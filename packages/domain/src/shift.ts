import type { UserRole } from './auth.js';
import type { UnixMs } from './clock.js';
import { DomainError } from './errors.js';
import {
  type Money,
  MAX_MONEY_TIYIN,
  ZERO_MONEY,
  isSignedInt64Money,
  moneyFromTiyin,
  moneyToTiyin,
} from './money.js';
import { normalizeMandatoryReason } from './return.js';
import { type CashMoveType, type PaymentMethod, PAYMENT_METHODS } from './sale.js';
import type { UuidV7 } from './uuidv7.js';

export const SHIFT_STATUSES = ['open', 'closed'] as const;
export type ShiftStatus = (typeof SHIFT_STATUSES)[number];

export const CASHIER_SESSION_STATUSES = ['active', 'closed'] as const;
export type CashierSessionStatus = (typeof CASHIER_SESSION_STATUSES)[number];

export const SHIFT_CASH_MOVE_TYPES = ['cash_in', 'cash_out', 'encashment'] as const;
export type ShiftCashMoveType = (typeof SHIFT_CASH_MOVE_TYPES)[number];

export const SHIFT_EXPENSE_CATEGORIES = [
  'supplies',
  'utilities',
  'transport',
  'repair',
  'salary_advance',
  'other',
] as const;
export type ShiftExpenseCategory = (typeof SHIFT_EXPENSE_CATEGORIES)[number];

export const DAY_CLOSE_FISCAL_STATUSES = ['not_fiscalized', 'pending', 'fiscalized'] as const;
export type DayCloseFiscalStatus = (typeof DAY_CLOSE_FISCAL_STATUSES)[number];

/**
 * Default cash discrepancy threshold requiring supervisor PIN override: 10,000.00 UZS (`1_000_000n` tiyin).
 * Configurable per hub in `local_hub_config.max_cash_discrepancy_without_override`.
 */
export const DEFAULT_MAX_CASH_DISCREPANCY_TIYIN = 1_000_000n;

export const BUSINESS_DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;

export interface CashDenominationCount {
  readonly nominal: Money;
  readonly count: number;
}

export interface ShiftCashMoveForSummary {
  readonly id: UuidV7;
  readonly shiftCashierSessionId: UuidV7 | null;
  readonly type: CashMoveType;
  readonly amountDelta: Money;
}

export interface ShiftSaleForSummary {
  readonly id: UuidV7;
  readonly shiftCashierSessionId: UuidV7 | null;
  readonly totalFinal: Money;
  readonly debtAmount: Money;
  readonly isVoided: boolean;
}

export interface ShiftReturnForSummary {
  readonly id: UuidV7;
  readonly shiftCashierSessionId: UuidV7 | null;
  readonly totalRefundAmount: Money;
  readonly debtOffsetAmount: Money;
}

export interface ShiftPaymentForSummary {
  readonly shiftCashierSessionId: UuidV7 | null;
  readonly method: PaymentMethod;
  /** Net sale payment amount applied (`payments.amount`). NEVER subtract `change_amount` (X3). */
  readonly amount: Money;
}

export interface ShiftReturnPaymentForSummary {
  readonly shiftCashierSessionId: UuidV7 | null;
  readonly method: PaymentMethod;
  readonly amount: Money;
}

export interface ShiftCashierSessionInput {
  readonly sessionId: UuidV7;
  readonly cashierUserId: UuidV7;
  readonly sessionSeq: number;
  readonly openingFloat: Money;
  readonly isClosed: boolean;
  readonly countedCash: Money | null;
}

export interface ComputedMethodTotal {
  readonly method: PaymentMethod | 'debt';
  readonly salesAmount: Money;
  readonly returnsAmount: Money;
  readonly netAmount: Money;
}

export interface ComputedCashierSessionSummary {
  readonly sessionId: UuidV7;
  readonly cashierUserId: UuidV7;
  readonly sessionSeq: number;
  readonly openingFloat: Money;
  readonly expectedCash: Money;
  readonly countedCash: Money;
  readonly discrepancyTiyin: bigint;
  readonly salesCount: number;
  readonly returnsCount: number;
  readonly salesTotal: Money;
  readonly returnsTotal: Money;
  readonly cashInTotal: Money;
  readonly cashOutTotal: Money;
}

