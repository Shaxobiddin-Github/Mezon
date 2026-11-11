import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import {
  type PinHasher,
  type UuidV7,
  ZERO_MONEY,
  epochDaysFromCivilDate,
  moneyFromTiyin,
  parseUuidV7,
  quantityFromMilli,
} from '@mezon/domain';
import { FixedClock, SeededRandomSource } from '@mezon/test-utils';
import { afterEach, describe, expect, it } from 'vitest';
import {
  type LocalSqliteConnection,
  createSqliteCatalogStore,
  createSqliteHubAuthStore,
  createSqliteShiftStore,
  createSqliteSupplierStore,
  goodsReceivingLines,
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

function makeTempDbPath(name = 'supplier-perf.db'): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mezon-t18-sup-perf-'));
  tempDirs.push(dir);
  return path.join(dir, name);
}

function makeUuidFromIndex(prefix: number, index: number): UuidV7 {
  return parseUuidV7(
    `0198${prefix.toString(16).padStart(4, '0')}-0000-7000-8000-${index.toString(16).padStart(12, '0')}`,
  );
}

afterEach(() => {
  while (openConnections.length > 0) {
    const conn = openConnections.pop()!;
    try {
      conn.close();
    } catch {
      // ignore already closed handles
    }
  }
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 });
  }
});

async function setupSupplierPerfEnv(seed: number) {
  const dbPath = makeTempDbPath();
  const clock = new FixedClock(DAY1_1000_MS);
  const random = new SeededRandomSource(seed);
  const connection = openLocalSqliteDatabase(dbPath);
  openConnections.push(connection);
  migrateLocalDatabase(connection.db);

  const authStore = await createSqliteHubAuthStore({ connection, clock, random });
  const setup = await authStore.completeSetup({
    fullName: 'Owner',
    username: 'owner18',
    pinHash: await FAST_TEST_HASHER.hash('849201'),
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
  const supplierStore = createSqliteSupplierStore({ connection, getRuntimeContext: getStoreCtx });
  const shiftStore = createSqliteShiftStore({ connection, getRuntimeContext: getStoreCtx });
  await shiftStore.openShift({
    actorUserId: setup.owner.id,
    clientRequestId: makeUuidFromIndex(0x00bb, 999999),
    openingCash: ZERO_MONEY,
  });

  let reqSeq = 1;
  const nextUuid = () => {
    reqSeq += 1;
    return makeUuidFromIndex(0x00bb, reqSeq);
  };

  return {
    connection,
    catalogStore,
    supplierStore,
    ownerId: setup.owner.id,
    nextUuid,
  };
}

describe('@mezon/db-local [PERF] - T1.8 Supplier 100-line receiving WAL benchmark', () => {
  it('meets <= 500 ms performance target for posting a 100-line receiving on file-backed WAL SQLite', async () => {
    const env = await setupSupplierPerfEnv(777);
    const sup = await env.supplierStore.createSupplier({ name: 'Perf 100-Line Wholesale' });

    const productIds: UuidV7[] = [];
    for (let i = 0; i < 100; i += 1) {
      const p = await env.catalogStore.createProduct({
        name: `Perf Tovar ${i + 1}`,
        unit: i % 3 === 0 ? 'kg' : 'dona',
        trackBatches: i % 2 === 0,
        salePrice: '25000',
        vatRateBp: 1200,
        actorUserId: env.ownerId,
      });
      productIds.push(p.product.id);
    }

    const draft = await env.supplierStore.createReceivingDraft({
      supplierId: sup.id,
      actorUserId: env.ownerId,
      supplierInvoiceNo: 'PERF-100',
      lines: productIds.map((pid, idx) => ({
        productId: pid,
        qty: quantityFromMilli(idx % 3 === 0 ? 5_500n : 10_000n),
        costUnknown: idx % 10 === 0,
        totalCostValue: idx % 10 === 0 ? null : moneyFromTiyin(BigInt(50_000 + idx * 100)),
        batchNumber: idx % 2 === 0 ? `B-${idx}` : null,
      })),
    });

    const reqId = env.nextUuid();
    const startMs = performance.now();
    const posted = await env.supplierStore.postReceiving(draft.id, {
      actorUserId: env.ownerId,
      clientRequestId: reqId,
    });
    const elapsedMs = performance.now() - startMs;

    console.info(`[PERF T1.8 100-line receiving]: ${elapsedMs.toFixed(2)} ms`);
    expect(posted.receiving.lines).toHaveLength(100);
    expect(env.connection.db.select().from(goodsReceivingLines).all()).toHaveLength(100);
    expect(elapsedMs).toBeLessThanOrEqual(500);
  });
});
