import {
  FISCAL_DOC_BOOKKEEPING_STATES,
  FISCAL_DOC_KINDS,
  FISCAL_DOC_STATUSES,
  isFiscalDocStatus,
  isFiscalDocTransitionAllowed,
} from '@mezon/domain';
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
// Sync Pull Request / Response Schemas (T2.4)
// ============================================================================

export const SyncPullQuerySchema = z.object({
  cursors: z.string().optional(),
  limit: z.coerce.number().int().positive().max(500).default(100),
});
export type SyncPullQueryDto = z.infer<typeof SyncPullQuerySchema>;

export function parseAndValidateSyncCursors(
  cursorsStr?: string,
): { success: true; cursors: Record<string, bigint> } | { success: false; error: string } {
  if (!cursorsStr || cursorsStr.trim() === '') {
    return { success: true, cursors: {} };
  }
  const pairs = cursorsStr.split(',');
  const result: Record<string, bigint> = {};
  for (const pair of pairs) {
    const trimmed = pair.trim();
    if (!trimmed) continue;
    const parts = trimmed.split(':');
    if (parts.length !== 2) {
      return {
        success: false,
        error: `Invalid cursor format "${trimmed}". Expected "uuid:position"`,
      };
    }
    const [storeId, posStr] = parts;
    const parsedStoreId = UuidV7Schema.safeParse(storeId);
    if (!parsedStoreId.success) {
      return {
        success: false,
        error: `Invalid store UUID "${storeId}" in cursors`,
      };
    }
    if (!/^\d+$/.test(posStr)) {
      return {
        success: false,
        error: `Invalid numeric position "${posStr}" in cursors`,
      };
    }
    result[parsedStoreId.data] = BigInt(posStr);
  }
  return { success: true, cursors: result };
}

export const SyncedEventSchema = z.object({
  eventId: UuidV7Schema,
  organizationId: UuidV7Schema,
  storeId: UuidV7Schema,
  deviceId: UuidV7Schema,
  deviceSeq: BigIntStringSchema,
  hlc: z.string().length(58),
  type: z.string().min(1),
  entity: z.string().min(1),
  entityId: UuidV7Schema,
  entityClass: SyncEntityClassSchema,
  schemaVersion: z.number().int().positive(),
  payload: z.record(z.string(), z.unknown()),
  position: BigIntStringSchema,
  hlcAdjusted: z.boolean().default(false),
  receivedAtMs: UnixMsPayloadSchema,
});
export type SyncedEventDto = z.infer<typeof SyncedEventSchema>;

export const SyncPullResponseSchema = z.object({
  events: z.array(SyncedEventSchema),
  nextCursors: z.record(z.string(), BigIntStringSchema),
  hasMore: z.boolean(),
});
export type SyncPullResponseDto = z.infer<typeof SyncPullResponseSchema>;

// ============================================================================
// P4: Strict Entity Payload Schemas (for all 36 Synced Domain Tables)
// Every schema uses .strict() to reject unapproved fields
// ============================================================================

export const UsersPayloadSchema = z
  .object({
    id: UuidV7Schema,
    organizationId: UuidV7Schema,
    deviceId: UuidV7Schema,
    hlc: z.string().length(58),
    createdAtMs: UnixMsPayloadSchema,
    updatedAtMs: UnixMsPayloadSchema,
    deletedAtMs: UnixMsPayloadSchema.nullable().optional(),
    username: z.string(),
    fullName: z.string(),
    role: z.string(),
    isActive: z.boolean(),
  })
  .strict();

export const CategoriesPayloadSchema = z
  .object({
    id: UuidV7Schema,
    organizationId: UuidV7Schema,
    deviceId: UuidV7Schema,
    hlc: z.string().length(58),
    createdAtMs: UnixMsPayloadSchema,
    updatedAtMs: UnixMsPayloadSchema,
    deletedAtMs: UnixMsPayloadSchema.nullable().optional(),
    name: z.string(),
    nameSearch: z.string(),
    parentId: UuidV7Schema.nullable().optional(),
    sortOrder: z.number().int(),
  })
  .strict();

export const ProductsPayloadSchema = z
  .object({
    id: UuidV7Schema,
    organizationId: UuidV7Schema,
    deviceId: UuidV7Schema,
    hlc: z.string().length(58),
    createdAtMs: UnixMsPayloadSchema,
    updatedAtMs: UnixMsPayloadSchema,
    deletedAtMs: UnixMsPayloadSchema.nullable().optional(),
    categoryId: UuidV7Schema.nullable().optional(),
    sku: z.string().nullable().optional(),
    skuSearch: z.string().nullable().optional(),
    name: z.string(),
    nameSearch: z.string(),
    unit: z.string(),
    unlimited: z.boolean(),
    minStock: QuantityPayloadSchema.nullable().optional(),
    hasVariants: z.boolean(),
    trackBatches: z.boolean(),
    salePrice: MoneyPayloadSchema,
    mxik: z.string().nullable().optional(),
    packageCode: z.string().nullable().optional(),
    vatRateBp: z.number().int(),
  })
  .strict();

export const ProductVariantsPayloadSchema = z
  .object({
    id: UuidV7Schema,
    organizationId: UuidV7Schema,
    deviceId: UuidV7Schema,
    hlc: z.string().length(58),
    createdAtMs: UnixMsPayloadSchema,
    updatedAtMs: UnixMsPayloadSchema,
    deletedAtMs: UnixMsPayloadSchema.nullable().optional(),
    productId: UuidV7Schema,
    name: z.string(),
    nameSearch: z.string(),
    sku: z.string().nullable().optional(),
    skuSearch: z.string().nullable().optional(),
    attributesJson: z.string(),
    salePrice: MoneyPayloadSchema.nullable().optional(),
  })
  .strict();

export const ProductBarcodesPayloadSchema = z
  .object({
    id: UuidV7Schema,
    organizationId: UuidV7Schema,
    deviceId: UuidV7Schema,
    hlc: z.string().length(58),
    createdAtMs: UnixMsPayloadSchema,
    updatedAtMs: UnixMsPayloadSchema,
    deletedAtMs: UnixMsPayloadSchema.nullable().optional(),
    productId: UuidV7Schema,
    variantId: UuidV7Schema.nullable().optional(),
    barcode: z.string(),
    format: z.string(),
  })
  .strict();

/** C21 product photos (ATTR, base64 body). */
export const ProductImagesPayloadSchema = z
  .object({
    id: UuidV7Schema,
    organizationId: UuidV7Schema,
    deviceId: UuidV7Schema,
    hlc: z.string().length(58),
    createdAtMs: UnixMsPayloadSchema,
    updatedAtMs: UnixMsPayloadSchema,
    deletedAtMs: UnixMsPayloadSchema.nullable().optional(),
    productId: UuidV7Schema,
    mime: z.enum(['image/jpeg', 'image/webp', 'image/png']),
    dataBase64: z.string().min(4).max(220_000),
    byteSize: z.number().int().min(1).max(160_000),
  })
  .strict();

