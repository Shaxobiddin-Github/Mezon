import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  type SyncPushResponseDto,
  SyncPushRequestSchema,
  parseAndValidateSyncCursors,
} from '@mezon/contracts';
import {
  PG_APP_ROLE_NAME,
  CloudSyncPushStore,
  CloudSyncPullStore,
  ForeignStoreError,
  cloudOrganizations,
  cloudStores,
  cloudDevices,
  createCloudPgPool,
  migrateCloudDatabase,
  shouldRunPgTests,
} from '@mezon/db-cloud';
import {
  type LocalSqliteConnection,
  ensureDeviceStateRowSync,
  migrateLocalDatabase,
  openLocalSqliteDatabase,
  localOutbox,
} from '@mezon/db-local';
import {
  type Clock,
  type IdGenerator,
  MonotonicUuidV7Generator,
  parseUuidV7,
  unixMsFromBigInt,
} from '@mezon/domain';
import { type SyncedEventDto, CURRENT_SCHEMA_VERSION } from '@mezon/sync';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { provisionAppRole } from '../../../packages/db-cloud/ops/provision-app-role.mjs';
import { createHubServer, type HubServer } from './server.js';
import { HubSyncPullService } from './sync-pull-service.js';

const describePg = shouldRunPgTests() ? describe : describe.skip;

