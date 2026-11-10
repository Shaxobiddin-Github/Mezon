import {
  CART_LINE_KINDS,
  CART_STATUSES,
  DomainError,
  MANUAL_DISCOUNT_MODES,
  PROMOTION_SCOPES,
  PROMOTION_TYPES,
  normalizePriceChangeReason,
} from '@mezon/domain';
import { z } from 'zod';
import { BigIntStringSchema, LoginRequestSchema, UuidV7Schema } from './auth.js';
import {
  MxikSchema,
  PackageCodeSchema,
  ProductNameSchema,
  ProductUnitSchema,
  VatRateBpSchema,
} from './catalog.js';

export const PromotionTypeSchema = z.enum(PROMOTION_TYPES);
export const PromotionScopeSchema = z.enum(PROMOTION_SCOPES);
export const ManualDiscountModeSchema = z.enum(MANUAL_DISCOUNT_MODES);
export const CartStatusSchema = z.enum(CART_STATUSES);
export const CartLineKindSchema = z.enum(CART_LINE_KINDS);

export const PositiveBigIntStringSchema = BigIntStringSchema.refine(
  (val) => BigInt(val) > 0n,
  'Must be greater than 0',
);

export const CartDiscountReasonSchema = z
  .string()
  .nullable()
  .transform((val, ctx): string | null => {
    try {
      return normalizePriceChangeReason(val);
    } catch (err) {
      ctx.addIssue({
        code: 'custom',
        message: err instanceof DomainError ? err.message : 'Invalid discount reason',
      });
      return z.NEVER;
    }
  });

export const ParkLabelSchema = z
  .string()
  .trim()
  .min(1, 'Park label cannot be empty')
  .max(120, 'Park label exceeds 120 characters')
  .nullable();

// --- Promotion DTOs ---

export const PromotionIdParamsSchema = z.strictObject({
  id: UuidV7Schema,
});
export type PromotionIdParamsDto = z.infer<typeof PromotionIdParamsSchema>;

export const PromotionSummarySchema = z.strictObject({
  id: UuidV7Schema,
  organizationId: UuidV7Schema,
  storeId: UuidV7Schema.nullable(),
  name: z.string(),
  type: PromotionTypeSchema,
  scope: PromotionScopeSchema,
  targetProductId: UuidV7Schema.nullable(),
  targetCategoryId: UuidV7Schema.nullable(),
  discountPercentBp: z.number().int().nullable(),
  discountAmount: BigIntStringSchema.nullable(),
  buyQty: z.number().int().nullable(),
  freeQty: z.number().int().nullable(),
  startsAtMs: BigIntStringSchema,
  endsAtMs: BigIntStringSchema.nullable(),
  isActive: z.boolean(),
  createdAtMs: BigIntStringSchema,
  updatedAtMs: BigIntStringSchema,
});
export type PromotionSummaryDto = z.infer<typeof PromotionSummarySchema>;

export const PromotionResponseSchema = z.strictObject({
  promotion: PromotionSummarySchema,
});
export type PromotionResponseDto = z.infer<typeof PromotionResponseSchema>;

export const ListPromotionsQuerySchema = z.strictObject({
  activeOnly: z.coerce.boolean().optional(),
});
export type ListPromotionsQueryDto = z.infer<typeof ListPromotionsQuerySchema>;

export const ListPromotionsResponseSchema = z.strictObject({
  promotions: z.array(PromotionSummarySchema),
});
export type ListPromotionsResponseDto = z.infer<typeof ListPromotionsResponseSchema>;

