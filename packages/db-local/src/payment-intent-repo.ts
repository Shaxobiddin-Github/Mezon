import { DomainError, type Money, type UnixMs, type UuidV7, moneyToTiyin } from '@mezon/domain';
import type { LocalSqliteConnection } from './connection.js';

type SqliteLike = LocalSqliteConnection['sqlite'];

export type PaymentIntentStatus =
  'pending' | 'paid' | 'expired' | 'cancelled' | 'failed' | 'refunded';

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
  },
): boolean {
  const sets = ['status = ?', 'updated_at_ms = ?'];
  const args: unknown[] = [p.to, p.nowMs];
  if (p.to === 'paid') {
    sets.push('paid_at_ms = ?', 'paid_late = ?');
    args.push(p.nowMs, p.paidLate === true ? 1 : 0);
  }
  if (p.to === 'refunded') {
    sets.push('refunded_at_ms = ?');
    args.push(p.nowMs);
  }
  if (p.confirmedByUserId !== undefined) {
    sets.push('confirmed_by_user_id = ?', 'confirm_note = ?');
    args.push(p.confirmedByUserId, p.confirmNote ?? null);
  }
  const extra = p.to === 'refunded' ? ' AND consumed_by_sale_id IS NULL' : '';
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
 * that amount, consumed by THIS sale (one atomic UPDATE; the partial UNIQUE index makes a second
 * sale with the same intent impossible even under a race).
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
