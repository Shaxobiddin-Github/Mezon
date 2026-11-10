import { describe, expect, it } from 'vitest';
import {
  CompleteSaleRequestSchema,
  CompleteSaleResponseSchema,
  SaleDtoSchema,
  SaleLineDtoSchema,
} from './sale.js';

const UID = (seq: number) => `01950000-0000-7000-8000-${String(seq).padStart(12, '0')}`;

describe('@mezon/contracts - T1.4 completeSale schemas & cost/fiscal boundary', () => {
  it('validates completeSale request and requires exactly one cash payment', () => {
    const ok = CompleteSaleRequestSchema.parse({
      clientRequestId: UID(1),
      expectedTotal: '150000',
      payments: [{ method: 'cash', tenderedAmount: '200000' }],
    });
    expect(ok.payments[0]?.tenderedAmount).toBe('200000');

    expect(() =>
      CompleteSaleRequestSchema.parse({
        clientRequestId: UID(1),
        expectedTotal: '150000',
        payments: [],
      }),
    ).toThrow();

    expect(() =>
      CompleteSaleRequestSchema.parse({
        clientRequestId: UID(1),
        expectedTotal: '150000',
        payments: [{ method: 'card', tenderedAmount: '150000' }],
      }),
    ).toThrow();

    expect(() =>
      CompleteSaleRequestSchema.parse({
        clientRequestId: UID(1),
        expectedTotal: '150000',
        payments: [
          { method: 'cash', tenderedAmount: '100000' },
          { method: 'cash', tenderedAmount: '50000' },
        ],
      }),
    ).toThrow();
  });

  it('rejects any cost/profit fields on SaleLineDto and any fiscal fields on SaleDto', () => {
    const baseLine = {
      id: UID(10),
      sortOrder: 0,
      lineKind: 'catalog' as const,
      productId: UID(11),
      variantId: null,
      categoryIdSnapshot: null,
      itemName: 'Suv',
      unit: 'dona' as const,
      qty: '1000',
      unitPriceSnapshot: '500000',
      appliedPromotionId: null,
      appliedPromotionName: null,
      freeUnits: 0,
      grossTotal: '500000',
      promoDiscount: '0',
      subtotalAfterPromo: '500000',
      allocatedOrderDiscount: '0',
      finalTotal: '500000',
      vatRateBpSnapshot: 0,
      netExVat: '500000',
      vatTotal: '0',
      mxikSnapshot: null,
      packageCodeSnapshot: null,
    };
    expect(() => SaleLineDtoSchema.parse(baseLine)).not.toThrow();
    expect(() => SaleLineDtoSchema.parse({ ...baseLine, costValue: '300000' })).toThrow();

    const baseSale = {
      id: UID(20),
      receiptNo: '1',
      receiptCode: '0002-000001',
      organizationId: UID(2),
      storeId: UID(3),
      deviceId: UID(4),
      sourceCartId: UID(5),
      cashierUserId: UID(6),
      customerId: null,
      shiftId: null,
      clientRequestId: UID(1),
      status: 'completed' as const,
      subtotalGross: '500000',
      totalPromoDiscount: '0',
      subtotalAfterPromo: '500000',
      manualDiscountMode: 'none' as const,
      manualDiscountValue: '0',
      manualDiscountReason: null,
      orderDiscountAmount: '0',
      totalFinal: '500000',
      totalNetExVat: '500000',
      totalVat: '0',
      totalPaid: '500000',
      debtAmount: '0',
      changeAmount: '0',
      overrideApprovedByUserId: null,
      overrideApprovedAmount: null,
      overrideApprovedAtMs: null,
      createdAtMs: '1760000000000',
      lines: [baseLine],
      payments: [
        {
          id: UID(30),
          method: 'cash' as const,
          amount: '500000',
          tenderedAmount: '500000',
          changeAmount: '0',
          providerRef: null,
          createdAtMs: '1760000000000',
        },
      ],
    };

    const parsed = CompleteSaleResponseSchema.parse({
      sale: baseSale,
      warnings: [],
    });
    expect(parsed.sale.receiptCode).toBe('0002-000001');

    // No fiscalStatus / fiscalReceiptNo on sales in T1.4
    expect(() => SaleDtoSchema.parse({ ...baseSale, fiscalStatus: 'pending' })).toThrow();
    expect(() => SaleDtoSchema.parse({ ...baseSale, fiscalReceiptNo: null })).toThrow();
  });
});
