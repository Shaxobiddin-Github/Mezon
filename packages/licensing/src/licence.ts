import { DomainError } from '@mezon/domain';
import { canonicalJson } from '@mezon/rules';
import {
  GRACE_DAYS,
  LICENCE_PLANS,
  type LicencePlan,
  type PlanLimits,
  TRIAL_DAYS,
  TRIAL_LIMITS,
} from './catalog.js';

/** Domain-separation prefix of the signed message. */
export const LICENCE_SIGNING_PREFIX = 'mezon-licence/v1\n';

const DAY_MS = 86_400_000n;
const UINT = /^(0|[1-9][0-9]{0,18})$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const BASE64_SIG = /^[A-Za-z0-9+/]{86}==$/;
const KEY_ID = /^[A-Za-z0-9._-]{1,64}$/;

export interface LicencePayload {
  readonly licenceId: string;
  readonly organizationId: string;
  readonly plan: LicencePlan;
  readonly limits: PlanLimits;
  readonly issuedAtMs: bigint;
  readonly validFromMs: bigint;
  readonly validUntilMs: bigint;
}

export interface LicenceEnvelope {
  readonly payload: LicencePayload;
  readonly keyId: string;
  readonly signature: string;
}

export interface TrustedLicenceKey {
  readonly keyId: string;
  /** Raw 32-byte Ed25519 public key, base64. */
  readonly publicKeyB64: string;
  readonly validFromMs: bigint;
  readonly validUntilMs: bigint | null;
}

/** Same port as the rules package: Ed25519 lives in node (`node:crypto`), not in this package. */
export interface LicenceSignatureVerifier {
  verifyEd25519(publicKeyB64: string, message: string, signatureB64: string): boolean;
}

function fail(message: string): never {
  throw new DomainError('LICENCE_INVALID', message);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function exactKeys(obj: Record<string, unknown>, keys: readonly string[], where: string) {
  for (const k of Object.keys(obj)) if (!keys.includes(k)) fail(`${where}: unknown field "${k}"`);
  for (const k of keys) if (!(k in obj)) fail(`${where}: missing field "${k}"`);
}

function uint(v: unknown, where: string): bigint {
  if (typeof v !== 'string' || !UINT.test(v)) fail(`${where}: must be a canonical uint string`);
  return BigInt(v);
}

function limit(v: unknown, where: string): number | null {
  if (v === null) return null;
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 1 || v > 100_000) {
    fail(`${where}: must be a positive integer or null`);
  }
  return v;
}

/** Wire form: bigint values travel as strings (canonical JSON allows only safe integers). */
export function licencePayloadToWire(p: LicencePayload): Record<string, unknown> {
  return {
    licenceId: p.licenceId,
    organizationId: p.organizationId,
    plan: p.plan,
    limits: { maxStores: p.limits.maxStores, maxDevices: p.limits.maxDevices },
    issuedAtMs: p.issuedAtMs.toString(),
    validFromMs: p.validFromMs.toString(),
    validUntilMs: p.validUntilMs.toString(),
  };
}

export function parseLicencePayload(raw: unknown): LicencePayload {
  if (!isRecord(raw)) fail('payload: must be an object');
  exactKeys(
    raw,
    ['licenceId', 'organizationId', 'plan', 'limits', 'issuedAtMs', 'validFromMs', 'validUntilMs'],
    'payload',
  );
  if (typeof raw.licenceId !== 'string' || !UUID.test(raw.licenceId)) {
    fail('payload.licenceId: must be a UUIDv7');
  }
  if (typeof raw.organizationId !== 'string' || !UUID.test(raw.organizationId)) {
    fail('payload.organizationId: must be a UUIDv7');
  }
  if (!LICENCE_PLANS.includes(raw.plan as LicencePlan)) fail('payload.plan: unknown plan');
  if (!isRecord(raw.limits)) fail('payload.limits: must be an object');
  exactKeys(raw.limits, ['maxStores', 'maxDevices'], 'payload.limits');
  const validFromMs = uint(raw.validFromMs, 'payload.validFromMs');
  const validUntilMs = uint(raw.validUntilMs, 'payload.validUntilMs');
  if (validUntilMs <= validFromMs) fail('payload.validUntilMs: must be after validFromMs');
  return {
    licenceId: raw.licenceId,
    organizationId: raw.organizationId,
    plan: raw.plan as LicencePlan,
    limits: {
      maxStores: limit(raw.limits.maxStores, 'payload.limits.maxStores'),
      maxDevices: limit(raw.limits.maxDevices, 'payload.limits.maxDevices'),
    },
    issuedAtMs: uint(raw.issuedAtMs, 'payload.issuedAtMs'),
    validFromMs,
    validUntilMs,
  };
}

export function buildLicenceSigningMessage(keyId: string, payload: LicencePayload): string {
  return `${LICENCE_SIGNING_PREFIX}${keyId}\n${canonicalJson(licencePayloadToWire(payload))}`;
}

export function parseLicenceEnvelope(raw: unknown): LicenceEnvelope {
  if (!isRecord(raw)) fail('envelope: must be an object');
  exactKeys(raw, ['payload', 'keyId', 'signature'], 'envelope');
  if (typeof raw.keyId !== 'string' || !KEY_ID.test(raw.keyId)) fail('envelope.keyId: invalid');
  if (typeof raw.signature !== 'string' || !BASE64_SIG.test(raw.signature)) {
    fail('envelope.signature: must be a base64 Ed25519 signature');
  }
  return { payload: parseLicencePayload(raw.payload), keyId: raw.keyId, signature: raw.signature };
}

