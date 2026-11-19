import type { UnixMs, UuidV7 } from '@mezon/domain';
import type { LocalSqliteConnection } from './connection.js';

type SqliteLike = LocalSqliteConnection['sqlite'];

/** T4.1 LAN identity / pairing codes / terminals: plain SQL, every state change guarded. */

export interface LanIdentityRow {
  readonly id: UuidV7;
  readonly organizationId: UuidV7;
  readonly certPem: string;
  readonly keyEncB64: string;
  readonly fingerprint256: string;
  readonly notAfterMs: bigint;
}

export function getLanIdentitySync(
  sqlite: SqliteLike,
  organizationId: UuidV7,
): LanIdentityRow | null {
  const r = sqlite
    .prepare(
      `SELECT id, organization_id, cert_pem, key_enc_b64, fingerprint256, not_after_ms
         FROM local_lan_identity WHERE organization_id = ?`,
    )
    .get(organizationId) as
    | {
        id: UuidV7;
        organization_id: UuidV7;
        cert_pem: string;
        key_enc_b64: string;
        fingerprint256: string;
        not_after_ms: bigint | number;
      }
    | undefined;
  return r
    ? {
        id: r.id,
        organizationId: r.organization_id,
        certPem: r.cert_pem,
        keyEncB64: r.key_enc_b64,
        fingerprint256: r.fingerprint256,
        notAfterMs: BigInt(r.not_after_ms),
      }
    : null;
}

/** Inserts the identity unless one exists (first writer wins); returns the stored one. */
export function insertLanIdentityIfAbsentSync(
  sqlite: SqliteLike,
  p: Omit<LanIdentityRow, 'notAfterMs'> & { readonly notAfterMs: bigint; readonly nowMs: UnixMs },
): LanIdentityRow {
  sqlite
    .prepare(
      `INSERT INTO local_lan_identity (id, organization_id, created_at_ms, updated_at_ms, cert_pem,
         key_enc_b64, fingerprint256, not_after_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (organization_id) DO NOTHING`,
    )
    .run(
      p.id,
      p.organizationId,
      p.nowMs,
      p.nowMs,
      p.certPem,
      p.keyEncB64,
      p.fingerprint256,
      p.notAfterMs,
    );
  return getLanIdentitySync(sqlite, p.organizationId)!;
}

export interface LanPairingCodeRow {
  readonly id: UuidV7;
  readonly codeEnc: string;
  readonly expiresAtMs: bigint;
  readonly failedAttempts: number;
}

