import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  app,
  BrowserWindow,
  ipcMain,
  powerMonitor,
  protocol,
  safeStorage,
  session,
  utilityProcess,
} from 'electron';
import { LanPairingRejectedError, pairWithLanHub } from '@mezon/drivers/node';
import { loadOrCreateDataKey } from './data-key.js';
import { createDesktopLogger } from './desktop-logger.js';
import { HubSupervisor, type HubBridgeState } from './hub-supervisor.js';
import {
  createProcessDesktopDataDir,
  resolveDesktopLayoutPaths,
  resolveRuntimeAssetPaths,
} from './paths.js';
import {
  APP_HOME_URL,
  APP_SCHEME,
  buildDesktopCspHeader,
  getMimeTypeForPath,
  isAllowedNavigationUrl,
  resolveAppProtocolFilePath,
} from './security-policy.js';
import {
  DEFAULT_UPDATE_MANIFEST_URL,
  PRODUCTION_TRUSTED_UPDATE_KEYS,
  nodeEd25519UpdateVerifier,
} from './update/update-manifest.js';
import { UpdateManager, type UpdateSchedule, type UpdateState } from './update/update-manager.js';
import {
  downloadInstaller,
  fetchUpdateEnvelope,
  sha256File,
  startInstallerDetached,
} from './update/update-node-ports.js';
  type TerminalConfig,
  deleteTerminalConfig,
  isValidLanHost,
  loadTerminalConfig,
  saveTerminalConfig,
  terminalInfoOf,
} from './terminal/terminal-config.js';
import { type TerminalProxy, startTerminalProxy } from './terminal/terminal-proxy.js';

// Redirect userData to persistent local path BEFORE single-instance lock & Chromium profile init.
const dataDir = createProcessDesktopDataDir(app.isPackaged);
const layoutPaths = resolveDesktopLayoutPaths(dataDir);
app.setPath('userData', layoutPaths.userDataDir);
app.setPath('logs', layoutPaths.logDir);

protocol.registerSchemesAsPrivileged([
  {
    scheme: APP_SCHEME,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      bypassCSP: false,
    },
  },
]);

const singleInstanceLockAcquired = app.requestSingleInstanceLock();
if (!singleInstanceLockAcquired) {
  app.exit(0);
}

const desktopLog = createDesktopLogger({ logDir: layoutPaths.logDir });
desktopLog.logger.info(
  {
    isPackaged: app.isPackaged,
    dataDir: layoutPaths.dataDir,
    dbPath: layoutPaths.dbPath,
    logDir: layoutPaths.logDir,
  },
  'desktop_boot_initialized',
);

let mainWindow: BrowserWindow | null = null;
let supervisor: HubSupervisor | null = null;
/** v1 LAN terminal mode: no local hub; the POS reaches the main register through this proxy. */
let terminalConfig: TerminalConfig | null = null;
let terminalProxy: TerminalProxy | null = null;
const terminalConfigPath = path.join(layoutPaths.userDataDir, 'terminal.json');
let currentHubBaseUrl: string | null = null;
let hubShutdownCompleted = false;
let shutdownInProgress: Promise<void> | null = null;
let updateManager: UpdateManager | null = null;
const UPDATE_CHECK_EVERY_MS = 6 * 60 * 60_000;
const UPDATE_TICK_EVERY_MS = 60_000;

function focusMainWindow(): void {
  if (mainWindow === null || mainWindow.isDestroyed()) {
    return;
  }
  if (mainWindow.isMinimized()) {
    mainWindow.restore();
  }
  mainWindow.show();
  mainWindow.focus();
}

async function performCleanShutdown(reason: string): Promise<void> {
  if (shutdownInProgress !== null) {
    return shutdownInProgress;
  }

  shutdownInProgress = (async () => {
    desktopLog.logger.info({ reason }, 'desktop_clean_shutdown_started');
    if (supervisor !== null) {
      await supervisor.shutdown();
    }
    if (terminalProxy !== null) {
      await terminalProxy.close();
    }
    hubShutdownCompleted = true;
    desktopLog.logger.info({ reason }, 'desktop_clean_shutdown_finished');
    desktopLog.close();
  })();

  return shutdownInProgress;
}

