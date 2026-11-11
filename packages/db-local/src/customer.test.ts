import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  type Money,
  type PinHasher,
  type UnixMs,
  type UuidV7,
  ZERO_MONEY,
  allocateCustomerLedgerFifo,
  computeDebtDueAtMs,
  epochDaysFromCivilDate,
  moneyFromTiyin,
  moneyToTiyin,
  parseUuidV7,
  quantityFromMilli,
  unixMsFromBigInt,
} from '@mezon/domain';
import { FixedClock, SeededRandomSource } from '@mezon/test-utils';
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import {
  type LocalSqliteConnection,
  createSqliteCartStore,
  createSqliteCatalogStore,
  createSqliteCustomerStore,
  createSqliteHubAuthStore,
  createSqliteReturnStore,
  createSqliteSaleStore,
  createSqliteShiftStore,
  createSqliteStockStore,
  customerLedger,
  formatOutboxRecordForDebug,
  getActiveShiftDrawerBalanceSync,
  listAllOutboxRecordsSync,
  localCustomerBalances,
  migrateLocalDatabase,
  openLocalSqliteDatabase,
} from './index.js';

const FAST_TEST_HASHER: PinHasher = {
  hash: (pin) => Promise.resolve(`fast-hash:${pin}`),
  verify: (hash, pin) => Promise.resolve(hash === `fast-hash:${pin}`),
};

const tempDirs: string[] = [];
const openConnections: LocalSqliteConnection[] = [];

function makeTempDbPath(name = 'customer-test.db'): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mezon-t17-cust-'));
  tempDirs.push(dir);
  return path.join(dir, name);
}

function seededNextInt(rng: SeededRandomSource, maxExclusive: number): number {
  const b = rng.nextBytes(2);
  return ((b[0] << 8) | b[1]) % maxExclusive;
}

function makeUuidFromIndex(prefix: number, index: number): UuidV7 {
  return parseUuidV7(
    `0197${prefix.toString(16).padStart(4, '0')}-0000-7000-8000-${index.toString(16).padStart(12, '0')}`,
  );
}

afterEach(() => {
  while (openConnections.length > 0) {
    const conn = openConnections.pop()!;
    try {
      conn.close();
    } catch {
      // ignore closed handles
    }
  }
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 });
  }
});

// 2026-06-01 10:00:00 Asia/Tashkent = 2026-06-01T05:00:00.000Z
const DAY1_1000_MS = epochDaysFromCivilDate('2026-06-01') * 86_400_000n + 5n * 3_600_000n;

