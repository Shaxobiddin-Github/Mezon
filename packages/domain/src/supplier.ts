import { normalizeCatalogSearchText } from './catalog.js';
import { type UnixMs, unixMsToBigInt } from './clock.js';
import {
  computeDebtDueAtMs,
  computeOverdueDaysAt,
  normalizeCustomerDueDays,
  normalizeCustomerPhone,
  type NormalizedCustomerPhone,
} from './customer.js';
import { DomainError } from './errors.js';
import {
  MAX_MONEY_TIYIN,
  type Money,
  ZERO_MONEY,
  isSignedInt64Money,
  moneyFromTiyin,
  moneyToTiyin,
} from './money.js';
import { type Quantity, quantityToMilli } from './quantity.js';
import {
  DEFAULT_STORE_TIMEZONE,
  assertValidStoreTimeZone,
  normalizeMandatoryReason,
} from './return.js';
import {
  MAX_PROVIDER_REF_LENGTH,
  type PaymentMethod,
  normalizePaymentProviderRef,
  parsePaymentMethod,
} from './sale.js';
import { type UuidV7, parseUuidV7 } from './uuidv7.js';

export const SUPPLIER_LEDGER_ENTRY_TYPES = [
  'opening_balance',
  'receiving_debt',
  'supplier_payment',
  'supplier_return',
  'adjustment',
] as const;

export type SupplierLedgerEntryType = (typeof SUPPLIER_LEDGER_ENTRY_TYPES)[number];

export const SUPPLIER_LEDGER_SOURCE_TYPES = [
  'opening_balance',
  'receiving',
  'receiving_cost_confirm',
  'supplier_payment',
  'supplier_return',
  'adjustment',
] as const;

export type SupplierLedgerSourceType = (typeof SUPPLIER_LEDGER_SOURCE_TYPES)[number];

export const RECEIVING_DRAFT_STATUSES = ['draft', 'posted', 'cancelled'] as const;
export type ReceivingDraftStatus = (typeof RECEIVING_DRAFT_STATUSES)[number];

export const DEFAULT_SUPPLIER_DUE_DAYS = 14;
export const MAX_SUPPLIER_DUE_DAYS = 3650;
export const MAX_SUPPLIER_NAME_LENGTH = 200;
export const MAX_SUPPLIER_CONTACT_LENGTH = 200;
export const MAX_SUPPLIER_NOTE_LENGTH = 500;
export const MAX_SUPPLIER_INVOICE_NO_LENGTH = 64;
export const MAX_BATCH_NUMBER_LENGTH = 64;
export const MAX_SUPPLIER_LEDGER_REASON_LENGTH = 500;
export const SUPPLIER_TIN_REGEX = /^\d{9}$/;

export type SupplierLedgerOperationKind =
  'opening_balance' | 'receiving_debt' | 'supplier_payment' | 'supplier_return' | 'adjustment';

export interface SupplierLedgerEntryForFifo {
  readonly id: UuidV7;
  readonly hlc: string;
  readonly createdAtMs: UnixMs;
  readonly entryType: SupplierLedgerEntryType;
  readonly amountDelta: Money;
  readonly sourceType: SupplierLedgerSourceType;
  readonly receivingId: UuidV7 | null;
  readonly paymentMethod: PaymentMethod | null;
  readonly dueAtMs: UnixMs | null;
}

export interface SupplierDebtObligationSummary {
  readonly ledgerEntryId: UuidV7;
  readonly entryType: 'opening_balance' | 'receiving_debt' | 'adjustment';
  readonly hlc: string;
  readonly createdAtMs: UnixMs;
  readonly receivingId: UuidV7 | null;
  readonly dueAtMs: UnixMs | null;
  readonly initialDebt: Money;
  readonly advanceApplied: Money;
  readonly paidOrReturnedTotal: Money;
  readonly waivedTotal: Money;
  readonly remainingDebt: Money;
  readonly isOverdue: boolean;
  readonly daysOverdue: bigint;
}

