import { randomBytes } from 'node:crypto';
import { DomainError, type UuidV7, parseUuidV7 } from '@mezon/domain';
import Fastify, { type FastifyInstance, type FastifyRequest, type HTTPMethods } from 'fastify';
import { z } from 'zod';
import type { HubAuthService } from './auth-service.js';
import type { HubLanService } from './lan-service.js';

/** Header the LAN proxy sets on forwarded requests; only trusted with the per-process secret. */
export const LAN_TERMINAL_ID_HEADER = 'x-mezon-terminal-id';
const LAN_PROXY_HEADER = 'x-mezon-lan-proxy';
const TERMINAL_AUTH_HEADER = 'x-mezon-terminal';

const terminalIds = new WeakMap<object, UuidV7>();

/**
 * Main-app hook: a terminal id is believed only when the request came through THIS process's LAN
 * proxy (secret header). Anything else, e.g. a local process forging the header, is stripped.
 */
export function registerLanTrustHook(app: FastifyInstance, proxySecret: string): void {
  app.addHook('onRequest', (request, _reply, done) => {
    const h = request.headers;
    const viaProxy = h[LAN_PROXY_HEADER] === proxySecret;
    const tid = h[LAN_TERMINAL_ID_HEADER];
    delete h[LAN_PROXY_HEADER];
    delete h[LAN_TERMINAL_ID_HEADER];
    if (viaProxy && typeof tid === 'string') terminalIds.set(request.raw, parseUuidV7(tid));
    done();
  });
}

/** The paired LAN terminal a request came from, or null for the hub machine itself (loopback). */
export function terminalIdOf(request: FastifyRequest): UuidV7 | null {
  return terminalIds.get(request.raw) ?? null;
}

export function newLanProxySecret(): string {
  return randomBytes(32).toString('base64url');
}

const PairBody = z.strictObject({
  terminalName: z.string().trim().min(1).max(60),
  nonce: z.string().regex(/^[A-Za-z0-9_-]{16,128}$/),
  proof: z.string().regex(/^[0-9a-f]{64}$/),
});

const FORWARD_METHODS: HTTPMethods[] = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];
const HOP_BY_HOP = new Set(['connection', 'content-length', 'transfer-encoding', 'keep-alive']);

const errorBody = (code: string, message: string) => ({ error: { code, message } });

export interface LanListener {
  readonly port: number;
  readonly fingerprint256: string;
  close(): Promise<void>;
}

/**
 * T4.1 LAN listener: HTTPS only, with the hub's pinned certificate. Every request except
 * `/lan/hello` and `/lan/pair` must carry a valid terminal key; it is checked in `onRequest`,
 * before the body is read. Accepted requests are forwarded in-process to the main app.
 */
