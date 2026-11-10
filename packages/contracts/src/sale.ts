import {
  CASH_MOVE_TYPES,
  MAX_MONEY_TIYIN,
  MAX_PROVIDER_REF_LENGTH,
  PAYMENT_METHODS,
} from '@mezon/domain';
import { z } from 'zod';
import { BigIntStringSchema, UuidV7Schema } from './auth.js';
import {
  CartLineKindSchema,
  ManualDiscountModeSchema,
  PositiveBigIntStringSchema,
} from './cart.js';
import { ProductUnitSchema } from './catalog.js';
import { SignedBigIntStringSchema } from './stock.js';

export const PaymentMethodSchema = z.enum(PAYMENT_METHODS);

export const NonCashPaymentMethodSchema = z.enum([
  'card',
  'uzqr',
  'payme',
  'click',
  'uzum',
  'social_card',
  'other',
]);

export const CashMoveTypeSchema = z.enum(CASH_MOVE_TYPES);

/**
 * Non-negative money string bounded to signed 64-bit SQL integer max (`<= MAX_MONEY_TIYIN`).
 */
export const BoundedMoneyStringSchema = BigIntStringSchema.refine(
  (val) => BigInt(val) <= MAX_MONEY_TIYIN,
  `Amount must not exceed ${MAX_MONEY_TIYIN.toString()} tiyin`,
);

/**
 * Strictly positive money string bounded `[1, MAX_MONEY_TIYIN]`.
 */
export const PositiveBoundedMoneyStringSchema = BigIntStringSchema.refine((val) => {
  const n = BigInt(val);
  return n >= 1n && n <= MAX_MONEY_TIYIN;
}, `Amount must be between 1 and ${MAX_MONEY_TIYIN.toString()} tiyin`);

export const CashSalePaymentInputSchema = z.strictObject({
  method: z.literal('cash'),
  tenderedAmount: PositiveBoundedMoneyStringSchema,
  amount: PositiveBoundedMoneyStringSchema.optional(),
});
export type CashSalePaymentInputDto = z.infer<typeof CashSalePaymentInputSchema>;

const ProviderRefInputSchema = z
  .string()
  .transform((val) => val.trim())
  .refine(
    (val) => val.length <= MAX_PROVIDER_REF_LENGTH,
    `providerRef must not exceed ${String(MAX_PROVIDER_REF_LENGTH)} characters`,
  )
  .transform((val) => (val.length === 0 ? null : val))
  .nullable()
  .optional();

export const NonCashSalePaymentInputSchema = z.strictObject({
  method: NonCashPaymentMethodSchema,
  amount: PositiveBoundedMoneyStringSchema,
  providerRef: ProviderRefInputSchema,
});
export type NonCashSalePaymentInputDto = z.infer<typeof NonCashSalePaymentInputSchema>;

export const SalePaymentInputSchema = z.union([
  CashSalePaymentInputSchema,
  NonCashSalePaymentInputSchema,
]);
export type SalePaymentInputDto = z.infer<typeof SalePaymentInputSchema>;

export const CompleteSaleRequestSchema = z
  .strictObject({
    clientRequestId: UuidV7Schema,
    expectedTotal: BoundedMoneyStringSchema,
    debtAmount: BoundedMoneyStringSchema.optional(),
    customerId: UuidV7Schema.nullable().optional(),
    payments: z
      .array(SalePaymentInputSchema)
      .max(64, 'At most 64 payment lines may be attached to one sale'),
  })
  .superRefine((val, ctx) => {
    let cashCount = 0;
    for (let i = 0; i < val.payments.length; i += 1) {
      if (val.payments[i]?.method === 'cash') {
        cashCount += 1;
        if (cashCount > 1) {
          ctx.addIssue({
            code: 'custom',
            path: ['payments', i, 'method'],
            message: 'At most one cash payment row is allowed per sale',
          });
        }
      }
    }
  });
export type CompleteSaleRequestDto = z.infer<typeof CompleteSaleRequestSchema>;

export const SaleLineDtoSchema = z.strictObject({
  id: UuidV7Schema,
  sortOrder: z.number().int(),
  lineKind: CartLineKindSchema,
  productId: UuidV7Schema.nullable(),
  variantId: UuidV7Schema.nullable(),
  categoryIdSnapshot: UuidV7Schema.nullable(),
  itemName: z.string(),
  unit: ProductUnitSchema,
  qty: PositiveBigIntStringSchema,
  unitPriceSnapshot: BigIntStringSchema,
  appliedPromotionId: UuidV7Schema.nullable(),
  appliedPromotionName: z.string().nullable(),
  freeUnits: z.number().int(),
  grossTotal: BigIntStringSchema,
  promoDiscount: BigIntStringSchema,
  subtotalAfterPromo: BigIntStringSchema,
  allocatedOrderDiscount: BigIntStringSchema,
  finalTotal: BigIntStringSchema,
  vatRateBpSnapshot: z.number().int(),
  netExVat: BigIntStringSchema,
  vatTotal: BigIntStringSchema,
  mxikSnapshot: z.string().nullable(),
  packageCodeSnapshot: z.string().nullable(),
});
export type SaleLineDto = z.infer<typeof SaleLineDtoSchema>;

export const SalePaymentDtoSchema = z.strictObject({
  id: UuidV7Schema,
  method: PaymentMethodSchema,
  amount: BigIntStringSchema,
  tenderedAmount: BigIntStringSchema.nullable(),
  changeAmount: BigIntStringSchema,
  providerRef: z.string().nullable(),
  createdAtMs: BigIntStringSchema,
});
export type SalePaymentDto = z.infer<typeof SalePaymentDtoSchema>;

export const CashMoveDtoSchema = z.strictObject({
  id: UuidV7Schema,
  organizationId: UuidV7Schema,
  storeId: UuidV7Schema,
  deviceId: UuidV7Schema,
  shiftId: UuidV7Schema.nullable(),
  type: CashMoveTypeSchema,
  amountDelta: SignedBigIntStringSchema,
  sourceType: z.string(),
  sourceId: UuidV7Schema,
  paymentId: UuidV7Schema.nullable(),
  reason: z.string().nullable(),
  createdByUserId: UuidV7Schema,
  createdAtMs: BigIntStringSchema,
});
export type CashMoveDto = z.infer<typeof CashMoveDtoSchema>;

export const SaleDtoSchema = z.strictObject({
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
  status: z.literal('completed'),
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
  lines: z.array(SaleLineDtoSchema),
  payments: z.array(SalePaymentDtoSchema),
});
export type SaleDto = z.infer<typeof SaleDtoSchema>;

export const SaleNegativeStockWarningSchema = z.strictObject({
  code: z.literal('NEGATIVE_STOCK'),
  productId: UuidV7Schema,
  variantId: UuidV7Schema.nullable(),
  deficitQty: PositiveBigIntStringSchema,
});
export type SaleNegativeStockWarningDto = z.infer<typeof SaleNegativeStockWarningSchema>;

export const CompleteSaleResponseSchema = z.strictObject({
  sale: SaleDtoSchema,
  warnings: z.array(SaleNegativeStockWarningSchema),
});
export type CompleteSaleResponseDto = z.infer<typeof CompleteSaleResponseSchema>;
