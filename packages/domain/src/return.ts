import { TASHKENT_TIMEZONE_ID, TASHKENT_UTC_OFFSET_MS } from './cart.js';
import { type ProductUnit, isIntegerOnlyUnit, validateQuantityForUnit } from './catalog.js';
import { type UnixMs, unixMsToBigInt } from './clock.js';
import { DomainError } from './errors.js';
import { MAX_MONEY_TIYIN, type Money, ZERO_MONEY, moneyFromTiyin, moneyToTiyin } from './money.js';
import { type Quantity, quantityFromMilli, quantityToMilli } from './quantity.js';
import { divideRoundHalfAwayFromZero } from './rounding.js';
import {
  PAYMENT_METHODS,
  type PaymentMethod,
  normalizePaymentProviderRef,
  parsePaymentMethod,
} from './sale.js';
import { type UuidV7, parseUuidV7 } from './uuidv7.js';

export const DEFAULT_STORE_TIMEZONE = TASHKENT_TIMEZONE_ID;
export const MAX_RETURN_REASON_LENGTH = 500;
export const MAX_STORE_TIMEZONE_LENGTH = 64;

const MS_PER_DAY = 86_400_000n;

function floorDiv(dividend: bigint, divisor: bigint): bigint {
  let q = dividend / divisor;
  if (dividend % divisor !== 0n && dividend < 0n !== divisor < 0n) {
    q -= 1n;
  }
  return q;
}

function civilDateFromEpochDays(epochDays: bigint): string {
  // Howard Hinnant civil-from-days algorithm in exact BigInt arithmetic (ISO YYYY-MM-DD).
  const z = epochDays + 719468n;
  const era = (z >= 0n ? z : z - 146096n) / 146097n;
  const doe = z - era * 146097n;
  const yoe = (doe - doe / 1460n + doe / 36524n - doe / 146096n) / 365n;
  const y = yoe + era * 400n;
  const doy = doe - (365n * yoe + yoe / 4n - yoe / 100n);
  const mp = (5n * doy + 2n) / 153n;
  const day = doy - (153n * mp + 2n) / 5n + 1n;
  const month = mp + (mp < 10n ? 3n : -9n);
  const year = y + (month <= 2n ? 1n : 0n);

  const yearStr =
    year < 0n ? `-${(-year).toString().padStart(4, '0')}` : year.toString().padStart(4, '0');
  return `${yearStr}-${month.toString().padStart(2, '0')}-${day.toString().padStart(2, '0')}`;
}

/**
 * Validates and canonicalizes an IANA timezone name (defaults to `Asia/Tashkent`).
 */
export function assertValidStoreTimeZone(timeZone: string | null | undefined): string {
  if (timeZone === undefined || timeZone === null) {
    return DEFAULT_STORE_TIMEZONE;
  }
  if (typeof timeZone !== 'string') {
    throw new DomainError('VALIDATION_ERROR', 'storeTimezone must be a string');
  }
  const trimmed = timeZone.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_STORE_TIMEZONE_LENGTH) {
    throw new DomainError(
      'VALIDATION_ERROR',
      `storeTimezone must be between 1 and ${String(MAX_STORE_TIMEZONE_LENGTH)} characters`,
    );
  }
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone: trimmed });
  } catch {
    throw new DomainError('VALIDATION_ERROR', `Invalid IANA timezone: "${trimmed}"`);
  }
  return trimmed;
}

/**
 * Converts a Unix millisecond timestamp to the local `YYYY-MM-DD` business date key
 * in the configured store timezone (`Asia/Tashkent` by default).
 *
 * `'Asia/Tashkent'` (`UTC+5`) and `'UTC'` are resolved purely in deterministic `BigInt` math.
 * Other DST-aware IANA timezones accept an optional outer resolver (`resolveTimeZoneDateKey`).
 */
