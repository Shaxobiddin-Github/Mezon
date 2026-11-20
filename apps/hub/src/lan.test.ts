import { generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LoginResponseSchema } from '@mezon/contracts';
import { MonotonicUuidV7Generator, parseUuidV7, unixMsFromBigInt } from '@mezon/domain';
import { PLAN_CATALOG, buildLicenceSigningMessage, licencePayloadToWire } from '@mezon/licensing';
import type { PinHasher } from '@mezon/domain';
import {
  LanPairingRejectedError,
  type PairedTerminalCredentials,
  generateSelfSignedTlsMaterial,
  lanPairingProof,
  pairWithLanHub,
  pinnedHubRequest,
} from '@mezon/drivers/node';
import { FixedClock, SeededRandomSource } from '@mezon/test-utils';
import { afterEach, describe, expect, it } from 'vitest';
import { type CreateHubServerOptions, type HubServer, createHubServer } from './index.js';

const HOST = '127.0.0.1:47879';
const fastHasher: PinHasher = {
  hash: (pin) => Promise.resolve(`fast-stub-hash:${pin}`),
  verify: (stored, pin) => Promise.resolve(stored === `fast-stub-hash:${pin}`),
};
const dirs: string[] = [];
const hubs: HubServer[] = [];
afterEach(async () => {
  for (const h of hubs.splice(0)) await h.close();
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true, maxRetries: 5 });
});

const nonce = () => randomBytes(18).toString('base64url');

async function boot(seed: number, extra: Partial<CreateHubServerOptions> = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mezon-lan-'));
  dirs.push(dir);
  const clock = new FixedClock(BigInt(Date.now()));
  const hub = await createHubServer({
    dbPath: path.join(dir, 'hub.db'),
    port: 47879,
    logLevel: 'silent',
    clock,
    random: new SeededRandomSource(seed),
    pinHasher: fastHasher,
    ...extra,
  });
  hubs.push(hub);
  const h = (t?: string) => (t ? { host: HOST, authorization: `Bearer ${t}` } : { host: HOST });
  await hub.app.inject({
    method: 'POST',
    url: '/setup',
    headers: h(),
    payload: { owner: { fullName: 'Egasi', username: 'owner', pin: '849201' } },
  });
  const login = async (username: string, pin: string) =>
    LoginResponseSchema.parse(
      (
        await hub.app.inject({
          method: 'POST',
          url: '/auth/login',
          headers: h(),
          payload: { username, pin },
        })
      ).json(),
    ).token;
  const owner = await login('owner', '849201');
  await hub.app.inject({
    method: 'POST',
    url: '/users',
    headers: h(owner),
    payload: { fullName: 'Kassir', username: 'kassa', role: 'cashier', pin: '582914' },
  });
  const cashier = await login('kassa', '582914');
  const lan = await hub.listenLan({ host: '127.0.0.1', port: 0 });
  const target = { host: '127.0.0.1', port: lan.port };
  const newCode = async () => {
    const r = await hub.app.inject({
      method: 'POST',
      url: '/lan/pairing-codes',
      headers: h(owner),
    });
    expect(r.statusCode, r.body).toBe(201);
    return r.json<{ code: string; fingerprint256: string }>();
  };
  return { hub, dir, clock, h, owner, cashier, lan, target, newCode };
}

const viaLan = (
  creds: PairedTerminalCredentials | { hub: PairedTerminalCredentials['hub'] },
  input: {
    method: 'GET' | 'POST';
    path: string;
    token?: string;
    key?: string | null;
    body?: unknown;
  },
) => {
  const headers: Record<string, string> = {};
  if (input.token) headers.authorization = `Bearer ${input.token}`;
  if (input.key !== null) {
    const c = creds as PairedTerminalCredentials;
    headers['x-mezon-terminal'] = input.key ?? `${c.terminalId}.${c.terminalKey}`;
  }
  return pinnedHubRequest(creds.hub, {
    method: input.method,
    path: input.path,
    headers,
    ...(input.body !== undefined ? { body: input.body } : {}),
  });
};
const errCode = (body: string) => (JSON.parse(body) as { error: { code: string } }).error.code;

