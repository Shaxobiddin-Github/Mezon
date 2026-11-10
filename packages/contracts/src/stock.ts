import {
  INVENTORY_COUNT_STATUSES,
  NEGATIVE_STOCK_POLICIES,
  STOCK_CONFLICT_REASONS,
  STOCK_MOVE_REASONS,
} from '@mezon/domain';
import { z } from 'zod';
import { BigIntStringSchema, UuidV7Schema } from './auth.js';
import { ProductUnitSchema } from './catalog.js';

export const SignedBigIntStringSchema = z.string().regex(/^-?\d+$/, 'Must be an integer string');

export const StockMoveReasonSchema = z.enum(STOCK_MOVE_REASONS);
export const NegativeStockPolicySchema = z.enum(NEGATIVE_STOCK_POLICIES);
export const InventoryCountStatusSchema = z.enum(INVENTORY_COUNT_STATUSES);
export const StockConflictReasonSchema = z.enum(STOCK_CONFLICT_REASONS);

// --- Balances & Valuation (strictly separated for RBAC) ---

/**
 * Cashier-safe stock balance DTO: contains ZERO cost, valuation, or variance fields (`GEMINI.md` 3.4).
 */
export const CashierStockBalanceSchema = z.strictObject({
  productId: UuidV7Schema,
  variantId: UuidV7Schema.nullable(),
  productName: z.string(),
  unit: ProductUnitSchema,
  unlimited: z.boolean(),
  trackBatches: z.boolean(),
  minStock: BigIntStringSchema.nullable(),
  qtyOnHand: SignedBigIntStringSchema.nullable(),
  isLowStock: z.boolean(),
});
export type CashierStockBalanceDto = z.infer<typeof CashierStockBalanceSchema>;

export const ListCashierStockBalancesResponseSchema = z.strictObject({
  balances: z.array(CashierStockBalanceSchema),
});
export type ListCashierStockBalancesResponseDto = z.infer<
  typeof ListCashierStockBalancesResponseSchema
>;

/**
 * Owner/Manager-only stock valuation DTO (`stock:write`).
 */
export const StockValuationItemSchema = z.strictObject({
  productId: UuidV7Schema,
  variantId: UuidV7Schema.nullable(),
  productName: z.string(),
  unit: ProductUnitSchema,
  trackBatches: z.boolean(),
  qtyOnHand: SignedBigIntStringSchema,
  totalValue: BigIntStringSchema,
  deficitQty: BigIntStringSchema,
  provisionalDeficitValue: BigIntStringSchema,
  costVarianceValue: SignedBigIntStringSchema,
  lastUnitCost: BigIntStringSchema.nullable(),
  updatedAtMs: BigIntStringSchema,
});
export type StockValuationItemDto = z.infer<typeof StockValuationItemSchema>;

export const ListStockValuationResponseSchema = z.strictObject({
  valuations: z.array(StockValuationItemSchema),
});
export type ListStockValuationResponseDto = z.infer<typeof ListStockValuationResponseSchema>;

// --- Batches ---

export const BatchSummarySchema = z.strictObject({
  id: UuidV7Schema,
  organizationId: UuidV7Schema,
  storeId: UuidV7Schema,
  productId: UuidV7Schema,
  variantId: UuidV7Schema.nullable(),
  batchNumber: z.string().nullable(),
  expiryDateMs: BigIntStringSchema.nullable(),
  initialQty: BigIntStringSchema,
  initialCostValue: BigIntStringSchema,
  remainingQty: BigIntStringSchema,
  remainingValue: BigIntStringSchema,
  createdAtMs: BigIntStringSchema,
});
export type BatchSummaryDto = z.infer<typeof BatchSummarySchema>;

export const ListBatchesQuerySchema = z.strictObject({
  productId: UuidV7Schema.optional(),
  includeEmpty: z.coerce.boolean().optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  offset: z.coerce.number().int().min(0).max(1_000_000).optional(),
});
export type ListBatchesQueryDto = z.infer<typeof ListBatchesQuerySchema>;

