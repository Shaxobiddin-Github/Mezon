import { generateKeyPairSync, sign } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  type LicencePayload,
  PLAN_CATALOG,
  buildLicenceSigningMessage,
  licencePayloadToWire,
} from '@mezon/licensing';
import { afterEach, describe, expect, it } from 'vitest';
import { HubLicenceService } from './licence-service.js';
import { nodeEd25519RulesVerifier } from './rules-service.js';

const DAY = 86_400_000n;
const ORG = '01950000-0000-7000-8000-000000000001';
const OTHER = '01950000-0000-7000-8000-000000000002';
const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const PUB = (publicKey.export({ type: 'spki', format: 'der' }) as Buffer)
  .subarray(-32)
  .toString('base64');
const KEYS = [{ keyId: 'k', publicKeyB64: PUB, validFromMs: 0n, validUntilMs: null }];

function envelope(over: Partial<LicencePayload> = {}) {
  const p: LicencePayload = {
    licenceId: '01950000-0000-7000-8000-0000000000aa',
    organizationId: ORG,
    plan: 'start',
    limits: PLAN_CATALOG.start.limits,
    issuedAtMs: 1n,
    validFromMs: 0n,
    validUntilMs: 100n * DAY,
    ...over,
  };
  const signature = sign(
    null,
    Buffer.from(buildLicenceSigningMessage('k', p), 'utf8'),
    privateKey,
  ).toString('base64');
  return { payload: licencePayloadToWire(p), keyId: 'k', signature };
}

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function setup(opts: { paired?: boolean; response?: unknown; fetchFails?: boolean; now?: bigint }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mezon-hub-licence-'));
  dirs.push(dir);
  const calls: string[] = [];
  let now = opts.now ?? 10n * DAY;
  const svc = new HubLicenceService({
    cloud: {
      getStatus: () =>
        Promise.resolve({
          status: opts.paired === false ? 'unpaired' : 'paired',
          cloudUrl: 'https://cloud.test',
          organizationId: ORG,
          storeId: null,
          pairedAtMs: null,
          lastSyncAtMs: null,
        }),
      getDecryptedToken: () => Promise.resolve('device-token'),
    },
    cachePath: path.join(dir, 'licence-cache.json'),
    trustedKeys: KEYS,
    verifier: nodeEd25519RulesVerifier,
    nowMs: () => now,
    fetchFn: ((url: string, init: { headers: Record<string, string> }) => {
      calls.push(`${url} ${init.headers.authorization}`);
      if (opts.fetchFails) return Promise.reject(new Error('offline'));
      return Promise.resolve(new Response(JSON.stringify(opts.response ?? {}), { status: 200 }));
    }) as unknown as typeof fetch,
  });
  return { svc, calls, dir, setNow: (n: bigint) => (now = n) };
}

describe('@mezon/hub - licence cache (T4.7)', () => {
  it('unpaired or never fetched: unknown, nothing requested', async () => {
    const { svc, calls } = setup({ paired: false });
    expect(await svc.refresh()).toBe(false);
    expect(calls).toHaveLength(0);
    expect((await svc.getView()).state).toBe('unknown');
  });

  it('fetches with the device token, caches, and works offline afterwards', async () => {
    const ok = setup({
      response: { organizationCreatedAtMs: '0', envelopes: [envelope()] },
    });
    expect(await ok.svc.refresh()).toBe(true);
    expect(ok.calls[0]).toBe('https://cloud.test/api/v1/devices/licence Bearer device-token');
    expect(await ok.svc.getView()).toMatchObject({
      state: 'active',
      plan: 'start',
      invalidLicence: false,
    });
  });

  it('a failed refresh keeps the previous cache', async () => {
    const first = setup({ response: { organizationCreatedAtMs: '0', envelopes: [envelope()] } });
    await first.svc.refresh();
    const cache = fs.readFileSync(path.join(first.dir, 'licence-cache.json'), 'utf8');
    const offline = setup({ fetchFails: true });
    fs.writeFileSync(path.join(offline.dir, 'licence-cache.json'), cache);
    expect(await offline.svc.refresh()).toBe(false);
    expect((await offline.svc.getView()).plan).toBe('start');
  });

  it('a hand-edited cache gains nothing: the tampered licence is ignored and flagged', async () => {
    const { svc, dir } = setup({
      response: { organizationCreatedAtMs: '0', envelopes: [envelope()] },
    });
    await svc.refresh();
    const file = path.join(dir, 'licence-cache.json');
    const cache = JSON.parse(fs.readFileSync(file, 'utf8')) as {
      envelopes: { payload: Record<string, unknown> }[];
    };
    cache.envelopes[0].payload.plan = 'pro';
    fs.writeFileSync(file, JSON.stringify(cache));
    const view = await svc.getView();
    expect(view.invalidLicence).toBe(true);
    // Without a valid licence the hub falls back to the trial (day 10 of 14), not to "pro".
    expect(view.plan).toBe(null);
    expect(view.state).toBe('trial');
  });

  it("another organization's licence does not apply", async () => {
    const { svc } = setup({
      response: { organizationCreatedAtMs: '0', envelopes: [envelope({ organizationId: OTHER })] },
      now: 20n * DAY,
    });
    await svc.refresh();
    expect(await svc.getView()).toMatchObject({ state: 'expired', invalidLicence: true });
  });

  it('a cache rewritten to name another organization (with its valid licence) applies nothing', async () => {
    const { svc, dir } = setup({
      response: { organizationCreatedAtMs: '0', envelopes: [envelope()] },
      now: 20n * DAY,
    });
    await svc.refresh();
    expect((await svc.getView()).plan).toBe('start');
    const file = path.join(dir, 'licence-cache.json');
    // A genuine Pro licence of ANOTHER organization, and the cache edited to name that organization.
    const foreign = envelope({
      organizationId: OTHER,
      plan: 'pro',
      limits: PLAN_CATALOG.pro.limits,
    });
    fs.writeFileSync(
      file,
      JSON.stringify({
        organizationId: OTHER,
        organizationCreatedAtMs: '0',
        envelopes: [foreign],
        fetchedAtMs: '1',
      }),
    );
    const view = await svc.getView();
    expect(view.plan).toBe(null);
    expect(view.invalidLicence).toBe(true);
    expect(view.state).toBe('expired');
  });

  it('a cache left over from another organization is flagged even with no licence in it', async () => {
    const { svc, dir } = setup({ now: 2n * DAY });
    fs.writeFileSync(
      path.join(dir, 'licence-cache.json'),
      JSON.stringify({
        organizationId: OTHER,
        organizationCreatedAtMs: '0',
        envelopes: [],
        fetchedAtMs: '1',
      }),
    );
    expect(await svc.getView()).toMatchObject({ state: 'trial', invalidLicence: true });
  });

  it('a malformed cloud answer is not cached', async () => {
    const { svc } = setup({ response: { envelopes: 'nope' } });
    expect(await svc.refresh()).toBe(false);
    expect((await svc.getView()).state).toBe('unknown');
  });
});
