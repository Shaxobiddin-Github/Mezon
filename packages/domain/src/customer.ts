import { normalizeCatalogSearchText } from './catalog.js';
import { type UnixMs, unixMsFromBigInt, unixMsToBigInt } from './clock.js';
import { DomainError } from './errors.js';
import {
  MAX_MONEY_TIYIN,
  type Money,
  isSignedInt64Money,
  moneyFromTiyin,
  moneyToTiyin,
} from './money.js';
import {
  DEFAULT_STORE_TIMEZONE,
  addDaysToBusinessDateKey,
  assertValidStoreTimeZone,
  createEmptyPaymentMethodMap,
  epochDaysFromCivilDate,
  getBusinessDateKey,
  getStartOfBusinessDayMs,
  normalizeMandatoryReason,
} from './return.js';
import { type PaymentMethod, normalizePaymentProviderRef, parsePaymentMethod } from './sale.js';
import { type UuidV7, parseUuidV7 } from './uuidv7.js';

export const CUSTOMER_LEDGER_ENTRY_TYPES = [
  'opening_balance',
  'sale_debt',
  'debt_payment',
  'return_offset',
  'adjustment',
] as const;

export type CustomerLedgerEntryType = (typeof CUSTOMER_LEDGER_ENTRY_TYPES)[number];

export const CUSTOMER_LEDGER_SOURCE_TYPES = [
  'opening_balance',
  'sale',
  'debt_payment',
  'sale_void',
  'return',
  'adjustment',
] as const;

export type CustomerLedgerSourceType = (typeof CUSTOMER_LEDGER_SOURCE_TYPES)[number];

export const DEFAULT_CUSTOMER_DUE_DAYS = 14;
export const MAX_CUSTOMER_DUE_DAYS = 3650;
export const MAX_CUSTOMER_NAME_LENGTH = 200;
export const MAX_CUSTOMER_NOTE_LENGTH = 500;
export const MAX_LEDGER_REASON_LENGTH = 500;

export type CustomerLedgerOperationKind =
  'opening_balance' | 'sale_debt' | 'debt_payment' | 'return_offset' | 'sale_void' | 'adjustment';

export interface NormalizedCustomerPhone {
  readonly phoneNormalized: string;
  readonly phoneDigits: string;
}

export interface LedgerEntryForFifo {
  readonly id: UuidV7;
  readonly hlc: string;
  readonly createdAtMs: UnixMs;
  readonly entryType: CustomerLedgerEntryType;
  readonly amountDelta: Money;
  readonly sourceType: CustomerLedgerSourceType;
  readonly saleId: UuidV7 | null;
  readonly paymentMethod: PaymentMethod | null;
  readonly dueAtMs: UnixMs | null;
}

export interface CustomerDebtObligationSummary {
  readonly ledgerEntryId: UuidV7;
  readonly entryType: 'opening_balance' | 'sale_debt' | 'adjustment';
  readonly hlc: string;
  readonly createdAtMs: UnixMs;
  readonly saleId: UuidV7 | null;
  readonly dueAtMs: UnixMs | null;
  readonly initialDebt: Money;
  readonly remainingDebt: Money;
  readonly returnOffsetTotal: Money;
  readonly fifoPaidTotal: Money;
  readonly fifoWaivedTotal: Money;
  readonly fifoPaidByMethod: Readonly<Record<PaymentMethod, Money>>;
  readonly isOverdue: boolean;
  readonly daysOverdue: bigint;
}

export interface CustomerLedgerFifoResult {
  readonly balance: Money;
  readonly totalDebtAccrued: Money;
  readonly totalSettled: Money;
  readonly overdueAmount: Money;
  readonly oldestOverdueDays: bigint;
  readonly earliestOpenDueAtMs: UnixMs | null;
  readonly obligations: readonly CustomerDebtObligationSummary[];
  readonly bySaleId: ReadonlyMap<UuidV7, CustomerDebtObligationSummary>;
}

/**
 * Normalizes and validates a customer's display name (`full_name`).
 * PII rule: never interpolate the raw name into error messages.
 */
export function normalizeCustomerFullName(raw: string): string {
  if (typeof raw !== 'string') {
    throw new DomainError('VALIDATION_ERROR', 'Customer fullName must be a string');
  }
  const trimmed = raw.trim().replace(/\s+/g, ' ');
  if (trimmed.length === 0 || trimmed.length > MAX_CUSTOMER_NAME_LENGTH) {
    throw new DomainError(
      'VALIDATION_ERROR',
      `Customer fullName must be between 1 and ${String(MAX_CUSTOMER_NAME_LENGTH)} characters`,
    );
  }
  return trimmed;
}