function attachWindowSecurityGuards(window: BrowserWindow): void {
  window.webContents.setWindowOpenHandler(({ url }) => {
    desktopLog.logger.warn({ targetUrl: url }, 'desktop_blocked_window_open');
    return { action: 'deny' };
  });

  window.webContents.on('will-navigate', (event, targetUrl) => {
    if (!isAllowedNavigationUrl(targetUrl)) {
      desktopLog.logger.warn({ targetUrl }, 'desktop_blocked_navigation');
      event.preventDefault();
    }
  });

  window.webContents.on('will-attach-webview', (event) => {
    event.preventDefault();
  });

  // Note: If the Windows host loses power abruptly before shutdown completes,
  // SQLite WAL with `synchronous=FULL` guarantees already-committed transactions remain intact.
  window.on('query-session-end', (event) => {
    if (!hubShutdownCompleted) {
      desktopLog.logger.info('desktop_query_session_end');
      event.preventDefault();
      void performCleanShutdown('query-session-end').then(() => {
        app.quit();
      });
    }
  });

  window.on('session-end', () => {
    desktopLog.logger.info('desktop_session_end');
    void performCleanShutdown('session-end');
  });
}

function registerSessionCspHeaders(): void {
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    const responseHeaders = { ...(details.responseHeaders ?? {}) };
    if (isAllowedNavigationUrl(details.url)) {
      responseHeaders['Content-Security-Policy'] = [buildDesktopCspHeader(currentHubBaseUrl)];
      responseHeaders['X-Content-Type-Options'] = ['nosniff'];
    }
    callback({ responseHeaders });
  });
}

function registerSessionPermissionHandlers(): void {
  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    desktopLog.logger.warn({ permission }, 'desktop_blocked_permission_request');
    callback(false);
  });
  session.defaultSession.setPermissionCheckHandler(() => false);
  session.defaultSession.setDevicePermissionHandler(() => false);
}

function registerAppProtocolHandler(uiDir: string): void {
  protocol.handle(APP_SCHEME, async (request) => {
    const resolvedFile = resolveAppProtocolFilePath(request.url, uiDir);
    if (resolvedFile === null) {
      return new Response('Forbidden', { status: 403 });
    }

    try {
      const content = await fs.readFile(resolvedFile);
      const mimeType = getMimeTypeForPath(resolvedFile);
      const headers: Record<string, string> = {
        'Content-Type': mimeType,
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'no-store',
      };
      if (mimeType.startsWith('text/html')) {
        headers['Content-Security-Policy'] = buildDesktopCspHeader(currentHubBaseUrl);
      }
      return new Response(content, { status: 200, headers });
    } catch {
      return new Response('Not Found', { status: 404 });
    }
  });
}

function createMainWindow(): BrowserWindow {
  const preloadPath = path.join(import.meta.dirname, 'preload.cjs');
  const window = new BrowserWindow({
    width: 1024,
    height: 768,
    show: process.env['MEZON_E2E'] !== '1',
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
    },
  });

  attachWindowSecurityGuards(window);
  window.on('closed', () => {
    if (mainWindow === window) {
      mainWindow = null;
    }
  });

  return window;
}