export function getBusinessDateKey(
  unixMs: UnixMs,
  timeZone: string = DEFAULT_STORE_TIMEZONE,
  resolveTimeZoneDateKey?: (unixMs: UnixMs, tz: string) => string,
): string {
  const ms = unixMsToBigInt(unixMs);
  const tz = assertValidStoreTimeZone(timeZone);

  if (tz === TASHKENT_TIMEZONE_ID) {
    return civilDateFromEpochDays(floorDiv(ms + TASHKENT_UTC_OFFSET_MS, MS_PER_DAY));
  }
  if (tz === 'UTC' || tz === 'Etc/UTC') {
    return civilDateFromEpochDays(floorDiv(ms, MS_PER_DAY));
  }

  if (resolveTimeZoneDateKey) {
    return resolveTimeZoneDateKey(unixMs, tz);
  }

  throw new DomainError(
    'VALIDATION_ERROR',
    `Timezone "${tz}" requires an external calendar resolver outside @mezon/domain`,
  );
}

/**
 * Checks whether two timestamps fall on the same store local business date.
 */
export function isSameBusinessDay(
  firstMs: UnixMs,
  secondMs: UnixMs,
  timeZone: string = DEFAULT_STORE_TIMEZONE,
  resolveTimeZoneDateKey?: (unixMs: UnixMs, tz: string) => string,
): boolean {
  const tz = assertValidStoreTimeZone(timeZone);
  return (
    getBusinessDateKey(firstMs, tz, resolveTimeZoneDateKey) ===
    getBusinessDateKey(secondMs, tz, resolveTimeZoneDateKey)
  );
}

/**
 * V1: Enforces that a sale may only be voided on the same local business day in the store
 * timezone (default `Asia/Tashkent`). Older receipts must be reversed via `createReturn`.
 *
 * NOTE FOR T1.9 (Shifts): Once shifts are introduced, T1.9 narrows this rule further so
 * `voidSale` is permitted ONLY while the original sale's shift remains open (closed shifts /
 * Z-reports cannot change retroactively — those reversals go strictly through `createReturn`).
 */
export function assertSaleVoidBusinessDay(params: {
  readonly saleCreatedAtMs: UnixMs;
  readonly nowMs: UnixMs;
  readonly storeTimezone?: string;
  readonly resolveTimeZoneDateKey?: (unixMs: UnixMs, tz: string) => string;
}): void {
  const tz = assertValidStoreTimeZone(params.storeTimezone);
  const saleDay = getBusinessDateKey(params.saleCreatedAtMs, tz, params.resolveTimeZoneDateKey);
  const currentDay = getBusinessDateKey(params.nowMs, tz, params.resolveTimeZoneDateKey);
  if (saleDay !== currentDay) {
    throw new DomainError(
      'VOID_WINDOW_EXPIRED',
      `Sale created on ${saleDay} (${tz}) cannot be voided on ${currentDay}; create a return instead`,
      {
        details: {
          saleBusinessDate: saleDay,
          currentBusinessDate: currentDay,
          storeTimezone: tz,
        },
      },
    );
  }
}

/**
 * Validates and trims a mandatory void/return reason (`1..500` chars).
 */
export function normalizeMandatoryReason(raw: string, fieldName = 'reason'): string {
  if (typeof raw !== 'string') {
    throw new DomainError('VALIDATION_ERROR', `${fieldName} must be a non-empty string`);
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    throw new DomainError('VALIDATION_ERROR', `${fieldName} must not be empty`);
  }
  if (trimmed.length > MAX_RETURN_REASON_LENGTH) {
    throw new DomainError(
      'VALIDATION_ERROR',
      `${fieldName} must not exceed ${String(MAX_RETURN_REASON_LENGTH)} characters`,
    );
  }
  return trimmed;
}

/**
 * Formats a human-visible return document code from `deviceId` and monotonic `return_no`:
 * `RET-<last 4 hex chars of deviceId>-<zero-padded >=6 digits>`.
 */