/** C20 wholesale price tiers (ATTR). */
export const ProductPriceTiersPayloadSchema = z
  .object({
    id: UuidV7Schema,
    organizationId: UuidV7Schema,
    deviceId: UuidV7Schema,
    hlc: z.string().length(58),
    createdAtMs: UnixMsPayloadSchema,
    updatedAtMs: UnixMsPayloadSchema,
    deletedAtMs: UnixMsPayloadSchema.nullable().optional(),
    productId: UuidV7Schema,
    minQty: QuantityPayloadSchema,
    unitPrice: MoneyPayloadSchema,
  })
  .strict();

export const PriceChangesPayloadSchema = z
  .object({
    id: UuidV7Schema,
    organizationId: UuidV7Schema,
    deviceId: UuidV7Schema,
    hlc: z.string().length(58),
    createdAtMs: UnixMsPayloadSchema,
    productId: UuidV7Schema,
    variantId: UuidV7Schema.nullable().optional(),
    oldPrice: MoneyPayloadSchema.nullable().optional(),
    newPrice: MoneyPayloadSchema,
    changedByUserId: UuidV7Schema,
    reason: z.string().nullable().optional(),
  })
  .strict();

export const BatchesPayloadSchema = z
  .object({
    id: UuidV7Schema,
    organizationId: UuidV7Schema,
    storeId: UuidV7Schema,
    deviceId: UuidV7Schema,
    hlc: z.string().length(58),
    createdAtMs: UnixMsPayloadSchema,
    productId: UuidV7Schema,
    variantId: UuidV7Schema.nullable().optional(),
    batchNumber: z.string().nullable().optional(),
    expiryDateMs: UnixMsPayloadSchema.nullable().optional(),
    initialQty: QuantityPayloadSchema,
    initialCostValue: MoneyPayloadSchema,
    supplierId: UuidV7Schema.nullable().optional(),
  })
  .strict();

export const StockMovesPayloadSchema = z
  .object({
    id: UuidV7Schema,
    organizationId: UuidV7Schema,
    storeId: UuidV7Schema,
    deviceId: UuidV7Schema,
    hlc: z.string().length(58),
    createdAtMs: UnixMsPayloadSchema,
    productId: UuidV7Schema,
    variantId: UuidV7Schema.nullable().optional(),
    batchId: UuidV7Schema.nullable().optional(),
    qtyDelta: QuantityPayloadSchema,
    costValueDelta: MoneyPayloadSchema,
    reason: z.string(),
    sourceType: z.string(),
    sourceId: UuidV7Schema,
    createdByUserId: UuidV7Schema,
    note: z.string().nullable().optional(),
  })
  .strict();

export const InventoryCountsPayloadSchema = z
  .object({
    id: UuidV7Schema,
    organizationId: UuidV7Schema,
    storeId: UuidV7Schema,
    deviceId: UuidV7Schema,
    hlc: z.string().length(58),
    createdAtMs: UnixMsPayloadSchema,
    updatedAtMs: UnixMsPayloadSchema,
    status: z.string(),
    startedByUserId: UuidV7Schema,
    finalizedByUserId: UuidV7Schema.nullable().optional(),
    finalizedAtMs: UnixMsPayloadSchema.nullable().optional(),
    note: z.string().nullable().optional(),
  })
  .strict();

export const InventoryCountLinesPayloadSchema = z
  .object({
    id: UuidV7Schema,
    organizationId: UuidV7Schema,
    storeId: UuidV7Schema,
    deviceId: UuidV7Schema,
    hlc: z.string().length(58),
    createdAtMs: UnixMsPayloadSchema,
    updatedAtMs: UnixMsPayloadSchema,
    countId: UuidV7Schema,
    productId: UuidV7Schema,
    variantId: UuidV7Schema.nullable().optional(),
    expectedQtyAtCount: QuantityPayloadSchema.nullable().optional(),
    countedQty: QuantityPayloadSchema.nullable().optional(),
    adjustmentQty: QuantityPayloadSchema.nullable().optional(),
  })
  .strict();

export const PromotionsPayloadSchema = z
  .object({
    id: UuidV7Schema,
    organizationId: UuidV7Schema,
    deviceId: UuidV7Schema,
    hlc: z.string().length(58),
    createdAtMs: UnixMsPayloadSchema,
    updatedAtMs: UnixMsPayloadSchema,
    deletedAtMs: UnixMsPayloadSchema.nullable().optional(),
    targetStoreId: UuidV7Schema.nullable().optional(),
    name: z.string(),
    type: z.string(),
    scope: z.string(),
    targetProductId: UuidV7Schema.nullable().optional(),
    targetCategoryId: UuidV7Schema.nullable().optional(),
    discountPercentBp: z.number().int().nullable().optional(),
    discountAmount: QuantityPayloadSchema.nullable().optional(),
    buyQty: z.number().int().nullable().optional(),
    freeQty: z.number().int().nullable().optional(),
    startsAtMs: UnixMsPayloadSchema,
    endsAtMs: UnixMsPayloadSchema.nullable().optional(),
    isActive: z.boolean(),
  })
  .strict();

export const SalesPayloadSchema = z
  .object({
    id: UuidV7Schema,
    organizationId: UuidV7Schema,
    storeId: UuidV7Schema,
    deviceId: UuidV7Schema,
    hlc: z.string().length(58),
    createdAtMs: UnixMsPayloadSchema,
    updatedAtMs: UnixMsPayloadSchema,
    receiptNo: MoneyPayloadSchema,
    receiptCode: z.string(),
    sourceCartId: UuidV7Schema.nullable().optional(),
    sourceOrderId: UuidV7Schema.nullable().optional(),
    cashierUserId: UuidV7Schema,
    completedByUserId: UuidV7Schema,
    customerId: UuidV7Schema.nullable().optional(),
    shiftId: UuidV7Schema.nullable().optional(),
    shiftCashierSessionId: UuidV7Schema.nullable().optional(),
    clientRequestId: UuidV7Schema,
    requestHash: z.string(),
    subtotalGross: MoneyPayloadSchema,
    totalPromoDiscount: QuantityPayloadSchema,
    subtotalAfterPromo: MoneyPayloadSchema,
    manualDiscountMode: z.string(),
    manualDiscountValue: QuantityPayloadSchema,
    manualDiscountReason: z.string().nullable().optional(),
    orderDiscountAmount: QuantityPayloadSchema,
    totalFinal: MoneyPayloadSchema,
    totalNetExVat: MoneyPayloadSchema,
    totalVat: MoneyPayloadSchema,
    totalPaid: MoneyPayloadSchema,
    debtAmount: MoneyPayloadSchema,
    changeAmount: MoneyPayloadSchema,
    overrideApprovedByUserId: UuidV7Schema.nullable().optional(),
    overrideApprovedAmount: MoneyPayloadSchema.nullable().optional(),
    overrideApprovedAtMs: UnixMsPayloadSchema.nullable().optional(),
    voidedAtMs: UnixMsPayloadSchema.nullable().optional(),
    voidedByUserId: UuidV7Schema.nullable().optional(),
    voidReason: z.string().nullable().optional(),
    voidClientRequestId: UuidV7Schema.nullable().optional(),
    voidRequestHash: z.string().nullable().optional(),
  })
  .strict();