export interface SupplierLedgerFifoResult {
  /** Signed net balance: `> 0` we owe supplier; `=== 0` settled; `< 0` we hold prepayment/advance (`-advanceBalance`). */
  readonly balanceTiyin: bigint;
  /** Positive debt owed to supplier (`balanceTiyin > 0 ? balanceTiyin : 0n`). */
  readonly debtBalance: Money;
  /** Positive advance/prepayment balance held by supplier (`balanceTiyin < 0 ? -balanceTiyin : 0n`). */
  readonly advanceBalance: Money;
  readonly totalDebtAccrued: Money;
  readonly totalCredited: Money;
  readonly overdueAmount: Money;
  readonly oldestOverdueDays: bigint;
  readonly earliestOpenDueAtMs: UnixMs | null;
  readonly obligations: readonly SupplierDebtObligationSummary[];
  readonly byReceivingId: ReadonlyMap<UuidV7, SupplierDebtObligationSummary>;
}

/**
 * Normalizes and validates a supplier's legal/display name (`name`).
 * PII rule: never interpolate the raw name into error messages.
 */
export function normalizeSupplierName(raw: string): string {
  if (typeof raw !== 'string') {
    throw new DomainError('VALIDATION_ERROR', 'Supplier name must be a string');
  }
  const trimmed = raw.trim().replace(/\s+/g, ' ');
  if (trimmed.length === 0) {
    throw new DomainError('VALIDATION_ERROR', 'Supplier name must not be empty');
  }
  if (trimmed.length > MAX_SUPPLIER_NAME_LENGTH) {
    throw new DomainError(
      'VALIDATION_ERROR',
      `Supplier name must not exceed ${MAX_SUPPLIER_NAME_LENGTH.toString()} characters`,
    );
  }
  return trimmed;
}

/**
 * Validates and normalizes Uzbekistan 9-digit TIN (STIR/INN).
 * PII/Tax safety: raw TIN value is omitted from error text.
 */
export function normalizeSupplierTin(raw: string | null | undefined): string | null {
  if (raw === undefined || raw === null) {
    return null;
  }
  if (typeof raw !== 'string') {
    throw new DomainError('VALIDATION_ERROR', 'Supplier TIN must be a string or null');
  }
  const compact = raw.trim().replace(/[\s-]+/g, '');
  if (compact.length === 0) {
    return null;
  }
  if (!SUPPLIER_TIN_REGEX.test(compact)) {
    throw new DomainError('VALIDATION_ERROR', 'Supplier TIN (STIR) must consist of 9 digits');
  }
  return compact;
}

export function normalizeSupplierPhone(
  raw: string | null | undefined,
): NormalizedCustomerPhone | null {
  return normalizeCustomerPhone(raw);
}

export function normalizeSupplierContactPerson(raw: string | null | undefined): string | null {
  if (raw === undefined || raw === null) {
    return null;
  }
  if (typeof raw !== 'string') {
    throw new DomainError('VALIDATION_ERROR', 'Supplier contactPerson must be a string');
  }
  const trimmed = raw.trim().replace(/\s+/g, ' ');
  if (trimmed.length === 0) {
    return null;
  }
  if (trimmed.length > MAX_SUPPLIER_CONTACT_LENGTH) {
    throw new DomainError(
      'VALIDATION_ERROR',
      `Supplier contactPerson must not exceed ${MAX_SUPPLIER_CONTACT_LENGTH.toString()} characters`,
    );
  }
  return trimmed;
}

export function normalizeSupplierNote(raw: string | null | undefined): string | null {
  if (raw === undefined || raw === null) {
    return null;
  }
  if (typeof raw !== 'string') {
    throw new DomainError('VALIDATION_ERROR', 'Supplier note must be a string');
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return null;
  }
  if (trimmed.length > MAX_SUPPLIER_NOTE_LENGTH) {
    throw new DomainError(
      'VALIDATION_ERROR',
      `Supplier note must not exceed ${MAX_SUPPLIER_NOTE_LENGTH.toString()} characters`,
    );
  }
  return trimmed;
}

export function normalizeSupplierInvoiceNo(raw: string | null | undefined): string | null {
  if (raw === undefined || raw === null) {
    return null;
  }
  if (typeof raw !== 'string') {
    throw new DomainError('VALIDATION_ERROR', 'Supplier invoice number must be a string');
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return null;
  }
  if (trimmed.length > MAX_SUPPLIER_INVOICE_NO_LENGTH) {
    throw new DomainError(
      'VALIDATION_ERROR',
      `Supplier invoice number must not exceed ${MAX_SUPPLIER_INVOICE_NO_LENGTH.toString()} characters`,
    );
  }
  return trimmed;
}