export function formatReturnCode(deviceId: UuidV7, returnNo: bigint): string {
  const validDeviceId = parseUuidV7(deviceId);
  if (returnNo < 1n) {
    throw new DomainError('VALIDATION_ERROR', 'returnNo must be a positive integer >= 1');
  }
  const deviceSuffix = validDeviceId.slice(-4).toUpperCase();
  const seqText = returnNo.toString().padStart(6, '0');
  return `RET-${deviceSuffix}-${seqText}`;
}

export interface CumulativeReturnLineInput {
  readonly saleLineId: UuidV7;
  readonly unit: ProductUnit;
  readonly soldQty: Quantity;
  readonly previouslyReturnedQty: Quantity;
  readonly requestedQty: Quantity;
  readonly soldFinalTotal: Money;
  readonly soldNetExVat: Money;
  readonly soldVatTotal: Money;
  readonly previouslyRefunded: Money;
  readonly previouslyReturnedNet: Money;
  readonly previouslyReturnedVat: Money;
}

export interface CumulativeReturnLineResult {
  readonly qty: Quantity;
  readonly refundAmount: Money;
  readonly netExVat: Money;
  readonly vatTotal: Money;
}

/**
 * Computes exact cumulative refund, net-ex-VAT, and VAT amounts for a partial or full return
 * against an original sale line.
 *
 * Properties preserved across any sequence of partial returns summing to `soldQty`:
 * - `SUM(refundAmount) === soldFinalTotal` (exact to the tiyin)
 * - `SUM(vatTotal) === soldVatTotal` (exact to the tiyin)
 * - `SUM(netExVat) === soldNetExVat` (exact to the tiyin)
 * - `0 <= vatTotal`, `0 <= netExVat`, and `netExVat + vatTotal === refundAmount` at every step.
 */
export function computeCumulativeReturnLineAmounts(
  input: CumulativeReturnLineInput,
): CumulativeReturnLineResult {
  parseUuidV7(input.saleLineId);
  const validReqQty = validateQuantityForUnit(input.unit, input.requestedQty);
  const reqMilli = quantityToMilli(validReqQty);
  if (reqMilli <= 0n) {
    throw new DomainError('INVALID_UNIT_QUANTITY', 'Return quantity must be strictly positive');
  }
  if (isIntegerOnlyUnit(input.unit) && reqMilli % 1000n !== 0n) {
    throw new DomainError(
      'INVALID_UNIT_QUANTITY',
      `Unit "${input.unit}" requires whole-unit return quantity`,
    );
  }

  const soldMilli = quantityToMilli(input.soldQty);
  const prevMilli = quantityToMilli(input.previouslyReturnedQty);
  if (soldMilli <= 0n || prevMilli < 0n || prevMilli > soldMilli) {
    throw new DomainError('VALIDATION_ERROR', 'Corrupted sale/return cumulative quantity state');
  }
  const remainingMilli = soldMilli - prevMilli;
  if (reqMilli > remainingMilli) {
    throw new DomainError(
      'RETURN_QTY_EXCEEDED',
      `Requested return qty (${reqMilli.toString()}) exceeds remaining returnable qty (${remainingMilli.toString()})`,
      {
        details: {
          saleLineId: input.saleLineId,
          soldQty: soldMilli.toString(),
          alreadyReturnedQty: prevMilli.toString(),
          remainingQty: remainingMilli.toString(),
          requestedQty: reqMilli.toString(),
        },
      },
    );
  }

  const soldFinal = moneyToTiyin(input.soldFinalTotal);
  const soldNet = moneyToTiyin(input.soldNetExVat);
  const soldVat = moneyToTiyin(input.soldVatTotal);
  if (soldFinal < 0n || soldNet < 0n || soldVat < 0n || soldNet + soldVat !== soldFinal) {
    throw new DomainError('VALIDATION_ERROR', 'Original sale line money breakdown is inconsistent');
  }

  const prevRefund = moneyToTiyin(input.previouslyRefunded);
  const prevNet = moneyToTiyin(input.previouslyReturnedNet);
  const prevVat = moneyToTiyin(input.previouslyReturnedVat);
  if (
    prevRefund < 0n ||
    prevNet < 0n ||
    prevVat < 0n ||
    prevNet + prevVat !== prevRefund ||
    prevRefund > soldFinal
  ) {
    throw new DomainError('VALIDATION_ERROR', 'Prior return totals are inconsistent');
  }

  const nextMilli = prevMilli + reqMilli;
  const cumRefundNext = divideRoundHalfAwayFromZero(soldFinal * nextMilli, soldMilli);
  const refundDelta = cumRefundNext - prevRefund;
  if (refundDelta < 0n || cumRefundNext > soldFinal) {
    throw new DomainError('VALIDATION_ERROR', 'Cumulative refund exceeded original line total');
  }

  // Clamp cumulative VAT delta inside `[L, U]` so `netExVat >= 0`, `vatTotal >= 0`, and final sums equal `soldVatTotal` & `soldNetExVat`.
  const rawCumVatNext = divideRoundHalfAwayFromZero(soldVat * nextMilli, soldMilli);
  const lowerBound = prevVat > cumRefundNext - soldNet ? prevVat : cumRefundNext - soldNet;
  const upperBound = soldVat < cumRefundNext - prevNet ? soldVat : cumRefundNext - prevNet;
  if (lowerBound > upperBound) {
    throw new DomainError('VALIDATION_ERROR', 'Cumulative VAT bounds became empty');
  }
  const cumVatNext =
    rawCumVatNext < lowerBound
      ? lowerBound
      : rawCumVatNext > upperBound
        ? upperBound
        : rawCumVatNext;
  const vatDelta = cumVatNext - prevVat;
  const netDelta = refundDelta - vatDelta;

  return {
    qty: validReqQty,
    refundAmount: moneyFromTiyin(refundDelta),
    netExVat: moneyFromTiyin(netDelta),
    vatTotal: moneyFromTiyin(vatDelta),
  };
}

