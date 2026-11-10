import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  attachHubWorkerController,
  type HubWorkerOutgoingMessage,
  type HubWorkerPortLike,
} from './electron-worker.js';

const tempDirs: string[] = [];

function createTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mezon-hub-worker-'));
  tempDirs.push(dir);
  return dir;
}

class FakeWorkerPort implements HubWorkerPortLike {
  readonly sent: HubWorkerOutgoingMessage[] = [];
  private listener: ((event: { readonly data: unknown }) => void) | null = null;
  started = false;

  on(_event: 'message', listener: (event: { readonly data: unknown }) => void): void {
    this.listener = listener;
  }

  postMessage(message: HubWorkerOutgoingMessage): void {
    this.sent.push(message);
  }

  start(): void {
    this.started = true;
  }

  deliver(data: unknown): void {
    this.listener?.({ data });
  }
}

async function occupyLoopbackPort(): Promise<{
  readonly server: net.Server;
  readonly port: number;
}> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    server.close();
    throw new Error('Failed to resolve occupied port');
  }
  return { server, port: address.port };
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  }
});

describe('attachHubWorkerController', () => {
  it('reuses preferredPort when free and writes redacted rotating logs (T1 + T4)', async () => {
    const dir = createTempDir();
    const dbPath = path.join(dir, 'data', 'mezon.db');
    const logDir = path.join(dir, 'logs');

    const probe = await occupyLoopbackPort();
    const preferredPort = probe.port;
    await new Promise<void>((resolve) => probe.server.close(() => resolve()));

    const port = new FakeWorkerPort();
    let exitCode: number | null = null;
    const controller = attachHubWorkerController({
      port,
      exitProcess: (code) => {
        exitCode = code;
      },
    });

    try {
      expect(port.started).toBe(true);
      port.deliver({
        type: 'start',
        dbPath,
        logDir,
        preferredPort,
        allowedOrigins: ['app://mezon'],
        maxLogBytes: 1024,
        maxLogFiles: 2,
      });

      await expect.poll(() => port.sent.length, { timeout: 5000 }).toBeGreaterThanOrEqual(1);
      const ready = port.sent[0];
      expect(ready).toEqual({
        type: 'ready',
        baseUrl: `http://127.0.0.1:${String(preferredPort)}`,
        port: preferredPort,
        reusedPreferredPort: true,
      });

      const healthResponse = await fetch(`http://127.0.0.1:${String(preferredPort)}/health`, {
        headers: {
          Origin: 'app://mezon',
          'x-pin': '1234',
          Authorization: 'Bearer secret-token-value',
        },
      });
      expect(healthResponse.status).toBe(200);
      expect(await healthResponse.json()).toEqual({
        status: 'ok',
        service: '@mezon/hub',
        needsSetup: true,
      });

      port.deliver({ type: 'shutdown' });
      await expect.poll(() => exitCode, { timeout: 5000 }).toBe(0);
      expect(port.sent.at(-1)).toEqual({ type: 'stopped' });

      const logFiles = fs.readdirSync(logDir).filter((name) => name.startsWith('mezon-hub.log'));
      expect(logFiles.length).toBeGreaterThanOrEqual(1);
      expect(logFiles.length).toBeLessThanOrEqual(2);
      const combinedLogs = logFiles
        .map((f) => fs.readFileSync(path.join(logDir, f), 'utf8'))
        .join('\n');
      expect(combinedLogs).not.toContain('secret-token-value');
      expect(combinedLogs).not.toContain('"1234"');
    } finally {
      await controller.shutdown();
    }
  });

  it('falls back to ephemeral port 0 when preferredPort is EADDRINUSE without leaking DB (T1)', async () => {
    const dir = createTempDir();
    const dbPath = path.join(dir, 'data', 'mezon.db');
    const logDir = path.join(dir, 'logs');
    const occupied = await occupyLoopbackPort();

    try {
      const port = new FakeWorkerPort();
      let exitCode: number | null = null;
      attachHubWorkerController({
        port,
        exitProcess: (code) => {
          exitCode = code;
        },
      });

      port.deliver({
        type: 'start',
        dbPath,
        logDir,
        preferredPort: occupied.port,
        allowedOrigins: ['app://mezon'],
      });

      await expect.poll(() => port.sent.length, { timeout: 5000 }).toBeGreaterThanOrEqual(1);
      const ready = port.sent[0];
      expect(ready?.type).toBe('ready');
      if (ready?.type === 'ready') {
        expect(ready.reusedPreferredPort).toBe(false);
        expect(ready.port).not.toBe(occupied.port);
        expect(ready.port).toBeGreaterThan(0);

        const healthResponse = await fetch(`${ready.baseUrl}/health`, {
          headers: { Origin: 'app://mezon' },
        });
        expect(healthResponse.status).toBe(200);
      }

      port.deliver({ type: 'shutdown' });
      await expect.poll(() => exitCode, { timeout: 5000 }).toBe(0);
    } finally {
      await new Promise<void>((resolve) => occupied.server.close(() => resolve()));
    }
  });
});
