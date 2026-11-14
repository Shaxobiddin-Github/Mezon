import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  type PinHasher,
  type UuidV7,
  epochDaysFromCivilDate,
  moneyFromTiyin,
  moneyToTiyin,
  parseUuidV7,
  quantityFromMilli,
  quantityToMilli,
} from '@mezon/domain';
import { FixedClock, SeededRandomSource } from '@mezon/test-utils';
import { afterEach, describe, expect, it } from 'vitest';
import {
  type LocalSqliteConnection,
  createSqliteCartStore,
  createSqliteCatalogStore,
  createSqliteCustomerStore,
  createSqliteHubAuthStore,
  createSqliteReportStore,
  createSqliteReturnStore,
  createSqliteSaleStore,
  createSqliteShiftStore,
  createSqliteStockStore,
  createSqliteSupplierStore,
  migrateLocalDatabase,
  openLocalSqliteDatabase,
} from './index.js';

const FAST_TEST_HASHER: PinHasher = {
  hash: (pin) => Promise.resolve(`fast-hash:${pin}`),
  verify: (hash, pin) => Promise.resolve(hash === `fast-hash:${pin}`),
};

const tempDirs: string[] = [];
const openConnections: LocalSqliteConnection[] = [];

function makeTempDbPath(name = 'report-test.db'): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mezon-t13-report-'));
  tempDirs.push(dir);
  return path.join(dir, name);
}

afterEach(() => {
  while (openConnections.length > 0) {
    openConnections.pop()?.close();
  }
  while (tempDirs.length > 0) {
    const d = tempDirs.pop();
    if (d) {
      fs.rmSync(d, { recursive: true, force: true });
    }
  }
});

let uuidCounter = 1;
function nextUuid(): UuidV7 {
  const hex = (uuidCounter++).toString(16).padStart(12, '0');
  return parseUuidV7(`01950000-0000-7000-8000-${hex}`);
}

// 2026-11-10 10:00:00 Asia/Tashkent = 2026-11-10T05:00:00.000Z
const DAY1_1000_MS = epochDaysFromCivilDate('2026-11-10') * 86_400_000n + 5n * 3_600_000n;

async function setupReportEnv(options?: { readonly initialMs?: bigint }) {
  const dbPath = makeTempDbPath();
  const clock = new FixedClock(options?.initialMs ?? DAY1_1000_MS);
  const random = new SeededRandomSource(101);
  const connection = openLocalSqliteDatabase(dbPath);
  openConnections.push(connection);
  migrateLocalDatabase(connection.db);

  const authStore = await createSqliteHubAuthStore({ connection, clock, random });
  const setup = await authStore.completeSetup({
    fullName: 'Owner',
    username: 'owner',
    pinHash: await FAST_TEST_HASHER.hash('123456'),
  });

  const getStoreCtx = () => {
    const ctx = authStore.getActiveRuntimeContext();
    return ctx
      ? { uow: ctx.uow, organizationId: ctx.config.organizationId, storeId: ctx.config.storeId }
      : null;
  };
  const getOrgCtx = () => {
    const ctx = authStore.getActiveRuntimeContext();
    return ctx ? { uow: ctx.uow, organizationId: ctx.config.organizationId } : null;
  };

  const catalogStore = createSqliteCatalogStore({ connection, getRuntimeContext: getOrgCtx });
  const stockStore = createSqliteStockStore({
    connection,
    getRuntimeContext: getStoreCtx,
  });
  const cartStore = createSqliteCartStore({
    connection,
    getRuntimeContext: getStoreCtx,
  });
  const saleStore = createSqliteSaleStore({
    connection,
    getRuntimeContext: getStoreCtx,
  });
  const returnStore = createSqliteReturnStore({
    connection,
    getRuntimeContext: getStoreCtx,
  });
  const customerStore = createSqliteCustomerStore({
    connection,
    getRuntimeContext: getStoreCtx,
  });
  const supplierStore = createSqliteSupplierStore({
    connection,
    getRuntimeContext: getStoreCtx,
  });
  const shiftStore = createSqliteShiftStore({
    connection,
    getRuntimeContext: getStoreCtx,
  });
  const reportStore = createSqliteReportStore({
    connection,
    getRuntimeContext: getStoreCtx,
  });

  return {
    connection,
    clock,
    random,
    authStore,
    catalogStore,
    stockStore,
    cartStore,
    saleStore,
    returnStore,
    customerStore,
    supplierStore,
    shiftStore,
    reportStore,
    ownerId: setup.owner.id,
  };
}

