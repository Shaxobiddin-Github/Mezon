import { BigIntStringSchema, UuidV7Schema } from './auth.js';
import { z } from 'zod';

export const MoneyPayloadSchema = z.union([
  z.string().regex(/^-?\d+$/, 'Must be a valid integer string representation of Money (tiyin)'),
  z.bigint(),
]);

export const QuantityPayloadSchema = z.union([
  z
    .string()
    .regex(/^-?\d+$/, 'Must be a valid integer string representation of Quantity (thousandths)'),
  z.bigint(),
]);

export const UnixMsPayloadSchema = z.union([
  z.string().regex(/^\d+$/, 'Must be a valid integer string representation of UnixMs'),
  z.bigint(),
  z.number().int().nonnegative(),
]);

// ============================================================================
// Core Sync Protocol Enums and Constants
// ============================================================================

export const MIN_CLIENT_VERSION = '1.0.0';
export const CURRENT_SCHEMA_VERSION = 1;
export const MAX_SYNC_BATCH_EVENTS = 100;
export const MAX_SYNC_BATCH_BYTES = 1024 * 1024; // 1 MB
export const MAX_HLC_SKEW_MS = 5 * 60 * 1000; // 5 minutes

export const SyncEntityClassSchema = z.enum(['FACT', 'ATTR', 'MONOTONE']);
export type SyncEntityClass = z.infer<typeof SyncEntityClassSchema>;

export const SyncEventStatusSchema = z.enum(['accepted', 'duplicate', 'rejected', 'retry']);
export type SyncEventStatus = z.infer<typeof SyncEventStatusSchema>;

export const SyncRejectReasonSchema = z.enum([
  'TENANT_MISMATCH',
  'STORE_MISMATCH',
  'FOREIGN_ENTITY_MISMATCH',
  'SINGLE_WRITER_VIOLATION',
  'INVALID_MONOTONE_TRANSITION',
  'SCHEMA_VERSION_UNSUPPORTED',
  'VALIDATION_ERROR',
  'UNKNOWN_ENTITY',
  'FORBIDDEN_TABLE_CLASS',
  'SQL_ERROR',
]);
export type SyncRejectReason = z.infer<typeof SyncRejectReasonSchema>;

// ============================================================================
// Sync Envelope & Wire DTOs
// ============================================================================

export const SyncEventEnvelopeSchema = z.object({
  eventId: UuidV7Schema,
  organizationId: UuidV7Schema,
  storeId: UuidV7Schema.nullable(),
  deviceId: UuidV7Schema,
  deviceSeq: BigIntStringSchema,
  hlc: z.string().length(58),
  type: z.string().min(1),
  entity: z.string().min(1),
  entityId: UuidV7Schema,
  entityClass: SyncEntityClassSchema,
  schemaVersion: z.number().int().positive(),
  payload: z.record(z.string(), z.unknown()),
});
export type SyncEventEnvelopeDto = z.infer<typeof SyncEventEnvelopeSchema>;

export const SyncPushRequestSchema = z.object({
  clientVersion: z.string().min(1),
  storeId: UuidV7Schema,
  deviceId: UuidV7Schema,
  events: z.array(SyncEventEnvelopeSchema).max(MAX_SYNC_BATCH_EVENTS),
});
export type SyncPushRequestDto = z.infer<typeof SyncPushRequestSchema>;

export const SyncEventResultSchema = z.object({
  eventId: UuidV7Schema,
  status: SyncEventStatusSchema,
  position: BigIntStringSchema.nullable().optional(),
  reason: z.string().nullable().optional(),
  error: z.string().nullable().optional(),
});
export type SyncEventResultDto = z.infer<typeof SyncEventResultSchema>;

export const SyncPushResponseSchema = z.object({
  results: z.array(SyncEventResultSchema),
});
export type SyncPushResponseDto = z.infer<typeof SyncPushResponseSchema>;

// ============================================================================
// P4: Strict Entity Payload Schemas (for all 36 Synced Domain Tables)
// Every schema uses .strict() to reject unapproved fields (e.g. pin_hash)
// ============================================================================

export const UserPayloadSchema = z
  .object({
    id: UuidV7Schema,
    organizationId: UuidV7Schema,
    username: z.string().min(2),
    fullName: z.string().min(1),
    role: z.enum(['owner', 'manager', 'cashier']),
    isActive: z.boolean(),
    deviceId: UuidV7Schema,
    hlc: z.string().length(58),
    createdAtMs: UnixMsPayloadSchema,
    updatedAtMs: UnixMsPayloadSchema,
    deletedAtMs: UnixMsPayloadSchema.nullable().optional(),
  })
  .strict();

export const CategoryPayloadSchema = z
  .object({
    id: UuidV7Schema,
    organizationId: UuidV7Schema,
    name: z.string().min(1),
    nameSearch: z.string(),
    parentId: UuidV7Schema.nullable().optional(),
    sortOrder: z.number().int(),
    deviceId: UuidV7Schema,
    hlc: z.string().length(58),
    createdAtMs: UnixMsPayloadSchema,
    updatedAtMs: UnixMsPayloadSchema,
    deletedAtMs: UnixMsPayloadSchema.nullable().optional(),
  })
  .strict();

export const ProductPayloadSchema = z
  .object({
    id: UuidV7Schema,
    organizationId: UuidV7Schema,
    categoryId: UuidV7Schema.nullable().optional(),
    sku: z.string().nullable().optional(),
    skuSearch: z.string().nullable().optional(),
    name: z.string().min(1),
    nameSearch: z.string(),
    unit: z.string().min(1),
    unlimited: z.boolean(),
    minStock: BigIntStringSchema.nullable().optional(),
    hasVariants: z.boolean(),
    trackBatches: z.boolean(),
    salePrice: MoneyPayloadSchema,
    mxik: z.string().nullable().optional(),
    packageCode: z.string().nullable().optional(),
    vatRateBp: z.number().int().min(0).max(10000),
    deviceId: UuidV7Schema,
    hlc: z.string().length(58),
    createdAtMs: UnixMsPayloadSchema,
    updatedAtMs: UnixMsPayloadSchema,
    deletedAtMs: UnixMsPayloadSchema.nullable().optional(),
  })
  .strict();

