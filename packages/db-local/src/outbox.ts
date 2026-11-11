import {
  type OutboxEntityClass,
  type OutboxPushStatus,
  type OutboxRepository,
  type PersistedOutboxRecord,
  type UnixMs,
  type UuidV7,
  parseHlc,
  parseUuidV7,
  serializeHlc,
  unixMsFromBigInt,
} from '@mezon/domain';
import type Database from 'better-sqlite3';
import { asc, eq } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { type SqliteSessionDbAccess, advanceDeviceSeqAndStateSync } from './device-state.js';
import { localOutbox } from './schema/index.js';

export function serializeOutboxJsonValue(value: unknown): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'bigint') {
    return value.toString();
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new TypeError(`Outbox payload cannot serialize non-finite number: ${String(value)}`);
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => serializeOutboxJsonValue(item));
  }
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (v !== undefined) {
        out[k] = serializeOutboxJsonValue(v);
      }
    }
    return out;
  }
  throw new TypeError(`Unsupported value type in outbox payload: ${typeof value}`);
}

export function serializeOutboxPayload(payload: Record<string, unknown>): string {
  return JSON.stringify(serializeOutboxJsonValue(payload));
}

export interface AppendOutboxEventParams {
  readonly eventId: UuidV7;
  readonly organizationId: UuidV7;
  readonly storeId: UuidV7 | null;
  readonly deviceId: UuidV7;
  readonly hlc: string;
  readonly uuidMs: UnixMs;
  readonly nowMs: UnixMs;
  readonly type: string;
  readonly entity: string;
  readonly entityId: UuidV7;
  readonly entityClass: OutboxEntityClass;
  readonly schemaVersion: number;
  readonly payload: Record<string, unknown>;
}

export interface AppendOutboxResult {
  readonly eventId: UuidV7;
  readonly deviceSeq: bigint;
  readonly hlc: string;
}

/**
 * Atomically allocates the next gapless `deviceSeq` in `local_device_state`, updates `last_hlc`
 * and `last_uuid_ms`, and inserts the event envelope into `local_outbox` (`id = eventId`).
 */
export function appendOutboxEventSync(
  sqlite: Database.Database,
  db: BetterSQLite3Database,
  params: AppendOutboxEventParams,
): AppendOutboxResult {
  if (!sqlite.inTransaction) {
    throw new Error('appendOutboxEventSync requires an active SQLite transaction');
  }
  if (!Number.isSafeInteger(params.schemaVersion) || params.schemaVersion < 1) {
    throw new RangeError(
      `schemaVersion must be a positive safe integer, got ${params.schemaVersion}`,
    );
  }
  if (typeof params.type !== 'string' || params.type.length === 0) {
    throw new TypeError('Outbox event type must be a non-empty string');
  }
  if (typeof params.entity !== 'string' || params.entity.length === 0) {
    throw new TypeError('Outbox entity name must be a non-empty string');
  }

  const validEventId = parseUuidV7(params.eventId);
  const validOrgId = parseUuidV7(params.organizationId);
  const validStoreId = params.storeId !== null ? parseUuidV7(params.storeId) : null;
  const validDeviceId = parseUuidV7(params.deviceId);
  const validEntityId = parseUuidV7(params.entityId);
  const canonicalHlc = serializeHlc(parseHlc(params.hlc));
  const validUuidMs = unixMsFromBigInt(params.uuidMs);
  const validNowMs = unixMsFromBigInt(params.nowMs);
  const payloadJson = serializeOutboxPayload(params.payload);

  const deviceSeq = advanceDeviceSeqAndStateSync(sqlite, {
    deviceId: validDeviceId,
    hlc: canonicalHlc,
    uuidMs: validUuidMs,
    updatedAtMs: validNowMs,
  });

  db.insert(localOutbox)
    .values({
      id: validEventId,
      organizationId: validOrgId,
      storeId: validStoreId,
      deviceId: validDeviceId,
      deviceSeq,
      hlc: canonicalHlc,
      type: params.type,
      entity: params.entity,
      entityId: validEntityId,
      entityClass: params.entityClass,
      schemaVersion: params.schemaVersion,
      payload: payloadJson,
      status: 'pending',
      attempts: 0,
      lastError: null,
      pushedAtMs: null,
      createdAtMs: validNowMs,
      updatedAtMs: validNowMs,
    })
    .run();

  return {
    eventId: validEventId,
    deviceSeq,
    hlc: canonicalHlc,
  };
}

