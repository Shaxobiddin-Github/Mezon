import {
  DomainError,
  MAX_CUSTOMER_DUE_DAYS,
  ORDER_PAYMENT_KINDS,
  ORDER_STATUSES,
  normalizeMandatoryOrderReason,
  normalizeOrderNote,
} from '@mezon/domain';
import { z } from 'zod';
import { BigIntStringSchema, LoginRequestSchema, UuidV7Schema } from './auth.js';
import {
  CartLineKindSchema,
  ManualDiscountModeSchema,
  PositiveBigIntStringSchema,
  SetCartDiscountRequestSchema,
} from './cart.js';
import {
  MxikSchema,
  PackageCodeSchema,
  ProductNameSchema,
  ProductUnitSchema,
  VatRateBpSchema,
} from './catalog.js';
import { CustomerFullNameSchema, CustomerPhoneInputSchema } from './customer.js';
import { ReturnPaymentInputSchema } from './return.js';
import {
  BoundedMoneyStringSchema,
  PaymentMethodSchema,
  SaleDtoSchema,
  SaleNegativeStockWarningSchema,
  SalePaymentInputSchema,
} from './sale.js';

export const OrderStatusSchema = z.enum(ORDER_STATUSES);
export const OrderPaymentKindSchema = z.enum(ORDER_PAYMENT_KINDS);

export const OrderIdParamsSchema = z.strictObject({
  id: UuidV7Schema,
});
export type OrderIdParamsDto = z.infer<typeof OrderIdParamsSchema>;

export const OptionalOrderNoteSchema = z
  .string()
  .nullable()
  .transform((val, ctx): string | null => {
    try {
      return normalizeOrderNote(val);
    } catch (err) {
      ctx.addIssue({
        code: 'custom',
        message: err instanceof DomainError ? err.message : 'Invalid order note',
      });
      return z.NEVER;
    }
  });

export const MandatoryOrderReasonSchema = z.string().transform((val, ctx): string => {
  try {
    return normalizeMandatoryOrderReason(val, 'reason');
  } catch (err) {
    ctx.addIssue({
      code: 'custom',
      message: err instanceof DomainError ? err.message : 'Invalid reason',
    });
    return z.NEVER;
  }
});

export const CreateOrderLineInputSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('catalog'),
    productId: UuidV7Schema,
    variantId: UuidV7Schema.nullable().default(null),
    qty: PositiveBigIntStringSchema,
  }),
  z.strictObject({
    kind: z.literal('quick_sale'),
    name: ProductNameSchema,
    unit: ProductUnitSchema,
    qty: PositiveBigIntStringSchema,
    unitPrice: BoundedMoneyStringSchema,
    mxik: MxikSchema.default(null),
    packageCode: PackageCodeSchema.default(null),
    vatRateBp: VatRateBpSchema.nullable().default(null),
  }),
]);
export type CreateOrderLineInputDto = z.infer<typeof CreateOrderLineInputSchema>;

export const CreateOrderRequestSchema = z
  .strictObject({
    clientRequestId: UuidV7Schema,
    customerId: UuidV7Schema.nullable().default(null),
    customerName: CustomerFullNameSchema.optional(),
    customerPhone: CustomerPhoneInputSchema.optional(),
    dueAtMs: BigIntStringSchema.nullable().default(null),
    note: OptionalOrderNoteSchema.default(null),
    confirmImmediately: z.boolean().default(false),
    expectedTotal: BoundedMoneyStringSchema.optional(),
    discount: SetCartDiscountRequestSchema.optional(),
    lines: z
      .array(CreateOrderLineInputSchema)
      .min(1, 'Order must contain at least one line')
      .max(200, 'Order cannot exceed 200 lines'),
  })
  .superRefine((val, ctx) => {
    if (val.customerId === null && val.customerName === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['customerName'],
        message: 'customerName is required when customerId is null',
      });
    }
  });
export type CreateOrderRequestDto = z.infer<typeof CreateOrderRequestSchema>;

