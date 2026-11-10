import { type ProductUnit, validateQuantityForUnit } from './catalog.js';
import { DomainError } from './errors.js';
import { type Money, ZERO_MONEY, moneyFromTiyin, moneyToTiyin } from './money.js';
import { type Quantity, ZERO_QUANTITY, quantityFromMilli, quantityToMilli } from './quantity.js';
import { divideRoundHalfAwayFromZero, multiply } from './rounding.js';
import type { UuidV7 } from './uuidv7.js';

export const STOCK_MOVE_REASONS = [
  'initial',
  'purchase',
  'sale',
  'return',
  'inventory',
  'adjustment',
  'damaged',
  'broken',
  'personal',
  'lost',
] as const;
export type StockMoveReason = (typeof STOCK_MOVE_REASONS)[number];

export const INBOUND_STOCK_REASONS = [
  'initial',
  'purchase',
  'return',
  'inventory',
  'adjustment',
] as const;
export const OUTBOUND_STOCK_REASONS = [
  'sale',
  'inventory',
  'adjustment',
  'damaged',
  'broken',
  'personal',
  'lost',
] as const;

export const NEGATIVE_STOCK_POLICIES = ['warn', 'block'] as const;
export type NegativeStockPolicy = (typeof NEGATIVE_STOCK_POLICIES)[number];

export const STOCK_SOURCE_TYPES = [
  'stock_entry',
  'inventory_count',
  'sale',
  'return',
  'purchase',
  'adjustment',
] as const;
export type StockSourceType = (typeof STOCK_SOURCE_TYPES)[number];

export const INVENTORY_COUNT_STATUSES = ['open', 'finalized', 'cancelled'] as const;
export type InventoryCountStatus = (typeof INVENTORY_COUNT_STATUSES)[number];

export const STOCK_CONFLICT_REASONS = [
  'BATCH_OVERCONSUMED',
  'UNKNOWN_COST_SURPLUS',
  'ORPHAN_BATCH_REFERENCE',
] as const;
export type StockConflictReason = (typeof STOCK_CONFLICT_REASONS)[number];

export function isStockMoveReason(value: unknown): value is StockMoveReason {
  return typeof value === 'string' && (STOCK_MOVE_REASONS as readonly string[]).includes(value);
}

export function parseStockMoveReason(value: unknown): StockMoveReason {
  if (!isStockMoveReason(value)) {
    throw new DomainError(
      'INVALID_STOCK_MOVE_REASON',
      `Stock move reason must be one of: ${STOCK_MOVE_REASONS.join(', ')}`,
    );
  }
  return value;
}

export function isNegativeStockPolicy(value: unknown): value is NegativeStockPolicy {
  return (
    typeof value === 'string' && (NEGATIVE_STOCK_POLICIES as readonly string[]).includes(value)
  );
}

export function parseNegativeStockPolicy(value: unknown): NegativeStockPolicy {
  if (!isNegativeStockPolicy(value)) {
    throw new DomainError(
      'VALIDATION_ERROR',
      `Negative stock policy must be one of: ${NEGATIVE_STOCK_POLICIES.join(', ')}`,
    );
  }
  return value;
}

export function validateStockMoveDirection(reason: StockMoveReason, direction: 'in' | 'out'): void {
  const validReason = parseStockMoveReason(reason);
  if (direction === 'in') {
    if (!(INBOUND_STOCK_REASONS as readonly string[]).includes(validReason)) {
      throw new DomainError(
        'INVALID_STOCK_MOVE_REASON',
        `Reason "${validReason}" is not valid for inbound stock moves`,
      );
    }
    return;
  }
  if (!(OUTBOUND_STOCK_REASONS as readonly string[]).includes(validReason)) {
    throw new DomainError(
      'INVALID_STOCK_MOVE_REASON',
      `Reason "${validReason}" is not valid for outbound stock moves`,
    );
  }
}

export function validatePositiveStockQuantity(unit: ProductUnit, quantity: Quantity): Quantity {
  return validateQuantityForUnit(unit, quantity, { allowZero: false });
}

