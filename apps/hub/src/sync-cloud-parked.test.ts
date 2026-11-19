import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { CloudParkedEventDto } from '@mezon/contracts';
import type { SqliteCloudStore } from '@mezon/db-local';
import { type PinHasher, parseUuidV7 } from '@mezon/domain';
import { FixedClock, SeededRandomSource } from '@mezon/test-utils';
import { afterEach, describe, expect, it } from 'vitest';
import { createHubServer } from './index.js';
import type { SafeStoragePort } from './safe-storage-port.js';
import { HubCloudParkedService } from './sync-cloud-parked.js';

const tempDirs: string[] = [];
afterEach(() => {
  for (const d of tempDirs.splice(0)) {
    fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});
const fastHasher: PinHasher = {
  hash: (pin) => Promise.resolve(`fast-stub-hash:${pin}`),
  verify: (stored, pin) => Promise.resolve(stored === `fast-stub-hash:${pin}`),
};
const safeStorage: SafeStoragePort = {
  isAvailable: () => true,
  encryptString: (s) => Promise.resolve(Buffer.from(`enc:${s}`)),
  decryptString: (b) => Promise.resolve(b.toString('utf8').replace(/^enc:/, '')),
};

describe('T2.6 hub proxy for the cloud side of parked pushes', () => {
  it('lists/resolves with the hub device token; retry re-queues the rejected outbox event; errors map', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mezon-cloud-parked-'));
    tempDirs.push(dir);
    const clock = new FixedClock(1_767_500_000_000n);
    const hub = await createHubServer({
      dbPath: path.join(dir, 'hub.db'),
      port: 47874,
      logLevel: 'silent',
      clock,
      random: new SeededRandomSource(5),
      pinHasher: fastHasher,
    });
    try {
      await hub.app.inject({
        method: 'POST',
        url: '/setup',
        headers: { host: '127.0.0.1:47874' },
        payload: { owner: { fullName: 'Egasi', username: 'owner', pin: '849201' } },
      });
      const out = hub.connection.sqlite
        .prepare('SELECT id FROM local_outbox ORDER BY device_seq LIMIT 1')
        .get() as { id: string };
      hub.connection.sqlite
        .prepare("UPDATE local_outbox SET status = 'rejected', last_error = 'gave up' WHERE id = ?")
        .run(out.id);

      const parkedRow: CloudParkedEventDto = {
        id: parseUuidV7('01995000-0000-7000-8000-000000000001'),
        eventId: parseUuidV7(out.id),
        entity: 'products',
        entityId: parseUuidV7('01995000-0000-7000-8000-000000000002'),
        missingRefEntity: 'categories',
        missingRefId: '01995000-0000-7000-8000-000000000003',
        attempts: 0,
        status: 'parked',
        resolution: 'retried',
        resolvedByUserId: parseUuidV7('01995000-0000-7000-8000-000000000004'),
        resolvedAtMs: '1',
        resolutionNote: null,
        createdAtMs: '1',
      };
      const calls: { url: string; init: RequestInit }[] = [];
      let nextStatus = 200;
      const fetchFn: typeof fetch = (url, init) => {
        calls.push({ url: url as string, init: init ?? {} });
        const body = init?.method === 'POST' ? { parked: parkedRow } : { parked: [parkedRow] };
        return Promise.resolve(new Response(JSON.stringify(body), { status: nextStatus }));
      };
      let paired = true;
      const cloudStore = {
        getCloudState: () =>
          Promise.resolve(
            paired
              ? {
                  status: 'paired',
                  cloudUrl: 'https://cloud.test',
                  encryptedDeviceToken: Buffer.from('enc:dev-token-1').toString('base64'),
                }
              : null,
          ),
      } as unknown as SqliteCloudStore;
      const svc = new HubCloudParkedService({
        connection: hub.connection,
        cloudStore,
        safeStorage,
        nowMs: () => clock.now(),
        fetchFn,
      });

      expect((await svc.list()).map((p) => p.id)).toEqual([parkedRow.id]);
      expect(calls[0].url).toBe('https://cloud.test/api/v1/sync/parked');
      expect((calls[0].init.headers as Record<string, string>).Authorization).toBe(
        'Bearer dev-token-1',
      );

      const userId = parseUuidV7('01995000-0000-7000-8000-000000000004');
      await svc.resolve({ id: parkedRow.id, action: 'retry', note: 'qayta', userId });
      expect(calls[1].url).toBe(`https://cloud.test/api/v1/sync/parked/${parkedRow.id}/resolve`);
      expect(JSON.parse(calls[1].init.body as string)).toEqual({
        action: 'retry',
        userId,
        note: 'qayta',
      });
      expect(
        (
          hub.connection.sqlite
            .prepare('SELECT status FROM local_outbox WHERE id = ?')
            .get(out.id) as {
            status: string;
          }
        ).status,
      ).toBe('pending');

      nextStatus = 404;
      await expect(
        svc.resolve({ id: parkedRow.id, action: 'acknowledge', note: null, userId }),
      ).rejects.toMatchObject({ code: 'SYNC_CONFLICT_NOT_FOUND' });
      nextStatus = 409;
      await expect(
        svc.resolve({ id: parkedRow.id, action: 'acknowledge', note: null, userId }),
      ).rejects.toMatchObject({ code: 'SYNC_CONFLICT_ALREADY_RESOLVED' });
      paired = false;
      await expect(svc.list()).rejects.toMatchObject({ code: 'CLOUD_NOT_PAIRED' });
    } finally {
      await hub.close();
    }
  });
});
