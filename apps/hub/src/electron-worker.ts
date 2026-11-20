import fs from 'node:fs';
import path from 'node:path';
import { createRotatingHubLogStream } from './logger.js';
import { createHubServer, type CreateHubServerOptions, type HubServer } from './server.js';
import { readUpdateReadiness, type UpdateReadiness } from './update-readiness.js';

export interface HubWorkerStartMessage {
  readonly type: 'start';
  readonly dbPath: string;
  readonly logDir: string;
  readonly preferredPort?: number;
  readonly allowedOrigins: readonly string[];
  readonly maxLogBytes?: number;
  readonly maxLogFiles?: number;
}

export interface HubWorkerShutdownMessage {
  readonly type: 'shutdown';
}

/**
 * T4.8: the desktop shell asks what an update would interrupt. With `backupIfReady`, a database
 * backup is taken when nothing blocks the update (no open receipt), right before installing.
 */
export interface HubWorkerUpdatePrepareMessage {
  readonly type: 'update-prepare';
  readonly requestId: string;
  readonly backupIfReady: boolean;
  readonly targetVersion: string;
}

/** T4.8: the prepared update is not going to start (re-opens the update gate). */
export interface HubWorkerUpdateCancelMessage {
  readonly type: 'update-cancel';
}

export type HubWorkerIncomingMessage =
  | HubWorkerStartMessage
  | HubWorkerShutdownMessage
  | HubWorkerUpdatePrepareMessage
  | HubWorkerUpdateCancelMessage;

export type HubWorkerOutgoingMessage =
  | {
      readonly type: 'ready';
      readonly baseUrl: string;
      readonly port: number;
      readonly reusedPreferredPort: boolean;
    }
  | {
      readonly type: 'stopped';
    }
  | {
      readonly type: 'error';
      readonly message: string;
    }
  | {
      readonly type: 'update-readiness';
      readonly requestId: string;
      /** `null` when the hub is not running (the update must wait). */
      readonly readiness: UpdateReadiness | null;
      readonly backupId: string | null;
      readonly error?: string;
    };

export interface HubWorkerPortLike {
  on(event: 'message', listener: (event: { readonly data: unknown }) => void): void;
  postMessage(message: HubWorkerOutgoingMessage): void;
  start?: () => void;
}

export interface HubWorkerControllerDeps {
  readonly port: HubWorkerPortLike;
  readonly createServer?: (options: CreateHubServerOptions) => Promise<HubServer>;
  readonly exitProcess?: (code: number) => void;
}

function isErrnoWithCode(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { readonly code?: unknown }).code === code
  );
}

function parseStartMessage(raw: unknown): HubWorkerStartMessage | null {
  if (typeof raw !== 'object' || raw === null) {
    return null;
  }
  const record = raw as Record<string, unknown>;
  if (record['type'] !== 'start') {
    return null;
  }
  if (typeof record['dbPath'] !== 'string' || typeof record['logDir'] !== 'string') {
    throw new Error('Hub worker start message must include dbPath and logDir strings');
  }
  if (!Array.isArray(record['allowedOrigins'])) {
    throw new Error('Hub worker start message must include allowedOrigins array');
  }
  const allowedOrigins = record['allowedOrigins'].filter(
    (item): item is string => typeof item === 'string',
  );
  const preferredPort =
    typeof record['preferredPort'] === 'number' && Number.isInteger(record['preferredPort'])
      ? record['preferredPort']
      : undefined;
  const maxLogBytes = typeof record['maxLogBytes'] === 'number' ? record['maxLogBytes'] : undefined;
  const maxLogFiles = typeof record['maxLogFiles'] === 'number' ? record['maxLogFiles'] : undefined;

  return {
    type: 'start',
    dbPath: record['dbPath'],
    logDir: record['logDir'],
    preferredPort,
    allowedOrigins,
    maxLogBytes,
    maxLogFiles,
  };
}

function parseUpdatePrepareMessage(raw: unknown): HubWorkerUpdatePrepareMessage | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (r['type'] !== 'update-prepare' || typeof r['requestId'] !== 'string') return null;
  return {
    type: 'update-prepare',
    requestId: r['requestId'],
    backupIfReady: r['backupIfReady'] === true,
    targetVersion: typeof r['targetVersion'] === 'string' ? r['targetVersion'].slice(0, 32) : '',
  };
}

function isUpdateCancelMessage(raw: unknown): boolean {
  return (
    typeof raw === 'object' &&
    raw !== null &&
    (raw as { readonly type?: unknown }).type === 'update-cancel'
  );
}

function isShutdownMessage(raw: unknown): boolean {
  return (
    typeof raw === 'object' &&
    raw !== null &&
    (raw as { readonly type?: unknown }).type === 'shutdown'
  );
}