export const ProductVariantPayloadSchema = z
  .object({
    id: UuidV7Schema,
    organizationId: UuidV7Schema,
    productId: UuidV7Schema,
    variantName: z.string().min(1),
    sku: z.string().nullable().optional(),
    barcode: z.string().nullable().optional(),
    price: MoneyPayloadSchema.nullable().optional(),
    costPrice: MoneyPayloadSchema.nullable().optional(),
    deviceId: UuidV7Schema,
    hlc: z.string().length(58),
    createdAtMs: UnixMsPayloadSchema,
    updatedAtMs: UnixMsPayloadSchema,
    deletedAtMs: UnixMsPayloadSchema.nullable().optional(),
  })
  .strict();

export const ProductBarcodePayloadSchema = z
  .object({
    id: UuidV7Schema,
    organizationId: UuidV7Schema,
    productId: UuidV7Schema,
    variantId: UuidV7Schema.nullable().optional(),
    barcode: z.string().min(1),
    deviceId: UuidV7Schema,
    hlc: z.string().length(58),
    createdAtMs: UnixMsPayloadSchema,
    updatedAtMs: UnixMsPayloadSchema,
    deletedAtMs: UnixMsPayloadSchema.nullable().optional(),
  })
  .strict();

export const PriceChangePayloadSchema = z
  .object({
    id: UuidV7Schema,
    organizationId: UuidV7Schema,
    productId: UuidV7Schema,
    variantId: UuidV7Schema.nullable().optional(),
    oldPrice: MoneyPayloadSchema,
    newPrice: MoneyPayloadSchema,
    reason: z.string().min(1),
    changedByUserId: UuidV7Schema,
    deviceId: UuidV7Schema,
    hlc: z.string().length(58),
    createdAtMs: UnixMsPayloadSchema,
  })
  .strict();

export const BatchPayloadSchema = z
  .object({
    id: UuidV7Schema,
    organizationId: UuidV7Schema,
    storeId: UuidV7Schema,
    productId: UuidV7Schema,
    variantId: UuidV7Schema.nullable().optional(),
    batchCode: z.string().min(1),
    costPrice: MoneyPayloadSchema,
    sellingPrice: MoneyPayloadSchema.nullable().optional(),
    expiryDate: z.string().nullable().optional(),
    receivedAtMs: UnixMsPayloadSchema,
    initialQuantity: QuantityPayloadSchema,
    deviceId: UuidV7Schema,
    hlc: z.string().length(58),
    createdAtMs: UnixMsPayloadSchema,
  })
  .strict();

export const StockMovePayloadSchema = z
  .object({
    id: UuidV7Schema,
    organizationId: UuidV7Schema,
    storeId: UuidV7Schema,
    productId: UuidV7Schema,
    variantId: UuidV7Schema.nullable().optional(),
    batchId: UuidV7Schema.nullable().optional(),
    moveType: z.string().min(1),
    quantity: QuantityPayloadSchema,
    unitCost: MoneyPayloadSchema,
    totalCost: MoneyPayloadSchema,
    referenceType: z.string().min(1),
    referenceId: UuidV7Schema.nullable().optional(),
    performedByUserId: UuidV7Schema,
    note: z.string().nullable().optional(),
    deviceId: UuidV7Schema,
    hlc: z.string().length(58),
    createdAtMs: UnixMsPayloadSchema,
  })
  .strict();

export const InventoryCountPayloadSchema = z
  .object({
    id: UuidV7Schema,
    organizationId: UuidV7Schema,
    storeId: UuidV7Schema,
    status: z.enum(['open', 'finalized', 'cancelled']),
    startedByUserId: UuidV7Schema,
    finalizedByUserId: UuidV7Schema.nullable().optional(),
    finalizedAtMs: UnixMsPayloadSchema.nullable().optional(),
    note: z.string().nullable().optional(),
    deviceId: UuidV7Schema,
    hlc: z.string().length(58),
    createdAtMs: UnixMsPayloadSchema,
    updatedAtMs: UnixMsPayloadSchema,
  })
  .strict();

export const InventoryCountLinePayloadSchema = z
  .object({
    id: UuidV7Schema,
    organizationId: UuidV7Schema,
    storeId: UuidV7Schema,
    countId: UuidV7Schema,
    productId: UuidV7Schema,
    variantId: UuidV7Schema.nullable().optional(),
    expectedQtyAtCount: QuantityPayloadSchema.nullable().optional(),
    countedQty: QuantityPayloadSchema.nullable().optional(),
    adjustmentQty: QuantityPayloadSchema.nullable().optional(),
    deviceId: UuidV7Schema,
    hlc: z.string().length(58),
    createdAtMs: UnixMsPayloadSchema,
    updatedAtMs: UnixMsPayloadSchema,
  })
  .strict();

export const PromotionPayloadSchema = z
  .object({
    id: UuidV7Schema,
    organizationId: UuidV7Schema,
    name: z.string().min(1),
    promoType: z.string().min(1),
    discountValue: BigIntStringSchema,
    validFromMs: UnixMsPayloadSchema,
    validToMs: UnixMsPayloadSchema,
    isActive: z.boolean(),
    configJson: z.string(),
    deviceId: UuidV7Schema,
    hlc: z.string().length(58),
    createdAtMs: UnixMsPayloadSchema,
    updatedAtMs: UnixMsPayloadSchema,
    deletedAtMs: UnixMsPayloadSchema.nullable().optional(),
  })
  .strict();

