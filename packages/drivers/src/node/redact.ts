export const DEFAULT_LOG_REDACT_PATHS: readonly string[] = [
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
  'cost',
  '*.cost',
  '*.*.cost',
  'costValue',
  '*.costValue',
  '*.*.costValue',
  'costPrice',
  '*.costPrice',
  'profit',
  '*.profit',
  '*.*.profit',
  'margin',
  '*.margin',
];

export interface CreateRotatingFileLogStreamOptions {
  readonly directory: string;
  readonly filename: string;
  /** Maximum size in bytes before active log rotates (default: 5 MiB). */
  readonly maxBytes?: number;
  /** Maximum total log files to retain including the active file (default: 5). */
  readonly maxFiles?: number;
}