export const ConfirmOrderRequestSchema = z.strictObject({
  clientRequestId: UuidV7Schema,
});
export type ConfirmOrderRequestDto = z.infer<typeof ConfirmOrderRequestSchema>;

export const MarkOrderReadyRequestSchema = z.strictObject({
  clientRequestId: UuidV7Schema,
});
export type MarkOrderReadyRequestDto = z.infer<typeof MarkOrderReadyRequestSchema>;

/**
 * STRICT: uses `SalePaymentInputSchema`, which forbids `'advance'` as an advance deposit tender.
 */
export const RecordOrderAdvanceRequestSchema = z
  .strictObject({
    clientRequestId: UuidV7Schema,
    payments: z
      .array(SalePaymentInputSchema)
      .min(1, 'At least one advance payment row is required')
      .max(16, 'At most 16 payment rows per advance deposit'),
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
            message: 'At most one cash row is allowed per advance deposit',
          });
        }
      }
    }
  });
export type RecordOrderAdvanceRequestDto = z.infer<typeof RecordOrderAdvanceRequestSchema>;

/**
 * STRICT: uses `ReturnPaymentInputSchema`, which forbids `'advance'`.
 */
export const RefundOrderAdvanceRequestSchema = z.strictObject({
  clientRequestId: UuidV7Schema,
  reason: MandatoryOrderReasonSchema,
  override: LoginRequestSchema.optional(),
  refunds: z
    .array(ReturnPaymentInputSchema)
    .min(1, 'At least one advance refund row is required')
    .max(16, 'At most 16 refund rows per advance refund'),
});
export type RefundOrderAdvanceRequestDto = z.infer<typeof RefundOrderAdvanceRequestSchema>;

/**
 * STRICT: additional payments during delivery accept real tenders (`SalePaymentInputSchema`);
 * remaining net advance on the order is automatically applied as `'advance'` in the shared
 * `completeSale` transaction core (`O2`).
 */
export const DeliverOrderRequestSchema = z
  .strictObject({
    clientRequestId: UuidV7Schema,
    expectedTotal: BoundedMoneyStringSchema,
    debtAmount: BoundedMoneyStringSchema.optional(),
    customerId: UuidV7Schema.nullable().optional(),
    dueDays: z.number().int().min(1).max(MAX_CUSTOMER_DUE_DAYS).nullable().optional(),
    creditOverride: LoginRequestSchema.optional(),
    payments: z
      .array(SalePaymentInputSchema)
      .max(64, 'At most 64 additional payment lines may be attached')
      .default([]),
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
            message: 'At most one cash payment row is allowed per delivery',
          });
        }
      }
    }
  });
export type DeliverOrderRequestDto = z.infer<typeof DeliverOrderRequestSchema>;

export const CancelOrderRequestSchema = z.strictObject({
  clientRequestId: UuidV7Schema,
  reason: MandatoryOrderReasonSchema,
  override: LoginRequestSchema.optional(),
});
export type CancelOrderRequestDto = z.infer<typeof CancelOrderRequestSchema>;

export const ListOrdersQuerySchema = z.strictObject({
  status: OrderStatusSchema.optional(),
  customerId: UuidV7Schema.optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  offset: z.coerce.number().int().min(0).max(100_000).optional(),
});
export type ListOrdersQueryDto = z.infer<typeof ListOrdersQuerySchema>;

// --- Response DTOs (ZERO cost/profit fields) ---

