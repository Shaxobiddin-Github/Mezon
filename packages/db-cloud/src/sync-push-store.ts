import {
  CURRENT_SCHEMA_VERSION,
  MONOTONE_TRANSITION_RULES,
  SYNC_FOREIGN_REFERENCES,
  type SyncEventEnvelopeDto,
  type SyncEventResultDto,
  type SyncPushResponseDto,
  checkAndClampHlc,
  validateSyncEntityPayload,
} from '@mezon/sync';
import { type UnixMs, type UuidV7 } from '@mezon/domain';
import { and, eq, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type pg from 'pg';
import type { QueryResult } from 'pg';
import { withPgTenantContext } from './connection.js';
import type { VerifiedDeviceContext } from './device-store.js';
import type { PgTableMetadata } from './registry.js';
import {
  cloudSchemaRegistry,
  cloudStoreSyncPositions,
  cloudSyncEvents,
  cloudSyncParked,
} from './schema/index.js';

export interface MissingReferenceInfo {
  readonly targetEntity: string;
  readonly targetId: UuidV7;
}

export type ForeignRefCheckResult =
  | { readonly status: 'valid' }
  | { readonly status: 'rejected'; readonly error: string }
  | { readonly status: 'retry'; readonly missingRef: MissingReferenceInfo };

export class CloudSyncPushStore {
  constructor(private readonly pool: pg.Pool) {}

  /**
   * Processes an incoming push batch under tenant context and store advisory lock.
   * Enforces:
   * P1: Per-event SAVEPOINT subtransactions (SQL errors isolate cleanly, positions stay gapless)
   * P2: Unknown references: cross-tenant -> rejected; missing in-tenant -> retry & cloud_sync_parked
   * P3: Shared MONOTONE state transitions (idempotent re-application -> duplicate; illegal -> rejected)
   * P4: Strict Zod payload validation (extra unexpected fields like pin_hash -> rejected)
   * Deduplication via UNIQUE(organization_id, id)
   * Gapless position allocation per store
   */
  async processSyncPushBatch(params: {
    readonly context: VerifiedDeviceContext;
    readonly events: readonly SyncEventEnvelopeDto[];
    readonly nowMs: UnixMs;
  }): Promise<SyncPushResponseDto> {
    return withPgTenantContext(this.pool, params.context.organizationId, async (tx) => {
      // Advisory transaction lock per store: guarantees strictly gapless positions under parallel pushes
      const lockKey = `store_sync:${params.context.storeId}`;
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`);

      // Read current store position
      const posRows = await tx
        .select()
        .from(cloudStoreSyncPositions)
        .where(
          and(
            eq(cloudStoreSyncPositions.organizationId, params.context.organizationId),
            eq(cloudStoreSyncPositions.storeId, params.context.storeId),
          ),
        )
        .limit(1);

      let currentPosition = posRows.length > 0 ? posRows[0].lastPosition : 0n;
      let positionUpdated = false;

      const results: SyncEventResultDto[] = [];

      for (const event of params.events) {
        // P1: Every event is wrapped in a SAVEPOINT
        await tx.execute(sql.raw('SAVEPOINT sp_event'));

        try {
          // 1. Deduplication: check if already accepted
          const existingEvent = await tx
            .select({ id: cloudSyncEvents.id })
            .from(cloudSyncEvents)
            .where(
              and(
                eq(cloudSyncEvents.organizationId, params.context.organizationId),
                eq(cloudSyncEvents.id, event.eventId),
              ),
            )
            .limit(1);

          if (existingEvent.length > 0) {
            await tx.execute(sql.raw('RELEASE SAVEPOINT sp_event'));
            results.push({
              eventId: event.eventId,
              status: 'duplicate',
            });
            continue;
          }

          // 2. Tenant isolation check
          if (event.organizationId !== params.context.organizationId) {
            await tx.execute(sql.raw('ROLLBACK TO SAVEPOINT sp_event'));
            results.push({
              eventId: event.eventId,
              status: 'rejected',
              reason: 'TENANT_MISMATCH',
              error: 'Event organizationId does not match authenticated tenant context',
            });
            continue;
          }

          // 3. Store isolation check
          if (event.storeId !== null && event.storeId !== params.context.storeId) {
            await tx.execute(sql.raw('ROLLBACK TO SAVEPOINT sp_event'));
            results.push({
              eventId: event.eventId,
              status: 'rejected',
              reason: 'STORE_MISMATCH',
              error: 'Event storeId does not match authenticated device store',
            });
            continue;
          }

          // 4. Schema version check
          if (event.schemaVersion !== CURRENT_SCHEMA_VERSION) {
            await tx.execute(sql.raw('ROLLBACK TO SAVEPOINT sp_event'));
            results.push({
              eventId: event.eventId,
              status: 'rejected',
              reason: 'SCHEMA_VERSION_UNSUPPORTED',
              error: `Schema version ${event.schemaVersion} is unsupported (current: ${CURRENT_SCHEMA_VERSION})`,
            });
            continue;
          }

          // 5. Registered entity & table class check
          const tableMeta = cloudSchemaRegistry.get(event.entity);
          if (!tableMeta || tableMeta.tableClass === 'LOCAL') {
            await tx.execute(sql.raw('ROLLBACK TO SAVEPOINT sp_event'));
            results.push({
              eventId: event.eventId,
              status: 'rejected',
              reason: tableMeta ? 'FORBIDDEN_TABLE_CLASS' : 'UNKNOWN_ENTITY',
              error: `Entity "${event.entity}" cannot be synced (class: ${tableMeta?.tableClass ?? 'unknown'})`,
            });
            continue;
          }

          // 6. Single-Writer Rule: stock_moves & batches must match authenticated store
          if (event.entity === 'stock_moves' || event.entity === 'batches') {
            if (event.storeId !== params.context.storeId) {
              await tx.execute(sql.raw('ROLLBACK TO SAVEPOINT sp_event'));
              results.push({
                eventId: event.eventId,
                status: 'rejected',
                reason: 'SINGLE_WRITER_VIOLATION',
                error: `Single-writer violation: entity "${event.entity}" can only be written by store ${params.context.storeId}`,
              });
              continue;
            }
          }

          // 7. P4: Strict Payload Validation
          const validationResult = validateSyncEntityPayload(event.entity, event.payload);
          if (!validationResult.success) {
            await tx.execute(sql.raw('ROLLBACK TO SAVEPOINT sp_event'));
            results.push({
              eventId: event.eventId,
              status: 'rejected',
              reason: 'VALIDATION_ERROR',
              error: validationResult.error,
            });
            continue;
          }

          // 8. P2: Foreign Reference Integrity & In-Tenant Dependency Parking
          const refCheck = await this.checkForeignReferences(
            tx,
            event.entity,
            validationResult.data,
            params.context.organizationId,
          );

          if (refCheck.status === 'rejected') {
            await tx.execute(sql.raw('ROLLBACK TO SAVEPOINT sp_event'));
            results.push({
              eventId: event.eventId,
              status: 'rejected',
              reason: 'FOREIGN_ENTITY_MISMATCH',
              error: refCheck.error,
            });
            continue;
          }

          if (refCheck.status === 'retry') {
            await tx.execute(sql.raw('ROLLBACK TO SAVEPOINT sp_event'));
            await this.parkEvent(tx, params.context, event, refCheck.missingRef, params.nowMs);
            results.push({
              eventId: event.eventId,
              status: 'retry',
              reason: 'DEPENDENCY_MISSING',
              error: `Referenced entity "${refCheck.missingRef.targetEntity}" (${refCheck.missingRef.targetId}) not found in this tenant yet`,
            });
            continue;
          }

          // 9. P3: Shared MONOTONE State Transitions
          if (tableMeta.tableClass === 'MONOTONE') {
            const monotoneResult = await this.checkMonotoneTransition(
              tx,
              tableMeta,
              event,
              validationResult.data,
              params.context.organizationId,
            );

            if (monotoneResult === 'duplicate') {
              await tx.execute(sql.raw('RELEASE SAVEPOINT sp_event'));
              results.push({
                eventId: event.eventId,
                status: 'duplicate',
              });
              continue;
            }

            if (monotoneResult === 'rejected') {
              await tx.execute(sql.raw('ROLLBACK TO SAVEPOINT sp_event'));
              results.push({
                eventId: event.eventId,
                status: 'rejected',
                reason: 'INVALID_MONOTONE_TRANSITION',
                error: `Illegal state transition on MONOTONE entity "${event.entity}"`,
              });
              continue;
            }
          }

          // 10. HLC Skew Guard
          const clampResult = checkAndClampHlc(event.hlc, params.nowMs);
          const effectiveHlc = clampResult.hlc;
          const hlcAdjusted = clampResult.adjusted;

          // 11. Apply to Domain Table (inside the SAVEPOINT)
          await this.applyEventToDomainTable(
            tx,
            tableMeta,
            event,
            validationResult.data,
            effectiveHlc,
            params.context.organizationId,
            params.nowMs,
          );

          // 12. Allocate gapless position and record sync event
          currentPosition += 1n;
          positionUpdated = true;

          const payloadStr =
            typeof event.payload === 'string' ? event.payload : JSON.stringify(event.payload);

          await tx.insert(cloudSyncEvents).values({
            id: event.eventId,
            organizationId: params.context.organizationId,
            storeId: params.context.storeId,
            deviceId: params.context.deviceId,
            deviceSeq: BigInt(event.deviceSeq),
            hlc: effectiveHlc,
            type: event.type,
            entity: event.entity,
            entityId: event.entityId,
            entityClass: tableMeta.tableClass,
            schemaVersion: event.schemaVersion,
            payload: payloadStr,
            position: currentPosition,
            hlcAdjusted,
            receivedAtMs: params.nowMs,
            createdAtMs: params.nowMs,
          });

          await tx.execute(sql.raw('RELEASE SAVEPOINT sp_event'));

          results.push({
            eventId: event.eventId,
            status: 'accepted',
            position: currentPosition.toString(),
          });
        } catch (err) {
          // P1: SQL execution error caught within SAVEPOINT.
          // Savepoint rolls back; position is NOT incremented; good events proceed unaffected.
          await tx.execute(sql.raw('ROLLBACK TO SAVEPOINT sp_event'));
          const underlying =
            err instanceof Error && 'cause' in err && err.cause instanceof Error
              ? err.cause.message
              : err instanceof Error
                ? err.message
                : String(err);
          results.push({
            eventId: event.eventId,
            status: 'rejected',
            reason: 'SQL_ERROR',
            error: underlying,
          });
        }
      }

      // Update store position record
      if (positionUpdated) {
        if (posRows.length > 0) {
          await tx
            .update(cloudStoreSyncPositions)
            .set({
              lastPosition: currentPosition,
              updatedAtMs: params.nowMs,
            })
            .where(
              and(
                eq(cloudStoreSyncPositions.organizationId, params.context.organizationId),
                eq(cloudStoreSyncPositions.storeId, params.context.storeId),
              ),
            );
        } else {
          await tx.insert(cloudStoreSyncPositions).values({
            id: params.context.deviceId,
            organizationId: params.context.organizationId,
            storeId: params.context.storeId,
            lastPosition: currentPosition,
            createdAtMs: params.nowMs,
            updatedAtMs: params.nowMs,
          });
        }
      }

      return { results };
    });
  }

  /**
   * P2: Verifies foreign references in the payload.
   * - If found in this tenant -> valid
   * - If found in another tenant -> rejected (cross-tenant data breach)
   * - If not found anywhere -> retry (in-flight reference not yet arrived)
   */
  private async checkForeignReferences(
    tx: NodePgDatabase,
    entity: string,
    payload: Record<string, unknown>,
    organizationId: UuidV7,
  ): Promise<ForeignRefCheckResult> {
    const refs = SYNC_FOREIGN_REFERENCES[entity] ?? [];
    if (refs.length === 0) {
      return { status: 'valid' };
    }

    for (const ref of refs) {
      const refId = payload[ref.payloadKey] as UuidV7 | null | undefined;
      if (!refId) {
        continue;
      }

      // 1. Check if referenced entity exists in THIS organization in cloud_sync_events
      const targetTableMeta = cloudSchemaRegistry.get(ref.targetEntity);
      if (!targetTableMeta) {
        continue;
      }

      const inTenantQuery = await tx.execute(sql`
        SELECT 1 FROM ${sql.identifier(ref.targetEntity)}
        WHERE organization_id = ${organizationId} AND id = ${refId}
        LIMIT 1
      `);

      if (inTenantQuery.rows.length > 0) {
        continue; // Reference satisfied!
      }

      // Also check cloud_sync_events in this tenant (in case domain table insert was just committed in same tx)
      const inSyncEvents = await tx
        .select({ id: cloudSyncEvents.id })
        .from(cloudSyncEvents)
        .where(
          and(
            eq(cloudSyncEvents.organizationId, organizationId),
            eq(cloudSyncEvents.entity, ref.targetEntity),
            eq(cloudSyncEvents.entityId, refId),
          ),
        )
        .limit(1);

      if (inSyncEvents.length > 0) {
        continue; // Reference satisfied!
      }

      // 2. Check if referenced entity exists in ANOTHER organization (Cross-tenant leak!) via SECURITY DEFINER function
      const crossTenantQuery = (await tx.execute(sql`
        SELECT sync_check_cross_tenant_entity(${ref.targetEntity}, ${refId}, ${organizationId}) AS exists
      `)) as unknown as QueryResult<{ readonly exists: boolean }>;

      if (crossTenantQuery.rows[0]?.exists === true) {
        return {
          status: 'rejected',
          error: `Cross-tenant reference violation: "${ref.payloadKey}" (${refId}) belongs to another organization`,
        };
      }

      // 3. Not found in any organization -> in-flight reference within this tenant
      return {
        status: 'retry',
        missingRef: {
          targetEntity: ref.targetEntity,
          targetId: refId,
        },
      };
    }

    return { status: 'valid' };
  }

  /**
   * P2: Parks an event with a missing in-tenant dependency into `cloud_sync_parked`.
   */
  private async parkEvent(
    tx: NodePgDatabase,
    context: VerifiedDeviceContext,
    event: SyncEventEnvelopeDto,
    missingRef: MissingReferenceInfo,
    nowMs: UnixMs,
  ): Promise<void> {
    const existing = await tx
      .select({ id: cloudSyncParked.id, attempts: cloudSyncParked.attempts })
      .from(cloudSyncParked)
      .where(
        and(
          eq(cloudSyncParked.organizationId, context.organizationId),
          eq(cloudSyncParked.eventId, event.eventId),
        ),
      )
      .limit(1);

    const payloadStr =
      typeof event.payload === 'string' ? event.payload : JSON.stringify(event.payload);

    if (existing.length > 0) {
      const nextAttempts = existing[0].attempts + 1;
      const status = nextAttempts >= 20 ? 'conflict' : 'parked';
      await tx
        .update(cloudSyncParked)
        .set({
          attempts: nextAttempts,
          status,
          updatedAtMs: nowMs,
        })
        .where(eq(cloudSyncParked.id, existing[0].id));
    } else {
      await tx.insert(cloudSyncParked).values({
        id: event.eventId,
        organizationId: context.organizationId,
        storeId: context.storeId,
        deviceId: context.deviceId,
        eventId: event.eventId,
        entity: event.entity,
        entityId: event.entityId,
        missingRefEntity: missingRef.targetEntity,
        missingRefId: missingRef.targetId,
        attempts: 1,
        eventPayload: payloadStr,
        status: 'parked',
        createdAtMs: nowMs,
        updatedAtMs: nowMs,
      });
    }
  }

  /**
   * P3: Shared MONOTONE state transition check against database state.
   */
  private async checkMonotoneTransition(
    tx: NodePgDatabase,
    tableMeta: PgTableMetadata,
    event: SyncEventEnvelopeDto,
    payload: Record<string, unknown>,
    organizationId: UuidV7,
  ): Promise<'accepted' | 'duplicate' | 'rejected'> {
    const rule = MONOTONE_TRANSITION_RULES[event.entity];
    if (!rule) {
      return 'accepted';
    }

    // Query existing row
    const existingRes = await tx.execute(sql`
      SELECT * FROM ${sql.identifier(tableMeta.tableName)}
      WHERE organization_id = ${organizationId} AND id = ${event.entityId}
      LIMIT 1
    `);

    const existingRow = existingRes.rows[0];
    if (!existingRow) {
      // Row does not exist yet (creation event) -> accepted
      return 'accepted';
    }

    return rule.checkTransition(existingRow, payload);
  }

  /**
   * Applies an event operation to the underlying domain table.
   * - FACT: INSERT
   * - ATTR: LWW Upsert (or soft delete)
   * - MONOTONE: UPDATE or INSERT
   */
  private async applyEventToDomainTable(
    tx: NodePgDatabase,
    tableMeta: PgTableMetadata,
    event: SyncEventEnvelopeDto,
    payload: Record<string, unknown>,
    effectiveHlc: string,
    organizationId: UuidV7,
    nowMs: UnixMs,
  ): Promise<void> {
    const tableName = tableMeta.tableName;

    if (tableMeta.tableClass === 'FACT') {
      // Build column/value pairs
      const keys = Object.keys(payload);
      const cols = keys.map((k) => sql.identifier(camelToSnake(k)));
      const vals = keys.map((k) => payload[k]);

      await tx.execute(sql`
        INSERT INTO ${sql.identifier(tableName)} (${sql.join(cols, sql`, `)})
        VALUES (${sql.join(
          vals.map((v) => sql`${v}`),
          sql`, `,
        )})
      `);
      return;
    }

    if (tableMeta.tableClass === 'ATTR') {
      const existing = await tx.execute(sql`
        SELECT hlc, deleted_at_ms FROM ${sql.identifier(tableName)}
        WHERE organization_id = ${organizationId} AND id = ${event.entityId}
        LIMIT 1
      `);

      if (existing.rows.length > 0) {
        const rawHlc = existing.rows[0]?.hlc;
        const currentHlc = typeof rawHlc === 'string' ? rawHlc : '';
        // LWW: only apply if incoming HLC is strictly greater than current HLC
        if (effectiveHlc > currentHlc) {
          const keys = Object.keys(payload).filter(
            (k) => k !== 'id' && k !== 'organizationId' && k !== 'hlc' && k !== 'updatedAtMs',
          );
          const setClauses = keys.map(
            (k) => sql`${sql.identifier(camelToSnake(k))} = ${payload[k]}`,
          );

          await tx.execute(sql`
            UPDATE ${sql.identifier(tableName)}
            SET ${sql.join(setClauses, sql`, `)}, hlc = ${effectiveHlc}, updated_at_ms = ${nowMs}
            WHERE organization_id = ${organizationId} AND id = ${event.entityId}
          `);
        }
        // If currentHlc >= effectiveHlc, do nothing (LWW win)
        return;
      }

      // Does not exist -> INSERT
      const keys = Object.keys(payload);
      const cols = keys.map((k) => sql.identifier(camelToSnake(k)));
      const vals = keys.map((k) => payload[k]);

      await tx.execute(sql`
        INSERT INTO ${sql.identifier(tableName)} (${sql.join(cols, sql`, `)})
        VALUES (${sql.join(
          vals.map((v) => sql`${v}`),
          sql`, `,
        )})
      `);
      return;
    }

    if (tableMeta.tableClass === 'MONOTONE') {
      const existing = await tx.execute(sql`
        SELECT id FROM ${sql.identifier(tableName)}
        WHERE organization_id = ${organizationId} AND id = ${event.entityId}
        LIMIT 1
      `);

      if (existing.rows.length > 0) {
        const keys = Object.keys(payload).filter(
          (k) => k !== 'id' && k !== 'organizationId' && k !== 'hlc' && k !== 'updatedAtMs',
        );
        const setClauses = keys.map((k) => sql`${sql.identifier(camelToSnake(k))} = ${payload[k]}`);

        await tx.execute(sql`
          UPDATE ${sql.identifier(tableName)}
          SET ${sql.join(setClauses, sql`, `)}, hlc = ${effectiveHlc}, updated_at_ms = ${nowMs}
          WHERE organization_id = ${organizationId} AND id = ${event.entityId}
        `);
        return;
      }

      // Does not exist -> INSERT
      const keys = Object.keys(payload);
      const cols = keys.map((k) => sql.identifier(camelToSnake(k)));
      const vals = keys.map((k) => payload[k]);

      await tx.execute(sql`
        INSERT INTO ${sql.identifier(tableName)} (${sql.join(cols, sql`, `)})
        VALUES (${sql.join(
          vals.map((v) => sql`${v}`),
          sql`, `,
        )})
      `);
    }
  }
}

function camelToSnake(str: string): string {
  return str.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
}
