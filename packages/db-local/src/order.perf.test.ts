import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import {
  type PinHasher,
  type UuidV7,
  epochDaysFromCivilDate,
  moneyFromTiyin,
  moneyToTiyin,
  parseUuidV7,
  quantityFromMilli,
} from '@mezon/domain';
import { FixedClock, SeededRandomSource } from '@mezon/test-utils';
import { afterEach, describe, expect, it } from 'vitest';
import {
  type LocalSqliteConnection,
  createSqliteCatalogStore,
  createSqliteCustomerStore,
  createSqliteHubAuthStore,
  createSqliteOrderStore,
  createSqliteShiftStore,
  createSqliteStockStore,
  migrateLocalDatabase,
  openLocalSqliteDatabase,
} from './index.js';

const FAST_TEST_HASHER: PinHasher = {
  hash: (pin) => Promise.resolve(`fast-hash:${pin}`),
  verify: (hash, pin) => Promise.resolve(hash === `fast-hash:${pin}`),
};

const tempDirs: string[] = [];
const openConnections: LocalSqliteConnection[] = [];
const DAY1_1000_MS = epochDaysFromCivilDate('2026-11-10') * 86_400_000n + 5n * 3_600_000n;

function makeTempDbPath(name = 'order-perf.db'): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mezon-t110-order-perf-'));
  tempDirs.push(dir);
  return path.join(dir, name);
}

function makeUuid(index: number): UuidV7 {
  return parseUuidV7(`019b0000-0000-7000-8000-${index.toString(16).padStart(12, '0')}`);
}

afterEach(() => {
  while (openConnections.length > 0) {
    openConnections.pop()?.close();
  }
  while (tempDirs.length > 0) {
    const d = tempDirs.pop();
    if (d) {
      fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 });
    }
  }
});

describe('@mezon/db-local - T1.10 Order Delivery Performance Benchmark', () => {
  it('delivers a 20-line order (FIFO catalog + quick_sale + advance + mixed settlement) within <= 300ms on disk WAL SQLite', async () => {
    const dbPath = makeTempDbPath();
    const clock = new FixedClock(DAY1_1000_MS);
    const random = new SeededRandomSource(910);
    const connection = openLocalSqliteDatabase(dbPath);
    openConnections.push(connection);
    migrateLocalDatabase(connection.db);

    const authStore = await createSqliteHubAuthStore({ connection, clock, random });
    const setup = await authStore.completeSetup({
      fullName: 'Perf Owner',
      username: 'perfowner110',
      pinHash: await FAST_TEST_HASHER.hash('849201'),
    });
    const cashier = await authStore.createUser({
      fullName: 'Perf Cashier',
      username: 'perfcash110',
      role: 'cashier',
      pinHash: await FAST_TEST_HASHER.hash('374829'),
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
    const stockStore = createSqliteStockStore({ connection, getRuntimeContext: getStoreCtx });
    const customerStore = createSqliteCustomerStore({ connection, getRuntimeContext: getStoreCtx });
    const shiftStore = createSqliteShiftStore({ connection, getRuntimeContext: getStoreCtx });
    const orderStore = createSqliteOrderStore({ connection, getRuntimeContext: getStoreCtx });

    let seq = 1;
    const nextUuid = () => makeUuid(seq++);

    const customer = await customerStore.createCustomer({
      fullName: 'Perf Buyer',
      phone: '90 100-20-30',
      creditLimit: moneyFromTiyin(50_000_000_00n),
    });

    const productIds: UuidV7[] = [];
    for (let i = 0; i < 15; i += 1) {
      const p = await catalogStore.createProduct({
        name: `Order Perf Item ${String(i + 1)}`,
        unit: 'dona',
        unlimited: false,
        trackBatches: true,
        salePrice: '1000000', // 10,000 UZS
        vatRateBp: 1200,
        actorUserId: setup.owner.id,
      });
      productIds.push(p.product.id);
      await stockStore.recordInboundMove({
        productId: p.product.id,
        reason: 'purchase',
        qty: '50000',
        totalCostValue: '25000000',
        batchNumber: `B-${String(i + 1)}`,
        actorUserId: setup.owner.id,
      });
    }

    await shiftStore.openShift({
      actorUserId: cashier.id,
      clientRequestId: nextUuid(),
      openingCash: moneyFromTiyin(100_000_00n),
    });

    // Warmup single-line delivery
    const warmupOrd = await orderStore.createOrder({
      actorUserId: cashier.id,
      clientRequestId: nextUuid(),
      customerId: customer.id,
      confirmImmediately: true,
      lines: [{ kind: 'catalog', productId: productIds[0], qty: quantityFromMilli(1_000n) }],
    });
    await orderStore.recordOrderAdvance({
      orderId: warmupOrd.order.id,
      actorUserId: cashier.id,
      clientRequestId: nextUuid(),
      payments: [{ method: 'cash', tenderedAmount: moneyFromTiyin(5_000_00n) }],
    });
    await orderStore.deliverOrder({
      orderId: warmupOrd.order.id,
      actorUserId: cashier.id,
      clientRequestId: nextUuid(),
      expectedTotal: warmupOrd.order.totalAmount,
      payments: [{ method: 'cash', tenderedAmount: moneyFromTiyin(5_000_00n) }],
    });

    // 20-line benchmark order: 15 FIFO batch-tracked catalog lines + 5 quick_sale lines + mixed advance + delivery
    const twentyLines = [
      ...productIds.map((pid) => ({
        kind: 'catalog' as const,
        productId: pid,
        qty: quantityFromMilli(1_000n),
      })),
      ...Array.from({ length: 5 }, (_, idx) => ({
        kind: 'quick_sale' as const,
        name: `Custom Qadoq ${String(idx + 1)}`,
        unit: 'dona' as const,
        qty: quantityFromMilli(1_000n),
        unitPrice: moneyFromTiyin(5_000_00n),
      })),
    ];

    const benchOrder = await orderStore.createOrder({
      actorUserId: cashier.id,
      clientRequestId: nextUuid(),
      customerId: customer.id,
      confirmImmediately: true,
      lines: twentyLines,
    });
    expect(benchOrder.order.lines.length).toBe(20);

    await orderStore.recordOrderAdvance({
      orderId: benchOrder.order.id,
      actorUserId: cashier.id,
      clientRequestId: nextUuid(),
      payments: [
        { method: 'cash', tenderedAmount: moneyFromTiyin(50_000_00n) },
        { method: 'card', amount: moneyFromTiyin(25_000_00n) },
      ],
    });

    const remTiyin = moneyToTiyin(benchOrder.order.totalAmount) - 75_000_00n;
    const t0 = performance.now();
    const res = await orderStore.deliverOrder({
      orderId: benchOrder.order.id,
      actorUserId: cashier.id,
      clientRequestId: nextUuid(),
      expectedTotal: benchOrder.order.totalAmount,
      payments: [{ method: 'cash', tenderedAmount: moneyFromTiyin(remTiyin) }],
    });
    const elapsedMs = performance.now() - t0;

    expect(res.order.status).toBe('delivered');
    expect(res.sale.lines.length).toBe(20);
    console.info(
      `[db-local perf] 20-line order deliverOrder completed in ${elapsedMs.toFixed(2)} ms`,
    );
    expect(elapsedMs).toBeLessThanOrEqual(300);
  });
});
