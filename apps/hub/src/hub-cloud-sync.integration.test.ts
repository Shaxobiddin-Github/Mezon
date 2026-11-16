import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { type SyncPushResponseDto, SyncPushRequestSchema } from '@mezon/contracts';
import {
  PG_APP_ROLE_NAME,
  CloudSyncPushStore,
  cloudSyncEvents,
  createCloudPgPool,
  migrateCloudDatabase,
  sales,
  shouldRunPgTests,
  users,
} from '@mezon/db-cloud';
import { ensureDeviceStateRowSync, localOutbox } from '@mezon/db-local';
import {
  MonotonicUuidV7Generator,
  parseUuidV7,
  serializeHlc,
  unixMsFromBigInt,
} from '@mezon/domain';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { eq } from 'drizzle-orm';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { provisionAppRole } from '../../../packages/db-cloud/ops/provision-app-role.mjs';
import { createHubServer, type HubServer } from './server.js';

const describePg = shouldRunPgTests() ? describe : describe.skip;

describePg('@mezon/hub - Hub to Cloud Sync Integration Test (R6)', () => {
  let container: StartedPostgreSqlContainer;
  let adminConn: ReturnType<typeof createCloudPgPool>;
  let appConn: ReturnType<typeof createCloudPgPool>;
  let cloudServer: FastifyInstance;
  let hubServer: HubServer;
  let tmpDir: string;
  let dbPath: string;

  const orgA = parseUuidV7('018bcfe5-6800-7000-8000-000000000001');
  const storeA = parseUuidV7('018bcfe5-6800-7000-8000-000000000011');
  const deviceA = parseUuidV7('018bcfe5-6800-7000-8000-000000000111');
  const ownerA = parseUuidV7('018bcfe5-6800-7000-8000-000000000003');
  const validToken = 'test-device-token-12345';

  let cloudBaseUrl: string;

  beforeAll(async () => {
    // 1. Start Testcontainers PostgreSQL container
    container = await new PostgreSqlContainer('postgres:18-alpine').start();

    adminConn = createCloudPgPool({
      connectionString: container.getConnectionUri(),
    });

    const testAppPassword = 'test-cloud-api-app-password-secret-1234';
    process.env.MEZON_APP_DB_PASSWORD = testAppPassword;
    await provisionAppRole({ pool: adminConn.pool });
    await migrateCloudDatabase(adminConn.db);

    const appConnUri = new URL(container.getConnectionUri());
    appConnUri.username = PG_APP_ROLE_NAME;
    appConnUri.password = testAppPassword;

    appConn = createCloudPgPool({
      connectionString: appConnUri.toString(),
    });
    const syncPushStore = new CloudSyncPushStore(appConn.pool);

    const nowMs = unixMsFromBigInt(1700000000000n);
    const initHlc = serializeHlc({
      physicalMs: nowMs,
      logical: 0,
      nodeId: deviceA,
    });

    // Seed ownerA into Cloud domain users table so foreign keys resolve
    await adminConn.db.insert(users).values({
      id: ownerA,
      organizationId: orgA,
      username: 'owner_a',
      fullName: 'Owner A',
      role: 'owner',
      isActive: true,
      deviceId: deviceA,
      hlc: initHlc,
      createdAtMs: nowMs,
      updatedAtMs: nowMs,
      deletedAtMs: null,
    });

    // 2. Spin up Cloud Fastify HTTP Server
    cloudServer = Fastify({ logger: false });

    cloudServer.post('/api/v1/sync/push', async (req, reply) => {
      const authHeader = req.headers.authorization;
      if (authHeader !== `Bearer ${validToken}`) {
        return reply.code(401).send({ error: 'Unauthorized', code: 'DEVICE_UNAUTHORIZED' });
      }

      const parsed = SyncPushRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'Validation Error' });
      }

      const { events } = parsed.data;
      const result: SyncPushResponseDto = await syncPushStore.processSyncPushBatch({
        context: {
          organizationId: orgA,
          storeId: storeA,
          deviceId: deviceA,
          deviceName: 'Kassa 1',
          status: 'active',
        },
        events,
        nowMs,
      });

      return reply.code(200).send(result);
    });

    const cloudAddr = await cloudServer.listen({ host: '127.0.0.1', port: 0 });
    cloudBaseUrl = cloudAddr;

    // 3. Setup Hub SQLite Server
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-cloud-integration-'));
    dbPath = path.join(tmpDir, 'hub.db');

    hubServer = await createHubServer({
      dbPath,
      port: 0,
      logLevel: 'silent',
    });

    await hubServer.listen();

    // 4. Pair device in Hub with cloud server
    const idGen = new MonotonicUuidV7Generator({
      clock: { now: () => unixMsFromBigInt(1700000000000n) },
      random: { nextBytes: (n: number) => new Uint8Array(n).fill(1) },
    });

    ensureDeviceStateRowSync(hubServer.connection.sqlite, hubServer.connection.db, {
      rowId: idGen.nextId(),
      organizationId: orgA,
      deviceId: deviceA,
      initialHlcStr: initHlc,
      initialUuidMs: 1700000000000n,
      nowMs: 1700000000000n,
    });

    const encryptedBytes = await hubServer.safeStorage.encryptString(validToken);
    const encryptedDeviceToken = encryptedBytes.toString('base64');
    await hubServer.cloudStore.saveCloudState({
      status: 'paired',
      cloudUrl: cloudBaseUrl,
      organizationId: orgA,
      organizationName: 'Guzar Kattaqo‘rg‘on Org A',
      storeId: storeA,
      storeName: 'Do‘kon A',
      encryptedDeviceToken,
      pairedAtMs: nowMs,
      nowMs,
      idGen,
    });
  }, 120_000);

  afterAll(async () => {
    if (hubServer) {
      await hubServer.close();
    }
    if (cloudServer) {
      await cloudServer.close();
    }
    if (appConn) {
      await appConn.pool.end();
    }
    if (adminConn) {
      await adminConn.pool.end();
    }
    if (container) {
      await container.stop();
    }
    if (tmpDir && fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('R6: end-to-end syncs completed sale from Hub SQLite outbox to Cloud PostgreSQL sales and cloud_sync_events', async () => {
    // 1. Initial setup in Hub: create user & shift
    const seedInitial = hubServer.connection.sqlite.transaction(() => {
      // Seed user in Hub
      hubServer.connection.sqlite
        .prepare(
          `
        INSERT INTO users (id, organization_id, device_id, hlc, created_at_ms, updated_at_ms, username, full_name, role, is_active)
        VALUES (?, ?, ?, ?, ?, ?, 'owner_a', 'Owner A', 'owner', 1)
      `,
        )
        .run(
          ownerA,
          orgA,
          deviceA,
          '001700000000000:00000:018bcfe5-6800-7000-8000-000000000111',
          1700000000000n,
          1700000000000n,
        );

      // Seed shift in Hub
      hubServer.connection.sqlite
        .prepare(
          `
        INSERT INTO shifts (
          id, organization_id, store_id, device_id, hlc, created_at_ms, updated_at_ms,
          shift_no, shift_code, status, opened_by_user_id, opening_cash, opened_at_ms,
          open_client_request_id, open_request_hash
        )
        VALUES (
          '018bcfe5-6800-7000-8000-000000000055', ?, ?, ?,
          '001700000000000:00000:018bcfe5-6800-7000-8000-000000000111', 1700000000000, 1700000000000,
          1, 'SHF-001', 'open', ?, 0, 1700000000000,
          '018bcfe5-6800-7000-8000-000000000056', 'hash123456'
        )
      `,
        )
        .run(orgA, storeA, deviceA, ownerA);
    });
    seedInitial();

    // Seed shifts in Cloud too so foreign key resolves
    await adminConn.db.execute(`
      INSERT INTO shifts (
        id, organization_id, store_id, device_id, hlc, created_at_ms, updated_at_ms,
        shift_no, shift_code, status, opened_by_user_id, opening_cash, opened_at_ms,
        open_client_request_id, open_request_hash
      )
      VALUES (
        '018bcfe5-6800-7000-8000-000000000055', '${orgA}', '${storeA}', '${deviceA}',
        '001700000000000:00000:018bcfe5-6800-7000-8000-000000000111', '1700000000000', '1700000000000',
        1, 'SHF-001', 'open', '${ownerA}', '0', '1700000000000',
        '018bcfe5-6800-7000-8000-000000000056', 'hash123456'
      )
    `);

    // 2. Perform a sale in Hub
    const saleId = parseUuidV7('018bcfe5-6800-7000-8000-000000000066');
    const salePayload = {
      id: saleId,
      organizationId: orgA,
      storeId: storeA,
      deviceId: deviceA,
      hlc: '001700000000000:00001:018bcfe5-6800-7000-8000-000000000111',
      createdAtMs: '1700000000000',
      updatedAtMs: '1700000000000',
      receiptNo: '1',
      receiptCode: 'REC-001',
      sourceCartId: null,
      sourceOrderId: null,
      cashierUserId: ownerA,
      completedByUserId: ownerA,
      customerId: null,
      shiftId: '018bcfe5-6800-7000-8000-000000000055',
      shiftCashierSessionId: null,
      clientRequestId: '018bcfe5-6800-7000-8000-000000000067',
      requestHash: 'hash123456',
      subtotalGross: '10000',
      totalPromoDiscount: '0',
      subtotalAfterPromo: '10000',
      manualDiscountMode: 'none',
      manualDiscountValue: '0',
      manualDiscountReason: null,
      orderDiscountAmount: '0',
      totalFinal: '10000',
      totalNetExVat: '8929',
      totalVat: '1071',
      totalPaid: '10000',
      debtAmount: '0',
      changeAmount: '0',
      overrideApprovedByUserId: null,
      overrideApprovedAmount: null,
      overrideApprovedAtMs: null,
      voidedAtMs: null,
      voidedByUserId: null,
      voidReason: null,
      voidClientRequestId: null,
      voidRequestHash: null,
    };

    // Atomically insert into Hub SQLite sales table and append to outbox
    const seedSaleAndOutbox = hubServer.connection.sqlite.transaction(() => {
      hubServer.connection.sqlite
        .prepare(
          `
        INSERT INTO sales (
          id, organization_id, store_id, device_id, hlc, created_at_ms, updated_at_ms,
          shift_id, cashier_user_id, completed_by_user_id, client_request_id, request_hash,
          receipt_no, receipt_code, subtotal_gross, total_promo_discount, subtotal_after_promo,
          manual_discount_mode, manual_discount_value, order_discount_amount, total_final,
          total_net_ex_vat, total_vat, total_paid, debt_amount, change_amount
        )
        VALUES (
          ?, ?, ?, ?, ?, ?, ?,
          ?, ?, ?, ?, ?,
          1, 'REC-001', 10000, 0, 10000,
          'none', 0, 0, 10000,
          8929, 1071, 10000, 0, 0
        )
      `,
        )
        .run(
          saleId,
          orgA,
          storeA,
          deviceA,
          '001700000000000:00001:018bcfe5-6800-7000-8000-000000000111',
          1700000000000n,
          1700000000000n,
          '018bcfe5-6800-7000-8000-000000000055',
          ownerA,
          ownerA,
          '018bcfe5-6800-7000-8000-000000000067',
          'hash123456',
        );

      // Append to outbox in same transaction
      hubServer.connection.sqlite
        .prepare(
          `
        INSERT INTO local_outbox (
          id, organization_id, store_id, device_id, device_seq, hlc,
          type, entity, entity_id, class, schema_version,
          payload, status, attempts, created_at_ms, updated_at_ms
        )
        VALUES (
          ?, ?, ?, ?, 1, ?,
          'sales.created', 'sales', ?, 'MONOTONE', 1,
          ?, 'pending', 0, ?, ?
        )
      `,
        )
        .run(
          '018bcfe5-6800-7000-8000-000000000068',
          orgA,
          storeA,
          deviceA,
          '001700000000000:00001:018bcfe5-6800-7000-8000-000000000111',
          saleId,
          JSON.stringify(salePayload),
          1700000000000n,
          1700000000000n,
        );
    });
    seedSaleAndOutbox();

    // Verify outbox row is initially pending
    const initialOutboxRow = hubServer.outboxStore.getPendingBatch(10);
    expect(initialOutboxRow).toHaveLength(1);
    expect(initialOutboxRow[0].status).toBe('pending');

    // 3. Trigger Hub push worker batch
    const pushOutcome = await hubServer.pushWorker.pushBatch();
    expect(pushOutcome.pushed).toBe(1);
    expect(pushOutcome.acked).toBe(1);
    expect(pushOutcome.status).toBe('ok');

    // 4. Verify outbox row in Hub SQLite is now 'acked'
    const [ackedOutbox] = hubServer.connection.db
      .select()
      .from(localOutbox)
      .where(eq(localOutbox.id, parseUuidV7('018bcfe5-6800-7000-8000-000000000068')))
      .all();
    expect(ackedOutbox.status).toBe('acked');

    // 5. Verify sale row exists in Cloud PostgreSQL
    const [cloudSale] = await adminConn.db.select().from(sales).where(eq(sales.id, saleId));
    expect(cloudSale).toBeDefined();
    expect(cloudSale.receiptCode).toBe('REC-001');
    expect(cloudSale.totalFinal).toBe(10000n);
    expect(cloudSale.totalPaid).toBe(10000n);

    // 6. Verify sync event exists in Cloud PostgreSQL
    const [cloudEvent] = await adminConn.db
      .select()
      .from(cloudSyncEvents)
      .where(eq(cloudSyncEvents.id, parseUuidV7('018bcfe5-6800-7000-8000-000000000068')));
    expect(cloudEvent).toBeDefined();
    expect(cloudEvent.entity).toBe('sales');
    expect(cloudEvent.entityId).toBe(saleId);
    expect(cloudEvent.position).toBe(1n);
  });
});
