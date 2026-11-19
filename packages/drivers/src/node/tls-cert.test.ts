import { X509Certificate, createPrivateKey, createPublicKey } from 'node:crypto';
import { type Server, createServer } from 'node:https';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import {
  LanPairingRejectedError,
  LanPinMismatchError,
  lanPairingProof,
  pairWithLanHub,
  pinnedHubRequest,
} from './pinned-https.js';
import { generateSelfSignedTlsMaterial } from './tls-cert.js';

const NOW = 1_771_000_000_000;
const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
});

function serve(m: { certPem: string; keyPem: string }, seen?: string[]): Promise<number> {
  const s = createServer({ cert: m.certPem, key: m.keyPem }, (req, res) => {
    seen?.push(String(req.headers['x-secret']));
    res.end('ok');
  });
  servers.push(s);
  return new Promise((resolve) =>
    s.listen(0, '127.0.0.1', () => resolve((s.address() as AddressInfo).port)),
  );
}

describe('T4.1 self-signed hub certificate', () => {
  it('is a valid self-signed X.509 that Node parses, with the key it was made for', () => {
    const m = generateSelfSignedTlsMaterial({ commonName: 'Mezon hub', nowMs: NOW, validDays: 30 });
    const x = new X509Certificate(m.certPem);
    expect(x.subject).toBe('CN=Mezon hub');
    expect(x.issuer).toBe('CN=Mezon hub');
    expect(x.verify(x.publicKey)).toBe(true);
    expect(x.fingerprint256).toBe(m.fingerprint256);
    expect(x.checkPrivateKey(createPrivateKey(m.keyPem))).toBe(true);
    expect(createPublicKey(m.keyPem).export({ format: 'jwk' }).crv).toBe('P-256');
    expect(Date.parse(x.validTo)).toBe(Math.floor((NOW + 30 * 86_400_000) / 1000) * 1000);
    expect(Date.parse(x.validFrom)).toBeLessThan(NOW);
    expect(m.notAfterMs).toBe(NOW + 30 * 86_400_000);
  });

  it('every generation is a new key and a new fingerprint', () => {
    const a = generateSelfSignedTlsMaterial({ commonName: 'h', nowMs: NOW, validDays: 1 });
    const b = generateSelfSignedTlsMaterial({ commonName: 'h', nowMs: NOW, validDays: 1 });
    expect(a.fingerprint256).not.toBe(b.fingerprint256);
    expect(a.keyPem).not.toBe(b.keyPem);
  });

  it('uses GeneralizedTime past 2049 (RFC 5280)', () => {
    const m = generateSelfSignedTlsMaterial({
      commonName: 'h',
      nowMs: Date.UTC(2049, 11, 1),
      validDays: 365,
    });
    expect(new X509Certificate(m.certPem).validTo).toContain('2050');
  });

  it('pinned request: works with the pinned cert; a different cert never receives the request', async () => {
    const real = generateSelfSignedTlsMaterial({
      commonName: 'Mezon hub',
      nowMs: Date.now(),
      validDays: 1,
    });
    const rogue = generateSelfSignedTlsMaterial({
      commonName: 'Mezon hub',
      nowMs: Date.now(),
      validDays: 1,
    });
    const realPort = await serve(real);
    const seenByRogue: string[] = [];
    const roguePort = await serve(rogue, seenByRogue);
    const pin = { host: '127.0.0.1', certPem: real.certPem, fingerprint256: real.fingerprint256 };

    const ok = await pinnedHubRequest({ ...pin, port: realPort }, { method: 'GET', path: '/' });
    expect(ok).toEqual({ status: 200, body: 'ok' });

    // Same address, other certificate (MITM / rogue hub): refused in the handshake.
    await expect(
      pinnedHubRequest(
        { ...pin, port: roguePort },
        { method: 'GET', path: '/', headers: { 'x-secret': 'terminal-key' } },
      ),
    ).rejects.toThrow();
    // Rogue cert pinned by its PEM but a wrong fingerprint: the pin check refuses.
    await expect(
      pinnedHubRequest(
        {
          host: '127.0.0.1',
          port: roguePort,
          certPem: rogue.certPem,
          fingerprint256: real.fingerprint256,
        },
        { method: 'GET', path: '/', headers: { 'x-secret': 'terminal-key' } },
      ),
    ).rejects.toBeInstanceOf(LanPinMismatchError);
    expect(seenByRogue).toEqual([]);
  });

  it('S9: a hub that answers /lan/pair without the right hubProof is refused (no credentials)', async () => {
    const m = generateSelfSignedTlsMaterial({
      commonName: 'Mezon hub',
      nowMs: Date.now(),
      validDays: 1,
    });
    const code = 'ABCDE-FGHJK';
    // A fake hub: it issues a key, but its hubProof is right only when `honest`.
    let honest = false;
    const s = createServer({ cert: m.certPem, key: m.keyPem }, (req, res) => {
      if (req.url === '/lan/hello') {
        res.end('{}');
        return;
      }
      let raw = '';
      req.on('data', (c: Buffer) => (raw += c.toString()));
      req.on('end', () => {
        const body = JSON.parse(raw) as { nonce: string };
        const hubProof = honest
          ? lanPairingProof(code, 'hub', m.fingerprint256, body.nonce)
          : lanPairingProof('ZZZZZ-ZZZZZ', 'hub', m.fingerprint256, body.nonce);
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ terminalId: 't1', terminalKey: 'k1', hubProof }));
      });
    });
    servers.push(s);
    const port = await new Promise<number>((resolve) =>
      s.listen(0, '127.0.0.1', () => resolve((s.address() as AddressInfo).port)),
    );
    const pair = () =>
      pairWithLanHub({
        target: { host: '127.0.0.1', port },
        code,
        terminalName: 'Kassa',
        nonce: 'nonce-0123456789abcdef',
      });
    await expect(pair()).rejects.toBeInstanceOf(LanPairingRejectedError);
    // Control: the same fake hub with the right proof is accepted.
    honest = true;
    await expect(pair()).resolves.toMatchObject({ terminalId: 't1', terminalKey: 'k1' });
  });
});