describe('Two Hubs Convergence Model Test (T2.4)', () => {
  let tmpDirA: string;
  let tmpDirB: string;
  let dbPathA: string;
  let dbPathB: string;
  let connA: LocalSqliteConnection;
  let connB: LocalSqliteConnection;
  let pullServiceA: HubSyncPullService;
  let pullServiceB: HubSyncPullService;
  let idGen: IdGenerator;

  const baseNowMs = 1700000000000n;
  let currentNowMs = baseNowMs;
  const clock: Clock = {
    now: () => unixMsFromBigInt(currentNowMs),
  };

  const orgId = parseUuidV7('01880000-0000-7000-8000-000000000001');
  const storeA = parseUuidV7('01880000-0000-7000-8000-000000000011');
  const storeB = parseUuidV7('01880000-0000-7000-8000-000000000022');
  const deviceA = parseUuidV7('01880000-0000-7000-8000-000000000111');
  const deviceB = parseUuidV7('01880000-0000-7000-8000-000000000222');
  const cashierA = parseUuidV7('01880000-0000-7000-8000-000000000333');

  beforeEach(() => {
    tmpDirA = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-convergence-a-'));
    tmpDirB = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-convergence-b-'));
    dbPathA = path.join(tmpDirA, 'hub-a.db');
    dbPathB = path.join(tmpDirB, 'hub-b.db');

    connA = openLocalSqliteDatabase(dbPathA);
    connB = openLocalSqliteDatabase(dbPathB);
    migrateLocalDatabase(connA.db);
    migrateLocalDatabase(connB.db);

    idGen = new MonotonicUuidV7Generator({
      clock,
      random: { nextBytes: (n: number) => new Uint8Array(n).fill(1) },
    });

    ensureDeviceStateRowSync(connA.sqlite, connA.db, {
      rowId: idGen.nextId(),
      organizationId: orgId,
      deviceId: deviceA,
      initialHlcStr: '000170000000000:00000:01880000-0000-7000-8000-000000000111',
      initialUuidMs: baseNowMs,
      nowMs: baseNowMs,
    });

    ensureDeviceStateRowSync(connB.sqlite, connB.db, {
      rowId: idGen.nextId(),
      organizationId: orgId,
      deviceId: deviceB,
      initialHlcStr: '000170000000000:00000:01880000-0000-7000-8000-000000000222',
      initialUuidMs: baseNowMs,
      nowMs: baseNowMs,
    });

    // Seed cashier on Hub A
    connA.sqlite
      .prepare(
        `
      INSERT INTO users (id, organization_id, device_id, hlc, username, full_name, role, is_active, created_at_ms, updated_at_ms)
      VALUES (?, ?, ?, '000170000000000:00000:01880000-0000-7000-8000-000000000111', 'cashier_a', 'Cashier A', 'cashier', 1, ?, ?)
    `,
      )
      .run(cashierA, orgId, deviceA, Number(baseNowMs), Number(baseNowMs));

    // Seed cashier on Hub B
    connB.sqlite
      .prepare(
        `
      INSERT INTO users (id, organization_id, device_id, hlc, username, full_name, role, is_active, created_at_ms, updated_at_ms)
      VALUES (?, ?, ?, '000170000000000:00000:01880000-0000-7000-8000-000000000222', 'cashier_a', 'Cashier A', 'cashier', 1, ?, ?)
    `,
      )
      .run(cashierA, orgId, deviceB, Number(baseNowMs), Number(baseNowMs));

    pullServiceA = new HubSyncPullService(connA);
    pullServiceB = new HubSyncPullService(connB);
  });

  afterEach(() => {
    try {
      connA.close();
      connB.close();
      fs.rmSync(tmpDirA, { recursive: true, force: true });
      fs.rmSync(tmpDirB, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it('Hub A and Hub B converge: shared categories, customer edits via LWW, and cross-store debts', () => {
    const sharedCatId = idGen.nextId();
    const sharedCustId = idGen.nextId();

    // 1. Hub A creates Category and Customer
    const hlcA1 = '000170000000000:00001:01880000-0000-7000-8000-000000000111';
    connA.sqlite
      .prepare(
        `
      INSERT INTO categories (id, organization_id, device_id, hlc, name, name_search, sort_order, created_at_ms, updated_at_ms)
      VALUES (?, ?, ?, ?, 'Ichimliklar', 'ichimliklar', 1, ?, ?)
    `,
      )
      .run(sharedCatId, orgId, deviceA, hlcA1, Number(baseNowMs), Number(baseNowMs));

    connA.sqlite
      .prepare(
        `
      INSERT INTO customers (id, organization_id, device_id, hlc, full_name, name_search, is_active, created_at_ms, updated_at_ms)
      VALUES (?, ?, ?, ?, 'Akmal Saidov', 'akmal saidov', 1, ?, ?)
    `,
      )
      .run(sharedCustId, orgId, deviceA, hlcA1, Number(baseNowMs), Number(baseNowMs));

    // 2. Simulate Cloud holding the events pushed from Hub A
    const catEventFromA: SyncedEventDto = {
      eventId: idGen.nextId(),
      organizationId: orgId,
      storeId: storeA,
      deviceId: deviceA,
      deviceSeq: '1',
      hlc: hlcA1,
      type: 'category.created',
      entity: 'categories',
      entityId: sharedCatId,
      entityClass: 'ATTR',
      schemaVersion: CURRENT_SCHEMA_VERSION,
      payload: {
        id: sharedCatId,
        organizationId: orgId,
        deviceId: deviceA,
        hlc: hlcA1,
        createdAtMs: Number(baseNowMs),
        updatedAtMs: Number(baseNowMs),
        name: 'Ichimliklar',
        nameSearch: 'ichimliklar',
        sortOrder: 1,
      },
      position: '1',
      hlcAdjusted: false,
      receivedAtMs: unixMsFromBigInt(baseNowMs),
    };

    const custEventFromA: SyncedEventDto = {
      eventId: idGen.nextId(),
      organizationId: orgId,
      storeId: storeA,
      deviceId: deviceA,
      deviceSeq: '2',
      hlc: hlcA1,
      type: 'customer.created',
      entity: 'customers',
      entityId: sharedCustId,
      entityClass: 'ATTR',
      schemaVersion: CURRENT_SCHEMA_VERSION,
      payload: {
        id: sharedCustId,
        organizationId: orgId,
        deviceId: deviceA,
        hlc: hlcA1,
        createdAtMs: Number(baseNowMs),
        updatedAtMs: Number(baseNowMs),
        fullName: 'Akmal Saidov',
        nameSearch: 'akmal saidov',
        isActive: true,
      },
      position: '2',
      hlcAdjusted: false,
      receivedAtMs: unixMsFromBigInt(baseNowMs),
    };

    // 3. Hub B pulls from Cloud: applies category and customer
    const pullResB = pullServiceB.applySyncPullBatch({
      context: { organizationId: orgId, storeId: storeB, deviceId: deviceB },
      events: [catEventFromA, custEventFromA],
      nextCursors: { [storeA]: 2n },
      nowMs: unixMsFromBigInt(baseNowMs),
    });

    expect(pullResB.appliedCount).toBe(2);
    expect(
      connB.sqlite.prepare('SELECT name FROM categories WHERE id = ?').get(sharedCatId),
    ).toEqual({ name: 'Ichimliklar' });
    expect(
      connB.sqlite.prepare('SELECT full_name FROM customers WHERE id = ?').get(sharedCustId),
    ).toEqual({ full_name: 'Akmal Saidov' });

    // 4. Hub B updates Category name with a higher HLC
    currentNowMs = baseNowMs + 60000n;
    const hlcB2 = '000170000060000:00001:01880000-0000-7000-8000-000000000222';
    connB.sqlite
      .prepare(
        `
      UPDATE categories SET name = 'Salqin Ichimliklar', name_search = 'salqin ichimliklar', hlc = ?, updated_at_ms = ? WHERE id = ?
    `,
      )
      .run(hlcB2, Number(currentNowMs), sharedCatId);

    // Event pushed from Hub B to Cloud
    const catUpdateEventFromB: SyncedEventDto = {
      eventId: idGen.nextId(),
      organizationId: orgId,
      storeId: storeB,
      deviceId: deviceB,
      deviceSeq: '1',
      hlc: hlcB2,
      type: 'category.updated',
      entity: 'categories',
      entityId: sharedCatId,
      entityClass: 'ATTR',
      schemaVersion: CURRENT_SCHEMA_VERSION,
      payload: {
        id: sharedCatId,
        organizationId: orgId,
        deviceId: deviceB,
        hlc: hlcB2,
        createdAtMs: Number(baseNowMs),
        updatedAtMs: Number(currentNowMs),
        name: 'Salqin Ichimliklar',
        nameSearch: 'salqin ichimliklar',
        sortOrder: 1,
      },
      position: '1',
      hlcAdjusted: false,
      receivedAtMs: unixMsFromBigInt(currentNowMs),
    };

    // 5. Hub A pulls from Cloud: category name is updated to Hub B's change via LWW!
    const pullResA = pullServiceA.applySyncPullBatch({
      context: { organizationId: orgId, storeId: storeA, deviceId: deviceA },
      events: [catUpdateEventFromB],
      nextCursors: { [storeB]: 1n },
      nowMs: unixMsFromBigInt(currentNowMs),
    });

    expect(pullResA.appliedCount).toBe(1);
    expect(
      connA.sqlite.prepare('SELECT name FROM categories WHERE id = ?').get(sharedCatId),
    ).toEqual({ name: 'Salqin Ichimliklar' });

    // 6. Hub A records customer debt of 70,000 UZS for Akmal Saidov
    currentNowMs = baseNowMs + 120000n;
    const ledgerId = idGen.nextId();
    const hlcA3 = '000170000120000:00001:01880000-0000-7000-8000-000000000111';

    const ledgerEventFromA: SyncedEventDto = {
      eventId: idGen.nextId(),
      organizationId: orgId,
      storeId: storeA,
      deviceId: deviceA,
      deviceSeq: '3',
      hlc: hlcA3,
      type: 'customer_ledger.created',
      entity: 'customer_ledger',
      entityId: ledgerId,
      entityClass: 'FACT',
      schemaVersion: CURRENT_SCHEMA_VERSION,
      payload: {
        id: ledgerId,
        organizationId: orgId,
        storeId: storeA,
        deviceId: deviceA,
        hlc: hlcA3,
        createdAtMs: Number(currentNowMs),
        customerId: sharedCustId,
        entryType: 'opening_balance',
        amountDelta: '70000',
        sourceType: 'opening_balance',
        sourceId: idGen.nextId(),
        reason: 'Store A debt',
        createdByUserId: cashierA,
      },
      position: '3',
      hlcAdjusted: false,
      receivedAtMs: unixMsFromBigInt(currentNowMs),
    };

    // Apply to Hub A itself first (as local projection)
    pullServiceA.applySyncPullBatch({
      context: { organizationId: orgId, storeId: storeA, deviceId: deviceA },
      events: [ledgerEventFromA],
      nextCursors: { [storeA]: 3n },
      nowMs: unixMsFromBigInt(currentNowMs),
    });

    const balA = connA.sqlite
      .prepare('SELECT balance FROM local_customer_balances WHERE customer_id = ?')
      .get(sharedCustId) as { balance: bigint };
    expect(balA.balance).toBe(70000n);

    // 7. Hub B pulls customer_ledger event from Cloud (since customer_ledger has pullScope: 'organization')
    pullServiceB.applySyncPullBatch({
      context: { organizationId: orgId, storeId: storeB, deviceId: deviceB },
      events: [ledgerEventFromA],
      nextCursors: { [storeA]: 3n },
      nowMs: unixMsFromBigInt(currentNowMs),
    });

    // Hub B's local customer balance projection is updated with the debt from Store A!
    const balB = connB.sqlite
      .prepare('SELECT balance FROM local_customer_balances WHERE customer_id = ?')
      .get(sharedCustId) as { balance: bigint };
    expect(balB.balance).toBe(70000n);

    // Both Hubs are in complete convergence!
    expect(balA.balance).toEqual(balB.balance);
    const catA = connA.sqlite
      .prepare('SELECT name, hlc FROM categories WHERE id = ?')
      .get(sharedCatId);
    const catB = connB.sqlite
      .prepare('SELECT name, hlc FROM categories WHERE id = ?')
      .get(sharedCatId);
    expect(catA).toEqual(catB);
  });
});

describePg('Two Hubs Convergence via Real Cloud PostgreSQL (X4)', () => {
  let container: StartedPostgreSqlContainer;
  let adminConn: ReturnType<typeof createCloudPgPool>;
  let appConn: ReturnType<typeof createCloudPgPool>;
  let cloudServer: FastifyInstance;
  let syncPushStore: CloudSyncPushStore;
  let syncPullStore: CloudSyncPullStore;
  let cloudBaseUrl: string;

  let hubA: HubServer;
  let hubB: HubServer;
  let tmpA: string;
  let tmpB: string;

  const orgId = parseUuidV7('018bcfe5-6800-7000-8000-000000000001');
  const storeA = parseUuidV7('018bcfe5-6800-7000-8000-000000000011');
  const storeB = parseUuidV7('018bcfe5-6800-7000-8000-000000000022');
  const deviceA = parseUuidV7('018bcfe5-6800-7000-8000-000000000111');
  const deviceB = parseUuidV7('018bcfe5-6800-7000-8000-000000000222');
  const tokenA = 'device-token-secret-hub-a-1234';
  const tokenB = 'device-token-secret-hub-b-5678';
  const baseNowMs = 1700000000000n;
  let currentCloudNowMs = unixMsFromBigInt(baseNowMs);
  const nowMs = unixMsFromBigInt(baseNowMs);

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:18-alpine').start();

    adminConn = createCloudPgPool({
      connectionString: container.getConnectionUri(),
    });

    const testAppPassword = 'test-cloud-api-two-hubs-password-1234';
    process.env.MEZON_APP_DB_PASSWORD = testAppPassword;
    await provisionAppRole({ pool: adminConn.pool });
    await migrateCloudDatabase(adminConn.db);

    const appConnUri = new URL(container.getConnectionUri());
    appConnUri.username = PG_APP_ROLE_NAME;
    appConnUri.password = testAppPassword;

    appConn = createCloudPgPool({
      connectionString: appConnUri.toString(),
    });
    syncPushStore = new CloudSyncPushStore(appConn.pool);
    syncPullStore = new CloudSyncPullStore(appConn.pool);

    // Seed org, stores, devices in Cloud
    await adminConn.db.insert(cloudOrganizations).values({
      id: orgId,
      organizationId: orgId,
      name: 'Two Hubs Org',
      status: 'active',
      createdAtMs: nowMs,
      updatedAtMs: nowMs,
    });

    await adminConn.db.insert(cloudStores).values([
      {
        id: storeA,
        organizationId: orgId,
        name: 'Store A',
        code: 'store_a',
        isActive: true,
        createdAtMs: nowMs,
        updatedAtMs: nowMs,
      },
      {
        id: storeB,
        organizationId: orgId,
        name: 'Store B',
        code: 'store_b',
        isActive: true,
        createdAtMs: nowMs,
        updatedAtMs: nowMs,
      },
    ]);

    await adminConn.db.insert(cloudDevices).values([
      {
        id: parseUuidV7('018bcfe5-6800-7000-8000-000000000101'),
        organizationId: orgId,
        storeId: storeA,
        deviceId: deviceA,
        name: 'Hub A Device',
        platform: 'windows',
        appVersion: '1.0.0',
        status: 'active',
        lastSeenAtMs: nowMs,
        createdAtMs: nowMs,
        updatedAtMs: nowMs,
      },
      {
        id: parseUuidV7('018bcfe5-6800-7000-8000-000000000202'),
        organizationId: orgId,
        storeId: storeB,
        deviceId: deviceB,
        name: 'Hub B Device',
        platform: 'windows',
        appVersion: '1.0.0',
        status: 'active',
        lastSeenAtMs: nowMs,
        createdAtMs: nowMs,
        updatedAtMs: nowMs,
      },
    ]);

    // Fastify Cloud API server
    cloudServer = Fastify({ logger: false });

    cloudServer.post('/api/v1/sync/push', async (req, reply) => {
      const authHeader = req.headers.authorization;
      const isA = authHeader === `Bearer ${tokenA}`;
      const isB = authHeader === `Bearer ${tokenB}`;
      if (!isA && !isB) {
        return reply.code(401).send({ error: 'Unauthorized', code: 'DEVICE_UNAUTHORIZED' });
      }

      const parsed = SyncPushRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'Validation Error' });
      }

      const { events } = parsed.data;
      const context = isA
        ? {
            organizationId: orgId,
            storeId: storeA,
            deviceId: deviceA,
            deviceName: 'Hub A',
            status: 'active' as const,
          }
        : {
            organizationId: orgId,
            storeId: storeB,
            deviceId: deviceB,
            deviceName: 'Hub B',
            status: 'active' as const,
          };

      const result: SyncPushResponseDto = await syncPushStore.processSyncPushBatch({
        context,
        events,
        nowMs: currentCloudNowMs,
      });

      return reply.code(200).send(result);
    });

    cloudServer.get('/api/v1/sync/pull', async (req, reply) => {
      const authHeader = req.headers.authorization;
      const isA = authHeader === `Bearer ${tokenA}`;
      const isB = authHeader === `Bearer ${tokenB}`;
      if (!isA && !isB) {
        return reply.code(401).send({ error: 'Unauthorized', code: 'DEVICE_UNAUTHORIZED' });
      }

      const query = req.query as { cursors?: string; limit?: string };
      const parsedCursors = parseAndValidateSyncCursors(query.cursors);
      if (!parsedCursors.success) {
        return reply.code(400).send({ error: 'Bad Request', code: 'INVALID_CURSORS' });
      }

      const context = isA
        ? {
            organizationId: orgId,
            storeId: storeA,
            deviceId: deviceA,
            deviceName: 'Hub A',
            status: 'active' as const,
          }
        : {
            organizationId: orgId,
            storeId: storeB,
            deviceId: deviceB,
            deviceName: 'Hub B',
            status: 'active' as const,
          };

      try {
        const result = await syncPullStore.getSyncPullEvents({
          context,
          cursors: parsedCursors.cursors,
          limit: query.limit ? Number(query.limit) : 100,
        });

        return reply.code(200).send(result);
      } catch (err) {
        if (err instanceof ForeignStoreError) {
          return reply
            .code(400)
            .send({ error: 'Bad Request', code: 'FOREIGN_STORE_ID', message: err.message });
        }
        throw err;
      }
    });

    const cloudAddr = await cloudServer.listen({ host: '127.0.0.1', port: 0 });
    cloudBaseUrl = cloudAddr;

    // Create Hub A
    tmpA = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-a-cloud-test-'));
    hubA = await createHubServer({
      dbPath: path.join(tmpA, 'hub-a.db'),
      port: 0,
      logLevel: 'silent',
    });
    await hubA.listen();

    // Create Hub B
    tmpB = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-b-cloud-test-'));
    hubB = await createHubServer({
      dbPath: path.join(tmpB, 'hub-b.db'),
      port: 0,
      logLevel: 'silent',
    });
    await hubB.listen();

    const idGen = new MonotonicUuidV7Generator({
      clock: { now: () => nowMs },
      random: { nextBytes: (n: number) => new Uint8Array(n).fill(1) },
    });

    // Pair Hub A
    ensureDeviceStateRowSync(hubA.connection.sqlite, hubA.connection.db, {
      rowId: idGen.nextId(),
      organizationId: orgId,
      deviceId: deviceA,
      initialHlcStr: '000170000000000:00000:018bcfe5-6800-7000-8000-000000000111',
      initialUuidMs: 1700000000000n,
      nowMs: 1700000000000n,
    });
    const encTokenA = (await hubA.safeStorage.encryptString(tokenA)).toString('base64');
    await hubA.cloudStore.saveCloudState({
      status: 'paired',
      cloudUrl: cloudBaseUrl,
      organizationId: orgId,
      organizationName: 'Two Hubs Org',
      storeId: storeA,
      storeName: 'Store A',
      encryptedDeviceToken: encTokenA,
      pairedAtMs: nowMs,
      nowMs,
      idGen,
    });

    // Pair Hub B
    ensureDeviceStateRowSync(hubB.connection.sqlite, hubB.connection.db, {
      rowId: idGen.nextId(),
      organizationId: orgId,
      deviceId: deviceB,
      initialHlcStr: '000170000000000:00000:018bcfe5-6800-7000-8000-000000000222',
      initialUuidMs: 1700000000000n,
      nowMs: 1700000000000n,
    });
    const encTokenB = (await hubB.safeStorage.encryptString(tokenB)).toString('base64');
    await hubB.cloudStore.saveCloudState({
      status: 'paired',
      cloudUrl: cloudBaseUrl,
      organizationId: orgId,
      organizationName: 'Two Hubs Org',
      storeId: storeB,
      storeName: 'Store B',
      encryptedDeviceToken: encTokenB,
      pairedAtMs: nowMs,
      nowMs,
      idGen,
    });
  }, 120_000);

  afterAll(async () => {
    if (hubA) await hubA.close();
    if (hubB) await hubB.close();
    if (cloudServer) await cloudServer.close();
    if (appConn) await appConn.pool.end();
    if (adminConn) await adminConn.pool.end();
    if (container) await container.stop();
    if (tmpA && fs.existsSync(tmpA)) fs.rmSync(tmpA, { recursive: true, force: true });
    if (tmpB && fs.existsSync(tmpB)) fs.rmSync(tmpB, { recursive: true, force: true });
  });

  it('Hub A pushes category to Cloud, Hub B pulls it, Hub B updates it with higher HLC, Hub A pulls and converges via LWW', async () => {
    const catId = parseUuidV7('018bcfe5-6800-7000-8000-000000000777');
    const hlcA1 = '000170000000000:00001:018bcfe5-6800-7000-8000-000000000111';

    // 1. Hub A creates Category locally and adds to outbox
    hubA.connection.sqlite.transaction(() => {
      hubA.connection.sqlite
        .prepare(
          `INSERT INTO categories (id, organization_id, device_id, hlc, name, name_search, sort_order, created_at_ms, updated_at_ms)
           VALUES (?, ?, ?, ?, 'Milliy Taomlar', 'milliy taomlar', 1, ?, ?)`,
        )
        .run(catId, orgId, deviceA, hlcA1, 1700000000000, 1700000000000);

      hubA.connection.db
        .insert(localOutbox)
        .values({
          id: parseUuidV7('018bcfe5-6800-7000-8000-000000000788'),
          organizationId: orgId,
          storeId: storeA,
          deviceId: deviceA,
          deviceSeq: 1n,
          hlc: hlcA1,
          type: 'category.created',
          entity: 'categories',
          entityId: catId,
          entityClass: 'ATTR',
          schemaVersion: CURRENT_SCHEMA_VERSION,
          payload: JSON.stringify({
            id: catId,
            organizationId: orgId,
            deviceId: deviceA,
            hlc: hlcA1,
            name: 'Milliy Taomlar',
            nameSearch: 'milliy taomlar',
            sortOrder: 1,
            createdAtMs: 1700000000000,
            updatedAtMs: 1700000000000,
          }),
          createdAtMs: unixMsFromBigInt(1700000000000n),
          updatedAtMs: unixMsFromBigInt(1700000000000n),
          status: 'pending',
          attempts: 0,
        })
        .run();
    })();

    // 2. Hub A pushes to Cloud via PushWorker
    const pushResA = await hubA.pushWorker.pushBatch();
    expect(pushResA.status).toBe('ok');
    expect(pushResA.acked).toBe(1);

    // 3. Hub B pulls from Cloud via PullWorker
    const pullResB = await hubB.pullWorker.pullBatch();
    expect(pullResB.status).toBe('ok');
    expect(pullResB.applied).toBe(1);

    // Hub B now has the Category from Hub A
    const catInB = hubB.connection.sqlite
      .prepare('SELECT name, hlc FROM categories WHERE id = ?')
      .get(catId) as { name: string; hlc: string };
    expect(catInB).toBeDefined();
    expect(catInB.name).toBe('Milliy Taomlar');
    expect(catInB.hlc).toBe(hlcA1);

    // 4. Hub B updates the Category name with a higher HLC and pushes to Cloud
    currentCloudNowMs = unixMsFromBigInt(1700000060000n);
    const hlcB2 = '000170000060000:00001:018bcfe5-6800-7000-8000-000000000222';
    hubB.connection.sqlite.transaction(() => {
      hubB.connection.sqlite
        .prepare(
          `UPDATE categories SET name = 'Sara Milliy Taomlar', name_search = 'sara milliy taomlar', hlc = ?, updated_at_ms = 1700000060000
           WHERE id = ?`,
        )
        .run(hlcB2, catId);

      hubB.connection.db
        .insert(localOutbox)
        .values({
          id: parseUuidV7('018bcfe5-6800-7000-8000-000000000799'),
          organizationId: orgId,
          storeId: storeB,
          deviceId: deviceB,
          deviceSeq: 1n,
          hlc: hlcB2,
          type: 'category.updated',
          entity: 'categories',
          entityId: catId,
          entityClass: 'ATTR',
          schemaVersion: CURRENT_SCHEMA_VERSION,
          payload: JSON.stringify({
            id: catId,
            organizationId: orgId,
            deviceId: deviceB,
            hlc: hlcB2,
            name: 'Sara Milliy Taomlar',
            nameSearch: 'sara milliy taomlar',
            sortOrder: 1,
            createdAtMs: 1700000000000,
            updatedAtMs: 1700000060000,
          }),
          createdAtMs: unixMsFromBigInt(1700000060000n),
          updatedAtMs: unixMsFromBigInt(1700000060000n),
          status: 'pending',
          attempts: 0,
        })
        .run();
    })();

    const pushResB = await hubB.pushWorker.pushBatch();
    expect(pushResB.status).toBe('ok');
    expect(pushResB.acked).toBe(1);

    // 5. Hub A pulls from Cloud via PullWorker: LWW applies Hub B's newer update!
    const pullResA = await hubA.pullWorker.pullBatch();
    expect(pullResA.status).toBe('ok');
    expect(pullResA.applied).toBe(1);

    // Hub A now has the updated name from Hub B!
    const catInA = hubA.connection.sqlite
      .prepare('SELECT name, hlc FROM categories WHERE id = ?')
      .get(catId) as { name: string; hlc: string };
    expect(catInA).toBeDefined();
    expect(catInA.name).toBe('Sara Milliy Taomlar');
    expect(catInA.hlc).toBe(hlcB2);

    // Convergence verified across both Hubs via real Cloud PostgreSQL
    const catInBFinal = hubB.connection.sqlite
      .prepare('SELECT name, hlc FROM categories WHERE id = ?')
      .get(catId) as { name: string; hlc: string };
    expect(catInA.name).toBe(catInBFinal.name);
    expect(catInA.hlc).toBe(catInBFinal.hlc);
  });
});
