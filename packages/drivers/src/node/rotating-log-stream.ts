import fs from 'node:fs';
import path from 'node:path';
import type { CreateRotatingFileLogStreamOptions } from './redact.js';

const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
const DEFAULT_MAX_FILES = 5;

function validateFilename(filename: string): string {
  const trimmed = filename.trim();
  if (
    trimmed.length === 0 ||
    trimmed === '.' ||
    trimmed === '..' ||
    trimmed.includes('/') ||
    trimmed.includes('\\')
  ) {
    throw new Error(`Invalid log filename: ${filename}`);
  }
  return trimmed;
}

function validatePositiveInt(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new RangeError(`${label} must be a positive integer >= 1`);
  }
  return value;
}

/**
 * Synchronous, bounded-size & bounded-count rotating log sink compatible with Pino streams.
 * Closes the active file handle before renaming backups so Windows file locking never blocks rotation.
 */
export class RotatingFileLogStream {
  readonly filePath: string;
  readonly maxBytes: number;
  readonly maxFiles: number;
  private fd: number | null = null;
  private currentSize = 0;
  private closed = false;

  constructor(options: CreateRotatingFileLogStreamOptions) {
    const filename = validateFilename(options.filename);
    this.maxBytes = validatePositiveInt(options.maxBytes ?? DEFAULT_MAX_BYTES, 'maxBytes');
    this.maxFiles = validatePositiveInt(options.maxFiles ?? DEFAULT_MAX_FILES, 'maxFiles');

    const directory = path.resolve(options.directory);
    fs.mkdirSync(directory, { recursive: true });
    this.filePath = path.join(directory, filename);
    this.openActiveFile();
  }

  write(chunk: string | Uint8Array): boolean {
    if (this.closed) {
      throw new Error('Cannot write to closed RotatingFileLogStream');
    }

    const buffer = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : Buffer.from(chunk);

    if (buffer.byteLength === 0) {
      return true;
    }

    if (this.currentSize > 0 && this.currentSize + buffer.byteLength > this.maxBytes) {
      this.rotate();
    }

    if (this.fd === null) {
      this.openActiveFile();
    }

    const activeFd = this.fd;
    if (activeFd === null) {
      throw new Error(`Failed to open log file descriptor: ${this.filePath}`);
    }

    let offset = 0;
    while (offset < buffer.byteLength) {
      offset += fs.writeSync(activeFd, buffer, offset, buffer.byteLength - offset);
    }
    this.currentSize += buffer.byteLength;
    return true;
  }

  end(): void {
    this.close();
  }

  close(): void {
    this.closed = true;
    this.closeFd();
  }

  private openActiveFile(): void {
    if (this.fd !== null) {
      return;
    }
    this.fd = fs.openSync(this.filePath, 'a');
    try {
      this.currentSize = fs.statSync(this.filePath).size;
    } catch {
      this.currentSize = 0;
    }
  }

  private closeFd(): void {
    if (this.fd !== null) {
      fs.closeSync(this.fd);
      this.fd = null;
    }
  }

  private backupPath(index: number): string {
    return `${this.filePath}.${String(index)}`;
  }

  private rotate(): void {
    this.closeFd();

    if (this.maxFiles === 1) {
      fs.rmSync(this.filePath, { force: true });
      this.currentSize = 0;
      this.openActiveFile();
      return;
    }

    const oldestBackup = this.backupPath(this.maxFiles - 1);
    fs.rmSync(oldestBackup, { force: true });

    for (let i = this.maxFiles - 2; i >= 1; i -= 1) {
      const source = this.backupPath(i);
      if (fs.existsSync(source)) {
        fs.renameSync(source, this.backupPath(i + 1));
      }
    }

    if (fs.existsSync(this.filePath)) {
      fs.renameSync(this.filePath, this.backupPath(1));
    }

    this.currentSize = 0;
    this.openActiveFile();
  }
}

export function createRotatingFileLogStream(
  options: CreateRotatingFileLogStreamOptions,
): RotatingFileLogStream {
  return new RotatingFileLogStream(options);
}