export interface OriginalSaleStockMoveLeg {
  readonly moveId: UuidV7;
  readonly batchId: UuidV7 | null;
  readonly soldQty: Quantity;
  readonly soldCostValue: Money;
}

export interface AllocatedReturnStockLeg {
  readonly origMoveId: UuidV7;
  readonly batchId: UuidV7 | null;
  readonly qty: Quantity;
  readonly costValue: Money;
}

export interface AllocatedReturnStockLegsResult {
  readonly legs: readonly AllocatedReturnStockLeg[];
  readonly totalCostValue: Money;
}

/**
 * Maps a partial or full return interval `[previouslyReturnedQty, previouslyReturnedQty + requestedQty]`
 * onto the original outbound `stock_moves` legs in deterministic FIFO/creation order (`Variant 1`).
 *
 * Guarantees:
 * - On full return (`0 -> soldQty`), restores the EXACT original `qty` and `costValue` per `batchId`.
 * - Across any random partition of partial returns, the sum restored to each leg equals that leg's
 *   exact original `soldQty` and `soldCostValue`, so `sum(totalCostValue)` matches 100% identically
 *   and live stock/batch balances remain identical to one full return (`V4.2`).
 * - When `origLegs` is empty (`quick_sale` or `unlimited` product per `V5`), `legs` is empty and
 *   no `stock_moves` are written.
 */
