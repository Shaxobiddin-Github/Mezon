import { createHmac } from 'node:crypto';
import { type RequestOptions, request } from 'node:https';
import type { PeerCertificate, TLSSocket } from 'node:tls';

/**
 * T4.1 — the terminal side of the LAN hub connection.
 *
 * After pairing, a terminal talks to the hub ONLY through `pinnedHubRequest`: the hub certificate
 * learned at pairing is the sole trust anchor (`ca`) and its SHA-256 fingerprint must match
 * (`checkServerIdentity`). Both checks run inside the TLS handshake, BEFORE any request byte
 * (headers, terminal key, PIN) is sent, so a different certificate (MITM, a rogue hub) gets nothing.
 * The hostname is not checked: LAN IPs change, the pin is the identity.
 */

export interface LanHubTarget {
  readonly host: string;
  readonly port: number;
}

export interface PinnedLanHubTarget extends LanHubTarget {
  readonly certPem: string;
  readonly fingerprint256: string;
}

export interface LanHttpResponse {
  readonly status: number;
  readonly body: string;
}

export class LanPinMismatchError extends Error {
  constructor(
    readonly expected: string,
    readonly actual: string,
  ) {
    super('Hub TLS certificate does not match the pinned fingerprint');
    this.name = 'LanPinMismatchError';
  }
}

interface RequestInput {
  readonly method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  readonly path: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: unknown;
}

function send(
  options: RequestOptions,
  input: RequestInput,
  onSocket?: (cert: PeerCertificate) => void,
): Promise<LanHttpResponse> {
  const payload = input.body === undefined ? undefined : JSON.stringify(input.body);
  return new Promise((resolve, reject) => {
    const req = request(
      {
        ...options,
        method: input.method,
        path: input.path,
        agent: false,
        headers: {
          ...(payload !== undefined
            ? {
                'content-type': 'application/json',
                'content-length': String(Buffer.byteLength(payload)),
              }
            : {}),
          ...input.headers,
        },
      },
      (res) => {
        if (onSocket) onSocket((res.socket as TLSSocket).getPeerCertificate());
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }),
        );
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    req.setTimeout(10_000, () => req.destroy(new Error('LAN hub request timed out')));
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

export function pinnedHubRequest(
  target: PinnedLanHubTarget,
  input: RequestInput,
): Promise<LanHttpResponse> {
  const expected = target.fingerprint256.toUpperCase();
  return send(
    {
      host: target.host,
      port: target.port,
      ca: [target.certPem],
      rejectUnauthorized: true,
      checkServerIdentity: (_host, cert) =>
        cert.fingerprint256.toUpperCase() === expected
          ? undefined
          : new LanPinMismatchError(expected, cert.fingerprint256),
    },
    input,
  );
}

/** Pairing proofs: the code itself never crosses the wire, only HMACs bound to the seen certificate. */
export function lanPairingProof(
  code: string,
  role: 'terminal' | 'hub',
  fingerprint256: string,
  nonce: string,
): string {
  return createHmac('sha256', normalizePairingCode(code))
    .update(`mezon.lan.pair.v1|${role}|${fingerprint256.toUpperCase()}|${nonce}`)
    .digest('hex');
}

export function normalizePairingCode(code: string): string {
  return code.replace(/[\s-]/g, '').toUpperCase();
}

export interface PairedTerminalCredentials {
  readonly terminalId: string;
  readonly terminalKey: string;
  readonly hub: PinnedLanHubTarget;
}

export class LanPairingRejectedError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
  ) {
    super(`Hub refused pairing (${status})`);
    this.name = 'LanPairingRejectedError';
  }
}

/**
 * First contact. The certificate is read from THIS connection; the terminal proves knowledge of
 * the code for exactly that fingerprint, and accepts the hub only if the hub proves the same.
 * A man in the middle presents another certificate, so the hub's check fails and no key is issued.
 */
export async function pairWithLanHub(input: {
  readonly target: LanHubTarget;
  readonly code: string;
  readonly terminalName: string;
  readonly nonce: string;
}): Promise<PairedTerminalCredentials> {
  let seen: PeerCertificate | null = null;
  // Probe: learn the certificate presented on the wire (no secret is sent on this request).
  await send(
    { host: input.target.host, port: input.target.port, rejectUnauthorized: false },
    { method: 'GET', path: '/lan/hello' },
    (cert) => {
      seen = cert;
    },
  );
  const cert = seen as PeerCertificate | null;
  if (cert === null || cert.raw === undefined) throw new Error('Hub presented no certificate');
  const fingerprint256 = cert.fingerprint256.toUpperCase();
  const certPem = `-----BEGIN CERTIFICATE-----\n${cert.raw
    .toString('base64')
    .replace(/(.{64})/g, '$1\n')
    .replace(/\n$/, '')}\n-----END CERTIFICATE-----\n`;
  const pinned: PinnedLanHubTarget = { ...input.target, certPem, fingerprint256 };
  // The proof request already runs pinned: if the certificate changes between the two
  // connections, the handshake fails before the proof leaves the terminal.
  const res = await pinnedHubRequest(pinned, {
    method: 'POST',
    path: '/lan/pair',
    body: {
      terminalName: input.terminalName,
      nonce: input.nonce,
      proof: lanPairingProof(input.code, 'terminal', fingerprint256, input.nonce),
    },
  });
  if (res.status !== 200) throw new LanPairingRejectedError(res.status, res.body);
  const out = JSON.parse(res.body) as { terminalId: string; terminalKey: string; hubProof: string };
  if (out.hubProof !== lanPairingProof(input.code, 'hub', fingerprint256, input.nonce)) {
    throw new LanPairingRejectedError(200, 'hub proof mismatch');
  }
  return { terminalId: out.terminalId, terminalKey: out.terminalKey, hub: pinned };
}
