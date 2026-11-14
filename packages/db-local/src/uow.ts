import { AsyncLocalStorage } from 'node:async_hooks';
import {
  type Clock,
  DomainError,
  type HlcTimestamp,
  HlcClock,
  MonotonicUuidV7Generator,
  type OutboxEntityClass,
  type RandomSource,
  type UnitOfWork,
  type UnitOfWorkSession,
  type UnixMs,
  type UuidV7,
  createHlcTimestamp,
  parseHlc,
  parseUuidV7,
  serializeHlc,
  unixMsFromBigInt,
} from '@mezon/domain';
import type Database from 'better-sqlite3';
import { type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import type { SQLiteTable } from 'drizzle-orm/sqlite-core';
import type { LocalSqliteConnection } from './connection.js';
import {
  type SqliteSessionDbAccess,
  ensureDeviceStateRowSync,
  readDeviceStateRowSync,
} from './device-state.js';
import { type AppendOutboxResult, appendOutboxEventSync } from './outbox.js';
import {
  SchemaValidationError,
  SqliteSchemaRegistry,
  type SqliteTableMetadata,
} from './registry.js';

class AsyncMutex {
  private locked = false;
  private readonly waiters: Array<() => void> = [];

  acquire(): Promise<() => void> {
    if (!this.locked) {
      this.locked = true;
      return Promise.resolve(this.createReleaser());
    }
    return new Promise<() => void>((resolve) => {
      this.waiters.push(() => {
        resolve(this.createReleaser());
      });
    });
  }

  private createReleaser(): () => void {
    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      const next = this.waiters.shift();
      if (next) {
        next();
      } else {
        this.locked = false;
      }
    };
  }
}

const activeUowContext = new AsyncLocalStorage<ReadonlySet<SqliteUnitOfWork>>();
const connectionMutexes = new WeakMap<Database.Database, AsyncMutex>();

function getConnectionMutex(sqlite: Database.Database): AsyncMutex {
  let mutex = connectionMutexes.get(sqlite);
  if (!mutex) {
    mutex = new AsyncMutex();
    connectionMutexes.set(sqlite, mutex);
  }
  return mutex;
}

export interface CreateSqliteUnitOfWorkOptions {
  readonly connection: LocalSqliteConnection;
  readonly organizationId: UuidV7;
  readonly deviceId: UuidV7;
  readonly registry: SqliteSchemaRegistry;
  readonly clock: Clock;
  readonly random: RandomSource;
  readonly maxSkewMs?: bigint;
}

export interface RecordOutboxEventInput {
  readonly organizationId: UuidV7;
  readonly storeId: UuidV7 | null;
  readonly hlc: string;
  readonly nowMs: UnixMs;
  readonly type: string;
  readonly entity: string;
  readonly entityId: UuidV7;
  readonly entityClass: OutboxEntityClass;
  readonly schemaVersion: number;
  readonly payload: Record<string, unknown>;
}

/**
 * Active transactional session handle passed into `SqliteUnitOfWork.execute` and `session.nested`.
 * Prevents stale closure writes after a transaction or savepoint exits, and guarantees
 * `device_seq`, `local_outbox`, and `local_device_state` share the active SQLite transaction.
 */
export class SqliteUnitOfWorkSession implements UnitOfWorkSession, SqliteSessionDbAccess {
  private closed = false;

  constructor(private readonly uow: SqliteUnitOfWork) {}

  get db(): BetterSQLite3Database {
    this.assertActiveTransaction();
    return this.uow.internalConnection.db;
  }

  get deviceId(): UuidV7 {
    return this.uow.deviceId;
  }

  get organizationId(): UuidV7 {
    return this.uow.organizationId;
  }

  isClosed(): boolean {
    return this.closed;
  }

  /** @internal */
  close(): void {
    this.closed = true;
  }

  assertOpen(): void {
    if (this.closed) {
      throw new DomainError(
        'UNIT_OF_WORK_SESSION_CLOSED',
        'Cannot use a UnitOfWork session after its execute/nested scope has completed',
      );
    }
  }

  assertActiveTransaction(): void {
    this.assertOpen();
    if (!activeUowContext.getStore()?.has(this.uow)) {
      throw new DomainError(
        'UNIT_OF_WORK_REQUIRED',
        'Operation must run inside an active UnitOfWork execution context',
      );
    }
    const sqlite = this.uow.internalConnection.sqlite;
    if (!sqlite.open || !sqlite.inTransaction) {
      throw new DomainError(
        'UNIT_OF_WORK_REQUIRED',
        'Operation requires an open SQLite transaction',
      );
    }
    if (this.uow.topActiveSession() !== this) {
      throw new DomainError(
        'UNIT_OF_WORK_CONCURRENT_NESTED',
        'Only the innermost active UnitOfWork session may write or open nested savepoints',
      );
    }
  }

