import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
import {
  type PinHasher,
  type UuidV7,
  ZERO_MONEY,
  computeCumulativeReturnLineAmounts,
  moneyFromTiyin,
  moneyToTiyin,
  parseUuidV7,
  quantityFromMilli,
  quantityToMilli,
  serializeHlc,
} from '@mezon/domain';
import { FixedClock, SeededRandomSource } from '@mezon/test-utils';
import { and, asc, eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import {
  type LocalSqliteConnection,
  batches,
  cashMoves,
  createSqliteCartStore,
  createSqliteCatalogStore,
  createSqliteHubAuthStore,
  createSqliteReturnStore,
  createSqliteSaleStore,
  createSqliteStockStore,
  getCashDrawerBalanceSync,
  listAllOutboxRecordsSync,
  localBatchBalances,
  localStockBalances,
  migrateLocalDatabase,
  openLocalSqliteDatabase,
  readDeviceStateRowSync,
  readReturnSeqSync,
  returnLines,
  returnPayments,
  returns,
  saleLines,
  sales,
  stockMoves,
} from './index.js';

const FAST_TEST_HASHER: PinHasher = {
  hash: (pin) => Promise.resolve(`fast-hash:${pin}`),
  verify: (hash, pin) => Promise.resolve(hash === `fast-hash:${pin}`),
};

const tempDirs: string[] = [];
const openConnections: LocalSqliteConnection[] = [];

function seededNextInt(rng: SeededRandomSource, maxExclusive: number): number {
  const b = rng.nextBytes(2);
  return ((b[0] << 8) | b[1]) % maxExclusive;
}

function makeTempDbPath(name = 'return-test.db'): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mezon-t16-return-'));
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

// 2026-06-15 23:59:30 Asia/Tashkent (UTC+5) = 2026-06-15T18:59:30.000Z
const TASHKENT_235930_UTC_MS = BigInt(Date.parse('2026-06-15T18:59:30.000Z'));
// 2026-06-16 00:01:00 Asia/Tashkent (UTC+5) = 2026-06-15T19:01:00.000Z
const TASHKENT_000100_NEXT_UTC_MS = BigInt(Date.parse('2026-06-15T19:01:00.000Z'));

async function setupReturnEnv(options?: {
  readonly dbPath?: string;
  readonly initialMs?: bigint;
  readonly seed?: number;
}) {
  const dbPath = options?.dbPath ?? makeTempDbPath();
  const clock = new FixedClock(options?.initialMs ?? TASHKENT_235930_UTC_MS);
  const random = new SeededRandomSource(options?.seed ?? 77);
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
    returnStore,
    organizationId: setup.organizationId,
    storeId: setup.storeId,
    deviceId: setup.deviceId,
    ownerId: setup.owner.id,
    managerId: manager.id,
    cashierId: cashier.id,
  };
}

let idCounter = 1n;
function nextTestUuid(prefixHex = '01960000'): UuidV7 {
  idCounter += 1n;
  const tail = idCounter.toString(16).padStart(12, '0');
  return parseUuidV7(`${prefixHex}-0000-7000-8000-${tail}`);
}

interface PoolSnapshot {
  readonly qtyOnHand: bigint;
  readonly totalValue: bigint;
  readonly deficitQty: bigint;
  readonly provisionalDeficitValue: bigint;
  readonly costVarianceValue: bigint;
  readonly lastUnitCost: bigint | null;
}

interface BatchNormalizedSnapshot {
  readonly batchNumber: string | null;
  readonly expiryDateMs: bigint | null;
  readonly remainingQty: bigint;
  readonly remainingValue: bigint;
}

function readPoolSnapshot(
  conn: LocalSqliteConnection,
  orgId: UuidV7,
  storeId: UuidV7,
  productId: UuidV7,
): PoolSnapshot {
  const row = conn.db
    .select()
    .from(localStockBalances)
    .where(
      and(
        eq(localStockBalances.organizationId, orgId),
        eq(localStockBalances.storeId, storeId),
        eq(localStockBalances.productId, productId),
      ),
    )
    .limit(1)
    .all()[0];
  if (!row) {
    return {
      qtyOnHand: 0n,
      totalValue: 0n,
      deficitQty: 0n,
      provisionalDeficitValue: 0n,
      costVarianceValue: 0n,
      lastUnitCost: null,
    };
  }
  return {
    qtyOnHand: quantityToMilli(row.qtyOnHand),
    totalValue: moneyToTiyin(row.totalValue),
    deficitQty: quantityToMilli(row.deficitQty),
    provisionalDeficitValue: moneyToTiyin(row.provisionalDeficitValue),
    costVarianceValue: moneyToTiyin(row.costVarianceValue),
    lastUnitCost: row.lastUnitCost !== null ? moneyToTiyin(row.lastUnitCost) : null,
  };
}

function readNormalizedBatchSnapshots(
  conn: LocalSqliteConnection,
  orgId: UuidV7,
  storeId: UuidV7,
  productId: UuidV7,
): BatchNormalizedSnapshot[] {
  const rows = conn.db
    .select({
      batchId: localBatchBalances.batchId,
      remainingQty: localBatchBalances.remainingQty,
      remainingValue: localBatchBalances.remainingValue,
      batchNumber: batches.batchNumber,
      expiryDateMs: batches.expiryDateMs,
    })
    .from(localBatchBalances)
    .innerJoin(batches, eq(batches.id, localBatchBalances.batchId))
    .where(
      and(
        eq(localBatchBalances.organizationId, orgId),
        eq(localBatchBalances.storeId, storeId),
        eq(localBatchBalances.productId, productId),
      ),
    )
    .orderBy(asc(localBatchBalances.hlc), asc(localBatchBalances.batchId))
    .all();

  return rows.map((r) => ({
    batchNumber: r.batchNumber?.startsWith('RET-') ? 'RET-FALLBACK' : r.batchNumber,
    expiryDateMs: r.expiryDateMs,
    remainingQty: quantityToMilli(r.remainingQty),
    remainingValue: moneyToTiyin(r.remainingValue),
  }));
}

async function seedCashInDrawer(
  env: Awaited<ReturnType<typeof setupReturnEnv>>,
  amountTiyin: bigint,
  tag: number,
) {
  const ctx = env.authStore.getActiveRuntimeContext()!;
  await ctx.uow.execute((session) => {
    const nowMs = session.nowUnixMs();
    session.db
      .insert(cashMoves)
      .values({
        id: session.nextId(),
        organizationId: env.organizationId,
        storeId: env.storeId,
        deviceId: env.deviceId,
        hlc: serializeHlc(session.nextHlc()),
        createdAtMs: nowMs,
        shiftId: null,
        type: 'cash_in',
        amountDelta: moneyFromTiyin(amountTiyin),
        sourceType: 'manual',
        sourceId: parseUuidV7(`01960000-0000-7000-8000-${tag.toString().padStart(12, '0')}`),
        paymentId: null,
        reason: 'Opening drawer float',
        createdByUserId: env.ownerId,
      })
      .run();
    return Promise.resolve();
  });
}

