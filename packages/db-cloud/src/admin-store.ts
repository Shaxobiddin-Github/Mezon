import {
  type Money,
  type Quantity,
  type UnixMs,
  type UuidV7,
  moneyFromTiyin,
  moneyToTiyin,
  parseUuidV7,
  quantityFromMilli,
  unixMsFromBigInt,
} from '@mezon/domain';
import type { Pool } from 'pg';
import { withPgTenantContext } from './connection.js';
import { resolveIntlDateKey } from './timezone.js';

export function maskPhoneNumber(phone: string | null | undefined): string | null {
  if (!phone) return null;
  const digitsOnly = phone.replace(/\D/g, '');
  if (digitsOnly.length < 9) {
    return '***';
  }
  const last2 = digitsOnly.slice(-2);
  if (digitsOnly.length === 12 && digitsOnly.startsWith('998')) {
    const code = digitsOnly.slice(3, 5);
    return `+998 ${code} *** ** ${last2}`;
  }
  if (digitsOnly.length === 9) {
    const code = digitsOnly.slice(0, 2);
    return `+998 ${code} *** ** ${last2}`;
  }
  return `+${digitsOnly.slice(0, Math.min(4, digitsOnly.length - 4))} *** ${last2}`;
}

export interface CloudStoreFreshness {
  readonly storeId: UuidV7;
  readonly storeName: string;
  readonly lastEventAtMs: UnixMs | null;
  readonly isStale: boolean;
}

export interface CloudDashboardMetrics {
  readonly todayDate: string;
  readonly grossSales: Money;
  readonly returnsTotal: Money;
  readonly netSales: Money;
  readonly receiptsCount: number;
  readonly avgReceipt: Money;
  readonly grossProfit?: Money;
  readonly marginBp?: number;
  readonly stores: readonly CloudStoreFreshness[];
}

export interface CloudReceiptItem {
  readonly id: UuidV7;
  readonly receiptNumber: string;
  readonly storeId: UuidV7;
  readonly storeName: string;
  readonly cashierName: string | null;
  readonly total: Money;
  readonly status: 'completed' | 'voided';
  readonly paymentMethods: readonly string[];
  readonly createdAtMs: UnixMs;
  readonly voidedAtMs: UnixMs | null;
}

export interface CloudReceiptLine {
  readonly id: UuidV7;
  readonly productId: UuidV7 | null;
  readonly productName: string;
  readonly sku: string | null;
  readonly barcode: string | null;
  readonly unit: string;
  readonly qty: Quantity;
  readonly unitPrice: Money;
  readonly total: Money;
  readonly vatPercent: number;
  readonly vatAmount: Money;
  readonly discountAmount: Money;
  readonly mxikCode: string | null;
}

export interface CloudReceiptPayment {
  readonly id: UuidV7;
  readonly method: string;
  readonly amount: Money;
  readonly createdAtMs: UnixMs;
}

export interface CloudReceiptDetail {
  readonly id: UuidV7;
  readonly receiptNumber: string;
  readonly storeId: UuidV7;
  readonly storeName: string;
  readonly cashierName: string | null;
  readonly customerName: string | null;
  readonly status: 'completed' | 'voided';
  readonly grossTotal: Money;
  readonly discountTotal: Money;
  readonly netTotal: Money;
  readonly vatTotal: Money;
  readonly createdAtMs: UnixMs;
  readonly voidedAtMs: UnixMs | null;
  readonly voidReason: string | null;
  readonly lines: readonly CloudReceiptLine[];
  readonly payments: readonly CloudReceiptPayment[];
}

export interface CloudCustomerItem {
  readonly id: UuidV7;
  readonly fullName: string;
  readonly maskedPhone: string | null;
  readonly balance: Money;
  readonly overdueAmount: Money;
  readonly createdAtMs: UnixMs;
}

export interface CloudCustomerLedgerEntry {
  readonly id: UuidV7;
  readonly entryType: string;
  readonly amount: Money;
  readonly balanceAfter: Money;
  readonly sourceType: string;
  readonly sourceId: UuidV7;
  readonly reason: string | null;
  readonly createdAtMs: UnixMs;
}

export interface CloudCustomerDetail {
  readonly id: UuidV7;
  readonly fullName: string;
  readonly phone: string | null;
  readonly balance: Money;
  readonly overdueAmount: Money;
  readonly earliestOverdueDueAtMs: UnixMs | null;
  readonly notes: string | null;
  readonly createdAtMs: UnixMs;
  readonly ledger: readonly CloudCustomerLedgerEntry[];
}

export interface CloudProductItem {
  readonly id: UuidV7;
  readonly name: string;
  readonly sku: string | null;
  readonly barcode: string | null;
  readonly unit: string;
  readonly price: Money;
  readonly vatPercent: number;
  readonly currentStock: Quantity;
  readonly minStock: Quantity;
}

export interface CloudLowStockItem {
  readonly productId: UuidV7;
  readonly name: string;
  readonly sku: string | null;
  readonly barcode: string | null;
  readonly unit: string;
  readonly currentStock: Quantity;
  readonly minStock: Quantity;
  readonly deficit: Quantity;
}