export function allocateReturnStockMoveLegs(params: {
  readonly origLegs: readonly OriginalSaleStockMoveLeg[];
  readonly soldLineQty: Quantity;
  readonly soldLineCostValue: Money;
  readonly previouslyReturnedQty: Quantity;
  readonly previouslyReturnedCostValue: Money;
  readonly requestedQty: Quantity;
}): AllocatedReturnStockLegsResult {
  const soldLineMilli = quantityToMilli(params.soldLineQty);
  const prevMilli = quantityToMilli(params.previouslyReturnedQty);
  const reqMilli = quantityToMilli(params.requestedQty);
  const nextMilli = prevMilli + reqMilli;

  if (params.origLegs.length === 0) {
    // V5: Non-tracked product (`quick_sale` or `unlimited`) -> 0 stock moves; keep cumulative line cost (normally 0n).
    const soldCost = moneyToTiyin(params.soldLineCostValue);
    const prevCost = moneyToTiyin(params.previouslyReturnedCostValue);
    const cumCostNext = divideRoundHalfAwayFromZero(soldCost * nextMilli, soldLineMilli);
    return {
      legs: [],
      totalCostValue: moneyFromTiyin(cumCostNext - prevCost),
    };
  }

  let legSumQtyMilli = 0n;
  for (const leg of params.origLegs) {
    const legQtyMilli = quantityToMilli(leg.soldQty);
    if (legQtyMilli <= 0n || moneyToTiyin(leg.soldCostValue) < 0n) {
      throw new DomainError('VALIDATION_ERROR', 'Original outbound stock leg must be non-negative');
    }
    legSumQtyMilli += legQtyMilli;
  }
  if (legSumQtyMilli !== soldLineMilli) {
    throw new DomainError(
      'VALIDATION_ERROR',
      `Original stock move legs sum (${legSumQtyMilli.toString()}) !== sale line qty (${soldLineMilli.toString()})`,
    );
  }

  const outLegs: AllocatedReturnStockLeg[] = [];
  let cursorMilli = 0n;
  let totalCostTiyin = 0n;

  for (const leg of params.origLegs) {
    const legQtyMilli = quantityToMilli(leg.soldQty);
    const legCostTiyin = moneyToTiyin(leg.soldCostValue);
    const legStart = cursorMilli;
    const legEnd = cursorMilli + legQtyMilli;
    cursorMilli = legEnd;

    const ovStart = prevMilli > legStart ? prevMilli : legStart;
    const ovEnd = nextMilli < legEnd ? nextMilli : legEnd;
    if (ovEnd <= ovStart) {
      continue;
    }

    const partQtyMilli = ovEnd - ovStart;
    const localPrev = ovStart - legStart;
    const localNext = ovEnd - legStart;
    const cumCostBefore = divideRoundHalfAwayFromZero(legCostTiyin * localPrev, legQtyMilli);
    const cumCostAfter = divideRoundHalfAwayFromZero(legCostTiyin * localNext, legQtyMilli);
    const partCostTiyin = cumCostAfter - cumCostBefore;

    totalCostTiyin += partCostTiyin;
    outLegs.push({
      origMoveId: leg.moveId,
      batchId: leg.batchId,
      qty: quantityFromMilli(partQtyMilli),
      costValue: moneyFromTiyin(partCostTiyin),
    });
  }

  return {
    legs: outLegs,
    totalCostValue: moneyFromTiyin(totalCostTiyin),
  };
}

export interface ReturnPaymentInput {
  readonly method: PaymentMethod;
  readonly amount: Money;
  readonly providerRef?: string | null;
}

export interface ResolvedReturnPaymentItem {
  readonly method: PaymentMethod;
  readonly amount: Money;
  readonly providerRef: string | null;
}

export interface ResolvedReturnPayments {
  readonly payments: readonly ResolvedReturnPaymentItem[];
  readonly cashRefundAmount: Money;
  readonly nonCashRefundAmount: Money;
  readonly debtOffsetAmount: Money;
}

export function createEmptyPaymentMethodMap(): Record<PaymentMethod, Money> {
  return {
    cash: ZERO_MONEY,
    card: ZERO_MONEY,
    uzqr: ZERO_MONEY,
    payme: ZERO_MONEY,
    click: ZERO_MONEY,
    uzum: ZERO_MONEY,
    social_card: ZERO_MONEY,
    other: ZERO_MONEY,
  };
}

