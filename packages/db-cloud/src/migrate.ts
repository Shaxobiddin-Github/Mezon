import path from 'node:path';
import { type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';

export function getDefaultCloudMigrationsFolder(): string {
  return path.resolve(import.meta.dirname, '..', 'drizzle');
}

export async function migrateCloudDatabase<TSchema extends Record<string, unknown>>(
  db: NodePgDatabase<TSchema>,
  migrationsFolder: string = getDefaultCloudMigrationsFolder(),
): Promise<void> {
  await migrate(db, { migrationsFolder });
}
