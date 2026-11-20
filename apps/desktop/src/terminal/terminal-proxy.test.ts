import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { generateSelfSignedTlsMaterial } from '@mezon/drivers/node';
import { afterEach, describe, expect, it } from 'vitest';
import type { DataKeyCipher } from '../data-key.js';
import {
  deleteTerminalConfig,
  isValidLanHost,
  loadTerminalConfig,
  saveTerminalConfig,
  terminalInfoOf,
} from './terminal-config.js';
import { type TerminalProxy, startTerminalProxy } from './terminal-proxy.js';

const tls = () =>
  generateSelfSignedTlsMaterial({ commonName: 'Mezon hub', nowMs: Date.now(), validDays: 1 });

interface Seen {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of closers.splice(0)) await c();
});

async function fakeHub(material = tls()) {
  const seen: Seen[] = [];
  const server = https.createServer(
    { key: material.keyPem, cert: material.certPem },
    (req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        seen.push({
          method: req.method ?? '',
          url: req.url ?? '',
          headers: req.headers,
          body: Buffer.concat(chunks).toString('utf8'),
        });
        res.writeHead(201, { 'content-type': 'application/json', 'x-hub': 'yes' });
        res.end(JSON.stringify({ ok: true }));
      });
    },
  );
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address();
  const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
  closers.push(
    () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  );
  return {
    seen,
    port,
    target: {
      host: '127.0.0.1',
      port,
      certPem: material.certPem,
      fingerprint256: material.fingerprint256,
    },
  };
}

async function proxyTo(target: Parameters<typeof startTerminalProxy>[0]['hub']) {
  const errors: string[] = [];
  const p = await startTerminalProxy({
    hub: target,
    terminalId: 'term-1',
    terminalKey: 'secret-key',
    timeoutMs: 3000,
    onError: (code) => errors.push(code),
  });
  closers.push(() => p.close());
  return { p, errors };
}

function call(
  p: TerminalProxy,
  input: {
    method: string;
    path: string;
    host?: string;
    headers?: Record<string, string>;
    body?: string;
  },
) {
  return new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }>(
    (resolve, reject) => {
      const req = http.request(
        {
          host: '127.0.0.1',
          port: p.port,
          method: input.method,
          path: input.path,
          setHost: false,
          headers: { host: input.host ?? `127.0.0.1:${p.port}`, ...input.headers },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () =>
            resolve({
              status: res.statusCode ?? 0,
              headers: res.headers,
              body: Buffer.concat(chunks).toString('utf8'),
            }),
          );
        },
      );
      req.on('error', reject);
      req.end(input.body);
    },
  );
}

describe('v1 LAN terminal proxy', () => {
  it('forwards to the pinned hub with the terminal key; forged x-mezon headers are dropped', async () => {
    const hub = await fakeHub();
    const { p } = await proxyTo(hub.target);
    const r = await call(p, {
      method: 'POST',
      path: '/carts?x=1',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer t',
        origin: 'app://mezon',
        'x-mezon-terminal': 'forged.key',
        'x-mezon-terminal-id': 'forged',
        'x-mezon-lan-proxy': 'forged',
      },
      body: '{"a":1}',
    });
    expect(r.status).toBe(201);
    expect(r.headers['x-hub']).toBe('yes');
    expect(JSON.parse(r.body)).toEqual({ ok: true });
    expect(hub.seen).toHaveLength(1);
    const s = hub.seen[0];
    expect(s).toMatchObject({ method: 'POST', url: '/carts?x=1', body: '{"a":1}' });
    expect(s?.headers['x-mezon-terminal']).toBe('term-1.secret-key');
    expect(s?.headers['x-mezon-terminal-id']).toBeUndefined();
    expect(s?.headers['x-mezon-lan-proxy']).toBeUndefined();
    expect(s?.headers.authorization).toBe('Bearer t');
    expect(s?.headers.origin).toBe('app://mezon');
  });

  it('refuses a foreign Host header (DNS rebinding) without contacting the hub', async () => {
    const hub = await fakeHub();
    const { p } = await proxyTo(hub.target);
    const r = await call(p, { method: 'GET', path: '/health', host: 'evil.example:80' });
    expect(r.status).toBe(421);
    expect(hub.seen).toHaveLength(0);
  });

  it('a different hub certificate (MITM, reinstalled hub) gets no request and no key', async () => {
    const hub = await fakeHub();
    const other = tls();
    const { p, errors } = await proxyTo({
      ...hub.target,
      certPem: other.certPem,
      fingerprint256: other.fingerprint256,
    });
    const r = await call(p, { method: 'GET', path: '/health' });
    expect(r.status).toBe(502);
    expect(hub.seen).toHaveLength(0);
    expect(errors).toEqual(['LAN_PIN_MISMATCH']);
    expect(JSON.parse(r.body)).toMatchObject({ error: { code: 'LAN_PIN_MISMATCH' } });
  });

  it('hub down → 502 LAN_HUB_UNREACHABLE', async () => {
    const material = tls();
    const hub = await fakeHub(material);
    const target = hub.target;
    await closers.shift()?.();
    const { p } = await proxyTo(target);
    const r = await call(p, { method: 'GET', path: '/health' });
    expect(r.status).toBe(502);
    expect(JSON.parse(r.body)).toMatchObject({ error: { code: 'LAN_HUB_UNREACHABLE' } });
  });
});

describe('v1 LAN terminal config', () => {
  const cipher: DataKeyCipher = {
    isEncryptionAvailable: () => true,
    encryptString: (s) => Buffer.from(`os:${s}`).reverse(),
    decryptString: (b) => Buffer.from(b).reverse().toString('utf8').slice(3),
  };

  it('round-trips; the key is stored OS-wrapped and never shown to the UI', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mezon-term-'));
    const file = path.join(dir, 'terminal.json');
    try {
      const m = tls();
      const config = {
        terminalId: 'term-1',
        terminalKey: 'very-secret-terminal-key',
        terminalName: 'Kassa 2',
        hub: {
          host: '192.168.1.10',
          port: 47821,
          certPem: m.certPem,
          fingerprint256: m.fingerprint256,
        },
        pairedAtMs: 1,
      };
      saveTerminalConfig(file, config, cipher);
      expect(fs.readFileSync(file, 'utf8')).not.toContain('very-secret-terminal-key');
      expect(loadTerminalConfig(file, cipher)).toEqual(config);
      expect(JSON.stringify(terminalInfoOf(config))).not.toContain('very-secret');
      deleteTerminalConfig(file);
      expect(loadTerminalConfig(file, cipher)).toBeNull();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('accepts LAN hosts only (no scheme, path or port)', () => {
    expect(isValidLanHost('192.168.1.10')).toBe(true);
    expect(isValidLanHost('kassa-1.local')).toBe(true);
    expect(isValidLanHost('http://x')).toBe(false);
    expect(isValidLanHost('1.2.3.4:80')).toBe(false);
    expect(isValidLanHost('a/b')).toBe(false);
    expect(isValidLanHost('')).toBe(false);
  });
});