/**
 * Normalizes optional customer notes. PII rule: never interpolate content into error messages.
 */
export function normalizeCustomerNote(raw: string | null | undefined): string | null {
  if (raw === undefined || raw === null) {
    return null;
  }
  if (typeof raw !== 'string') {
    throw new DomainError('VALIDATION_ERROR', 'Customer note must be a string');
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return null;
  }
  if (trimmed.length > MAX_CUSTOMER_NOTE_LENGTH) {
    throw new DomainError(
      'VALIDATION_ERROR',
      `Customer note must not exceed ${String(MAX_CUSTOMER_NOTE_LENGTH)} characters`,
    );
  }
  return trimmed;
}

/**
 * Normalizes optional due-days override (`1..3650`).
 */
export function normalizeCustomerDueDays(raw: number | null | undefined): number | null {
  if (raw === undefined || raw === null) {
    return null;
  }
  if (
    typeof raw !== 'number' ||
    Math.trunc(raw) !== raw ||
    raw < 1 ||
    raw > MAX_CUSTOMER_DUE_DAYS
  ) {
    throw new DomainError(
      'VALIDATION_ERROR',
      `dueDays must be an integer between 1 and ${String(MAX_CUSTOMER_DUE_DAYS)}`,
    );
  }
  return raw;
}

/**
 * Normalizes phone numbers to canonical E.164 format without echoing PII in error messages:
 * - Local Uzbekistan 9-digit forms (`90 123-45-67`) and `998XXXXXXXXX` -> `+998XXXXXXXXX`
 * - Explicit `+`-prefixed international numbers (e.g. `+77011234567`, `+992901234567`) -> `^\+[1-9]\d{7,14}$`
 */
export function normalizeCustomerPhone(
  raw: string | null | undefined,
): NormalizedCustomerPhone | null {
  if (raw === undefined || raw === null) {
    return null;
  }
  if (typeof raw !== 'string') {
    throw new DomainError('VALIDATION_ERROR', 'Customer phone must be a string');
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return null;
  }

  const compact = trimmed.replace(/[\s\-().]/g, '');
  if (compact.startsWith('+')) {
    if (!/^\+[1-9]\d{7,14}$/.test(compact)) {
      throw new DomainError(
        'VALIDATION_ERROR',
        'Customer phone must be a valid E.164 number (+country and 8..15 digits)',
      );
    }
    return {
      phoneNormalized: compact,
      phoneDigits: compact.slice(1),
    };
  }

  if (/^\d{9}$/.test(compact)) {
    const normalized = `+998${compact}`;
    return {
      phoneNormalized: normalized,
      phoneDigits: normalized.slice(1),
    };
  }
  if (/^998\d{9}$/.test(compact)) {
    return {
      phoneNormalized: `+${compact}`,
      phoneDigits: compact,
    };
  }

  throw new DomainError(
    'VALIDATION_ERROR',
    'Customer phone without "+" must be a 9-digit local UZ number or 998XXXXXXXXX',
  );
}

/**
 * Reuses T1.1 Latin/Cyrillic text normalization so customer search behaves consistently across scripts.
 */
export function normalizeCustomerSearchText(input: string): string {
  return normalizeCatalogSearchText(input);
}

/**
 * Extracts digit tokens and normalized name tokens for fast hybrid FTS5 / phone search.
 */
export function normalizeCustomerSearchQuery(rawQuery: string): {
  readonly textQuery: string;
  readonly digitsOnly: string;
} {
  const digitsOnly = rawQuery.replace(/\D/g, '');
  return {
    textQuery: normalizeCatalogSearchText(rawQuery),
    digitsOnly,
  };
}

/**
 * Validates credit limit when present (`>= 0n`, bounded to signed 64-bit SQL integer max).
 */
export function assertValidCreditLimit(creditLimit: Money | null | undefined): Money | null {
  if (creditLimit === undefined || creditLimit === null) {
    return null;
  }
  const tiyin = moneyToTiyin(creditLimit);
  if (tiyin < 0n || tiyin > MAX_MONEY_TIYIN) {
    throw new DomainError(
      'VALIDATION_ERROR',
      `creditLimit must be between 0 and ${MAX_MONEY_TIYIN.toString()} tiyin`,
    );
  }
  return creditLimit;
}