export function normalizeSupplierDueDays(dueDays: number | null | undefined): number | null {
  return normalizeCustomerDueDays(dueDays);
}

export function normalizeBatchNumber(raw: string | null | undefined): string | null {
  if (raw === undefined || raw === null) {
    return null;
  }
  if (typeof raw !== 'string') {
    throw new DomainError('VALIDATION_ERROR', 'Batch number must be a string');
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return null;
  }
  if (trimmed.length > MAX_BATCH_NUMBER_LENGTH) {
    throw new DomainError(
      'VALIDATION_ERROR',
      `Batch number must not exceed ${MAX_BATCH_NUMBER_LENGTH.toString()} characters`,
    );
  }
  return trimmed;
}

export function normalizeSupplierSearchText(raw: string): string {
  return normalizeCatalogSearchText(raw);
}

export function normalizeSupplierSearchQuery(raw: string): string {
  return normalizeCatalogSearchText(raw);
}

export function formatReceivingCode(deviceId: UuidV7, receivingNo: bigint): string {
  const validDeviceId = parseUuidV7(deviceId);
  if (receivingNo < 1n) {
    throw new DomainError('VALIDATION_ERROR', 'receivingNo must be positive');
  }
  const deviceSuffix = validDeviceId.slice(-4).toUpperCase();
  const seqStr = receivingNo.toString().padStart(6, '0');
  return `RCV-${deviceSuffix}-${seqStr}`;
}

export function formatSupplierReturnCode(deviceId: UuidV7, returnNo: bigint): string {
  const validDeviceId = parseUuidV7(deviceId);
  if (returnNo < 1n) {
    throw new DomainError('VALIDATION_ERROR', 'returnNo must be positive');
  }
  const deviceSuffix = validDeviceId.slice(-4).toUpperCase();
  const seqStr = returnNo.toString().padStart(6, '0');
  return `SRT-${deviceSuffix}-${seqStr}`;
}

/**
 * Validates supplier payment method (disallows `social_card`, which is only valid for retail B2C sales).
 */
export function parseSupplierPaymentMethod(raw: unknown): PaymentMethod {
  const method = parsePaymentMethod(raw);
  if (method === 'social_card') {
    throw new DomainError('VALIDATION_ERROR', 'social_card cannot be used for supplier payments');
  }
  return method;
}

/**
 * Validates receiving line cost consistency:
 * - `costUnknown = true` -> `totalCostValue` MUST be `null` (or absent), and returns `ZERO_MONEY`.
 * - `costUnknown = false` -> `totalCostValue` MUST be non-null non-negative bounded money (`<= MAX_MONEY_TIYIN`).
 */
export function validateReceivingLineCostInput(params: {
  readonly costUnknown: boolean;
  readonly totalCostValue: Money | null | undefined;
}): Money {
  if (params.costUnknown) {
    if (params.totalCostValue !== undefined && params.totalCostValue !== null) {
      throw new DomainError(
        'VALIDATION_ERROR',
        'totalCostValue must be null when costUnknown is true',
      );
    }
    return ZERO_MONEY;
  }
  if (params.totalCostValue === undefined || params.totalCostValue === null) {
    throw new DomainError(
      'VALIDATION_ERROR',
      'totalCostValue is required when costUnknown is false',
    );
  }
  const tiyin = moneyToTiyin(params.totalCostValue);
  if (tiyin < 0n || tiyin > MAX_MONEY_TIYIN) {
    throw new DomainError('VALIDATION_ERROR', 'Receiving line totalCostValue out of bounds');
  }
  return params.totalCostValue;
}

export function computeSupplierDueAtMs(params: {
  readonly createdAtMs: UnixMs;
  readonly dueDays: number | null | undefined;
  readonly storeTimezone?: string;
  readonly resolveTimeZoneDateKey?: (unixMs: UnixMs, tz: string) => string;
}): UnixMs | null {
  return computeDebtDueAtMs({
    ...params,
    dueDays: params.dueDays ?? null,
  });
}

