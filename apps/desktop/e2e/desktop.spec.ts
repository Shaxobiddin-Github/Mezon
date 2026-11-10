import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron, expect, test } from '@playwright/test';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const desktopDir = path.resolve(__dirname, '..');
const appAsarPath = path.join(desktopDir, 'dist-electron', 'win-unpacked', 'resources', 'app.asar');
const electronExecutablePath = require('electron') as unknown as string;

const tempDirs: string[] = [];

function createTempDataDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mezon-e2e-'));
  tempDirs.push(dir);
  return dir;
}

interface DesktopLogEntry {
  readonly msg?: string;
  readonly hubPid?: number;
  readonly port?: number;
  readonly baseUrl?: string;
}

function readDesktopLogEntries(logPath: string): DesktopLogEntry[] {
  if (!fs.existsSync(logPath)) {
    return [];
  }
  return fs
    .readFileSync(logPath, 'utf8')
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as DesktopLogEntry];
      } catch {
        return [];
      }
    });
}

function getLatestReadyWorker(
  logPath: string,
): { readonly pid: number; readonly port: number } | null {
  const entries = readDesktopLogEntries(logPath);
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i];
    if (
      entry?.msg === 'desktop_hub_ready' &&
      typeof entry.hubPid === 'number' &&
      typeof entry.port === 'number'
    ) {
      return { pid: entry.hubPid, port: entry.port };
    }
  }
  return null;
}

async function occupyLoopbackPortWithRetry(port: number, timeoutMs = 450): Promise<net.Server> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const server = net.createServer();
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen({ host: '127.0.0.1', port, exclusive: true }, () => {
          server.removeListener('error', reject);
          resolve();
        });
      });
      return server;
    } catch {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
      await new Promise((r) => setTimeout(r, 10));
    }
  }
  throw new Error(`Failed to occupy loopback port ${String(port)} within ${String(timeoutMs)}ms`);
}

test.afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

