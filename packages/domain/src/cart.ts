import { allocate } from './allocate.js';
import { type ProductUnit, isIntegerOnlyUnit, validateQuantityForUnit } from './catalog.js';
import { type UnixMs, unixMsToBigInt } from './clock.js';
import { DomainError } from './errors.js';
import { type Money, ZERO_MONEY, moneyFromTiyin, moneyToTiyin } from './money.js';
import { type Quantity, quantityToMilli } from './quantity.js';
import { divideRoundHalfAwayFromZero, multiply } from './rounding.js';
import { type UuidV7, parseUuidV7 } from './uuidv7.js';
import { type VatRate, ZERO_VAT_RATE, calculateVatIncluded } from './vat.js';

/**
 * Unified Uzbekistan POS time policy: Asia/Tashkent (`UTC+05:00`, no DST transitions).
 */
export const TASHKENT_TIMEZONE_ID = 'Asia/Tashkent' as const;
export const TASHKENT_UTC_OFFSET_MS = 18_000_000n;

const MS_PER_MINUTE = 60_000n;
const MS_PER_DAY = 86_400_000n;

export interface TashkentLocalTime {
  /** 0n = Sunday, 1n = Monday, ..., 6n = Saturday */
  readonly dayOfWeek: bigint;
  /** 0n..1439n minutes since local Tashkent midnight */
  readonly minutesOfDay: bigint;
}

/**
 * Converts a Unix ms timestamp to Asia/Tashkent (`UTC+5`) local day-of-week and minute-of-day
 * deterministically without depending on host OS timezone or floating-point `Number`.
 */
export function toTashkentLocalTime(unixMs: UnixMs): TashkentLocalTime {
  const localMs = unixMsToBigInt(unixMs) + TASHKENT_UTC_OFFSET_MS;
  // 1970-01-01T00:00:00Z was Thursday (4n).
  const daysSinceEpoch = localMs / MS_PER_DAY;
  const dayRemMs = localMs % MS_PER_DAY;
  const normalizedDays = dayRemMs < 0n ? daysSinceEpoch - 1n : daysSinceEpoch;
  const normalizedDayMs = dayRemMs < 0n ? dayRemMs + MS_PER_DAY : dayRemMs;
  const rawDow = (normalizedDays + 4n) % 7n;
  const dayOfWeek = rawDow < 0n ? rawDow + 7n : rawDow;
  const minutesOfDay = normalizedDayMs / MS_PER_MINUTE;
  return { dayOfWeek, minutesOfDay };
}

export const PROMOTION_TYPES = ['percent', 'fixed_amount', 'buy_x_get_y'] as const;
export type PromotionType = (typeof PROMOTION_TYPES)[number];

export const PROMOTION_SCOPES = ['product', 'category', 'all'] as const;
export type PromotionScope = (typeof PROMOTION_SCOPES)[number];

export const MANUAL_DISCOUNT_MODES = ['none', 'percent', 'amount'] as const;
export type ManualDiscountMode = (typeof MANUAL_DISCOUNT_MODES)[number];

export const CART_STATUSES = ['open', 'parked', 'completed'] as const;
export type CartStatus = (typeof CART_STATUSES)[number];

export const CART_LINE_KINDS = ['catalog', 'quick_sale'] as const;
export type CartLineKind = (typeof CART_LINE_KINDS)[number];

export interface PromotionRule {
  readonly id: UuidV7;
  readonly storeId: UuidV7 | null;
  readonly name: string;
  readonly type: PromotionType;
  readonly scope: PromotionScope;
  readonly targetProductId: UuidV7 | null;
  readonly targetCategoryId: UuidV7 | null;
  readonly discountPercentBp: bigint | null;
  readonly discountAmount: Money | null;
  readonly buyQty: bigint | null;
  readonly freeQty: bigint | null;
  readonly startsAtMs: UnixMs;
  readonly endsAtMs: UnixMs | null;
  readonly isActive: boolean;
}

export interface CashierDiscountPolicy {
  readonly percentUnlimited: boolean;
  readonly maxPercentBp: bigint;
  readonly amountUnlimited: boolean;
  readonly maxAmount: Money;
}

export interface CartManualDiscountInput {
  readonly mode: ManualDiscountMode;
  readonly percentBp: bigint;
  readonly amount: Money;
}

