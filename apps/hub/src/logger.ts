import { DEFAULT_LOG_REDACT_PATHS, createRotatingFileLogStream } from '@mezon/drivers/node';
import pino, { type DestinationStream, type LevelWithSilent, type Logger } from 'pino';

export const HUB_LOGGER_REDACT_PATHS: readonly string[] = DEFAULT_LOG_REDACT_PATHS;

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
