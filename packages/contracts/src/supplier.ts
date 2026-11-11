import {
  DomainError,
  MAX_BATCH_NUMBER_LENGTH,
  MAX_SUPPLIER_DUE_DAYS,
  MAX_SUPPLIER_INVOICE_NO_LENGTH,
  RECEIVING_DRAFT_STATUSES,
  SUPPLIER_LEDGER_ENTRY_TYPES,
  SUPPLIER_LEDGER_SOURCE_TYPES,
  normalizeBatchNumber,
  normalizeSupplierContactPerson,
  normalizeSupplierInvoiceNo,
  normalizeSupplierName,
  normalizeSupplierNote,
  normalizeSupplierPhone,
  normalizeSupplierTin,
} from '@mezon/domain';
import { z } from 'zod';
import { BigIntStringSchema, UuidV7Schema } from './auth.js';
import { PositiveBigIntStringSchema } from './cart.js';
import { ProductUnitSchema } from './catalog.js';
import {
  CustomerDueDaysSchema,
  MandatoryLedgerReasonSchema,
  SignedBoundedMoneyStringSchema,
} from './customer.js';
import {
  BoundedMoneyStringSchema,
  CashMoveDtoSchema,
  PaymentMethodSchema,
  PositiveBoundedMoneyStringSchema,
} from './sale.js';
import { SignedBigIntStringSchema } from './stock.js';

export const SupplierIdParamsSchema = z.strictObject({
  id: UuidV7Schema,
});
export type SupplierIdParamsDto = z.infer<typeof SupplierIdParamsSchema>;

export const ReceivingIdParamsSchema = z.strictObject({
  id: UuidV7Schema,
});
export type ReceivingIdParamsDto = z.infer<typeof ReceivingIdParamsSchema>;

export const ReceivingLineParamsSchema = z.strictObject({
  id: UuidV7Schema,
  lineId: UuidV7Schema,
});
export type ReceivingLineParamsDto = z.infer<typeof ReceivingLineParamsSchema>;

export const SupplierReturnIdParamsSchema = z.strictObject({
  id: UuidV7Schema,
});
export type SupplierReturnIdParamsDto = z.infer<typeof SupplierReturnIdParamsSchema>;

export const SupplierNameSchema = z.string().transform((val, ctx): string => {
  try {
    return normalizeSupplierName(val);
  } catch (err) {
    ctx.addIssue({
      code: 'custom',
      message: err instanceof DomainError ? err.message : 'Invalid supplier name',
    });
    return z.NEVER;
  }
});

export const SupplierTinInputSchema = z
  .string()
  .nullable()
  .transform((val, ctx): string | null => {
    try {
      return normalizeSupplierTin(val);
    } catch (err) {
      // Never echo raw TIN in Zod errors
      ctx.addIssue({
        code: 'custom',
        message: err instanceof DomainError ? err.message : 'Invalid supplier TIN format',
      });
      return z.NEVER;
    }
  });

export const SupplierPhoneInputSchema = z
  .string()
  .nullable()
  .transform((val, ctx): string | null => {
    try {
      const normalized = normalizeSupplierPhone(val);
      return normalized !== null ? normalized.phoneNormalized : null;
    } catch (err) {
      // Never echo raw phone number in Zod errors
      ctx.addIssue({
        code: 'custom',
        message: err instanceof DomainError ? err.message : 'Invalid supplier phone format',
      });
      return z.NEVER;
    }
  });

export const SupplierContactPersonInputSchema = z
  .string()
  .nullable()
  .transform((val, ctx): string | null => {
    try {
      return normalizeSupplierContactPerson(val);
    } catch (err) {
      ctx.addIssue({
        code: 'custom',
        message: err instanceof DomainError ? err.message : 'Invalid contactPerson',
      });
      return z.NEVER;
    }
  });

export const SupplierNoteInputSchema = z
  .string()
  .nullable()
  .transform((val, ctx): string | null => {
    try {
      return normalizeSupplierNote(val);
    } catch (err) {
      ctx.addIssue({
        code: 'custom',
        message: err instanceof DomainError ? err.message : 'Invalid supplier note',
      });
      return z.NEVER;
    }
  });

