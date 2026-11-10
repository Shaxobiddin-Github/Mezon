import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createDesktopLogger } from './desktop-logger.js';

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe('createDesktopLogger (T4 rotation + redaction)', () => {
  it('rotates logs under maxBytes/maxFiles and redacts sensitive keys', () => {
    const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mezon-desktop-log-'));
    tempDirs.push(logDir);

    const desktopLog = createDesktopLogger({
      logDir,
      maxBytes: 220,
      maxFiles: 2,
    });

    for (let i = 0; i < 6; i += 1) {
      desktopLog.logger.info(
        {
          seq: i,
          pin: '9988',
          token: 'super-secret-device-token',
          req: { headers: { authorization: 'Bearer raw-jwt' } },
        },
        'audit_check',
      );
    }
    desktopLog.close();

    const files = fs.readdirSync(logDir).sort();
    expect(files).toEqual(['mezon-desktop.log', 'mezon-desktop.log.1']);
    const contents = files
      .map((file) => fs.readFileSync(path.join(logDir, file), 'utf8'))
      .join('\n');
    expect(contents).toContain('[Redacted]');
    expect(contents).not.toContain('9988');
    expect(contents).not.toContain('super-secret-device-token');
    expect(contents).not.toContain('raw-jwt');
  });
});
