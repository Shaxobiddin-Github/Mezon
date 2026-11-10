import { describe, expect, it } from 'vitest';
import {
  CreateCategoryRequestSchema,
  CreateProductRequestSchema,
  CreateVariantRequestSchema,
  ListProductsQuerySchema,
  ProductSummarySchema,
  UpdateProductRequestSchema,
  UpdateVariantRequestSchema,
} from './index.js';

describe('@mezon/contracts - catalog schemas and strict validation', () => {
  it('validates product creation payloads and strips extra unknown fields cleanly via strictObject', () => {
    const parsed = CreateProductRequestSchema.parse({
      name: '  Olma   sharbat ',
      unit: 'litr',
      salePrice: '1500000',
      minStock: '5000',
      sku: '  JUICE-1L  ',
      mxik: ' 02202001001000001 ',
      packageCode: '123456',
      vatRateBp: 1200,
      barcodes: [{ barcode: '036000291452', format: 'upca' }],
      priceChangeReason: 'Boshlangich narx',
    });

    expect(parsed.name).toBe('Olma sharbat');
    expect(parsed.sku).toBe('JUICE-1L');
    expect(parsed.mxik).toBe('02202001001000001');
    expect(parsed.salePrice).toBe('1500000');

    expect(() =>
      CreateProductRequestSchema.parse({
        name: 'Test',
        unit: 'dona',
        salePrice: '1000',
        costPrice: '500',
      }),
    ).toThrow();
  });

  it('rejects empty update payloads and numeric/float money values', () => {
    expect(() => UpdateProductRequestSchema.parse({})).toThrow();
    expect(() => UpdateProductRequestSchema.parse({ priceChangeReason: 'only reason' })).toThrow();
    expect(() => UpdateVariantRequestSchema.parse({})).toThrow();

    expect(() =>
      CreateProductRequestSchema.parse({
        name: 'Bad price',
        unit: 'dona',
        salePrice: 1000,
      }),
    ).toThrow();

    expect(() =>
      CreateProductRequestSchema.parse({
        name: 'Decimal money',
        unit: 'dona',
        salePrice: '1000.50',
      }),
    ).toThrow();

    expect(() =>
      ProductSummarySchema.parse({
        id: '01950000-0000-7000-8000-000000000001',
        organizationId: '01950000-0000-7000-8000-000000000002',
        categoryId: null,
        sku: null,
        name: 'Test',
        unit: 'dona',
        unlimited: false,
        minStock: null,
        hasVariants: false,
        trackBatches: false,
        salePrice: '1000',
        mxik: null,
        packageCode: null,
        vatRateBp: 0,
        createdAtMs: '1700000000000',
        updatedAtMs: '1700000000000',
        costPrice: '500',
      }),
    ).toThrow();
  });

  it('validates category, variant attributes, and query pagination limits', () => {
    const cat = CreateCategoryRequestSchema.parse({
      name: '  Ichimliklar ',
      parentId: null,
      sortOrder: 10,
    });
    expect(cat.name).toBe('Ichimliklar');

    const variant = CreateVariantRequestSchema.parse({
      name: 'XL Qora',
      attributes: { ' rang ': ' Qora ', olcham: 'XL' },
      salePrice: '2500000',
    });
    expect(variant.attributes).toEqual({ olcham: 'XL', rang: 'Qora' });

    const query = ListProductsQuerySchema.parse({
      q: 'zero',
      limit: '25',
      offset: '50',
    });
    expect(query).toEqual({ q: 'zero', limit: 25, offset: 50 });
    expect(() => ListProductsQuerySchema.parse({ limit: '201' })).toThrow();
  });
});