/**
 * Validates refund payment method breakdown for a return:
 * - Strictly forbids cross-method refunds (`cash` -> `card`, etc.).
 * - `originalPaid(sale, 'cash')` MUST be net applied `payments.amount`, NEVER `tenderedAmount` (V2).
 * - `SUM(payments.amount) + debtOffsetAmount === totalRefund`.
 * - Enforces T1.7 placeholder rejection if `debtOffsetAmount > 0` or `saleDebtAmount > 0`.
 */
export function resolveReturnPayments(params: {
  readonly totalRefund: Money;
  readonly debtOffsetAmount?: Money;
  readonly saleTotalPaid: Money;
  readonly saleDebtAmount: Money;
  readonly originalPaidByMethod: Readonly<Record<PaymentMethod, Money>>;
  readonly priorReturnedByMethod: Readonly<Record<PaymentMethod, Money>>;
  readonly payments: readonly ReturnPaymentInput[];
}): ResolvedReturnPayments {
  const totalRefundTiyin = moneyToTiyin(params.totalRefund);
  const debtOffsetTiyin =
    params.debtOffsetAmount !== undefined ? moneyToTiyin(params.debtOffsetAmount) : 0n;
  const salePaidTiyin = moneyToTiyin(params.saleTotalPaid);
  const saleDebtTiyin = moneyToTiyin(params.saleDebtAmount);

  if (totalRefundTiyin < 0n || totalRefundTiyin > MAX_MONEY_TIYIN) {
    throw new DomainError('VALIDATION_ERROR', 'totalRefund out of bounds');
  }
  if (debtOffsetTiyin < 0n || debtOffsetTiyin > MAX_MONEY_TIYIN) {
    throw new DomainError('VALIDATION_ERROR', 'debtOffsetAmount out of bounds');
  }
  if (debtOffsetTiyin > 0n) {
    throw new DomainError(
      'CUSTOMER_REQUIRED',
      'Customer debt offset during return requires T1.7 customer_ledger',
    );
  }
  if (saleDebtTiyin > 0n) {
    throw new DomainError(
      'CUSTOMER_REQUIRED',
      'Returns against debt sales require T1.7 customer_ledger support',
    );
  }

  const resolvedItems: ResolvedReturnPaymentItem[] = [];
  const requestedByMethod = createEmptyPaymentMethodMap();
  let sumPaymentsTiyin = 0n;
  let cashCount = 0;

  for (const item of params.payments) {
    const method = parsePaymentMethod(item.method);
    const amtTiyin = moneyToTiyin(item.amount);
    if (amtTiyin <= 0n || amtTiyin > MAX_MONEY_TIYIN) {
      throw new DomainError(
        'VALIDATION_ERROR',
        `Refund payment for "${method}" must be strictly positive`,
      );
    }
    if (method === 'cash') {
      cashCount += 1;
      if (cashCount > 1) {
        throw new DomainError(
          'VALIDATION_ERROR',
          'At most one cash refund row is allowed per return',
        );
      }
      if (
        item.providerRef !== undefined &&
        item.providerRef !== null &&
        item.providerRef.trim().length > 0
      ) {
        throw new DomainError('VALIDATION_ERROR', 'Cash refund must not carry a providerRef');
      }
    }

    const providerRef = method === 'cash' ? null : normalizePaymentProviderRef(item.providerRef);
    const newMethodSum = moneyToTiyin(requestedByMethod[method]) + amtTiyin;
    requestedByMethod[method] = moneyFromTiyin(newMethodSum);
    sumPaymentsTiyin += amtTiyin;

    resolvedItems.push({
      method,
      amount: moneyFromTiyin(amtTiyin),
      providerRef,
    });
  }

  for (const method of PAYMENT_METHODS) {
    const origTiyin = moneyToTiyin(params.originalPaidByMethod[method]);
    const priorTiyin = moneyToTiyin(params.priorReturnedByMethod[method]);
    const capTiyin = origTiyin - priorTiyin;
    const reqTiyin = moneyToTiyin(requestedByMethod[method]);
    if (reqTiyin > capTiyin) {
      throw new DomainError(
        'RETURN_PAYMENT_LIMIT_EXCEEDED',
        `Refund of ${reqTiyin.toString()} tiyin for "${method}" exceeds remaining refundable limit (${capTiyin.toString()} tiyin)`,
        {
          details: {
            method,
            requestedAmount: reqTiyin.toString(),
            remainingCap: capTiyin.toString(),
            originalPaid: origTiyin.toString(),
            priorReturned: priorTiyin.toString(),
          },
        },
      );
    }
  }

  if (totalRefundTiyin === 0n && resolvedItems.length > 0) {
    throw new DomainError('VALIDATION_ERROR', 'Zero-value returns must not contain payment lines');
  }
  if (sumPaymentsTiyin + debtOffsetTiyin !== totalRefundTiyin) {
    throw new DomainError(
      'VALIDATION_ERROR',
      `Refund payment invariant violated: sum(payments)=${sumPaymentsTiyin.toString()} + debtOffset=${debtOffsetTiyin.toString()} !== totalRefund=${totalRefundTiyin.toString()}`,
    );
  }
  if (sumPaymentsTiyin > salePaidTiyin) {
    throw new DomainError(
      'RETURN_PAYMENT_LIMIT_EXCEEDED',
      'Total refund payments cannot exceed original paid amount',
    );
  }

  const cashRefundTiyin = moneyToTiyin(requestedByMethod.cash);
  const nonCashRefundTiyin = sumPaymentsTiyin - cashRefundTiyin;

  return {
    payments: resolvedItems,
    cashRefundAmount: moneyFromTiyin(cashRefundTiyin),
    nonCashRefundAmount: moneyFromTiyin(nonCashRefundTiyin),
    debtOffsetAmount: moneyFromTiyin(debtOffsetTiyin),
  };
}

