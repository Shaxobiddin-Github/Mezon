import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import type { SqliteTableMetadata, TableClass } from './registry.js';

const IDENTIFIER_REGEX = /^[a-z_][a-z0-9_]{0,62}$/;

function assertSqlIdentifier(name: string): string {
  if (!IDENTIFIER_REGEX.test(name)) {
    throw new RangeError(`Invalid SQLite SQL identifier: "${name}"`);
  }
  return name;
}

function quoteIdent(name: string): string {
  return `"${assertSqlIdentifier(name)}"`;
}

/**
 * Generates SQLite immutability triggers enforcing `GEMINI.md` Section 3.1 record-class rules:
 * - `FACT`: blocks both `UPDATE` and `DELETE` via `RAISE(ABORT, ...)`
 * - `ATTR` / `MONOTONE`: blocks physical `DELETE` via `RAISE(ABORT, ...)` (tombstone only)
 * - `LOCAL`: no immutability triggers generated (operational tables such as outbox & device_state)
 *
 * Note: Database-level MONOTONE transition checks (e.g. irreversible `voided_at` using `BEFORE UPDATE ... WHEN`)
 * will be added in later tasks as MONOTONE tables are introduced.
 */
export function buildSqliteImmutabilityTriggersSql(
  tableName: string,
  tableClass: TableClass,
): string[] {
  const ident = assertSqlIdentifier(tableName);
  const qTable = quoteIdent(ident);

  if (tableClass === 'LOCAL') {
    return [];
  }

  const dropDelete = `DROP TRIGGER IF EXISTS ${quoteIdent(`trg_${ident}_no_delete`)};`;
  const createDelete = [
    `CREATE TRIGGER ${quoteIdent(`trg_${ident}_no_delete`)}`,
    `BEFORE DELETE ON ${qTable}`,
    'FOR EACH ROW',
    'BEGIN',
    `  SELECT RAISE(ABORT, '${tableClass} table "${ident}" forbids physical DELETE: use tombstone');`,
    'END;',
  ].join('\n');

  if (tableClass === 'FACT') {
    const dropUpdate = `DROP TRIGGER IF EXISTS ${quoteIdent(`trg_${ident}_no_update`)};`;
    const createUpdate = [
      `CREATE TRIGGER ${quoteIdent(`trg_${ident}_no_update`)}`,
      `BEFORE UPDATE ON ${qTable}`,
      'FOR EACH ROW',
      'BEGIN',
      `  SELECT RAISE(ABORT, 'FACT table "${ident}" is immutable: UPDATE is forbidden');`,
      'END;',
    ].join('\n');
    return [dropUpdate, createUpdate, dropDelete, createDelete];
  }

  return [dropDelete, createDelete];
}

export function buildAllSqliteTriggersSql(tables: readonly SqliteTableMetadata[]): string[] {
  const statements: string[] = [];
  for (const meta of tables) {
    statements.push(...buildSqliteImmutabilityTriggersSql(meta.tableName, meta.tableClass));
  }
  return statements;
}

export function applySqliteImmutabilityTriggers(
  sqlite: Database.Database,
  tables: readonly SqliteTableMetadata[],
): void {
  const statements = buildAllSqliteTriggersSql(tables);
  for (const stmt of statements) {
    sqlite.exec(stmt);
  }
}

