import { PAYMENT_METHODS } from '@mezon/domain';
import { z } from 'zod';
import { BigIntStringSchema, UuidV7Schema } from './auth.js';
import {
  CartLineKindSchema,
  ManualDiscountModeSchema,
  PositiveBigIntStringSchema,
} from './cart.js';
import { ProductUnitSchema } from './catalog.js';

export const PaymentMethodSchema = z.enum(PAYMENT_METHODS);

export const CashSalePaymentInputSchema = z.strictObject({
  method: z.literal('cash'),
  tenderedAmount: BigIntStringSchema,
});
export type CashSalePaymentInputDto = z.infer<typeof CashSalePaymentInputSchema>;

export const CompleteSaleRequestSchema = z.strictObject({
  clientRequestId: UuidV7Schema,
  expectedTotal: BigIntStringSchema,
  payments: z.array(CashSalePaymentInputSchema).length(1, 'T1.4 requires exactly one cash payment'),
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

export const SaleDtoSchema = z.strictObject({
  id: UuidV7Schema,
  receiptNo: PositiveBigIntStringSchema,
  receiptCode: z.string(),
  organizationId: UuidV7Schema,
  storeId: UuidV7Schema,
  deviceId: UuidV7Schema,
  sourceCartId: UuidV7Schema.nullable(),
  cashierUserId: UuidV7Schema,
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
