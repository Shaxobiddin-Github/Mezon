import { DomainError } from './errors.js';
import type { Money } from './money.js';
import type { Quantity } from './quantity.js';

/**
 * Divides numerator by denominator with round-half-away-from-zero rounding.
 * Strictly symmetric across signs: divideRoundHalfAwayFromZero(-n, d) === -divideRoundHalfAwayFromZero(n, d).
 */
export function divideRoundHalfAwayFromZero(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= 0n) {
    throw new DomainError('INVALID_DENOMINATOR');
  }
  const isNegative = numerator < 0n;
  const absN = isNegative ? -numerator : numerator;
  let quotient = absN / denominator;
  const remainder = absN % denominator;
  if (2n * remainder >= denominator) {
    quotient += 1n;
  }
  return isNegative ? -quotient : quotient;
}

/**
 * Multiplies Money (tiyin) by Quantity (thousandths), dividing by 1000n with round-half-away-from-zero.
 * e.g. 1234567n Money * 5500n Quantity = 6790119n Money.
 */
export function multiply(money: Money, quantity: Quantity): Money {
  const product = (money as bigint) * (quantity as bigint);
  return divideRoundHalfAwayFromZero(product, 1000n) as Money;
}