export const CreatePromotionRequestSchema = z
  .strictObject({
    storeId: UuidV7Schema.nullable().default(null),
    name: ProductNameSchema,
    type: PromotionTypeSchema,
    scope: PromotionScopeSchema,
    targetProductId: UuidV7Schema.nullable().default(null),
    targetCategoryId: UuidV7Schema.nullable().default(null),
    discountPercentBp: z.number().int().min(1).max(10_000).nullable().default(null),
    discountAmount: PositiveBigIntStringSchema.nullable().default(null),
    buyQty: z.number().int().min(1).nullable().default(null),
    freeQty: z.number().int().min(1).nullable().default(null),
    startsAtMs: BigIntStringSchema,
    endsAtMs: BigIntStringSchema.nullable().default(null),
    isActive: z.boolean().default(true),
  })
  .superRefine((val, ctx) => {
    if (val.endsAtMs !== null && BigInt(val.endsAtMs) <= BigInt(val.startsAtMs)) {
      ctx.addIssue({
        code: 'custom',
        path: ['endsAtMs'],
        message: 'endsAtMs must be strictly greater than startsAtMs',
      });
    }
    if (
      val.scope === 'product' &&
      (val.targetProductId === null || val.targetCategoryId !== null)
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['targetProductId'],
        message: 'Product-scoped promotion requires targetProductId and null targetCategoryId',
      });
    }
    if (
      val.scope === 'category' &&
      (val.targetCategoryId === null || val.targetProductId !== null)
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['targetCategoryId'],
        message: 'Category-scoped promotion requires targetCategoryId and null targetProductId',
      });
    }
    if (val.scope === 'all' && (val.targetProductId !== null || val.targetCategoryId !== null)) {
      ctx.addIssue({
        code: 'custom',
        path: ['scope'],
        message: 'All-scoped promotion cannot specify targetProductId or targetCategoryId',
      });
    }
    if (val.type === 'percent') {
      if (val.discountPercentBp === null) {
        ctx.addIssue({
          code: 'custom',
          path: ['discountPercentBp'],
          message: 'Percent promotion requires discountPercentBp',
        });
      }
      if (val.discountAmount !== null || val.buyQty !== null || val.freeQty !== null) {
        ctx.addIssue({
          code: 'custom',
          path: ['type'],
          message: 'Percent promotion cannot include fixed amount or N+M fields',
        });
      }
    } else if (val.type === 'fixed_amount') {
      if (val.discountAmount === null) {
        ctx.addIssue({
          code: 'custom',
          path: ['discountAmount'],
          message: 'Fixed-amount promotion requires discountAmount',
        });
      }
      if (val.discountPercentBp !== null || val.buyQty !== null || val.freeQty !== null) {
        ctx.addIssue({
          code: 'custom',
          path: ['type'],
          message: 'Fixed-amount promotion cannot include percent or N+M fields',
        });
      }
    } else {
      if (val.buyQty === null || val.freeQty === null) {
        ctx.addIssue({
          code: 'custom',
          path: ['buyQty'],
          message: 'buy_x_get_y promotion requires buyQty and freeQty',
        });
      }
      if (val.discountPercentBp !== null || val.discountAmount !== null) {
        ctx.addIssue({
          code: 'custom',
          path: ['type'],
          message: 'buy_x_get_y promotion cannot include percent or fixed amount fields',
        });
      }
    }
  });
export type CreatePromotionRequestDto = z.infer<typeof CreatePromotionRequestSchema>;

