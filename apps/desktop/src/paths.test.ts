import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveDesktopDataDir, resolveDesktopLayoutPaths } from './paths.js';

describe('resolveDesktopDataDir (T5 & Windows LOCALAPPDATA)', () => {
  it('defaults to LOCALAPPDATA\\Mezon on Windows instead of Roaming APPDATA', () => {
    const result = resolveDesktopDataDir({
      isPackaged: true,
      platform: 'win32',
      homedir: 'C:\\Users\\kassir',
      env: {
        LOCALAPPDATA: 'C:\\Users\\kassir\\AppData\\Local',
        APPDATA: 'C:\\Users\\kassir\\AppData\\Roaming',
      },
    });
    expect(result).toBe(path.join('C:\\Users\\kassir\\AppData\\Local', 'Mezon'));
    expect(result).not.toContain('Roaming');
  });

  it('ignores MEZON_DATA_DIR in packaged builds even when MEZON_E2E=1 is set', () => {
    const result = resolveDesktopDataDir({
      isPackaged: true,
      platform: 'win32',
      homedir: 'C:\\Users\\kassir',
      env: {
        LOCALAPPDATA: 'C:\\Users\\kassir\\AppData\\Local',
        MEZON_E2E: '1',
        MEZON_DATA_DIR: 'C:\\temp\\rogue-override',
      },
    });
    expect(result).toBe(path.join('C:\\Users\\kassir\\AppData\\Local', 'Mezon'));
    expect(result).not.toContain('rogue-override');
  });

  it('ignores MEZON_DATA_DIR in unpackaged builds unless MEZON_E2E=1 is also set', () => {
    const withoutFlag = resolveDesktopDataDir({
      isPackaged: false,
      platform: 'win32',
      homedir: 'C:\\Users\\dev',
      env: {
        LOCALAPPDATA: 'C:\\Users\\dev\\AppData\\Local',
        MEZON_DATA_DIR: 'C:\\temp\\e2e-dir',
      },
    });
    expect(withoutFlag).toBe(path.join('C:\\Users\\dev\\AppData\\Local', 'Mezon'));

    const withWrongFlag = resolveDesktopDataDir({
      isPackaged: false,
      platform: 'win32',
      homedir: 'C:\\Users\\dev',
      env: {
        LOCALAPPDATA: 'C:\\Users\\dev\\AppData\\Local',
        MEZON_E2E: 'true',
        MEZON_DATA_DIR: 'C:\\temp\\e2e-dir',
      },
    });
    expect(withWrongFlag).toBe(path.join('C:\\Users\\dev\\AppData\\Local', 'Mezon'));
  });

  it('uses MEZON_DATA_DIR strictly in unpackaged test mode with MEZON_E2E=1', () => {
    const customDir = path.join(path.sep, 'tmp', 'mezon-e2e-data');
    const result = resolveDesktopDataDir({
      isPackaged: false,
      platform: 'linux',
      homedir: '/home/ci',
      env: {
        MEZON_E2E: '1',
        MEZON_DATA_DIR: customDir,
      },
    });
    expect(result).toBe(path.resolve(customDir));

    const layout = resolveDesktopLayoutPaths(result);
    expect(layout.dbPath).toBe(path.join(path.resolve(customDir), 'data', 'mezon.db'));
    expect(layout.logDir).toBe(path.join(path.resolve(customDir), 'logs'));
    expect(layout.userDataDir).toBe(path.resolve(customDir));
  });
});
