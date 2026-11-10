import {
  CUSTOMER_LEDGER_ENTRY_TYPES,
  CUSTOMER_LEDGER_SOURCE_TYPES,
  DomainError,
  MAX_CUSTOMER_DUE_DAYS,
  MAX_LEDGER_REASON_LENGTH,
  MAX_MONEY_TIYIN,
  MAX_PROVIDER_REF_LENGTH,
  isSignedInt64Money,
  normalizeCustomerFullName,
  normalizeCustomerNote,
  normalizeCustomerPhone,
} from '@mezon/domain';
import { z } from 'zod';
import { BigIntStringSchema, UuidV7Schema } from './auth.js';
import {
  BoundedMoneyStringSchema,
  CashMoveDtoSchema,
  PaymentMethodSchema,
  PositiveBoundedMoneyStringSchema,
} from './sale.js';
import { SignedBigIntStringSchema } from './stock.js';

export const CustomerIdParamsSchema = z.strictObject({
  id: UuidV7Schema,
});
export type CustomerIdParamsDto = z.infer<typeof CustomerIdParamsSchema>;

export const CustomerFullNameSchema = z.string().transform((val, ctx): string => {
  try {
    return normalizeCustomerFullName(val);
  } catch (err) {
    ctx.addIssue({
      code: 'custom',
      message: err instanceof DomainError ? err.message : 'Invalid customer fullName',
    });
    return z.NEVER;
  }
});

export const CustomerPhoneInputSchema = z
  .string()
  .nullable()
  .transform((val, ctx): string | null => {
    try {
      const normalized = normalizeCustomerPhone(val);
      return normalized !== null ? normalized.phoneNormalized : null;
    } catch (err) {
      // Never echo the raw phone number back into Zod error message
      ctx.addIssue({
        code: 'custom',
        message: err instanceof DomainError ? err.message : 'Invalid customer phone format',
      });
      return z.NEVER;
    }
  });

export const CustomerNoteInputSchema = z
  .string()
  .nullable()
  .transform((val, ctx): string | null => {
    try {
      return normalizeCustomerNote(val);
    } catch (err) {
      ctx.addIssue({
        code: 'custom',
        message: err instanceof DomainError ? err.message : 'Invalid customer note',
      });
      return z.NEVER;
    }
  });

export const CustomerDueDaysSchema = z.number().int().min(1).max(MAX_CUSTOMER_DUE_DAYS).nullable();

export const CreateCustomerRequestSchema = z.strictObject({
  fullName: CustomerFullNameSchema,
  phone: CustomerPhoneInputSchema.optional(),
  creditLimit: BoundedMoneyStringSchema.nullable().optional(),
  defaultDueDays: CustomerDueDaysSchema.optional(),
  note: CustomerNoteInputSchema.optional(),
});
export type CreateCustomerRequestDto = z.infer<typeof CreateCustomerRequestSchema>;

export const UpdateCustomerRequestSchema = z
  .strictObject({
    fullName: CustomerFullNameSchema.optional(),
    phone: CustomerPhoneInputSchema.optional(),
    creditLimit: BoundedMoneyStringSchema.nullable().optional(),
    defaultDueDays: CustomerDueDaysSchema.optional(),
    note: CustomerNoteInputSchema.optional(),
    isActive: z.boolean().optional(),
  })
  .refine(
    (val) =>
      val.fullName !== undefined ||
      val.phone !== undefined ||
      val.creditLimit !== undefined ||
      val.defaultDueDays !== undefined ||
      val.note !== undefined ||
      val.isActive !== undefined,
    'At least one customer field must be provided for update',
  );
export type UpdateCustomerRequestDto = z.infer<typeof UpdateCustomerRequestSchema>;

export const CustomerListQuerySchema = z.strictObject({
  q: z.string().trim().max(120).optional(),
  overdueOnly: z.coerce.boolean().optional(),
  includeInactive: z.coerce.boolean().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  offset: z.coerce.number().int().min(0).max(1_000_000).optional(),
});
export type CustomerListQueryDto = z.infer<typeof CustomerListQuerySchema>;

export const CustomerLedgerEntryTypeSchema = z.enum(CUSTOMER_LEDGER_ENTRY_TYPES);
export const CustomerLedgerSourceTypeSchema = z.enum(CUSTOMER_LEDGER_SOURCE_TYPES);