export const SupplierInvoiceNoInputSchema = z
  .string()
  .nullable()
  .transform((val, ctx): string | null => {
    try {
      return normalizeSupplierInvoiceNo(val);
    } catch (err) {
      ctx.addIssue({
        code: 'custom',
        message:
          err instanceof DomainError
            ? err.message
            : `Invoice number must not exceed ${String(MAX_SUPPLIER_INVOICE_NO_LENGTH)} characters`,
      });
      return z.NEVER;
    }
  });

export const BatchNumberInputSchema = z
  .string()
  .nullable()
  .transform((val, ctx): string | null => {
    try {
      return normalizeBatchNumber(val);
    } catch (err) {
      ctx.addIssue({
        code: 'custom',
        message:
          err instanceof DomainError
            ? err.message
            : `Batch number must not exceed ${String(MAX_BATCH_NUMBER_LENGTH)} characters`,
      });
      return z.NEVER;
    }
  });

export const SupplierDueDaysSchema = z.number().int().min(1).max(MAX_SUPPLIER_DUE_DAYS).nullable();

// --- Supplier Profile CRUD ---

export const CreateSupplierRequestSchema = z.strictObject({
  name: SupplierNameSchema,
  tin: SupplierTinInputSchema.optional(),
  phone: SupplierPhoneInputSchema.optional(),
  contactPerson: SupplierContactPersonInputSchema.optional(),
  defaultDueDays: SupplierDueDaysSchema.optional(),
  note: SupplierNoteInputSchema.optional(),
});
export type CreateSupplierRequestDto = z.infer<typeof CreateSupplierRequestSchema>;

export const UpdateSupplierRequestSchema = z
  .strictObject({
    name: SupplierNameSchema.optional(),
    tin: SupplierTinInputSchema.optional(),
    phone: SupplierPhoneInputSchema.optional(),
    contactPerson: SupplierContactPersonInputSchema.optional(),
    defaultDueDays: SupplierDueDaysSchema.optional(),
    note: SupplierNoteInputSchema.optional(),
    isActive: z.boolean().optional(),
  })
  .refine(
    (val) =>
      val.name !== undefined ||
      val.tin !== undefined ||
      val.phone !== undefined ||
      val.contactPerson !== undefined ||
      val.defaultDueDays !== undefined ||
      val.note !== undefined ||
      val.isActive !== undefined,
    'At least one supplier field must be provided for update',
  );
export type UpdateSupplierRequestDto = z.infer<typeof UpdateSupplierRequestSchema>;

export const SupplierListQuerySchema = z.strictObject({
  q: z.string().trim().max(120).optional(),
  overdueOnly: z.coerce.boolean().optional(),
  advanceOnly: z.coerce.boolean().optional(),
  includeInactive: z.coerce.boolean().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  offset: z.coerce.number().int().min(0).max(1_000_000).optional(),
});
export type SupplierListQueryDto = z.infer<typeof SupplierListQuerySchema>;

export const SupplierSummaryDtoSchema = z.strictObject({
  id: UuidV7Schema,
  organizationId: UuidV7Schema,
  name: z.string(),
  tin: z.string().nullable(),
  phoneNormalized: z.string().nullable(),
  contactPerson: z.string().nullable(),
  defaultDueDays: z.number().int().nullable(),
  note: z.string().nullable(),
  isActive: z.boolean(),
  balance: SignedBigIntStringSchema,
  debtBalance: BigIntStringSchema,
  advanceBalance: BigIntStringSchema,
  totalDebtAccrued: BigIntStringSchema,
  totalCredited: BigIntStringSchema,
  overdueAmount: BigIntStringSchema,
  oldestOverdueDays: z.number().int().nonnegative(),
  lastActivityAtMs: BigIntStringSchema.nullable(),
  createdAtMs: BigIntStringSchema,
  updatedAtMs: BigIntStringSchema,
});
export type SupplierSummaryDto = z.infer<typeof SupplierSummaryDtoSchema>;

