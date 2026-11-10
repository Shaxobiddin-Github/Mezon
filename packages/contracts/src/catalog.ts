import {
  BARCODE_FORMATS,
  DomainError,
  PRODUCT_UNITS,
  canonicalizeVariantAttributes,
  normalizeCatalogDisplayName,
  normalizeCatalogSku,
  normalizeFiscalCode,
  normalizePriceChangeReason,
} from '@mezon/domain';
import { z } from 'zod';
import { BigIntStringSchema, UuidV7Schema } from './auth.js';

export const ProductUnitSchema = z.enum(PRODUCT_UNITS);
export const BarcodeFormatSchema = z.enum(BARCODE_FORMATS);

export const VatRateBpSchema = z.number().int().min(0).max(10_000);

export const ProductNameSchema = z.string().transform((val, ctx): string => {
  try {
    return normalizeCatalogDisplayName(val, 'Product name', 200);
  } catch (err) {
    ctx.addIssue({
      code: 'custom',
      message: err instanceof DomainError ? err.message : 'Invalid product name',
    });
    return z.NEVER;
  }
});

export const CategoryNameSchema = z.string().transform((val, ctx): string => {
  try {
    return normalizeCatalogDisplayName(val, 'Category name', 120);
  } catch (err) {
    ctx.addIssue({
      code: 'custom',
      message: err instanceof DomainError ? err.message : 'Invalid category name',
    });
    return z.NEVER;
  }
});

export const VariantNameSchema = z.string().transform((val, ctx): string => {
  try {
    return normalizeCatalogDisplayName(val, 'Variant name', 120);
  } catch (err) {
    ctx.addIssue({
      code: 'custom',
      message: err instanceof DomainError ? err.message : 'Invalid variant name',
    });
    return z.NEVER;
  }
});

export const CatalogSkuSchema = z
  .string()
  .nullable()
  .transform((val, ctx): string | null => {
    try {
      return normalizeCatalogSku(val);
    } catch (err) {
      ctx.addIssue({
        code: 'custom',
        message: err instanceof DomainError ? err.message : 'Invalid SKU',
      });
      return z.NEVER;
    }
  });

export const MxikSchema = z
  .string()
  .nullable()
  .transform((val, ctx): string | null => {
    try {
      return normalizeFiscalCode(val, 'MXIK');
    } catch (err) {
      ctx.addIssue({
        code: 'custom',
        message: err instanceof DomainError ? err.message : 'Invalid MXIK code',
      });
      return z.NEVER;
    }
  });

export const PackageCodeSchema = z
  .string()
  .nullable()
  .transform((val, ctx): string | null => {
    try {
      return normalizeFiscalCode(val, 'Package code');
    } catch (err) {
      ctx.addIssue({
        code: 'custom',
        message: err instanceof DomainError ? err.message : 'Invalid package code',
      });
      return z.NEVER;
    }
  });

export const PriceChangeReasonSchema = z
  .string()
  .nullable()
  .transform((val, ctx): string | null => {
    try {
      return normalizePriceChangeReason(val);
    } catch (err) {
      ctx.addIssue({
        code: 'custom',
        message: err instanceof DomainError ? err.message : 'Invalid reason',
      });
      return z.NEVER;
    }
  });

export const VariantAttributesInputSchema = z
  .record(z.string(), z.string())
  .transform((val, ctx): Readonly<Record<string, string>> => {
    try {
      return canonicalizeVariantAttributes(val).attributes;
    } catch (err) {
      ctx.addIssue({
        code: 'custom',
        message: err instanceof DomainError ? err.message : 'Invalid variant attributes',
      });
      return z.NEVER;
    }
  });

// --- Categories ---

export const CategoryIdParamsSchema = z.strictObject({
  id: UuidV7Schema,
});
export type CategoryIdParamsDto = z.infer<typeof CategoryIdParamsSchema>;

