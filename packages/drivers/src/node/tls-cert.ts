import { X509Certificate, createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';

/**
 * T4.1 — a self-signed ECDSA P-256 / SHA-256 X.509 v3 certificate for the hub's LAN listener,
 * built with a tiny DER writer (no new dependency). Terminals never trust it by a CA: they pin
 * its SHA-256 fingerprint at pairing time, so the only fields that matter are a valid structure,
 * the public key and the validity window.
 */

function derLength(n: number): Buffer {
  if (n < 0x80) return Buffer.from([n]);
  const bytes: number[] = [];
  let v = n;
  while (v > 0) {
    bytes.unshift(v & 0xff);
    v >>= 8;
  }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function tlv(tag: number, content: Buffer): Buffer {
  return Buffer.concat([Buffer.from([tag]), derLength(content.length), content]);
}

const seq = (...parts: Buffer[]) => tlv(0x30, Buffer.concat(parts));
const set = (...parts: Buffer[]) => tlv(0x31, Buffer.concat(parts));

function oid(dotted: string): Buffer {
  const arcs = dotted.split('.').map(Number);
  const out: number[] = [40 * arcs[0] + arcs[1]];
  for (const arc of arcs.slice(2)) {
    const chunk: number[] = [arc & 0x7f];
    let v = arc >>> 7;
    while (v > 0) {
      chunk.unshift((v & 0x7f) | 0x80);
      v >>>= 7;
    }
    out.push(...chunk);
  }
  return tlv(0x06, Buffer.from(out));
}

function unsignedInteger(bytes: Buffer): Buffer {
  let b = bytes;
  while (b.length > 1 && b[0] === 0 && (b[1] & 0x80) === 0) b = b.subarray(1);
  if ((b[0] & 0x80) !== 0) b = Buffer.concat([Buffer.from([0]), b]);
  return tlv(0x02, b);
}

function time(ms: number): Buffer {
  const d = new Date(ms);
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  const body = `${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
  const year = d.getUTCFullYear();
  // RFC 5280 §4.1.2.5: UTCTime through 2049, GeneralizedTime from 2050.
  return year < 2050
    ? tlv(0x17, Buffer.from(`${p(year % 100)}${body}`, 'ascii'))
    : tlv(0x18, Buffer.from(`${p(year, 4)}${body}`, 'ascii'));
}

const name = (commonName: string) =>
  seq(set(seq(oid('2.5.4.3'), tlv(0x0c, Buffer.from(commonName, 'utf8')))));

const ECDSA_WITH_SHA256 = seq(oid('1.2.840.10045.4.3.2'));

export interface SelfSignedTlsMaterial {
  readonly certPem: string;
  readonly keyPem: string;
  /** Upper-case colon-separated SHA-256 of the DER certificate (same format as Node's `fingerprint256`). */
  readonly fingerprint256: string;
  readonly notAfterMs: number;
}

export function fingerprint256OfPem(certPem: string): string {
  return new X509Certificate(certPem).fingerprint256;
}

export function generateSelfSignedTlsMaterial(input: {
  readonly commonName: string;
  readonly nowMs: number;
  readonly validDays: number;
}): SelfSignedTlsMaterial {
  if (!Number.isInteger(input.validDays) || input.validDays < 1) {
    throw new RangeError('validDays must be a positive integer');
  }
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const spki = publicKey.export({ type: 'spki', format: 'der' });
  const serial = randomBytes(16);
  serial[0] = serial[0] & 0x7f;
  // Back-date one hour so a terminal whose clock is slightly behind still accepts the cert.
  const notBefore = input.nowMs - 3_600_000;
  const notAfter = input.nowMs + input.validDays * 86_400_000;
  const tbs = seq(
    tlv(0xa0, tlv(0x02, Buffer.from([2]))), // [0] EXPLICIT version v3
    unsignedInteger(serial),
    ECDSA_WITH_SHA256,
    name(input.commonName),
    seq(time(notBefore), time(notAfter)),
    name(input.commonName),
    spki,
  );
  const signature = sign('sha256', tbs, { key: privateKey, dsaEncoding: 'der' });
  const der = seq(tbs, ECDSA_WITH_SHA256, tlv(0x03, Buffer.concat([Buffer.from([0]), signature])));
  const certPem = `-----BEGIN CERTIFICATE-----\n${der
    .toString('base64')
    .replace(/(.{64})/g, '$1\n')
    .replace(/\n$/, '')}\n-----END CERTIFICATE-----\n`;
  const keyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const fingerprint256 = createHash('sha256')
    .update(der)
    .digest('hex')
    .toUpperCase()
    .replace(/(..)(?!$)/g, '$1:');
  return { certPem, keyPem, fingerprint256, notAfterMs: notAfter };
}