export const SaleLinesPayloadSchema = z
  .object({
    id: UuidV7Schema,
    organizationId: UuidV7Schema,
    storeId: UuidV7Schema,
    deviceId: UuidV7Schema,
    hlc: z.string().length(58),
    createdAtMs: UnixMsPayloadSchema,
    saleId: UuidV7Schema,
    sortOrder: z.number().int(),
    lineKind: z.string(),
    productId: UuidV7Schema.nullable().optional(),
    variantId: UuidV7Schema.nullable().optional(),
    categoryIdSnapshot: UuidV7Schema.nullable().optional(),
    itemName: z.string(),
    unit: z.string(),
    qty: QuantityPayloadSchema,
    unitPriceSnapshot: MoneyPayloadSchema,
    appliedPromotionId: UuidV7Schema.nullable().optional(),
    appliedPromotionName: z.string().nullable().optional(),
    freeUnits: QuantityPayloadSchema,
    grossTotal: MoneyPayloadSchema,
    promoDiscount: QuantityPayloadSchema,
    subtotalAfterPromo: MoneyPayloadSchema,
    allocatedOrderDiscount: QuantityPayloadSchema,
    finalTotal: MoneyPayloadSchema,
    vatRateBpSnapshot: z.number().int(),
    netExVat: MoneyPayloadSchema,
    vatTotal: MoneyPayloadSchema,
    mxikSnapshot: z.string().nullable().optional(),
    packageCodeSnapshot: z.string().nullable().optional(),
    costValue: MoneyPayloadSchema,
  })
  .strict();

export const PaymentsPayloadSchema = z
  .object({
    id: UuidV7Schema,
    organizationId: UuidV7Schema,
    storeId: UuidV7Schema,
    deviceId: UuidV7Schema,
    hlc: z.string().length(58),
    createdAtMs: UnixMsPayloadSchema,
    saleId: UuidV7Schema,
    method: z.string(),
    amount: MoneyPayloadSchema,
    tenderedAmount: MoneyPayloadSchema.nullable().optional(),
    changeAmount: MoneyPayloadSchema,
    providerRef: z.string().nullable().optional(),
    providerMetaJson: z.string().nullable().optional(),
  })
  .strict();

export const CashMovesPayloadSchema = z
  .object({
    id: UuidV7Schema,
    organizationId: UuidV7Schema,
    storeId: UuidV7Schema,
    deviceId: UuidV7Schema,
    hlc: z.string().length(58),
    createdAtMs: UnixMsPayloadSchema,
    shiftId: UuidV7Schema.nullable().optional(),
    shiftCashierSessionId: UuidV7Schema.nullable().optional(),
    registerId: UuidV7Schema.nullable().optional(),
    type: z.string(),
    amountDelta: MoneyPayloadSchema,
    sourceType: z.string(),
    sourceId: UuidV7Schema,
    paymentId: UuidV7Schema.nullable().optional(),
    expenseCategory: z.string().nullable().optional(),
    reason: z.string().nullable().optional(),
    createdByUserId: UuidV7Schema,
  })
  .strict();

export const ReturnsPayloadSchema = z
  .object({
    id: UuidV7Schema,
    organizationId: UuidV7Schema,
    storeId: UuidV7Schema,
    deviceId: UuidV7Schema,
    hlc: z.string().length(58),
    createdAtMs: UnixMsPayloadSchema,
    saleId: UuidV7Schema,
    shiftId: UuidV7Schema.nullable().optional(),
    shiftCashierSessionId: UuidV7Schema.nullable().optional(),
    returnNo: MoneyPayloadSchema,
    returnCode: z.string(),
    processedByUserId: UuidV7Schema,
    overrideApprovedByUserId: UuidV7Schema.nullable().optional(),
    overrideApprovedAtMs: UnixMsPayloadSchema.nullable().optional(),
    reason: z.string(),
    clientRequestId: UuidV7Schema,
    requestHash: z.string(),
    totalRefund: MoneyPayloadSchema,
    totalNetExVat: MoneyPayloadSchema,
    totalVat: MoneyPayloadSchema,
    cashRefundAmount: MoneyPayloadSchema,
    nonCashRefundAmount: MoneyPayloadSchema,
    debtOffsetAmount: MoneyPayloadSchema,
  })
  .strict();

export const ReturnLinesPayloadSchema = z
  .object({
    id: UuidV7Schema,
    organizationId: UuidV7Schema,
    storeId: UuidV7Schema,
    deviceId: UuidV7Schema,
    hlc: z.string().length(58),
    createdAtMs: UnixMsPayloadSchema,
    returnId: UuidV7Schema,
    saleId: UuidV7Schema,
    saleLineId: UuidV7Schema,
    sortOrder: z.number().int(),
    lineKind: z.string(),
    productId: UuidV7Schema.nullable().optional(),
    variantId: UuidV7Schema.nullable().optional(),
    itemName: z.string(),
    unit: z.string(),
    qty: QuantityPayloadSchema,
    unitPriceSnapshot: MoneyPayloadSchema,
    vatRateBpSnapshot: z.number().int(),
    mxikSnapshot: z.string().nullable().optional(),
    packageCodeSnapshot: z.string().nullable().optional(),
    refundAmount: MoneyPayloadSchema,
    netExVat: MoneyPayloadSchema,
    vatTotal: MoneyPayloadSchema,
    costValue: MoneyPayloadSchema,
  })
  .strict();

export const ReturnPaymentsPayloadSchema = z
  .object({
    id: UuidV7Schema,
    organizationId: UuidV7Schema,
    storeId: UuidV7Schema,
    deviceId: UuidV7Schema,
    hlc: z.string().length(58),
    createdAtMs: UnixMsPayloadSchema,
    returnId: UuidV7Schema,
    saleId: UuidV7Schema,
    method: z.string(),
    amount: MoneyPayloadSchema,
    providerRef: z.string().nullable().optional(),
  })
  .strict();

export const CustomersPayloadSchema = z
  .object({
    id: UuidV7Schema,
    organizationId: UuidV7Schema,
    deviceId: UuidV7Schema,
    hlc: z.string().length(58),
    createdAtMs: UnixMsPayloadSchema,
    updatedAtMs: UnixMsPayloadSchema,
    deletedAtMs: UnixMsPayloadSchema.nullable().optional(),
    fullName: z.string(),
    nameSearch: z.string(),
    phoneNormalized: z.string().nullable().optional(),
    phoneDigits: z.string().nullable().optional(),
    creditLimit: MoneyPayloadSchema.nullable().optional(),
    defaultDueDays: z.number().int().nullable().optional(),
    note: z.string().nullable().optional(),
    isActive: z.boolean(),
  })
  .strict();

