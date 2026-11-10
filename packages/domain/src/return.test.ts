import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  DomainError,
  ZERO_MONEY,
  ZERO_QUANTITY,
  allocateReturnStockMoveLegs,
  assertSaleVoidBusinessDay,
  assertValidStoreTimeZone,
  canonicalizeCreateReturnRequest,
  canonicalizeVoidSaleRequest,
  computeCumulativeReturnLineAmounts,
  createEmptyPaymentMethodMap,
  formatReturnCode,
  getBusinessDateKey,
  isSameBusinessDay,
  moneyFromTiyin,
  moneyToTiyin,
  normalizeMandatoryReason,
  quantityFromMilli,
  quantityToMilli,
  resolveReturnPayments,
  unixMsFromBigInt,
} from './index.js';
import { type UuidV7 } from './uuidv7.js';

const DEV_ID = '0195a1b2-0000-7000-8000-00000000cafe' as UuidV7;
const SALE_ID = '0195a1b2-0000-7000-8000-000000000001' as UuidV7;
const LINE_ID = '0195a1b2-0000-7000-8000-000000000002' as UuidV7;
const BATCH_A = '0195a1b2-0000-7000-8000-0000000000a1' as UuidV7;
const BATCH_B = '0195a1b2-0000-7000-8000-0000000000b2' as UuidV7;
const MOVE_1 = '0195a1b2-0000-7000-8000-000000000101' as UuidV7;
const MOVE_2 = '0195a1b2-0000-7000-8000-000000000102' as UuidV7;

function civilUtcToUnixMs(
  year: bigint,
  month: bigint,
  day: bigint,
  hour = 0n,
  minute = 0n,
  second = 0n,
  ms = 0n,
) {
  // Howard Hinnant days-from-civil pure BigInt inverse algorithm
  const y = month <= 2n ? year - 1n : year;
  const era = (y >= 0n ? y : y - 399n) / 400n;
  const yoe = y - era * 400n;
  const doy = (153n * (month + (month > 2n ? -3n : 9n)) + 2n) / 5n + day - 1n;
  const doe = yoe * 365n + yoe / 4n - yoe / 100n + doy;
  const epochDays = era * 146097n + doe - 719468n;
  const totalMs =
    epochDays * 86_400_000n + hour * 3_600_000n + minute * 60_000n + second * 1_000n + ms;
  return unixMsFromBigInt(totalMs);
}

