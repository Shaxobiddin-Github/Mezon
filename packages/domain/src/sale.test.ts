import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  DomainError,
  ZERO_MONEY,
  formatReceiptCode,
  moneyFromTiyin,
  moneyToTiyin,
  parsePaymentMethod,
  parseUuidV7,
  validateCashSalePayment,
  validateSalePaymentsInvariant,
} from './index.js';

const DEVICE_ID = parseUuidV7('01950000-0000-7000-8000-abcdef012345');

describe('@mezon/domain - sale payment validation, receipt formatting & invariants', () => {
  it('formats display receiptCode from device suffix + monotonic sequence and validates bounds', () => {
    expect(formatReceiptCode(DEVICE_ID, 1n)).toBe('2345-000001');
    expect(formatReceiptCode(DEVICE_ID, 42n)).toBe('2345-000042');
    expect(formatReceiptCode(DEVICE_ID, 1_234_567n)).toBe('2345-1234567');

    expect(() => formatReceiptCode(DEVICE_ID, 0n)).toThrow(DomainError);
    expect(() => formatReceiptCode(DEVICE_ID, -1n)).toThrow(DomainError);
    expect(() => parsePaymentMethod('crypto')).toThrow(DomainError);
    expect(parsePaymentMethod('cash')).toBe('cash');
  });

  it('validates cash payment, exact change, zero-total checkouts, and payment invariants', () => {
    const exact = validateCashSalePayment({
      totalFinal: moneyFromTiyin(250_000n),
      tenderedAmount: moneyFromTiyin(250_000n),
    });
    expect(exact).toEqual({
      method: 'cash',
      amount: moneyFromTiyin(250_000n),
      tenderedAmount: moneyFromTiyin(250_000n),
      changeAmount: ZERO_MONEY,
    });

    const withChange = validateCashSalePayment({
      totalFinal: moneyFromTiyin(173_500n),
      tenderedAmount: moneyFromTiyin(200_000n),
    });
    expect(withChange.changeAmount).toBe(moneyFromTiyin(26_500n));

    const zeroSale = validateCashSalePayment({
      totalFinal: ZERO_MONEY,
      tenderedAmount: moneyFromTiyin(5_000n),
    });
    expect(zeroSale.amount).toBe(ZERO_MONEY);
    expect(zeroSale.changeAmount).toBe(moneyFromTiyin(5_000n));

    expect(() =>
      validateCashSalePayment({
        totalFinal: moneyFromTiyin(10_000n),
        tenderedAmount: moneyFromTiyin(9_999n),
      }),
    ).toThrow(DomainError);

    expect(() =>
      validateSalePaymentsInvariant({
        totalFinal: moneyFromTiyin(100_000n),
        debtAmount: ZERO_MONEY,
        payments: [
          {
            method: 'cash',
            amount: moneyFromTiyin(99_999n),
            tenderedAmount: moneyFromTiyin(99_999n),
            changeAmount: ZERO_MONEY,
          },
        ],
      }),
    ).toThrow(DomainError);

    expect(() =>
      validateSalePaymentsInvariant({
        totalFinal: moneyFromTiyin(100_000n),
        debtAmount: ZERO_MONEY,
        payments: [
          {
            method: 'card',
            amount: moneyFromTiyin(100_000n),
            tenderedAmount: null,
            changeAmount: moneyFromTiyin(1_000n),
          },
        ],
      }),
    ).toThrow(DomainError);
  });

  it('property test: cash payment + invariant preserve tendered - change = amount = totalFinal', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 0n, max: 100_000_000_000n }),
        fc.bigInt({ min: 0n, max: 10_000_000n }),
        (totalTiyin, extraTiyin) => {
          const totalFinal = moneyFromTiyin(totalTiyin);
          const tendered = moneyFromTiyin(totalTiyin + extraTiyin);
          const res = validateCashSalePayment({
            totalFinal,
            tenderedAmount: tendered,
          });
          expect(res.amount).toBe(totalFinal);
          expect(res.changeAmount).toBe(moneyFromTiyin(extraTiyin));
          expect(moneyToTiyin(res.tenderedAmount) - moneyToTiyin(res.changeAmount)).toBe(
            totalTiyin,
          );
          validateSalePaymentsInvariant({
            totalFinal,
            debtAmount: ZERO_MONEY,
            payments: [res],
          });
        },
      ),
      { numRuns: 200 },
    );
  });
});
