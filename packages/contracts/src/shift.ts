import {
  BUSINESS_DATE_REGEX,
  CASHIER_SESSION_STATUSES,
  DAY_CLOSE_FISCAL_STATUSES,
  DomainError,
  SHIFT_CASH_MOVE_TYPES,
  SHIFT_EXPENSE_CATEGORIES,
  SHIFT_STATUSES,
  assertValidBusinessDate,
} from '@mezon/domain';
import { z } from 'zod';
import { BigIntStringSchema, LoginRequestSchema, UuidV7Schema } from './auth.js';
import { PositiveBigIntStringSchema } from './cart.js';
import {
  BoundedMoneyStringSchema,
  CashMoveDtoSchema,
  PositiveBoundedMoneyStringSchema,
  SalePaymentMethodSchema,
} from './sale.js';
import { SignedBigIntStringSchema } from './stock.js';

export const MAX_SHIFT_REASON_LENGTH = 500;
export const MAX_SHIFT_NOTE_LENGTH = 500;

export const ShiftStatusSchema = z.enum(SHIFT_STATUSES);
export const CashierSessionStatusSchema = z.enum(CASHIER_SESSION_STATUSES);
export const ShiftCashMoveTypeSchema = z.enum(SHIFT_CASH_MOVE_TYPES);
export const ShiftExpenseCategorySchema = z.enum(SHIFT_EXPENSE_CATEGORIES);
export const DayCloseFiscalStatusSchema = z.enum(DAY_CLOSE_FISCAL_STATUSES);

export const ShiftIdParamsSchema = z.strictObject({
  id: UuidV7Schema,
});
export type ShiftIdParamsDto = z.infer<typeof ShiftIdParamsSchema>;

export const BusinessDateSchema = z
  .string()
  .transform((val) => val.trim())
  .refine((val) => BUSINESS_DATE_REGEX.test(val), 'businessDate must match YYYY-MM-DD')
  .transform((val, ctx): string => {
    try {
      return assertValidBusinessDate(val);
    } catch (err) {
      ctx.addIssue({
        code: 'custom',
        message: err instanceof DomainError ? err.message : 'Invalid businessDate',
      });
      return z.NEVER;
    }
  });

export const MandatoryShiftReasonSchema = z
  .string()
  .transform((val) => val.trim())
  .refine((val) => val.length >= 1, 'Reason must not be empty')
  .refine(
    (val) => val.length <= MAX_SHIFT_REASON_LENGTH,
    `Reason must not exceed ${String(MAX_SHIFT_REASON_LENGTH)} characters`,
  );

export const OptionalShiftNoteSchema = z
  .string()
  .transform((val) => val.trim())
  .refine(
    (val) => val.length <= MAX_SHIFT_NOTE_LENGTH,
    `Note must not exceed ${String(MAX_SHIFT_NOTE_LENGTH)} characters`,
  )
  .transform((val) => (val.length === 0 ? null : val))
  .nullable();

export const CashDenominationCountInputSchema = z.strictObject({
  nominal: PositiveBoundedMoneyStringSchema,
  count: z.number().int().min(0).max(1_000_000),
});
export type CashDenominationCountInputDto = z.infer<typeof CashDenominationCountInputSchema>;

export const DenominationListSchema = z
  .array(CashDenominationCountInputSchema)
  .min(1, 'Denomination breakdown must contain at least one entry when provided')
  .max(64, 'Denomination breakdown must not exceed 64 entries');

export const OpenShiftRequestSchema = z.strictObject({
  clientRequestId: UuidV7Schema,
  openingCash: BoundedMoneyStringSchema,
  denominations: DenominationListSchema.optional(),
  openingDiscrepancyReason: MandatoryShiftReasonSchema.optional(),
  note: OptionalShiftNoteSchema.optional(),
});
export type OpenShiftRequestDto = z.infer<typeof OpenShiftRequestSchema>;

/**
 * STRICT: zero manual non-cash totals accepted (`card`, `uzqr`, `payme`, `click`, etc. rejected 400).
 */
