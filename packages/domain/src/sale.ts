import { DomainError } from './errors.js';
import { MAX_MONEY_TIYIN, type Money, ZERO_MONEY, moneyFromTiyin, moneyToTiyin } from './money.js';
import { type UuidV7, parseUuidV7 } from './uuidv7.js';

export const PAYMENT_METHODS = [
  'cash',
  'card',
  'uzqr',
  'payme',
  'click',
  'uzum',
  'social_card',
  'other',
] as const;

export type PaymentMethod = (typeof PAYMENT_METHODS)[number];
export type NonCashPaymentMethod = Exclude<PaymentMethod, 'cash'>;

export const CASH_MOVE_INFLOW_TYPES = ['sale_cash_in', 'debt_payment_in', 'cash_in'] as const;
export const CASH_MOVE_OUTFLOW_TYPES = [
  'sale_change_out',
  'refund_cash_out',
  'cash_out',
  'encashment',
] as const;
export const CASH_MOVE_TYPES = [...CASH_MOVE_INFLOW_TYPES, ...CASH_MOVE_OUTFLOW_TYPES] as const;

export type CashMoveInflowType = (typeof CASH_MOVE_INFLOW_TYPES)[number];
export type CashMoveOutflowType = (typeof CASH_MOVE_OUTFLOW_TYPES)[number];
export type CashMoveType = (typeof CASH_MOVE_TYPES)[number];

export const MAX_PROVIDER_REF_LENGTH = 128;

export interface ValidatedCashPayment {
  readonly method: 'cash';
  readonly amount: Money;
  readonly tenderedAmount: Money;
  readonly changeAmount: Money;
}

export type SalePaymentInput =
  | {
      readonly method: 'cash';
      readonly tenderedAmount: Money;
      readonly amount?: Money;
    }
  | {
      readonly method: NonCashPaymentMethod;
      readonly amount: Money;
      readonly providerRef?: string | null;
    };

export interface ResolvedSalePaymentItem {
  readonly method: PaymentMethod;
  readonly amount: Money;
  readonly tenderedAmount: Money | null;
  readonly changeAmount: Money;
  readonly providerRef: string | null;
}

export interface ResolvedSalePayments {
  readonly payments: readonly ResolvedSalePaymentItem[];
  readonly totalPaid: Money;
  readonly debtAmount: Money;
  readonly changeAmount: Money;
  readonly cashInAmount: Money;
  readonly cashChangeOutAmount: Money;
}

export interface SalePaymentInvariantItem {
  readonly method: PaymentMethod;
  readonly amount: Money;
  readonly tenderedAmount: Money | null;
  readonly changeAmount: Money;
}

export interface SalePaymentInvariantParams {
  readonly totalFinal: Money;
  readonly debtAmount: Money;
  readonly customerId?: UuidV7 | null;
  readonly payments: readonly SalePaymentInvariantItem[];
}

export function isPaymentMethod(value: unknown): value is PaymentMethod {
  return typeof value === 'string' && (PAYMENT_METHODS as readonly string[]).includes(value);
}

export function parsePaymentMethod(value: unknown): PaymentMethod {
  if (!isPaymentMethod(value)) {
    throw new DomainError('VALIDATION_ERROR', `Invalid payment method: "${String(value)}"`);
  }
  return value;
}

export function isCashMoveType(value: unknown): value is CashMoveType {
  return typeof value === 'string' && (CASH_MOVE_TYPES as readonly string[]).includes(value);
}

export function isCashMoveInflow(type: CashMoveType): type is CashMoveInflowType {
  return (CASH_MOVE_INFLOW_TYPES as readonly string[]).includes(type);
}

/**
 * Normalizes optional non-cash provider/terminal reference strings (`RRN`, QR tx id).
 * Empty or whitespace-only inputs collapse to `null`.
 */