async function setupCustomerEnv(options?: {
  readonly dbPath?: string;
  readonly initialMs?: bigint;
  readonly seed?: number;
}) {
  const dbPath = options?.dbPath ?? makeTempDbPath();
  const clock = new FixedClock(options?.initialMs ?? DAY1_1000_MS);
  const random = new SeededRandomSource(options?.seed ?? 91);
  const connection = openLocalSqliteDatabase(dbPath);
  openConnections.push(connection);
  migrateLocalDatabase(connection.db);

  const authStore = await createSqliteHubAuthStore({ connection, clock, random });
  const setup = await authStore.completeSetup({
    fullName: 'Owner',
    username: 'owner17',
    pinHash: await FAST_TEST_HASHER.hash('849201'),
  });
  const manager = await authStore.createUser({
    fullName: 'Manager',
    username: 'mgr17',
    role: 'manager',
    pinHash: await FAST_TEST_HASHER.hash('592817'),
  });
  const cashier = await authStore.createUser({
    fullName: 'Cashier',
    username: 'cash17',
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
  const cartStore = createSqliteCartStore({ connection, getRuntimeContext: getStoreCtx });
  const saleStore = createSqliteSaleStore({ connection, getRuntimeContext: getStoreCtx });
  const returnStore = createSqliteReturnStore({ connection, getRuntimeContext: getStoreCtx });
  const customerStore = createSqliteCustomerStore({ connection, getRuntimeContext: getStoreCtx });
  const shiftStore = createSqliteShiftStore({ connection, getRuntimeContext: getStoreCtx });
  const initialShift = await shiftStore.openShift({
    actorUserId: cashier.id,
    clientRequestId: makeUuidFromIndex(0x00aa, 999999),
    openingCash: ZERO_MONEY,
  });

  let reqSeq = 1;
  const nextUuid = () => {
    reqSeq += 1;
    return makeUuidFromIndex(0x00aa, reqSeq);
  };

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
    customerStore,
    shiftStore,
    initialShiftId: initialShift.shift.id,
    ownerId: setup.owner.id,
    managerId: manager.id,
    cashierId: cashier.id,
    organizationId: setup.organizationId,
    storeId: setup.storeId,
    deviceId: setup.deviceId,
    nextUuid,
  };
}

describe('@mezon/db-local - T1.7 Customer Profile, Ledger, FIFO, D1-D4 & Benchmarks', () => {
  it('enforces phone normalization, partial UNIQUE + tombstone reuse, PII outbox debug redaction, FACT/ATTR triggers & archive debt guard', async () => {
    const env = await setupCustomerEnv();
    try {
      const piiName = 'Dilshodbek Xudoyberdiyev';
      const piiPhoneInput = '90 444-55-66';
      const piiNote = 'VIP qarz oluvchi uy manzili bilan';
      const created = await env.customerStore.createCustomer({
        fullName: piiName,
        phone: piiPhoneInput,
        creditLimit: moneyFromTiyin(500_000n),
        defaultDueDays: 5,
        note: piiNote,
      });
      expect(created.phoneNormalized).toBe('+998904445566');
      expect(created.balance).toBe(ZERO_MONEY);

      // Duplicate active normalized phone -> 409 CUSTOMER_PHONE_ALREADY_EXISTS WITHOUT raw phone in error
      try {
        await env.customerStore.createCustomer({
          fullName: 'Boshqa Ism',
          phone: '+998904445566',
        });
        expect.unreachable('Duplicate phone should reject');
      } catch (err) {
        expect(err).toMatchObject({ code: 'CUSTOMER_PHONE_ALREADY_EXISTS' });
        expect((err as Error).message).not.toContain('904445566');
      }

      // Outbox sync payload keeps data for F2 sync, while debug formatter redacts all PII!
      const outbox = listAllOutboxRecordsSync(env.connection.db);
      const custOutbox = outbox.find((r) => r.entity === 'customers');
      expect(custOutbox).toBeDefined();
      expect(custOutbox!.payload.fullName).toBe(piiName);
      const debugJson = formatOutboxRecordForDebug(custOutbox!);
      expect(debugJson).not.toContain(piiName);
      expect(debugJson).not.toContain('+998904445566');
      expect(debugJson).not.toContain(piiNote);
      expect(debugJson).toContain('[Redacted]');

      // Record opening balance -> once only
      const obReqId = env.nextUuid();
      const ob1 = await env.customerStore.recordOpeningBalance({
        customerId: created.id,
        actorUserId: env.ownerId,
        clientRequestId: obReqId,
        amount: moneyFromTiyin(100_000n),
        reason: 'Eski daftardan qoldiq',
      });
      expect(moneyToTiyin(ob1.customer.balance)).toBe(100_000n);
      expect(ob1.idempotentReplay).toBe(false);

      // Same clientRequestId -> idempotent replay
      const obReplay = await env.customerStore.recordOpeningBalance({
        customerId: created.id,
        actorUserId: env.ownerId,
        clientRequestId: obReqId,
        amount: moneyFromTiyin(100_000n),
        reason: 'Eski daftardan qoldiq',
      });
      expect(obReplay.idempotentReplay).toBe(true);
      expect(obReplay.entry.id).toBe(ob1.entry.id);

      const dupReqId = env.nextUuid();
      await expect(
        env.customerStore.recordOpeningBalance({
          customerId: created.id,
          actorUserId: env.ownerId,
          clientRequestId: dupReqId,
          amount: moneyFromTiyin(50_000n),
          reason: 'Ikkinchi boshlangich qarz',
        }),
      ).rejects.toMatchObject({ code: 'OPENING_BALANCE_ALREADY_EXISTS' });

      // Cannot archive customer while balance > 0
      await expect(env.customerStore.archiveCustomer(created.id)).rejects.toMatchObject({
        code: 'CUSTOMER_HAS_OPEN_DEBT',
      });

      // Settle exact debt -> overpayment +1 rejected (D1)
      const curBal = 100_000n;
      await expect(
        env.customerStore.recordDebtPayment({
          customerId: created.id,
          actorUserId: env.cashierId,
          clientRequestId: env.nextUuid(),
          method: 'cash',
          amount: moneyFromTiyin(curBal + 1n),
        }),
      ).rejects.toMatchObject({ code: 'OVERPAYMENT_NOT_ALLOWED' });

      const paid = await env.customerStore.recordDebtPayment({
        customerId: created.id,
        actorUserId: env.cashierId,
        clientRequestId: env.nextUuid(),
        method: 'cash',
        amount: moneyFromTiyin(curBal),
        reason: 'Toza yopish',
      });
      expect(moneyToTiyin(paid.customer.balance)).toBe(0n);
      expect(paid.cashMove?.type).toBe('debt_payment_in');
      expect(
        moneyToTiyin(
          getActiveShiftDrawerBalanceSync(env.connection.db, env.connection.sqlite, {
            organizationId: env.organizationId,
            storeId: env.storeId,
            deviceId: env.deviceId,
          }),
        ),
      ).toBe(100_000n);

      // Pay when balance == 0 rejected
      await expect(
        env.customerStore.recordDebtPayment({
          customerId: created.id,
          actorUserId: env.cashierId,
          clientRequestId: env.nextUuid(),
          method: 'card',
          amount: moneyFromTiyin(1n),
        }),
      ).rejects.toMatchObject({ code: 'OVERPAYMENT_NOT_ALLOWED' });

      // FACT & ATTR triggers check
      expect(() =>
        env.connection.sqlite
          .prepare('UPDATE "customer_ledger" SET "amount_delta" = 0 WHERE "customer_id" = ?')
          .run(created.id),
      ).toThrowError(/UPDATE is forbidden/);
      expect(() =>
        env.connection.sqlite
          .prepare('DELETE FROM "customer_ledger" WHERE "customer_id" = ?')
          .run(created.id),
      ).toThrowError(/forbids physical DELETE/);
      expect(() =>
        env.connection.sqlite.prepare('DELETE FROM "customers" WHERE "id" = ?').run(created.id),
      ).toThrowError(/forbids physical DELETE/);

      // Now balance === 0 -> archive succeeds and frees +998904445566 for reuse
      const archived = await env.customerStore.archiveCustomer(created.id);
      expect(archived.customerId).toBe(created.id);
      const reused = await env.customerStore.createCustomer({
        fullName: 'Yangi Mijoz',
        phone: '+998904445566',
      });
      expect(reused.phoneNormalized).toBe('+998904445566');
    } finally {
      env.connection.close();
    }
  });

  it('supports credit sales (credit limit + override, non-debt customer history), overdue cutoff in Asia/Tashkent, return offsets, void guard & Window Function ledger history', async () => {
    const env = await setupCustomerEnv();
    try {
      const cust = await env.customerStore.createCustomer({
        fullName: 'Gulom Karimov',
        phone: '+7 701 555 1234',
        creditLimit: moneyFromTiyin(100_000n),
        defaultDueDays: 3,
      });

      const prod = await env.catalogStore.createProduct({
        name: 'Un 1kg',
        unit: 'kg',
        trackBatches: false,
        salePrice: '50000',
        vatRateBp: 0,
        actorUserId: env.ownerId,
      });
      await env.stockStore.recordInboundMove({
        productId: prod.product.id,
        reason: 'purchase',
        qty: '20000',
        totalCostValue: '400000',
        actorUserId: env.ownerId,
      });

      // 1) Non-debt sale attaches active customerId to receipt cleanly
      const c0 = await env.cartStore.openCart(env.cashierId);
      await env.cartStore.addLine(c0.id, {
        kind: 'catalog',
        productId: prod.product.id,
        variantId: null,
        qty: quantityFromMilli(1_000n),
      });
      const nonDebtSale = await env.saleStore.completeSale({
        cartId: c0.id,
        actorUserId: env.cashierId,
        clientRequestId: env.nextUuid(),
        expectedTotal: moneyFromTiyin(50_000n),
        customerId: cust.id,
        payments: [{ method: 'cash', tenderedAmount: moneyFromTiyin(50_000n) }],
      });
      expect(nonDebtSale.sale.customerId).toBe(cust.id);
      expect(nonDebtSale.sale.debtAmount).toBe(ZERO_MONEY);

      // 2) Credit limit enforcement: 120_000 > 100_000 blocked without override, succeeds WITH override
      const c1 = await env.cartStore.openCart(env.cashierId);
      await env.cartStore.addLine(c1.id, {
        kind: 'catalog',
        productId: prod.product.id,
        variantId: null,
        qty: quantityFromMilli(3_000n), // 150_000
      });
      await expect(
        env.saleStore.completeSale({
          cartId: c1.id,
          actorUserId: env.cashierId,
          clientRequestId: env.nextUuid(),
          expectedTotal: moneyFromTiyin(150_000n),
          customerId: cust.id,
          debtAmount: moneyFromTiyin(120_000n),
          payments: [{ method: 'cash', tenderedAmount: moneyFromTiyin(30_000n) }],
        }),
      ).rejects.toMatchObject({ code: 'CREDIT_LIMIT_EXCEEDED' });

      const sale1 = await env.saleStore.completeSale({
        cartId: c1.id,
        actorUserId: env.cashierId,
        clientRequestId: env.nextUuid(),
        expectedTotal: moneyFromTiyin(150_000n),
        customerId: cust.id,
        debtAmount: moneyFromTiyin(120_000n), // 30_000 cash + 120_000 debt
        creditOverrideApprovedByUserId: env.managerId,
        payments: [{ method: 'cash', tenderedAmount: moneyFromTiyin(30_000n) }],
      });
      expect(moneyToTiyin(sale1.sale.debtAmount)).toBe(120_000n);

      // 3) Advance time: before cutoff (2026-06-04 23:59:59 Tashkent) -> 0 overdue; +2s -> 1 day overdue!
      const dueCutoff = BigInt(
        computeDebtDueAtMs({
          createdAtMs: sale1.sale.createdAtMs,
          dueDays: 3,
          storeTimezone: 'Asia/Tashkent',
        })!,
      );
      env.clock.set(dueCutoff - 1_000n);
      const beforeDue = await env.customerStore.getCustomerDetail(cust.id);
      expect(moneyToTiyin(beforeDue.customer.overdueAmount)).toBe(0n);

      env.clock.set(dueCutoff + 1_000n);
      const afterDue = await env.customerStore.getCustomerDetail(cust.id);
      expect(moneyToTiyin(afterDue.customer.overdueAmount)).toBe(120_000n);
      expect(afterDue.customer.oldestOverdueDays).toBe(1);
      expect((await env.customerStore.listOverdueCustomers()).items.map((c) => c.id)).toContain(
        cust.id,
      );

      // 4) Customer pays 40_000 via card toward sale1 -> voidSale on sale1 MUST be rejected (`SALE_DEBT_HAS_PAYMENTS`)!
      await env.customerStore.recordDebtPayment({
        customerId: cust.id,
        actorUserId: env.cashierId,
        clientRequestId: env.nextUuid(),
        method: 'card',
        amount: moneyFromTiyin(40_000n),
      });

      // Test voidSale on a fresh unpaid credit sale same day vs sale1 (create another sale on same day & void it)
      const cVoid = await env.cartStore.openCart(env.cashierId);
      await env.cartStore.addLine(cVoid.id, {
        kind: 'catalog',
        productId: prod.product.id,
        variantId: null,
        qty: quantityFromMilli(1_000n), // 50_000 all debt
      });
      const voidableDebtSale = await env.saleStore.completeSale({
        cartId: cVoid.id,
        actorUserId: env.cashierId,
        clientRequestId: env.nextUuid(),
        expectedTotal: moneyFromTiyin(50_000n),
        customerId: cust.id,
        creditOverrideApprovedByUserId: env.ownerId,
        debtAmount: moneyFromTiyin(50_000n),
        payments: [],
      });
      // Detail now shows 80_000 remaining on sale1 + 50_000 on voidableDebtSale = 130_000
      expect(
        moneyToTiyin((await env.customerStore.getCustomerDetail(cust.id)).customer.balance),
      ).toBe(130_000n);

      await env.returnStore.voidSale({
        saleId: voidableDebtSale.sale.id,
        actorUserId: env.managerId,
        reason: 'Kassa xatosi qarzli chek void',
        clientRequestId: env.nextUuid(),
      });
      expect(
        moneyToTiyin((await env.customerStore.getCustomerDetail(cust.id)).customer.balance),
      ).toBe(80_000n);

      // Trying to void sale1 fails with SALE_DEBT_HAS_PAYMENTS (even if time were same day)
      env.clock.set(BigInt(sale1.sale.createdAtMs) + 1_000n);
      await expect(
        env.returnStore.voidSale({
          saleId: sale1.sale.id,
          actorUserId: env.managerId,
          reason: 'Tolangan qarzli chek void urinish',
          clientRequestId: env.nextUuid(),
        }),
      ).rejects.toMatchObject({ code: 'SALE_DEBT_HAS_PAYMENTS' });

      // 5) Return 2.000 kg (100_000) from sale1 -> remaining debt cap is 80_000 (120_000 - 40_000), card paid cap is 40_000 (from FIFO debt payment!), cash cap is 30_000
      //    Excess debtOffset (80_001) rejects!
      await expect(
        env.returnStore.createReturn({
          saleId: sale1.sale.id,
          actorUserId: env.managerId,
          reason: 'Ortiqcha offset',
          clientRequestId: env.nextUuid(),
          items: [{ saleLineId: sale1.sale.lines[0].id, qty: quantityFromMilli(2_000n) }],
          debtOffsetAmount: moneyFromTiyin(80_001n),
          payments: [{ method: 'cash', amount: moneyFromTiyin(19_999n) }],
        }),
      ).rejects.toMatchObject({ code: 'RETURN_DEBT_OFFSET_EXCEEDED' });

      // Valid return: 80_000 debt offset + 20_000 card (from card debt payment!) -> customer balance = 0!
      const retOk = await env.returnStore.createReturn({
        saleId: sale1.sale.id,
        actorUserId: env.managerId,
        reason: 'Qarz yopish va karta qaytarish',
        clientRequestId: env.nextUuid(),
        items: [{ saleLineId: sale1.sale.lines[0].id, qty: quantityFromMilli(2_000n) }],
        debtOffsetAmount: moneyFromTiyin(80_000n),
        payments: [{ method: 'card', amount: moneyFromTiyin(20_000n), providerRef: 'CARD-RET-1' }],
      });
      expect(moneyToTiyin(retOk.returnDoc.debtOffsetAmount)).toBe(80_000n);
      expect(
        moneyToTiyin((await env.customerStore.getCustomerDetail(cust.id)).customer.balance),
      ).toBe(0n);

      // 6) Ledger history Window Function check (running balances match chronological progression)
      const hist = await env.customerStore.listCustomerLedger(cust.id, { order: 'asc', limit: 20 });
      expect(hist.currentBalance).toBe(ZERO_MONEY);
      expect(
        hist.items.map((e) => [
          e.entryType,
          moneyToTiyin(e.amountDelta),
          moneyToTiyin(e.balanceAfter),
        ]),
      ).toEqual([
        ['sale_debt', 120_000n, 120_000n],
        ['debt_payment', -40_000n, 80_000n],
        ['sale_debt', 50_000n, 130_000n],
        ['return_offset', -50_000n, 80_000n],
        ['return_offset', -80_000n, 0n],
      ]);
    } finally {
      env.connection.close();
    }
  });

  it('T1.7 test debt: rejects sales for inactive customers (CUSTOMER_INACTIVE) with 0 DB writes while allowing debt payments', async () => {
    const env = await setupCustomerEnv();
    try {
      const cust = await env.customerStore.createCustomer({
        fullName: 'Nofaol Mijoz',
        phone: '+998907778899',
        creditLimit: moneyFromTiyin(200_000n),
      });

      const prod = await env.catalogStore.createProduct({
        name: 'Shakar 1kg',
        unit: 'kg',
        trackBatches: false,
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

      // Accrue initial 50_000 debt while customer is active
      const activeCart = await env.cartStore.openCart(env.cashierId);
      await env.cartStore.addLine(activeCart.id, {
        kind: 'catalog',
        productId: prod.product.id,
        variantId: null,
        qty: quantityFromMilli(1_000n),
      });
      await env.saleStore.completeSale({
        cartId: activeCart.id,
        actorUserId: env.cashierId,
        clientRequestId: env.nextUuid(),
        expectedTotal: moneyFromTiyin(50_000n),
        customerId: cust.id,
        debtAmount: moneyFromTiyin(50_000n),
        payments: [],
      });

      // Deactivate customer (isActive = false)
      const deactivated = await env.customerStore.updateCustomer(cust.id, { isActive: false });
      expect(deactivated.isActive).toBe(false);

      const countRows = () => ({
        sales: (
          env.connection.sqlite.prepare('SELECT COUNT(*) AS c FROM "sales"').get() as {
            readonly c: bigint;
          }
        ).c,
        stockMoves: (
          env.connection.sqlite.prepare('SELECT COUNT(*) AS c FROM "stock_moves"').get() as {
            readonly c: bigint;
          }
        ).c,
        customerLedger: (
          env.connection.sqlite.prepare('SELECT COUNT(*) AS c FROM "customer_ledger"').get() as {
            readonly c: bigint;
          }
        ).c,
        outbox: (
          env.connection.sqlite.prepare('SELECT COUNT(*) AS c FROM "local_outbox"').get() as {
            readonly c: bigint;
          }
        ).c,
      });

      // Attempt credit sale to inactive customer -> MUST reject with CUSTOMER_INACTIVE and 0 DB writes
      const inactiveCart = await env.cartStore.openCart(env.cashierId);
      await env.cartStore.addLine(inactiveCart.id, {
        kind: 'catalog',
        productId: prod.product.id,
        variantId: null,
        qty: quantityFromMilli(1_000n),
      });
      const snapBefore = countRows();

      await expect(
        env.saleStore.completeSale({
          cartId: inactiveCart.id,
          actorUserId: env.cashierId,
          clientRequestId: env.nextUuid(),
          expectedTotal: moneyFromTiyin(50_000n),
          customerId: cust.id,
          debtAmount: moneyFromTiyin(50_000n),
          payments: [],
        }),
      ).rejects.toMatchObject({ code: 'CUSTOMER_INACTIVE' });
      expect(countRows()).toEqual(snapBefore);

      // Even non-debt sale attached to inactive customer -> rejected with CUSTOMER_INACTIVE and 0 DB writes
      await expect(
        env.saleStore.completeSale({
          cartId: inactiveCart.id,
          actorUserId: env.cashierId,
          clientRequestId: env.nextUuid(),
          expectedTotal: moneyFromTiyin(50_000n),
          customerId: cust.id,
          debtAmount: ZERO_MONEY,
          payments: [{ method: 'cash', tenderedAmount: moneyFromTiyin(50_000n) }],
        }),
      ).rejects.toMatchObject({ code: 'CUSTOMER_INACTIVE' });
      expect(countRows()).toEqual(snapBefore);

      // Debt payment MUST still succeed for inactive customer (debt collection remains open)
      const paymentOutcome = await env.customerStore.recordDebtPayment({
        customerId: cust.id,
        actorUserId: env.cashierId,
        clientRequestId: env.nextUuid(),
        method: 'card',
        amount: moneyFromTiyin(20_000n),
        reason: 'Nofaol mijoz qarzini tolash',
      });
      expect(moneyToTiyin(paymentOutcome.customer.balance)).toBe(30_000n);
    } finally {
      env.connection.close();
    }
  });

  it('D2 + D3: enforces HLC FIFO ordering even under out-of-order DB insertion & positive/negative adjustment overdue rules', async () => {
    const env = await setupCustomerEnv();
    try {
      const cust = await env.customerStore.createCustomer({
        fullName: 'HLC Sync Customer',
        phone: '+998901112233',
      });

      // Insert out of chronological HLC order directly in SQLite (newer row inserted FIRST with earlier id? Or opposite hlc vs createdAtMs)
      const tEarlier = DAY1_1000_MS;
      const tLater = DAY1_1000_MS + 120_000n;
      const hlc1 = `${100n.toString().padStart(15, '0')}:00000:${env.deviceId}`; // earliest HLC
      const hlc2 = `${200n.toString().padStart(15, '0')}:00000:${env.deviceId}`; // positive adj, D3 no deadline
      const hlc3 = `${300n.toString().padStart(15, '0')}:00000:${env.deviceId}`; // explicit due adj
      const hlc4 = `${400n.toString().padStart(15, '0')}:00000:${env.deviceId}`; // payment

      const idLatestInsertedFirst = makeUuidFromIndex(0x0010, 1);
      const idMiddle = makeUuidFromIndex(0x0010, 2);
      const idEarliestInsertedLast = makeUuidFromIndex(0x0010, 3);
      const idPosAdjNoDue = makeUuidFromIndex(0x0010, 4);

      const duePast = BigInt(
        computeDebtDueAtMs({
          createdAtMs: unixMsFromBigInt(tEarlier),
          dueDays: 1,
          storeTimezone: 'Asia/Tashkent',
        })!,
      );

      // Disable triggers? No, INSERT into FACT is allowed! Notice opening_balance (hlc1) is inserted AFTER hlc4 and hlc3!
      const insertSql = env.connection.sqlite.prepare(
        `INSERT INTO "customer_ledger" ("id", "organization_id", "store_id", "device_id", "hlc", "created_at_ms", "customer_id", "entry_type", "amount_delta", "source_type", "source_id", "sale_id", "payment_method", "provider_ref", "cash_move_id", "due_at_ms", "reason", "created_by_user_id", "override_approved_by_user_id", "client_request_id", "request_hash")
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, NULL, NULL, ?, ?, ?, NULL, NULL, NULL)`,
      );

      // Insert in REVERSE order: hlc4 (-35_000 card), then hlc3 (+30_000 duePast pos adj), then hlc2 (+20_000 no-due pos adj), then hlc1 (+40_000 opening_balance)
      insertSql.run(
        idLatestInsertedFirst,
        env.organizationId,
        env.storeId,
        env.deviceId,
        hlc4,
        tEarlier, // Note intentionally earlier createdAtMs than hlc1 to prove D2 uses HLC not createdAtMs!
        cust.id,
        'debt_payment',
        -35_000n,
        'debt_payment',
        cust.id,
        'card',
        null,
        null,
        env.cashierId,
      );
      insertSql.run(
        idMiddle,
        env.organizationId,
        env.storeId,
        env.deviceId,
        hlc3,
        tLater,
        cust.id,
        'adjustment',
        30_000n,
        'adjustment',
        cust.id,
        null,
        duePast,
        'Explicit due positive adj',
        env.ownerId,
      );
      insertSql.run(
        idPosAdjNoDue,
        env.organizationId,
        env.storeId,
        env.deviceId,
        hlc2,
        tLater,
        cust.id,
        'adjustment',
        20_000n,
        'adjustment',
        cust.id,
        null,
        null,
        'No-due positive adj',
        env.ownerId,
      );
      insertSql.run(
        idEarliestInsertedLast,
        env.organizationId,
        env.storeId,
        env.deviceId,
        hlc1,
        tLater, // Newer createdAtMs + newer id, YET earlier HLC!
        cust.id,
        'opening_balance',
        40_000n,
        'opening_balance',
        cust.id,
        null,
        duePast,
        'Opening balance',
        env.ownerId,
      );

      await env.customerStore.rebuildCustomerBalances();
      env.clock.set(duePast + 10_000n);
      const det = await env.customerStore.getCustomerDetail(cust.id);

      // By HLC: hlc1 (+40_000 due) paid 35_000 -> 5_000 remaining (overdue!)
      // hlc2 (+20_000 no-due) -> 20_000 remaining (NOT overdue)
      // hlc3 (+30_000 due) -> 30_000 remaining (overdue!)
      // Total balance = 55_000; overdueAmount = 5_000 + 30_000 = 35_000!
      expect(moneyToTiyin(det.customer.balance)).toBe(55_000n);
      expect(moneyToTiyin(det.customer.overdueAmount)).toBe(35_000n);
      expect(det.openObligations.map((o) => [o.entryType, moneyToTiyin(o.remainingDebt)])).toEqual([
        ['opening_balance', 5_000n],
        ['adjustment', 20_000n],
        ['adjustment', 30_000n],
      ]);

      // Negative adjustment forgives oldest remaining FIFO obligations (5_000 opening + 5_000 of hlc2)
      const adjNeg = await env.customerStore.recordDebtAdjustment({
        customerId: cust.id,
        actorUserId: env.ownerId,
        clientRequestId: env.nextUuid(),
        amountDelta: moneyFromTiyin(-10_000n),
        reason: 'Chegirma',
      });
      expect(moneyToTiyin(adjNeg.customer.balance)).toBe(45_000n);
      expect(moneyToTiyin(adjNeg.customer.overdueAmount)).toBe(30_000n); // opening_balance (5_000) was waived!
    } finally {
      env.connection.close();
    }
  });

  it('D1 + D2 + D3 model test: 60 seeded random multi-customer sales, payments, adjustments, returns, voids & invalid D1 probes match independent model strictly + rebuildCustomerBalances parity', async () => {
    const env = await setupCustomerEnv({ seed: 777 });
    const rng = new SeededRandomSource(2026);
    try {
      const prod = await env.catalogStore.createProduct({
        name: 'Model Tovar',
        unit: 'kg',
        trackBatches: false,
        salePrice: '10000',
        vatRateBp: 0,
        actorUserId: env.ownerId,
      });
      await env.stockStore.recordInboundMove({
        productId: prod.product.id,
        reason: 'purchase',
        qty: '500000',
        totalCostValue: '2500000',
        actorUserId: env.ownerId,
      });

      const customerIds: UuidV7[] = [];
      for (let i = 0; i < 3; i += 1) {
        const c = await env.customerStore.createCustomer({
          fullName: `Model Mijoz ${i}`,
          phone: `90100000${i}`,
          creditLimit: null,
          defaultDueDays: 2 + i,
        });
        customerIds.push(c.id);
      }

      // Independent in-memory ledger oracle per customer
      const modelEntries = new Map<
        UuidV7,
        {
          id: UuidV7;
          hlc: string;
          createdAtMs: UnixMs;
          entryType:
            'opening_balance' | 'sale_debt' | 'debt_payment' | 'return_offset' | 'adjustment';
          amountDelta: Money;
          sourceType:
            'opening_balance' | 'sale' | 'debt_payment' | 'sale_void' | 'return' | 'adjustment';
          saleId: UuidV7 | null;
          paymentMethod: 'cash' | 'card' | null;
          dueAtMs: UnixMs | null;
        }[]
      >();
      for (const cid of customerIds) modelEntries.set(cid, []);
      let expectedDrawerCash = 0n;

      interface TrackedSale {
        readonly saleId: UuidV7;
        readonly lineId: UuidV7;
        readonly customerId: UuidV7;
        readonly unitPrice: bigint;
        readonly soldMilli: bigint;
        returnedMilli: bigint;
        voided: boolean;
        readonly createdDay: string;
        readonly origCash: bigint;
        readonly origCard: bigint;
        priorRetCash: bigint;
        priorRetCard: bigint;
      }
      const salesList: TrackedSale[] = [];

      const assertModelParity = async () => {
        const nowMs = env.clock.now();
        expect(
          moneyToTiyin(
            getActiveShiftDrawerBalanceSync(env.connection.db, env.connection.sqlite, {
              organizationId: env.organizationId,
              storeId: env.storeId,
              deviceId: env.deviceId,
            }),
          ),
        ).toBe(expectedDrawerCash);

        for (const cid of customerIds) {
          const det = await env.customerStore.getCustomerDetail(cid);
          const dbBal = moneyToTiyin(det.customer.balance);
          expect(dbBal).toBeGreaterThanOrEqual(0n); // D1 hard check!

          const sumSqlRow = env.connection.sqlite
            .prepare(
              'SELECT COALESCE(SUM("amount_delta"), 0) AS s FROM "customer_ledger" WHERE "organization_id" = ? AND "customer_id" = ?',
            )
            .safeIntegers(true)
            .get(env.organizationId, cid) as { readonly s: bigint };
          expect(dbBal).toBe(sumSqlRow.s);

          const projRow = env.connection.db
            .select()
            .from(localCustomerBalances)
            .where(eq(localCustomerBalances.customerId, cid))
            .limit(1)
            .all()[0];
          expect(projRow).toBeDefined();
          expect(moneyToTiyin(projRow.balance)).toBe(dbBal);

          const modelRes = allocateCustomerLedgerFifo({
            entries: modelEntries.get(cid)!,
            asOfMs: unixMsFromBigInt(nowMs),
            storeTimezone: 'Asia/Tashkent',
          });
          expect(moneyToTiyin(modelRes.balance)).toBe(dbBal);
          expect(moneyToTiyin(modelRes.overdueAmount)).toBe(
            moneyToTiyin(det.customer.overdueAmount),
          );
        }
      };

      const syncLatestCustomerLedgerEntryToModel = (cid: UuidV7) => {
        const rows = env.connection.db
          .select()
          .from(customerLedger)
          .where(eq(customerLedger.customerId, cid))
          .all();
        modelEntries.set(
          cid,
          rows.map((r) => ({
            id: r.id,
            hlc: r.hlc,
            createdAtMs: r.createdAtMs,
            entryType: r.entryType as
              'opening_balance' | 'sale_debt' | 'debt_payment' | 'return_offset' | 'adjustment',
            amountDelta: r.amountDelta,
            sourceType: r.sourceType as
              'opening_balance' | 'sale' | 'debt_payment' | 'sale_void' | 'return' | 'adjustment',
            saleId: r.saleId,
            paymentMethod: r.paymentMethod as 'cash' | 'card' | null,
            dueAtMs: r.dueAtMs,
          })),
        );
      };

      let stepCount = 0;
      for (let step = 0; step < 60; step += 1) {
        stepCount += 1;
        const cid = customerIds[seededNextInt(rng, customerIds.length)];
        if (cid === undefined) {
          throw new Error('Missing customerId in model test');
        }
        const action = seededNextInt(rng, 100);
        if (action < 12) {
          env.clock.advance(BigInt(seededNextInt(rng, 3) + 1) * 86_400_000n);
        }

        const detBefore = await env.customerStore.getCustomerDetail(cid);
        const balBefore = moneyToTiyin(detBefore.customer.balance);

        if (action < 35 || salesList.length === 0) {
          // Credit sale (with mixed cash/card + debt)
          const qtyUnits = BigInt(seededNextInt(rng, 4) + 1); // 1..4 kg
          const total = qtyUnits * 10_000n;
          const debt = BigInt(seededNextInt(rng, Number(total) + 1));
          const paid = total - debt;
          const cashPart = paid > 0n ? BigInt(seededNextInt(rng, Number(paid) + 1)) : 0n;
          const cardPart = paid - cashPart;
          const paymentsInput: (
            { method: 'cash'; tenderedAmount: Money } | { method: 'card'; amount: Money }
          )[] = [];
          if (cashPart > 0n)
            paymentsInput.push({ method: 'cash', tenderedAmount: moneyFromTiyin(cashPart) });
          if (cardPart > 0n)
            paymentsInput.push({ method: 'card', amount: moneyFromTiyin(cardPart) });

          const cart = await env.cartStore.openCart(env.cashierId);
          await env.cartStore.addLine(cart.id, {
            kind: 'catalog',
            productId: prod.product.id,
            variantId: null,
            qty: quantityFromMilli(qtyUnits * 1_000n),
          });
          const s = await env.saleStore.completeSale({
            cartId: cart.id,
            actorUserId: env.cashierId,
            clientRequestId: env.nextUuid(),
            expectedTotal: moneyFromTiyin(total),
            customerId: cid,
            debtAmount: moneyFromTiyin(debt),
            payments: paymentsInput,
          });
          expectedDrawerCash += cashPart;
          syncLatestCustomerLedgerEntryToModel(cid);
          salesList.push({
            saleId: s.sale.id,
            lineId: s.sale.lines[0].id,
            customerId: cid,
            unitPrice: 10_000n,
            soldMilli: qtyUnits * 1_000n,
            returnedMilli: 0n,
            voided: false,
            createdDay: new Date(Number(s.sale.createdAtMs) + 5 * 3600_000)
              .toISOString()
              .slice(0, 10),
            origCash: cashPart,
            origCard: cardPart,
            priorRetCash: 0n,
            priorRetCard: 0n,
          });
        } else if (action < 60) {
          // Probe D1 overpayment rejection (+1 tiyin), then valid payment
          await expect(
            env.customerStore.recordDebtPayment({
              customerId: cid,
              actorUserId: env.cashierId,
              clientRequestId: env.nextUuid(),
              method: 'cash',
              amount: moneyFromTiyin(balBefore + 1n),
            }),
          ).rejects.toMatchObject({ code: 'OVERPAYMENT_NOT_ALLOWED' });

          if (balBefore > 0n) {
            const payAmt =
              balBefore === 1n ? 1n : BigInt(seededNextInt(rng, Number(balBefore))) + 1n;
            const useCash = seededNextInt(rng, 2) === 0;
            await env.customerStore.recordDebtPayment({
              customerId: cid,
              actorUserId: env.cashierId,
              clientRequestId: env.nextUuid(),
              method: useCash ? 'cash' : 'card',
              amount: moneyFromTiyin(payAmt),
            });
            if (useCash) expectedDrawerCash += payAmt;
            syncLatestCustomerLedgerEntryToModel(cid);
          }
        } else if (action < 75) {
          // D3 adjustment (+ or -) + D1 excess negative adjustment probe
          await expect(
            env.customerStore.recordDebtAdjustment({
              customerId: cid,
              actorUserId: env.ownerId,
              clientRequestId: env.nextUuid(),
              amountDelta: moneyFromTiyin(-(balBefore + 1n)),
              reason: 'D1 probe',
            }),
          ).rejects.toMatchObject({ code: 'OVERPAYMENT_NOT_ALLOWED' });

          const isNeg = balBefore > 0n && seededNextInt(rng, 2) === 0;
          const delta = isNeg
            ? -(BigInt(seededNextInt(rng, Number(balBefore))) + 1n)
            : BigInt(seededNextInt(rng, 15_000) + 1);
          await env.customerStore.recordDebtAdjustment({
            customerId: cid,
            actorUserId: env.ownerId,
            clientRequestId: env.nextUuid(),
            amountDelta: moneyFromTiyin(delta),
            reason: isNeg ? 'Kechirish' : 'Qoshimcha',
            dueDays: !isNeg && seededNextInt(rng, 2) === 0 ? 1 : null,
          });
          syncLatestCustomerLedgerEntryToModel(cid);
        } else if (action < 90) {
          // Return on an eligible non-voided sale
          const eligible = salesList.find(
            (s) => !s.voided && s.soldMilli - s.returnedMilli >= 1_000n,
          );
          if (eligible) {
            const remMilli = eligible.soldMilli - eligible.returnedMilli;
            const retMilli = remMilli > 1_000n ? 1_000n : remMilli;
            const refundTotal = (retMilli / 1_000n) * eligible.unitPrice;
            const curDet = await env.customerStore.getCustomerDetail(eligible.customerId);
            const curFifo = allocateCustomerLedgerFifo({
              entries: modelEntries.get(eligible.customerId)!,
              asOfMs: unixMsFromBigInt(env.clock.now()),
              storeTimezone: 'Asia/Tashkent',
            });
            const saleOb = curFifo.bySaleId.get(eligible.saleId);
            const remDebt = saleOb ? moneyToTiyin(saleOb.remainingDebt) : 0n;
            const paidCashCap =
              eligible.origCash +
              (saleOb ? moneyToTiyin(saleOb.fifoPaidByMethod.cash) : 0n) -
              eligible.priorRetCash;
            const paidCardCap =
              eligible.origCard +
              (saleOb ? moneyToTiyin(saleOb.fifoPaidByMethod.card) : 0n) -
              eligible.priorRetCard;

            const offset = refundTotal <= remDebt ? refundTotal : remDebt;
            let needPay = refundTotal - offset;
            const useCash =
              needPay <= paidCashCap && needPay <= expectedDrawerCash
                ? needPay
                : paidCashCap < expectedDrawerCash
                  ? paidCashCap < needPay
                    ? paidCashCap
                    : needPay
                  : expectedDrawerCash;
            needPay -= useCash;
            const useCard = needPay <= paidCardCap ? needPay : 0n;
            if (offset + useCash + useCard === refundTotal && curDet.customer.balance >= 0n) {
              const rPay: (
                { method: 'cash'; amount: Money } | { method: 'card'; amount: Money }
              )[] = [];
              if (useCash > 0n) rPay.push({ method: 'cash', amount: moneyFromTiyin(useCash) });
              if (useCard > 0n) rPay.push({ method: 'card', amount: moneyFromTiyin(useCard) });
              await env.returnStore.createReturn({
                saleId: eligible.saleId,
                actorUserId: env.managerId,
                reason: 'Model return',
                clientRequestId: env.nextUuid(),
                items: [{ saleLineId: eligible.lineId, qty: quantityFromMilli(retMilli) }],
                debtOffsetAmount: moneyFromTiyin(offset),
                payments: rPay,
              });
              eligible.returnedMilli += retMilli;
              eligible.priorRetCash += useCash;
              eligible.priorRetCard += useCard;
              expectedDrawerCash -= useCash;
              syncLatestCustomerLedgerEntryToModel(eligible.customerId);
            }
          }
        } else {
          // Attempt void on unreturned same-day sale
          const todayKey = new Date(Number(env.clock.now()) + 5 * 3600_000)
            .toISOString()
            .slice(0, 10);
          const candidate = salesList.find(
            (s) => !s.voided && s.returnedMilli === 0n && s.createdDay === todayKey,
          );
          if (candidate && expectedDrawerCash >= candidate.origCash) {
            const curFifo = allocateCustomerLedgerFifo({
              entries: modelEntries.get(candidate.customerId)!,
              asOfMs: unixMsFromBigInt(env.clock.now()),
              storeTimezone: 'Asia/Tashkent',
            });
            const ob = curFifo.bySaleId.get(candidate.saleId);
            const hasPaidOrWaived =
              ob !== undefined &&
              (moneyToTiyin(ob.fifoPaidTotal) > 0n || moneyToTiyin(ob.fifoWaivedTotal) > 0n);

            if (hasPaidOrWaived) {
              await expect(
                env.returnStore.voidSale({
                  saleId: candidate.saleId,
                  actorUserId: env.managerId,
                  reason: 'Paid debt void blocked',
                  clientRequestId: env.nextUuid(),
                }),
              ).rejects.toMatchObject({ code: 'SALE_DEBT_HAS_PAYMENTS' });
            } else {
              await env.returnStore.voidSale({
                saleId: candidate.saleId,
                actorUserId: env.managerId,
                reason: 'Model clean void',
                clientRequestId: env.nextUuid(),
              });
              candidate.voided = true;
              expectedDrawerCash -= candidate.origCash;
              syncLatestCustomerLedgerEntryToModel(candidate.customerId);
            }
          }
        }

        await assertModelParity();
      }

      expect(stepCount).toBe(60);

      // Corrupt derived projections intentionally and verify rebuildCustomerBalances + rebuildCustomerSearchIndex emit 0 outbox events and restore parity
      const outboxBefore = listAllOutboxRecordsSync(env.connection.db).length;
      env.connection.sqlite
        .prepare(
          'UPDATE "local_customer_balances" SET "balance" = 9999999, "total_debt_accrued" = 0',
        )
        .run();
      await env.customerStore.rebuildCustomerBalances();
      await env.customerStore.rebuildCustomerSearchIndex();
      expect(listAllOutboxRecordsSync(env.connection.db)).toHaveLength(outboxBefore);
      await assertModelParity();
    } finally {
      env.connection.close();
    }
  }, 20_000);
});