export const HandoffCashierRequestSchema = z.strictObject({
  clientRequestId: UuidV7Schema,
  nextCashierUserId: UuidV7Schema,
  countedCash: BoundedMoneyStringSchema,
  denominations: DenominationListSchema.optional(),
  discrepancyReason: MandatoryShiftReasonSchema.optional(),
  override: LoginRequestSchema.optional(),
  note: OptionalShiftNoteSchema.optional(),
});
export type HandoffCashierRequestDto = z.infer<typeof HandoffCashierRequestSchema>;

/**
 * STRICT: zero manual non-cash totals accepted (`card`, `uzqr`, `payme`, `click`, etc. rejected 400).
 */
export const CloseShiftRequestSchema = z.strictObject({
  clientRequestId: UuidV7Schema,
  countedCash: BoundedMoneyStringSchema,
  denominations: DenominationListSchema.optional(),
  discrepancyReason: MandatoryShiftReasonSchema.optional(),
  override: LoginRequestSchema.optional(),
  note: OptionalShiftNoteSchema.optional(),
});
export type CloseShiftRequestDto = z.infer<typeof CloseShiftRequestSchema>;

/**
 * STRICT: append-only shift reclose accepts ONLY cash recount + reason + optional supervisor PIN override.
 */
export const RecloseShiftRequestSchema = z.strictObject({
  clientRequestId: UuidV7Schema,
  countedCash: BoundedMoneyStringSchema,
  denominations: DenominationListSchema.optional(),
  reason: MandatoryShiftReasonSchema,
  override: LoginRequestSchema.optional(),
});
export type RecloseShiftRequestDto = z.infer<typeof RecloseShiftRequestSchema>;

export const CreateShiftCashMoveRequestSchema = z
  .strictObject({
    clientRequestId: UuidV7Schema,
    type: ShiftCashMoveTypeSchema,
    amount: PositiveBoundedMoneyStringSchema,
    reason: MandatoryShiftReasonSchema,
    expenseCategory: ShiftExpenseCategorySchema.optional(),
  })
  .superRefine((val, ctx) => {
    if (val.type !== 'cash_out' && val.expenseCategory !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['expenseCategory'],
        message: 'expenseCategory is only valid when type is cash_out',
      });
    }
  });
export type CreateShiftCashMoveRequestDto = z.infer<typeof CreateShiftCashMoveRequestSchema>;

export const CloseBusinessDayRequestSchema = z.strictObject({
  clientRequestId: UuidV7Schema,
  businessDate: BusinessDateSchema,
  note: OptionalShiftNoteSchema.optional(),
});
export type CloseBusinessDayRequestDto = z.infer<typeof CloseBusinessDayRequestSchema>;

export const UpdateShiftSettingsRequestSchema = z.strictObject({
  maxCashDiscrepancyWithoutOverride: BoundedMoneyStringSchema,
});
export type UpdateShiftSettingsRequestDto = z.infer<typeof UpdateShiftSettingsRequestSchema>;

export const ShiftListQuerySchema = z.strictObject({
  status: ShiftStatusSchema.optional(),
  deviceId: UuidV7Schema.optional(),
  fromDate: BusinessDateSchema.optional(),
  toDate: BusinessDateSchema.optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  offset: z.coerce.number().int().min(0).max(100_000).optional(),
});
export type ShiftListQueryDto = z.infer<typeof ShiftListQuerySchema>;

export const DayCloseListQuerySchema = z.strictObject({
  businessDate: BusinessDateSchema.optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  offset: z.coerce.number().int().min(0).max(100_000).optional(),
});
export type DayCloseListQueryDto = z.infer<typeof DayCloseListQuerySchema>;

export const ShiftCashierSessionDtoSchema = z.strictObject({
  id: UuidV7Schema,
  shiftId: UuidV7Schema,
  sessionSeq: z.number().int().min(1),
  cashierUserId: UuidV7Schema,
  status: CashierSessionStatusSchema,
  openingFloat: BigIntStringSchema,
  expectedCash: BigIntStringSchema.nullable(),
  countedCash: BigIntStringSchema.nullable(),
  discrepancy: SignedBigIntStringSchema.nullable(),
  discrepancyReason: z.string().nullable(),
  denominationsJson: z.string().nullable(),
  overrideApprovedByUserId: UuidV7Schema.nullable(),
  handedOffByUserId: UuidV7Schema.nullable(),
  note: z.string().nullable(),
  startedAtMs: BigIntStringSchema,
  endedAtMs: BigIntStringSchema.nullable(),
});
export type ShiftCashierSessionDto = z.infer<typeof ShiftCashierSessionDtoSchema>;