export const CustomerLedgerPayloadSchema = z
  .object({
    id: UuidV7Schema,
    organizationId: UuidV7Schema,
    storeId: UuidV7Schema,
    deviceId: UuidV7Schema,
    hlc: z.string().length(58),
    createdAtMs: UnixMsPayloadSchema,
    customerId: UuidV7Schema,
    entryType: z.string(),
    amountDelta: MoneyPayloadSchema,
    sourceType: z.string(),
    sourceId: UuidV7Schema,
    saleId: UuidV7Schema.nullable().optional(),
    paymentMethod: z.string().nullable().optional(),
    providerRef: z.string().nullable().optional(),
    cashMoveId: UuidV7Schema.nullable().optional(),
    dueAtMs: UnixMsPayloadSchema.nullable().optional(),
    reason: z.string().nullable().optional(),
    createdByUserId: UuidV7Schema,
    overrideApprovedByUserId: UuidV7Schema.nullable().optional(),
    clientRequestId: UuidV7Schema.nullable().optional(),
    requestHash: z.string().nullable().optional(),
  })
  .strict();

export const SuppliersPayloadSchema = z
  .object({
    id: UuidV7Schema,
    organizationId: UuidV7Schema,
    deviceId: UuidV7Schema,
    hlc: z.string().length(58),
    createdAtMs: UnixMsPayloadSchema,
    updatedAtMs: UnixMsPayloadSchema,
    deletedAtMs: UnixMsPayloadSchema.nullable().optional(),
    name: z.string(),
    nameSearch: z.string(),
    tin: z.string().nullable().optional(),
    phoneNormalized: z.string().nullable().optional(),
    phoneDigits: z.string().nullable().optional(),
    contactPerson: z.string().nullable().optional(),
    note: z.string().nullable().optional(),
    defaultDueDays: z.number().int().nullable().optional(),
    isActive: z.boolean(),
  })
  .strict();

export const GoodsReceivingsPayloadSchema = z
  .object({
    id: UuidV7Schema,
    organizationId: UuidV7Schema,
    storeId: UuidV7Schema,
    deviceId: UuidV7Schema,
    hlc: z.string().length(58),
    createdAtMs: UnixMsPayloadSchema,
    receivingNo: MoneyPayloadSchema,
    receivingCode: z.string(),
    supplierId: UuidV7Schema,
    supplierInvoiceNo: z.string().nullable().optional(),
    dueDays: z.number().int().nullable().optional(),
    dueAtMs: UnixMsPayloadSchema.nullable().optional(),
    knownCostTotal: MoneyPayloadSchema,
    unknownCostLineCount: z.number().int(),
    note: z.string().nullable().optional(),
    postedByUserId: UuidV7Schema,
    clientRequestId: UuidV7Schema,
    requestHash: z.string(),
  })
  .strict();

export const GoodsReceivingLinesPayloadSchema = z
  .object({
    id: UuidV7Schema,
    organizationId: UuidV7Schema,
    storeId: UuidV7Schema,
    deviceId: UuidV7Schema,
    hlc: z.string().length(58),
    createdAtMs: UnixMsPayloadSchema,
    receivingId: UuidV7Schema,
    sortOrder: z.number().int(),
    productId: UuidV7Schema,
    variantId: UuidV7Schema.nullable().optional(),
    qty: QuantityPayloadSchema,
    costUnknown: z.boolean(),
    initialTotalCost: MoneyPayloadSchema,
    vatRateBp: z.number().int().nullable().optional(),
    vatAmount: MoneyPayloadSchema.nullable().optional(),
    stockMoveId: UuidV7Schema,
    batchId: UuidV7Schema.nullable().optional(),
    batchNumber: z.string().nullable().optional(),
    expiryDateMs: UnixMsPayloadSchema.nullable().optional(),
  })
  .strict();

export const ReceivingCostConfirmationsPayloadSchema = z
  .object({
    id: UuidV7Schema,
    organizationId: UuidV7Schema,
    storeId: UuidV7Schema,
    deviceId: UuidV7Schema,
    hlc: z.string().length(58),
    createdAtMs: UnixMsPayloadSchema,
    receivingId: UuidV7Schema,
    receivingLineId: UuidV7Schema,
    supplierId: UuidV7Schema,
    productId: UuidV7Schema,
    variantId: UuidV7Schema.nullable().optional(),
    batchId: UuidV7Schema.nullable().optional(),
    receivedQty: QuantityPayloadSchema,
    confirmedTotalCost: MoneyPayloadSchema,
    dueDays: z.number().int().nullable().optional(),
    dueAtMs: UnixMsPayloadSchema.nullable().optional(),
    reason: z.string(),
    confirmedByUserId: UuidV7Schema,
    clientRequestId: UuidV7Schema,
    requestHash: z.string(),
  })
  .strict();

export const SupplierReturnsPayloadSchema = z
  .object({
    id: UuidV7Schema,
    organizationId: UuidV7Schema,
    storeId: UuidV7Schema,
    deviceId: UuidV7Schema,
    hlc: z.string().length(58),
    createdAtMs: UnixMsPayloadSchema,
    returnNo: MoneyPayloadSchema,
    returnCode: z.string(),
    receivingId: UuidV7Schema,
    supplierId: UuidV7Schema,
    reason: z.string(),
    totalReturnCost: MoneyPayloadSchema,
    createdByUserId: UuidV7Schema,
    clientRequestId: UuidV7Schema,
    requestHash: z.string(),
  })
  .strict();

export const SupplierReturnLinesPayloadSchema = z
  .object({
    id: UuidV7Schema,
    organizationId: UuidV7Schema,
    storeId: UuidV7Schema,
    deviceId: UuidV7Schema,
    hlc: z.string().length(58),
    createdAtMs: UnixMsPayloadSchema,
    supplierReturnId: UuidV7Schema,
    receivingLineId: UuidV7Schema,
    sortOrder: z.number().int(),
    productId: UuidV7Schema,
    variantId: UuidV7Schema.nullable().optional(),
    batchId: UuidV7Schema.nullable().optional(),
    stockMoveId: UuidV7Schema,
    qty: QuantityPayloadSchema,
    returnCostValue: MoneyPayloadSchema,
  })
  .strict();

export const SupplierLedgerPayloadSchema = z
  .object({
    id: UuidV7Schema,
    organizationId: UuidV7Schema,
    storeId: UuidV7Schema,
    deviceId: UuidV7Schema,
    hlc: z.string().length(58),
    createdAtMs: UnixMsPayloadSchema,
    supplierId: UuidV7Schema,
    entryType: z.string(),
    amountDelta: MoneyPayloadSchema,
    sourceType: z.string(),
    sourceId: UuidV7Schema,
    receivingId: UuidV7Schema.nullable().optional(),
    supplierReturnId: UuidV7Schema.nullable().optional(),
    paymentMethod: z.string().nullable().optional(),
    providerRef: z.string().nullable().optional(),
    cashMoveId: UuidV7Schema.nullable().optional(),
    dueAtMs: UnixMsPayloadSchema.nullable().optional(),
    reason: z.string().nullable().optional(),
    createdByUserId: UuidV7Schema,
    clientRequestId: UuidV7Schema.nullable().optional(),
    requestHash: z.string().nullable().optional(),
  })
  .strict();

