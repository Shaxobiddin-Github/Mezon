import type { SaleReturnContextLineDto } from '@mezon/contracts';
import { parseUuidV7 } from '@mezon/domain';
import { describe, expect, it } from 'vitest';
import { lineRefundTiyin, planRefund, remainingQtyMilli } from './return-plan.js';

const line: SaleReturnContextLineDto = {
  id: parseUuidV7('01960000-0000-7000-8000-0000000000a1'),
  itemName: 'Qatiq',
  unit: 'dona',
  qty: '3000',
  unitPriceSnapshot: '1000000',
  finalTotal: '1000000',
  netExVat: '892857',
  vatTotal: '107143',
  returnedQty: '0',
  refundedAmount: '0',
  returnedNetExVat: '0',
  returnedVatTotal: '0',
};

describe('C12 return plan', () => {
  it('partial returns add up to the line total exactly (cumulative rounding)', () => {
    const first = lineRefundTiyin(line, 1000n);
    expect(first).toBe(333333n);
    const after = {
      ...line,
      returnedQty: '1000',
      refundedAmount: first.toString(),
      returnedNetExVat: '297619',
      returnedVatTotal: '35714',
    };
    expect(remainingQtyMilli(after)).toBe(2000n);
    expect(first + lineRefundTiyin(after, 2000n)).toBe(1_000_000n);
  });

  it('more than remains, or half a piece, is rejected by the same domain rule as the hub', () => {
    expect(() => lineRefundTiyin(line, 4000n)).toThrow(/exceeds remaining/);
    expect(() => lineRefundTiyin(line, 500n)).toThrow();
  });

  it('a refund covers the receipt debt first, then cash, then the other methods', () => {
    expect(
      planRefund(500n, {
        remainingSaleDebt: '200',
        refundableByMethod: [
          { method: 'card', amount: '1000' },
          { method: 'cash', amount: '100' },
        ],
      }),
    ).toEqual({
      debtOffset: 200n,
      payments: [
        { method: 'cash', amount: 100n },
        { method: 'card', amount: 200n },
      ],
    });
  });

  it('returns null when the limits cannot cover the refund', () => {
    expect(
      planRefund(500n, {
        remainingSaleDebt: '0',
        refundableByMethod: [{ method: 'cash', amount: '499' }],
      }),
    ).toBeNull();
    expect(planRefund(0n, { remainingSaleDebt: '0', refundableByMethod: [] })).toEqual({
      debtOffset: 0n,
      payments: [],
    });
  });
});
