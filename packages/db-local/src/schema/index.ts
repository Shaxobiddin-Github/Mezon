import { sql } from 'drizzle-orm';
import { check, index, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { sqliteBigint, sqliteHlc, sqliteInt, sqliteUnixMs, sqliteUuidV7 } from '../columns.js';
import { SqliteSchemaRegistry } from '../registry.js';

/**
 * Local SQLite schema metadata registry.
 * T0.5 adds operational `LOCAL` tables `local_device_state` and `local_outbox`.
 * Business synced tables (`FACT`/`ATTR`/`MONOTONE`) remain out of scope until F1.
 */
export const localSchemaRegistry = new SqliteSchemaRegistry();

/**
 * Persists this terminal/hub device's monotonic counters across commits, crashes, and restarts:
 * - `last_device_seq`: gapless monotonic counter (source of truth in DB, updated atomically on outbox writes)
 * - `last_hlc`: canonical 58-char HLC timestamp to restore `HlcClock({ initial })`
 * - `last_uuid_ms`: Unix ms watermark to restore `MonotonicUuidV7Generator({ initialLastMs })`
 */
export const localDeviceState = localSchemaRegistry.defineTable(
  {
    name: 'local_device_state',
    tableClass: 'LOCAL',
    tenantScope: 'organization',
  },
  (common) => ({
    ...common,
    deviceId: sqliteUuidV7('device_id').notNull(),
    lastDeviceSeq: sqliteBigint('last_device_seq').notNull(),
    lastHlc: sqliteHlc('last_hlc').notNull(),
    lastUuidMs: sqliteUnixMs('last_uuid_ms').notNull(),
  }),
  (self) => [
    uniqueIndex('uidx_local_device_state_device_id').on(self.deviceId),
    check('chk_local_device_state_seq_nonneg', sql`${self.lastDeviceSeq} >= 0`),
  ],
);

/**
 * Local transactional outbox queue (`GEMINI.md` Section 4 envelope + minimal push status for F2).
 * Decision (`T0.5` Adjustment #5): `id` primary key IS `eventId` (no redundant `event_id` column),
 * matching `SqliteSchemaRegistry`'s universal `id` primary key requirement cleanly.
 */
export const localOutbox = localSchemaRegistry.defineTable(
  {
    name: 'local_outbox',
    tableClass: 'LOCAL',
    tenantScope: 'organization',
  },
  (common) => ({
    ...common,
    storeId: sqliteUuidV7('store_id'),
    deviceId: sqliteUuidV7('device_id').notNull(),
    deviceSeq: sqliteBigint('device_seq').notNull(),
    hlc: sqliteHlc('hlc').notNull(),
    type: text('type').notNull(),
    entity: text('entity').notNull(),
    entityId: sqliteUuidV7('entity_id').notNull(),
    entityClass: text('class').notNull(),
    schemaVersion: sqliteInt('schema_version').notNull(),
    payload: text('payload').notNull(),
    status: text('status').notNull().default('pending'),
    attempts: sqliteInt('attempts').notNull().default(0),
    lastError: text('last_error'),
    pushedAtMs: sqliteUnixMs('pushed_at_ms'),
  }),
  (self) => [
    uniqueIndex('uidx_local_outbox_device_seq').on(self.deviceId, self.deviceSeq),
    index('idx_local_outbox_status_seq').on(self.status, self.deviceSeq),
    check('chk_local_outbox_device_seq_pos', sql`${self.deviceSeq} >= 1`),
    check('chk_local_outbox_class', sql`${self.entityClass} IN ('FACT', 'ATTR', 'MONOTONE')`),
    check('chk_local_outbox_schema_ver', sql`${self.schemaVersion} >= 1`),
    check('chk_local_outbox_status', sql`${self.status} IN ('pending', 'acked', 'rejected')`),
    check('chk_local_outbox_attempts', sql`${self.attempts} >= 0`),
  ],
);