export const ShiftsPayloadSchema = z
  .object({
    id: UuidV7Schema,
    organizationId: UuidV7Schema,
    storeId: UuidV7Schema,
    deviceId: UuidV7Schema,
    hlc: z.string().length(58),
    createdAtMs: UnixMsPayloadSchema,
    updatedAtMs: UnixMsPayloadSchema,
    shiftNo: MoneyPayloadSchema,
    shiftCode: z.string(),
    status: z.string(),
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
    openRequestHash: z.string(),
    closeClientRequestId: UuidV7Schema.nullable().optional(),
    closeRequestHash: z.string().nullable().optional(),
    registerId: UuidV7Schema.nullable().optional(),
  })
  .strict();

export const ShiftCashierSessionsPayloadSchema = z
  .object({
    id: UuidV7Schema,
    organizationId: UuidV7Schema,
    storeId: UuidV7Schema,
    deviceId: UuidV7Schema,
    hlc: z.string().length(58),
    createdAtMs: UnixMsPayloadSchema,
    updatedAtMs: UnixMsPayloadSchema,
    shiftId: UuidV7Schema,
    sessionSeq: z.number().int(),
    cashierUserId: UuidV7Schema,
    status: z.string(),
    openingFloat: MoneyPayloadSchema,
    expectedCash: MoneyPayloadSchema.nullable().optional(),
    countedCash: QuantityPayloadSchema.nullable().optional(),
    discrepancy: MoneyPayloadSchema.nullable().optional(),
    discrepancyReason: z.string().nullable().optional(),
    denominationsJson: z.string().nullable().optional(),
    overrideApprovedByUserId: UuidV7Schema.nullable().optional(),
    handedOffByUserId: UuidV7Schema.nullable().optional(),
    note: z.string().nullable().optional(),
    startedAtMs: UnixMsPayloadSchema,
    endedAtMs: UnixMsPayloadSchema.nullable().optional(),
    handoffClientRequestId: UuidV7Schema.nullable().optional(),
    handoffRequestHash: z.string().nullable().optional(),
    registerId: UuidV7Schema.nullable().optional(),
  })
  .strict();

export const ShiftClosuresPayloadSchema = z
  .object({
    id: UuidV7Schema,
    organizationId: UuidV7Schema,
    storeId: UuidV7Schema,
    deviceId: UuidV7Schema,
    hlc: z.string().length(58),
    createdAtMs: UnixMsPayloadSchema,
    shiftId: UuidV7Schema,
    closureSeq: z.number().int(),
    isReclose: z.boolean(),
    reason: z.string().nullable().optional(),
    closedByUserId: UuidV7Schema,
    overrideApprovedByUserId: UuidV7Schema.nullable().optional(),
    clientRequestId: UuidV7Schema,
    requestHash: z.string(),
    expectedCash: MoneyPayloadSchema,
    countedCash: QuantityPayloadSchema,
    discrepancy: MoneyPayloadSchema,
    denominationsJson: z.string().nullable().optional(),
    salesCount: z.number().int(),
    returnsCount: z.number().int(),
    voidsCount: z.number().int(),
    grossSalesTotal: MoneyPayloadSchema,
    returnsTotal: MoneyPayloadSchema,
    netSalesTotal: MoneyPayloadSchema,
    orderAdvanceCashTotal: MoneyPayloadSchema,
    orderAdvanceNonCashTotal: MoneyPayloadSchema,
    orderAdvanceRefundTotal: MoneyPayloadSchema,
  })
  .strict();

export const ShiftClosureMethodTotalsPayloadSchema = z
  .object({
    id: UuidV7Schema,
    organizationId: UuidV7Schema,
    storeId: UuidV7Schema,
    deviceId: UuidV7Schema,
    hlc: z.string().length(58),
    createdAtMs: UnixMsPayloadSchema,
    shiftClosureId: UuidV7Schema,
    method: z.string(),
    salesAmount: MoneyPayloadSchema,
    returnsAmount: MoneyPayloadSchema,
    netAmount: MoneyPayloadSchema,
  })
  .strict();

export const ShiftClosureCashiersPayloadSchema = z
  .object({
    id: UuidV7Schema,
    organizationId: UuidV7Schema,
    storeId: UuidV7Schema,
    deviceId: UuidV7Schema,
    hlc: z.string().length(58),
    createdAtMs: UnixMsPayloadSchema,
    shiftClosureId: UuidV7Schema,
    sessionId: UuidV7Schema,
    cashierUserId: UuidV7Schema,
    sessionSeq: z.number().int(),
    openingFloat: MoneyPayloadSchema,
    expectedCash: MoneyPayloadSchema,
    countedCash: QuantityPayloadSchema,
    discrepancy: MoneyPayloadSchema,
    salesCount: z.number().int(),
    returnsCount: z.number().int(),
    salesTotal: MoneyPayloadSchema,
    returnsTotal: MoneyPayloadSchema,
    cashInTotal: MoneyPayloadSchema,
    cashOutTotal: MoneyPayloadSchema,
  })
  .strict();

export const DayClosesPayloadSchema = z
  .object({
    id: UuidV7Schema,
    organizationId: UuidV7Schema,
    storeId: UuidV7Schema,
    deviceId: UuidV7Schema,
    hlc: z.string().length(58),
    createdAtMs: UnixMsPayloadSchema,
    businessDate: z.string(),
    closeSeq: z.number().int(),
    closeCode: z.string(),
    closedByUserId: UuidV7Schema,
    clientRequestId: UuidV7Schema,
    requestHash: z.string(),
    note: z.string().nullable().optional(),
    shiftsCount: z.number().int(),
    salesCount: z.number().int(),
    returnsCount: z.number().int(),
    voidsCount: z.number().int(),
    grossSalesTotal: MoneyPayloadSchema,
    returnsTotal: MoneyPayloadSchema,
    netSalesTotal: MoneyPayloadSchema,
    expectedCashTotal: MoneyPayloadSchema,
    countedCashTotal: QuantityPayloadSchema,
    discrepancyTotal: MoneyPayloadSchema,
    methodTotalsJson: z.string(),
    includedClosureIdsJson: z.string(),
    fiscalStatus: z.string(),
    fiscalReportNo: z.string().nullable().optional(),
  })
  .strict();