export function attachHubWorkerController(deps: HubWorkerControllerDeps) {
  const createServerFn = deps.createServer ?? createHubServer;
  const exitProcess = deps.exitProcess ?? ((code: number) => process.exit(code));
  let activeHub: HubServer | null = null;
  let activeLogStream: { close(): void } | null = null;
  let starting = false;
  let shuttingDown = false;
  let shutdownPromise: Promise<void> | null = null;

  async function tryListen(
    start: HubWorkerStartMessage,
    portToTry: number,
    logStream: ReturnType<typeof createRotatingHubLogStream>,
  ): Promise<{ readonly hub: HubServer; readonly port: number }> {
    const hub = await createServerFn({
      dbPath: start.dbPath,
      host: '127.0.0.1',
      port: portToTry,
      allowedOrigins: start.allowedOrigins,
      logStream,
    });
    try {
      const bound = await hub.listen();
      return { hub, port: bound.port };
    } catch (error) {
      await hub.close().catch(() => undefined);
      throw error;
    }
  }

  async function handleStart(start: HubWorkerStartMessage): Promise<void> {
    if (starting || activeHub !== null || shuttingDown) {
      return;
    }
    starting = true;
    if (start.dbPath !== ':memory:') {
      fs.mkdirSync(path.dirname(start.dbPath), { recursive: true });
    }
    const logStream = createRotatingHubLogStream({
      logDir: start.logDir,
      maxBytes: start.maxLogBytes,
      maxFiles: start.maxLogFiles,
    });
    activeLogStream = logStream;

    try {
      const preferredPort =
        start.preferredPort !== undefined && start.preferredPort > 0 ? start.preferredPort : 0;

      let result: { readonly hub: HubServer; readonly port: number };
      if (preferredPort > 0) {
        try {
          result = await tryListen(start, preferredPort, logStream);
        } catch (error) {
          if (!isErrnoWithCode(error, 'EADDRINUSE')) {
            throw error;
          }
          result = await tryListen(start, 0, logStream);
        }
      } else {
        result = await tryListen(start, 0, logStream);
      }

      if (shuttingDown) {
        await result.hub.close().catch(() => undefined);
        logStream.close();
        activeLogStream = null;
        return;
      }

      activeHub = result.hub;
      deps.port.postMessage({
        type: 'ready',
        baseUrl: `http://127.0.0.1:${String(result.port)}`,
        port: result.port,
        reusedPreferredPort: preferredPort > 0 && result.port === preferredPort,
      });
    } catch (error) {
      logStream.close();
      activeLogStream = null;
      deps.port.postMessage({
        type: 'error',
        message: error instanceof Error ? error.message : String(error),
      });
      exitProcess(1);
    } finally {
      starting = false;
    }
  }

  async function shutdown(): Promise<void> {
    if (shutdownPromise !== null) {
      return shutdownPromise;
    }
    shuttingDown = true;
    shutdownPromise = (async () => {
      if (activeHub !== null) {
        await activeHub.close().catch(() => undefined);
        activeHub = null;
      }
      if (activeLogStream !== null) {
        activeLogStream.close();
        activeLogStream = null;
      }
      deps.port.postMessage({ type: 'stopped' });
      exitProcess(0);
    })();
    return shutdownPromise;
  }

  async function handleUpdatePrepare(msg: HubWorkerUpdatePrepareMessage): Promise<void> {
    const hub = activeHub;
    if (hub === null || shuttingDown) {
      deps.port.postMessage({
        type: 'update-readiness',
        requestId: msg.requestId,
        readiness: null,
        backupId: null,
      });
      return;
    }
    try {
      if (!msg.backupIfReady) {
        deps.port.postMessage({
          type: 'update-readiness',
          requestId: msg.requestId,
          readiness: readUpdateReadiness(hub.connection),
          backupId: null,
        });
        return;
      }
      // B1: close the gate FIRST, then look. From here no new receipt can start (POS or LAN), so
      // what we read stays true until the installer stops the hub — or until the gate re-opens.
      hub.updateGate.close();
      let readiness = readUpdateReadiness(hub.connection);
      let backupId: string | null = null;
      if (readiness.openReceipts > 0) {
        hub.updateGate.open();
      } else {
        try {
          const meta = await hub.backupService.createBackup({
            reason: `Yangilanishdan oldin (${msg.targetVersion || '?'})`,
            actorUserId: null,
          });
          backupId = meta.id;
        } catch (error) {
          hub.updateGate.open();
          throw error;
        }
        // The answer is the state AFTER the backup (the gate kept it from changing).
        readiness = readUpdateReadiness(hub.connection);
        if (readiness.openReceipts > 0) {
          hub.updateGate.open();
          backupId = null;
        }
      }
      deps.port.postMessage({
        type: 'update-readiness',
        requestId: msg.requestId,
        readiness,
        backupId,
      });
    } catch (error) {
      deps.port.postMessage({
        type: 'update-readiness',
        requestId: msg.requestId,
        readiness: null,
        backupId: null,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  let operationQueue: Promise<void> = Promise.resolve();

  const enqueue = (task: () => Promise<void>) => {
    operationQueue = operationQueue.then(task, task);
    return operationQueue;
  };

  deps.port.on('message', (event) => {
    try {
      const start = parseStartMessage(event.data);
      if (start !== null) {
        void enqueue(() => handleStart(start));
        return;
      }
      if (isUpdateCancelMessage(event.data)) {
        // The update was not started after all: selling goes on.
        activeHub?.updateGate.open();
        return;
      }
      const prepare = parseUpdatePrepareMessage(event.data);
      if (prepare !== null) {
        void enqueue(() => handleUpdatePrepare(prepare));
        return;
      }
      if (isShutdownMessage(event.data)) {
        void enqueue(() => shutdown());
      }
    } catch (error) {
      deps.port.postMessage({
        type: 'error',
        message: error instanceof Error ? error.message : String(error),
      });
      exitProcess(1);
    }
  });

  deps.port.start?.();

  return {
    shutdown,
  };
}

interface ProcessWithParentPort {
  readonly parentPort?: HubWorkerPortLike;
}

export function startElectronHubWorkerProcess(): void {
  const parentPort = (process as unknown as ProcessWithParentPort).parentPort;
  if (parentPort === undefined) {
    throw new Error('process.parentPort is unavailable outside Electron utilityProcess');
  }
  const controller = attachHubWorkerController({ port: parentPort });
  process.on('SIGTERM', () => {
    void controller.shutdown();
  });
  process.on('SIGINT', () => {
    void controller.shutdown();
  });
}
