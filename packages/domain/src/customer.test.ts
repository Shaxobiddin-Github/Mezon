import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  DomainError,
  type LedgerEntryForFifo,
  ZERO_MONEY,
  allocateCustomerLedgerFifo,
  assertCreditLimitForSale,
  canonicalizeDebtAdjustmentRequest,
  canonicalizeDebtPaymentRequest,
  canonicalizeOpeningBalanceRequest,
  computeDebtDueAtMs,
  computeNextCustomerBalance,
  computeOverdueDaysAt,
  epochDaysFromCivilDate,
  moneyFromTiyin,
  moneyToTiyin,
  normalizeCustomerDueDays,
  normalizeCustomerFullName,
  normalizeCustomerPhone,
  normalizeCustomerSearchQuery,
  normalizeCustomerSearchText,
  parseUuidV7,
  unixMsFromBigInt,
} from './index.js';

const CUST_ID = parseUuidV7('01970000-0000-7000-8000-000000000001');
const SALE_1 = parseUuidV7('01970000-0000-7000-8000-000000000101');
const SALE_2 = parseUuidV7('01970000-0000-7000-8000-000000000102');

function makeEntryId(seq: bigint): ReturnType<typeof parseUuidV7> {
  return parseUuidV7(`01970000-0000-7000-8000-${seq.toString().padStart(12, '0')}`);
}

function makeHlc(seq: bigint): string {
  return `${seq.toString().padStart(16, '0')}-0000-01970000000070008000000000000001`;
}