export function normalizePaymentProviderRef(raw: string | null | undefined): string | null {
  if (raw === undefined || raw === null) {
    return null;
  }
  if (typeof raw !== 'string') {
    throw new DomainError('VALIDATION_ERROR', 'providerRef must be a string or null');
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return null;
  }
  if (trimmed.length > MAX_PROVIDER_REF_LENGTH) {
    throw new DomainError(
      'VALIDATION_ERROR',
      `providerRef must not exceed ${String(MAX_PROVIDER_REF_LENGTH)} characters`,
    );
  }
  return trimmed;
}

function assertBoundedNonNegative(tiyin: bigint, label: string): void {
  if (tiyin < 0n || tiyin > MAX_MONEY_TIYIN) {
    throw new DomainError(
      'VALIDATION_ERROR',
      `${label} must be between 0 and ${MAX_MONEY_TIYIN.toString()} tiyin`,
    );
  }
}

function assertBoundedPositive(tiyin: bigint, label: string): void {
  if (tiyin <= 0n || tiyin > MAX_MONEY_TIYIN) {
    throw new DomainError(
      'VALIDATION_ERROR',
      `${label} must be between 1 and ${MAX_MONEY_TIYIN.toString()} tiyin`,
    );
  }
}

/**
 * Formats a human-visible receipt code from the device identifier and monotonic `receipt_no`:
 * `<last 4 uppercase hex of deviceId>-<zero-padded >=6 digits>`.
 *
 * Note: This value is strictly for human display and printed receipts; receipt uniqueness is
 * enforced at the database level via `UNIQUE(organization_id, device_id, receipt_no)`.
 * When F4 terminal pairing introduces short terminal codes, formatting switches to that code.
 */
export function formatReceiptCode(deviceId: UuidV7, receiptNo: bigint): string {
  const validDeviceId = parseUuidV7(deviceId);
  if (receiptNo < 1n) {
    throw new DomainError('VALIDATION_ERROR', 'receiptNo must be a positive integer >= 1');
  }
  const deviceSuffix = validDeviceId.slice(-4).toUpperCase();
  const seqText = receiptNo.toString().padStart(6, '0');
  return `${deviceSuffix}-${seqText}`;
}

/**
 * Validates single cash payment completion (`tenderedAmount >= totalFinal > 0`), returning
 * the applied sale payment (`amount = totalFinal`) and exact cash change (`tendered - totalFinal`).
 */
export function validateCashSalePayment(params: {
  readonly totalFinal: Money;
  readonly tenderedAmount: Money;
}): ValidatedCashPayment {
  const resolved = resolveSalePayments({
    totalFinal: params.totalFinal,
    debtAmount: ZERO_MONEY,
    customerId: null,
    payments: [{ method: 'cash', tenderedAmount: params.tenderedAmount }],
  });
  validateSalePaymentsInvariant({
    totalFinal: params.totalFinal,
    debtAmount: ZERO_MONEY,
    customerId: null,
    payments: resolved.payments,
  });
  const cashRow = resolved.payments[0];
  if (!cashRow || cashRow.method !== 'cash' || cashRow.tenderedAmount === null) {
    throw new DomainError('VALIDATION_ERROR', 'Expected validated cash payment row');
  }
  return {
    method: 'cash',
    amount: cashRow.amount,
    tenderedAmount: cashRow.tenderedAmount,
    changeAmount: cashRow.changeAmount,
  };
}

/**
 * Resolves raw mixed payment inputs against server-recomputed `totalFinal` and `debtAmount`.
 *
 * Notice that cumulative invariant checks (`SUM(payments.amount) + debt === totalFinal`,
 * non-cash excess, `tendered >= amount`, and `customerId` requirement on `debt > 0`) are
 * intentionally enforced in `validateSalePaymentsInvariant` so callers (like `completeSale`)
 * keep `validateSalePaymentsInvariant` strictly load-bearing.
 */