export const OrdersPayloadSchema = z
  .object({
    id: UuidV7Schema,
    organizationId: UuidV7Schema,
    storeId: UuidV7Schema,
    deviceId: UuidV7Schema,
    hlc: z.string().length(58),
    createdAtMs: UnixMsPayloadSchema,
    updatedAtMs: UnixMsPayloadSchema,
    originDeviceId: UuidV7Schema,
    orderNo: MoneyPayloadSchema,
    orderCode: z.string(),
    status: z.string(),
    customerId: UuidV7Schema.nullable().optional(),
    customerName: z.string(),
    customerPhoneNormalized: z.string().nullable().optional(),
    dueAtMs: UnixMsPayloadSchema.nullable().optional(),
    note: z.string().nullable().optional(),
    subtotalGross: MoneyPayloadSchema,
    totalPromoDiscount: QuantityPayloadSchema,
    subtotalAfterPromo: MoneyPayloadSchema,
    manualDiscountMode: z.string(),
    manualDiscountValue: QuantityPayloadSchema,
    manualDiscountReason: z.string().nullable().optional(),
    orderDiscountAmount: QuantityPayloadSchema,
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
    createRequestHash: z.string(),
    confirmClientRequestId: UuidV7Schema.nullable().optional(),
    confirmRequestHash: z.string().nullable().optional(),
    readyClientRequestId: UuidV7Schema.nullable().optional(),
    readyRequestHash: z.string().nullable().optional(),
    deliverClientRequestId: UuidV7Schema.nullable().optional(),
    deliverRequestHash: z.string().nullable().optional(),
    cancelClientRequestId: UuidV7Schema.nullable().optional(),
    cancelRequestHash: z.string().nullable().optional(),
  })
  .strict();

export const OrderLinesPayloadSchema = z
  .object({
    id: UuidV7Schema,
    organizationId: UuidV7Schema,
    storeId: UuidV7Schema,
    deviceId: UuidV7Schema,
    hlc: z.string().length(58),
    createdAtMs: UnixMsPayloadSchema,
    orderId: UuidV7Schema,
    sortOrder: z.number().int(),
    lineKind: z.string(),
    productId: UuidV7Schema.nullable().optional(),
    variantId: UuidV7Schema.nullable().optional(),
    categoryIdSnapshot: UuidV7Schema.nullable().optional(),
    itemName: z.string(),
    unit: z.string(),
    qty: QuantityPayloadSchema,
    unitPriceSnapshot: MoneyPayloadSchema,
    appliedPromotionId: UuidV7Schema.nullable().optional(),
    appliedPromotionName: z.string().nullable().optional(),
    freeUnits: QuantityPayloadSchema,
    grossTotal: MoneyPayloadSchema,
    promoDiscount: QuantityPayloadSchema,
    subtotalAfterPromo: MoneyPayloadSchema,
    allocatedOrderDiscount: QuantityPayloadSchema,
    finalTotal: MoneyPayloadSchema,
    vatRateBpSnapshot: z.number().int(),
    netExVat: MoneyPayloadSchema,
    vatTotal: MoneyPayloadSchema,
    mxikSnapshot: z.string().nullable().optional(),
    packageCodeSnapshot: z.string().nullable().optional(),
  })
  .strict();

export const OrderPaymentsPayloadSchema = z
  .object({
    id: UuidV7Schema,
    organizationId: UuidV7Schema,
    storeId: UuidV7Schema,
    deviceId: UuidV7Schema,
    hlc: z.string().length(58),
    createdAtMs: UnixMsPayloadSchema,
    orderId: UuidV7Schema,
    shiftId: UuidV7Schema,
    shiftCashierSessionId: UuidV7Schema,
    kind: z.string(),
    method: z.string(),
    amount: MoneyPayloadSchema,
    tenderedAmount: MoneyPayloadSchema.nullable().optional(),
    changeAmount: MoneyPayloadSchema,
    providerRef: z.string().nullable().optional(),
    reason: z.string().nullable().optional(),
    createdByUserId: UuidV7Schema,
    overrideApprovedByUserId: UuidV7Schema.nullable().optional(),
    seq: z.number().int(),
    clientRequestId: UuidV7Schema,
    requestHash: z.string(),
  })
  .strict();

export const OrganizationTaxProfilesPayloadSchema = z
  .object({
    id: UuidV7Schema,
    organizationId: UuidV7Schema,
    deviceId: UuidV7Schema,
    hlc: z.string().length(58),
    createdAtMs: UnixMsPayloadSchema,
    updatedAtMs: UnixMsPayloadSchema,
    deletedAtMs: UnixMsPayloadSchema.nullable().optional(),
    tin: z.string().regex(/^\d{9}$/),
    legalName: z.string().min(1),
    legalAddress: z.string().min(1),
    isVatPayer: z.boolean(),
    defaultVatRateBp: z.number().int().min(0).max(10000),
    updatedByUserId: UuidV7Schema,
  })
  .strict();

/** T3.3 fiscal documents (MONOTONE). Driver fields are opaque strings, set only on `confirmed`. */
export const FiscalDocsPayloadSchema = z
  .object({
    id: UuidV7Schema,
    organizationId: UuidV7Schema,
    storeId: UuidV7Schema,
    deviceId: UuidV7Schema,
    hlc: z.string().length(58),
    createdAtMs: UnixMsPayloadSchema,
    updatedAtMs: UnixMsPayloadSchema,
    docKind: z.enum(FISCAL_DOC_KINDS),
    saleId: UuidV7Schema.nullable(),
    returnId: UuidV7Schema.nullable(),
    shiftId: UuidV7Schema.nullable(),
    dependsOnDocId: UuidV7Schema.nullable(),
    idempotencyKey: z.string().min(1).max(200),
    status: z.enum(FISCAL_DOC_STATUSES),
    attempts: z.number().int().nonnegative(),
    nextCheckAtMs: UnixMsPayloadSchema,
    lastErrorCode: z.string().nullable(),
    lastErrorMessage: z.string().nullable(),
    sentAtMs: UnixMsPayloadSchema.nullable(),
    confirmedAtMs: UnixMsPayloadSchema.nullable(),
    cancelledAtMs: UnixMsPayloadSchema.nullable(),
    fiscalSign: z.string().nullable(),
    fiscalNumber: z.string().nullable(),
    qrPayload: z.string().nullable(),
    driverId: z.string().min(1),
    offlineDeadlineMs: UnixMsPayloadSchema,
  })
  .strict();

