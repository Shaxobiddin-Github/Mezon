import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import {
  type PinHasher,
  type UuidV7,
  createHlcTimestamp,
  epochDaysFromCivilDate,
  moneyFromTiyin,
  moneyToTiyin,
  parseUuidV7,
  serializeHlc,
} from '@mezon/domain';
import { FixedClock, SeededRandomSource } from '@mezon/test-utils';
import { afterEach, describe, expect, it } from 'vitest';
import {
  type LocalSqliteConnection,
  createSqliteCatalogStore,
  createSqliteHubAuthStore,
  createSqliteShiftStore,
  migrateLocalDatabase,
  openLocalSqliteDatabase,
} from './index.js';

const FAST_TEST_HASHER: PinHasher = {
  hash: (pin) => Promise.resolve(`fast-hash:${pin}`),
  verify: (hash, pin) => Promise.resolve(hash === `fast-hash:${pin}`),
};

const tempDirs: string[] = [];
const openConnections: LocalSqliteConnection[] = [];
const DAY1_1000_MS = epochDaysFromCivilDate('2026-11-10') * 86_400_000n + 5n * 3_600_000n;

function makeTempDbPath(name = 'shift-perf.db'): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mezon-t19-shift-perf-'));
  tempDirs.push(dir);
  return path.join(dir, name);
}

