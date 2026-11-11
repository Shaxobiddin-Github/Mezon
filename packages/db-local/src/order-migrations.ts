import fs from 'node:fs';
import path from 'node:path';

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
    `\\bCREATE\\s+TRIGGER\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?(?:"${escapedName}"|\`${escapedName}\`|${escapedName})\\s+${timingEvent}\\s+ON\\s+${tableRef}\\s+FOR\\s+EACH\\s+ROW(?:\\s+WHEN\\s+([\\s\\S]*?))?\\bBEGIN([\\s\\S]*?)\\bEND\\s*;`,
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
 * Generates SQLite MONOTONE transition triggers for `orders` and closed-shift INSERT guard on `order_payments`.
 */
export function buildOrderTriggersSql(): string[] {
  const syncNoteComment = [
    '-- X5 (F2 sync note): Blocks local POS/hub inserts into an already-closed shift.',
    '-- When F2 adds remote peer/cloud sync writes, update this trigger WHEN clause to permit',
    '-- explicit F2 sync-mode inserts so historical advance records for closed shifts can sync safely.',
  ].join('\n');

  return [
    'DROP TRIGGER IF EXISTS "trg_orders_terminal_monotone";',
    'DROP TRIGGER IF EXISTS "trg_orders_immutable_core";',
    [
      'CREATE TRIGGER "trg_orders_terminal_monotone"',
      'BEFORE UPDATE ON "orders"',
      'FOR EACH ROW',
      `WHEN OLD."status" IN ('delivered', 'cancelled')`,
      'BEGIN',
      `  SELECT RAISE(ABORT, 'MONOTONE table "orders" cannot be modified once delivered or cancelled');`,
      'END;',
    ].join('\n'),
    [
      'CREATE TRIGGER "trg_orders_immutable_core"',
      'BEFORE UPDATE ON "orders"',
      'FOR EACH ROW',
      'WHEN',
      `  (OLD."status" = 'draft' AND NEW."status" NOT IN ('confirmed', 'cancelled')) OR`,
      `  (OLD."status" = 'confirmed' AND NEW."status" NOT IN ('ready', 'delivered', 'cancelled')) OR`,
      `  (OLD."status" = 'ready' AND NEW."status" NOT IN ('delivered', 'cancelled')) OR`,
      `  (NEW."status" = 'confirmed' AND NEW."confirmed_at_ms" IS NULL) OR`,
      `  (NEW."status" = 'ready' AND NEW."ready_at_ms" IS NULL) OR`,
      `  (NEW."status" = 'delivered' AND (NEW."delivered_at_ms" IS NULL OR NEW."delivered_sale_id" IS NULL)) OR`,
      `  (NEW."status" = 'cancelled' AND (NEW."cancelled_at_ms" IS NULL OR NEW."cancelled_by_user_id" IS NULL OR NEW."cancel_reason" IS NULL OR length(trim(NEW."cancel_reason")) = 0)) OR`,
      '  NEW."id" IS NOT OLD."id" OR',
      '  NEW."organization_id" IS NOT OLD."organization_id" OR',
      '  NEW."store_id" IS NOT OLD."store_id" OR',
      '  NEW."origin_device_id" IS NOT OLD."origin_device_id" OR',
      '  NEW."order_no" IS NOT OLD."order_no" OR',
      '  NEW."order_code" IS NOT OLD."order_code" OR',
      '  NEW."customer_id" IS NOT OLD."customer_id" OR',
      '  NEW."customer_name" IS NOT OLD."customer_name" OR',
      '  NEW."customer_phone_normalized" IS NOT OLD."customer_phone_normalized" OR',
      '  NEW."due_at_ms" IS NOT OLD."due_at_ms" OR',
      '  NEW."note" IS NOT OLD."note" OR',
      '  NEW."subtotal_gross" IS NOT OLD."subtotal_gross" OR',
      '  NEW."total_promo_discount" IS NOT OLD."total_promo_discount" OR',
      '  NEW."subtotal_after_promo" IS NOT OLD."subtotal_after_promo" OR',
      '  NEW."manual_discount_mode" IS NOT OLD."manual_discount_mode" OR',
      '  NEW."manual_discount_value" IS NOT OLD."manual_discount_value" OR',
      '  NEW."manual_discount_reason" IS NOT OLD."manual_discount_reason" OR',
      '  NEW."order_discount_amount" IS NOT OLD."order_discount_amount" OR',
      '  NEW."total_amount" IS NOT OLD."total_amount" OR',
      '  NEW."total_net_ex_vat" IS NOT OLD."total_net_ex_vat" OR',
      '  NEW."total_vat" IS NOT OLD."total_vat" OR',
      '  NEW."override_approved_by_user_id" IS NOT OLD."override_approved_by_user_id" OR',
      '  NEW."override_approved_amount" IS NOT OLD."override_approved_amount" OR',
      '  NEW."created_by_user_id" IS NOT OLD."created_by_user_id" OR',
      '  NEW."created_at_ms" IS NOT OLD."created_at_ms" OR',
      '  NEW."create_client_request_id" IS NOT OLD."create_client_request_id" OR',
      '  NEW."create_request_hash" IS NOT OLD."create_request_hash" OR',
      '  (OLD."confirmed_at_ms" IS NOT NULL AND NEW."confirmed_at_ms" IS NOT OLD."confirmed_at_ms") OR',
      '  (OLD."ready_at_ms" IS NOT NULL AND NEW."ready_at_ms" IS NOT OLD."ready_at_ms")',
      'BEGIN',
      `  SELECT RAISE(ABORT, 'MONOTONE table "orders" forbids invalid transitions or mutating frozen totals');`,
      'END;',
    ].join('\n'),
    'DROP TRIGGER IF EXISTS "trg_order_payments_closed_shift_guard";',
    [
      syncNoteComment,
      'CREATE TRIGGER "trg_order_payments_closed_shift_guard"',
      'BEFORE INSERT ON "order_payments"',
      'FOR EACH ROW',
      'WHEN NEW."shift_id" IS NOT NULL AND EXISTS (',
      `  SELECT 1 FROM "shifts" sh WHERE sh."id" = NEW."shift_id" AND sh."status" = 'closed'`,
      ')',
      'BEGIN',
      `  SELECT RAISE(ABORT, 'Cannot insert into "order_payments" referencing an already closed shift');`,
      'END;',
    ].join('\n'),
  ];
}

