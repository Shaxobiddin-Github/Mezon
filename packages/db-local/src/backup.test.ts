import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  type PinHasher,
  type UuidV7,
  epochDaysFromCivilDate,
  moneyFromTiyin,
  parseUuidV7,
  quantityFromMilli,
} from '@mezon/domain';
import { FixedClock, SeededRandomSource } from '@mezon/test-utils';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import {
  type LocalSqliteConnection,
  SqliteBackupService,
  createSqliteCartStore,
  createSqliteCatalogStore,
  createSqliteHubAuthStore,
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

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mezon-t13-backup-'));
  tempDirs.push(dir);
  return dir;
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

let uuidCounter = 1;
function nextUuid(): UuidV7 {
  const hex = (uuidCounter++).toString(16).padStart(12, '0');
  return parseUuidV7(`01950000-0000-7000-8000-${hex}`);
}

const DAY1_1000_MS = epochDaysFromCivilDate('2026-11-10') * 86_400_000n + 5n * 3_600_000n;

async function setupBackupEnv(options?: { readonly initialMs?: bigint }) {
  const dir = makeTempDir();
  const dbPath = path.join(dir, 'live-hub.db');
  const backupDir = path.join(dir, 'backups');

  const clock = new FixedClock(options?.initialMs ?? DAY1_1000_MS);
  const random = new SeededRandomSource(102);
  const connection = openLocalSqliteDatabase(dbPath);
  openConnections.push(connection);
  migrateLocalDatabase(connection.db);

  const authStore = await createSqliteHubAuthStore({ connection, clock, random });
  const setup = await authStore.completeSetup({
    fullName: 'Owner',
    username: 'owner',
    pinHash: await FAST_TEST_HASHER.hash('123456'),
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
  const stockStore = createSqliteStockStore({
    connection,
    getRuntimeContext: getStoreCtx,
  });
  const cartStore = createSqliteCartStore({
    connection,
    getRuntimeContext: getStoreCtx,
  });
  const saleStore = createSqliteSaleStore({
    connection,
    getRuntimeContext: getStoreCtx,
  });
  const shiftStore = createSqliteShiftStore({
    connection,
    getRuntimeContext: getStoreCtx,
  });

  const backupService = new SqliteBackupService({
    connection,
    dbPath,
    backupDir,
  });

  return {
    dir,
    dbPath,
    backupDir,
    connection,
    clock,
    random,
    authStore,
    catalogStore,
    stockStore,
    cartStore,
    saleStore,
    shiftStore,
    backupService,
    ownerId: setup.owner.id,
  };
}

describe('T1.13: SqliteBackupService & R2/R3 Restore Lifecycle', () => {
  it('creates WAL-safe online backup with SHA-256 and PRAGMA integrity verification', async () => {
    const env = await setupBackupEnv();

    const p = (
      await env.catalogStore.createProduct({
        actorUserId: env.ownerId,
        name: 'Olma 1kg',
        unit: 'kg',
        salePrice: '1500000',
        vatRateBp: 0,
      })
    ).product;

    await env.stockStore.recordInboundMove({
      productId: p.id,
      qty: '100000',
      totalCostValue: '100000000',
      reason: 'purchase',
      actorUserId: env.ownerId,
    });

    const meta = await env.backupService.createBackup({
      reason: 'Automated shift close backup',
      actorUserId: env.ownerId,
    });

    expect(meta.id).toMatch(/^backup-\d+-[a-z0-9]+$/);
    expect(meta.filename).toBe(`${meta.id}.db`);
    expect(meta.sizeBytes).toBeGreaterThan(0);
    expect(meta.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(meta.reason).toBe('Automated shift close backup');

    const backupFilePath = path.join(env.backupDir, meta.filename);
    const metaFilePath = path.join(env.backupDir, `${meta.id}.meta.json`);
    expect(fs.existsSync(backupFilePath)).toBe(true);
    expect(fs.existsSync(metaFilePath)).toBe(true);

    // Verify backup DB opens cleanly and integrity_check is ok
    const db = new Database(backupFilePath, { readonly: true });
    try {
      const integrity = db.pragma('integrity_check', { simple: true });
      expect(integrity).toBe('ok');
    } finally {
      db.close();
    }
  });

  it('rotates backups keeping the newest 10 backups and unlinking older files', async () => {
    const env = await setupBackupEnv();

    // Create 12 backups sequentially
    for (let i = 1; i <= 12; i++) {
      env.clock.advance(10_000n);
      await env.backupService.createBackup({ reason: `Backup #${i}` });
    }

    const list = env.backupService.listBackups();
    expect(list.length).toBe(10);

    const filesInDir = fs.readdirSync(env.backupDir);
    const dbFiles = filesInDir.filter((f) => f.endsWith('.db'));
    const metaFiles = filesInDir.filter((f) => f.endsWith('.meta.json'));

    expect(dbFiles.length).toBe(10);
    expect(metaFiles.length).toBe(10);

    // Newest backup should be #12, oldest kept should be #3
    expect(list[0].reason).toBe('Backup #12');
    expect(list[9].reason).toBe('Backup #3');
  });

  it('R2: stageRestore rejects with 409 if active shift or active cart exists', async () => {
    const env = await setupBackupEnv();
    const backup = await env.backupService.createBackup({ reason: 'Pre-shift backup' });

    // 1. Open shift -> stageRestore MUST reject with SHIFT_ALREADY_OPEN (409)
    const shift1 = await env.shiftStore.openShift({
      actorUserId: env.ownerId,
      clientRequestId: nextUuid(),
      openingCash: moneyFromTiyin(10_000_00n),
    });

    await expect(
      Promise.resolve().then(() =>
        env.backupService.stageRestore({
          backupId: backup.id,
          actorUserId: env.ownerId,
        }),
      ),
    ).rejects.toMatchObject({ code: 'SHIFT_ALREADY_OPEN' });

    // Close shift
    await env.shiftStore.closeShift({
      shiftId: shift1.shift.id,
      actorUserId: env.ownerId,
      clientRequestId: nextUuid(),
      countedCash: moneyFromTiyin(10_000_00n),
    });

    // 2. Open active cart -> stageRestore MUST reject with CART_NOT_OPEN (409)
    const cart = await env.cartStore.openCart(env.ownerId);

    await expect(
      Promise.resolve().then(() =>
        env.backupService.stageRestore({
          backupId: backup.id,
          actorUserId: env.ownerId,
        }),
      ),
    ).rejects.toMatchObject({ code: 'CART_NOT_OPEN' });

    // Cancel/clear cart
    await env.cartStore.deleteCart(cart.id);

    // 3. Now stageRestore succeeds cleanly!
    const staged = env.backupService.stageRestore({
      backupId: backup.id,
      actorUserId: env.ownerId,
    });
    expect(staged.staged).toBe(true);
    expect(fs.existsSync(staged.stagingFile)).toBe(true);
  });

  it('R2 + R3 Model Test: restores DB state while sequence counters advance monotonically', async () => {
    const env = await setupBackupEnv();

    // 1. Seed product & stock
    const p = (
      await env.catalogStore.createProduct({
        actorUserId: env.ownerId,
        name: 'Choy Samarqand',
        unit: 'dona',
        salePrice: '1000000',
        vatRateBp: 0,
      })
    ).product;

    await env.stockStore.recordInboundMove({
      productId: p.id,
      qty: '100000',
      totalCostValue: '50000000',
      reason: 'purchase',
      actorUserId: env.ownerId,
    });

    // 2. Open shift & perform 2 sales
    const shiftA = await env.shiftStore.openShift({
      actorUserId: env.ownerId,
      clientRequestId: nextUuid(),
      openingCash: moneyFromTiyin(100_000_00n),
    });

    for (let i = 1; i <= 2; i++) {
      const cart = await env.cartStore.openCart(env.ownerId);
      await env.cartStore.addLine(cart.id, {
        kind: 'catalog',
        productId: p.id,
        variantId: null,
        qty: quantityFromMilli(1_000n),
      });
      await env.saleStore.completeSale({
        cartId: cart.id,
        actorUserId: env.ownerId,
        clientRequestId: nextUuid(),
        expectedTotal: moneyFromTiyin(10_000_00n),
        payments: [{ method: 'cash', tenderedAmount: moneyFromTiyin(10_000_00n) }],
      });
    }

    // Close shift so DB has a clean checkpoint
    await env.shiftStore.closeShift({
      shiftId: shiftA.shift.id,
      actorUserId: env.ownerId,
      clientRequestId: nextUuid(),
      countedCash: moneyFromTiyin(120_000_00n),
    });

    // 3. Take backup after 2 sales (checkpoint A)
    const backupA = await env.backupService.createBackup({ reason: 'Checkpoint A (2 sales)' });

    // 4. Open shift & perform 3 MORE sales (total 5 sales)
    const shiftB = await env.shiftStore.openShift({
      actorUserId: env.ownerId,
      clientRequestId: nextUuid(),
      openingCash: moneyFromTiyin(120_000_00n),
    });

    for (let i = 3; i <= 5; i++) {
      const cart = await env.cartStore.openCart(env.ownerId);
      await env.cartStore.addLine(cart.id, {
        kind: 'catalog',
        productId: p.id,
        variantId: null,
        qty: quantityFromMilli(1_000n),
      });
      await env.saleStore.completeSale({
        cartId: cart.id,
        actorUserId: env.ownerId,
        clientRequestId: nextUuid(),
        expectedTotal: moneyFromTiyin(10_000_00n),
        payments: [{ method: 'cash', tenderedAmount: moneyFromTiyin(10_000_00n) }],
      });
    }

    // Close shift
    await env.shiftStore.closeShift({
      shiftId: shiftB.shift.id,
      actorUserId: env.ownerId,
      clientRequestId: nextUuid(),
      countedCash: moneyFromTiyin(150_000_00n),
    });

    // Live DB currently has receipt_seq = 5
    const stateBefore = env.connection.sqlite
      .prepare<[], { last_receipt_seq: unknown; last_device_seq: unknown }>(
        'SELECT last_receipt_seq, last_device_seq FROM local_device_state LIMIT 1',
      )
      .get()!;
    expect(Number(stateBefore.last_receipt_seq)).toBe(5);

    // 5. Stage restore to Checkpoint A (which only had 2 sales)
    env.backupService.stageRestore({
      backupId: backupA.id,
      actorUserId: env.ownerId,
    });

    // Close active connection before file replacement (simulates hub restart)
    env.connection.close();
    openConnections.length = 0;

    // 6. Execute staged restore via hub startup lifecycle
    const restored = SqliteBackupService.executeStagedRestoreIfPending({
      dbPath: env.dbPath,
      backupDir: env.backupDir,
    });
    expect(restored).toBe(true);
    expect(fs.existsSync(path.join(env.backupDir, 'pending-restore.json'))).toBe(false);

    // 7. Re-open DB and verify:
    // - Only 2 sales exist in the restored DB
    // - BUT R3 invariant holds: last_receipt_seq is max(2, 5) = 5!
    const reconnected = openLocalSqliteDatabase(env.dbPath);
    openConnections.push(reconnected);

    const salesCountRow = reconnected.sqlite
      .prepare<[], { count: unknown }>('SELECT COUNT(*) as count FROM sales')
      .get()!;
    expect(Number(salesCountRow.count)).toBe(2);

    const stateAfter = reconnected.sqlite
      .prepare<[], { last_receipt_seq: unknown; last_device_seq: unknown }>(
        'SELECT last_receipt_seq, last_device_seq FROM local_device_state LIMIT 1',
      )
      .get()!;

    expect(Number(stateAfter.last_receipt_seq)).toBe(5);
    expect(BigInt(stateAfter.last_device_seq as string | number)).toBeGreaterThanOrEqual(
      BigInt(stateBefore.last_device_seq as string | number),
    );

    // 8. Next sale generates receipt #6 (never rewinds or collides with #3, #4, #5)
    const reAuth = await createSqliteHubAuthStore({
      connection: reconnected,
      clock: env.clock,
      random: env.random,
    });
    const getStoreCtx = () => {
      const ctx = reAuth.getActiveRuntimeContext();
      return ctx
        ? { uow: ctx.uow, organizationId: ctx.config.organizationId, storeId: ctx.config.storeId }
        : null;
    };

    const reShiftStore = createSqliteShiftStore({
      connection: reconnected,
      getRuntimeContext: getStoreCtx,
    });
    const reCartStore = createSqliteCartStore({
      connection: reconnected,
      getRuntimeContext: getStoreCtx,
    });
    const reSaleStore = createSqliteSaleStore({
      connection: reconnected,
      getRuntimeContext: getStoreCtx,
    });

    await reShiftStore.openShift({
      actorUserId: env.ownerId,
      clientRequestId: nextUuid(),
      openingCash: moneyFromTiyin(120_000_00n),
    });

    const nextCart = await reCartStore.openCart(env.ownerId);
    await reCartStore.addLine(nextCart.id, {
      kind: 'catalog',
      productId: p.id,
      variantId: null,
      qty: quantityFromMilli(1_000n),
    });
    const nextSale = await reSaleStore.completeSale({
      cartId: nextCart.id,
      actorUserId: env.ownerId,
      clientRequestId: nextUuid(),
      expectedTotal: moneyFromTiyin(10_000_00n),
      payments: [{ method: 'cash', tenderedAmount: moneyFromTiyin(10_000_00n) }],
    });

    expect(nextSale.sale.receiptNo).toBe(6n);
  });
});
