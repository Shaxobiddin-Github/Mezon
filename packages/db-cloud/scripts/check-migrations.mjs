import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { is } from 'drizzle-orm';
import { PgTable } from 'drizzle-orm/pg-core';
import { generateDrizzleJson, generateMigration } from 'drizzle-kit/api';

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
const distPkgUrl = new URL(`file:///${path.join(pkgRoot, 'dist', 'index.js').replace(/\\/g, '/')}`);
const cloudPkg = await import(distPkgUrl.href);

const schemaTables = {};
if (cloudPkg.cloudSchemaRegistry) {
  for (const meta of cloudPkg.cloudSchemaRegistry.all()) {
    schemaTables[meta.tableName] = meta.table;
  }
  cloudPkg.assertRlsMigrationsComplete(migrationsDir, cloudPkg.cloudSchemaRegistry.all());
}
for (const [key, val] of Object.entries(cloudPkg)) {
  if (is(val, PgTable) && !Object.values(schemaTables).includes(val)) {
    schemaTables[key] = val;
  }
}

const currSnapshot = await generateDrizzleJson(schemaTables);
const diffStatements = await generateMigration(prevSnapshot, currSnapshot);

if (diffStatements.length > 0) {
  throw new Error(
    `PostgreSQL schema and migrations are out of sync (${diffStatements.length} unmigrated DDL statement(s)):\n${diffStatements.join('\n')}`,
  );
}

console.log('PostgreSQL schema matches committed migrations (0 diff statements).');