export const OrderLineDtoSchema = z.strictObject({
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
export type OrderLineDto = z.infer<typeof OrderLineDtoSchema>;

export const OrderPaymentDtoSchema = z.strictObject({
  id: UuidV7Schema,
  orderId: UuidV7Schema,
  shiftId: UuidV7Schema,
  shiftCashierSessionId: UuidV7Schema,
  kind: OrderPaymentKindSchema,
  method: PaymentMethodSchema,
  amount: BigIntStringSchema,
  tenderedAmount: BigIntStringSchema.nullable(),
  changeAmount: BigIntStringSchema,
  providerRef: z.string().nullable(),
  reason: z.string().nullable(),
  createdByUserId: UuidV7Schema,
  overrideApprovedByUserId: UuidV7Schema.nullable(),
  createdAtMs: BigIntStringSchema,
});
export type OrderPaymentDto = z.infer<typeof OrderPaymentDtoSchema>;

export const MethodAdvanceBreakdownDtoSchema = z.strictObject({
  cash: BigIntStringSchema,
  card: BigIntStringSchema,
  uzqr: BigIntStringSchema,
  payme: BigIntStringSchema,
  click: BigIntStringSchema,
  uzum: BigIntStringSchema,
  social_card: BigIntStringSchema,
  other: BigIntStringSchema,
});
export type MethodAdvanceBreakdownDto = z.infer<typeof MethodAdvanceBreakdownDtoSchema>;

export const OrderDtoSchema = z.strictObject({
  id: UuidV7Schema,
  organizationId: UuidV7Schema,
  storeId: UuidV7Schema,
  deviceId: UuidV7Schema,
  orderNo: PositiveBigIntStringSchema,
  orderCode: z.string(),
  status: OrderStatusSchema,
  customerId: UuidV7Schema.nullable(),
  customerName: z.string(),
  customerPhoneNormalized: z.string().nullable(),
  dueAtMs: BigIntStringSchema.nullable(),
  note: z.string().nullable(),
  subtotalGross: BigIntStringSchema,
  totalPromoDiscount: BigIntStringSchema,
  subtotalAfterPromo: BigIntStringSchema,
  manualDiscountMode: ManualDiscountModeSchema,
  manualDiscountValue: BigIntStringSchema,
  manualDiscountReason: z.string().nullable(),
  orderDiscountAmount: BigIntStringSchema,
  totalAmount: BigIntStringSchema,
  totalNetExVat: BigIntStringSchema,
  totalVat: BigIntStringSchema,
  netAdvance: BigIntStringSchema,
  remainingToPay: BigIntStringSchema,
  netAdvanceByMethod: MethodAdvanceBreakdownDtoSchema,
  overrideApprovedByUserId: UuidV7Schema.nullable(),
  overrideApprovedAmount: BigIntStringSchema.nullable(),
  createdByUserId: UuidV7Schema,
  createdAtMs: BigIntStringSchema,
  confirmedAtMs: BigIntStringSchema.nullable(),
  readyAtMs: BigIntStringSchema.nullable(),
  deliveredAtMs: BigIntStringSchema.nullable(),
  deliveredSaleId: UuidV7Schema.nullable(),
  cancelledAtMs: BigIntStringSchema.nullable(),
  cancelledByUserId: UuidV7Schema.nullable(),
  cancelReason: z.string().nullable(),
  lines: z.array(OrderLineDtoSchema),
  payments: z.array(OrderPaymentDtoSchema),
});
export type OrderDto = z.infer<typeof OrderDtoSchema>;

export const OrderActionResponseSchema = z.strictObject({
  order: OrderDtoSchema,
  idempotentReplay: z.boolean(),
});
export type OrderActionResponseDto = z.infer<typeof OrderActionResponseSchema>;

export const DeliverOrderResponseSchema = z.strictObject({
  order: OrderDtoSchema,
  sale: SaleDtoSchema,
  warnings: z.array(SaleNegativeStockWarningSchema),
  idempotentReplay: z.boolean(),
});
export type DeliverOrderResponseDto = z.infer<typeof DeliverOrderResponseSchema>;

export const ListOrdersResponseSchema = z.strictObject({
  orders: z.array(OrderDtoSchema),
  total: z.number().int().min(0),
});
export type ListOrdersResponseDto = z.infer<typeof ListOrdersResponseSchema>;

export const OpenAdvancesResponseSchema = z.strictObject({
  totalOpenAdvance: BigIntStringSchema,
  byMethod: MethodAdvanceBreakdownDtoSchema,
  openOrdersCount: z.number().int().min(0),
});
export type OpenAdvancesResponseDto = z.infer<typeof OpenAdvancesResponseSchema>;
