import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  type CashierDiscountPolicy,
  DomainError,
  type OrderDraftLineInput,
  type OrderStatus,
  PAYMENT_METHODS,
  type PaymentMethod,
  type PromotionRule,
  ZERO_MONEY,
  ZERO_VAT_RATE,
  assertOrderTransition,
  buildAutoCancelOrderRefunds,
  buildDeliverySalePayments,
  canTransitionOrderStatus,
  canonicalizeCancelOrderRequest,
  canonicalizeConfirmOrderRequest,
  canonicalizeCreateOrderRequest,
  canonicalizeDeliverOrderRequest,
  canonicalizeMarkOrderReadyRequest,
  canonicalizeRecordOrderAdvanceRequest,
  canonicalizeRefundOrderAdvanceRequest,
  computeOpenAdvancesAccounting,
  createEmptyPaymentMethodMap,
  evaluateOrderDraft,
  formatOrderCode,
  moneyFromTiyin,
  moneyToTiyin,
  parseUuidV7,
  quantityFromMilli,
  resolveOrderReturnEffectivePaidByMethod,
  resolveRecordOrderAdvance,
  resolveRefundOrderAdvances,
  summarizeOrderPayments,
  unixMsFromBigInt,
  vatRateFromBasisPoints,
} from './index.js';

function mkId(seq: number) {
  return parseUuidV7(`01950000-0000-7000-8000-${String(seq).padStart(12, '0')}`);
}

const DEV1 = mkId(99);
const STORE_ID = mkId(1);
const CUST_ID = mkId(2);
const MGR_ID = mkId(3);
const ORD_ID = mkId(4);
const PROD_CAKE = mkId(10);
const CAT_SWEETS = mkId(20);
const T0 = unixMsFromBigInt(1_760_000_000_000n);

const LIMITED_POLICY: CashierDiscountPolicy = {
  percentUnlimited: false,
  maxPercentBp: 500n, // max 5%
  amountUnlimited: false,
  maxAmount: moneyFromTiyin(5_000_00n),
};

