import type { PriceTierDto } from '@mezon/contracts';
import { formatMilliToQtyString } from '@mezon/ui';

/** Name the hub puts on a cart line priced by a wholesale tier (C20). */
export const WHOLESALE_LINE_NAME = 'Ulgurji narx';

/**
 * The first (smallest) wholesale tier as a short sale-screen hint, e.g. `{ qty: '5', price }`.
 * `null` when the product has no tiers.
 */
export function tierHint(
  tiers: readonly PriceTierDto[] | undefined,
): { readonly qty: string; readonly price: string } | null {
  if (tiers === undefined || tiers.length === 0) return null;
  let first = tiers[0];
  for (const tier of tiers) {
    if (first === undefined || BigInt(tier.minQty) < BigInt(first.minQty)) first = tier;
  }
  if (first === undefined) return null;
  return { qty: formatMilliToQtyString(first.minQty), price: first.unitPrice };
}

/** Editable tier row in the product form: what the owner types (pieces / so'm). */
export interface TierDraft {
  readonly qty: string;
  readonly priceSom: string;
}

export type TierErrorKey =
  | 'pos.wholesale.errQty'
  | 'pos.wholesale.errPrice'
  | 'pos.wholesale.errSameQty'
  | 'pos.wholesale.errOrder';

/** One tier ready for the hub: milli-units and tiyin as strings. */
export interface TierInput {
  readonly minQty: string;
  readonly unitPrice: string;
}

/**
 * Checks the owner's tier rows against the shelf price (tiyin). Empty rows are skipped. Rules
 * (the hub checks the same): quantity above 1, price below the shelf price, different quantities,
 * and a bigger quantity never dearer. Returns an i18n key on error.
 */
export function parseTierDrafts(
  drafts: readonly TierDraft[],
  salePriceTiyin: bigint,
  parseQty: (raw: string) => string | null | undefined,
  parsePrice: (raw: string) => string,
):
  | { readonly ok: true; readonly tiers: readonly TierInput[] }
  | { readonly ok: false; readonly error: TierErrorKey } {
  const out: TierInput[] = [];
  for (const d of drafts) {
    if (d.qty.trim() === '' && d.priceSom.trim() === '') continue;
    const qty = parseQty(d.qty);
    if (qty === null || qty === undefined || BigInt(qty) <= 1000n) {
      return { ok: false, error: 'pos.wholesale.errQty' };
    }
    let price: string;
    try {
      price = parsePrice(d.priceSom);
    } catch {
      return { ok: false, error: 'pos.wholesale.errPrice' };
    }
    if (BigInt(price) >= salePriceTiyin) return { ok: false, error: 'pos.wholesale.errPrice' };
    out.push({ minQty: qty, unitPrice: price });
  }
  const sorted = [...out].sort((a, b) => (BigInt(a.minQty) < BigInt(b.minQty) ? -1 : 1));
  for (let i = 1; i < sorted.length; i += 1) {
    const prev = sorted[i - 1];
    const cur = sorted[i];
    if (prev === undefined || cur === undefined) continue;
    if (prev.minQty === cur.minQty) return { ok: false, error: 'pos.wholesale.errSameQty' };
    if (BigInt(cur.unitPrice) > BigInt(prev.unitPrice)) {
      return { ok: false, error: 'pos.wholesale.errOrder' };
    }
  }
  return { ok: true, tiers: sorted };
}
