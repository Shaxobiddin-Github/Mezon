import { DomainError, type Money, type UnixMs, type UuidV7, moneyToTiyin } from '@mezon/domain';
import type { LocalSqliteConnection } from './connection.js';

type SqliteLike = LocalSqliteConnection['sqlite'];

/**
 * - `refunding`: the refund is claimed locally and sent to the provider; no sale can use the QR,
 *   and only the provider's answer (refund result or a later status check) moves it on (P2-K1).
 * - `amount_mismatch`: the provider took a different sum than the QR asked for; it never closes a
 *   receipt, a manager sees it and refunds it (P2-K2).
 */
export type PaymentIntentStatus =
  | 'pending'
  | 'paid'
  | 'expired'
  | 'cancelled'
  | 'failed'
  | 'refunding'
  | 'refunded'
  | 'amount_mismatch';

export interface PaymentIntentRecord {
  readonly id: UuidV7;
  readonly organizationId: UuidV7;
  readonly storeId: UuidV7;
  readonly cartId: UuidV7 | null;
  readonly kind: 'dynamic' | 'static';
  readonly amountTiyin: bigint;
  readonly status: PaymentIntentStatus;
  readonly providerRef: string;
  readonly qrPayload: string | null;
  readonly expiresAtMs: bigint;
  readonly paidAtMs: bigint | null;
  readonly paidLate: boolean;
  readonly confirmedByUserId: UuidV7 | null;
  readonly consumedBySaleId: UuidV7 | null;
  readonly receivedAmountTiyin: bigint | null;
  readonly createdAtMs: bigint;
}

interface Row {
  id: UuidV7;
  organization_id: UuidV7;
  store_id: UuidV7;
  cart_id: UuidV7 | null;
  kind: 'dynamic' | 'static';
  amount: bigint | number;
  status: PaymentIntentStatus;
  provider_ref: string;
  qr_payload: string | null;
  expires_at_ms: bigint | number;
  paid_at_ms: bigint | number | null;
  paid_late: bigint | number;
  confirmed_by_user_id: UuidV7 | null;
  consumed_by_sale_id: UuidV7 | null;
  received_amount: bigint | number | null;
  created_at_ms: bigint | number;
}

function toRecord(r: Row): PaymentIntentRecord {
  return {
    id: r.id,
    organizationId: r.organization_id,
    storeId: r.store_id,
    cartId: r.cart_id,
    kind: r.kind,
    amountTiyin: BigInt(r.amount),
    status: r.status,
    providerRef: r.provider_ref,
    qrPayload: r.qr_payload,
    expiresAtMs: BigInt(r.expires_at_ms),
    paidAtMs: r.paid_at_ms === null ? null : BigInt(r.paid_at_ms),
    paidLate: BigInt(r.paid_late) === 1n,
    confirmedByUserId: r.confirmed_by_user_id,
    consumedBySaleId: r.consumed_by_sale_id,
    receivedAmountTiyin: r.received_amount === null ? null : BigInt(r.received_amount),
    createdAtMs: BigInt(r.created_at_ms),
  };
}

export function insertPaymentIntentSync(
  sqlite: SqliteLike,
  p: {
    readonly id: UuidV7;
    readonly organizationId: UuidV7;
    readonly storeId: UuidV7;
    readonly cartId: UuidV7 | null;
    readonly kind: 'dynamic' | 'static';
    readonly amountTiyin: bigint;
    readonly providerRef: string;
    readonly qrPayload: string | null;
    readonly expiresAtMs: bigint;
    readonly nowMs: UnixMs;
  },
): PaymentIntentRecord {
  sqlite
    .prepare(
      `INSERT INTO payment_intents (id, organization_id, store_id, created_at_ms, updated_at_ms, cart_id,
         method, kind, amount, status, provider_ref, qr_payload, expires_at_ms)
       VALUES (?, ?, ?, ?, ?, ?, 'uzqr', ?, ?, 'pending', ?, ?, ?)`,
    )
    .run(
      p.id,
      p.organizationId,
      p.storeId,
      p.nowMs,
      p.nowMs,
      p.cartId,
      p.kind,
      p.amountTiyin,
      p.providerRef,
      p.qrPayload,
      p.expiresAtMs,
    );
  return getPaymentIntentSync(sqlite, p.id)!;
}