describe('@mezon/domain - T1.10 Order Lifecycle, Frozen Evaluation (O3), Advances (O4), Delivery (O2) & Return Method Spread (O1)', () => {
  it('enforces MONOTONE order state transition matrix & order code formatting', () => {
    expect(formatOrderCode(DEV1, 7n)).toBe('ORD-0099-000007');
    expect(() => formatOrderCode(DEV1, 0n)).toThrow(DomainError);

    expect(canTransitionOrderStatus('draft', 'confirmed')).toBe(true);
    expect(canTransitionOrderStatus('draft', 'cancelled')).toBe(true);
    expect(canTransitionOrderStatus('draft', 'ready')).toBe(false);
    expect(canTransitionOrderStatus('draft', 'delivered')).toBe(false);

    expect(canTransitionOrderStatus('confirmed', 'ready')).toBe(true);
    expect(canTransitionOrderStatus('confirmed', 'delivered')).toBe(true);
    expect(canTransitionOrderStatus('confirmed', 'cancelled')).toBe(true);

    expect(canTransitionOrderStatus('ready', 'delivered')).toBe(true);
    expect(canTransitionOrderStatus('ready', 'cancelled')).toBe(true);
    expect(canTransitionOrderStatus('ready', 'confirmed')).toBe(false);

    for (const target of ['draft', 'confirmed', 'ready', 'delivered', 'cancelled'] as const) {
      expect(canTransitionOrderStatus('delivered', target)).toBe(false);
      expect(canTransitionOrderStatus('cancelled', target)).toBe(false);
      expect(() => assertOrderTransition('delivered', target)).toThrowError(
        expect.objectContaining({ code: 'ORDER_INVALID_TRANSITION' }),
      );
      expect(() => assertOrderTransition('cancelled', target)).toThrowError(
        expect.objectContaining({ code: 'ORDER_INVALID_TRANSITION' }),
      );
    }
  });

  it('O3: evaluates order once via T1.3 evaluateCart with promos, pro-rata manual discount & supervisor override', () => {
    const promo: PromotionRule = {
      id: mkId(50),
      storeId: STORE_ID,
      name: 'Sweet 10% Off',
      type: 'percent',
      scope: 'category',
      targetProductId: null,
      targetCategoryId: CAT_SWEETS,
      discountPercentBp: 1_000n,
      discountAmount: null,
      buyQty: null,
      freeQty: null,
      startsAtMs: T0,
      endsAtMs: null,
      isActive: true,
    };

    const lines: OrderDraftLineInput[] = [
      {
        id: mkId(101),
        lineKind: 'catalog',
        productId: PROD_CAKE,
        variantId: null,
        categoryId: CAT_SWEETS,
        name: 'Napoleon Tort',
        unit: 'dona',
        qty: quantityFromMilli(2_000n),
        unitPriceSnapshot: moneyFromTiyin(50_000_00n), // 100,000 gross
        vatRate: vatRateFromBasisPoints(1200n),
        mxikSnapshot: '10712001001000000',
        packageCodeSnapshot: 'PK-1',
        vatRateBpSnapshot: 1200,
      },
      {
        id: mkId(102),
        lineKind: 'quick_sale',
        productId: null,
        variantId: null,
        categoryId: null,
        name: 'Custom Greeting Banner',
        unit: 'dona',
        qty: quantityFromMilli(1_000n),
        unitPriceSnapshot: moneyFromTiyin(30_000_00n), // 30,000 gross
        vatRate: ZERO_VAT_RATE,
        mxikSnapshot: null,
        packageCodeSnapshot: null,
        vatRateBpSnapshot: 0,
      },
    ];

    // Discount above 5% / 5,000 UZS requires supervisor approval
    expect(() =>
      evaluateOrderDraft({
        storeId: STORE_ID,
        nowMs: T0,
        lines,
        promotions: [promo],
        manualDiscount: {
          mode: 'amount',
          percentBp: 0n,
          amount: moneyFromTiyin(10_000_00n),
        },
        policy: LIMITED_POLICY,
        overrideApprovedByUserId: null,
        overrideApprovedAmount: null,
      }),
    ).toThrowError(expect.objectContaining({ code: 'DISCOUNT_OVERRIDE_REQUIRED' }));

    const ok = evaluateOrderDraft({
      storeId: STORE_ID,
      nowMs: T0,
      lines,
      promotions: [promo],
      manualDiscount: {
        mode: 'amount',
        percentBp: 0n,
        amount: moneyFromTiyin(10_000_00n),
      },
      policy: LIMITED_POLICY,
      overrideApprovedByUserId: MGR_ID,
      overrideApprovedAmount: moneyFromTiyin(10_000_00n),
    });

    // Cake: 100k - 10% (10k) = 90k after promo; Custom: 30k -> totalAfterPromo = 120k -> -10k manual -> 110k final
    expect(ok.subtotalGross).toBe(moneyFromTiyin(130_000_00n));
    expect(ok.totalPromoDiscount).toBe(moneyFromTiyin(10_000_00n));
    expect(ok.effectiveOrderDiscount).toBe(moneyFromTiyin(10_000_00n));
    expect(ok.totalFinal).toBe(moneyFromTiyin(110_000_00n));
    expect(ok.lines[0]?.appliedPromotionName).toBe('Sweet 10% Off');
    expect(ok.lines[1]?.lineKind).toBe('quick_sale');

    const emptyLines: OrderDraftLineInput[] = [];
    expect(() =>
      evaluateOrderDraft({
        storeId: STORE_ID,
        nowMs: T0,
        lines: emptyLines,
        promotions: [],
        manualDiscount: { mode: 'none', percentBp: 0n, amount: ZERO_MONEY },
        policy: LIMITED_POLICY,
        overrideApprovedByUserId: null,
        overrideApprovedAmount: null,
      }),
    ).toThrowError(expect.objectContaining({ code: 'ORDER_EMPTY' }));
  });

  it('enforces advance limits, per-method V2 refunds, auto-cancel refunds & O2 delivery payment split', () => {
    const dep = resolveRecordOrderAdvance({
      orderStatus: 'draft',
      orderTotalAmount: moneyFromTiyin(100_000n),
      existingNetAdvance: ZERO_MONEY,
      payments: [
        {
          method: 'cash',
          tenderedAmount: moneyFromTiyin(50_000n),
          amount: moneyFromTiyin(40_000n),
        },
        { method: 'card', amount: moneyFromTiyin(30_000n), providerRef: 'TX-1' },
      ],
    });
    expect(dep.addedAdvance).toBe(moneyFromTiyin(70_000n));
    expect(dep.cashInAmount).toBe(moneyFromTiyin(50_000n));
    expect(dep.cashChangeOutAmount).toBe(moneyFromTiyin(10_000n));
    expect(dep.nextStatus).toBe('confirmed');

    // Exceeding order total blocked
    expect(() =>
      resolveRecordOrderAdvance({
        orderStatus: 'confirmed',
        orderTotalAmount: moneyFromTiyin(100_000n),
        existingNetAdvance: moneyFromTiyin(70_000n),
        payments: [{ method: 'card', amount: moneyFromTiyin(30_001n) }],
      }),
    ).toThrowError(expect.objectContaining({ code: 'ORDER_ADVANCE_EXCEEDS_TOTAL' }));

    const summary = summarizeOrderPayments([
      { kind: 'advance', method: 'cash', amount: moneyFromTiyin(40_000n) },
      { kind: 'advance', method: 'card', amount: moneyFromTiyin(30_000n) },
    ]);

    // V2 method cap: cannot refund 45k card when only 30k card advance taken
    expect(() =>
      resolveRefundOrderAdvances({
        orderStatus: 'confirmed',
        netAdvanceByMethod: summary.netAdvanceByMethod,
        totalNetAdvance: summary.netAdvance,
        refunds: [{ method: 'card', amount: moneyFromTiyin(45_000n) }],
      }),
    ).toThrowError(expect.objectContaining({ code: 'ORDER_ADVANCE_REFUND_EXCEEDED' }));

    // Partial refund 15k cash
    const refund = resolveRefundOrderAdvances({
      orderStatus: 'confirmed',
      netAdvanceByMethod: summary.netAdvanceByMethod,
      totalNetAdvance: summary.netAdvance,
      refunds: [{ method: 'cash', amount: moneyFromTiyin(15_000n) }],
    });
    expect(refund.nextNetAdvance).toBe(moneyFromTiyin(55_000n));

    const afterRefund = summarizeOrderPayments([
      { kind: 'advance', method: 'cash', amount: moneyFromTiyin(40_000n) },
      { kind: 'advance', method: 'card', amount: moneyFromTiyin(30_000n) },
      { kind: 'advance_refund', method: 'cash', amount: moneyFromTiyin(15_000n) },
    ]);

    // Auto-cancel builds exact method breakdown for remaining 25k cash + 30k card
    const cancelRef = buildAutoCancelOrderRefunds({
      orderStatus: 'ready',
      netAdvanceByMethod: afterRefund.netAdvanceByMethod,
    });
    expect(cancelRef.cashRefundAmount).toBe(moneyFromTiyin(25_000n));
    expect(cancelRef.nonCashRefundAmount).toBe(moneyFromTiyin(30_000n));
    expect(cancelRef.totalRefund).toBe(moneyFromTiyin(55_000n));

    // O2 Delivery: 55k netAdvance + 25k cash + 20k debt = 100k
    const delivered = buildDeliverySalePayments({
      orderStatus: 'ready',
      orderTotalAmount: moneyFromTiyin(100_000n),
      netAdvance: afterRefund.netAdvance,
      debtAmount: moneyFromTiyin(20_000n),
      customerId: CUST_ID,
      additionalPayments: [{ method: 'cash', tenderedAmount: moneyFromTiyin(30_000n) }],
    });
    expect(delivered.appliedAdvance).toBe(moneyFromTiyin(55_000n));
    expect(delivered.resolved.payments).toEqual([
      {
        method: 'advance',
        amount: moneyFromTiyin(55_000n),
        tenderedAmount: null,
        changeAmount: ZERO_MONEY,
        providerRef: null,
      },
      {
        method: 'cash',
        amount: moneyFromTiyin(25_000n),
        tenderedAmount: moneyFromTiyin(30_000n),
        changeAmount: moneyFromTiyin(5_000n),
        providerRef: null,
      },
    ]);

    // Defensive ORDER_EXCESS_ADVANCE guard
    expect(() =>
      buildDeliverySalePayments({
        orderStatus: 'ready',
        orderTotalAmount: moneyFromTiyin(50_000n),
        netAdvance: moneyFromTiyin(55_000n),
        debtAmount: ZERO_MONEY,
        customerId: null,
        additionalPayments: [],
      }),
    ).toThrowError(expect.objectContaining({ code: 'ORDER_EXCESS_ADVANCE' }));

    // O1 / T1.6 spread 'advance' (55k = 25k cash + 30k card) back for return eligibility
    const effective = resolveOrderReturnEffectivePaidByMethod({
      salePayments: delivered.resolved.payments,
      netAdvanceByMethod: afterRefund.netAdvanceByMethod,
      netAdvanceTotal: afterRefund.netAdvance,
    });
    expect(effective.cash).toBe(moneyFromTiyin(50_000n)); // 25k cash advance + 25k delivery cash
    expect(effective.card).toBe(moneyFromTiyin(30_000n)); // 30k card advance
  });

  it('produces deterministic canonical request hashes for all 7 order operations', () => {
    const h1 = canonicalizeCreateOrderRequest({
      customerId: CUST_ID,
      customerName: 'Dilshod',
      customerPhoneNormalized: '+998901234567',
      dueAtMs: T0,
      note: 'Birthday',
      confirmImmediately: true,
      manualDiscountMode: 'none',
      manualDiscountPercentBp: 0n,
      manualDiscountAmount: ZERO_MONEY,
      overrideApprovedByUserId: null,
      overrideApprovedAmount: null,
      lines: [
        {
          lineKind: 'quick_sale',
          productId: null,
          variantId: null,
          itemName: 'Cake',
          unit: 'dona',
          qtyMilli: 1_000n,
          unitPriceTiyin: 50_000n,
          vatRateBp: 0,
          mxikSnapshot: null,
          packageCodeSnapshot: null,
        },
      ],
    });
    expect(h1).toContain('create_order.v1');
    expect(canonicalizeConfirmOrderRequest({ orderId: ORD_ID })).toContain(ORD_ID);
    expect(canonicalizeMarkOrderReadyRequest({ orderId: ORD_ID })).toContain(ORD_ID);
    expect(
      canonicalizeRecordOrderAdvanceRequest({
        orderId: ORD_ID,
        payments: [{ method: 'cash', tenderedAmount: moneyFromTiyin(10_000n) }],
      }),
    ).toContain('record_order_advance.v1');
    expect(
      canonicalizeRefundOrderAdvanceRequest({
        orderId: ORD_ID,
        reason: 'Changed date',
        refunds: [{ method: 'cash', amount: moneyFromTiyin(10_000n) }],
      }),
    ).toContain('refund_order_advance.v1');
    expect(
      canonicalizeDeliverOrderRequest({
        orderId: ORD_ID,
        expectedTotal: moneyFromTiyin(50_000n),
        debtAmount: ZERO_MONEY,
        customerId: null,
        dueDays: null,
        additionalPayments: [],
      }),
    ).toContain('deliver_order.v1');
    expect(
      canonicalizeCancelOrderRequest({ orderId: ORD_ID, reason: 'Customer cancelled' }),
    ).toContain('cancel_order.v1');
  });

  it('property test (300 runs, O3): evaluated order lines always sum to totalFinal with non-negative pro-rata manual discount and exact VAT', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            priceTiyin: fc.integer({ min: 100, max: 100_000 }),
            unit: fc.constantFrom<'dona' | 'kg'>('dona', 'kg'),
            wholeUnits: fc.integer({ min: 1, max: 5 }),
            kgMilli: fc.integer({ min: 250, max: 5_000 }),
            vatBp: fc.constantFrom(0, 1200, 1500),
          }),
          { minLength: 1, maxLength: 8 },
        ),
        fc.integer({ min: 0, max: 50_000 }),
        (specs, reqDiscountInt) => {
          const lines: OrderDraftLineInput[] = specs.map((s, idx) => ({
            id: mkId(200 + idx),
            lineKind: 'quick_sale',
            productId: null,
            variantId: null,
            categoryId: null,
            name: `Item ${String(idx)}`,
            unit: s.unit,
            qty: quantityFromMilli(
              s.unit === 'dona' ? BigInt(s.wholeUnits) * 1_000n : BigInt(s.kgMilli),
            ),
            unitPriceSnapshot: moneyFromTiyin(BigInt(s.priceTiyin)),
            vatRate: vatRateFromBasisPoints(BigInt(s.vatBp)),
            mxikSnapshot: null,
            packageCodeSnapshot: null,
            vatRateBpSnapshot: s.vatBp,
          }));

          const res = evaluateOrderDraft({
            storeId: STORE_ID,
            nowMs: T0,
            lines,
            promotions: [],
            manualDiscount: {
              mode: reqDiscountInt > 0 ? 'amount' : 'none',
              percentBp: 0n,
              amount: moneyFromTiyin(BigInt(reqDiscountInt)),
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

          const sumLineFinal = res.lines.reduce((acc, l) => acc + moneyToTiyin(l.finalTotal), 0n);
          const sumLineDisc = res.lines.reduce(
            (acc, l) => acc + moneyToTiyin(l.allocatedOrderDiscount),
            0n,
          );
          const sumNet = res.lines.reduce((acc, l) => acc + moneyToTiyin(l.netExVat), 0n);
          const sumVat = res.lines.reduce((acc, l) => acc + moneyToTiyin(l.vatTotal), 0n);

          expect(sumLineFinal).toBe(moneyToTiyin(res.totalFinal));
          expect(sumLineDisc).toBe(moneyToTiyin(res.effectiveOrderDiscount));
          expect(sumNet + sumVat).toBe(sumLineFinal);
          for (const l of res.lines) {
            expect(moneyToTiyin(l.finalTotal)).toBeGreaterThanOrEqual(0n);
          }
        },
      ),
      { numRuns: 300 },
    );
  });

  it('property test (300 runs, O4): openAdvances === totalIn - totalRefunded - totalAppliedAtDelivery across random lifecycles', () => {
    const methodArb = fc.constantFrom<PaymentMethod>(...PAYMENT_METHODS);

    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            totalTiyin: fc.integer({ min: 1_000, max: 200_000 }),
            deposits: fc.array(
              fc.record({ method: methodArb, amount: fc.integer({ min: 1, max: 50_000 }) }),
              { minLength: 0, maxLength: 5 },
            ),
            partialRefundFractionPct: fc.integer({ min: 0, max: 50 }),
            outcome: fc.constantFrom<OrderStatus>(
              'draft',
              'confirmed',
              'ready',
              'delivered',
              'cancelled',
            ),
          }),
          { minLength: 1, maxLength: 15 },
        ),
        (orders) => {
          const entries: Array<{
            orderStatus: OrderStatus;
            kind: 'advance' | 'advance_refund';
            method: PaymentMethod;
            amount: ReturnType<typeof moneyFromTiyin>;
          }> = [];

          const expectedByMethod = createEmptyPaymentMethodMap();
          const expectedMethodTiyin = new Map<PaymentMethod, bigint>();
          let totalIn = 0n;
          let totalRefund = 0n;
          let totalApplied = 0n;

          for (const spec of orders) {
            const total = BigInt(spec.totalTiyin);
            let orderNet = 0n;
            const orderMethodNet = new Map<PaymentMethod, bigint>();

            const effectiveStatus: OrderStatus =
              spec.outcome === 'draft' && spec.deposits.length > 0 ? 'confirmed' : spec.outcome;

            const orderEntries: Array<{
              kind: 'advance' | 'advance_refund';
              method: PaymentMethod;
              amountTiyin: bigint;
            }> = [];

            for (const dep of spec.deposits) {
              const take =
                orderNet + BigInt(dep.amount) > total ? total - orderNet : BigInt(dep.amount);
              if (take <= 0n) continue;
              orderNet += take;
              orderMethodNet.set(dep.method, (orderMethodNet.get(dep.method) ?? 0n) + take);
              orderEntries.push({ kind: 'advance', method: dep.method, amountTiyin: take });
              totalIn += take;
            }

            if (spec.partialRefundFractionPct > 0) {
              for (const m of PAYMENT_METHODS) {
                const avail = orderMethodNet.get(m) ?? 0n;
                const ref = (avail * BigInt(spec.partialRefundFractionPct)) / 100n;
                if (ref > 0n) {
                  orderNet -= ref;
                  orderMethodNet.set(m, avail - ref);
                  orderEntries.push({ kind: 'advance_refund', method: m, amountTiyin: ref });
                  totalRefund += ref;
                }
              }
            }

            if (effectiveStatus === 'cancelled') {
              for (const m of PAYMENT_METHODS) {
                const avail = orderMethodNet.get(m) ?? 0n;
                if (avail > 0n) {
                  orderNet -= avail;
                  orderMethodNet.set(m, 0n);
                  orderEntries.push({ kind: 'advance_refund', method: m, amountTiyin: avail });
                  totalRefund += avail;
                }
              }
            } else if (effectiveStatus === 'delivered') {
              totalApplied += orderNet;
            } else {
              for (const m of PAYMENT_METHODS) {
                expectedMethodTiyin.set(
                  m,
                  (expectedMethodTiyin.get(m) ?? 0n) + (orderMethodNet.get(m) ?? 0n),
                );
              }
            }

            for (const e of orderEntries) {
              entries.push({
                orderStatus: effectiveStatus,
                kind: e.kind,
                method: e.method,
                amount: moneyFromTiyin(e.amountTiyin),
              });
            }
          }

          for (const m of PAYMENT_METHODS) {
            expectedByMethod[m] = moneyFromTiyin(expectedMethodTiyin.get(m) ?? 0n);
          }

          const summary = computeOpenAdvancesAccounting(entries);
          expect(moneyToTiyin(summary.totalAdvanceIn)).toBe(totalIn);
          expect(moneyToTiyin(summary.totalAdvanceRefunded)).toBe(totalRefund);
          expect(moneyToTiyin(summary.totalAdvanceAppliedAtDelivery)).toBe(totalApplied);
          expect(moneyToTiyin(summary.totalOpenAdvance)).toBe(totalIn - totalRefund - totalApplied);
          expect(summary.byMethod).toEqual(expectedByMethod);
        },
      ),
      { numRuns: 300 },
    );
  });
});