export const UpdatePromotionRequestSchema = z
  .strictObject({
    name: ProductNameSchema.optional(),
    startsAtMs: BigIntStringSchema.optional(),
    endsAtMs: BigIntStringSchema.nullable().optional(),
    isActive: z.boolean().optional(),
    discountPercentBp: z.number().int().min(1).max(10_000).optional(),
    discountAmount: PositiveBigIntStringSchema.optional(),
    buyQty: z.number().int().min(1).optional(),
    freeQty: z.number().int().min(1).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, 'At least one field must be provided for update');
export type UpdatePromotionRequestDto = z.infer<typeof UpdatePromotionRequestSchema>;

export const DeletePromotionResponseSchema = z.strictObject({
  deletedId: UuidV7Schema,
});
export type DeletePromotionResponseDto = z.infer<typeof DeletePromotionResponseSchema>;

// --- Cashier Discount Limits & Quick-Sale Settings (P3) ---

export const CashierDiscountLimitSchema = z.strictObject({
  percentUnlimited: z.boolean(),
  maxPercentBp: z.number().int().min(0).max(10_000),
  amountUnlimited: z.boolean(),
  maxAmount: BigIntStringSchema,
});
export type CashierDiscountLimitDto = z.infer<typeof CashierDiscountLimitSchema>;

export const UpdateCartSettingsRequestSchema = z.strictObject({
  cashierDiscountLimit: CashierDiscountLimitSchema,
  quickSaleDefaultMxik: MxikSchema.default(null),
  quickSaleDefaultVatRateBp: VatRateBpSchema.nullable().default(null),
});
export type UpdateCartSettingsRequestDto = z.infer<typeof UpdateCartSettingsRequestSchema>;

export const CartSettingsResponseSchema = z.strictObject({
  cashierDiscountLimit: CashierDiscountLimitSchema,
  unlimitedDiscountEnabled: z.boolean(),
  quickSaleDefaultMxik: z.string().nullable(),
  quickSaleDefaultVatRateBp: z.number().int().nullable(),
});
export type CartSettingsResponseDto = z.infer<typeof CartSettingsResponseSchema>;

// --- Cart & Line DTOs (ZERO cost/profit fields) ---

export const CartIdParamsSchema = z.strictObject({
  id: UuidV7Schema,
});
export type CartIdParamsDto = z.infer<typeof CartIdParamsSchema>;

export const CartLineParamsSchema = z.strictObject({
  id: UuidV7Schema,
  lineId: UuidV7Schema,
});
export type CartLineParamsDto = z.infer<typeof CartLineParamsSchema>;

export const CreateCartRequestSchema = z.strictObject({}).optional();
export type CreateCartRequestDto = z.infer<typeof CreateCartRequestSchema>;

export const AddCartLineRequestSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('catalog'),
    productId: UuidV7Schema,
    variantId: UuidV7Schema.nullable().default(null),
    qty: PositiveBigIntStringSchema,
  }),
  z.strictObject({
    kind: z.literal('scan'),
    barcode: z.string().trim().min(1, 'Barcode is required').max(64),
    qty: PositiveBigIntStringSchema.default('1000'),
  }),
  z.strictObject({
    kind: z.literal('quick_sale'),
    name: ProductNameSchema,
    unit: ProductUnitSchema,
    qty: PositiveBigIntStringSchema,
    unitPrice: BigIntStringSchema,
    mxik: MxikSchema.default(null),
    packageCode: PackageCodeSchema.default(null),
    vatRateBp: VatRateBpSchema.nullable().default(null),
  }),
]);
export type AddCartLineRequestDto = z.infer<typeof AddCartLineRequestSchema>;

export const UpdateCartLineRequestSchema = z
  .strictObject({
    qty: PositiveBigIntStringSchema.optional(),
    name: ProductNameSchema.optional(),
    unitPrice: BigIntStringSchema.optional(),
  })
  .refine((v) => Object.keys(v).length > 0, 'At least one field must be provided for update');
export type UpdateCartLineRequestDto = z.infer<typeof UpdateCartLineRequestSchema>;

export const SetCartDiscountRequestSchema = z.discriminatedUnion('mode', [
  z.strictObject({
    mode: z.literal('none'),
  }),
  z.strictObject({
    mode: z.literal('percent'),
    percentBp: z.number().int().min(1).max(10_000),
    reason: CartDiscountReasonSchema.default(null),
    override: LoginRequestSchema.optional(),
  }),
  z.strictObject({
    mode: z.literal('amount'),
    amount: PositiveBigIntStringSchema,
    reason: CartDiscountReasonSchema.default(null),
    override: LoginRequestSchema.optional(),
  }),
]);
export type SetCartDiscountRequestDto = z.infer<typeof SetCartDiscountRequestSchema>;

export const ParkCartRequestSchema = z
  .strictObject({
    label: ParkLabelSchema.default(null),
  })
  .optional();
export type ParkCartRequestDto = z.infer<typeof ParkCartRequestSchema>;

export const PriceChangeWarningSchema = z.strictObject({
  snapshotUnitPrice: BigIntStringSchema,
  currentUnitPrice: BigIntStringSchema.nullable(),
  catalogDeleted: z.boolean(),
});
export type PriceChangeWarningDto = z.infer<typeof PriceChangeWarningSchema>;