describe('T1.13: SqliteReportStore', () => {
  it('aggregates daily and monthly sales from v_sales_lines accurately', async () => {
    const env = await setupReportEnv();

    // 1. Create product and add stock
    const p1 = (
      await env.catalogStore.createProduct({
        actorUserId: env.ownerId,
        name: 'Non (Samarqand)',
        sku: 'BREAD-01',
        unit: 'dona',
        salePrice: '500000',
        vatRateBp: 0,
        minStock: '10000', // 10 pcs
      })
    ).product;

    await env.stockStore.recordInboundMove({
      productId: p1.id,
      qty: '50000',
      totalCostValue: '15000000', // 50 * 3,000 = 150,000
      reason: 'purchase',
      actorUserId: env.ownerId,
    });

    // 2. Open shift
    await env.shiftStore.openShift({
      actorUserId: env.ownerId,
      clientRequestId: nextUuid(),
      openingCash: moneyFromTiyin(100_000_00n),
    });

    // 3. Sale 2 breads (2 * 5,000 = 10,000 tiyin)
    const cart1 = await env.cartStore.openCart(env.ownerId);
    await env.cartStore.addLine(cart1.id, {
      kind: 'catalog',
      productId: p1.id,
      variantId: null,
      qty: quantityFromMilli(2_000n),
    });
    await env.saleStore.completeSale({
      cartId: cart1.id,
      actorUserId: env.ownerId,
      clientRequestId: nextUuid(),
      expectedTotal: moneyFromTiyin(10_000_00n),
      payments: [{ method: 'cash', tenderedAmount: moneyFromTiyin(10_000_00n) }],
    });

    // 4. Query daily report
    const daily = await env.reportStore.getDailySalesReport({
      fromDate: '2026-11-01',
      toDate: '2026-11-30',
      includeCostAndProfit: true,
    });

    expect(daily.days.length).toBeGreaterThanOrEqual(1);
    const todaySummary = daily.days.find((d) => d.date === '2026-11-10');
    expect(todaySummary).toBeDefined();
    expect(moneyToTiyin(todaySummary!.netSales)).toBe(10_000_00n);
    expect(moneyToTiyin(todaySummary!.grossSales)).toBe(10_000_00n);
    expect(todaySummary!.salesCount).toBe(1);
    expect(moneyToTiyin(todaySummary!.costValue!)).toBe(6_000_00n);
    expect(moneyToTiyin(todaySummary!.grossProfit!)).toBe(4_000_00n);

    // 5. Query monthly report
    const monthly = await env.reportStore.getMonthlySalesReport({
      year: 2026,
      includeCostAndProfit: true,
    });
    expect(monthly.months.length).toBeGreaterThanOrEqual(1);
    const novSummary = monthly.months.find((m) => m.month === '2026-11');
    expect(novSummary).toBeDefined();
    expect(moneyToTiyin(novSummary!.netSales)).toBe(10_000_00n);
  });

  it('calculates profit report by product strictly matching COGS and gross profit', async () => {
    const env = await setupReportEnv();

    const p = (
      await env.catalogStore.createProduct({
        actorUserId: env.ownerId,
        name: 'Choy 100g',
        sku: 'TEA-01',
        unit: 'dona',
        salePrice: '1200000',
        vatRateBp: 0,
      })
    ).product;

    await env.stockStore.recordInboundMove({
      productId: p.id,
      qty: '20000',
      totalCostValue: '16000000', // 20 * 8,000 = 160,000
      reason: 'purchase',
      actorUserId: env.ownerId,
    });

    await env.shiftStore.openShift({
      actorUserId: env.ownerId,
      clientRequestId: nextUuid(),
      openingCash: moneyFromTiyin(50_000_00n),
    });

    const cart = await env.cartStore.openCart(env.ownerId);
    await env.cartStore.addLine(cart.id, {
      kind: 'catalog',
      productId: p.id,
      variantId: null,
      qty: quantityFromMilli(3_000n),
    });
    await env.saleStore.completeSale({
      cartId: cart.id,
      actorUserId: env.ownerId,
      clientRequestId: nextUuid(),
      expectedTotal: moneyFromTiyin(36_000_00n),
      payments: [{ method: 'cash', tenderedAmount: moneyFromTiyin(36_000_00n) }],
    });

    const profit = await env.reportStore.getProfitReport({
      fromDate: '2026-11-01',
      toDate: '2026-11-30',
      groupBy: 'product',
    });

    expect(profit.items.length).toBe(1);
    const item = profit.items[0];
    expect(item.key).toBe(p.id);
    expect(moneyToTiyin(item.netRevenue)).toBe(36_000_00n);
    expect(moneyToTiyin(item.costValue)).toBe(24_000_00n);
    expect(moneyToTiyin(item.grossProfit)).toBe(12_000_00n);
    expect(item.marginBp).toBe(3333); // 12,000 / 36,000 = 33.33% = 3333 bp
    expect(moneyToTiyin(profit.totalNetRevenue)).toBe(36_000_00n);
    expect(moneyToTiyin(profit.totalCostValue)).toBe(24_000_00n);
    expect(moneyToTiyin(profit.totalGrossProfit)).toBe(12_000_00n);
  });

  it('R1: reports low stock and expiring batches using real schema columns', async () => {
    const env = await setupReportEnv();

    // Product with minStock 15, current stock 5 -> low stock!
    const pLow = (
      await env.catalogStore.createProduct({
        actorUserId: env.ownerId,
        name: 'Sut 1L',
        sku: 'MILK-01',
        unit: 'dona',
        salePrice: '900000',
        vatRateBp: 0,
        trackBatches: true,
        minStock: '15000',
      })
    ).product;

    // Inbound with batch having expiry_date_ms in 5 days (R1: real column batches.expiry_date_ms)
    const in5DaysMs = DAY1_1000_MS + 5n * 86_400_000n;
    await env.stockStore.recordInboundMove({
      productId: pLow.id,
      qty: '5000',
      totalCostValue: '3500000',
      reason: 'purchase',
      batchNumber: 'BATCH-2026-11-15',
      expiryDateMs: String(in5DaysMs),
      actorUserId: env.ownerId,
    });

    // 1. Low stock report
    const lowStock = await env.reportStore.getLowStockReport({ limit: 10 });
    expect(lowStock.length).toBeGreaterThanOrEqual(1);
    const milkItem = lowStock.find((i) => i.productId === pLow.id);
    expect(milkItem).toBeDefined();
    expect(quantityToMilli(milkItem!.currentStock)).toBe(5_000n);
    expect(quantityToMilli(milkItem!.minStock)).toBe(15_000n);
    expect(quantityToMilli(milkItem!.deficit)).toBe(10_000n);

    // 2. Expiring batches report (R1: within 7 days)
    const expiring = await env.reportStore.getExpiringBatchesReport({
      withinDays: 7,
      asOfMs: DAY1_1000_MS,
    });
    expect(expiring.length).toBeGreaterThanOrEqual(1);
    const expBatch = expiring.find((b) => b.productId === pLow.id);
    expect(expBatch).toBeDefined();
    expect(expBatch!.batchCode).toBe('BATCH-2026-11-15');
    expect(expBatch!.daysRemaining).toBe(5);
    expect(quantityToMilli(expBatch!.remainingQty)).toBe(5_000n);
  });

  it('reports customer debts with aging buckets correctly', async () => {
    const env = await setupReportEnv();

    // Create customer with credit
    const cust = await env.customerStore.createCustomer({
      fullName: 'Alisher Karimov',
      phone: '+998901234567',
      creditLimit: moneyFromTiyin(500_000_00n),
    });

    // Record opening balance debt: 300,000 tiyin
    await env.customerStore.recordOpeningBalance({
      customerId: cust.id,
      actorUserId: env.ownerId,
      clientRequestId: nextUuid(),
      amount: moneyFromTiyin(300_000_00n),
      reason: 'Eski qarz',
    });

    const debts = await env.reportStore.getDebtsReport({ asOfMs: DAY1_1000_MS });
    expect(debts.customers.length).toBe(1);
    const cd = debts.customers[0];
    expect(cd.customerId).toBe(cust.id);
    expect(moneyToTiyin(cd.balance)).toBe(300_000_00n);
    expect(moneyToTiyin(debts.customerCurrentDebt)).toBe(300_000_00n);
    expect(moneyToTiyin(debts.totalCustomerDebt)).toBe(300_000_00n);
  });
});
