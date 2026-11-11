import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  DomainError,
  type NonCashPaymentMethod,
  PAYMENT_METHODS,
  type PinHasher,
  type SalePaymentInput,
  type UuidV7,
  ZERO_MONEY,
  createHlcTimestamp,
  moneyFromTiyin,
  moneyToTiyin,
  parseUuidV7,
  quantityFromMilli,
  serializeHlc,
  unixMsFromBigInt,
} from '@mezon/domain';
import { FixedClock, SeededRandomSource } from '@mezon/test-utils';
import { and, asc, eq } from 'drizzle-orm';
import fc from 'fast-check';
import { afterEach, describe, expect, it } from 'vitest';
import {
  type SqliteCartStore,
  type SqliteCatalogStore,
  type SqliteSaleStore,
  type SqliteShiftStore,
  type SqliteStockStore,
  advanceReceiptSeqSync,
  applyOutboundStockMoveSync,
  cashMoves,
  createSqliteCartStore,
  createSqliteCatalogStore,
  createSqliteHubAuthStore,
  createSqliteSaleStore,
  createSqliteShiftStore,
  createSqliteStockStore,
  getActiveShiftDrawerBalanceSync,
  getActiveStoreCashBalanceSync,
  getDefaultLocalMigrationsFolder,
  insertMonotone,
  listAllOutboxRecordsSync,
  localBatchBalances,
  localCarts,
  localDeviceState,
  localStockBalances,
  migrateLocalDatabase,
  openLocalSqliteDatabase,
  payments,
  readReceiptSeqSync,
  saleLines,
  sales,
  shiftCashierSessions,
  shifts,
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
  const shiftStore: SqliteShiftStore = createSqliteShiftStore({
    connection,
    getRuntimeContext: getStoreCtx,
  });
  const initialShift = await shiftStore.openShift({
    actorUserId: cashier.id,
    clientRequestId: parseUuidV7('01950000-0000-7000-8000-0000000000a1'),
    openingCash: ZERO_MONEY,
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
    shiftStore,
    initialShiftId: initialShift.shift.id,
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

      // Outbox records: 1 sale.completed + 3 sale_line.created + 2 stock_move.created (FIFO split) + 1 payment.created + 2 cash_move.created (cash in + change out) = 9
      const allOutbox = listAllOutboxRecordsSync(env.connection.db);
      expect(allOutbox.length - outboxCountBefore).toBe(9);
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

      // Allowed 1-way void transition succeeds once (with required V3 void_client_request_id & void_request_hash),
      // then any subsequent UPDATE (even to void_reason) is blocked permanently
      env.connection.sqlite
        .prepare(
          'UPDATE "sales" SET "voided_at_ms" = 1760000099000, "voided_by_user_id" = ?, "void_reason" = \'Test void\', "void_client_request_id" = ?, "void_request_hash" = \'deadbeef1234\', "updated_at_ms" = 1760000099000 WHERE "id" = ?',
        )
        .run(env.ownerId, parseUuidV7('01950000-0000-7000-8000-000000009901'), completed.sale.id);
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
      ).toThrow(/cannot be modified once voided/);
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
  }, 30_000);

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
            completedByUserId: env.cashierId,
            customerId: null,
            shiftId: null,
            clientRequestId: sharedClientRequestId,
            requestHash: 'fixture-cross-store-hash-0001',
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

  it('T1.5 mixed payments, 2x same non-cash, zero-total=[], cash_moves FACT ledger, M2 terminal vs store balance, request_hash & completedByUserId', async () => {
    const env = await setupSaleEnv();
    try {
      const milk = await env.catalogStore.createProduct({
        name: 'Sut',
        unit: 'dona',
        trackBatches: false,
        salePrice: '12000',
        vatRateBp: 0,
        actorUserId: env.ownerId,
      });
      const bread = await env.catalogStore.createProduct({
        name: 'Non',
        unit: 'dona',
        trackBatches: false,
        salePrice: '8000',
        vatRateBp: 0,
        actorUserId: env.ownerId,
      });
      await env.stockStore.recordInboundMove({
        productId: milk.product.id,
        reason: 'initial',
        qty: '20000',
        totalCostValue: '160000',
        actorUserId: env.ownerId,
      });
      await env.stockStore.recordInboundMove({
        productId: bread.product.id,
        reason: 'initial',
        qty: '20000',
        totalCostValue: '80000',
        actorUserId: env.ownerId,
      });

      // 1) Cashier opens cart, MANAGER completes mixed checkout (2x card + uzqr + payme + click + uzum + social_card + other + cash w/ change)
      // Total = 10 * 12_000 + 10 * 8_000 = 200_000 tiyin
      const cart1 = await env.cartStore.openCart(env.cashierId);
      await env.cartStore.addLine(cart1.id, {
        kind: 'catalog',
        productId: milk.product.id,
        variantId: null,
        qty: quantityFromMilli(10_000n),
      });
      const detail1 = await env.cartStore.addLine(cart1.id, {
        kind: 'catalog',
        productId: bread.product.id,
        variantId: null,
        qty: quantityFromMilli(10_000n),
      });
      expect(detail1.totalFinal).toBe(moneyFromTiyin(200_000n));

      const reqMixedId = parseUuidV7('01950000-0000-7000-8000-888888888801');
      const mixedPayments: SalePaymentInput[] = [
        { method: 'card', amount: moneyFromTiyin(30_000n), providerRef: '  CARD-RRN-1 ' },
        { method: 'card', amount: moneyFromTiyin(20_000n), providerRef: 'CARD-RRN-2' },
        { method: 'uzqr', amount: moneyFromTiyin(15_000n), providerRef: 'UZQR-1' },
        { method: 'payme', amount: moneyFromTiyin(15_000n), providerRef: 'PM-1' },
        { method: 'click', amount: moneyFromTiyin(15_000n), providerRef: 'CL-1' },
        { method: 'uzum', amount: moneyFromTiyin(15_000n), providerRef: 'UZ-1' },
        { method: 'social_card', amount: moneyFromTiyin(20_000n), providerRef: 'SC-1' },
        { method: 'other', amount: moneyFromTiyin(10_000n), providerRef: 'OTH-1' },
        // Remaining for cash = 200_000 - 140_000 = 60_000; tender 100_000 -> change 40_000
        { method: 'cash', tenderedAmount: moneyFromTiyin(100_000n) },
      ];

      const completed = await env.saleStore.completeSale({
        cartId: cart1.id,
        actorUserId: env.managerId,
        clientRequestId: reqMixedId,
        expectedTotal: detail1.totalFinal,
        payments: mixedPayments,
      });

      expect(completed.idempotentReplay).toBe(false);
      expect(completed.sale.cashierUserId).toBe(env.cashierId);
      expect(completed.sale.completedByUserId).toBe(env.managerId);
      expect(completed.sale.totalPaid).toBe(moneyFromTiyin(200_000n));
      expect(completed.sale.changeAmount).toBe(moneyFromTiyin(40_000n));
      expect(completed.sale.payments.length).toBe(9);
      expect(completed.sale.payments[0]?.providerRef).toBe('CARD-RRN-1');
      expect(completed.sale.payments[8]).toMatchObject({
        method: 'cash',
        amount: moneyFromTiyin(60_000n),
        tenderedAmount: moneyFromTiyin(100_000n),
        changeAmount: moneyFromTiyin(40_000n),
      });

      // Verify cash_moves FACT entries: +100_000 tendered, -40_000 change -> net +60_000
      const movesForSale = env.connection.db
        .select()
        .from(cashMoves)
        .where(eq(cashMoves.sourceId, completed.sale.id))
        .all();
      expect(movesForSale).toHaveLength(2);
      expect(movesForSale[0]?.type).toBe('sale_cash_in');
      expect(movesForSale[0]?.amountDelta).toBe(moneyFromTiyin(100_000n));
      expect(movesForSale[0]?.createdByUserId).toBe(env.managerId);
      expect(movesForSale[0]?.deviceId).toBe(env.deviceId);
      expect(movesForSale[0]?.shiftId).toBe(env.initialShiftId);
      expect(movesForSale[1]?.type).toBe('sale_change_out');
      expect(movesForSale[1]?.amountDelta).toBe(moneyFromTiyin(-40_000n));
      expect(await env.saleStore.getTerminalCashBalance()).toBe(moneyFromTiyin(60_000n));

      // Verify cash_moves FACT triggers & signed CHECK constraint
      expect(() =>
        env.connection.sqlite
          .prepare('UPDATE "cash_moves" SET "amount_delta" = 999 WHERE "id" = ?')
          .run(movesForSale[0].id),
      ).toThrow(/immutable/);
      expect(() =>
        env.connection.sqlite
          .prepare('DELETE FROM "cash_moves" WHERE "id" = ?')
          .run(movesForSale[0].id),
      ).toThrow(/forbids physical DELETE/);
      expect(() =>
        env.connection.sqlite
          .prepare(
            `INSERT INTO "cash_moves" ("id", "organization_id", "store_id", "device_id", "hlc", "created_at_ms", "shift_id", "type", "amount_delta", "source_type", "source_id", "payment_id", "reason", "created_by_user_id")
             VALUES (?, ?, ?, ?, ?, 1760000000000, NULL, 'sale_cash_in', -500, 'sale', ?, NULL, 'bad sign', ?)`,
          )
          .run(
            parseUuidV7('01950000-0000-7000-8000-dead00000001'),
            env.organizationId,
            env.storeId,
            env.deviceId,
            serializeHlc(createHlcTimestamp(unixMsFromBigInt(1_760_000_000_000n), 0, env.deviceId)),
            completed.sale.id,
            env.ownerId,
          ),
      ).toThrow(/CHECK constraint failed/);

      // MONOTONE immutability protects sales.completed_by_user_id and sales.request_hash even when setting voided_at_ms
      expect(() =>
        env.connection.sqlite
          .prepare(
            'UPDATE "sales" SET "voided_at_ms" = 1760000001000, "voided_by_user_id" = ?, "completed_by_user_id" = ? WHERE "id" = ?',
          )
          .run(env.ownerId, env.ownerId, completed.sale.id),
      ).toThrow(/immutable receipt fields/);
      expect(() =>
        env.connection.sqlite
          .prepare(
            'UPDATE "sales" SET "voided_at_ms" = 1760000001000, "voided_by_user_id" = ?, "request_hash" = ? WHERE "id" = ?',
          )
          .run(env.ownerId, 'tampered-hash-value', completed.sale.id),
      ).toThrow(/immutable receipt fields/);

      // 2) (f.1) Identical retry returns idempotentReplay: true; differing payments on same clientRequestId -> IDEMPOTENCY_CONFLICT
      const replay = await env.saleStore.completeSale({
        cartId: cart1.id,
        actorUserId: env.managerId,
        clientRequestId: reqMixedId,
        expectedTotal: detail1.totalFinal,
        payments: [
          { method: 'card', amount: moneyFromTiyin(30_000n), providerRef: 'CARD-RRN-1' },
          ...mixedPayments.slice(1),
        ],
      });
      expect(replay.idempotentReplay).toBe(true);
      expect(replay.sale.id).toBe(completed.sale.id);

      await expect(
        env.saleStore.completeSale({
          cartId: cart1.id,
          actorUserId: env.managerId,
          clientRequestId: reqMixedId,
          expectedTotal: detail1.totalFinal,
          payments: [
            { method: 'uzum', amount: moneyFromTiyin(30_000n), providerRef: 'CARD-RRN-1' },
            ...mixedPayments.slice(1),
          ],
        }),
      ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });

      // 3) 100%-discounted (zero totalFinal) sale closes cleanly with payments: [] and 0 payments/cash_moves
      const freeCart = await env.cartStore.openCart(env.cashierId);
      await env.cartStore.addLine(freeCart.id, {
        kind: 'catalog',
        productId: bread.product.id,
        variantId: null,
        qty: quantityFromMilli(1_000n),
      });
      const freeDetail = await env.cartStore.setDiscount(freeCart.id, {
        mode: 'percent',
        percentBp: 10_000,
        reason: '100% Promo',
        approvedSupervisorUserId: env.ownerId,
      });
      expect(freeDetail.totalFinal).toBe(ZERO_MONEY);

      // Zero total with non-empty payment MUST reject with VALIDATION_ERROR and 0 writes
      await expect(
        env.saleStore.completeSale({
          cartId: freeCart.id,
          actorUserId: env.cashierId,
          clientRequestId: parseUuidV7('01950000-0000-7000-8000-888888888899'),
          expectedTotal: ZERO_MONEY,
          payments: [{ method: 'cash', tenderedAmount: moneyFromTiyin(1_000n) }],
        }),
      ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });

      const payCountBeforeZero = env.connection.db.select().from(payments).all().length;
      const moveCountBeforeZero = env.connection.db.select().from(cashMoves).all().length;
      const freeCompleted = await env.saleStore.completeSale({
        cartId: freeCart.id,
        actorUserId: env.cashierId,
        clientRequestId: parseUuidV7('01950000-0000-7000-8000-888888888802'),
        expectedTotal: ZERO_MONEY,
        payments: [],
      });
      expect(freeCompleted.sale.totalFinal).toBe(ZERO_MONEY);
      expect(freeCompleted.sale.payments).toEqual([]);
      expect(env.connection.db.select().from(payments).all().length).toBe(payCountBeforeZero);
      expect(env.connection.db.select().from(cashMoves).all().length).toBe(moveCountBeforeZero);

      // 4) Exact-cash payment (change = 0) emits only 1 cash_move (sale_cash_in, no 0-amount change_out)
      const exactCart = await env.cartStore.openCart(env.cashierId);
      const exactDetail = await env.cartStore.addLine(exactCart.id, {
        kind: 'catalog',
        productId: bread.product.id,
        variantId: null,
        qty: quantityFromMilli(2_000n),
      });
      const exactSale = await env.saleStore.completeSale({
        cartId: exactCart.id,
        actorUserId: env.cashierId,
        clientRequestId: parseUuidV7('01950000-0000-7000-8000-888888888803'),
        expectedTotal: exactDetail.totalFinal,
        payments: [{ method: 'cash', tenderedAmount: exactDetail.totalFinal }],
      });
      const exactMoves = env.connection.db
        .select()
        .from(cashMoves)
        .where(eq(cashMoves.sourceId, exactSale.sale.id))
        .all();
      expect(exactMoves).toHaveLength(1);
      expect(exactMoves[0]?.type).toBe('sale_cash_in');
      expect(exactMoves[0]?.amountDelta).toBe(exactDetail.totalFinal);
      // Terminal drawer balance = 60_000 + 16_000 = 76_000
      expect(await env.saleStore.getTerminalCashBalance()).toBe(moneyFromTiyin(76_000n));

      // 5) M2: Another terminal (device B) within same store has its own isolated open shift & cash drawer balance (X1).
      const deviceB = parseUuidV7('01950000-0000-7000-8000-9999999999b2');
      const shiftBId = parseUuidV7('01950000-0000-7000-8000-9999999999b3');
      const sessBId = parseUuidV7('01950000-0000-7000-8000-9999999999b4');
      const ctx = env.authStore.getActiveRuntimeContext()!;
      await ctx.uow.execute((session) => {
        const nowMs = session.nowUnixMs();
        const hlcB = serializeHlc(createHlcTimestamp(nowMs, 0, deviceB));
        session.db
          .insert(localDeviceState)
          .values({
            id: parseUuidV7('01950000-0000-7000-8000-9999999999b5'),
            organizationId: env.organizationId,
            createdAtMs: nowMs,
            updatedAtMs: nowMs,
            deviceId: deviceB,
            lastDeviceSeq: 1n,
            lastHlc: hlcB,
            lastUuidMs: nowMs,
          })
          .run();
        session.db
          .insert(shifts)
          .values({
            id: shiftBId,
            organizationId: env.organizationId,
            storeId: env.storeId,
            deviceId: deviceB,
            hlc: hlcB,
            createdAtMs: nowMs,
            updatedAtMs: nowMs,
            shiftNo: 1n,
            shiftCode: 'SHF-99B2-000001',
            status: 'open',
            openedByUserId: env.ownerId,
            openingCash: ZERO_MONEY,
            openingDiscrepancy: ZERO_MONEY,
            openedAtMs: nowMs,
            openClientRequestId: parseUuidV7('01950000-0000-7000-8000-9999999999b6'),
            openRequestHash: 'device-b-open-hash',
          })
          .run();
        session.db
          .insert(shiftCashierSessions)
          .values({
            id: sessBId,
            organizationId: env.organizationId,
            storeId: env.storeId,
            deviceId: deviceB,
            hlc: hlcB,
            createdAtMs: nowMs,
            updatedAtMs: nowMs,
            shiftId: shiftBId,
            sessionSeq: 1,
            cashierUserId: env.ownerId,
            status: 'active',
            openingFloat: ZERO_MONEY,
            startedAtMs: nowMs,
          })
          .run();
        session.db
          .insert(cashMoves)
          .values({
            id: parseUuidV7('01950000-0000-7000-8000-9999999999c1'),
            organizationId: env.organizationId,
            storeId: env.storeId,
            deviceId: deviceB,
            hlc: hlcB,
            createdAtMs: nowMs,
            shiftId: shiftBId,
            shiftCashierSessionId: sessBId,
            type: 'cash_in',
            amountDelta: moneyFromTiyin(50_000n),
            sourceType: 'manual',
            sourceId: parseUuidV7('01950000-0000-7000-8000-9999999999c2'),
            paymentId: null,
            expenseCategory: null,
            reason: 'Device B float',
            createdByUserId: env.ownerId,
          })
          .run();
        return Promise.resolve();
      });

      expect(
        getActiveShiftDrawerBalanceSync(env.connection.db, env.connection.sqlite, {
          organizationId: env.organizationId,
          storeId: env.storeId,
          deviceId: env.deviceId,
        }),
      ).toBe(moneyFromTiyin(76_000n));
      expect(
        getActiveShiftDrawerBalanceSync(env.connection.db, env.connection.sqlite, {
          organizationId: env.organizationId,
          storeId: env.storeId,
          deviceId: deviceB,
        }),
      ).toBe(moneyFromTiyin(50_000n));
      expect(
        getActiveStoreCashBalanceSync(env.connection.db, env.connection.sqlite, {
          organizationId: env.organizationId,
          storeId: env.storeId,
        }),
      ).toBe(moneyFromTiyin(126_000n));
    } finally {
      env.connection.close();
    }
  });

  it('M1: upgrades a pre-populated 0006 DB (2 multi-line T1.4 sales, stock_moves, outbox) cleanly to 0007 under PRAGMA foreign_keys=ON', async () => {
    const migDir = getDefaultLocalMigrationsFolder();
    const partial06Dir = path.join(os.tmpdir(), `mezon-mig-0006-${Date.now()}-${Math.random()}`);
    fs.mkdirSync(path.join(partial06Dir, 'meta'), { recursive: true });
    tempDirs.push(partial06Dir);

    const journal = JSON.parse(
      fs.readFileSync(path.join(migDir, 'meta', '_journal.json'), 'utf8'),
    ) as {
      readonly version: string;
      readonly dialect: string;
      entries: Array<{ readonly idx: number; readonly tag: string }>;
    };
    const entries06 = journal.entries.filter((e) => e.idx <= 6);
    for (const entry of entries06) {
      fs.copyFileSync(
        path.join(migDir, `${entry.tag}.sql`),
        path.join(partial06Dir, `${entry.tag}.sql`),
      );
    }
    fs.writeFileSync(
      path.join(partial06Dir, 'meta', '_journal.json'),
      JSON.stringify({ ...journal, entries: entries06 }, null, 2),
    );

    const dbPath = createTempDbPath('upgrade-0006-to-0007.db');
    const clock = new FixedClock(1_760_000_000_000n);
    const random = new SeededRandomSource(91);
    const conn = openLocalSqliteDatabase(dbPath);
    try {
      migrateLocalDatabase(conn.db, partial06Dir);
      expect(conn.pragmas.foreignKeys).toBe(true);

      const authStore = await createSqliteHubAuthStore({ connection: conn, clock, random });
      const setup = await authStore.completeSetup({
        fullName: 'Owner M1',
        username: 'ownerm1',
        pinHash: await FAST_TEST_HASHER.hash('849201'),
      });
      const cashier = await authStore.createUser({
        fullName: 'Kassir M1',
        username: 'cashierm1',
        role: 'cashier',
        pinHash: await FAST_TEST_HASHER.hash('319482'),
      });

      const getStoreCtx = () => {
        const c = authStore.getActiveRuntimeContext();
        return c
          ? { uow: c.uow, organizationId: c.config.organizationId, storeId: c.config.storeId }
          : null;
      };
      const catalogStore = createSqliteCatalogStore({
        connection: conn,
        getRuntimeContext: () => {
          const c = authStore.getActiveRuntimeContext();
          return c ? { uow: c.uow, organizationId: c.config.organizationId } : null;
        },
      });
      const stockStore = createSqliteStockStore({
        connection: conn,
        getRuntimeContext: getStoreCtx,
      });
      const cartStore = createSqliteCartStore({ connection: conn, getRuntimeContext: getStoreCtx });

      const prod1 = await catalogStore.createProduct({
        name: 'Choy M1',
        unit: 'dona',
        trackBatches: true,
        salePrice: '25000',
        vatRateBp: 0,
        actorUserId: setup.owner.id,
      });
      const prod2 = await catalogStore.createProduct({
        name: 'Shakar M1',
        unit: 'kg',
        trackBatches: false,
        salePrice: '15000',
        vatRateBp: 0,
        actorUserId: setup.owner.id,
      });
      await stockStore.recordInboundMove({
        productId: prod1.product.id,
        reason: 'initial',
        qty: '20000',
        totalCostValue: '300000',
        batchNumber: 'M1-B1',
        actorUserId: setup.owner.id,
      });
      await stockStore.recordInboundMove({
        productId: prod2.product.id,
        reason: 'initial',
        qty: '20000',
        totalCostValue: '200000',
        actorUserId: setup.owner.id,
      });

      const ctx = authStore.getActiveRuntimeContext()!;
      const seededSaleIds: UuidV7[] = [];

      // Seed 2 authentic T1.4 sales in exact 0006 schema (multi-line, payments, stock_moves, outbox, completed carts, receipt_seq = 1, 2)
      for (const idx of [1n, 2n]) {
        const cart = await cartStore.openCart(cashier.id);
        await cartStore.addLine(cart.id, {
          kind: 'catalog',
          productId: prod1.product.id,
          variantId: null,
          qty: quantityFromMilli(2_000n),
        });
        await cartStore.addLine(cart.id, {
          kind: 'catalog',
          productId: prod2.product.id,
          variantId: null,
          qty: quantityFromMilli(1_000n),
        });

        await ctx.uow.execute((session) => {
          const sqlite = session.internalGetSqlite();
          const saleId = session.nextId();
          seededSaleIds.push(saleId);
          const nowMs = session.nowUnixMs();
          const hlc = serializeHlc(session.nextHlc());
          const receiptNo = advanceReceiptSeqSync(sqlite, {
            deviceId: setup.deviceId,
            updatedAtMs: nowMs,
          });
          const receiptCode = `${setup.deviceId.slice(-4).toUpperCase()}-${receiptNo.toString().padStart(6, '0')}`;
          const clientReqId = parseUuidV7(`01950000-0000-7000-8000-a0000000000${idx.toString()}`);

          sqlite
            .prepare(
              `INSERT INTO "sales" (
                "id", "organization_id", "store_id", "device_id", "hlc", "created_at_ms", "updated_at_ms",
                "receipt_no", "receipt_code", "source_cart_id", "cashier_user_id", "customer_id", "shift_id",
                "client_request_id", "subtotal_gross", "total_promo_discount", "subtotal_after_promo",
                "manual_discount_mode", "manual_discount_value", "manual_discount_reason", "order_discount_amount",
                "total_final", "total_net_ex_vat", "total_vat", "total_paid", "debt_amount", "change_amount",
                "override_approved_by_user_id", "override_approved_amount", "override_approved_at_ms",
                "voided_at_ms", "voided_by_user_id", "void_reason"
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, 65000, 0, 65000, 'none', 0, NULL, 0, 65000, 65000, 0, 65000, 0, 5000, NULL, NULL, NULL, NULL, NULL, NULL)`,
            )
            .run(
              saleId,
              setup.organizationId,
              setup.storeId,
              setup.deviceId,
              hlc,
              nowMs,
              nowMs,
              receiptNo,
              receiptCode,
              cart.id,
              cashier.id,
              clientReqId,
            );
          session.recordOutboxEvent({
            organizationId: setup.organizationId,
            storeId: setup.storeId,
            hlc: serializeHlc(session.nextHlc()),
            nowMs,
            entity: 'sales',
            entityId: saleId,
            entityClass: 'MONOTONE',
            type: 'sale.completed',
            schemaVersion: 1,
            payload: { id: saleId, receiptNo: receiptNo.toString() },
          });

          // 2 sale_lines + stock_moves
          const l1Out = applyOutboundStockMoveSync(session, {
            organizationId: setup.organizationId,
            storeId: setup.storeId,
            productId: prod1.product.id,
            variantId: null,
            reason: 'sale',
            needQty: quantityFromMilli(2_000n),
            overridePolicy: 'block',
            sourceType: 'sale',
            sourceId: saleId,
            note: `M1 #${idx.toString()}`,
            actorUserId: cashier.id,
          });
          const l2Out = applyOutboundStockMoveSync(session, {
            organizationId: setup.organizationId,
            storeId: setup.storeId,
            productId: prod2.product.id,
            variantId: null,
            reason: 'sale',
            needQty: quantityFromMilli(1_000n),
            overridePolicy: 'block',
            sourceType: 'sale',
            sourceId: saleId,
            note: `M1 #${idx.toString()}`,
            actorUserId: cashier.id,
          });

          const insertLineStmt = sqlite.prepare(
            `INSERT INTO "sale_lines" (
              "id", "organization_id", "store_id", "device_id", "hlc", "created_at_ms",
              "sale_id", "sort_order", "line_kind", "product_id", "variant_id", "category_id_snapshot",
              "item_name", "unit", "qty", "unit_price_snapshot", "applied_promotion_id", "applied_promotion_name",
              "free_units", "gross_total", "promo_discount", "subtotal_after_promo", "allocated_order_discount",
              "final_total", "vat_rate_bp_snapshot", "net_ex_vat", "vat_total", "mxik_snapshot", "package_code_snapshot", "cost_value"
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'catalog', ?, NULL, NULL, ?, ?, ?, ?, NULL, NULL, 0, ?, 0, ?, 0, ?, 0, ?, 0, NULL, NULL, ?)`,
          );
          const l1Id = session.nextId();
          insertLineStmt.run(
            l1Id,
            setup.organizationId,
            setup.storeId,
            setup.deviceId,
            serializeHlc(session.nextHlc()),
            nowMs,
            saleId,
            0,
            prod1.product.id,
            'Choy M1',
            'dona',
            2000n,
            25000n,
            50000n,
            50000n,
            50000n,
            50000n,
            -moneyToTiyin(l1Out.moves[0].costValueDelta),
          );
          const l2Id = session.nextId();
          insertLineStmt.run(
            l2Id,
            setup.organizationId,
            setup.storeId,
            setup.deviceId,
            serializeHlc(session.nextHlc()),
            nowMs,
            saleId,
            1,
            prod2.product.id,
            'Shakar M1',
            'kg',
            1000n,
            15000n,
            15000n,
            15000n,
            15000n,
            15000n,
            -moneyToTiyin(l2Out.moves[0].costValueDelta),
          );

          const pId = session.nextId();
          sqlite
            .prepare(
              `INSERT INTO "payments" (
                "id", "organization_id", "store_id", "device_id", "hlc", "created_at_ms",
                "sale_id", "method", "amount", "tendered_amount", "change_amount", "provider_ref", "provider_meta_json"
              ) VALUES (?, ?, ?, ?, ?, ?, ?, 'cash', 65000, 70000, 5000, NULL, NULL)`,
            )
            .run(
              pId,
              setup.organizationId,
              setup.storeId,
              setup.deviceId,
              serializeHlc(session.nextHlc()),
              nowMs,
              saleId,
            );

          sqlite
            .prepare(
              `UPDATE "local_carts" SET "status" = 'completed', "completed_sale_id" = ?, "completed_at_ms" = ?, "updated_at_ms" = ? WHERE "id" = ?`,
            )
            .run(saleId, nowMs, nowMs, cart.id);
          return Promise.resolve();
        });
      }

      expect(readReceiptSeqSync(conn.db, setup.deviceId)).toBe(2n);
      const preOutboxCount = listAllOutboxRecordsSync(conn.db).length;
      const preStockMoveCount = conn.db.select().from(stockMoves).all().length;

      // Apply 0007 migration cleanly under PRAGMA foreign_keys = ON inside Drizzle transaction
      migrateLocalDatabase(conn.db, migDir);

      // Verify ALL M1 guarantees:
      const fkViolations = conn.sqlite.pragma('foreign_key_check') as unknown[];
      expect(fkViolations).toEqual([]);
      const integrity = conn.sqlite.pragma('integrity_check', { simple: true });
      expect(integrity).toBe('ok');

      const upgradedSales = conn.sqlite
        .prepare('SELECT * FROM "sales" ORDER BY "receipt_no" ASC')
        .all() as Array<Record<string, unknown>>;
      expect(upgradedSales).toHaveLength(2);
      expect(upgradedSales[0]['id']).toBe(seededSaleIds[0]);
      expect(upgradedSales[0]['receipt_no']).toBe(1n);
      expect(upgradedSales[0]['total_final']).toBe(65_000n);
      expect(upgradedSales[0]['cashier_user_id']).toBe(cashier.id);
      expect(upgradedSales[0]['completed_by_user_id']).toBe(cashier.id);
      expect(upgradedSales[0]['request_hash']).toBe(`legacy:${seededSaleIds[0]}`);
      expect(upgradedSales[1]['id']).toBe(seededSaleIds[1]);
      expect(upgradedSales[1]['receipt_no']).toBe(2n);
      expect(upgradedSales[1]['completed_by_user_id']).toBe(cashier.id);
      expect(upgradedSales[1]['request_hash']).toBe(`legacy:${seededSaleIds[1]}`);

      const upgradedLines = conn.sqlite.prepare('SELECT * FROM "sale_lines"').all();
      expect(upgradedLines).toHaveLength(4);
      const upgradedPayments = conn.sqlite.prepare('SELECT * FROM "payments"').all() as Array<
        Record<string, unknown>
      >;
      expect(upgradedPayments).toHaveLength(2);
      expect(upgradedPayments[0]['amount']).toBe(65_000n);
      expect(upgradedPayments[0]['tendered_amount']).toBe(70_000n);
      expect(upgradedPayments[0]['change_amount']).toBe(5_000n);
      expect(conn.db.select().from(stockMoves).all().length).toBe(preStockMoveCount);
      expect(listAllOutboxRecordsSync(conn.db).length).toBe(preOutboxCount);

      // Verify recreated triggers block ALL raw SQL UPDATE/DELETE on sales, sale_lines, payments
      expect(() =>
        conn.sqlite
          .prepare('UPDATE "sales" SET "total_final" = 1 WHERE "id" = ?')
          .run(seededSaleIds[0]),
      ).toThrow(/forbids updating immutable receipt fields/);
      expect(() =>
        conn.sqlite.prepare('DELETE FROM "sales" WHERE "id" = ?').run(seededSaleIds[0]),
      ).toThrow(/forbids physical DELETE/);
      expect(() => conn.sqlite.prepare('UPDATE "sale_lines" SET "qty" = 999').run()).toThrow(
        /immutable/,
      );
      expect(() => conn.sqlite.prepare('DELETE FROM "sale_lines"').run()).toThrow(
        /forbids physical DELETE/,
      );
      expect(() => conn.sqlite.prepare('UPDATE "payments" SET "amount" = 999').run()).toThrow(
        /immutable/,
      );
      expect(() => conn.sqlite.prepare('DELETE FROM "payments"').run()).toThrow(
        /forbids physical DELETE/,
      );

      // Next T1.5 checkout continues receipt_no seamlessly at 3n and records cash_moves
      const shiftStore = createSqliteShiftStore({
        connection: conn,
        getRuntimeContext: getStoreCtx,
      });
      await shiftStore.openShift({
        actorUserId: cashier.id,
        clientRequestId: parseUuidV7('01950000-0000-7000-8000-a00000000099'),
        openingCash: ZERO_MONEY,
      });
      const saleStore = createSqliteSaleStore({ connection: conn, getRuntimeContext: getStoreCtx });
      const cart3 = await cartStore.openCart(cashier.id);
      const detail3 = await cartStore.addLine(cart3.id, {
        kind: 'catalog',
        productId: prod1.product.id,
        variantId: null,
        qty: quantityFromMilli(1_000n),
      });
      const sale3 = await saleStore.completeSale({
        cartId: cart3.id,
        actorUserId: setup.owner.id,
        clientRequestId: parseUuidV7('01950000-0000-7000-8000-a00000000003'),
        expectedTotal: detail3.totalFinal,
        payments: [
          { method: 'card', amount: moneyFromTiyin(10_000n), providerRef: 'M1-CARD' },
          { method: 'cash', tenderedAmount: moneyFromTiyin(20_000n) },
        ],
      });
      expect(sale3.sale.receiptNo).toBe(3n);
      expect(sale3.sale.completedByUserId).toBe(setup.owner.id);
      expect(readReceiptSeqSync(conn.db, setup.deviceId)).toBe(3n);
      expect(await saleStore.getTerminalCashBalance()).toBe(moneyFromTiyin(15_000n));
    } finally {
      conn.close();
    }
  });

  it('M3/M5 & property fuzz: rejects debtAmount > 0 (CUSTOMER_REQUIRED), customerId !== null (VALIDATION_ERROR), and all invariant breaches with exact DomainError codes & 0 DB writes', async () => {
    const env = await setupSaleEnv();
    try {
      const item = await env.catalogStore.createProduct({
        name: 'Tovar Invariant',
        unit: 'dona',
        trackBatches: false,
        salePrice: '10000',
        vatRateBp: 0,
        actorUserId: env.ownerId,
      });
      await env.stockStore.recordInboundMove({
        productId: item.product.id,
        reason: 'initial',
        qty: '500000',
        totalCostValue: '2500000',
        actorUserId: env.ownerId,
      });

      const snapshotState = () => ({
        sales: env.connection.db.select().from(sales).all().length,
        lines: env.connection.db.select().from(saleLines).all().length,
        payments: env.connection.db.select().from(payments).all().length,
        cashMoves: env.connection.db.select().from(cashMoves).all().length,
        outbox: listAllOutboxRecordsSync(env.connection.db).length,
        receiptSeq: readReceiptSeqSync(env.connection.db, env.deviceId),
      });

      // Deterministic explicit checks (M3 + M5)
      const openC = await env.cartStore.openCart(env.cashierId);
      const detC = await env.cartStore.addLine(openC.id, {
        kind: 'catalog',
        productId: item.product.id,
        variantId: null,
        qty: quantityFromMilli(5_000n), // 50_000 tiyin
      });
      const baseSnap = snapshotState();

      // M3: debt > 0 fails with exact CUSTOMER_REQUIRED
      await expect(
        env.saleStore.completeSale({
          cartId: openC.id,
          actorUserId: env.cashierId,
          clientRequestId: parseUuidV7('01950000-0000-7000-8000-b00000000001'),
          expectedTotal: detC.totalFinal,
          debtAmount: moneyFromTiyin(10_000n),
          payments: [{ method: 'card', amount: moneyFromTiyin(40_000n) }],
        }),
      ).rejects.toMatchObject({ code: 'CUSTOMER_REQUIRED' });
      expect(snapshotState()).toEqual(baseSnap);

      // T1.7: unknown customerId rejects with exact CUSTOMER_NOT_FOUND (and 0 DB writes)
      await expect(
        env.saleStore.completeSale({
          cartId: openC.id,
          actorUserId: env.cashierId,
          clientRequestId: parseUuidV7('01950000-0000-7000-8000-b00000000002'),
          expectedTotal: detC.totalFinal,
          customerId: parseUuidV7('01950000-0000-7000-8000-c00000000001'),
          payments: [{ method: 'cash', tenderedAmount: detC.totalFinal }],
        }),
      ).rejects.toMatchObject({ code: 'CUSTOMER_NOT_FOUND' });
      expect(snapshotState()).toEqual(baseSnap);

      // M5 critical mutation traps: underpaid card, overpaid card, cash + full card
      for (const badPayments of [
        [{ method: 'card', amount: moneyFromTiyin(49_999n) }] as const,
        [{ method: 'card', amount: moneyFromTiyin(50_001n) }] as const,
        [
          { method: 'card', amount: moneyFromTiyin(50_000n) },
          { method: 'cash', tenderedAmount: moneyFromTiyin(10_000n) },
        ] as const,
        [{ method: 'cash', tenderedAmount: moneyFromTiyin(49_999n) }] as const,
        [
          {
            method: 'cash',
            tenderedAmount: moneyFromTiyin(50_000n),
            amount: moneyFromTiyin(40_000n),
          },
        ] as const,
      ]) {
        const reqUuid = parseUuidV7(
          `01950000-0000-7000-8000-b1${String(Math.floor(Math.random() * 1e10)).padStart(10, '0')}`,
        );
        await expect(
          env.saleStore.completeSale({
            cartId: openC.id,
            actorUserId: env.cashierId,
            clientRequestId: reqUuid,
            expectedTotal: detC.totalFinal,
            payments: badPayments,
          }),
        ).rejects.toSatisfy(
          (e: unknown) => e instanceof DomainError && e.code === 'VALIDATION_ERROR',
        );
        expect(snapshotState()).toEqual(baseSnap);
      }

      // Property-based DB integration test: valid random mixed checkouts commit accurately, broken combinations fail with VALIDATION_ERROR & 0 writes
      const nonCashPool = PAYMENT_METHODS.filter((m): m is NonCashPaymentMethod => m !== 'cash');
      let reqSeq = 1;
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 1, max: 5 }),
          fc.array(
            fc.record({
              methodIdx: fc.integer({ min: 0, max: nonCashPool.length - 1 }),
              weight: fc.integer({ min: 1, max: 50 }),
            }),
            { minLength: 0, maxLength: 4 },
          ),
          fc.boolean(),
          fc.bigInt({ min: 0n, max: 50_000n }),
          fc.boolean(),
          async (qtyUnits, nonCashSpecs, withCash, extraCash, injectUnderpay) => {
            const c = await env.cartStore.openCart(env.cashierId);
            const det = await env.cartStore.addLine(c.id, {
              kind: 'catalog',
              productId: item.product.id,
              variantId: null,
              qty: quantityFromMilli(BigInt(qtyUnits) * 1_000n),
            });
            const total = moneyToTiyin(det.totalFinal);
            const hasCash = withCash || nonCashSpecs.length === 0;
            const payInputs: SalePaymentInput[] = [];
            let nonCashUsed = 0n;

            if (nonCashSpecs.length > 0) {
              const budget = hasCash ? total / 2n : total;
              const sumW = BigInt(nonCashSpecs.reduce((a, b) => a + b.weight, 0));
              for (let i = 0; i < nonCashSpecs.length; i += 1) {
                const s = nonCashSpecs[i];
                const part =
                  !hasCash && i === nonCashSpecs.length - 1
                    ? budget - nonCashUsed
                    : (budget * BigInt(s.weight)) / sumW;
                if (part > 0n) {
                  payInputs.push({
                    method: nonCashPool[s.methodIdx],
                    amount: moneyFromTiyin(part),
                  });
                  nonCashUsed += part;
                }
              }
            }

            const cashNeed = total - nonCashUsed;
            if (cashNeed > 0n) {
              payInputs.push({
                method: 'cash',
                tenderedAmount: moneyFromTiyin(
                  injectUnderpay ? cashNeed - 1n : cashNeed + extraCash,
                ),
              });
            } else if (payInputs.length === 0) {
              payInputs.push({
                method: 'card',
                amount: moneyFromTiyin(injectUnderpay ? total - 1n : total),
              });
            } else if (injectUnderpay) {
              const first = payInputs[0];
              if (first.method !== 'cash') {
                payInputs[0] = {
                  method: first.method,
                  amount: moneyFromTiyin(moneyToTiyin(first.amount) - 1n),
                };
              }
            }

            const clientReqId = parseUuidV7(
              `01950000-0000-7000-8000-d${String(reqSeq++).padStart(11, '0')}`,
            );

            if (injectUnderpay) {
              const before = snapshotState();
              await expect(
                env.saleStore.completeSale({
                  cartId: c.id,
                  actorUserId: env.cashierId,
                  clientRequestId: clientReqId,
                  expectedTotal: det.totalFinal,
                  payments: payInputs,
                }),
              ).rejects.toSatisfy(
                (err: unknown) => err instanceof DomainError && err.code === 'VALIDATION_ERROR',
              );
              expect(snapshotState()).toEqual(before);
              await env.cartStore.deleteCart(c.id);
              return;
            }

            const beforeDrawer = await env.saleStore.getTerminalCashBalance();
            const res = await env.saleStore.completeSale({
              cartId: c.id,
              actorUserId: env.cashierId,
              clientRequestId: clientReqId,
              expectedTotal: det.totalFinal,
              payments: payInputs,
            });
            const afterDrawer = await env.saleStore.getTerminalCashBalance();
            const expectedCashAdded = cashNeed > 0n ? cashNeed : 0n;
            expect(moneyToTiyin(afterDrawer) - moneyToTiyin(beforeDrawer)).toBe(expectedCashAdded);
            expect(res.sale.totalPaid).toBe(det.totalFinal);
          },
        ),
        { numRuns: 50 },
      );
    } finally {
      env.connection.close();
    }
  }, 30_000);

  it('T1.5 perf: 20-line cart with 3 payment types (card + payme + cash w/ change) completes <= 300ms', async () => {
    const dbPath = createTempDbPath('perf-t15-3pay.db');
    const env = await setupSaleEnv(dbPath);
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

  it('B1 regression: 36-step seeded differential test matches completeSale vs recordOutboundMove on all 6 local_stock_balances fields, cost_value_delta, FIFO batches & rebuildProjections', async () => {
    const env = await setupSaleEnv();
    try {
      await env.stockStore.setNegativeStockPolicy('warn');

      const avgSale = await env.catalogStore.createProduct({
        name: 'Un (completeSale avg)',
        unit: 'kg',
        trackBatches: false,
        salePrice: '10000',
        vatRateBp: 0,
        actorUserId: env.ownerId,
      });
      const avgDirect = await env.catalogStore.createProduct({
        name: 'Un (recordOutboundMove avg)',
        unit: 'kg',
        trackBatches: false,
        salePrice: '10000',
        vatRateBp: 0,
        actorUserId: env.ownerId,
      });
      const fifoSale = await env.catalogStore.createProduct({
        name: 'Shakar (completeSale fifo)',
        unit: 'kg',
        trackBatches: true,
        salePrice: '12000',
        vatRateBp: 0,
        actorUserId: env.ownerId,
      });
      const fifoDirect = await env.catalogStore.createProduct({
        name: 'Shakar (recordOutboundMove fifo)',
        unit: 'kg',
        trackBatches: true,
        salePrice: '12000',
        vatRateBp: 0,
        actorUserId: env.ownerId,
      });

      const readPoolSnapshot = (productId: UuidV7) => {
        const row = env.connection.db
          .select()
          .from(localStockBalances)
          .where(
            and(
              eq(localStockBalances.organizationId, env.organizationId),
              eq(localStockBalances.storeId, env.storeId),
              eq(localStockBalances.productId, productId),
            ),
          )
          .all()[0];
        expect(row).toBeDefined();
        return {
          qtyOnHand: row.qtyOnHand,
          totalValue: row.totalValue,
          deficitQty: row.deficitQty,
          provisionalDeficitValue: row.provisionalDeficitValue,
          costVarianceValue: row.costVarianceValue,
          lastUnitCost: row.lastUnitCost,
        };
      };

      const readOutboundCostSum = (productId: UuidV7) => {
        const rows = env.connection.db
          .select({ qtyDelta: stockMoves.qtyDelta, costValueDelta: stockMoves.costValueDelta })
          .from(stockMoves)
          .where(
            and(
              eq(stockMoves.organizationId, env.organizationId),
              eq(stockMoves.storeId, env.storeId),
              eq(stockMoves.productId, productId),
            ),
          )
          .orderBy(asc(stockMoves.hlc), asc(stockMoves.id))
          .all();
        return rows
          .filter((r) => (r.qtyDelta as bigint) < 0n)
          .reduce((acc, r) => acc + moneyToTiyin(r.costValueDelta), 0n);
      };

      const readBatchQtyAndValues = (productId: UuidV7) =>
        env.connection.db
          .select({
            remainingQty: localBatchBalances.remainingQty,
            remainingValue: localBatchBalances.remainingValue,
          })
          .from(localBatchBalances)
          .where(
            and(
              eq(localBatchBalances.organizationId, env.organizationId),
              eq(localBatchBalances.storeId, env.storeId),
              eq(localBatchBalances.productId, productId),
            ),
          )
          .orderBy(asc(localBatchBalances.hlc), asc(localBatchBalances.batchId))
          .all();

      const assertPairedParity = () => {
        expect(readPoolSnapshot(avgSale.product.id)).toEqual(
          readPoolSnapshot(avgDirect.product.id),
        );
        expect(readPoolSnapshot(fifoSale.product.id)).toEqual(
          readPoolSnapshot(fifoDirect.product.id),
        );
        expect(readOutboundCostSum(avgSale.product.id)).toBe(
          readOutboundCostSum(avgDirect.product.id),
        );
        expect(readOutboundCostSum(fifoSale.product.id)).toBe(
          readOutboundCostSum(fifoDirect.product.id),
        );
        expect(readBatchQtyAndValues(fifoSale.product.id)).toEqual(
          readBatchQtyAndValues(fifoDirect.product.id),
        );
      };

      // Step 1: initial inbound batches (exact 1707n avg unit cost counterexample + FIFO initial batch)
      for (const p of [avgSale, avgDirect]) {
        await env.stockStore.recordInboundMove({
          productId: p.product.id,
          reason: 'initial',
          qty: '3000',
          totalCostValue: '5121', // 5121 / 3 = 1707 tiyin/kg
          actorUserId: env.ownerId,
        });
      }
      for (const p of [fifoSale, fifoDirect]) {
        await env.stockStore.recordInboundMove({
          productId: p.product.id,
          reason: 'initial',
          qty: '4000',
          totalCostValue: '9600',
          batchNumber: 'INIT-B1',
          actorUserId: env.ownerId,
        });
      }
      assertPairedParity();

      // Deterministic PRNG for 35 randomized operations (covering normal outs, deficit transition,
      // repeated deficit outs using lastUnitCost, partial/full restocks with cost variance, & FIFO multi-batch outs)
      let rngState = 0x51a7b1n;
      const nextRand = (mod: bigint): bigint => {
        rngState = (rngState * 6364136223846793005n + 1442695040888963407n) & ((1n << 64n) - 1n);
        return (rngState >> 16n) % mod;
      };

      for (let step = 2; step <= 36; step += 1) {
        env.clock.advance(1_000n);
        // Ensure explicit deficit & recovery transitions early (steps 2..5) + mixed seeded steps afterwards
        const isRestock =
          step === 6 || step === 14 || step === 24 || (step > 6 && nextRand(10n) < 3n);

        if (isRestock) {
          const avgQty = 2_000n + nextRand(5_000n); // milli
          const avgUnitCost = 1_500n + nextRand(1_800n);
          const avgCostVal = (avgQty * avgUnitCost) / 1_000n;
          for (const p of [avgSale, avgDirect]) {
            await env.stockStore.recordInboundMove({
              productId: p.product.id,
              reason: 'purchase',
              qty: avgQty.toString(),
              totalCostValue: avgCostVal.toString(),
              actorUserId: env.ownerId,
            });
          }

          const fifoQty = 2_500n + nextRand(4_500n);
          const fifoUnitCost = 2_000n + nextRand(2_000n);
          const fifoCostVal = (fifoQty * fifoUnitCost) / 1_000n;
          for (const p of [fifoSale, fifoDirect]) {
            await env.stockStore.recordInboundMove({
              productId: p.product.id,
              reason: 'purchase',
              qty: fifoQty.toString(),
              totalCostValue: fifoCostVal.toString(),
              batchNumber: `STEP-${step}`,
              actorUserId: env.ownerId,
            });
          }
        } else {
          // Force deficit by step 3 & keep trading inside deficit in steps 4..5, then randomized qty
          const avgNeed =
            step === 2
              ? 2_000n // leaves 1.000 kg -> keeps lastUnitCost = 1707n
              : step === 3
                ? 2_500n // goes -1.500 kg into deficit!
                : 500n + nextRand(3_500n);
          const fifoNeed = step === 2 ? 2_500n : step === 3 ? 3_000n : 500n + nextRand(4_000n);

          // Path A: completeSale (1 cart containing BOTH avgSale & fifoSale)
          const cart = await env.cartStore.openCart(env.cashierId);
          await env.cartStore.addLine(cart.id, {
            kind: 'catalog',
            productId: avgSale.product.id,
            variantId: null,
            qty: quantityFromMilli(avgNeed),
          });
          const detail = await env.cartStore.addLine(cart.id, {
            kind: 'catalog',
            productId: fifoSale.product.id,
            variantId: null,
            qty: quantityFromMilli(fifoNeed),
          });
          const completed = await env.saleStore.completeSale({
            cartId: cart.id,
            actorUserId: env.cashierId,
            clientRequestId: parseUuidV7(
              `01950000-0000-7000-8000-d1ff${String(step).padStart(8, '0')}`,
            ),
            expectedTotal: detail.totalFinal,
            payments: [{ method: 'card', amount: detail.totalFinal, providerRef: `D-${step}` }],
          });

          // Path B: direct recordOutboundMove (separate T1.2 ledger path)
          const outAvg = await env.stockStore.recordOutboundMove({
            productId: avgDirect.product.id,
            reason: 'sale',
            qty: avgNeed.toString(),
            policy: 'warn',
            actorUserId: env.cashierId,
          });
          const outFifo = await env.stockStore.recordOutboundMove({
            productId: fifoDirect.product.id,
            reason: 'sale',
            qty: fifoNeed.toString(),
            policy: 'warn',
            actorUserId: env.cashierId,
          });

          // Verify per-step sale_lines.costValue === direct outbound -SUM(costValueDelta)
          const directAvgCost = outAvg.moves.reduce(
            (acc, m) => acc + -moneyToTiyin(m.costValueDelta),
            0n,
          );
          const directFifoCost = outFifo.moves.reduce(
            (acc, m) => acc + -moneyToTiyin(m.costValueDelta),
            0n,
          );
          expect(moneyToTiyin(completed.sale.lines[0].costValue)).toBe(directAvgCost);
          expect(moneyToTiyin(completed.sale.lines[1].costValue)).toBe(directFifoCost);
        }

        assertPairedParity();
      }

      // Final verification (B1 item 3): rebuildProjections() matches live balances across all 4 products
      const beforeRebuild = {
        avgSale: readPoolSnapshot(avgSale.product.id),
        avgDirect: readPoolSnapshot(avgDirect.product.id),
        fifoSale: readPoolSnapshot(fifoSale.product.id),
        fifoDirect: readPoolSnapshot(fifoDirect.product.id),
        fifoSaleBatches: readBatchQtyAndValues(fifoSale.product.id),
        fifoDirectBatches: readBatchQtyAndValues(fifoDirect.product.id),
      };
      await env.stockStore.rebuildProjections();
      const afterRebuild = {
        avgSale: readPoolSnapshot(avgSale.product.id),
        avgDirect: readPoolSnapshot(avgDirect.product.id),
        fifoSale: readPoolSnapshot(fifoSale.product.id),
        fifoDirect: readPoolSnapshot(fifoDirect.product.id),
        fifoSaleBatches: readBatchQtyAndValues(fifoSale.product.id),
        fifoDirectBatches: readBatchQtyAndValues(fifoDirect.product.id),
      };
      expect(afterRebuild).toEqual(beforeRebuild);
    } finally {
      env.connection.close();
    }
  }, 30_000);
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
