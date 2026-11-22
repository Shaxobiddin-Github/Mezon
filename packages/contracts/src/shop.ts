import { z } from 'zod';

/**
 * V2 / F5 online shop ("onlayn vitrina") wire contracts. Money is tiyin and quantity is
 * milli-units, both as decimal strings. The public projection never carries cost, stock
 * numbers, staff or customer data — only what a shopper may see.
 */
const DecimalString = z.string().regex(/^(0|[1-9][0-9]{0,18})$/);

export const ShopSlugSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9][a-z0-9-]{2,39}$/, 'Use 3-40 latin letters, digits or "-"');

export const ShopOrderStatusSchema = z.enum(['new', 'accepted', 'ready', 'done', 'cancelled']);
export type ShopOrderStatusDto = z.infer<typeof ShopOrderStatusSchema>;
export const ShopFulfilmentSchema = z.enum(['pickup', 'delivery']);

export const PublicShopProductSchema = z.object({
  id: z.string(),
  name: z.string(),
  unit: z.string(),
  price: DecimalString,
  category: z.string().nullable(),
  available: z.boolean(),
});
export type PublicShopProductDto = z.infer<typeof PublicShopProductSchema>;

export const PublicShopResponseSchema = z.object({
  shop: z.object({
    slug: z.string(),
    title: z.string(),
    phone: z.string().nullable(),
    address: z.string().nullable(),
    about: z.string().nullable(),
  }),
  products: z.array(PublicShopProductSchema),
});
export type PublicShopResponseDto = z.infer<typeof PublicShopResponseSchema>;

/** Uzbek phone as the shopper types it; stored as digits with an optional leading "+". */
export const ShopPhoneSchema = z
  .string()
  .transform((v) => v.replace(/[\s()-]/g, ''))
  .pipe(z.string().regex(/^\+?[0-9]{9,15}$/, 'Phone number'));

export const PlaceShopOrderRequestSchema = z.strictObject({
  customerName: z.string().trim().min(2).max(80),
  customerPhone: ShopPhoneSchema,
  fulfilment: ShopFulfilmentSchema,
  address: z.string().trim().max(300).optional(),
  note: z.string().trim().max(500).optional(),
  lines: z
    .array(z.strictObject({ productId: z.string().uuid(), qty: DecimalString }))
    .min(1)
    .max(50),
});
export type PlaceShopOrderRequestDto = z.infer<typeof PlaceShopOrderRequestSchema>;

export const ShopOrderLineDtoSchema = z.object({
  productId: z.string(),
  name: z.string(),
  unit: z.string(),
  qty: DecimalString,
  price: DecimalString,
  total: DecimalString,
});

export const ShopOrderDtoSchema = z.object({
  id: z.string(),
  orderNo: z.number().int(),
  customerName: z.string(),
  customerPhone: z.string(),
  fulfilment: ShopFulfilmentSchema,
  address: z.string().nullable(),
  note: z.string().nullable(),
  status: ShopOrderStatusSchema,
  total: DecimalString,
  createdAtMs: DecimalString,
  updatedAtMs: DecimalString,
  lines: z.array(ShopOrderLineDtoSchema),
});
export type ShopOrderDto = z.infer<typeof ShopOrderDtoSchema>;

export const PlaceShopOrderResponseSchema = z.object({
  order: ShopOrderDtoSchema,
  /** Keep it to see the order status later (shown only with this token). */
  accessToken: z.string(),
});
export type PlaceShopOrderResponseDto = z.infer<typeof PlaceShopOrderResponseSchema>;

export const PublicShopOrderResponseSchema = z.object({ order: ShopOrderDtoSchema });

// ---- Cabinet (owner / manager) ----

export const AdminShopSettingsSchema = z.object({
  slug: z.string(),
  title: z.string(),
  phone: z.string().nullable(),
  address: z.string().nullable(),
  about: z.string().nullable(),
  isEnabled: z.boolean(),
});
export type AdminShopSettingsDto = z.infer<typeof AdminShopSettingsSchema>;

export const AdminShopResponseSchema = z.object({ shop: AdminShopSettingsSchema.nullable() });

export const SaveAdminShopRequestSchema = z.strictObject({
  slug: ShopSlugSchema,
  title: z.string().trim().min(1).max(80),
  phone: z.string().trim().max(30).optional(),
  address: z.string().trim().max(300).optional(),
  about: z.string().trim().max(500).optional(),
  isEnabled: z.boolean(),
});
export type SaveAdminShopRequestDto = z.infer<typeof SaveAdminShopRequestSchema>;

export const AdminShopProductSchema = z.object({
  productId: z.string(),
  name: z.string(),
  unit: z.string(),
  price: DecimalString,
  category: z.string().nullable(),
  /** Milli-units at the shop's store; null = unlimited (service). Signed. */
  stock: z.string().nullable(),
  isPublished: z.boolean(),
});
export type AdminShopProductDto = z.infer<typeof AdminShopProductSchema>;

export const AdminShopProductsResponseSchema = z.object({ items: z.array(AdminShopProductSchema) });

export const SetShopProductsRequestSchema = z.strictObject({
  productIds: z.array(z.string().uuid()).min(1).max(500),
  isPublished: z.boolean(),
});

export const AdminShopOrdersResponseSchema = z.object({ orders: z.array(ShopOrderDtoSchema) });

export const SetShopOrderStatusRequestSchema = z.strictObject({ status: ShopOrderStatusSchema });
