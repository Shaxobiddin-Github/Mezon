import {
  type CustomerLedgerEntryType,
  type CustomerLedgerSourceType,
  type LedgerEntryForFifo,
  type Money,
  type PaymentMethod,
  type UnixMs,
  type UuidV7,
  allocateCustomerLedgerFifo,
  moneyFromTiyin,
  parseUuidV7,
  unixMsFromBigInt,
} from '@mezon/domain';
import type pg from 'pg';
import { resolveIntlDateKey } from './timezone.js';

export interface CloudCustomerDebt {
  readonly balance: Money;
  readonly overdueAmount: Money;
  readonly oldestOverdueDays: number;
}

const ZERO: CloudCustomerDebt = {
  balance: moneyFromTiyin(0n),
  overdueAmount: moneyFromTiyin(0n),
  oldestOverdueDays: 0,
};

/**
 * Customer debt in the cloud with the SAME rule as the hub (T1.7): the pure domain FIFO
 * (`allocateCustomerLedgerFifo`) over the synced `customer_ledger` rows. Before this the cabinet
 * always showed an overdue amount of 0.
 *
 * Runs inside the caller's tenant context (`client` from `withPgTenantContext`).
 */
export async function loadCustomerDebts(
  client: pg.PoolClient,
  params: {
    readonly organizationId: UuidV7;
    readonly customerIds: readonly string[];
    readonly asOfMs: UnixMs;
    readonly tz: string;
  },
): Promise<Map<string, CloudCustomerDebt>> {
  const result = new Map<string, CloudCustomerDebt>();
  if (params.customerIds.length === 0) return result;
  const rows = await client.query<{
    id: string;
    customer_id: string;
    hlc: string;
    created_at_ms: string;
    entry_type: string;
    amount_delta: string;
    source_type: string;
    sale_id: string | null;
    payment_method: string | null;
    due_at_ms: string | null;
  }>(
    `SELECT id, customer_id, hlc, created_at_ms, entry_type, amount_delta, source_type,
            sale_id, payment_method, due_at_ms
       FROM customer_ledger
      WHERE organization_id = $1 AND customer_id = ANY($2::uuid[])`,
    [params.organizationId, params.customerIds],
  );
  const byCustomer = new Map<string, LedgerEntryForFifo[]>();
  for (const r of rows.rows) {
    const list = byCustomer.get(r.customer_id) ?? [];
    list.push({
      id: parseUuidV7(r.id),
      hlc: r.hlc,
      createdAtMs: unixMsFromBigInt(BigInt(r.created_at_ms)),
      entryType: r.entry_type as CustomerLedgerEntryType,
      amountDelta: moneyFromTiyin(BigInt(r.amount_delta)),
      sourceType: r.source_type as CustomerLedgerSourceType,
      saleId: r.sale_id === null ? null : parseUuidV7(r.sale_id),
      paymentMethod: r.payment_method as PaymentMethod | null,
      dueAtMs: r.due_at_ms === null ? null : unixMsFromBigInt(BigInt(r.due_at_ms)),
    });
    byCustomer.set(r.customer_id, list);
  }
  for (const id of params.customerIds) {
    const entries = byCustomer.get(id);
    if (!entries) {
      result.set(id, ZERO);
      continue;
    }
    const fifo = allocateCustomerLedgerFifo({
      entries,
      asOfMs: params.asOfMs,
      storeTimezone: params.tz,
      resolveTimeZoneDateKey: resolveIntlDateKey,
    });
    result.set(id, {
      balance: fifo.balance,
      overdueAmount: fifo.overdueAmount,
      oldestOverdueDays: Number(fifo.oldestOverdueDays),
    });
  }
  return result;
}
