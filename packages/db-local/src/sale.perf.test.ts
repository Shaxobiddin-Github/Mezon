import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import {
  type PinHasher,
  type UuidV7,
  ZERO_MONEY,
  moneyFromTiyin,
  moneyToTiyin,
  parseUuidV7,
  quantityFromMilli,
} from '@mezon/domain';
import { FixedClock, SeededRandomSource } from '@mezon/test-utils';
import { afterEach, describe, expect, it } from 'vitest';
import {
  type SqliteCartStore,
  type SqliteCatalogStore,
  type SqliteSaleStore,
  type SqliteShiftStore,
  type SqliteStockStore,
  createSqliteCartStore,
  createSqliteCatalogStore,
  createSqliteHubAuthStore,
  createSqliteSaleStore,
  createSqliteShiftStore,
  createSqliteStockStore,
  migrateLocalDatabase,
  openLocalSqliteDatabase,
} from './index.js';

const FAST_TEST_HASHER: PinHasher = {
  hash: (pin) => Promise.resolve(`$stub$${pin}`),
  verify: (hash, pin) => Promise.resolve(hash === `$stub$${pin}`),
};

const tempDirs: string[] = [];

function createTempDbPath(name = 'sale-perf.db'): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mezon-sale-perf-'));
  tempDirs.push(dir);
  return path.join(dir, name);
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 });
  }
});

async function setupSalePerfEnv(dbPath = createTempDbPath()) {
  const clock = new FixedClock(1_760_000_000_000n);
  const random = new SeededRandomSource(91);
  const connection = openLocalSqliteDatabase(dbPath);
  migrateLocalDatabase(connection.db);

  const authStore = await createSqliteHubAuthStore({
    connection,
    clock,
    random,
  });
  const setup = await authStore.completeSetup({
    fullName: 'Owner Sale',
    username: 'owner',
    pinHash: await FAST_TEST_HASHER.hash('849201'),
  });
  const cashier = await authStore.createUser({
    fullName: 'Kassir Sale',
    username: 'cashier',
    role: 'cashier',
    pinHash: await FAST_TEST_HASHER.hash('319482'),
  });
  const manager = await authStore.createUser({
    fullName: 'Manager Sale',
    username: 'manager',
    role: 'manager',
    pinHash: await FAST_TEST_HASHER.hash('618394'),
  });

  const getStoreCtx = () => {
    const ctx = authStore.getActiveRuntimeContext();
    return ctx
      ? {
          uow: ctx.uow,
          organizationId: ctx.config.organizationId,
          storeId: ctx.config.storeId,
        }
      : null;
  };

  const catalogStore: SqliteCatalogStore = createSqliteCatalogStore({
    connection,
    getRuntimeContext: () => {
      const ctx = authStore.getActiveRuntimeContext();
      return ctx ? { uow: ctx.uow, organizationId: ctx.config.organizationId } : null;
    },
  });
  const stockStore: SqliteStockStore = createSqliteStockStore({
    connection,
    getRuntimeContext: getStoreCtx,
  });
  const cartStore: SqliteCartStore = createSqliteCartStore({
    connection,
    getRuntimeContext: getStoreCtx,
  });
  const saleStore: SqliteSaleStore = createSqliteSaleStore({
    connection,
    getRuntimeContext: getStoreCtx,
  });
  const shiftStore: SqliteShiftStore = createSqliteShiftStore({
    connection,
    getRuntimeContext: getStoreCtx,
  });
  await shiftStore.openShift({
    actorUserId: cashier.id,
    clientRequestId: parseUuidV7('01950000-0000-7000-8000-0000000000a1'),
    openingCash: ZERO_MONEY,
  });

  return {
    connection,
    catalogStore,
    stockStore,
    cartStore,
    saleStore,
    ownerId: setup.owner.id,
    managerId: manager.id,
    cashierId: cashier.id,
  };
}