/**
 * Computes resulting signed supplier balance (`balance + delta`) enforcing SQLite 64-bit bounds.
 * Unlike retail customers (`D1`), suppliers PERMIT negative balance (`balance < 0` represents
 * prepayment / advance credit held by the supplier).
 */
export function computeNextSupplierBalance(params: {
  readonly currentBalanceTiyin: bigint;
  readonly deltaTiyin: bigint;
  readonly operation: SupplierLedgerOperationKind;
}): bigint {
  if (!isSignedInt64Money(params.currentBalanceTiyin) || !isSignedInt64Money(params.deltaTiyin)) {
    throw new DomainError('VALIDATION_ERROR', 'Supplier balance or delta out of 64-bit bounds');
  }

  switch (params.operation) {
    case 'opening_balance':
    case 'receiving_debt': {
      if (params.deltaTiyin <= 0n) {
        throw new DomainError(
          'VALIDATION_ERROR',
          `Supplier ledger "${params.operation}" delta must be positive`,
        );
      }
      break;
    }
    case 'supplier_payment':
    case 'supplier_return': {
      if (params.deltaTiyin >= 0n) {
        throw new DomainError(
          'VALIDATION_ERROR',
          `Supplier ledger "${params.operation}" delta must be negative`,
        );
      }
      break;
    }
    case 'adjustment': {
      if (params.deltaTiyin === 0n) {
        throw new DomainError('VALIDATION_ERROR', 'Supplier adjustment delta must be non-zero');
      }
      break;
    }
  }

  const next = params.currentBalanceTiyin + params.deltaTiyin;
  if (!isSignedInt64Money(next)) {
    throw new DomainError(
      'VALIDATION_ERROR',
      `Resulting supplier balance exceeds 64-bit SQL limit (${MAX_MONEY_TIYIN.toString()} tiyin)`,
    );
  }
  return next;
}

/**
 * Deterministic single-pass O(N) bi-directional HLC FIFO + Advance allocator for `supplier_ledger`.
 *
 * - Sorting: Strictly orders entries by `(hlc ASC, id ASC)` so F2 sync produces identical
 *   obligations, advances, and overdue sums across all store hubs.
 * - Advance (`unappliedAdvance`, i.e. negative net balance): Prepayments or supplier returns exceeding
 *   open debts accumulate in `unappliedAdvance`. When a subsequent `opening_balance`, `receiving_debt`,
 *   or positive `adjustment` arrives chronologically, `unappliedAdvance` automatically closes that
 *   obligation first; only any excess remains open (`remainingDebt > 0`) and participates in overdue checks.
 * - Positive `adjustment`: Opens a debit obligation at its `hlc` slot (`dueAtMs = null` by default
 *   unless explicit `dueDays` provided).
 * - Negative credits (`supplier_payment`, `supplier_return`, negative `adjustment`): Consume open
 *   obligations oldest `hlc` first (FIFO), rolling any surplus into `unappliedAdvance`.
 * - F2 SYNC CONFLICT NOTE: Duplicate `opening_balance` across offline hubs triggers cloud conflict
 *   detection (`DUPLICATE_OPENING_BALANCE`), while cash overpayment relies on per-terminal local drawer
 *   balance at issue time.
 */
