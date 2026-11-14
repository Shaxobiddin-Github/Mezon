import {
  DomainError,
  type Money,
  type ProductUnit,
  type Quantity,
  type UnixMs,
  type UuidV7,
  moneyFromTiyin,
  moneyToTiyin,
  parseProductUnit,
  parseUuidV7,
  quantityFromMilli,
  quantityToMilli,
  unixMsFromBigInt,
} from '@mezon/domain';
import type { LocalSqliteConnection } from './connection.js';
import { localHubConfig } from './schema/index.js';
import { resolveIntlDateKey } from './timezone.js';
import { type SqliteUnitOfWork, runConnectionReadOnly } from './uow.js';
import { eq } from 'drizzle-orm';

export interface ReportRuntimeContext {
  readonly uow: SqliteUnitOfWork;
  readonly organizationId: UuidV7;
  readonly storeId: UuidV7;
}

export interface CreateSqliteReportStoreOptions {
  readonly connection: LocalSqliteConnection;
  readonly getRuntimeContext: () => ReportRuntimeContext | null;
}

export interface DailySalesDaySummary {
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

export interface DailySalesReportResult {
  readonly days: readonly DailySalesDaySummary[];
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

export interface MonthlySalesMonthSummary {
  readonly month: string;
  readonly salesCount: number;
  readonly returnsCount: number;
  readonly grossSales: Money;
  readonly returnsTotal: Money;
  readonly netSales: Money;
  readonly vatTotal: Money;
  readonly totalQty: Quantity;
  readonly costValue?: Money;
  readonly grossProfit?: Money;
}

export interface MonthlySalesReportResult {
  readonly months: readonly MonthlySalesMonthSummary[];
  readonly totalSalesCount: number;
  readonly totalReturnsCount: number;
  readonly totalGrossSales: Money;
  readonly totalReturns: Money;
  readonly totalNetSales: Money;
  readonly totalVat: Money;
  readonly totalCostValue?: Money;
  readonly totalGrossProfit?: Money;
}

export interface ProfitItemSummary {
  readonly key: string;
  readonly label: string;
  readonly qty: Quantity;
  readonly netRevenue: Money;
  readonly costValue: Money;
  readonly grossProfit: Money;
  readonly marginBp: number;
}

export interface ProfitReportResult {
  readonly items: readonly ProfitItemSummary[];
  readonly totalNetRevenue: Money;
  readonly totalCostValue: Money;
  readonly totalGrossProfit: Money;
  readonly averageMarginBp: number;
}

export interface CustomerDebtSummary {
  readonly customerId: UuidV7;
  readonly fullName: string;
  readonly phone: string | null;
  readonly balance: Money;
  readonly overdueAmount: Money;
  readonly earliestOverdueDueAtMs: UnixMs | null;
}

export interface SupplierDebtSummary {
  readonly supplierId: UuidV7;
  readonly name: string;
  readonly balance: Money;
}

export interface DebtsReportResult {
  readonly totalCustomerDebt: Money;
  readonly customerCurrentDebt: Money;
  readonly customerOverdue1To30Days: Money;
  readonly customerOverdue31To60Days: Money;
  readonly customerOverdue61PlusDays: Money;
  readonly customers: readonly CustomerDebtSummary[];
  readonly totalSupplierDebt: Money;
  readonly suppliers: readonly SupplierDebtSummary[];
}

export interface LowStockItemSummary {
  readonly productId: UuidV7;
  readonly name: string;
  readonly sku: string | null;
  readonly barcode: string | null;
  readonly unit: ProductUnit;
  readonly currentStock: Quantity;
  readonly minStock: Quantity;
  readonly deficit: Quantity;
}

export interface ExpiringBatchItemSummary {
  readonly batchId: UuidV7;
  readonly productId: UuidV7;
  readonly productName: string;
  readonly sku: string | null;
  readonly batchCode: string;
  readonly expiryDateMs: UnixMs;
  readonly remainingQty: Quantity;
  readonly unit: ProductUnit;
  readonly daysRemaining: number;
}

function toBigIntStrict(val: unknown): bigint {
  if (typeof val === 'bigint') return val;
  if (typeof val === 'number' && Number.isSafeInteger(val)) return BigInt(val);
  if (typeof val === 'string' && val.length > 0) return BigInt(val);
  return 0n;
}

export class SqliteReportStore {
  private readonly connection: LocalSqliteConnection;
  private readonly getRuntimeContext: () => ReportRuntimeContext | null;

