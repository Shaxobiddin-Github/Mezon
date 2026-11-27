import {
  type DailySalesReportQueryDto,
  type DailySalesReportResponseDto,
  type DashboardResponseDto,
  type DebtsReportQueryDto,
  type DebtsReportResponseDto,
  type ExpiringBatchesReportQueryDto,
  type ExpiringBatchesReportResponseDto,
  type LowStockReportQueryDto,
  type LowStockReportResponseDto,
  type MonthlySalesReportQueryDto,
  type MonthlySalesReportResponseDto,
  type ProfitReportQueryDto,
  type ProfitReportResponseDto,
} from '@mezon/contracts';
import { type SqliteReportStore } from '@mezon/db-local';
import {
  DomainError,
  type Money,
  type UserRole,
  moneyToTiyin,
  quantityToMilli,
  serializeUnixMs,
} from '@mezon/domain';
import { ExcelPort } from './excel-port.js';

export class HubReportService {
  public constructor(
    private readonly reportStore: SqliteReportStore,
    /** Hub clock (tests pass a fixed one). */
    private readonly nowMs: () => bigint = () => BigInt(Date.now()),
  ) {}

  public async getDailySales(
    query: DailySalesReportQueryDto,
    callerRole: UserRole,
  ): Promise<DailySalesReportResponseDto> {
    const isOwner = callerRole === 'owner';
    const res = await this.reportStore.getDailySalesReport({
      fromDate: query.fromDate,
      toDate: query.toDate,
      limit: query.limit,
      includeCostAndProfit: isOwner,
    });

    return {
      days: res.days.map((d) => ({
        date: d.date,
        salesCount: d.salesCount,
        returnsCount: d.returnsCount,
        grossSales: moneyToTiyin(d.grossSales).toString(),
        returnsTotal: moneyToTiyin(d.returnsTotal).toString(),
        netSales: moneyToTiyin(d.netSales).toString(),
        vatTotal: moneyToTiyin(d.vatTotal).toString(),
        totalQtyMilli: quantityToMilli(d.totalQty).toString(),
        cashSales: moneyToTiyin(d.cashSales).toString(),
        nonCashSales: moneyToTiyin(d.nonCashSales).toString(),
        costValue: isOwner && d.costValue ? moneyToTiyin(d.costValue).toString() : undefined,
        grossProfit: isOwner && d.grossProfit ? moneyToTiyin(d.grossProfit).toString() : undefined,
      })),
      totalSalesCount: res.totalSalesCount,
      totalReturnsCount: res.totalReturnsCount,
      totalGrossSales: moneyToTiyin(res.totalGrossSales).toString(),
      totalReturns: moneyToTiyin(res.totalReturns).toString(),
      totalNetSales: moneyToTiyin(res.totalNetSales).toString(),
      totalVat: moneyToTiyin(res.totalVat).toString(),
      totalCashSales: moneyToTiyin(res.totalCashSales).toString(),
      totalNonCashSales: moneyToTiyin(res.totalNonCashSales).toString(),
      totalCostValue:
        isOwner && res.totalCostValue ? moneyToTiyin(res.totalCostValue).toString() : undefined,
      totalGrossProfit:
        isOwner && res.totalGrossProfit ? moneyToTiyin(res.totalGrossProfit).toString() : undefined,
    };
  }