  /**
   * Executes a nested unit of work via SQLite `SAVEPOINT` without waiting on the outer mutex.
   * On failure, `ROLLBACK TO SAVEPOINT` + `RELEASE SAVEPOINT` cleanly reverts table writes,
   * `local_outbox`, and `local_device_state.last_device_seq` without poisoning the outer transaction.
   */
  async nested<T>(fn: (session: this) => Promise<T>): Promise<T> {
    this.assertActiveTransaction();
    const sqlite = this.uow.internalConnection.sqlite;
    const spName = this.uow.allocateSavepointName();
    const childSession = new SqliteUnitOfWorkSession(this.uow) as this;
    let savepointCreated = false;
    let released = false;

    sqlite.exec(`SAVEPOINT ${spName}`);
    savepointCreated = true;
    this.uow.pushActiveSession(childSession);

    try {
      let result: T;
      try {
        result = await fn(childSession);
      } finally {
        childSession.close();
        this.uow.popActiveSession(childSession);
      }
      sqlite.exec(`RELEASE SAVEPOINT ${spName}`);
      released = true;
      return result;
    } catch (err) {
      if (savepointCreated && !released && sqlite.open && sqlite.inTransaction) {
        try {
          sqlite.exec(`ROLLBACK TO SAVEPOINT ${spName}`);
          sqlite.exec(`RELEASE SAVEPOINT ${spName}`);
        } catch {
          // Preserve original error if connection closed or outer tx already rolled back.
        }
      }
      throw err;
    }
  }

  /** @internal */
  nextId(): UuidV7 {
    this.assertActiveTransaction();
    return this.uow.internalNextId();
  }

  /** @internal */
  nextHlc(): HlcTimestamp {
    this.assertActiveTransaction();
    return this.uow.internalNextHlc();
  }

  /** @internal */
  nowUnixMs(): UnixMs {
    this.assertActiveTransaction();
    return unixMsFromBigInt(this.uow.internalClock.now());
  }

  /** @internal */
  currentUuidLastMs(): UnixMs {
    this.assertActiveTransaction();
    return this.uow.internalCurrentUuidMs();
  }

  /** @internal */
  requireTableMetadata(table: SQLiteTable, tableName: string): SqliteTableMetadata {
    this.assertActiveTransaction();
    const meta = this.uow.internalRegistry.get(tableName);
    if (!meta || meta.table !== table) {
      throw new SchemaValidationError(
        `SQLite table "${tableName}" is not registered in this UnitOfWork registry`,
      );
    }
    return meta;
  }

  /** @internal */
  internalGetSqlite(): Database.Database {
    this.assertActiveTransaction();
    return this.uow.internalConnection.sqlite;
  }

  /** @internal */
  recordOutboxEvent(input: RecordOutboxEventInput): AppendOutboxResult {
    this.assertActiveTransaction();
    const eventId = this.uow.internalNextId();
    const uuidMs = this.uow.internalCurrentUuidMs();
    return appendOutboxEventSync(
      this.uow.internalConnection.sqlite,
      this.uow.internalConnection.db,
      {
        eventId,
        organizationId: input.organizationId,
        storeId: input.storeId,
        deviceId: this.uow.deviceId,
        hlc: input.hlc,
        uuidMs,
        nowMs: input.nowMs,
        type: input.type,
        entity: input.entity,
        entityId: input.entityId,
        entityClass: input.entityClass,
        schemaVersion: input.schemaVersion,
        payload: input.payload,
      },
    );
  }
}

/**
 * Asynchronous SQLite Unit of Work backed by `better-sqlite3` (`BEGIN IMMEDIATE` / `COMMIT` /
 * `ROLLBACK`), a connection-level FIFO mutex, `AsyncLocalStorage` reentrancy rejection,
 * and atomic SQLite `local_device_state` / `local_outbox` persistence.
 *
 * Note on rollback monotonicity (`T0.5` Adjustment #1):
 * In-memory `HlcClock` and `MonotonicUuidV7Generator` may stay ahead after an outer or savepoint
 * rollback. This is intentional and allowed because HLC and UUIDv7 only require strict monotonicity,
 * never gaplessness — whereas `device_seq` MUST be gapless and therefore lives solely in SQLite
 * (`local_device_state.last_device_seq`) so SQLite transaction/savepoint rollback restores it automatically.
 */
