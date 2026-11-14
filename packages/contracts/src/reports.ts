import { z } from 'zod';
import { BigIntStringSchema, UuidV7Schema } from './auth.js';

export const DateStringSchema = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be formatted as YYYY-MM-DD');

export const MonthStringSchema = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}$/, 'Month must be formatted as YYYY-MM');

// 1. Daily Sales Report
export const DailySalesReportQuerySchema = z
  .object({
    fromDate: DateStringSchema.optional(),
    toDate: DateStringSchema.optional(),
    limit: z.coerce.number().int().min(1).max(366).optional().default(31),
  })
  .strict();

export type DailySalesReportQueryDto = z.infer<typeof DailySalesReportQuerySchema>;

export const DailySalesDaySummarySchema = z
  .object({
    date: DateStringSchema,
    salesCount: z.number().int().min(0),
    returnsCount: z.number().int().min(0),
    grossSales: BigIntStringSchema,
    returnsTotal: BigIntStringSchema,
    netSales: BigIntStringSchema,
    vatTotal: BigIntStringSchema,
    totalQtyMilli: BigIntStringSchema,
    cashSales: BigIntStringSchema,
    nonCashSales: BigIntStringSchema,
    costValue: BigIntStringSchema.optional(),
    grossProfit: BigIntStringSchema.optional(),
  })
  .strict();

export type DailySalesDaySummaryDto = z.infer<typeof DailySalesDaySummarySchema>;

export const DailySalesReportResponseSchema = z
  .object({
    days: z.array(DailySalesDaySummarySchema),
    totalSalesCount: z.number().int().min(0),
    totalReturnsCount: z.number().int().min(0),
    totalGrossSales: BigIntStringSchema,
    totalReturns: BigIntStringSchema,
    totalNetSales: BigIntStringSchema,
    totalVat: BigIntStringSchema,
    totalCashSales: BigIntStringSchema,
    totalNonCashSales: BigIntStringSchema,
    totalCostValue: BigIntStringSchema.optional(),
    totalGrossProfit: BigIntStringSchema.optional(),
  })
  .strict();

export type DailySalesReportResponseDto = z.infer<typeof DailySalesReportResponseSchema>;

// 2. Monthly Sales Report
export const MonthlySalesReportQuerySchema = z
  .object({
    year: z.coerce.number().int().min(2020).max(2100).optional(),
    limit: z.coerce.number().int().min(1).max(60).optional().default(12),
  })
  .strict();

export type MonthlySalesReportQueryDto = z.infer<typeof MonthlySalesReportQuerySchema>;

export const MonthlySalesMonthSummarySchema = z
  .object({
    month: MonthStringSchema,
    salesCount: z.number().int().min(0),
    returnsCount: z.number().int().min(0),
    grossSales: BigIntStringSchema,
    returnsTotal: BigIntStringSchema,
    netSales: BigIntStringSchema,
    vatTotal: BigIntStringSchema,
    totalQtyMilli: BigIntStringSchema,
    costValue: BigIntStringSchema.optional(),
    grossProfit: BigIntStringSchema.optional(),
  })
  .strict();

export type MonthlySalesMonthSummaryDto = z.infer<typeof MonthlySalesMonthSummarySchema>;

export const MonthlySalesReportResponseSchema = z
  .object({
    months: z.array(MonthlySalesMonthSummarySchema),
    totalSalesCount: z.number().int().min(0),
    totalReturnsCount: z.number().int().min(0),
    totalGrossSales: BigIntStringSchema,
    totalReturns: BigIntStringSchema,
    totalNetSales: BigIntStringSchema,
    totalVat: BigIntStringSchema,
    totalCostValue: BigIntStringSchema.optional(),
    totalGrossProfit: BigIntStringSchema.optional(),
  })
  .strict();

export type MonthlySalesReportResponseDto = z.infer<typeof MonthlySalesReportResponseSchema>;

// 3. Profit & Margin Report (Owner-only)
export const ProfitReportQuerySchema = z
  .object({
    fromDate: DateStringSchema.optional(),
    toDate: DateStringSchema.optional(),
    groupBy: z.enum(['day', 'month', 'product']).optional().default('day'),
  })
  .strict();

export type ProfitReportQueryDto = z.infer<typeof ProfitReportQuerySchema>;

export const ProfitItemSummarySchema = z
  .object({
    key: z.string(),
    label: z.string(),
    qtyMilli: BigIntStringSchema,
    netRevenue: BigIntStringSchema,
    costValue: BigIntStringSchema,
    grossProfit: BigIntStringSchema,
    marginBp: z.number().int(),
  })
  .strict();

