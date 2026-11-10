import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  type PinHasher,
  type UuidV7,
  createHlcTimestamp,
  moneyToTiyin,
  quantityToMilli,
  serializeHlc,
  unixMsFromBigInt,
} from '@mezon/domain';
import { FixedClock, SeededRandomSource } from '@mezon/test-utils';
import fc from 'fast-check';
import { afterEach, describe, expect, it } from 'vitest';
import {
  SqliteCatalogStore,
  SqliteStockStore,
  createSqliteCatalogStore,
  createSqliteHubAuthStore,
  createSqliteStockStore,
  listAllOutboxRecordsSync,
  migrateLocalDatabase,
  openLocalSqliteDatabase,
} from './index.js';

const FAST_TEST_HASHER: PinHasher = {
  hash: (pin) => Promise.resolve(`$stub$${pin}`),
  verify: (hash, pin) => Promise.resolve(hash === `$stub$${pin}`),
};

const tempDirs: string[] = [];

function makeTempDbPath(name = 'stock.db'): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mezon-stock-'));
  tempDirs.push(dir);
  return path.join(dir, name);
}

afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

async function setupStockEnv(dbPath = makeTempDbPath()) {
  const clock = new FixedClock(1_760_000_000_000n);
  const random = new SeededRandomSource(88);
  const connection = openLocalSqliteDatabase(dbPath);
  migrateLocalDatabase(connection.db);

  const authStore = await createSqliteHubAuthStore({
    connection,
    clock,
    random,
  });
  const pinHash = await FAST_TEST_HASHER.hash('849201');
  const setup = await authStore.completeSetup({
    fullName: 'Stock Owner',
    username: 'owner',
    pinHash,
  });

  const catalogStore: SqliteCatalogStore = createSqliteCatalogStore({
    connection,
    getRuntimeContext: () => {
      const ctx = authStore.getActiveRuntimeContext();
      return ctx ? { uow: ctx.uow, organizationId: ctx.config.organizationId } : null;
    },
  });

  const stockStore: SqliteStockStore = createSqliteStockStore({
    connection,
    getRuntimeContext: () => {
      const ctx = authStore.getActiveRuntimeContext();
      return ctx
        ? {
            uow: ctx.uow,
            organizationId: ctx.config.organizationId,
            storeId: ctx.config.storeId,
          }
        : null;
    },
  });

  return {
    dbPath,
    clock,
    connection,
    authStore,
    catalogStore,
    stockStore,
    organizationId: setup.organizationId,
    storeId: setup.storeId,
    ownerId: setup.owner.id,
    deviceId: setup.deviceId,
  };
}

