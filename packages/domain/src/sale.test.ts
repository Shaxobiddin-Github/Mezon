import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  CASH_MOVE_INFLOW_TYPES,
  CASH_MOVE_OUTFLOW_TYPES,
  CASH_MOVE_TYPES,
  DomainError,
  MAX_MONEY_TIYIN,
  MAX_PROVIDER_REF_LENGTH,
  type NonCashPaymentMethod,
  PAYMENT_METHODS,
  type SalePaymentInput,
  ZERO_MONEY,
  canonicalizeCompleteSaleRequest,
  formatReceiptCode,
  isCashMoveInflow,
  isCashMoveType,
  moneyFromTiyin,
  moneyToTiyin,
  normalizePaymentProviderRef,
  parsePaymentMethod,
  parseUuidV7,
  resolveSalePayments,
  validateCashSalePayment,
  validateSalePaymentsInvariant,
} from './index.js';

const DEVICE_ID = parseUuidV7('01950000-0000-7000-8000-abcdef012345');
const CART_ID = parseUuidV7('01950000-0000-7000-8000-111111111111');
const CUSTOMER_ID = parseUuidV7('01950000-0000-7000-8000-222222222222');
const NON_CASH_METHODS = PAYMENT_METHODS.filter((m): m is NonCashPaymentMethod => m !== 'cash');

