import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { is } from 'drizzle-orm';
import { SQLiteTable } from 'drizzle-orm/sqlite-core';
import { generateSQLiteDrizzleJson, generateSQLiteMigration } from 'drizzle-kit/api';

const pkgRoot = path.resolve(import.meta.dirname, '..');
const drizzleKitBin = path.join(pkgRoot, 'node_modules', 'drizzle-kit', 'bin.cjs');
const migrationsDir = path.join(pkgRoot, 'drizzle');
const journalPath = path.join(migrationsDir, 'meta', '_journal.json');

if (!fs.existsSync(journalPath)) {
  throw new Error(`Missing Drizzle journal at ${journalPath}`);
}

execFileSync(process.execPath, [drizzleKitBin, 'check', '--config', 'drizzle.config.ts'], {
  cwd: pkgRoot,
  stdio: 'inherit',
});

const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8'));
if (!Array.isArray(journal.entries) || journal.entries.length === 0) {
  throw new Error('Drizzle journal must contain at least one baseline migration entry');
}

const lastEntry = journal.entries[journal.entries.length - 1];
const prefix = String(lastEntry.idx).padStart(4, '0');
const snapshotPath = path.join(migrationsDir, 'meta', `${prefix}_snapshot.json`);
if (!fs.existsSync(snapshotPath)) {
  throw new Error(`Missing Drizzle snapshot at ${snapshotPath}`);
}

const prevSnapshot = JSON.parse(fs.readFileSync(snapshotPath, 'utf8'));
const distSchemaUrl = new URL(
  `file:///${path.join(pkgRoot, 'dist', 'index.js').replace(/\\/g, '/')}`,
);
const schemaPkg = await import(distSchemaUrl.href);

const schemaTables = {};
for (const [key, val] of Object.entries(schemaPkg)) {
  if (is(val, SQLiteTable)) {
    schemaTables[key] = val;
  }
}
if (schemaPkg.localSchemaRegistry) {
  for (const meta of schemaPkg.localSchemaRegistry.all()) {
    schemaTables[meta.tableName] = meta.table;
  }
  schemaPkg.assertSqliteTriggersMigrationsComplete(
    migrationsDir,
    schemaPkg.localSchemaRegistry.all(),
  );
}
if (schemaPkg.assertCatalogSearchMigrationsComplete) {
  schemaPkg.assertCatalogSearchMigrationsComplete(migrationsDir);
}
if (schemaPkg.assertStockMigrationsComplete) {
  schemaPkg.assertStockMigrationsComplete(migrationsDir);
}
if (schemaPkg.assertSaleMigrationsComplete) {
  schemaPkg.assertSaleMigrationsComplete(migrationsDir);
}
if (schemaPkg.assertReturnAndViewMigrationsComplete) {
  schemaPkg.assertReturnAndViewMigrationsComplete(migrationsDir);
}
if (schemaPkg.assertCustomerMigrationsComplete) {
  schemaPkg.assertCustomerMigrationsComplete(migrationsDir);
}
if (schemaPkg.assertSupplierMigrationsComplete) {
  schemaPkg.assertSupplierMigrationsComplete(migrationsDir);
}

const currSnapshot = await generateSQLiteDrizzleJson(schemaTables);
const diffStatements = await generateSQLiteMigration(prevSnapshot, currSnapshot);

if (diffStatements.length > 0) {
  throw new Error(
    `SQLite schema and migrations are out of sync (${diffStatements.length} unmigrated DDL statement(s)):\n${diffStatements.join('\n')}`,
  );
}

console.log('SQLite schema matches committed migrations (0 diff statements).');