if (singleInstanceLockAcquired) {
  app.on('second-instance', () => {
    desktopLog.logger.info('desktop_second_instance_focused');
    focusMainWindow();
  });

  app.on('before-quit', (event) => {
    if (!hubShutdownCompleted) {
      event.preventDefault();
      void performCleanShutdown('before-quit').then(() => {
        app.quit();
      });
    }
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit();
    }
  });

  void app
    .whenReady()
    .then(async () => {
      const assets = resolveRuntimeAssetPaths(import.meta.dirname);
      desktopLog.logger.info(
        { uiDir: assets.uiDir, hubWorkerPath: assets.hubWorkerPath },
        'desktop_assets_resolved',
      );

      registerSessionCspHeaders();
      registerSessionPermissionHandlers();
      registerAppProtocolHandler(assets.uiDir);

      powerMonitor.on('shutdown', () => {
        if (!hubShutdownCompleted) {
          desktopLog.logger.info('desktop_power_monitor_shutdown');
          void performCleanShutdown('power-monitor-shutdown').then(() => {
            app.quit();
          });
        }
      });

      ipcMain.handle('mezon:get-hub-state', (): HubBridgeState => {
        if (terminalProxy !== null) {
          return { baseUrl: terminalProxy.baseUrl, restartCount: 0, status: 'ready' };
        }
        return (
          supervisor?.getState() ?? {
            baseUrl: currentHubBaseUrl,
            restartCount: 0,
            status: 'starting',
          }
        );
      });

      // v1 LAN terminal: pairing, info and leaving. The terminal key never reaches the renderer.
      ipcMain.handle('mezon:terminal-info', () =>
        terminalConfig === null ? { mode: 'hub' } : terminalInfoOf(terminalConfig),
      );
      ipcMain.handle('mezon:terminal-pair', async (_event, raw: unknown) => {
        const input = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<
          string,
          unknown
        >;
        const host = typeof input['host'] === 'string' ? input['host'].trim() : '';
        const port = input['port'];
        const code = typeof input['code'] === 'string' ? input['code'].trim() : '';
        const name = typeof input['terminalName'] === 'string' ? input['terminalName'].trim() : '';
        if (
          !isValidLanHost(host) ||
          typeof port !== 'number' ||
          !Number.isInteger(port) ||
          port < 1 ||
          port > 65535 ||
          !/^[0-9A-Za-z -]{10,16}$/.test(code) ||
          name.length < 1 ||
          name.length > 60
        ) {
          return { ok: false, code: 'INVALID_INPUT' };
        }
        if (terminalConfig !== null || currentHubBaseUrl === null) {
          return { ok: false, code: 'ALREADY_TERMINAL' };
        }
        // Only a fresh install may become a terminal: its own data would be orphaned otherwise.
        try {
          const health = (await (await fetch(`${currentHubBaseUrl}/health`)).json()) as {
            needsSetup?: unknown;
          };
          if (health.needsSetup !== true) return { ok: false, code: 'LOCAL_DATA_EXISTS' };
        } catch {
          return { ok: false, code: 'LOCAL_HUB_NOT_READY' };
        }
        try {
          const creds = await pairWithLanHub({
            target: { host, port },
            code,
            terminalName: name,
            nonce: randomBytes(18).toString('base64url'),
          });
          const config: TerminalConfig = {
            terminalId: creds.terminalId,
            terminalKey: creds.terminalKey,
            terminalName: name,
            hub: creds.hub,
            pairedAtMs: Date.now(),
          };
          saveTerminalConfig(terminalConfigPath, config, safeStorage);
          desktopLog.logger.info({ host, port }, 'desktop_terminal_paired');
          return { ok: true, fingerprint256: creds.hub.fingerprint256 };
        } catch (error) {
          const rejected = error instanceof LanPairingRejectedError;
          desktopLog.logger.warn(
            { host, port, error: error instanceof Error ? error.message : String(error) },
            'desktop_terminal_pair_failed',
          );
          return { ok: false, code: rejected ? 'PAIRING_REJECTED' : 'HUB_UNREACHABLE' };
        }
      });
      ipcMain.handle('mezon:terminal-leave', () => {
        if (terminalConfig === null) return { ok: false };
        deleteTerminalConfig(terminalConfigPath);
        desktopLog.logger.info('desktop_terminal_left');
        return { ok: true };
      });
      ipcMain.handle('mezon:relaunch', () => {
        // Mode changes (paired / left) take effect on a clean restart.
        app.relaunch();
        app.quit();
      });

      // D4: safeStorage IPC handlers for secure token storage
      ipcMain.handle('mezon:safe-storage-is-available', () => {
        return safeStorage.isEncryptionAvailable();
      });
      ipcMain.handle('mezon:safe-storage-encrypt', (_event, plainText: string) => {
        if (!safeStorage.isEncryptionAvailable()) {
          throw new Error('safeStorage encryption is not available on this platform');
        }
        return safeStorage.encryptString(plainText).toString('base64');
      });
      ipcMain.handle('mezon:safe-storage-decrypt', (_event, base64Cipher: string) => {
        if (!safeStorage.isEncryptionAvailable()) {
          throw new Error('safeStorage encryption is not available on this platform');
        }
        const buffer = Buffer.from(base64Cipher, 'base64');
        return safeStorage.decryptString(buffer);
      });

      let resolveInitialHubReady: (() => void) | null = null;
      const initialHubReadyPromise = new Promise<void>((resolve) => {
        resolveInitialHubReady = resolve;
      });

      terminalConfig = loadTerminalConfig(terminalConfigPath, safeStorage);
      if (terminalConfig !== null) {
        terminalProxy = await startTerminalProxy({
          hub: terminalConfig.hub,
          terminalId: terminalConfig.terminalId,
          terminalKey: terminalConfig.terminalKey,
          onError: (code, message) => {
            desktopLog.logger.warn({ code, message }, 'desktop_terminal_proxy_error');
          },
        });
        currentHubBaseUrl = terminalProxy.baseUrl;
        desktopLog.logger.info(
          { hubHost: terminalConfig.hub.host, hubPort: terminalConfig.hub.port },
          'desktop_terminal_mode',
        );
        // v1: a LAN terminal has no local hub, so it cannot check for an open receipt before an
        // install. Automatic update stays off here; a terminal is updated with the installer.
        const terminalUpdateState: UpdateState = {
          phase: 'disabled',
          currentVersion: app.getVersion(),
          version: null,
          notes: null,
          schedule: null,
          waitReason: null,
          error: null,
        };
        ipcMain.handle('mezon:update-get-state', (): UpdateState => terminalUpdateState);
        ipcMain.handle('mezon:update-schedule', () => false);
        ipcMain.handle('mezon:update-cancel', () => undefined);
        mainWindow = createMainWindow();
        await mainWindow.loadURL(APP_HOME_URL);
        if (process.env['MEZON_E2E'] !== '1') {
          mainWindow.show();
        }
        return;
      }

      // Secrets in the hub DB must stay readable after a restart: one persistent, OS-wrapped key.
      const dataKeyB64 = loadOrCreateDataKey({
        filePath: path.join(layoutPaths.userDataDir, 'hub-data-key.json'),
        cipher: safeStorage,
        onUnwrapped: () => {
          desktopLog.logger.warn('desktop_data_key_not_os_wrapped');
        },
      });

      supervisor = new HubSupervisor({
        dbPath: layoutPaths.dbPath,
        logDir: layoutPaths.logDir,
        allowedOrigins: ['app://mezon'],
        dataKeyB64,
        workerPath: assets.hubWorkerPath,
        logger: desktopLog.logger,
        forkWorker: (workerPath, args) => {
          const child = utilityProcess.fork(workerPath, [...args], {
            serviceName: 'mezon-hub',
            stdio: 'pipe',
          });
          child.stderr?.on('data', (chunk: Buffer) => {
            const text = chunk.toString('utf8').trim();
            if (text.length > 0) {
              desktopLog.logger.error({ workerStderr: text }, 'desktop_hub_worker_stderr');
            }
          });
          return {
            get pid() {
              return child.pid;
            },
            onMessage: (listener) => {
              child.on('message', listener);
            },
            onExit: (listener) => {
              child.on('exit', listener);
            },
            postMessage: (message) => {
              child.postMessage(message);
            },
            kill: () => child.kill(),
          };
        },
        onStateChange: (nextState, { portChanged }) => {
          currentHubBaseUrl = nextState.baseUrl;
          if (nextState.status === 'ready' || nextState.status === 'error') {
            resolveInitialHubReady?.();
            resolveInitialHubReady = null;
          }
          if (mainWindow !== null && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('mezon:hub-state', nextState);
            if (nextState.status === 'ready' && portChanged) {
              desktopLog.logger.info(
                { baseUrl: nextState.baseUrl },
                'desktop_reloading_window_for_new_hub_port',
              );
              mainWindow.webContents.reloadIgnoringCache();
            }
          }
        },
      });

      supervisor.start();
      await initialHubReadyPromise;

      // T4.8: signed automatic update. Off until the owner's update key is built in and a
      // manifest URL is configured (MEZON_UPDATE_MANIFEST_URL).
      const manifestUrl = process.env['MEZON_UPDATE_MANIFEST_URL'] ?? DEFAULT_UPDATE_MANIFEST_URL;
      const hub = supervisor;
      updateManager = new UpdateManager({
        dir: path.join(layoutPaths.userDataDir, 'updates'),
        currentVersion: app.getVersion(),
        platform: `${process.platform}-${process.arch}`,
        channel: 'stable',
        enabled:
          app.isPackaged &&
          PRODUCTION_TRUSTED_UPDATE_KEYS.length > 0 &&
          manifestUrl.startsWith('https://'),
        trustedKeys: PRODUCTION_TRUSTED_UPDATE_KEYS,
        verifier: nodeEd25519UpdateVerifier,
        ports: {
          fetchEnvelope: () => fetchUpdateEnvelope(manifestUrl),
          download: (url, dest, maxBytes) => downloadInstaller(url, dest, maxBytes),
          sha256File,
          // A backup of a large database can take minutes: wait for it, so a slow backup is never
          // mistaken for "no answer" (which would start another backup on the next tick).
          prepare: (version, backup) =>
            hub.prepareUpdate(version, backup, backup ? 10 * 60_000 : 30_000),
          launchInstaller: async (installerPath, expected) => {
            desktopLog.logger.info({ installerPath }, 'desktop_update_installing');
            await performCleanShutdown('update-install');
            // B3: the very last check, after the hub is stopped and right before the start.
            const actual = await sha256File(installerPath);
            if (
              actual.sha256 !== expected.sha256 ||
              String(actual.sizeBytes) !== expected.sizeBytes
            ) {
              await fs.rm(installerPath, { force: true });
              app.relaunch();
              app.quit();
              throw new Error('Installer changed on disk before start; removed, app restarted');
            }
            startInstallerDetached(installerPath);
            app.quit();
          },
          cancelPrepared: () => hub.cancelPreparedUpdate(),
          nowMs: () => BigInt(Date.now()),
        },
        onState: (state: UpdateState) => {
          desktopLog.logger.info(
            { phase: state.phase, version: state.version, waitReason: state.waitReason },
            'desktop_update_state',
          );
          if (mainWindow !== null && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('mezon:update-state', state);
          }
        },
      });
      const updates = updateManager;
      ipcMain.handle('mezon:update-get-state', (): UpdateState => updates.getState());
      ipcMain.handle('mezon:update-schedule', (_event, choice: unknown) =>
        updates.schedule(choice as UpdateSchedule),
      );
      ipcMain.handle('mezon:update-cancel', () => updates.cancelSchedule());
      await updates.init();
      void updates.check();
      setInterval(() => void updates.check(), UPDATE_CHECK_EVERY_MS).unref();
      setInterval(() => void updates.tick(), UPDATE_TICK_EVERY_MS).unref();

      mainWindow = createMainWindow();
      await mainWindow.loadURL(APP_HOME_URL);
      if (process.env['MEZON_E2E'] !== '1') {
        mainWindow.show();
      }
    })
    .catch((error: unknown) => {
      desktopLog.logger.fatal(
        { error: error instanceof Error ? error.message : String(error) },
        'desktop_startup_failed',
      );
      desktopLog.close();
      app.exit(1);
    });
}