export const SalePayloadSchema = z
  .object({
    id: UuidV7Schema,
    organizationId: UuidV7Schema,
    storeId: UuidV7Schema,
    receiptNo: BigIntStringSchema,
    receiptCode: z.string().min(1),
    sourceCartId: UuidV7Schema.nullable().optional(),
    sourceOrderId: UuidV7Schema.nullable().optional(),
    cashierUserId: UuidV7Schema,
    completedByUserId: UuidV7Schema,
    customerId: UuidV7Schema.nullable().optional(),
    shiftId: UuidV7Schema.nullable().optional(),
    shiftCashierSessionId: UuidV7Schema.nullable().optional(),
    clientRequestId: UuidV7Schema,
    requestHash: z.string().min(6),
    subtotalGross: MoneyPayloadSchema,
    totalPromoDiscount: MoneyPayloadSchema,
    subtotalAfterPromo: MoneyPayloadSchema,
    manualDiscountMode: z.string(),
    manualDiscountValue: BigIntStringSchema,
    manualDiscountReason: z.string().nullable().optional(),
    orderDiscountAmount: MoneyPayloadSchema,
    totalAmount: MoneyPayloadSchema,
    totalCost: MoneyPayloadSchema,
    totalNetExVat: MoneyPayloadSchema,
    totalVat: MoneyPayloadSchema,
    paidAmount: MoneyPayloadSchema,
    changeAmount: MoneyPayloadSchema,
    debtAmount: MoneyPayloadSchema,
    loyaltyPointsEarned: BigIntStringSchema,
    overrideApprovedByUserId: UuidV7Schema.nullable().optional(),
    overrideApprovedAmount: MoneyPayloadSchema.nullable().optional(),
    voidedAtMs: UnixMsPayloadSchema.nullable().optional(),
    voidedByUserId: UuidV7Schema.nullable().optional(),
    voidReason: z.string().nullable().optional(),
    voidClientRequestId: UuidV7Schema.nullable().optional(),
    voidRequestHash: z.string().nullable().optional(),
    deviceId: UuidV7Schema,
    hlc: z.string().length(58),
    createdAtMs: UnixMsPayloadSchema,
    updatedAtMs: UnixMsPayloadSchema,
  })
  .strict();

export const SaleLinePayloadSchema = z
  .object({
    id: UuidV7Schema,
    organizationId: UuidV7Schema,
    storeId: UuidV7Schema,
    saleId: UuidV7Schema,
    lineNo: z.number().int(),
    productId: UuidV7Schema,
    variantId: UuidV7Schema.nullable().optional(),
    productNameSnapshot: z.string().min(1),
    variantNameSnapshot: z.string().nullable().optional(),
    skuSnapshot: z.string().nullable().optional(),
    barcodeSnapshot: z.string().nullable().optional(),
    unitSnapshot: z.string().min(1),
    quantity: QuantityPayloadSchema,
    unitPrice: MoneyPayloadSchema,
    grossAmount: MoneyPayloadSchema,
    linePromoDiscount: MoneyPayloadSchema,
    amountAfterPromo: MoneyPayloadSchema,
    appliedOrderDiscount: MoneyPayloadSchema,
    lineTotal: MoneyPayloadSchema,
    unitCostSnapshot: MoneyPayloadSchema,
    totalCost: MoneyPayloadSchema,
    vatPercentSnapshot: z.number().int().min(0).max(100),
    vatAmount: MoneyPayloadSchema,
    netAmountExVat: MoneyPayloadSchema,
    mxikCodeSnapshot: z.string().nullable().optional(),
    packageCodeSnapshot: z.string().nullable().optional(),
    deviceId: UuidV7Schema,
    hlc: z.string().length(58),
    createdAtMs: UnixMsPayloadSchema,
  })
  .strict();

export const PaymentPayloadSchema = z
  .object({
    id: UuidV7Schema,
    organizationId: UuidV7Schema,
    storeId: UuidV7Schema,
    saleId: UuidV7Schema,
    paymentMethod: z.string().min(1),
    amount: MoneyPayloadSchema,
    referenceId: z.string().nullable().optional(),
    shiftId: UuidV7Schema.nullable().optional(),
    deviceId: UuidV7Schema,
    hlc: z.string().length(58),
    createdAtMs: UnixMsPayloadSchema,
  })
  .strict();

export const CashMovePayloadSchema = z
  .object({
    id: UuidV7Schema,
    organizationId: UuidV7Schema,
    storeId: UuidV7Schema,
    shiftId: UuidV7Schema,
    cashierUserId: UuidV7Schema,
    moveType: z.enum(['cash_in', 'cash_out', 'drop']),
    amount: MoneyPayloadSchema,
    reason: z.string().min(1),
    expenseCategory: z.string().nullable().optional(),
    authorizedByUserId: UuidV7Schema.nullable().optional(),
    deviceId: UuidV7Schema,
    hlc: z.string().length(58),
    createdAtMs: UnixMsPayloadSchema,
  })
  .strict();

export const ReturnPayloadSchema = z
  .object({
    id: UuidV7Schema,
    organizationId: UuidV7Schema,
    storeId: UuidV7Schema,
    originalSaleId: UuidV7Schema,
    returnNo: BigIntStringSchema,
    returnCode: z.string().min(1),
    cashierUserId: UuidV7Schema,
    shiftId: UuidV7Schema.nullable().optional(),
    totalRefundAmount: MoneyPayloadSchema,
    totalCostReturned: MoneyPayloadSchema,
    reason: z.string().min(1),
    clientRequestId: UuidV7Schema,
    requestHash: z.string().min(6),
    deviceId: UuidV7Schema,
    hlc: z.string().length(58),
    createdAtMs: UnixMsPayloadSchema,
  })
  .strict();

