import fs from 'node:fs';
import path from 'node:path';

/**
 * Generates SQLite MONOTONE enforcement triggers for `sales`:
 * - Once `OLD.voided_at_ms IS NOT NULL`, blocks any further UPDATE.
 * - Blocks modifying any core receipt/totals/actor column, or clearing `voided_at_ms`; only the
 *   one-way transition `OLD.voided_at_ms IS NULL -> NEW.voided_at_ms IS NOT NULL` is allowed (T1.6).
 */
export function buildSaleMonotoneTriggersSql(): string[] {
  return [
    `DROP TRIGGER IF EXISTS "trg_sales_voided_monotone";`,
    `DROP TRIGGER IF EXISTS "trg_sales_immutable_core";`,
    [
      'CREATE TRIGGER "trg_sales_voided_monotone"',
      'BEFORE UPDATE ON "sales"',
      'FOR EACH ROW',
      'WHEN OLD."voided_at_ms" IS NOT NULL',
      'BEGIN',
      `  SELECT RAISE(ABORT, 'MONOTONE table "sales" cannot be modified once voided');`,
      'END;',
    ].join('\n'),
    [
      'CREATE TRIGGER "trg_sales_immutable_core"',
      'BEFORE UPDATE ON "sales"',
      'FOR EACH ROW',
      'WHEN',
      '  OLD."voided_at_ms" IS NULL AND (',
      '  NEW."voided_at_ms" IS NULL OR',
      '  NEW."voided_by_user_id" IS NULL OR',
      '  NEW."void_reason" IS NULL OR',
      '  length(trim(NEW."void_reason")) = 0 OR',
      '  NEW."void_client_request_id" IS NULL OR',
      '  NEW."void_request_hash" IS NULL OR',
      '  length(trim(NEW."void_request_hash")) < 6 OR',
      '  OLD."voided_by_user_id" IS NOT NULL OR',
      '  OLD."void_reason" IS NOT NULL OR',
      '  OLD."void_client_request_id" IS NOT NULL OR',
      '  OLD."void_request_hash" IS NOT NULL OR',
      '  NEW."id" IS NOT OLD."id" OR',
      '  NEW."organization_id" IS NOT OLD."organization_id" OR',
      '  NEW."store_id" IS NOT OLD."store_id" OR',
      '  NEW."receipt_no" IS NOT OLD."receipt_no" OR',
      '  NEW."receipt_code" IS NOT OLD."receipt_code" OR',
      '  NEW."source_cart_id" IS NOT OLD."source_cart_id" OR',
      '  NEW."cashier_user_id" IS NOT OLD."cashier_user_id" OR',
      '  NEW."completed_by_user_id" IS NOT OLD."completed_by_user_id" OR',
      '  NEW."customer_id" IS NOT OLD."customer_id" OR',
      '  NEW."shift_id" IS NOT OLD."shift_id" OR',
      '  NEW."client_request_id" IS NOT OLD."client_request_id" OR',
      '  NEW."request_hash" IS NOT OLD."request_hash" OR',
      '  NEW."subtotal_gross" IS NOT OLD."subtotal_gross" OR',
      '  NEW."total_promo_discount" IS NOT OLD."total_promo_discount" OR',
      '  NEW."subtotal_after_promo" IS NOT OLD."subtotal_after_promo" OR',
      '  NEW."manual_discount_mode" IS NOT OLD."manual_discount_mode" OR',
      '  NEW."manual_discount_value" IS NOT OLD."manual_discount_value" OR',
      '  NEW."manual_discount_reason" IS NOT OLD."manual_discount_reason" OR',
      '  NEW."order_discount_amount" IS NOT OLD."order_discount_amount" OR',
      '  NEW."total_final" IS NOT OLD."total_final" OR',
      '  NEW."total_net_ex_vat" IS NOT OLD."total_net_ex_vat" OR',
      '  NEW."total_vat" IS NOT OLD."total_vat" OR',
      '  NEW."total_paid" IS NOT OLD."total_paid" OR',
      '  NEW."debt_amount" IS NOT OLD."debt_amount" OR',
      '  NEW."change_amount" IS NOT OLD."change_amount" OR',
      '  NEW."override_approved_by_user_id" IS NOT OLD."override_approved_by_user_id" OR',
      '  NEW."override_approved_amount" IS NOT OLD."override_approved_amount" OR',
      '  NEW."override_approved_at_ms" IS NOT OLD."override_approved_at_ms" OR',
      '  NEW."created_at_ms" IS NOT OLD."created_at_ms")',
      'BEGIN',
      `  SELECT RAISE(ABORT, 'MONOTONE table "sales" forbids updating immutable receipt fields');`,
      'END;',
    ].join('\n'),
  ];
}

function stripSqlComments(sqlText: string): string {
  return sqlText.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ');
}