describe('T4.1 LAN hub: only a paired terminal gets in', () => {
  it('pairs with a one-time code; the paired terminal works through pinned TLS', async () => {
    const env = await boot(4101);
    const { code, fingerprint256 } = await env.newCode();
    expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{5}-[0-9A-HJKMNP-TV-Z]{5}$/);
    const creds = await pairWithLanHub({
      target: env.target,
      code,
      terminalName: 'Kassa 2',
      nonce: nonce(),
    });
    expect(creds.hub.fingerprint256).toBe(fingerprint256);
    expect(fingerprint256).toBe(env.lan.fingerprint256);

    const login = await viaLan(creds, {
      method: 'POST',
      path: '/auth/login',
      key: undefined,
      body: { username: 'kassa', pin: '582914' },
    });
    expect(login.status, login.body).toBe(200);
    const token = LoginResponseSchema.parse(JSON.parse(login.body)).token;
    const shift = await viaLan(creds, { method: 'GET', path: '/shifts/current', token });
    expect(shift.status, shift.body).toBe(200);

    const list = await env.hub.app.inject({
      method: 'GET',
      url: '/lan/terminals',
      headers: env.h(env.owner),
    });
    expect(
      list.json<{
        terminals: { id: string; name: string; status: string; lastSeenAtMs: string | null }[];
      }>().terminals,
    ).toMatchObject([{ id: creds.terminalId, name: 'Kassa 2', status: 'active' }]);
    // Only hashes / ciphertext at rest.
    const sqlite = env.hub.connection.sqlite;
    const t = sqlite.prepare('SELECT key_hash FROM local_lan_terminals').get() as {
      key_hash: string;
    };
    expect(t.key_hash).not.toContain(creds.terminalKey);
    expect(t.key_hash).toMatch(/^[0-9a-f]{64}$/);
    const id = sqlite.prepare('SELECT key_enc_b64 FROM local_lan_identity').get() as {
      key_enc_b64: string;
    };
    expect(Buffer.from(id.key_enc_b64, 'base64').toString('latin1')).not.toContain('PRIVATE KEY');
    const c = sqlite.prepare('SELECT code_enc FROM local_lan_pairing_codes').get() as {
      code_enc: string;
    };
    expect(Buffer.from(c.code_enc, 'base64').toString('latin1')).not.toContain(
      code.replace('-', ''),
    );
  });

  it('unpaired, forged or revoked devices are stopped before any route (401)', async () => {
    const env = await boot(4102);
    const { code } = await env.newCode();
    const creds = await pairWithLanHub({
      target: env.target,
      code,
      terminalName: 'Kassa 2',
      nonce: nonce(),
    });
    const loginBody = { username: 'kassa', pin: '582914' };
    for (const key of [null, `${creds.terminalId}.wrong-key`, `.${creds.terminalKey}`, 'garbage']) {
      const r = await viaLan(creds, { method: 'POST', path: '/auth/login', key, body: loginBody });
      expect(r.status).toBe(401);
      expect(errCode(r.body)).toBe('TERMINAL_NOT_PAIRED');
    }
    // A cashier cannot revoke; the owner can, and the effect is immediate.
    expect(
      (
        await env.hub.app.inject({
          method: 'POST',
          url: `/lan/terminals/${creds.terminalId}/revoke`,
          headers: env.h(env.cashier),
        })
      ).statusCode,
    ).toBe(403);
    const rev = await env.hub.app.inject({
      method: 'POST',
      url: `/lan/terminals/${creds.terminalId}/revoke`,
      headers: env.h(env.owner),
    });
    expect(rev.statusCode, rev.body).toBe(200);
    const after = await viaLan(creds, { method: 'POST', path: '/auth/login', body: loginBody });
    expect(after.status).toBe(401);
    expect(errCode(after.body)).toBe('TERMINAL_NOT_PAIRED');
  });

  it('a pairing code is single-use, expires, and burns after 5 wrong proofs', async () => {
    const env = await boot(4103);
    const first = await env.newCode();
    await pairWithLanHub({
      target: env.target,
      code: first.code,
      terminalName: 'A',
      nonce: nonce(),
    });
    await expect(
      pairWithLanHub({ target: env.target, code: first.code, terminalName: 'B', nonce: nonce() }),
    ).rejects.toBeInstanceOf(LanPairingRejectedError);

    const late = await env.newCode();
    env.clock.advance(5n * 60_000n + 1n);
    await expect(
      pairWithLanHub({ target: env.target, code: late.code, terminalName: 'C', nonce: nonce() }),
    ).rejects.toBeInstanceOf(LanPairingRejectedError);

    const live = await env.newCode();
    for (let i = 0; i < 5; i++) {
      await expect(
        pairWithLanHub({
          target: env.target,
          code: 'AAAAA-AAAAA',
          terminalName: 'X',
          nonce: nonce(),
        }),
      ).rejects.toBeInstanceOf(LanPairingRejectedError);
    }
    await expect(
      pairWithLanHub({ target: env.target, code: live.code, terminalName: 'D', nonce: nonce() }),
    ).rejects.toBeInstanceOf(LanPairingRejectedError);
    expect(
      env.hub.connection.sqlite.prepare('SELECT count(*) AS n FROM local_lan_terminals').get(),
    ).toEqual({ n: 1n });
  });

  it('MITM at pairing: a proof bound to another certificate is refused, no key is issued', async () => {
    const env = await boot(4104);
    const { code } = await env.newCode();
    const mitm = generateSelfSignedTlsMaterial({
      commonName: 'Mezon hub',
      nowMs: Date.now(),
      validDays: 1,
    });
    const hello = await pairWithLanHub({
      target: env.target,
      code: (await env.newCode()).code,
      terminalName: 'probe',
      nonce: nonce(),
    });
    const n = nonce();
    // The terminal saw the MITM certificate, so its proof names the MITM fingerprint.
    const r = await pinnedHubRequest(hello.hub, {
      method: 'POST',
      path: '/lan/pair',
      body: {
        terminalName: 'Kassa 3',
        nonce: n,
        proof: lanPairingProof(code, 'terminal', mitm.fingerprint256, n),
      },
    });
    expect(r.status).toBe(401);
    expect(errCode(r.body)).toBe('LAN_PAIRING_REJECTED');
    expect(r.body).not.toContain('terminalKey');
    const names = env.hub.connection.sqlite.prepare('SELECT name FROM local_lan_terminals').all();
    expect(names).toEqual([{ name: 'probe' }]);
  });

  it('LAN management is local-only; a forged local terminal-id header is ignored', async () => {
    const env = await boot(4105);
    const { code } = await env.newCode();
    const creds = await pairWithLanHub({
      target: env.target,
      code,
      terminalName: 'Kassa 2',
      nonce: nonce(),
    });
    const viaTerminal = await viaLan(creds, {
      method: 'POST',
      path: '/lan/pairing-codes',
      token: env.owner,
    });
    expect(viaTerminal.status).toBe(403);
    expect(errCode(viaTerminal.body)).toBe('LAN_LOCAL_ONLY');
    const forged = await env.hub.app.inject({
      method: 'GET',
      url: '/lan/status',
      headers: {
        ...env.h(env.owner),
        'x-mezon-terminal-id': creds.terminalId,
        'x-mezon-lan-proxy': 'guess',
      },
    });
    expect(forged.statusCode, forged.body).toBe(200);
    expect(forged.json<{ activeTerminals: number }>().activeTerminals).toBe(1);
  });

  it('S10: two parallel pairings with the same code → exactly one terminal is added', async () => {
    const env = await boot(4106);
    const { code, fingerprint256 } = await env.newCode();
    const attempt = (name: string) => {
      const n = nonce();
      return env.hub.lanService.pair({
        terminalName: name,
        nonce: n,
        proof: lanPairingProof(code, 'terminal', fingerprint256, n),
      });
    };
    // Both see the live code (pair() awaits before it consumes); only the guarded consume decides.
    const results = await Promise.allSettled([attempt('A'), attempt('B')]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const lost = results.find((r) => r.status === 'rejected');
    expect((lost?.reason as { code?: string }).code).toBe('LAN_PAIRING_REJECTED');
    expect(
      env.hub.connection.sqlite.prepare('SELECT count(*) AS n FROM local_lan_terminals').get(),
    ).toEqual({ n: 1n });
  });

  it('T4.7 × T4.1: the licence device limit caps LAN terminals (the hub is one device); the code is not burnt', async () => {
    // A test signing key the hub trusts; a licence for 2 devices = the hub + 1 terminal.
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const pub = (publicKey.export({ type: 'spki', format: 'der' }) as Buffer)
      .subarray(-32)
      .toString('base64');
    const env = await boot(4107, {
      trustedLicenceKeys: [{ keyId: 'k', publicKeyB64: pub, validFromMs: 0n, validUntilMs: null }],
    });
    const cfg = env.hub.connection.sqlite
      .prepare('SELECT organization_id AS o, store_id AS s FROM local_hub_config LIMIT 1')
      .get() as { o: string; s: string };
    const org = parseUuidV7(cfg.o);
    const now = unixMsFromBigInt(BigInt(env.clock.now()));
    await env.hub.cloudStore.saveCloudState({
      status: 'paired',
      cloudUrl: 'https://cloud.invalid',
      organizationId: org,
      organizationName: 'Test',
      storeId: parseUuidV7(cfg.s),
      storeName: 'Dokon',
      encryptedDeviceToken: (await env.hub.safeStorage.encryptString('t')).toString('base64'),
      pairedAtMs: now,
      nowMs: now,
      idGen: new MonotonicUuidV7Generator({
        clock: { now: () => now },
        random: new SeededRandomSource(9),
      }),
    });
    const payload = {
      licenceId: '01950000-0000-7000-8000-0000000000aa',
      organizationId: org,
      plan: 'start' as const,
      limits: { ...PLAN_CATALOG.start.limits, maxDevices: 2 },
      issuedAtMs: 1n,
      validFromMs: 0n,
      validUntilMs: BigInt(env.clock.now()) + 30n * 86_400_000n,
    };
    const signature = sign(
      null,
      Buffer.from(buildLicenceSigningMessage('k', payload), 'utf8'),
      privateKey,
    ).toString('base64');
    fs.writeFileSync(
      path.join(env.dir, 'licence-cache.json'),
      JSON.stringify({
        organizationId: org,
        organizationCreatedAtMs: '0',
        envelopes: [{ payload: licencePayloadToWire(payload), keyId: 'k', signature }],
        fetchedAtMs: String(env.clock.now()),
      }),
    );

    // Two codes are issued while there is room; the first pairing fills the plan.
    const a = await env.newCode();
    const b = await env.newCode();
    const first = await pairWithLanHub({
      target: env.target,
      code: a.code,
      terminalName: 'Kassa 2',
      nonce: nonce(),
    });
    // The second (right) code is refused by the plan, not burnt as a wrong guess.
    await expect(
      pairWithLanHub({ target: env.target, code: b.code, terminalName: 'Kassa 3', nonce: nonce() }),
    ).rejects.toBeInstanceOf(LanPairingRejectedError);
    const codeB = env.hub.connection.sqlite
      .prepare(
        'SELECT used_at_ms AS u, failed_attempts AS f FROM local_lan_pairing_codes ORDER BY created_at_ms DESC, id DESC LIMIT 1',
      )
      .get() as { u: unknown; f: bigint };
    expect(codeB).toEqual({ u: null, f: 0n });
    // A new code is refused up front with the plan's code.
    const more = await env.hub.app.inject({
      method: 'POST',
      url: '/lan/pairing-codes',
      headers: env.h(env.owner),
    });
    expect(more.statusCode).toBe(402);
    expect(more.json<{ error: { code: string } }>().error.code).toBe('PLAN_LIMIT_REACHED');
    // Revoking the terminal frees the place: the unburnt code now pairs.
    const revoke = await env.hub.app.inject({
      method: 'POST',
      url: `/lan/terminals/${first.terminalId}/revoke`,
      headers: env.h(env.owner),
    });
    expect(revoke.statusCode, revoke.body).toBe(200);
    await expect(
      pairWithLanHub({ target: env.target, code: b.code, terminalName: 'Kassa 3', nonce: nonce() }),
    ).resolves.toMatchObject({ terminalId: expect.any(String) as string });
  });
});