export const CartLineDtoSchema = z.strictObject({
  id: UuidV7Schema,
  sortOrder: z.number().int(),
  lineKind: CartLineKindSchema,
  productId: UuidV7Schema.nullable(),
  variantId: UuidV7Schema.nullable(),
  categoryIdSnapshot: UuidV7Schema.nullable(),
  name: z.string(),
  unit: ProductUnitSchema,
  qty: BigIntStringSchema,
  unitPriceSnapshot: BigIntStringSchema,
  mxikSnapshot: z.string().nullable(),
  packageCodeSnapshot: z.string().nullable(),
  vatRateBpSnapshot: z.number().int(),
  appliedPromotionId: UuidV7Schema.nullable(),
  appliedPromotionName: z.string().nullable(),
  freeUnits: z.number().int(),
  grossTotal: BigIntStringSchema,
  promoDiscount: BigIntStringSchema,
  subtotalAfterPromo: BigIntStringSchema,
  allocatedOrderDiscount: BigIntStringSchema,
  finalTotal: BigIntStringSchema,
  netExVat: BigIntStringSchema,
  vatTotal: BigIntStringSchema,
  priceChangeWarning: PriceChangeWarningSchema.nullable(),
});
export type CartLineDto = z.infer<typeof CartLineDtoSchema>;

export const CartSummarySchema = z.strictObject({
  id: UuidV7Schema,
  organizationId: UuidV7Schema,
  storeId: UuidV7Schema,
  cashierUserId: UuidV7Schema,
  status: CartStatusSchema,
  parkLabel: z.string().nullable(),
  parkedAtMs: BigIntStringSchema.nullable(),
  manualDiscountMode: ManualDiscountModeSchema,
  manualDiscountValue: BigIntStringSchema,
  manualDiscountReason: z.string().nullable(),
  overrideApprovedByUserId: UuidV7Schema.nullable(),
  overrideApprovedAmount: BigIntStringSchema.nullable(),
  overrideApprovedAtMs: BigIntStringSchema.nullable(),
  lineCount: z.number().int(),
  totalFinal: BigIntStringSchema,
  priceWarningsCount: z.number().int(),
  discountOverrideRequired: z.boolean(),
  createdAtMs: BigIntStringSchema,
  updatedAtMs: BigIntStringSchema,
});
export type CartSummaryDto = z.infer<typeof CartSummarySchema>;

export const CartDetailSchema = z.strictObject({
  id: UuidV7Schema,
  organizationId: UuidV7Schema,
  storeId: UuidV7Schema,
  cashierUserId: UuidV7Schema,
  status: CartStatusSchema,
  parkLabel: z.string().nullable(),
  parkedAtMs: BigIntStringSchema.nullable(),
  manualDiscountMode: ManualDiscountModeSchema,
  manualDiscountValue: BigIntStringSchema,
  manualDiscountReason: z.string().nullable(),
  overrideApprovedByUserId: UuidV7Schema.nullable(),
  overrideApprovedAmount: BigIntStringSchema.nullable(),
  overrideApprovedAtMs: BigIntStringSchema.nullable(),
  subtotalGross: BigIntStringSchema,
  totalPromoDiscount: BigIntStringSchema,
  subtotalAfterPromo: BigIntStringSchema,
  requestedOrderDiscount: BigIntStringSchema,
  effectiveOrderDiscount: BigIntStringSchema,
  totalFinal: BigIntStringSchema,
  totalNetExVat: BigIntStringSchema,
  totalVat: BigIntStringSchema,
  totalFreeUnits: z.number().int(),
  exceedsCashierLimit: z.boolean(),
  discountAuthorized: z.boolean(),
  discountOverrideRequired: z.boolean(),
  priceWarningsCount: z.number().int(),
  lines: z.array(CartLineDtoSchema),
  createdAtMs: BigIntStringSchema,
  updatedAtMs: BigIntStringSchema,
});
export type CartDetailDto = z.infer<typeof CartDetailSchema>;

export const CartResponseSchema = z.strictObject({
  cart: CartDetailSchema,
});
export type CartResponseDto = z.infer<typeof CartResponseSchema>;

export const ListCartsResponseSchema = z.strictObject({
  carts: z.array(CartSummarySchema),
});
export type ListCartsResponseDto = z.infer<typeof ListCartsResponseSchema>;

export const DeleteCartResponseSchema = z.strictObject({
  deletedId: UuidV7Schema,
});
export type DeleteCartResponseDto = z.infer<typeof DeleteCartResponseSchema>;
