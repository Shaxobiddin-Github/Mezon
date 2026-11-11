import { describe, expect, it } from 'vitest';
import {
  CancelOrderRequestSchema,
  CreateOrderRequestSchema,
  DeliverOrderRequestSchema,
  OpenAdvancesResponseSchema,
  OrderDtoSchema,
  OrderLineDtoSchema,
  RecordOrderAdvanceRequestSchema,
  RefundOrderAdvanceRequestSchema,
  SalePaymentDtoSchema,
} from './index.js';

const UID = (n: number) => `01950000-0000-7000-8000-${String(n).padStart(12, '0')}`;

describe('@mezon/contracts - T1.10 orders & advances strict schemas', () => {
  it('validates catalog and quick_sale CreateOrderRequestSchema and requires customerName when customerId is null', () => {
    const parsed = CreateOrderRequestSchema.parse({
      clientRequestId: UID(1),
      customerName: '  Madina Karimova  ',
      customerPhone: '90 123-45-67',
      note: '  18:00 ga tayyor  ',
      discount: {
        mode: 'percent',
        percentBp: 500,
        reason: 'Doimiy mijoz',
      },
      lines: [
        { kind: 'catalog', productId: UID(10), qty: '2000' },
        {
          kind: 'quick_sale',
          name: 'Maxsus qadoq',
          unit: 'dona',
          qty: '1000',
          unitPrice: '1500000',
        },
      ],
    });
    expect(parsed.customerName).toBe('Madina Karimova');
    expect(parsed.customerPhone).toBe('+998901234567');
    expect(parsed.note).toBe('18:00 ga tayyor');
    expect(parsed.confirmImmediately).toBe(false);

    // Missing both customerId and customerName
    expect(() =>
      CreateOrderRequestSchema.parse({
        clientRequestId: UID(1),
        lines: [{ kind: 'catalog', productId: UID(10), qty: '1000' }],
      }),
    ).toThrow();
  });

  it('forbids advance method on deposits, refunds and additional delivery payments while permitting it in settled SalePaymentDto', () => {
    expect(() =>
      RecordOrderAdvanceRequestSchema.parse({
        clientRequestId: UID(2),
        payments: [{ method: 'advance', amount: '50000' }],
      }),
    ).toThrow();

    expect(() =>
      RefundOrderAdvanceRequestSchema.parse({
        clientRequestId: UID(3),
        reason: 'Bekor',
        refunds: [{ method: 'advance', amount: '50000' }],
      }),
    ).toThrow();

    expect(() =>
      DeliverOrderRequestSchema.parse({
        clientRequestId: UID(4),
        expectedTotal: '100000',
        payments: [{ method: 'advance', amount: '50000' }],
      }),
    ).toThrow();

    expect(() =>
      SalePaymentDtoSchema.parse({
        id: UID(5),
        method: 'advance',
        amount: '50000',
        tenderedAmount: null,
        changeAmount: '0',
        providerRef: null,
        createdAtMs: '1760000000000',
      }),
    ).not.toThrow();
  });

  it('enforces cost-hiding on OrderLineDto and mandatory reason on CancelOrderRequest', () => {
    const line = {
      id: UID(10),
      sortOrder: 0,
      lineKind: 'catalog' as const,
      productId: UID(11),
      variantId: null,
      categoryIdSnapshot: null,
      itemName: 'Tort',
      unit: 'dona' as const,
      qty: '1000',
      unitPriceSnapshot: '100000',
      appliedPromotionId: null,
      appliedPromotionName: null,
      freeUnits: 0,
      grossTotal: '100000',
      promoDiscount: '0',
      subtotalAfterPromo: '100000',
      allocatedOrderDiscount: '0',
      finalTotal: '100000',
      vatRateBpSnapshot: 1200,
      netExVat: '89286',
      vatTotal: '10714',
      mxikSnapshot: null,
      packageCodeSnapshot: null,
    };

    expect(() => OrderLineDtoSchema.parse(line)).not.toThrow();
    expect(() => OrderLineDtoSchema.parse({ ...line, costPrice: '50000' })).toThrow();

    const zeroBreakdown = {
      cash: '50000',
      card: '0',
      uzqr: '0',
      payme: '0',
      click: '0',
      uzum: '0',
      social_card: '0',
      other: '0',
    };

    expect(() =>
      OrderDtoSchema.parse({
        id: UID(20),
        organizationId: UID(1),
        storeId: UID(2),
        deviceId: UID(3),
        orderNo: '1',
        orderCode: 'ORD-0003-000001',
        status: 'confirmed',
        customerId: null,
        customerName: 'Madina',
        customerPhoneNormalized: null,
        dueAtMs: null,
        note: null,
        subtotalGross: '100000',
        totalPromoDiscount: '0',
        subtotalAfterPromo: '100000',
        manualDiscountMode: 'none',
        manualDiscountValue: '0',
        manualDiscountReason: null,
        orderDiscountAmount: '0',
        totalAmount: '100000',
        totalNetExVat: '89286',
        totalVat: '10714',
        netAdvance: '50000',
        remainingToPay: '50000',
        netAdvanceByMethod: zeroBreakdown,
        overrideApprovedByUserId: null,
        overrideApprovedAmount: null,
        createdByUserId: UID(4),
        createdAtMs: '1760000000000',
        confirmedAtMs: '1760000000000',
        readyAtMs: null,
        deliveredAtMs: null,
        deliveredSaleId: null,
        cancelledAtMs: null,
        cancelledByUserId: null,
        cancelReason: null,
        lines: [line],
        payments: [],
      }),
    ).not.toThrow();

    expect(() =>
      CancelOrderRequestSchema.parse({
        clientRequestId: UID(30),
        reason: '   ',
      }),
    ).toThrow();

    expect(() =>
      OpenAdvancesResponseSchema.parse({
        totalOpenAdvance: '50000',
        byMethod: zeroBreakdown,
        openOrdersCount: 1,
      }),
    ).not.toThrow();
  });
});
