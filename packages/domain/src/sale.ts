import { DomainError } from './errors.js';
import { type Money, ZERO_MONEY, moneyFromTiyin, moneyToTiyin } from './money.js';
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

export interface ValidatedCashPayment {
  readonly method: 'cash';
  readonly amount: Money;
  readonly tenderedAmount: Money;
  readonly changeAmount: Money;
}

export interface SalePaymentInvariantItem {
  readonly method: PaymentMethod;
  readonly amount: Money;
  readonly tenderedAmount: Money | null;
  readonly changeAmount: Money;
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
 * Validates single cash payment completion in T1.4 (`tenderedAmount >= totalFinal`), returning
 * the applied sale payment (`amount = totalFinal`) and exact cash change (`tendered - totalFinal`).
 */
export function validateCashSalePayment(params: {
  readonly totalFinal: Money;
  readonly tenderedAmount: Money;
}): ValidatedCashPayment {
  const totalTiyin = moneyToTiyin(params.totalFinal);
  const tenderedTiyin = moneyToTiyin(params.tenderedAmount);

  if (totalTiyin < 0n) {
    throw new DomainError('VALIDATION_ERROR', 'Sale total must not be negative');
  }
  if (tenderedTiyin < 0n) {
    throw new DomainError('VALIDATION_ERROR', 'Tendered cash amount must not be negative');
  }
  if (tenderedTiyin < totalTiyin) {
    throw new DomainError(
      'VALIDATION_ERROR',
      `Tendered cash (${tenderedTiyin.toString()} tiyin) is less than sale total (${totalTiyin.toString()} tiyin)`,
    );
  }

  return {
    method: 'cash',
    amount: params.totalFinal,
    tenderedAmount: params.tenderedAmount,
    changeAmount: moneyFromTiyin(tenderedTiyin - totalTiyin),
  };
}

/**
 * Enforces `SUM(payments.amount) + debtAmount === totalFinal`, cash tendered/change balance,
 * and zero change on non-cash methods (`GEMINI.md` T1.5 invariant kept intact from T1.4 onward).
 */
export function validateSalePaymentsInvariant(params: {
  readonly totalFinal: Money;
  readonly debtAmount: Money;
  readonly payments: readonly SalePaymentInvariantItem[];
}): void {
  const totalTiyin = moneyToTiyin(params.totalFinal);
  const debtTiyin = moneyToTiyin(params.debtAmount);
  if (totalTiyin < 0n || debtTiyin < 0n) {
    throw new DomainError('VALIDATION_ERROR', 'Sale total and debtAmount must not be negative');
  }

  let sumPaidTiyin = 0n;
  for (const p of params.payments) {
    const amt = moneyToTiyin(p.amount);
    const chg = moneyToTiyin(p.changeAmount);
    if (amt < 0n || chg < 0n) {
      throw new DomainError('VALIDATION_ERROR', 'Payment amount and change must not be negative');
    }

    if (p.method === 'cash') {
      if (p.tenderedAmount === null) {
        throw new DomainError('VALIDATION_ERROR', 'Cash payment requires tenderedAmount');
      }
      const tendered = moneyToTiyin(p.tenderedAmount);
      if (tendered < amt || tendered - chg !== amt) {
        throw new DomainError(
          'VALIDATION_ERROR',
          'Cash payment invariant violated: tenderedAmount - changeAmount must equal amount',
        );
      }
    } else {
      if (chg !== moneyToTiyin(ZERO_MONEY)) {
        throw new DomainError('VALIDATION_ERROR', 'Only cash payments may return change');
      }
    }

    sumPaidTiyin += amt;
  }

  if (sumPaidTiyin + debtTiyin !== totalTiyin) {
    throw new DomainError(
      'VALIDATION_ERROR',
      `Payment invariant violated: sum(payments)=${sumPaidTiyin.toString()} + debt=${debtTiyin.toString()} !== total=${totalTiyin.toString()}`,
    );
  }
}
