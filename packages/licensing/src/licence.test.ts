import { generateKeyPairSync, sign, verify, createPublicKey } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { GRACE_DAYS, PLAN_CATALOG, TRIAL_DAYS, TRIAL_LIMITS } from './catalog.js';
import {
  type LicencePayload,
  type TrustedLicenceKey,
  buildLicenceSigningMessage,
  checkPlanLimit,
  licencePayloadToWire,
  resolveLicenceStatus,
  verifyLicence,
} from './licence.js';

const DAY = 86_400_000n;
const ORG = '01950000-0000-7000-8000-000000000001';
const OTHER = '01950000-0000-7000-8000-000000000002';

const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const rawPub = (publicKey.export({ type: 'spki', format: 'der' }) as Buffer)
  .subarray(-32)
  .toString('base64');
const KEYS: TrustedLicenceKey[] = [
  { keyId: 'test-1', publicKeyB64: rawPub, validFromMs: 0n, validUntilMs: null },
];
const verifier = {
  verifyEd25519(pub: string, message: string, sig: string) {
    const spki = Buffer.concat([
      Buffer.from('302a300506032b6570032100', 'hex'),
      Buffer.from(pub, 'base64'),
    ]);
    const key = createPublicKey({ key: spki, format: 'der', type: 'spki' });
    return verify(null, Buffer.from(message, 'utf8'), key, Buffer.from(sig, 'base64'));
  },
};

function payload(over: Partial<LicencePayload> = {}): LicencePayload {
  return {
    licenceId: '01950000-0000-7000-8000-0000000000aa',
    organizationId: ORG,
    plan: 'business',
    limits: PLAN_CATALOG.business.limits,
    issuedAtMs: 1_000n,
    validFromMs: 10n * DAY,
    validUntilMs: 40n * DAY,
    ...over,
  };
}

function envelope(p: LicencePayload, keyId = 'test-1') {
  const signature = sign(
    null,
    Buffer.from(buildLicenceSigningMessage(keyId, p), 'utf8'),
    privateKey,
  ).toString('base64');
  return { payload: licencePayloadToWire(p), keyId, signature };
}

describe('@mezon/licensing - signed licence (T4.7)', () => {
  it('verifies a correctly signed licence of the same organization', () => {
    const env = verifyLicence(envelope(payload()), ORG, KEYS, verifier);
    expect(env.payload.plan).toBe('business');
  });

  it('rejects a tampered payload, a foreign organization and an unknown key', () => {
    const good = envelope(payload());
    const tampered = { ...good, payload: { ...good.payload, plan: 'pro' } };
    expect(() => verifyLicence(tampered, ORG, KEYS, verifier)).toThrow(/signature/i);
    const raisedLimit = {
      ...good,
      payload: { ...good.payload, limits: { maxStores: null, maxDevices: null } },
    };
    expect(() => verifyLicence(raisedLimit, ORG, KEYS, verifier)).toThrow(/signature/i);
    expect(() => verifyLicence(good, OTHER, KEYS, verifier)).toThrow(/another organization/);
    expect(() => verifyLicence(envelope(payload(), 'unknown'), ORG, KEYS, verifier)).toThrow(
      /Unknown licence key/,
    );
    expect(() => verifyLicence({ ...good, extra: 1 }, ORG, KEYS, verifier)).toThrow(
      /unknown field/,
    );
  });

  it('rejects a key used outside its validity window', () => {
    const keys = [{ ...KEYS[0]!, validFromMs: 5_000n }];
    expect(() => verifyLicence(envelope(payload()), ORG, keys, verifier)).toThrow(
      /not valid at issue/,
    );
  });
});

describe('@mezon/licensing - status and limits', () => {
  const created = 0n;
  const at = (d: bigint) => d * DAY;

  it('trial for TRIAL_DAYS after creation, then expired (growth frozen) without a licence', () => {
    const trial = resolveLicenceStatus({
      licences: [],
      invalidLicence: false,
      organizationCreatedAtMs: created,
      nowMs: at(1n),
    });
    expect(trial.state).toBe('trial');
    expect(trial.limits).toEqual(TRIAL_LIMITS);
    expect(trial.daysLeft).toBe(TRIAL_DAYS - 1);
    const after = resolveLicenceStatus({
      licences: [],
      invalidLicence: false,
      organizationCreatedAtMs: created,
      nowMs: at(BigInt(TRIAL_DAYS)) + 1n,
    });
    expect(after.state).toBe('expired');
    expect(checkPlanLimit(after, 'stores', 0).ok).toBe(false);
  });

  it('active -> grace (same limits) -> expired', () => {
    const p = payload({ plan: 'start', limits: PLAN_CATALOG.start.limits });
    const s = (d: bigint) =>
      resolveLicenceStatus({
        licences: [p],
        invalidLicence: false,
        organizationCreatedAtMs: created,
        nowMs: d,
      });
    expect(s(at(20n)).state).toBe('active');
    expect(s(at(40n)).state).toBe('active'); // last instant is inclusive
    const g = s(at(41n));
    expect(g.state).toBe('grace');
    expect(g.limits).toEqual(PLAN_CATALOG.start.limits);
    expect(s(at(40n + BigInt(GRACE_DAYS))).state).toBe('grace');
    const expired = s(at(40n + BigInt(GRACE_DAYS)) + 1n);
    expect(expired.state).toBe('expired');
    // Growth is frozen after expiry even below the old plan's limits (sales are not affected).
    expect(checkPlanLimit(expired, 'stores', 0).ok).toBe(false);
    expect(checkPlanLimit(expired, 'devices', 0).ok).toBe(false);
  });

  it('the longest running licence wins when two overlap', () => {
    const a = payload({
      plan: 'start',
      limits: PLAN_CATALOG.start.limits,
      validUntilMs: 30n * DAY,
    });
    const b = payload({ plan: 'pro', limits: PLAN_CATALOG.pro.limits, validUntilMs: 60n * DAY });
    const s = resolveLicenceStatus({
      licences: [a, b],
      invalidLicence: false,
      organizationCreatedAtMs: created,
      nowMs: at(20n),
    });
    expect(s.plan).toBe('pro');
  });

  it('a future licence does not count yet (still trial)', () => {
    const s = resolveLicenceStatus({
      licences: [payload({ validFromMs: 5n * DAY, validUntilMs: 50n * DAY })],
      invalidLicence: false,
      organizationCreatedAtMs: created,
      nowMs: at(2n),
    });
    expect(s.state).toBe('trial');
  });

  it('limits: below max ok, at max refused, null = unlimited', () => {
    const s = resolveLicenceStatus({
      licences: [payload({ plan: 'start', limits: { maxStores: 1, maxDevices: 2 } })],
      invalidLicence: false,
      organizationCreatedAtMs: created,
      nowMs: at(20n),
    });
    expect(checkPlanLimit(s, 'stores', 0)).toEqual({ ok: true });
    expect(checkPlanLimit(s, 'stores', 1)).toEqual({ ok: false, limit: 1, state: 'active' });
    expect(checkPlanLimit(s, 'devices', 1).ok).toBe(true);
    expect(checkPlanLimit(s, 'devices', 2).ok).toBe(false);
    const pro = resolveLicenceStatus({
      licences: [payload({ plan: 'pro', limits: { maxStores: null, maxDevices: null } })],
      invalidLicence: false,
      organizationCreatedAtMs: created,
      nowMs: at(20n),
    });
    expect(checkPlanLimit(pro, 'devices', 10_000).ok).toBe(true);
  });
});
