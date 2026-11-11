import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import {
  type PinHasher,
  type UuidV7,
  ZERO_MONEY,
  computeDebtDueAtMs,
  epochDaysFromCivilDate,
  moneyFromTiyin,
  moneyToTiyin,
  parseUuidV7,
  quantityFromMilli,
  unixMsFromBigInt,
} from '@mezon/domain';
import { FixedClock, SeededRandomSource } from '@mezon/test-utils';
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
  migrateLocalDatabase,
  openLocalSqliteDatabase,
} from './index.js';

const FAST_TEST_HASHER: PinHasher = {
  hash: (pin) => Promise.resolve(`fast-hash:${pin}`),
  verify: (hash, pin) => Promise.resolve(hash === `fast-hash:${pin}`),
};

const tempDirs: string[] = [];
const openConnections: LocalSqliteConnection[] = [];
const DAY1_1000_MS = epochDaysFromCivilDate('2026-06-01') * 86_400_000n + 5n * 3_600_000n;

function makeTempDbPath(name = 'customer-perf.db'): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mezon-t17-cust-perf-'));
  tempDirs.push(dir);
  return path.join(dir, name);
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

async function setupCustomerPerfEnv(seed: number) {
  const dbPath = makeTempDbPath();
  const clock = new FixedClock(DAY1_1000_MS);
  const random = new SeededRandomSource(seed);
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
  await shiftStore.openShift({
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
    clock,
    connection,
    catalogStore,
    stockStore,
    cartStore,
    saleStore,
    returnStore,
    customerStore,
    ownerId: setup.owner.id,
    managerId: manager.id,
    cashierId: cashier.id,
    organizationId: setup.organizationId,
    storeId: setup.storeId,
    deviceId: setup.deviceId,
    nextUuid,
  };
}

describe('@mezon/db-local [PERF] - T1.7 Customer D4 & 10k/100k benchmarks', () => {
  it('D4 perf benchmark: single customer with 5,000 mixed ledger entries runs getCustomerDetail & createReturn <= 100ms', async () => {
    const env = await setupCustomerPerfEnv(444);
    try {
      const cust = await env.customerStore.createCustomer({
        fullName: 'Heavy Debtor',
        phone: '+998909998877',
        defaultDueDays: 7,
      });

      const prod = await env.catalogStore.createProduct({
        name: 'Heavy Item',
        unit: 'dona',
        trackBatches: false,
        salePrice: '10000',
        vatRateBp: 0,
        actorUserId: env.ownerId,
      });
      await env.stockStore.recordInboundMove({
        productId: prod.product.id,
        reason: 'purchase',
        qty: '100000',
        totalCostValue: '500000',
        actorUserId: env.ownerId,
      });

      const seedTx = env.connection.sqlite.transaction(() => {
        const insertSale = env.connection.sqlite.prepare(
          `INSERT INTO "sales" ("id", "organization_id", "store_id", "device_id", "hlc", "created_at_ms", "updated_at_ms", "receipt_no", "receipt_code", "source_cart_id", "cashier_user_id", "completed_by_user_id", "customer_id", "shift_id", "client_request_id", "request_hash", "subtotal_gross", "total_promo_discount", "subtotal_after_promo", "manual_discount_mode", "manual_discount_value", "manual_discount_reason", "order_discount_amount", "total_final", "total_net_ex_vat", "total_vat", "total_paid", "debt_amount", "change_amount", "override_approved_by_user_id", "override_approved_amount", "override_approved_at_ms", "voided_at_ms", "voided_by_user_id", "void_reason", "void_client_request_id", "void_request_hash")
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, NULL, ?, 'seedhash', 10000, 0, 10000, 'none', 0, NULL, 0, 10000, 10000, 0, 0, 10000, 0, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL)`,
        );
        const insertLedger = env.connection.sqlite.prepare(
          `INSERT INTO "customer_ledger" ("id", "organization_id", "store_id", "device_id", "hlc", "created_at_ms", "customer_id", "entry_type", "amount_delta", "source_type", "source_id", "sale_id", "payment_method", "provider_ref", "cash_move_id", "due_at_ms", "reason", "created_by_user_id", "override_approved_by_user_id", "client_request_id", "request_hash")
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, NULL, NULL, NULL)`,
        );

        const baseT = BigInt(DAY1_1000_MS) - 10_000_000n;
        for (let i = 1; i <= 4_999; i += 1) {
          const t = baseT + BigInt(i * 1_000);
          const hlc = `${t.toString().padStart(15, '0')}:00000:${env.deviceId}`;
          const lid = makeUuidFromIndex(0x00d4, i);

          if (i % 3 === 1) {
            const sid = makeUuidFromIndex(0x00d5, i);
            insertSale.run(
              sid,
              env.organizationId,
              env.storeId,
              env.deviceId,
              hlc,
              t,
              t,
              BigInt(i + 100),
              `S-${i}`,
              env.cashierId,
              env.cashierId,
              cust.id,
              makeUuidFromIndex(0x00d6, i),
            );
            insertLedger.run(
              lid,
              env.organizationId,
              env.storeId,
              env.deviceId,
              hlc,
              t,
              cust.id,
              'sale_debt',
              10_000n,
              'sale',
              sid,
              sid,
              null,
              t + 604_800_000n,
              null,
              env.cashierId,
            );
          } else if (i % 3 === 2) {
            insertLedger.run(
              lid,
              env.organizationId,
              env.storeId,
              env.deviceId,
              hlc,
              t,
              cust.id,
              'debt_payment',
              -8_000n,
              'debt_payment',
              cust.id,
              null,
              'card',
              null,
              null,
              env.cashierId,
            );
          } else {
            insertLedger.run(
              lid,
              env.organizationId,
              env.storeId,
              env.deviceId,
              hlc,
              t,
              cust.id,
              'adjustment',
              -1_000n,
              'adjustment',
              cust.id,
              null,
              null,
              null,
              'Seed partial waiver',
              env.ownerId,
            );
          }
        }
      });
      seedTx();
      await env.customerStore.rebuildCustomerBalances();

      env.clock.set(DAY1_1000_MS + 100_000n);
      const cart = await env.cartStore.openCart(env.cashierId);
      await env.cartStore.addLine(cart.id, {
        kind: 'catalog',
        productId: prod.product.id,
        variantId: null,
        qty: quantityFromMilli(2_000n),
      });
      const targetSale = await env.saleStore.completeSale({
        cartId: cart.id,
        actorUserId: env.cashierId,
        clientRequestId: env.nextUuid(),
        expectedTotal: moneyFromTiyin(20_000n),
        customerId: cust.id,
        debtAmount: moneyFromTiyin(20_000n),
        payments: [],
      });

      const countRow = env.connection.sqlite
        .prepare('SELECT COUNT(*) AS cnt FROM "customer_ledger" WHERE "customer_id" = ?')
        .get(cust.id) as { readonly cnt: bigint };
      expect(countRow.cnt).toBe(5_000n);

      const tDet0 = performance.now();
      const det = await env.customerStore.getCustomerDetail(cust.id);
      const detMs = performance.now() - tDet0;
      expect(det.openObligations.length).toBeGreaterThan(0);

      const tRet0 = performance.now();
      const retRes = await env.returnStore.createReturn({
        saleId: targetSale.sale.id,
        actorUserId: env.managerId,
        reason: 'D4 benchmark return',
        clientRequestId: env.nextUuid(),
        items: [{ saleLineId: targetSale.sale.lines[0].id, qty: quantityFromMilli(2_000n) }],
        debtOffsetAmount: moneyFromTiyin(20_000n),
        payments: [],
      });
      const retMs = performance.now() - tRet0;
      expect(moneyToTiyin(retRes.returnDoc.debtOffsetAmount)).toBe(20_000n);

      console.info(
        `[PERF T1.7 D4] 5,000 entries (1 customer): getCustomerDetail=${detMs.toFixed(2)} ms | createReturn=${retMs.toFixed(2)} ms`,
      );
      expect(detMs).toBeLessThanOrEqual(100);
      expect(retMs).toBeLessThanOrEqual(100);
    } finally {
      env.connection.close();
    }
  }, 30_000);

  it('10,000 customers + 100,000 ledger rows perf benchmark: FTS5 search, phone prefix, overdue list & balance <= 100ms', async () => {
    const env = await setupCustomerPerfEnv(555);
    try {
      const baseT = BigInt(DAY1_1000_MS) - 10_000_000n;
      const pastDue = BigInt(
        computeDebtDueAtMs({
          createdAtMs: unixMsFromBigInt(DAY1_1000_MS - 1_000_000_000n),
          dueDays: 1,
          storeTimezone: 'Asia/Tashkent',
        })!,
      );
      const futureDue = BigInt(
        computeDebtDueAtMs({
          createdAtMs: unixMsFromBigInt(DAY1_1000_MS),
          dueDays: 30,
          storeTimezone: 'Asia/Tashkent',
        })!,
      );
      let targetCustomerId!: UuidV7;
      const seedAll = env.connection.sqlite.transaction(() => {
        const insCust = env.connection.sqlite.prepare(
          `INSERT INTO "customers" ("id", "organization_id", "device_id", "hlc", "created_at_ms", "updated_at_ms", "deleted_at_ms", "full_name", "name_search", "phone_normalized", "phone_digits", "credit_limit", "default_due_days", "note", "is_active")
           VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, NULL, 14, NULL, 1)`,
        );
        const insLed = env.connection.sqlite.prepare(
          `INSERT INTO "customer_ledger" ("id", "organization_id", "store_id", "device_id", "hlc", "created_at_ms", "customer_id", "entry_type", "amount_delta", "source_type", "source_id", "sale_id", "payment_method", "provider_ref", "cash_move_id", "due_at_ms", "reason", "created_by_user_id", "override_approved_by_user_id", "client_request_id", "request_hash")
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, NULL, NULL, ?, ?, ?, NULL, NULL, NULL)`,
        );

        let ledSeq = 1;
        for (let cIdx = 1; cIdx <= 10_000; cIdx += 1) {
          const cid = makeUuidFromIndex(0x0100, cIdx);
          if (cIdx === 5_432) targetCustomerId = cid;
          const t = baseT + BigInt(cIdx);
          const hlcC = `${BigInt(cIdx).toString().padStart(15, '0')}:00000:${env.deviceId}`;
          const phoneDigits = `99890${cIdx.toString().padStart(7, '0')}`;
          const name = cIdx === 5_432 ? 'Abdulloh Mijoz5432' : `Mijoz${cIdx} Aliyev`;
          insCust.run(
            cid,
            env.organizationId,
            env.deviceId,
            hlcC,
            t,
            t,
            name,
            name.toLowerCase(),
            `+${phoneDigits}`,
            phoneDigits,
          );

          const isOverdueCust = cIdx <= 50;
          for (let j = 0; j < 10; j += 1) {
            const lid = makeUuidFromIndex(0x0200, ledSeq);
            const seqBig = BigInt(ledSeq);
            ledSeq += 1;
            const hlcL = `${seqBig.toString().padStart(15, '0')}:00000:${env.deviceId}`;
            if (j === 0) {
              insLed.run(
                lid,
                env.organizationId,
                env.storeId,
                env.deviceId,
                hlcL,
                t + BigInt(j),
                cid,
                'opening_balance',
                20_000n,
                'opening_balance',
                cid,
                null,
                isOverdueCust ? pastDue : futureDue,
                'Seed',
                env.ownerId,
              );
            } else if (j % 2 === 1) {
              insLed.run(
                lid,
                env.organizationId,
                env.storeId,
                env.deviceId,
                hlcL,
                t + BigInt(j),
                cid,
                'debt_payment',
                -2_000n,
                'debt_payment',
                cid,
                'card',
                null,
                null,
                env.cashierId,
              );
            } else {
              insLed.run(
                lid,
                env.organizationId,
                env.storeId,
                env.deviceId,
                hlcL,
                t + BigInt(j),
                cid,
                'adjustment',
                2_000n,
                'adjustment',
                cid,
                null,
                null,
                'Seed adj',
                env.ownerId,
              );
            }
          }
        }
      });
      const tSeed0 = performance.now();
      seedAll();
      await env.customerStore.rebuildCustomerBalances();
      await env.customerStore.rebuildCustomerSearchIndex();
      const seedMs = performance.now() - tSeed0;

      const tFts0 = performance.now();
      const byName = await env.customerStore.listCustomers({ q: 'Абдуллоҳ', limit: 20 });
      const ftsMs = performance.now() - tFts0;
      expect(byName.items.some((c) => c.id === targetCustomerId)).toBe(true);

      const tPhone0 = performance.now();
      const byPhone = await env.customerStore.listCustomers({ q: '900005432', limit: 20 });
      const phoneMs = performance.now() - tPhone0;
      expect(byPhone.items[0]?.id).toBe(targetCustomerId);

      const tBal0 = performance.now();
      const detTarget = await env.customerStore.getCustomerDetail(targetCustomerId);
      const balMs = performance.now() - tBal0;
      expect(moneyToTiyin(detTarget.customer.balance)).toBe(18_000n);

      const tOver0 = performance.now();
      const overdueList = await env.customerStore.listOverdueCustomers({ limit: 50 });
      const overMs = performance.now() - tOver0;
      expect(overdueList.total).toBe(50);

      console.info(
        `[PERF T1.7 10k/100k] seedMs=${seedMs.toFixed(1)} | ftsMs=${ftsMs.toFixed(2)} | phoneMs=${phoneMs.toFixed(2)} | balanceMs=${balMs.toFixed(2)} | overdueMs=${overMs.toFixed(2)}`,
      );
      expect(ftsMs).toBeLessThanOrEqual(100);
      expect(phoneMs).toBeLessThanOrEqual(100);
      expect(balMs).toBeLessThanOrEqual(100);
      expect(overMs).toBeLessThanOrEqual(100);
    } finally {
      env.connection.close();
    }
  }, 30_000);
});