describe('@mezon/db-local [PERF] - T1.4 & T1.5 completeSale WAL benchmarks', () => {
  it('meets <= 300ms local completion target for a 20-line tracked catalog cart on disk WAL SQLite', async () => {
    const dbPath = createTempDbPath('perf-20-lines.db');
    const env = await setupSalePerfEnv(dbPath);
    try {
      const prodIds: UuidV7[] = [];
      for (let i = 0; i < 20; i += 1) {
        const created = await env.catalogStore.createProduct({
          name: `Perf Mahsulot ${i + 1}`,
          unit: 'dona',
          trackBatches: i % 2 === 0,
          salePrice: String((i + 1) * 10_000),
          vatRateBp: 1200,
          actorUserId: env.ownerId,
        });
        await env.stockStore.recordInboundMove({
          productId: created.product.id,
          reason: 'purchase',
          qty: '10000',
          totalCostValue: String((i + 1) * 60_000),
          batchNumber: i % 2 === 0 ? `B-${i}` : null,
          actorUserId: env.ownerId,
        });
        prodIds.push(created.product.id);
      }

      const cart = await env.cartStore.openCart(env.cashierId);
      let detail = await env.cartStore.getCart(cart.id);
      for (const pid of prodIds) {
        detail = await env.cartStore.addLine(cart.id, {
          kind: 'catalog',
          productId: pid,
          variantId: null,
          qty: quantityFromMilli(2_000n),
        });
      }
      expect(detail.lines.length).toBe(20);

      const t0 = performance.now();
      const completed = await env.saleStore.completeSale({
        cartId: cart.id,
        actorUserId: env.cashierId,
        clientRequestId: parseUuidV7('01950000-0000-7000-8000-555555555501'),
        expectedTotal: detail.totalFinal,
        payments: [{ method: 'cash', tenderedAmount: detail.totalFinal }],
      });
      const elapsedMs = performance.now() - t0;

      expect(completed.sale.lines.length).toBe(20);
      expect(elapsedMs).toBeLessThanOrEqual(300);
      console.info(
        `[PERF T1.4 db-local] 20-line completeSale (10 FIFO batched + 10 avg) took ${elapsedMs.toFixed(2)} ms`,
      );
    } finally {
      env.connection.close();
    }
  }, 30_000);

  it('T1.5 perf: 20-line cart with 3 payment types (card + payme + cash w/ change) completes <= 300ms', async () => {
    const dbPath = createTempDbPath('perf-t15-3pay.db');
    const env = await setupSalePerfEnv(dbPath);
    try {
      const prodIds: UuidV7[] = [];
      for (let i = 0; i < 20; i += 1) {
        const created = await env.catalogStore.createProduct({
          name: `T1.5 Perf ${i + 1}`,
          unit: 'dona',
          trackBatches: i % 2 === 0,
          salePrice: String((i + 1) * 10_000),
          vatRateBp: 1200,
          actorUserId: env.ownerId,
        });
        await env.stockStore.recordInboundMove({
          productId: created.product.id,
          reason: 'purchase',
          qty: '10000',
          totalCostValue: String((i + 1) * 60_000),
          batchNumber: i % 2 === 0 ? `B-${i}` : null,
          actorUserId: env.ownerId,
        });
        prodIds.push(created.product.id);
      }

      const samplesMs: number[] = [];
      let expectedDrawerTotal = 0n;
      for (let run = 1; run <= 5; run += 1) {
        const cart = await env.cartStore.openCart(env.cashierId);
        let detail = await env.cartStore.getCart(cart.id);
        for (const pid of prodIds) {
          detail = await env.cartStore.addLine(cart.id, {
            kind: 'catalog',
            productId: pid,
            variantId: null,
            qty: quantityFromMilli(2_000n),
          });
        }
        const total = moneyToTiyin(detail.totalFinal);
        const cardPart = total / 3n;
        const paymePart = total / 3n;
        const cashNeed = total - cardPart - paymePart;

        const t0 = performance.now();
        const completed = await env.saleStore.completeSale({
          cartId: cart.id,
          actorUserId: env.managerId,
          clientRequestId: parseUuidV7(`01950000-0000-7000-8000-e0000000000${run}`),
          expectedTotal: detail.totalFinal,
          payments: [
            { method: 'card', amount: moneyFromTiyin(cardPart), providerRef: 'PERF-CARD' },
            { method: 'payme', amount: moneyFromTiyin(paymePart), providerRef: 'PERF-PM' },
            { method: 'cash', tenderedAmount: moneyFromTiyin(cashNeed + 50_000n) },
          ],
        });
        samplesMs.push(performance.now() - t0);

        expect(completed.sale.lines).toHaveLength(20);
        expect(completed.sale.payments).toHaveLength(3);
        expect(completed.sale.changeAmount).toBe(moneyFromTiyin(50_000n));
        expectedDrawerTotal += cashNeed;
      }

      const sorted = [...samplesMs].sort((a, b) => a - b);
      const medianMs = sorted[Math.floor(sorted.length / 2)] ?? 0;
      expect(await env.saleStore.getTerminalCashBalance()).toBe(
        moneyFromTiyin(expectedDrawerTotal),
      );
      expect(medianMs).toBeLessThanOrEqual(300);
      console.info(
        `[PERF T1.5 db-local] 20-line completeSale (3 payments: card+payme+cash) median=${medianMs.toFixed(2)} ms samples=[${samplesMs.map((v) => v.toFixed(2)).join(', ')}]`,
      );
    } finally {
      env.connection.close();
    }
  }, 30_000);
});