export const ReturnLinePayloadSchema = z
  .object({
    id: UuidV7Schema,
    organizationId: UuidV7Schema,
    storeId: UuidV7Schema,
    returnId: UuidV7Schema,
    saleLineId: UuidV7Schema,
    productId: UuidV7Schema,
    variantId: UuidV7Schema.nullable().optional(),
    quantity: QuantityPayloadSchema,
    refundAmount: MoneyPayloadSchema,
    costReturned: MoneyPayloadSchema,
    vatAmountReturned: MoneyPayloadSchema,
    deviceId: UuidV7Schema,
    hlc: z.string().length(58),
    createdAtMs: UnixMsPayloadSchema,
  })
  .strict();

export const ReturnPaymentPayloadSchema = z
  .object({
    id: UuidV7Schema,
    organizationId: UuidV7Schema,
    storeId: UuidV7Schema,
    returnId: UuidV7Schema,
    paymentMethod: z.string().min(1),
    amount: MoneyPayloadSchema,
    deviceId: UuidV7Schema,
    hlc: z.string().length(58),
    createdAtMs: UnixMsPayloadSchema,
  })
  .strict();

export const CustomerPayloadSchema = z
  .object({
    id: UuidV7Schema,
    organizationId: UuidV7Schema,
    fullName: z.string().min(1),
    phone: z.string().nullable().optional(),
    phoneNormalized: z.string().nullable().optional(),
    phoneDigits: z.string().nullable().optional(),
    nameSearch: z.string(),
    creditLimit: MoneyPayloadSchema,
    loyaltyBalance: BigIntStringSchema,
    note: z.string().nullable().optional(),
    deviceId: UuidV7Schema,
    hlc: z.string().length(58),
    createdAtMs: UnixMsPayloadSchema,
    updatedAtMs: UnixMsPayloadSchema,
    deletedAtMs: UnixMsPayloadSchema.nullable().optional(),
  })
  .strict();

export const CustomerLedgerPayloadSchema = z
  .object({
    id: UuidV7Schema,
    organizationId: UuidV7Schema,
    storeId: UuidV7Schema,
    customerId: UuidV7Schema,
    entryType: z.string().min(1),
    amount: MoneyPayloadSchema,
    runningBalanceAfter: MoneyPayloadSchema,
    referenceType: z.string().min(1),
    referenceId: UuidV7Schema.nullable().optional(),
    performedByUserId: UuidV7Schema,
    note: z.string().nullable().optional(),
    deviceId: UuidV7Schema,
    hlc: z.string().length(58),
    createdAtMs: UnixMsPayloadSchema,
  })
  .strict();

export const SupplierPayloadSchema = z
  .object({
    id: UuidV7Schema,
    organizationId: UuidV7Schema,
    name: z.string().min(1),
    nameSearch: z.string(),
    contactPerson: z.string().nullable().optional(),
    phone: z.string().nullable().optional(),
    phoneNormalized: z.string().nullable().optional(),
    tin: z.string().nullable().optional(),
    note: z.string().nullable().optional(),
    deviceId: UuidV7Schema,
    hlc: z.string().length(58),
    createdAtMs: UnixMsPayloadSchema,
    updatedAtMs: UnixMsPayloadSchema,
    deletedAtMs: UnixMsPayloadSchema.nullable().optional(),
  })
  .strict();

export const GoodsReceivingPayloadSchema = z
  .object({
    id: UuidV7Schema,
    organizationId: UuidV7Schema,
    storeId: UuidV7Schema,
    supplierId: UuidV7Schema,
    invoiceNumber: z.string().nullable().optional(),
    invoiceDate: z.string().nullable().optional(),
    totalCost: MoneyPayloadSchema,
    status: z.string().min(1),
    receivedByUserId: UuidV7Schema,
    clientRequestId: UuidV7Schema,
    requestHash: z.string().min(6),
    deviceId: UuidV7Schema,
    hlc: z.string().length(58),
    createdAtMs: UnixMsPayloadSchema,
  })
  .strict();

export const GoodsReceivingLinePayloadSchema = z
  .object({
    id: UuidV7Schema,
    organizationId: UuidV7Schema,
    storeId: UuidV7Schema,
    receivingId: UuidV7Schema,
    productId: UuidV7Schema,
    variantId: UuidV7Schema.nullable().optional(),
    quantity: QuantityPayloadSchema,
    unitCost: MoneyPayloadSchema,
    totalCost: MoneyPayloadSchema,
    batchCode: z.string().nullable().optional(),
    expiryDate: z.string().nullable().optional(),
    deviceId: UuidV7Schema,
    hlc: z.string().length(58),
    createdAtMs: UnixMsPayloadSchema,
  })
  .strict();

export const ReceivingCostConfirmationPayloadSchema = z
  .object({
    id: UuidV7Schema,
    organizationId: UuidV7Schema,
    storeId: UuidV7Schema,
    receivingId: UuidV7Schema,
    confirmedByUserId: UuidV7Schema,
    confirmedAtMs: UnixMsPayloadSchema,
    deviceId: UuidV7Schema,
    hlc: z.string().length(58),
    createdAtMs: UnixMsPayloadSchema,
  })
  .strict();

export const SupplierReturnPayloadSchema = z
  .object({
    id: UuidV7Schema,
    organizationId: UuidV7Schema,
    storeId: UuidV7Schema,
    supplierId: UuidV7Schema,
    returnNumber: z.string().min(1),
    totalCost: MoneyPayloadSchema,
    reason: z.string().min(1),
    performedByUserId: UuidV7Schema,
    clientRequestId: UuidV7Schema,
    requestHash: z.string().min(6),
    deviceId: UuidV7Schema,
    hlc: z.string().length(58),
    createdAtMs: UnixMsPayloadSchema,
  })
  .strict();

