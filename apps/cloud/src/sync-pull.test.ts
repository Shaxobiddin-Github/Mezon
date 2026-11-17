import type {
  CloudPairDeviceResponseDto,
  SyncEventEnvelopeDto,
  SyncPushRequestDto,
  SyncPushResponseDto,
  SyncPullResponseDto,
} from '@mezon/contracts';
import {
  PG_APP_ROLE_NAME,
  CloudAuthStore,
  CloudDeviceStore,
  CloudSyncPushStore,
  CloudSyncPullStore,
  CloudTenantStore,
  createCloudPgPool,
  migrateCloudDatabase,
  shouldRunPgTests,
  users,
} from '@mezon/db-cloud';
import { parseUuidV7, serializeHlc, unixMsFromBigInt } from '@mezon/domain';
import { DeterministicUuidV7Generator } from '@mezon/test-utils';
import * as argon2 from '@node-rs/argon2';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { provisionAppRole } from '../../../packages/db-cloud/ops/provision-app-role.mjs';
import { loadCloudConfig } from './config.js';
import { CloudJwtService } from './jwt.js';
import { buildCloudServer } from './server.js';

const describePg = shouldRunPgTests() ? describe : describe.skip;

describePg('@mezon/cloud - Sync Pull Engine (T2.4)', () => {
  let container: StartedPostgreSqlContainer;
  let adminConn: ReturnType<typeof createCloudPgPool>;
  let appConn: ReturnType<typeof createCloudPgPool>;
  let server: FastifyInstance;
  let syncPushStore: CloudSyncPushStore;
  let syncPullStore: CloudSyncPullStore;
  let tenantStore: CloudTenantStore;
  let deviceStore: CloudDeviceStore;
  let idGen: DeterministicUuidV7Generator;

  const orgA = parseUuidV7('018bcfe5-6800-7000-8000-000000000001');
  const orgB = parseUuidV7('018bcfe5-6800-7000-8000-000000000002');
  const storeA1 = parseUuidV7('018bcfe5-6800-7000-8000-000000000011');
  const storeA2 = parseUuidV7('018bcfe5-6800-7000-8000-000000000012');
  const storeB = parseUuidV7('018bcfe5-6800-7000-8000-000000000022');
  const deviceA1 = parseUuidV7('018bcfe5-6800-7000-8000-000000000111');
  const deviceA2 = parseUuidV7('018bcfe5-6800-7000-8000-000000000112');
  const deviceA3 = parseUuidV7('018bcfe5-6800-7000-8000-000000000113');
  const deviceB = parseUuidV7('018bcfe5-6800-7000-8000-000000000222');
  const ownerA = parseUuidV7('018bcfe5-6800-7000-8000-000000000055');
  const ownerB = parseUuidV7('018bcfe5-6800-7000-8000-000000000066');

  const nowMs = unixMsFromBigInt(1_700_000_000_000n);

  let deviceTokenA1: string;
  let deviceTokenA2: string;
  let _deviceTokenA3: string;
  let deviceTokenB: string;

  function makeHlc(seq: number, devId: string) {
    return serializeHlc({ physicalMs: nowMs, logical: seq, nodeId: parseUuidV7(devId) });
  }

  function makeCategoryPayload(catId: string, name: string, sortOrder = 0) {
    const hlc = makeHlc(1, deviceA1);
    return {
      id: catId,
      organizationId: orgA,
      name,
      nameSearch: name.toLowerCase(),
      parentId: null,
      sortOrder,
      deviceId: deviceA1,
      hlc,
      createdAtMs: '1700000000000',
      updatedAtMs: '1700000000000',
      deletedAtMs: null,
    };
  }

  function makeCustomerPayload(custId: string, fullName: string) {
    const hlc = makeHlc(1, deviceA1);
    return {
      id: custId,
      organizationId: orgA,
      deviceId: deviceA1,
      hlc,
      createdAtMs: '1700000000000',
      updatedAtMs: '1700000000000',
      deletedAtMs: null,
      fullName,
      nameSearch: fullName.toLowerCase(),
      phoneNormalized: null,
      phoneDigits: null,
      creditLimit: null,
      defaultDueDays: null,
      note: null,
      isActive: true,
    };
  }

  function makeCustomerLedgerPayload(ledgerId: string, customerId: string, amountTiyin: string) {
    const hlc = makeHlc(2, deviceA1);
    return {
      id: ledgerId,
      organizationId: orgA,
      storeId: storeA1,
      deviceId: deviceA1,
      hlc,
      createdAtMs: '1700000000000',
      customerId,
      entryType: 'opening_balance',
      amountDelta: amountTiyin,
      sourceType: 'opening_balance',
      sourceId: idGen.nextId(),
      saleId: null,
      paymentMethod: null,
      providerRef: null,
      cashMoveId: null,
      dueAtMs: null,
      reason: 'Initial opening debt',
      createdByUserId: ownerA,
      overrideApprovedByUserId: null,
      clientRequestId: null,
      requestHash: null,
    };
  }

  function makeProductPayload(prodId: string, categoryId: string | null, name: string) {
    const hlc = makeHlc(3, deviceA1);
    return {
      id: prodId,
      organizationId: orgA,
      categoryId,
      sku: null,
      skuSearch: null,
      name,
      nameSearch: name.toLowerCase(),
      unit: 'dona',
      unlimited: false,
      minStock: null,
      hasVariants: false,
      trackBatches: false,
      salePrice: '1000',
      mxik: null,
      packageCode: null,
      vatRateBp: 1200,
      deviceId: deviceA1,
      hlc,
      createdAtMs: '1700000000000',
      updatedAtMs: '1700000000000',
      deletedAtMs: null,
    };
  }

  function makeStockMovePayload(
    moveId: string,
    productId: string,
    qtyDelta: string,
    costValueDelta: string,
  ) {
    const hlc = makeHlc(4, deviceA1);
    return {
      id: moveId,
      organizationId: orgA,
      storeId: storeA1,
      deviceId: deviceA1,
      hlc,
      createdAtMs: '1700000000000',
      productId,
      variantId: null,
      batchId: null,
      qtyDelta,
      costValueDelta,
      reason: 'initial',
      sourceType: 'stock_entry',
      sourceId: idGen.nextId(),
      createdByUserId: ownerA,
      note: 'Initial stock move',
    };
  }

  function makeSalePayload(saleId: string, receiptNo: string) {
    const hlc = makeHlc(5, deviceA1);
    return {
      id: saleId,
      organizationId: orgA,
      storeId: storeA1,
      deviceId: deviceA1,
      hlc,
      createdAtMs: '1700000000000',
      updatedAtMs: '1700000000000',
      receiptNo,
      receiptCode: `RCP-${receiptNo}`,
      sourceCartId: null,
      sourceOrderId: null,
      cashierUserId: ownerA,
      completedByUserId: ownerA,
      customerId: null,
      shiftId: null,
      shiftCashierSessionId: null,
      clientRequestId: idGen.nextId(),
      requestHash: 'hash-abc12345',
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
  }

  beforeAll(async () => {
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

    idGen = new DeterministicUuidV7Generator();
    tenantStore = new CloudTenantStore(adminConn.pool);
    deviceStore = new CloudDeviceStore(appConn.pool);
    syncPushStore = new CloudSyncPushStore(appConn.pool);
    syncPullStore = new CloudSyncPullStore(appConn.pool);

    const pwHash = await argon2.hash('TestPassword123!');

    // Create Org A with Store A1
    await tenantStore.createOrganizationWithStoreAndOwner({
      organizationId: orgA,
      storeId: storeA1,
      ownerUserId: ownerA,
      loginIdentityId: idGen.nextId(),
      organizationName: 'Guzar Kattaqo‘rg‘on Org A',
      storeName: 'Do‘kon A1',
      storeCode: 'store_a1',
      ownerUsername: 'owner_a',
      ownerLogin: 'owner_a@guzar.uz',
      passwordHash: pwHash,
      nowMs,
    });

    // Add Store A2 to Org A
    await adminConn.pool.query(
      `INSERT INTO cloud_stores (id, organization_id, name, code, is_active, created_at_ms, updated_at_ms)
       VALUES ($1, $2, $3, $4, true, $5, $6)`,
      [storeA2, orgA, 'Do‘kon A2', 'store_a2', nowMs, nowMs],
    );

    // Create Org B
    await tenantStore.createOrganizationWithStoreAndOwner({
      organizationId: orgB,
      storeId: storeB,
      ownerUserId: ownerB,
      loginIdentityId: idGen.nextId(),
      organizationName: 'Guzar Samarqand Org B',
      storeName: 'Do‘kon B',
      storeCode: 'store_b',
      ownerUsername: 'owner_b',
      ownerLogin: 'owner_b@guzar.uz',
      passwordHash: pwHash,
      nowMs,
    });

    const initHlc = serializeHlc({
      physicalMs: nowMs,
      logical: 0,
      nodeId: deviceA1,
    });

    await adminConn.db.insert(users).values({
      id: ownerA,
      organizationId: orgA,
      username: 'owner_a',
      fullName: 'Owner A',
      role: 'owner',
      isActive: true,
      deviceId: deviceA1,
      hlc: initHlc,
      createdAtMs: nowMs,
      updatedAtMs: nowMs,
      deletedAtMs: null,
    });

    const config = loadCloudConfig({
      DATABASE_URL: appConnUri.toString(),
      JWT_SECRET: 'super-secure-jwt-secret-key-at-least-32-chars-long-12345',
      CORS_ORIGINS: 'http://localhost:3000,http://localhost:5173',
      NODE_ENV: 'test',
    });

    server = await buildCloudServer({
      config,
      conn: appConn,
      jwtService: new CloudJwtService(config.jwtSecret),
      authStore: new CloudAuthStore(appConn.pool),
      tenantStore: new CloudTenantStore(appConn.pool),
      deviceStore,
      syncPushStore,
      syncPullStore,
      idGen,
      clock: { nowMs: () => nowMs },
    });

    await server.ready();

    // Pair Device A1 (under Org A / Store A1)
    const codeA1 = await deviceStore.createPairingCode({
      organizationId: orgA,
      storeId: storeA1,
      deviceName: 'POS A1',
      nowMs,
      idGen,
    });

    const pairResA1 = await server.inject({
      method: 'POST',
      url: '/api/v1/devices/pair',
      payload: {
        code: codeA1.code,
        deviceId: deviceA1,
        platform: 'windows',
        appVersion: '1.0.0',
      },
    });
    expect(pairResA1.statusCode).toBe(201);
    deviceTokenA1 = pairResA1.json<CloudPairDeviceResponseDto>().deviceToken;

    // Pair Device A2 (under Org A / Store A2)
    const codeA2 = await deviceStore.createPairingCode({
      organizationId: orgA,
      storeId: storeA2,
      deviceName: 'POS A2',
      nowMs,
      idGen,
    });

    const pairResA2 = await server.inject({
      method: 'POST',
      url: '/api/v1/devices/pair',
      payload: {
        code: codeA2.code,
        deviceId: deviceA2,
        platform: 'windows',
        appVersion: '1.0.0',
      },
    });
    expect(pairResA2.statusCode).toBe(201);
    deviceTokenA2 = pairResA2.json<CloudPairDeviceResponseDto>().deviceToken;

    // Pair Device A3 (under Org A / Store A1)
    const codeA3 = await deviceStore.createPairingCode({
      organizationId: orgA,
      storeId: storeA1,
      deviceName: 'POS A3',
      nowMs,
      idGen,
    });

    const pairResA3 = await server.inject({
      method: 'POST',
      url: '/api/v1/devices/pair',
      payload: {
        code: codeA3.code,
        deviceId: deviceA3,
        platform: 'windows',
        appVersion: '1.0.0',
      },
    });
    expect(pairResA3.statusCode).toBe(201);
    _deviceTokenA3 = pairResA3.json<CloudPairDeviceResponseDto>().deviceToken;

    // Pair Device B (under Org B / Store B)
    const codeB = await deviceStore.createPairingCode({
      organizationId: orgB,
      storeId: storeB,
      deviceName: 'POS B',
      nowMs,
      idGen,
    });

    const pairResB = await server.inject({
      method: 'POST',
      url: '/api/v1/devices/pair',
      payload: {
        code: codeB.code,
        deviceId: deviceB,
        platform: 'windows',
        appVersion: '1.0.0',
      },
    });
    expect(pairResB.statusCode).toBe(201);
    deviceTokenB = pairResB.json<CloudPairDeviceResponseDto>().deviceToken;
  }, 90000);

  afterAll(async () => {
    if (server) await server.close();
    if (appConn) await appConn.close();
    if (adminConn) await adminConn.close();
    if (container) await container.stop();
  });

  it('rejects unauthenticated pull requests with 401', async () => {
    const res = await server.inject({
      method: 'GET',
      url: '/api/v1/sync/pull',
    });
    expect(res.statusCode).toBe(401);
  });

  it('validates cursors query and rejects foreign storeId with 400 FOREIGN_STORE_ID', async () => {
    // Device A1 belongs to Org A. Passing Store B (belongs to Org B) must fail.
    const res = await server.inject({
      method: 'GET',
      url: `/api/v1/sync/pull?cursors=${storeB}:0`,
      headers: {
        Authorization: `Bearer ${deviceTokenA1}`,
      },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json<{ error: string; code: string }>();
    expect(body.code).toBe('FOREIGN_STORE_ID');
  });

  it('rejects malformed cursors string with 400 INVALID_CURSORS', async () => {
    const res = await server.inject({
      method: 'GET',
      url: '/api/v1/sync/pull?cursors=not-a-valid-cursor-string',
      headers: {
        Authorization: `Bearer ${deviceTokenA1}`,
      },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json<{ error: string; code: string }>();
    expect(body.code).toBe('INVALID_CURSORS');
  });

  it('enforces pullScope: org-scoped events are returned across all stores, while store-scoped events are restricted', async () => {
    const catId = idGen.nextId();
    const eventIdCat = idGen.nextId();
    const hlcCat = makeHlc(1, deviceA1);

    // 1. Device A1 pushes an org-scoped category
    const catPush: SyncPushRequestDto = {
      clientVersion: '1.0.0',
      storeId: storeA1,
      deviceId: deviceA1,
      events: [
        {
          eventId: eventIdCat,
          organizationId: orgA,
          storeId: storeA1,
          deviceId: deviceA1,
          deviceSeq: '1',
          hlc: hlcCat,
          type: 'categories.created',
          entity: 'categories',
          entityId: catId,
          entityClass: 'ATTR',
          schemaVersion: 1,
          payload: makeCategoryPayload(catId, 'Ichimliklar', 1),
        },
      ],
    };

    const pushResCat = await server.inject({
      method: 'POST',
      url: '/api/v1/sync/push',
      headers: {
        Authorization: `Bearer ${deviceTokenA1}`,
      },
      payload: catPush,
    });
    expect(pushResCat.statusCode).toBe(200);

    // 2. Device A2 (Store A2) pulls: must receive the org-scoped category!
    const pullResA2 = await server.inject({
      method: 'GET',
      url: '/api/v1/sync/pull',
      headers: {
        Authorization: `Bearer ${deviceTokenA2}`,
      },
    });
    expect(pullResA2.statusCode).toBe(200);
    const pullA2Data = pullResA2.json<SyncPullResponseDto>();
    expect(pullA2Data.events.some((e) => e.entityId === catId)).toBe(true);

    // 3. Device B (Org B) pulls: must NOT see Org A's category (RLS isolation)
    const pullResB = await server.inject({
      method: 'GET',
      url: '/api/v1/sync/pull',
      headers: {
        Authorization: `Bearer ${deviceTokenB}`,
      },
    });
    expect(pullResB.statusCode).toBe(200);
    const pullBData = pullResB.json<SyncPullResponseDto>();
    expect(pullBData.events.some((e) => e.entityId === catId)).toBe(false);
  });

  it('pullScope: customer_ledger entries are pulled across all stores in the organization (T4)', async () => {
    // Seed customer under Org A
    const custId = idGen.nextId();
    const custEventId = idGen.nextId();
    const custHlc = makeHlc(10, deviceA1);

    const customerPush: SyncPushRequestDto = {
      clientVersion: '1.0.0',
      storeId: storeA1,
      deviceId: deviceA1,
      events: [
        {
          eventId: custEventId,
          organizationId: orgA,
          storeId: storeA1,
          deviceId: deviceA1,
          deviceSeq: '2',
          hlc: custHlc,
          type: 'customers.created',
          entity: 'customers',
          entityId: custId,
          entityClass: 'ATTR',
          schemaVersion: 1,
          payload: makeCustomerPayload(custId, 'Mijoz Said'),
        },
      ],
    };

    const pushCustRes = await server.inject({
      method: 'POST',
      url: '/api/v1/sync/push',
      headers: { Authorization: `Bearer ${deviceTokenA1}` },
      payload: customerPush,
    });
    expect(pushCustRes.statusCode).toBe(200);

    // Store A1 records a customer_ledger entry
    const ledgerId = idGen.nextId();
    const ledgerEventId = idGen.nextId();
    const ledgerHlc = makeHlc(11, deviceA1);

    const ledgerPush: SyncPushRequestDto = {
      clientVersion: '1.0.0',
      storeId: storeA1,
      deviceId: deviceA1,
      events: [
        {
          eventId: ledgerEventId,
          organizationId: orgA,
          storeId: storeA1,
          deviceId: deviceA1,
          deviceSeq: '3',
          hlc: ledgerHlc,
          type: 'customer_ledger.created',
          entity: 'customer_ledger',
          entityId: ledgerId,
          entityClass: 'FACT',
          schemaVersion: 1,
          payload: makeCustomerLedgerPayload(ledgerId, custId, '50000'),
        },
      ],
    };

    const pushLedgerRes = await server.inject({
      method: 'POST',
      url: '/api/v1/sync/push',
      headers: { Authorization: `Bearer ${deviceTokenA1}` },
      payload: ledgerPush,
    });
    expect(pushLedgerRes.statusCode).toBe(200);

    // Device A2 (belonging to Store A2) pulls: must receive the customer_ledger event!
    const pullA2 = await server.inject({
      method: 'GET',
      url: '/api/v1/sync/pull',
      headers: { Authorization: `Bearer ${deviceTokenA2}` },
    });
    expect(pullA2.statusCode).toBe(200);
    const pullA2Data = pullA2.json<SyncPullResponseDto>();
    const foundLedger = pullA2Data.events.find((e) => e.entityId === ledgerId);
    expect(foundLedger).toBeDefined();
    expect(foundLedger?.entity).toBe('customer_ledger');
  });

  it('store-scoped isolation (Y1 / G7): storeA1 pushes sales and stock_moves; storeA2 pull does NOT receive them; storeA2 DOES receive customer_ledger', async () => {
    // 1. Seed a product so stock_moves has a valid foreign key reference
    const prodId = idGen.nextId();
    const prodEventId = idGen.nextId();
    const prodPush: SyncPushRequestDto = {
      clientVersion: '1.0.0',
      storeId: storeA1,
      deviceId: deviceA1,
      events: [
        {
          eventId: prodEventId,
          organizationId: orgA,
          storeId: storeA1,
          deviceId: deviceA1,
          deviceSeq: '20',
          hlc: makeHlc(20, deviceA1),
          type: 'products.created',
          entity: 'products',
          entityId: prodId,
          entityClass: 'ATTR',
          schemaVersion: 1,
          payload: makeProductPayload(prodId, null, 'Do‘kon A1 Mahsulot'),
        },
      ],
    };
    const prodRes = await server.inject({
      method: 'POST',
      url: '/api/v1/sync/push',
      headers: { Authorization: `Bearer ${deviceTokenA1}` },
      payload: prodPush,
    });
    expect(prodRes.statusCode).toBe(200);
    expect(prodRes.json<SyncPushResponseDto>().results[0].status).toBe('accepted');

    // 2. Seed a customer so customer_ledger has a valid customer reference
    const custId = idGen.nextId();
    const custEventId = idGen.nextId();
    const custPush: SyncPushRequestDto = {
      clientVersion: '1.0.0',
      storeId: storeA1,
      deviceId: deviceA1,
      events: [
        {
          eventId: custEventId,
          organizationId: orgA,
          storeId: storeA1,
          deviceId: deviceA1,
          deviceSeq: '21',
          hlc: makeHlc(21, deviceA1),
          type: 'customers.created',
          entity: 'customers',
          entityId: custId,
          entityClass: 'ATTR',
          schemaVersion: 1,
          payload: makeCustomerPayload(custId, 'Mijoz Dilshod'),
        },
      ],
    };
    const custRes = await server.inject({
      method: 'POST',
      url: '/api/v1/sync/push',
      headers: { Authorization: `Bearer ${deviceTokenA1}` },
      payload: custPush,
    });
    expect(custRes.statusCode).toBe(200);
    expect(custRes.json<SyncPushResponseDto>().results[0].status).toBe('accepted');

    // 3. Device A1 pushes store-scoped events (stock_moves, sales) AND org-scoped event (customer_ledger)
    const moveId = idGen.nextId();
    const moveEventId = idGen.nextId();
    const saleId = idGen.nextId();
    const saleEventId = idGen.nextId();
    const ledgerId = idGen.nextId();
    const ledgerEventId = idGen.nextId();

    const batchPush: SyncPushRequestDto = {
      clientVersion: '1.0.0',
      storeId: storeA1,
      deviceId: deviceA1,
      events: [
        {
          eventId: moveEventId,
          organizationId: orgA,
          storeId: storeA1,
          deviceId: deviceA1,
          deviceSeq: '22',
          hlc: makeHlc(22, deviceA1),
          type: 'stock_moves.created',
          entity: 'stock_moves',
          entityId: moveId,
          entityClass: 'FACT',
          schemaVersion: 1,
          payload: makeStockMovePayload(moveId, prodId, '5000', '50000'),
        },
        {
          eventId: saleEventId,
          organizationId: orgA,
          storeId: storeA1,
          deviceId: deviceA1,
          deviceSeq: '23',
          hlc: makeHlc(23, deviceA1),
          type: 'sales.completed',
          entity: 'sales',
          entityId: saleId,
          entityClass: 'MONOTONE',
          schemaVersion: 1,
          payload: makeSalePayload(saleId, '101'),
        },
        {
          eventId: ledgerEventId,
          organizationId: orgA,
          storeId: storeA1,
          deviceId: deviceA1,
          deviceSeq: '24',
          hlc: makeHlc(24, deviceA1),
          type: 'customer_ledger.created',
          entity: 'customer_ledger',
          entityId: ledgerId,
          entityClass: 'FACT',
          schemaVersion: 1,
          payload: makeCustomerLedgerPayload(ledgerId, custId, '75000'),
        },
      ],
    };

    const batchRes = await server.inject({
      method: 'POST',
      url: '/api/v1/sync/push',
      headers: { Authorization: `Bearer ${deviceTokenA1}` },
      payload: batchPush,
    });
    expect(batchRes.statusCode).toBe(200);
    const batchResults = batchRes.json<SyncPushResponseDto>().results;
    expect(batchResults.map((r) => r.status)).toEqual(['accepted', 'accepted', 'accepted']);

    // 4. Device A2 (belonging to Store A2) pulls from cloud:
    // MUST receive customer_ledger (org-scoped).
    // MUST NOT receive stock_moves or sales from Store A1 (store-scoped isolation!).
    const pullResA2 = await server.inject({
      method: 'GET',
      url: '/api/v1/sync/pull?limit=200',
      headers: { Authorization: `Bearer ${deviceTokenA2}` },
    });
    expect(pullResA2.statusCode).toBe(200);
    const pullA2Data = pullResA2.json<SyncPullResponseDto>();

    // Assert customer_ledger is received by Store A2
    const pulledLedgerByA2 = pullA2Data.events.find((e) => e.entityId === ledgerId);
    expect(pulledLedgerByA2).toBeDefined();
    expect(pulledLedgerByA2?.entity).toBe('customer_ledger');

    // Assert store-scoped events from Store A1 are NOT received by Store A2
    const pulledMoveByA2 = pullA2Data.events.find((e) => e.entityId === moveId);
    expect(pulledMoveByA2).toBeUndefined();

    const pulledSaleByA2 = pullA2Data.events.find((e) => e.entityId === saleId);
    expect(pulledSaleByA2).toBeUndefined();

    // 5. Device A1 (belonging to Store A1) pulls from cloud:
    // MUST receive its own store-scoped events (stock_moves, sales) AND customer_ledger
    const pullResA1 = await server.inject({
      method: 'GET',
      url: '/api/v1/sync/pull?limit=200',
      headers: { Authorization: `Bearer ${deviceTokenA1}` },
    });
    expect(pullResA1.statusCode).toBe(200);
    const pullA1Data = pullResA1.json<SyncPullResponseDto>();

    expect(pullA1Data.events.some((e) => e.entityId === moveId)).toBe(true);
    expect(pullA1Data.events.some((e) => e.entityId === saleId)).toBe(true);
    expect(pullA1Data.events.some((e) => e.entityId === ledgerId)).toBe(true);
  });

  it('respects limit, hasMore, and cursor pagination across batches', async () => {
    // Seed 3 categories from Device A1
    const catEvents: SyncEventEnvelopeDto[] = [];
    for (let i = 1; i <= 3; i++) {
      const cId = idGen.nextId();
      const eId = idGen.nextId();
      catEvents.push({
        eventId: eId,
        organizationId: orgA,
        storeId: storeA1,
        deviceId: deviceA1,
        deviceSeq: String(10 + i),
        hlc: makeHlc(20 + i, deviceA1),
        type: 'categories.created',
        entity: 'categories',
        entityId: cId,
        entityClass: 'ATTR',
        schemaVersion: 1,
        payload: makeCategoryPayload(cId, `Pagination Cat ${i}`, i),
      });
    }

    const pushBatch = await server.inject({
      method: 'POST',
      url: '/api/v1/sync/push',
      headers: { Authorization: `Bearer ${deviceTokenA1}` },
      payload: {
        clientVersion: '1.0.0',
        storeId: storeA1,
        deviceId: deviceA1,
        events: catEvents,
      },
    });
    expect(pushBatch.statusCode).toBe(200);

    // Pull with limit = 2
    const pull1 = await server.inject({
      method: 'GET',
      url: '/api/v1/sync/pull?limit=2',
      headers: { Authorization: `Bearer ${deviceTokenA1}` },
    });
    expect(pull1.statusCode).toBe(200);
    const data1 = pull1.json<SyncPullResponseDto>();
    expect(data1.events.length).toBe(2);
    expect(data1.hasMore).toBe(true);

    // Query next batch using nextCursors
    const cursorPairs = Object.entries(data1.nextCursors).map(([sId, pos]) => `${sId}:${pos}`);
    const pull2 = await server.inject({
      method: 'GET',
      url: `/api/v1/sync/pull?cursors=${encodeURIComponent(cursorPairs.join(','))}&limit=100`,
      headers: { Authorization: `Bearer ${deviceTokenA1}` },
    });
    expect(pull2.statusCode).toBe(200);
    const data2 = pull2.json<SyncPullResponseDto>();
    expect(data2.events.length).toBeGreaterThanOrEqual(1);
    expect(data2.hasMore).toBe(false);
  });

  it('ORACLE-P1: events with inverted received_at_ms vs position arrive in monotonic position order without omission', async () => {
    const eventId1 = idGen.nextId();
    const eventId2 = idGen.nextId();
    const catId1 = idGen.nextId();
    const catId2 = idGen.nextId();

    // Directly insert 2 events into cloud_sync_events with inverted received_at_ms:
    // Event 1: position = 9001n, received_at_ms = 900
    // Event 2: position = 9002n, received_at_ms = 100
    await adminConn.pool.query(
      `INSERT INTO cloud_sync_events (
         id, organization_id, store_id, device_id, device_seq, hlc,
         type, entity, entity_id, class, schema_version, payload,
         position, received_at_ms, created_at_ms
       ) VALUES
       ($1, $2, $3, $4, 1, $5, 'categories.created', 'categories', $6, 'ATTR', 1, $7, 9001, 900, 900),
       ($8, $2, $3, $4, 2, $9, 'categories.created', 'categories', $10, 'ATTR', 1, $11, 9002, 100, 100)`,
      [
        eventId1,
        orgA,
        storeA1,
        deviceA1,
        makeHlc(1, deviceA1),
        catId1,
        JSON.stringify(makeCategoryPayload(catId1, 'Oracle Cat 1')),
        eventId2,
        makeHlc(2, deviceA1),
        catId2,
        JSON.stringify(makeCategoryPayload(catId2, 'Oracle Cat 2')),
      ],
    );

    // Pull 1: cursors at 9000, limit = 1
    const pull1 = await server.inject({
      method: 'GET',
      url: `/api/v1/sync/pull?cursors=${encodeURIComponent(`${storeA1}:9000`)}&limit=1`,
      headers: { Authorization: `Bearer ${deviceTokenA1}` },
    });
    expect(pull1.statusCode).toBe(200);
    const data1 = pull1.json<SyncPullResponseDto>();
    expect(data1.events.length).toBe(1);
    expect(data1.events[0].position).toBe('9001');
    expect(data1.hasMore).toBe(true);

    // Pull 2: using nextCursors from pull 1, limit = 1
    const cursorPairs = Object.entries(data1.nextCursors).map(([sId, pos]) => `${sId}:${pos}`);
    const pull2 = await server.inject({
      method: 'GET',
      url: `/api/v1/sync/pull?cursors=${encodeURIComponent(cursorPairs.join(','))}&limit=1`,
      headers: { Authorization: `Bearer ${deviceTokenA1}` },
    });
    expect(pull2.statusCode).toBe(200);
    const data2 = pull2.json<SyncPullResponseDto>();
    expect(data2.events.length).toBe(1);
    expect(data2.events[0].position).toBe('9002');
  });

  it('concurrent multi-writer (3 devices, 2 stores) + simultaneous paginated pull loop: 0 omissions, 0 duplicates', async () => {
    // 3 distinct devices across 2 dedicated stores to avoid position pollution from earlier tests:
    // Device Conc1 (Store Conc1), Device Conc2 (Store Conc2), Device Conc3 (Store Conc1)
    const storeConc1 = parseUuidV7(idGen.nextId());
    const storeConc2 = parseUuidV7(idGen.nextId());
    const devConc1 = parseUuidV7(idGen.nextId());
    const devConc2 = parseUuidV7(idGen.nextId());
    const devConc3 = parseUuidV7(idGen.nextId());

    await adminConn.pool.query(
      `INSERT INTO cloud_stores (id, organization_id, name, code, is_active, created_at_ms, updated_at_ms)
       VALUES ($1, $2, 'Concurrent Store 1', 'conc_1', true, $3, $3),
              ($4, $2, 'Concurrent Store 2', 'conc_2', true, $3, $3)`,
      [storeConc1, orgA, nowMs, storeConc2],
    );

    async function pairConcDevice(
      stId: typeof storeConc1,
      dId: typeof devConc1,
      dName: string,
    ): Promise<string> {
      const code = await deviceStore.createPairingCode({
        organizationId: orgA,
        storeId: stId,
        deviceName: dName,
        nowMs,
        idGen,
      });
      const pairRes = await server.inject({
        method: 'POST',
        url: '/api/v1/devices/pair',
        payload: {
          code: code.code,
          deviceId: dId,
          platform: 'windows',
          appVersion: '1.0.0',
        },
      });
      expect(pairRes.statusCode).toBe(201);
      return pairRes.json<CloudPairDeviceResponseDto>().deviceToken;
    }

    const tokenConc1 = await pairConcDevice(storeConc1, devConc1, 'POS Conc 1');
    const tokenConc2 = await pairConcDevice(storeConc2, devConc2, 'POS Conc 2');
    const tokenConc3 = await pairConcDevice(storeConc1, devConc3, 'POS Conc 3');

    const totalPushes = 5;
    const eventsPerPush = 3;
    const totalExpectedEvents = totalPushes * 3 * eventsPerPush; // 45 events total

    const acceptedEventIds = new Set<string>();

    async function pushBatchForDevice(
      devId: typeof devConc1,
      stId: typeof storeConc1,
      token: string,
    ) {
      let devSeq = 0;
      for (let p = 0; p < totalPushes; p++) {
        const events: SyncEventEnvelopeDto[] = [];
        for (let e = 0; e < eventsPerPush; e++) {
          devSeq++;
          const catId = parseUuidV7(idGen.nextId());
          const evtId = parseUuidV7(idGen.nextId());
          events.push({
            eventId: evtId,
            organizationId: orgA,
            storeId: stId,
            deviceId: devId,
            deviceSeq: String(devSeq),
            hlc: makeHlc(devSeq, devId),
            type: 'categories.created',
            entity: 'categories',
            entityId: catId,
            entityClass: 'ATTR',
            schemaVersion: 1,
            payload: makeCategoryPayload(catId, `Concurrent Cat ${devId.slice(-4)}-${devSeq}`),
          });
          acceptedEventIds.add(evtId);
        }

        const res = await server.inject({
          method: 'POST',
          url: '/api/v1/sync/push',
          headers: { Authorization: `Bearer ${token}` },
          payload: {
            clientVersion: '1.0.0',
            storeId: stId,
            deviceId: devId,
            events,
          },
        });
        expect(res.statusCode).toBe(200);
        await new Promise((resolve) => setTimeout(resolve, Math.floor(Math.random() * 5)));
      }
    }

    const pulledEvents: SyncPullResponseDto['events'] = [];
    const pulledEventIds = new Set<string>();
    let duplicateCount = 0;
    let pullsDone = false;

    async function pullWorkerLoop() {
      let cursors: Record<string, string> = { [storeConc1]: '0', [storeConc2]: '0' };
      while (!pullsDone) {
        const cursorStr = Object.entries(cursors)
          .map(([s, p]) => `${s}:${p}`)
          .join(',');
        const query = cursorStr ? `cursors=${encodeURIComponent(cursorStr)}&limit=3` : 'limit=3';
        const res = await server.inject({
          method: 'GET',
          url: `/api/v1/sync/pull?${query}`,
          headers: { Authorization: `Bearer ${tokenConc1}` },
        });
        if (res.statusCode === 200) {
          const body = res.json<SyncPullResponseDto>();
          for (const ev of body.events) {
            if (acceptedEventIds.has(ev.eventId)) {
              if (pulledEventIds.has(ev.eventId)) {
                duplicateCount++;
              } else {
                pulledEventIds.add(ev.eventId);
                pulledEvents.push(ev);
              }
            }
          }
          cursors = { ...cursors, ...body.nextCursors };
          if (!body.hasMore) {
            await new Promise((resolve) => setTimeout(resolve, 10));
          }
        }
      }

      // Final drain passes until hasMore is false
      let hasMore = true;
      while (hasMore) {
        const cursorStr = Object.entries(cursors)
          .map(([s, p]) => `${s}:${p}`)
          .join(',');
        const query = cursorStr
          ? `cursors=${encodeURIComponent(cursorStr)}&limit=100`
          : 'limit=100';
        const res = await server.inject({
          method: 'GET',
          url: `/api/v1/sync/pull?${query}`,
          headers: { Authorization: `Bearer ${tokenConc1}` },
        });
        const body = res.json<SyncPullResponseDto>();
        for (const ev of body.events) {
          if (acceptedEventIds.has(ev.eventId)) {
            if (pulledEventIds.has(ev.eventId)) {
              duplicateCount++;
            } else {
              pulledEventIds.add(ev.eventId);
              pulledEvents.push(ev);
            }
          }
        }
        cursors = { ...cursors, ...body.nextCursors };
        hasMore = body.hasMore;
      }
    }

    const pullPromise = pullWorkerLoop();
    await Promise.all([
      pushBatchForDevice(devConc1, storeConc1, tokenConc1),
      pushBatchForDevice(devConc2, storeConc2, tokenConc2),
      pushBatchForDevice(devConc3, storeConc1, tokenConc3),
    ]);
    pullsDone = true;
    await pullPromise;

    expect(pulledEvents.length).toBe(totalExpectedEvents);
    expect(duplicateCount).toBe(0);
    expect(pulledEventIds.size).toBe(totalExpectedEvents);

    // Verify monotonic position ordering per store
    const store1Events = pulledEvents.filter((e) => e.storeId === storeA1);
    const store2Events = pulledEvents.filter((e) => e.storeId === storeA2);
    for (let idx = 1; idx < store1Events.length; idx++) {
      expect(BigInt(store1Events[idx].position)).toBeGreaterThan(
        BigInt(store1Events[idx - 1].position),
      );
    }
    for (let idx = 1; idx < store2Events.length; idx++) {
      expect(BigInt(store2Events[idx].position)).toBeGreaterThan(
        BigInt(store2Events[idx - 1].position),
      );
    }
  });
});
