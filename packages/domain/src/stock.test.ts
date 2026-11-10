import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  DomainError,
  type Money,
  ZERO_MONEY,
  applyReplayStockMove,
  computeProportionalCost,
  computeSurplusCostValue,
  createEmptyStockPoolState,
  moneyFromTiyin,
  moneyToTiyin,
  parseUuidV7,
  planAverageOutboundCost,
  planFifoOutboundLegs,
  quantityFromMilli,
  quantityToMilli,
  validateStockMoveDirection,
} from './index.js';

const PROD_ID = parseUuidV7('01950000-0000-7000-8000-000000000001');

function mkId(seq: number) {
  return parseUuidV7(`01950000-0000-7000-8000-${String(seq).padStart(12, '0')}`);
}

describe('@mezon/domain - stock costing (FIFO, average, value remainder, negative & replay)', () => {
  it('worked example #1: FIFO negative stock unbatched deficit and later closing receipt without losing 1 tiyin', () => {
    const state = createEmptyStockPoolState();
    const bA = mkId(10);
    const bB = mkId(11);

    // 1. Batch A inbound: +2 dona @ 20,000 tiyin (10,000/unit)
    applyReplayStockMove(state, {
      moveId: mkId(1),
      productId: PROD_ID,
      variantId: null,
      batchId: bA,
      hlc: '001',
      reason: 'purchase',
      qtyDelta: quantityFromMilli(2_000n),
      costValueDelta: moneyFromTiyin(20_000n),
      trackBatches: true,
    });
    expect(state.qtyOnHand).toBe(quantityFromMilli(2_000n));
    expect(state.totalValue).toBe(moneyFromTiyin(20_000n));

    // 2. Outbound 5 dona under warn policy: drains Batch A (20,000), creates 3 dona unbatched deficit (30,000)
    const plan = planFifoOutboundLegs({
      batches: [
        {
          batchId: bA,
          hlc: '001',
          remainingQty: quantityFromMilli(2_000n),
          remainingValue: moneyFromTiyin(20_000n),
        },
      ],
      needQty: quantityFromMilli(5_000n),
      lastUnitCost: state.lastUnitCost,
      negativePolicy: 'warn',
    });
    expect(plan.negativeStockWarning).toBe(true);
    expect(plan.totalCostValue).toBe(moneyFromTiyin(50_000n));
    expect(plan.legs).toHaveLength(2);
    expect(plan.legs[0]).toMatchObject({
      batchId: bA,
      qty: quantityFromMilli(2_000n),
      costValue: moneyFromTiyin(20_000n),
    });
    expect(plan.legs[1]).toMatchObject({
      batchId: null,
      qty: quantityFromMilli(3_000n),
      costValue: moneyFromTiyin(30_000n),
    });

    let seq = 2;
    for (const leg of plan.legs) {
      applyReplayStockMove(state, {
        moveId: mkId(seq++),
        productId: PROD_ID,
        variantId: null,
        batchId: leg.batchId,
        hlc: `00${seq}`,
        reason: 'sale',
        qtyDelta: quantityFromMilli(-quantityToMilli(leg.qty)),
        costValueDelta: moneyFromTiyin(-moneyToTiyin(leg.costValue)),
        trackBatches: true,
      });
    }
    expect(state.qtyOnHand).toBe(quantityFromMilli(-3_000n));
    expect(state.deficitQty).toBe(quantityFromMilli(3_000n));
    expect(state.provisionalDeficitValue).toBe(moneyFromTiyin(30_000n));
    expect(state.totalValue).toBe(ZERO_MONEY);

    // 3. Batch B inbound: +5 dona @ 60,000 tiyin (12,000/unit) closes 3 deficit @ 36,000, leaves 2 @ 24,000, variance = +6,000
    applyReplayStockMove(state, {
      moveId: mkId(100),
      productId: PROD_ID,
      variantId: null,
      batchId: bB,
      hlc: '010',
      reason: 'purchase',
      qtyDelta: quantityFromMilli(5_000n),
      costValueDelta: moneyFromTiyin(60_000n),
      trackBatches: true,
    });
    expect(state.qtyOnHand).toBe(quantityFromMilli(2_000n));
    expect(state.deficitQty).toBe(quantityFromMilli(0n));
    expect(state.provisionalDeficitValue).toBe(ZERO_MONEY);
    expect(state.totalValue).toBe(moneyFromTiyin(24_000n));
    expect(state.costVarianceValue).toBe(moneyFromTiyin(6_000n));
    expect(state.batches.get(bB)?.remainingQty).toBe(quantityFromMilli(2_000n));
    expect(state.batches.get(bB)?.remainingValue).toBe(moneyFromTiyin(24_000n));
    // Exact check: in (80,000) === out (50,000) + rem (24,000) + var (6,000)
    expect(20_000n + 60_000n).toBe(
      50_000n + moneyToTiyin(state.totalValue) + moneyToTiyin(state.costVarianceValue),
    );
  });

  it('worked example #2: indivisible 10,000 / 3 weighted average cost drains 3,333 then exact remainder 6,667', () => {
    const state = createEmptyStockPoolState();

    // +3 kg @ 10,000 tiyin
    applyReplayStockMove(state, {
      moveId: mkId(1),
      productId: PROD_ID,
      variantId: null,
      batchId: null,
      hlc: '001',
      reason: 'initial',
      qtyDelta: quantityFromMilli(3_000n),
      costValueDelta: moneyFromTiyin(10_000n),
      trackBatches: false,
    });

    // -1 kg -> round(10,000 * 1 / 3) = 3,333
    const out1 = planAverageOutboundCost({
      qtyOnHand: state.qtyOnHand,
      totalValue: state.totalValue,
      lastUnitCost: state.lastUnitCost,
      needQty: quantityFromMilli(1_000n),
      negativePolicy: 'block',
    });
    expect(out1.costValue).toBe(moneyFromTiyin(3_333n));

    applyReplayStockMove(state, {
      moveId: mkId(2),
      productId: PROD_ID,
      variantId: null,
      batchId: null,
      hlc: '002',
      reason: 'sale',
      qtyDelta: quantityFromMilli(-1_000n),
      costValueDelta: moneyFromTiyin(-3_333n),
      trackBatches: false,
    });
    expect(state.qtyOnHand).toBe(quantityFromMilli(2_000n));
    expect(state.totalValue).toBe(moneyFromTiyin(6_667n));

    // -2 kg -> takes ALL remaining 6,667 tiyin cleanly (no 1 tiyin left behind)
    const out2 = planAverageOutboundCost({
      qtyOnHand: state.qtyOnHand,
      totalValue: state.totalValue,
      lastUnitCost: state.lastUnitCost,
      needQty: quantityFromMilli(2_000n),
      negativePolicy: 'block',
    });
    expect(out2.costValue).toBe(moneyFromTiyin(6_667n));

    applyReplayStockMove(state, {
      moveId: mkId(3),
      productId: PROD_ID,
      variantId: null,
      batchId: null,
      hlc: '003',
      reason: 'sale',
      qtyDelta: quantityFromMilli(-2_000n),
      costValueDelta: moneyFromTiyin(-6_667n),
      trackBatches: false,
    });
    expect(state.qtyOnHand).toBe(quantityFromMilli(0n));
    expect(state.totalValue).toBe(ZERO_MONEY);
    expect(state.costVarianceValue).toBe(ZERO_MONEY);
  });

  it('S4: computes surplus inventory cost by mode and flags unknown cost cleanly', () => {
    expect(
      computeSurplusCostValue({
        trackBatches: false,
        adjustmentQty: quantityFromMilli(2_000n),
        qtyOnHand: quantityFromMilli(4_000n),
        totalValue: moneyFromTiyin(20_000n),
        lastUnitCost: moneyFromTiyin(9_000n),
      }),
    ).toEqual({ costValue: moneyFromTiyin(10_000n), costUnknown: false });

    expect(
      computeSurplusCostValue({
        trackBatches: true,
        adjustmentQty: quantityFromMilli(2_500n),
        qtyOnHand: quantityFromMilli(4_000n),
        totalValue: moneyFromTiyin(20_000n),
        lastUnitCost: moneyFromTiyin(8_000n),
      }),
    ).toEqual({ costValue: moneyFromTiyin(20_000n), costUnknown: false });

    expect(
      computeSurplusCostValue({
        trackBatches: true,
        adjustmentQty: quantityFromMilli(3_000n),
        qtyOnHand: quantityFromMilli(0n),
        totalValue: ZERO_MONEY,
        lastUnitCost: null,
      }),
    ).toEqual({ costValue: ZERO_MONEY, costUnknown: true });
  });

  it('validates direction reasons and block-policy insufficient stock rejection', () => {
    validateStockMoveDirection('purchase', 'in');
    validateStockMoveDirection('damaged', 'out');
    expect(() => validateStockMoveDirection('damaged', 'in')).toThrow(DomainError);
    expect(() => validateStockMoveDirection('purchase', 'out')).toThrow(DomainError);

    expect(() =>
      planFifoOutboundLegs({
        batches: [],
        needQty: quantityFromMilli(1_000n),
        lastUnitCost: null,
        negativePolicy: 'block',
      }),
    ).toThrowError(/INSUFFICIENT_STOCK/);

    expect(() =>
      planAverageOutboundCost({
        qtyOnHand: quantityFromMilli(500n),
        totalValue: moneyFromTiyin(1_000n),
        lastUnitCost: null,
        needQty: quantityFromMilli(1_000n),
        negativePolicy: 'block',
      }),
    ).toThrowError(/INSUFFICIENT_STOCK/);

    expect(
      computeProportionalCost(
        moneyFromTiyin(10_001n),
        quantityFromMilli(3_000n),
        quantityFromMilli(3_000n),
      ),
    ).toBe(moneyFromTiyin(10_001n));
  });

  it('property test: inbound = outbound + remaining + variance - provisional holds to exact tiyin across random sequences', () => {
    type SimStep =
      | { readonly kind: 'in'; readonly qtyMilli: bigint; readonly costTiyin: bigint }
      | { readonly kind: 'out'; readonly qtyMilli: bigint; readonly allowNegative: boolean };

    const stepArb: fc.Arbitrary<SimStep> = fc.oneof(
      fc.record({
        kind: fc.constant('in' as const),
        qtyMilli: fc.bigInt({ min: 1n, max: 50_000n }),
        costTiyin: fc.bigInt({ min: 0n, max: 5_000_000n }),
      }),
      fc.record({
        kind: fc.constant('out' as const),
        qtyMilli: fc.bigInt({ min: 1n, max: 50_000n }),
        allowNegative: fc.boolean(),
      }),
    );

    fc.assert(
      fc.property(
        fc.boolean(), // trackBatches
        fc.array(stepArb, { minLength: 1, maxLength: 40 }),
        (trackBatches, steps) => {
          const state = createEmptyStockPoolState();
          let sumInTiyin = 0n;
          let sumOutTiyin = 0n;
          let moveSeq = 1;
          let batchSeq = 1;
          let hadNegative = false;

          for (const step of steps) {
            const qty = quantityFromMilli(step.qtyMilli);
            if (step.kind === 'in') {
              const cost = moneyFromTiyin(step.costTiyin);
              const batchId = trackBatches ? mkId(10_000 + batchSeq++) : null;
              sumInTiyin += step.costTiyin;
              applyReplayStockMove(state, {
                moveId: mkId(moveSeq++),
                productId: PROD_ID,
                variantId: null,
                batchId,
                hlc: String(moveSeq).padStart(6, '0'),
                reason: 'purchase',
                qtyDelta: qty,
                costValueDelta: cost,
                trackBatches,
              });
            } else if (trackBatches) {
              const orderedBatches = [...state.batches.values()]
                .filter((b) => quantityToMilli(b.remainingQty) > 0n)
                .sort((a, b) => (a.hlc < b.hlc ? -1 : a.hlc > b.hlc ? 1 : 0));
              const totalAvail = orderedBatches.reduce(
                (acc, b) => acc + quantityToMilli(b.remainingQty),
                0n,
              );
              if (totalAvail < step.qtyMilli && !step.allowNegative) {
                continue;
              }
              const plan = planFifoOutboundLegs({
                batches: orderedBatches,
                needQty: qty,
                lastUnitCost: state.lastUnitCost,
                negativePolicy: step.allowNegative ? 'warn' : 'block',
              });
              if (plan.negativeStockWarning) {
                hadNegative = true;
              }
              for (const leg of plan.legs) {
                sumOutTiyin += moneyToTiyin(leg.costValue);
                applyReplayStockMove(state, {
                  moveId: mkId(moveSeq++),
                  productId: PROD_ID,
                  variantId: null,
                  batchId: leg.batchId,
                  hlc: String(moveSeq).padStart(6, '0'),
                  reason: 'sale',
                  qtyDelta: quantityFromMilli(-quantityToMilli(leg.qty)),
                  costValueDelta: moneyFromTiyin(-moneyToTiyin(leg.costValue)),
                  trackBatches: true,
                });
              }
            } else {
              const onHand = quantityToMilli(state.qtyOnHand);
              if (onHand < step.qtyMilli && !step.allowNegative) {
                continue;
              }
              const out = planAverageOutboundCost({
                qtyOnHand: state.qtyOnHand,
                totalValue: state.totalValue,
                lastUnitCost: state.lastUnitCost,
                needQty: qty,
                negativePolicy: step.allowNegative ? 'warn' : 'block',
              });
              if (out.negativeStockWarning) {
                hadNegative = true;
              }
              sumOutTiyin += moneyToTiyin(out.costValue);
              applyReplayStockMove(state, {
                moveId: mkId(moveSeq++),
                productId: PROD_ID,
                variantId: null,
                batchId: null,
                hlc: String(moveSeq).padStart(6, '0'),
                reason: 'sale',
                qtyDelta: quantityFromMilli(-step.qtyMilli),
                costValueDelta: moneyFromTiyin(-moneyToTiyin(out.costValue)),
                trackBatches: false,
              });
            }

            // Double-entry invariant at EVERY step
            const lhs = sumInTiyin;
            const rhs =
              sumOutTiyin +
              moneyToTiyin(state.totalValue) -
              moneyToTiyin(state.provisionalDeficitValue) +
              moneyToTiyin(state.costVarianceValue);
            expect(lhs).toBe(rhs);

            if (trackBatches) {
              const batchSumVal = [...state.batches.values()].reduce(
                (acc, b) => acc + moneyToTiyin(b.remainingValue),
                0n,
              );
              expect(moneyToTiyin(state.totalValue)).toBe(batchSumVal);
            }

            if (!hadNegative) {
              expect(state.costVarianceValue).toBe(ZERO_MONEY);
              expect(state.deficitQty).toBe(quantityFromMilli(0n));
              expect(sumInTiyin).toBe(sumOutTiyin + moneyToTiyin(state.totalValue));
            }
          }

          // Clean balance assertion when every batch/unit is fully drained at non-negative end
          expect(quantityToMilli(state.qtyOnHand) >= 0n || hadNegative).toBe(true);
          const totalBatchRemainMilli = [...state.batches.values()].reduce(
            (acc, b) => acc + quantityToMilli(b.remainingQty),
            0n,
          );
          if (trackBatches) {
            expect(quantityToMilli(state.qtyOnHand)).toBe(
              totalBatchRemainMilli - quantityToMilli(state.deficitQty),
            );
          }
          const unusedBatchVal: Money = state.totalValue;
          expect(moneyToTiyin(unusedBatchVal) >= 0n).toBe(true);
        },
      ),
      { numRuns: 200 },
    );
  });

  it('T1.2 test debt: rounds up 10,000 / 3 * 2 = 6,667 and drains remBatchMilli === needMilli without conflict', () => {
    // 1) computeProportionalCost upward rounding check (caught if integer truncation is used)
    expect(
      computeProportionalCost(
        moneyFromTiyin(10_000n),
        quantityFromMilli(3_000n),
        quantityFromMilli(2_000n),
      ),
    ).toBe(moneyFromTiyin(6_667n));
    expect(
      computeProportionalCost(
        moneyFromTiyin(5n),
        quantityFromMilli(2_000n),
        quantityFromMilli(1_000n),
      ),
    ).toBe(moneyFromTiyin(3n));

    // 2) applyReplayStockMove exact boundary remBatchMilli === needMilli (caught if >= becomes >)
    const state = createEmptyStockPoolState();
    const bExact = mkId(99);
    const inConflicts = applyReplayStockMove(state, {
      moveId: mkId(100),
      productId: PROD_ID,
      variantId: null,
      batchId: bExact,
      hlc: '001',
      reason: 'purchase',
      qtyDelta: quantityFromMilli(3_000n),
      costValueDelta: moneyFromTiyin(10_000n),
      trackBatches: true,
    });
    expect(inConflicts).toEqual([]);

    const outConflicts = applyReplayStockMove(state, {
      moveId: mkId(101),
      productId: PROD_ID,
      variantId: null,
      batchId: bExact,
      hlc: '002',
      reason: 'sale',
      qtyDelta: quantityFromMilli(-3_000n),
      costValueDelta: moneyFromTiyin(-10_000n),
      trackBatches: true,
    });
    expect(outConflicts).toEqual([]);
    expect(state.batches.get(bExact)?.remainingQty).toBe(quantityFromMilli(0n));
    expect(state.batches.get(bExact)?.remainingValue).toBe(ZERO_MONEY);
    expect(state.qtyOnHand).toBe(quantityFromMilli(0n));
    expect(state.totalValue).toBe(ZERO_MONEY);
    expect(state.deficitQty).toBe(quantityFromMilli(0n));
    expect(state.costVarianceValue).toBe(ZERO_MONEY);
  });
});