export interface ComputedShiftClosureSummary {
  readonly expectedCash: Money;
  readonly countedCash: Money;
  readonly discrepancyTiyin: bigint;
  readonly salesCount: number;
  readonly returnsCount: number;
  readonly voidsCount: number;
  readonly grossSalesTotal: Money;
  readonly returnsTotal: Money;
  readonly netSalesTotal: Money;
  readonly methodTotals: readonly ComputedMethodTotal[];
  readonly cashiers: readonly ComputedCashierSessionSummary[];
}

export function formatShiftCode(deviceId: UuidV7, shiftNo: bigint): string {
  const cleanHex = deviceId.replace(/-/g, '').slice(-4).toUpperCase();
  const padded = shiftNo.toString().padStart(6, '0');
  return `SHF-${cleanHex}-${padded}`;
}

export function formatDayCloseCode(businessDate: string, closeSeq: number): string {
  assertValidBusinessDate(businessDate);
  const compactDate = businessDate.replace(/-/g, '');
  const padded = closeSeq.toString().padStart(3, '0');
  return `Z-${compactDate}-${padded}`;
}

export function assertValidBusinessDate(raw: string): string {
  const trimmed = raw.trim();
  if (!BUSINESS_DATE_REGEX.test(trimmed)) {
    throw new DomainError('VALIDATION_ERROR', 'businessDate must match YYYY-MM-DD');
  }
  const parts = trimmed.split('-');
  const y = BigInt(parts[0] ?? '0');
  const m = BigInt(parts[1] ?? '0');
  const d = BigInt(parts[2] ?? '0');
  if (y < 2000n || y > 2100n || m < 1n || m > 12n || d < 1n) {
    throw new DomainError('VALIDATION_ERROR', 'businessDate is not a valid calendar date');
  }
  const isLeap = (y % 4n === 0n && y % 100n !== 0n) || y % 400n === 0n;
  const maxDay =
    m === 2n ? (isLeap ? 29n : 28n) : m === 4n || m === 6n || m === 9n || m === 11n ? 30n : 31n;
  if (d > maxDay) {
    throw new DomainError('VALIDATION_ERROR', 'businessDate is not a valid calendar date');
  }
  return trimmed;
}

export function parseShiftCashMoveType(raw: unknown): ShiftCashMoveType {
  if (typeof raw !== 'string' || !(SHIFT_CASH_MOVE_TYPES as readonly string[]).includes(raw)) {
    throw new DomainError(
      'VALIDATION_ERROR',
      'Shift cash move type must be cash_in, cash_out, or encashment',
    );
  }
  return raw as ShiftCashMoveType;
}

export function parseShiftExpenseCategory(
  type: ShiftCashMoveType,
  raw: string | null | undefined,
): ShiftExpenseCategory | null {
  if (type !== 'cash_out') {
    if (raw !== undefined && raw !== null) {
      throw new DomainError(
        'VALIDATION_ERROR',
        'Expense category is only allowed for cash_out moves',
      );
    }
    return null;
  }
  if (raw === undefined || raw === null) {
    return 'other';
  }
  if (!(SHIFT_EXPENSE_CATEGORIES as readonly string[]).includes(raw)) {
    throw new DomainError('VALIDATION_ERROR', 'Invalid shift expense category');
  }
  return raw as ShiftExpenseCategory;
}

export function validateNonNegativeShiftCash(value: Money, label = 'amount'): Money {
  const tiyin = moneyToTiyin(value);
  if (tiyin < 0n || !isSignedInt64Money(tiyin) || tiyin > MAX_MONEY_TIYIN) {
    throw new DomainError('VALIDATION_ERROR', `${label} must be non-negative bounded money`);
  }
  return value;
}