/**
 * Verifies committed T1.10 order & advance migrations enforce MONOTONE transitions on `orders`,
 * closed-shift INSERT guards on `order_payments`, and `source_order_id` immutability on `sales`.
 */
export function assertOrderMigrationsComplete(migrationsDir: string): void {
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
      'trg_orders_terminal_monotone',
      'BEFORE UPDATE',
      'orders',
      /OLD\."?status"?\s+IN\s*\(\s*'delivered'\s*,\s*'cancelled'\s*\)/i,
    ) ||
    !hasActiveTrigger(
      sqlContent,
      'trg_orders_immutable_core',
      'BEFORE UPDATE',
      'orders',
      /NEW\."?total_amount"?\s+IS\s+NOT\s+OLD\."?total_amount"?/i,
    )
  ) {
    throw new Error('Missing or incomplete active MONOTONE triggers on "orders"');
  }

  if (
    !hasActiveTrigger(
      sqlContent,
      'trg_order_payments_closed_shift_guard',
      'BEFORE INSERT',
      'order_payments',
      /sh\."?status"?\s*=\s*'closed'/i,
    )
  ) {
    throw new Error('Missing active closed-shift INSERT guard trigger on "order_payments"');
  }

  if (
    !hasActiveTrigger(
      sqlContent,
      'trg_sales_immutable_core',
      'BEFORE UPDATE',
      'sales',
      /NEW\."?source_order_id"?\s+IS\s+NOT\s+OLD\."?source_order_id"?/i,
    )
  ) {
    throw new Error('Trigger "trg_sales_immutable_core" must lock "source_order_id"');
  }
}
