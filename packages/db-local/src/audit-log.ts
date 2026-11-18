import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { UnixMs, UuidV7 } from '@mezon/domain';
import type { LocalSqliteConnection } from './connection.js';

/**
 * T3.8 append-only audit journal with a hash chain.
 *
 * Every row carries `hash = sha256(canonical(row fields, prev_hash))` and the previous row's hash,
 * so editing, deleting or reordering any row breaks the chain at that point and
 * `verifyAuditChainSync` names the first broken `seq`. UPDATE / DELETE are refused by triggers.
 * Rows are written INSIDE the transaction of the audited operation (§3.1.10): a rolled-back
 * operation leaves no audit row.
 *
 * Limit (stated, not hidden): someone who controls the device can rewrite the WHOLE chain from a
 * point on with fresh hashes; only an outside anchor (the last hash kept in the cloud) can catch
 * that. Locally the chain detects every partial edit.
 */

export const AUDIT_GENESIS_HASH = '0'.repeat(64);

export const AUDIT_EVENT_TYPES = [
  'auth.login',
  'auth.login_failed',
  'sale.voided',
  'return.created',
  'price.changed',
  'discount.applied',
  'shift.opened',
  'shift.closed',
  'shift.cash_move',
  'user.created',
  'user.updated',
  'day_close.created',
  'payment.manual_confirmed',
] as const;
export type AuditEventType = (typeof AUDIT_EVENT_TYPES)[number];

export interface AuditEntryInput {
  readonly organizationId: UuidV7;
  readonly eventType: AuditEventType;
  readonly actorUserId: UuidV7 | null;
  readonly entity: string;
  readonly entityId: string | null;
  /** Small, non-secret facts (amounts as strings, reasons). Never PINs, tokens or phone numbers. */
  readonly details: Readonly<Record<string, string | number | boolean | null>>;
  readonly nowMs: UnixMs;
  readonly nextId: () => UuidV7;
}

interface AuditRow {
  id: string;
  organization_id: string;
  seq: number | bigint;
  event_type: string;
  actor_user_id: string | null;
  entity: string;
  entity_id: string | null;
  details_json: string;
  prev_hash: string;
  hash: string;
  created_at_ms: number | bigint;
}

/** Deterministic JSON: object keys sorted, so the same facts always hash the same. */
export function canonicalAuditDetails(
  details: Readonly<Record<string, string | number | boolean | null>>,
): string {
  return JSON.stringify(
    Object.keys(details)
      .sort()
      .map((k) => [k, details[k]]),
  );
}

export function computeAuditHash(fields: {
  readonly organizationId: string;
  readonly seq: bigint;
  readonly eventType: string;
  readonly actorUserId: string | null;
  readonly entity: string;
  readonly entityId: string | null;
  readonly detailsJson: string;
  readonly createdAtMs: bigint;
  readonly prevHash: string;
}): string {
  const canonical = JSON.stringify([
    'mezon.audit.v1',
    fields.organizationId,
    fields.seq.toString(),
    fields.eventType,
    fields.actorUserId,
    fields.entity,
    fields.entityId,
    fields.detailsJson,
    fields.createdAtMs.toString(),
    fields.prevHash,
  ]);
  return createHash('sha256').update(canonical).digest('hex');
}

type SqliteLike = LocalSqliteConnection['sqlite'];

