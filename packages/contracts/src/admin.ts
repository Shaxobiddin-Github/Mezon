import { z } from 'zod';
import { BigIntStringSchema, UuidV7Schema } from './auth.js';
import { DateStringSchema } from './reports.js';

// Phone masking helper: '+998 90 *** ** 12'
export function maskPhoneNumber(phone: string | null | undefined): string | null {
  if (!phone) return null;
  const digitsOnly = phone.replace(/\D/g, '');
  if (digitsOnly.length < 9) {
    return '***';
  }
  // Take last 2 digits
  const last2 = digitsOnly.slice(-2);
  // If Uzbekistan number (9 or 12 digits)
  if (digitsOnly.length === 12 && digitsOnly.startsWith('998')) {
    const code = digitsOnly.slice(3, 5);
    return `+998 ${code} *** ** ${last2}`;
  }
  if (digitsOnly.length === 9) {
    const code = digitsOnly.slice(0, 2);
    return `+998 ${code} *** ** ${last2}`;
  }
  // Generic phone
  return `+${digitsOnly.slice(0, Math.min(4, digitsOnly.length - 4))} *** ${last2}`;
}

// 1. Dashboard & Store Freshness
export const AdminStoreFreshnessSchema = z
  .object({
    storeId: UuidV7Schema,
    storeName: z.string().min(1),
    lastEventAtMs: BigIntStringSchema.nullable(),
    isStale: z.boolean(), // true if lastEventAtMs is null or > 10m ago
  })
  .strict();

export type AdminStoreFreshnessDto = z.infer<typeof AdminStoreFreshnessSchema>;

export const AdminDashboardResponseSchema = z
  .object({
    todayDate: DateStringSchema,
    grossSales: BigIntStringSchema,
    returnsTotal: BigIntStringSchema,
    netSales: BigIntStringSchema,
    receiptsCount: z.number().int().min(0),
    avgReceipt: BigIntStringSchema,
    grossProfit: BigIntStringSchema.optional(), // Only for owner/manager
    marginBp: z.number().int().optional(),
    stores: z.array(AdminStoreFreshnessSchema),
  })
  .strict();

export type AdminDashboardResponseDto = z.infer<typeof AdminDashboardResponseSchema>;

// 2. Receipts Keyset Pagination & Detail
export const AdminReceiptsQuerySchema = z
  .object({
    storeId: UuidV7Schema.optional(),
    status: z.enum(['completed', 'voided', 'returned']).optional(),
    fromDate: DateStringSchema.optional(),
    toDate: DateStringSchema.optional(),
    cursor: z.string().trim().optional(), // Keyset cursor: encoded 'createdAtMs:id'
    limit: z.coerce.number().int().min(1).max(200).optional().default(50),
  })
  .strict();

export type AdminReceiptsQueryDto = z.infer<typeof AdminReceiptsQuerySchema>;

export const AdminReceiptItemSchema = z
  .object({
    id: UuidV7Schema,
    receiptNumber: z.string(),
    storeId: UuidV7Schema,
    storeName: z.string(),
    cashierName: z.string().nullable(),
    totalTiyin: BigIntStringSchema,
    status: z.enum(['completed', 'voided', 'returned']),
    paymentMethods: z.array(z.string()),
    createdAtMs: BigIntStringSchema,
    voidedAtMs: BigIntStringSchema.nullable(),
  })
  .strict();

export type AdminReceiptItemDto = z.infer<typeof AdminReceiptItemSchema>;

export const AdminReceiptsResponseSchema = z
  .object({
    items: z.array(AdminReceiptItemSchema),
    nextCursor: z.string().nullable(),
  })
  .strict();

export type AdminReceiptsResponseDto = z.infer<typeof AdminReceiptsResponseSchema>;

export const AdminReceiptLineSchema = z
  .object({
    id: UuidV7Schema,
    productId: UuidV7Schema.nullable(),
    productName: z.string(),
    sku: z.string().nullable(),
    barcode: z.string().nullable(),
    unit: z.string(),
    qtyMilli: BigIntStringSchema,
    unitPriceTiyin: BigIntStringSchema,
    totalTiyin: BigIntStringSchema,
    vatPercent: z.number().int(),
    vatTiyin: BigIntStringSchema,
    discountTiyin: BigIntStringSchema,
    mxikCode: z.string().nullable(),
  })
  .strict();

export type AdminReceiptLineDto = z.infer<typeof AdminReceiptLineSchema>;

export const AdminReceiptPaymentSchema = z
  .object({
    id: UuidV7Schema,
    method: z.string(),
    amountTiyin: BigIntStringSchema,
    createdAtMs: BigIntStringSchema,
  })
  .strict();

export type AdminReceiptPaymentDto = z.infer<typeof AdminReceiptPaymentSchema>;

export const AdminReceiptDetailResponseSchema = z
  .object({
    id: UuidV7Schema,
    receiptNumber: z.string(),
    storeId: UuidV7Schema,
    storeName: z.string(),
    cashierName: z.string().nullable(),
    status: z.enum(['completed', 'voided', 'returned']),
    grossTotalTiyin: BigIntStringSchema,
    discountTotalTiyin: BigIntStringSchema,
    netTotalTiyin: BigIntStringSchema,
    vatTotalTiyin: BigIntStringSchema,
    createdAtMs: BigIntStringSchema,
    voidedAtMs: BigIntStringSchema.nullable(),
    voidReason: z.string().nullable(),
    customerName: z.string().nullable(),
    lines: z.array(AdminReceiptLineSchema),
    payments: z.array(AdminReceiptPaymentSchema),
  })
  .strict();

