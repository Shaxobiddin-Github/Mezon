import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { type SyncEventEnvelopeDto } from '@mezon/contracts';
import {
  AdminReadStore,
  CloudSyncPushStore,
  CloudTenantStore,
  PG_APP_ROLE_NAME,
  type VerifiedDeviceContext,
  createCloudPgPool,
  migrateCloudDatabase,
  shouldRunPgTests,
  withPgTenantContext,
} from '@mezon/db-cloud';
import {
  type LocalSqliteConnection,
  createSqliteCartStore,
  createSqliteCatalogStore,
  createSqliteHubAuthStore,
  createSqliteReportStore,
  createSqliteReturnStore,
  createSqliteSaleStore,
  createSqliteShiftStore,
  createSqliteStockStore,
  listAllOutboxRecordsSync,
  migrateLocalDatabase,
  openLocalSqliteDatabase,
} from '@mezon/db-local';
import {
  type PinHasher,
  type UuidV7,
  moneyFromTiyin,
  moneyToTiyin,
  parseUuidV7,
  quantityFromMilli,
  quantityToMilli,
  unixMsFromBigInt,
} from '@mezon/domain';
import { FixedClock, SeededRandomSource, allowAllSaleRulesEvaluator } from '@mezon/test-utils';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { provisionAppRole } from '../../../packages/db-cloud/ops/provision-app-role.mjs';

const describePg = shouldRunPgTests() ? describe : describe.skip;

const FAST_PIN_HASHER: PinHasher = {
  hash: (pin) => Promise.resolve(`fast:${pin}`),
  verify: (hash, pin) => Promise.resolve(hash === `fast:${pin}`),
};

const tempDirs: string[] = [];
const openLocalConnections: LocalSqliteConnection[] = [];

function makeTempDbPath(name = 'hub-report.db'): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mezon-report-parity-'));
  tempDirs.push(dir);
  return path.join(dir, name);
}