function stripSqlComments(sqlText: string): string {
  return sqlText.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function hasActiveAbortTrigger(
  sqlContent: string,
  tableRefPattern: string,
  timingEvent: 'BEFORE UPDATE' | 'BEFORE DELETE',
): boolean {
  const trigPattern = new RegExp(
    `\\bCREATE\\s+TRIGGER\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?(?:"([^"]+)"|\`([^\`]+)\`|([a-zA-Z_][a-zA-Z0-9_]*))\\s+${timingEvent}\\s+ON\\s+${tableRefPattern}(?:\\s+FOR\\s+EACH\\s+ROW)?\\s+BEGIN(?:(?!\\bEND\\s*;)[\\s\\S])*?\\bSELECT\\s+RAISE\\s*\\(\\s*ABORT\\b(?:(?!\\bEND\\s*;)[\\s\\S])*?\\bEND\\s*;`,
    'gi',
  );

  let latestActiveTrigger: { readonly name: string; readonly index: number } | null = null;
  for (const match of sqlContent.matchAll(trigPattern)) {
    const name = match[1] ?? match[2] ?? match[3];
    if (name && typeof match.index === 'number') {
      latestActiveTrigger = { name, index: match.index };
    }
  }

  if (!latestActiveTrigger) {
    return false;
  }

  const escapedTrig = escapeRegExp(latestActiveTrigger.name);
  const dropPattern = new RegExp(
    `\\bDROP\\s+TRIGGER\\s+(?:IF\\s+EXISTS\\s+)?(?:"${escapedTrig}"|\`${escapedTrig}\`|${escapedTrig}(?=[\\s;]|$))`,
    'gi',
  );
  let latestDropIndex = -1;
  for (const dropMatch of sqlContent.matchAll(dropPattern)) {
    if (typeof dropMatch.index === 'number') {
      latestDropIndex = dropMatch.index;
    }
  }

  return latestActiveTrigger.index > latestDropIndex;
}

/**
 * Verifies that committed SQLite SQL migrations define active `RAISE(ABORT)` immutability triggers
 * matching every non-`LOCAL` table registered in `SqliteSchemaRegistry`:
 * - `FACT`: active `BEFORE UPDATE` + `BEFORE DELETE` triggers with `RAISE(ABORT)`
 * - `ATTR` / `MONOTONE`: active `BEFORE DELETE` trigger with `RAISE(ABORT)`, and no blanket
 *   (unconditional) `BEFORE UPDATE ... RAISE(ABORT)` blocking valid attribute/monotone updates.
 */
export function assertSqliteTriggersMigrationsComplete(
  migrationsDir: string,
  tables: readonly SqliteTableMetadata[],
): void {
  const syncedTables = tables.filter((t) => t.tableClass !== 'LOCAL');
  if (syncedTables.length === 0) {
    return;
  }

  if (!fs.existsSync(migrationsDir)) {
    throw new Error(`Migrations directory not found at "${migrationsDir}"`);
  }

  const rawSql = fs
    .readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((f) => fs.readFileSync(path.join(migrationsDir, f), 'utf8'))
    .join('\n');
  const sqlContent = stripSqlComments(rawSql);

  for (const meta of syncedTables) {
    const escaped = escapeRegExp(meta.tableName);
    const tableRefPattern = `(?:"${escaped}"|\`${escaped}\`|${escaped}(?=[\\s;,(]|$))`;

    const hasDeleteTrigger = hasActiveAbortTrigger(sqlContent, tableRefPattern, 'BEFORE DELETE');
    if (!hasDeleteTrigger) {
      throw new Error(
        `Synced SQLite table "${meta.tableName}" (${meta.tableClass}) is missing required BEFORE DELETE RAISE(ABORT) trigger in migrations`,
      );
    }

    if (meta.tableClass === 'FACT') {
      const hasUpdateTrigger = hasActiveAbortTrigger(sqlContent, tableRefPattern, 'BEFORE UPDATE');
      if (!hasUpdateTrigger) {
        throw new Error(
          `Immutable FACT SQLite table "${meta.tableName}" is missing required BEFORE UPDATE RAISE(ABORT) trigger in migrations`,
        );
      }
    } else {
      // Catch mistaken blanket BEFORE UPDATE immutability trigger on ATTR/MONOTONE tables
      // while allowing column-scoped/WHEN monotone transition triggers in future tasks.
      const blanketUpdatePattern = new RegExp(
        `\\bCREATE\\s+TRIGGER\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?(?:"[^"]+"|\`[^\`]+\`|[a-zA-Z_][a-zA-Z0-9_]*)\\s+BEFORE\\s+UPDATE\\s+ON\\s+${tableRefPattern}\\s+FOR\\s+EACH\\s+ROW\\s+BEGIN(?:(?!\\bEND\\s*;)[\\s\\S])*?\\bRAISE\\s*\\(\\s*ABORT\\b`,
        'i',
      );
      if (blanketUpdatePattern.test(sqlContent)) {
        throw new Error(
          `Mutable ${meta.tableClass} SQLite table "${meta.tableName}" must not define an unconditional BEFORE UPDATE RAISE(ABORT) trigger`,
        );
      }
    }
  }
}