export function allocateSupplierLedgerFifo(params: {
  readonly entries: readonly SupplierLedgerEntryForFifo[];
  readonly asOfMs: UnixMs;
  readonly storeTimezone?: string;
  readonly resolveTimeZoneDateKey?: (unixMs: UnixMs, tz: string) => string;
}): SupplierLedgerFifoResult {
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
    readonly entryType: 'opening_balance' | 'receiving_debt' | 'adjustment';
    readonly hlc: string;
    readonly createdAtMs: UnixMs;
    readonly receivingId: UuidV7 | null;
    readonly dueAtMs: UnixMs | null;
    readonly initialDebt: bigint;
    readonly advanceApplied: bigint;
    paidOrReturnedTotal: bigint;
    waivedTotal: bigint;
    remainingDebt: bigint;
  }

  const obligations: MutableObligation[] = [];
  const obByReceivingId = new Map<UuidV7, MutableObligation[]>();
  let fifoHead = 0;

  let runningBalanceTiyin = 0n;
  let unappliedAdvanceTiyin = 0n;
  let totalDebtAccruedTiyin = 0n;
  let totalCreditedTiyin = 0n;

  for (const entry of sorted) {
    const delta = moneyToTiyin(entry.amountDelta);
    runningBalanceTiyin += delta;

    if (
      entry.entryType === 'opening_balance' ||
      entry.entryType === 'receiving_debt' ||
      (entry.entryType === 'adjustment' && delta > 0n)
    ) {
      if (delta <= 0n) {
        throw new DomainError(
          'VALIDATION_ERROR',
          `Supplier debit ledger entry "${entry.entryType}" must carry positive amountDelta`,
        );
      }
      totalDebtAccruedTiyin += delta;
      const coveredByAdvance =
        unappliedAdvanceTiyin > 0n
          ? delta <= unappliedAdvanceTiyin
            ? delta
            : unappliedAdvanceTiyin
          : 0n;
      unappliedAdvanceTiyin -= coveredByAdvance;

      const ob: MutableObligation = {
        ledgerEntryId: entry.id,
        entryType: entry.entryType,
        hlc: entry.hlc,
        createdAtMs: entry.createdAtMs,
        receivingId: entry.receivingId,
        dueAtMs: entry.dueAtMs,
        initialDebt: delta,
        advanceApplied: coveredByAdvance,
        paidOrReturnedTotal: 0n,
        waivedTotal: 0n,
        remainingDebt: delta - coveredByAdvance,
      };
      obligations.push(ob);
      if (entry.receivingId !== null && entry.entryType === 'receiving_debt') {
        const list = obByReceivingId.get(entry.receivingId) ?? [];
        list.push(ob);
        obByReceivingId.set(entry.receivingId, list);
      }
      continue;
    }

    if (delta >= 0n) {
      throw new DomainError(
        'VALIDATION_ERROR',
        `Supplier credit ledger entry "${entry.entryType}" must carry negative amountDelta`,
      );
    }

    let creditRem = -delta;
    totalCreditedTiyin += creditRem;
    const isWaiver = entry.entryType === 'adjustment';

    while (creditRem > 0n && fifoHead < obligations.length) {
      const target = obligations[fifoHead];
      if (!target) break;
      if (target.remainingDebt <= 0n) {
        fifoHead += 1;
        continue;
      }
      const take = creditRem <= target.remainingDebt ? creditRem : target.remainingDebt;
      target.remainingDebt -= take;
      if (isWaiver) {
        target.waivedTotal += take;
      } else {
        target.paidOrReturnedTotal += take;
      }
      creditRem -= take;
      if (target.remainingDebt === 0n) {
        fifoHead += 1;
      }
    }

    if (creditRem > 0n) {
      unappliedAdvanceTiyin += creditRem;
    }
  }

  let overdueTiyin = 0n;
  let oldestOverdueDays = 0n;
  let earliestOpenDueAtMs: UnixMs | null = null;
  const finalized: SupplierDebtObligationSummary[] = [];

  for (const ob of obligations) {
    let isOverdue = false;
    let daysOverdue = 0n;

    if (ob.remainingDebt > 0n && ob.dueAtMs !== null) {
      if (
        earliestOpenDueAtMs === null ||
        unixMsToBigInt(ob.dueAtMs) < unixMsToBigInt(earliestOpenDueAtMs)
      ) {
        earliestOpenDueAtMs = ob.dueAtMs;
      }
      daysOverdue = computeOverdueDaysAt({
        dueAtMs: ob.dueAtMs,
        asOfMs: params.asOfMs,
        storeTimezone: tz,
        resolveTimeZoneDateKey: params.resolveTimeZoneDateKey,
      });
      if (daysOverdue > 0n) {
        isOverdue = true;
        overdueTiyin += ob.remainingDebt;
        if (daysOverdue > oldestOverdueDays) {
          oldestOverdueDays = daysOverdue;
        }
      }
    }

    finalized.push({
      ledgerEntryId: ob.ledgerEntryId,
      entryType: ob.entryType,
      hlc: ob.hlc,
      createdAtMs: ob.createdAtMs,
      receivingId: ob.receivingId,
      dueAtMs: ob.dueAtMs,
      initialDebt: moneyFromTiyin(ob.initialDebt),
      advanceApplied: moneyFromTiyin(ob.advanceApplied),
      paidOrReturnedTotal: moneyFromTiyin(ob.paidOrReturnedTotal),
      waivedTotal: moneyFromTiyin(ob.waivedTotal),
      remainingDebt: moneyFromTiyin(ob.remainingDebt),
      isOverdue,
      daysOverdue,
    });
  }

  const byReceivingId = new Map<UuidV7, SupplierDebtObligationSummary>();
  for (const item of finalized) {
    if (item.receivingId !== null && item.entryType === 'receiving_debt') {
      const existing = byReceivingId.get(item.receivingId);
      if (!existing) {
        byReceivingId.set(item.receivingId, item);
      } else {
        // Merge multiple debt confirmations for same receiving for summary lookup
        const mergedRem = moneyToTiyin(existing.remainingDebt) + moneyToTiyin(item.remainingDebt);
        const mergedInit = moneyToTiyin(existing.initialDebt) + moneyToTiyin(item.initialDebt);
        const mergedAdv = moneyToTiyin(existing.advanceApplied) + moneyToTiyin(item.advanceApplied);
        const mergedPaid =
          moneyToTiyin(existing.paidOrReturnedTotal) + moneyToTiyin(item.paidOrReturnedTotal);
        const mergedWaiv = moneyToTiyin(existing.waivedTotal) + moneyToTiyin(item.waivedTotal);
        byReceivingId.set(item.receivingId, {
          ...existing,
          initialDebt: moneyFromTiyin(mergedInit),
          advanceApplied: moneyFromTiyin(mergedAdv),
          paidOrReturnedTotal: moneyFromTiyin(mergedPaid),
          waivedTotal: moneyFromTiyin(mergedWaiv),
          remainingDebt: moneyFromTiyin(mergedRem),
          isOverdue: existing.isOverdue || item.isOverdue,
          daysOverdue:
            existing.daysOverdue >= item.daysOverdue ? existing.daysOverdue : item.daysOverdue,
        });
      }
    }
  }

  return {
    balanceTiyin: runningBalanceTiyin,
    debtBalance: runningBalanceTiyin > 0n ? moneyFromTiyin(runningBalanceTiyin) : ZERO_MONEY,
    advanceBalance: runningBalanceTiyin < 0n ? moneyFromTiyin(-runningBalanceTiyin) : ZERO_MONEY,
    totalDebtAccrued: moneyFromTiyin(totalDebtAccruedTiyin),
    totalCredited: moneyFromTiyin(totalCreditedTiyin),
    overdueAmount: moneyFromTiyin(overdueTiyin),
    oldestOverdueDays,
    earliestOpenDueAtMs,
    obligations: finalized,
    byReceivingId,
  };
}