export const SupplierOpenObligationDtoSchema = z.strictObject({
  ledgerEntryId: UuidV7Schema,
  entryType: z.enum(['opening_balance', 'receiving_debt', 'adjustment']),
  createdAtMs: BigIntStringSchema,
  receivingId: UuidV7Schema.nullable(),
  dueAtMs: BigIntStringSchema.nullable(),
  initialDebt: BigIntStringSchema,
  advanceApplied: BigIntStringSchema,
  paidOrReturnedTotal: BigIntStringSchema,
  waivedTotal: BigIntStringSchema,
  remainingDebt: BigIntStringSchema,
  isOverdue: z.boolean(),
  daysOverdue: z.number().int().nonnegative(),
});
export type SupplierOpenObligationDto = z.infer<typeof SupplierOpenObligationDtoSchema>;

export const SupplierDetailResponseSchema = z.strictObject({
  supplier: SupplierSummaryDtoSchema,
  openObligations: z.array(SupplierOpenObligationDtoSchema),
});
export type SupplierDetailResponseDto = z.infer<typeof SupplierDetailResponseSchema>;

export const SupplierListResponseSchema = z.strictObject({
  items: z.array(SupplierSummaryDtoSchema),
  total: z.number().int().nonnegative(),
  limit: z.number().int().positive(),
  offset: z.number().int().nonnegative(),
});
export type SupplierListResponseDto = z.infer<typeof SupplierListResponseSchema>;

export const SupplierMutationResponseSchema = z.strictObject({
  supplier: SupplierSummaryDtoSchema,
});
export type SupplierMutationResponseDto = z.infer<typeof SupplierMutationResponseSchema>;

export const ArchiveSupplierResponseSchema = z.strictObject({
  supplierId: UuidV7Schema,
  deletedAtMs: BigIntStringSchema,
});
export type ArchiveSupplierResponseDto = z.infer<typeof ArchiveSupplierResponseSchema>;

// --- Goods Receiving Draft & Posted Receiving ---

export const ReceivingDraftStatusSchema = z.enum(RECEIVING_DRAFT_STATUSES);

export const ReceivingLineInputSchema = z
  .strictObject({
    productId: UuidV7Schema,
    variantId: UuidV7Schema.nullable().optional(),
    qty: PositiveBigIntStringSchema,
    costUnknown: z.boolean(),
    totalCostValue: BoundedMoneyStringSchema.nullable(),
    vatRateBp: z.number().int().min(0).max(10000).nullable().optional(),
    vatAmount: BoundedMoneyStringSchema.nullable().optional(),
    batchNumber: BatchNumberInputSchema.optional(),
    expiryDateMs: PositiveBigIntStringSchema.nullable().optional(),
  })
  .superRefine((val, ctx) => {
    if (val.costUnknown && val.totalCostValue !== null) {
      ctx.addIssue({
        code: 'custom',
        path: ['totalCostValue'],
        message: 'totalCostValue must be null when costUnknown is true',
      });
    }
    if (!val.costUnknown && val.totalCostValue === null) {
      ctx.addIssue({
        code: 'custom',
        path: ['totalCostValue'],
        message: 'totalCostValue is required when costUnknown is false',
      });
    }
  });
export type ReceivingLineInputDto = z.infer<typeof ReceivingLineInputSchema>;

export const CreateReceivingDraftRequestSchema = z.strictObject({
  supplierId: UuidV7Schema,
  supplierInvoiceNo: SupplierInvoiceNoInputSchema.optional(),
  dueDays: SupplierDueDaysSchema.optional(),
  note: SupplierNoteInputSchema.optional(),
  lines: z.array(ReceivingLineInputSchema).max(500).optional(),
});
export type CreateReceivingDraftRequestDto = z.infer<typeof CreateReceivingDraftRequestSchema>;

