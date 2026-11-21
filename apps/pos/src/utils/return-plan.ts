import type { SaleReturnContextLineDto, SaleReturnContextResponseDto } from '@mezon/contracts';
import {
  type PaymentMethod,
  computeCumulativeReturnLineAmounts,
  moneyFromTiyin,
  moneyToTiyin,
  parseProductUnit,
  parseUuidV7,
  quantityFromMilli,
} from '@mezon/domain';

/** Milli-units still returnable on a sale line. */
export function remainingQtyMilli(line: SaleReturnContextLineDto): bigint {
  const rest = BigInt(line.qty) - BigInt(line.returnedQty);
  return rest > 0n ? rest : 0n;
}

/**
 * Refund (tiyin) for returning `qtyMilli` of a line now, with the SAME domain function the hub uses
 * (cumulative rounding across partial returns), so the kassa shows what the hub will accept.
 * Throws the domain error (e.g. RETURN_QTY_EXCEEDED, INVALID_UNIT_QUANTITY) for a bad quantity.
 */
export function lineRefundTiyin(line: SaleReturnContextLineDto, qtyMilli: bigint): bigint {
  return moneyToTiyin(
    computeCumulativeReturnLineAmounts({
      saleLineId: parseUuidV7(line.id),
      unit: parseProductUnit(line.unit),
      soldQty: quantityFromMilli(BigInt(line.qty)),
      previouslyReturnedQty: quantityFromMilli(BigInt(line.returnedQty)),
      requestedQty: quantityFromMilli(qtyMilli),
      soldFinalTotal: moneyFromTiyin(BigInt(line.finalTotal)),
      soldNetExVat: moneyFromTiyin(BigInt(line.netExVat)),
      soldVatTotal: moneyFromTiyin(BigInt(line.vatTotal)),
      previouslyRefunded: moneyFromTiyin(BigInt(line.refundedAmount)),
      previouslyReturnedNet: moneyFromTiyin(BigInt(line.returnedNetExVat)),
      previouslyReturnedVat: moneyFromTiyin(BigInt(line.returnedVatTotal)),
    }).refundAmount,
  );
}

export interface RefundPlan {
  /** Part of the refund that only reduces the customer's remaining debt on this receipt. */
  readonly debtOffset: bigint;
  readonly payments: readonly { readonly method: PaymentMethod; readonly amount: bigint }[];
}

/**
 * Splits a refund: first the remaining unpaid debt of the receipt (no money leaves the drawer for
 * goods that were never paid), then cash, then the other original methods, each up to what that
 * method can still refund. Returns null when the limits cannot cover the refund.
 */
export function planRefund(
  totalTiyin: bigint,
  ctx: Pick<SaleReturnContextResponseDto, 'refundableByMethod' | 'remainingSaleDebt'>,
): RefundPlan | null {
  let rest = totalTiyin;
  const debt = BigInt(ctx.remainingSaleDebt);
  const debtOffset = debt < rest ? debt : rest;
  rest -= debtOffset;
  const ordered = [...ctx.refundableByMethod].sort((a, b) =>
    a.method === 'cash' ? -1 : b.method === 'cash' ? 1 : 0,
  );
  const payments: { method: PaymentMethod; amount: bigint }[] = [];
  for (const r of ordered) {
    if (rest === 0n) break;
    const cap = BigInt(r.amount);
    const take = cap < rest ? cap : rest;
    if (take > 0n) {
      payments.push({ method: r.method, amount: take });
      rest -= take;
    }
  }
  return rest === 0n ? { debtOffset, payments } : null;
}
