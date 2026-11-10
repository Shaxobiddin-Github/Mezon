import type { Logger } from 'pino';

export interface HubBridgeState {
  readonly baseUrl: string | null;
  readonly restartCount: number;
  readonly status: 'starting' | 'ready' | 'restarting' | 'error';
  readonly lastError?: string;
}

export type HubWorkerIncoming =
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
    };

export interface HubChildProcessLike {
  readonly pid: number | undefined;
  onMessage(listener: (data: unknown) => void): void;
  onExit(listener: (code: number) => void): void;
  postMessage(message: unknown): void;
  kill(): boolean;
}

export interface HubSupervisorDeps {
  readonly dbPath: string;
  readonly logDir: string;
  readonly allowedOrigins: readonly string[];
  readonly workerPath: string;
  readonly forkWorker: (workerPath: string, args: readonly string[]) => HubChildProcessLike;
  readonly onStateChange: (
    state: HubBridgeState,
    details: { readonly portChanged: boolean },
  ) => void;
  readonly logger?: Logger;
  readonly shutdownTimeoutMs?: number;
  readonly backoffScheduleMs?: readonly number[];
  readonly maxLogBytes?: number;
  readonly maxLogFiles?: number;
}

const DEFAULT_BACKOFF_SCHEDULE_MS = [500, 1000, 2000, 5000] as const;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 3500;

export function selectRestartBackoffMs(
  restartAttempt: number,
  schedule: readonly number[] = DEFAULT_BACKOFF_SCHEDULE_MS,
): number {
  const index = Math.min(Math.max(restartAttempt, 0), schedule.length - 1);
  return schedule[index] ?? 500;
}

function parseWorkerMessage(raw: unknown): HubWorkerIncoming | null {
  if (typeof raw !== 'object' || raw === null) {
    return null;
  }
  const record = raw as Record<string, unknown>;
  if (
    record['type'] === 'ready' &&
    typeof record['baseUrl'] === 'string' &&
    typeof record['port'] === 'number' &&
    typeof record['reusedPreferredPort'] === 'boolean'
  ) {
    return {
      type: 'ready',
      baseUrl: record['baseUrl'],
      port: record['port'],
      reusedPreferredPort: record['reusedPreferredPort'],
    };
  }
  if (record['type'] === 'stopped') {
    return { type: 'stopped' };
  }
  if (record['type'] === 'error' && typeof record['message'] === 'string') {
    return { type: 'error', message: record['message'] };
  }
  return null;
}

export class HubSupervisor {
  private currentWorker: HubChildProcessLike | null = null;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private shuttingDown = false;
  private shutdownPromise: Promise<void> | null = null;
  private lastKnownPort: number | undefined;
  private consecutiveRestarts = 0;
  private state: HubBridgeState = {
    baseUrl: null,
    restartCount: 0,
    status: 'starting',
  };

  constructor(private readonly deps: HubSupervisorDeps) {}

  getState(): HubBridgeState {
    return this.state;
  }

  start(): void {
    if (this.shuttingDown || this.currentWorker !== null) {
      return;
    }
    this.spawnWorker(this.state.restartCount > 0 ? 'restarting' : 'starting');
  }

  async shutdown(): Promise<void> {
    if (this.shutdownPromise !== null) {
      return this.shutdownPromise;
    }

    this.shuttingDown = true;
    if (this.restartTimer !== null) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }

    const worker = this.currentWorker;
    if (worker === null) {
      return;
    }

    const timeoutMs = this.deps.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS;
    this.deps.logger?.info({ hubPid: worker.pid }, 'desktop_hub_shutdown_requested');

    this.shutdownPromise = new Promise<void>((resolve) => {
      let settled = false;
      const finish = (forced: boolean) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(killTimer);
        this.currentWorker = null;
        this.deps.logger?.info({ forced }, 'desktop_hub_shutdown_complete');
        resolve();
      };

      const killTimer = setTimeout(() => {
        try {
          worker.kill();
        } catch {
          // Process already exited.
        }
        finish(true);
      }, timeoutMs);

      worker.onExit(() => {
        finish(false);
      });

      try {
        worker.postMessage({ type: 'shutdown' });
      } catch {
        worker.kill();
        finish(true);
      }
    });

    return this.shutdownPromise;
  }

  private spawnWorker(phase: 'starting' | 'restarting'): void {
    const previousPort = this.lastKnownPort;
    const worker = this.deps.forkWorker(this.deps.workerPath, ['--electron-worker']);
    this.currentWorker = worker;

    this.state = {
      ...this.state,
      status: phase,
      lastError: undefined,
    };
    this.deps.onStateChange(this.state, { portChanged: false });
    this.deps.logger?.info(
      {
        hubPid: worker.pid ?? null,
        preferredPort: previousPort ?? null,
        phase,
      },
      'desktop_hub_worker_spawned',
    );

    worker.onMessage((raw) => {
      if (this.currentWorker !== worker) {
        return;
      }
      const message = parseWorkerMessage(raw);
      if (message === null) {
        return;
      }

      if (message.type === 'ready') {
        const portChanged = previousPort !== undefined && message.port !== previousPort;
        const wasRestart = this.state.baseUrl !== null;
        const nextRestartCount = wasRestart ? this.state.restartCount + 1 : this.state.restartCount;
        this.lastKnownPort = message.port;
        this.consecutiveRestarts = 0;

        this.state = {
          baseUrl: message.baseUrl,
          restartCount: nextRestartCount,
          status: 'ready',
        };

        this.deps.logger?.info(
          {
            hubPid: worker.pid ?? null,
            port: message.port,
            baseUrl: message.baseUrl,
            reusedPreferredPort: message.reusedPreferredPort,
            portChanged,
            restartCount: nextRestartCount,
          },
          'desktop_hub_ready',
        );
        this.deps.onStateChange(this.state, { portChanged });
        return;
      }

      if (message.type === 'error') {
        this.deps.logger?.error(
          {
            hubPid: worker.pid ?? null,
            errorMessage: message.message,
          },
          'desktop_hub_worker_error',
        );
        this.state = {
          ...this.state,
          status: 'error',
          lastError: message.message,
        };
        this.deps.onStateChange(this.state, { portChanged: false });
      }
    });

    worker.onExit((code) => {
      if (this.currentWorker !== worker) {
        return;
      }
      this.currentWorker = null;

      if (this.shuttingDown) {
        return;
      }

      const backoffMs = selectRestartBackoffMs(
        this.consecutiveRestarts,
        this.deps.backoffScheduleMs,
      );
      this.consecutiveRestarts += 1;

      this.deps.logger?.warn(
        {
          hubPid: worker.pid ?? null,
          exitCode: code,
          backoffMs,
          preferredPort: this.lastKnownPort ?? null,
        },
        'desktop_hub_worker_exited_restarting',
      );

      this.state = {
        ...this.state,
        status: 'restarting',
      };
      this.deps.onStateChange(this.state, { portChanged: false });

      this.restartTimer = setTimeout(() => {
        this.restartTimer = null;
        if (!this.shuttingDown) {
          this.spawnWorker('restarting');
        }
      }, backoffMs);
    });

    worker.postMessage({
      type: 'start',
      dbPath: this.deps.dbPath,
      logDir: this.deps.logDir,
      preferredPort: previousPort,
      allowedOrigins: this.deps.allowedOrigins,
      maxLogBytes: this.deps.maxLogBytes,
      maxLogFiles: this.deps.maxLogFiles,
    });
  }
}