/**
 * Computes exact store-timezone `dueAtMs` when a debt transitions into overdue state (`00:00:00.000`
 * on the day immediately following `saleDate + dueDays`). Returns `null` when `dueDays === null`.
 */
export function computeDebtDueAtMs(params: {
  readonly createdAtMs: UnixMs;
  readonly dueDays: number | null;
  readonly storeTimezone?: string;
  readonly resolveTimeZoneDateKey?: (unixMs: UnixMs, tz: string) => string;
}): UnixMs | null {
  const validDueDays = normalizeCustomerDueDays(params.dueDays);
  if (validDueDays === null) {
    return null;
  }
  const tz = assertValidStoreTimeZone(params.storeTimezone ?? DEFAULT_STORE_TIMEZONE);
  const startDateKey = getBusinessDateKey(params.createdAtMs, tz, params.resolveTimeZoneDateKey);
  const lastOnTimeDateKey = addDaysToBusinessDateKey(startDateKey, BigInt(validDueDays));
  const overdueStartDateKey = addDaysToBusinessDateKey(lastOnTimeDateKey, 1n);
  return getStartOfBusinessDayMs(overdueStartDateKey, tz, params.resolveTimeZoneDateKey);
}

/**
 * Computes integer overdue days (`0n` when not yet overdue or when `dueAtMs === null`, `>= 1n` once overdue).
 */
export function computeOverdueDaysAt(params: {
  readonly asOfMs: UnixMs;
  readonly dueAtMs: UnixMs | null;
  readonly storeTimezone?: string;
  readonly resolveTimeZoneDateKey?: (unixMs: UnixMs, tz: string) => string;
}): bigint {
  if (params.dueAtMs === null) {
    return 0n;
  }
  const asOf = unixMsToBigInt(params.asOfMs);
  const due = unixMsToBigInt(params.dueAtMs);
  if (asOf < due) {
    return 0n;
  }
  const tz = assertValidStoreTimeZone(params.storeTimezone ?? DEFAULT_STORE_TIMEZONE);
  const asOfKey = getBusinessDateKey(params.asOfMs, tz, params.resolveTimeZoneDateKey);
  const overdueStartKey = getBusinessDateKey(params.dueAtMs, tz, params.resolveTimeZoneDateKey);
  const diff = epochDaysFromCivilDate(asOfKey) - epochDaysFromCivilDate(overdueStartKey);
  return diff >= 0n ? diff + 1n : 1n;
}

/**
 * D1: Single shared balance invariant guard invoked before EVERY write to `customer_ledger`.
 * Enforces the policy that customer debt balance on a local hub is NEVER negative (`balance >= 0`).
 *
 * F2 SYNC CONFLICT NOTE (D5):
 * Credit limit checks, unique `opening_balance`, and `balance >= 0` overpayment prevention are
 * guaranteed locally per hub while offline. In F2 multi-store sync, concurrent offline operations on
 * two hubs against the same customer can legitimately produce post-sync conflicts without discarding
 * immutable `FACT` sales/payments:
 * 1. Concurrent offline debt sales exceeding `credit_limit` -> surfaced in admin panel as `CREDIT_LIMIT_EXCEEDED_SYNC`.
 * 2. Concurrent offline `opening_balance` entries -> cloud sync detects partial-unique collision -> parked/flagged `DUPLICATE_OPENING_BALANCE`.
 * 3. Concurrent offline debt payments causing `SUM(customer_ledger) < 0` -> surfaced as `OVERPAYMENT_CONFLICT` in `apps/admin` for owner resolution (manual adjustment/refund).
 */