export interface CloudConflictItem {
  readonly eventId: UuidV7;
  readonly storeId: UuidV7;
  readonly deviceId: UuidV7;
  readonly type: string;
  readonly entity: string;
  readonly entityId: UuidV7;
  readonly reason: string;
  readonly attempts: number;
  readonly parkedAtMs: UnixMs;
}

export interface CloudDailySalesDaySummary {
  readonly date: string;
  readonly salesCount: number;
  readonly returnsCount: number;
  readonly grossSales: Money;
  readonly returnsTotal: Money;
  readonly netSales: Money;
  readonly vatTotal: Money;
  readonly totalQty: Quantity;
  readonly cashSales: Money;
  readonly nonCashSales: Money;
  readonly costValue?: Money;
  readonly grossProfit?: Money;
}

export interface CloudDailySalesReport {
  readonly days: readonly CloudDailySalesDaySummary[];
  readonly totalSalesCount: number;
  readonly totalReturnsCount: number;
  readonly totalGrossSales: Money;
  readonly totalReturns: Money;
  readonly totalNetSales: Money;
  readonly totalVat: Money;
  readonly totalCashSales: Money;
  readonly totalNonCashSales: Money;
  readonly totalCostValue?: Money;
  readonly totalGrossProfit?: Money;
}

export interface AdminStoreOptions {
  readonly pool: Pool;
  readonly defaultTimezone?: string;
}

export class AdminReadStore {
  private readonly pool: Pool;
  private readonly defaultTz: string;

  constructor(options: AdminStoreOptions) {
    this.pool = options.pool;
    this.defaultTz = options.defaultTimezone ?? 'Asia/Tashkent';
  }

  /**
   * 1. Store Freshness Check (A2)
   */
  async getStoreFreshness(
    organizationId: UuidV7,
    nowMs: UnixMs = unixMsFromBigInt(BigInt(Date.now())),
  ): Promise<readonly CloudStoreFreshness[]> {
    return withPgTenantContext(this.pool, organizationId, async (_tx, client) => {
      const sql = `
        SELECT
          s.id AS store_id,
          s.name AS store_name,
          MAX(e.received_at_ms) AS last_event_at_ms
        FROM cloud_stores s
        LEFT JOIN cloud_sync_events e
          ON e.organization_id = s.organization_id
          AND e.store_id = s.id
        WHERE s.organization_id = $1
          AND s.is_active = true
        GROUP BY s.id, s.name
        ORDER BY s.name ASC
      `;
      const res = await client.query<{
        store_id: string;
        store_name: string;
        last_event_at_ms: string | null;
      }>(sql, [organizationId]);

      const TEN_MINUTES_MS = 10n * 60n * 1000n;
      const nowBig = BigInt(nowMs);

      return res.rows.map((row) => {
        const lastMs = row.last_event_at_ms !== null ? BigInt(row.last_event_at_ms) : null;
        const isStale = lastMs === null || nowBig - lastMs > TEN_MINUTES_MS;
        return {
          storeId: parseUuidV7(row.store_id),
          storeName: row.store_name,
          lastEventAtMs: lastMs !== null ? unixMsFromBigInt(lastMs) : null,
          isStale,
        };
      });
    });
  }

  /**
   * 2. Dashboard Metrics (Today)
   */
  async getDashboard(params: {
    organizationId: UuidV7;
    storeId?: UuidV7;
    tz?: string;
    nowMs?: UnixMs;
    includeProfit?: boolean;
  }): Promise<CloudDashboardMetrics> {
    const tz = params.tz ?? this.defaultTz;
    const nowMs = params.nowMs ?? unixMsFromBigInt(BigInt(Date.now()));
    const todayDate = resolveIntlDateKey(nowMs, tz);

    const storesFreshness = await this.getStoreFreshness(params.organizationId, nowMs);

    // Same figures as the daily report (and therefore as the hub) for the store's today.
    const report = await this.getDailySalesReport({
      organizationId: params.organizationId,
      storeId: params.storeId,
      fromDate: todayDate,
      toDate: todayDate,
      tz,
      includeCostAndProfit: true,
    });
    const day = report.days[0];
    const grossTiyin = day ? moneyToTiyin(day.grossSales) : 0n;
    const returnsTiyin = day ? moneyToTiyin(day.returnsTotal) : 0n;
    const netTiyin = day ? moneyToTiyin(day.netSales) : 0n;
    const profitTiyin = day?.grossProfit ? moneyToTiyin(day.grossProfit) : 0n;
    const count = day ? day.salesCount : 0;
    const avgTiyin = count > 0 ? netTiyin / BigInt(count) : 0n;
    const marginBp = netTiyin > 0n ? Number((profitTiyin * 10000n) / netTiyin) : 0;

    return {
      todayDate,
      grossSales: moneyFromTiyin(grossTiyin),
      returnsTotal: moneyFromTiyin(returnsTiyin),
      netSales: moneyFromTiyin(netTiyin),
      receiptsCount: count,
      avgReceipt: moneyFromTiyin(avgTiyin),
      grossProfit: params.includeProfit ? moneyFromTiyin(profitTiyin) : undefined,
      marginBp: params.includeProfit ? marginBp : undefined,
      stores: storesFreshness,
    };
  }