export type ProfitItemSummaryDto = z.infer<typeof ProfitItemSummarySchema>;

export const ProfitReportResponseSchema = z
  .object({
    items: z.array(ProfitItemSummarySchema),
    totalNetRevenue: BigIntStringSchema,
    totalCostValue: BigIntStringSchema,
    totalGrossProfit: BigIntStringSchema,
    averageMarginBp: z.number().int(),
  })
  .strict();

export type ProfitReportResponseDto = z.infer<typeof ProfitReportResponseSchema>;

// 4. Debts Report
export const DebtsReportQuerySchema = z
  .object({
    type: z.enum(['all', 'customer', 'supplier']).optional().default('all'),
  })
  .strict();

export type DebtsReportQueryDto = z.infer<typeof DebtsReportQuerySchema>;

export const CustomerDebtRecordSchema = z
  .object({
    customerId: UuidV7Schema,
    fullName: z.string(),
    phone: z.string().nullable(),
    balance: BigIntStringSchema,
    overdueAmount: BigIntStringSchema,
    earliestOverdueDueAtMs: BigIntStringSchema.nullable(),
  })
  .strict();

export type CustomerDebtRecordDto = z.infer<typeof CustomerDebtRecordSchema>;

export const SupplierDebtRecordSchema = z
  .object({
    supplierId: UuidV7Schema,
    name: z.string(),
    balance: BigIntStringSchema,
  })
  .strict();

export type SupplierDebtRecordDto = z.infer<typeof SupplierDebtRecordSchema>;

export const DebtsReportResponseSchema = z
  .object({
    totalCustomerDebt: BigIntStringSchema,
    customerCurrentDebt: BigIntStringSchema,
    customerOverdue1To30Days: BigIntStringSchema,
    customerOverdue31To60Days: BigIntStringSchema,
    customerOverdue61PlusDays: BigIntStringSchema,
    customers: z.array(CustomerDebtRecordSchema),
    totalSupplierDebt: BigIntStringSchema,
    suppliers: z.array(SupplierDebtRecordSchema),
  })
  .strict();

export type DebtsReportResponseDto = z.infer<typeof DebtsReportResponseSchema>;

// 5. Low Stock Report
export const LowStockReportQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(500).optional().default(100),
  })
  .strict();

export type LowStockReportQueryDto = z.infer<typeof LowStockReportQuerySchema>;

export const LowStockItemSchema = z
  .object({
    productId: UuidV7Schema,
    name: z.string(),
    sku: z.string().nullable(),
    barcode: z.string().nullable(),
    unit: z.string(),
    currentStockMilli: BigIntStringSchema,
    minStockMilli: BigIntStringSchema,
    deficitMilli: BigIntStringSchema,
  })
  .strict();

export type LowStockItemDto = z.infer<typeof LowStockItemSchema>;

export const LowStockReportResponseSchema = z
  .object({
    items: z.array(LowStockItemSchema),
    totalLowStockProducts: z.number().int().min(0),
  })
  .strict();

export type LowStockReportResponseDto = z.infer<typeof LowStockReportResponseSchema>;

// 6. Expiring Batches Report (R1: uses batches.expiry_date_ms and local_batch_balances.remaining_qty)
export const ExpiringBatchesReportQuerySchema = z
  .object({
    withinDays: z.coerce.number().int().min(1).max(365).optional().default(30),
  })
  .strict();

export type ExpiringBatchesReportQueryDto = z.infer<typeof ExpiringBatchesReportQuerySchema>;

export const ExpiringBatchItemSchema = z
  .object({
    batchId: UuidV7Schema,
    productId: UuidV7Schema,
    productName: z.string(),
    sku: z.string().nullable(),
    batchCode: z.string(),
    expiryDateMs: BigIntStringSchema,
    remainingQtyMilli: BigIntStringSchema,
    unit: z.string(),
    daysRemaining: z.number().int(),
  })
  .strict();

export type ExpiringBatchItemDto = z.infer<typeof ExpiringBatchItemSchema>;

export const ExpiringBatchesReportResponseSchema = z
  .object({
    items: z.array(ExpiringBatchItemSchema),
    totalExpiringBatches: z.number().int().min(0),
  })
  .strict();

export type ExpiringBatchesReportResponseDto = z.infer<typeof ExpiringBatchesReportResponseSchema>;