  public async getMonthlySales(
    query: MonthlySalesReportQueryDto,
    callerRole: UserRole,
  ): Promise<MonthlySalesReportResponseDto> {
    const isOwner = callerRole === 'owner';

    const res = await this.reportStore.getMonthlySalesReport({
      year: query.year,
      limit: query.limit,
      includeCostAndProfit: isOwner,
    });

    return {
      months: res.months.map((m) => ({
        month: m.month,
        salesCount: m.salesCount,
        returnsCount: m.returnsCount,
        grossSales: moneyToTiyin(m.grossSales).toString(),
        returnsTotal: moneyToTiyin(m.returnsTotal).toString(),
        netSales: moneyToTiyin(m.netSales).toString(),
        vatTotal: moneyToTiyin(m.vatTotal).toString(),
        totalQtyMilli: quantityToMilli(m.totalQty).toString(),
        costValue: isOwner && m.costValue ? moneyToTiyin(m.costValue).toString() : undefined,
        grossProfit: isOwner && m.grossProfit ? moneyToTiyin(m.grossProfit).toString() : undefined,
      })),
      totalSalesCount: res.totalSalesCount,
      totalReturnsCount: res.totalReturnsCount,
      totalGrossSales: moneyToTiyin(res.totalGrossSales).toString(),
      totalReturns: moneyToTiyin(res.totalReturns).toString(),
      totalNetSales: moneyToTiyin(res.totalNetSales).toString(),
      totalVat: moneyToTiyin(res.totalVat).toString(),
      totalCostValue:
        isOwner && res.totalCostValue ? moneyToTiyin(res.totalCostValue).toString() : undefined,
      totalGrossProfit:
        isOwner && res.totalGrossProfit ? moneyToTiyin(res.totalGrossProfit).toString() : undefined,
    };
  }

  public async getProfitReport(
    query: ProfitReportQueryDto,
    callerRole: UserRole,
  ): Promise<ProfitReportResponseDto> {
    if (callerRole !== 'owner') {
      throw new DomainError('AUTH_FORBIDDEN', 'Foyda hisoboti faqat biznes egasiga koʻrinadi');
    }

    const res = await this.reportStore.getProfitReport({
      fromDate: query.fromDate,
      toDate: query.toDate,
      groupBy: query.groupBy,
    });

    return {
      items: res.items.map((i) => ({
        key: i.key,
        label: i.label,
        qtyMilli: quantityToMilli(i.qty).toString(),
        netRevenue: moneyToTiyin(i.netRevenue).toString(),
        costValue: moneyToTiyin(i.costValue).toString(),
        grossProfit: moneyToTiyin(i.grossProfit).toString(),
        marginBp: i.marginBp,
      })),
      totalNetRevenue: moneyToTiyin(res.totalNetRevenue).toString(),
      totalCostValue: moneyToTiyin(res.totalCostValue).toString(),
      totalGrossProfit: moneyToTiyin(res.totalGrossProfit).toString(),
      averageMarginBp: res.averageMarginBp,
    };
  }

  public async getDebtsReport(query: DebtsReportQueryDto): Promise<DebtsReportResponseDto> {
    const res = await this.reportStore.getDebtsReport({
      type: query.type,
    });

    return {
      totalCustomerDebt: moneyToTiyin(res.totalCustomerDebt).toString(),
      customerCurrentDebt: moneyToTiyin(res.customerCurrentDebt).toString(),
      customerOverdue1To30Days: moneyToTiyin(res.customerOverdue1To30Days).toString(),
      customerOverdue31To60Days: moneyToTiyin(res.customerOverdue31To60Days).toString(),
      customerOverdue61PlusDays: moneyToTiyin(res.customerOverdue61PlusDays).toString(),
      customers: res.customers.map((c) => ({
        customerId: c.customerId,
        fullName: c.fullName,
        phone: c.phone,
        balance: moneyToTiyin(c.balance).toString(),
        overdueAmount: moneyToTiyin(c.overdueAmount).toString(),
        earliestOverdueDueAtMs: c.earliestOverdueDueAtMs
          ? serializeUnixMs(c.earliestOverdueDueAtMs)
          : null,
      })),
      totalSupplierDebt: moneyToTiyin(res.totalSupplierDebt).toString(),
      suppliers: res.suppliers.map((s) => ({
        supplierId: s.supplierId,
        name: s.name,
        balance: moneyToTiyin(s.balance).toString(),
      })),
    };
  }