export const CategorySummarySchema = z.strictObject({
  id: UuidV7Schema,
  organizationId: UuidV7Schema,
  name: z.string(),
  parentId: UuidV7Schema.nullable(),
  sortOrder: z.number().int(),
  createdAtMs: BigIntStringSchema,
  updatedAtMs: BigIntStringSchema,
});
export type CategorySummaryDto = z.infer<typeof CategorySummarySchema>;

export const ListCategoriesResponseSchema = z.strictObject({
  categories: z.array(CategorySummarySchema),
});
export type ListCategoriesResponseDto = z.infer<typeof ListCategoriesResponseSchema>;

export const CategoryResponseSchema = z.strictObject({
  category: CategorySummarySchema,
});
export type CategoryResponseDto = z.infer<typeof CategoryResponseSchema>;

export const CreateCategoryRequestSchema = z.strictObject({
  name: CategoryNameSchema,
  parentId: UuidV7Schema.nullable().optional(),
  sortOrder: z.number().int().min(-1_000_000).max(1_000_000).optional(),
});
export type CreateCategoryRequestDto = z.infer<typeof CreateCategoryRequestSchema>;

export const UpdateCategoryRequestSchema = z
  .strictObject({
    name: CategoryNameSchema.optional(),
    parentId: UuidV7Schema.nullable().optional(),
    sortOrder: z.number().int().min(-1_000_000).max(1_000_000).optional(),
  })
  .refine(
    (data) =>
      data.name !== undefined || data.parentId !== undefined || data.sortOrder !== undefined,
    { message: 'At least one field must be provided for update' },
  );
export type UpdateCategoryRequestDto = z.infer<typeof UpdateCategoryRequestSchema>;

export const DeleteCategoryResponseSchema = z.strictObject({
  deleted: z.literal(true),
  id: UuidV7Schema,
});
export type DeleteCategoryResponseDto = z.infer<typeof DeleteCategoryResponseSchema>;

// --- Barcodes ---

export const BarcodeInputSchema = z.strictObject({
  barcode: z.string().min(1).max(128),
  format: BarcodeFormatSchema.optional(),
});
export type BarcodeInputDto = z.infer<typeof BarcodeInputSchema>;

export const CreateBarcodeRequestSchema = z.strictObject({
  barcode: z.string().min(1).max(128),
  format: BarcodeFormatSchema.optional(),
  variantId: UuidV7Schema.nullable().optional(),
});
export type CreateBarcodeRequestDto = z.infer<typeof CreateBarcodeRequestSchema>;

export const ProductBarcodeSummarySchema = z.strictObject({
  id: UuidV7Schema,
  organizationId: UuidV7Schema,
  productId: UuidV7Schema,
  variantId: UuidV7Schema.nullable(),
  barcode: z.string(),
  format: BarcodeFormatSchema,
  createdAtMs: BigIntStringSchema,
  updatedAtMs: BigIntStringSchema,
});
export type ProductBarcodeSummaryDto = z.infer<typeof ProductBarcodeSummarySchema>;

export const BarcodeResponseSchema = z.strictObject({
  barcode: ProductBarcodeSummarySchema,
});
export type BarcodeResponseDto = z.infer<typeof BarcodeResponseSchema>;

export const DeleteBarcodeResponseSchema = z.strictObject({
  deleted: z.literal(true),
  id: UuidV7Schema,
});
export type DeleteBarcodeResponseDto = z.infer<typeof DeleteBarcodeResponseSchema>;

export const ProductBarcodeParamsSchema = z.strictObject({
  id: UuidV7Schema,
  barcodeId: UuidV7Schema,
});
export type ProductBarcodeParamsDto = z.infer<typeof ProductBarcodeParamsSchema>;

// --- Variants ---