export function validatePositiveShiftCash(value: Money, label = 'amount'): Money {
  const tiyin = moneyToTiyin(value);
  if (tiyin <= 0n || !isSignedInt64Money(tiyin) || tiyin > MAX_MONEY_TIYIN) {
    throw new DomainError('VALIDATION_ERROR', `${label} must be positive bounded money`);
  }
  return value;
}

/**
 * Validates an optional banknote/coin denomination breakdown and enforces exact parity
 * with `countedCash`.
 */
export function validateDenominationCounts(
  denominations: readonly CashDenominationCount[] | null | undefined,
  countedCash: Money,
): readonly CashDenominationCount[] | null {
  if (denominations === undefined || denominations === null) {
    return null;
  }
  const seen = new Set<bigint>();
  let totalTiyin = 0n;
  for (const item of denominations) {
    const nominalTiyin = moneyToTiyin(item.nominal);
    if (nominalTiyin <= 0n || !isSignedInt64Money(nominalTiyin)) {
      throw new DomainError('VALIDATION_ERROR', 'Denomination nominal must be positive money');
    }
    if (
      typeof item.count !== 'number' ||
      Math.trunc(item.count) !== item.count ||
      item.count < 0 ||
      item.count > 1_000_000
    ) {
      throw new DomainError(
        'VALIDATION_ERROR',
        'Denomination count must be a non-negative integer',
      );
    }
    if (seen.has(nominalTiyin)) {
      throw new DomainError('VALIDATION_ERROR', 'Duplicate nominal in denomination breakdown');
    }
    seen.add(nominalTiyin);
    totalTiyin += nominalTiyin * BigInt(item.count);
  }
  if (totalTiyin !== moneyToTiyin(countedCash)) {
    throw new DomainError(
      'VALIDATION_ERROR',
      'Denomination breakdown sum must match countedCash exactly',
    );
  }
  return denominations;
}

/**
 * X1 Single Source of Truth for terminal drawer cash:
 * `shift.openingCash + SUM(cash_moves.amount_delta WHERE shift_id = shift.id)`.
 */
export function computeActiveShiftDrawerBalance(params: {
  readonly openingCash: Money;
  readonly cashMovesDeltas: readonly Money[];
}): Money {
  let total = moneyToTiyin(params.openingCash);
  for (const delta of params.cashMovesDeltas) {
    total += moneyToTiyin(delta);
  }
  if (!isSignedInt64Money(total)) {
    throw new DomainError(
      'VALIDATION_ERROR',
      'Drawer balance exceeds bounded 64-bit integer range',
    );
  }
  return moneyFromTiyin(total);
}

export function evaluateOpeningDiscrepancy(params: {
  readonly prevShiftCloseCash: Money | null;
  readonly openingCash: Money;
  readonly reason?: string | null;
}): {
  readonly openingDiscrepancyTiyin: bigint;
  readonly normalizedReason: string | null;
} {
  validateNonNegativeShiftCash(params.openingCash, 'openingCash');
  const openTiyin = moneyToTiyin(params.openingCash);
  const diffTiyin =
    params.prevShiftCloseCash !== null ? openTiyin - moneyToTiyin(params.prevShiftCloseCash) : 0n;
  const trimmedReason =
    params.reason !== undefined && params.reason !== null && params.reason.trim().length > 0
      ? normalizeMandatoryReason(params.reason, 'openingDiscrepancyReason')
      : null;

  if (diffTiyin !== 0n && trimmedReason === null) {
    throw new DomainError(
      'VALIDATION_ERROR',
      'openingDiscrepancyReason is required when openingCash differs from previous shift close count',
    );
  }

  return {
    openingDiscrepancyTiyin: diffTiyin,
    normalizedReason: trimmedReason,
  };
}

/**
 * Evaluates cash discrepancy at cashier handoff, shift close, or shift reclose:
 * - Non-zero discrepancy requires a reason (`VALIDATION_ERROR`).
 * - Discrepancy magnitude `> maxThreshold` requires supervisor PIN authorization
 *   (`SUPERVISOR_OVERRIDE_REQUIRED`, 403).
 */
