import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import { request } from 'node:https';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { LoginResponseSchema } from '@mezon/contracts';
import type { PinHasher } from '@mezon/domain';
import { pairWithLanHub, pinnedHubRequest } from '@mezon/drivers/node';
import { afterEach, describe, expect, it } from 'vitest';
import { type HubServer, createHubServer } from './index.js';
import { AesGcmSafeStorageAdapter } from './safe-storage-port.js';

const DATA_KEY = randomBytes(32);

/**
 * v1: in the desktop app the LAN listener is not started by a test harness. It opens on demand
 * (the owner asks for a pairing code) and again on every hub start while paired terminals exist.
 */

const fastHasher: PinHasher = {
  hash: (pin) => Promise.resolve(`fast-stub-hash:${pin}`),
  verify: (stored, pin) => Promise.resolve(stored === `fast-stub-hash:${pin}`),
};
const dirs: string[] = [];
const hubs: HubServer[] = [];
afterEach(async () => {
  for (const h of hubs.splice(0)) await h.close().catch(() => undefined);
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true, maxRetries: 5 });
});

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const a = s.address();
      const port = typeof a === 'object' && a !== null ? a.port : 0;
      s.close(() => resolve(port));
    });
  });
}

async function bootAt(dbPath: string, port: number, lanPort: number) {
  const hub = await createHubServer({
    dbPath,
    port,
    lanPort,
    allowedOrigins: ['app://mezon'],
    logLevel: 'silent',
    pinHasher: fastHasher,
    // Desktop passes the same persistent key on every start (apps/desktop/src/data-key.ts).
    safeStorage: new AesGcmSafeStorageAdapter(DATA_KEY),
  });
  hubs.push(hub);
  await hub.listen();
  return hub;
}

function preflight(port: number, terminalHeader: string) {
  return new Promise<{ status: number; headers: Record<string, unknown> }>((resolve, reject) => {
    const req = request(
      {
        host: '127.0.0.1',
        port,
        method: 'OPTIONS',
        path: '/shifts/current',
        rejectUnauthorized: false,
        agent: false,
        headers: {
          origin: 'app://mezon',
          'access-control-request-method': 'GET',
          'access-control-request-headers': 'authorization',
          'x-mezon-terminal': terminalHeader,
        },
      },
      (res) => {
        res.resume();
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

describe('v1 LAN listener on demand (desktop hub)', () => {
  it('opens on the first pairing code, serves CORS preflight, and reopens after a restart', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mezon-lan-od-'));
    dirs.push(dir);
    const dbPath = path.join(dir, 'hub.db');
    const port = await freePort();
    const lanPort = await freePort();
    const host = `127.0.0.1:${port}`;
    const h = (t?: string) => (t ? { host, authorization: `Bearer ${t}` } : { host });

    let hub = await bootAt(dbPath, port, lanPort);
    await hub.app.inject({
      method: 'POST',
      url: '/setup',
      headers: h(),
      payload: { owner: { fullName: 'Egasi', username: 'owner', pin: '849201' } },
    });
    const owner = LoginResponseSchema.parse(
      (
        await hub.app.inject({
          method: 'POST',
          url: '/auth/login',
          headers: h(),
          payload: { username: 'owner', pin: '849201' },
        })
      ).json(),
    ).token;

    // No terminals yet: nothing listens on the LAN.
    const before = await hub.app.inject({ method: 'GET', url: '/lan/status', headers: h(owner) });
    expect(before.statusCode, before.body).toBe(200);
    expect(before.json<{ port: number | null; addresses: string[] }>()).toMatchObject({
      port: null,
    });
    expect(Array.isArray(before.json<{ addresses: string[] }>().addresses)).toBe(true);

    const codeRes = await hub.app.inject({
      method: 'POST',
      url: '/lan/pairing-codes',
      headers: h(owner),
    });
    expect(codeRes.statusCode, codeRes.body).toBe(201);
    const code = codeRes.json<{ code: string; port: number; fingerprint256: string }>();
    expect(code.port).toBe(lanPort);
    const after = await hub.app.inject({ method: 'GET', url: '/lan/status', headers: h(owner) });
    expect(after.json<{ port: number | null }>().port).toBe(lanPort);

    const creds = await pairWithLanHub({
      target: { host: '127.0.0.1', port: lanPort },
      code: code.code,
      terminalName: 'Kassa 2',
      nonce: randomBytes(18).toString('base64url'),
    });
    expect(creds.hub.fingerprint256).toBe(code.fingerprint256);
    const terminalHeader = `${creds.terminalId}.${creds.terminalKey}`;

    // The terminal's POS runs in app://mezon: its CORS preflight must pass the LAN proxy.
    const pre = await preflight(lanPort, terminalHeader);
    expect(pre.status).toBe(204);
    expect(pre.headers['access-control-allow-origin']).toBe('app://mezon');

    // Restart: the hub has a paired terminal, so the listener opens without any request.
    await hub.close();
    hubs.splice(hubs.indexOf(hub), 1);
    hub = await bootAt(dbPath, port, lanPort);
    const health = await pinnedHubRequest(creds.hub, {
      method: 'GET',
      path: '/health',
      headers: { 'x-mezon-terminal': terminalHeader },
    });
    expect(health.status, health.body).toBe(200);
  });

  it('a hub without paired terminals does not open the LAN port at start', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mezon-lan-od-'));
    dirs.push(dir);
    const lanPort = await freePort();
    await bootAt(path.join(dir, 'hub.db'), await freePort(), lanPort);
    const probe = await new Promise<boolean>((resolve) => {
      const s = net.connect(lanPort, '127.0.0.1');
      s.once('connect', () => {
        s.destroy();
        resolve(true);
      });
      s.once('error', () => resolve(false));
    });
    expect(probe).toBe(false);
  });
});
