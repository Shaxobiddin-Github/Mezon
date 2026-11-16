import { sql } from 'drizzle-orm';
import { index, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { pgBigint, pgBoolean, pgInt, pgUnixMs, pgUuidV7 } from '../columns.js';
import { cloudSchemaRegistry } from './registry-instance.js';

/**
 * Immutable historical sync events pushed to the Cloud (`FACT`, organization-scoped).
 * Provides deduplication via UNIQUE(organization_id, id) and gapless per-store sequence
 * via UNIQUE(organization_id, store_id, position).
 */
export const cloudSyncEvents = cloudSchemaRegistry.defineTable(
  {
    name: 'cloud_sync_events',
    tableClass: 'FACT',
    tenantScope: 'organization',
  },
  (common) => ({
    ...common,
    storeId: pgUuidV7('store_id').notNull(),
    deviceSeq: pgBigint('device_seq').notNull(),
    type: text('type').notNull(),
    entity: text('entity').notNull(),
    entityId: pgUuidV7('entity_id').notNull(),
    entityClass: text('class').notNull(),
    schemaVersion: pgInt('schema_version').notNull(),
    payload: text('payload').notNull(), // Raw JSON payload
    position: pgBigint('position').notNull(), // Gapless sequential position per store (T2.4 Pull foundation)
    hlcAdjusted: pgBoolean('hlc_adjusted').notNull().default(false),
    receivedAtMs: pgUnixMs('received_at_ms').notNull(),
  }),
  (self) => [
    uniqueIndex('uidx_cloud_sync_events_org_event').on(self.organizationId, self.id),
    uniqueIndex('uidx_cloud_sync_events_org_store_pos').on(
      self.organizationId,
      self.storeId,
      self.position,
    ),
    index('idx_cloud_sync_events_pull').on(self.organizationId, self.storeId, self.position),
    index('idx_cloud_sync_events_entity').on(self.organizationId, self.entity, self.entityId),
  ],
);

/**
 * Global gapless position tracker per store (`LOCAL`, organization-scoped).
 * Incremented under `pg_advisory_xact_lock(hashtext('store_sync:' || store_id))`
 * exclusively when an event achieves `status: 'accepted'`.
 */
export const cloudStoreSyncPositions = cloudSchemaRegistry.defineTable(
  {
    name: 'cloud_store_sync_positions',
    tableClass: 'LOCAL',
    tenantScope: 'organization',
  },
  (common) => ({
    ...common,
    storeId: pgUuidV7('store_id').notNull(),
    lastPosition: pgBigint('last_position')
      .notNull()
      .default(sql`0`),
  }),
  (self) => [
    uniqueIndex('uidx_cloud_store_sync_positions_org_store').on(self.organizationId, self.storeId),
  ],
);

/**
 * P2: Dependency parking table (`LOCAL`, organization-scoped).
 * Pushed events referencing missing in-tenant entities are parked here (status: 'parked')
 * and retried up to N=20 times before triggering a sync conflict.
 */
export const cloudSyncParked = cloudSchemaRegistry.defineTable(
  {
    name: 'cloud_sync_parked',
    tableClass: 'LOCAL',
    tenantScope: 'organization',
  },
  (common) => ({
    ...common,
    storeId: pgUuidV7('store_id').notNull(),
    deviceId: pgUuidV7('device_id').notNull(),
    eventId: pgUuidV7('event_id').notNull(),
    entity: text('entity').notNull(),
    entityId: pgUuidV7('entity_id').notNull(),
    missingRefEntity: text('missing_ref_entity').notNull(),
    missingRefId: pgUuidV7('missing_ref_id').notNull(),
    attempts: pgInt('attempts').notNull().default(1),
    eventPayload: text('event_payload').notNull(),
    status: text('status').notNull().default('parked'), // 'parked' | 'resolved' | 'conflict'
  }),
  (self) => [
    uniqueIndex('uidx_cloud_sync_parked_event').on(self.organizationId, self.eventId),
    index('idx_cloud_sync_parked_missing_ref').on(
      self.organizationId,
      self.missingRefEntity,
      self.missingRefId,
    ),
  ],
);