export const UpdateReceivingDraftRequestSchema = z
  .strictObject({
    supplierId: UuidV7Schema.optional(),
    supplierInvoiceNo: SupplierInvoiceNoInputSchema.optional(),
    dueDays: SupplierDueDaysSchema.optional(),
    note: SupplierNoteInputSchema.optional(),
    lines: z.array(ReceivingLineInputSchema).max(500).optional(),
  })
  .refine(
    (val) =>
      val.supplierId !== undefined ||
      val.supplierInvoiceNo !== undefined ||
      val.dueDays !== undefined ||
      val.note !== undefined ||
      val.lines !== undefined,
    'At least one receiving draft field or lines array must be provided',
  );
export type UpdateReceivingDraftRequestDto = z.infer<typeof UpdateReceivingDraftRequestSchema>;

export const PostReceivingRequestSchema = z.strictObject({
  clientRequestId: UuidV7Schema,
});
export type PostReceivingRequestDto = z.infer<typeof PostReceivingRequestSchema>;

export const ConfirmReceivingLineCostRequestSchema = z.strictObject({
  clientRequestId: UuidV7Schema,
  confirmedTotalCost: BoundedMoneyStringSchema,
  reason: MandatoryLedgerReasonSchema,
  dueDays: CustomerDueDaysSchema.optional(),
});
export type ConfirmReceivingLineCostRequestDto = z.infer<
  typeof ConfirmReceivingLineCostRequestSchema
>;

export const ReceivingListQuerySchema = z.strictObject({
  status: ReceivingDraftStatusSchema.optional(),
  supplierId: UuidV7Schema.optional(),
  costUnknownOnly: z.coerce.boolean().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  offset: z.coerce.number().int().min(0).max(1_000_000).optional(),
});
export type ReceivingListQueryDto = z.infer<typeof ReceivingListQuerySchema>;

export const ReceivingDraftLineDtoSchema = z.strictObject({
  id: UuidV7Schema,
  draftId: UuidV7Schema,
  sortOrder: z.number().int().nonnegative(),
  productId: UuidV7Schema,
  variantId: UuidV7Schema.nullable(),
  productName: z.string(),
  unit: ProductUnitSchema,
  qty: PositiveBigIntStringSchema,
  costUnknown: z.boolean(),
  totalCostValue: BigIntStringSchema.nullable(),
  vatRateBp: z.number().int().min(0).max(10000).nullable(),
  vatAmount: BigIntStringSchema.nullable(),
  batchNumber: z.string().nullable(),
  expiryDateMs: BigIntStringSchema.nullable(),
});
export type ReceivingDraftLineDto = z.infer<typeof ReceivingDraftLineDtoSchema>;

export const ReceivingDraftDtoSchema = z.strictObject({
  id: UuidV7Schema,
  organizationId: UuidV7Schema,
  storeId: UuidV7Schema,
  supplierId: UuidV7Schema,
  supplierInvoiceNo: z.string().nullable(),
  dueDays: z.number().int().nullable(),
  note: z.string().nullable(),
  status: ReceivingDraftStatusSchema,
  createdByUserId: UuidV7Schema,
  createdAtMs: BigIntStringSchema,
  updatedAtMs: BigIntStringSchema,
  postedAtMs: BigIntStringSchema.nullable(),
  cancelledAtMs: BigIntStringSchema.nullable(),
  lines: z.array(ReceivingDraftLineDtoSchema),
});
export type ReceivingDraftDto = z.infer<typeof ReceivingDraftDtoSchema>;

export const ReceivingCostConfirmationDtoSchema = z.strictObject({
  id: UuidV7Schema,
  organizationId: UuidV7Schema,
  storeId: UuidV7Schema,
  deviceId: UuidV7Schema,
  receivingId: UuidV7Schema,
  receivingLineId: UuidV7Schema,
  supplierId: UuidV7Schema,
  productId: UuidV7Schema,
  variantId: UuidV7Schema.nullable(),
  batchId: UuidV7Schema.nullable(),
  receivedQty: PositiveBigIntStringSchema,
  confirmedTotalCost: BigIntStringSchema,
  dueDays: z.number().int().nullable(),
  dueAtMs: BigIntStringSchema.nullable(),
  reason: z.string(),
  confirmedByUserId: UuidV7Schema,
  clientRequestId: UuidV7Schema,
  createdAtMs: BigIntStringSchema,
});
export type ReceivingCostConfirmationDto = z.infer<typeof ReceivingCostConfirmationDtoSchema>;