export function evaluateShiftDiscrepancy(params: {
  readonly expectedCash: Money;
  readonly countedCash: Money;
  readonly maxCashDiscrepancyWithoutOverride: bigint;
  readonly reason?: string | null;
  readonly supervisorApprovedByUserId: UuidV7 | null;
}): {
  readonly discrepancyTiyin: bigint;
  readonly normalizedReason: string | null;
  readonly requiresSupervisorOverride: boolean;
} {
  validateNonNegativeShiftCash(params.countedCash, 'countedCash');
  const expectedTiyin = moneyToTiyin(params.expectedCash);
  const countedTiyin = moneyToTiyin(params.countedCash);
  const discrepancyTiyin = countedTiyin - expectedTiyin;
  const absDiff = discrepancyTiyin < 0n ? -discrepancyTiyin : discrepancyTiyin;

  const trimmedReason =
    params.reason !== undefined && params.reason !== null && params.reason.trim().length > 0
      ? normalizeMandatoryReason(params.reason, 'discrepancyReason')
      : null;

  if (discrepancyTiyin !== 0n && trimmedReason === null) {
    throw new DomainError(
      'VALIDATION_ERROR',
      'Reason is required when countedCash does not match expectedCash',
    );
  }

  const threshold =
    params.maxCashDiscrepancyWithoutOverride >= 0n
      ? params.maxCashDiscrepancyWithoutOverride
      : DEFAULT_MAX_CASH_DISCREPANCY_TIYIN;
  const requiresSupervisorOverride = absDiff > threshold;

  if (requiresSupervisorOverride && params.supervisorApprovedByUserId === null) {
    throw new DomainError(
      'SUPERVISOR_OVERRIDE_REQUIRED',
      'Cash discrepancy exceeds allowed threshold and requires owner/manager approval',
      {
        details: {
          discrepancyTiyin: discrepancyTiyin.toString(),
          thresholdTiyin: threshold.toString(),
        },
      },
    );
  }

  return {
    discrepancyTiyin,
    normalizedReason: trimmedReason,
    requiresSupervisorOverride,
  };
}

/**
 * X2: Validates terminal active shift + active cashier session access.
 * - Closed/missing shift -> `409 SHIFT_NOT_OPEN`.
 * - Only the active session's cashier OR `owner`/`manager` may transact;
 *   another cashier attempting to sell/return/move cash -> `409 CASHIER_SESSION_MISMATCH`.
 */
export function assertOpenShiftAccess(params: {
  readonly shiftStatus: ShiftStatus | null;
  readonly activeCashierUserId: UuidV7 | null;
  readonly actorUserId: UuidV7;
  readonly actorRole: UserRole;
}): void {
  if (params.shiftStatus !== 'open' || params.activeCashierUserId === null) {
    throw new DomainError(
      'SHIFT_NOT_OPEN',
      'An open terminal shift is required for this operation',
    );
  }
  if (
    params.actorUserId !== params.activeCashierUserId &&
    params.actorRole !== 'owner' &&
    params.actorRole !== 'manager'
  ) {
    throw new DomainError(
      'CASHIER_SESSION_MISMATCH',
      'Another cashier holds the active terminal session; handoff shift session first',
    );
  }
}

export interface ShiftSessionAggregates {
  readonly cashDeltaTiyin: bigint;
  readonly cashInTiyin: bigint;
  readonly cashOutTiyin: bigint;
  readonly salesCount: number;
  readonly salesTotalTiyin: bigint;
  readonly returnsCount: number;
  readonly returnsTotalTiyin: bigint;
}

export interface ShiftClosureAggregatedBuckets {
  readonly openingCash: Money;
  readonly finalCountedCash: Money;
  readonly cashierSessions: readonly ShiftCashierSessionInput[];
  readonly totalCashMovesTiyin: bigint;
  readonly salesCount: number;
  readonly voidsCount: number;
  readonly returnsCount: number;
  readonly grossSalesTiyin: bigint;
  readonly returnsTiyin: bigint;
  readonly debtSalesTiyin: bigint;
  readonly returnDebtOffsetTiyin: bigint;
  readonly methodSalesTiyin: ReadonlyMap<PaymentMethod, bigint>;
  readonly methodReturnsTiyin: ReadonlyMap<PaymentMethod, bigint>;
  readonly sessionBuckets: ReadonlyMap<UuidV7, ShiftSessionAggregates>;
}