export interface CartLineInput {
  readonly id: UuidV7;
  readonly lineKind: CartLineKind;
  readonly productId: UuidV7 | null;
  readonly variantId: UuidV7 | null;
  readonly categoryId: UuidV7 | null;
  readonly name: string;
  readonly unit: ProductUnit;
  readonly qty: Quantity;
  readonly unitPriceSnapshot: Money;
  readonly vatRate: VatRate;
}

export interface EvaluatedCartLine {
  readonly id: UuidV7;
  readonly lineKind: CartLineKind;
  readonly productId: UuidV7 | null;
  readonly variantId: UuidV7 | null;
  readonly categoryId: UuidV7 | null;
  readonly name: string;
  readonly unit: ProductUnit;
  readonly qty: Quantity;
  readonly unitPriceSnapshot: Money;
  readonly vatRate: VatRate;
  readonly appliedPromotionId: UuidV7 | null;
  readonly appliedPromotionName: string | null;
  readonly freeUnits: bigint;
  readonly grossTotal: Money;
  readonly promoDiscount: Money;
  readonly subtotalAfterPromo: Money;
  readonly allocatedOrderDiscount: Money;
  readonly finalTotal: Money;
  readonly netExVat: Money;
  readonly vatTotal: Money;
}

export interface CartEvaluationResult {
  readonly lines: readonly EvaluatedCartLine[];
  readonly subtotalGross: Money;
  readonly totalPromoDiscount: Money;
  readonly subtotalAfterPromo: Money;
  readonly requestedOrderDiscount: Money;
  readonly effectiveOrderDiscount: Money;
  readonly totalFinal: Money;
  readonly totalNetExVat: Money;
  readonly totalVat: Money;
  readonly totalFreeUnits: bigint;
  readonly exceedsCashierLimit: boolean;
  readonly discountAuthorized: boolean;
  readonly discountOverrideRequired: boolean;
}

export function validatePromotionRuleInput(input: {
  readonly name: string;
  readonly type: PromotionType;
  readonly scope: PromotionScope;
  readonly targetProductId: UuidV7 | null;
  readonly targetCategoryId: UuidV7 | null;
  readonly discountPercentBp: bigint | null;
  readonly discountAmount: Money | null;
  readonly buyQty: bigint | null;
  readonly freeQty: bigint | null;
  readonly startsAtMs: UnixMs;
  readonly endsAtMs: UnixMs | null;
  readonly targetProductUnit?: ProductUnit | null;
}): void {
  const cleanName = input.name.trim();
  if (cleanName.length === 0 || cleanName.length > 200) {
    throw new DomainError('INVALID_PROMOTION', 'Promotion name must be 1..200 characters');
  }

  const startBig = unixMsToBigInt(input.startsAtMs);
  if (input.endsAtMs !== null && unixMsToBigInt(input.endsAtMs) <= startBig) {
    throw new DomainError('INVALID_PROMOTION', 'endsAtMs must be strictly after startsAtMs');
  }

  if (input.scope === 'product') {
    if (input.targetProductId === null || input.targetCategoryId !== null) {
      throw new DomainError(
        'INVALID_PROMOTION',
        'Product-scoped promotion requires targetProductId and no targetCategoryId',
      );
    }
    parseUuidV7(input.targetProductId);
  } else if (input.scope === 'category') {
    if (input.targetCategoryId === null || input.targetProductId !== null) {
      throw new DomainError(
        'INVALID_PROMOTION',
        'Category-scoped promotion requires targetCategoryId and no targetProductId',
      );
    }
    parseUuidV7(input.targetCategoryId);
  } else if (input.targetProductId !== null || input.targetCategoryId !== null) {
    throw new DomainError(
      'INVALID_PROMOTION',
      'Store-wide promotion must not set targetProductId or targetCategoryId',
    );
  }

  if (input.type === 'percent') {
    if (
      input.discountPercentBp === null ||
      input.discountPercentBp < 1n ||
      input.discountPercentBp > 10_000n
    ) {
      throw new DomainError(
        'INVALID_PROMOTION',
        'Percent promotion requires discountPercentBp between 1 and 10000',
      );
    }
    if (input.discountAmount !== null || input.buyQty !== null || input.freeQty !== null) {
      throw new DomainError('INVALID_PROMOTION', 'Percent promotion forbids fixed/N+M fields');
    }
  } else if (input.type === 'fixed_amount') {
    if (input.discountAmount === null || moneyToTiyin(input.discountAmount) <= 0n) {
      throw new DomainError(
        'INVALID_PROMOTION',
        'Fixed-amount promotion requires positive discountAmount',
      );
    }
    if (input.discountPercentBp !== null || input.buyQty !== null || input.freeQty !== null) {
      throw new DomainError(
        'INVALID_PROMOTION',
        'Fixed-amount promotion forbids percent/N+M fields',
      );
    }
  } else {
    if (
      input.buyQty === null ||
      input.freeQty === null ||
      input.buyQty < 1n ||
      input.freeQty < 1n
    ) {
      throw new DomainError(
        'INVALID_PROMOTION',
        'N+M promotion requires integer buyQty >= 1 and freeQty >= 1',
      );
    }
    if (input.discountPercentBp !== null || input.discountAmount !== null) {
      throw new DomainError('INVALID_PROMOTION', 'N+M promotion forbids percent/fixed fields');
    }
    if (input.targetProductUnit && !isIntegerOnlyUnit(input.targetProductUnit)) {
      throw new DomainError(
        'INVALID_PROMOTION',
        `N+M promotions apply only to integer units (dona/qadoq), got "${input.targetProductUnit}"`,
      );
    }
  }
}