export async function startLanListener(o: {
  readonly mainApp: FastifyInstance;
  readonly lanService: HubLanService;
  readonly host: string;
  readonly port: number;
  readonly loopbackHost: () => string;
  readonly proxySecret: string;
  readonly bodyLimit?: number;
}): Promise<LanListener> {
  const tls = await o.lanService.tlsMaterial();
  const lan = Fastify({
    https: { key: tls.keyPem, cert: tls.certPem, minVersion: 'TLSv1.2' },
    logger: false,
    bodyLimit: o.bodyLimit ?? 2 * 1024 * 1024,
  });
  lan.removeAllContentTypeParsers();
  lan.addContentTypeParser('*', { parseAs: 'buffer' }, (_req, body, done) => {
    done(null, body);
  });

  const authed = new WeakMap<object, UuidV7>();
  lan.addHook('onRequest', async (request, reply) => {
    const path = request.url.split('?')[0];
    if (path === '/lan/hello' || path === '/lan/pair') return;
    try {
      authed.set(
        request.raw,
        o.lanService.authenticateTerminal(request.headers[TERMINAL_AUTH_HEADER]),
      );
    } catch (err) {
      if (err instanceof DomainError) {
        return reply.code(401).send(errorBody(err.code, err.message));
      }
      throw err;
    }
  });

  lan.get('/lan/hello', () => ({
    service: 'mezon-hub-lan',
    fingerprint256: tls.fingerprint256,
  }));

  lan.post('/lan/pair', async (request, reply) => {
    let body: z.infer<typeof PairBody>;
    try {
      body = PairBody.parse(
        JSON.parse((request.body as Buffer | undefined)?.toString('utf8') ?? ''),
      );
    } catch {
      return reply.code(400).send(errorBody('VALIDATION_ERROR', 'Invalid pairing request'));
    }
    try {
      return await o.lanService.pair(body);
    } catch (err) {
      if (err instanceof DomainError) return reply.code(401).send(errorBody(err.code, err.message));
      throw err;
    }
  });

  lan.route({
    method: FORWARD_METHODS,
    url: '/*',
    handler: async (request, reply) => {
      const terminalId = authed.get(request.raw);
      if (terminalId === undefined) {
        return reply.code(401).send(errorBody('TERMINAL_NOT_PAIRED', 'Not a paired terminal'));
      }
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(request.headers)) {
        if (typeof v !== 'string' || HOP_BY_HOP.has(k)) continue;
        if (k === 'host' || k === TERMINAL_AUTH_HEADER || k === LAN_PROXY_HEADER) continue;
        if (k === LAN_TERMINAL_ID_HEADER) continue;
        headers[k] = v;
      }
      headers.host = o.loopbackHost();
      headers[LAN_PROXY_HEADER] = o.proxySecret;
      headers[LAN_TERMINAL_ID_HEADER] = terminalId;
      const body = request.body as Buffer | undefined;
      const res = await o.mainApp.inject({
        method: request.method,
        url: request.url,
        headers,
        ...(body !== undefined && body.length > 0 ? { payload: body } : {}),
      });
      reply.code(res.statusCode);
      for (const [k, v] of Object.entries(res.headers)) {
        if (v !== undefined && !HOP_BY_HOP.has(k)) reply.header(k, v);
      }
      return reply.send(res.rawPayload);
    },
  });

  await lan.listen({ host: o.host, port: o.port });
  const address = lan.server.address();
  const port = typeof address === 'object' && address !== null ? address.port : o.port;
  return { port, fingerprint256: tls.fingerprint256, close: () => lan.close() };
}

const IdParams = z.strictObject({ id: z.string() });
const PeriodQuery = z.strictObject({
  fromMs: z.string().regex(/^[0-9]{1,16}$/),
  toMs: z.string().regex(/^[0-9]{1,16}$/),
});

/** Owner/manager LAN management; only from the hub machine itself, never from a LAN terminal. */
export function registerLanRoutes(
  app: FastifyInstance,
  authService: HubAuthService,
  lanService: HubLanService,
): void {
  const authorize = async (request: FastifyRequest) => {
    if (terminalIdOf(request) !== null) {
      throw new DomainError('LAN_LOCAL_ONLY', 'LAN terminals are managed on the hub computer only');
    }
    const session = await authService.authenticate(request.headers.authorization);
    authService.assertPermission(session, 'lan:manage');
    return session;
  };

  app.get('/lan/status', async (request) => {
    await authorize(request);
    return lanService.status();
  });

  app.post('/lan/pairing-codes', async (request, reply) => {
    const session = await authorize(request);
    return reply.code(201).send(await lanService.createPairingCode(session.user.id));
  });

  app.get('/lan/terminals', async (request) => {
    await authorize(request);
    return { terminals: lanService.listTerminals() };
  });

  app.get('/lan/terminals/sales', async (request) => {
    await authorize(request);
    const q = PeriodQuery.parse(request.query);
    return { registers: lanService.salesByTerminal(BigInt(q.fromMs), BigInt(q.toMs)) };
  });

  app.post('/lan/terminals/:id/revoke', async (request) => {
    await authorize(request);
    const { id } = IdParams.parse(request.params);
    return { terminal: lanService.revoke(parseUuidV7(id)) };
  });
}