/**
 * Deterministic canonical string for `voidSale` idempotency hashing.
 * Excludes supervisor PIN/credentials intentionally so retries hash identically.
 */
export function canonicalizeVoidSaleRequest(params: {
  readonly saleId: UuidV7;
  readonly reason: string;
}): string {
  return JSON.stringify([
    'mezon.void_sale.v1',
    parseUuidV7(params.saleId),
    normalizeMandatoryReason(params.reason),
  ]);
}

/**
 * Deterministic canonical string for `createReturn` idempotency hashing.
 * Excludes supervisor PIN/credentials intentionally.
 */
export function canonicalizeCreateReturnRequest(params: {
  readonly saleId: UuidV7;
  readonly reason: string;
  readonly debtOffsetAmount?: Money;
  readonly items: readonly { readonly saleLineId: UuidV7; readonly qty: Quantity }[];
  readonly payments: readonly ReturnPaymentInput[];
}): string {
  const normalizedItems = [...params.items]
    .map((item) => ({
      saleLineId: parseUuidV7(item.saleLineId),
      qty: quantityToMilli(item.qty).toString(),
    }))
    .sort((a, b) => a.saleLineId.localeCompare(b.saleLineId));

  const normalizedPayments = [...params.payments]
    .map((p) => {
      const method = parsePaymentMethod(p.method);
      const amount = moneyToTiyin(p.amount).toString();
      const ref = method === 'cash' ? null : normalizePaymentProviderRef(p.providerRef);
      return [method, amount, ref] as const;
    })
    .sort((a, b) => {
      const m = a[0].localeCompare(b[0]);
      if (m !== 0) return m;
      const amt = a[1].localeCompare(b[1]);
      if (amt !== 0) return amt;
      return (a[2] ?? '').localeCompare(b[2] ?? '');
    });

  const debtOffset =
    params.debtOffsetAmount !== undefined ? moneyToTiyin(params.debtOffsetAmount).toString() : '0';

  return JSON.stringify([
    'mezon.create_return.v1',
    parseUuidV7(params.saleId),
    normalizeMandatoryReason(params.reason),
    debtOffset,
    normalizedItems,
    normalizedPayments,
  ]);
}