export function isPromotionActiveAt(
  promo: PromotionRule,
  nowMs: UnixMs,
  storeId: UuidV7 | null,
): boolean {
  if (!promo.isActive) {
    return false;
  }
  if (promo.storeId !== null && storeId !== null && promo.storeId !== storeId) {
    return false;
  }
  const nowBig = unixMsToBigInt(nowMs);
  const startBig = unixMsToBigInt(promo.startsAtMs);
  if (nowBig < startBig) {
    return false;
  }
  if (promo.endsAtMs !== null && nowBig >= unixMsToBigInt(promo.endsAtMs)) {
    return false;
  }
  return true;
}

export function computeBuyXGetYFreeUnits(qty: Quantity, buyQty: bigint, freeQty: bigint): bigint {
  if (buyQty < 1n || freeQty < 1n) {
    throw new DomainError('INVALID_PROMOTION', 'buyQty and freeQty must be positive integers');
  }
  const milli = quantityToMilli(qty);
  if (milli <= 0n) {
    return 0n;
  }
  const wholeUnits = milli / 1000n;
  const bundle = buyQty + freeQty;
  return (wholeUnits / bundle) * freeQty;
}

function doesLineMatchPromotionScope(line: CartLineInput, promo: PromotionRule): boolean {
  if (promo.type === 'buy_x_get_y') {
    if (line.lineKind !== 'catalog' || !isIntegerOnlyUnit(line.unit)) {
      return false;
    }
  }

  if (promo.scope === 'product') {
    return (
      line.lineKind === 'catalog' &&
      line.productId !== null &&
      promo.targetProductId === line.productId
    );
  }
  if (promo.scope === 'category') {
    return (
      line.lineKind === 'catalog' &&
      line.categoryId !== null &&
      promo.targetCategoryId === line.categoryId
    );
  }
  return true;
}

function clampBigInt(value: bigint, minVal: bigint, maxVal: bigint): bigint {
  if (value < minVal) return minVal;
  if (value > maxVal) return maxVal;
  return value;
}

function computeSingleLineNonBundleDiscountTiyin(
  line: CartLineInput,
  grossTiyin: bigint,
  promo: PromotionRule,
): bigint {
  if (grossTiyin <= 0n || !doesLineMatchPromotionScope(line, promo)) {
    return 0n;
  }
  if (promo.type === 'percent' && promo.discountPercentBp !== null) {
    const raw = divideRoundHalfAwayFromZero(grossTiyin * promo.discountPercentBp, 10_000n);
    return clampBigInt(raw, 0n, grossTiyin);
  }
  if (promo.type === 'fixed_amount' && promo.discountAmount !== null) {
    // Applied per unit (`discountAmount * qty`) so splitting lines never multiplies flat discount.
    const raw = moneyToTiyin(multiply(promo.discountAmount, line.qty));
    return clampBigInt(raw, 0n, grossTiyin);
  }
  return 0n;
}