export function computeNextCustomerBalance(params: {
  readonly currentBalance: Money;
  readonly delta: Money;
  readonly operation: CustomerLedgerOperationKind;
  readonly saleRemainingDebt?: Money;
}): Money {
  const cur = moneyToTiyin(params.currentBalance);
  const delta = moneyToTiyin(params.delta);

  if (cur < 0n || !isSignedInt64Money(cur) || !isSignedInt64Money(delta)) {
    throw new DomainError('VALIDATION_ERROR', 'Customer ledger balance or delta out of bounds');
  }

  const next = cur + delta;
  if (!isSignedInt64Money(next)) {
    throw new DomainError(
      'VALIDATION_ERROR',
      `Resulting customer balance exceeds 64-bit SQL limit (${MAX_MONEY_TIYIN.toString()} tiyin)`,
    );
  }

  switch (params.operation) {
    case 'opening_balance':
    case 'sale_debt': {
      if (delta <= 0n) {
        throw new DomainError(
          'VALIDATION_ERROR',
          `Ledger "${params.operation}" delta must be strictly positive`,
        );
      }
      break;
    }
    case 'debt_payment': {
      if (delta >= 0n) {
        throw new DomainError('VALIDATION_ERROR', 'Debt payment delta must be strictly negative');
      }
      if (next < 0n) {
        throw new DomainError(
          'OVERPAYMENT_NOT_ALLOWED',
          `Payment (${(-delta).toString()} tiyin) exceeds current customer debt (${cur.toString()} tiyin)`,
          {
            details: {
              currentBalance: cur.toString(),
              paymentAmount: (-delta).toString(),
            },
          },
        );
      }
      break;
    }
    case 'return_offset': {
      if (delta > 0n) {
        throw new DomainError('VALIDATION_ERROR', 'return_offset delta must not be positive');
      }
      const offsetAbs = -delta;
      if (params.saleRemainingDebt !== undefined) {
        const rem = moneyToTiyin(params.saleRemainingDebt);
        if (offsetAbs > rem) {
          throw new DomainError(
            'RETURN_DEBT_OFFSET_EXCEEDED',
            `Requested debt offset (${offsetAbs.toString()}) exceeds remaining sale debt (${rem.toString()})`,
            {
              details: {
                requestedDebtOffset: offsetAbs.toString(),
                remainingSaleDebt: rem.toString(),
              },
            },
          );
        }
      }
      if (next < 0n) {
        throw new DomainError(
          'RETURN_DEBT_OFFSET_EXCEEDED',
          `Debt offset (${offsetAbs.toString()}) would push customer balance negative`,
        );
      }
      break;
    }
    case 'sale_void': {
      if (delta > 0n) {
        throw new DomainError('VALIDATION_ERROR', 'sale_void debt reversal must not be positive');
      }
      const voidAbs = -delta;
      if (
        params.saleRemainingDebt !== undefined &&
        voidAbs > moneyToTiyin(params.saleRemainingDebt)
      ) {
        throw new DomainError(
          'SALE_DEBT_HAS_PAYMENTS',
          'Cannot void debt sale that has already received FIFO debt payments or reductions',
          {
            details: {
              saleDebtAmount: voidAbs.toString(),
              remainingSaleDebt: moneyToTiyin(params.saleRemainingDebt).toString(),
            },
          },
        );
      }
      if (next < 0n) {
        throw new DomainError(
          'SALE_DEBT_HAS_PAYMENTS',
          'Cannot void debt sale: insufficient remaining customer balance',
        );
      }
      break;
    }
    case 'adjustment': {
      if (delta === 0n) {
        throw new DomainError('VALIDATION_ERROR', 'Adjustment delta must be non-zero');
      }
      if (delta < 0n && next < 0n) {
        throw new DomainError(
          'OVERPAYMENT_NOT_ALLOWED',
          `Negative adjustment (${(-delta).toString()} tiyin) exceeds current customer debt (${cur.toString()} tiyin)`,
          {
            details: {
              currentBalance: cur.toString(),
              adjustmentMagnitude: (-delta).toString(),
            },
          },
        );
      }
      break;
    }
  }

  // Final D1 non-negative invariant guard shared by all ledger write paths
  if (next < 0n) {
    throw new DomainError(
      'OVERPAYMENT_NOT_ALLOWED',
      'Customer debt balance cannot become negative',
    );
  }

  return moneyFromTiyin(next);
}

/**
 * Evaluates credit limit policy when issuing a credit sale (`debtAmount > 0`).
 * Standard checkout rejects `currentBalance + debtAmount > creditLimit` with `CREDIT_LIMIT_EXCEEDED` (409),
 * unless authorized by an owner/manager supervisor override (`creditOverrideAuthorized: true`).
 */
