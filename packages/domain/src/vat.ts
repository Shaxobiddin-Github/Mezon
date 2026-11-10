import { DomainError } from './errors.js';
import type { Money } from './money.js';
import { divideRoundHalfAwayFromZero } from './rounding.js';

declare const VatRateBrand: unique symbol;

/**
 * VAT Rate in basis points (1% = 100n, 12% = 1200n, 100% = 10000n).
 * Value must be within [0n..10000n].
 */
export type VatRate = bigint & { readonly [VatRateBrand]: typeof VatRateBrand };

export const ZERO_VAT_RATE = 0n as VatRate;

export function vatRateFromBasisPoints(bp: bigint): VatRate {
  if (bp < 0n || bp > 10000n) {
    throw new DomainError('INVALID_VAT_RATE');
  }
  return bp as VatRate;
}

export function vatRateToBasisPoints(rate: VatRate): bigint {
  return rate;
}

export interface VatExcludedResult {
  readonly vat: Money;
  readonly total: Money;
}

export interface VatIncludedResult {
  readonly net: Money;
  readonly vat: Money;
}

/**
 * Calculates VAT added on top of a net amount.
 * total = net + vat.
 */
export function calculateVatExcluded(net: Money, rate: VatRate): VatExcludedResult {
  const rawNet = net as bigint;
  const rawRate = rate as bigint;
  if (rawRate === 0n || rawNet === 0n) {
    return {
      vat: 0n as Money,
      total: net,
    };
  }
  const vat = divideRoundHalfAwayFromZero(rawNet * rawRate, 10000n) as Money;
  const total = (rawNet + (vat as bigint)) as Money;
  return { vat, total };
}

/**
 * Extracts VAT included inside a gross amount.
 * Invariant: net + vat === gross.
 */
export function calculateVatIncluded(gross: Money, rate: VatRate): VatIncludedResult {
  const rawGross = gross as bigint;
  const rawRate = rate as bigint;
  if (rawRate === 0n || rawGross === 0n) {
    return {
      net: gross,
      vat: 0n as Money,
    };
  }
  const vat = divideRoundHalfAwayFromZero(rawGross * rawRate, 10000n + rawRate) as Money;
  const net = (rawGross - (vat as bigint)) as Money;
  return { net, vat };
}
