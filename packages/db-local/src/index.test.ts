import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { HlcClock, type UnixMs, parseUuidV7, serializeHlc, unixMsFromBigInt } from '@mezon/domain';
import { DeterministicUuidV7Generator, FixedClock } from '@mezon/test-utils';
import { count, eq } from 'drizzle-orm';
import { integer, numeric, real, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DB_LOCAL_PACKAGE,
  SchemaValidationError,
  SqliteSchemaRegistry,
  getDefaultLocalMigrationsFolder,
  localSchemaRegistry,
  migrateLocalDatabase,
  openLocalSqliteDatabase,
  sqliteBigint,
  sqliteBoolean,
  sqliteInt,
  sqliteMoney,
  sqliteQuantity,
  sqliteUnixMs,
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
  it('exports package marker and keeps production schema empty in T0.4', () => {
    expect(DB_LOCAL_PACKAGE).toBe('@mezon/db-local');
    expect(localSchemaRegistry.all()).toEqual([]);
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
      expect(migCountRow.cnt).toBe(1n);
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
});