describe('@mezon/domain - sale payments, mixed methods, debt, cash_moves & invariants', () => {
  it('formats receiptCode, validates methods & cash_moves types, and normalizes providerRef', () => {
    expect(formatReceiptCode(DEVICE_ID, 1n)).toBe('2345-000001');
    expect(formatReceiptCode(DEVICE_ID, 42n)).toBe('2345-000042');
    expect(formatReceiptCode(DEVICE_ID, 1_234_567n)).toBe('2345-1234567');

    expect(() => formatReceiptCode(DEVICE_ID, 0n)).toThrow(DomainError);
    expect(() => formatReceiptCode(DEVICE_ID, -1n)).toThrow(DomainError);
    expect(() => parsePaymentMethod('crypto')).toThrow(DomainError);
    for (const method of PAYMENT_METHODS) {
      expect(parsePaymentMethod(method)).toBe(method);
    }

    for (const inflow of CASH_MOVE_INFLOW_TYPES) {
      expect(isCashMoveType(inflow)).toBe(true);
      expect(isCashMoveInflow(inflow)).toBe(true);
    }
    for (const outflow of CASH_MOVE_OUTFLOW_TYPES) {
      expect(isCashMoveType(outflow)).toBe(true);
      expect(isCashMoveInflow(outflow)).toBe(false);
    }
    expect(CASH_MOVE_TYPES).toEqual([
      'sale_cash_in',
      'debt_payment_in',
      'cash_in',
      'sale_change_out',
      'refund_cash_out',
      'cash_out',
      'encashment',
    ]);

    expect(normalizePaymentProviderRef(undefined)).toBeNull();
    expect(normalizePaymentProviderRef(null)).toBeNull();
    expect(normalizePaymentProviderRef('   ')).toBeNull();
    expect(normalizePaymentProviderRef('  RRN-0042  ')).toBe('RRN-0042');
    expect(() => normalizePaymentProviderRef('x'.repeat(MAX_PROVIDER_REF_LENGTH + 1))).toThrow(
      DomainError,
    );
  });

  it('validates cash-only, zero-total, multiple cards, mixed cash + non-cash, debt & MAX_MONEY_TIYIN bounds', () => {
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

    // Zero total (100% discount) closes cleanly with payments: []
    const zeroResolved = resolveSalePayments({
      totalFinal: ZERO_MONEY,
      debtAmount: ZERO_MONEY,
      customerId: null,
      payments: [],
    });
    validateSalePaymentsInvariant({
      totalFinal: ZERO_MONEY,
      debtAmount: ZERO_MONEY,
      customerId: null,
      payments: zeroResolved.payments,
    });
    expect(zeroResolved.payments).toEqual([]);
    expect(zeroResolved.totalPaid).toBe(ZERO_MONEY);
    expect(zeroResolved.changeAmount).toBe(ZERO_MONEY);

    // Non-empty payment rows on zero total are rejected
    const zeroWithCash = resolveSalePayments({
      totalFinal: ZERO_MONEY,
      debtAmount: ZERO_MONEY,
      customerId: null,
      payments: [{ method: 'cash', tenderedAmount: moneyFromTiyin(5_000n) }],
    });
    expect(() =>
      validateSalePaymentsInvariant({
        totalFinal: ZERO_MONEY,
        debtAmount: ZERO_MONEY,
        customerId: null,
        payments: zeroWithCash.payments,
      }),
    ).toThrow(DomainError);

    // Mixed: two cards + payme + cash with change
    const mixed = resolveSalePayments({
      totalFinal: moneyFromTiyin(500_000n),
      debtAmount: ZERO_MONEY,
      customerId: null,
      payments: [
        { method: 'card', amount: moneyFromTiyin(150_000n), providerRef: '  CARD-1  ' },
        { method: 'card', amount: moneyFromTiyin(100_000n), providerRef: 'CARD-2' },
        { method: 'payme', amount: moneyFromTiyin(120_000n), providerRef: 'PM-99' },
        { method: 'cash', tenderedAmount: moneyFromTiyin(200_000n) },
      ],
    });
    validateSalePaymentsInvariant({
      totalFinal: moneyFromTiyin(500_000n),
      debtAmount: ZERO_MONEY,
      customerId: null,
      payments: mixed.payments,
    });
    expect(mixed.payments[0]?.providerRef).toBe('CARD-1');
    expect(mixed.payments[3]?.amount).toBe(moneyFromTiyin(130_000n));
    expect(mixed.changeAmount).toBe(moneyFromTiyin(70_000n));
    expect(mixed.cashInAmount).toBe(moneyFromTiyin(200_000n));
    expect(mixed.cashChangeOutAmount).toBe(moneyFromTiyin(70_000n));
    expect(mixed.totalPaid).toBe(moneyFromTiyin(500_000n));

    // Exact int64 maximum succeeds, MAX + 1n fails cleanly
    const atMax = resolveSalePayments({
      totalFinal: moneyFromTiyin(MAX_MONEY_TIYIN),
      debtAmount: ZERO_MONEY,
      customerId: null,
      payments: [{ method: 'cash', tenderedAmount: moneyFromTiyin(MAX_MONEY_TIYIN) }],
    });
    validateSalePaymentsInvariant({
      totalFinal: moneyFromTiyin(MAX_MONEY_TIYIN),
      debtAmount: ZERO_MONEY,
      customerId: null,
      payments: atMax.payments,
    });
    expect(() =>
      resolveSalePayments({
        totalFinal: moneyFromTiyin(100_000n),
        debtAmount: ZERO_MONEY,
        customerId: null,
        payments: [{ method: 'cash', tenderedAmount: moneyFromTiyin(MAX_MONEY_TIYIN + 1n) }],
      }),
    ).toThrow(DomainError);
  });

  it('rejects all invariant violations (multiple cash, excess non-cash, zero/negative rows, missing customer for debt)', () => {
    // 2 cash rows rejected
    expect(() =>
      resolveSalePayments({
        totalFinal: moneyFromTiyin(100_000n),
        debtAmount: ZERO_MONEY,
        customerId: null,
        payments: [
          {
            method: 'cash',
            tenderedAmount: moneyFromTiyin(50_000n),
            amount: moneyFromTiyin(50_000n),
          },
          { method: 'cash', tenderedAmount: moneyFromTiyin(50_000n) },
        ],
      }),
    ).toThrow(DomainError);

    // Non-cash excess rejected (no change from card/qr)
    const excessCard = resolveSalePayments({
      totalFinal: moneyFromTiyin(100_000n),
      debtAmount: ZERO_MONEY,
      customerId: null,
      payments: [{ method: 'card', amount: moneyFromTiyin(100_001n) }],
    });
    expect(() =>
      validateSalePaymentsInvariant({
        totalFinal: moneyFromTiyin(100_000n),
        debtAmount: ZERO_MONEY,
        customerId: null,
        payments: excessCard.payments,
      }),
    ).toThrow(DomainError);

    // Zero and negative rows rejected
    expect(() =>
      resolveSalePayments({
        totalFinal: moneyFromTiyin(10_000n),
        debtAmount: ZERO_MONEY,
        customerId: null,
        payments: [{ method: 'card', amount: ZERO_MONEY }],
      }),
    ).toThrow(DomainError);
    expect(() =>
      resolveSalePayments({
        totalFinal: moneyFromTiyin(10_000n),
        debtAmount: ZERO_MONEY,
        customerId: null,
        payments: [{ method: 'cash', tenderedAmount: moneyFromTiyin(-1n) }],
      }),
    ).toThrow(DomainError);

    // Debt without customer rejected with CUSTOMER_REQUIRED; with customerId succeeds in domain
    const debtResolved = resolveSalePayments({
      totalFinal: moneyFromTiyin(100_000n),
      debtAmount: moneyFromTiyin(40_000n),
      customerId: null,
      payments: [{ method: 'uzqr', amount: moneyFromTiyin(60_000n) }],
    });
    expect(() =>
      validateSalePaymentsInvariant({
        totalFinal: moneyFromTiyin(100_000n),
        debtAmount: moneyFromTiyin(40_000n),
        customerId: null,
        payments: debtResolved.payments,
      }),
    ).toThrowError(expect.objectContaining({ code: 'CUSTOMER_REQUIRED' }));

    validateSalePaymentsInvariant({
      totalFinal: moneyFromTiyin(100_000n),
      debtAmount: moneyFromTiyin(40_000n),
      customerId: CUSTOMER_ID,
      payments: debtResolved.payments,
    });

    // Cash underpayment caught
    const shortCash = resolveSalePayments({
      totalFinal: moneyFromTiyin(10_000n),
      debtAmount: ZERO_MONEY,
      customerId: null,
      payments: [{ method: 'cash', tenderedAmount: moneyFromTiyin(9_999n) }],
    });
    expect(() =>
      validateSalePaymentsInvariant({
        totalFinal: moneyFromTiyin(10_000n),
        debtAmount: ZERO_MONEY,
        customerId: null,
        payments: shortCash.payments,
      }),
    ).toThrow(DomainError);

    // Change on non-cash caught
    expect(() =>
      validateSalePaymentsInvariant({
        totalFinal: moneyFromTiyin(100_000n),
        debtAmount: ZERO_MONEY,
        customerId: null,
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

    // B2: tenderedAmount passed directly on non-cash row to validateSalePaymentsInvariant must fail VALIDATION_ERROR
    expect(() =>
      validateSalePaymentsInvariant({
        totalFinal: moneyFromTiyin(100_000n),
        debtAmount: ZERO_MONEY,
        customerId: null,
        payments: [
          {
            method: 'card',
            amount: moneyFromTiyin(100_000n),
            tenderedAmount: moneyFromTiyin(100_000n),
            changeAmount: ZERO_MONEY,
          },
        ],
      }),
    ).toThrowError(expect.objectContaining({ code: 'VALIDATION_ERROR' }));
  });

  it('canonicalizes completeSale requests deterministically across equivalent inputs and differentiates changes', () => {
    const base = canonicalizeCompleteSaleRequest({
      cartId: CART_ID,
      expectedTotal: moneyFromTiyin(250_000n),
      debtAmount: ZERO_MONEY,
      customerId: null,
      payments: [
        { method: 'card', amount: moneyFromTiyin(100_000n), providerRef: '  REF-1  ' },
        { method: 'cash', tenderedAmount: moneyFromTiyin(200_000n) },
      ],
    });
    const equivalent = canonicalizeCompleteSaleRequest({
      cartId: CART_ID,
      expectedTotal: moneyFromTiyin(250_000n),
      debtAmount: ZERO_MONEY,
      customerId: null,
      payments: [
        { method: 'card', amount: moneyFromTiyin(100_000n), providerRef: 'REF-1' },
        { method: 'cash', tenderedAmount: moneyFromTiyin(200_000n) },
      ],
    });
    expect(base).toBe(equivalent);

    const diffPaymentAmount = canonicalizeCompleteSaleRequest({
      cartId: CART_ID,
      expectedTotal: moneyFromTiyin(250_000n),
      debtAmount: ZERO_MONEY,
      customerId: null,
      payments: [
        { method: 'card', amount: moneyFromTiyin(100_001n), providerRef: 'REF-1' },
        { method: 'cash', tenderedAmount: moneyFromTiyin(200_000n) },
      ],
    });
    expect(diffPaymentAmount).not.toBe(base);

    const diffMethod = canonicalizeCompleteSaleRequest({
      cartId: CART_ID,
      expectedTotal: moneyFromTiyin(250_000n),
      debtAmount: ZERO_MONEY,
      customerId: null,
      payments: [
        { method: 'payme', amount: moneyFromTiyin(100_000n), providerRef: 'REF-1' },
        { method: 'cash', tenderedAmount: moneyFromTiyin(200_000n) },
      ],
    });
    expect(diffMethod).not.toBe(base);
  });

  it('property test: valid mixed payment combinations, cash change & debt pass and every violation fails cleanly', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 0n, max: 100_000_000_000n }),
        fc.integer({ min: 0, max: 100 }),
        fc.array(
          fc.record({
            methodIdx: fc.integer({ min: 0, max: NON_CASH_METHODS.length - 1 }),
            weight: fc.integer({ min: 1, max: 100 }),
          }),
          { minLength: 0, maxLength: 5 },
        ),
        fc.boolean(),
        fc.bigInt({ min: 0n, max: 10_000_000n }),
        (totalTiyin, debtPct, nonCashSpecs, useCash, extraCash) => {
          if (totalTiyin === 0n) {
            const zeroRes = resolveSalePayments({
              totalFinal: ZERO_MONEY,
              debtAmount: ZERO_MONEY,
              customerId: null,
              payments: [],
            });
            validateSalePaymentsInvariant({
              totalFinal: ZERO_MONEY,
              debtAmount: ZERO_MONEY,
              customerId: null,
              payments: zeroRes.payments,
            });
            expect(zeroRes.payments).toEqual([]);
            return;
          }

          const debtTiyin = (totalTiyin * BigInt(debtPct)) / 100n;
          const remainingToPay = totalTiyin - debtTiyin;
          const customerId = debtTiyin > 0n ? CUSTOMER_ID : null;

          if (remainingToPay === 0n) {
            const debtOnlyRes = resolveSalePayments({
              totalFinal: moneyFromTiyin(totalTiyin),
              debtAmount: moneyFromTiyin(debtTiyin),
              customerId,
              payments: [],
            });
            validateSalePaymentsInvariant({
              totalFinal: moneyFromTiyin(totalTiyin),
              debtAmount: moneyFromTiyin(debtTiyin),
              customerId,
              payments: debtOnlyRes.payments,
            });
            expect(debtOnlyRes.totalPaid).toBe(ZERO_MONEY);
            return;
          }

          // Split remainingToPay into non-cash parts (plus cash if useCash || nonCashSpecs empty)
          const hasCash = useCash || nonCashSpecs.length === 0;
          const inputs: SalePaymentInput[] = [];
          let nonCashAllocated = 0n;

          if (nonCashSpecs.length > 0) {
            const nonCashBudget = hasCash ? remainingToPay / 2n : remainingToPay;
            const totalWeight = BigInt(nonCashSpecs.reduce((acc, s) => acc + s.weight, 0));
            for (let i = 0; i < nonCashSpecs.length; i += 1) {
              const spec = nonCashSpecs[i];
              const method = NON_CASH_METHODS[spec.methodIdx];
              const part =
                !hasCash && i === nonCashSpecs.length - 1
                  ? nonCashBudget - nonCashAllocated
                  : (nonCashBudget * BigInt(spec.weight)) / totalWeight;
              if (part > 0n) {
                inputs.push({ method, amount: moneyFromTiyin(part) });
                nonCashAllocated += part;
              }
            }
          }

          const cashNeed = remainingToPay - nonCashAllocated;
          if (cashNeed > 0n) {
            inputs.push({
              method: 'cash',
              tenderedAmount: moneyFromTiyin(cashNeed + extraCash),
            });
          } else if (inputs.length === 0) {
            inputs.push({
              method: 'card',
              amount: moneyFromTiyin(remainingToPay),
            });
          }

          const resolved = resolveSalePayments({
            totalFinal: moneyFromTiyin(totalTiyin),
            debtAmount: moneyFromTiyin(debtTiyin),
            customerId,
            payments: inputs,
          });
          validateSalePaymentsInvariant({
            totalFinal: moneyFromTiyin(totalTiyin),
            debtAmount: moneyFromTiyin(debtTiyin),
            customerId,
            payments: resolved.payments,
          });

          expect(moneyToTiyin(resolved.totalPaid) + moneyToTiyin(resolved.debtAmount)).toBe(
            totalTiyin,
          );
          expect(
            moneyToTiyin(resolved.cashInAmount) - moneyToTiyin(resolved.cashChangeOutAmount),
          ).toBe(
            resolved.payments
              .filter((p) => p.method === 'cash')
              .reduce((acc, p) => acc + moneyToTiyin(p.amount), 0n),
          );

          // Mutation check: inflating any single payment by 1 tiyin violates invariant
          const first = resolved.payments[0];
          if (first) {
            const mutatedPayments = [
              {
                ...first,
                amount: moneyFromTiyin(moneyToTiyin(first.amount) + 1n),
                tenderedAmount:
                  first.tenderedAmount !== null
                    ? moneyFromTiyin(moneyToTiyin(first.tenderedAmount) + 1n)
                    : null,
              },
              ...resolved.payments.slice(1),
            ];
            expect(() =>
              validateSalePaymentsInvariant({
                totalFinal: moneyFromTiyin(totalTiyin),
                debtAmount: moneyFromTiyin(debtTiyin),
                customerId,
                payments: mutatedPayments,
              }),
            ).toThrow(DomainError);
          }

          // Dropping customerId when debt > 0 fails with CUSTOMER_REQUIRED
          if (debtTiyin > 0n) {
            expect(() =>
              validateSalePaymentsInvariant({
                totalFinal: moneyFromTiyin(totalTiyin),
                debtAmount: moneyFromTiyin(debtTiyin),
                customerId: null,
                payments: resolved.payments,
              }),
            ).toThrowError(expect.objectContaining({ code: 'CUSTOMER_REQUIRED' }));
          }
        },
      ),
      { numRuns: 500 },
    );
  });
});
