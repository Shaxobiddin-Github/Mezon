#!/usr/bin/env node
// T3.8 audit chain verification command.
// Usage: pnpm --filter @mezon/db-local audit:verify <path-to-hub.db>
// Exit code 0 = every organization's chain is intact, 1 = broken (the first broken seq is printed),
// 2 = usage / file error. The database is opened read-only.
import fs from 'node:fs';
import Database from 'better-sqlite3';
import { verifyAuditChainSync } from '../dist/index.js';

const dbPath = process.argv[2];
if (!dbPath || !fs.existsSync(dbPath)) {
  console.error('Usage: audit-verify <path-to-hub.db>');
  process.exit(2);
}
const sqlite = new Database(dbPath, { readonly: true, fileMustExist: true });
sqlite.defaultSafeIntegers(true);
try {
  const orgs = sqlite.prepare('SELECT DISTINCT organization_id AS o FROM local_audit_log').all();
  let ok = true;
  for (const { o } of orgs) {
    const r = verifyAuditChainSync(sqlite, o);
    console.log(JSON.stringify({ organizationId: o, ...r }));
    if (!r.ok) ok = false;
  }
  if (orgs.length === 0) console.log(JSON.stringify({ ok: true, checked: 0 }));
  process.exit(ok ? 0 : 1);
} finally {
  sqlite.close();
}
