import { DomainError } from '@mezon/domain';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ResolvedHubSecurityConfig } from './config.js';

export interface HostAllowlistState {
  updatePort(actualPort: number): void;
  getAllowedHosts(): ReadonlySet<string>;
}

export function createHostAllowlistState(initialPort: number): HostAllowlistState {
  let activePort = initialPort;

  const buildHosts = (port: number): Set<string> => {
    if (port <= 0) {
      return new Set<string>();
    }
    return new Set<string>([`127.0.0.1:${port}`, `localhost:${port}`]);
  };

  let hosts = buildHosts(initialPort);

  return {
    updatePort(actualPort: number): void {
      if (actualPort !== activePort && Number.isInteger(actualPort) && actualPort > 0) {
        activePort = actualPort;
        hosts = buildHosts(actualPort);
      }
    },
    getAllowedHosts(): ReadonlySet<string> {
      return hosts;
    },
  };
}

function sendSecurityError(
  reply: FastifyReply,
  statusCode: number,
  err: DomainError,
): FastifyReply {
  return reply
    .code(statusCode)
    .header('cache-control', 'no-store')
    .header('x-content-type-options', 'nosniff')
    .send({
      error: {
        code: err.code,
        message: err.message,
      },
    });
}

function assertValidHostHeader(
  rawHost: string | string[] | undefined,
  allowedHosts: ReadonlySet<string>,
): void {
  if (typeof rawHost !== 'string') {
    throw new DomainError('INVALID_HOST', 'Host header is missing or invalid');
  }
  const normalized = rawHost.trim().toLowerCase();
  if (
    normalized === '' ||
    normalized.includes(',') ||
    normalized.includes(' ') ||
    !allowedHosts.has(normalized)
  ) {
    throw new DomainError('INVALID_HOST', 'Host header is not allowed');
  }
}

function isAllowlistedDesktopAppOrigin(
  rawOrigin: string | string[] | undefined,
  allowedOrigins: ReadonlySet<string>,
): string | null {
  if (typeof rawOrigin !== 'string') {
    return null;
  }
  const normalized = rawOrigin.trim();
  if (!normalized.startsWith('app://') || !allowedOrigins.has(normalized)) {
    return null;
  }
  return normalized;
}

function assertAllowedBrowserOrigin(
  request: FastifyRequest,
  allowedOrigins: ReadonlySet<string>,
): string | null {
  const desktopAppOrigin = isAllowlistedDesktopAppOrigin(request.headers.origin, allowedOrigins);

  const secFetchSite = request.headers['sec-fetch-site'];
  if (
    desktopAppOrigin === null &&
    typeof secFetchSite === 'string' &&
    secFetchSite.trim().toLowerCase() === 'cross-site'
  ) {
    throw new DomainError('FORBIDDEN_ORIGIN', 'Cross-site requests are forbidden');
  }

  // Strictly close browser CORS preflight unless the request comes from an allowlisted Electron app:// origin
  if (request.method.toUpperCase() === 'OPTIONS' && desktopAppOrigin === null) {
    throw new DomainError('FORBIDDEN_ORIGIN', 'CORS preflight requests are not allowed');
  }

  const rawOrigin = request.headers.origin;
  if (rawOrigin === undefined) {
    return null;
  }
  if (typeof rawOrigin !== 'string') {
    throw new DomainError('FORBIDDEN_ORIGIN', 'Origin header is invalid');
  }

  const normalizedOrigin = rawOrigin.trim();
  if (
    normalizedOrigin === '' ||
    normalizedOrigin === 'null' ||
    !allowedOrigins.has(normalizedOrigin)
  ) {
    throw new DomainError('FORBIDDEN_ORIGIN', 'Origin is not allowed');
  }

  return desktopAppOrigin;
}

export function registerHubSecurityHooks(
  app: FastifyInstance,
  config: ResolvedHubSecurityConfig,
  hostState: HostAllowlistState,
): void {
  app.addHook('onRequest', async (request, reply) => {
    try {
      assertValidHostHeader(request.headers.host, hostState.getAllowedHosts());
    } catch (err) {
      if (err instanceof DomainError) {
        return sendSecurityError(reply, 421, err);
      }
      throw err;
    }

    let desktopAppOrigin: string | null = null;
    try {
      desktopAppOrigin = assertAllowedBrowserOrigin(request, config.allowedOrigins);
    } catch (err) {
      if (err instanceof DomainError) {
        return sendSecurityError(reply, 403, err);
      }
      throw err;
    }

    if (desktopAppOrigin !== null && request.method.toUpperCase() === 'OPTIONS') {
      return reply
        .code(204)
        .header('access-control-allow-origin', desktopAppOrigin)
        .header('vary', 'Origin')
        .header('access-control-allow-methods', 'GET, POST, PUT, PATCH, DELETE')
        .header('access-control-allow-headers', 'authorization, content-type, x-pin')
        .header('access-control-max-age', '600')
        .send();
    }
  });

  app.addHook('onSend', async (request, reply, payload) => {
    const desktopAppOrigin = isAllowlistedDesktopAppOrigin(
      request.headers.origin,
      config.allowedOrigins,
    );
    reply.removeHeader('set-cookie');
    reply.removeHeader('access-control-allow-credentials');

    if (desktopAppOrigin !== null && reply.statusCode < 400) {
      reply.header('access-control-allow-origin', desktopAppOrigin);
      reply.header('vary', 'Origin');
    } else {
      reply.removeHeader('access-control-allow-origin');
      reply.removeHeader('access-control-allow-methods');
      reply.removeHeader('access-control-allow-headers');
    }

    reply.header('cache-control', 'no-store');
    reply.header('x-content-type-options', 'nosniff');
    return payload;
  });
}
