import { execFileSync, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  DomainError,
  type Money,
  compareHlc,
  extractUuidV7Timestamp,
  moneyFromTiyin,
  parseHlc,
  unixMsFromBigInt,
} from '@mezon/domain';
import { DeterministicUuidV7Generator, FixedClock, SeededRandomSource } from '@mezon/test-utils';
import { eq } from 'drizzle-orm';
import { type SQLiteTable, getTableConfig, text } from 'drizzle-orm/sqlite-core';
import fc from 'fast-check';
import { afterEach, describe, expect, it } from 'vitest';
import {
  type LocalSqliteConnection,
  SqliteDeviceStateRepository,
  SqliteOutboxRepository,
  SqliteSchemaRegistry,
  SqliteUnitOfWork,
  applySqliteImmutabilityTriggers,
  createSqliteUnitOfWork,
  getSessionSqlite,
  insertAttr,
  insertFact,
  listAllOutboxRecordsSync,
  localOutbox,
  migrateLocalDatabase,
  openLocalSqliteDatabase,
  readDeviceStateRowSync,
  sqliteMoney,
  sqliteUnixMs,
  tombstoneAttr,
  updateAttr,
} from './index.js';
import { appendOutboxEventSync } from './outbox.js';

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

function makeTempDir(prefix = 'mezon-uow-test-'): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop()!, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 50,
    });
  }
});

async function expectDomainErrorAsync(
  fn: () => Promise<unknown>,
  expectedCode: string,
): Promise<DomainError> {
  try {
    await fn();
    expect.unreachable(`Expected DomainError(${expectedCode}) to be thrown`);
  } catch (err) {
    expect(err).toBeInstanceOf(DomainError);
    const domainErr = err as DomainError;
    expect(domainErr.code).toBe(expectedCode);
    return domainErr;
  }
}

function newestMtimeMs(dir: string): number {
  let maxMtime = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      maxMtime = Math.max(maxMtime, newestMtimeMs(full));
    } else if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
      maxMtime = Math.max(maxMtime, fs.statSync(full).mtimeMs);
    }
  }
  return maxMtime;
}

function ensureLocalPackagesBuiltForChild(): string {
  const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const domainRoot = path.resolve(pkgRoot, '..', 'domain');
  const domainDist = path.join(domainRoot, 'dist', 'index.js');
  const localDist = path.join(pkgRoot, 'dist', 'index.js');

  const needsDomainBuild =
    !fs.existsSync(domainDist) ||
    newestMtimeMs(path.join(domainRoot, 'src')) > fs.statSync(domainDist).mtimeMs;
  const needsLocalBuild =
    !fs.existsSync(localDist) ||
    newestMtimeMs(path.join(pkgRoot, 'src')) > fs.statSync(localDist).mtimeMs;

  if (needsDomainBuild || needsLocalBuild) {
    const repoRoot = path.resolve(pkgRoot, '..', '..');
    const tscBin = path.join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc');
    execFileSync(process.execPath, [tscBin, '-b', path.join(pkgRoot, 'tsconfig.json')], {
      cwd: repoRoot,
      stdio: 'inherit',
    });
  }

  return localDist;
}

function buildTestTables() {
  const registry = new SqliteSchemaRegistry();

  const factSales = registry.defineTable(
    { name: 'uow_test_fact_sales', tableClass: 'FACT', tenantScope: 'store' },
    (c) => ({
      ...c,
      totalTiyin: sqliteMoney('total_tiyin').notNull(),
      note: text('note').notNull(),
    }),
  );

  const attrItems = registry.defineTable(
    { name: 'uow_test_attr_items', tableClass: 'ATTR', tenantScope: 'organization' },
    (c) => ({
      ...c,
      title: text('title').notNull(),
      priceTiyin: sqliteMoney('price_tiyin').notNull(),
    }),
  );

  const monoDocs = registry.defineTable(
    {
      name: 'uow_test_monotone_docs',
      tableClass: 'MONOTONE',
      tenantScope: 'store',
      monotoneColumns: ['voided_at_ms'],
    },
    (c) => ({
      ...c,
      voidedAtMs: sqliteUnixMs('voided_at_ms'),
      label: text('label').notNull(),
    }),
  );

  return { registry, factSales, attrItems, monoDocs };
}

async function applyTestTables(
  conn: LocalSqliteConnection,
  registry: SqliteSchemaRegistry,
  tables: Record<string, SQLiteTable>,
): Promise<void> {
  const emptySnap = await generateSQLiteDrizzleJson({});
  const curSnap = await generateSQLiteDrizzleJson(tables);
  const stmts = await generateSQLiteMigration(emptySnap, curSnap);
  for (const stmt of stmts) {
    conn.sqlite.exec(stmt);
  }
  const activeNames = new Set(Object.values(tables).map((t) => getTableConfig(t).name));
  applySqliteImmutabilityTriggers(
    conn.sqlite,
    registry.all().filter((meta) => activeNames.has(meta.tableName)),
  );
}