  public constructor(options: CreateSqliteReportStoreOptions) {
    this.connection = options.connection;
    this.getRuntimeContext = options.getRuntimeContext;
  }

  private requireContext(): ReportRuntimeContext {
    const ctx = this.getRuntimeContext();
    if (!ctx) {
      throw new DomainError('AUTH_UNAUTHORIZED', 'Hub runtime context not available');
    }
    return ctx;
  }

  private readStoreTimezoneSync(): string {
    const row = this.connection.db
      .select({ storeTimezone: localHubConfig.storeTimezone })
      .from(localHubConfig)
      .where(eq(localHubConfig.singletonGuard, 1))
      .get();
    return row?.storeTimezone ?? 'Asia/Tashkent';
  }

  public async getDailySalesReport(params: {
    readonly fromDate?: string;
    readonly toDate?: string;
    readonly limit?: number;
    readonly includeCostAndProfit?: boolean;
  }): Promise<DailySalesReportResult> {
    const ctx = this.requireContext();
    return runConnectionReadOnly(this.connection, () => {
      const tz = this.readStoreTimezoneSync();
      const limit = params.limit ?? 31;

      // 1. Fetch sales lines from single-signed v_sales_lines view
      const lineStmt = this.connection.sqlite.prepare<
        [string, string],
        {
          readonly event_at_ms: unknown;
          readonly document_id: string;
          readonly record_kind: string;
          readonly signed_qty: unknown;
          readonly signed_final_total: unknown;
          readonly signed_net_ex_vat: unknown;
          readonly signed_vat_total: unknown;
          readonly signed_cost_value: unknown;
        }
      >(
        `SELECT "event_at_ms", "document_id", "record_kind", "signed_qty", "signed_final_total",
                "signed_net_ex_vat", "signed_vat_total", "signed_cost_value"
         FROM "v_sales_lines"
         WHERE "organization_id" = ? AND "store_id" = ?`,
      );

      interface DayBucket {
        readonly date: string;
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

      const dayBuckets = new Map<string, DayBucket>();

      const getOrCreateBucket = (d: string): DayBucket => {
        let b = dayBuckets.get(d);
        if (!b) {
          b = {
            date: d,
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
          dayBuckets.set(d, b);
        }
        return b;
      };

      for (const row of lineStmt.iterate(ctx.organizationId, ctx.storeId)) {
        const ms = toBigIntStrict(row.event_at_ms);
        const dateKey = resolveIntlDateKey(unixMsFromBigInt(ms), tz);
        if (params.fromDate && dateKey < params.fromDate) continue;
        if (params.toDate && dateKey > params.toDate) continue;

        const b = getOrCreateBucket(dateKey);
        const sFinal = toBigIntStrict(row.signed_final_total);
        const sNet = toBigIntStrict(row.signed_net_ex_vat);
        const sVat = toBigIntStrict(row.signed_vat_total);
        const sCost = toBigIntStrict(row.signed_cost_value);
        const sQty = toBigIntStrict(row.signed_qty);

        if (row.record_kind === 'sale') {
          b.saleIds.add(row.document_id);
          b.grossSalesTiyin += sFinal;
        } else {
          b.returnIds.add(row.document_id);
          b.returnsTiyin += -sFinal;
        }

        b.netSalesTiyin += sFinal;
        b.vatTiyin += sVat;
        b.qtyMilli += sQty;
        b.costTiyin += sCost;
        b.grossProfitTiyin += sNet - sCost;
      }

      // 2. Fetch payments for cash vs non-cash breakdown
      const payStmt = this.connection.sqlite.prepare<
        [string, string],
        { readonly created_at_ms: unknown; readonly method: string; readonly amount: unknown }
      >(
        `SELECT s.created_at_ms, p.method, p.amount
         FROM payments p
         INNER JOIN sales s ON s.id = p.sale_id
         WHERE s.organization_id = ? AND s.store_id = ? AND s.voided_at_ms IS NULL`,
      );
      for (const row of payStmt.iterate(ctx.organizationId, ctx.storeId)) {
        const ms = toBigIntStrict(row.created_at_ms);
        const dateKey = resolveIntlDateKey(unixMsFromBigInt(ms), tz);
        if (params.fromDate && dateKey < params.fromDate) continue;
        if (params.toDate && dateKey > params.toDate) continue;

        const b = getOrCreateBucket(dateKey);
        const amt = toBigIntStrict(row.amount);
        if (row.method === 'cash') {
          b.cashSalesTiyin += amt;
        } else {
          b.nonCashSalesTiyin += amt;
        }
      }

      const retPayStmt = this.connection.sqlite.prepare<
        [string, string],
        { readonly created_at_ms: unknown; readonly method: string; readonly amount: unknown }
      >(
        `SELECT r.created_at_ms, rp.method, rp.amount
         FROM return_payments rp
         INNER JOIN returns r ON r.id = rp.return_id
         WHERE r.organization_id = ? AND r.store_id = ?`,
      );
      for (const row of retPayStmt.iterate(ctx.organizationId, ctx.storeId)) {
        const ms = toBigIntStrict(row.created_at_ms);
        const dateKey = resolveIntlDateKey(unixMsFromBigInt(ms), tz);
        if (params.fromDate && dateKey < params.fromDate) continue;
        if (params.toDate && dateKey > params.toDate) continue;

        const b = getOrCreateBucket(dateKey);
        const amt = toBigIntStrict(row.amount);
        if (row.method === 'cash') {
          b.cashSalesTiyin -= amt;
        } else {
          b.nonCashSalesTiyin -= amt;
        }
      }

      const sortedDates = [...dayBuckets.keys()].sort().reverse().slice(0, limit);
      const days: DailySalesDaySummary[] = [];

      let totSalesCount = 0;
      let totReturnsCount = 0;
      let totGross = 0n;
      let totReturns = 0n;
      let totNet = 0n;
      let totVat = 0n;
      let totCash = 0n;
      let totNonCash = 0n;
      let totCost = 0n;
      let totProfit = 0n;

      for (const d of sortedDates) {
        const b = dayBuckets.get(d)!;
        const sCount = b.saleIds.size;
        const rCount = b.returnIds.size;

        totSalesCount += sCount;
        totReturnsCount += rCount;
        totGross += b.grossSalesTiyin;
        totReturns += b.returnsTiyin;
        totNet += b.netSalesTiyin;
        totVat += b.vatTiyin;
        totCash += b.cashSalesTiyin;
        totNonCash += b.nonCashSalesTiyin;
        totCost += b.costTiyin;
        totProfit += b.grossProfitTiyin;

        days.push({
          date: d,
          salesCount: sCount,
          returnsCount: rCount,
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
        totalSalesCount: totSalesCount,
        totalReturnsCount: totReturnsCount,
        totalGrossSales: moneyFromTiyin(totGross),
        totalReturns: moneyFromTiyin(totReturns),
        totalNetSales: moneyFromTiyin(totNet),
        totalVat: moneyFromTiyin(totVat),
        totalCashSales: moneyFromTiyin(totCash),
        totalNonCashSales: moneyFromTiyin(totNonCash),
        totalCostValue: params.includeCostAndProfit ? moneyFromTiyin(totCost) : undefined,
        totalGrossProfit: params.includeCostAndProfit ? moneyFromTiyin(totProfit) : undefined,
      };
    });
  }

  public async getMonthlySalesReport(params: {
    readonly year?: number;
    readonly limit?: number;
    readonly includeCostAndProfit?: boolean;
  }): Promise<MonthlySalesReportResult> {
    const daily = await this.getDailySalesReport({
      includeCostAndProfit: params.includeCostAndProfit,
      limit: 366,
    });

    interface MonthBucket {
      readonly month: string;
      salesCount: number;
      returnsCount: number;
      grossSalesTiyin: bigint;
      returnsTiyin: bigint;
      netSalesTiyin: bigint;
      vatTiyin: bigint;
      qtyMilli: bigint;
      costTiyin: bigint;
      grossProfitTiyin: bigint;
    }

    const monthBuckets = new Map<string, MonthBucket>();
    const yearPrefix = params.year !== undefined ? `${params.year}-` : null;

    for (const day of daily.days) {
      const monthKey = day.date.slice(0, 7);
      if (yearPrefix && !monthKey.startsWith(yearPrefix)) continue;

      let b = monthBuckets.get(monthKey);
      if (!b) {
        b = {
          month: monthKey,
          salesCount: 0,
          returnsCount: 0,
          grossSalesTiyin: 0n,
          returnsTiyin: 0n,
          netSalesTiyin: 0n,
          vatTiyin: 0n,
          qtyMilli: 0n,
          costTiyin: 0n,
          grossProfitTiyin: 0n,
        };
        monthBuckets.set(monthKey, b);
      }

      b.salesCount += day.salesCount;
      b.returnsCount += day.returnsCount;
      b.grossSalesTiyin += moneyToTiyin(day.grossSales);
      b.returnsTiyin += moneyToTiyin(day.returnsTotal);
      b.netSalesTiyin += moneyToTiyin(day.netSales);
      b.vatTiyin += moneyToTiyin(day.vatTotal);
      b.qtyMilli += quantityToMilli(day.totalQty);
      if (day.costValue) b.costTiyin += moneyToTiyin(day.costValue);
      if (day.grossProfit) b.grossProfitTiyin += moneyToTiyin(day.grossProfit);
    }

    const sortedMonths = [...monthBuckets.keys()]
      .sort()
      .reverse()
      .slice(0, params.limit ?? 12);
    const months: MonthlySalesMonthSummary[] = [];

    let totSales = 0;
    let totReturns = 0;
    let totGross = 0n;
    let totRet = 0n;
    let totNet = 0n;
    let totVat = 0n;
    let totCost = 0n;
    let totProfit = 0n;

    for (const m of sortedMonths) {
      const b = monthBuckets.get(m)!;
      totSales += b.salesCount;
      totReturns += b.returnsCount;
      totGross += b.grossSalesTiyin;
      totRet += b.returnsTiyin;
      totNet += b.netSalesTiyin;
      totVat += b.vatTiyin;
      totCost += b.costTiyin;
      totProfit += b.grossProfitTiyin;

      months.push({
        month: m,
        salesCount: b.salesCount,
        returnsCount: b.returnsCount,
        grossSales: moneyFromTiyin(b.grossSalesTiyin),
        returnsTotal: moneyFromTiyin(b.returnsTiyin),
        netSales: moneyFromTiyin(b.netSalesTiyin),
        vatTotal: moneyFromTiyin(b.vatTiyin),
        totalQty: quantityFromMilli(b.qtyMilli),
        costValue: params.includeCostAndProfit ? moneyFromTiyin(b.costTiyin) : undefined,
        grossProfit: params.includeCostAndProfit ? moneyFromTiyin(b.grossProfitTiyin) : undefined,
      });
    }

    return {
      months,
      totalSalesCount: totSales,
      totalReturnsCount: totReturns,
      totalGrossSales: moneyFromTiyin(totGross),
      totalReturns: moneyFromTiyin(totRet),
      totalNetSales: moneyFromTiyin(totNet),
      totalVat: moneyFromTiyin(totVat),
      totalCostValue: params.includeCostAndProfit ? moneyFromTiyin(totCost) : undefined,
      totalGrossProfit: params.includeCostAndProfit ? moneyFromTiyin(totProfit) : undefined,
    };
  }

  public async getProfitReport(params: {
    readonly fromDate?: string;
    readonly toDate?: string;
    readonly groupBy?: 'day' | 'month' | 'product';
  }): Promise<ProfitReportResult> {
    const ctx = this.requireContext();
    return runConnectionReadOnly(this.connection, () => {
      const tz = this.readStoreTimezoneSync();
      const groupBy = params.groupBy ?? 'day';

      const lineStmt = this.connection.sqlite.prepare<
        [string, string],
        {
          readonly event_at_ms: unknown;
          readonly product_id: string | null;
          readonly item_name: string;
          readonly signed_qty: unknown;
          readonly signed_net_ex_vat: unknown;
          readonly signed_cost_value: unknown;
        }
      >(
        `SELECT "event_at_ms", "product_id", "item_name", "signed_qty", "signed_net_ex_vat", "signed_cost_value"
         FROM "v_sales_lines"
         WHERE "organization_id" = ? AND "store_id" = ?`,
      );

      interface ProfitBucket {
        readonly key: string;
        readonly label: string;
        qtyMilli: bigint;
        netRevenueTiyin: bigint;
        costTiyin: bigint;
      }

      const buckets = new Map<string, ProfitBucket>();

      for (const row of lineStmt.iterate(ctx.organizationId, ctx.storeId)) {
        const ms = toBigIntStrict(row.event_at_ms);
        const dateKey = resolveIntlDateKey(unixMsFromBigInt(ms), tz);
        if (params.fromDate && dateKey < params.fromDate) continue;
        if (params.toDate && dateKey > params.toDate) continue;

        let bucketKey = dateKey;
        let bucketLabel = dateKey;

        if (groupBy === 'month') {
          bucketKey = dateKey.slice(0, 7);
          bucketLabel = bucketKey;
        } else if (groupBy === 'product') {
          bucketKey = row.product_id ?? row.item_name;
          bucketLabel = row.item_name;
        }

        let b = buckets.get(bucketKey);
        if (!b) {
          b = {
            key: bucketKey,
            label: bucketLabel,
            qtyMilli: 0n,
            netRevenueTiyin: 0n,
            costTiyin: 0n,
          };
          buckets.set(bucketKey, b);
        }

        b.qtyMilli += toBigIntStrict(row.signed_qty);
        b.netRevenueTiyin += toBigIntStrict(row.signed_net_ex_vat);
        b.costTiyin += toBigIntStrict(row.signed_cost_value);
      }

      let totNetRevenue = 0n;
      let totCost = 0n;

      const items: ProfitItemSummary[] = [];
      const sortedKeys = [...buckets.keys()].sort();

      for (const k of sortedKeys) {
        const b = buckets.get(k)!;
        const grossProfit = b.netRevenueTiyin - b.costTiyin;
        totNetRevenue += b.netRevenueTiyin;
        totCost += b.costTiyin;

        let marginBp = 0;
        if (b.netRevenueTiyin > 0n) {
          marginBp = Number((grossProfit * 10000n) / b.netRevenueTiyin);
        }

        items.push({
          key: b.key,
          label: b.label,
          qty: quantityFromMilli(b.qtyMilli),
          netRevenue: moneyFromTiyin(b.netRevenueTiyin),
          costValue: moneyFromTiyin(b.costTiyin),
          grossProfit: moneyFromTiyin(grossProfit),
          marginBp,
        });
      }

      const totProfit = totNetRevenue - totCost;
      let avgMarginBp = 0;
      if (totNetRevenue > 0n) {
        avgMarginBp = Number((totProfit * 10000n) / totNetRevenue);
      }

      return {
        items,
        totalNetRevenue: moneyFromTiyin(totNetRevenue),
        totalCostValue: moneyFromTiyin(totCost),
        totalGrossProfit: moneyFromTiyin(totProfit),
        averageMarginBp: avgMarginBp,
      };
    });
  }

  public async getDebtsReport(params?: {
    readonly type?: 'all' | 'customer' | 'supplier';
    readonly asOfMs?: bigint;
  }): Promise<DebtsReportResult> {
    const ctx = this.requireContext();
    return runConnectionReadOnly(this.connection, () => {
      const nowMs = params?.asOfMs ?? BigInt(Date.now());
      const type = params?.type ?? 'all';

      const customers: CustomerDebtSummary[] = [];
      let totCustDebt = 0n;
      let custCurrentDebt = 0n;
      let cust1To30 = 0n;
      let cust31To60 = 0n;
      let cust61Plus = 0n;

      if (type === 'all' || type === 'customer') {
        const custStmt = this.connection.sqlite.prepare<
          [string],
          {
            readonly customer_id: string;
            readonly full_name: string;
            readonly phone: string | null;
            readonly balance: unknown;
            readonly earliest_open_due_at_ms: unknown;
          }
        >(
          `SELECT cb.customer_id, c.full_name, c.phone_normalized AS phone, cb.balance, cb.earliest_open_due_at_ms
           FROM local_customer_balances cb
           INNER JOIN customers c ON c.id = cb.customer_id
           WHERE cb.organization_id = ? AND cb.balance > 0
           ORDER BY cb.balance DESC`,
        );

        for (const r of custStmt.iterate(ctx.organizationId)) {
          const bal = toBigIntStrict(r.balance);
          const earliestDue =
            r.earliest_open_due_at_ms !== null && r.earliest_open_due_at_ms !== undefined
              ? toBigIntStrict(r.earliest_open_due_at_ms)
              : null;

          totCustDebt += bal;

          let overdue = 0n;
          let isOverdue = false;
          let daysOverdue = 0;

          if (earliestDue !== null && nowMs > earliestDue) {
            isOverdue = true;
            overdue = bal;
            const diffMs = nowMs - earliestDue;
            daysOverdue = Number(diffMs / 86_400_000n);
          }

          if (!isOverdue) {
            custCurrentDebt += bal;
          } else if (daysOverdue <= 30) {
            cust1To30 += overdue;
          } else if (daysOverdue <= 60) {
            cust31To60 += overdue;
          } else {
            cust61Plus += overdue;
          }

          customers.push({
            customerId: parseUuidV7(r.customer_id),
            fullName: r.full_name,
            phone: r.phone,
            balance: moneyFromTiyin(bal),
            overdueAmount: moneyFromTiyin(overdue),
            earliestOverdueDueAtMs: earliestDue !== null ? unixMsFromBigInt(earliestDue) : null,
          });
        }
      }

      const suppliers: SupplierDebtSummary[] = [];
      let totSupDebt = 0n;

      if (type === 'all' || type === 'supplier') {
        const supStmt = this.connection.sqlite.prepare<
          [string],
          {
            readonly supplier_id: string;
            readonly name: string;
            readonly balance: unknown;
          }
        >(
          `SELECT sb.supplier_id, s.name, sb.balance
           FROM local_supplier_balances sb
           INNER JOIN suppliers s ON s.id = sb.supplier_id
           WHERE sb.organization_id = ? AND sb.balance > 0
           ORDER BY sb.balance DESC`,
        );

        for (const r of supStmt.iterate(ctx.organizationId)) {
          const bal = toBigIntStrict(r.balance);
          totSupDebt += bal;
          suppliers.push({
            supplierId: parseUuidV7(r.supplier_id),
            name: r.name,
            balance: moneyFromTiyin(bal),
          });
        }
      }

      return {
        totalCustomerDebt: moneyFromTiyin(totCustDebt),
        customerCurrentDebt: moneyFromTiyin(custCurrentDebt),
        customerOverdue1To30Days: moneyFromTiyin(cust1To30),
        customerOverdue31To60Days: moneyFromTiyin(cust31To60),
        customerOverdue61PlusDays: moneyFromTiyin(cust61Plus),
        customers,
        totalSupplierDebt: moneyFromTiyin(totSupDebt),
        suppliers,
      };
    });
  }

  public async getLowStockReport(params?: {
    readonly limit?: number;
  }): Promise<readonly LowStockItemSummary[]> {
    const ctx = this.requireContext();
    return runConnectionReadOnly(this.connection, () => {
      const limit = params?.limit ?? 100;

      const stmt = this.connection.sqlite.prepare<
        [string, string, number],
        {
          readonly product_id: string;
          readonly name: string;
          readonly sku: string | null;
          readonly unit: string;
          readonly min_stock: unknown;
          readonly qty_on_hand: unknown;
          readonly deficit_qty: unknown;
        }
      >(
        `SELECT p.id AS product_id, p.name, p.sku, p.unit, p.min_stock,
                COALESCE(sb.qty_on_hand, 0) AS qty_on_hand,
                COALESCE(sb.deficit_qty, 0) AS deficit_qty
         FROM products p
         LEFT JOIN local_stock_balances sb
           ON sb.product_id = p.id AND sb.organization_id = p.organization_id AND sb.store_id = ? AND sb.variant_id IS NULL
         WHERE p.organization_id = ?
           AND p.deleted_at_ms IS NULL
           AND p.min_stock IS NOT NULL
           AND (COALESCE(sb.qty_on_hand, 0) - COALESCE(sb.deficit_qty, 0)) <= p.min_stock
         ORDER BY (p.min_stock - (COALESCE(sb.qty_on_hand, 0) - COALESCE(sb.deficit_qty, 0))) DESC
         LIMIT ?`,
      );

      const barcodeStmt = this.connection.sqlite.prepare<[string], { readonly barcode: string }>(
        `SELECT barcode FROM product_barcodes WHERE product_id = ? LIMIT 1`,
      );

      const items: LowStockItemSummary[] = [];

      for (const r of stmt.iterate(ctx.storeId, ctx.organizationId, limit)) {
        const minStockMilli = toBigIntStrict(r.min_stock);
        const onHand = toBigIntStrict(r.qty_on_hand);
        const deficit = toBigIntStrict(r.deficit_qty);
        const currentStockMilli = onHand - deficit;
        const deficitMilli =
          minStockMilli > currentStockMilli ? minStockMilli - currentStockMilli : 0n;

        const barcodeRow = barcodeStmt.get(r.product_id);

        items.push({
          productId: parseUuidV7(r.product_id),
          name: r.name,
          sku: r.sku,
          barcode: barcodeRow?.barcode ?? null,
          unit: parseProductUnit(r.unit),
          currentStock: quantityFromMilli(currentStockMilli),
          minStock: quantityFromMilli(minStockMilli),
          deficit: quantityFromMilli(deficitMilli),
        });
      }

      return items;
    });
  }

  // R1: uses batches.expiry_date_ms and local_batch_balances.remaining_qty
  public async getExpiringBatchesReport(params?: {
    readonly withinDays?: number;
    readonly asOfMs?: bigint;
  }): Promise<readonly ExpiringBatchItemSummary[]> {
    const ctx = this.requireContext();
    return runConnectionReadOnly(this.connection, () => {
      const nowMs = params?.asOfMs ?? BigInt(Date.now());
      const withinDays = params?.withinDays ?? 30;
      const thresholdMs = nowMs + BigInt(withinDays * 86_400_000);

      const stmt = this.connection.sqlite.prepare<
        [string, string, bigint],
        {
          readonly batch_id: string;
          readonly product_id: string;
          readonly batch_number: string | null;
          readonly expiry_date_ms: unknown;
          readonly product_name: string;
          readonly sku: string | null;
          readonly unit: string;
          readonly remaining_qty: unknown;
        }
      >(
        `SELECT b.id AS batch_id, b.product_id, b.batch_number, b.expiry_date_ms,
                p.name AS product_name, p.sku, p.unit, bb.remaining_qty
         FROM batches b
         INNER JOIN products p ON p.id = b.product_id
         INNER JOIN local_batch_balances bb ON bb.batch_id = b.id
         WHERE b.organization_id = ?
           AND bb.store_id = ?
           AND b.expiry_date_ms IS NOT NULL
           AND b.expiry_date_ms <= ?
           AND bb.remaining_qty > 0
         ORDER BY b.expiry_date_ms ASC`,
      );

      const items: ExpiringBatchItemSummary[] = [];

      for (const r of stmt.iterate(ctx.organizationId, ctx.storeId, thresholdMs)) {
        const expiryMs = toBigIntStrict(r.expiry_date_ms);
        const remQty = toBigIntStrict(r.remaining_qty);
        const diffMs = expiryMs - nowMs;
        const daysRemaining = Math.floor(Number(diffMs) / 86_400_000);

        items.push({
          batchId: parseUuidV7(r.batch_id),
          productId: parseUuidV7(r.product_id),
          productName: r.product_name,
          sku: r.sku,
          batchCode: r.batch_number ?? '-',
          expiryDateMs: unixMsFromBigInt(expiryMs),
          remainingQty: quantityFromMilli(remQty),
          unit: parseProductUnit(r.unit),
          daysRemaining,
        });
      }

      return items;
    });
  }
}

export function createSqliteReportStore(
  options: CreateSqliteReportStoreOptions,
): SqliteReportStore {
  return new SqliteReportStore(options);
}
