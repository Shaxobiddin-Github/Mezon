import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  DomainError,
  type CashierDiscountPolicy,
  type PromotionRule,
  type CartLineInput,
  ZERO_MONEY,
  ZERO_VAT_RATE,
  assertCartDiscountAuthorized,
  computeBuyXGetYFreeUnits,
  doesDiscountExceedCashierLimit,
  evaluateCart,
  isCartManualDiscountAuthorized,
  isPromotionActiveAt,
  moneyFromTiyin,
  moneyToTiyin,
  parseUuidV7,
  quantityFromMilli,
  toTashkentLocalTime,
  unixMsFromBigInt,
  validatePromotionRuleInput,
  vatRateFromBasisPoints,
} from './index.js';

function mkId(seq: number) {
  return parseUuidV7(`01950000-0000-7000-8000-${String(seq).padStart(12, '0')}`);
}

const STORE_ID = mkId(1);
const PROD_A = mkId(10);
const PROD_B = mkId(11);
const CAT_DRINKS = mkId(20);
const USER_MGR = mkId(30);
const T0 = unixMsFromBigInt(1_760_000_000_000n);

const ZERO_CASHIER_LIMIT: CashierDiscountPolicy = {
  percentUnlimited: false,
  maxPercentBp: 0n,
  amountUnlimited: false,
  maxAmount: ZERO_MONEY,
};