  /**
   * 3. Receipts Keyset Pagination (A5)
   */
  async getReceiptsList(
    organizationId: UuidV7,
    query: {
      storeId?: UuidV7;
      status?: 'completed' | 'voided';
      cursor?: string;
      limit?: number;
    },
  ): Promise<{ items: readonly CloudReceiptItem[]; nextCursor: string | null }> {
    const limit = Math.min(query.limit ?? 50, 200);

    return withPgTenantContext(this.pool, organizationId, async (_tx, client) => {
      const conditions: string[] = ['s.organization_id = $1'];
      const args: unknown[] = [organizationId];
      let argIdx = 2;

      if (query.storeId) {
        conditions.push(`s.store_id = $${argIdx++}`);
        args.push(query.storeId);
      }

      if (query.status) {
        if (query.status === 'voided') {
          conditions.push('s.voided_at_ms IS NOT NULL');
        } else {
          conditions.push('s.voided_at_ms IS NULL');
        }
      }

      if (query.cursor) {
        const parts = query.cursor.split(':');
        if (parts.length === 2 && parts[0] && parts[1]) {
          const cursorMs = BigInt(parts[0]);
          const cursorId = parts[1];
          conditions.push(`(s.created_at_ms, s.id) < ($${argIdx++}::bigint, $${argIdx++}::uuid)`);
          args.push(cursorMs.toString(), cursorId);
        }
      }

      // LIMIT applies to the sales themselves (index order); payments are aggregated only for the
      // returned page, not for every sale of the organization.
      const sql = `
        SELECT
          s.id,
          s.receipt_code,
          s.store_id,
          st.name AS store_name,
          u.full_name AS cashier_name,
          s.total_final,
          CASE WHEN s.voided_at_ms IS NOT NULL THEN 'voided' ELSE 'completed' END AS status,
          s.created_at_ms,
          s.voided_at_ms,
          ARRAY(
            SELECT DISTINCT p.method FROM payments p
             WHERE p.sale_id = s.id AND p.organization_id = s.organization_id
             ORDER BY 1
          ) AS payment_methods
        FROM sales s
        INNER JOIN cloud_stores st ON st.id = s.store_id AND st.organization_id = s.organization_id
        LEFT JOIN users u ON u.id = s.cashier_user_id AND u.organization_id = s.organization_id
        WHERE ${conditions.join(' AND ')}
        ORDER BY s.created_at_ms DESC, s.id DESC
        LIMIT $${argIdx}
      `;
      args.push(limit + 1);

      const res = await client.query<{
        id: string;
        receipt_code: string;
        store_id: string;
        store_name: string;
        cashier_name: string | null;
        total_final: string;
        status: string;
        created_at_ms: string;
        voided_at_ms: string | null;
        payment_methods: string[];
      }>(sql, args);

      const rows = res.rows;
      const hasMore = rows.length > limit;
      const pageRows = hasMore ? rows.slice(0, limit) : rows;

      let nextCursor: string | null = null;
      if (hasMore && pageRows.length > 0) {
        const last = pageRows[pageRows.length - 1];
        if (last) {
          nextCursor = `${last.created_at_ms}:${last.id}`;
        }
      }

      const items: CloudReceiptItem[] = pageRows.map((r) => ({
        id: parseUuidV7(r.id),
        receiptNumber: r.receipt_code,
        storeId: parseUuidV7(r.store_id),
        storeName: r.store_name,
        cashierName: r.cashier_name,
        total: moneyFromTiyin(BigInt(r.total_final)),
        status: r.status === 'voided' ? 'voided' : 'completed',
        paymentMethods: r.payment_methods ?? [],
        createdAtMs: unixMsFromBigInt(BigInt(r.created_at_ms)),
        voidedAtMs: r.voided_at_ms !== null ? unixMsFromBigInt(BigInt(r.voided_at_ms)) : null,
      }));

      return { items, nextCursor };
    });
  }