export const ListBatchesResponseSchema = z.strictObject({
  batches: z.array(BatchSummarySchema),
});
export type ListBatchesResponseDto = z.infer<typeof ListBatchesResponseSchema>;

// --- Stock Moves ---

export const StockMoveSummarySchema = z.strictObject({
  id: UuidV7Schema,
  organizationId: UuidV7Schema,
  storeId: UuidV7Schema,
  productId: UuidV7Schema,
  variantId: UuidV7Schema.nullable(),
  batchId: UuidV7Schema.nullable(),
  qtyDelta: SignedBigIntStringSchema,
  costValueDelta: SignedBigIntStringSchema,
  reason: StockMoveReasonSchema,
  sourceType: z.string(),
  sourceId: UuidV7Schema,
  createdByUserId: UuidV7Schema,
  note: z.string().nullable(),
  createdAtMs: BigIntStringSchema,
});
export type StockMoveSummaryDto = z.infer<typeof StockMoveSummarySchema>;

export const StockMoveWarningSchema = z.strictObject({
  code: z.literal('NEGATIVE_STOCK'),
  productId: UuidV7Schema,
  variantId: UuidV7Schema.nullable(),
  deficitQty: BigIntStringSchema,
});
export type StockMoveWarningDto = z.infer<typeof StockMoveWarningSchema>;

export const CreateInboundStockMoveRequestSchema = z.strictObject({
  productId: UuidV7Schema,
  variantId: UuidV7Schema.nullable().optional(),
  reason: z.enum(['initial', 'purchase', 'return', 'adjustment']),
  qty: BigIntStringSchema,
  totalCostValue: BigIntStringSchema,
  batchNumber: z.string().trim().min(1).max(64).nullable().optional(),
  expiryDateMs: BigIntStringSchema.nullable().optional(),
  note: z.string().trim().min(1).max(250).nullable().optional(),
});
export type CreateInboundStockMoveRequestDto = z.infer<typeof CreateInboundStockMoveRequestSchema>;

export const CreateOutboundStockMoveRequestSchema = z.strictObject({
  productId: UuidV7Schema,
  variantId: UuidV7Schema.nullable().optional(),
  reason: z.enum(['sale', 'damaged', 'broken', 'personal', 'lost', 'adjustment']),
  qty: BigIntStringSchema,
  policy: NegativeStockPolicySchema.optional(),
  note: z.string().trim().min(1).max(250).nullable().optional(),
});
export type CreateOutboundStockMoveRequestDto = z.infer<
  typeof CreateOutboundStockMoveRequestSchema
>;

export const CreateStockMovesResponseSchema = z.strictObject({
  moves: z.array(StockMoveSummarySchema),
  batch: BatchSummarySchema.nullable(),
  warnings: z.array(StockMoveWarningSchema),
});
export type CreateStockMovesResponseDto = z.infer<typeof CreateStockMovesResponseSchema>;

export const ListStockMovesQuerySchema = z.strictObject({
  productId: UuidV7Schema.optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  offset: z.coerce.number().int().min(0).max(1_000_000).optional(),
});
export type ListStockMovesQueryDto = z.infer<typeof ListStockMovesQuerySchema>;

export const ListStockMovesResponseSchema = z.strictObject({
  moves: z.array(StockMoveSummarySchema),
});
export type ListStockMovesResponseDto = z.infer<typeof ListStockMovesResponseSchema>;

// --- Conflicts, Policy & Rebuild ---

export const StockConflictSummarySchema = z.strictObject({
  id: UuidV7Schema,
  productId: UuidV7Schema,
  variantId: UuidV7Schema.nullable(),
  batchId: UuidV7Schema.nullable(),
  moveId: UuidV7Schema.nullable(),
  conflictQty: BigIntStringSchema,
  reason: StockConflictReasonSchema,
  detail: z.string().nullable(),
  resolvedAtMs: BigIntStringSchema.nullable(),
  createdAtMs: BigIntStringSchema,
});
export type StockConflictSummaryDto = z.infer<typeof StockConflictSummarySchema>;

