import pino, { type DestinationStream, type LevelWithSilent, type Logger } from 'pino';

export const HUB_LOGGER_REDACT_PATHS: readonly string[] = [
  'req.headers.authorization',
  'req.headers["x-pin"]',
  'req.headers.cookie',
  'req.headers["set-cookie"]',
  'res.headers["set-cookie"]',
  'pin',
  '*.pin',
  '*.*.pin',
  'newPin',
  '*.newPin',
  'pinHash',
  '*.pinHash',
  'token',
  '*.token',
  '*.*.token',
  'accessToken',
  '*.accessToken',
  'tokenHash',
  '*.tokenHash',
  'password',
  '*.password',
  'secret',
  '*.secret',
];

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
  };

  return options?.stream ? pino(pinoOptions, options.stream) : pino(pinoOptions);
}