describe('@mezon/domain - customer profile, PII-safe phone, D1/D2/D3 FIFO & overdue', () => {
  it('normalizes local UZ and E.164 international phones without leaking raw PII in errors', () => {
    expect(normalizeCustomerPhone(null)).toBeNull();
    expect(normalizeCustomerPhone('   ')).toBeNull();

    expect(normalizeCustomerPhone('90 123-45-67')).toEqual({
      phoneNormalized: '+998901234567',
      phoneDigits: '998901234567',
    });
    expect(normalizeCustomerPhone('998 (91) 555.00.11')).toEqual({
      phoneNormalized: '+998915550011',
      phoneDigits: '998915550011',
    });
    expect(normalizeCustomerPhone('+998 93 777 88 99')).toEqual({
      phoneNormalized: '+998937778899',
      phoneDigits: '998937778899',
    });
    expect(normalizeCustomerPhone('+7 701 123 45 67')).toEqual({
      phoneNormalized: '+77011234567',
      phoneDigits: '77011234567',
    });
    expect(normalizeCustomerPhone('+992 90 555 1234')).toEqual({
      phoneNormalized: '+992905551234',
      phoneDigits: '992905551234',
    });

    for (const badPhone of ['+012345678', '+12345', '12345', '999901234567', 'abc-99890']) {
      try {
        normalizeCustomerPhone(badPhone);
        expect.unreachable(`Expected phone "${badPhone}" to fail`);
      } catch (err) {
        expect(err).toBeInstanceOf(DomainError);
        expect((err as DomainError).code).toBe('VALIDATION_ERROR');
        expect((err as DomainError).message).not.toContain(badPhone);
      }
    }

    const secretName = 'Abdulloh Karimov';
    expect(normalizeCustomerFullName('  Abdulloh   Karimov  ')).toBe(secretName);
    expect(normalizeCustomerSearchText('Ғулом Қаюмов')).toBe('gulom qayumov');
    expect(normalizeCustomerSearchQuery(' +998 90-123 ')).toEqual({
      textQuery: '998 90 123',
      digitsOnly: '99890123',
    });
    try {
      normalizeCustomerFullName('   ');
      expect.unreachable('Expected empty fullName to fail');
    } catch (err) {
      expect((err as DomainError).code).toBe('VALIDATION_ERROR');
    }

    expect(normalizeCustomerDueDays(null)).toBeNull();
    expect(normalizeCustomerDueDays(14)).toBe(14);
    expect(() => normalizeCustomerDueDays(0)).toThrowError(/VALIDATION_ERROR/);
  });

  it('D1: computeNextCustomerBalance blocks negative balance across debt_payment, negative adjustment, return_offset & sale_void', () => {
    const cur = moneyFromTiyin(50_000n);

    expect(
      moneyToTiyin(
        computeNextCustomerBalance({
          currentBalance: cur,
          delta: moneyFromTiyin(-50_000n),
          operation: 'debt_payment',
        }),
      ),
    ).toBe(0n);

    expect(() =>
      computeNextCustomerBalance({
        currentBalance: cur,
        delta: moneyFromTiyin(-50_001n),
        operation: 'debt_payment',
      }),
    ).toThrowError(/OVERPAYMENT_NOT_ALLOWED/);

    expect(() =>
      computeNextCustomerBalance({
        currentBalance: cur,
        delta: moneyFromTiyin(-50_001n),
        operation: 'adjustment',
      }),
    ).toThrowError(/OVERPAYMENT_NOT_ALLOWED/);

    expect(() =>
      computeNextCustomerBalance({
        currentBalance: cur,
        delta: moneyFromTiyin(-30_001n),
        operation: 'return_offset',
        saleRemainingDebt: moneyFromTiyin(30_000n),
      }),
    ).toThrowError(/RETURN_DEBT_OFFSET_EXCEEDED/);

    expect(() =>
      computeNextCustomerBalance({
        currentBalance: cur,
        delta: moneyFromTiyin(-40_000n),
        operation: 'sale_void',
        saleRemainingDebt: moneyFromTiyin(39_999n),
      }),
    ).toThrowError(/SALE_DEBT_HAS_PAYMENTS/);

    expect(() =>
      assertCreditLimitForSale({
        currentBalance: moneyFromTiyin(80_000n),
        newDebtAmount: moneyFromTiyin(20_001n),
        creditLimit: moneyFromTiyin(100_000n),
        creditOverrideAuthorized: false,
      }),
    ).toThrowError(/CREDIT_LIMIT_EXCEEDED/);

    expect(() =>
      assertCreditLimitForSale({
        currentBalance: moneyFromTiyin(80_000n),
        newDebtAmount: moneyFromTiyin(20_001n),
        creditLimit: moneyFromTiyin(100_000n),
        creditOverrideAuthorized: true,
      }),
    ).not.toThrow();
  });

  it('D2 + D3: allocates FIFO strictly by (hlc, id) regardless of array order & handles positive/negative adjustments + due deadlines in Asia/Tashkent', () => {
    // 2026-06-01 10:00 Asia/Tashkent (05:00Z)
    const day1Ms = unixMsFromBigInt(
      epochDaysFromCivilDate('2026-06-01') * 86_400_000n + 5n * 3_600_000n,
    );
    const due3 = computeDebtDueAtMs({
      createdAtMs: day1Ms,
      dueDays: 3,
      storeTimezone: 'Asia/Tashkent',
    });
    // Last on-time day: 2026-06-04; overdue starts 2026-06-05 00:00 Asia/Tashkent (2026-06-04T19:00:00Z)
    const expectedCutoff = epochDaysFromCivilDate('2026-06-04') * 86_400_000n + 19n * 3_600_000n;
    expect(due3).toBe(unixMsFromBigInt(expectedCutoff));

    const beforeCutoff = unixMsFromBigInt(expectedCutoff - 1_000n); // 23:59:59 Tashkent
    const afterCutoff = unixMsFromBigInt(expectedCutoff + 60_000n); // 00:01:00 Tashkent
    expect(
      computeOverdueDaysAt({
        asOfMs: beforeCutoff,
        dueAtMs: due3,
        storeTimezone: 'Asia/Tashkent',
      }),
    ).toBe(0n);
    expect(
      computeOverdueDaysAt({
        asOfMs: afterCutoff,
        dueAtMs: due3,
        storeTimezone: 'Asia/Tashkent',
      }),
    ).toBe(1n);

    const day2DueLater = computeDebtDueAtMs({
      createdAtMs: unixMsFromBigInt(
        epochDaysFromCivilDate('2026-06-03') * 86_400_000n + 5n * 3_600_000n,
      ),
      dueDays: 10,
      storeTimezone: 'Asia/Tashkent',
    });

    const entriesInOrder: LedgerEntryForFifo[] = [
      {
        id: makeEntryId(1n),
        hlc: makeHlc(10n),
        createdAtMs: day1Ms,
        entryType: 'opening_balance',
        amountDelta: moneyFromTiyin(40_000n),
        sourceType: 'opening_balance',
        saleId: null,
        paymentMethod: null,
        dueAtMs: due3,
      },
      {
        id: makeEntryId(2n),
        hlc: makeHlc(20n),
        createdAtMs: day1Ms,
        entryType: 'sale_debt',
        amountDelta: moneyFromTiyin(60_000n),
        sourceType: 'sale',
        saleId: SALE_1,
        paymentMethod: null,
        dueAtMs: due3,
      },
      // D3: positive adjustment enters FIFO without artificial due date unless set
      {
        id: makeEntryId(3n),
        hlc: makeHlc(30n),
        createdAtMs: day1Ms,
        entryType: 'adjustment',
        amountDelta: moneyFromTiyin(25_000n),
        sourceType: 'adjustment',
        saleId: null,
        paymentMethod: null,
        dueAtMs: null,
      },
      {
        id: makeEntryId(4n),
        hlc: makeHlc(40n),
        createdAtMs: afterCutoff,
        entryType: 'sale_debt',
        amountDelta: moneyFromTiyin(50_000n),
        sourceType: 'sale',
        saleId: SALE_2,
        paymentMethod: null,
        dueAtMs: day2DueLater,
      },
      // Pay 75,000 -> closes 40,000 opening_balance + 35,000 of SALE_1
      {
        id: makeEntryId(5n),
        hlc: makeHlc(50n),
        createdAtMs: afterCutoff,
        entryType: 'debt_payment',
        amountDelta: moneyFromTiyin(-75_000n),
        sourceType: 'debt_payment',
        saleId: null,
        paymentMethod: 'card',
        dueAtMs: null,
      },
      // Negative adjustment -30,000 -> closes remaining 25,000 of SALE_1 + 5,000 of positive adjustment
      {
        id: makeEntryId(6n),
        hlc: makeHlc(60n),
        createdAtMs: afterCutoff,
        entryType: 'adjustment',
        amountDelta: moneyFromTiyin(-30_000n),
        sourceType: 'adjustment',
        saleId: null,
        paymentMethod: null,
        dueAtMs: null,
      },
    ];

    const forward = allocateCustomerLedgerFifo({
      entries: entriesInOrder,
      asOfMs: afterCutoff,
      storeTimezone: 'Asia/Tashkent',
    });
    const reversed = allocateCustomerLedgerFifo({
      entries: [...entriesInOrder].reverse(),
      asOfMs: afterCutoff,
      storeTimezone: 'Asia/Tashkent',
    });

    expect(reversed.balance).toBe(forward.balance);
    expect(moneyToTiyin(forward.balance)).toBe(70_000n); // 20_000 positive adj (no deadline) + 50_000 SALE_2 (future due)
    expect(moneyToTiyin(forward.overdueAmount)).toBe(0n); // Both overdue debits were settled FIFO!
    expect(reversed.obligations).toEqual(forward.obligations);

    const s1 = forward.bySaleId.get(SALE_1)!;
    expect(moneyToTiyin(s1.fifoPaidTotal)).toBe(35_000n);
    expect(moneyToTiyin(s1.fifoPaidByMethod.card)).toBe(35_000n);
    expect(moneyToTiyin(s1.fifoWaivedTotal)).toBe(25_000n);
    expect(moneyToTiyin(s1.remainingDebt)).toBe(0n);
  });

  it('D1 + D2 + D3 property test: random ledger ops preserve balance >= 0, HLC order invariance & FIFO sum equality across 300 runs', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            kind: fc.constantFrom('sale', 'pay', 'pos_adj', 'neg_adj'),
            amt: fc.bigInt({ min: 1n, max: 50_000n }),
            method: fc.constantFrom<'cash' | 'card' | 'payme'>('cash', 'card', 'payme'),
            withDue: fc.boolean(),
          }),
          { minLength: 1, maxLength: 30 },
        ),
        (ops) => {
          let seq = 1n;
          let balance = ZERO_MONEY;
          const entries: LedgerEntryForFifo[] = [];
          const t0 = epochDaysFromCivilDate('2026-06-01') * 86_400_000n + 5n * 3_600_000n;

          for (const op of ops) {
            const nowMs = unixMsFromBigInt(t0 + seq * 60_000n);
            const hlc = makeHlc(seq);
            const id = makeEntryId(seq);
            seq += 1n;

            if (op.kind === 'sale') {
              const saleId = makeEntryId(10_000n + seq);
              const delta = moneyFromTiyin(op.amt);
              balance = computeNextCustomerBalance({
                currentBalance: balance,
                delta,
                operation: 'sale_debt',
              });
              entries.push({
                id,
                hlc,
                createdAtMs: nowMs,
                entryType: 'sale_debt',
                amountDelta: delta,
                sourceType: 'sale',
                saleId,
                paymentMethod: null,
                dueAtMs: op.withDue ? unixMsFromBigInt(t0 + 100_000n) : null,
              });
            } else if (op.kind === 'pos_adj') {
              const delta = moneyFromTiyin(op.amt);
              balance = computeNextCustomerBalance({
                currentBalance: balance,
                delta,
                operation: 'adjustment',
              });
              entries.push({
                id,
                hlc,
                createdAtMs: nowMs,
                entryType: 'adjustment',
                amountDelta: delta,
                sourceType: 'adjustment',
                saleId: null,
                paymentMethod: null,
                dueAtMs: op.withDue ? unixMsFromBigInt(t0 + 200_000n) : null,
              });
            } else {
              const cur = moneyToTiyin(balance);
              if (cur <= 0n) continue;
              const payAmt = op.amt <= cur ? op.amt : cur;
              const delta = moneyFromTiyin(-payAmt);
              balance = computeNextCustomerBalance({
                currentBalance: balance,
                delta,
                operation: op.kind === 'pay' ? 'debt_payment' : 'adjustment',
              });
              entries.push({
                id,
                hlc,
                createdAtMs: nowMs,
                entryType: op.kind === 'pay' ? 'debt_payment' : 'adjustment',
                amountDelta: delta,
                sourceType: op.kind === 'pay' ? 'debt_payment' : 'adjustment',
                saleId: null,
                paymentMethod: op.kind === 'pay' ? op.method : null,
                dueAtMs: null,
              });
            }
          }

          const asOf = unixMsFromBigInt(t0 + 500_000n);
          const r1 = allocateCustomerLedgerFifo({ entries, asOfMs: asOf });
          const r2 = allocateCustomerLedgerFifo({
            entries: [...entries].reverse(),
            asOfMs: asOf,
          });

          const sumRemaining = r1.obligations.reduce(
            (acc, ob) => acc + moneyToTiyin(ob.remainingDebt),
            0n,
          );
          expect(r1.balance).toBe(balance);
          expect(moneyToTiyin(r1.balance)).toBeGreaterThanOrEqual(0n);
          expect(sumRemaining).toBe(moneyToTiyin(r1.balance));
          expect(moneyToTiyin(r1.overdueAmount)).toBeLessThanOrEqual(moneyToTiyin(r1.balance));
          expect(r2.obligations).toEqual(r1.obligations);
        },
      ),
      { numRuns: 300 },
    );
  });

  it('produces deterministic canonical request hashes for opening balance, payment & adjustment', () => {
    expect(
      canonicalizeOpeningBalanceRequest({
        customerId: CUST_ID,
        amount: moneyFromTiyin(150_000n),
        reason: '  Eski daftardan  ',
        dueDays: 30,
      }),
    ).toBe(`["mezon.customer.opening_balance.v1","${CUST_ID}","150000","Eski daftardan",30]`);

    expect(
      canonicalizeDebtPaymentRequest({
        customerId: CUST_ID,
        method: 'card',
        amount: moneyFromTiyin(50_000n),
        providerRef: '  RRN-77 ',
        reason: ' Qisman tolov ',
      }),
    ).toBe(
      `["mezon.customer.debt_payment.v1","${CUST_ID}","card","50000","RRN-77","Qisman tolov"]`,
    );

    expect(
      canonicalizeDebtAdjustmentRequest({
        customerId: CUST_ID,
        amountDelta: moneyFromTiyin(-10_000n),
        reason: ' Chegirma kechirildi ',
        dueDays: null,
      }),
    ).toBe(`["mezon.customer.adjustment.v1","${CUST_ID}","-10000","Chegirma kechirildi",null]`);
  });
});