export const ShiftDtoSchema = z.strictObject({
  id: UuidV7Schema,
  organizationId: UuidV7Schema,
  storeId: UuidV7Schema,
  deviceId: UuidV7Schema,
  shiftNo: PositiveBigIntStringSchema,
  shiftCode: z.string(),
  status: ShiftStatusSchema,
  openedByUserId: UuidV7Schema,
  closedByUserId: UuidV7Schema.nullable(),
  openingCash: BigIntStringSchema,
  previousCloseCash: BigIntStringSchema.nullable(),
  openingDiscrepancy: SignedBigIntStringSchema,
  openingDiscrepancyReason: z.string().nullable(),
  openingNote: z.string().nullable(),
  closingNote: z.string().nullable(),
  openedAtMs: BigIntStringSchema,
  closedAtMs: BigIntStringSchema.nullable(),
  activeCashierSession: ShiftCashierSessionDtoSchema.nullable(),
  cashierSessions: z.array(ShiftCashierSessionDtoSchema),
});
export type ShiftDto = z.infer<typeof ShiftDtoSchema>;

export const ShiftClosureMethodSchema = z.union([SalePaymentMethodSchema, z.literal('debt')]);

export const ShiftClosureMethodTotalDtoSchema = z.strictObject({
  method: ShiftClosureMethodSchema,
  salesAmount: BigIntStringSchema,
  returnsAmount: BigIntStringSchema,
  netAmount: SignedBigIntStringSchema,
});
export type ShiftClosureMethodTotalDto = z.infer<typeof ShiftClosureMethodTotalDtoSchema>;

export const ShiftClosureCashierDtoSchema = z.strictObject({
  sessionId: UuidV7Schema,
  cashierUserId: UuidV7Schema,
  cashierUsername: z.string().nullable(),
  cashierFullName: z.string().nullable(),
  sessionSeq: z.number().int().min(1),
  openingFloat: BigIntStringSchema,
  expectedCash: BigIntStringSchema,
  countedCash: BigIntStringSchema,
  discrepancy: SignedBigIntStringSchema,
  salesCount: z.number().int().min(0),
  returnsCount: z.number().int().min(0),
  salesTotal: BigIntStringSchema,
  returnsTotal: BigIntStringSchema,
  cashInTotal: BigIntStringSchema,
  cashOutTotal: BigIntStringSchema,
});
export type ShiftClosureCashierDto = z.infer<typeof ShiftClosureCashierDtoSchema>;

export const ShiftClosureDtoSchema = z.strictObject({
  id: UuidV7Schema,
  shiftId: UuidV7Schema,
  closureSeq: z.number().int().min(1),
  isReclose: z.boolean(),
  reason: z.string().nullable(),
  closedByUserId: UuidV7Schema,
  overrideApprovedByUserId: UuidV7Schema.nullable(),
  expectedCash: BigIntStringSchema,
  countedCash: BigIntStringSchema,
  discrepancy: SignedBigIntStringSchema,
  denominationsJson: z.string().nullable(),
  salesCount: z.number().int().min(0),
  returnsCount: z.number().int().min(0),
  voidsCount: z.number().int().min(0),
  grossSalesTotal: BigIntStringSchema,
  returnsTotal: BigIntStringSchema,
  netSalesTotal: BigIntStringSchema,
  orderAdvanceCashTotal: BigIntStringSchema,
  orderAdvanceNonCashTotal: BigIntStringSchema,
  orderAdvanceRefundTotal: BigIntStringSchema,
  createdAtMs: BigIntStringSchema,
  methodTotals: z.array(ShiftClosureMethodTotalDtoSchema),
  cashiers: z.array(ShiftClosureCashierDtoSchema),
});
export type ShiftClosureDto = z.infer<typeof ShiftClosureDtoSchema>;

