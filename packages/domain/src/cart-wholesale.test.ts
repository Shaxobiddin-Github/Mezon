import { describe, expect, it } from 'vitest';
import {
  type CashierDiscountPolicy,
  type CartLineInput,
  type PromotionRule,
  WHOLESALE_RULE_TYPE,
  ZERO_MONEY,
  ZERO_VAT_RATE,
  evaluateCart,
  moneyFromTiyin,
  moneyToTiyin,
  parseUuidV7,
  quantityFromMilli,
  unixMsFromBigInt,
} from './index.js';

const id = (n: number) => parseUuidV7(`01950000-0000-7000-8000-${String(n).padStart(12, '0')}`);
const PROD = id(10);
const OTHER = id(11);
const T0 = unixMsFromBigInt(1_760_000_000_000n);
const POLICY: CashierDiscountPolicy = {
  percentUnlimited: true,
  maxPercentBp: 0n,
  amountUnlimited: true,
  maxAmount: ZERO_MONEY,
};

function tier(n: number, minMilli: bigint, priceTiyin: bigint, product = PROD): PromotionRule {
  return {
    id: id(n),
    storeId: null,
    name: 'Ulgurji narx',
    type: WHOLESALE_RULE_TYPE,
    wholesale: { minQty: quantityFromMilli(minMilli), unitPrice: moneyFromTiyin(priceTiyin) },
    scope: 'product',
    targetProductId: product,
    targetCategoryId: null,
    discountPercentBp: null,
    discountAmount: null,
    buyQty: null,
    freeQty: null,
    startsAtMs: T0,
    endsAtMs: null,
    isActive: true,
  };
}

function line(n: number, qtyMilli: bigint, priceTiyin: bigint, product = PROD): CartLineInput {
  return {
    id: id(n),
    lineKind: 'catalog',
    productId: product,
    variantId: null,
    categoryId: null,
    name: 'Coca cola',
    unit: 'dona',
    qty: quantityFromMilli(qtyMilli),
    unitPriceSnapshot: moneyFromTiyin(priceTiyin),
    vatRate: ZERO_VAT_RATE,
  };
}

function run(lines: CartLineInput[], promos: PromotionRule[]) {
  return evaluateCart({
    storeId: null,
    nowMs: T0,
    lines,
    promotions: promos,
    manualDiscount: { mode: 'none', percentBp: 0n, amount: ZERO_MONEY },
    policy: POLICY,
    overrideApprovedByUserId: null,
    overrideApprovedAmount: null,
  });
}

// 20 000 so'm shelf price, 19 000 from 5 pcs, 18 000 from 10 pcs (tiyin = so'm * 100)
const P = 2_000_000n;
const T5 = tier(100, 5_000n, 1_900_000n);
const T10 = tier(101, 10_000n, 1_800_000n);

describe('C20 wholesale tiers', () => {
  it('below the threshold the shelf price stays', () => {
    const r = run([line(1, 4_000n, P)], [T5, T10]);
    expect(moneyToTiyin(r.totalFinal)).toBe(4n * P);
    expect(r.lines[0]?.appliedPromotionId).toBeNull();
  });

  it('at exactly the threshold the tier price applies to every unit', () => {
    const r = run([line(1, 5_000n, P)], [T5, T10]);
    expect(moneyToTiyin(r.totalFinal)).toBe(5n * 1_900_000n);
    expect(r.lines[0]?.appliedPromotionName).toBe('Ulgurji narx');
  });

  it('the deepest reached tier wins', () => {
    const r = run([line(1, 12_000n, P)], [T5, T10]);
    expect(moneyToTiyin(r.totalFinal)).toBe(12n * 1_800_000n);
    expect(r.lines[0]?.appliedPromotionId).toBe(T10.id);
  });

  it('quantity is pooled across lines of the same product (split scans)', () => {
    const r = run([line(1, 3_000n, P), line(2, 2_000n, P)], [T5]);
    expect(moneyToTiyin(r.totalFinal)).toBe(5n * 1_900_000n);
  });

  it('another product never counts toward the threshold or gets the price', () => {
    const r = run([line(1, 3_000n, P), line(2, 2_000n, P, OTHER)], [T5]);
    expect(moneyToTiyin(r.totalFinal)).toBe(5n * P);
  });

  it('a tier above the shelf price never raises the price', () => {
    const r = run([line(1, 6_000n, P)], [tier(102, 5_000n, 2_500_000n)]);
    expect(moneyToTiyin(r.totalFinal)).toBe(6n * P);
  });

  it('fractional kg quantities work (2.5 kg from 2 kg)', () => {
    const kg: CartLineInput = { ...line(1, 2_500n, 1_000_000n), unit: 'kg' };
    const r = run([kg], [tier(103, 2_000n, 900_000n)]);
    expect(moneyToTiyin(r.totalFinal)).toBe(2_250_000n);
  });
});