export class SqliteUnitOfWork implements UnitOfWork<SqliteUnitOfWorkSession> {
  private readonly mutex: AsyncMutex;
  private readonly activeSessionStack: SqliteUnitOfWorkSession[] = [];
  private savepointSeq = 0;

  readonly organizationId: UuidV7;
  readonly deviceId: UuidV7;

  /** @internal */
  readonly internalConnection: LocalSqliteConnection;
  /** @internal */
  readonly internalRegistry: SqliteSchemaRegistry;
  /** @internal */
  readonly internalClock: Clock;

  private readonly clock: Clock;
  private readonly hlcClock: HlcClock;
  private readonly uuidGenerator: MonotonicUuidV7Generator;

  private constructor(params: {
    readonly connection: LocalSqliteConnection;
    readonly organizationId: UuidV7;
    readonly deviceId: UuidV7;
    readonly registry: SqliteSchemaRegistry;
    readonly clock: Clock;
    readonly hlcClock: HlcClock;
    readonly uuidGenerator: MonotonicUuidV7Generator;
  }) {
    this.mutex = getConnectionMutex(params.connection.sqlite);
    this.internalConnection = params.connection;
    this.organizationId = params.organizationId;
    this.deviceId = params.deviceId;
    this.internalRegistry = params.registry;
    this.clock = params.clock;
    this.internalClock = params.clock;
    this.hlcClock = params.hlcClock;
    this.uuidGenerator = params.uuidGenerator;
  }

  static async create(options: CreateSqliteUnitOfWorkOptions): Promise<SqliteUnitOfWork> {
    const validOrgId = parseUuidV7(options.organizationId);
    const validDeviceId = parseUuidV7(options.deviceId);
    const { sqlite, db } = options.connection;

    if (!sqlite.open) {
      throw new Error('Cannot create SqliteUnitOfWork on a closed SQLite database connection');
    }

    const release = await getConnectionMutex(sqlite).acquire();
    try {
      const existingTableCheck = sqlite
        .prepare<[string], { readonly name: string }>(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
        )
        .get('local_device_state');
      if (!existingTableCheck) {
        throw new Error(
          'Missing required "local_device_state" table; run migrateLocalDatabase() before creating SqliteUnitOfWork',
        );
      }

      // Bootstrap persistent device state atomically inside BEGIN IMMEDIATE ... COMMIT
      let persisted = readDeviceStateRowSync(db, validDeviceId);
      if (persisted === null) {
        sqlite.exec('BEGIN IMMEDIATE');
        try {
          persisted = readDeviceStateRowSync(db, validDeviceId);
          if (persisted === null) {
            const seedUuidGen = new MonotonicUuidV7Generator({
              clock: options.clock,
              random: options.random,
            });
            const rowId = seedUuidGen.nextId();
            const nowMs = unixMsFromBigInt(options.clock.now());
            const initialHlcStr = serializeHlc(createHlcTimestamp(nowMs, 0, validDeviceId));
            const initialUuidMs = seedUuidGen.currentLastTimestampMs() ?? nowMs;
            persisted = ensureDeviceStateRowSync(sqlite, db, {
              rowId,
              organizationId: validOrgId,
              deviceId: validDeviceId,
              initialHlcStr,
              initialUuidMs,
              nowMs,
            });
          }
          sqlite.exec('COMMIT');
        } catch (err) {
          if (sqlite.open && sqlite.inTransaction) {
            try {
              sqlite.exec('ROLLBACK');
            } catch {
              // ignore rollback error
            }
          }
          throw err;
        }
      } else if (persisted.organizationId !== validOrgId) {
        throw new Error(
          `Device "${validDeviceId}" belongs to organization "${persisted.organizationId}", expected "${validOrgId}"`,
        );
      }

      const hlcClock = new HlcClock({
        clock: options.clock,
        nodeId: validDeviceId,
        maxSkewMs: options.maxSkewMs,
        initial: parseHlc(persisted.lastHlc),
      });

      const uuidGenerator = new MonotonicUuidV7Generator({
        clock: options.clock,
        random: options.random,
        initialLastMs: persisted.lastUuidMs,
      });

      return new SqliteUnitOfWork({
        connection: options.connection,
        organizationId: validOrgId,
        deviceId: validDeviceId,
        registry: options.registry,
        clock: options.clock,
        hlcClock,
        uuidGenerator,
      });
    } finally {
      release();
    }
  }