describe('@mezon/domain - return, void window, cumulative allocation, and payments', () => {
  it('V1: enforces same-business-day void rule across Asia/Tashkent, UTC, and external IANA resolver', () => {
    // 2026-06-15 23:59:30 Asia/Tashkent (UTC+5) = 2026-06-15T18:59:30.000Z
    const sale2359 = civilUtcToUnixMs(2026n, 6n, 15n, 18n, 59n, 30n, 0n);
    // Same Tashkent day 23:59:59.999 -> allowed
    const stillSameDay = civilUtcToUnixMs(2026n, 6n, 15n, 18n, 59n, 59n, 999n);
    // 2026-06-16 00:01:00 Asia/Tashkent = 2026-06-15T19:01:00.000Z -> next Tashkent day!
    const nextDay0001 = civilUtcToUnixMs(2026n, 6n, 15n, 19n, 1n, 0n, 0n);

    expect(getBusinessDateKey(sale2359, 'Asia/Tashkent')).toBe('2026-06-15');
    expect(getBusinessDateKey(nextDay0001, 'Asia/Tashkent')).toBe('2026-06-16');
    expect(isSameBusinessDay(sale2359, stillSameDay, 'Asia/Tashkent')).toBe(true);
    expect(isSameBusinessDay(sale2359, nextDay0001, 'Asia/Tashkent')).toBe(false);

    expect(() =>
      assertSaleVoidBusinessDay({
        saleCreatedAtMs: sale2359,
        nowMs: stillSameDay,
        storeTimezone: 'Asia/Tashkent',
      }),
    ).not.toThrow();

    expect(() =>
      assertSaleVoidBusinessDay({
        saleCreatedAtMs: sale2359,
        nowMs: nextDay0001,
      }),
    ).toThrowError(DomainError);

    try {
      assertSaleVoidBusinessDay({
        saleCreatedAtMs: sale2359,
        nowMs: nextDay0001,
      });
      expect.unreachable();
    } catch (err) {
      expect((err as DomainError).code).toBe('VOID_WINDOW_EXPIRED');
    }

    // Under UTC, 18:59:30Z and 19:01:00Z are the SAME day (`2026-06-15`), whereas 00:01Z next day is rejected
    expect(isSameBusinessDay(sale2359, nextDay0001, 'UTC')).toBe(true);
    expect(
      isSameBusinessDay(
        civilUtcToUnixMs(2026n, 6n, 15n, 23n, 59n, 0n, 0n),
        civilUtcToUnixMs(2026n, 6n, 16n, 0n, 1n, 0n, 0n),
        'UTC',
      ),
    ).toBe(false);

    // Custom IANA resolver delegation check (injected cleanly from IO/db-local layer)
    const edtBeforeMidnight = civilUtcToUnixMs(2026n, 6n, 16n, 3n, 59n, 0n, 0n);
    const edtAfterMidnight = civilUtcToUnixMs(2026n, 6n, 16n, 4n, 1n, 0n, 0n);
    expect(
      isSameBusinessDay(edtBeforeMidnight, edtAfterMidnight, 'America/New_York', (ms) =>
        ms === edtBeforeMidnight ? '2026-06-15' : '2026-06-16',
      ),
    ).toBe(false);

    expect(() => assertValidStoreTimeZone('Mars/Olympus_Mons')).toThrowError(DomainError);
    expect(() => assertValidStoreTimeZone('')).toThrowError(DomainError);

    // Known civil calendar boundary checks in pure BigInt math (Unix epoch, leap year 2000, non-leap 2100, year boundaries)
    expect(getBusinessDateKey(civilUtcToUnixMs(1970n, 1n, 1n, 0n, 0n), 'Asia/Tashkent')).toBe(
      '1970-01-01',
    );
    expect(
      getBusinessDateKey(civilUtcToUnixMs(2000n, 2n, 29n, 18n, 59n, 59n), 'Asia/Tashkent'),
    ).toBe('2000-02-29');
    expect(getBusinessDateKey(civilUtcToUnixMs(2000n, 2n, 29n, 19n, 0n, 0n), 'Asia/Tashkent')).toBe(
      '2000-03-01',
    );
    expect(
      getBusinessDateKey(civilUtcToUnixMs(2024n, 12n, 31n, 18n, 59n, 59n), 'Asia/Tashkent'),
    ).toBe('2024-12-31');
    expect(
      getBusinessDateKey(civilUtcToUnixMs(2024n, 12n, 31n, 19n, 0n, 0n), 'Asia/Tashkent'),
    ).toBe('2025-01-01');
    expect(getBusinessDateKey(civilUtcToUnixMs(2100n, 2n, 28n, 19n, 0n, 0n), 'Asia/Tashkent')).toBe(
      '2100-03-01',
    );
  });

  it('validates mandatory reason, return code formatting, and canonical idempotency strings', () => {
    expect(normalizeMandatoryReason('  Mijoz qaytardi  ')).toBe('Mijoz qaytardi');
    expect(() => normalizeMandatoryReason('   ')).toThrowError(DomainError);
    expect(() => normalizeMandatoryReason('x'.repeat(501))).toThrowError(DomainError);
    expect(formatReturnCode(DEV_ID, 42n)).toBe('RET-CAFE-000042');

    const voidCanonA = canonicalizeVoidSaleRequest({ saleId: SALE_ID, reason: '  Xato chek ' });
    const voidCanonB = canonicalizeVoidSaleRequest({ saleId: SALE_ID, reason: 'Xato chek' });
    expect(voidCanonA).toBe(voidCanonB);

    const retCanonA = canonicalizeCreateReturnRequest({
      saleId: SALE_ID,
      reason: '  Braq ',
      items: [{ saleLineId: LINE_ID, qty: quantityFromMilli(1000n) }],
      payments: [
        { method: 'card', amount: moneyFromTiyin(5000n), providerRef: ' RRN-1 ' },
        { method: 'cash', amount: moneyFromTiyin(3000n) },
      ],
    });
    const retCanonB = canonicalizeCreateReturnRequest({
      saleId: SALE_ID,
      reason: 'Braq',
      debtOffsetAmount: ZERO_MONEY,
      items: [{ saleLineId: LINE_ID, qty: quantityFromMilli(1000n) }],
      payments: [
        { method: 'cash', amount: moneyFromTiyin(3000n) },
        { method: 'card', amount: moneyFromTiyin(5000n), providerRef: 'RRN-1' },
      ],
    });
    expect(retCanonA).toBe(retCanonB);
  });

  it('property test: cumulative line return sums equal sold totals strictly and preserve net + vat = refund across 600 random splits', () => {
    // Explicit tight-ratio VAT regression case (`final=10, vat=9, qty=4`) where unconstrained VAT delta would exceed refund
    let prevQ = ZERO_QUANTITY;
    let prevR = ZERO_MONEY;
    let prevN = ZERO_MONEY;
    let prevV = ZERO_MONEY;
    for (const stepMilli of [1000n, 1000n, 2000n]) {
      const step = computeCumulativeReturnLineAmounts({
        saleLineId: LINE_ID,
        unit: 'kg',
        soldQty: quantityFromMilli(4000n),
        previouslyReturnedQty: prevQ,
        requestedQty: quantityFromMilli(stepMilli),
        soldFinalTotal: moneyFromTiyin(10n),
        soldNetExVat: moneyFromTiyin(1n),
        soldVatTotal: moneyFromTiyin(9n),
        previouslyRefunded: prevR,
        previouslyReturnedNet: prevN,
        previouslyReturnedVat: prevV,
      });
      expect(moneyToTiyin(step.netExVat)).toBeGreaterThanOrEqual(0n);
      expect(moneyToTiyin(step.vatTotal)).toBeGreaterThanOrEqual(0n);
      expect(moneyToTiyin(step.netExVat) + moneyToTiyin(step.vatTotal)).toBe(
        moneyToTiyin(step.refundAmount),
      );
      prevQ = quantityFromMilli(quantityToMilli(prevQ) + stepMilli);
      prevR = moneyFromTiyin(moneyToTiyin(prevR) + moneyToTiyin(step.refundAmount));
      prevN = moneyFromTiyin(moneyToTiyin(prevN) + moneyToTiyin(step.netExVat));
      prevV = moneyFromTiyin(moneyToTiyin(prevV) + moneyToTiyin(step.vatTotal));
    }
    expect(moneyToTiyin(prevR)).toBe(10n);
    expect(moneyToTiyin(prevN)).toBe(1n);
    expect(moneyToTiyin(prevV)).toBe(9n);

    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 1, max: 50_000 }), { minLength: 1, maxLength: 12 }),
        fc.bigInt({ min: 0n, max: 500_000_000n }),
        fc.integer({ min: 0, max: 10000 }),
        (chunks, finalTiyin, vatShareBp) => {
          const soldMilli = chunks.reduce((acc, c) => acc + BigInt(c), 0n);
          const vatTiyin = (finalTiyin * BigInt(vatShareBp)) / 10000n;
          const netTiyin = finalTiyin - vatTiyin;

          let pQty = 0n;
          let pRef = 0n;
          let pNet = 0n;
          let pVat = 0n;

          for (const chunk of chunks) {
            const reqMilli = BigInt(chunk);
            const res = computeCumulativeReturnLineAmounts({
              saleLineId: LINE_ID,
              unit: 'kg',
              soldQty: quantityFromMilli(soldMilli),
              previouslyReturnedQty: quantityFromMilli(pQty),
              requestedQty: quantityFromMilli(reqMilli),
              soldFinalTotal: moneyFromTiyin(finalTiyin),
              soldNetExVat: moneyFromTiyin(netTiyin),
              soldVatTotal: moneyFromTiyin(vatTiyin),
              previouslyRefunded: moneyFromTiyin(pRef),
              previouslyReturnedNet: moneyFromTiyin(pNet),
              previouslyReturnedVat: moneyFromTiyin(pVat),
            });

            const r = moneyToTiyin(res.refundAmount);
            const n = moneyToTiyin(res.netExVat);
            const v = moneyToTiyin(res.vatTotal);
            expect(r).toBeGreaterThanOrEqual(0n);
            expect(n).toBeGreaterThanOrEqual(0n);
            expect(v).toBeGreaterThanOrEqual(0n);
            expect(n + v).toBe(r);

            pQty += reqMilli;
            pRef += r;
            pNet += n;
            pVat += v;
          }

          expect(pQty).toBe(soldMilli);
          expect(pRef).toBe(finalTiyin);
          expect(pNet).toBe(netTiyin);
          expect(pVat).toBe(vatTiyin);
        },
      ),
      { numRuns: 600 },
    );
  });

  it('allocates partial & multi-batch FIFO return stock legs identically to full reversal, and skips V5 non-tracked lines', () => {
    const origLegs = [
      {
        moveId: MOVE_1,
        batchId: BATCH_A,
        soldQty: quantityFromMilli(3000n),
        soldCostValue: moneyFromTiyin(30_000n),
      },
      {
        moveId: MOVE_2,
        batchId: BATCH_B,
        soldQty: quantityFromMilli(2000n),
        soldCostValue: moneyFromTiyin(50_000n),
      },
    ];
    const soldLineQty = quantityFromMilli(5000n);
    const soldLineCostValue = moneyFromTiyin(80_000n);

    // Full single allocation
    const full = allocateReturnStockMoveLegs({
      origLegs,
      soldLineQty,
      soldLineCostValue,
      previouslyReturnedQty: ZERO_QUANTITY,
      previouslyReturnedCostValue: ZERO_MONEY,
      requestedQty: soldLineQty,
    });
    expect(moneyToTiyin(full.totalCostValue)).toBe(80_000n);
    expect(full.legs).toHaveLength(2);
    expect(moneyToTiyin(full.legs[0].costValue)).toBe(30_000n);
    expect(moneyToTiyin(full.legs[1].costValue)).toBe(50_000n);

    // 3 random fractional partial returns summing to 5000n
    const splits = [1350n, 2400n, 1250n];
    let prevQty = 0n;
    let prevCost = 0n;
    const restoredByBatch = new Map<string, { qty: bigint; cost: bigint }>();

    for (const s of splits) {
      const part = allocateReturnStockMoveLegs({
        origLegs,
        soldLineQty,
        soldLineCostValue,
        previouslyReturnedQty: quantityFromMilli(prevQty),
        previouslyReturnedCostValue: moneyFromTiyin(prevCost),
        requestedQty: quantityFromMilli(s),
      });
      prevQty += s;
      prevCost += moneyToTiyin(part.totalCostValue);
      for (const leg of part.legs) {
        const key = leg.batchId ?? 'null';
        const cur = restoredByBatch.get(key) ?? { qty: 0n, cost: 0n };
        cur.qty += quantityToMilli(leg.qty);
        cur.cost += moneyToTiyin(leg.costValue);
        restoredByBatch.set(key, cur);
      }
    }

    expect(prevQty).toBe(5000n);
    expect(prevCost).toBe(80_000n);
    expect(restoredByBatch.get(BATCH_A)).toEqual({ qty: 3000n, cost: 30_000n });
    expect(restoredByBatch.get(BATCH_B)).toEqual({ qty: 2000n, cost: 50_000n });

    // V5: Non-tracked (quick_sale / unlimited) produces 0 stock legs
    const nonTracked = allocateReturnStockMoveLegs({
      origLegs: [],
      soldLineQty: quantityFromMilli(2000n),
      soldLineCostValue: ZERO_MONEY,
      previouslyReturnedQty: ZERO_QUANTITY,
      previouslyReturnedCostValue: ZERO_MONEY,
      requestedQty: quantityFromMilli(1000n),
    });
    expect(nonTracked.legs).toEqual([]);
    expect(moneyToTiyin(nonTracked.totalCostValue)).toBe(0n);
  });

  it('V2: caps cash refund by net payments.amount (not tendered) and forbids cross-method refunds', () => {
    const paid = createEmptyPaymentMethodMap();
    paid.cash = moneyFromTiyin(80_000n); // Customer tendered 100,000 and got 20,000 change -> net = 80,000
    paid.card = moneyFromTiyin(70_000n);
    const prior = createEmptyPaymentMethodMap();

    // Valid mixed refund within method caps
    const ok = resolveReturnPayments({
      totalRefund: moneyFromTiyin(150_000n),
      saleTotalPaid: moneyFromTiyin(150_000n),
      saleDebtAmount: ZERO_MONEY,
      originalPaidByMethod: paid,
      priorReturnedByMethod: prior,
      payments: [
        { method: 'cash', amount: moneyFromTiyin(80_000n) },
        { method: 'card', amount: moneyFromTiyin(70_000n), providerRef: 'RRN-9' },
      ],
    });
    expect(moneyToTiyin(ok.cashRefundAmount)).toBe(80_000n);
    expect(moneyToTiyin(ok.nonCashRefundAmount)).toBe(70_000n);

    // 1 tiyin over net cash limit (80,001 cash even though tendered was 100,000!) -> REJECTED
    expect(() =>
      resolveReturnPayments({
        totalRefund: moneyFromTiyin(150_000n),
        saleTotalPaid: moneyFromTiyin(150_000n),
        saleDebtAmount: ZERO_MONEY,
        originalPaidByMethod: paid,
        priorReturnedByMethod: prior,
        payments: [
          { method: 'cash', amount: moneyFromTiyin(80_001n) },
          { method: 'card', amount: moneyFromTiyin(69_999n) },
        ],
      }),
    ).toThrowError(/RETURN_PAYMENT_LIMIT_EXCEEDED/);

    // Pure cash sale cannot be refunded to card
    const cashOnlyPaid = createEmptyPaymentMethodMap();
    cashOnlyPaid.cash = moneyFromTiyin(50_000n);
    expect(() =>
      resolveReturnPayments({
        totalRefund: moneyFromTiyin(50_000n),
        saleTotalPaid: moneyFromTiyin(50_000n),
        saleDebtAmount: ZERO_MONEY,
        originalPaidByMethod: cashOnlyPaid,
        priorReturnedByMethod: prior,
        payments: [{ method: 'card', amount: moneyFromTiyin(50_000n) }],
      }),
    ).toThrowError(/RETURN_PAYMENT_LIMIT_EXCEEDED/);

    // Sum mismatch rejected
    expect(() =>
      resolveReturnPayments({
        totalRefund: moneyFromTiyin(50_000n),
        saleTotalPaid: moneyFromTiyin(50_000n),
        saleDebtAmount: ZERO_MONEY,
        originalPaidByMethod: cashOnlyPaid,
        priorReturnedByMethod: prior,
        payments: [{ method: 'cash', amount: moneyFromTiyin(49_999n) }],
      }),
    ).toThrowError(/VALIDATION_ERROR/);

    // T1.7 debt offset rejected until T1.7
    expect(() =>
      resolveReturnPayments({
        totalRefund: moneyFromTiyin(50_000n),
        debtOffsetAmount: moneyFromTiyin(10_000n),
        saleTotalPaid: moneyFromTiyin(50_000n),
        saleDebtAmount: ZERO_MONEY,
        originalPaidByMethod: cashOnlyPaid,
        priorReturnedByMethod: prior,
        payments: [{ method: 'cash', amount: moneyFromTiyin(40_000n) }],
      }),
    ).toThrowError(/CUSTOMER_REQUIRED/);
  });
});