/** Appends one audit row. MUST be called inside the audited operation's transaction. */
export function appendAuditInTxSync(sqlite: SqliteLike, input: AuditEntryInput): void {
  const last = sqlite
    .prepare(
      'SELECT seq, hash FROM local_audit_log WHERE organization_id = ? ORDER BY seq DESC LIMIT 1',
    )
    .get(input.organizationId) as { seq: number | bigint; hash: string } | undefined;
  const seq = last ? BigInt(last.seq) + 1n : 1n;
  const prevHash = last ? last.hash : AUDIT_GENESIS_HASH;
  const detailsJson = canonicalAuditDetails(input.details);
  const createdAtMs = BigInt(input.nowMs);
  const hash = computeAuditHash({
    organizationId: input.organizationId,
    seq,
    eventType: input.eventType,
    actorUserId: input.actorUserId,
    entity: input.entity,
    entityId: input.entityId,
    detailsJson,
    createdAtMs,
    prevHash,
  });
  sqlite
    .prepare(
      `INSERT INTO local_audit_log (
         id, organization_id, created_at_ms, updated_at_ms, seq, event_type, actor_user_id,
         entity, entity_id, details_json, prev_hash, hash
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.nextId(),
      input.organizationId,
      createdAtMs,
      createdAtMs,
      seq,
      input.eventType,
      input.actorUserId,
      input.entity,
      input.entityId,
      detailsJson,
      prevHash,
      hash,
    );
}

export interface AuditVerifyResult {
  readonly ok: boolean;
  readonly checked: number;
  readonly firstBrokenSeq: string | null;
  readonly reason: 'seq_gap' | 'prev_hash_mismatch' | 'hash_mismatch' | null;
  readonly lastHash: string;
}

/** The verification command: walks the chain from seq 1 and names the first broken row. */
export function verifyAuditChainSync(
  sqlite: SqliteLike,
  organizationId: string,
): AuditVerifyResult {
  const rows = sqlite
    .prepare('SELECT * FROM local_audit_log WHERE organization_id = ? ORDER BY seq ASC')
    .all(organizationId) as AuditRow[];
  let prev = AUDIT_GENESIS_HASH;
  let expectedSeq = 1n;
  let checked = 0;
  for (const r of rows) {
    const seq = BigInt(r.seq);
    const broken = (reason: AuditVerifyResult['reason']): AuditVerifyResult => ({
      ok: false,
      checked,
      firstBrokenSeq: seq.toString(),
      reason,
      lastHash: prev,
    });
    if (seq !== expectedSeq) {
      return { ...broken('seq_gap'), firstBrokenSeq: expectedSeq.toString() };
    }
    if (r.prev_hash !== prev) return broken('prev_hash_mismatch');
    const recomputed = computeAuditHash({
      organizationId: r.organization_id,
      seq,
      eventType: r.event_type,
      actorUserId: r.actor_user_id,
      entity: r.entity,
      entityId: r.entity_id,
      detailsJson: r.details_json,
      createdAtMs: BigInt(r.created_at_ms),
      prevHash: r.prev_hash,
    });
    if (recomputed !== r.hash) return broken('hash_mismatch');
    prev = r.hash;
    expectedSeq += 1n;
    checked += 1;
  }
  return { ok: true, checked, firstBrokenSeq: null, reason: null, lastHash: prev };
}

/** Append-only enforcement for `local_audit_log`. */
export function buildAuditLogTriggersSql(): string[] {
  return [
    'DROP TRIGGER IF EXISTS "trg_local_audit_log_no_update";',
    'DROP TRIGGER IF EXISTS "trg_local_audit_log_no_delete";',
    [
      'CREATE TRIGGER "trg_local_audit_log_no_update"',
      'BEFORE UPDATE ON "local_audit_log"',
      'FOR EACH ROW',
      'BEGIN',
      `  SELECT RAISE(ABORT, 'local_audit_log is append-only');`,
      'END;',
    ].join('\n'),
    [
      'CREATE TRIGGER "trg_local_audit_log_no_delete"',
      'BEFORE DELETE ON "local_audit_log"',
      'FOR EACH ROW',
      'BEGIN',
      `  SELECT RAISE(ABORT, 'local_audit_log is append-only');`,
      'END;',
    ].join('\n'),
  ];
}

function squash(sqlText: string): string {
  return sqlText.replace(/\s+/g, ' ').trim();
}

export function assertAuditMigrationsComplete(migrationsDir: string): void {
  const all = squash(
    fs
      .readdirSync(migrationsDir)
      .filter((f) => f.endsWith('.sql'))
      .sort()
      .map((f) => fs.readFileSync(path.join(migrationsDir, f), 'utf8'))
      .join('\n'),
  );
  for (const stmt of buildAuditLogTriggersSql().filter((s) => s.startsWith('CREATE TRIGGER'))) {
    if (!all.includes(squash(stmt))) {
      throw new Error(`Missing local_audit_log trigger in migrations: ${stmt.split('\n')[0]}`);
    }
  }
}
