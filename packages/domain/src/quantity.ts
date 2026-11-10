declare const QuantityBrand: unique symbol;

/**
 * Quantity represented in thousandths (milli-units: 0.001 = 1n) as an immutable branded bigint.
 */
export type Quantity = bigint & { readonly [QuantityBrand]: typeof QuantityBrand };

export const ZERO_QUANTITY = 0n as Quantity;

export function quantityFromMilli(milli: bigint): Quantity {
  return milli as Quantity;
}

export function quantityToMilli(qty: Quantity): bigint {
  return qty;
}

export function addQuantity(a: Quantity, b: Quantity): Quantity {
  return ((a as bigint) + (b as bigint)) as Quantity;
}

export function subtractQuantity(a: Quantity, b: Quantity): Quantity {
  return ((a as bigint) - (b as bigint)) as Quantity;
}

export function negateQuantity(a: Quantity): Quantity {
  return -(a as bigint) as Quantity;
}