function parseOutboxClass(raw: string): OutboxEntityClass {
  if (raw === 'FACT' || raw === 'ATTR' || raw === 'MONOTONE') {
    return raw;
  }
  throw new TypeError(`Invalid outbox entity class stored in SQLite: "${raw}"`);
}

function parseOutboxStatus(raw: string): OutboxPushStatus {
  if (raw === 'pending' || raw === 'acked' || raw === 'rejected') {
    return raw;
  }
  throw new TypeError(`Invalid outbox push status stored in SQLite: "${raw}"`);
}

function parseOutboxPayload(rawJson: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(rawJson);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new TypeError('Stored outbox payload JSON must decode to a plain object');
  }
  return parsed as Record<string, unknown>;
}

function mapOutboxRow(row: typeof localOutbox.$inferSelect): PersistedOutboxRecord {
  return {
    eventId: row.id,
    organizationId: row.organizationId,
    storeId: row.storeId ?? null,
    deviceId: row.deviceId,
    deviceSeq: row.deviceSeq,
    hlc: row.hlc,
    type: row.type,
    entity: row.entity,
    entityId: row.entityId,
    class: parseOutboxClass(row.entityClass),
    schemaVersion: row.schemaVersion,
    payload: parseOutboxPayload(row.payload),
    status: parseOutboxStatus(row.status),
    attempts: row.attempts,
    lastError: row.lastError ?? null,
    pushedAtMs: row.pushedAtMs ?? null,
    createdAtMs: row.createdAtMs,
    updatedAtMs: row.updatedAtMs,
  };
}

export function listAllOutboxRecordsSync(
  db: BetterSQLite3Database,
): readonly PersistedOutboxRecord[] {
  return db.select().from(localOutbox).orderBy(asc(localOutbox.deviceSeq)).all().map(mapOutboxRow);
}

const OUTBOX_DEBUG_REDACTED_KEYS = new Set<string>([
  'pin',
  'newPin',
  'pinHash',
  'token',
  'accessToken',
  'tokenHash',
  'password',
  'secret',
  'fullName',
  'full_name',
  'nameSearch',
  'name_search',
  'phone',
  'phoneNormalized',
  'phone_normalized',
  'phoneDigits',
  'phone_digits',
  'customerName',
  'customerPhone',
  'customerNote',
  'note',
]);

/**
 * Redacts PII (customer names, phones, notes) and secrets recursively before writing any outbox
 * record to debug logs, crash diagnostics, or support bundles while leaving the persisted sync
 * envelope untouched.
 */
export function redactOutboxPayloadForDebug(value: unknown): unknown {
  if (value === null || typeof value === 'boolean' || typeof value === 'number') {
    return value;
  }
  if (typeof value === 'bigint') {
    return value.toString();
  }
  if (typeof value === 'string') {
    return /^\+[1-9]\d{7,14}$/.test(value) ? '[Redacted]' : value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactOutboxPayloadForDebug(item));
  }
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (OUTBOX_DEBUG_REDACTED_KEYS.has(k)) {
        out[k] = v === null || v === undefined ? v : '[Redacted]';
      } else {
        out[k] = redactOutboxPayloadForDebug(v);
      }
    }
    return out;
  }
  return '[Redacted]';
}

export function formatOutboxRecordForDebug(record: PersistedOutboxRecord): string {
  return JSON.stringify({
    eventId: record.eventId,
    organizationId: record.organizationId,
    storeId: record.storeId,
    deviceId: record.deviceId,
    deviceSeq: record.deviceSeq.toString(),
    hlc: record.hlc,
    type: record.type,
    entity: record.entity,
    entityId: record.entityId,
    class: record.class,
    schemaVersion: record.schemaVersion,
    status: record.status,
    attempts: record.attempts,
    payload: redactOutboxPayloadForDebug(record.payload),
  });
}

export class SqliteOutboxRepository implements OutboxRepository<SqliteSessionDbAccess> {
  listPending(
    session: SqliteSessionDbAccess,
    limit: number = 100,
  ): Promise<readonly PersistedOutboxRecord[]> {
    session.assertOpen();
    if (!Number.isSafeInteger(limit) || limit < 1) {
      throw new RangeError(
        `Outbox listPending limit must be a positive safe integer, got ${limit}`,
      );
    }
    const rows = session.db
      .select()
      .from(localOutbox)
      .where(eq(localOutbox.status, 'pending'))
      .orderBy(asc(localOutbox.deviceSeq))
      .limit(limit)
      .all();

    return Promise.resolve(rows.map(mapOutboxRow));
  }
}