export function assertCreditLimitForSale(params: {
  readonly currentBalance: Money;
  readonly newDebtAmount: Money;
  readonly creditLimit: Money | null;
  readonly creditOverrideAuthorized: boolean;
}): void {
  const newDebt = moneyToTiyin(params.newDebtAmount);
  if (newDebt <= 0n || params.creditLimit === null) {
    return;
  }
  const cur = moneyToTiyin(params.currentBalance);
  const limit = moneyToTiyin(params.creditLimit);
  if (cur + newDebt > limit && !params.creditOverrideAuthorized) {
    throw new DomainError(
      'CREDIT_LIMIT_EXCEEDED',
      `Projected debt (${(cur + newDebt).toString()}) exceeds customer credit limit (${limit.toString()})`,
      {
        details: {
          currentBalance: cur.toString(),
          newDebtAmount: newDebt.toString(),
          projectedBalance: (cur + newDebt).toString(),
          creditLimit: limit.toString(),
        },
      },
    );
  }
}

/**
 * D2 + D3: Deterministic single-pass O(N) FIFO replay of a customer's `customer_ledger` history.
 *
 * - Sorting (D2): Strictly sorts entries by `(hlc ASC, id ASC)` — NEVER insertion order or `createdAtMs` —
 *   matching stock replay so F2 cross-device sync arrives at an identical deterministic allocation on all hubs.
 * - Positive adjustment semantics (D3): A positive `adjustment` (`amountDelta > 0`) appends a standalone
 *   debit obligation at its chronological `hlc` slot (`saleId = null`). Its `dueAtMs` is optional (`null`
 *   unless explicitly requested when creating the adjustment), so manual upward adjustments do NOT trigger
 *   instant overdue flags unless a term was explicitly given, yet participate normally in FIFO payoff order.
 * - Negative adjustment semantics (D3): Forgiving debt (`amountDelta < 0`) reduces open obligations FIFO
 *   from oldest `hlc` forward (`fifoWaivedTotal`).
 * - Direct `return_offset`: Immediately targets its matching `saleId` obligation.
 * - Cash/non-cash `debt_payment`: Consumes remaining obligations FIFO (`fifoHead` O(N) pointer), crediting
 *   `fifoPaidByMethod[paymentMethod]` on each obligation for downstream `createReturn` / `voidSale` caps.
 */
