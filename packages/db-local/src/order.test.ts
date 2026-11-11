import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  DEFAULT_MAX_CASH_DISCREPANCY_TIYIN,
  type PaymentMethod,
  type PinHasher,
  type UuidV7,
  ZERO_MONEY,
  epochDaysFromCivilDate,
  moneyFromTiyin,
  moneyToTiyin,
  parsePaymentMethod,
  parseUuidV7,
  quantityFromMilli,
  unixMsFromBigInt,
} from '@mezon/domain';
import { FixedClock, SeededRandomSource } from '@mezon/test-utils';
import { afterEach, describe, expect, it } from 'vitest';
import {
  type LocalSqliteConnection,
  type StoredShiftClosureRecord,
  createSqliteCartStore,
  createSqliteCatalogStore,
  createSqliteCustomerStore,
  createSqliteHubAuthStore,
  createSqliteOrderStore,
  createSqliteReturnStore,
  createSqliteSaleStore,
  createSqliteShiftStore,
  createSqliteStockStore,
  createSqliteUnitOfWork,
  localSchemaRegistry,
  migrateLocalDatabase,
  openLocalSqliteDatabase,
} from './index.js';

const FAST_TEST_HASHER: PinHasher = {
  hash: (pin) => Promise.resolve(`fast-hash:${pin}`),
  verify: (hash, pin) => Promise.resolve(hash === `fast-hash:${pin}`),
};

const tempDirs: string[] = [];
const openConnections: LocalSqliteConnection[] = [];

function makeTempDbPath(name = 'order-test.db'): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mezon-t110-order-'));
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

function makeUuid(prefixHex: number, seq: number): UuidV7 {
  const p = prefixHex.toString(16).padStart(8, '0');
  const t = seq.toString(16).padStart(12, '0');
  return parseUuidV7(`${p}-0000-7000-8000-${t}`);
}

function seededNextInt(random: SeededRandomSource, maxExclusive: number): number {
  const b = random.nextBytes(4);
  const v = ((b[0] << 24) | (b[1] << 16) | (b[2] << 8) | b[3]) >>> 0;
  return v % maxExclusive;
}

const DAY1_1000_MS = epochDaysFromCivilDate('2026-11-10') * 86_400_000n + 5n * 3_600_000n;

