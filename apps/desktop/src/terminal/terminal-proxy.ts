import http from 'node:http';
import https from 'node:https';
import { LanPinMismatchError, type PinnedLanHubTarget } from '@mezon/drivers/node';

/**
 * v1 LAN terminal: the POS keeps talking to `http://127.0.0.1:<port>` (same CSP, same loopback
 * checks as on the hub computer). This loopback proxy forwards every request to the hub's LAN
 * listener over pinned TLS and adds the terminal key. The key never reaches the renderer.
 */

const TERMINAL_AUTH_HEADER = 'x-mezon-terminal';
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-connection',
  'transfer-encoding',
  'upgrade',
  'te',
  'trailer',
  'host',
]);
const DEFAULT_BODY_LIMIT = 2 * 1024 * 1024;

export interface TerminalProxy {
  readonly baseUrl: string;
  readonly port: number;
  close(): Promise<void>;
}

const jsonError = (res: http.ServerResponse, status: number, code: string, message: string) => {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  const body = JSON.stringify({ error: { code, message } });
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  res.end(body);
};

export async function startTerminalProxy(o: {
  readonly hub: PinnedLanHubTarget;
  readonly terminalId: string;
  readonly terminalKey: string;
  readonly timeoutMs?: number;
  readonly bodyLimit?: number;
  readonly onError?: (code: string, message: string) => void;
}): Promise<TerminalProxy> {
  const expected = o.hub.fingerprint256.toUpperCase();
  const agent = new https.Agent({
    keepAlive: true,
    ca: [o.hub.certPem],
    rejectUnauthorized: true,
    // The pin is the identity (LAN IPs change): checked inside the handshake, before any byte.
    checkServerIdentity: (_host, cert) =>
      cert.fingerprint256.toUpperCase() === expected
        ? undefined
        : new LanPinMismatchError(expected, cert.fingerprint256),
  });
  const bodyLimit = o.bodyLimit ?? DEFAULT_BODY_LIMIT;
  let boundPort = 0;

  const server = http.createServer((req, res) => {
    // DNS rebinding: only the exact loopback origin the POS uses may reach the proxy.
    if (req.headers.host !== `127.0.0.1:${boundPort}`) {
      jsonError(res, 421, 'INVALID_HOST', 'Host header is not allowed');
      return;
    }
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (typeof v !== 'string' || HOP_BY_HOP.has(k) || k.startsWith('x-mezon-')) continue;
      headers[k] = v;
    }
    headers[TERMINAL_AUTH_HEADER] = `${o.terminalId}.${o.terminalKey}`;

    const chunks: Buffer[] = [];
    let size = 0;
    let tooLarge = false;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > bodyLimit) {
        tooLarge = true;
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (tooLarge) {
        jsonError(res, 413, 'PAYLOAD_TOO_LARGE', 'Request body is too large');
        return;
      }
      const body = Buffer.concat(chunks);
      if (body.length > 0) headers['content-length'] = String(body.length);
      else delete headers['content-length'];
      const upstream = https.request(
        {
          host: o.hub.host,
          port: o.hub.port,
          method: req.method,
          path: req.url,
          agent,
          headers,
        },
        (up) => {
          const out: Record<string, string | string[]> = {};
          for (const [k, v] of Object.entries(up.headers)) {
            if (v !== undefined && !HOP_BY_HOP.has(k)) out[k] = v;
          }
          res.writeHead(up.statusCode ?? 502, out);
          up.pipe(res);
          up.on('error', () => res.destroy());
        },
      );
      upstream.setTimeout(o.timeoutMs ?? 30_000, () =>
        upstream.destroy(new Error('LAN hub request timed out')),
      );
      upstream.on('error', (err) => {
        // Another certificate fails chain validation (self-signed, unknown) or the pin check.
        const tlsCode = (err as { code?: unknown }).code;
        const pin =
          err instanceof LanPinMismatchError ||
          (typeof tlsCode === 'string' &&
            /CERT|SELF_SIGNED|UNABLE_TO_VERIFY|SIGNATURE/.test(tlsCode));
        const code = pin ? 'LAN_PIN_MISMATCH' : 'LAN_HUB_UNREACHABLE';
        o.onError?.(code, err.message);
        jsonError(
          res,
          502,
          code,
          pin
            ? 'Main register certificate changed: pair this register again'
            : 'Main register is not reachable',
        );
      });
      upstream.end(body);
    });
    req.on('error', () => res.destroy());
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  const addr = server.address();
  boundPort = typeof addr === 'object' && addr !== null ? addr.port : 0;
  return {
    baseUrl: `http://127.0.0.1:${boundPort}`,
    port: boundPort,
    close: () =>
      new Promise<void>((resolve) => {
        agent.destroy();
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