export function allocateCustomerLedgerFifo(params: {
  readonly entries: readonly LedgerEntryForFifo[];
  readonly asOfMs: UnixMs;
  readonly storeTimezone?: string;
  readonly resolveTimeZoneDateKey?: (unixMs: UnixMs, tz: string) => string;
}): CustomerLedgerFifoResult {
  const tz = assertValidStoreTimeZone(params.storeTimezone ?? DEFAULT_STORE_TIMEZONE);
  const sorted = [...params.entries].sort((a, b) => {
    if (a.hlc < b.hlc) return -1;
    if (a.hlc > b.hlc) return 1;
    if (a.id < b.id) return -1;
    if (a.id > b.id) return 1;
    return 0;
  });

  interface MutableObligation {
    readonly ledgerEntryId: UuidV7;
    readonly entryType: 'opening_balance' | 'sale_debt' | 'adjustment';
    readonly hlc: string;
    readonly createdAtMs: UnixMs;
    readonly saleId: UuidV7 | null;
    readonly dueAtMs: UnixMs | null;
    readonly initialDebt: bigint;
    remainingDebt: bigint;
    returnOffsetTotal: bigint;
    fifoPaidTotal: bigint;
    fifoWaivedTotal: bigint;
    readonly fifoPaidByMethodMilli: Record<PaymentMethod, bigint>;
  }

  const obligations: MutableObligation[] = [];
  const obBySaleId = new Map<UuidV7, MutableObligation>();
  let fifoHead = 0;

  let runningBalanceTiyin = 0n;
  let totalDebtAccruedTiyin = 0n;
  let totalSettledTiyin = 0n;

  for (const entry of sorted) {
    const delta = moneyToTiyin(entry.amountDelta);
    runningBalanceTiyin += delta;

    if (
      entry.entryType === 'opening_balance' ||
      entry.entryType === 'sale_debt' ||
      (entry.entryType === 'adjustment' && delta > 0n)
    ) {
      if (delta <= 0n) {
        throw new DomainError(
          'VALIDATION_ERROR',
          `Debit ledger entry "${entry.entryType}" must carry positive amountDelta`,
        );
      }
      totalDebtAccruedTiyin += delta;
      const ob: MutableObligation = {
        ledgerEntryId: entry.id,
        entryType: entry.entryType,
        hlc: entry.hlc,
        createdAtMs: entry.createdAtMs,
        saleId: entry.saleId,
        dueAtMs: entry.dueAtMs,
        initialDebt: delta,
        remainingDebt: delta,
        returnOffsetTotal: 0n,
        fifoPaidTotal: 0n,
        fifoWaivedTotal: 0n,
        fifoPaidByMethodMilli: {
          cash: 0n,
          card: 0n,
          uzqr: 0n,
          payme: 0n,
          click: 0n,
          uzum: 0n,
          social_card: 0n,
          other: 0n,
        },
      };
      obligations.push(ob);
      if (entry.saleId !== null && entry.entryType === 'sale_debt') {
        obBySaleId.set(entry.saleId, ob);
      }
      continue;
    }

    if (entry.entryType === 'return_offset') {
      if (delta > 0n) {
        throw new DomainError('VALIDATION_ERROR', 'return_offset amountDelta cannot be positive');
      }
      const absDelta = -delta;
      totalSettledTiyin += absDelta;
      if (entry.saleId !== null) {
        const target = obBySaleId.get(entry.saleId);
        if (target && absDelta > 0n) {
          const applied = absDelta <= target.remainingDebt ? absDelta : target.remainingDebt;
          target.remainingDebt -= applied;
          target.returnOffsetTotal += applied;
        }
      }
      continue;
    }

    // `debt_payment` or negative `adjustment` (< 0): FIFO allocation using O(N) `fifoHead` pointer
    if (delta >= 0n) {
      throw new DomainError(
        'VALIDATION_ERROR',
        `Credit ledger entry "${entry.entryType}" must carry negative amountDelta`,
      );
    }
    let toAllocate = -delta;
    totalSettledTiyin += toAllocate;
    const isPayment = entry.entryType === 'debt_payment';
    const method = isPayment ? entry.paymentMethod : null;

    while (toAllocate > 0n && fifoHead < obligations.length) {
      const ob = obligations[fifoHead];
      if (!ob || ob.remainingDebt <= 0n) {
        fifoHead += 1;
        continue;
      }
      const chunk = toAllocate <= ob.remainingDebt ? toAllocate : ob.remainingDebt;
      ob.remainingDebt -= chunk;
      toAllocate -= chunk;
      if (isPayment && method !== null) {
        ob.fifoPaidTotal += chunk;
        ob.fifoPaidByMethodMilli[method] += chunk;
      } else {
        ob.fifoWaivedTotal += chunk;
      }
      if (ob.remainingDebt === 0n) {
        fifoHead += 1;
      }
    }
  }

  let overdueAmountTiyin = 0n;
  let oldestOverdueDays = 0n;
  let earliestOpenDueAtBig: bigint | null = null;

  const summaries: CustomerDebtObligationSummary[] = [];
  const bySaleId = new Map<UuidV7, CustomerDebtObligationSummary>();

  for (const ob of obligations) {
    const daysOverdue =
      ob.remainingDebt > 0n
        ? computeOverdueDaysAt({
            asOfMs: params.asOfMs,
            dueAtMs: ob.dueAtMs,
            storeTimezone: tz,
            resolveTimeZoneDateKey: params.resolveTimeZoneDateKey,
          })
        : 0n;
    const isOverdue = ob.remainingDebt > 0n && daysOverdue > 0n;

    if (ob.remainingDebt > 0n && ob.dueAtMs !== null) {
      const dueBig = unixMsToBigInt(ob.dueAtMs);
      if (earliestOpenDueAtBig === null || dueBig < earliestOpenDueAtBig) {
        earliestOpenDueAtBig = dueBig;
      }
    }
    if (isOverdue) {
      overdueAmountTiyin += ob.remainingDebt;
      if (daysOverdue > oldestOverdueDays) {
        oldestOverdueDays = daysOverdue;
      }
    }

    const paidByMethod = createEmptyPaymentMethodMap();
    paidByMethod.cash = moneyFromTiyin(ob.fifoPaidByMethodMilli.cash);
    paidByMethod.card = moneyFromTiyin(ob.fifoPaidByMethodMilli.card);
    paidByMethod.uzqr = moneyFromTiyin(ob.fifoPaidByMethodMilli.uzqr);
    paidByMethod.payme = moneyFromTiyin(ob.fifoPaidByMethodMilli.payme);
    paidByMethod.click = moneyFromTiyin(ob.fifoPaidByMethodMilli.click);
    paidByMethod.uzum = moneyFromTiyin(ob.fifoPaidByMethodMilli.uzum);
    paidByMethod.social_card = moneyFromTiyin(ob.fifoPaidByMethodMilli.social_card);
    paidByMethod.other = moneyFromTiyin(ob.fifoPaidByMethodMilli.other);

    const summary: CustomerDebtObligationSummary = {
      ledgerEntryId: ob.ledgerEntryId,
      entryType: ob.entryType,
      hlc: ob.hlc,
      createdAtMs: ob.createdAtMs,
      saleId: ob.saleId,
      dueAtMs: ob.dueAtMs,
      initialDebt: moneyFromTiyin(ob.initialDebt),
      remainingDebt: moneyFromTiyin(ob.remainingDebt),
      returnOffsetTotal: moneyFromTiyin(ob.returnOffsetTotal),
      fifoPaidTotal: moneyFromTiyin(ob.fifoPaidTotal),
      fifoWaivedTotal: moneyFromTiyin(ob.fifoWaivedTotal),
      fifoPaidByMethod: paidByMethod,
      isOverdue,
      daysOverdue,
    };
    summaries.push(summary);
    if (ob.saleId !== null && ob.entryType === 'sale_debt') {
      bySaleId.set(ob.saleId, summary);
    }
  }

  return {
    balance: moneyFromTiyin(runningBalanceTiyin),
    totalDebtAccrued: moneyFromTiyin(totalDebtAccruedTiyin),
    totalSettled: moneyFromTiyin(totalSettledTiyin),
    overdueAmount: moneyFromTiyin(overdueAmountTiyin),
    oldestOverdueDays,
    earliestOpenDueAtMs:
      earliestOpenDueAtBig !== null ? unixMsFromBigInt(earliestOpenDueAtBig) : null,
    obligations: summaries,
    bySaleId,
  };
}