interface LinePromoAssignment {
  readonly promoId: UuidV7 | null;
  readonly promoName: string | null;
  readonly freeUnits: bigint;
  readonly promoDiscountTiyin: bigint;
}

function compareUuidAsc(a: UuidV7, b: UuidV7): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function assignGroupPromotions(params: {
  readonly groupLines: readonly {
    readonly index: number;
    readonly line: CartLineInput;
    readonly grossTiyin: bigint;
  }[];
  readonly activePromos: readonly PromotionRule[];
}): Map<number, LinePromoAssignment> {
  const result = new Map<number, LinePromoAssignment>();
  const nonBundlePromos = params.activePromos.filter((p) => p.type !== 'buy_x_get_y');
  const bundlePromos = params.activePromos.filter((p) => p.type === 'buy_x_get_y');

  // 1) Best independent non-N+M promo per line
  const bestNonBundle = new Map<number, LinePromoAssignment>();
  let nonBundleGroupSum = 0n;
  let nonBundleBestMinId: UuidV7 | null = null;

  for (const item of params.groupLines) {
    let bestPromo: PromotionRule | null = null;
    let bestDisc = 0n;

    for (const promo of nonBundlePromos) {
      const disc = computeSingleLineNonBundleDiscountTiyin(item.line, item.grossTiyin, promo);
      if (disc <= 0n) {
        continue;
      }
      if (
        disc > bestDisc ||
        (disc === bestDisc && bestPromo !== null && compareUuidAsc(promo.id, bestPromo.id) < 0)
      ) {
        bestDisc = disc;
        bestPromo = promo;
      }
    }

    bestNonBundle.set(item.index, {
      promoId: bestPromo?.id ?? null,
      promoName: bestPromo?.name ?? null,
      freeUnits: 0n,
      promoDiscountTiyin: bestDisc,
    });
    nonBundleGroupSum += bestDisc;
    if (bestPromo !== null) {
      if (nonBundleBestMinId === null || compareUuidAsc(bestPromo.id, nonBundleBestMinId) < 0) {
        nonBundleBestMinId = bestPromo.id;
      }
    }
  }

  // 2) Evaluate N+M bundles across the pooled product/variant group (P1):
  // Total free units come from summed whole quantities in the group and allocate cheapest-first.
  let winningBundle: {
    readonly promo: PromotionRule;
    readonly totalDiscount: bigint;
    readonly assignments: Map<number, LinePromoAssignment>;
  } | null = null;

  for (const promo of bundlePromos) {
    if (promo.buyQty === null || promo.freeQty === null) {
      continue;
    }
    const eligible = params.groupLines.filter((item) =>
      doesLineMatchPromotionScope(item.line, promo),
    );
    if (eligible.length === 0) {
      continue;
    }

    let totalWholeUnits = 0n;
    for (const item of eligible) {
      totalWholeUnits += quantityToMilli(item.line.qty) / 1000n;
    }

    const totalFreeUnits = (totalWholeUnits / (promo.buyQty + promo.freeQty)) * promo.freeQty;
    if (totalFreeUnits <= 0n) {
      continue;
    }

    // Sort cheapest snapshot price first, deterministic line.id ASC tie-break
    const orderedForFree = [...eligible].sort((a, b) => {
      const pa = moneyToTiyin(a.line.unitPriceSnapshot);
      const pb = moneyToTiyin(b.line.unitPriceSnapshot);
      if (pa < pb) return -1;
      if (pa > pb) return 1;
      return compareUuidAsc(a.line.id, b.line.id);
    });

    let remFree = totalFreeUnits;
    let totalGroupDisc = 0n;
    const perLineAssign = new Map<number, LinePromoAssignment>();

    for (const item of eligible) {
      perLineAssign.set(item.index, {
        promoId: promo.id,
        promoName: promo.name,
        freeUnits: 0n,
        promoDiscountTiyin: 0n,
      });
    }

    for (const item of orderedForFree) {
      if (remFree <= 0n) {
        break;
      }
      const lineWholeUnits = quantityToMilli(item.line.qty) / 1000n;
      if (lineWholeUnits <= 0n) {
        continue;
      }
      const give = remFree <= lineWholeUnits ? remFree : lineWholeUnits;
      const lineDisc = clampBigInt(
        give * moneyToTiyin(item.line.unitPriceSnapshot),
        0n,
        item.grossTiyin,
      );
      perLineAssign.set(item.index, {
        promoId: promo.id,
        promoName: promo.name,
        freeUnits: give,
        promoDiscountTiyin: lineDisc,
      });
      totalGroupDisc += lineDisc;
      remFree -= give;
    }

    if (totalGroupDisc <= 0n) {
      continue;
    }

    if (
      winningBundle === null ||
      totalGroupDisc > winningBundle.totalDiscount ||
      (totalGroupDisc === winningBundle.totalDiscount &&
        compareUuidAsc(promo.id, winningBundle.promo.id) < 0)
    ) {
      winningBundle = {
        promo,
        totalDiscount: totalGroupDisc,
        assignments: perLineAssign,
      };
    }
  }

  // 3) Choose N+M bundle for group if it matches or beats combined per-line non-N+M promos
  if (
    winningBundle !== null &&
    (winningBundle.totalDiscount > nonBundleGroupSum ||
      (winningBundle.totalDiscount === nonBundleGroupSum &&
        (nonBundleBestMinId === null ||
          compareUuidAsc(winningBundle.promo.id, nonBundleBestMinId) < 0)))
  ) {
    for (const item of params.groupLines) {
      result.set(
        item.index,
        winningBundle.assignments.get(item.index) ?? {
          promoId: null,
          promoName: null,
          freeUnits: 0n,
          promoDiscountTiyin: 0n,
        },
      );
    }
    return result;
  }

  for (const item of params.groupLines) {
    result.set(
      item.index,
      bestNonBundle.get(item.index) ?? {
        promoId: null,
        promoName: null,
        freeUnits: 0n,
        promoDiscountTiyin: 0n,
      },
    );
  }
  return result;
}