export const ReceivingLineDtoSchema = z.strictObject({
  id: UuidV7Schema,
  receivingId: UuidV7Schema,
  sortOrder: z.number().int().nonnegative(),
  productId: UuidV7Schema,
  variantId: UuidV7Schema.nullable(),
  productName: z.string(),
  unit: ProductUnitSchema,
  qty: PositiveBigIntStringSchema,
  returnedQty: BigIntStringSchema,
  costUnknown: z.boolean(),
  costStatus: z.enum(['known', 'unknown', 'confirmed']),
  effectiveTotalCost: BigIntStringSchema,
  unitCostPreview: BigIntStringSchema,
  vatRateBp: z.number().int().min(0).max(10000).nullable(),
  vatAmount: BigIntStringSchema.nullable(),
  stockMoveId: UuidV7Schema,
  batchId: UuidV7Schema.nullable(),
  batchNumber: z.string().nullable(),
  expiryDateMs: BigIntStringSchema.nullable(),
  confirmation: ReceivingCostConfirmationDtoSchema.nullable(),
});
export type ReceivingLineDto = z.infer<typeof ReceivingLineDtoSchema>;

export const ReceivingDtoSchema = z.strictObject({
  id: UuidV7Schema,
  organizationId: UuidV7Schema,
  storeId: UuidV7Schema,
  deviceId: UuidV7Schema,
  receivingNo: PositiveBigIntStringSchema,
  receivingCode: z.string(),
  supplierId: UuidV7Schema,
  supplierInvoiceNo: z.string().nullable(),
  dueDays: z.number().int().nullable(),
  dueAtMs: BigIntStringSchema.nullable(),
  knownCostTotal: BigIntStringSchema,
  unknownCostLineCount: z.number().int().nonnegative(),
  note: z.string().nullable(),
  postedByUserId: UuidV7Schema,
  clientRequestId: UuidV7Schema,
  createdAtMs: BigIntStringSchema,
  lines: z.array(ReceivingLineDtoSchema),
});
export type ReceivingDto = z.infer<typeof ReceivingDtoSchema>;

export const ReceivingDraftResponseSchema = z.strictObject({
  draft: ReceivingDraftDtoSchema,
});
export type ReceivingDraftResponseDto = z.infer<typeof ReceivingDraftResponseSchema>;

export const PostReceivingResponseSchema = z.strictObject({
  receiving: ReceivingDtoSchema,
  supplier: SupplierSummaryDtoSchema,
  idempotentReplay: z.boolean(),
});
export type PostReceivingResponseDto = z.infer<typeof PostReceivingResponseSchema>;

export const ConfirmReceivingCostResponseSchema = z.strictObject({
  confirmation: ReceivingCostConfirmationDtoSchema,
  receiving: ReceivingDtoSchema,
  supplier: SupplierSummaryDtoSchema,
  idempotentReplay: z.boolean(),
});
export type ConfirmReceivingCostResponseDto = z.infer<typeof ConfirmReceivingCostResponseSchema>;

export const ReceivingListItemDtoSchema = z.strictObject({
  id: UuidV7Schema,
  status: ReceivingDraftStatusSchema,
  receivingNo: PositiveBigIntStringSchema.nullable(),
  receivingCode: z.string().nullable(),
  supplierId: UuidV7Schema,
  supplierInvoiceNo: z.string().nullable(),
  knownCostTotal: BigIntStringSchema,
  unknownCostLineCount: z.number().int().nonnegative(),
  lineCount: z.number().int().nonnegative(),
  createdAtMs: BigIntStringSchema,
  postedAtMs: BigIntStringSchema.nullable(),
});
export type ReceivingListItemDto = z.infer<typeof ReceivingListItemDtoSchema>;