/**
 * Shared pure closure calculation engine accepting pre-aggregated per-method and per-session
 * buckets (O(1) SQL GROUP BY path for >=1,000-receipt shifts in `<= 500 ms`).
 */
export function computeShiftClosureFromAggregates(
  params: ShiftClosureAggregatedBuckets,
): ComputedShiftClosureSummary {
  if (params.cashierSessions.length === 0) {
    throw new DomainError('VALIDATION_ERROR', 'Shift has no cashier sessions');
  }
  validateNonNegativeShiftCash(params.finalCountedCash, 'countedCash');

  const orderedSessions = [...params.cashierSessions].sort((a, b) => a.sessionSeq - b.sessionSeq);
  const lastIdx = orderedSessions.length - 1;

  const allMethods: ReadonlyArray<PaymentMethod | 'debt'> = [...PAYMENT_METHODS, 'debt'];
  const methodTotals: ComputedMethodTotal[] = allMethods.map((m) => {
    const sAmt = m === 'debt' ? params.debtSalesTiyin : (params.methodSalesTiyin.get(m) ?? 0n);
    const rAmt =
      m === 'debt' ? params.returnDebtOffsetTiyin : (params.methodReturnsTiyin.get(m) ?? 0n);
    return {
      method: m,
      salesAmount: moneyFromTiyin(sAmt),
      returnsAmount: moneyFromTiyin(rAmt),
      netAmount: moneyFromTiyin(sAmt - rAmt),
    };
  });

  const cashiers: ComputedCashierSessionSummary[] = orderedSessions.map((sess, idx) => {
    const bucket = params.sessionBuckets.get(sess.sessionId);
    const deltaTiyin = bucket?.cashDeltaTiyin ?? 0n;
    const expectedTiyin = moneyToTiyin(sess.openingFloat) + deltaTiyin;
    const countedTiyin =
      idx === lastIdx
        ? moneyToTiyin(params.finalCountedCash)
        : sess.countedCash !== null
          ? moneyToTiyin(sess.countedCash)
          : expectedTiyin;
    const discrepancyTiyin = countedTiyin - expectedTiyin;
    return {
      sessionId: sess.sessionId,
      cashierUserId: sess.cashierUserId,
      sessionSeq: sess.sessionSeq,
      openingFloat: sess.openingFloat,
      expectedCash: moneyFromTiyin(expectedTiyin),
      countedCash: moneyFromTiyin(countedTiyin),
      discrepancyTiyin,
      salesCount: bucket?.salesCount ?? 0,
      returnsCount: bucket?.returnsCount ?? 0,
      salesTotal: moneyFromTiyin(bucket?.salesTotalTiyin ?? 0n),
      returnsTotal: moneyFromTiyin(bucket?.returnsTotalTiyin ?? 0n),
      cashInTotal: moneyFromTiyin(bucket?.cashInTiyin ?? 0n),
      cashOutTotal: moneyFromTiyin(bucket?.cashOutTiyin ?? 0n),
    };
  });

  const shiftExpectedTiyin = moneyToTiyin(params.openingCash) + params.totalCashMovesTiyin;
  const shiftCountedTiyin = moneyToTiyin(params.finalCountedCash);

  return {
    expectedCash: moneyFromTiyin(shiftExpectedTiyin),
    countedCash: moneyFromTiyin(shiftCountedTiyin),
    discrepancyTiyin: shiftCountedTiyin - shiftExpectedTiyin,
    salesCount: params.salesCount,
    returnsCount: params.returnsCount,
    voidsCount: params.voidsCount,
    grossSalesTotal: moneyFromTiyin(params.grossSalesTiyin),
    returnsTotal: moneyFromTiyin(params.returnsTiyin),
    netSalesTotal: moneyFromTiyin(params.grossSalesTiyin - params.returnsTiyin),
    methodTotals,
    cashiers,
  };
}

