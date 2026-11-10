declare const MoneyBrand: unique symbol;

/**
 * Money represented in tiyin (1 so'm = 100 tiyin) as an immutable branded bigint.
 */
export type Money = bigint & { readonly [MoneyBrand]: typeof MoneyBrand };

export const ZERO_MONEY = 0n as Money;

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
