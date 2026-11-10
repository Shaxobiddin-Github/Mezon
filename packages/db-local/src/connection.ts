import Database from 'better-sqlite3';
import { type BetterSQLite3Database, drizzle } from 'drizzle-orm/better-sqlite3';

export const DEFAULT_SQLITE_BUSY_TIMEOUT_MS = 5000;

export interface LocalSqliteOptions {
  readonly busyTimeoutMs?: number;
}

export interface LocalSqlitePragmas {
  readonly journalMode: string;
  readonly synchronous: number;
  readonly foreignKeys: boolean;
  readonly busyTimeoutMs: number;
}

export interface LocalSqliteConnection<
  TSchema extends Record<string, unknown> = Record<string, never>,
> {
  readonly sqlite: Database.Database;
  readonly db: BetterSQLite3Database<TSchema>;
  readonly pragmas: LocalSqlitePragmas;
  close(): void;
}

export function openLocalSqliteDatabase<
  TSchema extends Record<string, unknown> = Record<string, never>,
>(
  filename: string,
  options: LocalSqliteOptions & { readonly schema?: TSchema } = {},
): LocalSqliteConnection<TSchema> {
  const busyTimeoutMs = options.busyTimeoutMs ?? DEFAULT_SQLITE_BUSY_TIMEOUT_MS;
  if (!Number.isSafeInteger(busyTimeoutMs) || busyTimeoutMs < 0) {
    throw new RangeError('busyTimeoutMs must be a non-negative safe integer');
  }

  const sqlite = new Database(filename);
  // Ensure 64-bit SQLite INTEGER values exceeding 2^53 - 1 are always read as exact JS bigint.
  sqlite.defaultSafeIntegers(true);

  sqlite.pragma('journal_mode = WAL');
  // Synchronous FULL guarantees fsync durability on power loss right after completed sales.
  sqlite.pragma('synchronous = FULL');
  sqlite.pragma('foreign_keys = ON');
  sqlite.pragma('temp_store = MEMORY');
  // 16 MB page cache avoids hot FTS5 / index re-reads on low-RAM Windows POS hosts.
  sqlite.pragma('cache_size = -16384');
  sqlite.pragma(`busy_timeout = ${busyTimeoutMs}`);

  const pragmas: LocalSqlitePragmas = {
    journalMode: String(sqlite.pragma('journal_mode', { simple: true })).toLowerCase(),
    synchronous: Number(sqlite.pragma('synchronous', { simple: true })),
    foreignKeys: Number(sqlite.pragma('foreign_keys', { simple: true })) === 1,
    busyTimeoutMs: Number(sqlite.pragma('busy_timeout', { simple: true })),
  };

  if (
    !pragmas.foreignKeys ||
    pragmas.synchronous !== 2 ||
    pragmas.busyTimeoutMs !== busyTimeoutMs
  ) {
    sqlite.close();
    throw new Error(`Failed to apply required SQLite pragmas: ${JSON.stringify(pragmas)}`);
  }

  const db = options.schema
    ? drizzle(sqlite, { schema: options.schema })
    : drizzle<TSchema>(sqlite);

  return {
    sqlite,
    db,
    pragmas,
    close() {
      if (sqlite.open) {
        sqlite.close();
      }
    },
  };
}