function hasActiveWhenTrigger(
  sqlContent: string,
  triggerName: string,
  tableName: string,
  requiredPattern: RegExp,
): boolean {
  const escapedName = triggerName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const escapedTable = tableName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const tableRef = `(?:"${escapedTable}"|\`${escapedTable}\`|${escapedTable}(?=[\\s;,(]|$))`;
  const createPattern = new RegExp(
    `\\bCREATE\\s+TRIGGER\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?(?:"${escapedName}"|\`${escapedName}\`|${escapedName})\\s+BEFORE\\s+UPDATE\\s+ON\\s+${tableRef}\\s+FOR\\s+EACH\\s+ROW\\s+WHEN\\s+([\\s\\S]*?)\\bBEGIN([\\s\\S]*?)\\bEND\\s*;`,
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
  const dropTablePattern = new RegExp(`\\bDROP\\s+TABLE\\s+(?:IF\\s+EXISTS\\s+)?${tableRef}`, 'gi');
  for (const dt of sqlContent.matchAll(dropTablePattern)) {
    if (typeof dt.index === 'number') {
      latestDrop = Math.max(latestDrop, dt.index);
    }
  }
  if (latest.index <= latestDrop) {
    return false;
  }

  return requiredPattern.test(latest.text) && /\bRAISE\s*\(\s*ABORT\b/i.test(latest.text);
}

/**
 * Verifies committed SQLite migrations enforce MONOTONE immutability on `sales`
 * and recreate immutability triggers after any table rebuild (`db:check`).
 */
export function assertSaleMigrationsComplete(migrationsDir: string): void {
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
    !hasActiveWhenTrigger(
      sqlContent,
      'trg_sales_voided_monotone',
      'sales',
      /OLD\."?voided_at_ms"?\s+IS\s+NOT\s+NULL/i,
    )
  ) {
    throw new Error(
      'Missing active BEFORE UPDATE MONOTONE trigger "trg_sales_voided_monotone" on "sales"',
    );
  }

  if (
    !hasActiveWhenTrigger(
      sqlContent,
      'trg_sales_immutable_core',
      'sales',
      /NEW\."?total_final"?\s+IS\s+NOT\s+OLD\."?total_final"?/i,
    ) ||
    !hasActiveWhenTrigger(
      sqlContent,
      'trg_sales_immutable_core',
      'sales',
      /NEW\."?completed_by_user_id"?\s+IS\s+NOT\s+OLD\."?completed_by_user_id"?/i,
    ) ||
    !hasActiveWhenTrigger(
      sqlContent,
      'trg_sales_immutable_core',
      'sales',
      /NEW\."?request_hash"?\s+IS\s+NOT\s+OLD\."?request_hash"?/i,
    ) ||
    !hasActiveWhenTrigger(
      sqlContent,
      'trg_sales_immutable_core',
      'sales',
      /NEW\."?void_client_request_id"?\s+IS\s+NULL/i,
    ) ||
    !hasActiveWhenTrigger(
      sqlContent,
      'trg_sales_immutable_core',
      'sales',
      /NEW\."?void_request_hash"?\s+IS\s+NULL/i,
    ) ||
    !hasActiveWhenTrigger(
      sqlContent,
      'trg_sales_immutable_core',
      'sales',
      /NEW\."?void_reason"?\s+IS\s+NULL/i,
    )
  ) {
    throw new Error(
      'Missing or incomplete active BEFORE UPDATE MONOTONE trigger "trg_sales_immutable_core" on "sales"',
    );
  }

  // Ensure rebuilt tables also re-apply unconditional FACT / DELETE triggers after DROP TABLE
  for (const [tableName, triggerName] of [
    ['sales', 'trg_sales_no_delete'],
    ['sale_lines', 'trg_sale_lines_no_update'],
    ['sale_lines', 'trg_sale_lines_no_delete'],
    ['payments', 'trg_payments_no_update'],
    ['payments', 'trg_payments_no_delete'],
    ['cash_moves', 'trg_cash_moves_no_update'],
    ['cash_moves', 'trg_cash_moves_no_delete'],
    ['returns', 'trg_returns_no_update'],
    ['returns', 'trg_returns_no_delete'],
    ['return_lines', 'trg_return_lines_no_update'],
    ['return_lines', 'trg_return_lines_no_delete'],
    ['return_payments', 'trg_return_payments_no_update'],
    ['return_payments', 'trg_return_payments_no_delete'],
  ] as const) {
    const dropTbl = new RegExp(
      `\\bDROP\\s+TABLE\\s+(?:IF\\s+EXISTS\\s+)?"?${tableName}"?\\b`,
      'gi',
    );
    const createTrig = new RegExp(
      `\\bCREATE\\s+TRIGGER\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?"?${triggerName}"?\\b`,
      'gi',
    );
    let lastDropIdx = -1;
    for (const m of sqlContent.matchAll(dropTbl)) {
      if (typeof m.index === 'number') {
        lastDropIdx = Math.max(lastDropIdx, m.index);
      }
    }
    if (lastDropIdx === -1) {
      continue;
    }
    let lastCreateIdx = -1;
    for (const m of sqlContent.matchAll(createTrig)) {
      if (typeof m.index === 'number') {
        lastCreateIdx = Math.max(lastCreateIdx, m.index);
      }
    }
    if (lastCreateIdx === -1 || lastCreateIdx <= lastDropIdx) {
      throw new Error(
        `Trigger "${triggerName}" on "${tableName}" must exist cleanly after any table rebuild`,
      );
    }
  }
}

/**
 * Generates unified signed sales & returns line reporting view `v_sales_lines` (`T1.6`):
 * - Non-voided `sale_lines` appear with `+1` sign (`record_kind = 'sale'`).
 * - Voided sales (`voided_at_ms IS NOT NULL`) are excluded completely from `v_sales_lines`.
 * - `return_lines` appear with `-1` sign (`record_kind = 'return'`).
 */
export function buildSalesLinesViewSql(): string[] {
  return [
    'DROP VIEW IF EXISTS "v_sales_lines";',
    [
      'CREATE VIEW "v_sales_lines" AS',
      'SELECT',
      '  sl."organization_id" AS "organization_id",',
      '  sl."store_id" AS "store_id",',
      '  sl."device_id" AS "device_id",',
      '  \'sale\' AS "record_kind",',
      '  s."created_at_ms" AS "event_at_ms",',
      '  s."id" AS "document_id",',
      '  s."id" AS "sale_id",',
      '  sl."id" AS "sale_line_id",',
      '  NULL AS "return_id",',
      '  sl."line_kind" AS "line_kind",',
      '  sl."product_id" AS "product_id",',
      '  sl."variant_id" AS "variant_id",',
      '  sl."category_id_snapshot" AS "category_id_snapshot",',
      '  sl."item_name" AS "item_name",',
      '  sl."unit" AS "unit",',
      '  1 AS "sign",',
      '  sl."qty" AS "signed_qty",',
      '  sl."final_total" AS "signed_final_total",',
      '  sl."net_ex_vat" AS "signed_net_ex_vat",',
      '  sl."vat_total" AS "signed_vat_total",',
      '  sl."cost_value" AS "signed_cost_value"',
      'FROM "sale_lines" sl',
      'INNER JOIN "sales" s ON s."id" = sl."sale_id"',
      'WHERE s."voided_at_ms" IS NULL',
      'UNION ALL',
      'SELECT',
      '  rl."organization_id" AS "organization_id",',
      '  rl."store_id" AS "store_id",',
      '  rl."device_id" AS "device_id",',
      '  \'return\' AS "record_kind",',
      '  r."created_at_ms" AS "event_at_ms",',
      '  r."id" AS "document_id",',
      '  rl."sale_id" AS "sale_id",',
      '  rl."sale_line_id" AS "sale_line_id",',
      '  rl."return_id" AS "return_id",',
      '  rl."line_kind" AS "line_kind",',
      '  rl."product_id" AS "product_id",',
      '  rl."variant_id" AS "variant_id",',
      '  sl."category_id_snapshot" AS "category_id_snapshot",',
      '  rl."item_name" AS "item_name",',
      '  rl."unit" AS "unit",',
      '  -1 AS "sign",',
      '  -rl."qty" AS "signed_qty",',
      '  -rl."refund_amount" AS "signed_final_total",',
      '  -rl."net_ex_vat" AS "signed_net_ex_vat",',
      '  -rl."vat_total" AS "signed_vat_total",',
      '  -rl."cost_value" AS "signed_cost_value"',
      'FROM "return_lines" rl',
      'INNER JOIN "returns" r ON r."id" = rl."return_id"',
      'INNER JOIN "sale_lines" sl ON sl."id" = rl."sale_line_id";',
    ].join('\n'),
  ];
}

/**
 * Verifies committed SQLite migrations maintain active `v_sales_lines` view excluding voided sales (`db:check`).
 */
export function assertReturnAndViewMigrationsComplete(migrationsDir: string): void {
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

  const createViewPattern =
    /\bCREATE\s+VIEW\s+(?:"v_sales_lines"|`v_sales_lines`|v_sales_lines)\s+AS\s+([\s\S]*?);/gi;
  let latestCreate: { readonly body: string; readonly index: number } | null = null;
  for (const m of sqlContent.matchAll(createViewPattern)) {
    if (typeof m.index === 'number') {
      latestCreate = { body: m[1] ?? '', index: m.index };
    }
  }
  if (!latestCreate) {
    throw new Error('Missing active SQLite view "v_sales_lines" in committed migrations');
  }

  const dropViewPattern =
    /\bDROP\s+VIEW\s+(?:IF\s+EXISTS\s+)?(?:"v_sales_lines"|`v_sales_lines`|v_sales_lines)\b/gi;
  let latestDrop = -1;
  for (const d of sqlContent.matchAll(dropViewPattern)) {
    if (typeof d.index === 'number') {
      latestDrop = Math.max(latestDrop, d.index);
    }
  }
  if (latestCreate.index <= latestDrop) {
    throw new Error('SQLite view "v_sales_lines" was dropped without being recreated');
  }

  if (
    !/voided_at_ms"?\s+IS\s+NULL/i.test(latestCreate.body) ||
    !/UNION\s+ALL/i.test(latestCreate.body) ||
    !/return_lines/i.test(latestCreate.body)
  ) {
    throw new Error(
      'SQLite view "v_sales_lines" must filter out voided sales (`voided_at_ms IS NULL`) and UNION ALL `return_lines`',
    );
  }
}