export function canonicalizePostReceivingRequest(params: {
  readonly draftId: UuidV7;
  readonly supplierId: UuidV7;
  readonly supplierInvoiceNo: string | null;
  readonly dueDays: number | null;
  readonly linesSnapshot: readonly {
    readonly productId: UuidV7;
    readonly variantId: UuidV7 | null;
    readonly qty: Quantity;
    readonly costUnknown: boolean;
    readonly totalCostValue: Money;
  }[];
}): string {
  return JSON.stringify([
    'mezon.receiving.post.v1',
    parseUuidV7(params.draftId),
    parseUuidV7(params.supplierId),
    normalizeSupplierInvoiceNo(params.supplierInvoiceNo),
    normalizeSupplierDueDays(params.dueDays),
    params.linesSnapshot.map((l) => [
      parseUuidV7(l.productId),
      l.variantId !== null ? parseUuidV7(l.variantId) : null,
      quantityToMilli(l.qty).toString(),
      l.costUnknown,
      moneyToTiyin(l.totalCostValue).toString(),
    ]),
  ]);
}

export function canonicalizeConfirmReceivingCostRequest(params: {
  readonly receivingId: UuidV7;
  readonly receivingLineId: UuidV7;
  readonly confirmedTotalCost: Money;
  readonly reason: string;
  readonly dueDays: number | null;
}): string {
  const cost = moneyToTiyin(params.confirmedTotalCost);
  if (cost < 0n || cost > MAX_MONEY_TIYIN) {
    throw new DomainError('VALIDATION_ERROR', 'confirmedTotalCost out of bounds');
  }
  return JSON.stringify([
    'mezon.receiving.confirm_cost.v1',
    parseUuidV7(params.receivingId),
    parseUuidV7(params.receivingLineId),
    cost.toString(),
    normalizeMandatoryReason(params.reason),
    normalizeSupplierDueDays(params.dueDays),
  ]);
}