async function setupOrderEnv(options?: { readonly seed?: number }) {
  const dbPath = makeTempDbPath();
  const clock = new FixedClock(DAY1_1000_MS);
  const random = new SeededRandomSource(options?.seed ?? 110);
  const connection = openLocalSqliteDatabase(dbPath);
  openConnections.push(connection);
  migrateLocalDatabase(connection.db);

  const authStore = await createSqliteHubAuthStore({ connection, clock, random });
  const setup = await authStore.completeSetup({
    fullName: 'Owner 110',
    username: 'owner110',
    pinHash: await FAST_TEST_HASHER.hash('849201'),
  });
  const manager = await authStore.createUser({
    fullName: 'Manager 110',
    username: 'mgr110',
    role: 'manager',
    pinHash: await FAST_TEST_HASHER.hash('592817'),
  });
  const cashierA = await authStore.createUser({
    fullName: 'Cashier A',
    username: 'cash110a',
    role: 'cashier',
    pinHash: await FAST_TEST_HASHER.hash('374829'),
  });
  const cashierB = await authStore.createUser({
    fullName: 'Cashier B',
    username: 'cash110b',
    role: 'cashier',
    pinHash: await FAST_TEST_HASHER.hash('619283'),
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
  const cartStore = createSqliteCartStore({ connection, getRuntimeContext: getStoreCtx });
  const customerStore = createSqliteCustomerStore({ connection, getRuntimeContext: getStoreCtx });
  const saleStore = createSqliteSaleStore({ connection, getRuntimeContext: getStoreCtx });
  const returnStore = createSqliteReturnStore({ connection, getRuntimeContext: getStoreCtx });
  const shiftStore = createSqliteShiftStore({ connection, getRuntimeContext: getStoreCtx });
  const orderStore = createSqliteOrderStore({ connection, getRuntimeContext: getStoreCtx });

  let seq = 1;
  const nextUuid = () => makeUuid(0x01a0, seq++);

  return {
    dbPath,
    clock,
    random,
    connection,
    authStore,
    catalogStore,
    stockStore,
    cartStore,
    customerStore,
    saleStore,
    returnStore,
    shiftStore,
    orderStore,
    organizationId: setup.organizationId,
    storeId: setup.storeId,
    deviceId: setup.deviceId,
    ownerId: setup.owner.id,
    managerId: manager.id,
    cashierAId: cashierA.id,
    cashierBId: cashierB.id,
    nextUuid,
  };
}

describe('@mezon/db-local - T1.10 Customer Orders, Frozen Evaluation (O3), Advances (O4), Frozen Delivery (O2), Return Spread (O1) & Model Test', () => {
  it('O3: evaluates order once via T1.3 promos & manual discount limits, preserves idempotency, and enforces MONOTONE transitions', async () => {
    const env = await setupOrderEnv();
    await env.cartStore.updateDiscountSettings({
      cashierDiscountLimit: {
        percentUnlimited: false,
        maxPercentBp: 500n, // max 5%
        amountUnlimited: false,
        maxAmount: moneyFromTiyin(5_000_00n),
      },
      quickSaleDefaultMxik: '99999999999999999',
      quickSaleDefaultVatRateBp: 1200,
    });

    const catProd = await env.catalogStore.createProduct({
      name: 'Tort Napoleon',
      unit: 'dona',
      unlimited: false,
      salePrice: '10000000', // 100,000 UZS
      vatRateBp: 1200,
      actorUserId: env.ownerId,
    });

    await env.cartStore.createPromotion({
      storeId: env.storeId,
      name: 'Tort 10%',
      type: 'percent',
      scope: 'product',
      targetProductId: catProd.product.id,
      targetCategoryId: null,
      discountPercentBp: 1000,
      discountAmount: null,
      buyQty: null,
      freeQty: null,
      startsAtMs: unixMsFromBigInt(DAY1_1000_MS),
      endsAtMs: null,
      isActive: true,
    });

    // Exceeding cashier limit without supervisor override -> DISCOUNT_OVERRIDE_REQUIRED
    await expect(
      env.orderStore.createOrder({
        actorUserId: env.cashierAId,
        clientRequestId: env.nextUuid(),
        customerName: 'Madina',
        customerPhone: '90 123-45-67',
        discount: {
          mode: 'amount',
          amount: moneyFromTiyin(15_000_00n), // 15,000 > 5,000 limit
          reason: 'VIP',
          approvedSupervisorUserId: null,
        },
        lines: [{ kind: 'catalog', productId: catProd.product.id, qty: quantityFromMilli(1_000n) }],
      }),
    ).rejects.toMatchObject({ code: 'DISCOUNT_OVERRIDE_REQUIRED' });

    const reqId = env.nextUuid();
    const created = await env.orderStore.createOrder({
      actorUserId: env.cashierAId,
      clientRequestId: reqId,
      customerName: 'Madina Karimova',
      customerPhone: '90 123-45-67',
      note: 'Yozuvi: Tabrik',
      discount: {
        mode: 'amount',
        amount: moneyFromTiyin(15_000_00n),
        reason: 'VIP',
        approvedSupervisorUserId: env.managerId,
      },
      overrideApprovedByUserId: env.managerId,
      lines: [
        { kind: 'catalog', productId: catProd.product.id, qty: quantityFromMilli(1_000n) }, // 100k - 10% = 90k
        {
          kind: 'quick_sale',
          name: 'Quticha + sham',
          unit: 'dona',
          qty: quantityFromMilli(1_000n),
          unitPrice: moneyFromTiyin(25_000_00n), // 25k
        },
      ],
    });
    expect(created.idempotentReplay).toBe(false);
    expect(created.order.status).toBe('draft');
    expect(created.order.customerPhoneNormalized).toBe('+998901234567');
    expect(created.order.subtotalGross).toBe(moneyFromTiyin(125_000_00n));
    expect(created.order.totalPromoDiscount).toBe(moneyFromTiyin(10_000_00n));
    expect(created.order.orderDiscountAmount).toBe(moneyFromTiyin(15_000_00n));
    expect(created.order.totalAmount).toBe(moneyFromTiyin(100_000_00n));
    expect(created.order.lines[1]?.vatRateBpSnapshot).toBe(1200);
    expect(created.order.lines[1]?.mxikSnapshot).toBe('99999999999999999');

    // Replay same clientRequestId -> returns exact same order
    const replay = await env.orderStore.createOrder({
      actorUserId: env.cashierAId,
      clientRequestId: reqId,
      customerName: 'Madina Karimova',
      customerPhone: '90 123-45-67',
      note: 'Yozuvi: Tabrik',
      discount: {
        mode: 'amount',
        amount: moneyFromTiyin(15_000_00n),
        reason: 'VIP',
        approvedSupervisorUserId: env.managerId,
      },
      overrideApprovedByUserId: env.managerId,
      lines: [
        { kind: 'catalog', productId: catProd.product.id, qty: quantityFromMilli(1_000n) },
        {
          kind: 'quick_sale',
          name: 'Quticha + sham',
          unit: 'dona',
          qty: quantityFromMilli(1_000n),
          unitPrice: moneyFromTiyin(25_000_00n),
        },
      ],
    });
    expect(replay.idempotentReplay).toBe(true);
    expect(replay.order.id).toBe(created.order.id);

    // Invalid transition draft -> ready blocked
    await expect(
      env.orderStore.markOrderReady({
        orderId: created.order.id,
        actorUserId: env.cashierAId,
        clientRequestId: env.nextUuid(),
      }),
    ).rejects.toMatchObject({ code: 'ORDER_INVALID_TRANSITION' });

    const confirmed = await env.orderStore.confirmOrder({
      orderId: created.order.id,
      actorUserId: env.cashierAId,
      clientRequestId: env.nextUuid(),
    });
    expect(confirmed.order.status).toBe('confirmed');

    const ready = await env.orderStore.markOrderReady({
      orderId: created.order.id,
      actorUserId: env.cashierAId,
      clientRequestId: env.nextUuid(),
    });
    expect(ready.order.status).toBe('ready');
  });

  it('O1, O2, O4, T1.6 & T1.9: cross-shift advance -> price/promo freeze at delivery -> voidSale rejected (ORDER_SALE_USE_RETURN) -> createReturn spreads advance', async () => {
    const env = await setupOrderEnv();
    const cust = await env.customerStore.createCustomer({
      fullName: 'Sardor Mijoz',
      phone: '91 222-33-44',
      creditLimit: moneyFromTiyin(500_000_00n),
      defaultDueDays: 14,
    });
    const prod = await env.catalogStore.createProduct({
      name: 'Maxsus Tort',
      unit: 'dona',
      unlimited: false,
      salePrice: '10000000', // 100,000 UZS
      vatRateBp: 0,
      actorUserId: env.ownerId,
    });
    await env.stockStore.recordInboundMove({
      productId: prod.product.id,
      reason: 'purchase',
      qty: '10000',
      totalCostValue: '50000000', // 50,000 UZS per unit
      actorUserId: env.ownerId,
    });
    const promo = await env.cartStore.createPromotion({
      storeId: env.storeId,
      name: 'Buyurtma 10%',
      type: 'percent',
      scope: 'product',
      targetProductId: prod.product.id,
      targetCategoryId: null,
      discountPercentBp: 1000,
      discountAmount: null,
      buyQty: null,
      freeQty: null,
      startsAtMs: unixMsFromBigInt(DAY1_1000_MS),
      endsAtMs: null,
      isActive: true,
    });

    // Day 1 / Shift 1: Create draft order (2 units * 100k - 10% = 180,000 UZS)
    const sh1 = await env.shiftStore.openShift({
      actorUserId: env.cashierAId,
      clientRequestId: env.nextUuid(),
      openingCash: moneyFromTiyin(50_000_00n), // 50,000 float
    });
    const ord = await env.orderStore.createOrder({
      actorUserId: env.cashierAId,
      clientRequestId: env.nextUuid(),
      customerId: cust.id,
      customerName: cust.fullName,
      lines: [{ kind: 'catalog', productId: prod.product.id, qty: quantityFromMilli(2_000n) }],
    });
    expect(ord.order.totalAmount).toBe(moneyFromTiyin(180_000_00n));

    // Deposit mixed advance (cash 60k tendered=100k change=40k + card 40k => netAdvance 100k), auto-confirms draft!
    const adv = await env.orderStore.recordOrderAdvance({
      orderId: ord.order.id,
      actorUserId: env.cashierAId,
      clientRequestId: env.nextUuid(),
      payments: [
        {
          method: 'cash',
          tenderedAmount: moneyFromTiyin(100_000_00n),
          amount: moneyFromTiyin(60_000_00n),
        },
        { method: 'card', amount: moneyFromTiyin(40_000_00n), providerRef: 'ADV-CARD-1' },
      ],
    });
    expect(adv.order.status).toBe('confirmed');
    expect(adv.order.netAdvance).toBe(moneyFromTiyin(100_000_00n));
    expect(adv.order.remainingToPay).toBe(moneyFromTiyin(80_000_00n));

    // Exceeding order total fails with ORDER_ADVANCE_EXCEEDS_TOTAL
    await expect(
      env.orderStore.recordOrderAdvance({
        orderId: ord.order.id,
        actorUserId: env.cashierAId,
        clientRequestId: env.nextUuid(),
        payments: [{ method: 'card', amount: moneyFromTiyin(80_000_01n) }],
      }),
    ).rejects.toMatchObject({ code: 'ORDER_ADVANCE_EXCEEDS_TOTAL' });

    // O4: Open advances = 100k (60k cash + 40k card)
    const openAdv1 = await env.orderStore.getOpenAdvancesTotal();
    expect(openAdv1.totalOpenAdvance).toBe(moneyFromTiyin(100_000_00n));
    expect(openAdv1.byMethod.cash).toBe(moneyFromTiyin(60_000_00n));
    expect(openAdv1.byMethod.card).toBe(moneyFromTiyin(40_000_00n));

    // Advance refund method limit check & cashier supervisor gate
    await expect(
      env.orderStore.refundOrderAdvance({
        orderId: ord.order.id,
        actorUserId: env.cashierAId,
        clientRequestId: env.nextUuid(),
        reason: 'Qisman qaytarish',
        refunds: [{ method: 'cash', amount: moneyFromTiyin(10_000_00n) }],
      }),
    ).rejects.toMatchObject({ code: 'SUPERVISOR_OVERRIDE_REQUIRED' });

    await expect(
      env.orderStore.refundOrderAdvance({
        orderId: ord.order.id,
        actorUserId: env.cashierAId,
        overrideApprovedByUserId: env.managerId,
        clientRequestId: env.nextUuid(),
        reason: 'Karta limit oshdi',
        refunds: [{ method: 'card', amount: moneyFromTiyin(45_000_00n) }],
      }),
    ).rejects.toMatchObject({ code: 'ORDER_ADVANCE_REFUND_EXCEEDED' });

    // Refund 10k cash cleanly with supervisor approval -> open advances = 50k cash + 40k card = 90k
    await env.orderStore.refundOrderAdvance({
      orderId: ord.order.id,
      actorUserId: env.cashierAId,
      overrideApprovedByUserId: env.managerId,
      clientRequestId: env.nextUuid(),
      reason: 'Qisman naqd qaytarish',
      refunds: [{ method: 'cash', amount: moneyFromTiyin(10_000_00n) }],
    });

    // Close Shift #1 -> sales revenue MUST BE 0 while expectedCash = 50k + 60k - 10k = 100k and advance columns reflect exact figures
    const sh1Close = await env.shiftStore.closeShift({
      shiftId: sh1.shift.id,
      actorUserId: env.cashierAId,
      clientRequestId: env.nextUuid(),
      countedCash: moneyFromTiyin(100_000_00n),
    });
    expect(sh1Close.closure.grossSalesTotal).toBe(ZERO_MONEY);
    expect(sh1Close.closure.netSalesTotal).toBe(ZERO_MONEY);
    expect(sh1Close.closure.expectedCash).toBe(moneyFromTiyin(100_000_00n));
    expect(sh1Close.closure.orderAdvanceCashTotal).toBe(moneyFromTiyin(60_000_00n));
    expect(sh1Close.closure.orderAdvanceNonCashTotal).toBe(moneyFromTiyin(40_000_00n));
    expect(sh1Close.closure.orderAdvanceRefundTotal).toBe(moneyFromTiyin(10_000_00n));

    const vSalesSh1 = env.connection.sqlite
      .prepare('SELECT COUNT(*) as cnt FROM v_sales_lines WHERE shift_id = ?')
      .get(sh1.shift.id) as { readonly cnt: bigint };
    expect(vSalesSh1.cnt).toBe(0n);

    // O2 MUTATION ON CATALOG & PROMOS BEFORE DELIVERY:
    // Price doubles (100k -> 200k) and promo deactivated! Delivery MUST keep frozen order total = 180,000 UZS!
    await env.catalogStore.updateProduct(prod.product.id, {
      salePrice: '20000000',
      priceChangeReason: 'Narx oshdi',
      actorUserId: env.ownerId,
    });
    await env.cartStore.updatePromotion(promo.id, { isActive: false });

    // Day 2 / Shift 2: Open Shift #2 -> deliver order with 90k 'advance' + 50k cash + 40k debt = 180k
    env.clock.advance(86_400_000n);
    const sh2 = await env.shiftStore.openShift({
      actorUserId: env.cashierBId,
      clientRequestId: env.nextUuid(),
      openingCash: moneyFromTiyin(100_000_00n),
    });

    const cashMovesBeforeDeliver = env.connection.sqlite
      .prepare('SELECT COUNT(*) as cnt FROM cash_moves WHERE shift_id = ?')
      .get(sh2.shift.id) as { readonly cnt: bigint };

    const delivered = await env.orderStore.deliverOrder({
      orderId: ord.order.id,
      actorUserId: env.cashierBId,
      clientRequestId: env.nextUuid(),
      expectedTotal: moneyFromTiyin(180_000_00n),
      debtAmount: moneyFromTiyin(40_000_00n),
      payments: [{ method: 'cash', tenderedAmount: moneyFromTiyin(50_000_00n) }],
    });
    expect(delivered.idempotentReplay).toBe(false);
    expect(delivered.order.status).toBe('delivered');
    expect(delivered.sale.sourceOrderId).toBe(ord.order.id);
    expect(delivered.sale.totalFinal).toBe(moneyFromTiyin(180_000_00n));
    expect(delivered.sale.totalPromoDiscount).toBe(moneyFromTiyin(20_000_00n));
    expect(delivered.sale.debtAmount).toBe(moneyFromTiyin(40_000_00n));
    expect(delivered.sale.payments.map((p) => [p.method, p.amount])).toEqual([
      ['advance', moneyFromTiyin(90_000_00n)],
      ['cash', moneyFromTiyin(50_000_00n)],
    ]);

    // Verify cash_moves ONLY gained 1 sale_cash_in (+50k) and ZERO extra move for 'advance'!
    const sh2Moves = env.connection.sqlite
      .prepare('SELECT type, amount_delta FROM cash_moves WHERE shift_id = ?')
      .all(sh2.shift.id) as Array<{ readonly type: string; readonly amount_delta: bigint }>;
    expect(cashMovesBeforeDeliver.cnt).toBe(0n);
    expect(sh2Moves).toEqual([{ type: 'sale_cash_in', amount_delta: 50_000_00n }]);

    // O4: Delivered order reduces open advances to ZERO
    const openAdvAfterDeliver = await env.orderStore.getOpenAdvancesTotal();
    expect(openAdvAfterDeliver.totalOpenAdvance).toBe(ZERO_MONEY);

    // O1: Attempting voidSale on delivered order sale MUST reject with ORDER_SALE_USE_RETURN
    await expect(
      env.returnStore.voidSale({
        saleId: delivered.sale.id,
        actorUserId: env.managerId,
        reason: 'Bekor qilish urinishi',
        clientRequestId: env.nextUuid(),
      }),
    ).rejects.toMatchObject({ code: 'ORDER_SALE_USE_RETURN' });

    // T1.6: Returning against delivered order sale expands 'advance' (50k cash + 40k card) -> cash cap 50k+50k=100k, card cap=40k!
    const saleLineId = delivered.sale.lines[0].id;
    // Exceeding 40k card cap rejected
    await expect(
      env.returnStore.createReturn({
        saleId: delivered.sale.id,
        actorUserId: env.managerId,
        reason: 'Ortiqcha karta qaytarish',
        clientRequestId: env.nextUuid(),
        items: [{ saleLineId, qty: quantityFromMilli(1_000n) }],
        payments: [
          { method: 'cash', amount: moneyFromTiyin(45_000_00n) },
          { method: 'card', amount: moneyFromTiyin(45_000_00n) },
        ],
      }),
    ).rejects.toMatchObject({ code: 'RETURN_PAYMENT_LIMIT_EXCEEDED' });

    // Valid partial return of 1 unit (90k): 50k cash + 40k card succeeds!
    const ret = await env.returnStore.createReturn({
      saleId: delivered.sale.id,
      actorUserId: env.managerId,
      reason: '1 dona qaytarildi',
      clientRequestId: env.nextUuid(),
      items: [{ saleLineId, qty: quantityFromMilli(1_000n) }],
      payments: [
        { method: 'cash', amount: moneyFromTiyin(50_000_00n) },
        { method: 'card', amount: moneyFromTiyin(40_000_00n), providerRef: 'RET-1' },
      ],
    });
    expect(ret.returnDoc.totalRefund).toBe(moneyFromTiyin(90_000_00n));

    // Close Shift #2 -> expectedCash = 100k + 50k - 50k = 100k, netSalesTotal = 180k - 90k = 90k, methodTotals includes 'advance'=90k
    const sh2Close = await env.shiftStore.closeShift({
      shiftId: sh2.shift.id,
      actorUserId: env.cashierBId,
      clientRequestId: env.nextUuid(),
      countedCash: moneyFromTiyin(100_000_00n),
    });
    expect(sh2Close.closure.expectedCash).toBe(moneyFromTiyin(100_000_00n));
    expect(sh2Close.closure.grossSalesTotal).toBe(moneyFromTiyin(180_000_00n));
    expect(sh2Close.closure.returnsTotal).toBe(moneyFromTiyin(90_000_00n));
    expect(sh2Close.closure.netSalesTotal).toBe(moneyFromTiyin(90_000_00n));
    expect(sh2Close.closure.methodTotals.find((m) => m.method === 'advance')?.salesAmount).toBe(
      moneyFromTiyin(90_000_00n),
    );
  });

  it('enforces SQLite MONOTONE, FACT, & X5 closed-shift INSERT guard triggers on orders, order_lines & order_payments', async () => {
    const env = await setupOrderEnv();
    const sh1 = await env.shiftStore.openShift({
      actorUserId: env.cashierAId,
      clientRequestId: env.nextUuid(),
      openingCash: moneyFromTiyin(100_000_00n),
    });

    const ord = await env.orderStore.createOrder({
      actorUserId: env.cashierAId,
      clientRequestId: env.nextUuid(),
      customerName: 'Trigger Test',
      lines: [
        {
          kind: 'quick_sale',
          name: 'Custom',
          unit: 'dona',
          qty: quantityFromMilli(1_000n),
          unitPrice: moneyFromTiyin(50_000_00n),
        },
      ],
    });
    await env.orderStore.recordOrderAdvance({
      orderId: ord.order.id,
      actorUserId: env.cashierAId,
      clientRequestId: env.nextUuid(),
      payments: [{ method: 'cash', tenderedAmount: moneyFromTiyin(20_000_00n) }],
    });

    // Mutating order totalAmount or invalid status regression blocked by trigger
    expect(() =>
      env.connection.sqlite
        .prepare('UPDATE "orders" SET "total_amount" = 999 WHERE "id" = ?')
        .run(ord.order.id),
    ).toThrowError(/MONOTONE table "orders"/);

    expect(() =>
      env.connection.sqlite
        .prepare('UPDATE "orders" SET "status" = \'draft\' WHERE "id" = ?')
        .run(ord.order.id),
    ).toThrowError(/MONOTONE table "orders"/);

    expect(() =>
      env.connection.sqlite.prepare('DELETE FROM "orders" WHERE "id" = ?').run(ord.order.id),
    ).toThrowError(/MONOTONE table "orders"/);

    expect(() =>
      env.connection.sqlite
        .prepare('UPDATE "order_lines" SET "final_total" = 0 WHERE "order_id" = ?')
        .run(ord.order.id),
    ).toThrowError(/FACT table "order_lines"/);

    expect(() =>
      env.connection.sqlite
        .prepare('DELETE FROM "order_payments" WHERE "order_id" = ?')
        .run(ord.order.id),
    ).toThrowError(/FACT table "order_payments"/);

    // Cancel order -> auto-refunds 20k cash & locks order in terminal 'cancelled'
    await env.orderStore.cancelOrder({
      orderId: ord.order.id,
      actorUserId: env.managerId,
      reason: 'Cancelled by trigger test',
      clientRequestId: env.nextUuid(),
    });
    expect(() =>
      env.connection.sqlite
        .prepare(
          'UPDATE "orders" SET "status" = \'delivered\', "delivered_at_ms" = 1760000000000, "delivered_sale_id" = ? WHERE "id" = ?',
        )
        .run(ord.order.id, ord.order.id),
    ).toThrowError(/MONOTONE table "orders" cannot be modified/);

    // Close shift -> closed-shift X5 guard blocks inserting order_payments into closed shift
    await env.shiftStore.closeShift({
      shiftId: sh1.shift.id,
      actorUserId: env.cashierAId,
      clientRequestId: env.nextUuid(),
      countedCash: moneyFromTiyin(100_000_00n),
    });

    const rowSample = env.connection.sqlite
      .prepare('SELECT * FROM "order_payments" LIMIT 1')
      .get() as Record<string, unknown>;
    expect(() =>
      env.connection.sqlite
        .prepare(
          `INSERT INTO "order_payments" ("id","organization_id","store_id","device_id","hlc","created_at_ms","order_id","shift_id","shift_cashier_session_id","kind","method","amount","tendered_amount","change_amount","provider_ref","reason","created_by_user_id","override_approved_by_user_id","seq","client_request_id","request_hash")
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'advance', 'card', 1000, NULL, 0, NULL, NULL, ?, NULL, 0, ?, 'hash12345')`,
        )
        .run(
          env.nextUuid(),
          rowSample.organization_id,
          rowSample.store_id,
          rowSample.device_id,
          rowSample.hlc,
          rowSample.created_at_ms,
          ord.order.id,
          sh1.shift.id,
          rowSample.shift_cashier_session_id,
          env.cashierAId,
          env.nextUuid(),
        ),
    ).toThrowError(/already closed shift/);
  });

  it('model test (>= 225 steps across 2 terminals, multiple shifts & days): O4 invariant + closure parity to exact tiyin at EVERY step', async () => {
    const env = await setupOrderEnv({ seed: 1102026 });
    await env.cartStore.updateDiscountSettings({
      cashierDiscountLimit: {
        percentUnlimited: true,
        maxPercentBp: 0n,
        amountUnlimited: true,
        maxAmount: ZERO_MONEY,
      },
      quickSaleDefaultMxik: null,
      quickSaleDefaultVatRateBp: 0,
    });

    const cust1 = await env.customerStore.createCustomer({
      fullName: 'VIP Mijoz Model',
      phone: '90 555-66-77',
      creditLimit: moneyFromTiyin(50_000_000_00n),
      defaultDueDays: 14,
    });

    const prodCatalog = await env.catalogStore.createProduct({
      name: 'Tort Model',
      unit: 'dona',
      unlimited: true,
      salePrice: '5000000', // 50,000 UZS
      vatRateBp: 0,
      actorUserId: env.ownerId,
    });

    const deviceB = parseUuidV7('01950000-0000-7000-8000-ddddddddddd2');
    const uowB = await createSqliteUnitOfWork({
      connection: env.connection,
      organizationId: env.organizationId,
      deviceId: deviceB,
      registry: localSchemaRegistry,
      clock: env.clock,
      random: env.random,
    });
    const getStoreCtxB = () => ({
      uow: uowB,
      organizationId: env.organizationId,
      storeId: env.storeId,
    });

    const termA = {
      shiftStore: env.shiftStore,
      orderStore: env.orderStore,
      returnStore: env.returnStore,
    };
    const termB = {
      shiftStore: createSqliteShiftStore({
        connection: env.connection,
        getRuntimeContext: getStoreCtxB,
      }),
      orderStore: createSqliteOrderStore({
        connection: env.connection,
        getRuntimeContext: getStoreCtxB,
      }),
      returnStore: createSqliteReturnStore({
        connection: env.connection,
        getRuntimeContext: getStoreCtxB,
      }),
    };
    const terms = [termA, termB] as const;

    interface ModelOrder {
      readonly id: UuidV7;
      readonly termIdx: 0 | 1;
      status: 'draft' | 'confirmed' | 'ready' | 'delivered' | 'cancelled';
      readonly totalAmount: bigint;
      readonly hasCustomer: boolean;
      netByMethod: Record<PaymentMethod, bigint>;
      netTotal: bigint;
      deliveredSaleId: UuidV7 | null;
      deliveredSaleLineId: UuidV7 | null;
      deliveredQtyMilli: bigint;
      returnedQtyMilli: bigint;
      deliveredAdditionalByMethod: Record<PaymentMethod, bigint>;
      returnedByMethod: Record<PaymentMethod, bigint>;
    }

    interface ModelShift {
      readonly shiftId: UuidV7;
      readonly openingCash: bigint;
      cashMovesNet: bigint;
      grossSales: bigint;
      returnsTotal: bigint;
      debtSales: bigint;
      returnDebtOffset: bigint;
      salesCount: number;
      returnsCount: number;
      methodSales: Map<PaymentMethod | 'advance', bigint>;
      methodReturns: Map<PaymentMethod, bigint>;
      advCash: bigint;
      advNonCash: bigint;
      advRefund: bigint;
      activeCashierId: UuidV7;
      activeDrawerCash: bigint;
    }

    const zeroMethodMap = (): Record<PaymentMethod, bigint> => ({
      cash: 0n,
      card: 0n,
      uzqr: 0n,
      payme: 0n,
      click: 0n,
      uzum: 0n,
      social_card: 0n,
      other: 0n,
    });

    let modelTotalAdvanceIn = 0n;
    let modelTotalAdvanceRefund = 0n;
    let modelTotalAdvanceAppliedAtDelivery = 0n;
    const modelOpenByMethod = zeroMethodMap();

    const ordersList: ModelOrder[] = [];
    const activeShifts: [ModelShift | null, ModelShift | null] = [null, null];
    let catalogPriceTiyin = 50_000_00n;

    const assertO4Parity = async () => {
      const openAdv = await env.orderStore.getOpenAdvancesTotal();
      expect(moneyToTiyin(openAdv.totalOpenAdvance)).toBe(
        modelTotalAdvanceIn - modelTotalAdvanceRefund - modelTotalAdvanceAppliedAtDelivery,
      );
      for (const m of ['cash', 'card', 'uzqr', 'payme'] as const) {
        expect(moneyToTiyin(openAdv.byMethod[m])).toBe(modelOpenByMethod[m]);
      }
    };

    const verifyClosure = (closure: StoredShiftClosureRecord, ms: ModelShift) => {
      const expectedCash = ms.openingCash + ms.cashMovesNet;
      expect(moneyToTiyin(closure.expectedCash)).toBe(expectedCash);
      expect(moneyToTiyin(closure.grossSalesTotal)).toBe(ms.grossSales);
      expect(moneyToTiyin(closure.returnsTotal)).toBe(ms.returnsTotal);
      expect(moneyToTiyin(closure.netSalesTotal)).toBe(ms.grossSales - ms.returnsTotal);
      expect(moneyToTiyin(closure.orderAdvanceCashTotal)).toBe(ms.advCash);
      expect(moneyToTiyin(closure.orderAdvanceNonCashTotal)).toBe(ms.advNonCash);
      expect(moneyToTiyin(closure.orderAdvanceRefundTotal)).toBe(ms.advRefund);
      expect(closure.salesCount).toBe(ms.salesCount);
      expect(closure.returnsCount).toBe(ms.returnsCount);

      for (const m of ['cash', 'card', 'uzqr', 'payme', 'advance', 'debt'] as const) {
        const sAmt = m === 'debt' ? ms.debtSales : (ms.methodSales.get(m) ?? 0n);
        const rAmt =
          m === 'debt'
            ? ms.returnDebtOffset
            : m === 'advance'
              ? 0n
              : (ms.methodReturns.get(parsePaymentMethod(m)) ?? 0n);
        const row = closure.methodTotals.find((x) => x.method === m)!;
        expect(moneyToTiyin(row.salesAmount)).toBe(sAmt);
        expect(moneyToTiyin(row.returnsAmount)).toBe(rAmt);
        expect(moneyToTiyin(row.netAmount)).toBe(sAmt - rAmt);
      }

      const vRow = env.connection.sqlite
        .prepare(
          'SELECT COALESCE(SUM(signed_final_total), 0) as net_v FROM v_sales_lines WHERE shift_id = ?',
        )
        .get(ms.shiftId) as { readonly net_v: bigint | number };
      expect(BigInt(vRow.net_v)).toBe(ms.grossSales - ms.returnsTotal);
    };

    // Open initial shifts on both terminals
    for (const tIdx of [0, 1] as const) {
      const cashierId = tIdx === 0 ? env.cashierAId : env.cashierBId;
      const openCash = 500_000_00n;
      const sh = await terms[tIdx].shiftStore.openShift({
        actorUserId: cashierId,
        clientRequestId: env.nextUuid(),
        openingCash: moneyFromTiyin(openCash),
      });
      activeShifts[tIdx] = {
        shiftId: sh.shift.id,
        openingCash: openCash,
        cashMovesNet: 0n,
        grossSales: 0n,
        returnsTotal: 0n,
        debtSales: 0n,
        returnDebtOffset: 0n,
        salesCount: 0,
        returnsCount: 0,
        methodSales: new Map(),
        methodReturns: new Map(),
        advCash: 0n,
        advNonCash: 0n,
        advRefund: 0n,
        activeCashierId: cashierId,
        activeDrawerCash: openCash,
      };
    }

    const TOTAL_STEPS = 225;
    for (let step = 1; step <= TOTAL_STEPS; step += 1) {
      const tIdx: 0 | 1 = (step % 2) as 0 | 1;
      const term = terms[tIdx];
      let ms = activeShifts[tIdx];

      if (ms === null) {
        const cashierId = tIdx === 0 ? env.cashierAId : env.cashierBId;
        const openCash = 500_000_00n;
        const sh = await term.shiftStore.openShift({
          actorUserId: cashierId,
          clientRequestId: env.nextUuid(),
          openingCash: moneyFromTiyin(openCash),
          openingDiscrepancyReason: `Model step ${String(step)}`,
        });
        ms = {
          shiftId: sh.shift.id,
          openingCash: openCash,
          cashMovesNet: 0n,
          grossSales: 0n,
          returnsTotal: 0n,
          debtSales: 0n,
          returnDebtOffset: 0n,
          salesCount: 0,
          returnsCount: 0,
          methodSales: new Map(),
          methodReturns: new Map(),
          advCash: 0n,
          advNonCash: 0n,
          advRefund: 0n,
          activeCashierId: cashierId,
          activeDrawerCash: openCash,
        };
        activeShifts[tIdx] = ms;
      } else {
        const openOrders = ordersList.filter(
          (o) => o.status === 'draft' || o.status === 'confirmed' || o.status === 'ready',
        );
        const returnableOrders = ordersList.filter(
          (o) => o.status === 'delivered' && o.deliveredQtyMilli > o.returnedQtyMilli,
        );
        const op = seededNextInt(env.random, 100);

        if (step % 35 === 0) {
          // Shift close (every 35 steps, leaving historical open orders to span across shifts!)
          const expCash = ms.openingCash + ms.cashMovesNet;
          const res = await term.shiftStore.closeShift({
            shiftId: ms.shiftId,
            actorUserId: ms.activeCashierId,
            clientRequestId: env.nextUuid(),
            countedCash: moneyFromTiyin(expCash),
          });
          verifyClosure(res.closure, ms);
          activeShifts[tIdx] = null;
        } else if (step % 70 === 15) {
          // Price hike to continuously exercise O2 delivery price freeze!
          catalogPriceTiyin += 5_000_00n;
          await env.catalogStore.updateProduct(prodCatalog.product.id, {
            salePrice: catalogPriceTiyin.toString(),
            priceChangeReason: `Price tick ${String(step)}`,
            actorUserId: env.ownerId,
          });
        } else if (op < 28 || openOrders.length < 2) {
          // Create new order (mix catalog + quick_sale)
          const useCust = op % 2 === 0;
          const catUnits = BigInt(1 + seededNextInt(env.random, 3));
          const qsPrice = BigInt(1 + seededNextInt(env.random, 3)) * 10_000_00n;
          const expectedTotal = catUnits * catalogPriceTiyin + qsPrice;
          const created = await term.orderStore.createOrder({
            actorUserId: ms.activeCashierId,
            clientRequestId: env.nextUuid(),
            customerId: useCust ? cust1.id : null,
            customerName: useCust ? cust1.fullName : `Walk-in ${String(step)}`,
            confirmImmediately: op % 3 === 0,
            lines: [
              {
                kind: 'catalog',
                productId: prodCatalog.product.id,
                qty: quantityFromMilli(catUnits * 1_000n),
              },
              {
                kind: 'quick_sale',
                name: `Dekor ${String(step)}`,
                unit: 'dona',
                qty: quantityFromMilli(1_000n),
                unitPrice: moneyFromTiyin(qsPrice),
              },
            ],
          });
          expect(moneyToTiyin(created.order.totalAmount)).toBe(expectedTotal);
          ordersList.push({
            id: created.order.id,
            termIdx: tIdx,
            status: created.order.status,
            totalAmount: expectedTotal,
            hasCustomer: useCust,
            netByMethod: zeroMethodMap(),
            netTotal: 0n,
            deliveredSaleId: null,
            deliveredSaleLineId: null,
            deliveredQtyMilli: catUnits * 1_000n,
            returnedQtyMilli: 0n,
            deliveredAdditionalByMethod: zeroMethodMap(),
            returnedByMethod: zeroMethodMap(),
          });
        } else if (op < 55) {
          // Record advance (cash w/ possible change or card/uzqr) on random open order
          const target = openOrders[seededNextInt(env.random, openOrders.length)];
          const rem = target.totalAmount - target.netTotal;
          if (rem >= 10_000_00n) {
            const take = rem >= 40_000_00n ? 30_000_00n : rem;
            const mChoice = (['cash', 'card', 'uzqr', 'payme'] as const)[
              seededNextInt(env.random, 4)
            ];
            const tendered = mChoice === 'cash' ? take + 5_000_00n : take;
            const res = await term.orderStore.recordOrderAdvance({
              orderId: target.id,
              actorUserId: ms.activeCashierId,
              clientRequestId: env.nextUuid(),
              payments: [
                mChoice === 'cash'
                  ? {
                      method: 'cash',
                      tenderedAmount: moneyFromTiyin(tendered),
                      amount: moneyFromTiyin(take),
                    }
                  : { method: mChoice, amount: moneyFromTiyin(take) },
              ],
            });
            target.status = res.order.status;
            target.netByMethod[mChoice] += take;
            target.netTotal += take;
            modelTotalAdvanceIn += take;
            modelOpenByMethod[mChoice] += take;
            if (mChoice === 'cash') {
              ms.advCash += take;
              ms.cashMovesNet += take;
              ms.activeDrawerCash += take;
            } else {
              ms.advNonCash += take;
            }
          }
        } else if (op < 68) {
          // Refund partial advance (when drawer allows cash if cash chosen)
          const target = openOrders[seededNextInt(env.random, openOrders.length)];
          const meth = (['cash', 'card', 'uzqr', 'payme'] as const).find(
            (m) => target.netByMethod[m] >= 10_000_00n,
          );
          if (meth && (meth !== 'cash' || ms.activeDrawerCash >= 10_000_00n)) {
            const refAmt = 10_000_00n;
            await term.orderStore.refundOrderAdvance({
              orderId: target.id,
              actorUserId: ms.activeCashierId,
              overrideApprovedByUserId: env.managerId,
              clientRequestId: env.nextUuid(),
              reason: `Partial refund ${String(step)}`,
              refunds: [{ method: meth, amount: moneyFromTiyin(refAmt) }],
            });
            target.netByMethod[meth] -= refAmt;
            target.netTotal -= refAmt;
            modelTotalAdvanceRefund += refAmt;
            modelOpenByMethod[meth] -= refAmt;
            ms.advRefund += refAmt;
            if (meth === 'cash') {
              ms.cashMovesNet -= refAmt;
              ms.activeDrawerCash -= refAmt;
            }
          }
        } else if (op < 75) {
          // Cancel open order if drawer has enough cash for cash netAdvance
          const target = openOrders[seededNextInt(env.random, openOrders.length)];
          if (ms.activeDrawerCash >= target.netByMethod.cash) {
            await term.orderStore.cancelOrder({
              orderId: target.id,
              actorUserId: env.managerId,
              reason: `Cancel ${String(step)}`,
              clientRequestId: env.nextUuid(),
            });
            target.status = 'cancelled';
            modelTotalAdvanceRefund += target.netTotal;
            ms.advRefund += target.netTotal;
            for (const m of ['cash', 'card', 'uzqr', 'payme'] as const) {
              modelOpenByMethod[m] -= target.netByMethod[m];
            }
            ms.cashMovesNet -= target.netByMethod.cash;
            ms.activeDrawerCash -= target.netByMethod.cash;
            target.netTotal = 0n;
          }
        } else if (op < 92) {
          // Confirm or mark ready or DELIVER order (even across shifts / after price hikes!)
          const target = openOrders[seededNextInt(env.random, openOrders.length)];
          if (target.status === 'draft') {
            await term.orderStore.confirmOrder({
              orderId: target.id,
              actorUserId: ms.activeCashierId,
              clientRequestId: env.nextUuid(),
            });
            target.status = 'confirmed';
          } else {
            const rem = target.totalAmount - target.netTotal;
            const useDebt = target.hasCustomer && rem >= 20_000_00n && step % 3 === 0;
            const debtAmt = useDebt ? 10_000_00n : 0n;
            const extraPay = rem - debtAmt;
            const cashExtra = extraPay > 0n ? extraPay : 0n;
            const delivered = await term.orderStore.deliverOrder({
              orderId: target.id,
              actorUserId: ms.activeCashierId,
              clientRequestId: env.nextUuid(),
              expectedTotal: moneyFromTiyin(target.totalAmount),
              debtAmount: moneyFromTiyin(debtAmt),
              payments:
                cashExtra > 0n
                  ? [{ method: 'cash', tenderedAmount: moneyFromTiyin(cashExtra) }]
                  : [],
            });
            expect(moneyToTiyin(delivered.sale.totalFinal)).toBe(target.totalAmount);
            target.status = 'delivered';
            target.deliveredSaleId = delivered.sale.id;
            target.deliveredSaleLineId = delivered.sale.lines[0].id;
            target.deliveredAdditionalByMethod.cash += cashExtra;

            modelTotalAdvanceAppliedAtDelivery += target.netTotal;
            for (const m of ['cash', 'card', 'uzqr', 'payme'] as const) {
              modelOpenByMethod[m] -= target.netByMethod[m];
            }

            ms.salesCount += 1;
            ms.grossSales += target.totalAmount;
            ms.debtSales += debtAmt;
            if (target.netTotal > 0n) {
              ms.methodSales.set(
                'advance',
                (ms.methodSales.get('advance') ?? 0n) + target.netTotal,
              );
            }
            if (cashExtra > 0n) {
              ms.methodSales.set('cash', (ms.methodSales.get('cash') ?? 0n) + cashExtra);
              ms.cashMovesNet += cashExtra;
              ms.activeDrawerCash += cashExtra;
            }
          }
        } else if (returnableOrders.length > 0) {
          // O1 & T1.6: Full return ONLY on first catalog line of non-debt delivered orders to verify O1 + return method cap
          const target = returnableOrders.find(
            (o) => o.returnedQtyMilli === 0n && o.hasCustomer === false,
          );
          if (target && target.deliveredSaleId && target.deliveredSaleLineId) {
            const capCash = target.netByMethod.cash + target.deliveredAdditionalByMethod.cash;
            if (capCash <= ms.activeDrawerCash) {
              // Verify voidSale blocked O1
              await expect(
                term.returnStore.voidSale({
                  saleId: target.deliveredSaleId,
                  actorUserId: env.managerId,
                  reason: 'O1 block test',
                  clientRequestId: env.nextUuid(),
                }),
              ).rejects.toMatchObject({ code: 'ORDER_SALE_USE_RETURN' });

              // Compute catalog line price = delivered line finalTotal
              const retSale = env.connection.sqlite
                .prepare('SELECT "final_total" FROM "sale_lines" WHERE "id" = ?')
                .get(target.deliveredSaleLineId) as { readonly final_total: bigint };
              const lineTotal = BigInt(retSale.final_total);
              const useCash = lineTotal <= capCash ? lineTotal : capCash;
              const remNeed = lineTotal - useCash;
              const payRows: Array<{
                method: PaymentMethod;
                amount: ReturnType<typeof moneyFromTiyin>;
              }> = [];
              if (useCash > 0n) {
                payRows.push({ method: 'cash', amount: moneyFromTiyin(useCash) });
              }
              let remLeft = remNeed;
              for (const m of ['card', 'uzqr', 'payme'] as const) {
                if (remLeft === 0n) break;
                const avail = target.netByMethod[m];
                const give = avail >= remLeft ? remLeft : avail;
                if (give > 0n) {
                  payRows.push({ method: m, amount: moneyFromTiyin(give) });
                  remLeft -= give;
                }
              }
              if (remLeft === 0n && payRows.length > 0) {
                await term.returnStore.createReturn({
                  saleId: target.deliveredSaleId,
                  actorUserId: env.managerId,
                  reason: `Model return ${String(step)}`,
                  clientRequestId: env.nextUuid(),
                  items: [
                    {
                      saleLineId: target.deliveredSaleLineId,
                      qty: quantityFromMilli(target.deliveredQtyMilli),
                    },
                  ],
                  payments: payRows,
                });
                target.returnedQtyMilli = target.deliveredQtyMilli;
                ms.returnsCount += 1;
                ms.returnsTotal += lineTotal;
                for (const p of payRows) {
                  const amt = moneyToTiyin(p.amount);
                  ms.methodReturns.set(p.method, (ms.methodReturns.get(p.method) ?? 0n) + amt);
                  if (p.method === 'cash') {
                    ms.cashMovesNet -= amt;
                    ms.activeDrawerCash -= amt;
                  }
                }
              }
            }
          }
        }
      }

      if (step % 60 === 0) {
        env.clock.advance(86_400_000n);
      } else {
        env.clock.advance(15_000n);
      }

      await assertO4Parity();
    }

    // Close remaining shifts and verify closure parity
    for (const tIdx of [0, 1] as const) {
      const ms = activeShifts[tIdx];
      if (ms !== null) {
        const expCash = ms.openingCash + ms.cashMovesNet;
        const res = await terms[tIdx].shiftStore.closeShift({
          shiftId: ms.shiftId,
          actorUserId: ms.activeCashierId,
          clientRequestId: env.nextUuid(),
          countedCash: moneyFromTiyin(expCash),
        });
        verifyClosure(res.closure, ms);
      }
    }
    expect(DEFAULT_MAX_CASH_DISCREPANCY_TIYIN).toBe(1_000_000n);
  });
});
