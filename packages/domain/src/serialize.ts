import { DomainError } from './errors.js';
import type { Money } from './money.js';
import type { Quantity } from './quantity.js';

const MAX_STRING_LENGTH = 30;
const CANONICAL_INT_REGEX = /^(0|-?[1-9][0-9]*)$/;
const DECIMAL_MONEY_REGEX = /^(-)?(0|[1-9][0-9]*)(?:\.([0-9]{1,2}))?$/;
const DECIMAL_QUANTITY_REGEX = /^(-)?(0|[1-9][0-9]*)(?:\.([0-9]{1,3}))?$/;

function validateRawString(raw: string): void {
  if (typeof raw !== 'string' || raw.length === 0) {
    throw new DomainError('INVALID_SERIALIZED_STRING');
  }
  if (raw.length > MAX_STRING_LENGTH) {
    throw new DomainError('STRING_TOO_LONG');
  }
}

export function serializeMoney(money: Money): string {
  return (money as bigint).toString();
}

export function parseMoney(raw: string): Money {
  validateRawString(raw);
  if (!CANONICAL_INT_REGEX.test(raw)) {
    throw new DomainError('INVALID_SERIALIZED_STRING');
  }
  return BigInt(raw) as Money;
}

export function serializeQuantity(quantity: Quantity): string {
  return (quantity as bigint).toString();
}

export function parseQuantity(raw: string): Quantity {
  validateRawString(raw);
  if (!CANONICAL_INT_REGEX.test(raw)) {
    throw new DomainError('INVALID_SERIALIZED_STRING');
  }
  return BigInt(raw) as Quantity;
}

/**
 * Formats Money into a decimal string with exactly 2 decimal places.
 * e.g. 5n -> "0.05", -50n -> "-0.50", 1234567n -> "12345.67".
 */
export function formatMoneyDecimal(money: Money): string {
  const val = money as bigint;
  const isNegative = val < 0n;
  const absVal = isNegative ? -val : val;
  const intPart = absVal / 100n;
  const fracPart = absVal % 100n;
  const fracStr = fracPart < 10n ? '0' + fracPart.toString() : fracPart.toString();
  return (isNegative ? '-' : '') + intPart.toString() + '.' + fracStr;
}

/**
 * Parses a decimal string (up to 2 fractional digits) into Money (tiyin).
 * Rejects comma, trailing/leading dots, negative zero, leading zeroes in int part, > 2 decimals.
 */
export function parseMoneyDecimal(raw: string): Money {
  validateRawString(raw);
  const match = DECIMAL_MONEY_REGEX.exec(raw);
  if (!match) {
    throw new DomainError('INVALID_DECIMAL_FORMAT');
  }
  const isNegative = match[1] === '-';
  const intStr = match[2];
  const fracStr = match[3];

  let fracTiyin = 0n;
  if (fracStr !== undefined) {
    if (fracStr.length === 1) {
      fracTiyin = BigInt(fracStr) * 10n;
    } else {
      fracTiyin = BigInt(fracStr);
    }
  }

  const intTiyin = BigInt(intStr) * 100n;
  const total = intTiyin + fracTiyin;

  if (isNegative && total === 0n) {
    throw new DomainError('INVALID_DECIMAL_FORMAT');
  }

  return (isNegative ? -total : total) as Money;
}

/**
 * Formats Quantity into a decimal string with exactly 3 decimal places.
 * e.g. -500n -> "-0.500", 5500n -> "5.500".
 */
export function formatQuantityDecimal(quantity: Quantity): string {
  const val = quantity as bigint;
  const isNegative = val < 0n;
  const absVal = isNegative ? -val : val;
  const intPart = absVal / 1000n;
  const fracPart = absVal % 1000n;
  let fracStr = fracPart.toString();
  while (fracStr.length < 3) {
    fracStr = '0' + fracStr;
  }
  return (isNegative ? '-' : '') + intPart.toString() + '.' + fracStr;
}

/**
 * Parses a decimal string (up to 3 fractional digits) into Quantity (milli-units).
 * Rejects comma, trailing/leading dots, negative zero, leading zeroes in int part, > 3 decimals.
 */
export function parseQuantityDecimal(raw: string): Quantity {
  validateRawString(raw);
  const match = DECIMAL_QUANTITY_REGEX.exec(raw);
  if (!match) {
    throw new DomainError('INVALID_DECIMAL_FORMAT');
  }
  const isNegative = match[1] === '-';
  const intStr = match[2];
  const fracStr = match[3];

  let fracMilli = 0n;
  if (fracStr !== undefined) {
    if (fracStr.length === 1) {
      fracMilli = BigInt(fracStr) * 100n;
    } else if (fracStr.length === 2) {
      fracMilli = BigInt(fracStr) * 10n;
    } else {
      fracMilli = BigInt(fracStr);
    }
  }

  const intMilli = BigInt(intStr) * 1000n;
  const total = intMilli + fracMilli;

  if (isNegative && total === 0n) {
    throw new DomainError('INVALID_DECIMAL_FORMAT');
  }

  return (isNegative ? -total : total) as Quantity;
}