  /**
   * Atomically executes one-time bootstrap setup inside a single `BEGIN IMMEDIATE ... COMMIT`
   * holding the connection FIFO mutex so concurrent `/setup` requests strictly serialize and
   * only one can ever succeed (`T0.6`).
   */
  static async bootstrapSetup<T>(
    options: CreateSqliteUnitOfWorkOptions & {
      readonly assertPrecondition?: (db: BetterSQLite3Database) => void;
      readonly fn: (session: SqliteUnitOfWorkSession, uow: SqliteUnitOfWork) => Promise<T>;
    },
  ): Promise<{ readonly uow: SqliteUnitOfWork; readonly result: T }> {
    const validOrgId = parseUuidV7(options.organizationId);
    const validDeviceId = parseUuidV7(options.deviceId);
    const { sqlite, db } = options.connection;

    if (!sqlite.open) {
      throw new Error('Cannot run bootstrapSetup on a closed SQLite database connection');
    }

    const release = await getConnectionMutex(sqlite).acquire();
    let txStarted = false;
    let settled = false;

    try {
      sqlite.exec('BEGIN IMMEDIATE');
      txStarted = true;

      options.assertPrecondition?.(db);

      const seedUuidGen = new MonotonicUuidV7Generator({
        clock: options.clock,
        random: options.random,
      });
      const rowId = seedUuidGen.nextId();
      const nowMs = unixMsFromBigInt(options.clock.now());
      const initialHlcStr = serializeHlc(createHlcTimestamp(nowMs, 0, validDeviceId));
      const initialUuidMs = seedUuidGen.currentLastTimestampMs() ?? nowMs;
      const persisted = ensureDeviceStateRowSync(sqlite, db, {
        rowId,
        organizationId: validOrgId,
        deviceId: validDeviceId,
        initialHlcStr,
        initialUuidMs,
        nowMs,
      });

      const uow = new SqliteUnitOfWork({
        connection: options.connection,
        organizationId: validOrgId,
        deviceId: validDeviceId,
        registry: options.registry,
        clock: options.clock,
        hlcClock: new HlcClock({
          clock: options.clock,
          nodeId: validDeviceId,
          maxSkewMs: options.maxSkewMs,
          initial: parseHlc(persisted.lastHlc),
        }),
        uuidGenerator: new MonotonicUuidV7Generator({
          clock: options.clock,
          random: options.random,
          initialLastMs: persisted.lastUuidMs,
        }),
      });

      const session = new SqliteUnitOfWorkSession(uow);
      uow.pushActiveSession(session);
      let result: T;
      try {
        result = await activeUowContext.run(new Set([uow]), () => options.fn(session, uow));
      } finally {
        session.close();
        uow.activeSessionStack.length = 0;
      }

      sqlite.exec('COMMIT');
      settled = true;
      return { uow, result };
    } catch (err) {
      if (txStarted && !settled && sqlite.open && sqlite.inTransaction) {
        try {
          sqlite.exec('ROLLBACK');
        } catch {
          // ignore rollback error
        }
      }
      throw err;
    } finally {
      release();
    }
  }

  /**
   * Executes an asynchronous unit of work within an exclusive `BEGIN IMMEDIATE` transaction.
   * Rejects reentrant calls (`uow.execute` inside `uow.execute`) immediately before waiting on
   * the mutex to prevent self-deadlock (`session.nested()` must be used instead).
   */
  async execute<T>(fn: (session: SqliteUnitOfWorkSession) => Promise<T>): Promise<T> {
    const outerActiveSet = activeUowContext.getStore();
    if (outerActiveSet?.has(this)) {
      throw new DomainError(
        'UNIT_OF_WORK_REENTRANCY',
        'Nested uow.execute() is forbidden inside an active transaction; use session.nested() instead',
      );
    }

    const release = await this.mutex.acquire();
    const sqlite = this.internalConnection.sqlite;
    let txStarted = false;
    let settled = false;

    try {
      sqlite.exec('BEGIN IMMEDIATE');
      txStarted = true;

      const session = new SqliteUnitOfWorkSession(this);
      const nextActiveSet = new Set(outerActiveSet);
      nextActiveSet.add(this);
      this.pushActiveSession(session);

      let result: T;
      try {
        result = await activeUowContext.run(nextActiveSet, () => fn(session));
      } finally {
        session.close();
        this.activeSessionStack.length = 0;
      }

      sqlite.exec('COMMIT');
      settled = true;
      return result;
    } catch (primaryErr) {
      if (txStarted && !settled && sqlite.open && sqlite.inTransaction) {
        try {
          sqlite.exec('ROLLBACK');
        } catch {
          // Ignore rollback errors so original COMMIT or callback error is preserved
          // and the mutex is still released in finally below.
        }
      }
      throw primaryErr;
    } finally {
      release();
    }
  }

