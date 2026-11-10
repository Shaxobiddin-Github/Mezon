import { MAX_PROVIDER_REF_LENGTH, MAX_RETURN_REASON_LENGTH } from '@mezon/domain';
import { z } from 'zod';
import { BigIntStringSchema, LoginRequestSchema, UuidV7Schema } from './auth.js';
import {
  CartLineKindSchema,
  ManualDiscountModeSchema,
  PositiveBigIntStringSchema,
} from './cart.js';
import { ProductUnitSchema } from './catalog.js';
import {
  BoundedMoneyStringSchema,
  NonCashPaymentMethodSchema,
  PaymentMethodSchema,
  PositiveBoundedMoneyStringSchema,
  SaleLineDtoSchema,
  SalePaymentDtoSchema,
} from './sale.js';
import { SignedBigIntStringSchema } from './stock.js';

export const SaleIdParamsSchema = z.strictObject({
  id: UuidV7Schema,
});
export type SaleIdParamsDto = z.infer<typeof SaleIdParamsSchema>;

export const ReturnIdParamsSchema = z.strictObject({
  id: UuidV7Schema,
});
export type ReturnIdParamsDto = z.infer<typeof ReturnIdParamsSchema>;

export const MandatoryReturnReasonSchema = z
  .string()
  .transform((val) => val.trim())
  .refine((val) => val.length >= 1, 'Reason must not be empty')
  .refine(
    (val) => val.length <= MAX_RETURN_REASON_LENGTH,
    `Reason must not exceed ${String(MAX_RETURN_REASON_LENGTH)} characters`,
  );

export const VoidSaleRequestSchema = z.strictObject({
  clientRequestId: UuidV7Schema,
  reason: MandatoryReturnReasonSchema,
  override: LoginRequestSchema.optional(),
});
export type VoidSaleRequestDto = z.infer<typeof VoidSaleRequestSchema>;

const ReturnProviderRefInputSchema = z
  .string()
  .transform((val) => val.trim())
  .refine(
    (val) => val.length <= MAX_PROVIDER_REF_LENGTH,
    `providerRef must not exceed ${String(MAX_PROVIDER_REF_LENGTH)} characters`,
  )
  .transform((val) => (val.length === 0 ? null : val))
  .nullable()
  .optional();

export const ReturnCashPaymentInputSchema = z.strictObject({
  method: z.literal('cash'),
  amount: PositiveBoundedMoneyStringSchema,
});
export type ReturnCashPaymentInputDto = z.infer<typeof ReturnCashPaymentInputSchema>;

export const ReturnNonCashPaymentInputSchema = z.strictObject({
  method: NonCashPaymentMethodSchema,
  amount: PositiveBoundedMoneyStringSchema,
  providerRef: ReturnProviderRefInputSchema,
});
export type ReturnNonCashPaymentInputDto = z.infer<typeof ReturnNonCashPaymentInputSchema>;

export const ReturnPaymentInputSchema = z.union([
  ReturnCashPaymentInputSchema,
  ReturnNonCashPaymentInputSchema,
]);
export type ReturnPaymentInputDto = z.infer<typeof ReturnPaymentInputSchema>;

export const ReturnLineInputSchema = z.strictObject({
  saleLineId: UuidV7Schema,
  qty: PositiveBigIntStringSchema,
});
export type ReturnLineInputDto = z.infer<typeof ReturnLineInputSchema>;

export const CreateReturnRequestSchema = z
  .strictObject({
    clientRequestId: UuidV7Schema,
    reason: MandatoryReturnReasonSchema,
    items: z
      .array(ReturnLineInputSchema)
      .min(1, 'At least one sale line item is required for a return')
      .max(200, 'At most 200 items may be returned in a single document'),
    payments: z
      .array(ReturnPaymentInputSchema)
      .max(64, 'At most 64 refund payment lines may be attached to one return'),
    debtOffsetAmount: BoundedMoneyStringSchema.optional(),
    override: LoginRequestSchema.optional(),
  })
  .superRefine((val, ctx) => {
    const seenLineIds = new Set<string>();
    for (let i = 0; i < val.items.length; i += 1) {
      const lineId = val.items[i].saleLineId;
      if (seenLineIds.has(lineId)) {
        ctx.addIssue({
          code: 'custom',
          path: ['items', i, 'saleLineId'],
          message: 'Duplicate saleLineId in return request is not allowed',
        });
      }
      seenLineIds.add(lineId);
    }

    let cashCount = 0;
    for (let i = 0; i < val.payments.length; i += 1) {
      if (val.payments[i]?.method === 'cash') {
        cashCount += 1;
        if (cashCount > 1) {
          ctx.addIssue({
            code: 'custom',
            path: ['payments', i, 'method'],
            message: 'At most one cash refund row is allowed per return',
          });
        }
      }
    }
  });
export type CreateReturnRequestDto = z.infer<typeof CreateReturnRequestSchema>;

/**
 * Cashier/POS-safe return line snapshot DTO (`costValue` and profit STRICTLY omitted per GEMINI.md 3.4).
 */
export const ReturnLineDtoSchema = z.strictObject({
  id: UuidV7Schema,
  returnId: UuidV7Schema,
  saleId: UuidV7Schema,
  saleLineId: UuidV7Schema,
  sortOrder: z.number().int(),
  lineKind: CartLineKindSchema,
  productId: UuidV7Schema.nullable(),
  variantId: UuidV7Schema.nullable(),
  itemName: z.string(),
  unit: ProductUnitSchema,
  qty: PositiveBigIntStringSchema,
  unitPriceSnapshot: BigIntStringSchema,
  vatRateBpSnapshot: z.number().int(),
  mxikSnapshot: z.string().nullable(),
  packageCodeSnapshot: z.string().nullable(),
  refundAmount: BigIntStringSchema,
  netExVat: BigIntStringSchema,
  vatTotal: BigIntStringSchema,
});
export type ReturnLineDto = z.infer<typeof ReturnLineDtoSchema>;

