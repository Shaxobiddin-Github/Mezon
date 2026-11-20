import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HubSupervisor, type HubBridgeState, type HubChildProcessLike } from './hub-supervisor.js';

class FakeHubChild implements HubChildProcessLike {
  readonly emitter = new EventEmitter();
  readonly messagesToWorker: unknown[] = [];
  killed = false;

  constructor(readonly pid: number) {}

  onMessage(listener: (data: unknown) => void): void {
    this.emitter.on('message', listener);
  }

  onExit(listener: (code: number) => void): void {
    this.emitter.on('exit', listener);
  }

  postMessage(message: unknown): void {
    this.messagesToWorker.push(message);
  }

  kill(): boolean {
    this.killed = true;
    return true;
  }

  emitMessage(msg: unknown): void {
    this.emitter.emit('message', msg);
  }

  emitExit(code: number): void {
    this.emitter.emit('exit', code);
  }
}

afterEach(() => {
  vi.useRealTimers();
});

describe('HubSupervisor', () => {
  it('restarts crashed worker with preferredPort, tracks port changes, and forces kill on shutdown timeout', async () => {
    vi.useFakeTimers();
    const workers: FakeHubChild[] = [];
    const stateEvents: Array<{ readonly state: HubBridgeState; readonly portChanged: boolean }> =
      [];

    const supervisor = new HubSupervisor({
      dbPath: 'data/mezon.db',
      logDir: 'logs',
      allowedOrigins: ['app://mezon'],
      workerPath: 'worker.js',
      backoffScheduleMs: [100, 200],
      shutdownTimeoutMs: 500,
      forkWorker: () => {
        const child = new FakeHubChild(1000 + workers.length);
        workers.push(child);
        return child;
      },
      onStateChange: (state, details) => {
        stateEvents.push({ state, portChanged: details.portChanged });
      },
    });

    supervisor.start();
    expect(workers).toHaveLength(1);
    const firstWorker = workers[0];
    if (firstWorker === undefined) {
      throw new Error('Expected first worker');
    }
    expect(firstWorker.messagesToWorker[0]).toMatchObject({
      type: 'start',
      preferredPort: undefined,
    });

    firstWorker.emitMessage({
      type: 'ready',
      baseUrl: 'http://127.0.0.1:41001',
      port: 41001,
      reusedPreferredPort: false,
    });
    expect(stateEvents.at(-1)).toEqual({
      state: { baseUrl: 'http://127.0.0.1:41001', restartCount: 0, status: 'ready' },
      portChanged: false,
    });

    // Crash worker 1; supervisor must schedule restart requesting preferredPort 41001.
    firstWorker.emitExit(1);
    expect(supervisor.getState().status).toBe('restarting');

    await vi.advanceTimersByTimeAsync(100);
    expect(workers).toHaveLength(2);
    const secondWorker = workers[1];
    if (secondWorker === undefined) {
      throw new Error('Expected second worker');
    }
    expect(secondWorker.messagesToWorker[0]).toMatchObject({
      type: 'start',
      preferredPort: 41001,
    });

    // Suppose port 41001 was occupied and fallback chose 41002; portChanged must be true.
    secondWorker.emitMessage({
      type: 'ready',
      baseUrl: 'http://127.0.0.1:41002',
      port: 41002,
      reusedPreferredPort: false,
    });
    expect(stateEvents.at(-1)).toEqual({
      state: { baseUrl: 'http://127.0.0.1:41002', restartCount: 1, status: 'ready' },
      portChanged: true,
    });

    // Shutdown sends 'shutdown' and kills if worker hangs past timeout.
    const shutdownPromise = supervisor.shutdown();
    expect(secondWorker.messagesToWorker.at(-1)).toEqual({ type: 'shutdown' });
    expect(secondWorker.killed).toBe(false);

    await vi.advanceTimersByTimeAsync(500);
    await shutdownPromise;
    expect(secondWorker.killed).toBe(true);
  });

  it('T4.8 prepareUpdate: asks the worker; no ready worker or no answer means "wait" (readiness null)', async () => {
    vi.useFakeTimers();
    const workers: FakeHubChild[] = [];
    const supervisor = new HubSupervisor({
      dbPath: 'data/mezon.db',
      logDir: 'logs',
      allowedOrigins: [],
      workerPath: 'worker.js',
      forkWorker: () => {
        const child = new FakeHubChild(2000 + workers.length);
        workers.push(child);
        return child;
      },
      onStateChange: () => undefined,
    });
    expect(await supervisor.prepareUpdate('1.3.0', true)).toEqual({
      readiness: null,
      backupId: null,
    });
    supervisor.start();
    // Spawned but not ready yet: still no.
    expect(await supervisor.prepareUpdate('1.3.0', true)).toEqual({
      readiness: null,
      backupId: null,
    });
    workers[0].emitMessage({
      type: 'ready',
      baseUrl: 'http://127.0.0.1:1',
      port: 1,
      reusedPreferredPort: false,
    });

    const asked = supervisor.prepareUpdate('1.3.0', true);
    const sent = workers[0].messagesToWorker.at(-1) as {
      type: string;
      requestId: string;
      backupIfReady: boolean;
    };
    expect(sent).toMatchObject({
      type: 'update-prepare',
      backupIfReady: true,
      targetVersion: '1.3.0',
    });
    // An answer to another request id is ignored.
    workers[0].emitMessage({
      type: 'update-readiness',
      requestId: 'other',
      readiness: { openReceipts: 9, openShifts: 0, pendingFiscalDocs: 0 },
      backupId: 'x',
    });
    workers[0].emitMessage({
      type: 'update-readiness',
      requestId: sent.requestId,
      readiness: { openReceipts: 0, openShifts: 1, pendingFiscalDocs: 2 },
      backupId: 'backup-9',
    });
    expect(await asked).toEqual({
      readiness: { openReceipts: 0, openShifts: 1, pendingFiscalDocs: 2 },
      backupId: 'backup-9',
    });

    // A malformed readiness is treated as no answer.
    const bad = supervisor.prepareUpdate('1.3.0', false);
    const sent2 = workers[0].messagesToWorker.at(-1) as { requestId: string };
    workers[0].emitMessage({
      type: 'update-readiness',
      requestId: sent2.requestId,
      readiness: { openReceipts: -1 },
      backupId: null,
    });
    expect((await bad).readiness).toBeNull();

    // No answer in time: wait.
    const silent = supervisor.prepareUpdate('1.3.0', true, 1000);
    await vi.advanceTimersByTimeAsync(1001);
    expect(await silent).toEqual({ readiness: null, backupId: null });
  });
});