export function validateNonNegativeCountQuantity(unit: ProductUnit, quantity: Quantity): Quantity {
  return validateQuantityForUnit(unit, quantity, { allowZero: true });
}

/**
 * Computes exact proportional cost value using `remaining_value * take_qty / remaining_qty`
 * (round-half-away-from-zero). When `take_qty === remaining_qty`, returns the entire
 * `remaining_value` so zero rounding remainder is ever lost.
 */
export function computeProportionalCost(
  remainingValue: Money,
  remainingQty: Quantity,
  takeQty: Quantity,
): Money {
  const remVal = moneyToTiyin(remainingValue);
  const remMilli = quantityToMilli(remainingQty);
  const takeMilli = quantityToMilli(takeQty);

  if (remMilli <= 0n) {
    throw new DomainError('INVALID_UNIT_QUANTITY', 'Remaining quantity must be positive');
  }
  if (takeMilli <= 0n || takeMilli > remMilli) {
    throw new DomainError(
      'INVALID_UNIT_QUANTITY',
      'Allocated quantity must be in (0, remainingQty]',
    );
  }
  if (remVal < 0n) {
    throw new DomainError('VALIDATION_ERROR', 'Remaining cost value must not be negative');
  }
  if (takeMilli === remMilli) {
    return remainingValue;
  }
  return moneyFromTiyin(divideRoundHalfAwayFromZero(remVal * takeMilli, remMilli));
}

export function computeUnitCostFromTotals(totalValue: Money, totalQty: Quantity): Money {
  const val = moneyToTiyin(totalValue);
  const qtyMilli = quantityToMilli(totalQty);
  if (qtyMilli <= 0n) {
    throw new DomainError('INVALID_UNIT_QUANTITY', 'Total quantity must be positive');
  }
  if (val < 0n) {
    throw new DomainError('VALIDATION_ERROR', 'Total value must not be negative');
  }
  return moneyFromTiyin(divideRoundHalfAwayFromZero(val * 1000n, qtyMilli));
}

export interface SurplusCostResult {
  readonly costValue: Money;
  readonly costUnknown: boolean;
}

/**
 * Determines cost value for positive inventory count adjustments (`S4`):
 * - Average-cost products with positive stock use current average pool valuation (`totalValue / qtyOnHand`).
 * - Otherwise (and for all FIFO products) uses `lastUnitCost * adjustmentQty` when known.
 * - If no prior cost exists, assigns `0n` and sets `costUnknown: true` so the caller logs a conflict.
 */
export function computeSurplusCostValue(params: {
  readonly trackBatches: boolean;
  readonly adjustmentQty: Quantity;
  readonly qtyOnHand: Quantity;
  readonly totalValue: Money;
  readonly lastUnitCost: Money | null;
}): SurplusCostResult {
  const adjMilli = quantityToMilli(params.adjustmentQty);
  if (adjMilli <= 0n) {
    throw new DomainError('INVALID_UNIT_QUANTITY', 'Surplus adjustment quantity must be positive');
  }

  const onHandMilli = quantityToMilli(params.qtyOnHand);
  if (
    !params.trackBatches &&
    onHandMilli > 0n &&
    (moneyToTiyin(params.totalValue) > 0n || params.lastUnitCost !== null)
  ) {
    const val = moneyToTiyin(params.totalValue);
    return {
      costValue: moneyFromTiyin(divideRoundHalfAwayFromZero(val * adjMilli, onHandMilli)),
      costUnknown: false,
    };
  }

  if (params.lastUnitCost !== null) {
    return {
      costValue: multiply(params.lastUnitCost, params.adjustmentQty),
      costUnknown: false,
    };
  }

  return {
    costValue: ZERO_MONEY,
    costUnknown: true,
  };
}

export interface FifoBatchCandidate {
  readonly batchId: UuidV7;
  readonly hlc: string;
  readonly remainingQty: Quantity;
  readonly remainingValue: Money;
}

