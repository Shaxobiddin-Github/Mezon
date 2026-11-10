import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface ResolveDesktopDataDirInput {
  readonly isPackaged: boolean;
  readonly platform: NodeJS.Platform;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly homedir: string;
  readonly xdgDataHomeDefault?: string;
}

export interface DesktopLayoutPaths {
  readonly dataDir: string;
  readonly userDataDir: string;
  readonly dbDir: string;
  readonly dbPath: string;
  readonly logDir: string;
}

export interface RuntimeAssetPaths {
  readonly uiDir: string;
  readonly hubWorkerPath: string;
}

/**
 * Resolves the persistent user/store data directory.
 * On Windows this defaults to `%LOCALAPPDATA%\Mezon` (never `%APPDATA%\Roaming`).
 * `MEZON_DATA_DIR` override is ignored in packaged builds and requires BOTH `MEZON_E2E=1` and `MEZON_DATA_DIR`.
 */
export function resolveDesktopDataDir(input: ResolveDesktopDataDirInput): string {
  const e2eOverride = input.env['MEZON_DATA_DIR']?.trim() ?? '';
  if (!input.isPackaged && input.env['MEZON_E2E'] === '1' && e2eOverride.length > 0) {
    return path.resolve(e2eOverride);
  }

  if (input.platform === 'win32') {
    const localAppData = input.env['LOCALAPPDATA']?.trim() ?? '';
    const baseDir =
      localAppData.length > 0 ? localAppData : path.join(input.homedir, 'AppData', 'Local');
    return path.join(baseDir, 'Mezon');
  }

  if (input.platform === 'darwin') {
    return path.join(input.homedir, 'Library', 'Application Support', 'Mezon');
  }

  const xdgDataHome = input.env['XDG_DATA_HOME']?.trim() ?? '';
  const baseDir =
    xdgDataHome.length > 0
      ? xdgDataHome
      : (input.xdgDataHomeDefault ?? path.join(input.homedir, '.local', 'share'));
  return path.join(baseDir, 'Mezon');
}

export function resolveDesktopLayoutPaths(dataDir: string): DesktopLayoutPaths {
  const resolved = path.resolve(dataDir);
  const dbDir = path.join(resolved, 'data');
  return {
    dataDir: resolved,
    userDataDir: resolved,
    dbDir,
    dbPath: path.join(dbDir, 'mezon.db'),
    logDir: path.join(resolved, 'logs'),
  };
}

export function createProcessDesktopDataDir(isPackaged: boolean): string {
  return resolveDesktopDataDir({
    isPackaged,
    platform: process.platform,
    env: process.env,
    homedir: os.homedir(),
  });
}

export function resolveRuntimeAssetPaths(moduleDir: string): RuntimeAssetPaths {
  const stagedRoot = path.resolve(moduleDir, '..');
  const stagedUiDir = path.join(stagedRoot, 'pos');
  const stagedHubWorker = path.join(
    stagedRoot,
    'node_modules',
    '@mezon',
    'hub',
    'dist',
    'electron-worker-entry.mjs',
  );

  if (fs.existsSync(path.join(stagedUiDir, 'index.html')) && fs.existsSync(stagedHubWorker)) {
    return {
      uiDir: stagedUiDir,
      hubWorkerPath: stagedHubWorker,
    };
  }

  const monorepoUiDir = path.resolve(moduleDir, '..', '..', 'pos', 'dist');
  const monorepoHubWorker = path.resolve(
    moduleDir,
    '..',
    '..',
    'hub',
    'dist',
    'electron-worker-entry.mjs',
  );

  if (fs.existsSync(path.join(monorepoUiDir, 'index.html')) && fs.existsSync(monorepoHubWorker)) {
    return {
      uiDir: monorepoUiDir,
      hubWorkerPath: monorepoHubWorker,
    };
  }

  throw new Error(
    `Desktop runtime assets not found (checked staged=${stagedRoot} and monorepo=${monorepoUiDir})`,
  );
}
