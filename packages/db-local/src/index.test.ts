import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import {
  HlcClock,
  type UnixMs,
  createHlcTimestamp,
  parseUuidV7,
  serializeHlc,
  unixMsFromBigInt,
} from '@mezon/domain';
import { DeterministicUuidV7Generator, FixedClock } from '@mezon/test-utils';
import { count, eq } from 'drizzle-orm';
import { integer, numeric, real, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DB_LOCAL_PACKAGE,
  SchemaValidationError,
  SqliteSchemaRegistry,
  assertCatalogSearchMigrationsComplete,
  assertCustomerMigrationsComplete,
  assertOrderMigrationsComplete,
  assertReturnAndViewMigrationsComplete,
  assertSaleMigrationsComplete,
  assertShiftMigrationsComplete,
  assertSqliteTriggersMigrationsComplete,
  assertStockMigrationsComplete,
  assertSupplierMigrationsComplete,
  batches,
  buildAllSqliteTriggersSql,
  buildCatalogSearchFtsSql,
  buildCustomerSearchFtsSql,
  buildOrderTriggersSql,
  buildSaleMonotoneTriggersSql,
  buildSalesLinesViewSql,
  buildShiftTriggersSql,
  buildSqliteImmutabilityTriggersSql,
  buildStockMonotoneTriggersSql,
  buildSupplierSearchFtsSql,
  cashMoves,
  categories,
  customerLedger,
  customers,
  getDefaultLocalMigrationsFolder,
  goodsReceivingLines,
  goodsReceivings,
  inventoryCountLines,
  inventoryCounts,
  localBatchBalances,
  localCartLines,
  localCarts,
  localCloudState,
  localCustomerBalances,
  localDeviceAuthState,
  localDeviceState,
  localHubConfig,
  localOutbox,
  localPinCredentials,
  localReceivingDraftLines,
  localReceivingDrafts,
  localSchemaRegistry,
  localSessions,
  localStockBalances,
  localStockConflicts,
  localSupplierBalances,
  migrateLocalDatabase,
  openLocalSqliteDatabase,
  orderLines,
  orderPayments,
  orders,
  payments,
  priceChanges,
  productBarcodes,
  productVariants,
  products,
  promotions,
  receivingCostConfirmations,
  returnLines,
  returnPayments,
  returns,
  saleLines,
  sales,
  shiftCashierSessions,
  shiftClosureCashiers,
  shiftClosureMethodTotals,
  shiftClosures,
  shifts,
  dayCloses,
  sqliteBigint,
  sqliteBoolean,
  sqliteInt,
  sqliteMoney,
  sqliteQuantity,
  sqliteUnixMs,
  stockMoves,
  supplierLedger,
  supplierReturnLines,
  supplierReturns,
  suppliers,
  users,
  validateSqliteSchemaRegistry,
} from './index.js';

interface DrizzleSqliteKitApi {
  readonly generateSQLiteDrizzleJson: (
    imports: Record<string, unknown>,
  ) => Promise<Record<string, unknown>>;
  readonly generateSQLiteMigration: (
    prev: Record<string, unknown>,
    cur: Record<string, unknown>,
  ) => Promise<string[]>;
}

const require = createRequire(import.meta.url);
const { generateSQLiteDrizzleJson, generateSQLiteMigration } =
  require('drizzle-kit/api') as DrizzleSqliteKitApi;

const tempDirs: string[] = [];

