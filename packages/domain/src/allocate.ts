import { DomainError } from './errors.js';
import type { Money } from './money.js';

interface RemainderItem {
  index: number;
  remainder: bigint;
}

/**
 * Distributes a Money amount across weights using the Largest Remainder Method (Hare-Niemeyer).
 * Strictly deterministic: equal remainders are resolved stably by original input index.
 * Strictly symmetric: allocate(-money, weights) element-wise === -allocate(money, weights).
 */
export function allocate(totalMoney: Money, weights: readonly bigint[]): Money[] {
  if (weights.length === 0) {
    throw new DomainError('ALLOCATE_EMPTY_WEIGHTS');
  }

  let totalWeight = 0n;
  for (let i = 0; i < weights.length; i++) {
    const w = weights[i];
    if (w < 0n) {
      throw new DomainError('ALLOCATE_NEGATIVE_WEIGHT');
    }
    totalWeight += w;
  }

  if (totalWeight === 0n) {
    throw new DomainError('ALLOCATE_ZERO_TOTAL_WEIGHT');
  }

  const rawMoney = totalMoney as bigint;
  if (rawMoney === 0n) {
    return weights.map(() => 0n as Money);
  }

  const isNegative = rawMoney < 0n;
  const absMoney = isNegative ? -rawMoney : rawMoney;

  const shares: bigint[] = new Array<bigint>(weights.length);
  const items: RemainderItem[] = new Array<RemainderItem>(weights.length);
  let sumShares = 0n;

  for (let i = 0; i < weights.length; i++) {
    const w = weights[i];
    const product = absMoney * w;
    const share = product / totalWeight;
    const remainder = product % totalWeight;
    shares[i] = share;
    items[i] = { index: i, remainder };
    sumShares += share;
  }

  let leftover = absMoney - sumShares;

  // Stable deterministic sort returning number, not bigint difference
  items.sort((a, b) => {
    if (a.remainder > b.remainder) return -1;
    if (a.remainder < b.remainder) return 1;
    return a.index - b.index;
  });

  for (let i = 0; i < items.length && leftover > 0n; i++) {
    const targetIdx = items[i].index;
    shares[targetIdx] += 1n;
    leftover -= 1n;
  }

  const result: Money[] = new Array<Money>(weights.length);
  for (let i = 0; i < weights.length; i++) {
    const finalShare = isNegative ? -shares[i] : shares[i];
    result[i] = finalShare as Money;
  }

  return result;
}
