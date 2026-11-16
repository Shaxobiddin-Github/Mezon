import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  type LocalSqliteConnection,
  SqliteCloudStore,
  SqliteOutboxSyncStore,
  appendOutboxEventSync,
  ensureDeviceStateRowSync,
  localOutbox,
  migrateLocalDatabase,
  openLocalSqliteDatabase,
} from '@mezon/db-local';
import {
  type Clock,
  type IdGenerator,
  MonotonicUuidV7Generator,
  type UuidV7,
  parseUuidV7,
  unixMsFromBigInt,
} from '@mezon/domain';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SafeStoragePort } from './safe-storage-port.js';
import { createHubServer } from './server.js';
import { HubSyncPushWorker } from './sync-push-worker.js';

class MockSafeStorage implements SafeStoragePort {
  isAvailable(): boolean {
    return true;
  }
  encryptString(plainText: string): Promise<Buffer> {
    return Promise.resolve(Buffer.from(`enc_${plainText}`, 'utf8'));
  }
  decryptString(cipherText: Buffer): Promise<string> {
    const raw = cipherText.toString('utf8');
    if (!raw.startsWith('enc_')) {
      return Promise.reject(new Error('Invalid ciphertext'));
    }
    return Promise.resolve(raw.slice(4));
  }
}

describe('HubSyncPushWorker', () => {
  let tmpDir: string;
  let dbPath: string;
  let conn: LocalSqliteConnection;
  let outboxStore: SqliteOutboxSyncStore;
  let cloudStore: SqliteCloudStore;
  let safeStorage: MockSafeStorage;
  let idGen: IdGenerator;

  const currentNowMs = 1700000000000n;
  const clock: Clock = {
    now: () => unixMsFromBigInt(currentNowMs),
  };

  const orgId = parseUuidV7('01880000-0000-7000-8000-000000000001');
  const storeId = parseUuidV7('01880000-0000-7000-8000-000000000002');
  const deviceId = parseUuidV7('01880000-0000-7000-8000-000000000003');

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-sync-push-test-'));
    dbPath = path.join(tmpDir, 'hub.db');
    conn = openLocalSqliteDatabase(dbPath);
    migrateLocalDatabase(conn.db);

    idGen = new MonotonicUuidV7Generator({
      clock,
      random: { nextBytes: (n: number) => new Uint8Array(n).fill(1) },
    });

    ensureDeviceStateRowSync(conn.sqlite, conn.db, {
      rowId: idGen.nextId(),
      organizationId: orgId,
      deviceId,
      initialHlcStr: '000170000000000:00000:01880000-0000-7000-8000-000000000001',
      initialUuidMs: currentNowMs,
      nowMs: currentNowMs,
    });

    outboxStore = new SqliteOutboxSyncStore(conn);
    cloudStore = new SqliteCloudStore(conn);
    safeStorage = new MockSafeStorage();

    // Seed paired cloud state
    const encToken = (await safeStorage.encryptString('valid-secret-token')).toString('base64');
    await cloudStore.saveCloudState({
      status: 'paired',
      cloudUrl: 'https://cloud.mezon.uz',
      organizationId: orgId,
      organizationName: 'Guzar Test Org',
      storeId,
      storeName: 'Main Store',
      encryptedDeviceToken: encToken,
      pairedAtMs: unixMsFromBigInt(currentNowMs),
      nowMs: unixMsFromBigInt(currentNowMs),
      idGen,
    });
  });

  afterEach(() => {
    conn.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function appendTestEvent(entity: string, payload: Record<string, unknown>): UuidV7 {
    const eventId = idGen.nextId();
    conn.sqlite.transaction(() => {
      appendOutboxEventSync(conn.sqlite, conn.db, {
        eventId,
        organizationId: orgId,
        storeId,
        deviceId,
        hlc: '000170000000000:00000:01880000-0000-7000-8000-000000000001',
        uuidMs: unixMsFromBigInt(currentNowMs),
        nowMs: unixMsFromBigInt(currentNowMs),
        type: 'TEST_EVENT',
        entity,
        entityId: idGen.nextId(),
        entityClass: 'ATTR',
        schemaVersion: 1,
        payload,
      });
    })();
    return eventId;
  }

  it('pushes pending events and updates outbox to acked on accepted/duplicate', async () => {
    const ev1 = appendTestEvent('products', { name: 'P1' });
    const ev2 = appendTestEvent('products', { name: 'P2' });

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () =>
        Promise.resolve({
          results: [
            { eventId: ev1, status: 'accepted', position: '1' },
            { eventId: ev2, status: 'duplicate' },
          ],
        }),
    });

    const worker = new HubSyncPushWorker({
      outboxStore,
      cloudStore,
      safeStorage,
      getDeviceId: () => deviceId,
      clock,
      idGen,
      fetchFn: fetchMock,
    });

    const res = await worker.pushBatch();
    expect(res.pushed).toBe(2);
    expect(res.acked).toBe(2);
    expect(res.rejected).toBe(0);
    expect(res.status).toBe('ok');

    // Both events should now be acked
    const rows = conn.db.select().from(localOutbox).all();
    expect(rows.every((r) => r.status === 'acked')).toBe(true);
  });

  it('diverts rejected event to local_sync_conflicts and does NOT block the queue', async () => {
    const ev1 = appendTestEvent('products', { name: 'Good 1' });
    const evBad = appendTestEvent('users', { username: 'bad', pin_hash: 'evil' });
    const ev3 = appendTestEvent('products', { name: 'Good 2' });

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () =>
        Promise.resolve({
          results: [
            { eventId: ev1, status: 'accepted', position: '1' },
            {
              eventId: evBad,
              status: 'rejected',
              reason: 'VALIDATION_ERROR',
              error: 'Forbidden pin_hash',
            },
            { eventId: ev3, status: 'accepted', position: '2' },
          ],
        }),
    });

    const worker = new HubSyncPushWorker({
      outboxStore,
      cloudStore,
      safeStorage,
      getDeviceId: () => deviceId,
      clock,
      idGen,
      fetchFn: fetchMock,
    });

    const res = await worker.pushBatch();
    expect(res.pushed).toBe(3);
    expect(res.acked).toBe(2);
    expect(res.rejected).toBe(1);

    // Verify rejected event diverted to local_sync_conflicts
    const conflicts = outboxStore.listConflicts();
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].eventId).toBe(evBad);
    expect(conflicts[0].reason).toBe('VALIDATION_ERROR');

    // Outbox status for bad event is rejected, while others are acked
    const rows = conn.db.select().from(localOutbox).all();
    const badRow = rows.find((r) => r.id === evBad);
    expect(badRow?.status).toBe('rejected');
    expect(badRow?.lastError).toContain('VALIDATION_ERROR');

    // Subsequent pushes find 0 pending (queue is clean, not blocked!)
    const nextRes = await worker.pushBatch();
    expect(nextRes.pushed).toBe(0);
  });

  it('P5: handles 401 with DEVICE_REVOKED by setting cloud state revoked and stopping worker', async () => {
    appendTestEvent('products', { name: 'P1' });

    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      json: () =>
        Promise.resolve({
          error: 'Unauthorized',
          code: 'DEVICE_REVOKED',
          message: 'Device revoked by owner',
        }),
    });

    const worker = new HubSyncPushWorker({
      outboxStore,
      cloudStore,
      safeStorage,
      getDeviceId: () => deviceId,
      clock,
      idGen,
      fetchFn: fetchMock,
    });

    const res = await worker.pushBatch();
    expect(res.status).toBe('stopped');

    const state = await cloudStore.getCloudState();
    expect(state?.status).toBe('revoked');
    expect(worker.isRunning()).toBe(false);
  });

  it('R6: 403 without revoked code does NOT revoke device and applies backoff', async () => {
    appendTestEvent('products', { name: 'P1' });

    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 403,
      json: () =>
        Promise.resolve({
          error: 'Forbidden',
          message: 'Rate limit or WAF block',
        }),
    });

    const worker = new HubSyncPushWorker({
      outboxStore,
      cloudStore,
      safeStorage,
      getDeviceId: () => deviceId,
      clock,
      idGen,
      fetchFn: fetchMock,
    });

    const res = await worker.pushBatch();
    expect(res.status).toBe('backoff');

    const state = await cloudStore.getCloudState();
    expect(state?.status).toBe('paired'); // NOT revoked!
  });

  it('P5: handles 401 with TOKEN_EXPIRED by rotating token and resuming', async () => {
    appendTestEvent('products', { name: 'P1' });

    let callCount = 0;
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      callCount += 1;
      if (url.endsWith('/rotate-token')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({ deviceToken: 'new-rotated-secret' }),
        });
      }
      if (url.endsWith('/sync/push') && callCount === 1) {
        // First push attempt fails with TOKEN_EXPIRED
        return Promise.resolve({
          ok: false,
          status: 401,
          json: () => Promise.resolve({ code: 'TOKEN_EXPIRED', error: 'Token expired' }),
        });
      }
      // Second push attempt succeeds
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({
            results: [{ eventId: '01880000-0000-7000-8000-000000000001', status: 'accepted' }],
          }),
      });
    });

    const worker = new HubSyncPushWorker({
      outboxStore,
      cloudStore,
      safeStorage,
      getDeviceId: () => deviceId,
      clock,
      idGen,
      fetchFn: fetchMock,
    });

    const res = await worker.pushBatch();
    expect(res.status).toBe('ok');
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/rotate-token'),
      expect.anything(),
    );
  });

  it('P5: applies exponential backoff on network failure (1s -> 2s -> 4s)', async () => {
    appendTestEvent('products', { name: 'P1' });

    const fetchMock = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));

    const worker = new HubSyncPushWorker({
      outboxStore,
      cloudStore,
      safeStorage,
      getDeviceId: () => deviceId,
      clock,
      idGen,
      fetchFn: fetchMock,
      minBackoffMs: 1000,
      maxBackoffMs: 8000,
    });

    expect(worker.getCurrentBackoffMs()).toBe(0);

    // 1st failure -> 1000ms
    const r1 = await worker.pushBatch();
    expect(r1.status).toBe('backoff');
    expect(worker.getCurrentBackoffMs()).toBe(1000);

    // 2nd failure -> 2000ms
    const r2 = await worker.pushBatch();
    expect(r2.status).toBe('backoff');
    expect(worker.getCurrentBackoffMs()).toBe(2000);

    // 3rd failure -> 4000ms
    const r3 = await worker.pushBatch();
    expect(r3.status).toBe('backoff');
    expect(worker.getCurrentBackoffMs()).toBe(4000);
  });

  it('F2: server listen() starts push worker (isRunning === true) and close() stops it (isRunning === false)', async () => {
    const hub = await createHubServer({
      dbPath,
      port: 0,
      logLevel: 'silent',
    });

    expect(hub.pushWorker.isRunning()).toBe(false);

    await hub.listen();
    expect(hub.pushWorker.isRunning()).toBe(true);

    await hub.close();
    expect(hub.pushWorker.isRunning()).toBe(false);
  });
});