/**
 * Verifies a wire envelope against the trusted keys and the expected organization.
 * A licence of another organization is rejected even with a valid signature.
 */
export function verifyLicence(
  raw: unknown,
  expectedOrganizationId: string,
  trustedKeys: readonly TrustedLicenceKey[],
  verifier: LicenceSignatureVerifier,
): LicenceEnvelope {
  const envelope = parseLicenceEnvelope(raw);
  if (envelope.payload.organizationId !== expectedOrganizationId) {
    fail('Licence belongs to another organization');
  }
  const key = trustedKeys.find((k) => k.keyId === envelope.keyId);
  if (!key)
    throw new DomainError('LICENCE_KEY_UNTRUSTED', `Unknown licence key "${envelope.keyId}"`);
  const issued = envelope.payload.issuedAtMs;
  if (issued < key.validFromMs || (key.validUntilMs !== null && issued > key.validUntilMs)) {
    throw new DomainError('LICENCE_KEY_UNTRUSTED', 'Licence key was not valid at issue time');
  }
  let ok = false;
  try {
    ok = verifier.verifyEd25519(
      key.publicKeyB64,
      buildLicenceSigningMessage(envelope.keyId, envelope.payload),
      envelope.signature,
    );
  } catch {
    ok = false;
  }
  if (!ok) throw new DomainError('LICENCE_SIGNATURE_INVALID', 'Licence signature is invalid');
  return envelope;
}

export type LicenceState = 'trial' | 'active' | 'grace' | 'expired';

export interface LicenceStatus {
  readonly state: LicenceState;
  readonly plan: LicencePlan | null;
  /** Limits enforced now. When `expired`, growth is frozen at the current usage. */
  readonly limits: PlanLimits;
  /** Trial end, licence end or grace end, whichever is relevant. */
  readonly endsAtMs: bigint | null;
  readonly daysLeft: number | null;
  /** A licence was presented but failed verification (shown to the owner). */
  readonly invalidLicence: boolean;
}

/**
 * Status at `nowMs` from the best verified licence (or none). GEMINI.md §2: a licence problem never
 * stops sales; `expired` only blocks growth (new stores and devices).
 */
export function resolveLicenceStatus(params: {
  readonly licences: readonly LicencePayload[];
  readonly invalidLicence: boolean;
  readonly organizationCreatedAtMs: bigint;
  readonly nowMs: bigint;
}): LicenceStatus {
  const now = params.nowMs;
  const days = (end: bigint) => Number((end - now + DAY_MS - 1n) / DAY_MS);
  const current = params.licences
    .filter((l) => l.validFromMs <= now && now <= l.validUntilMs)
    .sort((a, b) => (a.validUntilMs < b.validUntilMs ? 1 : -1))[0];
  if (current) {
    return {
      state: 'active',
      plan: current.plan,
      limits: current.limits,
      endsAtMs: current.validUntilMs,
      daysLeft: days(current.validUntilMs),
      invalidLicence: params.invalidLicence,
    };
  }
  const lastEnded = params.licences
    .filter((l) => l.validUntilMs < now)
    .sort((a, b) => (a.validUntilMs < b.validUntilMs ? 1 : -1))[0];
  if (lastEnded) {
    const graceEnd = lastEnded.validUntilMs + BigInt(GRACE_DAYS) * DAY_MS;
    if (now <= graceEnd) {
      return {
        state: 'grace',
        plan: lastEnded.plan,
        limits: lastEnded.limits,
        endsAtMs: graceEnd,
        daysLeft: days(graceEnd),
        invalidLicence: params.invalidLicence,
      };
    }
    return {
      state: 'expired',
      plan: lastEnded.plan,
      limits: { maxStores: 0, maxDevices: 0 },
      endsAtMs: graceEnd,
      daysLeft: 0,
      invalidLicence: params.invalidLicence,
    };
  }
  const trialEnd = params.organizationCreatedAtMs + BigInt(TRIAL_DAYS) * DAY_MS;
  if (now <= trialEnd) {
    return {
      state: 'trial',
      plan: null,
      limits: TRIAL_LIMITS,
      endsAtMs: trialEnd,
      daysLeft: days(trialEnd),
      invalidLicence: params.invalidLicence,
    };
  }
  return {
    state: 'expired',
    plan: null,
    limits: { maxStores: 0, maxDevices: 0 },
    endsAtMs: trialEnd,
    daysLeft: 0,
    invalidLicence: params.invalidLicence,
  };
}

export type LimitKind = 'stores' | 'devices';

/**
 * May one more store/device be added? `currentCount` = active ones now. When expired, nothing new
 * may be added, but everything existing keeps working (sales never stop).
 */
export function checkPlanLimit(
  status: LicenceStatus,
  kind: LimitKind,
  currentCount: number,
): { ok: true } | { ok: false; limit: number; state: LicenceState } {
  const max = kind === 'stores' ? status.limits.maxStores : status.limits.maxDevices;
  if (max === null) return { ok: true };
  return currentCount < max ? { ok: true } : { ok: false, limit: max, state: status.state };
}