  /**
   * 4. Receipt Detail
   */
  async getReceiptDetail(
    organizationId: UuidV7,
    receiptId: UuidV7,
  ): Promise<CloudReceiptDetail | null> {
    return withPgTenantContext(this.pool, organizationId, async (_tx, client) => {
      const saleSql = `
        SELECT
          s.id,
          s.receipt_code,
          s.store_id,
          st.name AS store_name,
          u.full_name AS cashier_name,
          c.full_name AS customer_name,
          CASE WHEN s.voided_at_ms IS NOT NULL THEN 'voided' ELSE 'completed' END AS status,
          s.subtotal_gross,
          s.total_promo_discount,
          s.total_final,
          s.total_vat,
          s.created_at_ms,
          s.voided_at_ms,
          s.void_reason
        FROM sales s
        INNER JOIN cloud_stores st ON st.id = s.store_id AND st.organization_id = s.organization_id
        LEFT JOIN users u ON u.id = s.cashier_user_id AND u.organization_id = s.organization_id
        LEFT JOIN customers c ON c.id = s.customer_id AND c.organization_id = s.organization_id
        WHERE s.organization_id = $1 AND s.id = $2
      `;
      const saleRes = await client.query<{
        id: string;
        receipt_code: string;
        store_id: string;
        store_name: string;
        cashier_name: string | null;
        customer_name: string | null;
        status: string;
        subtotal_gross: string;
        total_promo_discount: string;
        total_final: string;
        total_vat: string;
        created_at_ms: string;
        voided_at_ms: string | null;
        void_reason: string | null;
      }>(saleSql, [organizationId, receiptId]);

      if (saleRes.rows.length === 0 || !saleRes.rows[0]) return null;
      const s = saleRes.rows[0];

      const linesSql = `
        SELECT
          l.id,
          l.product_id,
          l.item_name,
          p.sku,
          NULL::text AS barcode,
          l.unit,
          l.qty,
          l.unit_price_snapshot,
          l.final_total,
          l.vat_rate_bp_snapshot,
          l.vat_total,
          l.promo_discount,
          l.mxik_snapshot
        FROM sale_lines l
        LEFT JOIN products p ON p.id = l.product_id AND p.organization_id = l.organization_id
        WHERE l.organization_id = $1 AND l.sale_id = $2
        ORDER BY l.sort_order ASC
      `;
      const linesRes = await client.query<{
        id: string;
        product_id: string | null;
        item_name: string;
        sku: string | null;
        barcode: string | null;
        unit: string;
        qty: string;
        unit_price_snapshot: string;
        final_total: string;
        vat_rate_bp_snapshot: number;
        vat_total: string;
        promo_discount: string;
        mxik_snapshot: string | null;
      }>(linesSql, [organizationId, receiptId]);

      const lines: CloudReceiptLine[] = linesRes.rows.map((l) => ({
        id: parseUuidV7(l.id),
        productId: l.product_id ? parseUuidV7(l.product_id) : null,
        productName: l.item_name,
        sku: l.sku,
        barcode: l.barcode,
        unit: l.unit,
        qty: quantityFromMilli(BigInt(l.qty)),
        unitPrice: moneyFromTiyin(BigInt(l.unit_price_snapshot)),
        total: moneyFromTiyin(BigInt(l.final_total)),
        vatPercent: Math.round(l.vat_rate_bp_snapshot / 100),
        vatAmount: moneyFromTiyin(BigInt(l.vat_total)),
        discountAmount: moneyFromTiyin(BigInt(l.promo_discount)),
        mxikCode: l.mxik_snapshot,
      }));

      const paySql = `
        SELECT id, method, amount, created_at_ms
        FROM payments
        WHERE organization_id = $1 AND sale_id = $2
        ORDER BY created_at_ms ASC
      `;
      const payRes = await client.query<{
        id: string;
        method: string;
        amount: string;
        created_at_ms: string;
      }>(paySql, [organizationId, receiptId]);

      const payments: CloudReceiptPayment[] = payRes.rows.map((p) => ({
        id: parseUuidV7(p.id),
        method: p.method,
        amount: moneyFromTiyin(BigInt(p.amount)),
        createdAtMs: unixMsFromBigInt(BigInt(p.created_at_ms)),
      }));

      return {
        id: parseUuidV7(s.id),
        receiptNumber: s.receipt_code,
        storeId: parseUuidV7(s.store_id),
        storeName: s.store_name,
        cashierName: s.cashier_name,
        customerName: s.customer_name,
        status: s.status === 'voided' ? 'voided' : 'completed',
        grossTotal: moneyFromTiyin(BigInt(s.subtotal_gross)),
        // All discounts (promo + manual/order), so gross - discount = what the customer paid.
        discountTotal: moneyFromTiyin(BigInt(s.subtotal_gross) - BigInt(s.total_final)),
        netTotal: moneyFromTiyin(BigInt(s.total_final)),
        vatTotal: moneyFromTiyin(BigInt(s.total_vat)),
        createdAtMs: unixMsFromBigInt(BigInt(s.created_at_ms)),
        voidedAtMs: s.voided_at_ms !== null ? unixMsFromBigInt(BigInt(s.voided_at_ms)) : null,
        voidReason: s.void_reason,
        lines,
        payments,
      };
    });
  }