export const SupplierReturnLinePayloadSchema = z
  .object({
    id: UuidV7Schema,
    organizationId: UuidV7Schema,
    storeId: UuidV7Schema,
    returnId: UuidV7Schema,
    productId: UuidV7Schema,
    variantId: UuidV7Schema.nullable().optional(),
    quantity: QuantityPayloadSchema,
    unitCost: MoneyPayloadSchema,
    totalCost: MoneyPayloadSchema,
    deviceId: UuidV7Schema,
    hlc: z.string().length(58),
    createdAtMs: UnixMsPayloadSchema,
  })
  .strict();

export const SupplierLedgerPayloadSchema = z
  .object({
    id: UuidV7Schema,
    organizationId: UuidV7Schema,
    storeId: UuidV7Schema,
    supplierId: UuidV7Schema,
    entryType: z.string().min(1),
    amount: MoneyPayloadSchema,
    runningBalanceAfter: MoneyPayloadSchema,
    referenceType: z.string().min(1),
    referenceId: UuidV7Schema.nullable().optional(),
    performedByUserId: UuidV7Schema,
    note: z.string().nullable().optional(),
    deviceId: UuidV7Schema,
    hlc: z.string().length(58),
    createdAtMs: UnixMsPayloadSchema,
  })
  .strict();

export const ShiftPayloadSchema = z
  .object({
    id: UuidV7Schema,
    organizationId: UuidV7Schema,
    storeId: UuidV7Schema,
    shiftNo: BigIntStringSchema,
    shiftCode: z.string().min(1),
    status: z.enum(['open', 'closed']),
    openedByUserId: UuidV7Schema,
    closedByUserId: UuidV7Schema.nullable().optional(),
    openingCash: MoneyPayloadSchema,
    previousCloseCash: MoneyPayloadSchema.nullable().optional(),
    openingDiscrepancy: MoneyPayloadSchema,
    openingDiscrepancyReason: z.string().nullable().optional(),
    openingNote: z.string().nullable().optional(),
    closingNote: z.string().nullable().optional(),
    openedAtMs: UnixMsPayloadSchema,
    closedAtMs: UnixMsPayloadSchema.nullable().optional(),
    openClientRequestId: UuidV7Schema,
    openRequestHash: z.string().min(6),
    closeClientRequestId: UuidV7Schema.nullable().optional(),
    closeRequestHash: z.string().nullable().optional(),
    deviceId: UuidV7Schema,
    hlc: z.string().length(58),
    createdAtMs: UnixMsPayloadSchema,
    updatedAtMs: UnixMsPayloadSchema,
  })
  .strict();

export const ShiftCashierSessionPayloadSchema = z
  .object({
    id: UuidV7Schema,
    organizationId: UuidV7Schema,
    storeId: UuidV7Schema,
    shiftId: UuidV7Schema,
    sessionSeq: z.number().int(),
    cashierUserId: UuidV7Schema,
    status: z.enum(['active', 'closed']),
    openingFloat: MoneyPayloadSchema,
    expectedCash: MoneyPayloadSchema.nullable().optional(),
    countedCash: MoneyPayloadSchema.nullable().optional(),
    discrepancy: MoneyPayloadSchema.nullable().optional(),
    discrepancyReason: z.string().nullable().optional(),
    denominationsJson: z.string().nullable().optional(),
    overrideApprovedByUserId: UuidV7Schema.nullable().optional(),
    handedOffByUserId: UuidV7Schema.nullable().optional(),
    note: z.string().nullable().optional(),
    startedAtMs: UnixMsPayloadSchema,
    endedAtMs: UnixMsPayloadSchema.nullable().optional(),
    deviceId: UuidV7Schema,
    hlc: z.string().length(58),
    createdAtMs: UnixMsPayloadSchema,
    updatedAtMs: UnixMsPayloadSchema,
  })
  .strict();

export const ShiftClosurePayloadSchema = z
  .object({
    id: UuidV7Schema,
    organizationId: UuidV7Schema,
    storeId: UuidV7Schema,
    shiftId: UuidV7Schema,
    closedByUserId: UuidV7Schema,
    closedAtMs: UnixMsPayloadSchema,
    systemExpectedCash: MoneyPayloadSchema,
    actualCountedCash: MoneyPayloadSchema,
    cashDiscrepancy: MoneyPayloadSchema,
    cashDiscrepancyReason: z.string().nullable().optional(),
    denominationsJson: z.string().nullable().optional(),
    note: z.string().nullable().optional(),
    deviceId: UuidV7Schema,
    hlc: z.string().length(58),
    createdAtMs: UnixMsPayloadSchema,
  })
  .strict();

export const ShiftClosureMethodTotalPayloadSchema = z
  .object({
    id: UuidV7Schema,
    organizationId: UuidV7Schema,
    storeId: UuidV7Schema,
    closureId: UuidV7Schema,
    paymentMethod: z.string().min(1),
    totalAmount: MoneyPayloadSchema,
    transactionCount: z.number().int(),
    deviceId: UuidV7Schema,
    hlc: z.string().length(58),
    createdAtMs: UnixMsPayloadSchema,
  })
  .strict();

export const ShiftClosureCashierPayloadSchema = z
  .object({
    id: UuidV7Schema,
    organizationId: UuidV7Schema,
    storeId: UuidV7Schema,
    closureId: UuidV7Schema,
    cashierUserId: UuidV7Schema,
    totalSales: MoneyPayloadSchema,
    totalReturns: MoneyPayloadSchema,
    totalDiscounts: MoneyPayloadSchema,
    deviceId: UuidV7Schema,
    hlc: z.string().length(58),
    createdAtMs: UnixMsPayloadSchema,
  })
  .strict();