export function doesDiscountExceedCashierLimit(
  effectiveOrderDiscount: Money,
  subtotalAfterPromo: Money,
  policy: CashierDiscountPolicy,
): boolean {
  const discTiyin = moneyToTiyin(effectiveOrderDiscount);
  const subTiyin = moneyToTiyin(subtotalAfterPromo);
  if (discTiyin <= 0n) {
    return false;
  }
  if (!policy.percentUnlimited) {
    if (subTiyin <= 0n || discTiyin * 10_000n > subTiyin * policy.maxPercentBp) {
      return true;
    }
  }
  if (!policy.amountUnlimited && discTiyin > moneyToTiyin(policy.maxAmount)) {
    return true;
  }
  return false;
}

export function isCartManualDiscountAuthorized(params: {
  readonly effectiveOrderDiscount: Money;
  readonly subtotalAfterPromo: Money;
  readonly policy: CashierDiscountPolicy;
  readonly overrideApprovedByUserId: UuidV7 | null;
  readonly overrideApprovedAmount: Money | null;
}): boolean {
  if (
    !doesDiscountExceedCashierLimit(
      params.effectiveOrderDiscount,
      params.subtotalAfterPromo,
      params.policy,
    )
  ) {
    return true;
  }
  if (params.overrideApprovedByUserId === null || params.overrideApprovedAmount === null) {
    return false;
  }
  return moneyToTiyin(params.effectiveOrderDiscount) <= moneyToTiyin(params.overrideApprovedAmount);
}

/**
 * Pure deterministic cart evaluation (`calculateCartTotals` / `evaluateCart`):
 * 1. Validates each line quantity & non-negative price snapshot and computes `lineGross`.
 * 2. Evaluates active promotions (`startsAtMs <= nowMs < endsAtMs`), pooling `N+M` (`buy_x_get_y`)
 *    quantities per `(productId, variantId)` and allocating free units cheapest-price-first.
 *    Each line gets at most 1 promotion (highest customer savings, tie-broken by `promo.id ASC`).
 * 3. Computes order-level manual discount clamped to `[0, subtotalAfterPromo]` and distributes it
 *    exactly via T0.2 Largest Remainder Method (`allocate`) proportionally to `lineSubtotalAfterPromo`.
 * 4. Extracts included VAT per line (`calculateVatIncluded`) preserving `net + vat === finalTotal`.
 * 5. Checks cashier discount limits and supervisor approval amount ceiling (`P2`).
 */