describe('@mezon/db-local - T1.6 Void, Return, V1-V5, Oracle Parity, C1 Crash & Perf', () => {
  it('enforces V1 business-day void cutoff, V2 drawer balance on void, V3 raw SQL immutability, V5 non-tracked zero stock moves & v_sales_lines exclusion', async () => {
    const env = await setupReturnEnv({ initialMs: TASHKENT_235930_UTC_MS });
    try {
      const fifoProd = await env.catalogStore.createProduct({
        name: 'Fifo Pishloq',
        unit: 'kg',
        trackBatches: true,
        salePrice: '100000',
        vatRateBp: 1200,
        actorUserId: env.ownerId,
      });
      await env.stockStore.recordInboundMove({
        productId: fifoProd.product.id,
        reason: 'purchase',
        qty: '5000',
        totalCostValue: '300000',
        batchNumber: 'P-1',
        actorUserId: env.ownerId,
      });

      const unlimProd = await env.catalogStore.createProduct({
        name: 'Yetkazish xizmati',
        unit: 'dona',
        unlimited: true,
        salePrice: '20000',
        vatRateBp: 0,
        actorUserId: env.ownerId,
      });

      // Sale #1 at 23:59:30 Asia/Tashkent: cash (tendered 150,000, change 30,000 => net payments.amount 120,000) + card 50,000
      // Lines: 1.5 kg Fifo Pishloq (150,000) + 1 unlim (20,000)? Wait: let's add 1 quick_sale (10,000) too => total = 180,000 -> wait: exact pricing 150k + 20k = 170k -> pay 120k cash + 50k card
      const cart1 = await env.cartStore.openCart(env.cashierId);
      await env.cartStore.addLine(cart1.id, {
        kind: 'catalog',
        productId: fifoProd.product.id,
        variantId: null,
        qty: quantityFromMilli(1_500n),
      });
      await env.cartStore.addLine(cart1.id, {
        kind: 'catalog',
        productId: unlimProd.product.id,
        variantId: null,
        qty: quantityFromMilli(1_000n),
      });
      const qsCart = await env.cartStore.openCart(env.cashierId);
      await env.cartStore.addLine(qsCart.id, {
        kind: 'quick_sale',
        name: 'Paket',
        unit: 'dona',
        qty: quantityFromMilli(1_000n),
        unitPrice: moneyFromTiyin(10_000n),
        mxik: null,
        packageCode: null,
        vatRateBp: null,
      });
      const quickSaleCompleted = await env.saleStore.completeSale({
        cartId: qsCart.id,
        actorUserId: env.cashierId,
        clientRequestId: nextTestUuid(),
        expectedTotal: moneyFromTiyin(10_000n),
        payments: [{ method: 'cash', tenderedAmount: moneyFromTiyin(10_000n) }],
      });
      expect(quickSaleCompleted.sale.id).toBeTruthy();

      const completed = await env.saleStore.completeSale({
        cartId: cart1.id,
        actorUserId: env.cashierId,
        clientRequestId: nextTestUuid(),
        expectedTotal: moneyFromTiyin(170_000n),
        payments: [
          { method: 'cash', tenderedAmount: moneyFromTiyin(150_000n) }, // net = 120,000
          { method: 'card', amount: moneyFromTiyin(50_000n), providerRef: 'RRN-1' },
        ],
      });

      // Drain drawer cash to 119,999 (total was 10,000 + 120,000 = 130,000 -> remove 10,001) to prove V2 applies to voidSale!
      const ctx = env.authStore.getActiveRuntimeContext()!;
      await ctx.uow.execute((session) => {
        session.db
          .insert(cashMoves)
          .values({
            id: session.nextId(),
            organizationId: env.organizationId,
            storeId: env.storeId,
            deviceId: env.deviceId,
            hlc: serializeHlc(session.nextHlc()),
            createdAtMs: session.nowUnixMs(),
            shiftId: null,
            type: 'encashment',
            amountDelta: moneyFromTiyin(-10_001n),
            sourceType: 'manual',
            sourceId: nextTestUuid(),
            paymentId: null,
            reason: 'Partial drop',
            createdByUserId: env.ownerId,
          })
          .run();
        return Promise.resolve();
      });

      await expect(
        env.returnStore.voidSale({
          saleId: completed.sale.id,
          actorUserId: env.managerId,
          reason: 'Kassa tekshiruvi',
          clientRequestId: nextTestUuid(),
        }),
      ).rejects.toMatchObject({ code: 'INSUFFICIENT_CASH_IN_DRAWER' });

      // Top drawer back up by 1 tiyin -> now 120,000 (exact needed for completed sale's net cash)
      await seedCashInDrawer(env, 1n, 9001);

      // V1: Advance FixedClock past midnight (2026-06-16 00:01:00 Asia/Tashkent) -> VOID_WINDOW_EXPIRED
      env.clock.set(TASHKENT_000100_NEXT_UTC_MS);
      await expect(
        env.returnStore.voidSale({
          saleId: completed.sale.id,
          actorUserId: env.managerId,
          reason: 'Kechikkan void',
          clientRequestId: nextTestUuid(),
        }),
      ).rejects.toMatchObject({ code: 'VOID_WINDOW_EXPIRED' });

      // Prove storeTimezone config works dynamically: switching to 'UTC' keeps 19:01Z on 2026-06-15 UTC -> succeeds on quick_sale,
      // then switch back to 'Asia/Tashkent' and rewind clock to 23:59:45 Tashkent for primary sale test!
      await env.returnStore.setStoreTimezone('UTC');
      const voidQuickUtc = await env.returnStore.voidSale({
        saleId: quickSaleCompleted.sale.id,
        actorUserId: env.ownerId,
        reason: 'UTC same day quick sale void',
        clientRequestId: nextTestUuid(),
      });
      expect(voidQuickUtc.sale.status).toBe('voided');
      // V5: Quick-sale void generated ZERO stock_moves
      const quickSaleVoidStockMoves = env.connection.db
        .select()
        .from(stockMoves)
        .where(eq(stockMoves.sourceId, quickSaleCompleted.sale.id))
        .all();
      expect(quickSaleVoidStockMoves).toHaveLength(0);

      // Also exercise arbitrary IANA DST zone (`America/New_York`: 2026-06-16T04:01Z = 00:01 EDT June 16 vs sale June 15)
      await env.returnStore.setStoreTimezone('America/New_York');
      env.clock.set(BigInt(Date.parse('2026-06-16T04:01:00.000Z')));
      await expect(
        env.returnStore.voidSale({
          saleId: completed.sale.id,
          actorUserId: env.managerId,
          reason: 'EDT midnight crossed',
          clientRequestId: nextTestUuid(),
        }),
      ).rejects.toMatchObject({ code: 'VOID_WINDOW_EXPIRED' });

      // Reset timezone to default Asia/Tashkent and restore FixedClock inside same Tashkent day (23:59:45)
      await env.returnStore.setStoreTimezone('Asia/Tashkent');
      env.clock.set(TASHKENT_235930_UTC_MS + 15_000n);
      // Replenish the 10,000 tiyin voided from quickSaleCompleted so drawer = 120,000 exact for primary sale void
      await seedCashInDrawer(env, 10_000n, 9002);

      // V3 BEFORE void: writing partial void columns (`void_reason` alone, etc.) on unvoided sale MUST ABORT in raw SQL
      for (const stmt of [
        `UPDATE "sales" SET "void_reason" = 'Partial hack' WHERE "id" = ?`,
        `UPDATE "sales" SET "void_client_request_id" = '${nextTestUuid()}' WHERE "id" = ?`,
        `UPDATE "sales" SET "void_request_hash" = 'deadbeef99' WHERE "id" = ?`,
        `UPDATE "sales" SET "voided_at_ms" = ${TASHKENT_235930_UTC_MS.toString()} WHERE "id" = ?`,
      ]) {
        expect(() => env.connection.sqlite.prepare(stmt).run(completed.sale.id)).toThrow(
          /MONOTONE|CHECK constraint failed/,
        );
      }

      const voidReqId = nextTestUuid();
      const stockMoveCountBefore = env.connection.db.select().from(stockMoves).all().length;
      const voidRes = await env.returnStore.voidSale({
        saleId: completed.sale.id,
        actorUserId: env.managerId,
        reason: 'Xato urilgan chek',
        clientRequestId: voidReqId,
      });
      expect(voidRes.idempotentReplay).toBe(false);
      expect(voidRes.sale.status).toBe('voided');
      expect(voidRes.cashRefundAmount).toBe(moneyFromTiyin(120_000n)); // Net payments.amount, NOT 150k tendered!

      // V5: Only tracked fifoProd got a compensating stock_move (+1 move, NOT 2 for unlimited product!)
      const stockMovesAfter = env.connection.db.select().from(stockMoves).all();
      expect(stockMovesAfter.length - stockMoveCountBefore).toBe(1);
      const voidStockMove = stockMovesAfter[stockMovesAfter.length - 1];
      expect(voidStockMove.productId).toBe(fifoProd.product.id);
      expect(voidStockMove.reason).toBe('return');
      expect(quantityToMilli(voidStockMove.qtyDelta)).toBe(1_500n);
      expect(moneyToTiyin(voidStockMove.costValueDelta)).toBe(90_000n);

      // Cash drawer balance back to 0 (both sales voided -> 10k dropped by 10001 dropped + 1 topup = 0, completed voided -120k)
      // Check ledger: +10k -10k? Wait: opening had +10k + 120k - 10,001 + 1 - 10,000(quick) - 120,000(completed) = -10,000?
      // Wait: drawer had +120,000 left after draining? +10,000 + 120,000 - 10,001 + 1 = 120,000 -> - 10,000 (void quick) -> - 120,000? No: 120k - 10k (quick void) = 110k -> wait: voidQuickUtc passed BEFORE topping? No: topped +1 -> 120,000; voidQuickUtc withdrew 10,000 -> 110,000... wait why did completed succeed? Ah! completed cash was 120,000; why was balance >= 120,000?
      // Let's trace: quickSale(+10k) + sale1(+120k) = 130k. Dropped 10,001 -> 119,999. Voided sale1 failed! Topped +1 -> 120,000.
      // THEN voidQuickUtc withdrew 10,000 -> 110,000? Wait why did line 354 NOT fail?! Because voidQuickUtc ran while drawer = 120,000 (-10k = 110k) -> wait why didn't voidRes fail at line 378?! Let's check!!
      expect(
        readPoolSnapshot(env.connection, env.organizationId, env.storeId, fifoProd.product.id)
          .qtyOnHand,
      ).toBe(5_000n);
      expect(
        getCashDrawerBalanceSync(env.connection.db, {
          organizationId: env.organizationId,
          storeId: env.storeId,
          deviceId: env.deviceId,
        }),
      ).toBe(ZERO_MONEY);
    } finally {
      env.connection.close();
    }
  });

  it('tracks drawer & V3 AFTER void raw SQL tamper checks and v_sales_lines exclusion cleanly', async () => {
    const env = await setupReturnEnv({ initialMs: TASHKENT_235930_UTC_MS });
    try {
      const prod = await env.catalogStore.createProduct({
        name: 'Sut',
        unit: 'dona',
        salePrice: '15000',
        vatRateBp: 1200,
        actorUserId: env.ownerId,
      });
      await env.stockStore.recordInboundMove({
        productId: prod.product.id,
        reason: 'initial',
        qty: '10000',
        totalCostValue: '100000',
        actorUserId: env.ownerId,
      });

      const cart = await env.cartStore.openCart(env.cashierId);
      await env.cartStore.addLine(cart.id, {
        kind: 'catalog',
        productId: prod.product.id,
        variantId: null,
        qty: quantityFromMilli(2_000n),
      });
      const saleRes = await env.saleStore.completeSale({
        cartId: cart.id,
        actorUserId: env.cashierId,
        clientRequestId: nextTestUuid(),
        expectedTotal: moneyFromTiyin(30_000n),
        payments: [{ method: 'cash', tenderedAmount: moneyFromTiyin(30_000n) }],
      });

      // Before void: v_sales_lines has 1 sale row
      const preReport = await env.returnStore.querySalesLinesReport();
      expect(preReport.lineCount).toBe(1);
      expect(moneyToTiyin(preReport.revenue)).toBe(30_000n);

      const reqId = nextTestUuid();
      const outboxBeforeVoid = listAllOutboxRecordsSync(env.connection.db).length;
      const voidRes = await env.returnStore.voidSale({
        saleId: saleRes.sale.id,
        actorUserId: env.managerId,
        reason: 'Mijoz bekor qildi',
        clientRequestId: reqId,
      });
      expect(voidRes.sale.voidReason).toBe('Mijoz bekor qildi');

      // v_sales_lines MUST completely exclude voided sale
      const postReport = await env.returnStore.querySalesLinesReport();
      expect(postReport).toEqual({
        lineCount: 0,
        signedQtyTotal: 0n,
        revenue: ZERO_MONEY,
        netRevenue: ZERO_MONEY,
        vatTotal: ZERO_MONEY,
        costValue: ZERO_MONEY,
        grossProfit: ZERO_MONEY,
      });

      // Idempotent replay with same clientRequestId + reason -> 0 extra outbox
      const outboxAfterVoid = listAllOutboxRecordsSync(env.connection.db).length;
      expect(outboxAfterVoid).toBeGreaterThan(outboxBeforeVoid);
      const replay = await env.returnStore.voidSale({
        saleId: saleRes.sale.id,
        actorUserId: env.managerId,
        reason: '  Mijoz bekor qildi ',
        clientRequestId: reqId,
      });
      expect(replay.idempotentReplay).toBe(true);
      expect(listAllOutboxRecordsSync(env.connection.db).length).toBe(outboxAfterVoid);

      // Differing reason with same clientRequestId -> IDEMPOTENCY_CONFLICT
      await expect(
        env.returnStore.voidSale({
          saleId: saleRes.sale.id,
          actorUserId: env.managerId,
          reason: 'Boshqa sabab',
          clientRequestId: reqId,
        }),
      ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });

      // Second void with fresh clientRequestId -> SALE_ALREADY_VOIDED
      await expect(
        env.returnStore.voidSale({
          saleId: saleRes.sale.id,
          actorUserId: env.managerId,
          reason: 'Ikkinchi void',
          clientRequestId: nextTestUuid(),
        }),
      ).rejects.toMatchObject({ code: 'SALE_ALREADY_VOIDED' });

      // Return against voided sale -> SALE_ALREADY_VOIDED
      await expect(
        env.returnStore.createReturn({
          saleId: saleRes.sale.id,
          actorUserId: env.managerId,
          reason: 'Void chekka qaytarish',
          clientRequestId: nextTestUuid(),
          items: [{ saleLineId: saleRes.sale.lines[0].id, qty: quantityFromMilli(1_000n) }],
          payments: [{ method: 'cash', amount: moneyFromTiyin(15_000n) }],
        }),
      ).rejects.toMatchObject({ code: 'SALE_ALREADY_VOIDED' });

      // V3: After void, mutating ANY individual void column via raw SQL MUST fail (`cannot be modified once voided`)
      const alterQueries = [
        `UPDATE "sales" SET "voided_at_ms" = 1760000099999 WHERE "id" = ?`,
        `UPDATE "sales" SET "voided_by_user_id" = '${env.ownerId}' WHERE "id" = ?`,
        `UPDATE "sales" SET "void_reason" = 'Tampered reason' WHERE "id" = ?`,
        `UPDATE "sales" SET "void_client_request_id" = '${nextTestUuid()}' WHERE "id" = ?`,
        `UPDATE "sales" SET "void_request_hash" = 'tamperedhash123' WHERE "id" = ?`,
        `UPDATE "sales" SET "total_final" = 1 WHERE "id" = ?`,
      ];
      for (const sqlText of alterQueries) {
        expect(() => env.connection.sqlite.prepare(sqlText).run(saleRes.sale.id)).toThrow(
          /cannot be modified once voided/,
        );
      }
      expect(() =>
        env.connection.sqlite.prepare('DELETE FROM "sales" WHERE "id" = ?').run(saleRes.sale.id),
      ).toThrow(/forbids physical DELETE/);
    } finally {
      env.connection.close();
    }
  });

  it('rejects excess/double returns, void-after-return, parallel partial races, V2 method caps, V5 non-tracked & enforces FACT triggers', async () => {
    const env = await setupReturnEnv();
    try {
      const tracked = await env.catalogStore.createProduct({
        name: 'Guruch',
        unit: 'kg',
        trackBatches: false,
        salePrice: '20000',
        vatRateBp: 1200,
        actorUserId: env.ownerId,
      });
      await env.stockStore.recordInboundMove({
        productId: tracked.product.id,
        reason: 'purchase',
        qty: '10000',
        totalCostValue: '120000',
        actorUserId: env.ownerId,
      });

      const serviceProd = await env.catalogStore.createProduct({
        name: 'Qadoqlash',
        unit: 'dona',
        unlimited: true,
        salePrice: '10000',
        vatRateBp: 0,
        actorUserId: env.ownerId,
      });

      const cart = await env.cartStore.openCart(env.cashierId);
      await env.cartStore.addLine(cart.id, {
        kind: 'catalog',
        productId: tracked.product.id,
        variantId: null,
        qty: quantityFromMilli(5_000n), // 5 kg * 20,000 = 100,000
      });
      await env.cartStore.addLine(cart.id, {
        kind: 'catalog',
        productId: serviceProd.product.id,
        variantId: null,
        qty: quantityFromMilli(2_000n), // 2 * 10,000 = 20,000
      });
      await env.cartStore.addLine(cart.id, {
        kind: 'quick_sale',
        name: 'Tez mahsulot',
        unit: 'dona',
        qty: quantityFromMilli(1_000n), // 10,000
        unitPrice: moneyFromTiyin(10_000n),
        mxik: null,
        packageCode: null,
        vatRateBp: null,
      });

      // Total = 130,000. Customer tenders 100,000 cash with 20,000 change -> payments.amount = 80,000 cash + 50,000 card!
      const sale = await env.saleStore.completeSale({
        cartId: cart.id,
        actorUserId: env.cashierId,
        clientRequestId: nextTestUuid(),
        expectedTotal: moneyFromTiyin(130_000n),
        payments: [
          {
            method: 'cash',
            tenderedAmount: moneyFromTiyin(100_000n),
            amount: moneyFromTiyin(80_000n),
          },
          { method: 'card', amount: moneyFromTiyin(50_000n), providerRef: 'RRN-MIX' },
        ],
      });

      const trackedLine = sale.sale.lines[0];
      const unlimLine = sale.sale.lines[1];
      const quickLine = sale.sale.lines[2];

      // V2: Attempt full cash refund of 80,001 + card 49,999 (tendered was 100k, but net cash payment was 80k!) -> REJECTED
      await expect(
        env.returnStore.createReturn({
          saleId: sale.sale.id,
          actorUserId: env.managerId,
          reason: "Karta o'rniga naqd",
          clientRequestId: nextTestUuid(),
          items: [
            { saleLineId: trackedLine.id, qty: quantityFromMilli(5_000n) },
            { saleLineId: unlimLine.id, qty: quantityFromMilli(2_000n) },
            { saleLineId: quickLine.id, qty: quantityFromMilli(1_000n) },
          ],
          payments: [
            { method: 'cash', amount: moneyFromTiyin(80_001n) },
            { method: 'card', amount: moneyFromTiyin(49_999n), providerRef: 'REF-1' },
          ],
        }),
      ).rejects.toMatchObject({ code: 'RETURN_PAYMENT_LIMIT_EXCEEDED' });

      // Also cross-method payment (`uzqr` never paid) rejected cleanly
      await expect(
        env.returnStore.createReturn({
          saleId: sale.sale.id,
          actorUserId: env.managerId,
          reason: 'UzQR ga qaytarish',
          clientRequestId: nextTestUuid(),
          items: [{ saleLineId: quickLine.id, qty: quantityFromMilli(1_000n) }],
          payments: [{ method: 'uzqr', amount: moneyFromTiyin(10_000n) }],
        }),
      ).rejects.toMatchObject({ code: 'RETURN_PAYMENT_LIMIT_EXCEEDED' });

      // Failed return did NOT increment last_return_seq
      expect(readReturnSeqSync(env.connection.db, env.deviceId)).toBe(0n);

      // Partial return #1: return 2 kg Guruch (40,000) + 1 unlim (10,000) + 1 quick_sale (10,000) = 60,000 total (cash 60,000)
      const stockCountBeforeRet1 = env.connection.db.select().from(stockMoves).all().length;
      const ret1 = await env.returnStore.createReturn({
        saleId: sale.sale.id,
        actorUserId: env.cashierId,
        overrideApprovedByUserId: env.ownerId,
        reason: 'Qisman qaytarish #1',
        clientRequestId: nextTestUuid(),
        items: [
          { saleLineId: trackedLine.id, qty: quantityFromMilli(2_000n) },
          { saleLineId: unlimLine.id, qty: quantityFromMilli(1_000n) },
          { saleLineId: quickLine.id, qty: quantityFromMilli(1_000n) },
        ],
        payments: [{ method: 'cash', amount: moneyFromTiyin(60_000n) }],
      });
      expect(ret1.returnDoc.returnNo).toBe(1n);
      expect(readReturnSeqSync(env.connection.db, env.deviceId)).toBe(1n);

      // V5: Only trackedLine created a stock_move (+1 move, NOT 3!)
      const stockMovesPostRet1 = env.connection.db.select().from(stockMoves).all();
      expect(stockMovesPostRet1.length - stockCountBeforeRet1).toBe(1);
      expect(stockMovesPostRet1[stockMovesPostRet1.length - 1].productId).toBe(tracked.product.id);

      // Void on sale that ALREADY has a return -> MUST REJECT (`SALE_HAS_RETURNS`)
      await expect(
        env.returnStore.voidSale({
          saleId: sale.sale.id,
          actorUserId: env.ownerId,
          reason: 'Qaytarilgan chekni void qilish',
          clientRequestId: nextTestUuid(),
        }),
      ).rejects.toMatchObject({ code: 'SALE_HAS_RETURNS' });

      // Parallel partial return race: 3 kg Guruch remain. Fire two concurrent returns each asking 2 kg (40k)!
      // One succeeds (remaining becomes 1 kg), second fails with RETURN_QTY_EXCEEDED!
      const raceSettled = await Promise.allSettled([
        env.returnStore.createReturn({
          saleId: sale.sale.id,
          actorUserId: env.managerId,
          reason: 'Parallel 1',
          clientRequestId: nextTestUuid(),
          items: [{ saleLineId: trackedLine.id, qty: quantityFromMilli(2_000n) }],
          payments: [
            { method: 'cash', amount: moneyFromTiyin(20_000n) },
            { method: 'card', amount: moneyFromTiyin(20_000n), providerRef: 'REF-PAR1' },
          ],
        }),
        env.returnStore.createReturn({
          saleId: sale.sale.id,
          actorUserId: env.managerId,
          reason: 'Parallel 2',
          clientRequestId: nextTestUuid(),
          items: [{ saleLineId: trackedLine.id, qty: quantityFromMilli(2_000n) }],
          payments: [
            { method: 'cash', amount: moneyFromTiyin(20_000n) },
            { method: 'card', amount: moneyFromTiyin(20_000n), providerRef: 'REF-PAR2' },
          ],
        }),
      ]);
      const raceOk = raceSettled.filter((r) => r.status === 'fulfilled');
      const raceErr = raceSettled.filter((r) => r.status === 'rejected');
      expect(raceOk).toHaveLength(1);
      expect(raceErr).toHaveLength(1);
      expect(raceErr[0].reason).toMatchObject({ code: 'RETURN_QTY_EXCEEDED' });

      // Remaining remainingQty = 1.000 kg (tracked) and 1.000 dona (unlim) -> return remaining = 30,000 via remaining card cap (50k - 20k = 30k)!
      const retFinal = await env.returnStore.createReturn({
        saleId: sale.sale.id,
        actorUserId: env.managerId,
        reason: 'Qolganini qaytarish',
        clientRequestId: nextTestUuid(),
        items: [
          { saleLineId: trackedLine.id, qty: quantityFromMilli(1_000n) },
          { saleLineId: unlimLine.id, qty: quantityFromMilli(1_000n) },
        ],
        payments: [{ method: 'card', amount: moneyFromTiyin(30_000n), providerRef: 'REF-FINAL' }],
      });
      expect(retFinal.returnDoc.returnNo).toBe(3n);

      // Re-returning even 1 milli after 100% returned -> RETURN_QTY_EXCEEDED!
      await expect(
        env.returnStore.createReturn({
          saleId: sale.sale.id,
          actorUserId: env.managerId,
          reason: 'Ortiqcha urinish',
          clientRequestId: nextTestUuid(),
          items: [{ saleLineId: trackedLine.id, qty: quantityFromMilli(1n) }],
          payments: [],
        }),
      ).rejects.toMatchObject({ code: 'RETURN_QTY_EXCEEDED' });

      // Since all lines fully returned, v_sales_lines net sum = 0 across qty, revenue, vat, cost, profit!
      const summary = await env.returnStore.querySalesLinesReport();
      expect(summary.signedQtyTotal).toBe(0n);
      expect(summary.revenue).toBe(ZERO_MONEY);
      expect(summary.netRevenue).toBe(ZERO_MONEY);
      expect(summary.vatTotal).toBe(ZERO_MONEY);
      expect(summary.costValue).toBe(ZERO_MONEY);
      expect(summary.grossProfit).toBe(ZERO_MONEY);

      // FACT immutability triggers on returns, return_lines, return_payments
      expect(() =>
        env.connection.sqlite
          .prepare('UPDATE "returns" SET "reason" = \'hack\' WHERE "id" = ?')
          .run(ret1.returnDoc.id),
      ).toThrow(/UPDATE is forbidden/);
      expect(() =>
        env.connection.sqlite
          .prepare('DELETE FROM "returns" WHERE "id" = ?')
          .run(ret1.returnDoc.id),
      ).toThrow(/forbids physical DELETE/);
      expect(() =>
        env.connection.sqlite
          .prepare('UPDATE "return_lines" SET "qty" = 999 WHERE "return_id" = ?')
          .run(ret1.returnDoc.id),
      ).toThrow(/UPDATE is forbidden/);
      expect(() =>
        env.connection.sqlite
          .prepare('DELETE FROM "return_payments" WHERE "return_id" = ?')
          .run(ret1.returnDoc.id),
      ).toThrow(/forbids physical DELETE/);
    } finally {
      env.connection.close();
    }
  });

  it('V4.1 & V4.2 Strong Oracles: void === full return & 3 partial returns === 1 full return across FIFO, average, and warn deficit with rebuildProjections parity', async () => {
    const regimes: readonly {
      readonly label: string;
      readonly trackBatches: boolean;
      readonly deficitTest: boolean;
      readonly seed: number;
    }[] = [
      { label: 'FIFO multi-batch', trackBatches: true, deficitTest: false, seed: 101 },
      { label: 'Weighted average', trackBatches: false, deficitTest: false, seed: 202 },
      { label: 'Warn deficit batched', trackBatches: true, deficitTest: true, seed: 303 },
      { label: 'Warn deficit average', trackBatches: false, deficitTest: true, seed: 404 },
    ];

    for (const regime of regimes) {
      // Twin setup helper: executes IDENTICAL seeded initial/purchases/interim sales across Twin A, B, C
      const setupTwins = async () => {
        const twinA = await setupReturnEnv({ seed: regime.seed }); // Void twin
        const twinB = await setupReturnEnv({ seed: regime.seed }); // 1 Full Return twin
        const twinC = await setupReturnEnv({ seed: regime.seed }); // 3 Random Partial Returns twin
        const all = [twinA, twinB, twinC] as const;

        const productIds: UuidV7[] = [];
        for (const t of all) {
          const p = await t.catalogStore.createProduct({
            name: `Oracle ${regime.label}`,
            unit: 'kg',
            trackBatches: regime.trackBatches,
            salePrice: '45000',
            vatRateBp: 1200,
            actorUserId: t.ownerId,
          });
          productIds.push(p.product.id);
          await t.stockStore.setNegativeStockPolicy('warn');
          await seedCashInDrawer(t, 5_000_000n, 700);
        }

        // Twin-step execution: execute identical stock purchases and pre-target sales on all 3 twins
        const rand = new SeededRandomSource(regime.seed);
        const targetSellQty = regime.deficitTest ? 6_250n : 4_750n;

        if (!regime.deficitTest) {
          // Non-deficit: multiple purchases with prime/non-divisible costs so multi-batch FIFO & rounding remainders are exercised!
          for (const [idx, qty, cost, bName] of [
            [1, '2300', '27111', 'B1'],
            [2, '3100', '51999', 'B2'],
            [3, '2500', '33333', 'B3'],
          ] as const) {
            for (let i = 0; i < 3; i += 1) {
              await all[i].stockStore.recordInboundMove({
                productId: productIds[i],
                reason: idx === 1 ? 'initial' : 'purchase',
                qty,
                totalCostValue: cost,
                batchNumber: regime.trackBatches ? bName : null,
                actorUserId: all[i].ownerId,
              });
            }
          }
          // Pre-sale draining part of Batch 1 cleanly
          for (let i = 0; i < 3; i += 1) {
            const cPre = await all[i].cartStore.openCart(all[i].cashierId);
            const detPre = await all[i].cartStore.addLine(cPre.id, {
              kind: 'catalog',
              productId: productIds[i],
              variantId: null,
              qty: quantityFromMilli(1_400n),
            });
            await all[i].saleStore.completeSale({
              cartId: cPre.id,
              actorUserId: all[i].cashierId,
              clientRequestId: parseUuidV7('01960000-0000-7000-8000-00000000aa01'),
              expectedTotal: detPre.totalFinal,
              payments: [{ method: 'cash', tenderedAmount: detPre.totalFinal }],
            });
          }
        } else {
          // Deficit mode ('warn'): small batch 2 kg then oversell 6.25 kg (2 kg batched + 4.25 kg deficit unbatched!)
          for (let i = 0; i < 3; i += 1) {
            await all[i].stockStore.recordInboundMove({
              productId: productIds[i],
              reason: 'purchase',
              qty: '2000',
              totalCostValue: '30001',
              batchNumber: regime.trackBatches ? 'B-SMALL' : null,
              actorUserId: all[i].ownerId,
            });
          }
        }

        // Target sale on all 3 twins!
        const targetSales: Awaited<ReturnType<typeof twinA.saleStore.completeSale>>[] = [];
        for (let i = 0; i < 3; i += 1) {
          const c = await all[i].cartStore.openCart(all[i].cashierId);
          const det = await all[i].cartStore.addLine(c.id, {
            kind: 'catalog',
            productId: productIds[i],
            variantId: null,
            qty: quantityFromMilli(targetSellQty),
          });
          // Apply 7% order discount for interesting VAT/total rounding remainders!
          const detDisc = await all[i].cartStore.setDiscount(c.id, {
            mode: 'percent',
            percentBp: 700,
            reason: 'Oracle test',
            approvedSupervisorUserId: all[i].ownerId,
          });
          const s = await all[i].saleStore.completeSale({
            cartId: c.id,
            actorUserId: all[i].cashierId,
            clientRequestId: parseUuidV7('01960000-0000-7000-8000-00000000bb01'),
            expectedTotal: detDisc.totalFinal,
            payments: [{ method: 'cash', tenderedAmount: detDisc.totalFinal }],
          });
          targetSales.push(s);
          expect(det.subtotalGross).toBeDefined();
        }

        // Generate 3 random positive integer partial splits summing to `targetSellQty` from seeded RNG
        const b1 = BigInt(100 + seededNextInt(rand, 1500)) + 1n;
        const b2 = BigInt(100 + seededNextInt(rand, 1500)) + 1n;
        const p1 = (targetSellQty * b1) / 5000n;
        const p2 = (targetSellQty * b2) / 5000n;
        const p3 = targetSellQty - p1 - p2;
        expect(p1 > 0n && p2 > 0n && p3 > 0n).toBe(true);
        expect(p1 + p2 + p3).toBe(targetSellQty);

        return { twinA, twinB, twinC, productIds, targetSales, splits: [p1, p2, p3] as const };
      };

      const { twinA, twinB, twinC, productIds, targetSales, splits } = await setupTwins();
      try {
        // 1) Twin A: voidSale
        await twinA.returnStore.voidSale({
          saleId: targetSales[0].sale.id,
          actorUserId: twinA.managerId,
          reason: 'V4.1 void',
          clientRequestId: nextTestUuid(),
        });

        // 2) Twin B: single full createReturn
        const fullRet = await twinB.returnStore.createReturn({
          saleId: targetSales[1].sale.id,
          actorUserId: twinB.managerId,
          reason: 'V4.1 full return',
          clientRequestId: nextTestUuid(),
          items: [
            {
              saleLineId: targetSales[1].sale.lines[0].id,
              qty: quantityFromMilli(targetSales[1].sale.lines[0].qty),
            },
          ],
          payments: [{ method: 'cash', amount: targetSales[1].sale.totalFinal }],
        });

        // 3) Twin C: 3 random partial createReturns summing to total sold
        let sumRefundC = 0n;
        let sumNetC = 0n;
        let sumVatC = 0n;
        let sumCostC = 0n;
        const origLineC = targetSales[2].sale.lines[0];
        let prevQtyC = 0n;
        let prevRefC = 0n;
        let prevNetC = 0n;
        let prevVatC = 0n;

        for (let sIdx = 0; sIdx < 3; sIdx += 1) {
          const chunkMilli = splits[sIdx];
          const nextQtyC = prevQtyC + chunkMilli;
          // Query exact cumulative expected refund from domain formula so payment matches return total
          const partRowsBefore = twinC.connection.db
            .select()
            .from(returnLines)
            .where(eq(returnLines.saleLineId, origLineC.id))
            .all();
          expect(partRowsBefore.length).toBe(sIdx);

          const expectedAmounts = computeCumulativeReturnLineAmounts({
            saleLineId: origLineC.id,
            unit: 'kg',
            soldQty: origLineC.qty,
            previouslyReturnedQty: quantityFromMilli(prevQtyC),
            requestedQty: quantityFromMilli(chunkMilli),
            soldFinalTotal: origLineC.finalTotal,
            soldNetExVat: origLineC.netExVat,
            soldVatTotal: origLineC.vatTotal,
            previouslyRefunded: moneyFromTiyin(prevRefC),
            previouslyReturnedNet: moneyFromTiyin(prevNetC),
            previouslyReturnedVat: moneyFromTiyin(prevVatC),
          });
          const partRet = await twinC.returnStore.createReturn({
            saleId: targetSales[2].sale.id,
            actorUserId: twinC.managerId,
            reason: `Partial #${sIdx + 1}`,
            clientRequestId: nextTestUuid(),
            items: [{ saleLineId: origLineC.id, qty: quantityFromMilli(chunkMilli) }],
            payments:
              moneyToTiyin(expectedAmounts.refundAmount) > 0n
                ? [{ method: 'cash', amount: expectedAmounts.refundAmount }]
                : [],
          });
          prevQtyC = nextQtyC;
          prevRefC += moneyToTiyin(expectedAmounts.refundAmount);
          prevNetC += moneyToTiyin(expectedAmounts.netExVat);
          prevVatC += moneyToTiyin(expectedAmounts.vatTotal);

          sumRefundC += moneyToTiyin(partRet.returnDoc.totalRefund);
          sumNetC += moneyToTiyin(partRet.returnDoc.totalNetExVat);
          sumVatC += moneyToTiyin(partRet.returnDoc.totalVat);
          const storedLine = twinC.connection.db
            .select()
            .from(returnLines)
            .where(eq(returnLines.returnId, partRet.returnDoc.id))
            .get()!;
          sumCostC += moneyToTiyin(storedLine.costValue);
        }

        // Assert V4.1: Pool (all 6 fields) + Batches of Twin A (void) === Twin B (full return)
        const poolA = readPoolSnapshot(
          twinA.connection,
          twinA.organizationId,
          twinA.storeId,
          productIds[0],
        );
        const poolB = readPoolSnapshot(
          twinB.connection,
          twinB.organizationId,
          twinB.storeId,
          productIds[1],
        );
        const poolC = readPoolSnapshot(
          twinC.connection,
          twinC.organizationId,
          twinC.storeId,
          productIds[2],
        );
        expect(poolA).toEqual(poolB);
        expect(poolB).toEqual(poolC);

        const batchesA = readNormalizedBatchSnapshots(
          twinA.connection,
          twinA.organizationId,
          twinA.storeId,
          productIds[0],
        );
        const batchesB = readNormalizedBatchSnapshots(
          twinB.connection,
          twinB.organizationId,
          twinB.storeId,
          productIds[1],
        );
        const batchesC = readNormalizedBatchSnapshots(
          twinC.connection,
          twinC.organizationId,
          twinC.storeId,
          productIds[2],
        );
        expect(batchesA).toEqual(batchesB);
        expect(batchesB).toEqual(batchesC);

        // Assert V4.2 totals: 3 partial returns sum === single full return (refund, vat, net, cost)!
        const fullRetLine = twinB.connection.db
          .select()
          .from(returnLines)
          .where(eq(returnLines.returnId, fullRet.returnDoc.id))
          .get()!;
        expect(sumRefundC).toBe(moneyToTiyin(fullRet.returnDoc.totalRefund));
        expect(sumNetC).toBe(moneyToTiyin(fullRet.returnDoc.totalNetExVat));
        expect(sumVatC).toBe(moneyToTiyin(fullRet.returnDoc.totalVat));
        expect(sumCostC).toBe(moneyToTiyin(fullRetLine.costValue));

        // Assert live === rebuildStockProjections() on all 3 twins!
        for (let i = 0; i < 3; i += 1) {
          const twin = [twinA, twinB, twinC][i];
          const pid = productIds[i];
          const livePool = readPoolSnapshot(
            twin.connection,
            twin.organizationId,
            twin.storeId,
            pid,
          );
          const liveBatches = readNormalizedBatchSnapshots(
            twin.connection,
            twin.organizationId,
            twin.storeId,
            pid,
          );
          await twin.stockStore.rebuildProjections();
          const rebuiltPool = readPoolSnapshot(
            twin.connection,
            twin.organizationId,
            twin.storeId,
            pid,
          );
          const rebuiltBatches = readNormalizedBatchSnapshots(
            twin.connection,
            twin.organizationId,
            twin.storeId,
            pid,
          );
          expect(livePool).toEqual(rebuiltPool);
          expect(liveBatches).toEqual(rebuiltBatches);
        }
      } finally {
        twinA.connection.close();
        twinB.connection.close();
        twinC.connection.close();
      }
    }
  }, 20_000);

  it('v_sales_lines model test: seeded random sales, partial returns & voids match independent accounting model to the exact tiyin', async () => {
    const env = await setupReturnEnv({ initialMs: TASHKENT_235930_UTC_MS, seed: 555 });
    try {
      await env.stockStore.setNegativeStockPolicy('warn');
      await seedCashInDrawer(env, 50_000_000n, 888);

      const fifo = await env.catalogStore.createProduct({
        name: 'Fifo Pishloq Model',
        unit: 'kg',
        trackBatches: true,
        salePrice: '37500',
        vatRateBp: 1200,
        actorUserId: env.ownerId,
      });
      const avg = await env.catalogStore.createProduct({
        name: 'Average Un Model',
        unit: 'kg',
        trackBatches: false,
        salePrice: '19000',
        vatRateBp: 0,
        actorUserId: env.ownerId,
      });
      const unlim = await env.catalogStore.createProduct({
        name: 'Kofe Xizmat',
        unit: 'dona',
        unlimited: true,
        salePrice: '12000',
        vatRateBp: 1200,
        actorUserId: env.ownerId,
      });

      await env.stockStore.recordInboundMove({
        productId: fifo.product.id,
        reason: 'initial',
        qty: '50000',
        totalCostValue: '900000',
        batchNumber: 'MOD-B1',
        actorUserId: env.ownerId,
      });
      await env.stockStore.recordInboundMove({
        productId: avg.product.id,
        reason: 'initial',
        qty: '50000',
        totalCostValue: '550000',
        actorUserId: env.ownerId,
      });

      // Independent ground-truth accounting model tracking every line, return, and void!
      interface ModelSale {
        readonly id: UuidV7;
        voided: boolean;
        readonly lines: readonly {
          readonly id: UuidV7;
          readonly qty: bigint;
          readonly final: bigint;
          readonly net: bigint;
          readonly vat: bigint;
          readonly cost: bigint;
          returnedQty: bigint;
          returnedFinal: bigint;
          returnedNet: bigint;
          returnedVat: bigint;
          returnedCost: bigint;
        }[];
        readonly returns: {
          readonly qty: bigint;
          readonly final: bigint;
          readonly net: bigint;
          readonly vat: bigint;
          readonly cost: bigint;
        }[];
      }
      const modelSales: ModelSale[] = [];

      const rng = new SeededRandomSource(999);

      // 1) Create 10 varied multi-line sales (tracked FIFO, avg, unlimited, quick_sale, with order discounts)
      for (let i = 0; i < 10; i += 1) {
        const c = await env.cartStore.openCart(env.cashierId);
        await env.cartStore.addLine(c.id, {
          kind: 'catalog',
          productId: fifo.product.id,
          variantId: null,
          qty: quantityFromMilli(BigInt(500 + (seededNextInt(rng, 15) + 1) * 250)),
        });
        await env.cartStore.addLine(c.id, {
          kind: 'catalog',
          productId: avg.product.id,
          variantId: null,
          qty: quantityFromMilli(BigInt(500 + (seededNextInt(rng, 15) + 1) * 250)),
        });
        await env.cartStore.addLine(c.id, {
          kind: 'catalog',
          productId: unlim.product.id,
          variantId: null,
          qty: quantityFromMilli(2_000n),
        });
        await env.cartStore.addLine(c.id, {
          kind: 'quick_sale',
          name: `Tez-${i}`,
          unit: 'dona',
          qty: quantityFromMilli(1_000n),
          unitPrice: moneyFromTiyin(BigInt(5_000 + i * 1_111)),
          mxik: null,
          packageCode: null,
          vatRateBp: i % 2 === 0 ? 1200 : null,
        });
        const discBp = i % 3 === 0 ? 500 : i % 3 === 1 ? 1000 : 0;
        if (discBp > 0) {
          await env.cartStore.setDiscount(c.id, {
            mode: 'percent',
            percentBp: discBp,
            reason: 'Model disc',
            approvedSupervisorUserId: env.ownerId,
          });
        }
        const detail = await env.cartStore.getCart(c.id);
        const completed = await env.saleStore.completeSale({
          cartId: c.id,
          actorUserId: env.cashierId,
          clientRequestId: nextTestUuid(),
          expectedTotal: detail.totalFinal,
          payments: [{ method: 'cash', tenderedAmount: detail.totalFinal }],
        });

        const storedLines = env.connection.db
          .select()
          .from(saleLines)
          .where(eq(saleLines.saleId, completed.sale.id))
          .orderBy(asc(saleLines.sortOrder))
          .all();

        modelSales.push({
          id: completed.sale.id,
          voided: false,
          lines: storedLines.map((sl) => ({
            id: sl.id,
            qty: quantityToMilli(sl.qty),
            final: moneyToTiyin(sl.finalTotal),
            net: moneyToTiyin(sl.netExVat),
            vat: moneyToTiyin(sl.vatTotal),
            cost: moneyToTiyin(sl.costValue),
            returnedQty: 0n,
            returnedFinal: 0n,
            returnedNet: 0n,
            returnedVat: 0n,
            returnedCost: 0n,
          })),
          returns: [],
        });
      }

      // 2) Execute mix of voids (on untouched sales 0, 3, 6) and multiple partial/full returns on remaining sales
      for (const idx of [0, 3, 6]) {
        const target = modelSales[idx];
        await env.returnStore.voidSale({
          saleId: target.id,
          actorUserId: env.managerId,
          reason: `Void ${idx}`,
          clientRequestId: nextTestUuid(),
        });
        target.voided = true;
      }

      for (const idx of [1, 2, 4, 5, 7, 8, 9]) {
        const ms = modelSales[idx];
        // Execute 1-2 partial returns per sale across different lines
        for (const lIdx of [0, 1, 2, 3]) {
          const ml = ms.lines[lIdx];
          const partQty = lIdx < 2 ? ml.qty / 3n + 111n : ml.qty; // Fractional kg on catalog kg lines, full qty on dona lines
          if (partQty <= 0n || partQty > ml.qty - ml.returnedQty) {
            continue;
          }
          const origDbLine = env.connection.db
            .select()
            .from(saleLines)
            .where(eq(saleLines.id, ml.id))
            .get()!;

          const expAmt = computeCumulativeReturnLineAmounts({
            saleLineId: ml.id,
            unit: origDbLine.unit as 'kg' | 'dona',
            soldQty: origDbLine.qty,
            previouslyReturnedQty: quantityFromMilli(ml.returnedQty),
            requestedQty: quantityFromMilli(partQty),
            soldFinalTotal: origDbLine.finalTotal,
            soldNetExVat: origDbLine.netExVat,
            soldVatTotal: origDbLine.vatTotal,
            previouslyRefunded: moneyFromTiyin(ml.returnedFinal),
            previouslyReturnedNet: moneyFromTiyin(ml.returnedNet),
            previouslyReturnedVat: moneyFromTiyin(ml.returnedVat),
          });

          const retRes = await env.returnStore.createReturn({
            saleId: ms.id,
            actorUserId: env.managerId,
            reason: `Return s${idx}-l${lIdx}`,
            clientRequestId: nextTestUuid(),
            items: [{ saleLineId: ml.id, qty: quantityFromMilli(partQty) }],
            payments:
              moneyToTiyin(expAmt.refundAmount) > 0n
                ? [{ method: 'cash', amount: expAmt.refundAmount }]
                : [],
          });

          const savedRl = env.connection.db
            .select()
            .from(returnLines)
            .where(eq(returnLines.returnId, retRes.returnDoc.id))
            .get()!;
          const cTiyin = moneyToTiyin(savedRl.costValue);

          ml.returnedQty += partQty;
          ml.returnedFinal += moneyToTiyin(expAmt.refundAmount);
          ml.returnedNet += moneyToTiyin(expAmt.netExVat);
          ml.returnedVat += moneyToTiyin(expAmt.vatTotal);
          ml.returnedCost += cTiyin;
          ms.returns.push({
            qty: partQty,
            final: moneyToTiyin(expAmt.refundAmount),
            net: moneyToTiyin(expAmt.netExVat),
            vat: moneyToTiyin(expAmt.vatTotal),
            cost: cTiyin,
          });
        }
      }

      // Compute independent model totals (`+` for non-voided sales, `-` for returns, voided sales excluded!)
      let mLines = 0;
      let mQty = 0n;
      let mRev = 0n;
      let mNet = 0n;
      let mVat = 0n;
      let mCost = 0n;

      for (const ms of modelSales) {
        if (ms.voided) {
          expect(ms.returns).toHaveLength(0);
          continue;
        }
        for (const ml of ms.lines) {
          mLines += 1;
          mQty += ml.qty;
          mRev += ml.final;
          mNet += ml.net;
          mVat += ml.vat;
          mCost += ml.cost;
        }
        for (const mr of ms.returns) {
          mLines += 1;
          mQty -= mr.qty;
          mRev -= mr.final;
          mNet -= mr.net;
          mVat -= mr.vat;
          mCost -= mr.cost;
        }
      }

      const report = await env.returnStore.querySalesLinesReport();
      expect(report.lineCount).toBe(mLines);
      expect(report.signedQtyTotal).toBe(mQty);
      expect(moneyToTiyin(report.revenue)).toBe(mRev);
      expect(moneyToTiyin(report.netRevenue)).toBe(mNet);
      expect(moneyToTiyin(report.vatTotal)).toBe(mVat);
      expect(moneyToTiyin(report.costValue)).toBe(mCost);
      expect(moneyToTiyin(report.grossProfit)).toBe(mNet - mCost);
      expect(mNet + mVat).toBe(mRev);
    } finally {
      env.connection.close();
    }
  }, 15_000);

  it('C1 crash safety: child process killed before COMMIT leaves zero half-voids or half-returns and gapless last_return_seq', async () => {
    const dbPath = makeTempDbPath('c1-crash-return.db');
    const env = await setupReturnEnv({ dbPath });
    const prod = await env.catalogStore.createProduct({
      name: 'Choy Crash',
      unit: 'dona',
      salePrice: '50000',
      vatRateBp: 0,
      actorUserId: env.ownerId,
    });
    await env.stockStore.recordInboundMove({
      productId: prod.product.id,
      reason: 'purchase',
      qty: '10000',
      totalCostValue: '300000',
      actorUserId: env.ownerId,
    });

    const c1 = await env.cartStore.openCart(env.cashierId);
    await env.cartStore.addLine(c1.id, {
      kind: 'catalog',
      productId: prod.product.id,
      variantId: null,
      qty: quantityFromMilli(2_000n),
    });
    const sale1 = await env.saleStore.completeSale({
      cartId: c1.id,
      actorUserId: env.cashierId,
      clientRequestId: nextTestUuid(),
      expectedTotal: moneyFromTiyin(100_000n),
      payments: [{ method: 'cash', tenderedAmount: moneyFromTiyin(100_000n) }],
    });

    const c2 = await env.cartStore.openCart(env.cashierId);
    await env.cartStore.addLine(c2.id, {
      kind: 'catalog',
      productId: prod.product.id,
      variantId: null,
      qty: quantityFromMilli(2_000n),
    });
    const sale2 = await env.saleStore.completeSale({
      cartId: c2.id,
      actorUserId: env.cashierId,
      clientRequestId: nextTestUuid(),
      expectedTotal: moneyFromTiyin(100_000n),
      payments: [{ method: 'cash', tenderedAmount: moneyFromTiyin(100_000n) }],
    });

    const baselineOutbox = listAllOutboxRecordsSync(env.connection.db).length;
    const baselineSeq = readDeviceStateRowSync(env.connection.db, env.deviceId)!.lastDeviceSeq;
    const baselineRetSeq = readReturnSeqSync(env.connection.db, env.deviceId);
    const baselineStockMoves = env.connection.db.select().from(stockMoves).all().length;
    const baselineCashMoves = env.connection.db.select().from(cashMoves).all().length;
    env.connection.close();

    const dbLocalUrl = pathToFileURL(
      path.resolve(import.meta.dirname, '..', 'dist', 'index.js'),
    ).href;
    const domainUrl = pathToFileURL(
      path.resolve(import.meta.dirname, '..', '..', 'domain', 'dist', 'index.js'),
    ).href;
    const testUtilsUrl = pathToFileURL(
      path.resolve(import.meta.dirname, '..', '..', 'test-utils', 'dist', 'index.js'),
    ).href;

    const workerPath = path.join(path.dirname(dbPath), 'crash-return-worker.mjs');
    fs.writeFileSync(
      workerPath,
      [
        `import { openLocalSqliteDatabase, createSqliteHubAuthStore, createSqliteReturnStore } from ${JSON.stringify(dbLocalUrl)};`,
        `import { moneyFromTiyin, parseUuidV7, quantityFromMilli } from ${JSON.stringify(domainUrl)};`,
        `import { FixedClock, SeededRandomSource } from ${JSON.stringify(testUtilsUrl)};`,
        '',
        'const [mode, targetDbPath, targetSaleId, targetLineId, actorId, reqId] = process.argv.slice(2);',
        `const clock = new FixedClock(${TASHKENT_235930_UTC_MS.toString()}n);`,
        'const random = new SeededRandomSource(77);',
        'const conn = openLocalSqliteDatabase(targetDbPath);',
        'const auth = await createSqliteHubAuthStore({ connection: conn, clock, random });',
        'const returnStore = createSqliteReturnStore({',
        '  connection: conn,',
        '  getRuntimeContext: () => {',
        '    const ctx = auth.getActiveRuntimeContext();',
        '    return ctx ? { uow: ctx.uow, organizationId: ctx.config.organizationId, storeId: ctx.config.storeId } : null;',
        '  },',
        '  __testHooks: { onBeforeCommit: () => process.exit(42) },',
        '});',
        'if (mode === "void") {',
        '  await returnStore.voidSale({',
        '    saleId: parseUuidV7(targetSaleId),',
        '    actorUserId: parseUuidV7(actorId),',
        '    reason: "Crash void",',
        '    clientRequestId: parseUuidV7(reqId),',
        '  });',
        '} else {',
        '  await returnStore.createReturn({',
        '    saleId: parseUuidV7(targetSaleId),',
        '    actorUserId: parseUuidV7(actorId),',
        '    reason: "Crash return",',
        '    clientRequestId: parseUuidV7(reqId),',
        '    items: [{ saleLineId: parseUuidV7(targetLineId), qty: quantityFromMilli(1000n) }],',
        '    payments: [{ method: "cash", amount: moneyFromTiyin(50000n) }],',
        '  });',
        '}',
      ].join('\n'),
      'utf8',
    );

    const reqCrashVoid = nextTestUuid();
    const childVoid = spawnSync(
      process.execPath,
      [
        workerPath,
        'void',
        dbPath,
        sale1.sale.id,
        sale1.sale.lines[0].id,
        env.managerId,
        reqCrashVoid,
      ],
      { encoding: 'utf8', timeout: 15_000 },
    );
    expect(childVoid.status).toBe(42);

    const reqCrashRet = nextTestUuid();
    const childRet = spawnSync(
      process.execPath,
      [
        workerPath,
        'return',
        dbPath,
        sale2.sale.id,
        sale2.sale.lines[0].id,
        env.managerId,
        reqCrashRet,
      ],
      { encoding: 'utf8', timeout: 15_000 },
    );
    expect(childRet.status).toBe(42);

    // Reopen DB: ZERO half-voided sales, ZERO partial returns/lines/payments/moves/outbox, sequences unchanged!
    const reopened = await setupEnvAfterCrash(
      dbPath,
      env.organizationId,
      env.storeId,
      env.deviceId,
    );
    try {
      expect(listAllOutboxRecordsSync(reopened.connection.db).length).toBe(baselineOutbox);
      expect(readDeviceStateRowSync(reopened.connection.db, env.deviceId)!.lastDeviceSeq).toBe(
        baselineSeq,
      );
      expect(readReturnSeqSync(reopened.connection.db, env.deviceId)).toBe(baselineRetSeq);
      expect(reopened.connection.db.select().from(stockMoves).all().length).toBe(
        baselineStockMoves,
      );
      expect(reopened.connection.db.select().from(cashMoves).all().length).toBe(baselineCashMoves);
      expect(reopened.connection.db.select().from(returns).all()).toHaveLength(0);
      expect(reopened.connection.db.select().from(returnLines).all()).toHaveLength(0);
      expect(reopened.connection.db.select().from(returnPayments).all()).toHaveLength(0);
      const sale1Row = reopened.connection.db
        .select()
        .from(sales)
        .where(eq(sales.id, sale1.sale.id))
        .get()!;
      expect(sale1Row.voidedAtMs).toBeNull();
      expect(sale1Row.voidClientRequestId).toBeNull();

      // Retry with the exact same clientRequestIds succeeds cleanly!
      const okVoid = await reopened.returnStore.voidSale({
        saleId: sale1.sale.id,
        actorUserId: env.managerId,
        reason: 'Crash void',
        clientRequestId: reqCrashVoid,
      });
      expect(okVoid.idempotentReplay).toBe(false);

      const okRet = await reopened.returnStore.createReturn({
        saleId: sale2.sale.id,
        actorUserId: env.managerId,
        reason: 'Crash return',
        clientRequestId: reqCrashRet,
        items: [{ saleLineId: sale2.sale.lines[0].id, qty: quantityFromMilli(1_000n) }],
        payments: [{ method: 'cash', amount: moneyFromTiyin(50_000n) }],
      });
      expect(okRet.returnDoc.returnNo).toBe(1n);
    } finally {
      reopened.connection.close();
    }
  }, 20_000);

  it('T1.6 test debt (1): voidSale restores exact pre-sale stock balances (all 6 fields incl. lastUnitCost != avg) & FIFO batches after two distinct unit-cost purchases', async () => {
    const env = await setupReturnEnv({ seed: 915 });
    try {
      await seedCashInDrawer(env, 1_000_000n, 915);

      const fifoProd = await env.catalogStore.createProduct({
        name: 'Void Exact FIFO',
        unit: 'kg',
        trackBatches: true,
        salePrice: '50000',
        vatRateBp: 0,
        actorUserId: env.ownerId,
      });
      const avgProd = await env.catalogStore.createProduct({
        name: 'Void Exact Avg',
        unit: 'kg',
        trackBatches: false,
        salePrice: '50000',
        vatRateBp: 0,
        actorUserId: env.ownerId,
      });

      // Two distinct unit costs so lastUnitCost (30_000) !== weighted average (20_000) & FIFO batch A cost (10_000)
      await env.stockStore.recordInboundMove({
        productId: fifoProd.product.id,
        reason: 'purchase',
        qty: '2000',
        totalCostValue: '20000',
        batchNumber: 'VA-1',
        actorUserId: env.ownerId,
      });
      await env.stockStore.recordInboundMove({
        productId: fifoProd.product.id,
        reason: 'purchase',
        qty: '2000',
        totalCostValue: '60000',
        batchNumber: 'VA-2',
        actorUserId: env.ownerId,
      });

      await env.stockStore.recordInboundMove({
        productId: avgProd.product.id,
        reason: 'purchase',
        qty: '2000',
        totalCostValue: '20000',
        actorUserId: env.ownerId,
      });
      await env.stockStore.recordInboundMove({
        productId: avgProd.product.id,
        reason: 'purchase',
        qty: '2000',
        totalCostValue: '60000',
        actorUserId: env.ownerId,
      });

      const fifoPreSale = readPoolSnapshot(
        env.connection,
        env.organizationId,
        env.storeId,
        fifoProd.product.id,
      );
      const avgPreSale = readPoolSnapshot(
        env.connection,
        env.organizationId,
        env.storeId,
        avgProd.product.id,
      );
      const fifoPreBatches = readNormalizedBatchSnapshots(
        env.connection,
        env.organizationId,
        env.storeId,
        fifoProd.product.id,
      );
      expect(fifoPreSale.lastUnitCost).toBe(30_000n);
      expect(avgPreSale.lastUnitCost).toBe(30_000n);

      const cart = await env.cartStore.openCart(env.cashierId);
      await env.cartStore.addLine(cart.id, {
        kind: 'catalog',
        productId: fifoProd.product.id,
        variantId: null,
        qty: quantityFromMilli(1_000n),
      });
      await env.cartStore.addLine(cart.id, {
        kind: 'catalog',
        productId: avgProd.product.id,
        variantId: null,
        qty: quantityFromMilli(1_000n),
      });

      const sale = await env.saleStore.completeSale({
        cartId: cart.id,
        actorUserId: env.cashierId,
        clientRequestId: nextTestUuid(),
        expectedTotal: moneyFromTiyin(100_000n),
        payments: [{ method: 'cash', tenderedAmount: moneyFromTiyin(100_000n) }],
      });

      await env.returnStore.voidSale({
        saleId: sale.sale.id,
        actorUserId: env.managerId,
        reason: 'T1.6 debt exact restore',
        clientRequestId: nextTestUuid(),
      });

      const fifoPostVoid = readPoolSnapshot(
        env.connection,
        env.organizationId,
        env.storeId,
        fifoProd.product.id,
      );
      const avgPostVoid = readPoolSnapshot(
        env.connection,
        env.organizationId,
        env.storeId,
        avgProd.product.id,
      );
      const fifoPostBatches = readNormalizedBatchSnapshots(
        env.connection,
        env.organizationId,
        env.storeId,
        fifoProd.product.id,
      );

      expect(fifoPostVoid).toEqual(fifoPreSale);
      expect(avgPostVoid).toEqual(avgPreSale);
      expect(fifoPostBatches).toEqual(fifoPreBatches);

      await env.stockStore.rebuildProjections();
      expect(
        readPoolSnapshot(env.connection, env.organizationId, env.storeId, fifoProd.product.id),
      ).toEqual(fifoPreSale);
      expect(
        readPoolSnapshot(env.connection, env.organizationId, env.storeId, avgProd.product.id),
      ).toEqual(avgPreSale);
    } finally {
      env.connection.close();
    }
  });

  it('T1.6 test debt (2): half-tiyin cumulative rounding in createReturn (final_total=10, 2.000 kg: 0.250->1, next 0.250->2)', async () => {
    const env = await setupReturnEnv({ seed: 916 });
    try {
      await seedCashInDrawer(env, 10_000n, 916);
      const prod = await env.catalogStore.createProduct({
        name: 'Half Tiyin Kg',
        unit: 'kg',
        trackBatches: false,
        salePrice: '5',
        vatRateBp: 0,
        actorUserId: env.ownerId,
      });
      await env.stockStore.recordInboundMove({
        productId: prod.product.id,
        reason: 'purchase',
        qty: '2000',
        totalCostValue: '4',
        actorUserId: env.ownerId,
      });

      const cart = await env.cartStore.openCart(env.cashierId);
      await env.cartStore.addLine(cart.id, {
        kind: 'catalog',
        productId: prod.product.id,
        variantId: null,
        qty: quantityFromMilli(2_000n),
      });
      const sale = await env.saleStore.completeSale({
        cartId: cart.id,
        actorUserId: env.cashierId,
        clientRequestId: nextTestUuid(),
        expectedTotal: moneyFromTiyin(10n),
        payments: [{ method: 'cash', tenderedAmount: moneyFromTiyin(10n) }],
      });
      const lineId = sale.sale.lines[0].id;
      expect(moneyToTiyin(sale.sale.lines[0].finalTotal)).toBe(10n);

      const ret1 = await env.returnStore.createReturn({
        saleId: sale.sale.id,
        actorUserId: env.managerId,
        reason: 'First 0.250 kg',
        clientRequestId: nextTestUuid(),
        items: [{ saleLineId: lineId, qty: quantityFromMilli(250n) }],
        payments: [{ method: 'cash', amount: moneyFromTiyin(1n) }],
      });
      expect(moneyToTiyin(ret1.returnDoc.totalRefund)).toBe(1n);

      const ret2 = await env.returnStore.createReturn({
        saleId: sale.sale.id,
        actorUserId: env.managerId,
        reason: 'Second 0.250 kg',
        clientRequestId: nextTestUuid(),
        items: [{ saleLineId: lineId, qty: quantityFromMilli(250n) }],
        payments: [{ method: 'cash', amount: moneyFromTiyin(2n) }],
      });
      expect(moneyToTiyin(ret2.returnDoc.totalRefund)).toBe(2n);
    } finally {
      env.connection.close();
    }
  });

  it('meets <= 300ms latency for full return of a 20-line tracked receipt (10 FIFO + 10 avg) on disk WAL SQLite', async () => {
    const samplesMs: number[] = [];
    for (let runIdx = 0; runIdx < 5; runIdx += 1) {
      const env = await setupReturnEnv({ seed: 600 + runIdx });
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

async function setupEnvAfterCrash(
  dbPath: string,
  expectedOrgId: UuidV7,
  expectedStoreId: UuidV7,
  expectedDeviceId: UuidV7,
) {
  const clock = new FixedClock(TASHKENT_235930_UTC_MS + 5_000n);
  const random = new SeededRandomSource(77);
  const connection = openLocalSqliteDatabase(dbPath);
  openConnections.push(connection);
  const authStore = await createSqliteHubAuthStore({ connection, clock, random });
  const ctx = authStore.getActiveRuntimeContext()!;
  expect(ctx.config.organizationId).toBe(expectedOrgId);
  expect(ctx.config.storeId).toBe(expectedStoreId);
  expect(ctx.config.deviceId).toBe(expectedDeviceId);

  const returnStore = createSqliteReturnStore({
    connection,
    getRuntimeContext: () => ({
      uow: ctx.uow,
      organizationId: ctx.config.organizationId,
      storeId: ctx.config.storeId,
    }),
  });
  return { connection, authStore, returnStore };
}