export const DayClosePayloadSchema = z
  .object({
    id: UuidV7Schema,
    organizationId: UuidV7Schema,
    storeId: UuidV7Schema,
    dayCloseNo: BigIntStringSchema,
    periodStartMs: UnixMsPayloadSchema,
    periodEndMs: UnixMsPayloadSchema,
    closedByUserId: UuidV7Schema,
    totalGrossSales: MoneyPayloadSchema,
    totalDiscounts: MoneyPayloadSchema,
    totalReturns: MoneyPayloadSchema,
    totalNetSales: MoneyPayloadSchema,
    totalVat: MoneyPayloadSchema,
    totalCost: MoneyPayloadSchema,
    zReportNumber: z.string().nullable().optional(),
    fiscalDocId: z.string().nullable().optional(),
    deviceId: UuidV7Schema,
    hlc: z.string().length(58),
    createdAtMs: UnixMsPayloadSchema,
  })
  .strict();

export const OrderPayloadSchema = z
  .object({
    id: UuidV7Schema,
    organizationId: UuidV7Schema,
    storeId: UuidV7Schema,
    originDeviceId: UuidV7Schema,
    orderNo: BigIntStringSchema,
    orderCode: z.string().min(1),
    status: z.enum(['draft', 'confirmed', 'ready', 'delivered', 'cancelled']),
    customerId: UuidV7Schema.nullable().optional(),
    customerName: z.string().min(1),
    customerPhoneNormalized: z.string().nullable().optional(),
    dueAtMs: UnixMsPayloadSchema.nullable().optional(),
    note: z.string().nullable().optional(),
    subtotalGross: MoneyPayloadSchema,
    totalPromoDiscount: MoneyPayloadSchema,
    subtotalAfterPromo: MoneyPayloadSchema,
    manualDiscountMode: z.string(),
    manualDiscountValue: BigIntStringSchema,
    manualDiscountReason: z.string().nullable().optional(),
    orderDiscountAmount: MoneyPayloadSchema,
    totalAmount: MoneyPayloadSchema,
    totalNetExVat: MoneyPayloadSchema,
    totalVat: MoneyPayloadSchema,
    overrideApprovedByUserId: UuidV7Schema.nullable().optional(),
    overrideApprovedAmount: MoneyPayloadSchema.nullable().optional(),
    createdByUserId: UuidV7Schema,
    confirmedAtMs: UnixMsPayloadSchema.nullable().optional(),
    readyAtMs: UnixMsPayloadSchema.nullable().optional(),
    deliveredAtMs: UnixMsPayloadSchema.nullable().optional(),
    deliveredSaleId: UuidV7Schema.nullable().optional(),
    cancelledAtMs: UnixMsPayloadSchema.nullable().optional(),
    cancelledByUserId: UuidV7Schema.nullable().optional(),
    cancelReason: z.string().nullable().optional(),
    createClientRequestId: UuidV7Schema,
    createRequestHash: z.string().min(6),
    deviceId: UuidV7Schema,
    hlc: z.string().length(58),
    createdAtMs: UnixMsPayloadSchema,
    updatedAtMs: UnixMsPayloadSchema,
  })
  .strict();

export const OrderLinePayloadSchema = z
  .object({
    id: UuidV7Schema,
    organizationId: UuidV7Schema,
    storeId: UuidV7Schema,
    orderId: UuidV7Schema,
    lineNo: z.number().int(),
    productId: UuidV7Schema,
    variantId: UuidV7Schema.nullable().optional(),
    productNameSnapshot: z.string().min(1),
    variantNameSnapshot: z.string().nullable().optional(),
    skuSnapshot: z.string().nullable().optional(),
    unitSnapshot: z.string().min(1),
    quantity: QuantityPayloadSchema,
    unitPrice: MoneyPayloadSchema,
    grossAmount: MoneyPayloadSchema,
    linePromoDiscount: MoneyPayloadSchema,
    amountAfterPromo: MoneyPayloadSchema,
    appliedOrderDiscount: MoneyPayloadSchema,
    lineTotal: MoneyPayloadSchema,
    vatPercentSnapshot: z.number().int().min(0).max(100),
    vatAmount: MoneyPayloadSchema,
    netAmountExVat: MoneyPayloadSchema,
    deviceId: UuidV7Schema,
    hlc: z.string().length(58),
    createdAtMs: UnixMsPayloadSchema,
  })
  .strict();

export const OrderPaymentPayloadSchema = z
  .object({
    id: UuidV7Schema,
    organizationId: UuidV7Schema,
    storeId: UuidV7Schema,
    orderId: UuidV7Schema,
    paymentMethod: z.string().min(1),
    amount: MoneyPayloadSchema,
    referenceId: z.string().nullable().optional(),
    shiftId: UuidV7Schema.nullable().optional(),
    deviceId: UuidV7Schema,
    hlc: z.string().length(58),
    createdAtMs: UnixMsPayloadSchema,
  })
  .strict();

// Map of all 36 Synced Table Payload Schemas
export const SYNC_PAYLOAD_SCHEMAS: Readonly<Record<string, z.ZodType<Record<string, unknown>>>> = {
  users: UserPayloadSchema,
  categories: CategoryPayloadSchema,
  products: ProductPayloadSchema,
  product_variants: ProductVariantPayloadSchema,
  product_barcodes: ProductBarcodePayloadSchema,
  price_changes: PriceChangePayloadSchema,
  batches: BatchPayloadSchema,
  stock_moves: StockMovePayloadSchema,
  inventory_counts: InventoryCountPayloadSchema,
  inventory_count_lines: InventoryCountLinePayloadSchema,
  promotions: PromotionPayloadSchema,
  sales: SalePayloadSchema,
  sale_lines: SaleLinePayloadSchema,
  payments: PaymentPayloadSchema,
  cash_moves: CashMovePayloadSchema,
  returns: ReturnPayloadSchema,
  return_lines: ReturnLinePayloadSchema,
  return_payments: ReturnPaymentPayloadSchema,
  customers: CustomerPayloadSchema,
  customer_ledger: CustomerLedgerPayloadSchema,
  suppliers: SupplierPayloadSchema,
  goods_receivings: GoodsReceivingPayloadSchema,
  goods_receiving_lines: GoodsReceivingLinePayloadSchema,
  receiving_cost_confirmations: ReceivingCostConfirmationPayloadSchema,
  supplier_returns: SupplierReturnPayloadSchema,
  supplier_return_lines: SupplierReturnLinePayloadSchema,
  supplier_ledger: SupplierLedgerPayloadSchema,
  shifts: ShiftPayloadSchema,
  shift_cashier_sessions: ShiftCashierSessionPayloadSchema,
  shift_closures: ShiftClosurePayloadSchema,
  shift_closure_method_totals: ShiftClosureMethodTotalPayloadSchema,
  shift_closure_cashiers: ShiftClosureCashierPayloadSchema,
  day_closes: DayClosePayloadSchema,
  orders: OrderPayloadSchema,
  order_lines: OrderLinePayloadSchema,
  order_payments: OrderPaymentPayloadSchema,
};