function makeTempDbPath(filename: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mezon-db-local-'));
  tempDirs.push(dir);
  return path.join(dir, filename);
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('@mezon/db-local - Schema foundation, registry, pragmas, and bigint safety', () => {
  it('exports package marker, registers foundation & T0.6 auth tables, and validates cleanly', () => {
    expect(DB_LOCAL_PACKAGE).toBe('@mezon/db-local');
    expect(localSchemaRegistry.all().map((m) => [m.tableName, m.tableClass])).toEqual([
      ['local_device_state', 'LOCAL'],
      ['local_outbox', 'LOCAL'],
      ['users', 'ATTR'],
      ['local_hub_config', 'LOCAL'],
      ['local_pin_credentials', 'LOCAL'],
      ['local_device_auth_state', 'LOCAL'],
      ['local_sessions', 'LOCAL'],
      ['categories', 'ATTR'],
      ['products', 'ATTR'],
      ['product_variants', 'ATTR'],
      ['product_barcodes', 'ATTR'],
      ['price_changes', 'FACT'],
      ['batches', 'FACT'],
      ['stock_moves', 'FACT'],
      ['inventory_counts', 'MONOTONE'],
      ['inventory_count_lines', 'MONOTONE'],
      ['local_stock_balances', 'LOCAL'],
      ['local_batch_balances', 'LOCAL'],
      ['local_stock_conflicts', 'LOCAL'],
      ['promotions', 'ATTR'],
      ['local_carts', 'LOCAL'],
      ['local_cart_lines', 'LOCAL'],
      ['sales', 'MONOTONE'],
      ['sale_lines', 'FACT'],
      ['payments', 'FACT'],
      ['cash_moves', 'FACT'],
      ['returns', 'FACT'],
      ['return_lines', 'FACT'],
      ['return_payments', 'FACT'],
      ['customers', 'ATTR'],
      ['customer_ledger', 'FACT'],
      ['local_customer_balances', 'LOCAL'],
      ['suppliers', 'ATTR'],
      ['local_receiving_drafts', 'LOCAL'],
      ['local_receiving_draft_lines', 'LOCAL'],
      ['goods_receivings', 'FACT'],
      ['goods_receiving_lines', 'FACT'],
      ['receiving_cost_confirmations', 'FACT'],
      ['supplier_returns', 'FACT'],
      ['supplier_return_lines', 'FACT'],
      ['supplier_ledger', 'FACT'],
      ['local_supplier_balances', 'LOCAL'],
      ['shifts', 'MONOTONE'],
      ['shift_cashier_sessions', 'MONOTONE'],
      ['shift_closures', 'FACT'],
      ['shift_closure_method_totals', 'FACT'],
      ['shift_closure_cashiers', 'FACT'],
      ['day_closes', 'FACT'],
      ['orders', 'MONOTONE'],
      ['order_lines', 'FACT'],
      ['order_payments', 'FACT'],
      ['local_receipt_prints', 'LOCAL'],
      ['local_cash_drawer_events', 'LOCAL'],
      ['local_cloud_state', 'LOCAL'],
    ]);
    expect(() =>
      validateSqliteSchemaRegistry(
        {
          localDeviceState,
          localOutbox,
          users,
          localHubConfig,
          localPinCredentials,
          localDeviceAuthState,
          localSessions,
          categories,
          products,
          productVariants,
          productBarcodes,
          priceChanges,
          batches,
          stockMoves,
          inventoryCounts,
          inventoryCountLines,
          localStockBalances,
          localBatchBalances,
          localStockConflicts,
          promotions,
          localCarts,
          localCartLines,
          sales,
          saleLines,
          payments,
          cashMoves,
          returns,
          returnLines,
          returnPayments,
          customers,
          customerLedger,
          localCustomerBalances,
          suppliers,
          localReceivingDrafts,
          localReceivingDraftLines,
          goodsReceivings,
          goodsReceivingLines,
          receivingCostConfirmations,
          supplierReturns,
          supplierReturnLines,
          supplierLedger,
          localSupplierBalances,
          shifts,
          shiftCashierSessions,
          shiftClosures,
          shiftClosureMethodTotals,
          shiftClosureCashiers,
          dayCloses,
          orders,
          orderLines,
          orderPayments,
          localCloudState,
        },
        localSchemaRegistry,
      ),
    ).not.toThrow();

    expect(buildOrderTriggersSql().length).toBeGreaterThanOrEqual(4);
    expect(() => assertOrderMigrationsComplete(getDefaultLocalMigrationsFolder())).not.toThrow();
  });

  it('registers all four classes (FACT/ATTR/MONOTONE/LOCAL) and enforces exact common columns', () => {
    const registry = new SqliteSchemaRegistry();

    const factTable = registry.defineTable(
      { name: 'test_fact', tableClass: 'FACT', tenantScope: 'store' },
      (c) => ({
        ...c,
        totalTiyin: sqliteMoney('total_tiyin').notNull(),
        qtyMilli: sqliteQuantity('qty_milli').notNull(),
      }),
    );

    const attrTable = registry.defineTable(
      { name: 'test_attr', tableClass: 'ATTR', tenantScope: 'organization' },
      (c) => ({
        ...c,
        title: text('title').notNull(),
        active: sqliteBoolean('active').notNull(),
      }),
    );

    const monotoneTable = registry.defineTable(
      {
        name: 'test_monotone',
        tableClass: 'MONOTONE',
        tenantScope: 'store',
        monotoneColumns: ['voided_at_ms'],
      },
      (c) => ({
        ...c,
        voidedAtMs: sqliteUnixMs('voided_at_ms'),
      }),
    );

    const localNoneTable = registry.defineTable(
      { name: 'test_local_none', tableClass: 'LOCAL', tenantScope: 'none' },
      (c) => ({
        ...c,
        seq: sqliteInt('seq').notNull(),
      }),
    );

    const localStoreTable = registry.defineTable(
      { name: 'test_local_store', tableClass: 'LOCAL', tenantScope: 'store' },
      (c) => ({
        ...c,
        payload: text('payload').notNull(),
      }),
    );

    expect(() =>
      validateSqliteSchemaRegistry(
        { factTable, attrTable, monotoneTable, localNoneTable, localStoreTable },
        registry,
      ),
    ).not.toThrow();

    expect(registry.all()).toHaveLength(5);
    expect(registry.get('test_monotone')?.monotoneColumns).toEqual(['voided_at_ms']);
  });

  it('rejects unregistered tables, synced tables without organization_id, float/numeric columns, and invalid class shapes', () => {
    const validReg = new SqliteSchemaRegistry();
    const okTable = validReg.defineTable(
      { name: 'ok_fact', tableClass: 'FACT', tenantScope: 'organization' },
      (c) => ({ ...c }),
    );

    // 1. Unregistered raw sqliteTable
    const unregistered = sqliteTable('rogue_table', { id: text('id').primaryKey() });
    expect(() => validateSqliteSchemaRegistry({ okTable, unregistered }, validReg)).toThrowError(
      SchemaValidationError,
    );

    // 2. Duplicate table registration
    expect(() =>
      validReg.defineTable(
        { name: 'ok_fact', tableClass: 'FACT', tenantScope: 'organization' },
        (c) => ({ ...c }),
      ),
    ).toThrowError(SchemaValidationError);

    // 3. Synced table with tenantScope 'none'
    for (const cls of ['FACT', 'ATTR', 'MONOTONE'] as const) {
      expect(() =>
        validReg.defineTable({ name: `bad_${cls}`, tableClass: cls, tenantScope: 'none' }, (c) => ({
          ...c,
        })),
      ).toThrowError(SchemaValidationError);
    }

    // 4. Forbidden float/real column
    const floatReg = new SqliteSchemaRegistry();
    const withReal = floatReg.defineTable(
      { name: 'bad_real', tableClass: 'FACT', tenantScope: 'store' },
      (c) => ({ ...c, price: real('price').notNull() }),
    );
    expect(() => validateSqliteSchemaRegistry({ withReal }, floatReg)).toThrowError(
      /forbidden floating\/numeric/i,
    );

    // 5. Forbidden numeric column
    const numReg = new SqliteSchemaRegistry();
    const withNumeric = numReg.defineTable(
      { name: 'bad_num', tableClass: 'FACT', tenantScope: 'store' },
      (c) => ({ ...c, price: numeric('price').notNull() }),
    );
    expect(() => validateSqliteSchemaRegistry({ withNumeric }, numReg)).toThrowError(
      /forbidden floating\/numeric/i,
    );

    // 6. Unsafe raw SQLiteInteger column
    const rawIntReg = new SqliteSchemaRegistry();
    const withRawInt = rawIntReg.defineTable(
      { name: 'bad_raw_int', tableClass: 'FACT', tenantScope: 'store' },
      (c) => ({ ...c, seq: integer('seq').notNull() }),
    );
    expect(() => validateSqliteSchemaRegistry({ withRawInt }, rawIntReg)).toThrowError(/unsafe/i);

    // 7. Sneaky raw FACT table registered directly or stripped of organization_id via manual bypass
    const missingOrgTable = sqliteTable('sneaky_fact', {
      id: text('id').primaryKey(),
      deviceId: text('device_id').notNull(),
      hlc: text('hlc').notNull(),
      createdAtMs: sqliteBigint('created_at_ms').notNull(),
    });
    const fakeMetaRegistry = {
      get: (name: string) =>
        name === 'sneaky_fact'
          ? {
              tableName: 'sneaky_fact',
              tableClass: 'FACT' as const,
              tenantScope: 'organization' as const,
              monotoneColumns: [],
              table: missingOrgTable,
            }
          : undefined,
    } as unknown as SqliteSchemaRegistry;
    expect(() => validateSqliteSchemaRegistry({ missingOrgTable }, fakeMetaRegistry)).toThrowError(
      /missing required column "organization_id"/i,
    );
  });

  it('applies WAL, synchronous=FULL, foreign_keys=ON, busy_timeout=5000 and handles migrations + safeIntegers side effects', () => {
    const dbPath = makeTempDbPath('mezon-pos.sqlite');
    const conn = openLocalSqliteDatabase(dbPath);

    try {
      expect(conn.pragmas.journalMode).toBe('wal');
      expect(conn.pragmas.synchronous).toBe(2); // FULL
      expect(conn.pragmas.foreignKeys).toBe(true);
      expect(conn.pragmas.busyTimeoutMs).toBe(5000);

      // Foreign key enforcement check
      conn.sqlite.exec(`
        CREATE TABLE parent (id TEXT PRIMARY KEY);
        CREATE TABLE child (id TEXT PRIMARY KEY, parent_id TEXT NOT NULL REFERENCES parent(id));
      `);
      expect(() =>
        conn.sqlite.prepare("INSERT INTO child (id, parent_id) VALUES ('c1', 'missing')").run(),
      ).toThrowError(/FOREIGN KEY constraint failed/);

      // Drizzle migrations run cleanly and idempotently with defaultSafeIntegers(true)
      expect(fs.existsSync(getDefaultLocalMigrationsFolder())).toBe(true);
      migrateLocalDatabase(conn.db);
      migrateLocalDatabase(conn.db);

      expect(Number(conn.sqlite.pragma('user_version', { simple: true }))).toBe(1);
      const migCountRow = conn.sqlite
        .prepare('SELECT COUNT(*) as cnt FROM __drizzle_migrations')
        .get() as { cnt: bigint };
      expect(migCountRow.cnt).toBe(15n);
    } finally {
      conn.close();
    }
  });

  it('enforces >53-bit bigint fidelity, automatic typeof=integer CHECK, length(hlc)=58 CHECK, boolean & count()', async () => {
    const registry = new SqliteSchemaRegistry();
    const ledgerTable = registry.defineTable(
      { name: 'test_ledger', tableClass: 'ATTR', tenantScope: 'store' },
      (c) => ({
        ...c,
        amountTiyin: sqliteBigint('amount_tiyin').notNull(),
        optionalDelta: sqliteBigint('optional_delta'),
        seq: sqliteInt('seq').notNull(),
        isActive: sqliteBoolean('is_active').notNull(),
      }),
    );

    const emptySnap = await generateSQLiteDrizzleJson({});
    const currSnap = await generateSQLiteDrizzleJson({ test_ledger: ledgerTable });
    const ddlStatements = await generateSQLiteMigration(emptySnap, currSnap);
    expect(ddlStatements.length).toBeGreaterThan(0);
    const fullDdl = ddlStatements.join('\n');

    expect(fullDdl).toContain('CHECK(typeof("test_ledger"."amount_tiyin") = \'integer\')');
    expect(fullDdl).toContain(
      'CHECK("test_ledger"."optional_delta" IS NULL OR typeof("test_ledger"."optional_delta") = \'integer\')',
    );
    expect(fullDdl).toContain('CHECK(length("test_ledger"."hlc") = 58)');

    const dbPath = makeTempDbPath('test-checks.sqlite');
    const conn = openLocalSqliteDatabase(dbPath, { schema: { test_ledger: ledgerTable } });

    try {
      migrateLocalDatabase(conn.db);
      conn.sqlite.exec(fullDdl);

      const idGen = new DeterministicUuidV7Generator();
      const clock = new FixedClock(1_700_000_000_000n);
      const nodeId = idGen.nextId();
      const orgId = idGen.nextId();
      const storeId = idGen.nextId();
      const rowId = idGen.nextId();
      const hlc = serializeHlc(new HlcClock({ clock, nodeId }).now().hlc);
      const nowMs = clock.now();

      const hugeBigint = 9_007_199_254_740_993n; // 2^53 + 1
      const hugeNeg = -9_007_199_254_740_993n;

      // Drizzle insert + nullable deletedAtMs + boolean + int + >53-bit bigint
      conn.db
        .insert(ledgerTable)
        .values({
          id: rowId,
          organizationId: orgId,
          storeId,
          deviceId: nodeId,
          hlc,
          createdAtMs: nowMs,
          updatedAtMs: nowMs,
          deletedAtMs: null,
          amountTiyin: hugeBigint,
          optionalDelta: hugeNeg,
          seq: 7,
          isActive: false,
        })
        .run();

      const fetched = conn.db.select().from(ledgerTable).where(eq(ledgerTable.id, rowId)).get();
      expect(fetched).toBeDefined();
      expect(fetched?.amountTiyin).toBe(hugeBigint);
      expect(typeof fetched?.amountTiyin).toBe('bigint');
      expect(fetched?.optionalDelta).toBe(hugeNeg);
      expect(fetched?.deletedAtMs).toBeNull();
      expect(fetched?.seq).toBe(7);
      expect(typeof fetched?.seq).toBe('number');
      expect(fetched?.isActive).toBe(false);
      expect(typeof fetched?.isActive).toBe('boolean');

      // Drizzle count() aggregate works cleanly despite defaultSafeIntegers(true)
      const countRows = conn.db.select({ total: count() }).from(ledgerTable).all();
      expect(countRows[0].total).toBe(1);

      // boolean true readback
      const rowId2 = idGen.nextId();
      conn.db
        .insert(ledgerTable)
        .values({
          id: rowId2,
          organizationId: orgId,
          storeId,
          deviceId: nodeId,
          hlc,
          createdAtMs: nowMs,
          updatedAtMs: nowMs,
          deletedAtMs: unixMsFromBigInt(1_700_000_000_100n),
          amountTiyin: 0n,
          optionalDelta: null,
          seq: 8,
          isActive: true,
        })
        .run();
      const fetched2 = conn.db.select().from(ledgerTable).where(eq(ledgerTable.id, rowId2)).get();
      expect(fetched2?.isActive).toBe(true);
      expect(fetched2?.deletedAtMs).toBe(1_700_000_000_100n);
      expect(conn.db.select({ total: count() }).from(ledgerTable).all()[0].total).toBe(2);

      // TypeScript/runtime toDriver guards reject number/string
      expect(() =>
        conn.db
          .insert(ledgerTable)
          .values({
            id: idGen.nextId(),
            organizationId: orgId,
            storeId,
            deviceId: nodeId,
            hlc,
            createdAtMs: nowMs,
            updatedAtMs: nowMs,
            amountTiyin: '123' as unknown as bigint,
            seq: 9,
            isActive: true,
          })
          .run(),
      ).toThrow(TypeError);

      // Raw SQL CHECK rejections on non-integer text, decimals, blobs, floats, bad HLC length
      const badInsert = conn.sqlite.prepare(`
        INSERT INTO test_ledger (
          id, organization_id, store_id, device_id, hlc, created_at_ms, updated_at_ms,
          deleted_at_ms, amount_tiyin, optional_delta, seq, is_active
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      const validRowArgs = (): Array<string | number | bigint | Buffer | null> => [
        idGen.nextId(),
        orgId,
        storeId,
        nodeId,
        hlc,
        1000n,
        1000n,
        null,
        500n,
        null,
        1,
        1,
      ];

      // Float 1.5 rejected on amount_tiyin
      const floatArgs = validRowArgs();
      floatArgs[8] = 1.5;
      expect(() => badInsert.run(...floatArgs)).toThrowError(/CHECK constraint failed/);

      // Text 'abc' rejected on amount_tiyin
      const textArgs = validRowArgs();
      textArgs[8] = 'abc';
      expect(() => badInsert.run(...textArgs)).toThrowError(/CHECK constraint failed/);

      // Text '12.5' rejected on optional_delta (nullable accepts NULL, rejects non-integers)
      const optDecArgs = validRowArgs();
      optDecArgs[9] = '12.5';
      expect(() => badInsert.run(...optDecArgs)).toThrowError(/CHECK constraint failed/);

      // Blob rejected on deleted_at_ms
      const blobArgs = validRowArgs();
      blobArgs[7] = Buffer.from([1, 2, 3]);
      expect(() => badInsert.run(...blobArgs)).toThrowError(/CHECK constraint failed/);

      // Bad HLC length (57 chars) rejected
      const badHlcArgs = validRowArgs();
      badHlcArgs[4] = 'x'.repeat(57);
      expect(() => badInsert.run(...badHlcArgs)).toThrowError(/CHECK constraint failed/);

      // Verify lossless integer affinity behavior if raw SQL passes numeric string '123':
      // SQLite converts '123' to integer 123 before CHECK, so typeof(amount_tiyin) is still 'integer' (never 'text').
      const coercedArgs = validRowArgs();
      const coercedId = parseUuidV7(idGen.nextId());
      coercedArgs[0] = coercedId;
      coercedArgs[8] = '123';
      badInsert.run(...coercedArgs);
      const coercedCheck = conn.sqlite
        .prepare('SELECT amount_tiyin, typeof(amount_tiyin) as sql_t FROM test_ledger WHERE id = ?')
        .get(coercedId) as { amount_tiyin: bigint; sql_t: string };
      expect(coercedCheck.amount_tiyin).toBe(123n);
      expect(coercedCheck.sql_t).toBe('integer');

      // Validate UnixMs out-of-range check
      expect(() =>
        conn.db
          .insert(ledgerTable)
          .values({
            id: idGen.nextId(),
            organizationId: orgId,
            storeId,
            deviceId: nodeId,
            hlc,
            createdAtMs: -1n as UnixMs,
            updatedAtMs: nowMs,
            amountTiyin: 1n,
            seq: 1,
            isActive: true,
          })
          .run(),
      ).toThrow();
    } finally {
      conn.close();
    }
  });

  it('generates class immutability triggers and assertSqliteTriggersMigrationsComplete catches missing/weak triggers', () => {
    const reg = new SqliteSchemaRegistry();
    reg.defineTable({ name: 'fact_sales', tableClass: 'FACT', tenantScope: 'store' }, (c) => ({
      ...c,
    }));
    reg.defineTable(
      { name: 'attr_customers', tableClass: 'ATTR', tenantScope: 'organization' },
      (c) => ({ ...c }),
    );
    reg.defineTable(
      {
        name: 'mono_voids',
        tableClass: 'MONOTONE',
        tenantScope: 'store',
        monotoneColumns: ['voided_at_ms'],
      },
      (c) => ({ ...c, voidedAtMs: sqliteUnixMs('voided_at_ms') }),
    );
    reg.defineTable({ name: 'local_cfg', tableClass: 'LOCAL', tenantScope: 'none' }, (c) => ({
      ...c,
    }));

    expect(buildSqliteImmutabilityTriggersSql('local_cfg', 'LOCAL')).toEqual([]);
    const allSql = buildAllSqliteTriggersSql(reg.all()).join('\n');
    expect(allSql).toContain('CREATE TRIGGER "trg_fact_sales_no_update"');
    expect(allSql).toContain('CREATE TRIGGER "trg_fact_sales_no_delete"');
    expect(allSql).toContain('CREATE TRIGGER "trg_attr_customers_no_delete"');
    expect(allSql).toContain('CREATE TRIGGER "trg_mono_voids_no_delete"');
    expect(allSql).not.toContain('trg_attr_customers_no_update');
    expect(allSql).not.toContain('trg_mono_voids_no_update');

    const [factMeta, attrMeta, monoMeta] = reg.all();
    const makeMigDir = () => {
      const dir = path.join(os.tmpdir(), `mezon-trig-test-${Date.now()}-${Math.random()}`);
      fs.mkdirSync(dir, { recursive: true });
      tempDirs.push(dir);
      return dir;
    };

    // Valid triggers pass for all classes
    const okDir = makeMigDir();
    fs.writeFileSync(path.join(okDir, '0001.sql'), allSql);
    expect(() => assertSqliteTriggersMigrationsComplete(okDir, reg.all())).not.toThrow();

    // Missing FACT BEFORE UPDATE trigger fails
    const missingFactUpdateDir = makeMigDir();
    fs.writeFileSync(
      path.join(missingFactUpdateDir, '0001.sql'),
      `
      CREATE TRIGGER "trg_fact_sales_no_delete" BEFORE DELETE ON "fact_sales" FOR EACH ROW
      BEGIN SELECT RAISE(ABORT, 'no delete'); END;
      `,
    );
    expect(() =>
      assertSqliteTriggersMigrationsComplete(missingFactUpdateDir, [factMeta]),
    ).toThrowError(/missing required BEFORE UPDATE RAISE\(ABORT\)/);

    // Wrong RAISE action (RAISE(IGNORE) instead of RAISE(ABORT)) fails
    const raiseIgnoreDir = makeMigDir();
    fs.writeFileSync(
      path.join(raiseIgnoreDir, '0001.sql'),
      `
      CREATE TRIGGER "trg_attr_customers_no_delete" BEFORE DELETE ON "attr_customers" FOR EACH ROW
      BEGIN SELECT RAISE(IGNORE); END;
      `,
    );
    expect(() => assertSqliteTriggersMigrationsComplete(raiseIgnoreDir, [attrMeta])).toThrowError(
      /missing required BEFORE DELETE RAISE\(ABORT\)/,
    );

    // Weakened WHEN trigger condition fails
    const whenFilterDir = makeMigDir();
    fs.writeFileSync(
      path.join(whenFilterDir, '0001.sql'),
      `
      CREATE TRIGGER "trg_mono_voids_no_delete" BEFORE DELETE ON "mono_voids" FOR EACH ROW WHEN 1 = 0
      BEGIN SELECT RAISE(ABORT, 'bypassed'); END;
      `,
    );
    expect(() => assertSqliteTriggersMigrationsComplete(whenFilterDir, [monoMeta])).toThrowError(
      /missing required BEFORE DELETE RAISE\(ABORT\)/,
    );

    // Subsequent DROP TRIGGER without recreate fails
    const droppedDir = makeMigDir();
    fs.writeFileSync(
      path.join(droppedDir, '0001.sql'),
      buildSqliteImmutabilityTriggersSql('attr_customers', 'ATTR').join('\n') +
        '\nDROP TRIGGER "trg_attr_customers_no_delete";\n',
    );
    expect(() => assertSqliteTriggersMigrationsComplete(droppedDir, [attrMeta])).toThrowError(
      /missing required BEFORE DELETE RAISE\(ABORT\)/,
    );

    // Unconditional BEFORE UPDATE abort mistakenly put on ATTR table fails
    const attrUpdateBlockDir = makeMigDir();
    fs.writeFileSync(
      path.join(attrUpdateBlockDir, '0001.sql'),
      buildSqliteImmutabilityTriggersSql('attr_customers', 'FACT').join('\n'),
    );
    expect(() =>
      assertSqliteTriggersMigrationsComplete(attrUpdateBlockDir, [attrMeta]),
    ).toThrowError(/must not define an unconditional BEFORE UPDATE RAISE\(ABORT\)/);
  });

  it('F4 negative proof: rejects migrations missing products_fts, rowid coupling, or broken FTS sync triggers', () => {
    const makeMigDir = () => {
      const dir = path.join(os.tmpdir(), `mezon-fts-check-${Date.now()}-${Math.random()}`);
      fs.mkdirSync(dir, { recursive: true });
      tempDirs.push(dir);
      return dir;
    };

    const validSql = buildCatalogSearchFtsSql().join('\n');
    const okDir = makeMigDir();
    fs.writeFileSync(path.join(okDir, '0003.sql'), validSql);
    expect(() => assertCatalogSearchMigrationsComplete(okDir)).not.toThrow();

    // Missing products_fts virtual table
    const noFtsDir = makeMigDir();
    fs.writeFileSync(path.join(noFtsDir, '0003.sql'), 'CREATE TABLE "other" ("id" text);');
    expect(() => assertCatalogSearchMigrationsComplete(noFtsDir)).toThrowError(
      /Missing active FTS5 virtual table "products_fts"/,
    );

    // Unsafe content='products' external content rowid coupling (F1 violation)
    const contentRowidDir = makeMigDir();
    fs.writeFileSync(
      path.join(contentRowidDir, '0003.sql'),
      validSql.replace("prefix = '2 3'", "content = 'products',\n  prefix = '2 3'"),
    );
    expect(() => assertCatalogSearchMigrationsComplete(contentRowidDir)).toThrowError(
      /must not use "content=" rowid coupling/,
    );

    // Trigger missing delete by product_id
    const brokenUpdateTriggerDir = makeMigDir();
    fs.writeFileSync(
      path.join(brokenUpdateTriggerDir, '0003.sql'),
      validSql.replace(
        'DELETE FROM "products_fts" WHERE "product_id" = OLD."id";',
        'DELETE FROM "products_fts" WHERE "rowid" = OLD."rowid";',
      ),
    );
    expect(() => assertCatalogSearchMigrationsComplete(brokenUpdateTriggerDir)).toThrowError(
      /delete stale "products_fts" rows by product_id = OLD\.id/,
    );

    // S3 negative proof: missing inventory_counts or inventory_count_lines MONOTONE triggers fails db:check
    const validStockTrig = buildStockMonotoneTriggersSql().join('\n');
    const okStockDir = makeMigDir();
    fs.writeFileSync(path.join(okStockDir, '0004.sql'), validStockTrig);
    expect(() => assertStockMigrationsComplete(okStockDir)).not.toThrow();

    const missingLineUpdateDir = makeMigDir();
    fs.writeFileSync(
      path.join(missingLineUpdateDir, '0004.sql'),
      validStockTrig.replace(
        /CREATE TRIGGER "trg_inventory_count_lines_parent_open_update"[\s\S]*$/i,
        '',
      ),
    );
    expect(() => assertStockMigrationsComplete(missingLineUpdateDir)).toThrowError(
      /BEFORE UPDATE trigger on "inventory_count_lines"/,
    );

    const missingLineInsertDir = makeMigDir();
    fs.writeFileSync(
      path.join(missingLineInsertDir, '0004.sql'),
      validStockTrig.replace(
        /CREATE TRIGGER "trg_inventory_count_lines_parent_open_insert"[\s\S]*$/i,
        '',
      ),
    );
    expect(() => assertStockMigrationsComplete(missingLineInsertDir)).toThrowError(
      /BEFORE INSERT trigger on "inventory_count_lines"/,
    );

    // T1.4 MONOTONE trigger checks for `sales`
    const validSaleTrig = buildSaleMonotoneTriggersSql().join('\n');
    const okSaleDir = makeMigDir();
    fs.writeFileSync(path.join(okSaleDir, '0006.sql'), validSaleTrig);
    expect(() => assertSaleMigrationsComplete(okSaleDir)).not.toThrow();

    const missingVoidedTrigDir = makeMigDir();
    fs.writeFileSync(
      path.join(missingVoidedTrigDir, '0006.sql'),
      validSaleTrig.replace(/CREATE TRIGGER "trg_sales_voided_monotone"[\s\S]*?END;/i, ''),
    );
    expect(() => assertSaleMigrationsComplete(missingVoidedTrigDir)).toThrowError(
      /trg_sales_voided_monotone/,
    );

    const dropWithoutRecreateDir = makeMigDir();
    fs.writeFileSync(
      path.join(dropWithoutRecreateDir, '0006.sql'),
      `${validSaleTrig}\nDROP TABLE "sales";`,
    );
    expect(() => assertSaleMigrationsComplete(dropWithoutRecreateDir)).toThrowError(
      /trg_sales_voided_monotone/,
    );

    // T1.6 `v_sales_lines` view validator negative/positive tests
    const okViewDir = makeMigDir();
    fs.writeFileSync(path.join(okViewDir, '0008.sql'), buildSalesLinesViewSql().join('\n'));
    expect(() => assertReturnAndViewMigrationsComplete(okViewDir)).not.toThrow();

    const missingVoidFilterDir = makeMigDir();
    fs.writeFileSync(
      path.join(missingVoidFilterDir, '0008.sql'),
      buildSalesLinesViewSql().join('\n').replace('WHERE s."voided_at_ms" IS NULL', ''),
    );
    expect(() => assertReturnAndViewMigrationsComplete(missingVoidFilterDir)).toThrowError(
      /voided_at_ms IS NULL/,
    );

    // T1.7 customer_fts & opening_balance unique validator negative/positive tests
    const openingIdxSql = `CREATE UNIQUE INDEX "uidx_customer_ledger_opening_balance" ON "customer_ledger" ("organization_id", "customer_id") WHERE "customer_ledger"."entry_type" = 'opening_balance';`;
    const okCustDir = makeMigDir();
    fs.writeFileSync(
      path.join(okCustDir, '0009.sql'),
      `${buildCustomerSearchFtsSql().join('\n')}\n${openingIdxSql}`,
    );
    expect(() => assertCustomerMigrationsComplete(okCustDir)).not.toThrow();

    const missingOpeningIdxDir = makeMigDir();
    fs.writeFileSync(
      path.join(missingOpeningIdxDir, '0009.sql'),
      buildCustomerSearchFtsSql().join('\n'),
    );
    expect(() => assertCustomerMigrationsComplete(missingOpeningIdxDir)).toThrowError(
      /uidx_customer_ledger_opening_balance/,
    );

    // T1.8 suppliers_fts, opening_balance & cost confirmation unique index validator tests
    const supOpeningIdxSql = `CREATE UNIQUE INDEX "uidx_supplier_ledger_opening_balance" ON "supplier_ledger" ("organization_id", "supplier_id") WHERE "supplier_ledger"."entry_type" = 'opening_balance';`;
    const confirmLineIdxSql = `CREATE UNIQUE INDEX "uidx_receiving_cost_confirms_line" ON "receiving_cost_confirmations" ("organization_id", "receiving_line_id");`;
    const okSupDir = makeMigDir();
    fs.writeFileSync(
      path.join(okSupDir, '0010.sql'),
      `${buildSupplierSearchFtsSql().join('\n')}\n${supOpeningIdxSql}\n${confirmLineIdxSql}`,
    );
    expect(() => assertSupplierMigrationsComplete(okSupDir)).not.toThrow();

    const missingSupOpeningDir = makeMigDir();
    fs.writeFileSync(
      path.join(missingSupOpeningDir, '0010.sql'),
      `${buildSupplierSearchFtsSql().join('\n')}\n${confirmLineIdxSql}`,
    );
    expect(() => assertSupplierMigrationsComplete(missingSupOpeningDir)).toThrowError(
      /uidx_supplier_ledger_opening_balance/,
    );

    const missingConfirmIdxDir = makeMigDir();
    fs.writeFileSync(
      path.join(missingConfirmIdxDir, '0010.sql'),
      `${buildSupplierSearchFtsSql().join('\n')}\n${supOpeningIdxSql}`,
    );
    expect(() => assertSupplierMigrationsComplete(missingConfirmIdxDir)).toThrowError(
      /uidx_receiving_cost_confirms_line/,
    );

    // T1.9 shift triggers, partial unique indexes & v_sales_lines shift column checks
    const shiftIdx1 =
      'CREATE UNIQUE INDEX "uidx_shifts_one_open_per_device" ON "shifts" ("organization_id","store_id","device_id") WHERE "shifts"."status" = \'open\';';
    const shiftIdx2 =
      'CREATE UNIQUE INDEX "uidx_shift_cashier_one_active" ON "shift_cashier_sessions" ("shift_id") WHERE "shift_cashier_sessions"."status" = \'active\';';
    const okShiftDir = makeMigDir();
    fs.writeFileSync(
      path.join(okShiftDir, '0011.sql'),
      `${buildShiftTriggersSql().join('\n')}\n${shiftIdx1}\n${shiftIdx2}\n${buildSalesLinesViewSql().join('\n')}`,
    );
    expect(() => assertShiftMigrationsComplete(okShiftDir)).not.toThrow();

    const missingShiftGuardDir = makeMigDir();
    fs.writeFileSync(
      path.join(missingShiftGuardDir, '0011.sql'),
      `${shiftIdx1}\n${shiftIdx2}\n${buildSalesLinesViewSql().join('\n')}`,
    );
    expect(() => assertShiftMigrationsComplete(missingShiftGuardDir)).toThrowError(
      /trg_shifts|shifts/,
    );
  });

  it('cleanly upgrades a pre-populated 0003 database to 0004 without losing products or FTS triggers', () => {
    const migDir = getDefaultLocalMigrationsFolder();
    const partialMigDir = path.join(os.tmpdir(), `mezon-mig-0003-${Date.now()}-${Math.random()}`);
    fs.mkdirSync(path.join(partialMigDir, 'meta'), { recursive: true });
    tempDirs.push(partialMigDir);

    for (const fname of [
      '0000_init.sql',
      '0001_uow_outbox_device_state.sql',
      '0002_hub_auth.sql',
      '0003_catalog.sql',
    ]) {
      fs.copyFileSync(path.join(migDir, fname), path.join(partialMigDir, fname));
    }
    const journal = JSON.parse(
      fs.readFileSync(path.join(migDir, 'meta', '_journal.json'), 'utf8'),
    ) as {
      readonly version: string;
      readonly dialect: string;
      entries: Array<{ readonly idx: number }>;
    };
    fs.writeFileSync(
      path.join(partialMigDir, 'meta', '_journal.json'),
      JSON.stringify({ ...journal, entries: journal.entries.filter((e) => e.idx <= 3) }, null, 2),
    );

    const dbPath = makeTempDbPath('upgrade-0003-to-0004.db');
    const conn = openLocalSqliteDatabase(dbPath);
    try {
      migrateLocalDatabase(conn.db, partialMigDir);

      const hlc58 = serializeHlc(
        createHlcTimestamp(
          unixMsFromBigInt(1_760_000_000_000n),
          0,
          parseUuidV7('01950000-0000-7000-8000-000000000001'),
        ),
      );
      expect(hlc58.length).toBe(58);
      conn.sqlite
        .prepare(
          `INSERT INTO "local_hub_config" (
            "id", "organization_id", "created_at_ms", "updated_at_ms",
            "store_id", "device_id", "singleton_guard", "setup_completed_at_ms"
          ) VALUES (?, ?, 1760000000000, 1760000000000, ?, ?, 1, 1760000000000)`,
        )
        .run(
          '01950000-0000-7000-8000-000000000010',
          '01950000-0000-7000-8000-000000000011',
          '01950000-0000-7000-8000-000000000012',
          '01950000-0000-7000-8000-000000000001',
        );
      conn.sqlite
        .prepare(
          `INSERT INTO "products" (
            "id", "organization_id", "device_id", "hlc", "created_at_ms", "updated_at_ms",
            "deleted_at_ms", "category_id", "sku", "sku_search", "name", "name_search",
            "unit", "unlimited", "min_stock", "has_variants", "sale_price", "mxik", "package_code", "vat_rate_bp"
          ) VALUES (?, ?, ?, ?, 1760000000000, 1760000000000, NULL, NULL, NULL, NULL, 'Old Milk', 'old milk', 'dona', 0, NULL, 0, 100000, NULL, NULL, 0)`,
        )
        .run(
          '01950000-0000-7000-8000-000000000020',
          '01950000-0000-7000-8000-000000000011',
          '01950000-0000-7000-8000-000000000001',
          hlc58,
        );

      // Upgrade cleanly to 0004
      migrateLocalDatabase(conn.db, migDir);

      const hubCfg = conn.sqlite
        .prepare(
          `SELECT "negative_stock_policy", "cashier_discount_percent_unlimited",
            "cashier_max_discount_percent_bp", "cashier_discount_amount_unlimited",
            "cashier_max_discount_amount", "quick_sale_default_mxik"
           FROM "local_hub_config" WHERE "singleton_guard" = 1`,
        )
        .get() as {
        readonly negative_stock_policy: string;
        readonly cashier_discount_percent_unlimited: bigint;
        readonly cashier_max_discount_percent_bp: bigint;
        readonly cashier_discount_amount_unlimited: bigint;
        readonly cashier_max_discount_amount: bigint;
        readonly quick_sale_default_mxik: string | null;
      };
      expect(hubCfg.negative_stock_policy).toBe('warn');
      expect(hubCfg.cashier_discount_percent_unlimited).toBe(0n);
      expect(hubCfg.cashier_max_discount_percent_bp).toBe(0n);
      expect(hubCfg.cashier_discount_amount_unlimited).toBe(0n);
      expect(hubCfg.cashier_max_discount_amount).toBe(0n);
      expect(hubCfg.quick_sale_default_mxik).toBeNull();

      const prod = conn.sqlite
        .prepare('SELECT "name", "track_batches" FROM "products" WHERE "id" = ?')
        .get('01950000-0000-7000-8000-000000000020') as {
        readonly name: string;
        readonly track_batches: bigint;
      };
      expect(prod.name).toBe('Old Milk');
      expect(prod.track_batches).toBe(0n);

      // Products FTS trigger & immutability trigger survived upgrade intact
      const ftsRow = conn.sqlite
        .prepare('SELECT "product_id" FROM "products_fts" WHERE "products_fts" MATCH ?')
        .get('"milk"*') as { readonly product_id: string } | undefined;
      expect(ftsRow?.product_id).toBe('01950000-0000-7000-8000-000000000020');

      expect(() =>
        conn.sqlite
          .prepare('DELETE FROM "products" WHERE "id" = ?')
          .run('01950000-0000-7000-8000-000000000020'),
      ).toThrow(/forbids physical DELETE/);
    } finally {
      conn.close();
    }
  });

  it('cleanly upgrades a pre-populated 0005 database (with open carts, lines & device state) to 0006 under PRAGMA foreign_keys=ON', () => {
    const migDir = getDefaultLocalMigrationsFolder();
    const partialMigDir = path.join(os.tmpdir(), `mezon-mig-0005-${Date.now()}-${Math.random()}`);
    fs.mkdirSync(path.join(partialMigDir, 'meta'), { recursive: true });
    tempDirs.push(partialMigDir);

    const journal = JSON.parse(
      fs.readFileSync(path.join(migDir, 'meta', '_journal.json'), 'utf8'),
    ) as {
      readonly version: string;
      readonly dialect: string;
      entries: Array<{ readonly idx: number; readonly tag: string }>;
    };
    const entries05 = journal.entries.filter((e) => e.idx <= 5);
    for (const entry of entries05) {
      fs.copyFileSync(
        path.join(migDir, `${entry.tag}.sql`),
        path.join(partialMigDir, `${entry.tag}.sql`),
      );
    }
    fs.writeFileSync(
      path.join(partialMigDir, 'meta', '_journal.json'),
      JSON.stringify({ ...journal, entries: entries05 }, null, 2),
    );

    const dbPath = makeTempDbPath('upgrade-0005-to-0006.db');
    const conn = openLocalSqliteDatabase(dbPath);
    try {
      migrateLocalDatabase(conn.db, partialMigDir);

      const devId = '01950000-0000-7000-8000-000000000001';
      const orgId = '01950000-0000-7000-8000-000000000011';
      const storeId = '01950000-0000-7000-8000-000000000012';
      const userId = '01950000-0000-7000-8000-000000000013';
      const cartId = '01950000-0000-7000-8000-000000000014';
      const lineId = '01950000-0000-7000-8000-000000000015';
      const hlc58 = serializeHlc(
        createHlcTimestamp(unixMsFromBigInt(1_760_000_000_000n), 0, parseUuidV7(devId)),
      );

      conn.sqlite
        .prepare(
          `INSERT INTO "local_device_state" ("id", "organization_id", "created_at_ms", "updated_at_ms", "device_id", "last_device_seq", "last_hlc", "last_uuid_ms")
           VALUES (?, ?, 1760000000000, 1760000000000, ?, 3, ?, 1760000000000)`,
        )
        .run('01950000-0000-7000-8000-000000000010', orgId, devId, hlc58);
      conn.sqlite
        .prepare(
          `INSERT INTO "users" ("id", "organization_id", "device_id", "hlc", "created_at_ms", "updated_at_ms", "deleted_at_ms", "username", "full_name", "role", "is_active")
           VALUES (?, ?, ?, ?, 1760000000000, 1760000000000, NULL, 'cashier1', 'Cashier One', 'cashier', 1)`,
        )
        .run(userId, orgId, devId, hlc58);
      conn.sqlite
        .prepare(
          `INSERT INTO "local_carts" ("id", "organization_id", "store_id", "created_at_ms", "updated_at_ms", "cashier_user_id", "status", "park_label", "parked_at_ms", "manual_discount_mode", "manual_discount_value", "manual_discount_reason", "override_approved_by_user_id", "override_approved_amount", "override_approved_at_ms")
           VALUES (?, ?, ?, 1760000000000, 1760000000000, ?, 'open', NULL, NULL, 'none', 0, NULL, NULL, NULL, NULL)`,
        )
        .run(cartId, orgId, storeId, userId);
      conn.sqlite
        .prepare(
          `INSERT INTO "local_cart_lines" ("id", "organization_id", "store_id", "created_at_ms", "updated_at_ms", "cart_id", "sort_order", "line_kind", "product_id", "variant_id", "category_id_snapshot", "item_name", "unit", "qty", "unit_price_snapshot", "mxik_snapshot", "package_code_snapshot", "vat_rate_bp_snapshot")
           VALUES (?, ?, ?, 1760000000000, 1760000000000, ?, 0, 'quick_sale', NULL, NULL, NULL, 'Fast Item', 'dona', 1000, 50000, NULL, NULL, 0)`,
        )
        .run(lineId, orgId, storeId, cartId);

      // Upgrade to 0006 cleanly under PRAGMA foreign_keys = ON inside Drizzle transaction
      migrateLocalDatabase(conn.db, migDir);

      const devRow = conn.sqlite
        .prepare(
          'SELECT "last_device_seq", "last_receipt_seq", "last_return_seq", "last_receiving_seq", "last_supplier_return_seq" FROM "local_device_state" WHERE "device_id" = ?',
        )
        .get(devId) as {
        readonly last_device_seq: bigint;
        readonly last_receipt_seq: bigint;
        readonly last_return_seq: bigint;
        readonly last_receiving_seq: bigint;
        readonly last_supplier_return_seq: bigint;
      };
      expect(devRow.last_device_seq).toBe(3n);
      expect(devRow.last_receipt_seq).toBe(0n);
      expect(devRow.last_return_seq).toBe(0n);
      expect(devRow.last_receiving_seq).toBe(0n);
      expect(devRow.last_supplier_return_seq).toBe(0n);

      const lineRow = conn.sqlite
        .prepare('SELECT "item_name", "unit_price_snapshot" FROM "local_cart_lines" WHERE "id" = ?')
        .get(lineId) as { readonly item_name: string; readonly unit_price_snapshot: bigint };
      expect(lineRow.item_name).toBe('Fast Item');
      expect(lineRow.unit_price_snapshot).toBe(50_000n);
    } finally {
      conn.close();
    }
  });

  it('cleanly upgrades a pre-populated 0007 database (with sales, sale_lines, payments, cash_moves) to 0008 under PRAGMA foreign_keys=ON', () => {
    const migDir = getDefaultLocalMigrationsFolder();
    const partialMigDir = path.join(os.tmpdir(), `mezon-mig-0007-${Date.now()}-${Math.random()}`);
    fs.mkdirSync(path.join(partialMigDir, 'meta'), { recursive: true });
    tempDirs.push(partialMigDir);

    const journal = JSON.parse(
      fs.readFileSync(path.join(migDir, 'meta', '_journal.json'), 'utf8'),
    ) as {
      readonly version: string;
      readonly dialect: string;
      entries: Array<{ readonly idx: number; readonly tag: string }>;
    };
    const entries07 = journal.entries.filter((e) => e.idx <= 7);
    for (const entry of entries07) {
      fs.copyFileSync(
        path.join(migDir, `${entry.tag}.sql`),
        path.join(partialMigDir, `${entry.tag}.sql`),
      );
    }
    fs.writeFileSync(
      path.join(partialMigDir, 'meta', '_journal.json'),
      JSON.stringify({ ...journal, entries: entries07 }, null, 2),
    );

    const dbPath = makeTempDbPath('upgrade-0007-to-0008.db');
    const conn = openLocalSqliteDatabase(dbPath);
    try {
      migrateLocalDatabase(conn.db, partialMigDir);

      const devId = '01950000-0000-7000-8000-000000000001';
      const orgId = '01950000-0000-7000-8000-000000000011';
      const storeId = '01950000-0000-7000-8000-000000000012';
      const userId = '01950000-0000-7000-8000-000000000013';
      const saleId = '01950000-0000-7000-8000-000000000014';
      const saleLineId = '01950000-0000-7000-8000-000000000015';
      const payId = '01950000-0000-7000-8000-000000000016';
      const cashMoveId = '01950000-0000-7000-8000-000000000017';
      const hlc58 = serializeHlc(
        createHlcTimestamp(unixMsFromBigInt(1_760_000_000_000n), 0, parseUuidV7(devId)),
      );

      conn.sqlite
        .prepare(
          `INSERT INTO "local_device_state" ("id", "organization_id", "created_at_ms", "updated_at_ms", "device_id", "last_device_seq", "last_receipt_seq", "last_hlc", "last_uuid_ms")
           VALUES (?, ?, 1760000000000, 1760000000000, ?, 4, 1, ?, 1760000000000)`,
        )
        .run('01950000-0000-7000-8000-000000000010', orgId, devId, hlc58);
      conn.sqlite
        .prepare(
          `INSERT INTO "local_hub_config" ("id", "organization_id", "created_at_ms", "updated_at_ms", "store_id", "device_id", "singleton_guard", "setup_completed_at_ms")
           VALUES (?, ?, 1760000000000, 1760000000000, ?, ?, 1, 1760000000000)`,
        )
        .run('01950000-0000-7000-8000-000000000020', orgId, storeId, devId);
      conn.sqlite
        .prepare(
          `INSERT INTO "users" ("id", "organization_id", "device_id", "hlc", "created_at_ms", "updated_at_ms", "deleted_at_ms", "username", "full_name", "role", "is_active")
           VALUES (?, ?, ?, ?, 1760000000000, 1760000000000, NULL, 'cashier1', 'Cashier One', 'cashier', 1)`,
        )
        .run(userId, orgId, devId, hlc58);
      conn.sqlite
        .prepare(
          `INSERT INTO "sales" ("id", "organization_id", "store_id", "device_id", "hlc", "created_at_ms", "updated_at_ms", "receipt_no", "receipt_code", "source_cart_id", "cashier_user_id", "completed_by_user_id", "customer_id", "shift_id", "client_request_id", "request_hash", "subtotal_gross", "total_promo_discount", "subtotal_after_promo", "manual_discount_mode", "manual_discount_value", "manual_discount_reason", "order_discount_amount", "total_final", "total_net_ex_vat", "total_vat", "total_paid", "debt_amount", "change_amount", "override_approved_by_user_id", "override_approved_amount", "override_approved_at_ms", "voided_at_ms", "voided_by_user_id", "void_reason")
           VALUES (?, ?, ?, ?, ?, 1760000000000, 1760000000000, 1, '0001-000001', NULL, ?, ?, NULL, NULL, ?, 'hash007', 10000, 0, 10000, 'none', 0, NULL, 0, 10000, 10000, 0, 10000, 0, 0, NULL, NULL, NULL, NULL, NULL, NULL)`,
        )
        .run(
          saleId,
          orgId,
          storeId,
          devId,
          hlc58,
          userId,
          userId,
          '01950000-0000-7000-8000-000000000030',
        );
      conn.sqlite
        .prepare(
          `INSERT INTO "sale_lines" ("id", "organization_id", "store_id", "device_id", "hlc", "created_at_ms", "sale_id", "sort_order", "line_kind", "product_id", "variant_id", "category_id_snapshot", "item_name", "unit", "qty", "unit_price_snapshot", "applied_promotion_id", "applied_promotion_name", "free_units", "gross_total", "promo_discount", "subtotal_after_promo", "allocated_order_discount", "final_total", "vat_rate_bp_snapshot", "net_ex_vat", "vat_total", "mxik_snapshot", "package_code_snapshot", "cost_value")
           VALUES (?, ?, ?, ?, ?, 1760000000000, ?, 0, 'quick_sale', NULL, NULL, NULL, 'Fast Item', 'dona', 1000, 10000, NULL, NULL, 0, 10000, 0, 10000, 0, 10000, 0, 10000, 0, NULL, NULL, 0)`,
        )
        .run(saleLineId, orgId, storeId, devId, hlc58, saleId);
      conn.sqlite
        .prepare(
          `INSERT INTO "payments" ("id", "organization_id", "store_id", "device_id", "hlc", "created_at_ms", "sale_id", "method", "amount", "tendered_amount", "change_amount", "provider_ref", "provider_meta_json")
           VALUES (?, ?, ?, ?, ?, 1760000000000, ?, 'cash', 10000, 10000, 0, NULL, NULL)`,
        )
        .run(payId, orgId, storeId, devId, hlc58, saleId);
      conn.sqlite
        .prepare(
          `INSERT INTO "cash_moves" ("id", "organization_id", "store_id", "device_id", "hlc", "created_at_ms", "shift_id", "type", "amount_delta", "source_type", "source_id", "payment_id", "reason", "created_by_user_id")
           VALUES (?, ?, ?, ?, ?, 1760000000000, NULL, 'sale_cash_in', 10000, 'sale', ?, ?, 'Cash', ?)`,
        )
        .run(cashMoveId, orgId, storeId, devId, hlc58, saleId, payId, userId);

      // Upgrade pre-populated 0007 DB to 0008 under PRAGMA foreign_keys = ON
      migrateLocalDatabase(conn.db, migDir);
      expect(conn.sqlite.pragma('foreign_key_check')).toEqual([]);

      const viewRows = conn.sqlite
        .prepare('SELECT "record_kind", "sign", "signed_final_total" FROM "v_sales_lines"')
        .all() as readonly {
        readonly record_kind: string;
        readonly sign: bigint;
        readonly signed_final_total: bigint;
      }[];
      expect(viewRows).toEqual([{ record_kind: 'sale', sign: 1n, signed_final_total: 10000n }]);

      const cfgRow = conn.sqlite
        .prepare(
          'SELECT "store_timezone", "default_customer_due_days", "default_supplier_due_days" FROM "local_hub_config" WHERE "singleton_guard" = 1',
        )
        .get() as {
        readonly store_timezone: string;
        readonly default_customer_due_days: bigint | null;
        readonly default_supplier_due_days: bigint | null;
      };
      expect(cfgRow.store_timezone).toBe('Asia/Tashkent');
      expect(cfgRow.default_customer_due_days).toBe(14n);
      expect(cfgRow.default_supplier_due_days).toBe(14n);

      // Existing immutability & void triggers survived upgrade intact
      expect(() =>
        conn.sqlite
          .prepare('UPDATE "sales" SET "void_reason" = \'hack\' WHERE "id" = ?')
          .run(saleId),
      ).toThrow(/MONOTONE/);
    } finally {
      conn.close();
    }
  });

  it('cleanly upgrades a pre-populated 0009 database (with customers, customer_ledger -> cash_moves FK) to 0010 under PRAGMA foreign_keys=ON', () => {
    const migDir = getDefaultLocalMigrationsFolder();
    const partialMigDir = path.join(os.tmpdir(), `mezon-mig-0009-${Date.now()}-${Math.random()}`);
    fs.mkdirSync(path.join(partialMigDir, 'meta'), { recursive: true });
    tempDirs.push(partialMigDir);

    const journal = JSON.parse(
      fs.readFileSync(path.join(migDir, 'meta', '_journal.json'), 'utf8'),
    ) as {
      readonly version: string;
      readonly dialect: string;
      entries: Array<{ readonly idx: number; readonly tag: string }>;
    };
    const entries09 = journal.entries.filter((e) => e.idx <= 9);
    for (const entry of entries09) {
      fs.copyFileSync(
        path.join(migDir, `${entry.tag}.sql`),
        path.join(partialMigDir, `${entry.tag}.sql`),
      );
    }
    fs.writeFileSync(
      path.join(partialMigDir, 'meta', '_journal.json'),
      JSON.stringify({ ...journal, entries: entries09 }, null, 2),
    );

    const dbPath = makeTempDbPath('upgrade-0009-to-0010.db');
    const conn = openLocalSqliteDatabase(dbPath);
    try {
      migrateLocalDatabase(conn.db, partialMigDir);

      const devId = '01950000-0000-7000-8000-000000000101';
      const orgId = '01950000-0000-7000-8000-000000000111';
      const storeId = '01950000-0000-7000-8000-000000000112';
      const userId = '01950000-0000-7000-8000-000000000113';
      const custId = '01950000-0000-7000-8000-000000000114';
      const cashMoveId = '01950000-0000-7000-8000-000000000115';
      const ledgerId = '01950000-0000-7000-8000-000000000116';
      const hlc58 = serializeHlc(
        createHlcTimestamp(unixMsFromBigInt(1_760_000_000_000n), 0, parseUuidV7(devId)),
      );

      conn.sqlite
        .prepare(
          `INSERT INTO "local_device_state" ("id", "organization_id", "created_at_ms", "updated_at_ms", "device_id", "last_device_seq", "last_receipt_seq", "last_return_seq", "last_hlc", "last_uuid_ms")
           VALUES (?, ?, 1760000000000, 1760000000000, ?, 2, 0, 0, ?, 1760000000000)`,
        )
        .run('01950000-0000-7000-8000-000000000110', orgId, devId, hlc58);
      conn.sqlite
        .prepare(
          `INSERT INTO "local_hub_config" ("id", "organization_id", "created_at_ms", "updated_at_ms", "store_id", "device_id", "singleton_guard", "setup_completed_at_ms")
           VALUES (?, ?, 1760000000000, 1760000000000, ?, ?, 1, 1760000000000)`,
        )
        .run('01950000-0000-7000-8000-000000000120', orgId, storeId, devId);
      conn.sqlite
        .prepare(
          `INSERT INTO "users" ("id", "organization_id", "device_id", "hlc", "created_at_ms", "updated_at_ms", "deleted_at_ms", "username", "full_name", "role", "is_active")
           VALUES (?, ?, ?, ?, 1760000000000, 1760000000000, NULL, 'cashier1', 'Cashier One', 'cashier', 1)`,
        )
        .run(userId, orgId, devId, hlc58);
      conn.sqlite
        .prepare(
          `INSERT INTO "customers" ("id", "organization_id", "device_id", "hlc", "created_at_ms", "updated_at_ms", "deleted_at_ms", "full_name", "name_search", "is_active")
           VALUES (?, ?, ?, ?, 1760000000000, 1760000000000, NULL, 'Sardor', 'sardor', 1)`,
        )
        .run(custId, orgId, devId, hlc58);
      conn.sqlite
        .prepare(
          `INSERT INTO "cash_moves" ("id", "organization_id", "store_id", "device_id", "hlc", "created_at_ms", "shift_id", "type", "amount_delta", "source_type", "source_id", "payment_id", "reason", "created_by_user_id")
           VALUES (?, ?, ?, ?, ?, 1760000000000, NULL, 'debt_payment_in', 5000, 'debt_payment', ?, NULL, 'In', ?)`,
        )
        .run(cashMoveId, orgId, storeId, devId, hlc58, custId, userId);
      conn.sqlite
        .prepare(
          `INSERT INTO "customer_ledger" ("id", "organization_id", "store_id", "device_id", "hlc", "created_at_ms", "customer_id", "entry_type", "amount_delta", "source_type", "source_id", "sale_id", "payment_method", "provider_ref", "cash_move_id", "due_at_ms", "reason", "created_by_user_id", "override_approved_by_user_id")
           VALUES (?, ?, ?, ?, ?, 1760000000000, ?, 'debt_payment', -5000, 'debt_payment', ?, NULL, 'cash', NULL, ?, NULL, 'Payment', ?, NULL)`,
        )
        .run(ledgerId, orgId, storeId, devId, hlc58, custId, custId, cashMoveId, userId);

      // Upgrade 0009 -> 0010 under PRAGMA foreign_keys = ON (cash_moves rebuilt)
      migrateLocalDatabase(conn.db, migDir);
      expect(conn.sqlite.pragma('foreign_key_check')).toEqual([]);

      const cashRow = conn.sqlite
        .prepare('SELECT "id", "amount_delta" FROM "cash_moves" WHERE "id" = ?')
        .get(cashMoveId) as { readonly id: string; readonly amount_delta: bigint } | undefined;
      expect(cashRow).toEqual({ id: cashMoveId, amount_delta: 5000n });

      const clRow = conn.sqlite
        .prepare('SELECT "id", "cash_move_id" FROM "customer_ledger" WHERE "id" = ?')
        .get(ledgerId) as { readonly id: string; readonly cash_move_id: string | null } | undefined;
      expect(clRow).toEqual({ id: ledgerId, cash_move_id: cashMoveId });
    } finally {
      conn.close();
    }
  });

  it('cleanly upgrades a pre-populated 0010 database to 0011 preserving data, defaults & FKs', () => {
    const migDir = getDefaultLocalMigrationsFolder();
    const partialMigDir = path.join(os.tmpdir(), `mezon-mig-0010-${Date.now()}-${Math.random()}`);
    fs.mkdirSync(path.join(partialMigDir, 'meta'), { recursive: true });
    tempDirs.push(partialMigDir);

    const journal = JSON.parse(
      fs.readFileSync(path.join(migDir, 'meta', '_journal.json'), 'utf8'),
    ) as {
      readonly version: string;
      readonly dialect: string;
      entries: Array<{ readonly idx: number; readonly tag: string }>;
    };
    const entries10 = journal.entries.filter((e) => e.idx <= 10);
    for (const entry of entries10) {
      fs.copyFileSync(
        path.join(migDir, `${entry.tag}.sql`),
        path.join(partialMigDir, `${entry.tag}.sql`),
      );
    }
    fs.writeFileSync(
      path.join(partialMigDir, 'meta', '_journal.json'),
      JSON.stringify({ ...journal, entries: entries10 }, null, 2),
    );

    const dbPath = makeTempDbPath('upgrade-0010-to-0011.db');
    const conn = openLocalSqliteDatabase(dbPath);
    try {
      migrateLocalDatabase(conn.db, partialMigDir);

      const devId = '01950000-0000-7000-8000-000000000201';
      const orgId = '01950000-0000-7000-8000-000000000211';
      const storeId = '01950000-0000-7000-8000-000000000212';
      const userId = '01950000-0000-7000-8000-000000000213';
      const cashMoveId = '01950000-0000-7000-8000-000000000215';
      const hlc58 = serializeHlc(
        createHlcTimestamp(unixMsFromBigInt(1_760_000_000_000n), 0, parseUuidV7(devId)),
      );

      conn.sqlite
        .prepare(
          `INSERT INTO "local_device_state" ("id", "organization_id", "created_at_ms", "updated_at_ms", "device_id", "last_device_seq", "last_receipt_seq", "last_return_seq", "last_receiving_seq", "last_supplier_return_seq", "last_hlc", "last_uuid_ms")
           VALUES (?, ?, 1760000000000, 1760000000000, ?, 5, 2, 1, 1, 0, ?, 1760000000000)`,
        )
        .run('01950000-0000-7000-8000-000000000210', orgId, devId, hlc58);
      conn.sqlite
        .prepare(
          `INSERT INTO "local_hub_config" ("id", "organization_id", "created_at_ms", "updated_at_ms", "store_id", "device_id", "singleton_guard", "setup_completed_at_ms")
           VALUES (?, ?, 1760000000000, 1760000000000, ?, ?, 1, 1760000000000)`,
        )
        .run('01950000-0000-7000-8000-000000000220', orgId, storeId, devId);
      conn.sqlite
        .prepare(
          `INSERT INTO "users" ("id", "organization_id", "device_id", "hlc", "created_at_ms", "updated_at_ms", "deleted_at_ms", "username", "full_name", "role", "is_active")
           VALUES (?, ?, ?, ?, 1760000000000, 1760000000000, NULL, 'cashier1', 'Cashier One', 'cashier', 1)`,
        )
        .run(userId, orgId, devId, hlc58);
      conn.sqlite
        .prepare(
          `INSERT INTO "cash_moves" ("id", "organization_id", "store_id", "device_id", "hlc", "created_at_ms", "shift_id", "type", "amount_delta", "source_type", "source_id", "payment_id", "reason", "created_by_user_id")
           VALUES (?, ?, ?, ?, ?, 1760000000000, NULL, 'cash_in', 75000, 'manual', ?, NULL, 'Legacy in', ?)`,
        )
        .run(cashMoveId, orgId, storeId, devId, hlc58, userId, userId);

      migrateLocalDatabase(conn.db, migDir);
      expect(conn.sqlite.pragma('foreign_key_check')).toEqual([]);

      const devRow = conn.sqlite
        .prepare(
          'SELECT "last_shift_seq", "last_device_seq" FROM "local_device_state" WHERE "device_id" = ?',
        )
        .get(devId) as { readonly last_shift_seq: bigint; readonly last_device_seq: bigint };
      expect(devRow).toEqual({ last_shift_seq: 0n, last_device_seq: 5n });

      const hubCfg = conn.sqlite
        .prepare(
          'SELECT "max_cash_discrepancy_without_override" FROM "local_hub_config" WHERE "singleton_guard" = 1',
        )
        .get() as { readonly max_cash_discrepancy_without_override: bigint };
      expect(hubCfg.max_cash_discrepancy_without_override).toBe(1_000_000n);

      const moveRow = conn.sqlite
        .prepare(
          'SELECT "id", "shift_cashier_session_id", "expense_category" FROM "cash_moves" WHERE "id" = ?',
        )
        .get(cashMoveId) as {
        readonly id: string;
        readonly shift_cashier_session_id: string | null;
        readonly expense_category: string | null;
      };
      expect(moveRow).toEqual({
        id: cashMoveId,
        shift_cashier_session_id: null,
        expense_category: null,
      });
    } finally {
      conn.close();
    }
  });

  it('cleanly upgrades a pre-populated 0011 database (payments, cash_moves, ledgers, shift_closures) to 0012 under foreign_keys=ON', () => {
    const migDir = getDefaultLocalMigrationsFolder();
    const partialMigDir = path.join(os.tmpdir(), `mezon-mig-0011-${Date.now()}-${Math.random()}`);
    fs.mkdirSync(path.join(partialMigDir, 'meta'), { recursive: true });
    tempDirs.push(partialMigDir);

    const journal = JSON.parse(
      fs.readFileSync(path.join(migDir, 'meta', '_journal.json'), 'utf8'),
    ) as {
      readonly version: string;
      readonly dialect: string;
      entries: Array<{ readonly idx: number; readonly tag: string }>;
    };
    const entries11 = journal.entries.filter((e) => e.idx <= 11);
    for (const entry of entries11) {
      fs.copyFileSync(
        path.join(migDir, `${entry.tag}.sql`),
        path.join(partialMigDir, `${entry.tag}.sql`),
      );
    }
    fs.writeFileSync(
      path.join(partialMigDir, 'meta', '_journal.json'),
      JSON.stringify({ ...journal, entries: entries11 }, null, 2),
    );

    const dbPath = makeTempDbPath('upgrade-0011-to-0012.db');
    const conn = openLocalSqliteDatabase(dbPath);
    try {
      migrateLocalDatabase(conn.db, partialMigDir);

      const devId = '01950000-0000-7000-8000-000000000301';
      const orgId = '01950000-0000-7000-8000-000000000311';
      const storeId = '01950000-0000-7000-8000-000000000312';
      const userId = '01950000-0000-7000-8000-000000000313';
      const custId = '01950000-0000-7000-8000-000000000314';
      const saleId = '01950000-0000-7000-8000-000000000315';
      const payId = '01950000-0000-7000-8000-000000000316';
      const cmId = '01950000-0000-7000-8000-000000000317';
      const clId = '01950000-0000-7000-8000-000000000318';
      const shiftId = '01950000-0000-7000-8000-000000000319';
      const sessId = '01950000-0000-7000-8000-000000000320';
      const closureId = '01950000-0000-7000-8000-000000000321';
      const closureMethodId = '01950000-0000-7000-8000-000000000322';
      const closureCashierId = '01950000-0000-7000-8000-000000000323';
      const hlc58 = serializeHlc(
        createHlcTimestamp(unixMsFromBigInt(1_760_000_000_000n), 0, parseUuidV7(devId)),
      );

      conn.sqlite
        .prepare(
          `INSERT INTO "local_device_state" ("id", "organization_id", "created_at_ms", "updated_at_ms", "device_id", "last_device_seq", "last_receipt_seq", "last_return_seq", "last_receiving_seq", "last_supplier_return_seq", "last_shift_seq", "last_hlc", "last_uuid_ms")
           VALUES (?, ?, 1760000000000, 1760000000000, ?, 9, 1, 0, 0, 0, 1, ?, 1760000000000)`,
        )
        .run('01950000-0000-7000-8000-000000000310', orgId, devId, hlc58);
      conn.sqlite
        .prepare(
          `INSERT INTO "users" ("id", "organization_id", "device_id", "hlc", "created_at_ms", "updated_at_ms", "deleted_at_ms", "username", "full_name", "role", "is_active")
           VALUES (?, ?, ?, ?, 1760000000000, 1760000000000, NULL, 'owner11', 'Owner Eleven', 'owner', 1)`,
        )
        .run(userId, orgId, devId, hlc58);
      conn.sqlite
        .prepare(
          `INSERT INTO "customers" ("id", "organization_id", "device_id", "hlc", "created_at_ms", "updated_at_ms", "deleted_at_ms", "full_name", "name_search", "phone_normalized", "phone_digits", "credit_limit", "is_active", "note")
           VALUES (?, ?, ?, ?, 1760000000000, 1760000000000, NULL, 'Cust 11', 'cust 11', NULL, NULL, NULL, 1, NULL)`,
        )
        .run(custId, orgId, devId, hlc58);
      conn.sqlite
        .prepare(
          `INSERT INTO "shifts" ("id", "organization_id", "store_id", "device_id", "hlc", "created_at_ms", "updated_at_ms", "shift_no", "shift_code", "status", "opened_by_user_id", "closed_by_user_id", "opening_cash", "opening_discrepancy", "opened_at_ms", "closed_at_ms", "open_client_request_id", "open_request_hash", "close_client_request_id", "close_request_hash")
           VALUES (?, ?, ?, ?, ?, 1760000000000, 1760000000000, 1, 'SHF-0301-000001', 'open', ?, NULL, 0, 0, 1760000000000, NULL, ?, 'hashopen1', NULL, NULL)`,
        )
        .run(shiftId, orgId, storeId, devId, hlc58, userId, devId);
      conn.sqlite
        .prepare(
          `INSERT INTO "shift_cashier_sessions" ("id", "organization_id", "store_id", "device_id", "hlc", "created_at_ms", "updated_at_ms", "shift_id", "session_seq", "cashier_user_id", "status", "opening_float", "expected_cash", "counted_cash", "discrepancy", "started_at_ms", "ended_at_ms")
           VALUES (?, ?, ?, ?, ?, 1760000000000, 1760000001000, ?, 1, ?, 'closed', 0, 10000, 10000, 0, 1760000000000, 1760000001000)`,
        )
        .run(sessId, orgId, storeId, devId, hlc58, shiftId, userId);
      conn.sqlite
        .prepare(
          `INSERT INTO "sales" ("id", "organization_id", "store_id", "device_id", "hlc", "created_at_ms", "updated_at_ms", "receipt_no", "receipt_code", "source_cart_id", "cashier_user_id", "completed_by_user_id", "customer_id", "shift_id", "shift_cashier_session_id", "client_request_id", "request_hash", "subtotal_gross", "total_promo_discount", "subtotal_after_promo", "manual_discount_mode", "manual_discount_value", "manual_discount_reason", "order_discount_amount", "total_final", "total_net_ex_vat", "total_vat", "total_paid", "debt_amount", "change_amount")
           VALUES (?, ?, ?, ?, ?, 1760000000500, 1760000000500, 1, '0301-000001', NULL, ?, ?, ?, ?, ?, ?, 'hashsale1', 10000, 0, 10000, 'none', 0, NULL, 0, 10000, 10000, 0, 10000, 0, 0)`,
        )
        .run(saleId, orgId, storeId, devId, hlc58, userId, userId, custId, shiftId, sessId, saleId);
      conn.sqlite
        .prepare(
          `INSERT INTO "payments" ("id", "organization_id", "store_id", "device_id", "hlc", "created_at_ms", "sale_id", "method", "amount", "tendered_amount", "change_amount")
           VALUES (?, ?, ?, ?, ?, 1760000000500, ?, 'cash', 10000, 10000, 0)`,
        )
        .run(payId, orgId, storeId, devId, hlc58, saleId);
      conn.sqlite
        .prepare(
          `INSERT INTO "cash_moves" ("id", "organization_id", "store_id", "device_id", "hlc", "created_at_ms", "shift_id", "shift_cashier_session_id", "type", "amount_delta", "source_type", "source_id", "payment_id", "expense_category", "reason", "created_by_user_id")
           VALUES (?, ?, ?, ?, ?, 1760000000500, ?, ?, 'sale_cash_in', 10000, 'sale', ?, ?, NULL, 'Sale 1', ?)`,
        )
        .run(cmId, orgId, storeId, devId, hlc58, shiftId, sessId, saleId, payId, userId);
      conn.sqlite
        .prepare(
          `UPDATE "shifts" SET "status" = 'closed', "closed_by_user_id" = ?, "closed_at_ms" = 1760000001000, "close_client_request_id" = ?, "close_request_hash" = 'hashclose1', "updated_at_ms" = 1760000001000 WHERE "id" = ?`,
        )
        .run(userId, saleId, shiftId);
      conn.sqlite
        .prepare(
          `INSERT INTO "customer_ledger" ("id", "organization_id", "store_id", "device_id", "hlc", "created_at_ms", "customer_id", "entry_type", "amount_delta", "source_type", "source_id", "sale_id", "payment_method", "cash_move_id", "reason", "created_by_user_id")
           VALUES (?, ?, ?, ?, ?, 1760000000600, ?, 'debt_payment', -5000, 'debt_payment', ?, NULL, 'cash', ?, 'Paid', ?)`,
        )
        .run(clId, orgId, storeId, devId, hlc58, custId, clId, cmId, userId);
      conn.sqlite
        .prepare(
          `INSERT INTO "shift_closures" ("id", "organization_id", "store_id", "device_id", "hlc", "created_at_ms", "shift_id", "closure_seq", "is_reclose", "closed_by_user_id", "client_request_id", "request_hash", "expected_cash", "counted_cash", "discrepancy", "sales_count", "returns_count", "voids_count", "gross_sales_total", "returns_total", "net_sales_total")
           VALUES (?, ?, ?, ?, ?, 1760000001000, ?, 1, 0, ?, ?, 'hashcls1', 10000, 10000, 0, 1, 0, 0, 10000, 0, 10000)`,
        )
        .run(closureId, orgId, storeId, devId, hlc58, shiftId, userId, closureId);
      conn.sqlite
        .prepare(
          `INSERT INTO "shift_closure_method_totals" ("id", "organization_id", "store_id", "device_id", "hlc", "created_at_ms", "shift_closure_id", "method", "sales_amount", "returns_amount", "net_amount")
           VALUES (?, ?, ?, ?, ?, 1760000001000, ?, 'cash', 10000, 0, 10000)`,
        )
        .run(closureMethodId, orgId, storeId, devId, hlc58, closureId);
      conn.sqlite
        .prepare(
          `INSERT INTO "shift_closure_cashiers" ("id", "organization_id", "store_id", "device_id", "hlc", "created_at_ms", "shift_closure_id", "session_id", "cashier_user_id", "session_seq", "opening_float", "expected_cash", "counted_cash", "discrepancy", "sales_count", "returns_count", "sales_total", "returns_total", "cash_in_total", "cash_out_total")
           VALUES (?, ?, ?, ?, ?, 1760000001000, ?, ?, ?, 1, 0, 10000, 10000, 0, 1, 0, 10000, 0, 10000, 0)`,
        )
        .run(closureCashierId, orgId, storeId, devId, hlc58, closureId, sessId, userId);

      migrateLocalDatabase(conn.db, migDir);
      expect(conn.sqlite.pragma('foreign_key_check')).toEqual([]);

      const devState = conn.sqlite
        .prepare(
          'SELECT "last_order_seq", "last_shift_seq" FROM "local_device_state" WHERE "device_id" = ?',
        )
        .get(devId) as { readonly last_order_seq: bigint; readonly last_shift_seq: bigint };
      expect(devState).toEqual({ last_order_seq: 0n, last_shift_seq: 1n });

      const closureRow = conn.sqlite
        .prepare(
          'SELECT "order_advance_cash_total", "order_advance_non_cash_total", "order_advance_refund_total" FROM "shift_closures" WHERE "id" = ?',
        )
        .get(closureId) as {
        readonly order_advance_cash_total: bigint;
        readonly order_advance_non_cash_total: bigint;
        readonly order_advance_refund_total: bigint;
      };
      expect(closureRow).toEqual({
        order_advance_cash_total: 0n,
        order_advance_non_cash_total: 0n,
        order_advance_refund_total: 0n,
      });

      const saleRow = conn.sqlite
        .prepare('SELECT "source_order_id" FROM "sales" WHERE "id" = ?')
        .get(saleId) as { readonly source_order_id: string | null };
      expect(saleRow.source_order_id).toBeNull();

      // Re-created FACT triggers must still block UPDATE/DELETE on rebuilt tables
      expect(() =>
        conn.sqlite.prepare('UPDATE "payments" SET "amount" = 999 WHERE "id" = ?').run(payId),
      ).toThrowError(/FACT table "payments"/);
      expect(() =>
        conn.sqlite.prepare('DELETE FROM "cash_moves" WHERE "id" = ?').run(cmId),
      ).toThrowError(/FACT table "cash_moves"/);
      expect(() =>
        conn.sqlite
          .prepare('UPDATE "shift_closures" SET "counted_cash" = 0 WHERE "id" = ?')
          .run(closureId),
      ).toThrowError(/FACT table "shift_closures"/);
      expect(() =>
        conn.sqlite.prepare('DELETE FROM "customer_ledger" WHERE "id" = ?').run(clId),
      ).toThrowError(/FACT table "customer_ledger"/);
    } finally {
      conn.close();
    }
  });
});
