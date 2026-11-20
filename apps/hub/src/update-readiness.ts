import type { LocalSqliteConnection } from '@mezon/db-local';

/**
 * T4.8 — what an application update would interrupt right now. The desktop shell asks the hub
 * worker for this (over the private parent port, never over HTTP) before it installs an update.
 *
 * - `openReceipts`: open carts that already have lines — a cashier is in the middle of a receipt.
 *   An update never starts while this is above 0, whatever the cashier chose. A QR payment that
 *   is still waiting for the customer (`pending`, not yet expired) counts too: the customer is in
 *   the middle of paying (P2 × C2). A paid-but-unused QR does not: its open cart already counts, and
 *   an orphaned late payment only waits for a manager's refund (it must never block updates).
 * - `openShifts`: open shifts. Only the "when the shift is closed" choice waits for 0.
 * - `pendingFiscalDocs`: fiscal documents not yet confirmed. Shown for information only: the queue
 *   is durable and the fiscal worker resumes it after the restart.
 */
export interface UpdateReadiness {
  readonly openReceipts: number;
  readonly openShifts: number;
  readonly pendingFiscalDocs: number;
}

export function readUpdateReadiness(
  connection: LocalSqliteConnection,
  nowMs: number = Date.now(),
): UpdateReadiness {
  const count = (sql: string, ...args: unknown[]) =>
    Number((connection.sqlite.prepare(sql).get(...args) as { n: number | bigint }).n);
  return {
    openReceipts:
      count(
        `SELECT COUNT(*) AS n FROM local_carts c
        WHERE c.status = 'open'
          AND EXISTS (SELECT 1 FROM local_cart_lines l WHERE l.cart_id = c.id)`,
      ) +
      count(
        `SELECT COUNT(*) AS n FROM payment_intents WHERE status = 'pending' AND expires_at_ms > ?`,
        nowMs,
      ),
    openShifts: count(`SELECT COUNT(*) AS n FROM shifts WHERE status = 'open'`),
    pendingFiscalDocs: count(
      `SELECT COUNT(*) AS n FROM fiscal_docs WHERE status IN ('pending', 'sent', 'failed')`,
    ),
  };
}
