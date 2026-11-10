declare const MoneyBrand: unique symbol;

/**
 * Money represented in tiyin (1 so'm = 100 tiyin) as an immutable branded bigint.
 */
export type Money = bigint & { readonly [MoneyBrand]: typeof MoneyBrand };

export const ZERO_MONEY = 0n as Money;

/**
 * Maximum magnitude (signed 64-bit SQLite/PostgreSQL integer max = 2^63 - 1) allowed for any
 * persisted money value so both positive (`+amount`, `+tendered`) and negated (`-change`) ledger
 * deltas (`cash_moves.amount_delta`) fit safely in 64-bit SQL integers.
 */
export const MAX_MONEY_TIYIN = 9_223_372_036_854_775_807n;

export function isSignedInt64Money(tiyin: bigint): boolean {
  return tiyin >= -MAX_MONEY_TIYIN && tiyin <= MAX_MONEY_TIYIN;
}

export function moneyFromTiyin(tiyin: bigint): Money {
  return tiyin as Money;
}

export function moneyToTiyin(money: Money): bigint {
  return money;
}

export function addMoney(a: Money, b: Money): Money {
  return ((a as bigint) + (b as bigint)) as Money;
}

export function subtractMoney(a: Money, b: Money): Money {
  return ((a as bigint) - (b as bigint)) as Money;
}

export function negateMoney(a: Money): Money {
  return -(a as bigint) as Money;
}

export function sumMoney(items: readonly Money[]): Money {
  let total = 0n;
  for (let i = 0; i < items.length; i++) {
    total += items[i] as bigint;
  }
  return total as Money;
}
