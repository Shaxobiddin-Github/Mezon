import { MAX_MONEY_TIYIN } from '@mezon/domain';
import { describe, expect, it } from 'vitest';
import {
  CashMoveDtoSchema,
  CompleteSaleRequestSchema,
  CompleteSaleResponseSchema,
  SaleDtoSchema,
  SaleLineDtoSchema,
} from './sale.js';

const UID = (seq: number) => `01950000-0000-7000-8000-${String(seq).padStart(12, '0')}`;

describe('@mezon/contracts - T1.5 mixed payments, bounds, cash_moves & cost/fiscal boundary', () => {
  it('validates T1.4 cash-only requests, T1.5 mixed/empty requests, MAX_MONEY_TIYIN bounds, and rejects invalid inputs', () => {
    // T1.4 backward compatible cash request
    const cashOnly = CompleteSaleRequestSchema.parse({
      clientRequestId: UID(1),
      expectedTotal: '150000',
      payments: [{ method: 'cash', tenderedAmount: '200000' }],
    });
    expect(cashOnly.payments[0]).toEqual({ method: 'cash', tenderedAmount: '200000' });

    // T1.5 empty array allowed at contract level (for 100%-discounted totalFinal=0 sales)
    const emptyPay = CompleteSaleRequestSchema.parse({
      clientRequestId: UID(1),
      expectedTotal: '0',
      payments: [],
    });
    expect(emptyPay.payments).toEqual([]);

    // Mixed: two card rows (with RRN ref), payme, uzqr, plus cash
    const mixed = CompleteSaleRequestSchema.parse({
      clientRequestId: UID(2),
      expectedTotal: '500000',
      payments: [
        { method: 'card', amount: '100000', providerRef: '  RRN-1  ' },
        { method: 'card', amount: '150000', providerRef: '   ' },
        { method: 'uzqr', amount: '100000' },
        { method: 'payme', amount: '50000', providerRef: 'PM-01' },
        { method: 'cash', tenderedAmount: '150000' },
      ],
    });
    expect(mixed.payments[0]).toEqual({ method: 'card', amount: '100000', providerRef: 'RRN-1' });
    expect(mixed.payments[1]).toEqual({ method: 'card', amount: '150000', providerRef: null });

    // Rejects tenderedAmount on non-cash method
    expect(() =>
      CompleteSaleRequestSchema.parse({
        clientRequestId: UID(1),
        expectedTotal: '150000',
        payments: [{ method: 'card', amount: '150000', tenderedAmount: '150000' }],
      }),
    ).toThrow();

    // Rejects providerRef on cash method
    expect(() =>
      CompleteSaleRequestSchema.parse({
        clientRequestId: UID(1),
        expectedTotal: '150000',
        payments: [{ method: 'cash', tenderedAmount: '150000', providerRef: 'ABC' }],
      }),
    ).toThrow();

    // Rejects > 1 cash row
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

    // Rejects zero and negative payment rows
    expect(() =>
      CompleteSaleRequestSchema.parse({
        clientRequestId: UID(1),
        expectedTotal: '150000',
        payments: [{ method: 'cash', tenderedAmount: '0' }],
      }),
    ).toThrow();
    expect(() =>
      CompleteSaleRequestSchema.parse({
        clientRequestId: UID(1),
        expectedTotal: '150000',
        payments: [{ method: 'card', amount: '0' }],
      }),
    ).toThrow();
    expect(() =>
      CompleteSaleRequestSchema.parse({
        clientRequestId: UID(1),
        expectedTotal: '150000',
        payments: [{ method: 'card', amount: '-100' }],
      }),
    ).toThrow();

    // M4 upper bound checks: MAX_MONEY_TIYIN passes, MAX_MONEY_TIYIN + 1n fails
    const maxStr = MAX_MONEY_TIYIN.toString();
    const overMaxStr = (MAX_MONEY_TIYIN + 1n).toString();
    expect(() =>
      CompleteSaleRequestSchema.parse({
        clientRequestId: UID(1),
        expectedTotal: maxStr,
        payments: [{ method: 'cash', tenderedAmount: maxStr }],
      }),
    ).not.toThrow();
    expect(() =>
      CompleteSaleRequestSchema.parse({
        clientRequestId: UID(1),
        expectedTotal: '10000',
        payments: [{ method: 'card', amount: maxStr }],
      }),
    ).not.toThrow();
    expect(() =>
      CompleteSaleRequestSchema.parse({
        clientRequestId: UID(1),
        expectedTotal: '10000',
        payments: [{ method: 'cash', tenderedAmount: overMaxStr }],
      }),
    ).toThrow();
    expect(() =>
      CompleteSaleRequestSchema.parse({
        clientRequestId: UID(1),
        expectedTotal: '10000',
        payments: [{ method: 'card', amount: overMaxStr }],
      }),
    ).toThrow();
    expect(() =>
      CompleteSaleRequestSchema.parse({
        clientRequestId: UID(1),
        expectedTotal: overMaxStr,
        payments: [],
      }),
    ).toThrow();
  });

  it('rejects any cost/profit fields on SaleLineDto, fiscal fields on SaleDto, and validates CashMoveDto', () => {
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
      completedByUserId: UID(7),
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
    expect(parsed.sale.completedByUserId).toBe(UID(7));

    // No fiscalStatus / fiscalReceiptNo on sales in F1
    expect(() => SaleDtoSchema.parse({ ...baseSale, fiscalStatus: 'pending' })).toThrow();
    expect(() => SaleDtoSchema.parse({ ...baseSale, fiscalReceiptNo: null })).toThrow();

    const parsedMove = CashMoveDtoSchema.parse({
      id: UID(40),
      organizationId: UID(2),
      storeId: UID(3),
      deviceId: UID(4),
      shiftId: null,
      type: 'sale_change_out',
      amountDelta: '-25000',
      sourceType: 'sale',
      sourceId: UID(20),
      paymentId: UID(30),
      reason: null,
      createdByUserId: UID(7),
      createdAtMs: '1760000000000',
    });
    expect(parsedMove.amountDelta).toBe('-25000');
  });
});