describePg('A1: Hub vs Cloud DailySalesReport Parity (T2.7a)', () => {
  let container: StartedPostgreSqlContainer;
  let adminConn: ReturnType<typeof createCloudPgPool>;
  let appConn: ReturnType<typeof createCloudPgPool>;
  let syncPushStore: CloudSyncPushStore;
  let adminReadStore: AdminReadStore;
  let hubReportStore: ReturnType<typeof createSqliteReportStore>;

  let orgId: UuidV7;
  let storeId: UuidV7;
  let deviceId: UuidV7;
  let deviceContext: VerifiedDeviceContext;

  const nowMs = unixMsFromBigInt(1731232800000n); // 2026-11-10 10:00:00 UTC (15:00 Asia/Tashkent)
  const clock = new FixedClock(1731232800000n);
  const random = new SeededRandomSource(42);

  beforeAll(async () => {
    // 1. Start PostgreSQL testcontainer
    container = await new PostgreSqlContainer('postgres:18-alpine').start();
    adminConn = createCloudPgPool({
      connectionString: container.getConnectionUri(),
    });

    const testAppPassword = 'test-admin-api-app-password-secret-1234';
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
    adminReadStore = new AdminReadStore({ pool: appConn.pool });

    // 2. Setup Hub SQLite database
    const dbPath = makeTempDbPath();
    const localConn = openLocalSqliteDatabase(dbPath);
    openLocalConnections.push(localConn);
    migrateLocalDatabase(localConn.db);

    const hubAuthStore = await createSqliteHubAuthStore({ connection: localConn, clock, random });
    const hubSetup = await hubAuthStore.completeSetup({
      fullName: 'Boshliq',
      username: 'boshliq',
      pinHash: await FAST_PIN_HASHER.hash('123456'),
    });

    const activeCtx = hubAuthStore.getActiveRuntimeContext()!;
    orgId = activeCtx.config.organizationId;
    storeId = activeCtx.config.storeId;
    deviceId = activeCtx.config.deviceId;

    // 3. Seed Cloud Tenant and Store
    const tenantStore = new CloudTenantStore(adminConn.pool);
    await tenantStore.createOrganizationWithStoreAndOwner({
      organizationId: orgId,
      storeId,
      ownerUserId: hubSetup.owner.id,
      loginIdentityId: parseUuidV7('01950000-0000-7000-8000-000000000099'),
      organizationName: 'Guzar Parity Org',
      storeName: 'Markaziy Doʻkon',
      storeCode: 'store_parity',
      ownerUsername: 'boshliq',
      ownerLogin: 'boshliq@guzar.uz',
      passwordHash: '$argon2id$v=19$m=65536,t=3,p=4$dummyhash$dummyhash',
      nowMs,
    });

    // Seed enrolled device in cloud
    await withPgTenantContext(adminConn.pool, orgId, async (_tx, client) => {
      await client.query(
        `INSERT INTO cloud_devices (id, organization_id, store_id, device_id, name, platform, app_version, status, last_seen_at_ms, created_at_ms, updated_at_ms)
         VALUES ($1, $2, $3, $4, 'Main POS Terminal', 'windows', '1.0.0', 'active', $5, $5, $5)`,
        [
          parseUuidV7('01950000-0000-7000-8000-000000000088'),
          orgId,
          storeId,
          deviceId,
          nowMs.toString(),
        ],
      );
    });

    deviceContext = {
      organizationId: orgId,
      storeId,
      deviceId,
      deviceName: 'Main POS Terminal',
      status: 'active',
    };

    // 4. Perform Hub Operations: Catalog, Stock, Shift, Sales, Returns
    const getStoreCtx = () => {
      const ctx = hubAuthStore.getActiveRuntimeContext();
      return ctx
        ? { uow: ctx.uow, organizationId: ctx.config.organizationId, storeId: ctx.config.storeId }
        : null;
    };
    const getOrgCtx = () => {
      const ctx = hubAuthStore.getActiveRuntimeContext();
      return ctx ? { uow: ctx.uow, organizationId: ctx.config.organizationId } : null;
    };

    const catalogStore = createSqliteCatalogStore({
      connection: localConn,
      getRuntimeContext: getOrgCtx,
    });
    const stockStore = createSqliteStockStore({
      connection: localConn,
      getRuntimeContext: getStoreCtx,
    });
    const cartStore = createSqliteCartStore({
      connection: localConn,
      getRuntimeContext: getStoreCtx,
    });
    const saleStore = createSqliteSaleStore({
      connection: localConn,
      getRuntimeContext: getStoreCtx,
      rulesEvaluator: allowAllSaleRulesEvaluator,
    });
    const returnStore = createSqliteReturnStore({
      connection: localConn,
      getRuntimeContext: getStoreCtx,
    });
    const shiftStore = createSqliteShiftStore({
      connection: localConn,
      getRuntimeContext: getStoreCtx,
    });
    hubReportStore = createSqliteReportStore({
      connection: localConn,
      getRuntimeContext: getStoreCtx,
    });

    // Item 1: Samarqand non (12% VAT = 1200 bp), Sale Price: 10,000 tiyin, Cost: 6,000 tiyin
    const p1 = (
      await catalogStore.createProduct({
        actorUserId: hubSetup.owner.id,
        name: 'Samarqand non',
        sku: 'BREAD-SMQ',
        unit: 'dona',
        salePrice: '1000000',
        vatRateBp: 1200,
        minStock: '10000',
      })
    ).product;

    await stockStore.recordInboundMove({
      productId: p1.id,
      qty: '50000',
      totalCostValue: '30000000', // 50 * 6,000 = 300,000 tiyin
      reason: 'purchase',
      actorUserId: hubSetup.owner.id,
    });

    // Item 2: Sut (0% VAT = 0 bp), Sale Price: 8,000 tiyin, Cost: 5,000 tiyin
    const p2 = (
      await catalogStore.createProduct({
        actorUserId: hubSetup.owner.id,
        name: 'Tohir Sut',
        sku: 'MILK-TOH',
        unit: 'dona',
        salePrice: '800000',
        vatRateBp: 0,
        minStock: '10000',
      })
    ).product;

    await stockStore.recordInboundMove({
      productId: p2.id,
      qty: '40000',
      totalCostValue: '20000000', // 40 * 5,000 = 200,000 tiyin
      reason: 'purchase',
      actorUserId: hubSetup.owner.id,
    });

    // Open Shift
    await shiftStore.openShift({
      actorUserId: hubSetup.owner.id,
      clientRequestId: parseUuidV7('01950000-0000-7000-8000-000000000010'),
      openingCash: moneyFromTiyin(500_000_00n),
    });

    // Sale 1: 2x Bread (20,000 tiyin) + 1x Milk (8,000 tiyin) = 28,000 tiyin (Cash: 28,000)
    const cart1 = await cartStore.openCart(hubSetup.owner.id);
    await cartStore.addLine(cart1.id, {
      kind: 'catalog',
      productId: p1.id,
      variantId: null,
      qty: quantityFromMilli(2_000n),
    });
    await cartStore.addLine(cart1.id, {
      kind: 'catalog',
      productId: p2.id,
      variantId: null,
      qty: quantityFromMilli(1_000n),
    });
    const sale1Res = await saleStore.completeSale({
      cartId: cart1.id,
      actorUserId: hubSetup.owner.id,
      clientRequestId: parseUuidV7('01950000-0000-7000-8000-000000000011'),
      expectedTotal: moneyFromTiyin(28_000_00n),
      payments: [{ method: 'cash', tenderedAmount: moneyFromTiyin(28_000_00n) }],
    });

    // Sale 2: 1x Milk (8,000 tiyin) (Card: 8,000)
    const cart2 = await cartStore.openCart(hubSetup.owner.id);
    await cartStore.addLine(cart2.id, {
      kind: 'catalog',
      productId: p2.id,
      variantId: null,
      qty: quantityFromMilli(1_000n),
    });
    await saleStore.completeSale({
      cartId: cart2.id,
      actorUserId: hubSetup.owner.id,
      clientRequestId: parseUuidV7('01950000-0000-7000-8000-000000000012'),
      expectedTotal: moneyFromTiyin(8_000_00n),
      payments: [{ method: 'card', amount: moneyFromTiyin(8_000_00n) }],
    });

    // Return: Return 1x Bread from Sale 1 (10,000 tiyin Cash refund)
    const sale1 = sale1Res.sale;
    const breadLine = sale1.lines.find((l) => l.productId === p1.id)!;
    await returnStore.createReturn({
      actorUserId: hubSetup.owner.id,
      clientRequestId: parseUuidV7('01950000-0000-7000-8000-000000000013'),
      saleId: sale1.id,
      reason: 'Sifatsiz',
      payments: [{ method: 'cash', amount: moneyFromTiyin(10_000_00n) }],
      items: [
        {
          saleLineId: breadLine.id,
          qty: quantityFromMilli(1_000n),
        },
      ],
    });

    // 5. Read Outbox from SQLite and Push to Cloud
    const outboxRows = listAllOutboxRecordsSync(localConn.db);
    expect(outboxRows.length).toBeGreaterThan(0);

    const syncEvents: SyncEventEnvelopeDto[] = outboxRows.map((r) => ({
      eventId: r.eventId,
      organizationId: r.organizationId,
      storeId: r.storeId,
      deviceId: r.deviceId,
      deviceSeq: r.deviceSeq.toString(),
      hlc: r.hlc,
      type: r.type,
      entity: r.entity,
      entityId: r.entityId,
      entityClass: r.class,
      schemaVersion: r.schemaVersion,
      payload: r.payload,
    }));

    // Process push in Cloud
    const pushResult = await syncPushStore.processSyncPushBatch({
      context: deviceContext,
      events: syncEvents,
      nowMs,
    });

    const acceptedCount = pushResult.results.filter(
      (r) => r.status === 'accepted' || r.status === 'duplicate',
    ).length;
    expect(acceptedCount).toBe(syncEvents.length);
  }, 90000);

  afterAll(async () => {
    while (openLocalConnections.length > 0) {
      openLocalConnections.pop()?.close();
    }
    while (tempDirs.length > 0) {
      const d = tempDirs.pop();
      if (d) fs.rmSync(d, { recursive: true, force: true });
    }
    await appConn?.pool.end();
    await adminConn?.pool.end();
    await container?.stop();
  });

  it('matches Hub DailySalesReport and Cloud DailySalesReport tiyin-to-tiyin across all metrics', async () => {
    // 1. Fetch Hub Report
    const hubReport = await hubReportStore.getDailySalesReport({
      fromDate: '2026-11-01',
      toDate: '2026-11-30',
      includeCostAndProfit: true,
    });

    // 2. Fetch Cloud Report
    const cloudReport = await adminReadStore.getDailySalesReport({
      organizationId: orgId,
      storeId,
      fromDate: '2026-11-01',
      toDate: '2026-11-30',
      tz: 'Asia/Tashkent',
      includeCostAndProfit: true,
    });

    // 3. Parity Assertions
    // Total Counts
    expect(cloudReport.totalSalesCount).toBe(hubReport.totalSalesCount);
    expect(cloudReport.totalReturnsCount).toBe(hubReport.totalReturnsCount);

    // Gross Sales, Returns, Net Sales
    expect(moneyToTiyin(cloudReport.totalGrossSales)).toBe(moneyToTiyin(hubReport.totalGrossSales));
    expect(moneyToTiyin(cloudReport.totalReturns)).toBe(moneyToTiyin(hubReport.totalReturns));
    expect(moneyToTiyin(cloudReport.totalNetSales)).toBe(moneyToTiyin(hubReport.totalNetSales));

    // VAT
    expect(moneyToTiyin(cloudReport.totalVat)).toBe(moneyToTiyin(hubReport.totalVat));

    // Payment breakdown (Cash vs Non-cash)
    expect(moneyToTiyin(cloudReport.totalCashSales)).toBe(moneyToTiyin(hubReport.totalCashSales));
    expect(moneyToTiyin(cloudReport.totalNonCashSales)).toBe(
      moneyToTiyin(hubReport.totalNonCashSales),
    );

    // Cost of goods sold & Gross Profit
    expect(cloudReport.totalCostValue).toBeDefined();
    expect(hubReport.totalCostValue).toBeDefined();
    if (cloudReport.totalCostValue && hubReport.totalCostValue) {
      expect(moneyToTiyin(cloudReport.totalCostValue)).toBe(moneyToTiyin(hubReport.totalCostValue));
    }

    expect(cloudReport.totalGrossProfit).toBeDefined();
    expect(hubReport.totalGrossProfit).toBeDefined();
    if (cloudReport.totalGrossProfit && hubReport.totalGrossProfit) {
      expect(moneyToTiyin(cloudReport.totalGrossProfit)).toBe(
        moneyToTiyin(hubReport.totalGrossProfit),
      );
    }

    // Daily buckets count and exact values
    expect(cloudReport.days.length).toBe(hubReport.days.length);
    for (let i = 0; i < hubReport.days.length; i++) {
      const hDay = hubReport.days[i];
      const cDay = cloudReport.days[i];
      if (!hDay || !cDay) continue;

      expect(cDay.date).toBe(hDay.date);
      expect(cDay.salesCount).toBe(hDay.salesCount);
      expect(cDay.returnsCount).toBe(hDay.returnsCount);
      expect(moneyToTiyin(cDay.grossSales)).toBe(moneyToTiyin(hDay.grossSales));
      expect(moneyToTiyin(cDay.returnsTotal)).toBe(moneyToTiyin(hDay.returnsTotal));
      expect(moneyToTiyin(cDay.netSales)).toBe(moneyToTiyin(hDay.netSales));
      expect(moneyToTiyin(cDay.vatTotal)).toBe(moneyToTiyin(hDay.vatTotal));
      expect(quantityToMilli(cDay.totalQty)).toBe(quantityToMilli(hDay.totalQty));
      expect(moneyToTiyin(cDay.cashSales)).toBe(moneyToTiyin(hDay.cashSales));
      expect(moneyToTiyin(cDay.nonCashSales)).toBe(moneyToTiyin(hDay.nonCashSales));

      if (hDay.costValue && cDay.costValue) {
        expect(moneyToTiyin(cDay.costValue)).toBe(moneyToTiyin(hDay.costValue));
      }
      if (hDay.grossProfit && cDay.grossProfit) {
        expect(moneyToTiyin(cDay.grossProfit)).toBe(moneyToTiyin(hDay.grossProfit));
      }
    }
  });
});