describe('@mezon/db-local - T1.2 Stock Ledger, Batches, FIFO/Average Costing, S1-S4 & Property Tests', () => {
  it('enforces unit rules, unlimited product blocks, STOCK_COSTING_LOCKED, FACT immutability, and worked manual FIFO & average examples', async () => {
    const env = await setupStockEnv();
    try {
      const fifoProd = (
        await env.catalogStore.createProduct({
          name: 'Dori Quti',
          unit: 'dona',
          trackBatches: true,
          salePrice: '1500000',
          actorUserId: env.ownerId,
        })
      ).product;

      const avgProd = (
        await env.catalogStore.createProduct({
          name: 'Guruch',
          unit: 'kg',
          trackBatches: false,
          salePrice: '1800000',
          actorUserId: env.ownerId,
        })
      ).product;

      const serviceProd = (
        await env.catalogStore.createProduct({
          name: 'Yetkazib berish',
          unit: 'dona',
          unlimited: true,
          salePrice: '2000000',
          actorUserId: env.ownerId,
        })
      ).product;

      // Unlimited items cannot receive stock moves
      await expect(
        env.stockStore.recordInboundMove({
          productId: serviceProd.id,
          reason: 'initial',
          qty: '1000',
          totalCostValue: '1000',
          actorUserId: env.ownerId,
        }),
      ).rejects.toMatchObject({ code: 'UNLIMITED_PRODUCT_STOCK_NOT_TRACKED' });

      // Fractional quantity rejected on 'dona'
      await expect(
        env.stockStore.recordInboundMove({
          productId: fifoProd.id,
          reason: 'initial',
          qty: '1500',
          totalCostValue: '15000',
          actorUserId: env.ownerId,
        }),
      ).rejects.toMatchObject({ code: 'INVALID_UNIT_QUANTITY' });

      // --- Worked Example #1 (FIFO negative + closing receipt) ---
      const b1 = await env.stockStore.recordInboundMove({
        productId: fifoProd.id,
        reason: 'purchase',
        qty: '2000',
        totalCostValue: '20000',
        batchNumber: 'LOT-A',
        expiryDateMs: '1800000000000',
        actorUserId: env.ownerId,
      });
      expect(b1.batch?.remainingQty).toBe(2000n);
      expect(b1.batch?.remainingValue).toBe(20000n);

      // Cannot switch trackBatches once stock moves exist
      await expect(
        env.catalogStore.updateProduct(fifoProd.id, {
          trackBatches: false,
          actorUserId: env.ownerId,
        }),
      ).rejects.toMatchObject({ code: 'STOCK_COSTING_LOCKED' });

      // Default warn policy: selling 5 dona leaves -3 deficit
      const negSale = await env.stockStore.recordOutboundMove({
        productId: fifoProd.id,
        reason: 'sale',
        qty: '5000',
        actorUserId: env.ownerId,
      });
      expect(negSale.warnings).toHaveLength(1);
      expect(negSale.warnings[0]?.deficitQty).toBe(3000n);
      expect(negSale.moves).toHaveLength(2);

      // Next inbound +5 @ 60,000 closes 3 deficit @ 36,000, leaves 2 @ 24,000, variance = +6,000
      const b2 = await env.stockStore.recordInboundMove({
        productId: fifoProd.id,
        reason: 'purchase',
        qty: '5000',
        totalCostValue: '60000',
        batchNumber: 'LOT-B',
        actorUserId: env.ownerId,
      });
      expect(b2.batch?.remainingQty).toBe(2000n);
      expect(b2.batch?.remainingValue).toBe(24000n);

      // --- Worked Example #2 (Weighted Average Cost 10,000 / 3 indivisible) ---
      await env.stockStore.recordInboundMove({
        productId: avgProd.id,
        reason: 'initial',
        qty: '3000', // 3.000 kg
        totalCostValue: '10000',
        actorUserId: env.ownerId,
      });
      const avgOut1 = await env.stockStore.recordOutboundMove({
        productId: avgProd.id,
        reason: 'sale',
        qty: '1000',
        actorUserId: env.ownerId,
      });
      expect(avgOut1.moves[0]?.costValueDelta).toBe(-3333n);

      // Policy 'block' rejects exceeding remaining 2 kg
      await expect(
        env.stockStore.recordOutboundMove({
          productId: avgProd.id,
          reason: 'damaged',
          qty: '2500',
          policy: 'block',
          actorUserId: env.ownerId,
        }),
      ).rejects.toMatchObject({ code: 'INSUFFICIENT_STOCK' });

      const avgOut2 = await env.stockStore.recordOutboundMove({
        productId: avgProd.id,
        reason: 'sale',
        qty: '2000',
        actorUserId: env.ownerId,
      });
      expect(avgOut2.moves[0]?.costValueDelta).toBe(-6667n);

      const vals = await env.stockStore.listStockValuations();
      const fifoVal = vals.find((v) => v.productId === fifoProd.id)!;
      const avgVal = vals.find((v) => v.productId === avgProd.id)!;
      expect(fifoVal.qtyOnHand).toBe(2000n);
      expect(fifoVal.totalValue).toBe(24000n);
      expect(fifoVal.costVarianceValue).toBe(6000n);
      expect(avgVal.qtyOnHand).toBe(0n);
      expect(avgVal.totalValue).toBe(0n);

      // FACT immutability on stock_moves and batches
      expect(() =>
        env.connection.sqlite.prepare('UPDATE stock_moves SET qty_delta = 1').run(),
      ).toThrow(/FACT table "stock_moves" is immutable/);
      expect(() => env.connection.sqlite.prepare('DELETE FROM batches').run()).toThrow(
        /FACT table "batches" forbids physical DELETE/,
      );
    } finally {
      env.connection.close();
    }
  });

  it('S1 & S3: snapshots expected_qty_at_count at line count time (cases a, b, c + partial) and blocks post-finalize line mutations', async () => {
    const env = await setupStockEnv();
    try {
      const pA = (
        await env.catalogStore.createProduct({
          name: 'Tovar A',
          unit: 'dona',
          salePrice: '100000',
          actorUserId: env.ownerId,
        })
      ).product;
      const pB = (
        await env.catalogStore.createProduct({
          name: 'Tovar B (Sanalmaydigan)',
          unit: 'dona',
          salePrice: '100000',
          actorUserId: env.ownerId,
        })
      ).product;

      const setStock = async (prodId: UuidV7, qtyWhole: number) => {
        await env.stockStore.recordInboundMove({
          productId: prodId,
          reason: 'initial',
          qty: String(qtyWhole * 1000),
          totalCostValue: String(qtyWhole * 5000),
          actorUserId: env.ownerId,
        });
      };

      // Case (a): start 10 -> sell 2 (now 8) -> count 8 -> finalize = 8 (no adjustment)
      await setStock(pA.id, 10);
      await setStock(pB.id, 4);
      const countA = await env.stockStore.startInventoryCount({
        productIds: [pA.id, pB.id],
        actorUserId: env.ownerId,
      });
      await env.stockStore.recordOutboundMove({
        productId: pA.id,
        reason: 'sale',
        qty: '2000',
        actorUserId: env.ownerId,
      });
      await env.stockStore.recordInventoryCountLines(countA.count.id, [
        { productId: pA.id, countedQty: '8000' },
        // pB stays null (partial count!)
      ]);
      const finA = await env.stockStore.finalizeInventoryCount(countA.count.id, env.ownerId);
      expect(finA.adjustmentMoves).toHaveLength(0);
      let cashBals = await env.stockStore.listCashierBalances();
      expect(cashBals.find((b) => b.productId === pA.id)?.qtyOnHand).toBe(8000n);
      // Uncounted pB remained 4000n (NEVER zeroed out!)
      expect(cashBals.find((b) => b.productId === pB.id)?.qtyOnHand).toBe(4000n);

      // S3: raw SQL cannot mutate finalized count OR insert/update lines of finalized count
      expect(() =>
        env.connection.sqlite
          .prepare('UPDATE "inventory_counts" SET "status" = ? WHERE "id" = ?')
          .run('open', countA.count.id),
      ).toThrow(/MONOTONE table "inventory_counts"/);
      expect(() =>
        env.connection.sqlite
          .prepare('UPDATE "inventory_count_lines" SET "counted_qty" = 999000 WHERE "count_id" = ?')
          .run(countA.count.id),
      ).toThrow(/Cannot modify inventory_count_lines of finalized or cancelled/);
      expect(() =>
        env.connection.sqlite
          .prepare(
            `INSERT INTO "inventory_count_lines" (
              "id", "organization_id", "store_id", "device_id", "hlc", "created_at_ms", "updated_at_ms",
              "count_id", "product_id", "variant_id", "expected_qty_at_count", "counted_qty", "adjustment_qty"
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL)`,
          )
          .run(
            '01991111-0000-7000-8000-000000000001',
            env.organizationId,
            env.storeId,
            env.deviceId,
            serializeHlc(createHlcTimestamp(unixMsFromBigInt(1_760_000_000_000n), 9, env.deviceId)),
            1_760_000_000_000n,
            1_760_000_000_000n,
            countA.count.id,
            pB.id,
          ),
      ).toThrow(/Cannot insert inventory_count_lines into non-open/);

      // Case (b): 10 -> count 9 -> sell 2 -> finalize => final balance = 7
      await env.stockStore.recordInboundMove({
        productId: pA.id,
        reason: 'purchase',
        qty: '2000',
        totalCostValue: '10000',
        actorUserId: env.ownerId,
      }); // pA back to 10
      const countB = await env.stockStore.startInventoryCount({
        productIds: [pA.id],
        actorUserId: env.ownerId,
      });
      await env.stockStore.recordInventoryCountLines(countB.count.id, [
        { productId: pA.id, countedQty: '9000' }, // snapshot expected = 10, counted = 9 => -1
      ]);
      await env.stockStore.recordOutboundMove({
        productId: pA.id,
        reason: 'sale',
        qty: '2000',
        actorUserId: env.ownerId,
      }); // ledger now 8
      const finB = await env.stockStore.finalizeInventoryCount(countB.count.id, env.ownerId);
      expect(finB.lines[0]?.adjustmentQty).toBe(-1000n);
      cashBals = await env.stockStore.listCashierBalances();
      expect(cashBals.find((b) => b.productId === pA.id)?.qtyOnHand).toBe(7000n);

      // Case (c): re-count line after sale updates expected_qty_at_count to latest ledger snapshot
      await env.stockStore.recordInboundMove({
        productId: pA.id,
        reason: 'purchase',
        qty: '3000',
        totalCostValue: '15000',
        actorUserId: env.ownerId,
      }); // pA back to 10
      const countC = await env.stockStore.startInventoryCount({
        productIds: [pA.id],
        actorUserId: env.ownerId,
      });
      // First entry: ledger 10, count 11 (snapshot expected=10)
      await env.stockStore.recordInventoryCountLines(countC.count.id, [
        { productId: pA.id, countedQty: '11000' },
      ]);
      // Sale of 3 brings ledger to 7
      await env.stockStore.recordOutboundMove({
        productId: pA.id,
        reason: 'sale',
        qty: '3000',
        actorUserId: env.ownerId,
      });
      // Re-count enters 6 -> latest expected_qty_at_count MUST be 7 => adj = -1 => final = 6!
      const updated = await env.stockStore.recordInventoryCountLines(countC.count.id, [
        { productId: pA.id, countedQty: '6000' },
      ]);
      expect(updated.lines[0]?.expectedQtyAtCount).toBe(7000n);
      const finC = await env.stockStore.finalizeInventoryCount(countC.count.id, env.ownerId);
      expect(finC.lines[0]?.adjustmentQty).toBe(-1000n);
      cashBals = await env.stockStore.listCashierBalances();
      expect(cashBals.find((b) => b.productId === pA.id)?.qtyOnHand).toBe(6000n);
    } finally {
      env.connection.close();
    }
  });

  it('S2 & S4: rebuildStockProjections survives over-consumed batches & unknown surplus costs, logging owner conflicts accurately', async () => {
    const env = await setupStockEnv();
    try {
      const fifoUnknown = (
        await env.catalogStore.createProduct({
          name: 'Nomalum Narxli Partiya',
          unit: 'dona',
          trackBatches: true,
          salePrice: '50000',
          actorUserId: env.ownerId,
        })
      ).product;

      const avgSurplus = (
        await env.catalogStore.createProduct({
          name: 'Ortacha Ortiqcha',
          unit: 'kg',
          trackBatches: false,
          salePrice: '200000',
          actorUserId: env.ownerId,
        })
      ).product;

      // S4 test #1: unknown-cost positive inventory count creates 0-cost batch + UNKNOWN_COST_SURPLUS conflict
      const cnt = await env.stockStore.startInventoryCount({
        productIds: [fifoUnknown.id],
        actorUserId: env.ownerId,
      });
      await env.stockStore.recordInventoryCountLines(cnt.count.id, [
        { productId: fifoUnknown.id, countedQty: '2000' },
      ]);
      const finUnknown = await env.stockStore.finalizeInventoryCount(cnt.count.id, env.ownerId);
      expect(finUnknown.adjustmentMoves[0]?.costValueDelta).toBe(0n);
      expect(finUnknown.conflicts).toHaveLength(1);
      expect(finUnknown.conflicts[0]?.reason).toBe('UNKNOWN_COST_SURPLUS');

      // S4 test #2: average-cost product with known pool uses average valuation
      await env.stockStore.recordInboundMove({
        productId: avgSurplus.id,
        reason: 'purchase',
        qty: '4000',
        totalCostValue: '20000',
        actorUserId: env.ownerId,
      });
      const cntAvg = await env.stockStore.startInventoryCount({
        productIds: [avgSurplus.id],
        actorUserId: env.ownerId,
      });
      await env.stockStore.recordInventoryCountLines(cntAvg.count.id, [
        { productId: avgSurplus.id, countedQty: '6000' }, // +2 kg @ avg 5,000/kg = 10,000
      ]);
      const finAvg = await env.stockStore.finalizeInventoryCount(cntAvg.count.id, env.ownerId);
      expect(finAvg.adjustmentMoves[0]?.costValueDelta).toBe(10000n);
      expect(finAvg.conflicts).toHaveLength(0);

      // S2 test: over-consume a batch via raw SQL FACT insert and prove rebuild succeeds without throwing
      const batchRes = await env.stockStore.recordInboundMove({
        productId: fifoUnknown.id,
        reason: 'purchase',
        qty: '5000',
        totalCostValue: '50000',
        batchNumber: 'OVER-LOT',
        actorUserId: env.ownerId,
      });
      const targetBatchId = batchRes.batch!.id;
      await env.stockStore.recordOutboundMove({
        productId: fifoUnknown.id,
        reason: 'sale',
        qty: '6000', // consumes 2k unknown + 4k of OVER-LOT -> leaving 1k remaining
        actorUserId: env.ownerId,
      });

      env.clock.advance(5_000n);
      const laterHlc = serializeHlc(
        createHlcTimestamp(unixMsFromBigInt(env.clock.now()), 1, env.deviceId),
      );
      env.connection.sqlite
        .prepare(
          `INSERT INTO "stock_moves" (
            "id", "organization_id", "store_id", "device_id", "hlc", "created_at_ms",
            "product_id", "variant_id", "batch_id", "qty_delta", "cost_value_delta",
            "reason", "source_type", "source_id", "created_by_user_id", "note"
          ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, -3000, -30000, 'sale', 'sale', ?, ?, 'simulated conflict overconsumption')`,
        )
        .run(
          '01992222-0000-7000-8000-000000000001',
          env.organizationId,
          env.storeId,
          env.deviceId,
          laterHlc,
          env.clock.now(),
          fifoUnknown.id,
          targetBatchId,
          '01992222-0000-7000-8000-000000000002',
          env.ownerId,
        );

      const rebuildStats = await env.stockStore.rebuildProjections();
      expect(rebuildStats.conflictsDetected).toBeGreaterThanOrEqual(2);

      const conflicts = await env.stockStore.listConflicts();
      const overConflict = conflicts.find((c) => c.reason === 'BATCH_OVERCONSUMED');
      expect(overConflict).toBeDefined();
      expect(overConflict?.batchId).toBe(targetBatchId);
      expect(overConflict?.conflictQty).toBe(2000n); // remaining was 1,000, tried taking 3,000 => overflow 2,000

      const vals = await env.stockStore.listStockValuations();
      const prodVal = vals.find((v) => v.productId === fifoUnknown.id)!;
      expect(prodVal.qtyOnHand).toBe(-2000n);
      expect(prodVal.deficitQty).toBe(2000n);
    } finally {
      env.connection.close();
    }
  });

  it('(d) out-of-order HLC replay preserves immutable FACT snapshots and tracks cost_variance_value', async () => {
    const env = await setupStockEnv();
    try {
      const prod = (
        await env.catalogStore.createProduct({
          name: 'HLC Sync Item',
          unit: 'dona',
          trackBatches: false,
          salePrice: '25000',
          actorUserId: env.ownerId,
        })
      ).product;

      // Live receipt at t0 + 10s: +5 @ 50,000 (10k/unit)
      env.clock.advance(10_000n);
      await env.stockStore.recordInboundMove({
        productId: prod.id,
        reason: 'purchase',
        qty: '5000',
        totalCostValue: '50000',
        actorUserId: env.ownerId,
      });

      // Sale at t0 + 20s: -2 @ 20,000 (snapshot!)
      env.clock.advance(10_000n);
      const saleRes = await env.stockStore.recordOutboundMove({
        productId: prod.id,
        reason: 'sale',
        qty: '2000',
        actorUserId: env.ownerId,
      });
      const saleMove = saleRes.moves[0];
      if (!saleMove) {
        throw new Error('Expected outbound sale move');
      }
      const saleMoveId = saleMove.id;
      expect(saleMove.costValueDelta).toBe(-20000n);

      // Late synced historical purchase arriving with earlier HLC (t0 + 1s): +5 @ 100,000 (20k/unit)
      // Combined pool at sale time becomes 10 units @ 150,000 => true cost of 2 units = 30,000 (10,000 difference!)
      const earlyHlc = serializeHlc(
        createHlcTimestamp(unixMsFromBigInt(1_760_000_001_000n), 0, env.deviceId),
      );
      env.connection.sqlite
        .prepare(
          `INSERT INTO "stock_moves" (
            "id", "organization_id", "store_id", "device_id", "hlc", "created_at_ms",
            "product_id", "variant_id", "batch_id", "qty_delta", "cost_value_delta",
            "reason", "source_type", "source_id", "created_by_user_id", "note"
          ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, 5000, 100000, 'purchase', 'purchase', ?, ?, 'late historical sync')`,
        )
        .run(
          '01993333-0000-7000-8000-000000000001',
          env.organizationId,
          env.storeId,
          env.deviceId,
          earlyHlc,
          1_760_000_001_000n,
          prod.id,
          '01993333-0000-7000-8000-000000000002',
          env.ownerId,
        );

      const outboxBefore = listAllOutboxRecordsSync(env.connection.db).length;
      await env.stockStore.rebuildProjections();
      expect(listAllOutboxRecordsSync(env.connection.db)).toHaveLength(outboxBefore);

      // Sale FACT snapshot remains untouched (-20,000)
      const movesAfter = await env.stockStore.listStockMoves({ productId: prod.id });
      expect(movesAfter.find((m) => m.id === saleMoveId)?.costValueDelta).toBe(-20000n);

      // Pool value balances: in (150k) === out (20k) + remaining (120k) + variance (10k)
      const val = (await env.stockStore.listStockValuations()).find(
        (v) => v.productId === prod.id,
      )!;
      expect(val.qtyOnHand).toBe(8000n);
      expect(val.totalValue).toBe(120000n);
      expect(val.costVarianceValue).toBe(10000n);
      expect(150000n).toBe(20000n + val.totalValue + val.costVarianceValue);
    } finally {
      env.connection.close();
    }
  });

  it('(g) property test: live SQLite state & rebuildStockProjections match independent naive ledger model exactly across random ops', async () => {
    type RandomOp =
      | { readonly kind: 'in'; readonly qtyMilli: bigint; readonly costTiyin: bigint }
      | { readonly kind: 'out'; readonly qtyMilli: bigint; readonly allowNeg: boolean }
      | { readonly kind: 'inv'; readonly countedMilli: bigint };

    const opArb: fc.Arbitrary<RandomOp> = fc.oneof(
      fc.record({
        kind: fc.constant('in' as const),
        qtyMilli: fc.bigInt({ min: 1n, max: 20_000n }),
        costTiyin: fc.bigInt({ min: 0n, max: 500_000n }),
      }),
      fc.record({
        kind: fc.constant('out' as const),
        qtyMilli: fc.bigInt({ min: 1n, max: 20_000n }),
        allowNeg: fc.boolean(),
      }),
      fc.record({
        kind: fc.constant('inv' as const),
        countedMilli: fc.bigInt({ min: 0n, max: 20_000n }),
      }),
    );

    await fc.assert(
      fc.asyncProperty(
        fc.boolean(),
        fc.array(opArb, { minLength: 3, maxLength: 18 }),
        async (trackBatches, ops) => {
          const env = await setupStockEnv();
          try {
            const prod = (
              await env.catalogStore.createProduct({
                name: trackBatches ? 'Prop FIFO' : 'Prop AVG',
                unit: 'kg',
                trackBatches,
                salePrice: '100000',
                actorUserId: env.ownerId,
              })
            ).product;

            let naiveQtySum = 0n;

            for (const op of ops) {
              if (op.kind === 'in') {
                await env.stockStore.recordInboundMove({
                  productId: prod.id,
                  reason: 'purchase',
                  qty: op.qtyMilli.toString(),
                  totalCostValue: op.costTiyin.toString(),
                  actorUserId: env.ownerId,
                });
                naiveQtySum += op.qtyMilli;
              } else if (op.kind === 'out') {
                if (!op.allowNeg && naiveQtySum < op.qtyMilli) {
                  await expect(
                    env.stockStore.recordOutboundMove({
                      productId: prod.id,
                      reason: 'sale',
                      qty: op.qtyMilli.toString(),
                      policy: 'block',
                      actorUserId: env.ownerId,
                    }),
                  ).rejects.toMatchObject({ code: 'INSUFFICIENT_STOCK' });
                  continue;
                }
                await env.stockStore.recordOutboundMove({
                  productId: prod.id,
                  reason: 'sale',
                  qty: op.qtyMilli.toString(),
                  policy: op.allowNeg ? 'warn' : 'block',
                  actorUserId: env.ownerId,
                });
                naiveQtySum -= op.qtyMilli;
              } else {
                const cnt = await env.stockStore.startInventoryCount({
                  productIds: [prod.id],
                  actorUserId: env.ownerId,
                });
                await env.stockStore.recordInventoryCountLines(cnt.count.id, [
                  { productId: prod.id, countedQty: op.countedMilli.toString() },
                ]);
                await env.stockStore.finalizeInventoryCount(cnt.count.id, env.ownerId);
                naiveQtySum = op.countedMilli;
              }
            }

            // Snapshot live SQLite state before rebuild
            const liveMoves = await env.stockStore.listStockMoves({
              productId: prod.id,
              limit: 200,
            });
            const ledgerQty = liveMoves.reduce((acc, m) => acc + quantityToMilli(m.qtyDelta), 0n);
            const ledgerInCost = liveMoves
              .filter((m) => quantityToMilli(m.qtyDelta) > 0n)
              .reduce((acc, m) => acc + moneyToTiyin(m.costValueDelta), 0n);
            const ledgerOutCost = liveMoves
              .filter((m) => quantityToMilli(m.qtyDelta) < 0n)
              .reduce((acc, m) => acc + -moneyToTiyin(m.costValueDelta), 0n);

            expect(ledgerQty).toBe(naiveQtySum);

            const liveVal = (await env.stockStore.listStockValuations()).find(
              (v) => v.productId === prod.id,
            );
            const liveBatches = await env.stockStore.listBatches({
              productId: prod.id,
              includeEmpty: true,
              limit: 200,
            });

            if (liveVal) {
              expect(liveVal.qtyOnHand).toBe(ledgerQty);
              expect(ledgerInCost).toBe(
                ledgerOutCost +
                  liveVal.totalValue -
                  liveVal.provisionalDeficitValue +
                  liveVal.costVarianceValue,
              );
              if (trackBatches) {
                const batchSumQty = liveBatches.reduce((a, b) => a + b.remainingQty, 0n);
                const batchSumVal = liveBatches.reduce((a, b) => a + b.remainingValue, 0n);
                expect(liveVal.qtyOnHand).toBe(batchSumQty - liveVal.deficitQty);
                expect(liveVal.totalValue).toBe(batchSumVal);
              }
            }

            // Wipe projections via rebuildStockProjections() and assert ZERO drift & ZERO outbox events
            const outboxBefore = listAllOutboxRecordsSync(env.connection.db).length;
            await env.stockStore.rebuildProjections();
            expect(listAllOutboxRecordsSync(env.connection.db)).toHaveLength(outboxBefore);

            const rebuiltVal = (await env.stockStore.listStockValuations()).find(
              (v) => v.productId === prod.id,
            );
            const rebuiltBatches = await env.stockStore.listBatches({
              productId: prod.id,
              includeEmpty: true,
              limit: 200,
            });

            expect(rebuiltVal?.qtyOnHand).toBe(liveVal?.qtyOnHand);
            expect(rebuiltVal?.totalValue).toBe(liveVal?.totalValue);
            expect(rebuiltVal?.deficitQty).toBe(liveVal?.deficitQty);
            expect(rebuiltVal?.provisionalDeficitValue).toBe(liveVal?.provisionalDeficitValue);
            expect(rebuiltVal?.costVarianceValue).toBe(liveVal?.costVarianceValue);
            expect(rebuiltBatches.map((b) => [b.id, b.remainingQty, b.remainingValue])).toEqual(
              liveBatches.map((b) => [b.id, b.remainingQty, b.remainingValue]),
            );
          } finally {
            env.connection.close();
          }
        },
      ),
      { numRuns: 25 },
    );
  }, 30_000);
});