export function resolveSalePayments(params: {
  readonly totalFinal: Money;
  readonly debtAmount: Money;
  readonly customerId: UuidV7 | null;
  readonly payments: readonly SalePaymentInput[];
}): ResolvedSalePayments {
  const totalTiyin = moneyToTiyin(params.totalFinal);
  const debtTiyin = moneyToTiyin(params.debtAmount);
  assertBoundedNonNegative(totalTiyin, 'totalFinal');
  assertBoundedNonNegative(debtTiyin, 'debtAmount');

  const rawPayments: unknown = params.payments;
  if (!Array.isArray(rawPayments)) {
    throw new DomainError('VALIDATION_ERROR', 'payments must be an array');
  }

  let cashCount = 0;
  let nonCashTotalTiyin = 0n;

  for (const row of params.payments) {
    parsePaymentMethod(row.method);
    if (row.method === 'cash') {
      cashCount += 1;
      if (cashCount > 1) {
        throw new DomainError(
          'VALIDATION_ERROR',
          'At most one cash payment row is allowed per sale',
        );
      }
      assertBoundedPositive(moneyToTiyin(row.tenderedAmount), 'cash.tenderedAmount');
      if (row.amount !== undefined) {
        assertBoundedPositive(moneyToTiyin(row.amount), 'cash.amount');
      }
    } else {
      assertBoundedPositive(moneyToTiyin(row.amount), `${row.method}.amount`);
      normalizePaymentProviderRef(row.providerRef);
      nonCashTotalTiyin += moneyToTiyin(row.amount);
    }
  }

  const remainingForCashTiyin = totalTiyin - debtTiyin - nonCashTotalTiyin;
  const resolved: ResolvedSalePaymentItem[] = [];
  let sumPaidTiyin = 0n;
  let totalChangeTiyin = 0n;
  let cashInTiyin = 0n;
  let cashChangeOutTiyin = 0n;

  for (const row of params.payments) {
    if (row.method === 'cash') {
      const tenderedTiyin = moneyToTiyin(row.tenderedAmount);
      const amountTiyin =
        row.amount !== undefined ? moneyToTiyin(row.amount) : remainingForCashTiyin;
      const changeTiyin = tenderedTiyin - amountTiyin;
      resolved.push({
        method: 'cash',
        amount: moneyFromTiyin(amountTiyin),
        tenderedAmount: row.tenderedAmount,
        changeAmount: moneyFromTiyin(changeTiyin),
        providerRef: null,
      });
      sumPaidTiyin += amountTiyin;
      totalChangeTiyin = changeTiyin;
      cashInTiyin = tenderedTiyin;
      cashChangeOutTiyin = changeTiyin;
    } else {
      const amountTiyin = moneyToTiyin(row.amount);
      resolved.push({
        method: row.method,
        amount: row.amount,
        tenderedAmount: null,
        changeAmount: ZERO_MONEY,
        providerRef: normalizePaymentProviderRef(row.providerRef),
      });
      sumPaidTiyin += amountTiyin;
    }
  }

  return {
    payments: resolved,
    totalPaid: moneyFromTiyin(sumPaidTiyin),
    debtAmount: params.debtAmount,
    changeAmount: moneyFromTiyin(totalChangeTiyin),
    cashInAmount: moneyFromTiyin(cashInTiyin),
    cashChangeOutAmount: moneyFromTiyin(cashChangeOutTiyin),
  };
}

/**
 * Enforces T1.5 payment invariants (`GEMINI.md` T1.5):
 * - All persisted amounts/change fit signed 64-bit SQL integers (`<= MAX_MONEY_TIYIN`).
 * - Zero and negative payment rows are rejected (`amount > 0`, `tendered > 0`).
 * - At most one `'cash'` row; non-cash rows carry `tenderedAmount = null` and `changeAmount = 0`.
 * - Non-cash total + debt cannot exceed `totalFinal` (change comes solely from cash).
 * - `debtAmount > 0` requires `customerId !== null` (`CUSTOMER_REQUIRED`).
 * - `SUM(payments.amount) + debtAmount === totalFinal` (vacuously true when `totalFinal === 0` and `payments === []`).
 */