export interface OutboundAllocationLeg {
  readonly batchId: UuidV7 | null;
  readonly qty: Quantity;
  readonly costValue: Money;
  readonly isDeficit: boolean;
}

export interface OutboundAllocationPlan {
  readonly legs: readonly OutboundAllocationLeg[];
  readonly totalCostValue: Money;
  readonly negativeStockWarning: boolean;
  readonly deficitQty: Quantity;
}

/**
 * Plans exact FIFO outbound legs ordered chronologically by batch slice without losing tiyin.
 * When `needQty > totalAvailable`:
 * - `'block'` throws `INSUFFICIENT_STOCK`
 * - `'warn'` drains all active batches to zero, creates an unbatched deficit leg (`batchId: null`)
 *   valued provisionally at `lastUnitCost`, and sets `negativeStockWarning: true`.
 */
export function planFifoOutboundLegs(params: {
  readonly batches: readonly FifoBatchCandidate[];
  readonly needQty: Quantity;
  readonly lastUnitCost: Money | null;
  readonly negativePolicy: NegativeStockPolicy;
}): OutboundAllocationPlan {
  const needMilli = quantityToMilli(params.needQty);
  if (needMilli <= 0n) {
    throw new DomainError('INVALID_UNIT_QUANTITY', 'Outbound quantity must be positive');
  }

  let totalAvailMilli = 0n;
  for (const b of params.batches) {
    const q = quantityToMilli(b.remainingQty);
    if (q > 0n) {
      totalAvailMilli += q;
    }
  }

  if (totalAvailMilli < needMilli && params.negativePolicy === 'block') {
    throw new DomainError(
      'INSUFFICIENT_STOCK',
      'Available batch quantity is smaller than requested outbound quantity',
    );
  }

  const legs: OutboundAllocationLeg[] = [];
  let remainingNeedMilli = needMilli;
  let totalCostTiyin = 0n;

  for (const b of params.batches) {
    if (remainingNeedMilli === 0n) {
      break;
    }
    const batchMilli = quantityToMilli(b.remainingQty);
    if (batchMilli <= 0n) {
      continue;
    }
    const takeMilli = remainingNeedMilli <= batchMilli ? remainingNeedMilli : batchMilli;
    const takeQty = quantityFromMilli(takeMilli);
    const takeCost = computeProportionalCost(b.remainingValue, b.remainingQty, takeQty);

    legs.push({
      batchId: b.batchId,
      qty: takeQty,
      costValue: takeCost,
      isDeficit: false,
    });
    totalCostTiyin += moneyToTiyin(takeCost);
    remainingNeedMilli -= takeMilli;
  }

  let deficitQty = ZERO_QUANTITY;
  let negativeStockWarning = false;

  if (remainingNeedMilli > 0n) {
    negativeStockWarning = true;
    deficitQty = quantityFromMilli(remainingNeedMilli);
    const provCost =
      params.lastUnitCost !== null ? multiply(params.lastUnitCost, deficitQty) : ZERO_MONEY;
    legs.push({
      batchId: null,
      qty: deficitQty,
      costValue: provCost,
      isDeficit: true,
    });
    totalCostTiyin += moneyToTiyin(provCost);
  }

  return {
    legs,
    totalCostValue: moneyFromTiyin(totalCostTiyin),
    negativeStockWarning,
    deficitQty,
  };
}

/**
 * Plans exact weighted-average outbound cost for non-batched products (`trackBatches = false`).
 */