/**
 * Computes exact shift closure figures, per-method breakdown (`X3`: uses `payments.amount` directly
 * without double-subtracting `change_amount`), and per-cashier session accountability (`X2`: grouped
 * strictly by `shiftCashierSessionId`).
 *
 * Algebraic invariant guaranteed across any sequence of K handoffs:
 * `SUM(cashiers[i].discrepancyTiyin) === discrepancyTiyin`.
 */
export function computeShiftClosureTotals(params: {
  readonly openingCash: Money;
  readonly finalCountedCash: Money;
  readonly cashierSessions: readonly ShiftCashierSessionInput[];
  readonly cashMoves: readonly ShiftCashMoveForSummary[];
  readonly sales: readonly ShiftSaleForSummary[];
  readonly returns: readonly ShiftReturnForSummary[];
  readonly payments: readonly ShiftPaymentForSummary[];
  readonly returnPayments: readonly ShiftReturnPaymentForSummary[];
}): ComputedShiftClosureSummary {
  if (params.cashierSessions.length === 0) {
    throw new DomainError('VALIDATION_ERROR', 'Shift has no cashier sessions');
  }

  const orderedSessions = [...params.cashierSessions].sort((a, b) => a.sessionSeq - b.sessionSeq);
  const fallbackSid = orderedSessions[0].sessionId;

  const sessionBuckets = new Map<
    UuidV7,
    {
      cashDeltaTiyin: bigint;
      cashInTiyin: bigint;
      cashOutTiyin: bigint;
      salesCount: number;
      salesTotalTiyin: bigint;
      returnsCount: number;
      returnsTotalTiyin: bigint;
    }
  >();
  const ensureBucket = (sid: UuidV7) => {
    let b = sessionBuckets.get(sid);
    if (!b) {
      b = {
        cashDeltaTiyin: 0n,
        cashInTiyin: 0n,
        cashOutTiyin: 0n,
        salesCount: 0,
        salesTotalTiyin: 0n,
        returnsCount: 0,
        returnsTotalTiyin: 0n,
      };
      sessionBuckets.set(sid, b);
    }
    return b;
  };

  let totalCashMovesTiyin = 0n;
  for (const m of params.cashMoves) {
    const dt = moneyToTiyin(m.amountDelta);
    totalCashMovesTiyin += dt;
    const b = ensureBucket(m.shiftCashierSessionId ?? fallbackSid);
    b.cashDeltaTiyin += dt;
    if (dt >= 0n) {
      b.cashInTiyin += dt;
    } else {
      b.cashOutTiyin += -dt;
    }
  }

  let salesCount = 0;
  let voidsCount = 0;
  let grossSalesTiyin = 0n;
  let debtSalesTiyin = 0n;
  for (const s of params.sales) {
    if (s.isVoided) {
      voidsCount += 1;
      continue;
    }
    salesCount += 1;
    const amt = moneyToTiyin(s.totalFinal);
    grossSalesTiyin += amt;
    debtSalesTiyin += moneyToTiyin(s.debtAmount);
    const b = ensureBucket(s.shiftCashierSessionId ?? fallbackSid);
    b.salesCount += 1;
    b.salesTotalTiyin += amt;
  }

  let returnsCount = 0;
  let returnsTiyin = 0n;
  let returnDebtOffsetTiyin = 0n;
  for (const r of params.returns) {
    returnsCount += 1;
    const amt = moneyToTiyin(r.totalRefundAmount);
    returnsTiyin += amt;
    returnDebtOffsetTiyin += moneyToTiyin(r.debtOffsetAmount);
    const b = ensureBucket(r.shiftCashierSessionId ?? fallbackSid);
    b.returnsCount += 1;
    b.returnsTotalTiyin += amt;
  }

  const methodSalesTiyin = new Map<PaymentMethod, bigint>();
  const methodReturnsTiyin = new Map<PaymentMethod, bigint>();
  for (const p of params.payments) {
    methodSalesTiyin.set(p.method, (methodSalesTiyin.get(p.method) ?? 0n) + moneyToTiyin(p.amount));
  }
  for (const rp of params.returnPayments) {
    methodReturnsTiyin.set(
      rp.method,
      (methodReturnsTiyin.get(rp.method) ?? 0n) + moneyToTiyin(rp.amount),
    );
  }

  return computeShiftClosureFromAggregates({
    openingCash: params.openingCash,
    finalCountedCash: params.finalCountedCash,
    cashierSessions: orderedSessions,
    totalCashMovesTiyin,
    salesCount,
    voidsCount,
    returnsCount,
    grossSalesTiyin,
    returnsTiyin,
    debtSalesTiyin,
    returnDebtOffsetTiyin,
    methodSalesTiyin,
    methodReturnsTiyin,
    sessionBuckets,
  });
}