/**
 * Deterministic canonical string for one-time `opening_balance` idempotency hashing.
 */
export function canonicalizeOpeningBalanceRequest(params: {
  readonly customerId: UuidV7;
  readonly amount: Money;
  readonly reason: string;
  readonly dueDays: number | null;
}): string {
  const validAmount = moneyToTiyin(params.amount);
  if (validAmount <= 0n || validAmount > MAX_MONEY_TIYIN) {
    throw new DomainError('VALIDATION_ERROR', 'opening_balance amount must be strictly positive');
  }
  return JSON.stringify([
    'mezon.customer.opening_balance.v1',
    parseUuidV7(params.customerId),
    validAmount.toString(),
    normalizeMandatoryReason(params.reason),
    normalizeCustomerDueDays(params.dueDays),
  ]);
}

/**
 * Deterministic canonical string for `debt_payment` idempotency hashing.
 */
export function canonicalizeDebtPaymentRequest(params: {
  readonly customerId: UuidV7;
  readonly method: PaymentMethod;
  readonly amount: Money;
  readonly providerRef?: string | null;
  readonly reason?: string | null;
}): string {
  const method = parsePaymentMethod(params.method);
  const amt = moneyToTiyin(params.amount);
  if (amt <= 0n || amt > MAX_MONEY_TIYIN) {
    throw new DomainError('VALIDATION_ERROR', 'debt_payment amount must be strictly positive');
  }
  const ref = method === 'cash' ? null : normalizePaymentProviderRef(params.providerRef);
  const note = params.reason !== undefined && params.reason !== null ? params.reason.trim() : null;
  return JSON.stringify([
    'mezon.customer.debt_payment.v1',
    parseUuidV7(params.customerId),
    method,
    amt.toString(),
    ref,
    note !== null && note.length > 0 ? note : null,
  ]);
}

/**
 * Deterministic canonical string for manual `adjustment` idempotency hashing.
 */
export function canonicalizeDebtAdjustmentRequest(params: {
  readonly customerId: UuidV7;
  readonly amountDelta: Money;
  readonly reason: string;
  readonly dueDays: number | null;
}): string {
  const delta = moneyToTiyin(params.amountDelta);
  if (delta === 0n || !isSignedInt64Money(delta)) {
    throw new DomainError(
      'VALIDATION_ERROR',
      'adjustment amountDelta must be non-zero signed 64-bit money',
    );
  }
  return JSON.stringify([
    'mezon.customer.adjustment.v1',
    parseUuidV7(params.customerId),
    delta.toString(),
    normalizeMandatoryReason(params.reason),
    normalizeCustomerDueDays(params.dueDays),
  ]);
}
