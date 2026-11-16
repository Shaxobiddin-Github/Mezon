import { DEFAULT_LOG_REDACT_PATHS, createRotatingFileLogStream } from '@mezon/drivers/node';
import pino, { type DestinationStream, type LevelWithSilent, type Logger } from 'pino';

export const HUB_LOGGER_REDACT_PATHS: readonly string[] = DEFAULT_LOG_REDACT_PATHS;

const REDACTED_LOG_QUERY_KEYS = new Set<string>([
  'q',
  'tin',
  'phone',
  'pin',
  'token',
  'secret',
  'password',
]);

/**
 * Strips sensitive query parameter values (`q`, `tin`, `phone`, `pin`, `token`, etc.) from URLs
 * before Pino/Fastify writes request telemetry so search terms (customer names/phones, supplier
 * names/TINs) never leak into log files.
 */
export function sanitizeRequestUrlForLog(rawUrl: string): string {
  const qIdx = rawUrl.indexOf('?');
  if (qIdx < 0) {
    return rawUrl;
  }
  const pathPart = rawUrl.slice(0, qIdx);
  const queryPart = rawUrl.slice(qIdx + 1);
  const sanitized = queryPart
    .split('&')
    .filter((segment) => segment.length > 0)
    .map((segment) => {
      const eqIdx = segment.indexOf('=');
      if (eqIdx < 0) {
        return segment;
      }
      const rawKey = segment.slice(0, eqIdx);
      let decodedKey = rawKey;
      try {
        decodedKey = decodeURIComponent(rawKey);
      } catch {
        // leave malformed percent-encoding intact for key comparison
      }
      return REDACTED_LOG_QUERY_KEYS.has(decodedKey) ? `${rawKey}=[Redacted]` : segment;
    })
    .join('&');
  return sanitized.length > 0 ? `${pathPart}?${sanitized}` : pathPart;
}

export interface CreateHubLoggerOptions {
  readonly level?: LevelWithSilent;
  readonly stream?: DestinationStream;
}

export function createHubLogger(options?: CreateHubLoggerOptions): Logger {
  const pinoOptions = {
    name: '@mezon/hub',
    level: options?.level ?? 'info',
    redact: {
      paths: [...HUB_LOGGER_REDACT_PATHS],
      censor: '[Redacted]',
    },
    serializers: {
      req(req: {
        readonly raw?: unknown;
        readonly method?: string;
        readonly url?: string;
        readonly headers?: Readonly<Record<string, unknown>>;
        readonly host?: string;
        readonly ip?: string;
        readonly remoteAddress?: string;
        readonly socket?: { readonly remotePort?: number };
      }) {
        if (
          req.raw === undefined &&
          req.method === undefined &&
          req.url === undefined &&
          req.headers === undefined
        ) {
          return req;
        }
        return {
          method: req.method,
          url: typeof req.url === 'string' ? sanitizeRequestUrlForLog(req.url) : req.url,
          version: req.headers?.['accept-version'],
          host: req.host,
          remoteAddress: req.ip ?? req.remoteAddress,
          remotePort: req.socket?.remotePort,
        };
      },
    },
  };

  return options?.stream ? pino(pinoOptions, options.stream) : pino(pinoOptions);
}

export interface CreateRotatingHubLogStreamOptions {
  readonly logDir: string;
  readonly filename?: string;
  readonly maxBytes?: number;
  readonly maxFiles?: number;
}

export function createRotatingHubLogStream(options: CreateRotatingHubLogStreamOptions) {
  return createRotatingFileLogStream({
    directory: options.logDir,
    filename: options.filename ?? 'mezon-hub.log',
    maxBytes: options.maxBytes,
    maxFiles: options.maxFiles,
  });
}