export const SYNC_PAYLOAD_SCHEMAS: Readonly<Record<string, z.ZodType<Record<string, unknown>>>> = {
  users: UsersPayloadSchema,
  categories: CategoriesPayloadSchema,
  products: ProductsPayloadSchema,
  product_variants: ProductVariantsPayloadSchema,
  product_barcodes: ProductBarcodesPayloadSchema,
  product_price_tiers: ProductPriceTiersPayloadSchema,
  product_images: ProductImagesPayloadSchema,
  price_changes: PriceChangesPayloadSchema,
  batches: BatchesPayloadSchema,
  stock_moves: StockMovesPayloadSchema,
  inventory_counts: InventoryCountsPayloadSchema,
  inventory_count_lines: InventoryCountLinesPayloadSchema,
  promotions: PromotionsPayloadSchema,
  sales: SalesPayloadSchema,
  sale_lines: SaleLinesPayloadSchema,
  payments: PaymentsPayloadSchema,
  cash_moves: CashMovesPayloadSchema,
  returns: ReturnsPayloadSchema,
  return_lines: ReturnLinesPayloadSchema,
  return_payments: ReturnPaymentsPayloadSchema,
  customers: CustomersPayloadSchema,
  customer_ledger: CustomerLedgerPayloadSchema,
  suppliers: SuppliersPayloadSchema,
  goods_receivings: GoodsReceivingsPayloadSchema,
  goods_receiving_lines: GoodsReceivingLinesPayloadSchema,
  receiving_cost_confirmations: ReceivingCostConfirmationsPayloadSchema,
  supplier_returns: SupplierReturnsPayloadSchema,
  supplier_return_lines: SupplierReturnLinesPayloadSchema,
  supplier_ledger: SupplierLedgerPayloadSchema,
  shifts: ShiftsPayloadSchema,
  shift_cashier_sessions: ShiftCashierSessionsPayloadSchema,
  shift_closures: ShiftClosuresPayloadSchema,
  shift_closure_method_totals: ShiftClosureMethodTotalsPayloadSchema,
  shift_closure_cashiers: ShiftClosureCashiersPayloadSchema,
  day_closes: DayClosesPayloadSchema,
  orders: OrdersPayloadSchema,
  order_lines: OrderLinesPayloadSchema,
  order_payments: OrderPaymentsPayloadSchema,
  organization_tax_profiles: OrganizationTaxProfilesPayloadSchema,
  fiscal_docs: FiscalDocsPayloadSchema,
};

export const UserPayloadSchema = UsersPayloadSchema;
export const CategoryPayloadSchema = CategoriesPayloadSchema;
export const ProductPayloadSchema = ProductsPayloadSchema;
export const ProductVariantPayloadSchema = ProductVariantsPayloadSchema;
export const ProductBarcodePayloadSchema = ProductBarcodesPayloadSchema;
export const PriceChangePayloadSchema = PriceChangesPayloadSchema;
export const BatchPayloadSchema = BatchesPayloadSchema;
export const StockMovePayloadSchema = StockMovesPayloadSchema;
export const InventoryCountPayloadSchema = InventoryCountsPayloadSchema;
export const InventoryCountLinePayloadSchema = InventoryCountLinesPayloadSchema;
export const PromotionPayloadSchema = PromotionsPayloadSchema;
export const SalePayloadSchema = SalesPayloadSchema;
export const SaleLinePayloadSchema = SaleLinesPayloadSchema;
export const PaymentPayloadSchema = PaymentsPayloadSchema;
export const CashMovePayloadSchema = CashMovesPayloadSchema;
export const ReturnPayloadSchema = ReturnsPayloadSchema;
export const ReturnLinePayloadSchema = ReturnLinesPayloadSchema;
export const ReturnPaymentPayloadSchema = ReturnPaymentsPayloadSchema;
export const CustomerPayloadSchema = CustomersPayloadSchema;
export const SupplierPayloadSchema = SuppliersPayloadSchema;
export const GoodsReceivingPayloadSchema = GoodsReceivingsPayloadSchema;
export const GoodsReceivingLinePayloadSchema = GoodsReceivingLinesPayloadSchema;
export const ReceivingCostConfirmationPayloadSchema = ReceivingCostConfirmationsPayloadSchema;
export const SupplierReturnPayloadSchema = SupplierReturnsPayloadSchema;
export const SupplierReturnLinePayloadSchema = SupplierReturnLinesPayloadSchema;
export const ShiftPayloadSchema = ShiftsPayloadSchema;
export const ShiftCashierSessionPayloadSchema = ShiftCashierSessionsPayloadSchema;
export const ShiftClosurePayloadSchema = ShiftClosuresPayloadSchema;
export const ShiftClosureMethodTotalPayloadSchema = ShiftClosureMethodTotalsPayloadSchema;
export const ShiftClosureCashierPayloadSchema = ShiftClosureCashiersPayloadSchema;
export const DayClosePayloadSchema = DayClosesPayloadSchema;
export const OrderPayloadSchema = OrdersPayloadSchema;
export const OrderLinePayloadSchema = OrderLinesPayloadSchema;
export const OrderPaymentPayloadSchema = OrderPaymentsPayloadSchema;
export const OrganizationTaxProfilePayloadSchema = OrganizationTaxProfilesPayloadSchema;
export const FiscalDocPayloadSchema = FiscalDocsPayloadSchema;

