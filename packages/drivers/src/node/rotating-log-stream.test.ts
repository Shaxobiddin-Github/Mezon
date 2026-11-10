import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createRotatingFileLogStream } from './rotating-log-stream.js';

const tempDirs: string[] = [];

function createTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mezon-log-rotate-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe('RotatingFileLogStream', () => {
  it('rotates active logs by maxBytes and never keeps more than maxFiles files', () => {
    const dir = createTempDir();
    const stream = createRotatingFileLogStream({
      directory: dir,
      filename: 'mezon-hub.log',
      maxBytes: 40,
      maxFiles: 3,
    });

    for (let i = 0; i < 12; i += 1) {
      stream.write(`{"seq":${String(i).padStart(2, '0')},"msg":"entry-payload"}\n`);
    }
    stream.close();

    const files = fs.readdirSync(dir).sort();
    expect(files).toEqual(['mezon-hub.log', 'mezon-hub.log.1', 'mezon-hub.log.2']);
    expect(fs.existsSync(path.join(dir, 'mezon-hub.log.3'))).toBe(false);

    for (const file of files) {
      const size = fs.statSync(path.join(dir, file)).size;
      expect(size).toBeGreaterThan(0);
      expect(size).toBeLessThanOrEqual(40);
    }

    const activeContent = fs.readFileSync(path.join(dir, 'mezon-hub.log'), 'utf8');
    expect(activeContent).toContain('"seq":11');
  });

  it('tracks existing active file size across restarts', () => {
    const dir = createTempDir();
    const first = createRotatingFileLogStream({
      directory: dir,
      filename: 'mezon-desktop.log',
      maxBytes: 50,
      maxFiles: 2,
    });
    first.write('123456789012345678901234567890\n');
    first.close();

    const second = createRotatingFileLogStream({
      directory: dir,
      filename: 'mezon-desktop.log',
      maxBytes: 50,
      maxFiles: 2,
    });
    second.write('abcdefghijklmnopqrstuvwxyz1234\n');
    second.close();

    const files = fs.readdirSync(dir).sort();
    expect(files).toEqual(['mezon-desktop.log', 'mezon-desktop.log.1']);
  });

  it('caps files to 1 when maxFiles is 1 and rejects invalid inputs', () => {
    const dir = createTempDir();
    const single = createRotatingFileLogStream({
      directory: dir,
      filename: 'single.log',
      maxBytes: 20,
      maxFiles: 1,
    });
    single.write('first-line-over-ten\n');
    single.write('second-line-over-ten\n');
    single.close();

    expect(fs.readdirSync(dir)).toEqual(['single.log']);
    expect(() => createRotatingFileLogStream({ directory: dir, filename: '../bad.log' })).toThrow();
    expect(() =>
      createRotatingFileLogStream({ directory: dir, filename: 'ok.log', maxBytes: 0 }),
    ).toThrow();
  });
});