  /**
   * 5. Customers List (Keyset paginated, masked phone) (A6)
   */
  async getCustomersList(
    organizationId: UuidV7,
    query: {
      search?: string;
      hasDebtOnly?: boolean;
      cursor?: string;
      limit?: number;
    },
  ): Promise<{ items: readonly CloudCustomerItem[]; nextCursor: string | null }> {
    const limit = Math.min(query.limit ?? 50, 200);

    return withPgTenantContext(this.pool, organizationId, async (_tx, client) => {
      const conditions: string[] = ['c.organization_id = $1', 'c.deleted_at_ms IS NULL'];
      const args: unknown[] = [organizationId];
      let argIdx = 2;

      if (query.search) {
        conditions.push(
          `(c.full_name ILIKE $${argIdx} OR c.phone_normalized ILIKE $${argIdx} OR c.name_search ILIKE $${argIdx})`,
        );
        args.push(`%${query.search}%`);
        argIdx++;
      }

      if (query.cursor) {
        const parts = query.cursor.split(':');
        if (parts.length === 2 && parts[0] && parts[1]) {
          const cursorMs = BigInt(parts[0]);
          const cursorId = parts[1];
          conditions.push(`(c.created_at_ms, c.id) < ($${argIdx++}::bigint, $${argIdx++}::uuid)`);
          args.push(cursorMs.toString(), cursorId);
        }
      }

      const sql = `
        SELECT
          c.id,
          c.full_name,
          c.phone_normalized,
          c.created_at_ms,
          COALESCE(SUM(l.amount_delta), 0) AS balance_tiyin
        FROM customers c
        LEFT JOIN customer_ledger l ON l.customer_id = c.id AND l.organization_id = c.organization_id
        WHERE ${conditions.join(' AND ')}
        GROUP BY c.id, c.full_name, c.phone_normalized, c.created_at_ms
        ${query.hasDebtOnly ? 'HAVING COALESCE(SUM(l.amount_delta), 0) > 0' : ''}
        ORDER BY c.created_at_ms DESC, c.id DESC
        LIMIT $${argIdx}
      `;
      args.push(limit + 1);

      const res = await client.query<{
        id: string;
        full_name: string;
        phone_normalized: string | null;
        created_at_ms: string;
        balance_tiyin: string;
      }>(sql, args);

      const rows = res.rows;
      const hasMore = rows.length > limit;
      const pageRows = hasMore ? rows.slice(0, limit) : rows;

      let nextCursor: string | null = null;
      if (hasMore && pageRows.length > 0) {
        const last = pageRows[pageRows.length - 1];
        if (last) {
          nextCursor = `${last.created_at_ms}:${last.id}`;
        }
      }

      const items: CloudCustomerItem[] = pageRows.map((r) => ({
        id: parseUuidV7(r.id),
        fullName: r.full_name,
        maskedPhone: maskPhoneNumber(r.phone_normalized),
        balance: moneyFromTiyin(BigInt(r.balance_tiyin)),
        overdueAmount: moneyFromTiyin(0n),
        createdAtMs: unixMsFromBigInt(BigInt(r.created_at_ms)),
      }));

      return { items, nextCursor };
    });
  }

  /**
   * 6. Customer Detail
   */
  async getCustomerDetail(params: {
    organizationId: UuidV7;
    customerId: UuidV7;
    isPrivilegedRole: boolean;
  }): Promise<CloudCustomerDetail | null> {
    return withPgTenantContext(this.pool, params.organizationId, async (_tx, client) => {
      const custSql = `
        SELECT
          c.id,
          c.full_name,
          c.phone_normalized,
          c.note,
          c.created_at_ms,
          COALESCE(SUM(l.amount_delta), 0) AS balance_tiyin
        FROM customers c
        LEFT JOIN customer_ledger l ON l.customer_id = c.id AND l.organization_id = c.organization_id
        WHERE c.organization_id = $1 AND c.id = $2 AND c.deleted_at_ms IS NULL
        GROUP BY c.id, c.full_name, c.phone_normalized, c.note, c.created_at_ms
      `;
      const custRes = await client.query<{
        id: string;
        full_name: string;
        phone_normalized: string | null;
        note: string | null;
        created_at_ms: string;
        balance_tiyin: string;
      }>(custSql, [params.organizationId, params.customerId]);

      if (custRes.rows.length === 0 || !custRes.rows[0]) return null;
      const c = custRes.rows[0];

      const ledgerSql = `
        SELECT
          id,
          entry_type,
          amount_delta,
          source_type,
          source_id,
          reason,
          created_at_ms
        FROM customer_ledger
        WHERE organization_id = $1 AND customer_id = $2
        ORDER BY created_at_ms DESC
        LIMIT 100
      `;
      const ledgerRes = await client.query<{
        id: string;
        entry_type: string;
        amount_delta: string;
        source_type: string;
        source_id: string;
        reason: string | null;
        created_at_ms: string;
      }>(ledgerSql, [params.organizationId, params.customerId]);

      const ledger: CloudCustomerLedgerEntry[] = ledgerRes.rows.map((row) => ({
        id: parseUuidV7(row.id),
        entryType: row.entry_type,
        amount: moneyFromTiyin(BigInt(row.amount_delta)),
        balanceAfter: moneyFromTiyin(0n),
        sourceType: row.source_type,
        sourceId: parseUuidV7(row.source_id),
        reason: row.reason,
        createdAtMs: unixMsFromBigInt(BigInt(row.created_at_ms)),
      }));

      const phone = params.isPrivilegedRole
        ? c.phone_normalized
        : maskPhoneNumber(c.phone_normalized);

      return {
        id: parseUuidV7(c.id),
        fullName: c.full_name,
        phone,
        balance: moneyFromTiyin(BigInt(c.balance_tiyin)),
        overdueAmount: moneyFromTiyin(0n),
        earliestOverdueDueAtMs: null,
        notes: c.note,
        createdAtMs: unixMsFromBigInt(BigInt(c.created_at_ms)),
        ledger,
      };
    });
  }