  /**
   * Runs a read-only operation serialized through the connection FIFO mutex so concurrent
   * callers never interleave with an active asynchronous `BEGIN IMMEDIATE ... await ... ROLLBACK`.
   */
  async runReadOnly<T>(fn: () => Promise<T>): Promise<T> {
    const outerActiveSet = activeUowContext.getStore();
    if (outerActiveSet?.has(this)) {
      throw new DomainError(
        'UNIT_OF_WORK_REENTRANCY',
        'Do not call uow.runReadOnly() inside an active execute() callback; use session.db directly',
      );
    }

    const release = await this.mutex.acquire();
    try {
      return await fn();
    } finally {
      release();
    }
  }

  /** @internal */
  pushActiveSession(session: SqliteUnitOfWorkSession): void {
    this.activeSessionStack.push(session);
  }

  /** @internal */
  popActiveSession(session: SqliteUnitOfWorkSession): void {
    const popped = this.activeSessionStack.pop();
    if (popped !== session) {
      throw new Error('Corrupted UnitOfWork session stack state');
    }
  }

  /** @internal */
  topActiveSession(): SqliteUnitOfWorkSession | undefined {
    return this.activeSessionStack.at(-1);
  }

  /** @internal */
  allocateSavepointName(): string {
    this.savepointSeq += 1;
    return `sp_${this.savepointSeq}`;
  }

  /** @internal */
  internalNextId(): UuidV7 {
    return this.uuidGenerator.nextId();
  }

  /** @internal */
  internalNextHlc(): HlcTimestamp {
    return this.hlcClock.now().hlc;
  }

  /** Returns current millisecond timestamp from injected Clock adapter (read-only). */
  nowUnixMs(): UnixMs {
    return unixMsFromBigInt(this.clock.now());
  }

  /** @internal */
  internalCurrentUuidMs(): UnixMs {
    return this.uuidGenerator.currentLastTimestampMs() ?? unixMsFromBigInt(this.clock.now());
  }
}

export async function createSqliteUnitOfWork(
  options: CreateSqliteUnitOfWorkOptions,
): Promise<SqliteUnitOfWork> {
  return SqliteUnitOfWork.create(options);
}

export async function bootstrapSqliteHubUnitOfWork<T>(
  options: CreateSqliteUnitOfWorkOptions & {
    readonly assertPrecondition?: (db: BetterSQLite3Database) => void;
    readonly fn: (session: SqliteUnitOfWorkSession, uow: SqliteUnitOfWork) => Promise<T>;
  },
): Promise<{ readonly uow: SqliteUnitOfWork; readonly result: T }> {
  return SqliteUnitOfWork.bootstrapSetup(options);
}

/**
 * Serializes a read-only database inspection across the connection FIFO mutex even before a
 * `SqliteUnitOfWork` has been instantiated (e.g. pre-setup health checks and login-options).
 */
export async function runConnectionReadOnly<T>(
  connection: LocalSqliteConnection,
  fn: () => Promise<T> | T,
): Promise<T> {
  const release = await getConnectionMutex(connection.sqlite).acquire();
  try {
    return await fn();
  } finally {
    release();
  }
}

/**
 * Executes a synchronous projection/index maintenance transaction (`BEGIN IMMEDIATE ... COMMIT`)
 * under the connection FIFO mutex without emitting business outbox events (e.g. F4 search index rebuild).
 */
export async function runConnectionProjectionMaintenance<T>(
  connection: LocalSqliteConnection,
  fn: (sqlite: Database.Database, db: BetterSQLite3Database) => T,
): Promise<T> {
  const release = await getConnectionMutex(connection.sqlite).acquire();
  try {
    const runTx = connection.sqlite.transaction(() => fn(connection.sqlite, connection.db));
    return await Promise.resolve(runTx.immediate());
  } finally {
    release();
  }
}

/**
 * Helper to read the active transaction's `Database.Database` strictly inside an active UoW scope.
 * Intended for test diagnostics and constrained SQL checks inside transactions.
 */
export function getSessionSqlite(session: SqliteUnitOfWorkSession): Database.Database {
  return session.internalGetSqlite();
}