export function validateSalePaymentsInvariant(params: SalePaymentInvariantParams): void {
  const totalTiyin = moneyToTiyin(params.totalFinal);
  const debtTiyin = moneyToTiyin(params.debtAmount);
  assertBoundedNonNegative(totalTiyin, 'totalFinal');
  assertBoundedNonNegative(debtTiyin, 'debtAmount');

  if (debtTiyin > 0n && (params.customerId === undefined || params.customerId === null)) {
    throw new DomainError(
      'CUSTOMER_REQUIRED',
      'Customer is required when sale includes debtAmount > 0',
    );
  }

  let cashCount = 0;
  let sumPaidTiyin = 0n;
  let nonCashTotalTiyin = 0n;

  for (const p of params.payments) {
    parsePaymentMethod(p.method);
    const amt = moneyToTiyin(p.amount);
    const chg = moneyToTiyin(p.changeAmount);
    assertBoundedPositive(amt, `${p.method}.amount`);
    assertBoundedNonNegative(chg, `${p.method}.changeAmount`);

    if (p.method === 'cash') {
      cashCount += 1;
      if (cashCount > 1) {
        throw new DomainError(
          'VALIDATION_ERROR',
          'At most one cash payment row is allowed per sale',
        );
      }
      if (p.tenderedAmount === null) {
        throw new DomainError('VALIDATION_ERROR', 'Cash payment requires tenderedAmount');
      }
      const tendered = moneyToTiyin(p.tenderedAmount);
      assertBoundedPositive(tendered, 'cash.tenderedAmount');
      if (tendered < amt || tendered - chg !== amt) {
        throw new DomainError(
          'VALIDATION_ERROR',
          'Cash payment invariant violated: tenderedAmount - changeAmount must equal amount',
        );
      }
    } else {
      if (p.tenderedAmount !== null) {
        throw new DomainError(
          'VALIDATION_ERROR',
          `Non-cash payment "${p.method}" must not include tenderedAmount`,
        );
      }
      if (chg !== 0n) {
        throw new DomainError('VALIDATION_ERROR', 'Only cash payments may return change');
      }
      nonCashTotalTiyin += amt;
    }

    sumPaidTiyin += amt;
  }

  if (nonCashTotalTiyin + debtTiyin > totalTiyin) {
    throw new DomainError(
      'VALIDATION_ERROR',
      'Non-cash payments plus debt cannot exceed sale total',
    );
  }

  if (sumPaidTiyin > MAX_MONEY_TIYIN || sumPaidTiyin + debtTiyin !== totalTiyin) {
    throw new DomainError(
      'VALIDATION_ERROR',
      `Payment invariant violated: sum(payments)=${sumPaidTiyin.toString()} + debt=${debtTiyin.toString()} !== total=${totalTiyin.toString()}`,
    );
  }
}

/**
 * Produces a deterministic canonical representation of a `completeSale` request payload so
 * `db-local` can detect conflicting payloads reusing the same `clientRequestId` via SHA-256.
 */
export function canonicalizeCompleteSaleRequest(params: {
  readonly cartId: UuidV7;
  readonly expectedTotal: Money;
  readonly debtAmount: Money;
  readonly customerId: UuidV7 | null;
  readonly payments: readonly SalePaymentInput[];
}): string {
  const normalizedPayments = params.payments.map((row) => {
    parsePaymentMethod(row.method);
    if (row.method === 'cash') {
      return [
        'cash',
        moneyToTiyin(row.tenderedAmount).toString(),
        row.amount !== undefined ? moneyToTiyin(row.amount).toString() : null,
      ] as const;
    }
    return [
      row.method,
      moneyToTiyin(row.amount).toString(),
      normalizePaymentProviderRef(row.providerRef),
    ] as const;
  });

  return JSON.stringify([
    'mezon.complete_sale.v1',
    parseUuidV7(params.cartId),
    moneyToTiyin(params.expectedTotal).toString(),
    moneyToTiyin(params.debtAmount).toString(),
    params.customerId !== null ? parseUuidV7(params.customerId) : null,
    normalizedPayments,
  ]);
}