  /**
   * 7. Products List (Keyset paginated)
   */
  async getProductsList(
    organizationId: UuidV7,
    query: {
      search?: string;
      categoryId?: UuidV7;
      cursor?: string;
      limit?: number;
    },
  ): Promise<{ items: readonly CloudProductItem[]; nextCursor: string | null }> {
    const limit = Math.min(query.limit ?? 50, 200);

    return withPgTenantContext(this.pool, organizationId, async (_tx, client) => {
      const conditions: string[] = ['p.organization_id = $1', 'p.deleted_at_ms IS NULL'];
      const args: unknown[] = [organizationId];
      let argIdx = 2;

      if (query.search) {
        conditions.push(`(p.name ILIKE $${argIdx} OR p.sku ILIKE $${argIdx})`);
        args.push(`%${query.search}%`);
        argIdx++;
      }

      if (query.categoryId) {
        conditions.push(`p.category_id = $${argIdx++}`);
        args.push(query.categoryId);
      }

      if (query.cursor) {
        const parts = query.cursor.split(':');
        if (parts.length === 2 && parts[0] && parts[1]) {
          const cursorMs = BigInt(parts[0]);
          const cursorId = parts[1];
          conditions.push(`(p.created_at_ms, p.id) < ($${argIdx++}::bigint, $${argIdx++}::uuid)`);
          args.push(cursorMs.toString(), cursorId);
        }
      }

      const sql = `
        SELECT
          p.id,
          p.name,
          p.sku,
          p.sale_price,
          p.vat_rate_bp,
          p.unit,
          p.min_stock,
          p.created_at_ms,
          (
            SELECT COALESCE(SUM(sm.qty_delta), 0) FROM stock_moves sm
             WHERE sm.product_id = p.id AND sm.organization_id = p.organization_id
          ) AS current_stock_milli
        FROM products p
        WHERE ${conditions.join(' AND ')}
        ORDER BY p.created_at_ms DESC, p.id DESC
        LIMIT $${argIdx}
      `;
      args.push(limit + 1);

      const res = await client.query<{
        id: string;
        name: string;
        sku: string | null;
        sale_price: string;
        vat_rate_bp: number;
        unit: string;
        min_stock: string | null;
        created_at_ms: string;
        current_stock_milli: string;
      }>(sql, args);

      const rows = res.rows;
      const hasMore = rows.length > limit;
      const pageRows = hasMore ? rows.slice(0, limit) : rows;

      let nextCursor: string | null = null;
      if (hasMore && pageRows.length > 0) {
        const last = pageRows[pageRows.length - 1];
        if (last) {
          nextCursor = `${last.created_at_ms}:${last.id}`;
        }
      }

      const items: CloudProductItem[] = pageRows.map((r) => ({
        id: parseUuidV7(r.id),
        name: r.name,
        sku: r.sku,
        barcode: null,
        unit: r.unit,
        price: moneyFromTiyin(BigInt(r.sale_price)),
        vatPercent: Math.round(r.vat_rate_bp / 100),
        currentStock: quantityFromMilli(BigInt(r.current_stock_milli)),
        minStock: quantityFromMilli(BigInt(r.min_stock ?? '0')),
      }));

      return { items, nextCursor };
    });
  }

  /**
   * 8. Low Stock Items
   */
  async getLowStockItems(
    organizationId: UuidV7,
    storeId?: UuidV7,
  ): Promise<readonly CloudLowStockItem[]> {
    return withPgTenantContext(this.pool, organizationId, async (_tx, client) => {
      const sql = `
        SELECT
          p.id AS product_id,
          p.name,
          p.sku,
          p.unit,
          COALESCE(p.min_stock, 0) AS min_stock,
          COALESCE(SUM(sm.qty_delta), 0) AS current_stock
        FROM products p
        LEFT JOIN stock_moves sm
          ON sm.product_id = p.id
          AND sm.organization_id = p.organization_id
          AND ($2::uuid IS NULL OR sm.store_id = $2::uuid)
        WHERE p.organization_id = $1
          AND p.deleted_at_ms IS NULL
          AND p.min_stock IS NOT NULL
          AND p.min_stock > 0
        GROUP BY p.id, p.name, p.sku, p.unit, p.min_stock
        HAVING COALESCE(SUM(sm.qty_delta), 0) < p.min_stock
        ORDER BY (p.min_stock - COALESCE(SUM(sm.qty_delta), 0)) DESC
        LIMIT 200
      `;
      const res = await client.query<{
        product_id: string;
        name: string;
        sku: string | null;
        unit: string;
        min_stock: string;
        current_stock: string;
      }>(sql, [organizationId, storeId ?? null]);

      return res.rows.map((r) => {
        const min = BigInt(r.min_stock);
        const curr = BigInt(r.current_stock);
        const deficit = min > curr ? min - curr : 0n;
        return {
          productId: parseUuidV7(r.product_id),
          name: r.name,
          sku: r.sku,
          barcode: null,
          unit: r.unit,
          currentStock: quantityFromMilli(curr),
          minStock: quantityFromMilli(min),
          deficit: quantityFromMilli(deficit),
        };
      });
    });
  }