export function insertLanPairingCodeSync(
  sqlite: SqliteLike,
  p: {
    readonly id: UuidV7;
    readonly organizationId: UuidV7;
    readonly codeEnc: string;
    readonly createdByUserId: UuidV7;
    readonly expiresAtMs: bigint;
    readonly nowMs: UnixMs;
  },
): void {
  sqlite
    .prepare(
      `INSERT INTO local_lan_pairing_codes (id, organization_id, created_at_ms, updated_at_ms,
         code_enc, created_by_user_id, expires_at_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(p.id, p.organizationId, p.nowMs, p.nowMs, p.codeEnc, p.createdByUserId, p.expiresAtMs);
}

/** Codes that may still pair: unused, not expired, attempts left. */
export function listActiveLanPairingCodesSync(
  sqlite: SqliteLike,
  organizationId: UuidV7,
  nowMs: UnixMs,
  maxFailedAttempts: number,
): LanPairingCodeRow[] {
  return (
    sqlite
      .prepare(
        `SELECT id, code_enc, expires_at_ms, failed_attempts FROM local_lan_pairing_codes
          WHERE organization_id = ? AND used_at_ms IS NULL AND expires_at_ms > ?
            AND failed_attempts < ?
          ORDER BY created_at_ms`,
      )
      .all(organizationId, nowMs, maxFailedAttempts) as {
      id: UuidV7;
      code_enc: string;
      expires_at_ms: bigint | number;
      failed_attempts: bigint | number;
    }[]
  ).map((r) => ({
    id: r.id,
    codeEnc: r.code_enc,
    expiresAtMs: BigInt(r.expires_at_ms),
    failedAttempts: Number(r.failed_attempts),
  }));
}

export function recordLanPairingFailureSync(
  sqlite: SqliteLike,
  ids: readonly UuidV7[],
  nowMs: UnixMs,
): void {
  const stmt = sqlite.prepare(
    `UPDATE local_lan_pairing_codes SET failed_attempts = failed_attempts + 1, updated_at_ms = ?
      WHERE id = ? AND used_at_ms IS NULL`,
  );
  for (const id of ids) stmt.run(nowMs, id);
}

/**
 * Consumes the code and creates the terminal in ONE transaction. The guarded UPDATE
 * (`used_at_ms IS NULL`) makes a code single-use even under two concurrent pairings.
 */
export function consumeLanPairingCodeAndAddTerminalSync(
  sqlite: SqliteLike,
  p: {
    readonly codeId: UuidV7;
    readonly organizationId: UuidV7;
    readonly terminalId: UuidV7;
    readonly name: string;
    readonly keyHash: string;
    readonly nowMs: UnixMs;
  },
): boolean {
  return sqlite.transaction(() => {
    const used = sqlite
      .prepare(
        `UPDATE local_lan_pairing_codes SET used_at_ms = ?, used_by_terminal_id = ?, updated_at_ms = ?
          WHERE id = ? AND used_at_ms IS NULL`,
      )
      .run(p.nowMs, p.terminalId, p.nowMs, p.codeId);
    if (used.changes !== 1) return false;
    const by = sqlite
      .prepare('SELECT created_by_user_id AS u FROM local_lan_pairing_codes WHERE id = ?')
      .get(p.codeId) as { u: UuidV7 };
    sqlite
      .prepare(
        `INSERT INTO local_lan_terminals (id, organization_id, created_at_ms, updated_at_ms, name,
           key_hash, status, paired_at_ms, paired_by_user_id)
         VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
      )
      .run(p.terminalId, p.organizationId, p.nowMs, p.nowMs, p.name, p.keyHash, p.nowMs, by.u);
    return true;
  })();
}

export interface LanTerminalRow {
  readonly id: UuidV7;
  readonly organizationId: UuidV7;
  readonly name: string;
  readonly keyHash: string;
  readonly status: 'active' | 'revoked';
  readonly pairedAtMs: bigint;
  readonly revokedAtMs: bigint | null;
  readonly lastSeenAtMs: bigint | null;
}

interface TerminalDbRow {
  id: UuidV7;
  organization_id: UuidV7;
  name: string;
  key_hash: string;
  status: 'active' | 'revoked';
  paired_at_ms: bigint | number;
  revoked_at_ms: bigint | number | null;
  last_seen_at_ms: bigint | number | null;
}

const toTerminal = (r: TerminalDbRow): LanTerminalRow => ({
  id: r.id,
  organizationId: r.organization_id,
  name: r.name,
  keyHash: r.key_hash,
  status: r.status,
  pairedAtMs: BigInt(r.paired_at_ms),
  revokedAtMs: r.revoked_at_ms === null ? null : BigInt(r.revoked_at_ms),
  lastSeenAtMs: r.last_seen_at_ms === null ? null : BigInt(r.last_seen_at_ms),
});

export function getLanTerminalSync(sqlite: SqliteLike, id: string): LanTerminalRow | null {
  const r = sqlite.prepare('SELECT * FROM local_lan_terminals WHERE id = ?').get(id) as
    TerminalDbRow | undefined;
  return r ? toTerminal(r) : null;
}