export const ListStockConflictsResponseSchema = z.strictObject({
  conflicts: z.array(StockConflictSummarySchema),
});
export type ListStockConflictsResponseDto = z.infer<typeof ListStockConflictsResponseSchema>;

export const UpdateNegativeStockPolicyRequestSchema = z.strictObject({
  policy: NegativeStockPolicySchema,
});
export type UpdateNegativeStockPolicyRequestDto = z.infer<
  typeof UpdateNegativeStockPolicyRequestSchema
>;

export const NegativeStockPolicyResponseSchema = z.strictObject({
  policy: NegativeStockPolicySchema,
});
export type NegativeStockPolicyResponseDto = z.infer<typeof NegativeStockPolicyResponseSchema>;

export const RebuildStockProjectionsResponseSchema = z.strictObject({
  balancesRebuilt: z.number().int().min(0),
  batchesRebuilt: z.number().int().min(0),
  movesReplayed: z.number().int().min(0),
  conflictsDetected: z.number().int().min(0),
});
export type RebuildStockProjectionsResponseDto = z.infer<
  typeof RebuildStockProjectionsResponseSchema
>;

// --- Inventory Counts (S1 + S3 + S4) ---

export const InventoryCountIdParamsSchema = z.strictObject({
  id: UuidV7Schema,
});
export type InventoryCountIdParamsDto = z.infer<typeof InventoryCountIdParamsSchema>;

export const InventoryCountSummarySchema = z.strictObject({
  id: UuidV7Schema,
  organizationId: UuidV7Schema,
  storeId: UuidV7Schema,
  status: InventoryCountStatusSchema,
  startedByUserId: UuidV7Schema,
  finalizedByUserId: UuidV7Schema.nullable(),
  finalizedAtMs: BigIntStringSchema.nullable(),
  note: z.string().nullable(),
  createdAtMs: BigIntStringSchema,
  updatedAtMs: BigIntStringSchema,
});
export type InventoryCountSummaryDto = z.infer<typeof InventoryCountSummarySchema>;

export const InventoryCountLineSchema = z.strictObject({
  id: UuidV7Schema,
  countId: UuidV7Schema,
  productId: UuidV7Schema,
  variantId: UuidV7Schema.nullable(),
  expectedQtyAtCount: SignedBigIntStringSchema.nullable(),
  countedQty: BigIntStringSchema.nullable(),
  adjustmentQty: SignedBigIntStringSchema.nullable(),
  updatedAtMs: BigIntStringSchema,
});
export type InventoryCountLineDto = z.infer<typeof InventoryCountLineSchema>;

export const StartInventoryCountRequestSchema = z.strictObject({
  productIds: z.array(UuidV7Schema).max(500).optional(),
  categoryId: UuidV7Schema.optional(),
  note: z.string().trim().min(1).max(250).nullable().optional(),
});
export type StartInventoryCountRequestDto = z.infer<typeof StartInventoryCountRequestSchema>;

export const RecordInventoryCountLinesRequestSchema = z.strictObject({
  lines: z
    .array(
      z.strictObject({
        productId: UuidV7Schema,
        variantId: UuidV7Schema.nullable().optional(),
        countedQty: BigIntStringSchema.nullable(),
      }),
    )
    .min(1)
    .max(500),
});
export type RecordInventoryCountLinesRequestDto = z.infer<
  typeof RecordInventoryCountLinesRequestSchema
>;

export const InventoryCountDetailResponseSchema = z.strictObject({
  count: InventoryCountSummarySchema,
  lines: z.array(InventoryCountLineSchema),
});
export type InventoryCountDetailResponseDto = z.infer<typeof InventoryCountDetailResponseSchema>;

export const FinalizeInventoryCountResponseSchema = z.strictObject({
  count: InventoryCountSummarySchema,
  lines: z.array(InventoryCountLineSchema),
  adjustmentMoves: z.array(StockMoveSummarySchema),
  conflicts: z.array(StockConflictSummarySchema),
});
export type FinalizeInventoryCountResponseDto = z.infer<
  typeof FinalizeInventoryCountResponseSchema
>;