  /**
   * 9. Sync Conflicts List
   */
  async getConflictsList(
    organizationId: UuidV7,
    limit: number = 50,
  ): Promise<readonly CloudConflictItem[]> {
    return withPgTenantContext(this.pool, organizationId, async (_tx, client) => {
      const sql = `
        SELECT
          event_id,
          store_id,
          device_id,
          entity,
          entity_id,
          missing_ref_entity,
          missing_ref_id,
          attempts,
          created_at_ms
        FROM cloud_sync_parked
        WHERE organization_id = $1
          AND status IN ('parked', 'conflict')
        ORDER BY created_at_ms DESC
        LIMIT $2
      `;
      const res = await client.query<{
        event_id: string;
        store_id: string;
        device_id: string;
        entity: string;
        entity_id: string;
        missing_ref_entity: string;
        missing_ref_id: string;
        attempts: number;
        created_at_ms: string;
      }>(sql, [organizationId, limit]);

      return res.rows.map((r) => ({
        eventId: parseUuidV7(r.event_id),
        storeId: parseUuidV7(r.store_id),
        deviceId: parseUuidV7(r.device_id),
        type: 'parked_dependency',
        entity: r.entity,
        entityId: parseUuidV7(r.entity_id),
        reason: `Missing foreign reference: ${r.missing_ref_entity} (${r.missing_ref_id})`,
        attempts: r.attempts,
        parkedAtMs: unixMsFromBigInt(BigInt(r.created_at_ms)),
      }));
    });
  }

