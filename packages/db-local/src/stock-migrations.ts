import fs from 'node:fs';
import path from 'node:path';

/**
 * Generates SQLite MONOTONE enforcement triggers for inventory counts (`S3`):
 * - `inventory_counts`: once `status <> 'open'` (`finalized` or `cancelled`), blocks any further UPDATE.
 * - `inventory_count_lines`: blocks `INSERT` or `UPDATE` whenever the parent `inventory_counts` row
 *   is no longer `'open'`, and forbids moving a line to a different `count_id`.
 */
export function buildStockMonotoneTriggersSql(): string[] {
  return [
    `DROP TRIGGER IF EXISTS "trg_inventory_counts_monotone";`,
    `DROP TRIGGER IF EXISTS "trg_inventory_count_lines_parent_open_insert";`,
    `DROP TRIGGER IF EXISTS "trg_inventory_count_lines_parent_open_update";`,
    [
      'CREATE TRIGGER "trg_inventory_counts_monotone"',
      'BEFORE UPDATE ON "inventory_counts"',
      'FOR EACH ROW',
      `WHEN OLD."status" <> 'open'`,
      'BEGIN',
      `  SELECT RAISE(ABORT, 'MONOTONE table "inventory_counts" cannot be modified after finalize/cancel');`,
      'END;',
    ].join('\n'),
    [
      'CREATE TRIGGER "trg_inventory_count_lines_parent_open_insert"',
      'BEFORE INSERT ON "inventory_count_lines"',
      'FOR EACH ROW',
      'WHEN EXISTS (',
      `  SELECT 1 FROM "inventory_counts" c`,
      `  WHERE c."id" = NEW."count_id" AND c."status" <> 'open'`,
      ')',
      'BEGIN',
      `  SELECT RAISE(ABORT, 'Cannot insert inventory_count_lines into non-open inventory_count');`,
      'END;',
    ].join('\n'),
    [
      'CREATE TRIGGER "trg_inventory_count_lines_parent_open_update"',
      'BEFORE UPDATE ON "inventory_count_lines"',
      'FOR EACH ROW',
      'WHEN EXISTS (',
      `  SELECT 1 FROM "inventory_counts" c`,
      `  WHERE c."id" = OLD."count_id" AND c."status" <> 'open'`,
      ') OR NEW."count_id" <> OLD."count_id"',
      'BEGIN',
      `  SELECT RAISE(ABORT, 'Cannot modify inventory_count_lines of finalized or cancelled inventory_count');`,
      'END;',
    ].join('\n'),
  ];
}

function stripSqlComments(sqlText: string): string {
  return sqlText.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ');
}

function getLatestTriggerSql(
  sqlContent: string,
  timingEvent: 'BEFORE INSERT' | 'BEFORE UPDATE',
  tableName: string,
  requireWhen: boolean,
): string | null {
  const escapedTable = tableName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const tableRef = `(?:"${escapedTable}"|\`${escapedTable}\`|${escapedTable}(?=[\\s;,(]|$))`;
  const whenClause = requireWhen ? '\\s+WHEN\\s+([\\s\\S]*?)' : '(?:\\s+WHEN\\s+([\\s\\S]*?))?';
  const createPattern = new RegExp(
    `\\bCREATE\\s+TRIGGER\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?(?:"([^"]+)"|\`([^\`]+)\`|([a-zA-Z_][a-zA-Z0-9_]*))\\s+${timingEvent}\\s+ON\\s+${tableRef}\\s+FOR\\s+EACH\\s+ROW${whenClause}\\s+BEGIN([\\s\\S]*?)\\bEND\\s*;`,
    'gi',
  );

  let latest: {
    readonly name: string;
    readonly whenText: string;
    readonly body: string;
    readonly index: number;
  } | null = null;
  for (const m of sqlContent.matchAll(createPattern)) {
    const name = m[1] ?? m[2] ?? m[3];
    if (name && typeof m.index === 'number') {
      latest = {
        name,
        whenText: m[4] ?? '',
        body: m[5] ?? '',
        index: m.index,
      };
    }
  }
  if (!latest) {
    return null;
  }

  const escapedName = latest.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const dropPattern = new RegExp(
    `\\bDROP\\s+TRIGGER\\s+(?:IF\\s+EXISTS\\s+)?(?:"${escapedName}"|\`${escapedName}\`|${escapedName}(?=[\\s;]|$))`,
    'gi',
  );
  let latestDrop = -1;
  for (const d of sqlContent.matchAll(dropPattern)) {
    if (typeof d.index === 'number') {
      latestDrop = d.index;
    }
  }
  if (latest.index <= latestDrop) {
    return null;
  }
  return `${latest.whenText}\n${latest.body}`;
}

/**
 * Verifies committed SQLite migrations enforce MONOTONE immutability on both `inventory_counts`
 * and child `inventory_count_lines` (`S3` verification in `db:check`).
 */
export function assertStockMigrationsComplete(migrationsDir: string): void {
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

  const countTrig = getLatestTriggerSql(sqlContent, 'BEFORE UPDATE', 'inventory_counts', true);
  if (
    countTrig === null ||
    !/OLD\."?status"?\s*<>\s*'open'/i.test(countTrig) ||
    !/\bRAISE\s*\(\s*ABORT\b/i.test(countTrig)
  ) {
    throw new Error(
      'Missing active BEFORE UPDATE MONOTONE trigger on "inventory_counts" guarding status <> open',
    );
  }

  const lineInsTrig = getLatestTriggerSql(
    sqlContent,
    'BEFORE INSERT',
    'inventory_count_lines',
    true,
  );
  if (
    lineInsTrig === null ||
    !/\binventory_counts\b/i.test(lineInsTrig) ||
    !/status"?\s*<>\s*'open'/i.test(lineInsTrig) ||
    !/\bRAISE\s*\(\s*ABORT\b/i.test(lineInsTrig)
  ) {
    throw new Error(
      'Missing active BEFORE INSERT trigger on "inventory_count_lines" enforcing parent status = open',
    );
  }

  const lineUpdTrig = getLatestTriggerSql(
    sqlContent,
    'BEFORE UPDATE',
    'inventory_count_lines',
    true,
  );
  if (
    lineUpdTrig === null ||
    !/\binventory_counts\b/i.test(lineUpdTrig) ||
    !/status"?\s*<>\s*'open'/i.test(lineUpdTrig) ||
    !/\bRAISE\s*\(\s*ABORT\b/i.test(lineUpdTrig)
  ) {
    throw new Error(
      'Missing active BEFORE UPDATE trigger on "inventory_count_lines" enforcing parent status = open',
    );
  }
}
