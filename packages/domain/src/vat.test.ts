import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  type CashierDiscountPolicy,
  ZERO_MONEY,
  ZERO_VAT_RATE,
  calculateVatIncluded,
  effectiveVatRate,
  evaluateCart,
  moneyFromTiyin,
  moneyToTiyin,
  parseUuidV7,
  quantityFromMilli,
  unixMsFromBigInt,
  vatRateFromBasisPoints,
  vatRateToBasisPoints,
} from './index.js';

/**
 * T3.1 "QQS yaxlitlash testlari": boundary table, property tests and hand-computed multi-line
 * receipts. VAT is INCLUDED in the price and rounded per line (half away from zero) after discount
 * allocation (`cart.ts` → `calculateVatIncluded`).
 */

const R12 = vatRateFromBasisPoints(1200n);

function vatIncl(grossTiyin: bigint, bp: bigint): { net: bigint; vat: bigint } {
  const res = calculateVatIncluded(moneyFromTiyin(grossTiyin), vatRateFromBasisPoints(bp));
  return { net: moneyToTiyin(res.net), vat: moneyToTiyin(res.vat) };
}

describe('T3.1 calculateVatIncluded — boundary table', () => {
  // vat = round_half_away(gross * bp / (10000 + bp)); hand-computed expectations.
  const table: ReadonlyArray<readonly [string, bigint, bigint, bigint]> = [
    ['gross 0 at 12%', 0n, 1200n, 0n],
    ['1 tiyin at 12% (0.107 → 0)', 1n, 1200n, 0n],
    ['4 tiyin at 12% (0.428 → 0)', 4n, 1200n, 0n],
    ['5 tiyin at 12% (0.535 → 1)', 5n, 1200n, 1n],
    ['112 tiyin at 12% (exactly 12)', 112n, 1200n, 12n],
    ['14 tiyin at 12% (exact half 1.5 → 2, away from zero)', 14n, 1200n, 2n],
    ['42 tiyin at 12% (exact half 4.5 → 5)', 42n, 1200n, 5n],
    ['rate 0 keeps everything net', 123_456n, 0n, 0n],
    ['rate 100% (10000 bp): half of gross', 1_000n, 10_000n, 500n],
    ['rate 100% odd gross (2.5 → 3)', 5n, 10_000n, 3n],
    ['15% standard example', 115_00n, 1500n, 15_00n],
    [
      'beyond 2^53 tiyin stays exact',
      9_007_199_254_740_993n * 112n,
      1200n,
      9_007_199_254_740_993n * 12n,
    ],
  ];

  for (const [label, gross, bp, expectedVat] of table) {
    it(label, () => {
      const { net, vat } = vatIncl(gross, bp);
      expect(vat).toBe(expectedVat);
      expect(net + vat).toBe(gross);
    });
  }

  it('negative gross (returns) is the exact mirror, including exact halves', () => {
    expect(vatIncl(-14n, 1200n).vat).toBe(-2n);
    expect(vatIncl(-5n, 1200n).vat).toBe(-1n);
    expect(vatIncl(-112n, 1200n).vat).toBe(-12n);
  });
});