  /**
   * 10. Daily Sales Report — the same formula as the hub (`report-repo.ts` over `v_sales_lines`):
   * signed sale lines (non-voided sales) and return lines, revenue = line `final_total` (after every
   * discount), returns negative, profit = signed `net_ex_vat` minus signed `cost_value` (a return
   * gives its cost back). Cash/non-cash from sale payments minus return payments.
   *
   * Rows are fetched only around the requested range (2 days of margin in UTC, then filtered exactly
   * by the store day), not the organization's whole history.
   */
  async getDailySalesReport(params: {
    organizationId: UuidV7;
    storeId?: UuidV7;
    fromDate?: string;
    toDate?: string;
    limit?: number;
    tz?: string;
    includeCostAndProfit?: boolean;
  }): Promise<CloudDailySalesReport> {
    const tz = params.tz ?? this.defaultTz;
    const limit = Math.min(params.limit ?? 31, 366);
    const DAY = 86_400_000;
    const lo = params.fromDate ? Date.parse(`${params.fromDate}T00:00:00Z`) - 2 * DAY : null;
    const hi = params.toDate ? Date.parse(`${params.toDate}T00:00:00Z`) + 3 * DAY : null;
    const inRange = (dateKey: string) =>
      !(params.fromDate && dateKey < params.fromDate) &&
      !(params.toDate && dateKey > params.toDate);
    const args = [
      params.organizationId,
      params.storeId ?? null,
      lo === null ? null : String(lo),
      hi === null ? null : String(hi),
    ];
    const timeFilter = (col: string) =>
      `($3::bigint IS NULL OR ${col} >= $3::bigint) AND ($4::bigint IS NULL OR ${col} < $4::bigint)`;

    return withPgTenantContext(this.pool, params.organizationId, async (_tx, client) => {
      interface DayBucket {
        readonly saleIds: Set<string>;
        readonly returnIds: Set<string>;
        grossSalesTiyin: bigint;
        returnsTiyin: bigint;
        netSalesTiyin: bigint;
        vatTiyin: bigint;
        qtyMilli: bigint;
        costTiyin: bigint;
        grossProfitTiyin: bigint;
        cashSalesTiyin: bigint;
        nonCashSalesTiyin: bigint;
      }
      const buckets = new Map<string, DayBucket>();
      const bucket = (d: string): DayBucket => {
        let b = buckets.get(d);
        if (!b) {
          b = {
            saleIds: new Set(),
            returnIds: new Set(),
            grossSalesTiyin: 0n,
            returnsTiyin: 0n,
            netSalesTiyin: 0n,
            vatTiyin: 0n,
            qtyMilli: 0n,
            costTiyin: 0n,
            grossProfitTiyin: 0n,
            cashSalesTiyin: 0n,
            nonCashSalesTiyin: 0n,
          };
          buckets.set(d, b);
        }
        return b;
      };

      const lines = await client.query<{
        record_kind: 'sale' | 'return';
        event_at_ms: string;
        document_id: string;
        signed_qty: string;
        signed_final_total: string;
        signed_net_ex_vat: string;
        signed_vat_total: string;
        signed_cost_value: string;
      }>(
        `SELECT 'sale' AS record_kind, s.created_at_ms AS event_at_ms, s.id AS document_id,
                sl.qty AS signed_qty, sl.final_total AS signed_final_total,
                sl.net_ex_vat AS signed_net_ex_vat, sl.vat_total AS signed_vat_total,
                COALESCE(sl.cost_value, 0) AS signed_cost_value
           FROM sale_lines sl
           JOIN sales s ON s.id = sl.sale_id AND s.organization_id = sl.organization_id
          WHERE s.organization_id = $1 AND s.voided_at_ms IS NULL
            AND ($2::uuid IS NULL OR s.store_id = $2::uuid) AND ${timeFilter('s.created_at_ms')}
         UNION ALL
         SELECT 'return', r.created_at_ms, r.id,
                -rl.qty, -rl.refund_amount, -rl.net_ex_vat, -rl.vat_total,
                -COALESCE(rl.cost_value, 0)
           FROM return_lines rl
           JOIN returns r ON r.id = rl.return_id AND r.organization_id = rl.organization_id
          WHERE r.organization_id = $1
            AND ($2::uuid IS NULL OR r.store_id = $2::uuid) AND ${timeFilter('r.created_at_ms')}`,
        args,
      );
      for (const row of lines.rows) {
        const dateKey = resolveIntlDateKey(unixMsFromBigInt(BigInt(row.event_at_ms)), tz);
        if (!inRange(dateKey)) continue;
        const b = bucket(dateKey);
        const sFinal = BigInt(row.signed_final_total);
        if (row.record_kind === 'sale') {
          b.saleIds.add(row.document_id);
          b.grossSalesTiyin += sFinal;
        } else {
          b.returnIds.add(row.document_id);
          b.returnsTiyin += -sFinal;
        }
        b.netSalesTiyin += sFinal;
        b.vatTiyin += BigInt(row.signed_vat_total);
        b.qtyMilli += BigInt(row.signed_qty);
        b.costTiyin += BigInt(row.signed_cost_value);
        b.grossProfitTiyin += BigInt(row.signed_net_ex_vat) - BigInt(row.signed_cost_value);
      }

      const pays = await client.query<{
        sign: string;
        created_at_ms: string;
        method: string;
        amount: string;
      }>(
        `SELECT '1' AS sign, s.created_at_ms, p.method, p.amount
           FROM payments p
           JOIN sales s ON s.id = p.sale_id AND s.organization_id = p.organization_id
          WHERE p.organization_id = $1 AND s.voided_at_ms IS NULL
            AND ($2::uuid IS NULL OR s.store_id = $2::uuid) AND ${timeFilter('s.created_at_ms')}
         UNION ALL
         SELECT '-1', r.created_at_ms, rp.method, rp.amount
           FROM return_payments rp
           JOIN returns r ON r.id = rp.return_id AND r.organization_id = rp.organization_id
          WHERE rp.organization_id = $1
            AND ($2::uuid IS NULL OR r.store_id = $2::uuid) AND ${timeFilter('r.created_at_ms')}`,
        args,
      );
      for (const row of pays.rows) {
        const dateKey = resolveIntlDateKey(unixMsFromBigInt(BigInt(row.created_at_ms)), tz);
        if (!inRange(dateKey)) continue;
        const b = bucket(dateKey);
        const amt = BigInt(row.amount) * BigInt(row.sign);
        if (row.method === 'cash') b.cashSalesTiyin += amt;
        else b.nonCashSalesTiyin += amt;
      }

      const days: CloudDailySalesReport['days'][number][] = [];
      const tot = {
        sales: 0,
        returns: 0,
        gross: 0n,
        ret: 0n,
        net: 0n,
        vat: 0n,
        cash: 0n,
        nonCash: 0n,
        cost: 0n,
        profit: 0n,
      };
      for (const d of [...buckets.keys()].sort().reverse().slice(0, limit)) {
        const b = buckets.get(d)!;
        tot.sales += b.saleIds.size;
        tot.returns += b.returnIds.size;
        tot.gross += b.grossSalesTiyin;
        tot.ret += b.returnsTiyin;
        tot.net += b.netSalesTiyin;
        tot.vat += b.vatTiyin;
        tot.cash += b.cashSalesTiyin;
        tot.nonCash += b.nonCashSalesTiyin;
        tot.cost += b.costTiyin;
        tot.profit += b.grossProfitTiyin;
        days.push({
          date: d,
          salesCount: b.saleIds.size,
          returnsCount: b.returnIds.size,
          grossSales: moneyFromTiyin(b.grossSalesTiyin),
          returnsTotal: moneyFromTiyin(b.returnsTiyin),
          netSales: moneyFromTiyin(b.netSalesTiyin),
          vatTotal: moneyFromTiyin(b.vatTiyin),
          totalQty: quantityFromMilli(b.qtyMilli),
          cashSales: moneyFromTiyin(b.cashSalesTiyin),
          nonCashSales: moneyFromTiyin(b.nonCashSalesTiyin),
          costValue: params.includeCostAndProfit ? moneyFromTiyin(b.costTiyin) : undefined,
          grossProfit: params.includeCostAndProfit ? moneyFromTiyin(b.grossProfitTiyin) : undefined,
        });
      }

      return {
        days,
        totalSalesCount: tot.sales,
        totalReturnsCount: tot.returns,
        totalGrossSales: moneyFromTiyin(tot.gross),
        totalReturns: moneyFromTiyin(tot.ret),
        totalNetSales: moneyFromTiyin(tot.net),
        totalVat: moneyFromTiyin(tot.vat),
        totalCashSales: moneyFromTiyin(tot.cash),
        totalNonCashSales: moneyFromTiyin(tot.nonCash),
        totalCostValue: params.includeCostAndProfit ? moneyFromTiyin(tot.cost) : undefined,
        totalGrossProfit: params.includeCostAndProfit ? moneyFromTiyin(tot.profit) : undefined,
      };
    });
  }
}