describe('@mezon/db-local - Async UnitOfWork, Outbox, DeviceState & SQLite Triggers', () => {
  it('writes FACT/ATTR/update/tombstone with identical entity+outbox HLC, id=eventId, and BigInt JSON serialization', async () => {
    const dbPath = path.join(makeTempDir(), 'writers.db');
    const conn = openLocalSqliteDatabase(dbPath);
    const { registry, factSales, attrItems } = buildTestTables();
    const idGen = new DeterministicUuidV7Generator();
    const orgId = idGen.nextId();
    const storeId = idGen.nextId();
    const deviceId = idGen.nextId();
    const otherOrgId = idGen.nextId();

    try {
      migrateLocalDatabase(conn.db);
      await applyTestTables(conn, registry, { factSales, attrItems });

      const clock = new FixedClock(1_700_000_000_000n);
      const random = new SeededRandomSource(1);
      const uow = await createSqliteUnitOfWork({
        connection: conn,
        organizationId: orgId,
        deviceId,
        registry,
        clock,
        random,
      });

      const outboxRepo = new SqliteOutboxRepository();
      const deviceStateRepo = new SqliteDeviceStateRepository();
      const hugeMoney = moneyFromTiyin(9_007_199_254_740_993n);

      await uow.execute(async (session) => {
        const factRes = insertFact(session, factSales, {
          organizationId: orgId,
          storeId,
          values: { totalTiyin: hugeMoney, note: 'sale-1' },
        });
        expect(factRes.deviceSeq).toBe(1n);

        // Check entity row HLC equals outbox HLC (Adjustment #5)
        const storedFact = session.db
          .select()
          .from(factSales)
          .where(eq(factSales.id, factRes.entityId))
          .all()[0];
        expect(storedFact.hlc).toBe(factRes.hlc);
        expect(storedFact.totalTiyin).toBe(hugeMoney);

        const attrRes = insertAttr(session, attrItems, {
          organizationId: orgId,
          values: { title: 'Bread', priceTiyin: moneyFromTiyin(3000n) },
        });
        expect(attrRes.deviceSeq).toBe(2n);

        clock.advance(50n);
        const updRes = updateAttr(session, attrItems, {
          id: attrRes.entityId,
          organizationId: orgId,
          values: { priceTiyin: moneyFromTiyin(3500n) },
        });
        expect(updRes.deviceSeq).toBe(3n);

        const storedAttrAfterUpdate = session.db
          .select()
          .from(attrItems)
          .where(eq(attrItems.id, attrRes.entityId))
          .all()[0];
        expect(storedAttrAfterUpdate.hlc).toBe(updRes.hlc);
        expect(storedAttrAfterUpdate.priceTiyin).toBe(3500n);

        // Non-existent id within own org fails before touching device_seq
        expect(() =>
          updateAttr(session, attrItems, {
            id: idGen.nextId(),
            organizationId: orgId,
            values: { title: 'Ghost' },
          }),
        ).toThrowError(/not found, belongs to another tenant, or is already tombstoned/);

        // Organization-scoped ATTR table rejects unexpected storeId (K3.5)
        expect(() =>
          insertAttr(session, attrItems, {
            organizationId: orgId,
            storeId,
            values: { title: 'BadScope', priceTiyin: moneyFromTiyin(10n) },
          }),
        ).toThrowError(/must not receive a storeId/);

        // Store-scoped FACT table rejects omitted storeId
        expect(() =>
          insertFact(session, factSales, {
            organizationId: orgId,
            values: { totalTiyin: hugeMoney, note: 'missing-store' },
          }),
        ).toThrowError(/requires storeId/);

        // Cross-tenant write rejected immediately (K2)
        expect(() =>
          insertAttr(session, attrItems, {
            organizationId: otherOrgId,
            values: { title: 'OtherOrg', priceTiyin: moneyFromTiyin(10n) },
          }),
        ).toThrowError(DomainError);

        // Wrong class writer rejected cleanly
        expect(() =>
          insertFact(session, attrItems as unknown as typeof factSales, {
            organizationId: orgId,
            values: { totalTiyin: hugeMoney, note: 'bad' },
          }),
        ).toThrowError(/Writer expects table class "FACT"/);

        // Reserved common column override rejected
        expect(() =>
          insertAttr(session, attrItems, {
            organizationId: orgId,
            values: {
              title: 'bad',
              priceTiyin: moneyFromTiyin(1n),
              hlc: 'evil',
            } as unknown as { title: string; priceTiyin: Money },
          }),
        ).toThrowError(/must not specify managed common column "hlc"/);

        clock.advance(25n);
        const tombRes = tombstoneAttr(session, attrItems, {
          id: attrRes.entityId,
          organizationId: orgId,
        });
        expect(tombRes.deviceSeq).toBe(4n);

        // Re-updating tombstoned ATTR fails
        expect(() =>
          updateAttr(session, attrItems, {
            id: attrRes.entityId,
            organizationId: orgId,
            values: { title: 'After Tombstone' },
          }),
        ).toThrowError(/already tombstoned/);

        const pending = await outboxRepo.listPending(session);
        expect(pending).toHaveLength(4);
        expect(pending.map((e) => e.deviceSeq)).toEqual([1n, 2n, 3n, 4n]);
        expect(pending.map((e) => e.eventId)).toEqual([
          factRes.eventId,
          attrRes.eventId,
          updRes.eventId,
          tombRes.eventId,
        ]);
        // HLC equality on all 4 pairs
        expect(pending[0].hlc).toBe(storedFact.hlc);
        expect(pending[1].hlc).toBe(attrRes.hlc);
        expect(pending[2].hlc).toBe(storedAttrAfterUpdate.hlc);
        expect(pending[3].hlc).toBe(tombRes.hlc);

        // BigInt in outbox JSON payload serialized as canonical string
        expect(pending[0].payload.totalTiyin).toBe('9007199254740993');
        expect(pending[0].status).toBe('pending');
        expect(pending[0].storeId).toBe(storeId);
        expect(pending[1].storeId).toBeNull();

        const devState = await deviceStateRepo.getByDeviceId(session, deviceId);
        expect(devState?.lastDeviceSeq).toBe(4n);
        expect(devState?.lastHlc).toBe(tombRes.hlc);
      });
    } finally {
      conn.close();
    }
  });

  it('guarantees empty outbox & unconsumed deviceSeq across rollback -> commit -> rollback -> commit sequence', async () => {
    const dbPath = path.join(makeTempDir(), 'rollback-seq.db');
    const conn = openLocalSqliteDatabase(dbPath);
    const { registry, factSales, attrItems } = buildTestTables();
    const idGen = new DeterministicUuidV7Generator();
    const orgId = idGen.nextId();
    const storeId = idGen.nextId();
    const deviceId = idGen.nextId();

    try {
      migrateLocalDatabase(conn.db);
      await applyTestTables(conn, registry, { factSales, attrItems });

      const uow = await createSqliteUnitOfWork({
        connection: conn,
        organizationId: orgId,
        deviceId,
        registry,
        clock: new FixedClock(1_700_000_000_000n),
        random: new SeededRandomSource(2),
      });

      // 1. Rollback #1
      await expect(
        uow.execute(async (session) => {
          insertFact(session, factSales, {
            organizationId: orgId,
            storeId,
            values: {
              totalTiyin: moneyFromTiyin(100n),
              note: 'rb1',
            },
          });
          await Promise.resolve();
          throw new Error('rollback 1');
        }),
      ).rejects.toThrow('rollback 1');

      expect(listAllOutboxRecordsSync(conn.db)).toHaveLength(0);
      expect(readDeviceStateRowSync(conn.db, deviceId)?.lastDeviceSeq).toBe(0n);

      // 2. Commit #1 -> starts cleanly at deviceSeq 1n
      await uow.execute(async (session) => {
        const res = insertFact(session, factSales, {
          organizationId: orgId,
          storeId,
          values: { totalTiyin: moneyFromTiyin(200n), note: 'c1' },
        });
        expect(res.deviceSeq).toBe(1n);
        await Promise.resolve();
      });

      expect(listAllOutboxRecordsSync(conn.db).map((r) => r.deviceSeq)).toEqual([1n]);
      expect(readDeviceStateRowSync(conn.db, deviceId)?.lastDeviceSeq).toBe(1n);

      // 3. Rollback #2 with non-Error throw value
      await expect(
        uow.execute(async (session) => {
          insertAttr(session, attrItems, {
            organizationId: orgId,
            values: {
              title: 'rb2',
              priceTiyin: moneyFromTiyin(50n),
            },
          });
          await Promise.resolve();
          // eslint-disable-next-line @typescript-eslint/only-throw-error -- explicitly testing non-Error throw per T0.5 Adjustment #3
          throw 'string-error-rollback';
        }),
      ).rejects.toBe('string-error-rollback');

      expect(listAllOutboxRecordsSync(conn.db).map((r) => r.deviceSeq)).toEqual([1n]);
      expect(readDeviceStateRowSync(conn.db, deviceId)?.lastDeviceSeq).toBe(1n);

      // 4. Commit #2 -> continues gaplessly at 2n, 3n
      await uow.execute(async (session) => {
        const r2 = insertFact(session, factSales, {
          organizationId: orgId,
          storeId,
          values: { totalTiyin: moneyFromTiyin(300n), note: 'c2' },
        });
        const r3 = insertAttr(session, attrItems, {
          organizationId: orgId,
          values: {
            title: 'kept',
            priceTiyin: moneyFromTiyin(99n),
          },
        });
        expect(r2.deviceSeq).toBe(2n);
        expect(r3.deviceSeq).toBe(3n);
        await Promise.resolve();
      });

      expect(listAllOutboxRecordsSync(conn.db).map((r) => r.deviceSeq)).toEqual([1n, 2n, 3n]);
      expect(readDeviceStateRowSync(conn.db, deviceId)?.lastDeviceSeq).toBe(3n);
    } finally {
      conn.close();
    }
  });

  it('isolates nested SAVEPOINT rollback from outer transaction without leaking writes or deviceSeq gaps', async () => {
    const dbPath = path.join(makeTempDir(), 'savepoint.db');
    const conn = openLocalSqliteDatabase(dbPath);
    const { registry, factSales, attrItems } = buildTestTables();
    const idGen = new DeterministicUuidV7Generator();
    const orgId = idGen.nextId();
    const storeId = idGen.nextId();
    const deviceId = idGen.nextId();

    try {
      migrateLocalDatabase(conn.db);
      await applyTestTables(conn, registry, { factSales, attrItems });

      const uow = await createSqliteUnitOfWork({
        connection: conn,
        organizationId: orgId,
        deviceId,
        registry,
        clock: new FixedClock(1_700_000_000_000n),
        random: new SeededRandomSource(3),
      });

      await uow.execute(async (session) => {
        const outer1 = insertFact(session, factSales, {
          organizationId: orgId,
          storeId,
          values: {
            totalTiyin: moneyFromTiyin(1000n),
            note: 'keep-1',
          },
        });
        expect(outer1.deviceSeq).toBe(1n);

        // Failing nested savepoint (with nested child inside it too) must roll back completely
        await expect(
          session.nested(async (inner) => {
            insertFact(inner, factSales, {
              organizationId: orgId,
              storeId,
              values: {
                totalTiyin: moneyFromTiyin(2000n),
                note: 'abort-inner',
              },
            });
            await inner.nested(async (deep) => {
              insertAttr(deep, attrItems, {
                organizationId: orgId,
                values: {
                  title: 'abort-deep',
                  priceTiyin: moneyFromTiyin(10n),
                },
              });
              await Promise.resolve();
            });
            throw new Error('inner savepoint boom');
          }),
        ).rejects.toThrow('inner savepoint boom');

        // Outer continues allocating directly at deviceSeq 2n (rolled back inner 2n, 3n never existed)
        const outer2 = insertAttr(session, attrItems, {
          organizationId: orgId,
          values: {
            title: 'keep-2',
            priceTiyin: moneyFromTiyin(3000n),
          },
        });
        expect(outer2.deviceSeq).toBe(2n);

        // Committing nested savepoint succeeds cleanly at 3n
        await session.nested(async (innerOk) => {
          const innerOkRes = updateAttr(innerOk, attrItems, {
            id: outer2.entityId,
            organizationId: orgId,
            values: { title: 'keep-2-updated' },
          });
          expect(innerOkRes.deviceSeq).toBe(3n);
          await Promise.resolve();
        });
      });

      const facts = conn.db.select().from(factSales).all();
      const attrs = conn.db.select().from(attrItems).all();
      const outbox = listAllOutboxRecordsSync(conn.db);

      expect(facts.map((f) => f.note)).toEqual(['keep-1']);
      expect(attrs.map((a) => a.title)).toEqual(['keep-2-updated']);
      expect(outbox.map((e) => e.deviceSeq)).toEqual([1n, 2n, 3n]);
      expect(readDeviceStateRowSync(conn.db, deviceId)?.lastDeviceSeq).toBe(3n);
    } finally {
      conn.close();
    }
  });

  it('rejects reentrant execute()/runReadOnly() immediately without deadlock, rejects stale sessions, and serializes parallel await UoWs', async () => {
    const dbPath = path.join(makeTempDir(), 'concurrency.db');
    const conn = openLocalSqliteDatabase(dbPath);
    const { registry, factSales, attrItems } = buildTestTables();
    const idGen = new DeterministicUuidV7Generator();
    const orgId = idGen.nextId();
    const storeId = idGen.nextId();
    const deviceId = idGen.nextId();

    try {
      migrateLocalDatabase(conn.db);
      await applyTestTables(conn, registry, { factSales, attrItems });

      const uow = await createSqliteUnitOfWork({
        connection: conn,
        organizationId: orgId,
        deviceId,
        registry,
        clock: new FixedClock(1_700_000_000_000n),
        random: new SeededRandomSource(4),
      });

      // 1. Reentrancy detection completes rapidly (< 1s, never waits on self-mutex)
      let leakedSession: Parameters<Parameters<SqliteUnitOfWork['execute']>[0]>[0] | undefined;
      await uow.execute(async (session) => {
        leakedSession = session;
        await expectDomainErrorAsync(
          () => uow.execute(async () => Promise.resolve()),
          'UNIT_OF_WORK_REENTRANCY',
        );
        await expectDomainErrorAsync(
          () => uow.runReadOnly(async () => Promise.resolve()),
          'UNIT_OF_WORK_REENTRANCY',
        );
      });

      // 2. Stale session cannot write or start nested tx outside scope
      expect(leakedSession?.isClosed()).toBe(true);
      expect(() =>
        insertFact(leakedSession!, factSales, {
          organizationId: orgId,
          storeId,
          values: { totalTiyin: moneyFromTiyin(1n), note: 'stale' },
        }),
      ).toThrowError(DomainError);

      await expectDomainErrorAsync(
        () =>
          leakedSession!.nested(async () => {
            await Promise.resolve();
          }),
        'UNIT_OF_WORK_SESSION_CLOSED',
      );

      // 3. Interleaved parallel UoWs + runReadOnly serialize strictly via FIFO mutex
      let activeWorkers = 0;
      let maxObservedConcurrent = 0;
      const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

      const results = await Promise.allSettled([
        uow.execute(async (s) => {
          activeWorkers += 1;
          maxObservedConcurrent = Math.max(maxObservedConcurrent, activeWorkers);
          insertFact(s, factSales, {
            organizationId: orgId,
            storeId,
            values: { totalTiyin: moneyFromTiyin(10n), note: 'p1' },
          });
          await delay(25);
          expect(activeWorkers).toBe(1);
          activeWorkers -= 1;
          return 'p1';
        }),
        uow.execute(async (s) => {
          activeWorkers += 1;
          maxObservedConcurrent = Math.max(maxObservedConcurrent, activeWorkers);
          insertFact(s, factSales, {
            organizationId: orgId,
            storeId,
            values: {
              totalTiyin: moneyFromTiyin(20n),
              note: 'p2-fail',
            },
          });
          await delay(10);
          activeWorkers -= 1;
          throw new Error('p2 aborted cleanly');
        }),
        uow.runReadOnly(async () => {
          activeWorkers += 1;
          maxObservedConcurrent = Math.max(maxObservedConcurrent, activeWorkers);
          await delay(5);
          // Must only see p1 committed (never p2's uncommitted row)
          const countNow = conn.db.select().from(factSales).all().length;
          activeWorkers -= 1;
          return countNow;
        }),
        uow.execute(async (s) => {
          activeWorkers += 1;
          maxObservedConcurrent = Math.max(maxObservedConcurrent, activeWorkers);
          insertFact(s, factSales, {
            organizationId: orgId,
            storeId,
            values: { totalTiyin: moneyFromTiyin(30n), note: 'p3' },
          });
          await delay(5);
          activeWorkers -= 1;
          return 'p3';
        }),
      ]);

      expect(maxObservedConcurrent).toBe(1);
      expect(results[0]).toEqual({ status: 'fulfilled', value: 'p1' });
      expect(results[1].status).toBe('rejected');
      expect(results[2]).toEqual({ status: 'fulfilled', value: 1 });
      expect(results[3]).toEqual({ status: 'fulfilled', value: 'p3' });

      expect(
        conn.db
          .select()
          .from(factSales)
          .all()
          .map((r) => r.note),
      ).toEqual(['p1', 'p3']);
      expect(listAllOutboxRecordsSync(conn.db).map((r) => r.deviceSeq)).toEqual([1n, 2n]);
    } finally {
      conn.close();
    }
  });

  it('releases mutex and rolls back cleanly when COMMIT itself fails (deferred FOREIGN KEY violation)', async () => {
    const dbPath = path.join(makeTempDir(), 'commit-fail.db');
    const conn = openLocalSqliteDatabase(dbPath);
    const { registry, factSales } = buildTestTables();
    const idGen = new DeterministicUuidV7Generator();
    const orgId = idGen.nextId();
    const storeId = idGen.nextId();
    const deviceId = idGen.nextId();

    try {
      migrateLocalDatabase(conn.db);
      await applyTestTables(conn, registry, { factSales });
      conn.sqlite.exec(`
        CREATE TABLE test_parent (id TEXT PRIMARY KEY NOT NULL);
        CREATE TABLE test_child (
          id TEXT PRIMARY KEY NOT NULL,
          parent_id TEXT NOT NULL REFERENCES test_parent(id) DEFERRABLE INITIALLY DEFERRED
        );
      `);

      const uow = await createSqliteUnitOfWork({
        connection: conn,
        organizationId: orgId,
        deviceId,
        registry,
        clock: new FixedClock(1_700_000_000_000n),
        random: new SeededRandomSource(5),
      });

      // COMMIT itself fails due to unresolved deferred FK constraint
      await expect(
        uow.execute(async (session) => {
          insertFact(session, factSales, {
            organizationId: orgId,
            storeId,
            values: {
              totalTiyin: moneyFromTiyin(500n),
              note: 'should-rollback-on-commit-fail',
            },
          });
          getSessionSqlite(session)
            .prepare('INSERT INTO test_child (id, parent_id) VALUES (?, ?)')
            .run('c1', 'missing-parent');
          await Promise.resolve();
        }),
      ).rejects.toThrowError(/FOREIGN KEY constraint failed/);

      expect(conn.sqlite.inTransaction).toBe(false);
      expect(conn.db.select().from(factSales).all()).toHaveLength(0);
      expect(listAllOutboxRecordsSync(conn.db)).toHaveLength(0);
      expect(readDeviceStateRowSync(conn.db, deviceId)?.lastDeviceSeq).toBe(0n);

      // Subsequent UoW MUST acquire mutex immediately and commit cleanly
      await uow.execute(async (session) => {
        const okRes = insertFact(session, factSales, {
          organizationId: orgId,
          storeId,
          values: {
            totalTiyin: moneyFromTiyin(700n),
            note: 'recovered',
          },
        });
        expect(okRes.deviceSeq).toBe(1n);
        await Promise.resolve();
      });

      expect(
        conn.db
          .select()
          .from(factSales)
          .all()
          .map((r) => r.note),
      ).toEqual(['recovered']);
      expect(listAllOutboxRecordsSync(conn.db).map((r) => r.deviceSeq)).toEqual([1n]);
    } finally {
      conn.close();
    }
  });

  it('recovers cleanly with 0 half-writes from sqlite.close() AND abrupt child process crash (process.exit without close)', async () => {
    const dir = makeTempDir('mezon-crash-');
    const dbPath = path.join(dir, 'crash.db');
    const { registry, factSales } = buildTestTables();
    const idGen = new DeterministicUuidV7Generator();
    const orgId = idGen.nextId();
    const storeId = idGen.nextId();
    const deviceId = idGen.nextId();

    // Part A: mid-tx forced sqlite.close() leaves zero uncommitted writes
    const connA = openLocalSqliteDatabase(dbPath);
    try {
      migrateLocalDatabase(connA.db);
      await applyTestTables(connA, registry, { factSales });

      const uowA = await createSqliteUnitOfWork({
        connection: connA,
        organizationId: orgId,
        deviceId,
        registry,
        clock: new FixedClock(1_700_000_000_000n),
        random: new SeededRandomSource(6),
      });

      await uowA.execute(async (session) => {
        insertFact(session, factSales, {
          organizationId: orgId,
          storeId,
          values: {
            totalTiyin: moneyFromTiyin(111n),
            note: 'committed-1',
          },
        });
        await Promise.resolve();
      });

      await expect(
        uowA.execute(async (session) => {
          insertFact(session, factSales, {
            organizationId: orgId,
            storeId,
            values: {
              totalTiyin: moneyFromTiyin(222n),
              note: 'forced-close',
            },
          });
          await Promise.resolve();
          getSessionSqlite(session).close();
        }),
      ).rejects.toThrow();
    } finally {
      connA.close();
    }

    // Part B: Real OS process crash via child node process calling process.exit(42) inside active UoW without closing sqlite
    const builtDistIndex = ensureLocalPackagesBuiltForChild();
    const domainDistUrl = pathToFileURL(
      path.resolve(path.dirname(builtDistIndex), '..', '..', 'domain', 'dist', 'index.js'),
    ).href;
    const dbLocalDistUrl = pathToFileURL(builtDistIndex).href;
    const workerScriptPath = path.join(dir, 'crash-worker.mjs');

    fs.writeFileSync(
      workerScriptPath,
      `
      import { createRequire } from 'node:module';
      import {
        SqliteSchemaRegistry,
        sqliteMoney,
        openLocalSqliteDatabase,
        createSqliteUnitOfWork,
        insertFact,
      } from ${JSON.stringify(dbLocalDistUrl)};
      import { parseUuidV7 } from ${JSON.stringify(domainDistUrl)};

      const localReq = createRequire(${JSON.stringify(dbLocalDistUrl)});
      const { text } = localReq('drizzle-orm/sqlite-core');

      const [dbPath, orgId, storeId, deviceId] = process.argv.slice(2);
      const registry = new SqliteSchemaRegistry();
      const factSales = registry.defineTable(
        { name: 'uow_test_fact_sales', tableClass: 'FACT', tenantScope: 'store' },
        (c) => ({
          ...c,
          totalTiyin: sqliteMoney('total_tiyin').notNull(),
          note: text('note').notNull(),
        }),
      );

      const clock = { now: () => 1_700_000_100_000n };
      const random = { nextBytes: (n) => new Uint8Array(n).fill(7) };
      const conn = openLocalSqliteDatabase(dbPath);
      const uow = await createSqliteUnitOfWork({
        connection: conn,
        organizationId: parseUuidV7(orgId),
        deviceId: parseUuidV7(deviceId),
        registry,
        clock,
        random,
      });

      await uow.execute(async (session) => {
        const res = insertFact(session, factSales, {
          organizationId: parseUuidV7(orgId),
          storeId: parseUuidV7(storeId),
          values: { totalTiyin: 999n, note: 'crashed-mid-tx' },
        });
        process.stdout.write(JSON.stringify({ inTx: conn.sqlite.inTransaction, seq: res.deviceSeq.toString() }));
        // Simulate hard process death mid-transaction with open file handle and uncommitted WAL frames
        process.exit(42);
      });
      `,
      'utf8',
    );

    const childRes = spawnSync(
      process.execPath,
      [workerScriptPath, dbPath, orgId, storeId, deviceId],
      { encoding: 'utf8', timeout: 20_000 },
    );
    expect(childRes.status, childRes.stderr).toBe(42);
    expect(JSON.parse(childRes.stdout.trim())).toEqual({ inTx: true, seq: '2' });

    // Reopen DB in parent after crash -> verify uncommitted writes gone & deviceSeq continues gaplessly at 2n
    const connRecovered = openLocalSqliteDatabase(dbPath);
    try {
      const uowRecovered = await createSqliteUnitOfWork({
        connection: connRecovered,
        organizationId: orgId,
        deviceId,
        registry,
        clock: new FixedClock(1_700_000_200_000n),
        random: new SeededRandomSource(8),
      });

      const factsBefore = connRecovered.db.select().from(factSales).all();
      const outboxBefore = listAllOutboxRecordsSync(connRecovered.db);
      expect(factsBefore.map((f) => f.note)).toEqual(['committed-1']);
      expect(outboxBefore.map((o) => o.deviceSeq)).toEqual([1n]);
      expect(readDeviceStateRowSync(connRecovered.db, deviceId)?.lastDeviceSeq).toBe(1n);

      await uowRecovered.execute(async (session) => {
        const res = insertFact(session, factSales, {
          organizationId: orgId,
          storeId,
          values: {
            totalTiyin: moneyFromTiyin(333n),
            note: 'post-crash',
          },
        });
        expect(res.deviceSeq).toBe(2n);
        await Promise.resolve();
      });

      expect(
        connRecovered.db
          .select()
          .from(factSales)
          .all()
          .map((f) => f.note),
      ).toEqual(['committed-1', 'post-crash']);
      expect(listAllOutboxRecordsSync(connRecovered.db).map((o) => o.deviceSeq)).toEqual([1n, 2n]);
    } finally {
      connRecovered.close();
    }
  });

  it('continues deviceSeq gaplessly and preserves strict HLC & UUIDv7 monotonicity across restart even when system clock jumps backward', async () => {
    const dbPath = path.join(makeTempDir(), 'restart-backward-clock.db');
    const { registry, factSales } = buildTestTables();
    const idGen = new DeterministicUuidV7Generator();
    const orgId = idGen.nextId();
    const storeId = idGen.nextId();
    const deviceId = idGen.nextId();

    let prevLastEntityId: ReturnType<typeof idGen.nextId>;
    let prevLastEventId: ReturnType<typeof idGen.nextId>;
    let prevLastHlc: string;

    const conn1 = openLocalSqliteDatabase(dbPath);
    try {
      migrateLocalDatabase(conn1.db);
      await applyTestTables(conn1, registry, { factSales });

      const uow1 = await createSqliteUnitOfWork({
        connection: conn1,
        organizationId: orgId,
        deviceId,
        registry,
        clock: new FixedClock(2_000_000_000_000n),
        random: new SeededRandomSource(10),
      });

      const last = await uow1.execute(async (session) => {
        insertFact(session, factSales, {
          organizationId: orgId,
          storeId,
          values: { totalTiyin: moneyFromTiyin(1n), note: 'r1' },
        });
        const w2 = insertFact(session, factSales, {
          organizationId: orgId,
          storeId,
          values: { totalTiyin: moneyFromTiyin(2n), note: 'r2' },
        });
        await Promise.resolve();
        return w2;
      });
      prevLastEntityId = last.entityId;
      prevLastEventId = last.eventId;
      prevLastHlc = last.hlc;
      expect(last.deviceSeq).toBe(2n);
    } finally {
      conn1.close();
    }

    // Restart with wall clock jumped BACKWARD by 500 seconds
    const conn2 = openLocalSqliteDatabase(dbPath);
    try {
      const uow2 = await createSqliteUnitOfWork({
        connection: conn2,
        organizationId: orgId,
        deviceId,
        registry,
        clock: new FixedClock(1_500_000_000_000n),
        random: new SeededRandomSource(11),
      });

      const next = await uow2.execute(async (session) => {
        const res = insertFact(session, factSales, {
          organizationId: orgId,
          storeId,
          values: { totalTiyin: moneyFromTiyin(3n), note: 'r3' },
        });
        await Promise.resolve();
        return res;
      });

      expect(next.deviceSeq).toBe(3n);
      expect(compareHlc(parseHlc(next.hlc), parseHlc(prevLastHlc))).toBe(1);
      expect(next.entityId > prevLastEntityId).toBe(true);
      expect(next.eventId > prevLastEventId).toBe(true);
      expect(extractUuidV7Timestamp(next.entityId) > extractUuidV7Timestamp(prevLastEntityId)).toBe(
        true,
      );
      expect(extractUuidV7Timestamp(next.eventId) > extractUuidV7Timestamp(prevLastEventId)).toBe(
        true,
      );
    } finally {
      conn2.close();
    }
  });

  it('enforces generated SQLite immutability triggers against raw SQL (FACT blocks UPDATE/DELETE; ATTR/MONOTONE block DELETE only)', async () => {
    const dbPath = path.join(makeTempDir(), 'triggers.db');
    const conn = openLocalSqliteDatabase(dbPath);
    const { registry, factSales, attrItems, monoDocs } = buildTestTables();
    const idGen = new DeterministicUuidV7Generator();
    const orgId = idGen.nextId();
    const storeId = idGen.nextId();
    const deviceId = idGen.nextId();

    try {
      migrateLocalDatabase(conn.db);
      await applyTestTables(conn, registry, { factSales, attrItems, monoDocs });

      const uow = await createSqliteUnitOfWork({
        connection: conn,
        organizationId: orgId,
        deviceId,
        registry,
        clock: new FixedClock(1_700_000_000_000n),
        random: new SeededRandomSource(12),
      });

      const ids = await uow.execute(async (session) => {
        const f = insertFact(session, factSales, {
          organizationId: orgId,
          storeId,
          values: { totalTiyin: moneyFromTiyin(500n), note: 'f' },
        });
        const a = insertAttr(session, attrItems, {
          organizationId: orgId,
          values: { title: 'a', priceTiyin: moneyFromTiyin(100n) },
        });
        const mId = idGen.nextId();
        session.db
          .insert(monoDocs)
          .values({
            id: mId,
            organizationId: orgId,
            storeId,
            deviceId,
            hlc: f.hlc,
            createdAtMs: unixMsFromBigInt(1_700_000_000_000n),
            updatedAtMs: unixMsFromBigInt(1_700_000_000_000n),
            voidedAtMs: null,
            label: 'doc-1',
          })
          .run();
        await Promise.resolve();
        return { fId: f.entityId, aId: a.entityId, mId };
      });

      // FACT blocks raw UPDATE and raw DELETE
      expect(() =>
        conn.sqlite
          .prepare('UPDATE uow_test_fact_sales SET note = ? WHERE id = ?')
          .run('tampered', ids.fId),
      ).toThrowError(/FACT table "uow_test_fact_sales" is immutable: UPDATE is forbidden/);

      expect(() =>
        conn.sqlite.prepare('DELETE FROM uow_test_fact_sales WHERE id = ?').run(ids.fId),
      ).toThrowError(/FACT table "uow_test_fact_sales" forbids physical DELETE/);

      // ATTR allows raw UPDATE, blocks raw DELETE
      conn.sqlite
        .prepare('UPDATE uow_test_attr_items SET title = ? WHERE id = ?')
        .run('a-updated', ids.aId);
      expect(() =>
        conn.sqlite.prepare('DELETE FROM uow_test_attr_items WHERE id = ?').run(ids.aId),
      ).toThrowError(/ATTR table "uow_test_attr_items" forbids physical DELETE/);

      // MONOTONE allows raw UPDATE, blocks raw DELETE
      conn.sqlite
        .prepare('UPDATE uow_test_monotone_docs SET voided_at_ms = ? WHERE id = ?')
        .run(unixMsFromBigInt(1_700_000_005_000n), ids.mId);
      expect(() =>
        conn.sqlite.prepare('DELETE FROM uow_test_monotone_docs WHERE id = ?').run(ids.mId),
      ).toThrowError(/MONOTONE table "uow_test_monotone_docs" forbids physical DELETE/);
    } finally {
      conn.close();
    }
  });

  it('property test: device_seq remains strictly gapless 1..N across arbitrary commit/rollback/savepoint/reentrant sequences', async () => {
    const { registry, factSales, attrItems } = buildTestTables();
    const opArb = fc.constantFrom(
      'commit_fact' as const,
      'commit_attr' as const,
      'outer_rollback' as const,
      'nested_rollback_then_commit' as const,
      'nested_commit_then_outer_rollback' as const,
      'reentrant_error_then_commit' as const,
    );

    await fc.assert(
      fc.asyncProperty(fc.array(opArb, { minLength: 1, maxLength: 20 }), async (ops) => {
        const dbPath = path.join(makeTempDir(), 'prop.db');
        const conn = openLocalSqliteDatabase(dbPath);
        const idGen = new DeterministicUuidV7Generator();
        const orgId = idGen.nextId();
        const storeId = idGen.nextId();
        const deviceId = idGen.nextId();
        const clock = new FixedClock(1_700_000_000_000n);

        try {
          migrateLocalDatabase(conn.db);
          await applyTestTables(conn, registry, { factSales, attrItems });

          const uow = await createSqliteUnitOfWork({
            connection: conn,
            organizationId: orgId,
            deviceId,
            registry,
            clock,
            random: new SeededRandomSource(20),
          });

          let expectedEvents = 0;

          for (const op of ops) {
            clock.advance(1n);
            if (op === 'commit_fact') {
              await uow.execute(async (session) => {
                insertFact(session, factSales, {
                  organizationId: orgId,
                  storeId,
                  values: {
                    totalTiyin: moneyFromTiyin(100n),
                    note: 'cf',
                  },
                });
                await Promise.resolve();
              });
              expectedEvents += 1;
            } else if (op === 'commit_attr') {
              await uow.execute(async (session) => {
                const ins = insertAttr(session, attrItems, {
                  organizationId: orgId,
                  values: {
                    title: 'ca',
                    priceTiyin: moneyFromTiyin(200n),
                  },
                });
                updateAttr(session, attrItems, {
                  id: ins.entityId,
                  organizationId: orgId,
                  values: { title: 'ca2' },
                });
                await Promise.resolve();
              });
              expectedEvents += 2;
            } else if (op === 'outer_rollback') {
              await expect(
                uow.execute(async (session) => {
                  insertFact(session, factSales, {
                    organizationId: orgId,
                    storeId,
                    values: {
                      totalTiyin: moneyFromTiyin(300n),
                      note: 'orb',
                    },
                  });
                  await Promise.resolve();
                  throw new Error('prop outer rollback');
                }),
              ).rejects.toThrow('prop outer rollback');
            } else if (op === 'nested_rollback_then_commit') {
              await uow.execute(async (session) => {
                insertFact(session, factSales, {
                  organizationId: orgId,
                  storeId,
                  values: {
                    totalTiyin: moneyFromTiyin(400n),
                    note: 'outer-ok',
                  },
                });
                await expect(
                  session.nested(async (inner) => {
                    insertFact(inner, factSales, {
                      organizationId: orgId,
                      storeId,
                      values: {
                        totalTiyin: moneyFromTiyin(500n),
                        note: 'inner-rb',
                      },
                    });
                    await Promise.resolve();
                    throw new Error('prop inner rollback');
                  }),
                ).rejects.toThrow('prop inner rollback');
              });
              expectedEvents += 1;
            } else if (op === 'nested_commit_then_outer_rollback') {
              await expect(
                uow.execute(async (session) => {
                  await session.nested(async (inner) => {
                    insertFact(inner, factSales, {
                      organizationId: orgId,
                      storeId,
                      values: {
                        totalTiyin: moneyFromTiyin(600n),
                        note: 'inner-committed-before-outer-rb',
                      },
                    });
                    await Promise.resolve();
                  });
                  throw new Error('outer rollback discards committed savepoint');
                }),
              ).rejects.toThrow('outer rollback discards committed savepoint');
            } else {
              await uow.execute(async (session) => {
                await expectDomainErrorAsync(
                  () => uow.execute(async () => Promise.resolve()),
                  'UNIT_OF_WORK_REENTRANCY',
                );
                insertFact(session, factSales, {
                  organizationId: orgId,
                  storeId,
                  values: {
                    totalTiyin: moneyFromTiyin(700n),
                    note: 'after-reentrant-err',
                  },
                });
              });
              expectedEvents += 1;
            }
          }

          const outbox = listAllOutboxRecordsSync(conn.db);
          expect(outbox).toHaveLength(expectedEvents);
          for (let i = 0; i < outbox.length; i++) {
            expect(outbox[i].deviceSeq).toBe(BigInt(i + 1));
            if (i > 0) {
              expect(compareHlc(parseHlc(outbox[i].hlc), parseHlc(outbox[i - 1].hlc))).toBe(1);
            }
          }
          expect(readDeviceStateRowSync(conn.db, deviceId)?.lastDeviceSeq).toBe(
            BigInt(expectedEvents),
          );
        } finally {
          conn.close();
        }
      }),
      { numRuns: 15 },
    );
  }, 30_000);

  it('K1: rejects concurrent parallel nested() calls and parent-session writes while child savepoint is active, while allowing deep & sequential nested()', async () => {
    const dbPath = path.join(makeTempDir(), 'k1-nested-stack.db');
    const conn = openLocalSqliteDatabase(dbPath);
    const { registry, factSales, attrItems } = buildTestTables();
    const idGen = new DeterministicUuidV7Generator();
    const orgId = idGen.nextId();
    const storeId = idGen.nextId();
    const deviceId = idGen.nextId();
    const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

    try {
      migrateLocalDatabase(conn.db);
      await applyTestTables(conn, registry, { factSales, attrItems });

      const uow = await createSqliteUnitOfWork({
        connection: conn,
        organizationId: orgId,
        deviceId,
        registry,
        clock: new FixedClock(1_700_000_000_000n),
        random: new SeededRandomSource(20),
      });

      // (a) Claude's exact parallel Promise.allSettled([p1, p2]) reproduction: p2 MUST reject immediately
      await uow.execute(async (s) => {
        const p1 = s.nested(async () => {
          await delay(30);
          throw new Error('p1 savepoint failed');
        });
        const p2 = s.nested(async (c) => {
          await delay(5);
          return insertAttr(c, attrItems, {
            organizationId: orgId,
            values: { title: 'lost-row-if-allowed', priceTiyin: moneyFromTiyin(10n) },
          });
        });

        const settled = await Promise.allSettled([p1, p2]);
        expect(settled[0].status).toBe('rejected');
        expect(settled[1].status).toBe('rejected');
        if (settled[1].status === 'rejected') {
          expect(settled[1].reason).toBeInstanceOf(DomainError);
          expect((settled[1].reason as DomainError).code).toBe('UNIT_OF_WORK_CONCURRENT_NESTED');
        }
      });

      expect(conn.db.select().from(attrItems).all()).toHaveLength(0);
      expect(listAllOutboxRecordsSync(conn.db)).toHaveLength(0);

      // Even if p1 succeeds slowly, concurrent p2 MUST NOT steal or hide under p1's savepoint
      await uow.execute(async (s) => {
        const p1 = s.nested(async (c1) => {
          await delay(25);
          return insertAttr(c1, attrItems, {
            organizationId: orgId,
            values: { title: 'ok-1', priceTiyin: moneyFromTiyin(11n) },
          });
        });
        const p2 = s.nested(async (c2) => {
          await delay(5);
          return insertAttr(c2, attrItems, {
            organizationId: orgId,
            values: { title: 'rejected-concurrent', priceTiyin: moneyFromTiyin(12n) },
          });
        });
        const settled = await Promise.allSettled([p1, p2]);
        expect(settled[0].status).toBe('fulfilled');
        expect(settled[1].status).toBe('rejected');
        if (settled[1].status === 'rejected') {
          expect((settled[1].reason as DomainError).code).toBe('UNIT_OF_WORK_CONCURRENT_NESTED');
        }
      });

      expect(
        conn.db
          .select()
          .from(attrItems)
          .all()
          .map((a) => a.title),
      ).toEqual(['ok-1']);
      expect(listAllOutboxRecordsSync(conn.db).map((e) => e.deviceSeq)).toEqual([1n]);

      // (b) Parent-session write while inner savepoint is active MUST reject with UNIT_OF_WORK_CONCURRENT_NESTED
      await uow.execute(async (s) => {
        const preParent = insertAttr(s, attrItems, {
          organizationId: orgId,
          values: { title: 'parent-before', priceTiyin: moneyFromTiyin(20n) },
        });
        await expect(
          s.nested(async (c1) => {
            expect(() =>
              insertAttr(s, attrItems, {
                organizationId: orgId,
                values: { title: 'parent-during-child', priceTiyin: moneyFromTiyin(21n) },
              }),
            ).toThrowError(/UNIT_OF_WORK_CONCURRENT_NESTED/);

            expect(() =>
              insertFact(s, factSales, {
                organizationId: orgId,
                storeId,
                values: { totalTiyin: moneyFromTiyin(22n), note: 'parent-fact' },
              }),
            ).toThrowError(/UNIT_OF_WORK_CONCURRENT_NESTED/);

            expect(() =>
              updateAttr(s, attrItems, {
                id: preParent.entityId,
                organizationId: orgId,
                values: { title: 'parent-update' },
              }),
            ).toThrowError(/UNIT_OF_WORK_CONCURRENT_NESTED/);

            expect(() =>
              tombstoneAttr(s, attrItems, {
                id: preParent.entityId,
                organizationId: orgId,
              }),
            ).toThrowError(/UNIT_OF_WORK_CONCURRENT_NESTED/);

            // (c) Deep nested inside c1 is allowed; while c2 is open, BOTH s and c1 are rejected
            await c1.nested(async (c2) => {
              expect(() =>
                insertAttr(c1, attrItems, {
                  organizationId: orgId,
                  values: { title: 'c1-during-c2', priceTiyin: moneyFromTiyin(23n) },
                }),
              ).toThrowError(/UNIT_OF_WORK_CONCURRENT_NESTED/);
              expect(() =>
                insertAttr(s, attrItems, {
                  organizationId: orgId,
                  values: { title: 's-during-c2', priceTiyin: moneyFromTiyin(24n) },
                }),
              ).toThrowError(/UNIT_OF_WORK_CONCURRENT_NESTED/);

              insertFact(c2, factSales, {
                organizationId: orgId,
                storeId,
                values: { totalTiyin: moneyFromTiyin(30n), note: 'deep-ok' },
              });
              await Promise.resolve();
            });
            throw new Error('rollback c1 cleanly without hurting parent-before');
          }),
        ).rejects.toThrow('rollback c1 cleanly without hurting parent-before');

        // Sequential nested after c1 popped works cleanly on s
        await s.nested(async (cSeq) => {
          insertFact(cSeq, factSales, {
            organizationId: orgId,
            storeId,
            values: { totalTiyin: moneyFromTiyin(40n), note: 'seq-nested-ok' },
          });
          await Promise.resolve();
        });
      });

      expect(
        conn.db
          .select()
          .from(factSales)
          .all()
          .map((f) => f.note),
      ).toEqual(['seq-nested-ok']);
      expect(listAllOutboxRecordsSync(conn.db).map((e) => e.deviceSeq)).toEqual([1n, 2n, 3n]);
    } finally {
      conn.close();
    }
  });

  it('K2: rejects writes with foreign organizationId across all 4 writers with UNIT_OF_WORK_TENANT_MISMATCH', async () => {
    const dbPath = path.join(makeTempDir(), 'k2-tenant.db');
    const conn = openLocalSqliteDatabase(dbPath);
    const { registry, factSales, attrItems } = buildTestTables();
    const idGen = new DeterministicUuidV7Generator();
    const orgA = idGen.nextId();
    const orgB = idGen.nextId();
    const storeId = idGen.nextId();
    const deviceId = idGen.nextId();

    try {
      migrateLocalDatabase(conn.db);
      await applyTestTables(conn, registry, { factSales, attrItems });

      const uow = await createSqliteUnitOfWork({
        connection: conn,
        organizationId: orgA,
        deviceId,
        registry,
        clock: new FixedClock(1_700_000_000_000n),
        random: new SeededRandomSource(21),
      });

      let ownAttrId: ReturnType<typeof idGen.nextId>;
      await uow.execute(async (session) => {
        const res = insertAttr(session, attrItems, {
          organizationId: orgA,
          values: { title: 'legit', priceTiyin: moneyFromTiyin(100n) },
        });
        ownAttrId = res.entityId;
        await Promise.resolve();
      });

      await uow.execute(async (session) => {
        await expectDomainErrorAsync(async () => {
          insertFact(session, factSales, {
            organizationId: orgB,
            storeId,
            values: { totalTiyin: moneyFromTiyin(1n), note: 'evil' },
          });
          return Promise.resolve();
        }, 'UNIT_OF_WORK_TENANT_MISMATCH');

        await expectDomainErrorAsync(async () => {
          insertAttr(session, attrItems, {
            organizationId: orgB,
            values: { title: 'evil', priceTiyin: moneyFromTiyin(1n) },
          });
          return Promise.resolve();
        }, 'UNIT_OF_WORK_TENANT_MISMATCH');

        await expectDomainErrorAsync(async () => {
          updateAttr(session, attrItems, {
            id: ownAttrId,
            organizationId: orgB,
            values: { title: 'evil-upd' },
          });
          return Promise.resolve();
        }, 'UNIT_OF_WORK_TENANT_MISMATCH');

        await expectDomainErrorAsync(async () => {
          tombstoneAttr(session, attrItems, {
            id: ownAttrId,
            organizationId: orgB,
          });
          return Promise.resolve();
        }, 'UNIT_OF_WORK_TENANT_MISMATCH');
      });

      expect(conn.db.select().from(factSales).all()).toHaveLength(0);
      expect(
        conn.db
          .select()
          .from(attrItems)
          .all()
          .map((a) => a.title),
      ).toEqual(['legit']);
      expect(listAllOutboxRecordsSync(conn.db).map((e) => e.deviceSeq)).toEqual([1n]);
    } finally {
      conn.close();
    }
  });

  it('K3.1: closes child savepoint session immediately on exit or rollback while outer UoW is still active', async () => {
    const dbPath = path.join(makeTempDir(), 'k3-child-closed.db');
    const conn = openLocalSqliteDatabase(dbPath);
    const { registry, factSales, attrItems } = buildTestTables();
    const idGen = new DeterministicUuidV7Generator();
    const orgId = idGen.nextId();
    const storeId = idGen.nextId();
    const deviceId = idGen.nextId();

    try {
      migrateLocalDatabase(conn.db);
      await applyTestTables(conn, registry, { factSales, attrItems });

      const uow = await createSqliteUnitOfWork({
        connection: conn,
        organizationId: orgId,
        deviceId,
        registry,
        clock: new FixedClock(1_700_000_000_000n),
        random: new SeededRandomSource(22),
      });

      await uow.execute(async (outer) => {
        let leakedOkChild: typeof outer | undefined;
        let leakedErrChild: typeof outer | undefined;

        await outer.nested(async (child) => {
          leakedOkChild = child;
          await Promise.resolve();
        });
        expect(leakedOkChild?.isClosed()).toBe(true);

        await expectDomainErrorAsync(async () => {
          insertAttr(leakedOkChild!, attrItems, {
            organizationId: orgId,
            values: { title: 'stale-child', priceTiyin: moneyFromTiyin(1n) },
          });
          return Promise.resolve();
        }, 'UNIT_OF_WORK_SESSION_CLOSED');
        await expectDomainErrorAsync(
          () => leakedOkChild!.nested(async () => Promise.resolve()),
          'UNIT_OF_WORK_SESSION_CLOSED',
        );

        await expect(
          outer.nested(async (child) => {
            leakedErrChild = child;
            await Promise.resolve();
            throw new Error('child aborted');
          }),
        ).rejects.toThrow('child aborted');
        expect(leakedErrChild?.isClosed()).toBe(true);

        await expectDomainErrorAsync(async () => {
          insertFact(leakedErrChild!, factSales, {
            organizationId: orgId,
            storeId,
            values: { totalTiyin: moneyFromTiyin(2n), note: 'stale-err-child' },
          });
          return Promise.resolve();
        }, 'UNIT_OF_WORK_SESSION_CLOSED');
      });
    } finally {
      conn.close();
    }
  });

  it('K3.2: BEGIN IMMEDIATE acquires write lock upfront across two separate OS connections preventing SQLITE_BUSY write-upgrade error', async () => {
    const dir = makeTempDir();
    const dbPath = path.join(dir, 'k3-begin-immediate.db');
    const conn1 = openLocalSqliteDatabase(dbPath);
    const { registry, factSales } = buildTestTables();
    const idGen = new DeterministicUuidV7Generator();
    const orgId = idGen.nextId();
    const storeId = idGen.nextId();
    const device1 = idGen.nextId();
    const device2 = idGen.nextId();
    const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

    const builtDistIndex = ensureLocalPackagesBuiltForChild();
    const domainDistUrl = pathToFileURL(
      path.resolve(path.dirname(builtDistIndex), '..', '..', 'domain', 'dist', 'index.js'),
    ).href;
    const dbLocalDistUrl = pathToFileURL(builtDistIndex).href;
    const workerScriptPath = path.join(dir, 'conn2-worker.mjs');

    fs.writeFileSync(
      workerScriptPath,
      `
      import { createRequire } from 'node:module';
      import {
        SqliteSchemaRegistry,
        sqliteMoney,
        openLocalSqliteDatabase,
        createSqliteUnitOfWork,
        insertFact,
      } from ${JSON.stringify(dbLocalDistUrl)};
      import { parseUuidV7 } from ${JSON.stringify(domainDistUrl)};

      const localReq = createRequire(${JSON.stringify(dbLocalDistUrl)});
      const { text } = localReq('drizzle-orm/sqlite-core');

      const [dbPathArg, orgIdStr, storeIdStr, deviceIdStr] = process.argv.slice(2);
      const orgId = parseUuidV7(orgIdStr);
      const storeId = parseUuidV7(storeIdStr);
      const deviceId = parseUuidV7(deviceIdStr);

      const registry = new SqliteSchemaRegistry();
      const factSales = registry.defineTable(
        { name: 'uow_test_fact_sales', tableClass: 'FACT', tenantScope: 'store' },
        (c) => ({
          ...c,
          totalTiyin: sqliteMoney('total_tiyin').notNull(),
          note: text('note').notNull(),
        }),
      );

      const conn = openLocalSqliteDatabase(dbPathArg);
      const uow = await createSqliteUnitOfWork({
        connection: conn,
        organizationId: orgId,
        deviceId,
        registry,
        clock: { now: () => 1_700_000_000_050n },
        random: { nextBytes: (n) => new Uint8Array(n).fill(9) },
      });

      process.on('message', (msg) => {
        if (msg !== 'write') return;
        void (async () => {
          let reply;
          try {
            const res = await uow.execute(async (s2) => {
              await Promise.resolve();
              return insertFact(s2, factSales, {
                organizationId: orgId,
                storeId,
                values: { totalTiyin: 200n, note: 'conn2-concurrent-write' },
              });
            });
            reply = { status: 'ok', deviceSeq: res.deviceSeq.toString() };
          } catch (err) {
            reply = {
              status: 'error',
              message: err instanceof Error ? err.message : String(err),
            };
          } finally {
            conn.close();
          }
          if (typeof process.send === 'function') {
            process.send(reply, () => process.exit(0));
          } else {
            process.exit(0);
          }
        })();
      });

      process.send?.({ status: 'ready' });
      `,
      'utf8',
    );

    migrateLocalDatabase(conn1.db);
    await applyTestTables(conn1, registry, { factSales });

    const uow1 = await createSqliteUnitOfWork({
      connection: conn1,
      organizationId: orgId,
      deviceId: device1,
      registry,
      clock: new FixedClock(1_700_000_000_000n),
      random: new SeededRandomSource(23),
    });

    const child = spawn(process.execPath, [workerScriptPath, dbPath, orgId, storeId, device2], {
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    const closedPromise = new Promise<void>((resolve) => {
      child.once('close', () => resolve());
    });
    let childStderr = '';
    child.stderr?.on('data', (chunk: Buffer) => {
      childStderr += chunk.toString('utf8');
    });

    const readyPromise = new Promise<void>((resolve, reject) => {
      const onMessage = (msg: unknown) => {
        if (
          typeof msg === 'object' &&
          msg !== null &&
          (msg as { status?: string }).status === 'ready'
        ) {
          child.off('message', onMessage);
          resolve();
        }
      };
      child.on('message', onMessage);
      child.once('error', reject);
      child.once('exit', (code) => {
        if (code !== 0) {
          reject(new Error(`conn2-worker exited early with code ${String(code)}: ${childStderr}`));
        }
      });
    });

    const resultPromise = new Promise<{ status: string; deviceSeq?: string; message?: string }>(
      (resolve, reject) => {
        const onMessage = (msg: unknown) => {
          if (typeof msg === 'object' && msg !== null) {
            const status = (msg as { status?: string }).status;
            if (status === 'ok' || status === 'error') {
              child.off('message', onMessage);
              resolve(msg as { status: string; deviceSeq?: string; message?: string });
            }
          }
        };
        child.on('message', onMessage);
        child.once('error', reject);
        child.once('exit', (code) => {
          if (code !== 0) {
            reject(new Error(`conn2-worker failed with code ${String(code)}: ${childStderr}`));
          }
        });
      },
    );

    try {
      await readyPromise;

      // Connection 1 (main process) reads inside tx, signals Connection 2 (child OS process) to write concurrently,
      // then awaits before writing itself. With BEGIN IMMEDIATE, conn1 holds the write lock from t=0 and conn2 waits
      // cleanly within SQLite busy_timeout until conn1 commits. With plain BEGIN, conn2 steals the write lock first
      // and conn1 hits SQLITE_BUSY when upgrading its stale read snapshot to write.
      const p1 = uow1.execute(async (s1) => {
        const beforeCount = s1.db.select().from(factSales).all().length;
        expect(beforeCount).toBe(0);
        child.send('write');
        await delay(150);
        return insertFact(s1, factSales, {
          organizationId: orgId,
          storeId,
          values: { totalTiyin: moneyFromTiyin(100n), note: 'conn1-read-then-write' },
        });
      });

      const [r1, r2] = await Promise.all([p1, resultPromise]);
      await closedPromise;
      expect(r1.deviceSeq).toBe(1n);
      expect(r2).toEqual({ status: 'ok', deviceSeq: '1' });
      expect(
        conn1.db
          .select()
          .from(factSales)
          .all()
          .map((f) => f.note),
      ).toEqual(['conn1-read-then-write', 'conn2-concurrent-write']);
    } finally {
      if (child.exitCode === null) {
        child.kill();
      }
      await closedPromise;
      conn1.close();
    }
  });

  it('K3.3, K3.4, K3.6: enforces appendOutboxEventSync inTransaction check, listPending status filtering, and mid-callback ROLLBACK/close guard', async () => {
    const dbPath = path.join(makeTempDir(), 'k3-guards.db');
    const conn = openLocalSqliteDatabase(dbPath);
    const { registry, factSales } = buildTestTables();
    const idGen = new DeterministicUuidV7Generator();
    const orgId = idGen.nextId();
    const storeId = idGen.nextId();
    const deviceId = idGen.nextId();

    try {
      migrateLocalDatabase(conn.db);
      await applyTestTables(conn, registry, { factSales });

      const uow = await createSqliteUnitOfWork({
        connection: conn,
        organizationId: orgId,
        deviceId,
        registry,
        clock: new FixedClock(1_700_000_000_000n),
        random: new SeededRandomSource(25),
      });

      // K3.3: appendOutboxEventSync outside SQLite transaction rejects immediately
      expect(() =>
        appendOutboxEventSync(conn.sqlite, conn.db, {
          eventId: idGen.nextId(),
          organizationId: orgId,
          storeId,
          deviceId,
          hlc: `001700000000000:00000:${deviceId}`,
          uuidMs: unixMsFromBigInt(1_700_000_000_000n),
          nowMs: unixMsFromBigInt(1_700_000_000_000n),
          type: 'test.created',
          entity: 'uow_test_fact_sales',
          entityId: idGen.nextId(),
          entityClass: 'FACT',
          schemaVersion: 1,
          payload: {},
        }),
      ).toThrowError(/requires an active SQLite transaction/);

      // K3.4: SqliteOutboxRepository.listPending skips 'acked' and 'rejected', preserves 'pending' order
      const outboxRepo = new SqliteOutboxRepository();
      await uow.execute(async (session) => {
        const e1 = insertFact(session, factSales, {
          organizationId: orgId,
          storeId,
          values: { totalTiyin: moneyFromTiyin(1n), note: 'e1' },
        });
        const e2 = insertFact(session, factSales, {
          organizationId: orgId,
          storeId,
          values: { totalTiyin: moneyFromTiyin(2n), note: 'e2' },
        });
        const e3 = insertFact(session, factSales, {
          organizationId: orgId,
          storeId,
          values: { totalTiyin: moneyFromTiyin(3n), note: 'e3' },
        });
        const e4 = insertFact(session, factSales, {
          organizationId: orgId,
          storeId,
          values: { totalTiyin: moneyFromTiyin(4n), note: 'e4' },
        });

        session.db
          .update(localOutbox)
          .set({ status: 'acked' })
          .where(eq(localOutbox.id, e1.eventId))
          .run();
        session.db
          .update(localOutbox)
          .set({ status: 'rejected', lastError: 'permanent test reject' })
          .where(eq(localOutbox.id, e3.eventId))
          .run();

        const pendingAll = await outboxRepo.listPending(session);
        expect(pendingAll.map((r) => [r.eventId, r.deviceSeq])).toEqual([
          [e2.eventId, 2n],
          [e4.eventId, 4n],
        ]);
        const pendingOne = await outboxRepo.listPending(session, 1);
        expect(pendingOne.map((r) => r.eventId)).toEqual([e2.eventId]);
      });

      // K3.6: sqlite.inTransaction check inside assertActiveTransaction IS reachable when raw SQLite
      // rolls back mid-callback (e.g. OR ROLLBACK / raw ROLLBACK) while session & ALS are still active
      await expectDomainErrorAsync(
        () =>
          uow.execute(async (session) => {
            getSessionSqlite(session).exec('ROLLBACK');
            expect(conn.sqlite.inTransaction).toBe(false);
            insertFact(session, factSales, {
              organizationId: orgId,
              storeId,
              values: { totalTiyin: moneyFromTiyin(9n), note: 'after-raw-rollback' },
            });
            return Promise.resolve();
          }),
        'UNIT_OF_WORK_REQUIRED',
      );

      // Mutex was still released cleanly after mid-callback raw ROLLBACK
      await uow.execute(async (session) => {
        const res = insertFact(session, factSales, {
          organizationId: orgId,
          storeId,
          values: { totalTiyin: moneyFromTiyin(5n), note: 'e5-after-rollback-guard' },
        });
        expect(res.deviceSeq).toBe(5n);
        await Promise.resolve();
      });
    } finally {
      conn.close();
    }
  });
});