test('Playwright unfused Electron against identical app.asar: app://mezon, CSP, single instance, and T1 Hub crash recovery', async () => {
  expect(fs.existsSync(appAsarPath)).toBe(true);
  const dataDir = createTempDataDir();
  const dbPath = path.join(dataDir, 'data', 'mezon.db');
  const desktopLogPath = path.join(dataDir, 'logs', 'mezon-desktop.log');
  const hubLogPath = path.join(dataDir, 'logs', 'mezon-hub.log');

  const launchEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && key !== 'ELECTRON_RUN_AS_NODE') {
      launchEnv[key] = value;
    }
  }
  launchEnv['MEZON_E2E'] = '1';
  launchEnv['MEZON_DATA_DIR'] = dataDir;

  const electronApp = await electron.launch({
    executablePath: electronExecutablePath,
    args: [appAsarPath],
    env: launchEnv,
  });

  try {
    const page = await electronApp.firstWindow();

    // 1. Custom app://mezon origin, never file://, and live /health 200 inside UI.
    expect(page.url()).toMatch(/^app:\/\/mezon\//);
    expect(page.url()).not.toContain('file://');

    await expect(page.getByTestId('hub-origin')).toHaveText('app://mezon');
    await expect(page.getByTestId('health-status')).toHaveText('ok', { timeout: 15_000 });
    await expect(page.getByTestId('health-needs-setup')).toHaveText('true');
    await expect(page.getByTestId('hub-restart-count')).toHaveText('0');

    const initialHubUrl = (await page.getByTestId('hub-url').innerText()).trim();
    expect(initialHubUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    const initialCountText = await page.getByTestId('health-check-count').innerText();
    const initialCheckCount = Number(initialCountText);
    expect(initialCheckCount).toBeGreaterThanOrEqual(1);

    // DB + rotating log files exist inside MEZON_DATA_DIR.
    expect(fs.existsSync(dbPath)).toBe(true);
    expect(fs.existsSync(desktopLogPath)).toBe(true);
    expect(fs.existsSync(hubLogPath)).toBe(true);

    // Hub rejects non-app://mezon Origin requests cleanly.
    const rejectedHealth = await fetch(`${initialHubUrl}/health`, {
      headers: { Origin: 'file://' },
    });
    expect(rejectedHealth.status).toBe(403);

    // 2. Renderer sandbox, CSP inline-script block, & preload boundary checks.
    const sandboxDiagnostics = await page.evaluate(() => {
      const win = window as unknown as {
        process?: unknown;
        require?: unknown;
        ipcRenderer?: unknown;
        mezonBridge?: Record<string, unknown>;
        __cspInlineExecuted?: boolean;
      };
      const inlineScript = document.createElement('script');
      inlineScript.textContent = 'window.__cspInlineExecuted = true;';
      document.body.appendChild(inlineScript);
      inlineScript.remove();
      return {
        hasProcess: typeof win.process !== 'undefined',
        hasRequire: typeof win.require !== 'undefined',
        hasIpcRenderer: typeof win.ipcRenderer !== 'undefined',
        cspInlineExecuted: Boolean(win.__cspInlineExecuted),
        bridgeKeys: win.mezonBridge ? Object.keys(win.mezonBridge).sort() : [],
      };
    });
    expect(sandboxDiagnostics).toEqual({
      hasProcess: false,
      hasRequire: false,
      hasIpcRenderer: false,
      cspInlineExecuted: false,
      bridgeKeys: ['getHubState', 'onHubState'],
    });

    // External window.open must stay blocked.
    const popupOpened = await page.evaluate(() => window.open('https://example.com') !== null);
    expect(popupOpened).toBe(false);
    expect(electronApp.windows()).toHaveLength(1);

    // 3. Second instance with identical MEZON_DATA_DIR exits cleanly and keeps single window.
    const secondInstanceExitCode = await new Promise<number | null>((resolve, reject) => {
      const secondChild = spawn(electronExecutablePath, [appAsarPath], {
        env: launchEnv,
        stdio: 'ignore',
        windowsHide: true,
      });
      const timer = setTimeout(() => {
        secondChild.kill('SIGKILL');
        reject(new Error('Second instance did not exit within timeout'));
      }, 10_000);
      secondChild.on('exit', (code) => {
        clearTimeout(timer);
        resolve(code);
      });
    });
    expect(secondInstanceExitCode).toBe(0);
    expect(electronApp.windows()).toHaveLength(1);
    await expect
      .poll(() =>
        readDesktopLogEntries(desktopLogPath).some(
          (entry) => entry.msg === 'desktop_second_instance_focused',
        ),
      )
      .toBe(true);

    // 4a. T1 Part 1: Kill Hub utilityProcess and verify same-port restart + UI /health 200.
    const worker1 = getLatestReadyWorker(desktopLogPath);
    expect(worker1).not.toBeNull();
    process.kill(worker1!.pid);

    await expect(page.getByTestId('hub-restart-count')).toHaveText('1', { timeout: 15_000 });
    await expect(page.getByTestId('health-status')).toHaveText('ok', { timeout: 15_000 });
    await expect(page.getByTestId('hub-url')).toHaveText(initialHubUrl);
    await expect
      .poll(async () => Number(await page.getByTestId('health-check-count').innerText()))
      .toBeGreaterThan(initialCheckCount);

    // 4b. T1 Part 2: Kill Hub utilityProcess again while occupying its preferred port so
    // Hub must pick a new port, main must update CSP + reload window, and UI /health stays ok!
    const worker2 = getLatestReadyWorker(desktopLogPath);
    expect(worker2).not.toBeNull();
    expect(worker2!.port).toBe(worker1!.port);

    process.kill(worker2!.pid);
    const portOccupier = await occupyLoopbackPortWithRetry(worker2!.port);
    try {
      await expect(page.getByTestId('hub-restart-count')).toHaveText('2', { timeout: 15_000 });
      await expect(page.getByTestId('health-status')).toHaveText('ok', { timeout: 15_000 });
      const recoveredHubUrl = (await page.getByTestId('hub-url').innerText()).trim();
      expect(recoveredHubUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      expect(recoveredHubUrl).not.toBe(initialHubUrl);
    } finally {
      await new Promise<void>((resolve) => {
        portOccupier.close(() => resolve());
      });
    }

    // 5. External navigation must stay blocked by main will-navigate guard.
    await page.evaluate(() => {
      window.location.href = 'https://example.com/';
    });
    await expect
      .poll(() =>
        readDesktopLogEntries(desktopLogPath).some(
          (entry) => entry.msg === 'desktop_blocked_navigation',
        ),
      )
      .toBe(true);
    expect(page.url()).toMatch(/^app:\/\/mezon\//);
  } catch (error) {
    if (fs.existsSync(desktopLogPath)) {
      console.error('=== E2E FAILURE DESKTOP LOG ===\n' + fs.readFileSync(desktopLogPath, 'utf8'));
    }
    throw error;
  } finally {
    await electronApp.close();
  }
});