export function evaluateCart(params: {
  readonly storeId: UuidV7 | null;
  readonly nowMs: UnixMs;
  readonly lines: readonly CartLineInput[];
  readonly promotions: readonly PromotionRule[];
  readonly manualDiscount: CartManualDiscountInput;
  readonly policy: CashierDiscountPolicy;
  readonly overrideApprovedByUserId: UuidV7 | null;
  readonly overrideApprovedAmount: Money | null;
}): CartEvaluationResult {
  const activePromos = params.promotions.filter((p) =>
    isPromotionActiveAt(p, params.nowMs, params.storeId),
  );

  // Validate lines & compute gross totals
  const baseLines = params.lines.map((line, index) => {
    validateQuantityForUnit(line.unit, line.qty, { allowZero: false });
    const unitPriceTiyin = moneyToTiyin(line.unitPriceSnapshot);
    if (unitPriceTiyin < 0n) {
      throw new DomainError('VALIDATION_ERROR', 'Line unitPriceSnapshot must not be negative');
    }
    const gross = multiply(line.unitPriceSnapshot, line.qty);
    return {
      index,
      line,
      grossTiyin: moneyToTiyin(gross),
    };
  });

  // Group catalog lines by (productId, variantId) for P1 N+M pooling
  const groups = new Map<
    string,
    Array<{ readonly index: number; readonly line: CartLineInput; readonly grossTiyin: bigint }>
  >();
  for (const item of baseLines) {
    const key =
      item.line.lineKind === 'catalog' && item.line.productId !== null
        ? `${item.line.productId}:${item.line.variantId ?? ''}`
        : `single:${item.line.id}`;
    const list = groups.get(key);
    if (list) {
      list.push(item);
    } else {
      groups.set(key, [item]);
    }
  }

  const linePromoMap = new Map<number, LinePromoAssignment>();
  for (const groupLines of groups.values()) {
    const assigned = assignGroupPromotions({ groupLines, activePromos });
    for (const [idx, val] of assigned.entries()) {
      linePromoMap.set(idx, val);
    }
  }

  let subtotalGrossTiyin = 0n;
  let totalPromoTiyin = 0n;
  let totalAfterPromoTiyin = 0n;
  let totalFreeUnits = 0n;

  const afterPromoLines = baseLines.map((item) => {
    const promo = linePromoMap.get(item.index) ?? {
      promoId: null,
      promoName: null,
      freeUnits: 0n,
      promoDiscountTiyin: 0n,
    };
    const promoTiyin = clampBigInt(promo.promoDiscountTiyin, 0n, item.grossTiyin);
    const subAfterPromoTiyin = item.grossTiyin - promoTiyin;
    subtotalGrossTiyin += item.grossTiyin;
    totalPromoTiyin += promoTiyin;
    totalAfterPromoTiyin += subAfterPromoTiyin;
    totalFreeUnits += promo.freeUnits;

    return {
      ...item,
      promoId: promo.promoId,
      promoName: promo.promoName,
      freeUnits: promo.freeUnits,
      promoTiyin,
      subAfterPromoTiyin,
    };
  });

  // Compute order-level manual discount clamped to subtotalAfterPromo
  let requestedOrderTiyin = 0n;
  if (params.manualDiscount.mode === 'percent') {
    if (params.manualDiscount.percentBp < 0n || params.manualDiscount.percentBp > 10_000n) {
      throw new DomainError('VALIDATION_ERROR', 'Manual discount percentBp must be in [0, 10000]');
    }
    if (params.manualDiscount.percentBp > 0n && totalAfterPromoTiyin > 0n) {
      requestedOrderTiyin = divideRoundHalfAwayFromZero(
        totalAfterPromoTiyin * params.manualDiscount.percentBp,
        10_000n,
      );
    }
  } else if (params.manualDiscount.mode === 'amount') {
    const rawAmt = moneyToTiyin(params.manualDiscount.amount);
    if (rawAmt < 0n) {
      throw new DomainError('VALIDATION_ERROR', 'Manual discount amount must not be negative');
    }
    requestedOrderTiyin = rawAmt;
  }

  const effectiveOrderTiyin = clampBigInt(requestedOrderTiyin, 0n, totalAfterPromoTiyin);

  // Allocate order discount across lines via T0.2 Largest Remainder Method
  let allocatedOrderDiscounts: Money[];
  if (effectiveOrderTiyin === 0n || totalAfterPromoTiyin === 0n) {
    allocatedOrderDiscounts = afterPromoLines.map(() => ZERO_MONEY);
  } else {
    allocatedOrderDiscounts = allocate(
      moneyFromTiyin(effectiveOrderTiyin),
      afterPromoLines.map((l) => l.subAfterPromoTiyin),
    );
  }

  let totalFinalTiyin = 0n;
  let totalNetExVatTiyin = 0n;
  let totalVatTiyin = 0n;

  const evaluatedLines: EvaluatedCartLine[] = afterPromoLines.map((item, i) => {
    const allocTiyin = moneyToTiyin(allocatedOrderDiscounts[i] ?? ZERO_MONEY);
    const finalTiyin = item.subAfterPromoTiyin - allocTiyin;
    const finalMoney = moneyFromTiyin(finalTiyin);
    const vatBreakdown = calculateVatIncluded(finalMoney, item.line.vatRate ?? ZERO_VAT_RATE);

    totalFinalTiyin += finalTiyin;
    totalNetExVatTiyin += moneyToTiyin(vatBreakdown.net);
    totalVatTiyin += moneyToTiyin(vatBreakdown.vat);

    return {
      id: item.line.id,
      lineKind: item.line.lineKind,
      productId: item.line.productId,
      variantId: item.line.variantId,
      categoryId: item.line.categoryId,
      name: item.line.name,
      unit: item.line.unit,
      qty: item.line.qty,
      unitPriceSnapshot: item.line.unitPriceSnapshot,
      vatRate: item.line.vatRate,
      appliedPromotionId: item.promoId,
      appliedPromotionName: item.promoName,
      freeUnits: item.freeUnits,
      grossTotal: moneyFromTiyin(item.grossTiyin),
      promoDiscount: moneyFromTiyin(item.promoTiyin),
      subtotalAfterPromo: moneyFromTiyin(item.subAfterPromoTiyin),
      allocatedOrderDiscount: moneyFromTiyin(allocTiyin),
      finalTotal: finalMoney,
      netExVat: vatBreakdown.net,
      vatTotal: vatBreakdown.vat,
    };
  });

  const subtotalAfterPromoMoney = moneyFromTiyin(totalAfterPromoTiyin);
  const effectiveOrderMoney = moneyFromTiyin(effectiveOrderTiyin);
  const exceedsLimit = doesDiscountExceedCashierLimit(
    effectiveOrderMoney,
    subtotalAfterPromoMoney,
    params.policy,
  );
  const authorized = isCartManualDiscountAuthorized({
    effectiveOrderDiscount: effectiveOrderMoney,
    subtotalAfterPromo: subtotalAfterPromoMoney,
    policy: params.policy,
    overrideApprovedByUserId: params.overrideApprovedByUserId,
    overrideApprovedAmount: params.overrideApprovedAmount,
  });

  return {
    lines: evaluatedLines,
    subtotalGross: moneyFromTiyin(subtotalGrossTiyin),
    totalPromoDiscount: moneyFromTiyin(totalPromoTiyin),
    subtotalAfterPromo: subtotalAfterPromoMoney,
    requestedOrderDiscount: moneyFromTiyin(requestedOrderTiyin),
    effectiveOrderDiscount: effectiveOrderMoney,
    totalFinal: moneyFromTiyin(totalFinalTiyin),
    totalNetExVat: moneyFromTiyin(totalNetExVatTiyin),
    totalVat: moneyFromTiyin(totalVatTiyin),
    totalFreeUnits,
    exceedsCashierLimit: exceedsLimit,
    discountAuthorized: authorized,
    discountOverrideRequired: !authorized,
  };
}

export function assertCartDiscountAuthorized(evaluation: CartEvaluationResult): void {
  if (evaluation.discountOverrideRequired) {
    throw new DomainError(
      'DISCOUNT_OVERRIDE_REQUIRED',
      'Order manual discount exceeds cashier limit or previously approved amount and requires supervisor PIN approval',
    );
  }
}