function makeUuid(prefix: number, index: number): UuidV7 {
  return parseUuidV7(
    `0199${prefix.toString(16).padStart(4, '0')}-0000-7000-8000-${index.toString(16).padStart(12, '0')}`,
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

async function setupShiftPerfEnv(seed: number) {
  const dbPath = makeTempDbPath();
  const clock = new FixedClock(DAY1_1000_MS);
  const random = new SeededRandomSource(seed);
  const connection = openLocalSqliteDatabase(dbPath);
  openConnections.push(connection);
  migrateLocalDatabase(connection.db);

  const authStore = await createSqliteHubAuthStore({ connection, clock, random });
  const setup = await authStore.completeSetup({
    fullName: 'Owner',
    username: 'owner19',
    pinHash: await FAST_TEST_HASHER.hash('849201'),
  });
  const cashierA = await authStore.createUser({
    fullName: 'Cashier A',
    username: 'cash19a',
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
  const shiftStore = createSqliteShiftStore({ connection, getRuntimeContext: getStoreCtx });

  let seq = 1;
  const nextUuid = () => makeUuid(0x019a, seq++);

  return {
    clock,
    connection,
    authStore,
    catalogStore,
    shiftStore,
    ownerId: setup.owner.id,
    cashierAId: cashierA.id,
    nextUuid,
  };
}

describe('@mezon/db-local [PERF] - T1.9 Shift close 1,000-receipt WAL benchmark', () => {
  it('performance benchmark: closes a 1,000-receipt shift (+50 returns +1,050 cash moves) <= 500 ms on disk WAL SQLite', async () => {
    const env = await setupShiftPerfEnv(999);
    const sh = await env.shiftStore.openShift({
      actorUserId: env.cashierAId,
      clientRequestId: env.nextUuid(),
      openingCash: moneyFromTiyin(1_000_000n),
    });
    const sessId = sh.shift.activeCashierSession!.id;
    const prod = await env.catalogStore.createProduct({
      name: 'Perf Unit',
      unit: 'dona',
      unlimited: true,
      salePrice: '10000',
      vatRateBp: 0,
      actorUserId: env.ownerId,
    });
    const ctx = env.authStore.getActiveRuntimeContext()!;
    const nowMs = env.clock.now();
    const hlc = serializeHlc(createHlcTimestamp(nowMs, 1, ctx.config.deviceId));

    const insertSale = env.connection.sqlite.prepare(
      `INSERT INTO "sales" ("id","organization_id","store_id","device_id","hlc","created_at_ms","updated_at_ms","receipt_no","receipt_code","cashier_user_id","completed_by_user_id","shift_id","shift_cashier_session_id","client_request_id","request_hash","subtotal_gross","total_promo_discount","subtotal_after_promo","manual_discount_mode","manual_discount_value","order_discount_amount","total_final","total_net_ex_vat","total_vat","total_paid","debt_amount","change_amount")
       VALUES (?,?,?,?,?,?,?,?,'0001-PERF',?,?,?,?,?, 'perf-hash', 20000,0,20000,'none',0,0,20000,20000,0,20000,0,0)`,
    );
    const insertLine = env.connection.sqlite.prepare(
      `INSERT INTO "sale_lines" ("id","organization_id","store_id","device_id","hlc","created_at_ms","sale_id","sort_order","line_kind","product_id","item_name","unit","qty","unit_price_snapshot","gross_total","promo_discount","subtotal_after_promo","allocated_order_discount","final_total","vat_rate_bp_snapshot","net_ex_vat","vat_total","cost_value")
       VALUES (?,?,?,?,?,?,?,0,'catalog',?,'Perf Item','dona',2000,10000,20000,0,20000,0,20000,0,20000,0,0)`,
    );
    const insertPay = env.connection.sqlite.prepare(
      `INSERT INTO "payments" ("id","organization_id","store_id","device_id","hlc","created_at_ms","sale_id","method","amount","tendered_amount","change_amount")
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    );
    const insertMove = env.connection.sqlite.prepare(
      `INSERT INTO "cash_moves" ("id","organization_id","store_id","device_id","hlc","created_at_ms","shift_id","shift_cashier_session_id","type","amount_delta","source_type","source_id","created_by_user_id")
       VALUES (?,?,?,?,?,?,?,?,'sale_cash_in',10000,'sale',?,?)`,
    );
    const insertRet = env.connection.sqlite.prepare(
      `INSERT INTO "returns" ("id","organization_id","store_id","device_id","hlc","created_at_ms","sale_id","shift_id","shift_cashier_session_id","return_no","return_code","processed_by_user_id","reason","client_request_id","request_hash","total_refund","total_net_ex_vat","total_vat","cash_refund_amount","non_cash_refund_amount","debt_offset_amount")
       VALUES (?,?,?,?,?,?,?, ?,?, ?, 'RET-PERF', ?, 'Perf ret', ?, 'perf-ret', 5000, 5000, 0, 5000, 0, 0)`,
    );
    const insertRetPay = env.connection.sqlite.prepare(
      `INSERT INTO "return_payments" ("id","organization_id","store_id","device_id","hlc","created_at_ms","return_id","sale_id","method","amount")
       VALUES (?,?,?,?,?,?,?,?,'cash',5000)`,
    );
    const insertRetMove = env.connection.sqlite.prepare(
      `INSERT INTO "cash_moves" ("id","organization_id","store_id","device_id","hlc","created_at_ms","shift_id","shift_cashier_session_id","type","amount_delta","source_type","source_id","created_by_user_id")
       VALUES (?,?,?,?,?,?,?,?,'refund_cash_out',-5000,'return',?,?)`,
    );

    const runBulk = env.connection.sqlite.transaction(() => {
      for (let i = 1; i <= 1000; i += 1) {
        const sId = makeUuid(0x019f, i);
        const lId = makeUuid(0x019e, i);
        insertSale.run(
          sId,
          ctx.config.organizationId,
          ctx.config.storeId,
          ctx.config.deviceId,
          hlc,
          nowMs,
          nowMs,
          BigInt(i),
          env.cashierAId,
          env.cashierAId,
          sh.shift.id,
          sessId,
          makeUuid(0x019d, i),
        );
        insertLine.run(
          lId,
          ctx.config.organizationId,
          ctx.config.storeId,
          ctx.config.deviceId,
          hlc,
          nowMs,
          sId,
          prod.product.id,
        );
        insertPay.run(
          makeUuid(0x019c, i * 2),
          ctx.config.organizationId,
          ctx.config.storeId,
          ctx.config.deviceId,
          hlc,
          nowMs,
          sId,
          'cash',
          10_000n,
          10_000n,
          0n,
        );
        insertPay.run(
          makeUuid(0x019c, i * 2 + 1),
          ctx.config.organizationId,
          ctx.config.storeId,
          ctx.config.deviceId,
          hlc,
          nowMs,
          sId,
          i % 2 === 0 ? 'card' : 'payme',
          10_000n,
          null,
          0n,
        );
        insertMove.run(
          makeUuid(0x019b, i),
          ctx.config.organizationId,
          ctx.config.storeId,
          ctx.config.deviceId,
          hlc,
          nowMs,
          sh.shift.id,
          sessId,
          sId,
          env.cashierAId,
        );
        if (i <= 50) {
          const rId = makeUuid(0x0199, i);
          insertRet.run(
            rId,
            ctx.config.organizationId,
            ctx.config.storeId,
            ctx.config.deviceId,
            hlc,
            nowMs,
            sId,
            sh.shift.id,
            sessId,
            BigInt(i),
            env.cashierAId,
            makeUuid(0x0198, i),
          );
          insertRetPay.run(
            makeUuid(0x0197, i),
            ctx.config.organizationId,
            ctx.config.storeId,
            ctx.config.deviceId,
            hlc,
            nowMs,
            rId,
            sId,
          );
          insertRetMove.run(
            makeUuid(0x0196, i),
            ctx.config.organizationId,
            ctx.config.storeId,
            ctx.config.deviceId,
            hlc,
            nowMs,
            sh.shift.id,
            sessId,
            rId,
            env.cashierAId,
          );
        }
      }
    });
    runBulk();

    const t0 = performance.now();
    const closed = await env.shiftStore.closeShift({
      shiftId: sh.shift.id,
      actorUserId: env.cashierAId,
      clientRequestId: env.nextUuid(),
      countedCash: moneyFromTiyin(10_750_000n),
    });
    const elapsedMs = performance.now() - t0;

    console.info(
      `[PERF T1.9 db-local] 1,000-receipt shift closeShift elapsed=${elapsedMs.toFixed(2)} ms`,
    );
    expect(closed.closure.salesCount).toBe(1000);
    expect(closed.closure.returnsCount).toBe(50);
    expect(moneyToTiyin(closed.closure.grossSalesTotal)).toBe(20_000_000n);
    expect(moneyToTiyin(closed.closure.returnsTotal)).toBe(250_000n);
    expect(moneyToTiyin(closed.closure.expectedCash)).toBe(10_750_000n);
    expect(elapsedMs).toBeLessThanOrEqual(500);
  }, 20_000);
});