// 7. Excel Import / Export
export const ExcelImportRowActionSchema = z.enum(['create', 'update', 'skip']);
export type ExcelImportRowAction = z.infer<typeof ExcelImportRowActionSchema>;

export const ExcelImportPreviewRowSchema = z
  .object({
    rowNumber: z.number().int().min(1),
    action: ExcelImportRowActionSchema,
    barcode: z.string().nullable(),
    name: z.string(),
    sku: z.string().nullable(),
    unit: z.string(),
    salePrice: BigIntStringSchema,
    costPrice: BigIntStringSchema.nullable(),
    minStockMilli: BigIntStringSchema.nullable(),
    initialStockMilli: BigIntStringSchema.nullable(),
  })
  .strict();

export type ExcelImportPreviewRowDto = z.infer<typeof ExcelImportPreviewRowSchema>;

export const ExcelImportIssueSchema = z
  .object({
    rowNumber: z.number().int().min(1),
    field: z.string().optional(),
    message: z.string(),
  })
  .strict();

export type ExcelImportIssueDto = z.infer<typeof ExcelImportIssueSchema>;

export const ExcelImportConflictSchema = z
  .object({
    rowNumber: z.number().int().min(1),
    barcode: z.string(),
    existingProductName: z.string(),
    message: z.string(),
  })
  .strict();

export type ExcelImportConflictDto = z.infer<typeof ExcelImportConflictSchema>;

export const ExcelImportPreviewResponseSchema = z
  .object({
    previewToken: UuidV7Schema,
    expiresAtMs: BigIntStringSchema,
    totalRows: z.number().int().min(0),
    validRows: z.number().int().min(0),
    createsCount: z.number().int().min(0),
    updatesCount: z.number().int().min(0),
    errors: z.array(ExcelImportIssueSchema),
    conflicts: z.array(ExcelImportConflictSchema),
    rows: z.array(ExcelImportPreviewRowSchema),
  })
  .strict();

export type ExcelImportPreviewResponseDto = z.infer<typeof ExcelImportPreviewResponseSchema>;

export const ExcelImportCommitRequestSchema = z
  .object({
    previewToken: UuidV7Schema,
    clientRequestId: UuidV7Schema,
  })
  .strict();

export type ExcelImportCommitRequestDto = z.infer<typeof ExcelImportCommitRequestSchema>;

export const ExcelImportCommitResponseSchema = z
  .object({
    importedProductsCount: z.number().int().min(0),
    updatedProductsCount: z.number().int().min(0),
    initialStockMovesCount: z.number().int().min(0),
    idempotentReplay: z.boolean(),
  })
  .strict();

export type ExcelImportCommitResponseDto = z.infer<typeof ExcelImportCommitResponseSchema>;

// 8. SQLite Backup & Restore (R2, R3)
export const BackupRecordSchema = z
  .object({
    id: z.string(),
    filename: z.string(),
    sizeBytes: z.number().int().min(0),
    createdAtMs: BigIntStringSchema,
    sha256: z.string(),
    reason: z.string(),
    actorUserId: UuidV7Schema.nullable(),
    salesCount: z.number().int().min(0),
    totalNetSales: BigIntStringSchema,
  })
  .strict();

export type BackupRecordDto = z.infer<typeof BackupRecordSchema>;

export const BackupListResponseSchema = z
  .object({
    backups: z.array(BackupRecordSchema),
  })
  .strict();

export type BackupListResponseDto = z.infer<typeof BackupListResponseSchema>;

export const CreateBackupRequestSchema = z
  .object({
    reason: z.string().trim().min(2).max(200).optional().default('Manual backup by owner'),
  })
  .strict();

export type CreateBackupRequestDto = z.infer<typeof CreateBackupRequestSchema>;

export const CreateBackupResponseSchema = z
  .object({
    backup: BackupRecordSchema,
  })
  .strict();

export type CreateBackupResponseDto = z.infer<typeof CreateBackupResponseSchema>;

export const StageRestoreRequestSchema = z
  .object({
    reason: z.string().trim().min(2).max(200).optional().default('Restore requested by owner'),
  })
  .strict();

export type StageRestoreRequestDto = z.infer<typeof StageRestoreRequestSchema>;

export const StageRestoreResponseSchema = z
  .object({
    staged: z.boolean(),
    backupId: z.string(),
    requiresRestart: z.boolean(),
    message: z.string(),
  })
  .strict();

export type StageRestoreResponseDto = z.infer<typeof StageRestoreResponseSchema>;