export const ReceivingListResponseSchema = z.strictObject({
  items: z.array(ReceivingListItemDtoSchema),
  total: z.number().int().nonnegative(),
  limit: z.number().int().positive(),
  offset: z.number().int().nonnegative(),
});
export type ReceivingListResponseDto = z.infer<typeof ReceivingListResponseSchema>;

// --- Supplier Returns ---

export const SupplierReturnLineInputSchema = z.strictObject({
  receivingLineId: UuidV7Schema,
  qty: PositiveBigIntStringSchema,
});
export type SupplierReturnLineInputDto = z.infer<typeof SupplierReturnLineInputSchema>;

export const CreateSupplierReturnRequestSchema = z.strictObject({
  clientRequestId: UuidV7Schema,
  reason: MandatoryLedgerReasonSchema,
  items: z.array(SupplierReturnLineInputSchema).min(1).max(200),
});
export type CreateSupplierReturnRequestDto = z.infer<typeof CreateSupplierReturnRequestSchema>;

export const SupplierReturnLineDtoSchema = z.strictObject({
  id: UuidV7Schema,
  supplierReturnId: UuidV7Schema,
  receivingLineId: UuidV7Schema,
  sortOrder: z.number().int().nonnegative(),
  productId: UuidV7Schema,
  variantId: UuidV7Schema.nullable(),
  batchId: UuidV7Schema.nullable(),
  stockMoveId: UuidV7Schema,
  qty: PositiveBigIntStringSchema,
  returnCostValue: BigIntStringSchema,
});
export type SupplierReturnLineDto = z.infer<typeof SupplierReturnLineDtoSchema>;

export const SupplierReturnDtoSchema = z.strictObject({
  id: UuidV7Schema,
  organizationId: UuidV7Schema,
  storeId: UuidV7Schema,
  deviceId: UuidV7Schema,
  returnNo: PositiveBigIntStringSchema,
  returnCode: z.string(),
  receivingId: UuidV7Schema,
  supplierId: UuidV7Schema,
  reason: z.string(),
  totalReturnCost: BigIntStringSchema,
  createdByUserId: UuidV7Schema,
  clientRequestId: UuidV7Schema,
  createdAtMs: BigIntStringSchema,
  lines: z.array(SupplierReturnLineDtoSchema),
});
export type SupplierReturnDto = z.infer<typeof SupplierReturnDtoSchema>;

export const CreateSupplierReturnResponseSchema = z.strictObject({
  supplierReturn: SupplierReturnDtoSchema,
  supplier: SupplierSummaryDtoSchema,
  idempotentReplay: z.boolean(),
});
export type CreateSupplierReturnResponseDto = z.infer<typeof CreateSupplierReturnResponseSchema>;

export const ListSupplierReturnsResponseSchema = z.strictObject({
  returns: z.array(SupplierReturnDtoSchema),
});
export type ListSupplierReturnsResponseDto = z.infer<typeof ListSupplierReturnsResponseSchema>;

// --- Supplier Ledger, Opening Balance, Payments & Adjustments ---

export const SupplierLedgerEntryTypeSchema = z.enum(SUPPLIER_LEDGER_ENTRY_TYPES);
export const SupplierLedgerSourceTypeSchema = z.enum(SUPPLIER_LEDGER_SOURCE_TYPES);

export const SupplierLedgerQuerySchema = z.strictObject({
  limit: z.coerce.number().int().min(1).max(200).optional(),
  offset: z.coerce.number().int().min(0).max(5_000_000).optional(),
  order: z.enum(['asc', 'desc']).optional(),
  entryType: SupplierLedgerEntryTypeSchema.optional(),
});
export type SupplierLedgerQueryDto = z.infer<typeof SupplierLedgerQuerySchema>;