export function planAverageOutboundCost(params: {
  readonly qtyOnHand: Quantity;
  readonly totalValue: Money;
  readonly lastUnitCost: Money | null;
  readonly needQty: Quantity;
  readonly negativePolicy: NegativeStockPolicy;
}): {
  readonly costValue: Money;
  readonly negativeStockWarning: boolean;
  readonly deficitQty: Quantity;
} {
  const needMilli = quantityToMilli(params.needQty);
  if (needMilli <= 0n) {
    throw new DomainError('INVALID_UNIT_QUANTITY', 'Outbound quantity must be positive');
  }

  const onHandMilli = quantityToMilli(params.qtyOnHand);
  const availMilli = onHandMilli > 0n ? onHandMilli : 0n;

  if (availMilli < needMilli && params.negativePolicy === 'block') {
    throw new DomainError(
      'INSUFFICIENT_STOCK',
      'Available stock quantity is smaller than requested outbound quantity',
    );
  }

  if (needMilli <= availMilli) {
    return {
      costValue: computeProportionalCost(
        params.totalValue,
        quantityFromMilli(availMilli),
        params.needQty,
      ),
      negativeStockWarning: false,
      deficitQty: ZERO_QUANTITY,
    };
  }

  // Consumes all positive remaining value first, plus provisional estimate for deficit portion
  const posCostTiyin = availMilli > 0n ? moneyToTiyin(params.totalValue) : 0n;
  const defMilli = needMilli - availMilli;
  const deficitQty = quantityFromMilli(defMilli);
  const provDefCost =
    params.lastUnitCost !== null ? multiply(params.lastUnitCost, deficitQty) : ZERO_MONEY;

  return {
    costValue: moneyFromTiyin(posCostTiyin + moneyToTiyin(provDefCost)),
    negativeStockWarning: true,
    deficitQty,
  };
}

// --- Pure deterministic replay state machine (shared by domain property tests & db-local rebuild) ---

export interface ReplayBatchState {
  readonly batchId: UuidV7;
  readonly hlc: string;
  remainingQty: Quantity;
  remainingValue: Money;
}

export interface ReplayStockPoolState {
  qtyOnHand: Quantity;
  totalValue: Money;
  deficitQty: Quantity;
  provisionalDeficitValue: Money;
  costVarianceValue: Money;
  lastUnitCost: Money | null;
  readonly batches: Map<UuidV7, ReplayBatchState>;
}

export interface ReplayStockConflict {
  readonly productId: UuidV7;
  readonly variantId: UuidV7 | null;
  readonly batchId: UuidV7 | null;
  readonly moveId: UuidV7;
  readonly conflictQty: Quantity;
  readonly reason: StockConflictReason;
}

export interface ReplayStockMoveEvent {
  readonly moveId: UuidV7;
  readonly productId: UuidV7;
  readonly variantId: UuidV7 | null;
  readonly batchId: UuidV7 | null;
  readonly hlc: string;
  readonly reason: StockMoveReason;
  readonly qtyDelta: Quantity;
  readonly costValueDelta: Money;
  readonly trackBatches: boolean;
}

export function createEmptyStockPoolState(): ReplayStockPoolState {
  return {
    qtyOnHand: ZERO_QUANTITY,
    totalValue: ZERO_MONEY,
    deficitQty: ZERO_QUANTITY,
    provisionalDeficitValue: ZERO_MONEY,
    costVarianceValue: ZERO_MONEY,
    lastUnitCost: null,
    batches: new Map<UuidV7, ReplayBatchState>(),
  };
}

/**
 * Deterministically applies one FACT `stock_move` onto a mutable pool projection state without ever
 * failing on negative stock or over-consumed batch allocations (`S2`), returning any generated
 * owner conflict records. Satisfies the double-entry identity at every single step:
 * `SUM(inboundCost) === SUM(outboundCost) + totalValue - provisionalDeficitValue + costVarianceValue`.
 */
