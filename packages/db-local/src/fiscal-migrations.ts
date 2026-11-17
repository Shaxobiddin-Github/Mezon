import fs from 'node:fs';
import path from 'node:path';
import { FISCAL_DOC_STATUSES, FISCAL_DOC_TRANSITIONS } from '@mezon/domain';

/**
 * T3.3 `fiscal_docs` MONOTONE triggers, DERIVED from the single domain transition table
 * (`FISCAL_DOC_TRANSITIONS`) so the database, the domain and the cloud rule cannot drift
 * (`monotone-parity.test.ts`).
 *
 * - `trg_fiscal_docs_transition`: a status change must be an allowed pair.
 * - `trg_fiscal_docs_terminal`: `confirmed` / `cancelled` rows are frozen; `rejected` may only
 *   move to `cancelled` (no in-place bookkeeping on a rejected row).
 * - `trg_fiscal_docs_immutable_core`: identity, links, driver and deadline never change; attempts
 *   never decrease.
 */
export function buildFiscalDocsTriggersSql(): string[] {
  const allowedPairs = FISCAL_DOC_STATUSES.flatMap((from) =>
    FISCAL_DOC_TRANSITIONS[from].map(
      (to) => `(OLD."status" = '${from}' AND NEW."status" = '${to}')`,
    ),
  );
  return [
    'DROP TRIGGER IF EXISTS "trg_fiscal_docs_transition";',
    'DROP TRIGGER IF EXISTS "trg_fiscal_docs_terminal";',
    'DROP TRIGGER IF EXISTS "trg_fiscal_docs_immutable_core";',
    [
      'CREATE TRIGGER "trg_fiscal_docs_transition"',
      'BEFORE UPDATE ON "fiscal_docs"',
      'FOR EACH ROW',
      'WHEN NEW."status" IS NOT OLD."status" AND NOT (',
      `  ${allowedPairs.join(' OR\n  ')}`,
      ')',
      'BEGIN',
      `  SELECT RAISE(ABORT, 'MONOTONE table "fiscal_docs" forbids this status transition');`,
      'END;',
    ].join('\n'),
    [
      'CREATE TRIGGER "trg_fiscal_docs_terminal"',
      'BEFORE UPDATE ON "fiscal_docs"',
      'FOR EACH ROW',
      `WHEN OLD."status" IN ('confirmed', 'cancelled') OR (OLD."status" = 'rejected' AND NEW."status" IS NOT 'cancelled')`,
      'BEGIN',
      `  SELECT RAISE(ABORT, 'MONOTONE table "fiscal_docs" cannot be modified once confirmed, cancelled or rejected');`,
      'END;',
    ].join('\n'),
    [
      'CREATE TRIGGER "trg_fiscal_docs_immutable_core"',
      'BEFORE UPDATE ON "fiscal_docs"',
      'FOR EACH ROW',
      'WHEN',
      '  NEW."id" IS NOT OLD."id" OR',
      '  NEW."organization_id" IS NOT OLD."organization_id" OR',
      '  NEW."store_id" IS NOT OLD."store_id" OR',
      '  NEW."created_at_ms" IS NOT OLD."created_at_ms" OR',
      '  NEW."doc_kind" IS NOT OLD."doc_kind" OR',
      '  NEW."sale_id" IS NOT OLD."sale_id" OR',
      '  NEW."return_id" IS NOT OLD."return_id" OR',
      '  NEW."shift_id" IS NOT OLD."shift_id" OR',
      '  NEW."depends_on_doc_id" IS NOT OLD."depends_on_doc_id" OR',
      '  NEW."idempotency_key" IS NOT OLD."idempotency_key" OR',
      '  NEW."driver_id" IS NOT OLD."driver_id" OR',
      '  NEW."offline_deadline_ms" IS NOT OLD."offline_deadline_ms" OR',
      '  NEW."attempts" < OLD."attempts"',
      'BEGIN',
      `  SELECT RAISE(ABORT, 'MONOTONE table "fiscal_docs" forbids mutating immutable fields');`,
      'END;',
    ].join('\n'),
  ];
}

function stripSqlComments(sqlText: string): string {
  return sqlText.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ');
}

/** Normalizes whitespace so committed SQL is compared to the generated triggers exactly. */
function squash(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * Verifies that the committed migrations contain the CURRENT generated `fiscal_docs` triggers
 * verbatim (whitespace-insensitive), so changing `FISCAL_DOC_TRANSITIONS` without a new migration
 * fails `db:check` and the tests.
 */
export function assertFiscalMigrationsComplete(migrationsDir: string): void {
  if (!fs.existsSync(migrationsDir)) {
    throw new Error(`Migrations directory not found at "${migrationsDir}"`);
  }
  const files = fs
    .readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  const all = squash(
    stripSqlComments(
      files.map((f) => fs.readFileSync(path.join(migrationsDir, f), 'utf8')).join('\n'),
    ),
  );
  for (const stmt of buildFiscalDocsTriggersSql().filter((s) => s.startsWith('CREATE TRIGGER'))) {
    const needle = squash(stmt);
    const at = all.lastIndexOf(needle);
    if (at < 0) {
      throw new Error(`Missing current fiscal_docs trigger in migrations: ${stmt.split('\n')[0]}`);
    }
    const name = /"([^"]+)"/.exec(stmt)?.[1] ?? '';
    const drop = all.lastIndexOf(`DROP TRIGGER IF EXISTS "${name}"`);
    const laterCreate = all.indexOf(`CREATE TRIGGER "${name}"`, at + 1);
    if (drop > at || laterCreate > at) {
      throw new Error(
        `fiscal_docs trigger "${name}" is dropped or replaced after its current definition`,
      );
    }
  }
}
