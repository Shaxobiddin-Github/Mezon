import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  DomainError,
  type PinHasher,
  type UuidV7,
  ZERO_MONEY,
  moneyFromTiyin,
  parseUuidV7,
  quantityFromMilli,
  unixMsFromBigInt,
} from '@mezon/domain';
import { FixedClock, SeededRandomSource } from '@mezon/test-utils';
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import {
  type SqliteCartStore,
  type SqliteCatalogStore,
  type SqliteSaleStore,
  type SqliteStockStore,
  createSqliteCartStore,
  createSqliteCatalogStore,
  createSqliteHubAuthStore,
  createSqliteSaleStore,
  createSqliteStockStore,
  insertMonotone,
  listAllOutboxRecordsSync,
  localCarts,
  migrateLocalDatabase,
  openLocalSqliteDatabase,
  payments,
  readReceiptSeqSync,
  saleLines,
  sales,
  stockMoves,
} from './index.js';

const FAST_TEST_HASHER: PinHasher = {
  hash: (pin) => Promise.resolve(`$stub$${pin}`),
  verify: (hash, pin) => Promise.resolve(hash === `$stub$${pin}`),
};

const tempDirs: string[] = [];

function createTempDbPath(name = 'sale.db'): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mezon-sale-'));
  tempDirs.push(dir);
  return path.join(dir, name);
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

async function setupSaleEnv(dbPath = createTempDbPath()) {
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

  return {
    dbPath,
    clock,
    random,
    connection,
    authStore,
    catalogStore,
    stockStore,
    cartStore,
    saleStore,
    organizationId: setup.organizationId,
    storeId: setup.storeId,
    deviceId: setup.deviceId,
    ownerId: setup.owner.id,
    managerId: manager.id,
    cashierId: cashier.id,
  };
}