describe('T3.1 calculateVatIncluded — properties (fast-check)', () => {
  const grossArb = fc.bigInt({ min: -(10n ** 15n), max: 10n ** 15n });
  const bpArb = fc.bigInt({ min: 0n, max: 10_000n });

  it('net + vat === gross for every gross and rate', () => {
    fc.assert(
      fc.property(grossArb, bpArb, (g, bp) => {
        const { net, vat } = vatIncl(g, bp);
        expect(net + vat).toBe(g);
      }),
      { numRuns: 2000 },
    );
  });

  it('0 ≤ |vat| ≤ |gross| and vat has the sign of gross', () => {
    fc.assert(
      fc.property(grossArb, bpArb, (g, bp) => {
        const { vat } = vatIncl(g, bp);
        const absV = vat < 0n ? -vat : vat;
        const absG = g < 0n ? -g : g;
        expect(absV <= absG).toBe(true);
        if (g > 0n) expect(vat >= 0n).toBe(true);
        if (g < 0n) expect(vat <= 0n).toBe(true);
      }),
      { numRuns: 2000 },
    );
  });

  it('sign symmetry: vat(-g) === -vat(g)', () => {
    fc.assert(
      fc.property(grossArb, bpArb, (g, bp) => {
        expect(vatIncl(-g, bp).vat).toBe(-vatIncl(g, bp).vat);
      }),
      { numRuns: 2000 },
    );
  });

  it('monotone: larger gross never yields smaller vat at the same rate', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 0n, max: 10n ** 12n }),
        fc.bigInt({ min: 0n, max: 10n ** 6n }),
        bpArb,
        (g, d, bp) => {
          expect(vatIncl(g + d, bp).vat >= vatIncl(g, bp).vat).toBe(true);
        },
      ),
      { numRuns: 2000 },
    );
  });

  it('rate 0 ⇒ vat 0', () => {
    fc.assert(
      fc.property(grossArb, (g) => {
        expect(vatIncl(g, 0n).vat).toBe(0n);
      }),
    );
  });

  it('rounding error is at most half a tiyin versus the exact rational value', () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 0n, max: 10n ** 15n }), bpArb, (g, bp) => {
        const { vat } = vatIncl(g, bp);
        // |vat*(10000+bp) - g*bp| ≤ (10000+bp)/2  ⇔  |vat - exact| ≤ 0.5
        const diff = vat * (10_000n + bp) - g * bp;
        const absDiff = diff < 0n ? -diff : diff;
        expect(2n * absDiff <= 10_000n + bp).toBe(true);
      }),
      { numRuns: 2000 },
    );
  });
});

describe('T3.1 effectiveVatRate (S2: non-VAT-payer snapshots 0)', () => {
  it('VAT payer keeps the product rate; non-payer gets 0 regardless of product rate', () => {
    expect(vatRateToBasisPoints(effectiveVatRate(R12, true))).toBe(1200n);
    expect(vatRateToBasisPoints(effectiveVatRate(R12, false))).toBe(0n);
    expect(effectiveVatRate(ZERO_VAT_RATE, true)).toBe(ZERO_VAT_RATE);
  });

  it('property: non-payer ⇒ 0; payer ⇒ identity', () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 0n, max: 10_000n }), (bp) => {
        const rate = vatRateFromBasisPoints(bp);
        expect(vatRateToBasisPoints(effectiveVatRate(rate, false))).toBe(0n);
        expect(vatRateToBasisPoints(effectiveVatRate(rate, true))).toBe(bp);
      }),
    );
  });
});