export const SYNC_ENTITY_PAYLOAD_SCHEMAS = SYNC_PAYLOAD_SCHEMAS;

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
  readonly allowableUpdateColumns: readonly string[];
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
    allowableUpdateColumns: [
      'voidedAtMs',
      'voidedByUserId',
      'voidReason',
      'voidClientRequestId',
      'voidRequestHash',
      'hlc',
      'updatedAtMs',
    ],
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
    allowableUpdateColumns: [
      'status',
      'confirmedAtMs',
      'readyAtMs',
      'deliveredAtMs',
      'deliveredSaleId',
      'cancelledAtMs',
      'cancelledByUserId',
      'cancelReason',
      'hlc',
      'updatedAtMs',
    ],
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
    allowableUpdateColumns: [
      'status',
      'closedAtMs',
      'closedByUserId',
      'closeClientRequestId',
      'closeRequestHash',
      'hlc',
      'updatedAtMs',
    ],
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
    allowableUpdateColumns: [
      'status',
      'endedAtMs',
      'expectedCash',
      'countedCash',
      'discrepancy',
      'hlc',
      'updatedAtMs',
    ],
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
    allowableUpdateColumns: [
      'status',
      'finalizedAtMs',
      'finalizedByUserId',
      'cancelledAtMs',
      'cancelledByUserId',
      'cancelReason',
      'hlc',
      'updatedAtMs',
    ],
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
    allowableUpdateColumns: [
      'expectedQtyAtCount',
      'countedQty',
      'adjustmentQty',
      'hlc',
      'updatedAtMs',
    ],
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
  fiscal_docs: {
    stateColumn: 'status',
    isMonotone: true,
    // Controller fix #5: explicit list. Opaque driver fields are accepted only on the transition to
    // `confirmed` (checkTransition) and are frozen afterwards (terminal state).
    allowableUpdateColumns: [
      'status',
      'attempts',
      'nextCheckAtMs',
      'lastErrorCode',
      'lastErrorMessage',
      'sentAtMs',
      'confirmedAtMs',
      'cancelledAtMs',
      'fiscalSign',
      'fiscalNumber',
      'qrPayload',
      'deviceId',
      'hlc',
      'updatedAtMs',
    ],
    checkTransition(existing, incoming) {
      const from = existing.status;
      const to = incoming.status;
      if (!isFiscalDocStatus(from) || !isFiscalDocStatus(to)) return 'rejected';
      const opaque = ['fiscal_sign', 'fiscal_number', 'qr_payload'] as const;
      const camel = {
        fiscal_sign: 'fiscalSign',
        fiscal_number: 'fiscalNumber',
        qr_payload: 'qrPayload',
      };
      const val = (row: Record<string, unknown>, k: (typeof opaque)[number]) =>
        row[k] ?? row[camel[k]] ?? null;
      if (from === to) {
        if (from === 'confirmed' || from === 'cancelled' || from === 'rejected') {
          // Replay of the terminal state with identical opaque fields is a duplicate.
          return opaque.every((k) => val(existing, k) === val(incoming, k))
            ? 'duplicate'
            : 'rejected';
        }
        // In-place bookkeeping (attempts / next check / last error) on a live state.
        if (!FISCAL_DOC_BOOKKEEPING_STATES.includes(from)) return 'rejected';
        if (opaque.some((k) => val(incoming, k) !== null)) return 'rejected';
        // attempts may arrive as number, bigint (SQLite safeIntegers) or string (wire).
        const a0 = toSafeString(existing.attempts);
        const a1 = toSafeString(incoming.attempts);
        if (!/^[0-9]+$/.test(a0) || !/^[0-9]+$/.test(a1) || BigInt(a1) < BigInt(a0))
          return 'rejected';
        return 'accepted';
      }
      if (!isFiscalDocTransitionAllowed(from, to)) return 'rejected';
      const hasAll = opaque.every((k) => {
        const v = val(incoming, k);
        return typeof v === 'string' && v.length > 0;
      });
      const hasAny = opaque.some((k) => val(incoming, k) !== null);
      if (to === 'confirmed') return hasAll ? 'accepted' : 'rejected';
      return hasAny ? 'rejected' : 'accepted';
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
  fiscal_docs: [
    { payloadKey: 'saleId', targetEntity: 'sales' },
    { payloadKey: 'returnId', targetEntity: 'returns' },
    { payloadKey: 'shiftId', targetEntity: 'shifts' },
    { payloadKey: 'dependsOnDocId', targetEntity: 'fiscal_docs' },
  ],
  categories: [{ payloadKey: 'parentId', targetEntity: 'categories' }],
  products: [{ payloadKey: 'categoryId', targetEntity: 'categories' }],
  product_variants: [{ payloadKey: 'productId', targetEntity: 'products' }],
  product_barcodes: [
    { payloadKey: 'productId', targetEntity: 'products' },
    { payloadKey: 'variantId', targetEntity: 'product_variants' },
  ],
  product_price_tiers: [{ payloadKey: 'productId', targetEntity: 'products' }],
  product_images: [{ payloadKey: 'productId', targetEntity: 'products' }],
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
  organization_tax_profiles: [{ payloadKey: 'updatedByUserId', targetEntity: 'users' }],
};

// --- T2.6: sync conflicts (hub view & resolve; no manual data editing) ---

export const SYNC_CONFLICT_ACTIONS = ['retry', 'acknowledge'] as const;
export const SYNC_CONFLICT_ORIGINS = ['push', 'pull', 'projection'] as const;

export const SyncConflictDtoSchema = z.strictObject({
  id: UuidV7Schema,
  origin: z.enum(SYNC_CONFLICT_ORIGINS),
  storeId: UuidV7Schema.nullable(),
  eventId: UuidV7Schema,
  entity: z.string(),
  entityId: UuidV7Schema,
  reason: z.string(),
  error: z.string().nullable(),
  /** Which actions this conflict allows (`acknowledge` always while open). */
  allowedActions: z.array(z.enum(SYNC_CONFLICT_ACTIONS)),
  createdAtMs: BigIntStringSchema,
  resolvedAtMs: BigIntStringSchema.nullable(),
  resolution: z.enum(['retried', 'acknowledged', 'auto']).nullable(),
  resolvedByUserId: UuidV7Schema.nullable(),
  resolutionNote: z.string().nullable(),
});
export type SyncConflictDto = z.infer<typeof SyncConflictDtoSchema>;

export const SyncConflictListQuerySchema = z.strictObject({
  status: z.enum(['open', 'resolved']).default('open'),
});

export const SyncConflictListResponseSchema = z.strictObject({
  conflicts: z.array(SyncConflictDtoSchema),
});
export type SyncConflictListResponseDto = z.infer<typeof SyncConflictListResponseSchema>;

/** Strict: there is deliberately no field to edit data — only retry or acknowledge. */
export const ResolveSyncConflictRequestSchema = z.strictObject({
  action: z.enum(SYNC_CONFLICT_ACTIONS),
  note: z.string().trim().max(500).optional(),
});
export type ResolveSyncConflictRequestDto = z.infer<typeof ResolveSyncConflictRequestSchema>;

export const ResolveSyncConflictResponseSchema = z.strictObject({
  conflict: SyncConflictDtoSchema,
  applied: z.boolean(),
});
export type ResolveSyncConflictResponseDto = z.infer<typeof ResolveSyncConflictResponseSchema>;

export const SyncParkedDtoSchema = z.strictObject({
  id: UuidV7Schema,
  eventId: UuidV7Schema,
  entity: z.string(),
  entityId: UuidV7Schema,
  missingRefEntity: z.string(),
  missingRefId: z.string(),
  attempts: z.number().int(),
  createdAtMs: BigIntStringSchema,
});
export const SyncParkedListResponseSchema = z.strictObject({
  parked: z.array(SyncParkedDtoSchema),
});
export type SyncParkedListResponseDto = z.infer<typeof SyncParkedListResponseSchema>;

// --- T2.6: cloud-side parked push events (device token; hub proxies them to the POS) ---

export const CloudParkedEventDtoSchema = z.strictObject({
  id: UuidV7Schema,
  eventId: UuidV7Schema,
  entity: z.string(),
  entityId: UuidV7Schema,
  missingRefEntity: z.string(),
  missingRefId: z.string(),
  attempts: z.number().int(),
  status: z.enum(['parked', 'conflict', 'resolved']),
  resolution: z.enum(['retried', 'acknowledged']).nullable(),
  resolvedByUserId: UuidV7Schema.nullable(),
  resolvedAtMs: BigIntStringSchema.nullable(),
  resolutionNote: z.string().nullable(),
  createdAtMs: BigIntStringSchema,
});
export type CloudParkedEventDto = z.infer<typeof CloudParkedEventDtoSchema>;

export const CloudParkedListResponseSchema = z.strictObject({
  parked: z.array(CloudParkedEventDtoSchema),
});
export type CloudParkedListResponseDto = z.infer<typeof CloudParkedListResponseSchema>;

/** Strict: retry or acknowledge only; `userId` is the hub user who decided (audit). */
export const CloudResolveParkedRequestSchema = z.strictObject({
  action: z.enum(SYNC_CONFLICT_ACTIONS),
  userId: UuidV7Schema,
  note: z.string().trim().max(500).optional(),
});
export type CloudResolveParkedRequestDto = z.infer<typeof CloudResolveParkedRequestSchema>;

export const CloudResolveParkedResponseSchema = z.strictObject({
  parked: CloudParkedEventDtoSchema,
});