export function getPaymentIntentSync(sqlite: SqliteLike, id: UuidV7): PaymentIntentRecord | null {
  const row = sqlite.prepare('SELECT * FROM payment_intents WHERE id = ?').get(id) as
    Row | undefined;
  return row ? toRecord(row) : null;
}

/**
 * The single forward-only transition primitive: applies only when the row is still in one of
 * `from` (so two racing callers cannot both move it). Returns whether this caller moved it.
 */
export function transitionPaymentIntentSync(
  sqlite: SqliteLike,
  p: {
    readonly id: UuidV7;
    readonly from: readonly PaymentIntentStatus[];
    readonly to: PaymentIntentStatus;
    readonly nowMs: UnixMs;
    readonly paidLate?: boolean;
    readonly confirmedByUserId?: UuidV7 | null;
    readonly confirmNote?: string | null;
    readonly receivedAmountTiyin?: bigint;
  },
): boolean {
  const sets = ['status = ?', 'updated_at_ms = ?'];
  const args: unknown[] = [p.to, p.nowMs];
  // Money arrives: stamp it. A refund that did not happen (`refunding` → back) keeps the original stamp.
  if ((p.to === 'paid' || p.to === 'amount_mismatch') && !p.from.includes('refunding')) {
    sets.push('paid_at_ms = ?', 'paid_late = ?');
    args.push(p.nowMs, p.paidLate === true ? 1 : 0);
  }
  if (p.receivedAmountTiyin !== undefined) {
    sets.push('received_amount = ?');
    args.push(p.receivedAmountTiyin);
  }
  if (p.to === 'refunded') {
    sets.push('refunded_at_ms = ?');
    args.push(p.nowMs);
  }
  if (p.confirmedByUserId !== undefined) {
    sets.push('confirmed_by_user_id = ?', 'confirm_note = ?');
    args.push(p.confirmedByUserId, p.confirmNote ?? null);
  }
  // A refund (claim or finish) never touches a QR a sale already used.
  const extra =
    p.to === 'refunding' || p.to === 'refunded' ? ' AND consumed_by_sale_id IS NULL' : '';
  const res = sqlite
    .prepare(
      `UPDATE payment_intents SET ${sets.join(', ')}
        WHERE id = ? AND status IN (${p.from.map(() => '?').join(', ')})${extra}`,
    )
    .run(...args, p.id, ...p.from);
  return res.changes === 1;
}

/**
 * Inside `completeSale`: an `uzqr` payment closes the receipt only with a `paid` intent of exactly
 * that amount, consumed by THIS sale. One atomic UPDATE guarded by `consumed_by_sale_id IS NULL`:
 * under a race only one sale changes the row, the other gets 0 changes and is refused. A sale may
 * consume several intents (two QR payments in one receipt).
 */
export function consumeUzqrPaymentInTxSync(
  sqlite: SqliteLike,
  p: {
    readonly organizationId: UuidV7;
    readonly providerRef: string | null;
    readonly amount: Money;
    readonly saleId: UuidV7;
    readonly nowMs: UnixMs;
  },
): void {
  if (p.providerRef === null) {
    throw new DomainError('PAYMENT_NOT_CONFIRMED', 'An UzQR payment needs its payment reference');
  }
  const res = sqlite
    .prepare(
      `UPDATE payment_intents SET consumed_by_sale_id = ?, updated_at_ms = ?
        WHERE organization_id = ? AND provider_ref = ? AND status = 'paid'
          AND consumed_by_sale_id IS NULL AND amount = ?`,
    )
    .run(p.saleId, p.nowMs, p.organizationId, p.providerRef, moneyToTiyin(p.amount));
  if (res.changes !== 1) {
    throw new DomainError(
      'PAYMENT_NOT_CONFIRMED',
      'The UzQR payment is not confirmed, already used, or the amount differs',
      { details: { providerRef: p.providerRef } },
    );
  }
}

/** Intents a manager must look at: money taken with the wrong sum, or a refund whose outcome is open. */
export function listPaymentIntentsNeedingAttentionSync(
  sqlite: SqliteLike,
  organizationId: UuidV7,
): PaymentIntentRecord[] {
  const rows = sqlite
    .prepare(
      `SELECT * FROM payment_intents
        WHERE organization_id = ? AND status IN ('amount_mismatch', 'refunding')
        ORDER BY created_at_ms, id`,
    )
    .all(organizationId) as Row[];
  return rows.map(toRecord);
}
