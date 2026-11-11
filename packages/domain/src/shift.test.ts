import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MAX_CASH_DISCREPANCY_TIYIN,
  assertOpenShiftAccess,
  assertValidBusinessDate,
  computeActiveShiftDrawerBalance,
  computeShiftClosureTotals,
  evaluateOpeningDiscrepancy,
  evaluateShiftDiscrepancy,
  formatDayCloseCode,
  formatShiftCode,
  moneyFromTiyin,
  moneyToTiyin,
  parseShiftCashMoveType,
  parseShiftExpenseCategory,
  parseUuidV7,
  validateDenominationCounts,
} from './index.js';

const DEV1 = parseUuidV7('01950000-0000-7000-8000-00000000a1b2');
const U_CASH1 = parseUuidV7('01950000-0000-7000-8000-000000000001');
const U_CASH2 = parseUuidV7('01950000-0000-7000-8000-000000000002');
const U_MGR = parseUuidV7('01950000-0000-7000-8000-000000000003');
const U_OWNER = parseUuidV7('01950000-0000-7000-8000-000000000004');
const SESS1 = parseUuidV7('01950000-0000-7000-8000-000000001001');
const SESS2 = parseUuidV7('01950000-0000-7000-8000-000000001002');

describe('@mezon/domain - T1.9 Shifts, Discrepancy, Cashiers & Closure Math', () => {
  it('formats shift & Z-report codes and validates business dates, denominations, and expense categories', () => {
    expect(formatShiftCode(DEV1, 1n)).toBe('SHF-A1B2-000001');
    expect(formatDayCloseCode('2026-06-15', 2)).toBe('Z-20260615-002');
    expect(assertValidBusinessDate('2026-02-28')).toBe('2026-02-28');
    expect(() => assertValidBusinessDate('2026-02-30')).toThrowError(/VALIDATION_ERROR/);
    expect(() => assertValidBusinessDate('15-06-2026')).toThrowError(/VALIDATION_ERROR/);

    expect(parseShiftCashMoveType('cash_out')).toBe('cash_out');
    expect(parseShiftExpenseCategory('cash_out', 'utilities')).toBe('utilities');
    expect(parseShiftExpenseCategory('cash_out', undefined)).toBe('other');
    expect(() => parseShiftExpenseCategory('encashment', 'other')).toThrowError(/VALIDATION_ERROR/);

    const denoms = [
      { nominal: moneyFromTiyin(5_000_00n), count: 2 },
      { nominal: moneyFromTiyin(1_000_00n), count: 5 },
    ];
    expect(validateDenominationCounts(denoms, moneyFromTiyin(1_500_000n))).toEqual(denoms);
    expect(() => validateDenominationCounts(denoms, moneyFromTiyin(1_500_001n))).toThrowError(
      /VALIDATION_ERROR/,
    );
  });

  it('enforces X1 drawer balance, X2 cashier session ownership, opening/closing discrepancy reason & 1,000,000 tiyin supervisor threshold', () => {
    expect(DEFAULT_MAX_CASH_DISCREPANCY_TIYIN).toBe(1_000_000n);
    expect(
      moneyToTiyin(
        computeActiveShiftDrawerBalance({
          openingCash: moneyFromTiyin(100_000n),
          cashMovesDeltas: [moneyFromTiyin(50_000n), moneyFromTiyin(-20_000n)],
        }),
      ),
    ).toBe(130_000n);

    // X2 session ownership rules
    expect(() =>
      assertOpenShiftAccess({
        shiftStatus: 'closed',
        activeCashierUserId: U_CASH1,
        actorUserId: U_CASH1,
        actorRole: 'cashier',
      }),
    ).toThrowError(/SHIFT_NOT_OPEN/);
    expect(() =>
      assertOpenShiftAccess({
        shiftStatus: 'open',
        activeCashierUserId: U_CASH1,
        actorUserId: U_CASH2,
        actorRole: 'cashier',
      }),
    ).toThrowError(/CASHIER_SESSION_MISMATCH/);
    // Manager & Owner can transact in Cashier 1's active session
    expect(() =>
      assertOpenShiftAccess({
        shiftStatus: 'open',
        activeCashierUserId: U_CASH1,
        actorUserId: U_MGR,
        actorRole: 'manager',
      }),
    ).not.toThrow();

    // Opening discrepancy requires reason when diff != 0
    expect(() =>
      evaluateOpeningDiscrepancy({
        prevShiftCloseCash: moneyFromTiyin(500_000n),
        openingCash: moneyFromTiyin(490_000n),
      }),
    ).toThrowError(/VALIDATION_ERROR/);
    expect(
      evaluateOpeningDiscrepancy({
        prevShiftCloseCash: moneyFromTiyin(500_000n),
        openingCash: moneyFromTiyin(490_000n),
        reason: 'Smena orasida 100 sum kamomad',
      }).openingDiscrepancyTiyin,
    ).toBe(-10_000n);

    // Closing discrepancy <= 1,000,000 tiyin requires reason only; > 1,000,000 requires supervisor
    expect(() =>
      evaluateShiftDiscrepancy({
        expectedCash: moneyFromTiyin(2_000_000n),
        countedCash: moneyFromTiyin(1_500_000n),
        maxCashDiscrepancyWithoutOverride: DEFAULT_MAX_CASH_DISCREPANCY_TIYIN,
        supervisorApprovedByUserId: null,
      }),
    ).toThrowError(/VALIDATION_ERROR/);

    expect(
      evaluateShiftDiscrepancy({
        expectedCash: moneyFromTiyin(2_000_000n),
        countedCash: moneyFromTiyin(1_000_000n), // abs = 1_000_000n === threshold -> OK without override
        maxCashDiscrepancyWithoutOverride: DEFAULT_MAX_CASH_DISCREPANCY_TIYIN,
        reason: 'Kupyura maydalashda farq',
        supervisorApprovedByUserId: null,
      }).requiresSupervisorOverride,
    ).toBe(false);

    expect(() =>
      evaluateShiftDiscrepancy({
        expectedCash: moneyFromTiyin(2_000_000n),
        countedCash: moneyFromTiyin(999_999n), // abs = 1_000_001n > threshold -> requires supervisor
        maxCashDiscrepancyWithoutOverride: DEFAULT_MAX_CASH_DISCREPANCY_TIYIN,
        reason: 'Katta kamomad',
        supervisorApprovedByUserId: null,
      }),
    ).toThrowError(/SUPERVISOR_OVERRIDE_REQUIRED/);

    expect(
      evaluateShiftDiscrepancy({
        expectedCash: moneyFromTiyin(2_000_000n),
        countedCash: moneyFromTiyin(999_999n),
        maxCashDiscrepancyWithoutOverride: DEFAULT_MAX_CASH_DISCREPANCY_TIYIN,
        reason: 'Katta kamomad',
        supervisorApprovedByUserId: U_OWNER,
      }).discrepancyTiyin,
    ).toBe(-1_000_001n);
  });

  it('X2 & X3 exact worked example: two cashier sessions with manager return and cash sales with change', () => {
    const id1 = parseUuidV7('01950000-0000-7000-8000-000000002001');
    const id2 = parseUuidV7('01950000-0000-7000-8000-000000002002');
    const id3 = parseUuidV7('01950000-0000-7000-8000-000000002003');

    const summary = computeShiftClosureTotals({
      openingCash: moneyFromTiyin(100_000n),
      finalCountedCash: moneyFromTiyin(125_000n),
      cashierSessions: [
        {
          sessionId: SESS1,
          cashierUserId: U_CASH1,
          sessionSeq: 1,
          openingFloat: moneyFromTiyin(100_000n),
          isClosed: true,
          countedCash: moneyFromTiyin(145_000n), // expected = 100k + (100k - 20k) - 30k = 150k -> -5k shortage
        },
        {
          sessionId: SESS2,
          cashierUserId: U_CASH2,
          sessionSeq: 2,
          openingFloat: moneyFromTiyin(145_000n),
          isClosed: false,
          countedCash: null, // expects 145k - 20k = 125k -> 0 discrepancy
        },
      ],
      cashMoves: [
        // Sale 1 during Sess1: 80k sale paid with 100k tendered - 20k change -> payments.amount = 80k
        {
          id: id1,
          shiftCashierSessionId: SESS1,
          type: 'sale_cash_in',
          amountDelta: moneyFromTiyin(100_000n),
        },
        {
          id: id2,
          shiftCashierSessionId: SESS1,
          type: 'sale_change_out',
          amountDelta: moneyFromTiyin(-20_000n),
        },
        // Manager return during Sess1 attributed to SESS1 (X2!)
        {
          id: id3,
          shiftCashierSessionId: SESS1,
          type: 'refund_cash_out',
          amountDelta: moneyFromTiyin(-30_000n),
        },
        // Cash out during Sess2
        {
          id: DEV1,
          shiftCashierSessionId: SESS2,
          type: 'cash_out',
          amountDelta: moneyFromTiyin(-20_000n),
        },
      ],
      sales: [
        {
          id: id1,
          shiftCashierSessionId: SESS1,
          totalFinal: moneyFromTiyin(80_000n),
          debtAmount: moneyFromTiyin(0n),
          isVoided: false,
        },
        {
          id: id2,
          shiftCashierSessionId: SESS2,
          totalFinal: moneyFromTiyin(50_000n),
          debtAmount: moneyFromTiyin(0n),
          isVoided: false,
        },
      ],
      returns: [
        {
          id: id3,
          shiftCashierSessionId: SESS1,
          totalRefundAmount: moneyFromTiyin(30_000n),
          debtOffsetAmount: moneyFromTiyin(0n),
        },
      ],
      payments: [
        // X3: payments.amount is ALREADY net of change (80k, NOT 100k - 20k = 60k!)
        { shiftCashierSessionId: SESS1, method: 'cash', amount: moneyFromTiyin(80_000n) },
        { shiftCashierSessionId: SESS2, method: 'card', amount: moneyFromTiyin(50_000n) },
      ],
      returnPayments: [
        { shiftCashierSessionId: SESS1, method: 'cash', amount: moneyFromTiyin(30_000n) },
      ],
    });

    // Shift expected = 100k + 100k - 20k - 30k - 20k = 130k; counted = 125k => shift discrepancy = -5k
    expect(moneyToTiyin(summary.expectedCash)).toBe(130_000n);
    expect(summary.discrepancyTiyin).toBe(-5_000n);
    // Cash method: sales 80k (NOT reduced by change again!), returns 30k, net 50k
    const cashMethod = summary.methodTotals.find((m) => m.method === 'cash')!;
    expect(moneyToTiyin(cashMethod.salesAmount)).toBe(80_000n);
    expect(moneyToTiyin(cashMethod.returnsAmount)).toBe(30_000n);
    expect(moneyToTiyin(cashMethod.netAmount)).toBe(50_000n);
    // Card method: sales 50k
    expect(moneyToTiyin(summary.methodTotals.find((m) => m.method === 'card')!.netAmount)).toBe(
      50_000n,
    );
    // Cashier accountability: Sess1 = -5k, Sess2 = 0 => sum === -5k!
    expect(summary.cashiers[0].discrepancyTiyin).toBe(-5_000n);
    expect(summary.cashiers[1].discrepancyTiyin).toBe(0n);
  });

  it('property test (300 runs): D_shift === SUM(D_i) across arbitrary K handoffs, moves & counts', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 500_000 }),
        fc.array(
          fc.record({
            moves: fc.array(fc.integer({ min: -50_000, max: 100_000 }), {
              minLength: 0,
              maxLength: 6,
            }),
            handoffDelta: fc.integer({ min: -20_000, max: 20_000 }),
          }),
          { minLength: 1, maxLength: 5 },
        ),
        (openingInt, sessionSpecs) => {
          const openingCash = moneyFromTiyin(BigInt(openingInt));
          const sessions: Array<{
            sessionId: ReturnType<typeof parseUuidV7>;
            cashierUserId: ReturnType<typeof parseUuidV7>;
            sessionSeq: number;
            openingFloat: ReturnType<typeof moneyFromTiyin>;
            isClosed: boolean;
            countedCash: ReturnType<typeof moneyFromTiyin> | null;
          }> = [];
          const cashMoves: Array<{
            id: ReturnType<typeof parseUuidV7>;
            shiftCashierSessionId: ReturnType<typeof parseUuidV7>;
            type: 'cash_in' | 'cash_out';
            amountDelta: ReturnType<typeof moneyFromTiyin>;
          }> = [];

          let curFloat = BigInt(openingInt);
          let moveCounter = 1;
          for (let idx = 0; idx < sessionSpecs.length; idx += 1) {
            const spec = sessionSpecs[idx];
            const sid = parseUuidV7(
              `01950000-0000-7000-8000-${(idx + 1).toString(16).padStart(12, '0')}`,
            );
            let deltaSum = 0n;
            for (const mInt of spec.moves) {
              const dt = BigInt(mInt);
              if (dt === 0n) continue;
              deltaSum += dt;
              cashMoves.push({
                id: parseUuidV7(
                  `01950001-0000-7000-8000-${(moveCounter++).toString(16).padStart(12, '0')}`,
                ),
                shiftCashierSessionId: sid,
                type: dt > 0n ? 'cash_in' : 'cash_out',
                amountDelta: moneyFromTiyin(dt),
              });
            }
            const rawCount = curFloat + deltaSum + BigInt(spec.handoffDelta);
            const boundedCount = rawCount < 0n ? 0n : rawCount;
            const isLast = idx === sessionSpecs.length - 1;
            sessions.push({
              sessionId: sid,
              cashierUserId: idx % 2 === 0 ? U_CASH1 : U_CASH2,
              sessionSeq: idx + 1,
              openingFloat: moneyFromTiyin(curFloat),
              isClosed: !isLast,
              countedCash: isLast ? null : moneyFromTiyin(boundedCount),
            });
            curFloat = boundedCount;
          }

          const finalCount = moneyFromTiyin(curFloat);
          const result = computeShiftClosureTotals({
            openingCash,
            finalCountedCash: finalCount,
            cashierSessions: sessions,
            cashMoves,
            sales: [],
            returns: [],
            payments: [],
            returnPayments: [],
          });

          const sumDiscrepancies = result.cashiers.reduce((acc, c) => acc + c.discrepancyTiyin, 0n);
          expect(sumDiscrepancies).toBe(result.discrepancyTiyin);
        },
      ),
      { numRuns: 300 },
    );
  });

  it('tracks order advances separately from sales revenue and includes advance in methodTotals', () => {
    const result = computeShiftClosureTotals({
      openingCash: moneyFromTiyin(100_000n),
      finalCountedCash: moneyFromTiyin(135_000n),
      cashierSessions: [
        {
          sessionId: SESS1,
          cashierUserId: U_CASH1,
          sessionSeq: 1,
          openingFloat: moneyFromTiyin(100_000n),
          isClosed: false,
          countedCash: null,
        },
      ],
      cashMoves: [
        {
          id: parseUuidV7('01950000-0000-7000-8000-000000005001'),
          shiftCashierSessionId: SESS1,
          type: 'advance_cash_in',
          amountDelta: moneyFromTiyin(60_000n),
        },
        {
          id: parseUuidV7('01950000-0000-7000-8000-000000005002'),
          shiftCashierSessionId: SESS1,
          type: 'advance_change_out',
          amountDelta: moneyFromTiyin(-10_000n),
        },
        {
          id: parseUuidV7('01950000-0000-7000-8000-000000005003'),
          shiftCashierSessionId: SESS1,
          type: 'advance_refund_out',
          amountDelta: moneyFromTiyin(-15_000n),
        },
      ],
      sales: [
        {
          id: parseUuidV7('01950000-0000-7000-8000-000000006001'),
          shiftCashierSessionId: SESS1,
          totalFinal: moneyFromTiyin(80_000n),
          debtAmount: moneyFromTiyin(0n),
          isVoided: false,
        },
      ],
      returns: [],
      payments: [
        {
          shiftCashierSessionId: SESS1,
          method: 'advance',
          amount: moneyFromTiyin(50_000n),
        },
        {
          shiftCashierSessionId: SESS1,
          method: 'card',
          amount: moneyFromTiyin(30_000n),
        },
      ],
      returnPayments: [],
      orderPayments: [
        {
          shiftCashierSessionId: SESS1,
          kind: 'advance',
          method: 'cash',
          amount: moneyFromTiyin(50_000n),
        },
        {
          shiftCashierSessionId: SESS1,
          kind: 'advance',
          method: 'card',
          amount: moneyFromTiyin(25_000n),
        },
        {
          shiftCashierSessionId: SESS1,
          kind: 'advance_refund',
          method: 'cash',
          amount: moneyFromTiyin(15_000n),
        },
      ],
    });

    expect(result.expectedCash).toBe(moneyFromTiyin(135_000n));
    expect(result.discrepancyTiyin).toBe(0n);
    expect(result.grossSalesTotal).toBe(moneyFromTiyin(80_000n));
    expect(result.orderAdvanceCashTotal).toBe(moneyFromTiyin(50_000n));
    expect(result.orderAdvanceNonCashTotal).toBe(moneyFromTiyin(25_000n));
    expect(result.orderAdvanceRefundTotal).toBe(moneyFromTiyin(15_000n));
    expect(result.methodTotals.find((m) => m.method === 'advance')?.salesAmount).toBe(
      moneyFromTiyin(50_000n),
    );
  });
});
