import { sql } from 'drizzle-orm';
import { check, index, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import {
  sqliteBigint,
  sqliteBoolean,
  sqliteHlc,
  sqliteInt,
  sqliteUnixMs,
  sqliteUuidV7,
} from '../columns.js';
import { SqliteSchemaRegistry } from '../registry.js';

/**
 * Local SQLite schema metadata registry.
 * T0.5 added operational `LOCAL` tables `local_device_state` and `local_outbox`.
 * T0.6 adds synced `ATTR` `users` and `LOCAL` hub auth tables (`local_hub_config`,
 * `local_pin_credentials`, `local_device_auth_state`, `local_sessions`).
 * Business synced tables (catalog, stock, sales) remain out of scope until F1.
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

/**
 * Synced user & role directory (`ATTR`).
 * Secrets (PIN hashes, lockout counters, session tokens) NEVER live here and are NEVER outboxed.
 * Username uniqueness applies strictly to non-tombstoned rows (`WHERE deleted_at_ms IS NULL`)
 * so a deleted user's username may be safely reused later.
 */
export const users = localSchemaRegistry.defineTable(
  {
    name: 'users',
    tableClass: 'ATTR',
    tenantScope: 'organization',
  },
  (common) => ({
    ...common,
    username: text('username').notNull(),
    fullName: text('full_name').notNull(),
    role: text('role').notNull(),
    isActive: sqliteBoolean('is_active').notNull(),
  }),
  (self) => [
    uniqueIndex('uidx_users_org_username')
      .on(self.organizationId, self.username)
      .where(sql`${self.deletedAtMs} IS NULL`),
    index('idx_users_org_active_role').on(self.organizationId, self.deletedAtMs, self.isActive),
    check('chk_users_role', sql`${self.role} IN ('owner', 'manager', 'cashier')`),
    check('chk_users_is_active', sql`${self.isActive} IN (0, 1)`),
    check('chk_users_username_nonempty', sql`length(trim(${self.username})) >= 2`),
    check('chk_users_full_name_nonempty', sql`length(trim(${self.fullName})) >= 1`),
  ],
);

/**
 * Singleton first-run setup configuration (`LOCAL`).
 * Enforces at database level (`singleton_guard = 1` UNIQUE) that initial setup completes at most once.
 */
export const localHubConfig = localSchemaRegistry.defineTable(
  {
    name: 'local_hub_config',
    tableClass: 'LOCAL',
    tenantScope: 'organization',
  },
  (common) => ({
    ...common,
    storeId: sqliteUuidV7('store_id').notNull(),
    deviceId: sqliteUuidV7('device_id').notNull(),
    singletonGuard: sqliteInt('singleton_guard').notNull(),
    setupCompletedAtMs: sqliteUnixMs('setup_completed_at_ms').notNull(),
  }),
  (self) => [
    uniqueIndex('uidx_local_hub_config_singleton').on(self.singletonGuard),
    check('chk_local_hub_config_singleton', sql`${self.singletonGuard} = 1`),
  ],
);

/**
 * Device-local Argon2id PIN credentials and persistent per-user brute-force lockout state (`LOCAL`).
 * Strictly excluded from outbox/sync (`GEMINI.md` 3.4).
 */
export const localPinCredentials = localSchemaRegistry.defineTable(
  {
    name: 'local_pin_credentials',
    tableClass: 'LOCAL',
    tenantScope: 'organization',
  },
  (common) => ({
    ...common,
    userId: sqliteUuidV7('user_id')
      .notNull()
      .references(() => users.id),
    pinHash: text('pin_hash').notNull(),
    pinUpdatedAtMs: sqliteUnixMs('pin_updated_at_ms').notNull(),
    failedAttempts: sqliteInt('failed_attempts').notNull().default(0),
    lockedUntilMs: sqliteUnixMs('locked_until_ms'),
    lastFailedAtMs: sqliteUnixMs('last_failed_at_ms'),
  }),
  (self) => [
    uniqueIndex('uidx_local_pin_credentials_user_id').on(self.userId),
    check('chk_local_pin_credentials_failed_nonneg', sql`${self.failedAttempts} >= 0`),
    check('chk_local_pin_credentials_hash_nonempty', sql`length(${self.pinHash}) >= 1`),
  ],
);

/**
 * Device-wide progressive PIN throttling state (`LOCAL`, `T0.6` T1).
 * Tracks consecutive/windowed failures across all usernames so user-rotation sprays hit exponential
 * backoff (2s, 4s, ..., capped at 60s) without ever hard-locking the entire POS terminal.
 */
export const localDeviceAuthState = localSchemaRegistry.defineTable(
  {
    name: 'local_device_auth_state',
    tableClass: 'LOCAL',
    tenantScope: 'organization',
  },
  (common) => ({
    ...common,
    deviceId: sqliteUuidV7('device_id').notNull(),
    windowStartedAtMs: sqliteUnixMs('window_started_at_ms').notNull(),
    failedAttempts: sqliteInt('failed_attempts').notNull().default(0),
    nextAllowedAtMs: sqliteUnixMs('next_allowed_at_ms'),
    lastFailedAtMs: sqliteUnixMs('last_failed_at_ms'),
  }),
  (self) => [
    uniqueIndex('uidx_local_device_auth_state_device_id').on(self.deviceId),
    check('chk_local_device_auth_state_failed_nonneg', sql`${self.failedAttempts} >= 0`),
  ],
);

/**
 * Local bearer sessions (`LOCAL`). Stores only 64-char SHA-256 hex digest of 32 random bytes.
 */
export const localSessions = localSchemaRegistry.defineTable(
  {
    name: 'local_sessions',
    tableClass: 'LOCAL',
    tenantScope: 'organization',
  },
  (common) => ({
    ...common,
    userId: sqliteUuidV7('user_id')
      .notNull()
      .references(() => users.id),
    deviceId: sqliteUuidV7('device_id').notNull(),
    tokenHash: text('token_hash').notNull(),
    expiresAtMs: sqliteUnixMs('expires_at_ms').notNull(),
    revokedAtMs: sqliteUnixMs('revoked_at_ms'),
    lastSeenAtMs: sqliteUnixMs('last_seen_at_ms').notNull(),
  }),
  (self) => [
    uniqueIndex('uidx_local_sessions_token_hash').on(self.tokenHash),
    index('idx_local_sessions_user_revoked').on(self.userId, self.revokedAtMs),
    check('chk_local_sessions_token_hash_len', sql`length(${self.tokenHash}) = 64`),
  ],
);