describe('@mezon/db-local - T1.4 completeSale atomic TX, receipts, stock policy, idempotency, crash & perf', () => {
  it('writes MONOTONE sale, FACT sale_lines/payments, FIFO stock_moves & outbox atomically, keeps snapshot immutable, and enforces MONOTONE/FACT triggers', async () => {
    const env = await setupSaleEnv();
    try {
      // 1) Seed FIFO batched product, average product, unlimited service product
      const coffee = await env.catalogStore.createProduct({
        name: 'Arabika Qahva',
        unit: 'kg',
        salePrice: '100000', // 1000 som / kg
        mxik: '09012100001000000',
        packageCode: 'PKG01',
        vatRateBp: 1200,
        trackBatches: true,
        actorUserId: env.ownerId,
      });
      // Batch 1: 2 kg @ 60,000/kg -> cost 120,000; Batch 2: 3 kg @ 80,000/kg -> cost 240,000
      await env.stockStore.recordInboundMove({
        productId: coffee.product.id,
        reason: 'purchase',
        qty: '2000',
        totalCostValue: '120000',
        batchNumber: 'B-1',
        actorUserId: env.ownerId,
      });
      env.clock.advance(1_000n);
      await env.stockStore.recordInboundMove({
        productId: coffee.product.id,
        reason: 'purchase',
        qty: '3000',
        totalCostValue: '240000',
        batchNumber: 'B-2',
        actorUserId: env.ownerId,
      });

      const bag = await env.catalogStore.createProduct({
        name: 'Yetkazib berish xizmati',
        unit: 'dona',
        unlimited: true,
        salePrice: '50000',
        vatRateBp: 0,
        actorUserId: env.ownerId,
      });

      // Set 10% cashier limit
      await env.cartStore.updateDiscountSettings({
        cashierDiscountLimit: {
          percentUnlimited: false,
          maxPercentBp: 1_000n,
          amountUnlimited: true,
          maxAmount: ZERO_MONEY,
        },
        quickSaleDefaultMxik: null,
        quickSaleDefaultVatRateBp: null,
      });

      // Open cart with 2.5 kg batched coffee + 1 unlimited service + 1 quick_sale item
      const cart = await env.cartStore.openCart(env.cashierId);
      await env.cartStore.addLine(cart.id, {
        kind: 'catalog',
        productId: coffee.product.id,
        variantId: null,
        qty: quantityFromMilli(2_500n),
      });
      await env.cartStore.addLine(cart.id, {
        kind: 'catalog',
        productId: bag.product.id,
        variantId: null,
        qty: quantityFromMilli(1_000n),
      });
      await env.cartStore.addLine(cart.id, {
        kind: 'quick_sale',
        name: 'Maxsus qadoq',
        unit: 'dona',
        qty: quantityFromMilli(1_000n),
        unitPrice: moneyFromTiyin(50_000n),
        mxik: null,
        packageCode: null,
        vatRateBp: 0,
      });

      // Total gross = 250,000 + 50,000 + 50,000 = 350,000. 10% manual discount = 35,000 -> total 315,000
      const discounted = await env.cartStore.setDiscount(cart.id, {
        mode: 'percent',
        percentBp: 1_000,
        reason: 'Doimiy mijoz 10%',
        approvedSupervisorUserId: null,
      });
      expect(discounted.totalFinal).toBe(moneyFromTiyin(315_000n));

      const outboxCountBefore = listAllOutboxRecordsSync(env.connection.db).length;
      const reqId = parseUuidV7('01950000-0000-7000-8000-111111111111');

      const completed = await env.saleStore.completeSale({
        cartId: cart.id,
        actorUserId: env.cashierId,
        clientRequestId: reqId,
        expectedTotal: moneyFromTiyin(315_000n),
        payments: [{ method: 'cash', tenderedAmount: moneyFromTiyin(400_000n) }],
      });

      expect(completed.idempotentReplay).toBe(false);
      expect(completed.warnings).toEqual([]);
      expect(completed.sale.receiptNo).toBe(1n);
      expect(completed.sale.receiptCode).toBe(`${env.deviceId.slice(-4).toUpperCase()}-000001`);
      expect(completed.sale.totalFinal).toBe(moneyFromTiyin(315_000n));
      expect(completed.sale.totalPaid).toBe(moneyFromTiyin(315_000n));
      expect(completed.sale.debtAmount).toBe(ZERO_MONEY);
      expect(completed.sale.changeAmount).toBe(moneyFromTiyin(85_000n));
      expect(completed.sale.lines.length).toBe(3);

      // Verify exact FIFO COGS on line 0: 2 kg @ 60k (120,000) + 0.5 kg @ 80k (40,000) = 160,000
      expect(completed.sale.lines[0]?.costValue).toBe(moneyFromTiyin(160_000n));
      expect(completed.sale.lines[0]?.mxikSnapshot).toBe('09012100001000000');
      expect(completed.sale.lines[0]?.packageCodeSnapshot).toBe('PKG01');
      // Unlimited & quick_sale lines do not track stock -> costValue = 0
      expect(completed.sale.lines[1]?.costValue).toBe(ZERO_MONEY);
      expect(completed.sale.lines[2]?.costValue).toBe(ZERO_MONEY);

      // Balance left for coffee: 2.5 kg remaining @ 80k/kg = 200,000
      const valuation = await env.stockStore.listCashierBalances();
      const coffeeBal = valuation.find((b) => b.productId === coffee.product.id);
      expect(coffeeBal?.qtyOnHand).toBe(quantityFromMilli(2_500n));

      // Cart excluded from active carts list and transitions reject non-open mutations with CART_NOT_OPEN
      expect((await env.cartStore.listCarts()).length).toBe(0);
      await expect(env.cartStore.deleteCart(cart.id)).rejects.toMatchObject({
        code: 'CART_NOT_OPEN',
      });
      await expect(
        env.saleStore.completeSale({
          cartId: cart.id,
          actorUserId: env.cashierId,
          clientRequestId: parseUuidV7('01950000-0000-7000-8000-111111111112'),
          expectedTotal: moneyFromTiyin(315_000n),
          payments: [{ method: 'cash', tenderedAmount: moneyFromTiyin(315_000n) }],
        }),
      ).rejects.toMatchObject({ code: 'CART_NOT_OPEN' });

      // Outbox records: 1 sale.completed + 3 sale_line.created + 2 stock_move.created (FIFO split) + 1 payment.created = 7
      const allOutbox = listAllOutboxRecordsSync(env.connection.db);
      expect(allOutbox.length - outboxCountBefore).toBe(7);
      expect(readReceiptSeqSync(env.connection.db, env.deviceId)).toBe(1n);

      // Snapshot immutability: editing product name/price/MXIK afterward must not change sale_lines
      await env.catalogStore.updateProduct(coffee.product.id, {
        name: 'Changed Qahva',
        salePrice: '999000',
        mxik: '99999999999999999',
        actorUserId: env.ownerId,
      });
      const persistedLine = env.connection.db
        .select()
        .from(saleLines)
        .where(eq(saleLines.saleId, completed.sale.id))
        .all()[0];
      expect(persistedLine?.itemName).toBe('Arabika Qahva');
      expect(persistedLine?.unitPriceSnapshot).toBe(100_000n);
      expect(persistedLine?.mxikSnapshot).toBe('09012100001000000');

      // MONOTONE and FACT SQLite triggers reject mutations & physical deletes, permitting only 1-way void
      expect(() =>
        env.connection.sqlite.prepare('DELETE FROM "sales" WHERE "id" = ?').run(completed.sale.id),
      ).toThrow(/forbids physical DELETE/);
      expect(() =>
        env.connection.sqlite
          .prepare('UPDATE "sales" SET "total_final" = 1 WHERE "id" = ?')
          .run(completed.sale.id),
      ).toThrow(/forbids updating immutable receipt fields/);
      expect(() =>
        env.connection.sqlite
          .prepare('UPDATE "sale_lines" SET "item_name" = \'Hacked\' WHERE "sale_id" = ?')
          .run(completed.sale.id),
      ).toThrow(/UPDATE is forbidden/);
      expect(() =>
        env.connection.sqlite
          .prepare('DELETE FROM "payments" WHERE "sale_id" = ?')
          .run(completed.sale.id),
      ).toThrow(/forbids physical DELETE/);

      // Allowed 1-way void transition succeeds once, then second UPDATE (even to void_reason) is blocked permanently
      env.connection.sqlite
        .prepare(
          'UPDATE "sales" SET "voided_at_ms" = 1760000099000, "voided_by_user_id" = ?, "void_reason" = \'Test void\', "updated_at_ms" = 1760000099000 WHERE "id" = ?',
        )
        .run(env.ownerId, completed.sale.id);
      expect(() =>
        env.connection.sqlite
          .prepare('UPDATE "sales" SET "void_reason" = \'Modified after void\' WHERE "id" = ?')
          .run(completed.sale.id),
      ).toThrow(/cannot be modified once voided/);
      expect(() =>
        env.connection.sqlite
          .prepare(
            'UPDATE "sales" SET "voided_at_ms" = NULL, "voided_by_user_id" = NULL WHERE "id" = ?',
          )
          .run(completed.sale.id),
      ).toThrow(/forbids updating immutable receipt fields/);
    } finally {
      env.connection.close();
    }
  });

  it('recomputes server totals (409 SALE_TOTAL_CHANGED on expired/started promo), checks override/empty/parked, and rolls back block shortages (incl. duplicate lines) cleanly before retry', async () => {
    const env = await setupSaleEnv();
    try {
      await env.stockStore.setNegativeStockPolicy('block');

      const tea = await env.catalogStore.createProduct({
        name: "Ko'k choy",
        unit: 'dona',
        salePrice: '100000',
        actorUserId: env.ownerId,
      });
      await env.stockStore.recordInboundMove({
        productId: tea.product.id,
        reason: 'purchase',
        qty: '5000', // only 5 available
        totalCostValue: '300000',
        actorUserId: env.ownerId,
      });

      const promoEnds = unixMsFromBigInt(1_760_000_060_000n);
      await env.cartStore.createPromotion({
        storeId: null,
        name: 'Flash 20%',
        type: 'percent',
        scope: 'product',
        targetProductId: tea.product.id,
        targetCategoryId: null,
        discountPercentBp: 2_000,
        discountAmount: null,
        buyQty: null,
        freeQty: null,
        startsAtMs: unixMsFromBigInt(1_759_999_000_000n),
        endsAtMs: promoEnds,
        isActive: true,
      });

      const emptyCart = await env.cartStore.openCart(env.cashierId);
      await expect(
        env.saleStore.completeSale({
          cartId: emptyCart.id,
          actorUserId: env.cashierId,
          clientRequestId: parseUuidV7('01950000-0000-7000-8000-222222222201'),
          expectedTotal: ZERO_MONEY,
          payments: [{ method: 'cash', tenderedAmount: ZERO_MONEY }],
        }),
      ).rejects.toMatchObject({ code: 'CART_EMPTY' });

      // Parked cart cannot be completed until resumed
      await env.cartStore.addLine(emptyCart.id, {
        kind: 'catalog',
        productId: tea.product.id,
        variantId: null,
        qty: quantityFromMilli(3_000n),
      });
      await env.cartStore.parkCart(emptyCart.id, 'Kechiktirilgan');
      await expect(
        env.saleStore.completeSale({
          cartId: emptyCart.id,
          actorUserId: env.cashierId,
          clientRequestId: parseUuidV7('01950000-0000-7000-8000-222222222202'),
          expectedTotal: moneyFromTiyin(240_000n),
          payments: [{ method: 'cash', tenderedAmount: moneyFromTiyin(240_000n) }],
        }),
      ).rejects.toMatchObject({ code: 'CART_NOT_OPEN' });

      await env.cartStore.resumeCart(emptyCart.id);

      // Clock crosses promo expiration -> expectedTotal 240,000 stale -> 409 SALE_TOTAL_CHANGED with updated 300,000
      env.clock.set(1_760_000_060_000n);
      let caughtTotalChanged: unknown;
      try {
        await env.saleStore.completeSale({
          cartId: emptyCart.id,
          actorUserId: env.cashierId,
          clientRequestId: parseUuidV7('01950000-0000-7000-8000-222222222203'),
          expectedTotal: moneyFromTiyin(240_000n),
          payments: [{ method: 'cash', tenderedAmount: moneyFromTiyin(300_000n) }],
        });
      } catch (err) {
        caughtTotalChanged = err;
      }
      expect(caughtTotalChanged).toBeInstanceOf(DomainError);
      expect((caughtTotalChanged as DomainError).code).toBe('SALE_TOTAL_CHANGED');
      expect((caughtTotalChanged as DomainError).details).toMatchObject({
        expectedTotal: '240000',
        actualTotal: '300000',
      });
      expect(readReceiptSeqSync(env.connection.db, env.deviceId)).toBe(0n);

      // Add 2nd line of SAME product at different snapshot price (3 + 4 = 7 > 5 available -> cumulative shortage!)
      await env.catalogStore.updateProduct(tea.product.id, {
        salePrice: '110000',
        actorUserId: env.ownerId,
      });
      const twoLineCart = await env.cartStore.addLine(emptyCart.id, {
        kind: 'catalog',
        productId: tea.product.id,
        variantId: null,
        qty: quantityFromMilli(4_000n),
      });
      expect(twoLineCart.totalFinal).toBe(moneyFromTiyin(740_000n));

      const blockClientReqId = parseUuidV7('01950000-0000-7000-8000-222222222204');
      const outboxBeforeBlock = listAllOutboxRecordsSync(env.connection.db).length;

      let caughtStock: unknown;
      try {
        await env.saleStore.completeSale({
          cartId: emptyCart.id,
          actorUserId: env.cashierId,
          clientRequestId: blockClientReqId,
          expectedTotal: moneyFromTiyin(740_000n),
          payments: [{ method: 'cash', tenderedAmount: moneyFromTiyin(740_000n) }],
        });
      } catch (err) {
        caughtStock = err;
      }
      expect(caughtStock).toBeInstanceOf(DomainError);
      expect((caughtStock as DomainError).code).toBe('INSUFFICIENT_STOCK');
      const insufficientLines = ((caughtStock as DomainError).details?.insufficientLines ??
        []) as readonly {
        readonly productId: string;
        readonly requestedQty: string;
        readonly availableQty: string;
        readonly deficitQty: string;
      }[];
      expect(insufficientLines.length).toBe(1);
      expect(insufficientLines[0]).toMatchObject({
        productId: tea.product.id,
        requestedQty: '4000',
        availableQty: '2000',
        deficitQty: '2000',
      });

      // Full rollback verified: 0 sales, 0 moves emitted, 0 outbox, receipt_no NOT consumed, cart still open
      expect(env.connection.db.select().from(sales).all().length).toBe(0);
      expect(listAllOutboxRecordsSync(env.connection.db).length).toBe(outboxBeforeBlock);
      expect(readReceiptSeqSync(env.connection.db, env.deviceId)).toBe(0n);
      expect((await env.cartStore.getCart(emptyCart.id)).status).toBe('open');

      // Restock +2 and retry with SAME blockClientReqId -> now succeeds cleanly with receiptNo = 1!
      await env.stockStore.recordInboundMove({
        productId: tea.product.id,
        reason: 'purchase',
        qty: '2000',
        totalCostValue: '120000',
        actorUserId: env.ownerId,
      });
      const retried = await env.saleStore.completeSale({
        cartId: emptyCart.id,
        actorUserId: env.cashierId,
        clientRequestId: blockClientReqId,
        expectedTotal: moneyFromTiyin(740_000n),
        payments: [{ method: 'cash', tenderedAmount: moneyFromTiyin(750_000n) }],
      });
      expect(retried.idempotentReplay).toBe(false);
      expect(retried.sale.receiptNo).toBe(1n);
      expect(retried.sale.changeAmount).toBe(moneyFromTiyin(10_000n));
      expect(readReceiptSeqSync(env.connection.db, env.deviceId)).toBe(1n);
    } finally {
      env.connection.close();
    }
  });

  it('supports warn-mode negative stock, idempotent replay (including warnings & zero duplicates), and parallel execution races (1 sale max)', async () => {
    const env = await setupSaleEnv();
    try {
      await env.stockStore.setNegativeStockPolicy('warn');

      const sugar = await env.catalogStore.createProduct({
        name: 'Shakar',
        unit: 'kg',
        salePrice: '150000',
        actorUserId: env.ownerId,
      });

      // Warn mode on 0 stock -> completes and persists warning snapshot for replay
      const cart1 = await env.cartStore.openCart(env.cashierId);
      await env.cartStore.addLine(cart1.id, {
        kind: 'catalog',
        productId: sugar.product.id,
        variantId: null,
        qty: quantityFromMilli(1_500n),
      });
      const reqId1 = parseUuidV7('01950000-0000-7000-8000-333333333301');
      const first = await env.saleStore.completeSale({
        cartId: cart1.id,
        actorUserId: env.cashierId,
        clientRequestId: reqId1,
        expectedTotal: moneyFromTiyin(225_000n),
        payments: [{ method: 'cash', tenderedAmount: moneyFromTiyin(250_000n) }],
      });
      expect(first.idempotentReplay).toBe(false);
      expect(first.warnings).toEqual([
        {
          code: 'NEGATIVE_STOCK',
          productId: sugar.product.id,
          variantId: null,
          deficitQty: quantityFromMilli(1_500n),
        },
      ]);

      // Sequential double-click with identical clientRequestId returns identical snapshot & warnings
      const outboxBeforeReplay = listAllOutboxRecordsSync(env.connection.db).length;
      const replay = await env.saleStore.completeSale({
        cartId: cart1.id,
        actorUserId: env.cashierId,
        clientRequestId: reqId1,
        expectedTotal: moneyFromTiyin(225_000n),
        payments: [{ method: 'cash', tenderedAmount: moneyFromTiyin(250_000n) }],
      });
      expect(replay.idempotentReplay).toBe(true);
      expect(replay.sale.id).toBe(first.sale.id);
      expect(replay.sale.receiptNo).toBe(1n);
      expect(replay.warnings).toEqual(first.warnings);
      expect(listAllOutboxRecordsSync(env.connection.db).length).toBe(outboxBeforeReplay);
      expect(readReceiptSeqSync(env.connection.db, env.deviceId)).toBe(1n);

      // Reusing same clientRequestId against another cart raises IDEMPOTENCY_CONFLICT
      const cart2 = await env.cartStore.openCart(env.cashierId);
      await env.cartStore.addLine(cart2.id, {
        kind: 'catalog',
        productId: sugar.product.id,
        variantId: null,
        qty: quantityFromMilli(1_000n),
      });
      await expect(
        env.saleStore.completeSale({
          cartId: cart2.id,
          actorUserId: env.cashierId,
          clientRequestId: reqId1,
          expectedTotal: moneyFromTiyin(150_000n),
          payments: [{ method: 'cash', tenderedAmount: moneyFromTiyin(150_000n) }],
        }),
      ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });

      // Parallel race on cart2: 3 same-id requests + 2 distinct-id requests concurrently -> strictly 1 new sale (total 2)!
      const raceId = parseUuidV7('01950000-0000-7000-8000-333333333302');
      const altId1 = parseUuidV7('01950000-0000-7000-8000-333333333303');
      const altId2 = parseUuidV7('01950000-0000-7000-8000-333333333304');

      const settled = await Promise.allSettled([
        env.saleStore.completeSale({
          cartId: cart2.id,
          actorUserId: env.cashierId,
          clientRequestId: raceId,
          expectedTotal: moneyFromTiyin(150_000n),
          payments: [{ method: 'cash', tenderedAmount: moneyFromTiyin(150_000n) }],
        }),
        env.saleStore.completeSale({
          cartId: cart2.id,
          actorUserId: env.cashierId,
          clientRequestId: raceId,
          expectedTotal: moneyFromTiyin(150_000n),
          payments: [{ method: 'cash', tenderedAmount: moneyFromTiyin(150_000n) }],
        }),
        env.saleStore.completeSale({
          cartId: cart2.id,
          actorUserId: env.cashierId,
          clientRequestId: altId1,
          expectedTotal: moneyFromTiyin(150_000n),
          payments: [{ method: 'cash', tenderedAmount: moneyFromTiyin(150_000n) }],
        }),
        env.saleStore.completeSale({
          cartId: cart2.id,
          actorUserId: env.cashierId,
          clientRequestId: altId2,
          expectedTotal: moneyFromTiyin(150_000n),
          payments: [{ method: 'cash', tenderedAmount: moneyFromTiyin(150_000n) }],
        }),
        env.saleStore.completeSale({
          cartId: cart2.id,
          actorUserId: env.cashierId,
          clientRequestId: raceId,
          expectedTotal: moneyFromTiyin(150_000n),
          payments: [{ method: 'cash', tenderedAmount: moneyFromTiyin(150_000n) }],
        }),
      ]);

      const salesInDb = env.connection.db.select().from(sales).all();
      expect(salesInDb.length).toBe(2);
      const fulfilled = settled.filter((r) => r.status === 'fulfilled');
      const rejected = settled.filter((r) => r.status === 'rejected');
      expect(fulfilled.length).toBe(3); // raceId wins once + 2 idempotent replays
      expect(rejected.length).toBe(2); // altId1 & altId2 get CART_NOT_OPEN
      for (const r of rejected) {
        expect(r.reason).toMatchObject({ code: 'CART_NOT_OPEN' });
      }
      expect(readReceiptSeqSync(env.connection.db, env.deviceId)).toBe(2n);
    } finally {
      env.connection.close();
    }
  });

  it('C1 crash safety: child process killed mid-transaction (before COMMIT) leaves zero partial rows/receipts, env vars cannot arm crash hook, and retry succeeds cleanly', async () => {
    const dbPath = createTempDbPath('crash-recovery.db');
    const env = await setupSaleEnv(dbPath);
    const prod = await env.catalogStore.createProduct({
      name: 'Un 5kg',
      unit: 'dona',
      salePrice: '450000',
      actorUserId: env.ownerId,
    });
    await env.stockStore.recordInboundMove({
      productId: prod.product.id,
      reason: 'purchase',
      qty: '10000',
      totalCostValue: '3000000',
      actorUserId: env.ownerId,
    });
    const cart = await env.cartStore.openCart(env.cashierId);
    await env.cartStore.addLine(cart.id, {
      kind: 'catalog',
      productId: prod.product.id,
      variantId: null,
      qty: quantityFromMilli(2_000n),
    });

    const baselineOutboxCount = listAllOutboxRecordsSync(env.connection.db).length;
    const reqId = parseUuidV7('01950000-0000-7000-8000-444444444401');

    // Proof C1: setting env vars must NEVER crash a store created without __testHooks
    const prevEnv = process.env.MEZON_TEST_CRASH_BEFORE_COMMIT;
    process.env.MEZON_TEST_CRASH_BEFORE_COMMIT = '1';
    try {
      // Negative check using non-committing insufficient cash shows env never fires crash
      await expect(
        env.saleStore.completeSale({
          cartId: cart.id,
          actorUserId: env.cashierId,
          clientRequestId: reqId,
          expectedTotal: moneyFromTiyin(900_000n),
          payments: [{ method: 'cash', tenderedAmount: moneyFromTiyin(100_000n) }],
        }),
      ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    } finally {
      if (prevEnv === undefined) {
        delete process.env.MEZON_TEST_CRASH_BEFORE_COMMIT;
      } else {
        process.env.MEZON_TEST_CRASH_BEFORE_COMMIT = prevEnv;
      }
      env.connection.close();
    }

    // Build an isolated child Node ESM script importing built packages and injecting __testHooks
    const dbLocalUrl = pathToFileURL(
      path.resolve(import.meta.dirname, '..', 'dist', 'index.js'),
    ).href;
    const domainUrl = pathToFileURL(
      path.resolve(import.meta.dirname, '..', '..', 'domain', 'dist', 'index.js'),
    ).href;
    const testUtilsUrl = pathToFileURL(
      path.resolve(import.meta.dirname, '..', '..', 'test-utils', 'dist', 'index.js'),
    ).href;

    const workerPath = path.join(path.dirname(dbPath), 'crash-worker.mjs');
    fs.writeFileSync(
      workerPath,
      [
        `import { openLocalSqliteDatabase, createSqliteHubAuthStore, createSqliteSaleStore } from ${JSON.stringify(dbLocalUrl)};`,
        `import { moneyFromTiyin, parseUuidV7 } from ${JSON.stringify(domainUrl)};`,
        `import { FixedClock, SeededRandomSource } from ${JSON.stringify(testUtilsUrl)};`,
        '',
        'const [dbPath, cartId, actorId, clientReqId] = process.argv.slice(2);',
        'const clock = new FixedClock(1_760_000_000_000n);',
        'const random = new SeededRandomSource(91);',
        'const conn = openLocalSqliteDatabase(dbPath);',
        'const auth = await createSqliteHubAuthStore({ connection: conn, clock, random });',
        'const saleStore = createSqliteSaleStore({',
        '  connection: conn,',
        '  getRuntimeContext: () => {',
        '    const ctx = auth.getActiveRuntimeContext();',
        '    return ctx ? { uow: ctx.uow, organizationId: ctx.config.organizationId, storeId: ctx.config.storeId } : null;',
        '  },',
        '  __testHooks: {',
        '    onBeforeCommit: () => {',
        '      // Crash mid-transaction after sales/lines/payments/stock_moves/outbox SQL inserts, before COMMIT',
        '      process.exit(42);',
        '    },',
        '  },',
        '});',
        'await saleStore.completeSale({',
        '  cartId: parseUuidV7(cartId),',
        '  actorUserId: parseUuidV7(actorId),',
        '  clientRequestId: parseUuidV7(clientReqId),',
        '  expectedTotal: moneyFromTiyin(900_000n),',
        '  payments: [{ method: "cash", tenderedAmount: moneyFromTiyin(1_000_000n) }],',
        '});',
      ].join('\n'),
      'utf8',
    );

    const child = spawnSync(process.execPath, [workerPath, dbPath, cart.id, env.cashierId, reqId], {
      encoding: 'utf8',
      timeout: 15_000,
    });
    expect(child.status).toBe(42);

    // Parent reopens DB and asserts 0 partial sales/lines/payments/stock_moves/outbox & open cart
    const reopened = await setupSaleEnvReadExisting(dbPath);
    try {
      expect(reopened.connection.db.select().from(sales).all().length).toBe(0);
      expect(reopened.connection.db.select().from(saleLines).all().length).toBe(0);
      expect(reopened.connection.db.select().from(payments).all().length).toBe(0);
      expect(listAllOutboxRecordsSync(reopened.connection.db).length).toBe(baselineOutboxCount);
      expect(readReceiptSeqSync(reopened.connection.db, reopened.deviceId)).toBe(0n);

      const cartAfterCrash = reopened.connection.db
        .select()
        .from(localCarts)
        .where(eq(localCarts.id, cart.id))
        .all()[0];
      expect(cartAfterCrash?.status).toBe('open');
      expect(cartAfterCrash?.completedSaleId).toBeNull();

      // Stock still 10 units
      const bal = await reopened.stockStore.listCashierBalances();
      expect(bal.find((b) => b.productId === prod.product.id)?.qtyOnHand).toBe(
        quantityFromMilli(10_000n),
      );

      // Re-trying the sale succeeds cleanly with receiptNo = 1!
      const cleanRetry = await reopened.saleStore.completeSale({
        cartId: cart.id,
        actorUserId: env.cashierId,
        clientRequestId: reqId,
        expectedTotal: moneyFromTiyin(900_000n),
        payments: [{ method: 'cash', tenderedAmount: moneyFromTiyin(1_000_000n) }],
      });
      expect(cleanRetry.sale.receiptNo).toBe(1n);
      expect(cleanRetry.sale.changeAmount).toBe(moneyFromTiyin(100_000n));
      expect(readReceiptSeqSync(reopened.connection.db, reopened.deviceId)).toBe(1n);
    } finally {
      reopened.connection.close();
    }
  }, 30_000);

  it('meets <= 300ms local completion target for a 20-line tracked catalog cart on disk WAL SQLite', async () => {
    const dbPath = createTempDbPath('perf-20-lines.db');
    const env = await setupSaleEnv(dbPath);
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
  });

  it('T1.4 debt (1): block mode enforces exact 1-milli threshold across single & multi-line carts without partial writes', async () => {
    const env = await setupSaleEnv();
    try {
      await env.stockStore.setNegativeStockPolicy('block');
      const sugar = await env.catalogStore.createProduct({
        name: 'Shakar',
        unit: 'kg',
        trackBatches: false,
        salePrice: '15000',
        vatRateBp: 0,
        actorUserId: env.ownerId,
      });
      await env.stockStore.recordInboundMove({
        productId: sugar.product.id,
        reason: 'initial',
        qty: '5000', // exactly 5.000 kg
        totalCostValue: '50000',
        actorUserId: env.ownerId,
      });

      const snapshotBeforeReject = () => ({
        salesCount: env.connection.db.select().from(sales).all().length,
        linesCount: env.connection.db.select().from(saleLines).all().length,
        paymentsCount: env.connection.db.select().from(payments).all().length,
        movesCount: env.connection.db.select().from(stockMoves).all().length,
        outboxCount: listAllOutboxRecordsSync(env.connection.db).length,
        receiptSeq: readReceiptSeqSync(env.connection.db, env.deviceId),
      });

      // 5.001 kg in one line MUST fail (1 milli short) and write nothing
      const overSingle = await env.cartStore.openCart(env.cashierId);
      const overSingleDetail = await env.cartStore.addLine(overSingle.id, {
        kind: 'catalog',
        productId: sugar.product.id,
        variantId: null,
        qty: quantityFromMilli(5_001n),
      });
      const beforeSingle = snapshotBeforeReject();
      await expect(
        env.saleStore.completeSale({
          cartId: overSingle.id,
          actorUserId: env.cashierId,
          clientRequestId: parseUuidV7('01950000-0000-7000-8000-666666666601'),
          expectedTotal: overSingleDetail.totalFinal,
          payments: [{ method: 'cash', tenderedAmount: overSingleDetail.totalFinal }],
        }),
      ).rejects.toMatchObject({ code: 'INSUFFICIENT_STOCK' });
      expect(snapshotBeforeReject()).toEqual(beforeSingle);

      // 3.000 kg + 2.001 kg = 5.001 kg across two lines of same product MUST also fail and write nothing
      const overSplit = await env.cartStore.openCart(env.cashierId);
      await env.cartStore.addLine(overSplit.id, {
        kind: 'catalog',
        productId: sugar.product.id,
        variantId: null,
        qty: quantityFromMilli(3_000n),
      });
      const overSplitDetail = await env.cartStore.addLine(overSplit.id, {
        kind: 'catalog',
        productId: sugar.product.id,
        variantId: null,
        qty: quantityFromMilli(2_001n),
      });
      await expect(
        env.saleStore.completeSale({
          cartId: overSplit.id,
          actorUserId: env.cashierId,
          clientRequestId: parseUuidV7('01950000-0000-7000-8000-666666666602'),
          expectedTotal: overSplitDetail.totalFinal,
          payments: [{ method: 'cash', tenderedAmount: overSplitDetail.totalFinal }],
        }),
      ).rejects.toMatchObject({ code: 'INSUFFICIENT_STOCK' });
      expect(snapshotBeforeReject()).toEqual(beforeSingle);

      // Exact 5.000 kg succeeds and leaves 0.000 kg stock
      const exactCart = await env.cartStore.openCart(env.cashierId);
      const exactDetail = await env.cartStore.addLine(exactCart.id, {
        kind: 'catalog',
        productId: sugar.product.id,
        variantId: null,
        qty: quantityFromMilli(5_000n),
      });
      const ok = await env.saleStore.completeSale({
        cartId: exactCart.id,
        actorUserId: env.cashierId,
        clientRequestId: parseUuidV7('01950000-0000-7000-8000-666666666603'),
        expectedTotal: exactDetail.totalFinal,
        payments: [{ method: 'cash', tenderedAmount: exactDetail.totalFinal }],
      });
      expect(ok.sale.receiptNo).toBe(1n);
      const balances = await env.stockStore.listCashierBalances();
      const sugarAfter = balances.find((b) => b.productId === sugar.product.id);
      expect(sugarAfter?.qtyOnHand).toBe(quantityFromMilli(0n));
    } finally {
      env.connection.close();
    }
  });

  it('T1.4 debt (2): clientRequestId used in a different store rejects with IDEMPOTENCY_CONFLICT and writes nothing', async () => {
    const env = await setupSaleEnv();
    try {
      const rice = await env.catalogStore.createProduct({
        name: 'Guruch',
        unit: 'kg',
        trackBatches: false,
        salePrice: '20000',
        vatRateBp: 0,
        actorUserId: env.ownerId,
      });
      await env.stockStore.recordInboundMove({
        productId: rice.product.id,
        reason: 'initial',
        qty: '2000',
        totalCostValue: '24000',
        actorUserId: env.ownerId,
      });

      const sharedClientRequestId = parseUuidV7('01950000-0000-7000-8000-777777777701');
      const otherStoreId = parseUuidV7('01950000-0000-7000-8000-777777777799');
      const ctx = env.authStore.getActiveRuntimeContext()!;

      const cartA = await env.cartStore.openCart(env.cashierId);
      const detailA = await env.cartStore.addLine(cartA.id, {
        kind: 'catalog',
        productId: rice.product.id,
        variantId: null,
        qty: quantityFromMilli(1_000n),
      });

      // Fixture: another store within the same organization already used sharedClientRequestId
      // (with matching sourceCartId to isolate `existingSale.storeId !== ctx.storeId` specifically)
      await ctx.uow.execute((session) => {
        insertMonotone(session, sales, {
          organizationId: env.organizationId,
          storeId: otherStoreId,
          values: {
            receiptNo: 1n,
            receiptCode: 'FFFF-000001',
            sourceCartId: cartA.id,
            cashierUserId: env.cashierId,
            customerId: null,
            shiftId: null,
            clientRequestId: sharedClientRequestId,
            subtotalGross: moneyFromTiyin(20_000n),
            totalPromoDiscount: ZERO_MONEY,
            subtotalAfterPromo: moneyFromTiyin(20_000n),
            manualDiscountMode: 'none',
            manualDiscountValue: 0n,
            manualDiscountReason: null,
            orderDiscountAmount: ZERO_MONEY,
            totalFinal: moneyFromTiyin(20_000n),
            totalNetExVat: moneyFromTiyin(20_000n),
            totalVat: ZERO_MONEY,
            totalPaid: moneyFromTiyin(20_000n),
            debtAmount: ZERO_MONEY,
            changeAmount: ZERO_MONEY,
            overrideApprovedByUserId: null,
            overrideApprovedAmount: null,
            overrideApprovedAtMs: null,
            voidedAtMs: null,
            voidedByUserId: null,
            voidReason: null,
          },
          eventType: 'sale.completed',
          schemaVersion: 1,
        });
        return Promise.resolve();
      });

      const outboxBefore = listAllOutboxRecordsSync(env.connection.db).length;
      const salesBefore = env.connection.db.select().from(sales).all().length;
      const receiptSeqBefore = readReceiptSeqSync(env.connection.db, env.deviceId);

      await expect(
        env.saleStore.completeSale({
          cartId: cartA.id,
          actorUserId: env.cashierId,
          clientRequestId: sharedClientRequestId,
          expectedTotal: detailA.totalFinal,
          payments: [{ method: 'cash', tenderedAmount: detailA.totalFinal }],
        }),
      ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });

      expect(env.connection.db.select().from(sales).all().length).toBe(salesBefore);
      expect(listAllOutboxRecordsSync(env.connection.db).length).toBe(outboxBefore);
      expect(readReceiptSeqSync(env.connection.db, env.deviceId)).toBe(receiptSeqBefore);
      const cartAfter = await env.cartStore.getCart(cartA.id);
      expect(cartAfter.status).toBe('open');
    } finally {
      env.connection.close();
    }
  });
});

async function setupSaleEnvReadExisting(dbPath: string) {
  const clock = new FixedClock(1_760_000_000_000n);
  const random = new SeededRandomSource(91);
  const connection = openLocalSqliteDatabase(dbPath);
  const authStore = await createSqliteHubAuthStore({
    connection,
    clock,
    random,
  });
  const ctx0 = authStore.getActiveRuntimeContext();
  if (!ctx0) {
    throw new Error('Expected active hub runtime context after reopen');
  }
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
  return {
    connection,
    deviceId: ctx0.config.deviceId,
    stockStore: createSqliteStockStore({ connection, getRuntimeContext: getStoreCtx }),
    saleStore: createSqliteSaleStore({ connection, getRuntimeContext: getStoreCtx }),
  };
}