export const ProductVariantSummarySchema = z.strictObject({
  id: UuidV7Schema,
  organizationId: UuidV7Schema,
  productId: UuidV7Schema,
  name: z.string(),
  sku: z.string().nullable(),
  attributes: z.record(z.string(), z.string()),
  salePrice: BigIntStringSchema.nullable(),
  effectiveSalePrice: BigIntStringSchema,
  createdAtMs: BigIntStringSchema,
  updatedAtMs: BigIntStringSchema,
});
export type ProductVariantSummaryDto = z.infer<typeof ProductVariantSummarySchema>;

export const CreateVariantRequestSchema = z.strictObject({
  name: VariantNameSchema,
  sku: CatalogSkuSchema.optional(),
  attributes: VariantAttributesInputSchema.optional(),
  salePrice: BigIntStringSchema.nullable().optional(),
  reason: PriceChangeReasonSchema.optional(),
});
export type CreateVariantRequestDto = z.infer<typeof CreateVariantRequestSchema>;

export const UpdateVariantRequestSchema = z
  .strictObject({
    name: VariantNameSchema.optional(),
    sku: CatalogSkuSchema.optional(),
    attributes: VariantAttributesInputSchema.optional(),
    salePrice: BigIntStringSchema.nullable().optional(),
    reason: PriceChangeReasonSchema.optional(),
  })
  .refine(
    (data) =>
      data.name !== undefined ||
      data.sku !== undefined ||
      data.attributes !== undefined ||
      data.salePrice !== undefined,
    { message: 'At least one field must be provided for update' },
  );
export type UpdateVariantRequestDto = z.infer<typeof UpdateVariantRequestSchema>;

export const VariantResponseSchema = z.strictObject({
  variant: ProductVariantSummarySchema,
});
export type VariantResponseDto = z.infer<typeof VariantResponseSchema>;

export const DeleteVariantResponseSchema = z.strictObject({
  deleted: z.literal(true),
  id: UuidV7Schema,
});
export type DeleteVariantResponseDto = z.infer<typeof DeleteVariantResponseSchema>;

export const ProductVariantParamsSchema = z.strictObject({
  id: UuidV7Schema,
  variantId: UuidV7Schema,
});
export type ProductVariantParamsDto = z.infer<typeof ProductVariantParamsSchema>;

// --- Products ---

export const ProductIdParamsSchema = z.strictObject({
  id: UuidV7Schema,
});
export type ProductIdParamsDto = z.infer<typeof ProductIdParamsSchema>;

export const ProductSummarySchema = z.strictObject({
  id: UuidV7Schema,
  organizationId: UuidV7Schema,
  categoryId: UuidV7Schema.nullable(),
  sku: z.string().nullable(),
  name: z.string(),
  unit: ProductUnitSchema,
  unlimited: z.boolean(),
  minStock: BigIntStringSchema.nullable(),
  hasVariants: z.boolean(),
  salePrice: BigIntStringSchema,
  mxik: z.string().nullable(),
  packageCode: z.string().nullable(),
  vatRateBp: VatRateBpSchema,
  createdAtMs: BigIntStringSchema,
  updatedAtMs: BigIntStringSchema,
});
export type ProductSummaryDto = z.infer<typeof ProductSummarySchema>;

export const ProductResponseSchema = z.strictObject({
  product: ProductSummarySchema,
});
export type ProductResponseDto = z.infer<typeof ProductResponseSchema>;

export const ProductDetailResponseSchema = z.strictObject({
  product: ProductSummarySchema,
  variants: z.array(ProductVariantSummarySchema),
  barcodes: z.array(ProductBarcodeSummarySchema),
});
export type ProductDetailResponseDto = z.infer<typeof ProductDetailResponseSchema>;

export const CreateProductRequestSchema = z.strictObject({
  categoryId: UuidV7Schema.nullable().optional(),
  sku: CatalogSkuSchema.optional(),
  name: ProductNameSchema,
  unit: ProductUnitSchema,
  unlimited: z.boolean().optional(),
  minStock: BigIntStringSchema.nullable().optional(),
  hasVariants: z.boolean().optional(),
  salePrice: BigIntStringSchema,
  mxik: MxikSchema.optional(),
  packageCode: PackageCodeSchema.optional(),
  vatRateBp: VatRateBpSchema.optional(),
  barcodes: z.array(BarcodeInputSchema).max(20).optional(),
  priceChangeReason: PriceChangeReasonSchema.optional(),
});
export type CreateProductRequestDto = z.infer<typeof CreateProductRequestSchema>;

