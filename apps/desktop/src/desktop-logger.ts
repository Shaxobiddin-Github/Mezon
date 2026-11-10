import { DEFAULT_LOG_REDACT_PATHS, createRotatingFileLogStream } from '@mezon/drivers/node';
import pino, { type Logger } from 'pino';

export interface DesktopLoggerBundle {
  readonly logger: Logger;
  close(): void;
}

export function createDesktopLogger(options: {
  readonly logDir: string;
  readonly maxBytes?: number;
  readonly maxFiles?: number;
}): DesktopLoggerBundle {
  const stream = createRotatingFileLogStream({
    directory: options.logDir,
    filename: 'mezon-desktop.log',
    maxBytes: options.maxBytes ?? 5 * 1024 * 1024,
    maxFiles: options.maxFiles ?? 5,
  });

  const logger = pino(
    {
      name: '@mezon/desktop',
      level: 'info',
      redact: {
        paths: [...DEFAULT_LOG_REDACT_PATHS],
        censor: '[Redacted]',
      },
    },
    stream,
  );

  return {
    logger,
    close: () => {
      stream.close();
    },
  };
}