export function applyReplayStockMove(
  state: ReplayStockPoolState,
  move: ReplayStockMoveEvent,
): readonly ReplayStockConflict[] {
  const conflicts: ReplayStockConflict[] = [];
  const qtyMilli = quantityToMilli(move.qtyDelta);
  const valTiyin = moneyToTiyin(move.costValueDelta);

  if (qtyMilli === 0n) {
    return conflicts;
  }

  if (qtyMilli > 0n) {
    const inQty = move.qtyDelta;
    const inVal = move.costValueDelta;

    const prevOnHandMilli = quantityToMilli(state.qtyOnHand);
    if (move.reason === 'inventory' && valTiyin === 0n && state.lastUnitCost === null) {
      conflicts.push({
        productId: move.productId,
        variantId: move.variantId,
        batchId: move.batchId,
        moveId: move.moveId,
        conflictQty: inQty,
        reason: 'UNKNOWN_COST_SURPLUS',
      });
    } else if (
      move.reason !== 'return' &&
      (valTiyin > 0n || move.reason === 'initial' || move.reason === 'purchase')
    ) {
      state.lastUnitCost = computeUnitCostFromTotals(inVal, inQty);
    }

    const defMilli = quantityToMilli(state.deficitQty);
    const coverMilli = defMilli > 0n ? (qtyMilli <= defMilli ? qtyMilli : defMilli) : 0n;
    const coverQty = quantityFromMilli(coverMilli);
    const coverVal = coverMilli > 0n ? computeProportionalCost(inVal, inQty, coverQty) : ZERO_MONEY;
    const settledProv =
      coverMilli > 0n
        ? computeProportionalCost(state.provisionalDeficitValue, state.deficitQty, coverQty)
        : ZERO_MONEY;

    const netQty = quantityFromMilli(qtyMilli - coverMilli);
    const netVal = moneyFromTiyin(valTiyin - moneyToTiyin(coverVal));

    state.deficitQty = quantityFromMilli(defMilli - coverMilli);
    state.provisionalDeficitValue = moneyFromTiyin(
      moneyToTiyin(state.provisionalDeficitValue) - moneyToTiyin(settledProv),
    );
    state.costVarianceValue = moneyFromTiyin(
      moneyToTiyin(state.costVarianceValue) + moneyToTiyin(coverVal) - moneyToTiyin(settledProv),
    );
    state.qtyOnHand = quantityFromMilli(prevOnHandMilli + qtyMilli);
    state.totalValue = moneyFromTiyin(moneyToTiyin(state.totalValue) + moneyToTiyin(netVal));

    if (move.trackBatches && move.batchId !== null) {
      const existing = state.batches.get(move.batchId);
      if (existing) {
        existing.remainingQty = quantityFromMilli(
          quantityToMilli(existing.remainingQty) + quantityToMilli(netQty),
        );
        existing.remainingValue = moneyFromTiyin(
          moneyToTiyin(existing.remainingValue) + moneyToTiyin(netVal),
        );
      } else {
        state.batches.set(move.batchId, {
          batchId: move.batchId,
          hlc: move.hlc,
          remainingQty: netQty,
          remainingValue: netVal,
        });
      }
    }

    return conflicts;
  }

  // Outbound (qtyMilli < 0n)
  const needMilli = -qtyMilli;
  const needQty = quantityFromMilli(needMilli);
  const recordedOutTiyin = -valTiyin;
  const onHandMilli = quantityToMilli(state.qtyOnHand);

  if (move.batchId !== null) {
    const batch = state.batches.get(move.batchId);
    if (!batch) {
      conflicts.push({
        productId: move.productId,
        variantId: move.variantId,
        batchId: move.batchId,
        moveId: move.moveId,
        conflictQty: needQty,
        reason: 'ORPHAN_BATCH_REFERENCE',
      });
      state.qtyOnHand = quantityFromMilli(onHandMilli - needMilli);
      state.deficitQty = quantityFromMilli(quantityToMilli(state.deficitQty) + needMilli);
      state.provisionalDeficitValue = moneyFromTiyin(
        moneyToTiyin(state.provisionalDeficitValue) + recordedOutTiyin,
      );
      return conflicts;
    }

    const remBatchMilli = quantityToMilli(batch.remainingQty);
    if (remBatchMilli >= needMilli) {
      const truePosVal = computeProportionalCost(batch.remainingValue, batch.remainingQty, needQty);
      const truePosTiyin = moneyToTiyin(truePosVal);
      batch.remainingQty = quantityFromMilli(remBatchMilli - needMilli);
      batch.remainingValue = moneyFromTiyin(moneyToTiyin(batch.remainingValue) - truePosTiyin);
      state.totalValue = moneyFromTiyin(moneyToTiyin(state.totalValue) - truePosTiyin);
      state.qtyOnHand = quantityFromMilli(onHandMilli - needMilli);
      state.costVarianceValue = moneyFromTiyin(
        moneyToTiyin(state.costVarianceValue) + truePosTiyin - recordedOutTiyin,
      );
      return conflicts;
    }

    // S2: batch over-consumed — drain positive remainder and spill overflow into deficit + log conflict
    const takePosMilli = remBatchMilli > 0n ? remBatchMilli : 0n;
    const truePosTiyin = takePosMilli > 0n ? moneyToTiyin(batch.remainingValue) : 0n;
    const overflowQty = quantityFromMilli(needMilli - takePosMilli);

    batch.remainingQty = ZERO_QUANTITY;
    batch.remainingValue = ZERO_MONEY;
    state.totalValue = moneyFromTiyin(moneyToTiyin(state.totalValue) - truePosTiyin);
    state.qtyOnHand = quantityFromMilli(onHandMilli - needMilli);
    state.deficitQty = quantityFromMilli(
      quantityToMilli(state.deficitQty) + quantityToMilli(overflowQty),
    );

    const stepProvTiyin = recordedOutTiyin > truePosTiyin ? recordedOutTiyin - truePosTiyin : 0n;
    state.provisionalDeficitValue = moneyFromTiyin(
      moneyToTiyin(state.provisionalDeficitValue) + stepProvTiyin,
    );
    state.costVarianceValue = moneyFromTiyin(
      moneyToTiyin(state.costVarianceValue) + truePosTiyin + stepProvTiyin - recordedOutTiyin,
    );

    conflicts.push({
      productId: move.productId,
      variantId: move.variantId,
      batchId: move.batchId,
      moveId: move.moveId,
      conflictQty: overflowQty,
      reason: 'BATCH_OVERCONSUMED',
    });
    return conflicts;
  }

  // Unbatched outbound (`batchId === null`): weighted average pool or pre-existing deficit leg
  if (!move.trackBatches) {
    const availMilli = onHandMilli > 0n ? onHandMilli : 0n;
    const takePosMilli = needMilli <= availMilli ? needMilli : availMilli;
    const truePosTiyin =
      takePosMilli > 0n
        ? moneyToTiyin(
            computeProportionalCost(
              state.totalValue,
              quantityFromMilli(availMilli),
              quantityFromMilli(takePosMilli),
            ),
          )
        : 0n;
    const defStepMilli = needMilli - takePosMilli;

    state.totalValue = moneyFromTiyin(moneyToTiyin(state.totalValue) - truePosTiyin);
    state.qtyOnHand = quantityFromMilli(onHandMilli - needMilli);
    state.deficitQty = quantityFromMilli(quantityToMilli(state.deficitQty) + defStepMilli);

    const stepProvTiyin =
      defStepMilli > 0n && recordedOutTiyin > truePosTiyin ? recordedOutTiyin - truePosTiyin : 0n;
    state.provisionalDeficitValue = moneyFromTiyin(
      moneyToTiyin(state.provisionalDeficitValue) + stepProvTiyin,
    );
    state.costVarianceValue = moneyFromTiyin(
      moneyToTiyin(state.costVarianceValue) + truePosTiyin + stepProvTiyin - recordedOutTiyin,
    );
    return conflicts;
  }

  // Batched product with `batchId === null` (explicit unbatched deficit outbound)
  state.qtyOnHand = quantityFromMilli(onHandMilli - needMilli);
  state.deficitQty = quantityFromMilli(quantityToMilli(state.deficitQty) + needMilli);
  state.provisionalDeficitValue = moneyFromTiyin(
    moneyToTiyin(state.provisionalDeficitValue) + recordedOutTiyin,
  );
  return conflicts;
}