  /**
   * C23: everything the owner's home screen needs in one call. Profit and purchase-price stock
   * value only for the owner (same rule as the daily report).
   */
  public async getDashboard(callerRole: UserRole): Promise<DashboardResponseDto> {
    const isOwner = callerRole === 'owner';
    const extras = await this.reportStore.getDashboardExtras({ nowMs: this.nowMs() });
    const keys = extras.weekKeys;
    const daily = await this.reportStore.getDailySalesReport({
      fromDate: keys[0],
      toDate: extras.dateKey,
      limit: 8,
      includeCostAndProfit: isOwner,
    });
    const byDate = new Map(daily.days.map((d) => [d.date, d]));
    const debts = await this.reportStore.getDebtsReport({ type: 'all' });
    const low = await this.reportStore.getLowStockReport({ limit: 500 });
    const today = byDate.get(extras.dateKey);
    const t = (m: Money | undefined | null) => (m ? moneyToTiyin(m).toString() : '0');
    return {
      date: extras.dateKey,
      today: {
        netSales: t(today?.netSales),
        salesCount: today?.salesCount ?? 0,
        returnsTotal: t(today?.returnsTotal),
        cashSales: t(today?.cashSales),
        nonCashSales: t(today?.nonCashSales),
        grossProfit: isOwner ? t(today?.grossProfit) : null,
        newDebt: extras.newDebtTiyin.toString(),
        debtCollected: extras.debtCollectedTiyin.toString(),
        expenses: extras.expensesTiyin.toString(),
      },
      yesterdayNetSales: t(byDate.get(extras.yesterdayKey)?.netSales),
      week: keys.map((date) => ({
        date,
        netSales: t(byDate.get(date)?.netSales),
        salesCount: byDate.get(date)?.salesCount ?? 0,
      })),
      customerDebtTotal: t(debts.totalCustomerDebt),
      supplierDebtTotal: t(debts.totalSupplierDebt),
      stock: {
        costValue: isOwner ? extras.stockCostTiyin.toString() : null,
        retailValue: extras.stockRetailTiyin.toString(),
        productsInStock: extras.productsInStock,
        outOfStock: extras.outOfStockCount,
        lowStock: low.length,
      },
    };
  }

  public async getLowStock(query: LowStockReportQueryDto): Promise<LowStockReportResponseDto> {
    const res = await this.reportStore.getLowStockReport({
      limit: query.limit,
    });

    return {
      items: res.map((i) => ({
        productId: i.productId,
        name: i.name,
        sku: i.sku,
        barcode: i.barcode,
        unit: i.unit,
        currentStockMilli: quantityToMilli(i.currentStock).toString(),
        minStockMilli: quantityToMilli(i.minStock).toString(),
        deficitMilli: quantityToMilli(i.deficit).toString(),
      })),
      totalLowStockProducts: res.length,
    };
  }

  public async getExpiringBatches(
    query: ExpiringBatchesReportQueryDto,
  ): Promise<ExpiringBatchesReportResponseDto> {
    const res = await this.reportStore.getExpiringBatchesReport({
      withinDays: query.withinDays,
    });

    return {
      items: res.map((b) => ({
        batchId: b.batchId,
        productId: b.productId,
        productName: b.productName,
        sku: b.sku,
        batchCode: b.batchCode,
        expiryDateMs: serializeUnixMs(b.expiryDateMs),
        remainingQtyMilli: quantityToMilli(b.remainingQty).toString(),
        unit: b.unit,
        daysRemaining: b.daysRemaining,
      })),
      totalExpiringBatches: res.length,
    };
  }

  public async exportDailySales(
    query: DailySalesReportQueryDto,
    callerRole: UserRole,
  ): Promise<Buffer> {
    const isOwner = callerRole === 'owner';
    const report = await this.reportStore.getDailySalesReport({
      fromDate: query.fromDate,
      toDate: query.toDate,
      limit: query.limit,
      includeCostAndProfit: isOwner,
    });

    return ExcelPort.generateDailySalesWorkbook(report, { includeCost: isOwner });
  }

  public async exportDebts(query: DebtsReportQueryDto): Promise<Buffer> {
    const report = await this.reportStore.getDebtsReport({
      type: query.type,
    });

    return ExcelPort.generateDebtsWorkbook(report);
  }
}
