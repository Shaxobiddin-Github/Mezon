import path from 'node:path';
import { type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';

export function getDefaultLocalMigrationsFolder(): string {
  return path.resolve(import.meta.dirname, '..', 'drizzle');
}

export function migrateLocalDatabase<TSchema extends Record<string, unknown>>(
  db: BetterSQLite3Database<TSchema>,
  migrationsFolder: string = getDefaultLocalMigrationsFolder(),
): void {
  migrate(db, { migrationsFolder });
}
