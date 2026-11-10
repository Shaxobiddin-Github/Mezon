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
  assertSqliteTriggersMigrationsComplete,
  assertStockMigrationsComplete,
  batches,
  buildAllSqliteTriggersSql,
  buildCatalogSearchFtsSql,
  buildSqliteImmutabilityTriggersSql,
  buildStockMonotoneTriggersSql,
  categories,
  getDefaultLocalMigrationsFolder,
  inventoryCountLines,
  inventoryCounts,
  localBatchBalances,
  localCartLines,
  localCarts,
  localDeviceAuthState,
  localDeviceState,
  localHubConfig,
  localOutbox,
  localPinCredentials,
  localSchemaRegistry,
  localSessions,
  localStockBalances,
  localStockConflicts,
  migrateLocalDatabase,
  openLocalSqliteDatabase,
  priceChanges,
  productBarcodes,
  productVariants,
  products,
  promotions,
  sqliteBigint,
  sqliteBoolean,
  sqliteInt,
  sqliteMoney,
  sqliteQuantity,
  sqliteUnixMs,
  stockMoves,
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
        },
        localSchemaRegistry,
      ),
    ).not.toThrow();
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
      expect(migCountRow.cnt).toBe(6n);
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
});