export const DayCloseDtoSchema = z.strictObject({
  id: UuidV7Schema,
  organizationId: UuidV7Schema,
  storeId: UuidV7Schema,
  businessDate: z.string(),
  closeSeq: z.number().int().min(1),
  closeCode: z.string(),
  closedByUserId: UuidV7Schema,
  note: z.string().nullable(),
  shiftsCount: z.number().int().min(0),
  salesCount: z.number().int().min(0),
  returnsCount: z.number().int().min(0),
  voidsCount: z.number().int().min(0),
  grossSalesTotal: BigIntStringSchema,
  returnsTotal: BigIntStringSchema,
  netSalesTotal: BigIntStringSchema,
  expectedCashTotal: BigIntStringSchema,
  countedCashTotal: BigIntStringSchema,
  discrepancyTotal: SignedBigIntStringSchema,
  methodTotals: z.array(ShiftClosureMethodTotalDtoSchema),
  fiscalStatus: DayCloseFiscalStatusSchema,
  fiscalReportNo: z.string().nullable(),
  isStale: z.boolean(),
  createdAtMs: BigIntStringSchema,
});
export type DayCloseDto = z.infer<typeof DayCloseDtoSchema>;

export const CurrentShiftResponseSchema = z.strictObject({
  shift: ShiftDtoSchema.nullable(),
  drawerCashBalance: BigIntStringSchema,
  maxCashDiscrepancyWithoutOverride: BigIntStringSchema,
});
export type CurrentShiftResponseDto = z.infer<typeof CurrentShiftResponseSchema>;

export const OpenShiftResponseSchema = z.strictObject({
  shift: ShiftDtoSchema,
  drawerCashBalance: BigIntStringSchema,
  idempotentReplay: z.boolean(),
});
export type OpenShiftResponseDto = z.infer<typeof OpenShiftResponseSchema>;

export const HandoffCashierResponseSchema = z.strictObject({
  shift: ShiftDtoSchema,
  closedSession: ShiftCashierSessionDtoSchema,
  activeSession: ShiftCashierSessionDtoSchema,
  drawerCashBalance: BigIntStringSchema,
  idempotentReplay: z.boolean(),
});
export type HandoffCashierResponseDto = z.infer<typeof HandoffCashierResponseSchema>;

export const CloseShiftResponseSchema = z.strictObject({
  shift: ShiftDtoSchema,
  closure: ShiftClosureDtoSchema,
  drawerCashBalance: BigIntStringSchema,
  idempotentReplay: z.boolean(),
});
export type CloseShiftResponseDto = z.infer<typeof CloseShiftResponseSchema>;

export const ShiftDetailResponseSchema = z.strictObject({
  shift: ShiftDtoSchema,
  closures: z.array(ShiftClosureDtoSchema),
  cashMoves: z.array(CashMoveDtoSchema),
});
export type ShiftDetailResponseDto = z.infer<typeof ShiftDetailResponseSchema>;

export const ShiftListResponseSchema = z.strictObject({
  shifts: z.array(ShiftDtoSchema),
  total: z.number().int().min(0),
});
export type ShiftListResponseDto = z.infer<typeof ShiftListResponseSchema>;

export const ShiftCashMoveResponseSchema = z.strictObject({
  cashMove: CashMoveDtoSchema,
  drawerCashBalance: BigIntStringSchema,
  idempotentReplay: z.boolean(),
});
export type ShiftCashMoveResponseDto = z.infer<typeof ShiftCashMoveResponseSchema>;

export const CloseBusinessDayResponseSchema = z.strictObject({
  dayClose: DayCloseDtoSchema,
  idempotentReplay: z.boolean(),
});
export type CloseBusinessDayResponseDto = z.infer<typeof CloseBusinessDayResponseSchema>;

export const DayCloseListResponseSchema = z.strictObject({
  dayCloses: z.array(DayCloseDtoSchema),
  total: z.number().int().min(0),
});
export type DayCloseListResponseDto = z.infer<typeof DayCloseListResponseSchema>;

export const UpdateShiftSettingsResponseSchema = z.strictObject({
  maxCashDiscrepancyWithoutOverride: BigIntStringSchema,
});
export type UpdateShiftSettingsResponseDto = z.infer<typeof UpdateShiftSettingsResponseSchema>;
