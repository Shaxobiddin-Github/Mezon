import type {
  CloudPairDeviceResponseDto,
  SyncEventEnvelopeDto,
  SyncPushRequestDto,
  SyncPushResponseDto,
} from '@mezon/contracts';
import {
  PG_APP_ROLE_NAME,
  CloudAuthStore,
  CloudDeviceStore,
  CloudSyncPushStore,
  CloudTenantStore,
  categories,
  cloudStoreSyncPositions,
  cloudSyncEvents,
  cloudSyncParked,
  createCloudPgPool,
  migrateCloudDatabase,
  shouldRunPgTests,
  users,
  organizationTaxProfiles,
} from '@mezon/db-cloud';
import { parseUuidV7, serializeHlc, unixMsFromBigInt } from '@mezon/domain';
import { DeterministicUuidV7Generator } from '@mezon/test-utils';
import * as argon2 from '@node-rs/argon2';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { provisionAppRole } from '../../../packages/db-cloud/ops/provision-app-role.mjs';
import { loadCloudConfig } from './config.js';
import { CloudJwtService } from './jwt.js';
import { buildCloudServer } from './server.js';

const describePg = shouldRunPgTests() ? describe : describe.skip;

describePg('@mezon/cloud - Sync Push Engine (T2.3 & P1-P5)', () => {
  let container: StartedPostgreSqlContainer;
  let adminConn: ReturnType<typeof createCloudPgPool>;
  let appConn: ReturnType<typeof createCloudPgPool>;
  let server: FastifyInstance;
  let syncPushStore: CloudSyncPushStore;
  let tenantStore: CloudTenantStore;
  let deviceStore: CloudDeviceStore;
  let idGen: DeterministicUuidV7Generator;

  const orgA = parseUuidV7('018bcfe5-6800-7000-8000-000000000001');
  const orgB = parseUuidV7('018bcfe5-6800-7000-8000-000000000002');
  const storeA = parseUuidV7('018bcfe5-6800-7000-8000-000000000011');
  const storeB = parseUuidV7('018bcfe5-6800-7000-8000-000000000022');
  const deviceA = parseUuidV7('018bcfe5-6800-7000-8000-000000000111');
  const deviceB = parseUuidV7('018bcfe5-6800-7000-8000-000000000222');
  const ownerA = parseUuidV7('018bcfe5-6800-7000-8000-000000000055');
  const ownerB = parseUuidV7('018bcfe5-6800-7000-8000-000000000066');

  const nowMs = unixMsFromBigInt(1_700_000_000_000n);

  let deviceTokenA: string;
  let deviceTokenB: string;

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

    const pwHash = await argon2.hash('TestPassword123!');

    // Create Org A
    await tenantStore.createOrganizationWithStoreAndOwner({
      organizationId: orgA,
      storeId: storeA,
      ownerUserId: ownerA,
      loginIdentityId: idGen.nextId(),
      organizationName: 'Guzar Kattaqo‘rg‘on Org A',
      storeName: 'Do‘kon A',
      storeCode: 'store_a',
      ownerUsername: 'owner_a',
      ownerLogin: 'owner_a@guzar.uz',
      passwordHash: pwHash,
      nowMs,
    });

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
      nodeId: deviceA,
    });

    // Seed ownerA into domain users table so foreign keys resolve
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
      idGen,
      clock: { nowMs: () => nowMs },
    });

    await server.ready();

    // Pair Device A under Org A / Store A
    const codeA = await deviceStore.createPairingCode({
      organizationId: orgA,
      storeId: storeA,
      deviceName: 'POS A',
      nowMs,
      idGen,
    });

    const pairResA = await server.inject({
      method: 'POST',
      url: '/api/v1/devices/pair',
      payload: {
        code: codeA.code,
        deviceId: deviceA,
        platform: 'windows',
        appVersion: '1.0.0',
      },
    });
    expect(pairResA.statusCode).toBe(201);
    deviceTokenA = pairResA.json<CloudPairDeviceResponseDto>().deviceToken;

    // Pair Device B under Org B / Store B
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
  }, 60_000);

  afterAll(async () => {
    if (server) await server.close();
    if (appConn) await appConn.close();
    if (adminConn) await adminConn.close();
    if (container) await container.stop();
  });

  function makeCategoryPayload(catId: string, name: string, sortOrder = 0) {
    return {
      id: catId,
      organizationId: orgA,
      name,
      nameSearch: name.toLowerCase(),
      parentId: null,
      sortOrder,
      deviceId: deviceA,
      hlc: '001700000000000:00000:018bcfe5-6800-7000-8000-000000000111',
      createdAtMs: '1700000000000',
      updatedAtMs: '1700000000000',
      deletedAtMs: null,
    };
  }

  function makeProductPayload(prodId: string, categoryId: string | null, name: string) {
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
      deviceId: deviceA,
      hlc: '001700000000000:00000:018bcfe5-6800-7000-8000-000000000111',
      createdAtMs: '1700000000000',
      updatedAtMs: '1700000000000',
      deletedAtMs: null,
    };
  }

  // --------------------------------------------------------------------------
  // Test 1 (P1 Savepoint Proof):
  // 11 events in a batch, event 6 violates SQL constraint (sortOrder < 0).
  // -> Events 1..5 accepted with positions 1..5.
  // -> Event 6 rejected with SQL_ERROR.
  // -> Events 7..11 accepted with positions 6..10.
  // -> Positions 1..10 are strictly contiguous and gapless!
  // --------------------------------------------------------------------------
  it('P1: wraps each event in a SAVEPOINT so SQL constraint failure isolates cleanly and positions remain gapless 1..10', async () => {
    const events: SyncEventEnvelopeDto[] = [];

    for (let i = 1; i <= 11; i++) {
      const eventId = idGen.nextId();
      const catId = idGen.nextId();
      // Event 6 has whitespace name which passes Zod min(1) but violates chk_categories_name_nonempty in database
      const name = i === 6 ? '   ' : `Category ${i}`;

      events.push({
        eventId,
        organizationId: orgA,
        storeId: storeA,
        deviceId: deviceA,
        deviceSeq: String(i),
        hlc: `001700000000000:${String(i).padStart(5, '0')}:018bcfe5-6800-7000-8000-000000000111`,
        type: 'categories.created',
        entity: 'categories',
        entityId: catId,
        entityClass: 'ATTR',
        schemaVersion: 1,
        payload: makeCategoryPayload(catId, name, i),
      });
    }

    const pushRes = await server.inject({
      method: 'POST',
      url: '/api/v1/sync/push',
      headers: {
        authorization: `Bearer ${deviceTokenA}`,
      },
      payload: {
        clientVersion: '1.0.0',
        storeId: storeA,
        deviceId: deviceA,
        events,
      } satisfies SyncPushRequestDto,
    });

    expect(pushRes.statusCode).toBe(200);
    const body = pushRes.json<SyncPushResponseDto>();
    expect(body.results).toHaveLength(11);

    // Verify 1..5 accepted with positions 1..5
    for (let i = 0; i < 5; i++) {
      expect(body.results[i].status).toBe('accepted');
      expect(body.results[i].position).toBe(String(i + 1));
    }

    // Verify 6 rejected due to SQL constraint
    expect(body.results[5].status).toBe('rejected');
    expect(body.results[5].reason).toBe('SQL_ERROR');

    // Verify 7..11 accepted with contiguous positions 6..10 (no gap from event 6!)
    for (let i = 6; i < 11; i++) {
      expect(body.results[i].status).toBe('accepted');
      expect(body.results[i].position).toBe(String(i)); // 6th accepted event gets position 6
    }

    // Verify store sync position record in database is exactly 10
    const [posRow] = await adminConn.db
      .select()
      .from(cloudStoreSyncPositions)
      .where(
        and(
          eq(cloudStoreSyncPositions.organizationId, orgA),
          eq(cloudStoreSyncPositions.storeId, storeA),
        ),
      );
    expect(posRow.lastPosition).toBe(10n);
  });

  // --------------------------------------------------------------------------
  // Test 2: Foreign storeId mismatch -> rejected (STORE_MISMATCH)
  // --------------------------------------------------------------------------
  it('rejects event with STORE_MISMATCH when storeId does not match authenticated device', async () => {
    const eventId = idGen.nextId();
    const catId = idGen.nextId();

    const pushRes = await server.inject({
      method: 'POST',
      url: '/api/v1/sync/push',
      headers: { authorization: `Bearer ${deviceTokenA}` },
      payload: {
        clientVersion: '1.0.0',
        storeId: storeA,
        deviceId: deviceA,
        events: [
          {
            eventId,
            organizationId: orgA,
            storeId: storeB, // Mismatched storeId!
            deviceId: deviceA,
            deviceSeq: '100',
            hlc: '001700000000000:00000:018bcfe5-6800-7000-8000-000000000111',
            type: 'categories.created',
            entity: 'categories',
            entityId: catId,
            entityClass: 'ATTR',
            schemaVersion: 1,
            payload: makeCategoryPayload(catId, 'Mismatched Category'),
          },
        ],
      },
    });

    expect(pushRes.statusCode).toBe(200);
    const body = pushRes.json<SyncPushResponseDto>();
    expect(body.results[0].status).toBe('rejected');
    expect(body.results[0].reason).toBe('STORE_MISMATCH');
  });

  // --------------------------------------------------------------------------
  // Test 3: Cross-tenant foreign reference -> rejected (FOREIGN_ENTITY_MISMATCH)
  // --------------------------------------------------------------------------
  it('P2: rejects cross-tenant foreign reference permanently with FOREIGN_ENTITY_MISMATCH', async () => {
    // 1. Create a category under Org B
    const catBId = idGen.nextId();
    const catBEventId = idGen.nextId();

    const pushB = await server.inject({
      method: 'POST',
      url: '/api/v1/sync/push',
      headers: { authorization: `Bearer ${deviceTokenB}` },
      payload: {
        clientVersion: '1.0.0',
        storeId: storeB,
        deviceId: deviceB,
        events: [
          {
            eventId: catBEventId,
            organizationId: orgB,
            storeId: storeB,
            deviceId: deviceB,
            deviceSeq: '1',
            hlc: '001700000000000:00000:018bcfe5-6800-7000-8000-000000000222',
            type: 'categories.created',
            entity: 'categories',
            entityId: catBId,
            entityClass: 'ATTR',
            schemaVersion: 1,
            payload: {
              id: catBId,
              organizationId: orgB,
              name: 'Org B Category',
              nameSearch: 'org b category',
              parentId: null,
              sortOrder: 0,
              deviceId: deviceB,
              hlc: '001700000000000:00000:018bcfe5-6800-7000-8000-000000000222',
              createdAtMs: '1700000000000',
              updatedAtMs: '1700000000000',
              deletedAtMs: null,
            },
          },
        ],
      },
    });
    expect(pushB.json<SyncPushResponseDto>().results[0].status).toBe('accepted');

    // 2. Try to push a product under Org A that references catBId (which belongs to Org B!)
    const prodEventId = idGen.nextId();
    const prodId = idGen.nextId();

    const pushA = await server.inject({
      method: 'POST',
      url: '/api/v1/sync/push',
      headers: { authorization: `Bearer ${deviceTokenA}` },
      payload: {
        clientVersion: '1.0.0',
        storeId: storeA,
        deviceId: deviceA,
        events: [
          {
            eventId: prodEventId,
            organizationId: orgA,
            storeId: storeA,
            deviceId: deviceA,
            deviceSeq: '200',
            hlc: '001700000000000:00000:018bcfe5-6800-7000-8000-000000000111',
            type: 'products.created',
            entity: 'products',
            entityId: prodId,
            entityClass: 'ATTR',
            schemaVersion: 1,
            payload: makeProductPayload(prodId, catBId, 'Illegal Product'),
          },
        ],
      },
    });

    const bodyA = pushA.json<SyncPushResponseDto>();
    expect(bodyA.results[0].status).toBe('rejected');
    expect(bodyA.results[0].reason).toBe('FOREIGN_ENTITY_MISMATCH');
  });

  // --------------------------------------------------------------------------
  // Test 4: Concurrent push race (2 parallel requests pushing same store)
  // --------------------------------------------------------------------------
  it('handles concurrent push race safely via advisory lock without gap in positions or duplicate collision', async () => {
    const cat1Id = idGen.nextId();
    const cat1EventId = idGen.nextId();
    const cat2Id = idGen.nextId();
    const cat2EventId = idGen.nextId();

    const req1 = server.inject({
      method: 'POST',
      url: '/api/v1/sync/push',
      headers: { authorization: `Bearer ${deviceTokenA}` },
      payload: {
        clientVersion: '1.0.0',
        storeId: storeA,
        deviceId: deviceA,
        events: [
          {
            eventId: cat1EventId,
            organizationId: orgA,
            storeId: storeA,
            deviceId: deviceA,
            deviceSeq: '301',
            hlc: '001700000000000:00001:018bcfe5-6800-7000-8000-000000000111',
            type: 'categories.created',
            entity: 'categories',
            entityId: cat1Id,
            entityClass: 'ATTR',
            schemaVersion: 1,
            payload: makeCategoryPayload(cat1Id, 'Concurrent Cat 1'),
          },
        ],
      },
    });

    const req2 = server.inject({
      method: 'POST',
      url: '/api/v1/sync/push',
      headers: { authorization: `Bearer ${deviceTokenA}` },
      payload: {
        clientVersion: '1.0.0',
        storeId: storeA,
        deviceId: deviceA,
        events: [
          {
            eventId: cat2EventId,
            organizationId: orgA,
            storeId: storeA,
            deviceId: deviceA,
            deviceSeq: '302',
            hlc: '001700000000000:00002:018bcfe5-6800-7000-8000-000000000111',
            type: 'categories.created',
            entity: 'categories',
            entityId: cat2Id,
            entityClass: 'ATTR',
            schemaVersion: 1,
            payload: makeCategoryPayload(cat2Id, 'Concurrent Cat 2'),
          },
        ],
      },
    });

    const [res1, res2] = await Promise.all([req1, req2]);
    expect(res1.statusCode).toBe(200);
    expect(res2.statusCode).toBe(200);

    const b1 = res1.json<SyncPushResponseDto>();
    const b2 = res2.json<SyncPushResponseDto>();

    expect(b1.results[0].status).toBe('accepted');
    expect(b2.results[0].status).toBe('accepted');

    const p1 = BigInt(b1.results[0].position!);
    const p2 = BigInt(b2.results[0].position!);

    // Positions must be adjacent (diff = 1)
    const diff = p1 > p2 ? p1 - p2 : p2 - p1;
    expect(diff).toBe(1n);
  });

  // --------------------------------------------------------------------------
  // Test 5 (P2 Dependency parking):
  // Child product pushed before parent category -> retry, parked in cloud_sync_parked.
  // Parent category pushed -> accepted.
  // Child product retried -> accepted.
  // --------------------------------------------------------------------------
  it('P2: parks child event in cloud_sync_parked when parent dependency missing; accepts upon retry after parent arrives', async () => {
    const parentCatId = idGen.nextId();
    const childProdId = idGen.nextId();
    const childEventId = idGen.nextId();

    // 1. Push child product before parent category exists
    const pushChild1 = await server.inject({
      method: 'POST',
      url: '/api/v1/sync/push',
      headers: { authorization: `Bearer ${deviceTokenA}` },
      payload: {
        clientVersion: '1.0.0',
        storeId: storeA,
        deviceId: deviceA,
        events: [
          {
            eventId: childEventId,
            organizationId: orgA,
            storeId: storeA,
            deviceId: deviceA,
            deviceSeq: '401',
            hlc: '001700000000000:00000:018bcfe5-6800-7000-8000-000000000111',
            type: 'products.created',
            entity: 'products',
            entityId: childProdId,
            entityClass: 'ATTR',
            schemaVersion: 1,
            payload: makeProductPayload(childProdId, parentCatId, 'Child Product'),
          },
        ],
      },
    });

    const bodyChild1 = pushChild1.json<SyncPushResponseDto>();
    expect(bodyChild1.results[0].status).toBe('retry');
    expect(bodyChild1.results[0].reason).toBe('DEPENDENCY_MISSING');

    // Verify parked row in cloud_sync_parked
    const parkedRows = await adminConn.db
      .select()
      .from(cloudSyncParked)
      .where(
        and(eq(cloudSyncParked.organizationId, orgA), eq(cloudSyncParked.eventId, childEventId)),
      );
    expect(parkedRows).toHaveLength(1);
    expect(parkedRows[0].missingRefEntity).toBe('categories');
    expect(parkedRows[0].missingRefId).toBe(parentCatId);
    expect(parkedRows[0].status).toBe('parked');

    // 2. Now push the parent category
    const parentEventId = idGen.nextId();
    const pushParent = await server.inject({
      method: 'POST',
      url: '/api/v1/sync/push',
      headers: { authorization: `Bearer ${deviceTokenA}` },
      payload: {
        clientVersion: '1.0.0',
        storeId: storeA,
        deviceId: deviceA,
        events: [
          {
            eventId: parentEventId,
            organizationId: orgA,
            storeId: storeA,
            deviceId: deviceA,
            deviceSeq: '402',
            hlc: '001700000000000:00001:018bcfe5-6800-7000-8000-000000000111',
            type: 'categories.created',
            entity: 'categories',
            entityId: parentCatId,
            entityClass: 'ATTR',
            schemaVersion: 1,
            payload: makeCategoryPayload(parentCatId, 'Parent Category'),
          },
        ],
      },
    });
    expect(pushParent.json<SyncPushResponseDto>().results[0].status).toBe('accepted');

    // 3. Retry pushing child product -> now accepted!
    const pushChild2 = await server.inject({
      method: 'POST',
      url: '/api/v1/sync/push',
      headers: { authorization: `Bearer ${deviceTokenA}` },
      payload: {
        clientVersion: '1.0.0',
        storeId: storeA,
        deviceId: deviceA,
        events: [
          {
            eventId: childEventId,
            organizationId: orgA,
            storeId: storeA,
            deviceId: deviceA,
            deviceSeq: '401',
            hlc: '001700000000000:00000:018bcfe5-6800-7000-8000-000000000111',
            type: 'products.created',
            entity: 'products',
            entityId: childProdId,
            entityClass: 'ATTR',
            schemaVersion: 1,
            payload: makeProductPayload(childProdId, parentCatId, 'Child Product'),
          },
        ],
      },
    });

    const bodyChild2 = pushChild2.json<SyncPushResponseDto>();
    expect(bodyChild2.results[0].status).toBe('accepted');

    // R5: Verify parked row in cloud_sync_parked is deleted upon accepted
    const parkedAfterAccepted = await adminConn.db
      .select()
      .from(cloudSyncParked)
      .where(
        and(eq(cloudSyncParked.organizationId, orgA), eq(cloudSyncParked.eventId, childEventId)),
      );
    expect(parkedAfterAccepted).toHaveLength(0);
  });

  // --------------------------------------------------------------------------
  // Test 6 (P3 MONOTONE):
  // Allowed transition -> accepted.
  // Re-application -> duplicate.
  // Illegal transition -> rejected (INVALID_MONOTONE_TRANSITION).
  // --------------------------------------------------------------------------
  it('P3: enforces MONOTONE state transitions: allowed accepted, re-application duplicate, illegal rejected', async () => {
    const orderId = idGen.nextId();
    const event1Id = idGen.nextId();
    const event2Id = idGen.nextId();
    const event3Id = idGen.nextId();

    const baseOrderPayload = {
      id: orderId,
      organizationId: orgA,
      storeId: storeA,
      originDeviceId: deviceA,
      orderNo: '101',
      orderCode: 'ORD-101',
      status: 'draft',
      customerId: null,
      customerName: 'Alisher Navoiy',
      customerPhoneNormalized: null,
      dueAtMs: null,
      note: null,
      subtotalGross: '50000',
      totalPromoDiscount: '0',
      subtotalAfterPromo: '50000',
      manualDiscountMode: 'none',
      manualDiscountValue: '0',
      manualDiscountReason: null,
      orderDiscountAmount: '0',
      totalAmount: '50000',
      totalNetExVat: '44643',
      totalVat: '5357',
      overrideApprovedByUserId: null,
      overrideApprovedAmount: null,
      createdByUserId: ownerA,
      confirmedAtMs: null,
      readyAtMs: null,
      deliveredAtMs: null,
      deliveredSaleId: null,
      cancelledAtMs: null,
      cancelledByUserId: null,
      cancelReason: null,
      createClientRequestId: idGen.nextId(),
      createRequestHash: 'hash123456',
      deviceId: deviceA,
      hlc: '001700000000000:00000:018bcfe5-6800-7000-8000-000000000111',
      createdAtMs: '1700000000000',
      updatedAtMs: '1700000000000',
    };

    // 1. Initial creation (status: draft) -> accepted
    const res1 = await server.inject({
      method: 'POST',
      url: '/api/v1/sync/push',
      headers: { authorization: `Bearer ${deviceTokenA}` },
      payload: {
        clientVersion: '1.0.0',
        storeId: storeA,
        deviceId: deviceA,
        events: [
          {
            eventId: event1Id,
            organizationId: orgA,
            storeId: storeA,
            deviceId: deviceA,
            deviceSeq: '501',
            hlc: '001700000000000:00000:018bcfe5-6800-7000-8000-000000000111',
            type: 'orders.created',
            entity: 'orders',
            entityId: orderId,
            entityClass: 'MONOTONE',
            schemaVersion: 1,
            payload: baseOrderPayload,
          },
        ],
      },
    });
    expect(res1.json<SyncPushResponseDto>().results[0].status).toBe('accepted');

    // 2. Allowed transition (draft -> confirmed) -> accepted
    const confirmedPayload = {
      ...baseOrderPayload,
      status: 'confirmed',
      confirmedAtMs: '1700000001000',
      hlc: '001700000000000:00001:018bcfe5-6800-7000-8000-000000000111',
    };

    const res2 = await server.inject({
      method: 'POST',
      url: '/api/v1/sync/push',
      headers: { authorization: `Bearer ${deviceTokenA}` },
      payload: {
        clientVersion: '1.0.0',
        storeId: storeA,
        deviceId: deviceA,
        events: [
          {
            eventId: event2Id,
            organizationId: orgA,
            storeId: storeA,
            deviceId: deviceA,
            deviceSeq: '502',
            hlc: '001700000000000:00001:018bcfe5-6800-7000-8000-000000000111',
            type: 'orders.status_changed',
            entity: 'orders',
            entityId: orderId,
            entityClass: 'MONOTONE',
            schemaVersion: 1,
            payload: confirmedPayload,
          },
        ],
      },
    });
    expect(res2.json<SyncPushResponseDto>().results[0].status).toBe('accepted');

    // 3. Re-application of same confirmed state -> duplicate
    const reapplyEventId = idGen.nextId();
    const resReapply = await server.inject({
      method: 'POST',
      url: '/api/v1/sync/push',
      headers: { authorization: `Bearer ${deviceTokenA}` },
      payload: {
        clientVersion: '1.0.0',
        storeId: storeA,
        deviceId: deviceA,
        events: [
          {
            eventId: reapplyEventId,
            organizationId: orgA,
            storeId: storeA,
            deviceId: deviceA,
            deviceSeq: '503',
            hlc: '001700000000000:00002:018bcfe5-6800-7000-8000-000000000111',
            type: 'orders.status_changed',
            entity: 'orders',
            entityId: orderId,
            entityClass: 'MONOTONE',
            schemaVersion: 1,
            payload: confirmedPayload,
          },
        ],
      },
    });
    expect(resReapply.json<SyncPushResponseDto>().results[0].status).toBe('duplicate');

    // 4. Illegal reverse transition (confirmed -> draft) -> rejected (INVALID_MONOTONE_TRANSITION)
    const res3 = await server.inject({
      method: 'POST',
      url: '/api/v1/sync/push',
      headers: { authorization: `Bearer ${deviceTokenA}` },
      payload: {
        clientVersion: '1.0.0',
        storeId: storeA,
        deviceId: deviceA,
        events: [
          {
            eventId: event3Id,
            organizationId: orgA,
            storeId: storeA,
            deviceId: deviceA,
            deviceSeq: '504',
            hlc: '001700000000000:00003:018bcfe5-6800-7000-8000-000000000111',
            type: 'orders.status_changed',
            entity: 'orders',
            entityId: orderId,
            entityClass: 'MONOTONE',
            schemaVersion: 1,
            payload: {
              ...baseOrderPayload,
              status: 'draft',
              hlc: '001700000000000:00003:018bcfe5-6800-7000-8000-000000000111',
            },
          },
        ],
      },
    });
    const body3 = res3.json<SyncPushResponseDto>();
    expect(body3.results[0].status).toBe('rejected');
    expect(body3.results[0].reason).toBe('INVALID_MONOTONE_TRANSITION');

    // 5. R2: Mutation of immutable field (e.g. totalAmount on confirmed order) -> rejected (IMMUTABLE_FIELD_CHANGED)
    const mutateImmutableEventId = idGen.nextId();
    const resMutate = await server.inject({
      method: 'POST',
      url: '/api/v1/sync/push',
      headers: { authorization: `Bearer ${deviceTokenA}` },
      payload: {
        clientVersion: '1.0.0',
        storeId: storeA,
        deviceId: deviceA,
        events: [
          {
            eventId: mutateImmutableEventId,
            organizationId: orgA,
            storeId: storeA,
            deviceId: deviceA,
            deviceSeq: '505',
            hlc: '001700000000000:00004:018bcfe5-6800-7000-8000-000000000111',
            type: 'orders.status_changed',
            entity: 'orders',
            entityId: orderId,
            entityClass: 'MONOTONE',
            schemaVersion: 1,
            payload: {
              ...confirmedPayload,
              totalAmount: '999999', // MUTATING IMMUTABLE FIELD!
              hlc: '001700000000000:00004:018bcfe5-6800-7000-8000-000000000111',
            },
          },
        ],
      },
    });
    const bodyMutate = resMutate.json<SyncPushResponseDto>();
    expect(bodyMutate.results[0].status).toBe('rejected');
    expect(bodyMutate.results[0].reason).toBe('IMMUTABLE_FIELD_CHANGED');
  });

  // --------------------------------------------------------------------------
  // Test 7 (P4 Strict Payload):
  // Extra fields like pin_hash on users -> rejected (VALIDATION_ERROR)
  // --------------------------------------------------------------------------
  it('P4: strictly validates entity payload and rejects extra unexpected fields (e.g. pin_hash)', async () => {
    const userId = idGen.nextId();
    const eventId = idGen.nextId();

    const pushRes = await server.inject({
      method: 'POST',
      url: '/api/v1/sync/push',
      headers: { authorization: `Bearer ${deviceTokenA}` },
      payload: {
        clientVersion: '1.0.0',
        storeId: storeA,
        deviceId: deviceA,
        events: [
          {
            eventId,
            organizationId: orgA,
            storeId: storeA,
            deviceId: deviceA,
            deviceSeq: '601',
            hlc: '001700000000000:00000:018bcfe5-6800-7000-8000-000000000111',
            type: 'users.created',
            entity: 'users',
            entityId: userId,
            entityClass: 'ATTR',
            schemaVersion: 1,
            payload: {
              id: userId,
              organizationId: orgA,
              username: 'cashier_test',
              fullName: 'Test Cashier',
              role: 'cashier',
              isActive: true,
              pin_hash: 'leak_secret_pin_hash_attempt', // FORBIDDEN EXTRA FIELD!
              deviceId: deviceA,
              hlc: '001700000000000:00000:018bcfe5-6800-7000-8000-000000000111',
              createdAtMs: '1700000000000',
              updatedAtMs: '1700000000000',
              deletedAtMs: null,
            },
          },
        ],
      },
    });

    const body = pushRes.json<SyncPushResponseDto>();
    expect(body.results[0].status).toBe('rejected');
    expect(body.results[0].reason).toBe('VALIDATION_ERROR');
    expect(body.results[0].error).toContain('pin_hash');
  });

  // --------------------------------------------------------------------------
  // Test 8: HLC Skew > 5 min -> Clamped and hlcAdjusted = true recorded
  // --------------------------------------------------------------------------
  it('clamps HLC exceeding 5-min skew threshold and records hlcAdjusted = true', async () => {
    const catId = idGen.nextId();
    const eventId = idGen.nextId();

    // Timestamp 10 minutes in the future (> 5 min MAX_SKEW_MS)
    const futureMs = BigInt(nowMs) + 600_000n;
    const futureHlc = serializeHlc({
      physicalMs: unixMsFromBigInt(futureMs),
      logical: 0,
      nodeId: deviceA,
    });

    const pushRes = await server.inject({
      method: 'POST',
      url: '/api/v1/sync/push',
      headers: { authorization: `Bearer ${deviceTokenA}` },
      payload: {
        clientVersion: '1.0.0',
        storeId: storeA,
        deviceId: deviceA,
        events: [
          {
            eventId,
            organizationId: orgA,
            storeId: storeA,
            deviceId: deviceA,
            deviceSeq: '701',
            hlc: futureHlc,
            type: 'categories.created',
            entity: 'categories',
            entityId: catId,
            entityClass: 'ATTR',
            schemaVersion: 1,
            payload: {
              ...makeCategoryPayload(catId, 'Skewed HLC Cat'),
              hlc: futureHlc,
            },
          },
        ],
      },
    });

    const body = pushRes.json<SyncPushResponseDto>();
    expect(body.results[0].status).toBe('accepted');

    // Query recorded sync event from database
    const [eventRow] = await adminConn.db
      .select()
      .from(cloudSyncEvents)
      .where(and(eq(cloudSyncEvents.organizationId, orgA), eq(cloudSyncEvents.id, eventId)));

    expect(eventRow.hlcAdjusted).toBe(true);
    // Effective HLC must be clamped to nowMs physical timestamp
    expect(eventRow.hlc.startsWith(`00${nowMs}`)).toBe(true);

    // R4: Assert domain table row itself also received the clamped HLC, not raw futureHlc
    const [catRow] = await adminConn.db
      .select()
      .from(categories)
      .where(and(eq(categories.organizationId, orgA), eq(categories.id, catId)));
    expect(catRow.hlc).toBe(eventRow.hlc);
    expect(catRow.hlc).not.toBe(futureHlc);
  });

  // --------------------------------------------------------------------------
  // Test 9: Client version < MIN_CLIENT_VERSION -> HTTP 426 Upgrade Required
  // --------------------------------------------------------------------------
  it('returns HTTP 426 Upgrade Required when clientVersion is below MIN_CLIENT_VERSION', async () => {
    const pushRes = await server.inject({
      method: 'POST',
      url: '/api/v1/sync/push',
      headers: { authorization: `Bearer ${deviceTokenA}` },
      payload: {
        clientVersion: '0.9.0', // Older than MIN_CLIENT_VERSION '1.0.0'
        storeId: storeA,
        deviceId: deviceA,
        events: [],
      },
    });

    expect(pushRes.statusCode).toBe(426);
    const body = pushRes.json<{ error: string; code: string }>();
    expect(body.error).toBe('Upgrade Required');
    expect(body.code).toBe('CLIENT_VERSION_UNSUPPORTED');
  });

  // --------------------------------------------------------------------------
  // Test 10: Throughput Benchmark
  // Process 50 events in a single batch and measure events / second
  // --------------------------------------------------------------------------
  it('measures push processing throughput (asserts > 100 events / sec)', async () => {
    const BATCH_SIZE = 50;

    const runBatch = async (offsetSeq: number, label: string) => {
      const batchEvents: SyncEventEnvelopeDto[] = [];
      for (let i = 1; i <= BATCH_SIZE; i++) {
        const eventId = idGen.nextId();
        const catId = idGen.nextId();
        batchEvents.push({
          eventId,
          organizationId: orgA,
          storeId: storeA,
          deviceId: deviceA,
          deviceSeq: String(offsetSeq + i),
          hlc: `001700000000000:${String(offsetSeq + i).padStart(5, '0')}:018bcfe5-6800-7000-8000-000000000111`,
          type: 'categories.created',
          entity: 'categories',
          entityId: catId,
          entityClass: 'ATTR',
          schemaVersion: 1,
          payload: makeCategoryPayload(catId, `${label} Cat ${i}`, i),
        });
      }

      const start = performance.now();
      const pushRes = await server.inject({
        method: 'POST',
        url: '/api/v1/sync/push',
        headers: { authorization: `Bearer ${deviceTokenA}` },
        payload: {
          clientVersion: '1.0.0',
          storeId: storeA,
          deviceId: deviceA,
          events: batchEvents,
        },
      });
      const elapsedMs = performance.now() - start;
      expect(pushRes.statusCode).toBe(200);
      const body = pushRes.json<SyncPushResponseDto>();
      expect(body.results).toHaveLength(BATCH_SIZE);
      expect(body.results.every((r) => r.status === 'accepted')).toBe(true);
      return (BATCH_SIZE / elapsedMs) * 1000;
    };

    const throughput1 = await runBatch(1000, 'Batch 1');
    const throughput2 = await runBatch(2000, 'Batch 2');
    const throughput3 = await runBatch(3000, 'Batch 3');
    const bestThroughput = Math.max(throughput1, throughput2, throughput3);

    console.log(
      `Sync Push Throughput Benchmark: ${BATCH_SIZE} events best throughput: ~${bestThroughput.toFixed(0)} events/sec (run1: ~${throughput1.toFixed(0)}, run2: ~${throughput2.toFixed(0)}, run3: ~${throughput3.toFixed(0)})`,
    );
    expect(bestThroughput).toBeGreaterThan(100);
  });

  // --------------------------------------------------------------------------
  // Test 11 (R1 Envelope vs Payload ID Mismatch):
  // --------------------------------------------------------------------------
  it('R1: rejects events where envelope entityId does not match payload id (ENVELOPE_PAYLOAD_MISMATCH)', async () => {
    const eventId = idGen.nextId();
    const catId1 = idGen.nextId();
    const catId2 = idGen.nextId();

    const pushRes = await server.inject({
      method: 'POST',
      url: '/api/v1/sync/push',
      headers: { authorization: `Bearer ${deviceTokenA}` },
      payload: {
        clientVersion: '1.0.0',
        storeId: storeA,
        deviceId: deviceA,
        events: [
          {
            eventId,
            organizationId: orgA,
            storeId: storeA,
            deviceId: deviceA,
            deviceSeq: '1101',
            hlc: '001700000000000:00000:018bcfe5-6800-7000-8000-000000000111',
            type: 'categories.created',
            entity: 'categories',
            entityId: catId1, // Mismatched envelope entityId!
            entityClass: 'ATTR',
            schemaVersion: 1,
            payload: makeCategoryPayload(catId2, 'Mismatched Envelope Cat'), // payload.id is catId2
          },
        ],
      },
    });

    const body = pushRes.json<SyncPushResponseDto>();
    expect(body.results[0].status).toBe('rejected');
    expect(body.results[0].reason).toBe('ENVELOPE_PAYLOAD_MISMATCH');
  });

  // --------------------------------------------------------------------------
  // Test 12 (R1 Store Mismatch for store-scoped table):
  // --------------------------------------------------------------------------
  it('R1: rejects events where store-scoped payload storeId does not match device store context (STORE_MISMATCH)', async () => {
    const eventId = idGen.nextId();
    const orderId = idGen.nextId();

    const orderPayload = {
      id: orderId,
      organizationId: orgA,
      storeId: storeB, // Illegal store context: storeB when authenticated for storeA!
      originDeviceId: deviceA,
      orderNo: '101',
      orderCode: 'ORD-101',
      status: 'draft',
      customerId: null,
      customerName: 'Alisher Navoiy',
      customerPhoneNormalized: null,
      dueAtMs: null,
      note: null,
      subtotalGross: '50000',
      totalPromoDiscount: '0',
      subtotalAfterPromo: '50000',
      manualDiscountMode: 'none',
      manualDiscountValue: '0',
      manualDiscountReason: null,
      orderDiscountAmount: '0',
      totalAmount: '50000',
      totalNetExVat: '44643',
      totalVat: '5357',
      overrideApprovedByUserId: null,
      overrideApprovedAmount: null,
      createdByUserId: ownerA,
      confirmedAtMs: null,
      readyAtMs: null,
      deliveredAtMs: null,
      deliveredSaleId: null,
      cancelledAtMs: null,
      cancelledByUserId: null,
      cancelReason: null,
      createClientRequestId: idGen.nextId(),
      createRequestHash: 'hash123456',
      confirmClientRequestId: null,
      confirmRequestHash: null,
      readyClientRequestId: null,
      readyRequestHash: null,
      deliverClientRequestId: null,
      deliverRequestHash: null,
      cancelClientRequestId: null,
      cancelRequestHash: null,
      deviceId: deviceA,
      hlc: '001700000000000:00000:018bcfe5-6800-7000-8000-000000000111',
      createdAtMs: '1700000000000',
      updatedAtMs: '1700000000000',
    };

    const pushRes = await server.inject({
      method: 'POST',
      url: '/api/v1/sync/push',
      headers: { authorization: `Bearer ${deviceTokenA}` },
      payload: {
        clientVersion: '1.0.0',
        storeId: storeA,
        deviceId: deviceA,
        events: [
          {
            eventId,
            organizationId: orgA,
            storeId: storeA,
            deviceId: deviceA,
            deviceSeq: '1102',
            hlc: '001700000000000:00000:018bcfe5-6800-7000-8000-000000000111',
            type: 'orders.created',
            entity: 'orders',
            entityId: orderId,
            entityClass: 'MONOTONE',
            schemaVersion: 1,
            payload: orderPayload,
          },
        ],
      },
    });

    const body = pushRes.json<SyncPushResponseDto>();
    expect(body.results[0].status).toBe('rejected');
    expect(body.results[0].reason).toBe('STORE_MISMATCH');
  });

  // --------------------------------------------------------------------------
  // Test 13 (R5 Dependency Unresolved Conflict):
  // --------------------------------------------------------------------------
  it('R5: marks parked event as conflict and returns rejected: DEPENDENCY_UNRESOLVED after 20 attempts', async () => {
    const parentCatId = idGen.nextId();
    const childProdId = idGen.nextId();
    const childEventId = idGen.nextId();
    const unresolvedPayload = makeProductPayload(childProdId, parentCatId, 'Unresolved Product');

    // Seed 20 attempts directly in cloudSyncParked
    await adminConn.db.insert(cloudSyncParked).values({
      id: idGen.nextId(),
      organizationId: orgA,
      storeId: storeA,
      deviceId: deviceA,
      eventId: childEventId,
      entity: 'products',
      entityId: childProdId,
      missingRefEntity: 'categories',
      missingRefId: parentCatId,
      attempts: 20,
      eventPayload: JSON.stringify(unresolvedPayload),
      status: 'parked',
      createdAtMs: nowMs,
      updatedAtMs: nowMs,
    });

    // 21st attempt -> exceeds 20 attempts threshold!
    const pushRes = await server.inject({
      method: 'POST',
      url: '/api/v1/sync/push',
      headers: { authorization: `Bearer ${deviceTokenA}` },
      payload: {
        clientVersion: '1.0.0',
        storeId: storeA,
        deviceId: deviceA,
        events: [
          {
            eventId: childEventId,
            organizationId: orgA,
            storeId: storeA,
            deviceId: deviceA,
            deviceSeq: '1103',
            hlc: '001700000000000:00000:018bcfe5-6800-7000-8000-000000000111',
            type: 'products.created',
            entity: 'products',
            entityId: childProdId,
            entityClass: 'ATTR',
            schemaVersion: 1,
            payload: makeProductPayload(childProdId, parentCatId, 'Unresolved Product'),
          },
        ],
      },
    });

    const body = pushRes.json<SyncPushResponseDto>();
    expect(body.results[0].status).toBe('rejected');
    expect(body.results[0].reason).toBe('DEPENDENCY_UNRESOLVED');

    // Verify row status is updated to 'conflict'
    const [parkedRow] = await adminConn.db
      .select()
      .from(cloudSyncParked)
      .where(
        and(eq(cloudSyncParked.organizationId, orgA), eq(cloudSyncParked.eventId, childEventId)),
      );
    expect(parkedRow.status).toBe('conflict');
    expect(parkedRow.attempts).toBe(21);
  });

  it('F1: catches wrapped SQLSTATE 23503 foreign key violation via extractPgErrorCode, parks event as retry, and preserves gapless position', async () => {
    // 1. Push parent category CAT-F1
    const catId = parseUuidV7('018bcfe5-6800-7000-8000-000000000991');
    const catEventId = parseUuidV7('018bcfe5-6800-7000-8000-000000000992');
    const pushCatRes = await server.inject({
      method: 'POST',
      url: '/api/v1/sync/push',
      headers: { authorization: `Bearer ${deviceTokenA}` },
      payload: {
        clientVersion: '1.0.0',
        storeId: storeA,
        deviceId: deviceA,
        events: [
          {
            eventId: catEventId,
            organizationId: orgA,
            storeId: storeA,
            deviceId: deviceA,
            deviceSeq: '1201',
            hlc: '001700000000000:00000:018bcfe5-6800-7000-8000-000000000111',
            type: 'categories.created',
            entity: 'categories',
            entityId: catId,
            entityClass: 'ATTR',
            schemaVersion: 1,
            payload: makeCategoryPayload(catId, 'F1 Category'),
          },
        ],
      },
    });

    const catBody = pushCatRes.json<SyncPushResponseDto>();
    expect(catBody.results[0].status).toBe('accepted');
    const posAfterCat = BigInt(catBody.results[0].position ?? '0');

    // 2. Delete parent category directly from domain table via admin connection
    // Note: cloud_sync_events row remains, so reference pre-check in checkForeignReferences passes!
    await adminConn.db.delete(categories).where(eq(categories.id, catId));

    // 3. Push child product referencing catId
    const prodId = parseUuidV7('018bcfe5-6800-7000-8000-000000000993');
    const prodEventId = parseUuidV7('018bcfe5-6800-7000-8000-000000000994');
    const pushProdRes = await server.inject({
      method: 'POST',
      url: '/api/v1/sync/push',
      headers: { authorization: `Bearer ${deviceTokenA}` },
      payload: {
        clientVersion: '1.0.0',
        storeId: storeA,
        deviceId: deviceA,
        events: [
          {
            eventId: prodEventId,
            organizationId: orgA,
            storeId: storeA,
            deviceId: deviceA,
            deviceSeq: '1202',
            hlc: '001700000000000:00000:018bcfe5-6800-7000-8000-000000000111',
            type: 'products.created',
            entity: 'products',
            entityId: prodId,
            entityClass: 'ATTR',
            schemaVersion: 1,
            payload: makeProductPayload(prodId, catId, 'F1 Product'),
          },
        ],
      },
    });

    // 4. Expected outcome: retry, parked in cloud_sync_parked, position NOT incremented
    const prodBody = pushProdRes.json<SyncPushResponseDto>();
    expect(prodBody.results[0].status).toBe('retry');
    expect(prodBody.results[0].reason).toBe('DEPENDENCY_MISSING');
    expect(prodBody.results[0].position).toBeUndefined();

    // Check parked row exists
    const parkedRows = await adminConn.db
      .select()
      .from(cloudSyncParked)
      .where(
        and(eq(cloudSyncParked.organizationId, orgA), eq(cloudSyncParked.eventId, prodEventId)),
      );
    expect(parkedRows).toHaveLength(1);
    expect(parkedRows[0].status).toBe('parked');

    // Check store position was not incremented
    const [storePos] = await adminConn.db
      .select()
      .from(cloudStoreSyncPositions)
      .where(
        and(
          eq(cloudStoreSyncPositions.organizationId, orgA),
          eq(cloudStoreSyncPositions.storeId, storeA),
        ),
      );
    expect(storePos.lastPosition).toBe(posAfterCat);
  });

  it('mutations: checkMonotoneTransition returns missing_rule when entity has no transition rule', async () => {
    const dummyEvent: SyncEventEnvelopeDto = {
      eventId: idGen.nextId(),
      organizationId: orgA,
      storeId: storeA,
      deviceId: deviceA,
      deviceSeq: '9999',
      hlc: '001700000000000:00000:018bcfe5-6800-7000-8000-000000000111',
      type: 'dummy.updated',
      entity: 'non_existent_monotone_entity',
      entityId: idGen.nextId(),
      entityClass: 'MONOTONE',
      schemaVersion: 1,
      payload: {},
    };
    const res = await (
      syncPushStore as unknown as {
        checkMonotoneTransition: (
          tx: null,
          tableMeta: { tableName: string },
          event: SyncEventEnvelopeDto,
          payload: Record<string, unknown>,
          org: string,
        ) => Promise<string>;
      }
    ).checkMonotoneTransition(null, { tableName: 'non_existent' }, dummyEvent, {}, orgA);
    expect(res).toBe('missing_rule');
  });

  it('handles organization_tax_profile created, updated (tombstone), and restored (deleted_at_ms = null) via LWW ATTR', async () => {
    // 1. organization_tax_profile.created
    const createEventId = idGen.nextId();
    const hlc1 = serializeHlc({ physicalMs: nowMs, logical: 10, nodeId: deviceA });
    const pushCreateRes = await server.inject({
      method: 'POST',
      url: '/api/v1/sync/push',
      headers: {
        authorization: `Bearer ${deviceTokenA}`,
      },
      payload: {
        clientVersion: '1.0.0',
        storeId: storeA,
        deviceId: deviceA,
        events: [
          {
            eventId: createEventId,
            organizationId: orgA,
            storeId: storeA,
            deviceId: deviceA,
            deviceSeq: '5001',
            hlc: hlc1,
            type: 'organization_tax_profile.created',
            entity: 'organization_tax_profiles',
            entityId: orgA, // id MUST equal organizationId
            entityClass: 'ATTR',
            schemaVersion: 1,
            payload: {
              id: orgA,
              organizationId: orgA,
              deviceId: deviceA,
              hlc: hlc1,
              createdAtMs: '1700000000000',
              updatedAtMs: '1700000000000',
              deletedAtMs: null,
              tin: '123456789',
              legalName: 'Guzar Test MCHJ',
              legalAddress: 'Kattaqo‘rg‘on sh., Alisher Navoiy ko‘chasi 1-uy',
              isVatPayer: true,
              defaultVatRateBp: 1200,
              updatedByUserId: ownerA,
            },
          },
        ],
      },
    });

    expect(pushCreateRes.statusCode).toBe(200);
    const createBody = pushCreateRes.json<SyncPushResponseDto>();
    expect(createBody.results[0].status).toBe('accepted');

    // Verify row in domain table
    const [createdRow] = await adminConn.db
      .select()
      .from(organizationTaxProfiles)
      .where(eq(organizationTaxProfiles.id, orgA));
    expect(createdRow).toBeDefined();
    expect(createdRow.tin).toBe('123456789');
    expect(createdRow.legalName).toBe('Guzar Test MCHJ');
    expect(createdRow.isVatPayer).toBe(true);
    expect(createdRow.defaultVatRateBp).toBe(1200);
    expect(createdRow.deletedAtMs).toBeNull();

    // 2. organization_tax_profile.updated with tombstone (soft delete)
    const updateEventId = idGen.nextId();
    const hlc2 = serializeHlc({ physicalMs: nowMs, logical: 20, nodeId: deviceA });
    const pushUpdateRes = await server.inject({
      method: 'POST',
      url: '/api/v1/sync/push',
      headers: {
        authorization: `Bearer ${deviceTokenA}`,
      },
      payload: {
        clientVersion: '1.0.0',
        storeId: storeA,
        deviceId: deviceA,
        events: [
          {
            eventId: updateEventId,
            organizationId: orgA,
            storeId: storeA,
            deviceId: deviceA,
            deviceSeq: '5002',
            hlc: hlc2,
            type: 'organization_tax_profile.updated',
            entity: 'organization_tax_profiles',
            entityId: orgA,
            entityClass: 'ATTR',
            schemaVersion: 1,
            payload: {
              id: orgA,
              organizationId: orgA,
              deviceId: deviceA,
              hlc: hlc2,
              createdAtMs: '1700000000000',
              updatedAtMs: '1700000005000',
              deletedAtMs: '1700000005000',
              tin: '123456789',
              legalName: 'Guzar Test MCHJ (Updated)',
              legalAddress: 'Kattaqo‘rg‘on sh., Alisher Navoiy ko‘chasi 1-uy',
              isVatPayer: true,
              defaultVatRateBp: 1200,
              updatedByUserId: ownerA,
            },
          },
        ],
      },
    });

    expect(pushUpdateRes.statusCode).toBe(200);
    const updateBody = pushUpdateRes.json<SyncPushResponseDto>();
    expect(updateBody.results[0].status).toBe('accepted');

    const [updatedRow] = await adminConn.db
      .select()
      .from(organizationTaxProfiles)
      .where(eq(organizationTaxProfiles.id, orgA));
    expect(updatedRow.legalName).toBe('Guzar Test MCHJ (Updated)');
    expect(updatedRow.deletedAtMs).toBe(1700000005000n);

    // 3. organization_tax_profile.restored with deletedAtMs: null
    const restoreEventId = idGen.nextId();
    const hlc3 = serializeHlc({ physicalMs: nowMs, logical: 30, nodeId: deviceA });
    const pushRestoreRes = await server.inject({
      method: 'POST',
      url: '/api/v1/sync/push',
      headers: {
        authorization: `Bearer ${deviceTokenA}`,
      },
      payload: {
        clientVersion: '1.0.0',
        storeId: storeA,
        deviceId: deviceA,
        events: [
          {
            eventId: restoreEventId,
            organizationId: orgA,
            storeId: storeA,
            deviceId: deviceA,
            deviceSeq: '5003',
            hlc: hlc3,
            type: 'organization_tax_profile.restored',
            entity: 'organization_tax_profiles',
            entityId: orgA,
            entityClass: 'ATTR',
            schemaVersion: 1,
            payload: {
              id: orgA,
              organizationId: orgA,
              deviceId: deviceA,
              hlc: hlc3,
              createdAtMs: '1700000000000',
              updatedAtMs: '1700000010000',
              deletedAtMs: null, // Restored!
              tin: '123456789',
              legalName: 'Guzar Test MCHJ (Restored)',
              legalAddress: 'Kattaqo‘rg‘on sh., Alisher Navoiy ko‘chasi 1-uy',
              isVatPayer: false,
              defaultVatRateBp: 0,
              updatedByUserId: ownerA,
            },
          },
        ],
      },
    });

    expect(pushRestoreRes.statusCode).toBe(200);
    const restoreBody = pushRestoreRes.json<SyncPushResponseDto>();
    expect(restoreBody.results[0].status).toBe('accepted');

    const [restoredRow] = await adminConn.db
      .select()
      .from(organizationTaxProfiles)
      .where(eq(organizationTaxProfiles.id, orgA));
    expect(restoredRow.legalName).toBe('Guzar Test MCHJ (Restored)');
    expect(restoredRow.isVatPayer).toBe(false);
    expect(restoredRow.defaultVatRateBp).toBe(0);
    expect(restoredRow.deletedAtMs).toBeNull();
  });
});