export function listLanTerminalsSync(sqlite: SqliteLike, organizationId: UuidV7): LanTerminalRow[] {
  return (
    sqlite
      .prepare('SELECT * FROM local_lan_terminals WHERE organization_id = ? ORDER BY paired_at_ms')
      .all(organizationId) as TerminalDbRow[]
  ).map(toTerminal);
}

export function revokeLanTerminalSync(sqlite: SqliteLike, id: UuidV7, nowMs: UnixMs): boolean {
  return (
    sqlite
      .prepare(
        `UPDATE local_lan_terminals SET status = 'revoked', revoked_at_ms = ?, updated_at_ms = ?
          WHERE id = ? AND status = 'active'`,
      )
      .run(nowMs, nowMs, id).changes === 1
  );
}

export function touchLanTerminalSync(sqlite: SqliteLike, id: UuidV7, nowMs: UnixMs): void {
  sqlite
    .prepare(
      `UPDATE local_lan_terminals SET last_seen_at_ms = ?
        WHERE id = ? AND (last_seen_at_ms IS NULL OR last_seen_at_ms < ?)`,
    )
    .run(nowMs, id, BigInt(nowMs) - 30_000n);
}

export interface TerminalSalesRow {
  readonly terminalId: UuidV7 | null;
  readonly terminalName: string | null;
  readonly saleCount: number;
  readonly totalFinal: bigint;
}

/**
 * T4.2 per-register breakdown of non-voided sales in `[fromMs, toMs)`. The register is the
 * terminal the cart was opened on (`local_carts.terminal_id`; NULL = the hub computer).
 */
export function listSalesByTerminalSync(
  sqlite: SqliteLike,
  p: { readonly organizationId: UuidV7; readonly fromMs: bigint; readonly toMs: bigint },
): TerminalSalesRow[] {
  return (
    sqlite
      .prepare(
        `SELECT c.terminal_id AS terminal_id, t.name AS terminal_name,
                COUNT(*) AS n, COALESCE(SUM(s.total_final), 0) AS total
           FROM sales s
           JOIN local_carts c ON c.completed_sale_id = s.id
           LEFT JOIN local_lan_terminals t ON t.id = c.terminal_id
          WHERE s.organization_id = ? AND s.voided_at_ms IS NULL
            AND s.created_at_ms >= ? AND s.created_at_ms < ?
          GROUP BY c.terminal_id
          ORDER BY t.name IS NOT NULL, t.name`,
      )
      .all(p.organizationId, p.fromMs, p.toMs) as {
      terminal_id: UuidV7 | null;
      terminal_name: string | null;
      n: bigint | number;
      total: bigint | number;
    }[]
  ).map((r) => ({
    terminalId: r.terminal_id,
    terminalName: r.terminal_name,
    saleCount: Number(r.n),
    totalFinal: BigInt(r.total),
  }));
}

/** T4.3: the register a sale was rung up on (NULL = hub computer or unknown). */
export function getSaleTerminalIdSync(sqlite: SqliteLike, saleId: string): UuidV7 | null {
  const r = sqlite
    .prepare('SELECT terminal_id FROM local_carts WHERE completed_sale_id = ? LIMIT 1')
    .get(saleId) as { terminal_id: UuidV7 | null } | undefined;
  return r?.terminal_id ?? null;
}

/** T4.3 the register's printer settings (JSON) — NULL when none is configured. */
export function getLanTerminalPrinterJsonSync(sqlite: SqliteLike, id: string): string | null {
  const r = sqlite.prepare('SELECT printer_json FROM local_lan_terminals WHERE id = ?').get(id) as
    { printer_json: string | null } | undefined;
  return r?.printer_json ?? null;
}

export function setLanTerminalPrinterJsonSync(
  sqlite: SqliteLike,
  id: UuidV7,
  json: string | null,
  nowMs: UnixMs,
): boolean {
  return (
    sqlite
      .prepare('UPDATE local_lan_terminals SET printer_json = ?, updated_at_ms = ? WHERE id = ?')
      .run(json, nowMs, id).changes === 1
  );
}