export const CustomerSummaryDtoSchema = z.strictObject({
  id: UuidV7Schema,
  organizationId: UuidV7Schema,
  fullName: z.string(),
  phoneNormalized: z.string().nullable(),
  creditLimit: BigIntStringSchema.nullable(),
  defaultDueDays: z.number().int().nullable(),
  note: z.string().nullable(),
  isActive: z.boolean(),
  balance: BigIntStringSchema,
  totalDebtAccrued: BigIntStringSchema,
  totalSettled: BigIntStringSchema,
  overdueAmount: BigIntStringSchema,
  oldestOverdueDays: z.number().int().nonnegative(),
  lastActivityAtMs: BigIntStringSchema.nullable(),
  createdAtMs: BigIntStringSchema,
  updatedAtMs: BigIntStringSchema,
});
export type CustomerSummaryDto = z.infer<typeof CustomerSummaryDtoSchema>;

export const CustomerOpenObligationDtoSchema = z.strictObject({
  ledgerEntryId: UuidV7Schema,
  entryType: z.enum(['opening_balance', 'sale_debt', 'adjustment']),
  createdAtMs: BigIntStringSchema,
  saleId: UuidV7Schema.nullable(),
  dueAtMs: BigIntStringSchema.nullable(),
  initialDebt: BigIntStringSchema,
  remainingDebt: BigIntStringSchema,
  returnOffsetTotal: BigIntStringSchema,
  fifoPaidTotal: BigIntStringSchema,
  fifoWaivedTotal: BigIntStringSchema,
  isOverdue: z.boolean(),
  daysOverdue: z.number().int().nonnegative(),
});
export type CustomerOpenObligationDto = z.infer<typeof CustomerOpenObligationDtoSchema>;

export const CustomerDetailResponseSchema = z.strictObject({
  customer: CustomerSummaryDtoSchema,
  openObligations: z.array(CustomerOpenObligationDtoSchema),
});
export type CustomerDetailResponseDto = z.infer<typeof CustomerDetailResponseSchema>;

export const CustomerListResponseSchema = z.strictObject({
  items: z.array(CustomerSummaryDtoSchema),
  total: z.number().int().nonnegative(),
  limit: z.number().int().positive(),
  offset: z.number().int().nonnegative(),
});
export type CustomerListResponseDto = z.infer<typeof CustomerListResponseSchema>;

export const CustomerMutationResponseSchema = z.strictObject({
  customer: CustomerSummaryDtoSchema,
});
export type CustomerMutationResponseDto = z.infer<typeof CustomerMutationResponseSchema>;

export const ArchiveCustomerResponseSchema = z.strictObject({
  customerId: UuidV7Schema,
  deletedAtMs: BigIntStringSchema,
});
export type ArchiveCustomerResponseDto = z.infer<typeof ArchiveCustomerResponseSchema>;

export const CustomerLedgerQuerySchema = z.strictObject({
  limit: z.coerce.number().int().min(1).max(200).optional(),
  offset: z.coerce.number().int().min(0).max(5_000_000).optional(),
  order: z.enum(['asc', 'desc']).optional(),
  entryType: CustomerLedgerEntryTypeSchema.optional(),
});
export type CustomerLedgerQueryDto = z.infer<typeof CustomerLedgerQuerySchema>;

export const CustomerLedgerEntryDtoSchema = z.strictObject({
  id: UuidV7Schema,
  organizationId: UuidV7Schema,
  storeId: UuidV7Schema,
  deviceId: UuidV7Schema,
  customerId: UuidV7Schema,
  entryType: CustomerLedgerEntryTypeSchema,
  amountDelta: SignedBigIntStringSchema,
  balanceAfter: BigIntStringSchema,
  sourceType: CustomerLedgerSourceTypeSchema,
  sourceId: UuidV7Schema,
  saleId: UuidV7Schema.nullable(),
  paymentMethod: PaymentMethodSchema.nullable(),
  providerRef: z.string().nullable(),
  cashMoveId: UuidV7Schema.nullable(),
  dueAtMs: BigIntStringSchema.nullable(),
  reason: z.string().nullable(),
  createdByUserId: UuidV7Schema,
  overrideApprovedByUserId: UuidV7Schema.nullable(),
  createdAtMs: BigIntStringSchema,
});
export type CustomerLedgerEntryDto = z.infer<typeof CustomerLedgerEntryDtoSchema>;