export const ReturnPaymentDtoSchema = z.strictObject({
  id: UuidV7Schema,
  method: PaymentMethodSchema,
  amount: BigIntStringSchema,
  providerRef: z.string().nullable(),
  createdAtMs: BigIntStringSchema,
});
export type ReturnPaymentDto = z.infer<typeof ReturnPaymentDtoSchema>;

export const ReturnDtoSchema = z.strictObject({
  id: UuidV7Schema,
  returnNo: PositiveBigIntStringSchema,
  returnCode: z.string(),
  organizationId: UuidV7Schema,
  storeId: UuidV7Schema,
  deviceId: UuidV7Schema,
  saleId: UuidV7Schema,
  processedByUserId: UuidV7Schema,
  overrideApprovedByUserId: UuidV7Schema.nullable(),
  overrideApprovedAtMs: BigIntStringSchema.nullable(),
  reason: z.string(),
  clientRequestId: UuidV7Schema,
  totalRefund: BigIntStringSchema,
  totalNetExVat: BigIntStringSchema,
  totalVat: BigIntStringSchema,
  cashRefundAmount: BigIntStringSchema,
  nonCashRefundAmount: BigIntStringSchema,
  debtOffsetAmount: BigIntStringSchema,
  createdAtMs: BigIntStringSchema,
  lines: z.array(ReturnLineDtoSchema),
  payments: z.array(ReturnPaymentDtoSchema),
});
export type ReturnDto = z.infer<typeof ReturnDtoSchema>;

export const VoidedSaleDtoSchema = z.strictObject({
  id: UuidV7Schema,
  receiptNo: PositiveBigIntStringSchema,
  receiptCode: z.string(),
  organizationId: UuidV7Schema,
  storeId: UuidV7Schema,
  deviceId: UuidV7Schema,
  sourceCartId: UuidV7Schema.nullable(),
  cashierUserId: UuidV7Schema,
  completedByUserId: UuidV7Schema,
  customerId: UuidV7Schema.nullable(),
  shiftId: UuidV7Schema.nullable(),
  clientRequestId: UuidV7Schema,
  status: z.literal('voided'),
  subtotalGross: BigIntStringSchema,
  totalPromoDiscount: BigIntStringSchema,
  subtotalAfterPromo: BigIntStringSchema,
  manualDiscountMode: ManualDiscountModeSchema,
  manualDiscountValue: BigIntStringSchema,
  manualDiscountReason: z.string().nullable(),
  orderDiscountAmount: BigIntStringSchema,
  totalFinal: BigIntStringSchema,
  totalNetExVat: BigIntStringSchema,
  totalVat: BigIntStringSchema,
  totalPaid: BigIntStringSchema,
  debtAmount: BigIntStringSchema,
  changeAmount: BigIntStringSchema,
  overrideApprovedByUserId: UuidV7Schema.nullable(),
  overrideApprovedAmount: BigIntStringSchema.nullable(),
  overrideApprovedAtMs: BigIntStringSchema.nullable(),
  createdAtMs: BigIntStringSchema,
  voidedAtMs: BigIntStringSchema,
  voidedByUserId: UuidV7Schema,
  voidReason: z.string(),
  lines: z.array(SaleLineDtoSchema),
  payments: z.array(SalePaymentDtoSchema),
});
export type VoidedSaleDto = z.infer<typeof VoidedSaleDtoSchema>;

export const VoidSaleResponseSchema = z.strictObject({
  sale: VoidedSaleDtoSchema,
  cashRefundAmount: BoundedMoneyStringSchema,
  idempotentReplay: z.boolean(),
});
export type VoidSaleResponseDto = z.infer<typeof VoidSaleResponseSchema>;

export const CreateReturnResponseSchema = z.strictObject({
  returnDoc: ReturnDtoSchema,
  idempotentReplay: z.boolean(),
});
export type CreateReturnResponseDto = z.infer<typeof CreateReturnResponseSchema>;

export const ListSaleReturnsResponseSchema = z.strictObject({
  returns: z.array(ReturnDtoSchema),
});
export type ListSaleReturnsResponseDto = z.infer<typeof ListSaleReturnsResponseSchema>;

export const SalesLinesReportQuerySchema = z.strictObject({
  fromMs: BigIntStringSchema.optional(),
  toMs: BigIntStringSchema.optional(),
});
export type SalesLinesReportQueryDto = z.infer<typeof SalesLinesReportQuerySchema>;

/**
 * Owner-only summary computed strictly from unified signed view `v_sales_lines`.
 * Inaccessible to cashier and manager roles (`reports:profit` required).
 */
export const SalesLinesReportSummarySchema = z.strictObject({
  lineCount: z.number().int(),
  signedQtyTotal: SignedBigIntStringSchema,
  revenue: SignedBigIntStringSchema,
  netRevenue: SignedBigIntStringSchema,
  vatTotal: SignedBigIntStringSchema,
  costValue: SignedBigIntStringSchema,
  grossProfit: SignedBigIntStringSchema,
});
export type SalesLinesReportSummaryDto = z.infer<typeof SalesLinesReportSummarySchema>;
