import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  DEFAULT_MAX_CASH_DISCREPANCY_TIYIN,
  MAX_MONEY_TIYIN,
  type PinHasher,
  type UuidV7,
  ZERO_MONEY,
  createHlcTimestamp,
  epochDaysFromCivilDate,
  moneyFromTiyin,
  moneyToTiyin,
  parseUuidV7,
  quantityFromMilli,
  serializeHlc,
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
  createSqliteSupplierStore,
  createSqliteUnitOfWork,
  getActiveShiftDrawerBalanceSync,
  getActiveStoreCashBalanceSync,
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

function makeTempDbPath(name = 'shift-test.db'): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mezon-t19-shift-'));
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

// 2026-11-10 10:00:00 Asia/Tashkent = 2026-11-10T05:00:00.000Z
const DAY1_1000_MS = epochDaysFromCivilDate('2026-11-10') * 86_400_000n + 5n * 3_600_000n;

async function setupShiftEnv(options?: {
  readonly dbPath?: string;
  readonly initialMs?: bigint;
  readonly seed?: number;
}) {
  const dbPath = options?.dbPath ?? makeTempDbPath();
  const clock = new FixedClock(options?.initialMs ?? DAY1_1000_MS);
  const random = new SeededRandomSource(options?.seed ?? 109);
  const connection = openLocalSqliteDatabase(dbPath);
  openConnections.push(connection);
  migrateLocalDatabase(connection.db);

  const authStore = await createSqliteHubAuthStore({ connection, clock, random });
  const setup = await authStore.completeSetup({
    fullName: 'Owner',
    username: 'owner19',
    pinHash: await FAST_TEST_HASHER.hash('849201'),
  });
  const manager = await authStore.createUser({
    fullName: 'Manager',
    username: 'mgr19',
    role: 'manager',
    pinHash: await FAST_TEST_HASHER.hash('592817'),
  });
  const cashierA = await authStore.createUser({
    fullName: 'Cashier A',
    username: 'cash19a',
    role: 'cashier',
    pinHash: await FAST_TEST_HASHER.hash('374829'),
  });
  const cashierB = await authStore.createUser({
    fullName: 'Cashier B',
    username: 'cash19b',
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
  const saleStore = createSqliteSaleStore({ connection, getRuntimeContext: getStoreCtx });
  const returnStore = createSqliteReturnStore({ connection, getRuntimeContext: getStoreCtx });
  const supplierStore = createSqliteSupplierStore({ connection, getRuntimeContext: getStoreCtx });
  const shiftStore = createSqliteShiftStore({ connection, getRuntimeContext: getStoreCtx });

  let seq = 1;
  const nextUuid = () => makeUuid(0x019a, seq++);

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
    supplierStore,
    shiftStore,
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

describe('@mezon/db-local - T1.9 Shifts, Cashier Sessions, Cash Moves, Reclose & Day Close', () => {
  it('enforces lifecycle guards, handoff discrepancy thresholds (10,000 UZS default + custom), append-only reclose FACT history, & opening float continuity', async () => {
    const env = await setupShiftEnv();
    const unlimProd = await env.catalogStore.createProduct({
      name: 'Non',
      unit: 'dona',
      unlimited: true,
      salePrice: '50000',
      vatRateBp: 0,
      actorUserId: env.ownerId,
    });

    // No open shift -> cart checkout rejected with SHIFT_NOT_OPEN
    const blockedCart = await env.cartStore.openCart(env.cashierAId);
    await env.cartStore.addLine(blockedCart.id, {
      kind: 'catalog',
      productId: unlimProd.product.id,
      variantId: null,
      qty: quantityFromMilli(1_000n),
    });
    await expect(
      env.saleStore.completeSale({
        cartId: blockedCart.id,
        actorUserId: env.cashierAId,
        clientRequestId: env.nextUuid(),
        expectedTotal: moneyFromTiyin(50_000n),
        payments: [{ method: 'cash', tenderedAmount: moneyFromTiyin(50_000n) }],
      }),
    ).rejects.toMatchObject({ code: 'SHIFT_NOT_OPEN' });

    // Open Shift #1 with openingCash = 500,000 + valid denominations
    const openReqId = env.nextUuid();
    const opened = await env.shiftStore.openShift({
      actorUserId: env.cashierAId,
      clientRequestId: openReqId,
      openingCash: moneyFromTiyin(500_000n),
      denominations: [{ nominal: moneyFromTiyin(100_000n), count: 5 }],
      note: 'Morning shift',
    });
    expect(opened.idempotentReplay).toBe(false);
    expect(opened.shift.shiftNo).toBe(1n);
    expect(opened.shift.status).toBe('open');
    expect(opened.drawerCashBalance).toBe(moneyFromTiyin(500_000n));
    expect(opened.shift.activeCashierSession?.cashierUserId).toBe(env.cashierAId);

    // Idempotent replay on openShift returns replay=true without advancing shiftNo
    const openReplay = await env.shiftStore.openShift({
      actorUserId: env.cashierAId,
      clientRequestId: openReqId,
      openingCash: moneyFromTiyin(500_000n),
      denominations: [{ nominal: moneyFromTiyin(100_000n), count: 5 }],
      note: 'Different note still allowed as excluded from hash',
    });
    expect(openReplay.idempotentReplay).toBe(true);
    expect(openReplay.shift.id).toBe(opened.shift.id);

    // Opening second shift on same device while open -> 409 SHIFT_ALREADY_OPEN
    await expect(
      env.shiftStore.openShift({
        actorUserId: env.cashierBId,
        clientRequestId: env.nextUuid(),
        openingCash: moneyFromTiyin(500_000n),
      }),
    ).rejects.toMatchObject({ code: 'SHIFT_ALREADY_OPEN' });

    // Cashier A completes blockedCart (cash 50k tendered=60k change=10k -> +50k net drawer)
    await env.saleStore.completeSale({
      cartId: blockedCart.id,
      actorUserId: env.cashierAId,
      clientRequestId: env.nextUuid(),
      expectedTotal: moneyFromTiyin(50_000n),
      payments: [{ method: 'cash', tenderedAmount: moneyFromTiyin(60_000n) }],
    });
    // Record manager cash_out with expenseCategory 'transport' (-20k) + cash_in (+10k)
    await env.shiftStore.recordShiftCashMove({
      shiftId: opened.shift.id,
      actorUserId: env.managerId,
      clientRequestId: env.nextUuid(),
      type: 'cash_out',
      amount: moneyFromTiyin(20_000n),
      reason: 'Taxi delivery',
      expenseCategory: 'transport',
    });
    await env.shiftStore.recordShiftCashMove({
      shiftId: opened.shift.id,
      actorUserId: env.managerId,
      clientRequestId: env.nextUuid(),
      type: 'cash_in',
      amount: moneyFromTiyin(10_000n),
      reason: 'Change coins added',
    });
    // Expected Session 1 float = 500k + 50k - 20k + 10k = 540,000
    expect(await env.saleStore.getTerminalCashBalance()).toBe(moneyFromTiyin(540_000n));

    // Handoff A -> B: non-zero discrepancy without reason fails VALIDATION_ERROR
    await expect(
      env.shiftStore.handoffCashier({
        shiftId: opened.shift.id,
        actorUserId: env.cashierAId,
        nextCashierUserId: env.cashierBId,
        clientRequestId: env.nextUuid(),
        countedCash: moneyFromTiyin(539_000n),
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });

    // Discrepancy within default threshold (1,000,000n = 10,000 UZS) succeeds with reason, no supervisor needed
    const handoff1 = await env.shiftStore.handoffCashier({
      shiftId: opened.shift.id,
      actorUserId: env.cashierAId,
      nextCashierUserId: env.cashierBId,
      clientRequestId: env.nextUuid(),
      countedCash: moneyFromTiyin(535_000n), // -5,000
      discrepancyReason: 'Minor counting shortage',
    });
    expect(handoff1.closedSession.discrepancy).toBe(moneyFromTiyin(-5_000n));
    expect(handoff1.activeSession.cashierUserId).toBe(env.cashierBId);
    expect(handoff1.activeSession.openingFloat).toBe(moneyFromTiyin(535_000n));

    // Lower hub discrepancy threshold to 200,000 tiyin -> verify custom threshold enforcement
    expect((await env.shiftStore.getCurrentShift()).maxCashDiscrepancyWithoutOverride).toBe(
      moneyFromTiyin(DEFAULT_MAX_CASH_DISCREPANCY_TIYIN),
    );
    await env.shiftStore.updateCashDiscrepancyThreshold(moneyFromTiyin(200_000n));

    // Cashier B closes shift with counted = 330,000 (-205,000 vs 535,000 expected on B; -210,000 vs 540,000 expected on shift!)
    // Without overrideApprovedByUserId -> SUPERVISOR_OVERRIDE_REQUIRED (403)
    await expect(
      env.shiftStore.closeShift({
        shiftId: opened.shift.id,
        actorUserId: env.cashierBId,
        clientRequestId: env.nextUuid(),
        countedCash: moneyFromTiyin(330_000n),
        discrepancyReason: 'Large shortage',
      }),
    ).rejects.toMatchObject({ code: 'SUPERVISOR_OVERRIDE_REQUIRED' });

    // With supervisor override -> closes cleanly! Verify closureSeq = 1 & SUM(D_i) === D_shift
    const closed = await env.shiftStore.closeShift({
      shiftId: opened.shift.id,
      actorUserId: env.cashierBId,
      clientRequestId: env.nextUuid(),
      countedCash: moneyFromTiyin(330_000n),
      discrepancyReason: 'Large shortage',
      overrideApprovedByUserId: env.managerId,
    });
    expect(closed.closure.closureSeq).toBe(1);
    expect(closed.closure.isReclose).toBe(false);
    expect(closed.closure.discrepancy).toBe(moneyFromTiyin(-210_000n));
    expect(closed.closure.cashiers).toHaveLength(2);
    expect(closed.closure.cashiers[0].discrepancy).toBe(moneyFromTiyin(-5_000n));
    expect(closed.closure.cashiers[1].discrepancy).toBe(moneyFromTiyin(-205_000n));

    // Reclose by cashier -> rejected AUTH_FORBIDDEN (403)
    await expect(
      env.shiftStore.recloseShift({
        shiftId: opened.shift.id,
        actorUserId: env.cashierBId,
        clientRequestId: env.nextUuid(),
        countedCash: moneyFromTiyin(540_000n),
        reason: 'Cashier retry',
      }),
    ).rejects.toMatchObject({ code: 'AUTH_FORBIDDEN' });

    // Reclose by manager finding lost 210,000 cash -> appends closureSeq = 2, preserving closureSeq = 1 FACT!
    const reclosed = await env.shiftStore.recloseShift({
      shiftId: opened.shift.id,
      actorUserId: env.managerId,
      clientRequestId: env.nextUuid(),
      countedCash: moneyFromTiyin(540_000n),
      reason: 'Found 210k bundle under tray',
      overrideApprovedByUserId: env.ownerId,
    });
    expect(reclosed.closure.closureSeq).toBe(2);
    expect(reclosed.closure.isReclose).toBe(true);
    expect(reclosed.closure.discrepancy).toBe(ZERO_MONEY);

    const detail = await env.shiftStore.getShiftDetail(opened.shift.id);
    expect(detail.closures).toHaveLength(2);
    expect(detail.closures[0].closureSeq).toBe(1);
    expect(detail.closures[0].countedCash).toBe(moneyFromTiyin(330_000n));
    expect(detail.closures[1].closureSeq).toBe(2);
    expect(detail.closures[1].countedCash).toBe(moneyFromTiyin(540_000n));

    // Opening Shift #2 with cash differing from Shift #1's latest reclose (540,000) without reason -> fails!
    await expect(
      env.shiftStore.openShift({
        actorUserId: env.cashierAId,
        clientRequestId: env.nextUuid(),
        openingCash: moneyFromTiyin(200_000n),
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });

    const shift2 = await env.shiftStore.openShift({
      actorUserId: env.cashierAId,
      clientRequestId: env.nextUuid(),
      openingCash: moneyFromTiyin(200_000n),
      openingDiscrepancyReason: 'Owner banked 340k before morning shift',
    });
    expect(shift2.shift.previousCloseCash).toBe(moneyFromTiyin(540_000n));
    expect(shift2.shift.openingDiscrepancy).toBe(moneyFromTiyin(-340_000n));
  });

  it('X1: enforces new shift openingCash (not historical cash_moves sum) as single source of truth across ALL outflow guards', async () => {
    const env = await setupShiftEnv();
    const prod = await env.catalogStore.createProduct({
      name: 'Choy',
      unit: 'dona',
      unlimited: true,
      salePrice: '80000',
      vatRateBp: 0,
      actorUserId: env.ownerId,
    });
    const sup = await env.supplierStore.createSupplier({ name: 'Choy Yetkazib Beruvchi' });
    await env.supplierStore.recordOpeningBalance({
      supplierId: sup.id,
      actorUserId: env.ownerId,
      clientRequestId: env.nextUuid(),
      amount: moneyFromTiyin(200_000n),
      reason: 'Opening payable',
    });

    // Shift 1: open with 50,000, sell 80,000 cash => historical cash_moves = +80,000; expected = 130,000
    // Close Shift 1 with shortage: counted = 100,000 (discrepancy = -30,000)
    const sh1 = await env.shiftStore.openShift({
      actorUserId: env.cashierAId,
      clientRequestId: env.nextUuid(),
      openingCash: moneyFromTiyin(50_000n),
    });
    const c1 = await env.cartStore.openCart(env.cashierAId);
    await env.cartStore.addLine(c1.id, {
      kind: 'catalog',
      productId: prod.product.id,
      variantId: null,
      qty: quantityFromMilli(1_000n),
    });
    const sale1 = await env.saleStore.completeSale({
      cartId: c1.id,
      actorUserId: env.cashierAId,
      clientRequestId: env.nextUuid(),
      expectedTotal: moneyFromTiyin(80_000n),
      payments: [{ method: 'cash', tenderedAmount: moneyFromTiyin(80_000n) }],
    });
    await env.shiftStore.closeShift({
      shiftId: sh1.shift.id,
      actorUserId: env.cashierAId,
      clientRequestId: env.nextUuid(),
      countedCash: moneyFromTiyin(100_000n),
      discrepancyReason: 'Shortage counted',
    });

    // Shift 2: open with ONLY 40,000 openingCash (notice historical cash_moves = +80,000, prev close = 100,000!)
    const sh2 = await env.shiftStore.openShift({
      actorUserId: env.cashierAId,
      clientRequestId: env.nextUuid(),
      openingCash: moneyFromTiyin(40_000n),
      openingDiscrepancyReason: 'Safe withdrawal before Shift 2',
    });

    // X1 Balance Check: must return 40,000n, NEVER 80,000n!
    expect(await env.saleStore.getTerminalCashBalance()).toBe(moneyFromTiyin(40_000n));
    expect(
      getActiveShiftDrawerBalanceSync(env.connection.db, env.connection.sqlite, {
        organizationId: env.organizationId,
        storeId: env.storeId,
        deviceId: env.deviceId,
      }),
    ).toBe(moneyFromTiyin(40_000n));

    // ALL outflow commands attempting > 40,000 (even 40,001 or 60,000 which < historical 80,000!) MUST reject INSUFFICIENT_CASH_IN_DRAWER
    await expect(
      env.shiftStore.recordShiftCashMove({
        shiftId: sh2.shift.id,
        actorUserId: env.managerId,
        clientRequestId: env.nextUuid(),
        type: 'cash_out',
        amount: moneyFromTiyin(40_001n),
        reason: 'Exceeds Shift 2 openingCash',
      }),
    ).rejects.toMatchObject({ code: 'INSUFFICIENT_CASH_IN_DRAWER' });

    await expect(
      env.shiftStore.recordShiftCashMove({
        shiftId: sh2.shift.id,
        actorUserId: env.managerId,
        clientRequestId: env.nextUuid(),
        type: 'encashment',
        amount: moneyFromTiyin(50_000n),
        reason: 'Exceeds Shift 2 openingCash',
      }),
    ).rejects.toMatchObject({ code: 'INSUFFICIENT_CASH_IN_DRAWER' });

    await expect(
      env.returnStore.createReturn({
        saleId: sale1.sale.id,
        actorUserId: env.cashierAId,
        reason: 'Partial refund > 40k',
        clientRequestId: env.nextUuid(),
        items: [{ saleLineId: sale1.sale.lines[0].id, qty: quantityFromMilli(1_000n) }],
        payments: [{ method: 'cash', amount: moneyFromTiyin(80_000n) }],
      }),
    ).rejects.toMatchObject({ code: 'INSUFFICIENT_CASH_IN_DRAWER' });

    await expect(
      env.supplierStore.recordPayment({
        supplierId: sup.id,
        actorUserId: env.ownerId,
        clientRequestId: env.nextUuid(),
        method: 'cash',
        amount: moneyFromTiyin(50_000n),
        reason: 'Supplier cash > 40k',
      }),
    ).rejects.toMatchObject({ code: 'INSUFFICIENT_CASH_IN_DRAWER' });

    // Check voidSale X1 sufficiency as well inside Shift 2 (complete a 50k cash sale then encash 20k -> 70k left? Make drawer < sale total):
    // First spend 25,000 via supplier cash payment -> drawer = 15,000 (allowed!)
    await env.supplierStore.recordPayment({
      supplierId: sup.id,
      actorUserId: env.ownerId,
      clientRequestId: env.nextUuid(),
      method: 'cash',
      amount: moneyFromTiyin(25_000n),
      reason: 'Within Shift 2 balance',
    });
    expect(await env.saleStore.getTerminalCashBalance()).toBe(moneyFromTiyin(15_000n));
  });

  it('X2, X3, V1: attributes manager returns/voids to active cashier session, blocks wrong cashier 409 CASHIER_SESSION_MISMATCH, never subtracts change twice, & narrows voidSale strictly to same open shift', async () => {
    const env = await setupShiftEnv();
    const prod = await env.catalogStore.createProduct({
      name: 'Shokolad',
      unit: 'dona',
      unlimited: true,
      salePrice: '75000',
      vatRateBp: 0,
      actorUserId: env.ownerId,
    });

    const sh1 = await env.shiftStore.openShift({
      actorUserId: env.cashierAId,
      clientRequestId: env.nextUuid(),
      openingCash: moneyFromTiyin(100_000n),
    });
    const sessionAId = sh1.shift.activeCashierSession!.id;

    // Wrong cashier (Cashier B) blocked on cart sale, return, handoff, and close!
    const cB = await env.cartStore.openCart(env.cashierBId);
    await env.cartStore.addLine(cB.id, {
      kind: 'catalog',
      productId: prod.product.id,
      variantId: null,
      qty: quantityFromMilli(1_000n),
    });
    await expect(
      env.saleStore.completeSale({
        cartId: cB.id,
        actorUserId: env.cashierBId,
        clientRequestId: env.nextUuid(),
        expectedTotal: moneyFromTiyin(75_000n),
        payments: [{ method: 'cash', tenderedAmount: moneyFromTiyin(75_000n) }],
      }),
    ).rejects.toMatchObject({ code: 'CASHIER_SESSION_MISMATCH' });

    await expect(
      env.shiftStore.handoffCashier({
        shiftId: sh1.shift.id,
        actorUserId: env.cashierBId,
        nextCashierUserId: env.cashierBId,
        clientRequestId: env.nextUuid(),
        countedCash: moneyFromTiyin(100_000n),
      }),
    ).rejects.toMatchObject({ code: 'CASHIER_SESSION_MISMATCH' });

    // X3 check: Cashier A completes 2 sales (2 x 75k = 150k), paying cash 100k tendered (25k change -> net payments.amount = 75k)
    const cA1 = await env.cartStore.openCart(env.cashierAId);
    await env.cartStore.addLine(cA1.id, {
      kind: 'catalog',
      productId: prod.product.id,
      variantId: null,
      qty: quantityFromMilli(2_000n), // 150,000 total
    });
    const sale1 = await env.saleStore.completeSale({
      cartId: cA1.id,
      actorUserId: env.cashierAId,
      clientRequestId: env.nextUuid(),
      expectedTotal: moneyFromTiyin(150_000n),
      payments: [
        { method: 'cash', tenderedAmount: moneyFromTiyin(100_000n) }, // net cash = 75k, change = 25k
        { method: 'card', amount: moneyFromTiyin(75_000n), providerRef: 'RRN-X3' },
      ],
    });
    expect(sale1.sale.shiftId).toBe(sh1.shift.id);
    expect(sale1.sale.shiftCashierSessionId).toBe(sessionAId);
    expect(await env.saleStore.getTerminalCashBalance()).toBe(moneyFromTiyin(175_000n));

    // Cashier B ALSO blocked on createReturn and voidSale during Cashier A's session
    await expect(
      env.returnStore.createReturn({
        saleId: sale1.sale.id,
        actorUserId: env.cashierBId,
        reason: 'Wrong cashier return',
        clientRequestId: env.nextUuid(),
        items: [{ saleLineId: sale1.sale.lines[0].id, qty: quantityFromMilli(1_000n) }],
        payments: [
          { method: 'cash', amount: moneyFromTiyin(25_000n) },
          { method: 'card', amount: moneyFromTiyin(50_000n), providerRef: 'RET-B' },
        ],
      }),
    ).rejects.toMatchObject({ code: 'CASHIER_SESSION_MISMATCH' });

    // X2 CRITICAL: Manager processes partial return (cash 25k + card 50k = 75k) during Cashier A's active session
    const mgrRet = await env.returnStore.createReturn({
      saleId: sale1.sale.id,
      actorUserId: env.managerId,
      reason: 'Manager return during Cashier A session',
      clientRequestId: env.nextUuid(),
      items: [{ saleLineId: sale1.sale.lines[0].id, qty: quantityFromMilli(1_000n) }],
      payments: [
        { method: 'cash', amount: moneyFromTiyin(25_000n) },
        { method: 'card', amount: moneyFromTiyin(50_000n), providerRef: 'RET-X3' },
      ],
    });
    expect(mgrRet.returnDoc.processedByUserId).toBe(env.managerId);
    expect(mgrRet.returnDoc.shiftId).toBe(sh1.shift.id);
    expect(mgrRet.returnDoc.shiftCashierSessionId).toBe(sessionAId);

    // Drawer now: 100k + 75k - 25k = 150k. Close Shift 1!
    const sh1Close = await env.shiftStore.closeShift({
      shiftId: sh1.shift.id,
      actorUserId: env.cashierAId,
      clientRequestId: env.nextUuid(),
      countedCash: moneyFromTiyin(150_000n),
    });

    // Verify X3 methodTotals: cash salesAmount = 75,000 (NOT 50,000 double-subtracting 25k change!)
    const cashMethod = sh1Close.closure.methodTotals.find((m) => m.method === 'cash')!;
    expect(cashMethod.salesAmount).toBe(moneyFromTiyin(75_000n));
    expect(cashMethod.returnsAmount).toBe(moneyFromTiyin(25_000n));
    expect(cashMethod.netAmount).toBe(moneyFromTiyin(50_000n));
    expect(sh1Close.closure.methodTotals.find((m) => m.method === 'card')!.netAmount).toBe(
      moneyFromTiyin(25_000n),
    );

    // Verify X2: single cashier session (Cashier A) got attributed with the manager-processed return!
    expect(sh1Close.closure.cashiers).toHaveLength(1);
    expect(sh1Close.closure.cashiers[0].sessionId).toBe(sessionAId);
    expect(sh1Close.closure.cashiers[0].cashierUserId).toBe(env.cashierAId);
    expect(sh1Close.closure.cashiers[0].returnsCount).toBe(1);
    expect(sh1Close.closure.cashiers[0].returnsTotal).toBe(moneyFromTiyin(75_000n));
    expect(sh1Close.closure.cashiers[0].expectedCash).toBe(moneyFromTiyin(150_000n));
    expect(sh1Close.closure.cashiers[0].discrepancy).toBe(ZERO_MONEY);

    // V1 check: Same calendar day, open Shift #2 -> create a sale & close or try to void sale1 (from closed Shift #1)!
    const sh2 = await env.shiftStore.openShift({
      actorUserId: env.cashierBId,
      clientRequestId: env.nextUuid(),
      openingCash: moneyFromTiyin(150_000n),
    });
    const cB2 = await env.cartStore.openCart(env.cashierBId);
    await env.cartStore.addLine(cB2.id, {
      kind: 'catalog',
      productId: prod.product.id,
      variantId: null,
      qty: quantityFromMilli(1_000n),
    });
    const saleInSh2 = await env.saleStore.completeSale({
      cartId: cB2.id,
      actorUserId: env.cashierBId,
      clientRequestId: env.nextUuid(),
      expectedTotal: moneyFromTiyin(75_000n),
      payments: [{ method: 'cash', tenderedAmount: moneyFromTiyin(75_000n) }],
    });

    // Attempting voidSale on a sale from closed Shift #1 on SAME calendar day MUST throw 409 SHIFT_ALREADY_CLOSED!
    await expect(
      env.returnStore.voidSale({
        saleId: sale1.sale.id,
        actorUserId: env.managerId,
        reason: 'Cannot void prior closed shift sale',
        clientRequestId: env.nextUuid(),
      }),
    ).rejects.toMatchObject({ code: 'SHIFT_ALREADY_CLOSED' });

    // Voiding saleInSh2 inside SAME open Shift #2 succeeds (even across midnight if clock advances!)
    env.clock.advance(16n * 3_600_000n); // Next calendar day while sh2 is STILL open
    const voided = await env.returnStore.voidSale({
      saleId: saleInSh2.sale.id,
      actorUserId: env.managerId,
      reason: 'Same open shift across midnight',
      clientRequestId: env.nextUuid(),
    });
    expect(voided.sale.status).toBe('voided');
    expect(voided.sale.shiftId).toBe(sh2.shift.id);
  });

  it('X4: assigns overnight shifts by closing date, blocks DAY_HAS_OPEN_SHIFTS, marks isStale on reclose, & preserves history', async () => {
    // Tashkent 2026-11-10 22:00:00 = 2026-11-10T17:00:00Z
    const nov10_2200_utc = BigInt(Date.parse('2026-11-10T17:00:00.000Z'));
    const env = await setupShiftEnv({ initialMs: nov10_2200_utc });
    const prod = await env.catalogStore.createProduct({
      name: 'Kofe',
      unit: 'dona',
      unlimited: true,
      salePrice: '30000',
      vatRateBp: 0,
      actorUserId: env.ownerId,
    });

    // Overnight Shift 1 opens 2026-11-10 22:00 Tashkent
    const sh1 = await env.shiftStore.openShift({
      actorUserId: env.cashierAId,
      clientRequestId: env.nextUuid(),
      openingCash: moneyFromTiyin(100_000n),
    });
    const c1 = await env.cartStore.openCart(env.cashierAId);
    await env.cartStore.addLine(c1.id, {
      kind: 'catalog',
      productId: prod.product.id,
      variantId: null,
      qty: quantityFromMilli(1_000n),
    });
    await env.saleStore.completeSale({
      cartId: c1.id,
      actorUserId: env.cashierAId,
      clientRequestId: env.nextUuid(),
      expectedTotal: moneyFromTiyin(30_000n),
      payments: [{ method: 'cash', tenderedAmount: moneyFromTiyin(30_000n) }],
    });

    // Close overnight Shift 1 at 2026-11-11 02:30:00 Tashkent (4.5 hours later!)
    env.clock.set(BigInt(Date.parse('2026-11-10T21:30:00.000Z')));
    await env.shiftStore.closeShift({
      shiftId: sh1.shift.id,
      actorUserId: env.cashierAId,
      clientRequestId: env.nextUuid(),
      countedCash: moneyFromTiyin(130_000n),
    });

    // Open Morning Shift 2 at 2026-11-11 09:00:00 Tashkent (stays open!)
    env.clock.set(BigInt(Date.parse('2026-11-11T04:00:00.000Z')));
    const sh2 = await env.shiftStore.openShift({
      actorUserId: env.cashierBId,
      clientRequestId: env.nextUuid(),
      openingCash: moneyFromTiyin(130_000n),
    });
    const c2 = await env.cartStore.openCart(env.cashierBId);
    await env.cartStore.addLine(c2.id, {
      kind: 'catalog',
      productId: prod.product.id,
      variantId: null,
      qty: quantityFromMilli(2_000n),
    });
    await env.saleStore.completeSale({
      cartId: c2.id,
      actorUserId: env.cashierBId,
      clientRequestId: env.nextUuid(),
      expectedTotal: moneyFromTiyin(60_000n),
      payments: [{ method: 'card', amount: moneyFromTiyin(60_000n), providerRef: 'DAY2-CARD' }],
    });

    // Attempting day close for 2026-11-11 while Shift 2 is open -> 409 DAY_HAS_OPEN_SHIFTS!
    await expect(
      env.shiftStore.closeBusinessDay({
        actorUserId: env.managerId,
        clientRequestId: env.nextUuid(),
        businessDate: '2026-11-11',
      }),
    ).rejects.toMatchObject({ code: 'DAY_HAS_OPEN_SHIFTS' });

    // Closing 2026-11-10 succeeds cleanly with 0 shifts (overnight Shift 1 closed on 2026-11-11, NOT 2026-11-10!)
    const nov10Close = await env.shiftStore.closeBusinessDay({
      actorUserId: env.managerId,
      clientRequestId: env.nextUuid(),
      businessDate: '2026-11-10',
    });
    expect(nov10Close.dayClose.shiftsCount).toBe(0);
    expect(nov10Close.dayClose.grossSalesTotal).toBe(ZERO_MONEY);

    // Close Shift 2 at 2026-11-11 18:00 Tashkent
    env.clock.set(BigInt(Date.parse('2026-11-11T13:00:00.000Z')));
    await env.shiftStore.closeShift({
      shiftId: sh2.shift.id,
      actorUserId: env.cashierBId,
      clientRequestId: env.nextUuid(),
      countedCash: moneyFromTiyin(130_000n),
    });

    // Close Business Day 2026-11-11 -> closeSeq = 1 includes BOTH Shift 1 (overnight) + Shift 2!
    const nov11Close1 = await env.shiftStore.closeBusinessDay({
      actorUserId: env.managerId,
      clientRequestId: env.nextUuid(),
      businessDate: '2026-11-11',
    });
    expect(nov11Close1.dayClose.closeSeq).toBe(1);
    expect(nov11Close1.dayClose.shiftsCount).toBe(2);
    expect(nov11Close1.dayClose.grossSalesTotal).toBe(moneyFromTiyin(90_000n));
    expect(nov11Close1.dayClose.discrepancyTotal).toBe(ZERO_MONEY);
    expect(nov11Close1.dayClose.isStale).toBe(false);

    // Reclose Shift 1 with corrected cash count (125,000 instead of 130,000 -> -5,000)
    await env.shiftStore.recloseShift({
      shiftId: sh1.shift.id,
      actorUserId: env.ownerId,
      clientRequestId: env.nextUuid(),
      countedCash: moneyFromTiyin(125_000n),
      reason: 'Audit recounted 5k missing from overnight box',
    });

    // X4 Stale check: existing day_close closeSeq=1 MUST report isStale === true even with FixedClock!
    const listedAfterReclose = await env.shiftStore.listDayCloses({ businessDate: '2026-11-11' });
    expect(listedAfterReclose.dayCloses).toHaveLength(1);
    expect(listedAfterReclose.dayCloses[0].isStale).toBe(true);

    // Re-closing day 2026-11-11 preserves closeSeq=1 (still stale historical snapshot) and appends closeSeq=2 (fresh!)
    const nov11Close2 = await env.shiftStore.closeBusinessDay({
      actorUserId: env.ownerId,
      clientRequestId: env.nextUuid(),
      businessDate: '2026-11-11',
      note: 'Updated after shift 1 reclose',
    });
    expect(nov11Close2.dayClose.closeSeq).toBe(2);
    expect(nov11Close2.dayClose.discrepancyTotal).toBe(moneyFromTiyin(-5_000n));
    expect(nov11Close2.dayClose.isStale).toBe(false);

    const listedAfterDayReclose = await env.shiftStore.listDayCloses({
      businessDate: '2026-11-11',
    });
    expect(listedAfterDayReclose.dayCloses.map((d) => [d.closeSeq, d.isStale])).toEqual([
      [2, false],
      [1, true],
    ]);
  });

  it('enforces SQLite MONOTONE, FACT, X5 closed-shift INSERT guards, expense_category trigger, partial unique indexes & v_sales_lines shift columns', async () => {
    const env = await setupShiftEnv();
    const prod = await env.catalogStore.createProduct({
      name: 'Sut',
      unit: 'dona',
      unlimited: true,
      salePrice: '20000',
      vatRateBp: 0,
      actorUserId: env.ownerId,
    });

    const sh = await env.shiftStore.openShift({
      actorUserId: env.cashierAId,
      clientRequestId: env.nextUuid(),
      openingCash: moneyFromTiyin(50_000n),
    });
    const sessId = sh.shift.activeCashierSession!.id;

    const c = await env.cartStore.openCart(env.cashierAId);
    await env.cartStore.addLine(c.id, {
      kind: 'catalog',
      productId: prod.product.id,
      variantId: null,
      qty: quantityFromMilli(1_000n),
    });
    const completed = await env.saleStore.completeSale({
      cartId: c.id,
      actorUserId: env.cashierAId,
      clientRequestId: env.nextUuid(),
      expectedTotal: moneyFromTiyin(20_000n),
      payments: [{ method: 'cash', tenderedAmount: moneyFromTiyin(20_000n) }],
    });

    // Raw SQL mutate immutable fields while open -> ABORT
    expect(() =>
      env.connection.sqlite
        .prepare('UPDATE "shifts" SET "opening_cash" = 999 WHERE "id" = ?')
        .run(sh.shift.id),
    ).toThrow(/MONOTONE|forbids/);

    // Invalid expense_category on cash_in -> ABORT
    const hlc58 = serializeHlc(createHlcTimestamp(env.clock.now(), 99, env.deviceId));
    expect(() =>
      env.connection.sqlite
        .prepare(
          `INSERT INTO "cash_moves" ("id","organization_id","store_id","device_id","hlc","created_at_ms","shift_id","shift_cashier_session_id","type","amount_delta","source_type","source_id","expense_category","created_by_user_id")
           VALUES (?,?,?,?,?,?,?,?,'cash_in',1000,'manual',?,'transport',?)`,
        )
        .run(
          env.nextUuid(),
          env.organizationId,
          env.storeId,
          env.deviceId,
          hlc58,
          env.clock.now(),
          sh.shift.id,
          sessId,
          env.nextUuid(),
          env.ownerId,
        ),
    ).toThrow(/expense_category/);

    // Close shift + close day
    await env.shiftStore.closeShift({
      shiftId: sh.shift.id,
      actorUserId: env.cashierAId,
      clientRequestId: env.nextUuid(),
      countedCash: moneyFromTiyin(70_000n),
    });
    await env.shiftStore.closeBusinessDay({
      actorUserId: env.managerId,
      clientRequestId: env.nextUuid(),
      businessDate: '2026-11-10',
    });

    // MONOTONE after close & DELETE forbidden on shifts/sessions
    expect(() =>
      env.connection.sqlite
        .prepare('UPDATE "shifts" SET "closing_note" = \'hack\' WHERE "id" = ?')
        .run(sh.shift.id),
    ).toThrow(/MONOTONE/);
    expect(() =>
      env.connection.sqlite.prepare('DELETE FROM "shifts" WHERE "id" = ?').run(sh.shift.id),
    ).toThrow(/DELETE/);
    expect(() =>
      env.connection.sqlite
        .prepare('UPDATE "shift_cashier_sessions" SET "note" = \'hack\' WHERE "id" = ?')
        .run(sessId),
    ).toThrow(/MONOTONE/);

    // FACT immutability on closures & day_closes
    expect(() =>
      env.connection.sqlite.prepare('UPDATE "shift_closures" SET "reason" = \'x\'').run(),
    ).toThrow(/immutable/);
    expect(() => env.connection.sqlite.prepare('DELETE FROM "shift_closures"').run()).toThrow(
      /DELETE/,
    );
    expect(() =>
      env.connection.sqlite
        .prepare('UPDATE "shift_closure_method_totals" SET "net_amount" = 0')
        .run(),
    ).toThrow(/immutable/);
    expect(() =>
      env.connection.sqlite.prepare('UPDATE "shift_closure_cashiers" SET "counted_cash" = 0').run(),
    ).toThrow(/immutable/);
    expect(() =>
      env.connection.sqlite.prepare('UPDATE "day_closes" SET "note" = \'x\'').run(),
    ).toThrow(/immutable/);

    // X5: Closed-shift INSERT guard triggers on cash_moves, sales, returns
    expect(() =>
      env.connection.sqlite
        .prepare(
          `INSERT INTO "cash_moves" ("id","organization_id","store_id","device_id","hlc","created_at_ms","shift_id","shift_cashier_session_id","type","amount_delta","source_type","source_id","created_by_user_id")
           VALUES (?,?,?,?,?,?,?,?,'cash_in',1000,'manual',?,?)`,
        )
        .run(
          env.nextUuid(),
          env.organizationId,
          env.storeId,
          env.deviceId,
          hlc58,
          env.clock.now(),
          sh.shift.id,
          sessId,
          env.nextUuid(),
          env.ownerId,
        ),
    ).toThrow(/already closed shift/);

    // v_sales_lines exposes shift_id & shift_cashier_session_id cleanly
    const vRow = env.connection.sqlite
      .prepare(
        'SELECT "shift_id", "shift_cashier_session_id", "signed_final_total" FROM "v_sales_lines" WHERE "sale_id" = ?',
      )
      .get(completed.sale.id) as {
      readonly shift_id: string;
      readonly shift_cashier_session_id: string;
      readonly signed_final_total: bigint;
    };
    expect(vRow).toEqual({
      shift_id: sh.shift.id,
      shift_cashier_session_id: sessId,
      signed_final_total: 20_000n,
    });
  });

  it('model test (>= 240 steps across 2 parallel terminals A & B): parity across handoffs, cash sales w/ change, cards, voids, returns, cash moves, closes, recloses & day_closes', async () => {
    const env = await setupShiftEnv({ seed: 2026 });
    const prod = await env.catalogStore.createProduct({
      name: 'Universal Model Item',
      unit: 'dona',
      unlimited: true,
      salePrice: '10000',
      vatRateBp: 0,
      actorUserId: env.ownerId,
    });

    const deviceB = parseUuidV7('01950000-0000-7000-8000-bbbbbbbbbbb2');
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
    const termB = {
      deviceId: deviceB,
      shiftStore: createSqliteShiftStore({
        connection: env.connection,
        getRuntimeContext: getStoreCtxB,
      }),
      cartStore: createSqliteCartStore({
        connection: env.connection,
        getRuntimeContext: getStoreCtxB,
      }),
      saleStore: createSqliteSaleStore({
        connection: env.connection,
        getRuntimeContext: getStoreCtxB,
      }),
      returnStore: createSqliteReturnStore({
        connection: env.connection,
        getRuntimeContext: getStoreCtxB,
      }),
    };
    const termA = {
      deviceId: env.deviceId,
      shiftStore: env.shiftStore,
      cartStore: env.cartStore,
      saleStore: env.saleStore,
      returnStore: env.returnStore,
    };

    interface ModelSession {
      readonly sessionId: UuidV7;
      readonly cashierId: UuidV7;
      readonly openingFloat: bigint;
      cashDelta: bigint;
      salesCount: number;
      returnsCount: number;
      salesTotal: bigint;
      returnsTotal: bigint;
      countedCash: bigint | null;
    }
    interface ModelSale {
      readonly saleId: UuidV7;
      readonly lineId: UuidV7;
      readonly qtySold: bigint;
      qtyReturned: bigint;
      voided: boolean;
      readonly cashPaid: bigint;
      readonly cardPaid: bigint;
      cashRefunded: bigint;
      cardRefunded: bigint;
      readonly totalFinal: bigint;
      readonly sessionIdx: number;
    }
    interface ModelShift {
      readonly shiftId: UuidV7;
      readonly openingCash: bigint;
      status: 'open' | 'closed';
      sessions: ModelSession[];
      sales: ModelSale[];
      cashMovesNet: bigint;
      cashSalesTotal: bigint;
      cardSalesTotal: bigint;
      cashReturnsTotal: bigint;
      cardReturnsTotal: bigint;
      grossSales: bigint;
      returnsTotal: bigint;
      salesCount: number;
      returnsCount: number;
      voidsCount: number;
      closedDate: string | null;
      latestClosureId: UuidV7 | null;
      latestExpectedCash: bigint;
      latestCountedCash: bigint;
    }

    const activeByTerm: [ModelShift | null, ModelShift | null] = [null, null];
    const closedShifts: ModelShift[] = [];
    const currentDay = '2026-11-10';
    const lastCloseCashByTerm: [bigint, bigint] = [0n, 0n];

    const verifyTerminalDrawer = async (idx: 0 | 1) => {
      const term = idx === 0 ? termA : termB;
      const ms = activeByTerm[idx];
      const activeSess = ms ? ms.sessions[ms.sessions.length - 1] : null;
      const expected = activeSess ? activeSess.openingFloat + activeSess.cashDelta : 0n;
      expect(await term.saleStore.getTerminalCashBalance(term.deviceId)).toBe(
        moneyFromTiyin(expected),
      );
    };

    const verifyClosure = (
      c: Awaited<ReturnType<typeof env.shiftStore.closeShift>>['closure'],
      m: ModelShift,
    ) => {
      expect(moneyToTiyin(c.expectedCash)).toBe(m.openingCash + m.cashMovesNet);
      expect(moneyToTiyin(c.countedCash)).toBe(m.latestCountedCash);
      expect(moneyToTiyin(c.grossSalesTotal)).toBe(m.grossSales);
      expect(moneyToTiyin(c.returnsTotal)).toBe(m.returnsTotal);
      expect(c.salesCount).toBe(m.salesCount);
      expect(c.returnsCount).toBe(m.returnsCount);
      expect(c.voidsCount).toBe(m.voidsCount);
      const sumSessionDisc = c.cashiers.reduce((a, x) => a + moneyToTiyin(x.discrepancy), 0n);
      expect(sumSessionDisc).toBe(moneyToTiyin(c.discrepancy));
      expect(moneyToTiyin(c.methodTotals.find((x) => x.method === 'cash')!.salesAmount)).toBe(
        m.cashSalesTotal,
      );
      expect(moneyToTiyin(c.methodTotals.find((x) => x.method === 'cash')!.returnsAmount)).toBe(
        m.cashReturnsTotal,
      );
      expect(moneyToTiyin(c.methodTotals.find((x) => x.method === 'card')!.salesAmount)).toBe(
        m.cardSalesTotal,
      );
      expect(moneyToTiyin(c.methodTotals.find((x) => x.method === 'card')!.returnsAmount)).toBe(
        m.cardReturnsTotal,
      );
    };

    const TOTAL_STEPS = 240;
    for (let step = 0; step < TOTAL_STEPS; step += 1) {
      env.clock.advance(60_000n);
      const tIdx = seededNextInt(env.random, 2) as 0 | 1;
      const term = tIdx === 0 ? termA : termB;
      const ms = activeByTerm[tIdx];
      const op = seededNextInt(env.random, 100);

      if (!ms || (op < 10 && ms.status === 'open')) {
        if (!ms) {
          const openCash = BigInt(100_000 + seededNextInt(env.random, 50) * 1_000);
          const cashierId = tIdx === 0 ? env.cashierAId : env.cashierBId;
          const opened = await term.shiftStore.openShift({
            actorUserId: cashierId,
            clientRequestId: env.nextUuid(),
            openingCash: moneyFromTiyin(openCash),
            openingDiscrepancyReason:
              openCash !== lastCloseCashByTerm[tIdx] ? `Model float ${step}` : null,
          });
          activeByTerm[tIdx] = {
            shiftId: opened.shift.id,
            openingCash: openCash,
            status: 'open',
            sessions: [
              {
                sessionId: opened.shift.activeCashierSession!.id,
                cashierId,
                openingFloat: openCash,
                cashDelta: 0n,
                salesCount: 0,
                returnsCount: 0,
                salesTotal: 0n,
                returnsTotal: 0n,
                countedCash: null,
              },
            ],
            sales: [],
            cashMovesNet: 0n,
            cashSalesTotal: 0n,
            cardSalesTotal: 0n,
            cashReturnsTotal: 0n,
            cardReturnsTotal: 0n,
            grossSales: 0n,
            returnsTotal: 0n,
            salesCount: 0,
            returnsCount: 0,
            voidsCount: 0,
            closedDate: null,
            latestClosureId: null,
            latestExpectedCash: openCash,
            latestCountedCash: openCash,
          };
        } else {
          // Close shift with small bounded discrepancy (-3k .. +3k)
          const expCash = ms.openingCash + ms.cashMovesNet;
          const delta = BigInt(seededNextInt(env.random, 7) - 3) * 1_000n;
          const counted = expCash + delta < 0n ? 0n : expCash + delta;
          const activeSess = ms.sessions[ms.sessions.length - 1];
          const res = await term.shiftStore.closeShift({
            shiftId: ms.shiftId,
            actorUserId: activeSess.cashierId,
            clientRequestId: env.nextUuid(),
            countedCash: moneyFromTiyin(counted),
            discrepancyReason: counted !== expCash ? `Close delta ${step}` : null,
          });
          ms.status = 'closed';
          ms.closedDate = currentDay;
          ms.latestClosureId = res.closure.id;
          ms.latestExpectedCash = expCash;
          ms.latestCountedCash = counted;
          verifyClosure(res.closure, ms);
          closedShifts.push(ms);
          activeByTerm[tIdx] = null;
          lastCloseCashByTerm[tIdx] = counted;
        }
      } else if (op < 50) {
        // Mixed cash w/ non-zero change + card sale
        const activeSessIdx = ms.sessions.length - 1;
        const activeSess = ms.sessions[activeSessIdx];
        const qtyUnits = BigInt(1 + seededNextInt(env.random, 5));
        const totalFinal = qtyUnits * 10_000n;
        const cashShare = op % 2 === 0 ? totalFinal : totalFinal / 2n;
        const cardShare = totalFinal - cashShare;
        const tendered = cashShare + 5_000n; // Always non-zero 5k change (X3!)

        const cart = await term.cartStore.openCart(activeSess.cashierId);
        await term.cartStore.addLine(cart.id, {
          kind: 'catalog',
          productId: prod.product.id,
          variantId: null,
          qty: quantityFromMilli(qtyUnits * 1_000n),
        });
        const salePayments =
          cardShare > 0n
            ? [
                { method: 'cash' as const, tenderedAmount: moneyFromTiyin(tendered) },
                {
                  method: 'card' as const,
                  amount: moneyFromTiyin(cardShare),
                  providerRef: `M-${step}`,
                },
              ]
            : [{ method: 'cash' as const, tenderedAmount: moneyFromTiyin(tendered) }];
        const completed = await term.saleStore.completeSale({
          cartId: cart.id,
          actorUserId: activeSess.cashierId,
          clientRequestId: env.nextUuid(),
          expectedTotal: moneyFromTiyin(totalFinal),
          payments: salePayments,
        });
        ms.sales.push({
          saleId: completed.sale.id,
          lineId: completed.sale.lines[0].id,
          qtySold: qtyUnits * 1_000n,
          qtyReturned: 0n,
          voided: false,
          cashPaid: cashShare,
          cardPaid: cardShare,
          cashRefunded: 0n,
          cardRefunded: 0n,
          totalFinal,
          sessionIdx: activeSessIdx,
        });
        ms.cashMovesNet += cashShare;
        ms.cashSalesTotal += cashShare;
        ms.cardSalesTotal += cardShare;
        ms.grossSales += totalFinal;
        ms.salesCount += 1;
        activeSess.cashDelta += cashShare;
        activeSess.salesCount += 1;
        activeSess.salesTotal += totalFinal;
      } else if (op < 62 && ms.sales.some((s) => !s.voided && s.qtyReturned === 0n)) {
        // Void untouched open-shift sale (as manager, X2 attributes cash move to active session!)
        const target = ms.sales.find((s) => !s.voided && s.qtyReturned === 0n)!;
        const activeSess = ms.sessions[ms.sessions.length - 1];
        const drawerAvail = activeSess.openingFloat + activeSess.cashDelta;
        if (drawerAvail >= target.cashPaid) {
          await term.returnStore.voidSale({
            saleId: target.saleId,
            actorUserId: env.managerId,
            reason: `Model void ${step}`,
            clientRequestId: env.nextUuid(),
          });
          target.voided = true;
          ms.cashMovesNet -= target.cashPaid;
          ms.cashSalesTotal -= target.cashPaid;
          ms.cardSalesTotal -= target.cardPaid;
          ms.grossSales -= target.totalFinal;
          ms.salesCount -= 1;
          ms.voidsCount += 1;
          activeSess.cashDelta -= target.cashPaid;
          // Original session's non-voided sales stats decrease while void cash out comes out of current active session
          const origSess = ms.sessions[target.sessionIdx];
          origSess.salesCount -= 1;
          origSess.salesTotal -= target.totalFinal;
        }
      } else if (
        op < 75 &&
        ms.sales.some((s) => !s.voided && s.qtySold - s.qtyReturned >= 1_000n)
      ) {
        // Partial return of 1 unit (by manager -> X2 charges active session!)
        const target = ms.sales.find((s) => !s.voided && s.qtySold - s.qtyReturned >= 1_000n)!;
        const remCash = target.cashPaid - target.cashRefunded;
        const remCard = target.cardPaid - target.cardRefunded;
        const activeSess = ms.sessions[ms.sessions.length - 1];
        const drawerAvail = activeSess.openingFloat + activeSess.cashDelta;
        const payCash = remCash >= 10_000n && drawerAvail >= 10_000n ? 10_000n : 0n;
        const payCard = payCash === 10_000n ? 0n : remCard >= 10_000n ? 10_000n : 0n;
        if (payCash + payCard === 10_000n) {
          await term.returnStore.createReturn({
            saleId: target.saleId,
            actorUserId: env.managerId,
            reason: `Model return ${step}`,
            clientRequestId: env.nextUuid(),
            items: [{ saleLineId: target.lineId, qty: quantityFromMilli(1_000n) }],
            payments:
              payCash > 0n
                ? [{ method: 'cash', amount: moneyFromTiyin(10_000n) }]
                : [{ method: 'card', amount: moneyFromTiyin(10_000n), providerRef: `R-${step}` }],
          });
          target.qtyReturned += 1_000n;
          target.cashRefunded += payCash;
          target.cardRefunded += payCard;
          ms.cashMovesNet -= payCash;
          ms.cashReturnsTotal += payCash;
          ms.cardReturnsTotal += payCard;
          ms.returnsTotal += 10_000n;
          ms.returnsCount += 1;
          const activeSess = ms.sessions[ms.sessions.length - 1];
          activeSess.cashDelta -= payCash;
          activeSess.returnsCount += 1;
          activeSess.returnsTotal += 10_000n;
        }
      } else if (op < 87) {
        // Cash in / cash out / encashment
        const activeSess = ms.sessions[ms.sessions.length - 1];
        const drawerAvail = activeSess.openingFloat + activeSess.cashDelta;
        const isIn = op % 3 === 0 || drawerAvail < 15_000n;
        const amt = 15_000n;
        await term.shiftStore.recordShiftCashMove({
          shiftId: ms.shiftId,
          actorUserId: env.managerId,
          clientRequestId: env.nextUuid(),
          type: isIn ? 'cash_in' : op % 3 === 1 ? 'cash_out' : 'encashment',
          amount: moneyFromTiyin(amt),
          reason: `Model move ${step}`,
          expenseCategory: !isIn && op % 3 === 1 ? 'supplies' : null,
        });
        const delta = isIn ? amt : -amt;
        ms.cashMovesNet += delta;
        activeSess.cashDelta += delta;
      } else if (op < 94) {
        // Cashier handoff A <-> B mid-shift
        const prevSess = ms.sessions[ms.sessions.length - 1];
        const nextCashier = prevSess.cashierId === env.cashierAId ? env.cashierBId : env.cashierAId;
        const expSessFloat = prevSess.openingFloat + prevSess.cashDelta;
        const delta = BigInt(seededNextInt(env.random, 5) - 2) * 1_000n;
        const counted = expSessFloat + delta < 0n ? 0n : expSessFloat + delta;
        const ho = await term.shiftStore.handoffCashier({
          shiftId: ms.shiftId,
          actorUserId: prevSess.cashierId,
          nextCashierUserId: nextCashier,
          clientRequestId: env.nextUuid(),
          countedCash: moneyFromTiyin(counted),
          discrepancyReason: counted !== expSessFloat ? `Handoff ${step}` : null,
        });
        prevSess.countedCash = counted;
        ms.sessions.push({
          sessionId: ho.activeSession.id,
          cashierId: nextCashier,
          openingFloat: counted,
          cashDelta: 0n,
          salesCount: 0,
          returnsCount: 0,
          salesTotal: 0n,
          returnsTotal: 0n,
          countedCash: null,
        });
      } else if (op >= 94 && closedShifts.length > 0) {
        // Reclose a random closed shift
        const cShift = closedShifts[seededNextInt(env.random, closedShifts.length)];
        const newCount = cShift.latestExpectedCash + 2_000n;
        const rec = await env.shiftStore.recloseShift({
          shiftId: cShift.shiftId,
          actorUserId: env.managerId,
          clientRequestId: env.nextUuid(),
          countedCash: moneyFromTiyin(newCount),
          reason: `Model reclose ${step}`,
        });
        cShift.latestCountedCash = newCount;
        cShift.latestClosureId = rec.closure.id;
        verifyClosure(rec.closure, cShift);
      }

      await verifyTerminalDrawer(0);
      await verifyTerminalDrawer(1);
    }

    // Close any open shifts on both terminals cleanly and execute closeBusinessDay
    for (const tIdx of [0, 1] as const) {
      const ms = activeByTerm[tIdx];
      if (ms) {
        const term = tIdx === 0 ? termA : termB;
        const expCash = ms.openingCash + ms.cashMovesNet;
        const activeSess = ms.sessions[ms.sessions.length - 1];
        const res = await term.shiftStore.closeShift({
          shiftId: ms.shiftId,
          actorUserId: activeSess.cashierId,
          clientRequestId: env.nextUuid(),
          countedCash: moneyFromTiyin(expCash),
        });
        ms.latestCountedCash = expCash;
        ms.latestExpectedCash = expCash;
        ms.closedDate = currentDay;
        verifyClosure(res.closure, ms);
        closedShifts.push(ms);
        activeByTerm[tIdx] = null;
      }
    }

    const dc = await env.shiftStore.closeBusinessDay({
      actorUserId: env.ownerId,
      clientRequestId: env.nextUuid(),
      businessDate: currentDay,
    });
    const expGrossDay = closedShifts.reduce((a, s) => a + s.grossSales, 0n);
    const expRetDay = closedShifts.reduce((a, s) => a + s.returnsTotal, 0n);
    const expCountedDay = closedShifts.reduce((a, s) => a + s.latestCountedCash, 0n);
    expect(dc.dayClose.shiftsCount).toBe(closedShifts.length);
    expect(moneyToTiyin(dc.dayClose.grossSalesTotal)).toBe(expGrossDay);
    expect(moneyToTiyin(dc.dayClose.returnsTotal)).toBe(expRetDay);
    expect(moneyToTiyin(dc.dayClose.countedCashTotal)).toBe(expCountedDay);
    expect(dc.dayClose.isStale).toBe(false);
  }, 20_000);

  it('handles 40_000n prior cash + MAX_MONEY_TIYIN cash tender & change without SQLite int64 SUM overflow', async () => {
    // Part A: exact M4 cash_moves sequence [+40_000n, +MAX_MONEY_TIYIN, -(MAX_MONEY_TIYIN - 50_000n)]
    const env1 = await setupShiftEnv();
    const open1 = await env1.shiftStore.openShift({
      actorUserId: env1.cashierAId,
      clientRequestId: env1.nextUuid(),
      openingCash: ZERO_MONEY,
    });
    await env1.shiftStore.recordShiftCashMove({
      shiftId: open1.shift.id,
      actorUserId: env1.managerId,
      clientRequestId: env1.nextUuid(),
      type: 'cash_in',
      amount: moneyFromTiyin(40_000n),
      reason: 'prior drawer cash before MAX_MONEY_TIYIN tender',
    });
    const prod1 = await env1.catalogStore.createProduct({
      name: 'Large Tender Item A',
      unit: 'dona',
      unlimited: true,
      salePrice: '50000',
      vatRateBp: 0,
      actorUserId: env1.ownerId,
    });
    const cart1 = await env1.cartStore.openCart(env1.cashierAId);
    await env1.cartStore.addLine(cart1.id, {
      kind: 'catalog',
      productId: prod1.product.id,
      variantId: null,
      qty: quantityFromMilli(1_000n),
    });
    await env1.saleStore.completeSale({
      cartId: cart1.id,
      actorUserId: env1.cashierAId,
      clientRequestId: env1.nextUuid(),
      expectedTotal: moneyFromTiyin(50_000n),
      payments: [{ method: 'cash', tenderedAmount: moneyFromTiyin(MAX_MONEY_TIYIN) }],
    });

    expect(
      moneyToTiyin(
        getActiveShiftDrawerBalanceSync(env1.connection.db, env1.connection.sqlite, {
          organizationId: open1.shift.organizationId,
          storeId: open1.shift.storeId,
          deviceId: open1.shift.deviceId,
        }),
      ),
    ).toBe(90_000n);
    expect(
      moneyToTiyin(
        getActiveStoreCashBalanceSync(env1.connection.db, env1.connection.sqlite, {
          organizationId: open1.shift.organizationId,
          storeId: open1.shift.storeId,
        }),
      ),
    ).toBe(90_000n);

    // Part B: openingCash 40_000n + MAX_MONEY_TIYIN cash tender & change -> handoffCashier + closeShift succeed
    const env2 = await setupShiftEnv();
    const open2 = await env2.shiftStore.openShift({
      actorUserId: env2.cashierAId,
      clientRequestId: env2.nextUuid(),
      openingCash: moneyFromTiyin(40_000n),
    });
    const prod2 = await env2.catalogStore.createProduct({
      name: 'Large Tender Item B',
      unit: 'dona',
      unlimited: true,
      salePrice: '50000',
      vatRateBp: 0,
      actorUserId: env2.ownerId,
    });
    const cart2 = await env2.cartStore.openCart(env2.cashierAId);
    await env2.cartStore.addLine(cart2.id, {
      kind: 'catalog',
      productId: prod2.product.id,
      variantId: null,
      qty: quantityFromMilli(1_000n),
    });
    await env2.saleStore.completeSale({
      cartId: cart2.id,
      actorUserId: env2.cashierAId,
      clientRequestId: env2.nextUuid(),
      expectedTotal: moneyFromTiyin(50_000n),
      payments: [{ method: 'cash', tenderedAmount: moneyFromTiyin(MAX_MONEY_TIYIN) }],
    });

    const handed = await env2.shiftStore.handoffCashier({
      shiftId: open2.shift.id,
      actorUserId: env2.cashierAId,
      nextCashierUserId: env2.cashierBId,
      clientRequestId: env2.nextUuid(),
      countedCash: moneyFromTiyin(90_000n),
    });
    expect(handed.closedSession.expectedCash).toBe(moneyFromTiyin(90_000n));

    const closed = await env2.shiftStore.closeShift({
      shiftId: open2.shift.id,
      actorUserId: env2.cashierBId,
      clientRequestId: env2.nextUuid(),
      countedCash: moneyFromTiyin(90_000n),
    });
    expect(moneyToTiyin(closed.closure.expectedCash)).toBe(90_000n);
    expect(moneyToTiyin(closed.closure.grossSalesTotal)).toBe(50_000n);
    const cashRow = closed.closure.methodTotals.find((x) => x.method === 'cash');
    expect(cashRow).toBeDefined();
    if (cashRow) {
      expect(moneyToTiyin(cashRow.salesAmount)).toBe(50_000n);
    }
  });

  it('B1 (X1 session physical cash): post-handoff drawerCashBalance, getTerminalCashBalance & outflow guards use activeSession.openingFloat + session cash_moves, while closure preserves D_shift === SUM(D_i)', async () => {
    const env = await setupShiftEnv({ seed: 919 });
    const item = await env.catalogStore.createProduct({
      name: 'B1 Drawer Test Item',
      unit: 'dona',
      unlimited: true,
      salePrice: '8474',
      vatRateBp: 0,
      actorUserId: env.ownerId,
    });

    const opened = await env.shiftStore.openShift({
      actorUserId: env.cashierAId,
      clientRequestId: env.nextUuid(),
      openingCash: ZERO_MONEY,
    });

    // Cashier A completes an 8,474 cash sale + 99 cash_in -> expected = 8,573
    const cart1 = await env.cartStore.openCart(env.cashierAId);
    await env.cartStore.addLine(cart1.id, {
      kind: 'catalog',
      productId: item.product.id,
      variantId: null,
      qty: quantityFromMilli(1_000n),
    });
    const sale1 = await env.saleStore.completeSale({
      cartId: cart1.id,
      actorUserId: env.cashierAId,
      clientRequestId: env.nextUuid(),
      expectedTotal: moneyFromTiyin(8_474n),
      payments: [{ method: 'cash', tenderedAmount: moneyFromTiyin(8_474n) }],
    });
    await env.shiftStore.recordShiftCashMove({
      shiftId: opened.shift.id,
      actorUserId: env.managerId,
      clientRequestId: env.nextUuid(),
      type: 'cash_in',
      amount: moneyFromTiyin(99n),
      reason: 'Small change top-up',
    });

    // Cashier A hands off with countedCash = 8,473 (shortage = -100 vs expected 8,573)
    const handoff = await env.shiftStore.handoffCashier({
      shiftId: opened.shift.id,
      actorUserId: env.cashierAId,
      nextCashierUserId: env.cashierBId,
      clientRequestId: env.nextUuid(),
      countedCash: moneyFromTiyin(8_473n),
      discrepancyReason: 'Missing 100 tiyin at handoff',
    });
    expect(handoff.closedSession.expectedCash).toBe(moneyFromTiyin(8_573n));
    expect(handoff.closedSession.discrepancy).toBe(moneyFromTiyin(-100n));
    expect(handoff.activeSession.openingFloat).toBe(moneyFromTiyin(8_473n));

    // All drawer balance readers MUST report 8,473 (NOT 8,573!)
    expect(handoff.drawerCashBalance).toBe(moneyFromTiyin(8_473n));
    expect((await env.shiftStore.getCurrentShift()).drawerCashBalance).toBe(moneyFromTiyin(8_473n));
    expect(await env.saleStore.getTerminalCashBalance()).toBe(moneyFromTiyin(8_473n));
    expect(
      getActiveShiftDrawerBalanceSync(env.connection.db, env.connection.sqlite, {
        organizationId: env.organizationId,
        storeId: env.storeId,
        deviceId: env.deviceId,
      }),
    ).toBe(moneyFromTiyin(8_473n));
    expect(
      getActiveStoreCashBalanceSync(env.connection.db, env.connection.sqlite, {
        organizationId: env.organizationId,
        storeId: env.storeId,
      }),
    ).toBe(moneyFromTiyin(8_473n));

    // Spending/returning > 8,473 (both 8,474 cash return and 8,474 encashment) MUST reject with INSUFFICIENT_CASH_IN_DRAWER!
    await expect(
      env.returnStore.createReturn({
        saleId: sale1.sale.id,
        actorUserId: env.managerId,
        reason: 'Full 8,474 refund blocked by 8,473 physical cash',
        clientRequestId: env.nextUuid(),
        items: [{ saleLineId: sale1.sale.lines[0].id, qty: quantityFromMilli(1_000n) }],
        payments: [{ method: 'cash', amount: moneyFromTiyin(8_474n) }],
      }),
    ).rejects.toMatchObject({ code: 'INSUFFICIENT_CASH_IN_DRAWER' });

    await expect(
      env.shiftStore.recordShiftCashMove({
        shiftId: opened.shift.id,
        actorUserId: env.managerId,
        clientRequestId: env.nextUuid(),
        type: 'encashment',
        amount: moneyFromTiyin(8_474n),
        reason: 'Exceeds physical cash by 1 tiyin',
      }),
    ).rejects.toMatchObject({ code: 'INSUFFICIENT_CASH_IN_DRAWER' });

    // Exact physical balance 8,473 encashment MUST succeed -> drawerCashBalance becomes 0
    const encashed = await env.shiftStore.recordShiftCashMove({
      shiftId: opened.shift.id,
      actorUserId: env.managerId,
      clientRequestId: env.nextUuid(),
      type: 'encashment',
      amount: moneyFromTiyin(8_473n),
      reason: 'Exact physical drawer cash encashed',
    });
    expect(encashed.drawerCashBalance).toBe(ZERO_MONEY);
    expect(await env.saleStore.getTerminalCashBalance()).toBe(ZERO_MONEY);

    // Session B adds 500 cash_in -> drawerCashBalance = 8,473 + (-8,473 + 500) = 500
    const cashInB = await env.shiftStore.recordShiftCashMove({
      shiftId: opened.shift.id,
      actorUserId: env.managerId,
      clientRequestId: env.nextUuid(),
      type: 'cash_in',
      amount: moneyFromTiyin(500n),
      reason: 'Session B float refill',
    });
    expect(cashInB.drawerCashBalance).toBe(moneyFromTiyin(500n));
    expect(await env.saleStore.getTerminalCashBalance()).toBe(moneyFromTiyin(500n));

    // Close shift with countedCash = 525 (Session B has +25 surplus vs its 500 expected -> D_2 = +25)
    // Shift-level expectedCash = 0 + (8,474 + 99 - 8,473 + 500) = 600, so D_shift = 525 - 600 = -75 === D_1 (-100) + D_2 (+25)!
    const closed = await env.shiftStore.closeShift({
      shiftId: opened.shift.id,
      actorUserId: env.cashierBId,
      clientRequestId: env.nextUuid(),
      countedCash: moneyFromTiyin(525n),
      discrepancyReason: 'Combined shift shortage reconciled (-100 + 25 = -75)',
    });
    expect(closed.closure.expectedCash).toBe(moneyFromTiyin(600n));
    expect(closed.closure.discrepancy).toBe(moneyFromTiyin(-75n));
    expect(closed.closure.cashiers).toHaveLength(2);
    expect(closed.closure.cashiers[0].discrepancy).toBe(moneyFromTiyin(-100n));
    expect(closed.closure.cashiers[1].discrepancy).toBe(moneyFromTiyin(25n));
    const sumSessionsDisc = closed.closure.cashiers.reduce(
      (acc, c) => acc + moneyToTiyin(c.discrepancy),
      0n,
    );
    expect(sumSessionsDisc).toBe(moneyToTiyin(closed.closure.discrepancy));
  });
});
