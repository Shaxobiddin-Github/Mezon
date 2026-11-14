import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
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
  createSqliteCustomerStore,
  createSqliteHubAuthStore,
  createSqliteSaleStore,
  createSqliteShiftStore,
  createSqliteStockStore,
  createSqliteSupplierStore,
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
  const customerStore = createSqliteCustomerStore({
    connection,
    getRuntimeContext: getStoreCtx,
  });
  const supplierStore = createSqliteSupplierStore({
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
    customerStore,
    supplierStore,
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
      .prepare<[], { last_receipt_seq: unknown; last_device_seq: unknown; last_hlc: unknown }>(
        'SELECT last_receipt_seq, last_device_seq, last_hlc FROM local_device_state LIMIT 1',
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
    const restored = await SqliteBackupService.executeStagedRestoreIfPending({
      dbPath: env.dbPath,
      backupDir: env.backupDir,
    });
    expect(restored.wasRestored).toBe(true);
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
      .prepare<[], { last_receipt_seq: unknown; last_device_seq: unknown; last_hlc: unknown }>(
        'SELECT last_receipt_seq, last_device_seq, last_hlc FROM local_device_state LIMIT 1',
      )
      .get()!;

    expect(Number(stateAfter.last_receipt_seq)).toBe(5);
    expect(BigInt(stateAfter.last_device_seq as string | number)).toBeGreaterThanOrEqual(
      BigInt(stateBefore.last_device_seq as string | number),
    );
    expect(String(stateAfter.last_hlc) >= String(stateBefore.last_hlc)).toBe(true);

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

  it('B1: safety pre-restore backup checkpoints WAL and includes uncheckpointed crash commits', async () => {
    const env = await setupBackupEnv();

    // 1. Initial backup before crash commit
    const backupInit = await env.backupService.createBackup({ reason: 'Initial checkpoint' });

    // Close parent connection so child can write to WAL exclusively
    env.connection.close();
    openConnections.length = 0;

    // 2. Child process connects to SQLite with journal_mode=WAL, commits a new row, then process.exit(0) without closing!
    const crashScript = path.join(env.dir, 'child-wal-crash.mjs');
    const crashedProductId = '01950000-0000-7000-8000-000000000999';
    fs.writeFileSync(
      crashScript,
      `
      import { createRequire } from 'node:module';
      const localRequire = createRequire(${JSON.stringify(import.meta.url)});
      const Database = localRequire('better-sqlite3');
      const db = new Database(${JSON.stringify(env.dbPath)});
      db.pragma('journal_mode = WAL');
      const dev = db.prepare('SELECT organization_id, device_id, last_hlc FROM local_device_state LIMIT 1').get();
      db.prepare(\`
        INSERT INTO products (
          id, organization_id, device_id, hlc, created_at_ms, updated_at_ms, name, name_search, unit, sale_price, vat_rate_bp
        ) VALUES (
          ?, ?, ?, ?, 1763100000000, 1763100000000, 'Crash Product', 'crash product', 'dona', 1500000, 0
        )
      \`).run(
        ${JSON.stringify(crashedProductId)},
        dev.organization_id,
        dev.device_id,
        dev.last_hlc
      );
      // Exit abruptly without closing DB connection or checkpointing!
      process.exit(0);
      `,
      'utf8',
    );

    const childRes = spawnSync(process.execPath, [crashScript], {
      encoding: 'utf8',
      timeout: 15_000,
    });
    expect(childRes.status, childRes.stderr).toBe(0);

    const walFile = `${env.dbPath}-wal`;
    expect(fs.existsSync(walFile)).toBe(true);
    expect(fs.statSync(walFile).size).toBeGreaterThan(0);

    // 3. Stage restore to backupInit
    const stagingPath = path.join(env.backupDir, 'pending-restore.json');
    fs.writeFileSync(
      stagingPath,
      JSON.stringify({
        backupId: backupInit.id,
        targetDbPath: env.dbPath,
        reason: 'B1 crash recovery restore test',
        actorUserId: env.ownerId,
        stagedAtMs: Date.now(),
      }),
      'utf8',
    );

    // 4. Execute staged restore: it MUST checkpoint WAL before taking safety backup
    const outcome = await SqliteBackupService.executeStagedRestoreIfPending({
      dbPath: env.dbPath,
      backupDir: env.backupDir,
    });
    expect(outcome.wasRestored).toBe(true);
    expect(outcome.safetyBackupPath).toBeDefined();
    expect(fs.existsSync(outcome.safetyBackupPath!)).toBe(true);

    // 5. Open safety backup database: verify uncheckpointed crashed commit is present and accounted for!
    const sDb = new Database(outcome.safetyBackupPath, { readonly: true });
    try {
      const row = sDb
        .prepare('SELECT id, name, sale_price FROM products WHERE id = ?')
        .get(crashedProductId) as { id: string; name: string; sale_price: unknown } | undefined;
      expect(row).toBeDefined();
      expect(row?.id).toBe(crashedProductId);
      expect(row?.name).toBe('Crash Product');
    } finally {
      sDb.close();
    }

    // 6. Live restored DB should NOT have this product (it was restored to backupInit)
    const liveDb = openLocalSqliteDatabase(env.dbPath);
    openConnections.push(liveDb);
    const liveRow = liveDb.sqlite
      .prepare('SELECT id FROM products WHERE id = ?')
      .get(crashedProductId);
    expect(liveRow).toBeUndefined();
  });

  it('B2: rejects staged restore and leaves current DB untouched if backup SHA-256 or integrity fails', async () => {
    const env = await setupBackupEnv();

    const p = (
      await env.catalogStore.createProduct({
        actorUserId: env.ownerId,
        name: 'Guarded Product B2',
        unit: 'dona',
        salePrice: '500000',
        vatRateBp: 0,
      })
    ).product;

    const backupA = await env.backupService.createBackup({ reason: 'Valid backup' });

    // Case 1: Targeted payload byte change inside product name string
    // PRAGMA integrity_check STILL PASSES ('ok') because B-tree structure is intact,
    // but SHA-256 mismatch MUST catch it and reject restore!
    env.backupService.stageRestore({
      backupId: backupA.id,
      actorUserId: env.ownerId,
    });

    env.connection.close();
    openConnections.length = 0;

    const backupDbFile = path.join(env.backupDir, `${backupA.id}.db`);
    const originalBuf = fs.readFileSync(backupDbFile);
    const targetStr = 'Guarded Product B2';
    const targetIdx = originalBuf.indexOf(Buffer.from(targetStr));
    expect(targetIdx).toBeGreaterThan(0);

    const tamperedBuf = Buffer.from(originalBuf);
    tamperedBuf[targetIdx] = 'X'.charCodeAt(0); // 'Xuarded Product B2'
    fs.writeFileSync(backupDbFile, tamperedBuf);

    // Assert: PRAGMA integrity_check ALONE returns 'ok' on this tampered database!
    const tamperedDb = new Database(backupDbFile, { readonly: true });
    const chkRows = tamperedDb.pragma('integrity_check') as Array<{ integrity_check: string }>;
    tamperedDb.close();
    expect(chkRows).toBeDefined();
    expect(chkRows[0]?.integrity_check).toBe('ok');

    // BUT executeStagedRestoreIfPending MUST reject it due to SHA-256 verification failure!
    await expect(
      SqliteBackupService.executeStagedRestoreIfPending({
        dbPath: env.dbPath,
        backupDir: env.backupDir,
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });

    // Current database MUST remain completely untouched!
    const curDb = openLocalSqliteDatabase(env.dbPath);
    openConnections.push(curDb);
    const prodRow = curDb.sqlite.prepare('SELECT id, name FROM products WHERE id = ?').get(p.id) as
      { id: string; name: string } | undefined;
    expect(prodRow).toBeDefined();
    expect(prodRow?.name).toBe('Guarded Product B2');

    // Case 2: Corrupted SQLite file failing integrity_check with matching sha
    curDb.close();
    openConnections.length = 0;

    const garbageDbPath = path.join(env.backupDir, 'corrupted.db');
    fs.writeFileSync(garbageDbPath, Buffer.alloc(4096, 0xaa));
    const garbageSha = createHash('sha256').update(fs.readFileSync(garbageDbPath)).digest('hex');
    fs.writeFileSync(
      path.join(env.backupDir, 'corrupted.meta.json'),
      JSON.stringify({ id: 'corrupted', sha256: garbageSha, filename: 'corrupted.db' }),
    );

    const stagingPath = path.join(env.backupDir, 'pending-restore.json');
    fs.writeFileSync(
      stagingPath,
      JSON.stringify({
        backupId: 'corrupted',
        targetDbPath: env.dbPath,
        reason: 'corrupted test',
        actorUserId: env.ownerId,
        stagedAtMs: Date.now(),
      }),
    );

    await expect(
      SqliteBackupService.executeStagedRestoreIfPending({
        dbPath: env.dbPath,
        backupDir: env.backupDir,
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });

    // Again, current database is intact
    const verifyDb = openLocalSqliteDatabase(env.dbPath);
    openConnections.push(verifyDb);
    const intact = verifyDb.sqlite
      .prepare('SELECT COUNT(*) as cnt FROM products WHERE id = ?')
      .get(p.id) as { cnt: unknown };
    expect(Number(intact.cnt)).toBe(1);

    // Case 3: Missing .meta.json MUST reject restore with VALIDATION_ERROR and leave current DB intact
    verifyDb.close();
    openConnections.length = 0;

    const curDbForBackup = openLocalSqliteDatabase(env.dbPath);
    openConnections.push(curDbForBackup);
    const backupService3 = new SqliteBackupService({
      connection: curDbForBackup,
      backupDir: env.backupDir,
      dbPath: env.dbPath,
    });
    const backupNoMeta = await backupService3.createBackup({ reason: 'Will delete meta' });
    backupService3.stageRestore({
      backupId: backupNoMeta.id,
      actorUserId: env.ownerId,
    });
    curDbForBackup.close();
    openConnections.length = 0;

    // Delete the metadata file
    const metaToDelete = path.join(env.backupDir, `${backupNoMeta.id}.meta.json`);
    expect(fs.existsSync(metaToDelete)).toBe(true);
    fs.unlinkSync(metaToDelete);

    await expect(
      SqliteBackupService.executeStagedRestoreIfPending({
        dbPath: env.dbPath,
        backupDir: env.backupDir,
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });

    // Verify current DB remains intact
    const verifyDb3 = openLocalSqliteDatabase(env.dbPath);
    openConnections.push(verifyDb3);
    const intact3 = verifyDb3.sqlite
      .prepare('SELECT COUNT(*) as cnt FROM products WHERE id = ?')
      .get(p.id) as { cnt: unknown };
    expect(Number(intact3.cnt)).toBe(1);
  });

  it('B3: rebuilds stock, customer, and supplier projections post-restore and verifies ledger parity', async () => {
    const env = await setupBackupEnv();

    const p = (
      await env.catalogStore.createProduct({
        actorUserId: env.ownerId,
        name: 'Olma B3',
        unit: 'kg',
        salePrice: '1000000',
        vatRateBp: 0,
      })
    ).product;

    await env.stockStore.recordInboundMove({
      productId: p.id,
      qty: '50000', // 50 kg
      totalCostValue: '25000000',
      reason: 'purchase',
      actorUserId: env.ownerId,
    });

    const cust = await env.customerStore.createCustomer({
      fullName: 'Anvar B3',
      phone: '+998901234567',
      creditLimit: moneyFromTiyin(1_000_000_00n),
    });

    await env.customerStore.recordDebtAdjustment({
      customerId: cust.id,
      actorUserId: env.ownerId,
      clientRequestId: nextUuid(),
      amountDelta: moneyFromTiyin(150_000_00n),
      reason: 'B3 opening debt',
    });

    const sup = await env.supplierStore.createSupplier({
      name: 'Supplier B3 MCHJ',
    });

    await env.supplierStore.recordAdjustment({
      supplierId: sup.id,
      actorUserId: env.ownerId,
      clientRequestId: nextUuid(),
      amountDelta: moneyFromTiyin(200_000_00n),
      reason: 'B3 opening payable',
    });

    // Create backup with consistent ledger + projections
    const backupConsistent = await env.backupService.createBackup({
      reason: 'Consistent B3 backup',
    });

    // Manually corrupt projection tables to simulate stale/desynced projections
    env.connection.sqlite.prepare('UPDATE local_stock_balances SET qty_on_hand = 999999').run();
    env.connection.sqlite.prepare('UPDATE local_customer_balances SET balance = 888888').run();
    env.connection.sqlite.prepare('UPDATE local_supplier_balances SET balance = 777777').run();

    // Stage restore to backupConsistent
    env.backupService.stageRestore({
      backupId: backupConsistent.id,
      actorUserId: env.ownerId,
    });

    env.connection.close();
    openConnections.length = 0;

    // Execute staged restore
    const restoreOutcome = await SqliteBackupService.executeStagedRestoreIfPending({
      dbPath: env.dbPath,
      backupDir: env.backupDir,
    });
    expect(restoreOutcome.wasRestored).toBe(true);

    const reconnected = openLocalSqliteDatabase(env.dbPath);
    openConnections.push(reconnected);

    // Run post-restore rebuild and verification
    const rebuildOutcome = await SqliteBackupService.executePostRestoreRebuildAndVerify({
      connection: reconnected,
      backupDir: env.backupDir,
      backupId: restoreOutcome.backupId,
    });

    expect(rebuildOutcome.stockResult).toBeDefined();
    expect(rebuildOutcome.customerResult).toBeDefined();
    expect(rebuildOutcome.supplierResult).toBeDefined();

    // Verify projection = ledger parity:
    const stockRow = reconnected.sqlite
      .prepare('SELECT qty_on_hand FROM local_stock_balances WHERE product_id = ?')
      .get(p.id) as { qty_on_hand: unknown };
    expect(Number(stockRow.qty_on_hand)).toBe(50000); // 50 kg exactly matching stock_moves

    const custRow = reconnected.sqlite
      .prepare('SELECT balance FROM local_customer_balances WHERE customer_id = ?')
      .get(cust.id) as { balance: unknown };
    expect(Number(custRow.balance)).toBe(15000000); // 150,000 so'm exactly matching customer_ledger

    const supRow = reconnected.sqlite
      .prepare('SELECT balance FROM local_supplier_balances WHERE supplier_id = ?')
      .get(sup.id) as { balance: unknown };
    expect(Number(supRow.balance)).toBe(20000000); // 200,000 so'm exactly matching supplier_ledger
  });

  it('B4: advances last_hlc to max(restored, current) lexicographically across restore', async () => {
    const env = await setupBackupEnv();

    const p = (
      await env.catalogStore.createProduct({
        actorUserId: env.ownerId,
        name: 'HLC Test Product',
        unit: 'dona',
        salePrice: '100000',
        vatRateBp: 0,
      })
    ).product;

    // Checkpoint A has an earlier HLC
    const backupA = await env.backupService.createBackup({ reason: 'HLC checkpoint A' });

    // Read HLC at checkpoint A
    const hlcAtA = (
      env.connection.sqlite.prepare('SELECT last_hlc FROM local_device_state LIMIT 1').get() as {
        last_hlc: string;
      }
    ).last_hlc;

    // Advance system clock and perform multiple operations to generate a strictly higher HLC
    env.clock.advance(120_000n);
    await env.stockStore.recordInboundMove({
      productId: p.id,
      qty: '10000',
      totalCostValue: '500000',
      reason: 'purchase',
      actorUserId: env.ownerId,
    });

    const hlcBeforeRestore = (
      env.connection.sqlite.prepare('SELECT last_hlc FROM local_device_state LIMIT 1').get() as {
        last_hlc: string;
      }
    ).last_hlc;

    expect(hlcBeforeRestore > hlcAtA).toBe(true);

    // Stage restore to checkpoint A
    env.backupService.stageRestore({
      backupId: backupA.id,
      actorUserId: env.ownerId,
    });

    env.connection.close();
    openConnections.length = 0;

    await SqliteBackupService.executeStagedRestoreIfPending({
      dbPath: env.dbPath,
      backupDir: env.backupDir,
    });

    // Reopen and check that last_hlc was advanced to max(restored, current) = hlcBeforeRestore
    const reconnected = openLocalSqliteDatabase(env.dbPath);
    openConnections.push(reconnected);

    const hlcAfterRestore = (
      reconnected.sqlite.prepare('SELECT last_hlc FROM local_device_state LIMIT 1').get() as {
        last_hlc: string;
      }
    ).last_hlc;

    expect(hlcAfterRestore).toBe(hlcBeforeRestore);
    expect(hlcAfterRestore > hlcAtA).toBe(true);
  });
});