describe('@mezon/domain - cart calculation, promotions (N+M), P1/P2/P3 & property tests', () => {
  it('computes N+M (2+1) across exact worked examples and blocks fractional N+M', () => {
    expect(computeBuyXGetYFreeUnits(quantityFromMilli(2_000n), 2n, 1n)).toBe(0n);
    expect(computeBuyXGetYFreeUnits(quantityFromMilli(3_000n), 2n, 1n)).toBe(1n);
    expect(computeBuyXGetYFreeUnits(quantityFromMilli(5_000n), 2n, 1n)).toBe(1n);
    expect(computeBuyXGetYFreeUnits(quantityFromMilli(6_000n), 2n, 1n)).toBe(2n);

    expect(() =>
      validatePromotionRuleInput({
        name: 'Bad kg N+M',
        type: 'buy_x_get_y',
        scope: 'product',
        targetProductId: PROD_A,
        targetCategoryId: null,
        discountPercentBp: null,
        discountAmount: null,
        buyQty: 2n,
        freeQty: 1n,
        startsAtMs: T0,
        endsAtMs: null,
        targetProductUnit: 'kg',
      }),
    ).toThrow(DomainError);

    // Even under 'category' N+M, a fractional 'kg' item is skipped automatically
    const catNm: PromotionRule = {
      id: mkId(50),
      storeId: null,
      name: '2+1 Category',
      type: 'buy_x_get_y',
      scope: 'category',
      targetProductId: null,
      targetCategoryId: CAT_DRINKS,
      discountPercentBp: null,
      discountAmount: null,
      buyQty: 2n,
      freeQty: 1n,
      startsAtMs: T0,
      endsAtMs: null,
      isActive: true,
    };

    const evalKg = evaluateCart({
      storeId: STORE_ID,
      nowMs: T0,
      lines: [
        {
          id: mkId(100),
          lineKind: 'catalog',
          productId: PROD_A,
          variantId: null,
          categoryId: CAT_DRINKS,
          name: 'Quruq choy kg',
          unit: 'kg',
          qty: quantityFromMilli(3_000n),
          unitPriceSnapshot: moneyFromTiyin(10_000_00n),
          vatRate: vatRateFromBasisPoints(1200n),
        },
      ],
      promotions: [catNm],
      manualDiscount: { mode: 'none', percentBp: 0n, amount: ZERO_MONEY },
      policy: ZERO_CASHIER_LIMIT,
      overrideApprovedByUserId: null,
      overrideApprovedAmount: null,
    });
    expect(evalKg.totalFreeUnits).toBe(0n);
    expect(evalKg.totalPromoDiscount).toBe(ZERO_MONEY);
  });

  it('P1: pools N+M across different-price lines of same product, assigns free units cheapest-first, and preserves invariance across line splits', () => {
    const promo2Plus1: PromotionRule = {
      id: mkId(201),
      storeId: null,
      name: 'Cola 2+1',
      type: 'buy_x_get_y',
      scope: 'product',
      targetProductId: PROD_A,
      targetCategoryId: null,
      discountPercentBp: null,
      discountAmount: null,
      buyQty: 2n,
      freeQty: 1n,
      startsAtMs: T0,
      endsAtMs: null,
      isActive: true,
    };
    const promo10Pct: PromotionRule = {
      id: mkId(200),
      storeId: null,
      name: '10% All',
      type: 'percent',
      scope: 'all',
      targetProductId: null,
      targetCategoryId: null,
      discountPercentBp: 1000n,
      discountAmount: null,
      buyQty: null,
      freeQty: null,
      startsAtMs: T0,
      endsAtMs: null,
      isActive: true,
    };

    // Mixed prices: line 1 expensive (12,000, qty 1), line 2 cheaper (10,000, qty 2) -> total 3 -> 1 free on cheaper line (10,000)
    const res = evaluateCart({
      storeId: STORE_ID,
      nowMs: T0,
      lines: [
        {
          id: mkId(301),
          lineKind: 'catalog',
          productId: PROD_A,
          variantId: null,
          categoryId: CAT_DRINKS,
          name: 'Cola (new price)',
          unit: 'dona',
          qty: quantityFromMilli(1_000n),
          unitPriceSnapshot: moneyFromTiyin(12_000n),
          vatRate: ZERO_VAT_RATE,
        },
        {
          id: mkId(302),
          lineKind: 'catalog',
          productId: PROD_A,
          variantId: null,
          categoryId: CAT_DRINKS,
          name: 'Cola (old price)',
          unit: 'dona',
          qty: quantityFromMilli(2_000n),
          unitPriceSnapshot: moneyFromTiyin(10_000n),
          vatRate: ZERO_VAT_RATE,
        },
      ],
      promotions: [promo2Plus1, promo10Pct],
      manualDiscount: { mode: 'none', percentBp: 0n, amount: ZERO_MONEY },
      policy: ZERO_CASHIER_LIMIT,
      overrideApprovedByUserId: null,
      overrideApprovedAmount: null,
    });

    expect(res.totalFreeUnits).toBe(1n);
    expect(res.totalPromoDiscount).toBe(moneyFromTiyin(10_000n));
    expect(res.totalFinal).toBe(moneyFromTiyin(22_000n));
    expect(res.lines[0]?.freeUnits).toBe(0n);
    expect(res.lines[1]?.freeUnits).toBe(1n);
    expect(res.lines[0]?.appliedPromotionId).toBe(promo2Plus1.id);
    expect(res.lines[1]?.appliedPromotionId).toBe(promo2Plus1.id);

    // P1 property test A: arbitrary splits across 1..5 lines yield exact same N+M free units, discount, and total for any price
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 1, max: 6 }), { minLength: 1, maxLength: 5 }),
        fc.bigInt({ min: 1_000n, max: 50_000n }),
        fc.bigInt({ min: 1n, max: 5n }),
        fc.bigInt({ min: 1n, max: 3n }),
        (qtys, unitPrice, buyQty, freeQty) => {
          const dynNm: PromotionRule = {
            ...promo2Plus1,
            buyQty,
            freeQty,
          };
          const sumUnits = qtys.reduce((a, b) => a + b, 0);
          const merged = evaluateCart({
            storeId: STORE_ID,
            nowMs: T0,
            lines: [
              {
                id: mkId(400),
                lineKind: 'catalog',
                productId: PROD_A,
                variantId: null,
                categoryId: CAT_DRINKS,
                name: 'Merged',
                unit: 'dona',
                qty: quantityFromMilli(BigInt(sumUnits) * 1000n),
                unitPriceSnapshot: moneyFromTiyin(unitPrice),
                vatRate: ZERO_VAT_RATE,
              },
            ],
            promotions: [dynNm],
            manualDiscount: { mode: 'none', percentBp: 0n, amount: ZERO_MONEY },
            policy: ZERO_CASHIER_LIMIT,
            overrideApprovedByUserId: null,
            overrideApprovedAmount: null,
          });

          const split = evaluateCart({
            storeId: STORE_ID,
            nowMs: T0,
            lines: qtys.map((q, idx) => ({
              id: mkId(410 + idx),
              lineKind: 'catalog' as const,
              productId: PROD_A,
              variantId: null,
              categoryId: CAT_DRINKS,
              name: `Split ${idx}`,
              unit: 'dona' as const,
              qty: quantityFromMilli(BigInt(q) * 1000n),
              unitPriceSnapshot: moneyFromTiyin(unitPrice),
              vatRate: ZERO_VAT_RATE,
            })),
            promotions: [dynNm],
            manualDiscount: { mode: 'none', percentBp: 0n, amount: ZERO_MONEY },
            policy: ZERO_CASHIER_LIMIT,
            overrideApprovedByUserId: null,
            overrideApprovedAmount: null,
          });

          expect(split.totalFreeUnits).toBe(merged.totalFreeUnits);
          expect(split.totalPromoDiscount).toBe(merged.totalPromoDiscount);
          expect(split.totalFinal).toBe(merged.totalFinal);
        },
      ),
      { numRuns: 100 },
    );

    // P1 property test B: competing N+M vs 10% (multiple-of-10 price so % has exact tiyin) prevents double-dipping on split rows
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 1, max: 6 }), { minLength: 1, maxLength: 5 }),
        fc.bigInt({ min: 100n, max: 5_000n }).map((n) => n * 10n),
        (qtys, unitPrice) => {
          const sumUnits = qtys.reduce((a, b) => a + b, 0);
          const merged = evaluateCart({
            storeId: STORE_ID,
            nowMs: T0,
            lines: [
              {
                id: mkId(450),
                lineKind: 'catalog',
                productId: PROD_A,
                variantId: null,
                categoryId: CAT_DRINKS,
                name: 'Merged',
                unit: 'dona',
                qty: quantityFromMilli(BigInt(sumUnits) * 1000n),
                unitPriceSnapshot: moneyFromTiyin(unitPrice),
                vatRate: ZERO_VAT_RATE,
              },
            ],
            promotions: [promo2Plus1, promo10Pct],
            manualDiscount: { mode: 'none', percentBp: 0n, amount: ZERO_MONEY },
            policy: ZERO_CASHIER_LIMIT,
            overrideApprovedByUserId: null,
            overrideApprovedAmount: null,
          });

          const split = evaluateCart({
            storeId: STORE_ID,
            nowMs: T0,
            lines: qtys.map((q, idx) => ({
              id: mkId(460 + idx),
              lineKind: 'catalog' as const,
              productId: PROD_A,
              variantId: null,
              categoryId: CAT_DRINKS,
              name: `Split ${idx}`,
              unit: 'dona' as const,
              qty: quantityFromMilli(BigInt(q) * 1000n),
              unitPriceSnapshot: moneyFromTiyin(unitPrice),
              vatRate: ZERO_VAT_RATE,
            })),
            promotions: [promo2Plus1, promo10Pct],
            manualDiscount: { mode: 'none', percentBp: 0n, amount: ZERO_MONEY },
            policy: ZERO_CASHIER_LIMIT,
            overrideApprovedByUserId: null,
            overrideApprovedAmount: null,
          });

          expect(split.totalFreeUnits).toBe(merged.totalFreeUnits);
          expect(split.totalPromoDiscount).toBe(merged.totalPromoDiscount);
          expect(split.totalFinal).toBe(merged.totalFinal);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('enforces [start, end) half-open bounds, Asia/Tashkent UTC+5 time, tie-break by id ASC, and flat promo unit invariance', () => {
    const endT = unixMsFromBigInt(1_760_000_100_000n);
    const pLowId: PromotionRule = {
      id: mkId(100),
      storeId: null,
      name: 'Fixed 1000/unit A',
      type: 'fixed_amount',
      scope: 'product',
      targetProductId: PROD_B,
      targetCategoryId: null,
      discountPercentBp: null,
      discountAmount: moneyFromTiyin(1_000n),
      buyQty: null,
      freeQty: null,
      startsAtMs: T0,
      endsAtMs: endT,
      isActive: true,
    };
    const pHighId: PromotionRule = {
      ...pLowId,
      id: mkId(101),
      name: 'Percent 10% B (same 1000 on 10,000)',
      type: 'percent',
      discountPercentBp: 1000n,
      discountAmount: null,
    };

    const baseLine: CartLineInput = {
      id: mkId(500),
      lineKind: 'catalog',
      productId: PROD_B,
      variantId: null,
      categoryId: null,
      name: 'Non',
      unit: 'dona',
      qty: quantityFromMilli(2_000n),
      unitPriceSnapshot: moneyFromTiyin(10_000n),
      vatRate: vatRateFromBasisPoints(1200n),
    };

    // At T0 (inclusive start): active, tie-break selects lowest UUID (pLowId)
    const atStart = evaluateCart({
      storeId: STORE_ID,
      nowMs: T0,
      lines: [baseLine],
      promotions: [pHighId, pLowId],
      manualDiscount: { mode: 'none', percentBp: 0n, amount: ZERO_MONEY },
      policy: ZERO_CASHIER_LIMIT,
      overrideApprovedByUserId: null,
      overrideApprovedAmount: null,
    });
    expect(atStart.lines[0]?.appliedPromotionId).toBe(pLowId.id);
    expect(atStart.totalPromoDiscount).toBe(moneyFromTiyin(2_000n));

    // At endT (exclusive end): expired!
    const atEnd = evaluateCart({
      storeId: STORE_ID,
      nowMs: endT,
      lines: [baseLine],
      promotions: [pLowId],
      manualDiscount: { mode: 'none', percentBp: 0n, amount: ZERO_MONEY },
      policy: ZERO_CASHIER_LIMIT,
      overrideApprovedByUserId: null,
      overrideApprovedAmount: null,
    });
    expect(atEnd.totalPromoDiscount).toBe(ZERO_MONEY);

    // Asia/Tashkent UTC+5: 1970-01-01T19:30:00Z -> next day 1970-01-02 (Friday = 5n) 00:30 local
    const utcMs = unixMsFromBigInt((19n * 60n + 30n) * 60_000n);
    expect(toTashkentLocalTime(utcMs)).toEqual({ dayOfWeek: 5n, minutesOfDay: 30n });
  });

  it('P2 & P3: validates cashier percent/amount limits, explicit unlimited flags, and revokes supervisor approval if cart grows past approved amount', () => {
    const policy10PctAndMax15k: CashierDiscountPolicy = {
      percentUnlimited: false,
      maxPercentBp: 1000n,
      amountUnlimited: false,
      maxAmount: moneyFromTiyin(15_000n),
    };

    // Fixed amount exceeding 10% on a 100,000 cart (12,000 > 10% even though < 15,000 maxAmount) requires override!
    const sneakByAmount = evaluateCart({
      storeId: STORE_ID,
      nowMs: T0,
      lines: [
        {
          id: mkId(600),
          lineKind: 'quick_sale',
          productId: null,
          variantId: null,
          categoryId: null,
          name: 'Qadoqlash',
          unit: 'dona',
          qty: quantityFromMilli(1_000n),
          unitPriceSnapshot: moneyFromTiyin(100_000n),
          vatRate: ZERO_VAT_RATE,
        },
      ],
      promotions: [],
      manualDiscount: { mode: 'amount', percentBp: 0n, amount: moneyFromTiyin(12_000n) },
      policy: policy10PctAndMax15k,
      overrideApprovedByUserId: null,
      overrideApprovedAmount: null,
    });
    expect(sneakByAmount.exceedsCashierLimit).toBe(true);
    expect(sneakByAmount.discountOverrideRequired).toBe(true);
    expect(() => assertCartDiscountAuthorized(sneakByAmount)).toThrow(DomainError);

    // 10% on 100,000 approved for 10,000 tiyin under zero-limit policy
    const approvedSmall = evaluateCart({
      storeId: STORE_ID,
      nowMs: T0,
      lines: [
        {
          id: mkId(601),
          lineKind: 'quick_sale',
          productId: null,
          variantId: null,
          categoryId: null,
          name: 'Xizmat',
          unit: 'dona',
          qty: quantityFromMilli(1_000n),
          unitPriceSnapshot: moneyFromTiyin(100_000n),
          vatRate: ZERO_VAT_RATE,
        },
      ],
      promotions: [],
      manualDiscount: { mode: 'percent', percentBp: 1000n, amount: ZERO_MONEY },
      policy: ZERO_CASHIER_LIMIT,
      overrideApprovedByUserId: USER_MGR,
      overrideApprovedAmount: moneyFromTiyin(10_000n),
    });
    expect(approvedSmall.discountAuthorized).toBe(true);
    expect(approvedSmall.discountOverrideRequired).toBe(false);

    // Cart grows to 500,000 -> 10% is now 50,000 > overrideApprovedAmount (10,000) -> P2 invalidates!
    const grownCart = evaluateCart({
      storeId: STORE_ID,
      nowMs: T0,
      lines: [
        {
          id: mkId(601),
          lineKind: 'quick_sale',
          productId: null,
          variantId: null,
          categoryId: null,
          name: 'Xizmat',
          unit: 'dona',
          qty: quantityFromMilli(5_000n),
          unitPriceSnapshot: moneyFromTiyin(100_000n),
          vatRate: ZERO_VAT_RATE,
        },
      ],
      promotions: [],
      manualDiscount: { mode: 'percent', percentBp: 1000n, amount: ZERO_MONEY },
      policy: ZERO_CASHIER_LIMIT,
      overrideApprovedByUserId: USER_MGR,
      overrideApprovedAmount: moneyFromTiyin(10_000n),
    });
    expect(grownCart.effectiveOrderDiscount).toBe(moneyFromTiyin(50_000n));
    expect(grownCart.discountAuthorized).toBe(false);
    expect(grownCart.discountOverrideRequired).toBe(true);
    expect(() => assertCartDiscountAuthorized(grownCart)).toThrow(/DISCOUNT_OVERRIDE_REQUIRED/);
  });

  it('property test: Σ lineFinalTotal = cartTotal, Σ allocated = orderDiscount, Σ vat + net = totalFinal, and zero negative values', () => {
    const unitArb = fc.constantFrom<'dona' | 'kg' | 'litr'>('dona', 'kg', 'litr');
    const lineArb = fc.record({
      isQuick: fc.boolean(),
      prodPick: fc.constantFrom(PROD_A, PROD_B),
      unit: unitArb,
      rawUnits: fc.integer({ min: 1, max: 50 }),
      rawMilliExtra: fc.integer({ min: 0, max: 999 }),
      price: fc.bigInt({ min: 0n, max: 500_000n }),
      vatBp: fc.constantFrom(0n, 1200n, 1500n),
    });

    const discountArb = fc.oneof(
      fc.record({
        mode: fc.constant('none' as const),
        percentBp: fc.constant(0n),
        amount: fc.constant(0n),
      }),
      fc.record({
        mode: fc.constant('percent' as const),
        percentBp: fc.bigInt({ min: 1n, max: 10_000n }),
        amount: fc.constant(0n),
      }),
      fc.record({
        mode: fc.constant('amount' as const),
        percentBp: fc.constant(0n),
        amount: fc.bigInt({ min: 0n, max: 5_000_000n }),
      }),
    );

    const promos: PromotionRule[] = [
      {
        id: mkId(701),
        storeId: null,
        name: '2+1 A',
        type: 'buy_x_get_y',
        scope: 'product',
        targetProductId: PROD_A,
        targetCategoryId: null,
        discountPercentBp: null,
        discountAmount: null,
        buyQty: 2n,
        freeQty: 1n,
        startsAtMs: T0,
        endsAtMs: null,
        isActive: true,
      },
      {
        id: mkId(702),
        storeId: null,
        name: '500/unit Cat',
        type: 'fixed_amount',
        scope: 'category',
        targetProductId: null,
        targetCategoryId: CAT_DRINKS,
        discountPercentBp: null,
        discountAmount: moneyFromTiyin(500n),
        buyQty: null,
        freeQty: null,
        startsAtMs: T0,
        endsAtMs: null,
        isActive: true,
      },
      {
        id: mkId(703),
        storeId: null,
        name: '15% All',
        type: 'percent',
        scope: 'all',
        targetProductId: null,
        targetCategoryId: null,
        discountPercentBp: 1500n,
        discountAmount: null,
        buyQty: null,
        freeQty: null,
        startsAtMs: T0,
        endsAtMs: null,
        isActive: true,
      },
    ];

    fc.assert(
      fc.property(
        fc.array(lineArb, { minLength: 0, maxLength: 12 }),
        discountArb,
        (rawLines, disc) => {
          const lines: CartLineInput[] = rawLines.map((l, idx) => {
            const qtyMilli =
              l.unit === 'dona'
                ? BigInt(l.rawUnits) * 1000n
                : BigInt(l.rawUnits) * 1000n + BigInt(l.rawMilliExtra);
            return {
              id: mkId(800 + idx),
              lineKind: l.isQuick ? 'quick_sale' : 'catalog',
              productId: l.isQuick ? null : l.prodPick,
              variantId: null,
              categoryId: l.isQuick ? null : CAT_DRINKS,
              name: `Item ${idx}`,
              unit: l.unit,
              qty: quantityFromMilli(qtyMilli),
              unitPriceSnapshot: moneyFromTiyin(l.price),
              vatRate: vatRateFromBasisPoints(l.vatBp),
            };
          });

          const res = evaluateCart({
            storeId: STORE_ID,
            nowMs: T0,
            lines,
            promotions: promos,
            manualDiscount: {
              mode: disc.mode,
              percentBp: disc.percentBp,
              amount: moneyFromTiyin(disc.amount),
            },
            policy: {
              percentUnlimited: true,
              maxPercentBp: 0n,
              amountUnlimited: true,
              maxAmount: ZERO_MONEY,
            },
            overrideApprovedByUserId: null,
            overrideApprovedAmount: null,
          });

          let sumGross = 0n;
          let sumPromo = 0n;
          let sumAfterPromo = 0n;
          let sumAlloc = 0n;
          let sumFinal = 0n;
          let sumNet = 0n;
          let sumVat = 0n;

          for (const line of res.lines) {
            const g = moneyToTiyin(line.grossTotal);
            const p = moneyToTiyin(line.promoDiscount);
            const s = moneyToTiyin(line.subtotalAfterPromo);
            const a = moneyToTiyin(line.allocatedOrderDiscount);
            const f = moneyToTiyin(line.finalTotal);
            const n = moneyToTiyin(line.netExVat);
            const v = moneyToTiyin(line.vatTotal);

            expect(g >= 0n).toBe(true);
            expect(p >= 0n && p <= g).toBe(true);
            expect(s).toBe(g - p);
            expect(a >= 0n && a <= s).toBe(true);
            expect(f).toBe(s - a);
            expect(f >= 0n).toBe(true);
            expect(n >= 0n && v >= 0n).toBe(true);
            expect(n + v).toBe(f);

            sumGross += g;
            sumPromo += p;
            sumAfterPromo += s;
            sumAlloc += a;
            sumFinal += f;
            sumNet += n;
            sumVat += v;
          }

          expect(sumGross).toBe(moneyToTiyin(res.subtotalGross));
          expect(sumPromo).toBe(moneyToTiyin(res.totalPromoDiscount));
          expect(sumAfterPromo).toBe(moneyToTiyin(res.subtotalAfterPromo));
          expect(sumAlloc).toBe(moneyToTiyin(res.effectiveOrderDiscount));
          expect(sumFinal).toBe(moneyToTiyin(res.totalFinal));
          expect(sumNet).toBe(moneyToTiyin(res.totalNetExVat));
          expect(sumVat).toBe(moneyToTiyin(res.totalVat));
          expect(moneyToTiyin(res.totalFinal)).toBe(sumAfterPromo - sumAlloc);
        },
      ),
      { numRuns: 200 },
    );
  });

  it('T1.3 test debt (1): store-scoped promotion applies only to its store, whereas storeId=null applies everywhere', () => {
    const storeA = mkId(101);
    const storeB = mkId(102);

    const storeAPromo: PromotionRule = {
      id: mkId(701),
      storeId: storeA,
      name: 'Only Store A 10%',
      type: 'percent',
      scope: 'all',
      targetProductId: null,
      targetCategoryId: null,
      discountPercentBp: 1_000n,
      discountAmount: null,
      buyQty: null,
      freeQty: null,
      startsAtMs: T0,
      endsAtMs: null,
      isActive: true,
    };
    const networkPromo: PromotionRule = {
      id: mkId(702),
      storeId: null,
      name: 'Network Wide 5%',
      type: 'percent',
      scope: 'all',
      targetProductId: null,
      targetCategoryId: null,
      discountPercentBp: 500n,
      discountAmount: null,
      buyQty: null,
      freeQty: null,
      startsAtMs: T0,
      endsAtMs: null,
      isActive: true,
    };

    expect(isPromotionActiveAt(storeAPromo, T0, storeA)).toBe(true);
    expect(isPromotionActiveAt(storeAPromo, T0, storeB)).toBe(false);
    expect(isPromotionActiveAt(networkPromo, T0, storeA)).toBe(true);
    expect(isPromotionActiveAt(networkPromo, T0, storeB)).toBe(true);

    const line: CartLineInput = {
      id: mkId(703),
      lineKind: 'catalog',
      productId: PROD_A,
      variantId: null,
      categoryId: CAT_DRINKS,
      name: 'Tea',
      unit: 'dona',
      qty: quantityFromMilli(1_000n),
      unitPriceSnapshot: moneyFromTiyin(100_000n),
      vatRate: ZERO_VAT_RATE,
    };

    const evalStoreB = evaluateCart({
      storeId: storeB,
      nowMs: T0,
      lines: [line],
      promotions: [storeAPromo, networkPromo],
      manualDiscount: { mode: 'none', percentBp: 0n, amount: ZERO_MONEY },
      policy: ZERO_CASHIER_LIMIT,
      overrideApprovedByUserId: null,
      overrideApprovedAmount: null,
    });
    expect(evalStoreB.lines[0]?.appliedPromotionId).toBe(networkPromo.id);
    expect(evalStoreB.totalPromoDiscount).toBe(moneyFromTiyin(5_000n));

    const evalStoreA = evaluateCart({
      storeId: storeA,
      nowMs: T0,
      lines: [line],
      promotions: [storeAPromo, networkPromo],
      manualDiscount: { mode: 'none', percentBp: 0n, amount: ZERO_MONEY },
      policy: ZERO_CASHIER_LIMIT,
      overrideApprovedByUserId: null,
      overrideApprovedAmount: null,
    });
    expect(evalStoreA.lines[0]?.appliedPromotionId).toBe(storeAPromo.id);
    expect(evalStoreA.totalPromoDiscount).toBe(moneyFromTiyin(10_000n));
  });

  it('T1.3 test debt (2): doesDiscountExceedCashierLimit enforces exact maxAmount (+1 tiyin) and maxPercentBp (+1 tiyin) boundaries', () => {
    const amountPolicy: CashierDiscountPolicy = {
      percentUnlimited: true,
      maxPercentBp: 0n,
      amountUnlimited: false,
      maxAmount: moneyFromTiyin(5_000n),
    };
    const subtotal = moneyFromTiyin(100_000n);

    expect(doesDiscountExceedCashierLimit(moneyFromTiyin(5_000n), subtotal, amountPolicy)).toBe(
      false,
    );
    expect(doesDiscountExceedCashierLimit(moneyFromTiyin(5_001n), subtotal, amountPolicy)).toBe(
      true,
    );

    const percentPolicy: CashierDiscountPolicy = {
      percentUnlimited: false,
      maxPercentBp: 1_000n, // 10.00%
      amountUnlimited: true,
      maxAmount: ZERO_MONEY,
    };

    // Exact 10.00% of 100,000 = 10,000 -> allowed; 10,001 -> exceeds
    expect(doesDiscountExceedCashierLimit(moneyFromTiyin(10_000n), subtotal, percentPolicy)).toBe(
      false,
    );
    expect(doesDiscountExceedCashierLimit(moneyFromTiyin(10_001n), subtotal, percentPolicy)).toBe(
      true,
    );

    const bothPolicy: CashierDiscountPolicy = {
      percentUnlimited: false,
      maxPercentBp: 1_000n,
      amountUnlimited: false,
      maxAmount: moneyFromTiyin(5_000n),
    };
    expect(doesDiscountExceedCashierLimit(moneyFromTiyin(5_000n), subtotal, bothPolicy)).toBe(
      false,
    );
    expect(doesDiscountExceedCashierLimit(moneyFromTiyin(5_001n), subtotal, bothPolicy)).toBe(true);
  });

  it('T1.3 test debt (3): isCartManualDiscountAuthorized rejects when either overrideApprovedByUserId or overrideApprovedAmount is null', () => {
    const subtotal = moneyFromTiyin(100_000n);
    const exceededDiscount = moneyFromTiyin(20_000n);
    const strictPolicy: CashierDiscountPolicy = {
      percentUnlimited: false,
      maxPercentBp: 1_000n, // 10,000 allowed
      amountUnlimited: false,
      maxAmount: moneyFromTiyin(10_000n),
    };

    // Approver present, approved ceiling null -> must reject
    expect(
      isCartManualDiscountAuthorized({
        effectiveOrderDiscount: exceededDiscount,
        subtotalAfterPromo: subtotal,
        policy: strictPolicy,
        overrideApprovedByUserId: USER_MGR,
        overrideApprovedAmount: null,
      }),
    ).toBe(false);

    // Approved ceiling sufficient, approver ID null -> must reject
    expect(
      isCartManualDiscountAuthorized({
        effectiveOrderDiscount: exceededDiscount,
        subtotalAfterPromo: subtotal,
        policy: strictPolicy,
        overrideApprovedByUserId: null,
        overrideApprovedAmount: moneyFromTiyin(25_000n),
      }),
    ).toBe(false);

    // Both present and ceiling >= effective discount -> allowed
    expect(
      isCartManualDiscountAuthorized({
        effectiveOrderDiscount: exceededDiscount,
        subtotalAfterPromo: subtotal,
        policy: strictPolicy,
        overrideApprovedByUserId: USER_MGR,
        overrideApprovedAmount: moneyFromTiyin(20_000n),
      }),
    ).toBe(true);
  });
});
