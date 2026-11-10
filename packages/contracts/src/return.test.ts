import { describe, expect, it } from 'vitest';
import {
  CreateReturnRequestSchema,
  CreateReturnResponseSchema,
  ReturnDtoSchema,
  ReturnLineDtoSchema,
  SalesLinesReportSummarySchema,
  VoidSaleRequestSchema,
  VoidSaleResponseSchema,
} from './index.js';

const UUID_1 = '0195a1b2-0000-7000-8000-000000000001';
const UUID_2 = '0195a1b2-0000-7000-8000-000000000002';
const UUID_3 = '0195a1b2-0000-7000-8000-000000000003';
const UUID_4 = '0195a1b2-0000-7000-8000-000000000004';
const UUID_5 = '0195a1b2-0000-7000-8000-000000000005';

describe('@mezon/contracts - void, return, and report schemas', () => {
  it('validates VoidSaleRequestSchema and mandatory trimmed reason', () => {
    const parsed = VoidSaleRequestSchema.parse({
      clientRequestId: UUID_1,
      reason: '  Kassir xato urgan  ',
      override: { username: 'mgr1', pin: '849201' },
    });
    expect(parsed.reason).toBe('Kassir xato urgan');
    expect(() =>
      VoidSaleRequestSchema.parse({
        clientRequestId: UUID_1,
        reason: '   ',
      }),
    ).toThrow();
    expect(() =>
      VoidSaleRequestSchema.parse({
        clientRequestId: UUID_1,
        reason: 'Test',
        extraField: 123,
      }),
    ).toThrow();
  });

  it('validates CreateReturnRequestSchema and rejects duplicate saleLineId or duplicate cash payments', () => {
    const valid = CreateReturnRequestSchema.parse({
      clientRequestId: UUID_1,
      reason: '  Mijoz qaytardi ',
      items: [{ saleLineId: UUID_2, qty: '2000' }],
      payments: [
        { method: 'cash', amount: '10000' },
        { method: 'card', amount: '5000', providerRef: ' RRN-88 ' },
      ],
    });
    expect(valid.reason).toBe('Mijoz qaytardi');
    expect(valid.payments[1]).toEqual({ method: 'card', amount: '5000', providerRef: 'RRN-88' });

    // Duplicate saleLineId rejected
    expect(() =>
      CreateReturnRequestSchema.parse({
        clientRequestId: UUID_1,
        reason: 'Dup',
        items: [
          { saleLineId: UUID_2, qty: '1000' },
          { saleLineId: UUID_2, qty: '1000' },
        ],
        payments: [{ method: 'cash', amount: '1000' }],
      }),
    ).toThrow();

    // Duplicate cash payment rejected
    expect(() =>
      CreateReturnRequestSchema.parse({
        clientRequestId: UUID_1,
        reason: 'Dup cash',
        items: [{ saleLineId: UUID_2, qty: '1000' }],
        payments: [
          { method: 'cash', amount: '500' },
          { method: 'cash', amount: '500' },
        ],
      }),
    ).toThrow();

    // Empty items rejected
    expect(() =>
      CreateReturnRequestSchema.parse({
        clientRequestId: UUID_1,
        reason: 'Empty',
        items: [],
        payments: [],
      }),
    ).toThrow();
  });

  it('strictly omits costValue and profit from cashier ReturnLineDtoSchema and VoidSaleResponseSchema', () => {
    const baseLine = {
      id: UUID_1,
      returnId: UUID_2,
      saleId: UUID_3,
      saleLineId: UUID_4,
      sortOrder: 0,
      lineKind: 'catalog' as const,
      productId: UUID_5,
      variantId: null,
      itemName: 'Olma',
      unit: 'kg' as const,
      qty: '1000',
      unitPriceSnapshot: '10000',
      vatRateBpSnapshot: 1200,
      mxikSnapshot: null,
      packageCodeSnapshot: null,
      refundAmount: '10000',
      netExVat: '8929',
      vatTotal: '1071',
    };

    expect(ReturnLineDtoSchema.parse(baseLine)).toEqual(baseLine);
    expect(() => ReturnLineDtoSchema.parse({ ...baseLine, costValue: '5000' })).toThrow();
    expect(() => ReturnLineDtoSchema.parse({ ...baseLine, profit: '3000' })).toThrow();

    const doc = {
      id: UUID_2,
      returnNo: '1',
      returnCode: 'RET-0001-000001',
      organizationId: UUID_1,
      storeId: UUID_2,
      deviceId: UUID_3,
      saleId: UUID_4,
      processedByUserId: UUID_5,
      overrideApprovedByUserId: null,
      overrideApprovedAtMs: null,
      reason: 'Sifatsiz',
      clientRequestId: UUID_1,
      totalRefund: '10000',
      totalNetExVat: '8929',
      totalVat: '1071',
      cashRefundAmount: '10000',
      nonCashRefundAmount: '0',
      debtOffsetAmount: '0',
      createdAtMs: '1750000000000',
      lines: [baseLine],
      payments: [
        {
          id: UUID_4,
          method: 'cash' as const,
          amount: '10000',
          providerRef: null,
          createdAtMs: '1750000000000',
        },
      ],
    };

    expect(ReturnDtoSchema.parse(doc)).toEqual(doc);
    expect(
      CreateReturnResponseSchema.parse({
        returnDoc: doc,
        idempotentReplay: false,
      }).idempotentReplay,
    ).toBe(false);

    const summary = SalesLinesReportSummarySchema.parse({
      lineCount: 4,
      signedQtyTotal: '3000',
      revenue: '25000',
      netRevenue: '22321',
      vatTotal: '2679',
      costValue: '14000',
      grossProfit: '8321',
    });
    expect(summary.grossProfit).toBe('8321');
    expect(typeof VoidSaleResponseSchema.parse).toBe('function');
  });
});
