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
  type LocalSqliteConnection,
  createSqliteCartStore,
  createSqliteCatalogStore,
  createSqliteHubAuthStore,
  createSqliteReturnStore,
  createSqliteSaleStore,
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
const TASHKENT_235930_UTC_MS = BigInt(Date.parse('2026-06-15T18:59:30.000Z'));

let idCounter = 1n;
function nextTestUuid(prefixHex = '01960000'): UuidV7 {
  idCounter += 1n;
  const tail = idCounter.toString(16).padStart(12, '0');
  return parseUuidV7(`${prefixHex}-0000-7000-8000-${tail}`);
}

function makeTempDbPath(name = 'return-perf.db'): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mezon-t16-ret-perf-'));
  tempDirs.push(dir);
  return path.join(dir, name);
}

afterEach(() => {
  while (openConnections.length > 0) {
    const conn = openConnections.pop()!;
    try {
      conn.close();
    } catch {
      // Ignore already-closed handles
    }
  }
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 });
  }
});

async function setupReturnPerfEnv(seed: number) {
  const dbPath = makeTempDbPath();
  const clock = new FixedClock(TASHKENT_235930_UTC_MS);
  const random = new SeededRandomSource(seed);
  const connection = openLocalSqliteDatabase(dbPath);
  openConnections.push(connection);
  migrateLocalDatabase(connection.db);

  const authStore = await createSqliteHubAuthStore({ connection, clock, random });
  const setup = await authStore.completeSetup({
    fullName: 'Owner',
    username: 'owner16',
    pinHash: await FAST_TEST_HASHER.hash('849201'),
  });
  const manager = await authStore.createUser({
    fullName: 'Manager',
    username: 'mgr16',
    role: 'manager',
    pinHash: await FAST_TEST_HASHER.hash('592817'),
  });
  const cashier = await authStore.createUser({
    fullName: 'Cashier',
    username: 'cash16',
    role: 'cashier',
    pinHash: await FAST_TEST_HASHER.hash('374829'),
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

  const catalogStore = createSqliteCatalogStore({
    connection,
    getRuntimeContext: () => {
      const ctx = authStore.getActiveRuntimeContext();
      return ctx ? { uow: ctx.uow, organizationId: ctx.config.organizationId } : null;
    },
  });
  const stockStore = createSqliteStockStore({ connection, getRuntimeContext: getStoreCtx });
  const cartStore = createSqliteCartStore({ connection, getRuntimeContext: getStoreCtx });
  const saleStore = createSqliteSaleStore({ connection, getRuntimeContext: getStoreCtx });
  const returnStore = createSqliteReturnStore({ connection, getRuntimeContext: getStoreCtx });
  const shiftStore = createSqliteShiftStore({ connection, getRuntimeContext: getStoreCtx });
  await shiftStore.openShift({
    actorUserId: cashier.id,
    clientRequestId: parseUuidV7('01960000-0000-7000-8000-000000000099'),
    openingCash: ZERO_MONEY,
  });

  return {
    connection,
    catalogStore,
    stockStore,
    cartStore,
    saleStore,
    returnStore,
    ownerId: setup.owner.id,
    managerId: manager.id,
    cashierId: cashier.id,
  };
}

describe('@mezon/db-local [PERF] - T1.6 Return WAL benchmark', () => {
  it('meets <= 300ms latency for full return of a 20-line tracked receipt (10 FIFO + 10 avg) on disk WAL SQLite', async () => {
    const samplesMs: number[] = [];
    for (let runIdx = 0; runIdx < 5; runIdx += 1) {
      const env = await setupReturnPerfEnv(600 + runIdx);
      try {
        const cart = await env.cartStore.openCart(env.cashierId);
        let expectedTotal = 0n;

        for (let i = 0; i < 20; i += 1) {
          const isBatched = i < 10;
          const p = await env.catalogStore.createProduct({
            name: `Perf Tovar ${i}`,
            unit: 'dona',
            trackBatches: isBatched,
            salePrice: '15000',
            vatRateBp: 1200,
            actorUserId: env.ownerId,
          });
          await env.stockStore.recordInboundMove({
            productId: p.product.id,
            reason: 'purchase',
            qty: '10000',
            totalCostValue: '80000',
            batchNumber: isBatched ? `PB-${i}` : null,
            actorUserId: env.ownerId,
          });
          await env.cartStore.addLine(cart.id, {
            kind: 'catalog',
            productId: p.product.id,
            variantId: null,
            qty: quantityFromMilli(2_000n),
          });
          expectedTotal += 30_000n;
        }

        const sale = await env.saleStore.completeSale({
          cartId: cart.id,
          actorUserId: env.cashierId,
          clientRequestId: nextTestUuid(),
          expectedTotal: moneyFromTiyin(expectedTotal),
          payments: [
            { method: 'cash', tenderedAmount: moneyFromTiyin(300_000n) },
            { method: 'card', amount: moneyFromTiyin(300_000n), providerRef: 'PERF-CARD' },
          ],
        });

        const items = sale.sale.lines.map((l) => ({
          saleLineId: l.id,
          qty: l.qty,
        }));
        const t0 = performance.now();
        const ret = await env.returnStore.createReturn({
          saleId: sale.sale.id,
          actorUserId: env.managerId,
          reason: 'Perf 20-line full return',
          clientRequestId: nextTestUuid(),
          items,
          payments: [
            { method: 'cash', amount: moneyFromTiyin(300_000n) },
            { method: 'card', amount: moneyFromTiyin(300_000n), providerRef: 'PERF-RET' },
          ],
        });
        const elapsedMs = performance.now() - t0;
        samplesMs.push(elapsedMs);
        expect(ret.returnDoc.lines).toHaveLength(20);
        expect(moneyToTiyin(ret.returnDoc.totalRefund)).toBe(600_000n);
      } finally {
        env.connection.close();
      }
    }

    const sorted = [...samplesMs].sort((a, b) => a - b);
    const medianMs = sorted[Math.floor(sorted.length / 2)];
    console.info(
      `[PERF T1.6 db-local] 20-line full createReturn (10 FIFO + 10 avg) median=${medianMs.toFixed(2)} ms samples=[${samplesMs.map((s) => s.toFixed(2)).join(', ')}]`,
    );
    expect(medianMs).toBeLessThanOrEqual(300);
  }, 15_000);
});
