import { describe, expect, it } from 'vitest';
import {
  DailySalesReportQuerySchema,
  DailySalesReportResponseSchema,
  DebtsReportResponseSchema,
  ExcelImportCommitRequestSchema,
  ExcelImportPreviewResponseSchema,
  ExpiringBatchesReportResponseSchema,
  LowStockReportResponseSchema,
  MonthlySalesReportResponseSchema,
  ProfitReportResponseSchema,
} from './reports.js';

describe('@mezon/contracts - T1.13 Reports, Excel & Backup Schemas', () => {
  it('validates daily and monthly sales report queries and responses', () => {
    const q = DailySalesReportQuerySchema.parse({
      fromDate: '2026-11-01',
      toDate: '2026-11-14',
      limit: 14,
    });
    expect(q.fromDate).toBe('2026-11-01');

    const res = DailySalesReportResponseSchema.parse({
      days: [
        {
          date: '2026-11-14',
          salesCount: 10,
          returnsCount: 1,
          grossSales: '15000000',
          returnsTotal: '1000000',
          netSales: '14000000',
          vatTotal: '1680000',
          totalQtyMilli: '25000',
          cashSales: '10000000',
          nonCashSales: '4000000',
        },
      ],
      totalSalesCount: 10,
      totalReturnsCount: 1,
      totalGrossSales: '15000000',
      totalReturns: '1000000',
      totalNetSales: '14000000',
      totalVat: '1680000',
      totalCashSales: '10000000',
      totalNonCashSales: '4000000',
    });
    expect(res.days).toHaveLength(1);
    expect(res.days[0].netSales).toBe('14000000');
    // Verify optional costValue/grossProfit can be present or absent
    expect(res.days[0].costValue).toBeUndefined();

    const monthRes = MonthlySalesReportResponseSchema.parse({
      months: [
        {
          month: '2026-11',
          salesCount: 100,
          returnsCount: 5,
          grossSales: '150000000',
          returnsTotal: '10000000',
          netSales: '140000000',
          vatTotal: '16800000',
          totalQtyMilli: '250000',
        },
      ],
      totalSalesCount: 100,
      totalReturnsCount: 5,
      totalGrossSales: '150000000',
      totalReturns: '10000000',
      totalNetSales: '140000000',
      totalVat: '16800000',
    });
    expect(monthRes.months).toHaveLength(1);
  });

  it('validates profit report schema (owner-only metrics)', () => {
    const profit = ProfitReportResponseSchema.parse({
      items: [
        {
          key: '2026-11-14',
          label: '2026-11-14',
          qtyMilli: '10000',
          netRevenue: '10000000',
          costValue: '6000000',
          grossProfit: '4000000',
          marginBp: 4000,
        },
      ],
      totalNetRevenue: '10000000',
      totalCostValue: '6000000',
      totalGrossProfit: '4000000',
      averageMarginBp: 4000,
    });
    expect(profit.items[0].grossProfit).toBe('4000000');
  });

  it('validates debts, low stock and expiring batches schemas (R1)', () => {
    const debts = DebtsReportResponseSchema.parse({
      totalCustomerDebt: '5000000',
      customerCurrentDebt: '3000000',
      customerOverdue1To30Days: '1500000',
      customerOverdue31To60Days: '500000',
      customerOverdue61PlusDays: '0',
      customers: [
        {
          customerId: '01950000-0000-7000-8000-000000000001',
          fullName: 'Rustam Karimov',
          phone: '+998901234567',
          balance: '5000000',
          overdueAmount: '2000000',
          earliestOverdueDueAtMs: '1763100000000',
        },
      ],
      totalSupplierDebt: '12000000',
      suppliers: [
        {
          supplierId: '01950000-0000-7000-8000-000000000002',
          name: 'Samarkand Sut MCHJ',
          balance: '12000000',
        },
      ],
    });
    expect(debts.customers).toHaveLength(1);

    const lowStock = LowStockReportResponseSchema.parse({
      items: [
        {
          productId: '01950000-0000-7000-8000-000000000003',
          name: 'Pepsi 1.5L',
          sku: 'PEP-15',
          barcode: '4780000000012',
          unit: 'dona',
          currentStockMilli: '2000',
          minStockMilli: '10000',
          deficitMilli: '8000',
        },
      ],
      totalLowStockProducts: 1,
    });
    expect(lowStock.items[0].deficitMilli).toBe('8000');

    // R1: uses expiryDateMs and remainingQtyMilli
    const expiring = ExpiringBatchesReportResponseSchema.parse({
      items: [
        {
          batchId: '01950000-0000-7000-8000-000000000004',
          productId: '01950000-0000-7000-8000-000000000005',
          productName: 'Tvorog 9%',
          sku: 'TVR-9',
          batchCode: 'B-2026-11',
          expiryDateMs: '1763100000000',
          remainingQtyMilli: '5000',
          unit: 'kg',
          daysRemaining: 3,
        },
      ],
      totalExpiringBatches: 1,
    });
    expect(expiring.items[0].remainingQtyMilli).toBe('5000');
  });

  it('validates Excel import preview and commit schemas (R4)', () => {
    const preview = ExcelImportPreviewResponseSchema.parse({
      previewToken: '01950000-0000-7000-8000-000000000010',
      expiresAtMs: '1763110000000',
      totalRows: 2,
      validRows: 2,
      createsCount: 1,
      updatesCount: 1,
      errors: [],
      conflicts: [],
      rows: [
        {
          rowNumber: 2,
          action: 'create',
          barcode: '4780000000099',
          name: 'Non Samarqand',
          sku: 'NON-01',
          unit: 'dona',
          salePrice: '500000',
          costPrice: '350000',
          minStockMilli: '5000',
          initialStockMilli: '20000',
        },
      ],
    });
    expect(preview.createsCount).toBe(1);

    const commit = ExcelImportCommitRequestSchema.parse({
      previewToken: '01950000-0000-7000-8000-000000000010',
      clientRequestId: '01950000-0000-7000-8000-000000000011',
    });
    expect(commit.previewToken).toBeDefined();
  });
});
