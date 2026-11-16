import { createCloudPgPool, migrateCloudDatabase } from '@mezon/db-cloud';

export async function runCloudMigrations(adminUrl?: string): Promise<void> {
  const url = adminUrl ?? process.env.DATABASE_ADMIN_URL;
  if (!url) {
    throw new Error('DATABASE_ADMIN_URL environment variable is required to run migrations');
  }

  console.log('[db:migrate] Connecting with DATABASE_ADMIN_URL...');
  const conn = createCloudPgPool({ connectionString: url });
  try {
    console.log('[db:migrate] Applying PostgreSQL migrations...');
    await migrateCloudDatabase(conn.db);
    console.log('[db:migrate] Migrations completed successfully.');
  } finally {
    await conn.close();
  }
}

if (process.argv[1]?.endsWith('migrate.ts') || process.argv[1]?.endsWith('migrate.js')) {
  runCloudMigrations().catch((err) => {
    console.error('[db:migrate] Migration failed:', err);
    process.exit(1);
  });
}