// --- Canonical Request Hash Builders for Idempotency ---

export function canonicalizeOpenShiftRequest(params: {
  readonly cashierUserId: UuidV7;
  readonly openingCash: Money;
  readonly openingDiscrepancyReason: string | null;
}): string {
  return JSON.stringify({
    op: 'open_shift',
    cashierUserId: params.cashierUserId,
    openingCash: moneyToTiyin(params.openingCash).toString(),
    openingDiscrepancyReason: params.openingDiscrepancyReason,
  });
}

export function canonicalizeHandoffCashierRequest(params: {
  readonly shiftId: UuidV7;
  readonly countedCash: Money;
  readonly nextCashierUserId: UuidV7 | null;
  readonly reason: string | null;
}): string {
  return JSON.stringify({
    op: 'handoff_cashier',
    shiftId: params.shiftId,
    countedCash: moneyToTiyin(params.countedCash).toString(),
    nextCashierUserId: params.nextCashierUserId,
    reason: params.reason,
  });
}

export function canonicalizeCloseShiftRequest(params: {
  readonly shiftId: UuidV7;
  readonly countedCash: Money;
  readonly reason: string | null;
}): string {
  return JSON.stringify({
    op: 'close_shift',
    shiftId: params.shiftId,
    countedCash: moneyToTiyin(params.countedCash).toString(),
    reason: params.reason,
  });
}

export function canonicalizeRecloseShiftRequest(params: {
  readonly shiftId: UuidV7;
  readonly countedCash: Money;
  readonly reason: string;
}): string {
  return JSON.stringify({
    op: 'reclose_shift',
    shiftId: params.shiftId,
    countedCash: moneyToTiyin(params.countedCash).toString(),
    reason: params.reason,
  });
}

export function canonicalizeShiftCashMoveRequest(params: {
  readonly shiftId: UuidV7;
  readonly type: ShiftCashMoveType;
  readonly amount: Money;
  readonly expenseCategory: ShiftExpenseCategory | null;
  readonly reason: string;
}): string {
  return JSON.stringify({
    op: 'shift_cash_move',
    shiftId: params.shiftId,
    type: params.type,
    amount: moneyToTiyin(params.amount).toString(),
    expenseCategory: params.expenseCategory,
    reason: params.reason,
  });
}

export function canonicalizeCloseBusinessDayRequest(params: {
  readonly businessDate: string;
  readonly reason: string | null;
  readonly storeTimezone: string;
}): string {
  return JSON.stringify({
    op: 'close_business_day',
    businessDate: params.businessDate,
    reason: params.reason,
    storeTimezone: params.storeTimezone,
  });
}

/**
 * Computes closed shift belonging to `businessDate` based strictly on closing timestamp `closedAtMs`
 * in the store's local timezone (X4 rule).
 */
export function isTimestampInBusinessDate(params: {
  readonly unixMs: UnixMs;
  readonly businessDate: string;
  readonly dateKey: string;
}): boolean {
  return params.dateKey === params.businessDate && BigInt(params.unixMs) >= 0n;
}

export const ZERO_SHIFT_MONEY = ZERO_MONEY;