export type AdminReceiptDetailResponseDto = z.infer<typeof AdminReceiptDetailResponseSchema>;

// 3. Customers Keyset Pagination & Detail
export const AdminCustomersQuerySchema = z
  .object({
    search: z.string().trim().max(100).optional(),
    hasDebtOnly: z.coerce.boolean().optional(),
    cursor: z.string().trim().optional(),
    limit: z.coerce.number().int().min(1).max(200).optional().default(50),
  })
  .strict();

export type AdminCustomersQueryDto = z.infer<typeof AdminCustomersQuerySchema>;

export const AdminCustomerItemSchema = z
  .object({
    id: UuidV7Schema,
    fullName: z.string(),
    maskedPhone: z.string().nullable(),
    balanceTiyin: BigIntStringSchema,
    overdueAmountTiyin: BigIntStringSchema,
    createdAtMs: BigIntStringSchema,
  })
  .strict();

export type AdminCustomerItemDto = z.infer<typeof AdminCustomerItemSchema>;

export const AdminCustomersResponseSchema = z
  .object({
    items: z.array(AdminCustomerItemSchema),
    nextCursor: z.string().nullable(),
  })
  .strict();

export type AdminCustomersResponseDto = z.infer<typeof AdminCustomersResponseSchema>;

export const AdminCustomerLedgerEntrySchema = z
  .object({
    id: UuidV7Schema,
    entryType: z.string(),
    amountTiyin: BigIntStringSchema,
    balanceAfterTiyin: BigIntStringSchema,
    sourceType: z.string().nullable(),
    sourceId: UuidV7Schema.nullable(),
    reason: z.string().nullable(),
    createdAtMs: BigIntStringSchema,
  })
  .strict();

export type AdminCustomerLedgerEntryDto = z.infer<typeof AdminCustomerLedgerEntrySchema>;

export const AdminCustomerDetailResponseSchema = z
  .object({
    id: UuidV7Schema,
    fullName: z.string(),
    phone: z.string().nullable(), // Unmasked if manager/owner, masked otherwise
    balanceTiyin: BigIntStringSchema,
    overdueAmountTiyin: BigIntStringSchema,
    earliestOverdueDueAtMs: BigIntStringSchema.nullable(),
    notes: z.string().nullable(),
    createdAtMs: BigIntStringSchema,
    ledger: z.array(AdminCustomerLedgerEntrySchema),
  })
  .strict();

export type AdminCustomerDetailResponseDto = z.infer<typeof AdminCustomerDetailResponseSchema>;

// 4. Products Keyset Pagination & Inventory
export const AdminProductsQuerySchema = z
  .object({
    search: z.string().trim().max(100).optional(),
    categoryId: UuidV7Schema.optional(),
    cursor: z.string().trim().optional(),
    limit: z.coerce.number().int().min(1).max(200).optional().default(50),
  })
  .strict();

export type AdminProductsQueryDto = z.infer<typeof AdminProductsQuerySchema>;

export const AdminProductItemSchema = z
  .object({
    id: UuidV7Schema,
    name: z.string(),
    sku: z.string().nullable(),
    barcode: z.string().nullable(),
    unit: z.string(),
    priceTiyin: BigIntStringSchema,
    vatPercent: z.number().int(),
    currentStockMilli: BigIntStringSchema,
    minStockMilli: BigIntStringSchema,
  })
  .strict();

export type AdminProductItemDto = z.infer<typeof AdminProductItemSchema>;

export const AdminProductsResponseSchema = z
  .object({
    items: z.array(AdminProductItemSchema),
    nextCursor: z.string().nullable(),
  })
  .strict();

export type AdminProductsResponseDto = z.infer<typeof AdminProductsResponseSchema>;

export const AdminLowStockItemSchema = z
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

export type AdminLowStockItemDto = z.infer<typeof AdminLowStockItemSchema>;

export const AdminLowStockResponseSchema = z
  .object({
    items: z.array(AdminLowStockItemSchema),
  })
  .strict();

export type AdminLowStockResponseDto = z.infer<typeof AdminLowStockResponseSchema>;

// 5. Conflicts
export const AdminConflictItemSchema = z
  .object({
    eventId: UuidV7Schema,
    storeId: UuidV7Schema,
    deviceId: UuidV7Schema,
    type: z.string(),
    entity: z.string(),
    entityId: UuidV7Schema,
    reason: z.string(),
    attempts: z.number().int(),
    parkedAtMs: BigIntStringSchema,
  })
  .strict();

export type AdminConflictItemDto = z.infer<typeof AdminConflictItemSchema>;

export const AdminConflictsResponseSchema = z
  .object({
    items: z.array(AdminConflictItemSchema),
  })
  .strict();

export type AdminConflictsResponseDto = z.infer<typeof AdminConflictsResponseSchema>;
