import fs from 'node:fs';
import path from 'node:path';
import { SHIFT_EXPENSE_CATEGORIES } from '@mezon/domain';

function stripSqlComments(sqlText: string): string {
  return sqlText.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ');
}

function hasActiveTrigger(
  sqlContent: string,
  triggerName: string,
  timingEvent: 'BEFORE INSERT' | 'BEFORE UPDATE',
  tableName: string,
  requiredPattern: RegExp,
): boolean {
  const escapedName = triggerName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const escapedTable = tableName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const tableRef = `(?:"${escapedTable}"|\`${escapedTable}\`|${escapedTable}(?=[\\s;,(]|$))`;
  const createPattern = new RegExp(
    `\\bCREATE\\s+TRIGGER\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?(?:"${escapedName}"|\`${escapedName}\`|${escapedName})\\s+${timingEvent}\\s+ON\\s+${tableRef}\\s+FOR\\s+EACH\\s+ROW\\s+WHEN\\s+([\\s\\S]*?)\\bBEGIN([\\s\\S]*?)\\bEND\\s*;`,
    'gi',
  );

  let latest: { readonly text: string; readonly index: number } | null = null;
  for (const m of sqlContent.matchAll(createPattern)) {
    if (typeof m.index === 'number') {
      latest = { text: `${m[1] ?? ''}\n${m[2] ?? ''}`, index: m.index };
    }
  }
  if (!latest) {
    return false;
  }

  const dropPattern = new RegExp(
    `\\bDROP\\s+TRIGGER\\s+(?:IF\\s+EXISTS\\s+)?(?:"${escapedName}"|\`${escapedName}\`|${escapedName}(?=[\\s;]|$))`,
    'gi',
  );
  let latestDrop = -1;
  for (const d of sqlContent.matchAll(dropPattern)) {
    if (typeof d.index === 'number') {
      latestDrop = Math.max(latestDrop, d.index);
    }
  }
  if (latest.index <= latestDrop) {
    return false;
  }

  return requiredPattern.test(latest.text) && /\bRAISE\s*\(\s*ABORT\b/i.test(latest.text);
}

/**
 * Generates T1.9 SQLite MONOTONE + closed-shift guard triggers for `shifts`, `shift_cashier_sessions`,
 * `sales`, `returns`, and `cash_moves`.
 *
 * Includes X5 F2 sync comments: closed-shift `BEFORE INSERT` guards currently protect local offline
 * hub writes; when F2 introduces remote multi-terminal sync writes, these triggers must explicitly
 * allow F2 sync-mode inserts so synced historical records for already-closed shifts are accepted.
 */
export function buildShiftTriggersSql(): string[] {
  const expenseCatSqlList = SHIFT_EXPENSE_CATEGORIES.map((c) => `'${c}'`).join(', ');
  const syncNoteComment = [
    '-- X5 (F2 sync note): Blocks local POS/hub inserts into an already-closed shift.',
    '-- When F2 adds remote peer/cloud sync writes, update this trigger WHEN clause to permit',
    '-- explicit F2 sync-mode inserts so historical receipts for closed shifts can sync safely.',
  ].join('\n');

  return [
    'DROP TRIGGER IF EXISTS "trg_shifts_closed_monotone";',
    'DROP TRIGGER IF EXISTS "trg_shifts_immutable_core";',
    [
      'CREATE TRIGGER "trg_shifts_closed_monotone"',
      'BEFORE UPDATE ON "shifts"',
      'FOR EACH ROW',
      `WHEN OLD."status" = 'closed' OR OLD."closed_at_ms" IS NOT NULL`,
      'BEGIN',
      `  SELECT RAISE(ABORT, 'MONOTONE table "shifts" cannot be modified once closed');`,
      'END;',
    ].join('\n'),
    [
      'CREATE TRIGGER "trg_shifts_immutable_core"',
      'BEFORE UPDATE ON "shifts"',
      'FOR EACH ROW',
      'WHEN',
      `  OLD."status" = 'open' AND (`,
      `  NEW."status" <> 'closed' OR`,
      '  NEW."closed_at_ms" IS NULL OR',
      '  NEW."closed_by_user_id" IS NULL OR',
      '  NEW."close_client_request_id" IS NULL OR',
      '  NEW."close_request_hash" IS NULL OR',
      '  length(trim(NEW."close_request_hash")) < 6 OR',
      '  OLD."closed_by_user_id" IS NOT NULL OR',
      '  OLD."close_client_request_id" IS NOT NULL OR',
      '  OLD."close_request_hash" IS NOT NULL OR',
      '  NEW."id" IS NOT OLD."id" OR',
      '  NEW."organization_id" IS NOT OLD."organization_id" OR',
      '  NEW."store_id" IS NOT OLD."store_id" OR',
      '  NEW."shift_no" IS NOT OLD."shift_no" OR',
      '  NEW."shift_code" IS NOT OLD."shift_code" OR',
      '  NEW."opened_by_user_id" IS NOT OLD."opened_by_user_id" OR',
      '  NEW."opening_cash" IS NOT OLD."opening_cash" OR',
      '  NEW."previous_close_cash" IS NOT OLD."previous_close_cash" OR',
      '  NEW."opening_discrepancy" IS NOT OLD."opening_discrepancy" OR',
      '  NEW."opening_discrepancy_reason" IS NOT OLD."opening_discrepancy_reason" OR',
      '  NEW."opening_note" IS NOT OLD."opening_note" OR',
      '  NEW."opened_at_ms" IS NOT OLD."opened_at_ms" OR',
      '  NEW."open_client_request_id" IS NOT OLD."open_client_request_id" OR',
      '  NEW."open_request_hash" IS NOT OLD."open_request_hash" OR',
      '  NEW."created_at_ms" IS NOT OLD."created_at_ms")',
      'BEGIN',
      `  SELECT RAISE(ABORT, 'MONOTONE table "shifts" forbids mutating immutable open fields');`,
      'END;',
    ].join('\n'),
    'DROP TRIGGER IF EXISTS "trg_shift_cashier_sessions_closed_monotone";',
    'DROP TRIGGER IF EXISTS "trg_shift_cashier_sessions_immutable_core";',
    [
      'CREATE TRIGGER "trg_shift_cashier_sessions_closed_monotone"',
      'BEFORE UPDATE ON "shift_cashier_sessions"',
      'FOR EACH ROW',
      `WHEN OLD."status" = 'closed' OR OLD."ended_at_ms" IS NOT NULL`,
      'BEGIN',
      `  SELECT RAISE(ABORT, 'MONOTONE table "shift_cashier_sessions" cannot be modified once closed');`,
      'END;',
    ].join('\n'),
    [
      'CREATE TRIGGER "trg_shift_cashier_sessions_immutable_core"',
      'BEFORE UPDATE ON "shift_cashier_sessions"',
      'FOR EACH ROW',
      'WHEN',
      `  OLD."status" = 'active' AND (`,
      `  NEW."status" <> 'closed' OR`,
      '  NEW."ended_at_ms" IS NULL OR',
      '  NEW."expected_cash" IS NULL OR',
      '  NEW."counted_cash" IS NULL OR',
      '  NEW."discrepancy" IS NULL OR',
      '  NEW."id" IS NOT OLD."id" OR',
      '  NEW."organization_id" IS NOT OLD."organization_id" OR',
      '  NEW."store_id" IS NOT OLD."store_id" OR',
      '  NEW."shift_id" IS NOT OLD."shift_id" OR',
      '  NEW."session_seq" IS NOT OLD."session_seq" OR',
      '  NEW."cashier_user_id" IS NOT OLD."cashier_user_id" OR',
      '  NEW."opening_float" IS NOT OLD."opening_float" OR',
      '  NEW."started_at_ms" IS NOT OLD."started_at_ms" OR',
      '  NEW."created_at_ms" IS NOT OLD."created_at_ms")',
      'BEGIN',
      `  SELECT RAISE(ABORT, 'MONOTONE table "shift_cashier_sessions" forbids mutating immutable session fields');`,
      'END;',
    ].join('\n'),
    'DROP TRIGGER IF EXISTS "trg_sales_closed_shift_guard";',
    [
      syncNoteComment,
      'CREATE TRIGGER "trg_sales_closed_shift_guard"',
      'BEFORE INSERT ON "sales"',
      'FOR EACH ROW',
      'WHEN NEW."shift_id" IS NOT NULL AND EXISTS (',
      `  SELECT 1 FROM "shifts" sh WHERE sh."id" = NEW."shift_id" AND sh."status" = 'closed'`,
      ')',
      'BEGIN',
      `  SELECT RAISE(ABORT, 'Cannot insert into "sales" referencing an already closed shift');`,
      'END;',
    ].join('\n'),
    'DROP TRIGGER IF EXISTS "trg_returns_closed_shift_guard";',
    [
      syncNoteComment,
      'CREATE TRIGGER "trg_returns_closed_shift_guard"',
      'BEFORE INSERT ON "returns"',
      'FOR EACH ROW',
      'WHEN NEW."shift_id" IS NOT NULL AND EXISTS (',
      `  SELECT 1 FROM "shifts" sh WHERE sh."id" = NEW."shift_id" AND sh."status" = 'closed'`,
      ')',
      'BEGIN',
      `  SELECT RAISE(ABORT, 'Cannot insert into "returns" referencing an already closed shift');`,
      'END;',
    ].join('\n'),
    'DROP TRIGGER IF EXISTS "trg_cash_moves_closed_shift_guard";',
    [
      syncNoteComment,
      'CREATE TRIGGER "trg_cash_moves_closed_shift_guard"',
      'BEFORE INSERT ON "cash_moves"',
      'FOR EACH ROW',
      'WHEN NEW."shift_id" IS NOT NULL AND EXISTS (',
      `  SELECT 1 FROM "shifts" sh WHERE sh."id" = NEW."shift_id" AND sh."status" = 'closed'`,
      ')',
      'BEGIN',
      `  SELECT RAISE(ABORT, 'Cannot insert into "cash_moves" referencing an already closed shift');`,
      'END;',
    ].join('\n'),
    'DROP TRIGGER IF EXISTS "trg_cash_moves_expense_cat_guard";',
    [
      'CREATE TRIGGER "trg_cash_moves_expense_cat_guard"',
      'BEFORE INSERT ON "cash_moves"',
      'FOR EACH ROW',
      'WHEN',
      `  (NEW."type" <> 'cash_out' AND NEW."expense_category" IS NOT NULL) OR`,
      `  (NEW."expense_category" IS NOT NULL AND NEW."expense_category" NOT IN (${expenseCatSqlList}))`,
      'BEGIN',
      `  SELECT RAISE(ABORT, 'Invalid expense_category on "cash_moves"');`,
      'END;',
    ].join('\n'),
  ];
}

/**
 * Verifies committed T1.9 shift & day-close migrations enforce MONOTONE transitions, closed-shift
 * INSERT guards (with X5 F2 sync comments), single-open partial indexes, and `v_sales_lines` shift columns.
 */
export function assertShiftMigrationsComplete(migrationsDir: string): void {
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

  if (
    !hasActiveTrigger(
      sqlContent,
      'trg_shifts_closed_monotone',
      'BEFORE UPDATE',
      'shifts',
      /OLD\."?status"?\s*=\s*'closed'/i,
    ) ||
    !hasActiveTrigger(
      sqlContent,
      'trg_shifts_immutable_core',
      'BEFORE UPDATE',
      'shifts',
      /NEW\."?opening_cash"?\s+IS\s+NOT\s+OLD\."?opening_cash"?/i,
    )
  ) {
    throw new Error('Missing or incomplete active MONOTONE triggers on "shifts"');
  }

  if (
    !hasActiveTrigger(
      sqlContent,
      'trg_shift_cashier_sessions_closed_monotone',
      'BEFORE UPDATE',
      'shift_cashier_sessions',
      /OLD\."?status"?\s*=\s*'closed'/i,
    ) ||
    !hasActiveTrigger(
      sqlContent,
      'trg_shift_cashier_sessions_immutable_core',
      'BEFORE UPDATE',
      'shift_cashier_sessions',
      /NEW\."?opening_float"?\s+IS\s+NOT\s+OLD\."?opening_float"?/i,
    )
  ) {
    throw new Error('Missing or incomplete active MONOTONE triggers on "shift_cashier_sessions"');
  }

  for (const tbl of ['sales', 'returns', 'cash_moves'] as const) {
    if (
      !hasActiveTrigger(
        sqlContent,
        `trg_${tbl}_closed_shift_guard`,
        'BEFORE INSERT',
        tbl,
        /sh\."?status"?\s*=\s*'closed'/i,
      )
    ) {
      throw new Error(`Missing active closed-shift INSERT guard trigger on "${tbl}"`);
    }
  }

  if (
    !hasActiveTrigger(
      sqlContent,
      'trg_cash_moves_expense_cat_guard',
      'BEFORE INSERT',
      'cash_moves',
      /expense_category/i,
    )
  ) {
    throw new Error('Missing active expense_category guard trigger on "cash_moves"');
  }

  if (
    !/CREATE\s+UNIQUE\s+INDEX\s+[\s\S]*?uidx_shifts_one_open_per_device[\s\S]*?WHERE[\s\S]*?status[\s\S]*?'open'/i.test(
      sqlContent,
    )
  ) {
    throw new Error('Missing active partial unique index "uidx_shifts_one_open_per_device"');
  }
  if (
    !/CREATE\s+UNIQUE\s+INDEX\s+[\s\S]*?uidx_shift_cashier_one_active[\s\S]*?WHERE[\s\S]*?status[\s\S]*?'active'/i.test(
      sqlContent,
    )
  ) {
    throw new Error('Missing active partial unique index "uidx_shift_cashier_one_active"');
  }

  // Ensure latest v_sales_lines exposes shift_id & shift_cashier_session_id
  const viewMatches = [
    ...sqlContent.matchAll(
      /\bCREATE\s+VIEW\s+(?:"v_sales_lines"|`v_sales_lines`|v_sales_lines)\s+AS\s+([\s\S]*?);/gi,
    ),
  ];
  const latestView = viewMatches[viewMatches.length - 1]?.[1] ?? '';
  if (!/shift_id/i.test(latestView) || !/shift_cashier_session_id/i.test(latestView)) {
    throw new Error(
      'Latest SQLite view "v_sales_lines" must expose "shift_id" and "shift_cashier_session_id"',
    );
  }
}