export function canonicalizeSupplierReturnRequest(params: {
  readonly receivingId: UuidV7;
  readonly reason: string;
  readonly items: readonly { readonly receivingLineId: UuidV7; readonly qty: Quantity }[];
}): string {
  const sortedItems = [...params.items]
    .map((i) => ({
      receivingLineId: parseUuidV7(i.receivingLineId),
      qty: quantityToMilli(i.qty),
    }))
    .sort((a, b) =>
      a.receivingLineId < b.receivingLineId ? -1 : a.receivingLineId > b.receivingLineId ? 1 : 0,
    );
  return JSON.stringify([
    'mezon.supplier_return.create.v1',
    parseUuidV7(params.receivingId),
    normalizeMandatoryReason(params.reason),
    sortedItems.map((i) => [i.receivingLineId, i.qty.toString()]),
  ]);
}

export function canonicalizeSupplierOpeningBalanceRequest(params: {
  readonly supplierId: UuidV7;
  readonly amount: Money;
  readonly reason: string;
  readonly dueDays: number | null;
}): string {
  const amt = moneyToTiyin(params.amount);
  if (amt <= 0n || amt > MAX_MONEY_TIYIN) {
    throw new DomainError(
      'VALIDATION_ERROR',
      'Supplier opening_balance amount must be strictly positive',
    );
  }
  return JSON.stringify([
    'mezon.supplier.opening_balance.v1',
    parseUuidV7(params.supplierId),
    amt.toString(),
    normalizeMandatoryReason(params.reason),
    normalizeSupplierDueDays(params.dueDays),
  ]);
}

export function canonicalizeSupplierPaymentRequest(params: {
  readonly supplierId: UuidV7;
  readonly method: PaymentMethod;
  readonly amount: Money;
  readonly providerRef?: string | null;
  readonly reason?: string | null;
}): string {
  const method = parseSupplierPaymentMethod(params.method);
  const amt = moneyToTiyin(params.amount);
  if (amt <= 0n || amt > MAX_MONEY_TIYIN) {
    throw new DomainError('VALIDATION_ERROR', 'Supplier payment amount must be strictly positive');
  }
  const ref = method === 'cash' ? null : normalizePaymentProviderRef(params.providerRef);
  const note = params.reason !== undefined && params.reason !== null ? params.reason.trim() : null;
  if (note !== null && note.length > MAX_SUPPLIER_LEDGER_REASON_LENGTH) {
    throw new DomainError('VALIDATION_ERROR', 'Reason exceeds maximum length');
  }
  return JSON.stringify([
    'mezon.supplier.payment.v1',
    parseUuidV7(params.supplierId),
    method,
    amt.toString(),
    ref,
    note !== null && note.length > 0 ? note : null,
  ]);
}

export function canonicalizeSupplierAdjustmentRequest(params: {
  readonly supplierId: UuidV7;
  readonly amountDeltaTiyin: bigint;
  readonly reason: string;
  readonly dueDays: number | null;
}): string {
  if (params.amountDeltaTiyin === 0n || !isSignedInt64Money(params.amountDeltaTiyin)) {
    throw new DomainError('VALIDATION_ERROR', 'Supplier adjustment delta must be non-zero int64');
  }
  return JSON.stringify([
    'mezon.supplier.adjustment.v1',
    parseUuidV7(params.supplierId),
    params.amountDeltaTiyin.toString(),
    normalizeMandatoryReason(params.reason),
    normalizeSupplierDueDays(params.dueDays),
  ]);
}

export function parseSupplierProviderRef(
  method: PaymentMethod,
  raw: string | null | undefined,
): string | null {
  const ref = normalizePaymentProviderRef(raw);
  if (method === 'cash' && ref !== null) {
    throw new DomainError('VALIDATION_ERROR', 'Cash supplier payment must not carry providerRef');
  }
  if (ref !== null && ref.length > MAX_PROVIDER_REF_LENGTH) {
    throw new DomainError('VALIDATION_ERROR', 'providerRef exceeds max length');
  }
  return ref;
}