export function validateSyncEntityPayload(
  entity: string,
  payload: unknown,
):
  | { readonly success: true; readonly data: Record<string, unknown> }
  | { readonly success: false; readonly error: string } {
  const schema = SYNC_PAYLOAD_SCHEMAS[entity];
  if (!schema) {
    return {
      success: false,
      error: `Unknown or non-synced entity "${entity}"`,
    };
  }
  const result = schema.safeParse(payload);
  if (!result.success) {
    return {
      success: false,
      error: result.error.issues.map((e) => `${e.path.join('.')}: ${e.message}`).join('; '),
    };
  }
  return {
    success: true,
    data: result.data,
  };
}

// ============================================================================
// P3: Shared MONOTONE Transition Metadata
// ============================================================================

export type MonotoneTransitionResult = 'accepted' | 'duplicate' | 'rejected';

export interface MonotoneTransitionRule {
  readonly stateColumn: string;
  readonly isMonotone: true;
  checkTransition(
    existingRow: Record<string, unknown>,
    incomingPayload: Record<string, unknown>,
  ): MonotoneTransitionResult;
}

function toSafeString(val: unknown): string {
  if (typeof val === 'string') return val;
  if (typeof val === 'number' || typeof val === 'bigint') return String(val);
  return '';
}

export const MONOTONE_TRANSITION_RULES: Readonly<Record<string, MonotoneTransitionRule>> = {
  sales: {
    stateColumn: 'voided_at_ms',
    isMonotone: true,
    checkTransition(existing, incoming) {
      const existingVoid = existing.voided_at_ms ?? existing.voidedAtMs;
      const incomingVoid = incoming.voided_at_ms ?? incoming.voidedAtMs;

      // If already voided:
      if (existingVoid !== null && existingVoid !== undefined) {
        // Idempotent re-void with same void timestamp/reason -> duplicate
        if (
          incomingVoid !== null &&
          incomingVoid !== undefined &&
          toSafeString(existingVoid) === toSafeString(incomingVoid)
        ) {
          return 'duplicate';
        }
        // Cannot modify or re-void with different data
        return 'rejected';
      }

      // Transition from null -> not null is accepted
      if (incomingVoid !== null && incomingVoid !== undefined) {
        return 'accepted';
      }

      return 'rejected';
    },
  },
  orders: {
    stateColumn: 'status',
    isMonotone: true,
    checkTransition(existing, incoming) {
      const currentStatus = toSafeString(existing.status);
      const newStatus = toSafeString(incoming.status);

      if (currentStatus === newStatus) {
        return 'duplicate';
      }

      const allowedTransitions: Record<string, readonly string[]> = {
        draft: ['confirmed', 'cancelled'],
        confirmed: ['ready', 'delivered', 'cancelled'],
        ready: ['delivered', 'cancelled'],
        delivered: [], // terminal
        cancelled: [], // terminal
      };

      const validNext = allowedTransitions[currentStatus];
      if (validNext && validNext.includes(newStatus)) {
        return 'accepted';
      }
      return 'rejected';
    },
  },
  shifts: {
    stateColumn: 'status',
    isMonotone: true,
    checkTransition(existing, incoming) {
      const currentStatus = toSafeString(existing.status);
      const newStatus = toSafeString(incoming.status);

      if (currentStatus === newStatus) {
        return 'duplicate';
      }

      if (currentStatus === 'open' && newStatus === 'closed') {
        return 'accepted';
      }

      return 'rejected';
    },
  },
  shift_cashier_sessions: {
    stateColumn: 'status',
    isMonotone: true,
    checkTransition(existing, incoming) {
      const currentStatus = toSafeString(existing.status);
      const newStatus = toSafeString(incoming.status);

      if (currentStatus === newStatus) {
        return 'duplicate';
      }

      if (currentStatus === 'active' && newStatus === 'closed') {
        return 'accepted';
      }

      return 'rejected';
    },
  },
  inventory_counts: {
    stateColumn: 'status',
    isMonotone: true,
    checkTransition(existing, incoming) {
      const currentStatus = toSafeString(existing.status);
      const newStatus = toSafeString(incoming.status);

      if (currentStatus === newStatus) {
        return 'duplicate';
      }

      if (currentStatus === 'open' && (newStatus === 'finalized' || newStatus === 'cancelled')) {
        return 'accepted';
      }

      return 'rejected';
    },
  },
  inventory_count_lines: {
    stateColumn: 'expected_qty_at_count',
    isMonotone: true,
    checkTransition(existing, incoming) {
      // Lines cannot be moved to a different count
      const existingCountId = existing.count_id ?? existing.countId;
      const incomingCountId = incoming.count_id ?? incoming.countId;
      if (existingCountId && incomingCountId && existingCountId !== incomingCountId) {
        return 'rejected';
      }
      return 'accepted';
    },
  },
};

// ============================================================================
// Foreign Key Reference Metadata (for P2 dependency parking & tenant isolation)
// ============================================================================

export interface ForeignKeyRef {
  readonly payloadKey: string;
  readonly targetEntity: string;
}

