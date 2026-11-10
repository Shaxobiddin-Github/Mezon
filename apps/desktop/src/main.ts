import fs from 'node:fs/promises';
import path from 'node:path';
import {
  app,
  BrowserWindow,
  ipcMain,
  powerMonitor,
  protocol,
  session,
  utilityProcess,
} from 'electron';
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
let currentHubBaseUrl: string | null = null;
let hubShutdownCompleted = false;
let shutdownInProgress: Promise<void> | null = null;

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
        return (
          supervisor?.getState() ?? {
            baseUrl: currentHubBaseUrl,
            restartCount: 0,
            status: 'starting',
          }
        );
      });

      let resolveInitialHubReady: (() => void) | null = null;
      const initialHubReadyPromise = new Promise<void>((resolve) => {
        resolveInitialHubReady = resolve;
      });

      supervisor = new HubSupervisor({
        dbPath: layoutPaths.dbPath,
        logDir: layoutPaths.logDir,
        allowedOrigins: ['app://mezon'],
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