export const CustomerLedgerResponseSchema = z.strictObject({
  customerId: UuidV7Schema,
  currentBalance: BigIntStringSchema,
  items: z.array(CustomerLedgerEntryDtoSchema),
  total: z.number().int().nonnegative(),
  limit: z.number().int().positive(),
  offset: z.number().int().nonnegative(),
});
export type CustomerLedgerResponseDto = z.infer<typeof CustomerLedgerResponseSchema>;

export const MandatoryLedgerReasonSchema = z
  .string()
  .transform((val) => val.trim())
  .refine((val) => val.length >= 1, 'Reason must not be empty')
  .refine(
    (val) => val.length <= MAX_LEDGER_REASON_LENGTH,
    `Reason must not exceed ${String(MAX_LEDGER_REASON_LENGTH)} characters`,
  );

const OptionalLedgerReasonSchema = z
  .string()
  .transform((val) => val.trim())
  .refine(
    (val) => val.length <= MAX_LEDGER_REASON_LENGTH,
    `Reason must not exceed ${String(MAX_LEDGER_REASON_LENGTH)} characters`,
  )
  .transform((val) => (val.length === 0 ? null : val))
  .nullable()
  .optional();

const DebtProviderRefInputSchema = z
  .string()
  .transform((val) => val.trim())
  .refine(
    (val) => val.length <= MAX_PROVIDER_REF_LENGTH,
    `providerRef must not exceed ${String(MAX_PROVIDER_REF_LENGTH)} characters`,
  )
  .transform((val) => (val.length === 0 ? null : val))
  .nullable()
  .optional();

export const CreateOpeningBalanceRequestSchema = z.strictObject({
  clientRequestId: UuidV7Schema,
  amount: PositiveBoundedMoneyStringSchema,
  reason: MandatoryLedgerReasonSchema,
  dueDays: CustomerDueDaysSchema.optional(),
});
export type CreateOpeningBalanceRequestDto = z.infer<typeof CreateOpeningBalanceRequestSchema>;

export const CreateDebtPaymentRequestSchema = z
  .strictObject({
    clientRequestId: UuidV7Schema,
    method: PaymentMethodSchema,
    amount: PositiveBoundedMoneyStringSchema,
    providerRef: DebtProviderRefInputSchema,
    reason: OptionalLedgerReasonSchema,
  })
  .superRefine((val, ctx) => {
    if (
      val.method === 'cash' &&
      val.providerRef !== undefined &&
      val.providerRef !== null &&
      val.providerRef.length > 0
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['providerRef'],
        message: 'Cash debt payment must not carry a providerRef',
      });
    }
  });
export type CreateDebtPaymentRequestDto = z.infer<typeof CreateDebtPaymentRequestSchema>;

export const SignedBoundedMoneyStringSchema = SignedBigIntStringSchema.refine(
  (val) => isSignedInt64Money(BigInt(val)),
  `Amount must be within signed 64-bit bounds (-${MAX_MONEY_TIYIN.toString()}..${MAX_MONEY_TIYIN.toString()})`,
);

export const CreateDebtAdjustmentRequestSchema = z.strictObject({
  clientRequestId: UuidV7Schema,
  amountDelta: SignedBoundedMoneyStringSchema.refine(
    (val) => BigInt(val) !== 0n,
    'amountDelta must be non-zero',
  ),
  reason: MandatoryLedgerReasonSchema,
  dueDays: CustomerDueDaysSchema.optional(),
});
export type CreateDebtAdjustmentRequestDto = z.infer<typeof CreateDebtAdjustmentRequestSchema>;

export const CustomerLedgerMutationResponseSchema = z.strictObject({
  customer: CustomerSummaryDtoSchema,
  entry: CustomerLedgerEntryDtoSchema,
  cashMove: CashMoveDtoSchema.nullable(),
  idempotentReplay: z.boolean(),
});
export type CustomerLedgerMutationResponseDto = z.infer<
  typeof CustomerLedgerMutationResponseSchema
>;