export const SYNC_FOREIGN_REFERENCES: Readonly<Record<string, readonly ForeignKeyRef[]>> = {
  categories: [{ payloadKey: 'parentId', targetEntity: 'categories' }],
  products: [{ payloadKey: 'categoryId', targetEntity: 'categories' }],
  product_variants: [{ payloadKey: 'productId', targetEntity: 'products' }],
  product_barcodes: [
    { payloadKey: 'productId', targetEntity: 'products' },
    { payloadKey: 'variantId', targetEntity: 'product_variants' },
  ],
  price_changes: [
    { payloadKey: 'productId', targetEntity: 'products' },
    { payloadKey: 'variantId', targetEntity: 'product_variants' },
    { payloadKey: 'changedByUserId', targetEntity: 'users' },
  ],
  batches: [
    { payloadKey: 'productId', targetEntity: 'products' },
    { payloadKey: 'variantId', targetEntity: 'product_variants' },
  ],
  stock_moves: [
    { payloadKey: 'productId', targetEntity: 'products' },
    { payloadKey: 'variantId', targetEntity: 'product_variants' },
    { payloadKey: 'batchId', targetEntity: 'batches' },
    { payloadKey: 'performedByUserId', targetEntity: 'users' },
  ],
  inventory_counts: [{ payloadKey: 'startedByUserId', targetEntity: 'users' }],
  inventory_count_lines: [
    { payloadKey: 'countId', targetEntity: 'inventory_counts' },
    { payloadKey: 'productId', targetEntity: 'products' },
    { payloadKey: 'variantId', targetEntity: 'product_variants' },
  ],
  sales: [
    { payloadKey: 'cashierUserId', targetEntity: 'users' },
    { payloadKey: 'completedByUserId', targetEntity: 'users' },
    { payloadKey: 'customerId', targetEntity: 'customers' },
    { payloadKey: 'shiftId', targetEntity: 'shifts' },
  ],
  sale_lines: [
    { payloadKey: 'saleId', targetEntity: 'sales' },
    { payloadKey: 'productId', targetEntity: 'products' },
    { payloadKey: 'variantId', targetEntity: 'product_variants' },
  ],
  payments: [
    { payloadKey: 'saleId', targetEntity: 'sales' },
    { payloadKey: 'shiftId', targetEntity: 'shifts' },
  ],
  cash_moves: [
    { payloadKey: 'shiftId', targetEntity: 'shifts' },
    { payloadKey: 'cashierUserId', targetEntity: 'users' },
  ],
  returns: [
    { payloadKey: 'originalSaleId', targetEntity: 'sales' },
    { payloadKey: 'cashierUserId', targetEntity: 'users' },
    { payloadKey: 'shiftId', targetEntity: 'shifts' },
  ],
  return_lines: [
    { payloadKey: 'returnId', targetEntity: 'returns' },
    { payloadKey: 'saleLineId', targetEntity: 'sale_lines' },
    { payloadKey: 'productId', targetEntity: 'products' },
    { payloadKey: 'variantId', targetEntity: 'product_variants' },
  ],
  return_payments: [{ payloadKey: 'returnId', targetEntity: 'returns' }],
  customer_ledger: [
    { payloadKey: 'customerId', targetEntity: 'customers' },
    { payloadKey: 'performedByUserId', targetEntity: 'users' },
  ],
  goods_receivings: [
    { payloadKey: 'supplierId', targetEntity: 'suppliers' },
    { payloadKey: 'receivedByUserId', targetEntity: 'users' },
  ],
  goods_receiving_lines: [
    { payloadKey: 'receivingId', targetEntity: 'goods_receivings' },
    { payloadKey: 'productId', targetEntity: 'products' },
    { payloadKey: 'variantId', targetEntity: 'product_variants' },
  ],
  receiving_cost_confirmations: [
    { payloadKey: 'receivingId', targetEntity: 'goods_receivings' },
    { payloadKey: 'confirmedByUserId', targetEntity: 'users' },
  ],
  supplier_returns: [
    { payloadKey: 'supplierId', targetEntity: 'suppliers' },
    { payloadKey: 'performedByUserId', targetEntity: 'users' },
  ],
  supplier_return_lines: [
    { payloadKey: 'returnId', targetEntity: 'supplier_returns' },
    { payloadKey: 'productId', targetEntity: 'products' },
    { payloadKey: 'variantId', targetEntity: 'product_variants' },
  ],
  supplier_ledger: [
    { payloadKey: 'supplierId', targetEntity: 'suppliers' },
    { payloadKey: 'performedByUserId', targetEntity: 'users' },
  ],
  shift_cashier_sessions: [
    { payloadKey: 'shiftId', targetEntity: 'shifts' },
    { payloadKey: 'cashierUserId', targetEntity: 'users' },
  ],
  shift_closures: [
    { payloadKey: 'shiftId', targetEntity: 'shifts' },
    { payloadKey: 'closedByUserId', targetEntity: 'users' },
  ],
  shift_closure_method_totals: [{ payloadKey: 'closureId', targetEntity: 'shift_closures' }],
  shift_closure_cashiers: [
    { payloadKey: 'closureId', targetEntity: 'shift_closures' },
    { payloadKey: 'cashierUserId', targetEntity: 'users' },
  ],
  orders: [
    { payloadKey: 'customerId', targetEntity: 'customers' },
    { payloadKey: 'createdByUserId', targetEntity: 'users' },
  ],
  order_lines: [
    { payloadKey: 'orderId', targetEntity: 'orders' },
    { payloadKey: 'productId', targetEntity: 'products' },
    { payloadKey: 'variantId', targetEntity: 'product_variants' },
  ],
  order_payments: [
    { payloadKey: 'orderId', targetEntity: 'orders' },
    { payloadKey: 'shiftId', targetEntity: 'shifts' },
  ],
};