export const UpdateProductRequestSchema = z
  .strictObject({
    categoryId: UuidV7Schema.nullable().optional(),
    sku: CatalogSkuSchema.optional(),
    name: ProductNameSchema.optional(),
    unit: ProductUnitSchema.optional(),
    unlimited: z.boolean().optional(),
    minStock: BigIntStringSchema.nullable().optional(),
    hasVariants: z.boolean().optional(),
    salePrice: BigIntStringSchema.optional(),
    mxik: MxikSchema.optional(),
    packageCode: PackageCodeSchema.optional(),
    vatRateBp: VatRateBpSchema.optional(),
    priceChangeReason: PriceChangeReasonSchema.optional(),
  })
  .refine(
    (data) =>
      data.categoryId !== undefined ||
      data.sku !== undefined ||
      data.name !== undefined ||
      data.unit !== undefined ||
      data.unlimited !== undefined ||
      data.minStock !== undefined ||
      data.hasVariants !== undefined ||
      data.salePrice !== undefined ||
      data.mxik !== undefined ||
      data.packageCode !== undefined ||
      data.vatRateBp !== undefined,
    { message: 'At least one field must be provided for update' },
  );
export type UpdateProductRequestDto = z.infer<typeof UpdateProductRequestSchema>;

export const ListProductsQuerySchema = z.strictObject({
  q: z.string().max(256).optional(),
  categoryId: UuidV7Schema.optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  offset: z.coerce.number().int().min(0).max(1_000_000).optional(),
});
export type ListProductsQueryDto = z.infer<typeof ListProductsQuerySchema>;

export const ListProductsResponseSchema = z.strictObject({
  products: z.array(ProductSummarySchema),
  total: z.number().int().min(0),
  limit: z.number().int().min(1),
  offset: z.number().int().min(0),
});
export type ListProductsResponseDto = z.infer<typeof ListProductsResponseSchema>;

export const DeleteProductResponseSchema = z.strictObject({
  deleted: z.literal(true),
  id: UuidV7Schema,
});
export type DeleteProductResponseDto = z.infer<typeof DeleteProductResponseSchema>;

// --- Price changes ---

export const PriceChangeSummarySchema = z.strictObject({
  id: UuidV7Schema,
  organizationId: UuidV7Schema,
  productId: UuidV7Schema,
  variantId: UuidV7Schema.nullable(),
  oldPrice: BigIntStringSchema.nullable(),
  newPrice: BigIntStringSchema,
  changedByUserId: UuidV7Schema,
  reason: z.string().nullable(),
  createdAtMs: BigIntStringSchema,
});
export type PriceChangeSummaryDto = z.infer<typeof PriceChangeSummarySchema>;

export const ListPriceChangesResponseSchema = z.strictObject({
  priceChanges: z.array(PriceChangeSummarySchema),
});
export type ListPriceChangesResponseDto = z.infer<typeof ListPriceChangesResponseSchema>;

// --- Barcode Scan ---

export const ScanBarcodeQuerySchema = z.strictObject({
  code: z.string().min(1).max(128),
});
export type ScanBarcodeQueryDto = z.infer<typeof ScanBarcodeQuerySchema>;

export const ScanBarcodeResponseSchema = z.strictObject({
  product: ProductSummarySchema,
  variant: ProductVariantSummarySchema.nullable(),
  barcode: ProductBarcodeSummarySchema,
  quantity: BigIntStringSchema.nullable(),
});
export type ScanBarcodeResponseDto = z.infer<typeof ScanBarcodeResponseSchema>;
