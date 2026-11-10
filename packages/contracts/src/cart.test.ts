import { describe, expect, it } from 'vitest';
import {
  AddCartLineRequestSchema,
  CartDetailSchema,
  CreatePromotionRequestSchema,
  SetCartDiscountRequestSchema,
  UpdateCartSettingsRequestSchema,
} from './index.js';

const UUID_1 = '01950000-0000-7000-8000-000000000001';
const UUID_2 = '01950000-0000-7000-8000-000000000002';

describe('@mezon/contracts - T1.3 cart, promotion & P3 discount settings schemas', () => {
  it('enforces P3 explicit unlimited booleans (rejects null/missing) and rejects unknown keys', () => {
    expect(() =>
      UpdateCartSettingsRequestSchema.parse({
        cashierDiscountLimit: {
          maxPercentBp: null,
          maxAmount: '0',
        },
      }),
    ).toThrow();

    expect(() =>
      UpdateCartSettingsRequestSchema.parse({
        cashierDiscountLimit: {
          maxPercentBp: 500,
          amountUnlimited: false,
          maxAmount: '100000',
        },
      }),
    ).toThrow();

    const parsed = UpdateCartSettingsRequestSchema.parse({
      cashierDiscountLimit: {
        percentUnlimited: false,
        maxPercentBp: 500,
        amountUnlimited: true,
        maxAmount: '0',
      },
      quickSaleDefaultMxik: '10203040506070809',
      quickSaleDefaultVatRateBp: 1200,
    });
    expect(parsed.cashierDiscountLimit.amountUnlimited).toBe(true);
    expect(parsed.quickSaleDefaultVatRateBp).toBe(1200);
  });

  it('validates promotion types, scopes, and half-open interval consistency', () => {
    const validNm = CreatePromotionRequestSchema.parse({
      name: '2+1 Aksiya',
      type: 'buy_x_get_y',
      scope: 'product',
      targetProductId: UUID_1,
      buyQty: 2,
      freeQty: 1,
      startsAtMs: '1760000000000',
      endsAtMs: '1760086400000',
    });
    expect(validNm.buyQty).toBe(2);

    // EndsAtMs <= StartsAtMs rejected
    expect(() =>
      CreatePromotionRequestSchema.parse({
        name: 'Bad Range',
        type: 'percent',
        scope: 'all',
        discountPercentBp: 1000,
        startsAtMs: '1760000000000',
        endsAtMs: '1760000000000',
      }),
    ).toThrow();

    // Missing scope target or mixed type fields rejected
    expect(() =>
      CreatePromotionRequestSchema.parse({
        name: 'Missing Prod',
        type: 'percent',
        scope: 'product',
        discountPercentBp: 1000,
        startsAtMs: '1760000000000',
      }),
    ).toThrow();

    expect(() =>
      CreatePromotionRequestSchema.parse({
        name: 'Mixed Fields',
        type: 'buy_x_get_y',
        scope: 'all',
        buyQty: 2,
        freeQty: 1,
        discountPercentBp: 500,
        startsAtMs: '1760000000000',
      }),
    ).toThrow();
  });

  it('validates scan/catalog/quick_sale lines, discount override payload, and ensures zero cost fields in CartDetailSchema', () => {
    const scanLine = AddCartLineRequestSchema.parse({
      kind: 'scan',
      barcode: ' 4006381333931 ',
    });
    expect(scanLine).toEqual({ kind: 'scan', barcode: '4006381333931', qty: '1000' });

    const quickLine = AddCartLineRequestSchema.parse({
      kind: 'quick_sale',
      name: 'Paket',
      unit: 'dona',
      qty: '2000',
      unitPrice: '50000',
    });
    expect(quickLine.kind).toBe('quick_sale');

    const disc = SetCartDiscountRequestSchema.parse({
      mode: 'percent',
      percentBp: 1500,
      reason: 'VIP mijoz',
      override: { username: 'manager1', pin: '849201' },
    });
    expect(disc.mode).toBe('percent');

    expect('costPrice' in CartDetailSchema.shape).toBe(false);
    expect('profit' in CartDetailSchema.shape).toBe(false);
    expect(() =>
      CartDetailSchema.parse({
        id: UUID_1,
        organizationId: UUID_1,
        storeId: UUID_2,
        cashierUserId: UUID_2,
        status: 'open',
        parkLabel: null,
        parkedAtMs: null,
        manualDiscountMode: 'none',
        manualDiscountValue: '0',
        manualDiscountReason: null,
        overrideApprovedByUserId: null,
        overrideApprovedAmount: null,
        overrideApprovedAtMs: null,
        subtotalGross: '0',
        totalPromoDiscount: '0',
        subtotalAfterPromo: '0',
        requestedOrderDiscount: '0',
        effectiveOrderDiscount: '0',
        totalFinal: '0',
        totalNetExVat: '0',
        totalVat: '0',
        totalFreeUnits: 0,
        exceedsCashierLimit: false,
        discountAuthorized: true,
        discountOverrideRequired: false,
        priceWarningsCount: 0,
        lines: [],
        createdAtMs: '100',
        updatedAtMs: '100',
        costPrice: '100',
      }),
    ).toThrow();
  });
});