describe('T3.1 multi-line receipts — per-line VAT after discount allocation', () => {
  const mkId = (seq: number) =>
    parseUuidV7(`01950000-0000-7000-8000-${String(seq).padStart(12, '0')}`);
  const T0 = unixMsFromBigInt(1_760_000_000_000n);
  const UNLIMITED: CashierDiscountPolicy = {
    percentUnlimited: true,
    maxPercentBp: 0n,
    amountUnlimited: true,
    maxAmount: ZERO_MONEY,
  };

  function line(seq: number, grossTiyin: bigint, bp: bigint) {
    return {
      id: mkId(seq),
      lineKind: 'catalog' as const,
      productId: mkId(500 + seq),
      variantId: null,
      categoryId: null,
      name: `L${String(seq)}`,
      unit: 'dona' as const,
      qty: quantityFromMilli(1_000n),
      unitPriceSnapshot: moneyFromTiyin(grossTiyin),
      vatRate: vatRateFromBasisPoints(bp),
    };
  }

  it('mixed 12% and 0% lines with an amount discount: hand-computed per-line VAT', () => {
    // A: 1 000.00 so'm @12%, B: 500.00 so'm @0%, order discount 150.00 so'm.
    // Allocation 100000:50000 → A −10000, B −5000. A final 90000 → vat round(90000*1200/11200)
    // = round(9642.857…) = 9643, net 80357. B final 45000 → vat 0.
    const res = evaluateCart({
      storeId: mkId(1),
      nowMs: T0,
      lines: [line(1, 100_000n, 1200n), line(2, 50_000n, 0n)],
      promotions: [],
      manualDiscount: { mode: 'amount', percentBp: 0n, amount: moneyFromTiyin(15_000n) },
      policy: UNLIMITED,
      overrideApprovedByUserId: null,
      overrideApprovedAmount: null,
    });
    const [a, b] = res.lines;
    expect(moneyToTiyin(a?.finalTotal ?? ZERO_MONEY)).toBe(90_000n);
    expect(moneyToTiyin(a?.vatTotal ?? ZERO_MONEY)).toBe(9_643n);
    expect(moneyToTiyin(a?.netExVat ?? ZERO_MONEY)).toBe(80_357n);
    expect(moneyToTiyin(b?.finalTotal ?? ZERO_MONEY)).toBe(45_000n);
    expect(moneyToTiyin(b?.vatTotal ?? ZERO_MONEY)).toBe(0n);
    expect(moneyToTiyin(res.totalVat)).toBe(9_643n);
    expect(moneyToTiyin(res.totalFinal)).toBe(135_000n);
    expect(moneyToTiyin(res.totalNetExVat) + moneyToTiyin(res.totalVat)).toBe(135_000n);
  });

  it('documents per-line rounding: 3 × 14 tiyin @12% → Σ line VAT 6, receipt-level would be 5', () => {
    const res = evaluateCart({
      storeId: mkId(1),
      nowMs: T0,
      lines: [line(11, 14n, 1200n), line(12, 14n, 1200n), line(13, 14n, 1200n)],
      promotions: [],
      manualDiscount: { mode: 'none', percentBp: 0n, amount: ZERO_MONEY },
      policy: UNLIMITED,
      overrideApprovedByUserId: null,
      overrideApprovedAmount: null,
    });
    for (const l of res.lines) {
      expect(moneyToTiyin(l.vatTotal)).toBe(2n); // 1.5 → 2 per line
    }
    expect(moneyToTiyin(res.totalVat)).toBe(6n);
    // Receipt-level rounding of the same total (42 tiyin) would give 5 — the model is per line.
    expect(vatIncl(42n, 1200n).vat).toBe(5n);
  });

  it('non-VAT-payer receipt: every line snapshotted at effective 0% ⇒ totalVat 0', () => {
    const nonPayer = (bp: bigint) => effectiveVatRate(vatRateFromBasisPoints(bp), false);
    const res = evaluateCart({
      storeId: mkId(1),
      nowMs: T0,
      lines: [
        { ...line(21, 112_00n, 1200n), vatRate: nonPayer(1200n) },
        { ...line(22, 77_77n, 1500n), vatRate: nonPayer(1500n) },
      ],
      promotions: [],
      manualDiscount: { mode: 'percent', percentBp: 1000n, amount: ZERO_MONEY },
      policy: UNLIMITED,
      overrideApprovedByUserId: null,
      overrideApprovedAmount: null,
    });
    expect(moneyToTiyin(res.totalVat)).toBe(0n);
    expect(moneyToTiyin(res.totalNetExVat)).toBe(moneyToTiyin(res.totalFinal));
  });

  it('property: Σ line VAT = totalVat and Σ(net+vat) = totalFinal for random 0%/12% receipts with discounts', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            gross: fc.bigInt({ min: 1n, max: 10_000_000n }),
            bp: fc.constantFrom(0n, 1200n),
          }),
          { minLength: 1, maxLength: 12 },
        ),
        fc.bigInt({ min: 0n, max: 5000n }),
        (lines, discountBp) => {
          const res = evaluateCart({
            storeId: mkId(1),
            nowMs: T0,
            lines: lines.map((l, i) => line(100 + i, l.gross, l.bp)),
            promotions: [],
            manualDiscount:
              discountBp === 0n
                ? { mode: 'none', percentBp: 0n, amount: ZERO_MONEY }
                : { mode: 'percent', percentBp: discountBp, amount: ZERO_MONEY },
            policy: UNLIMITED,
            overrideApprovedByUserId: null,
            overrideApprovedAmount: null,
          });
          let sumVat = 0n;
          let sumGross = 0n;
          for (const l of res.lines) {
            const v = moneyToTiyin(l.vatTotal);
            const n = moneyToTiyin(l.netExVat);
            expect(n + v).toBe(moneyToTiyin(l.finalTotal));
            // per-line VAT equals the included VAT of that line's final total
            expect(v).toBe(
              vatIncl(moneyToTiyin(l.finalTotal), vatRateToBasisPoints(l.vatRate)).vat,
            );
            sumVat += v;
            sumGross += n + v;
          }
          expect(sumVat).toBe(moneyToTiyin(res.totalVat));
          expect(sumGross).toBe(moneyToTiyin(res.totalFinal));
        },
      ),
      { numRuns: 300 },
    );
  });
});