export const SupplierLedgerEntryDtoSchema = z.strictObject({
  id: UuidV7Schema,
  organizationId: UuidV7Schema,
  storeId: UuidV7Schema,
  deviceId: UuidV7Schema,
  supplierId: UuidV7Schema,
  entryType: SupplierLedgerEntryTypeSchema,
  amountDelta: SignedBigIntStringSchema,
  balanceAfter: SignedBigIntStringSchema,
  sourceType: SupplierLedgerSourceTypeSchema,
  sourceId: UuidV7Schema,
  receivingId: UuidV7Schema.nullable(),
  supplierReturnId: UuidV7Schema.nullable(),
  paymentMethod: PaymentMethodSchema.nullable(),
  providerRef: z.string().nullable(),
  cashMoveId: UuidV7Schema.nullable(),
  dueAtMs: BigIntStringSchema.nullable(),
  reason: z.string().nullable(),
  createdByUserId: UuidV7Schema,
  createdAtMs: BigIntStringSchema,
});
export type SupplierLedgerEntryDto = z.infer<typeof SupplierLedgerEntryDtoSchema>;

export const SupplierLedgerResponseSchema = z.strictObject({
  supplierId: UuidV7Schema,
  currentBalance: SignedBigIntStringSchema,
  items: z.array(SupplierLedgerEntryDtoSchema),
  total: z.number().int().nonnegative(),
  limit: z.number().int().positive(),
  offset: z.number().int().nonnegative(),
});
export type SupplierLedgerResponseDto = z.infer<typeof SupplierLedgerResponseSchema>;

export const CreateSupplierOpeningBalanceRequestSchema = z.strictObject({
  clientRequestId: UuidV7Schema,
  amount: PositiveBoundedMoneyStringSchema,
  reason: MandatoryLedgerReasonSchema,
  dueDays: SupplierDueDaysSchema.optional(),
});
export type CreateSupplierOpeningBalanceRequestDto = z.infer<
  typeof CreateSupplierOpeningBalanceRequestSchema
>;

export const SupplierPaymentMethodSchema = z.enum([
  'cash',
  'card',
  'uzqr',
  'payme',
  'click',
  'uzum',
  'other',
]);

export const CreateSupplierPaymentRequestSchema = z
  .strictObject({
    clientRequestId: UuidV7Schema,
    method: SupplierPaymentMethodSchema,
    amount: PositiveBoundedMoneyStringSchema,
    providerRef: z.string().trim().max(128).nullable().optional(),
    reason: z
      .string()
      .transform((val) => val.trim())
      .refine((val) => val.length <= 500, 'Reason must not exceed 500 characters')
      .transform((val) => (val.length === 0 ? null : val))
      .nullable()
      .optional(),
  })
  .superRefine((val, ctx) => {
    if (
      val.method === 'cash' &&
      val.providerRef !== undefined &&
      val.providerRef !== null &&
      val.providerRef.trim().length > 0
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['providerRef'],
        message: 'Cash supplier payment must not carry a providerRef',
      });
    }
  });
export type CreateSupplierPaymentRequestDto = z.infer<typeof CreateSupplierPaymentRequestSchema>;

export const CreateSupplierAdjustmentRequestSchema = z.strictObject({
  clientRequestId: UuidV7Schema,
  amountDelta: SignedBoundedMoneyStringSchema.refine(
    (val) => BigInt(val) !== 0n,
    'amountDelta must be non-zero',
  ),
  reason: MandatoryLedgerReasonSchema,
  dueDays: SupplierDueDaysSchema.optional(),
});
export type CreateSupplierAdjustmentRequestDto = z.infer<
  typeof CreateSupplierAdjustmentRequestSchema
>;

export const SupplierLedgerMutationResponseSchema = z.strictObject({
  supplier: SupplierSummaryDtoSchema,
  entry: SupplierLedgerEntryDtoSchema,
  cashMove: CashMoveDtoSchema.nullable(),
  idempotentReplay: z.boolean(),
});
export type SupplierLedgerMutationResponseDto = z.infer<
  typeof SupplierLedgerMutationResponseSchema
>;
