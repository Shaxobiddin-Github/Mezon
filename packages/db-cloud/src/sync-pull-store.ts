import { and, asc, eq, inArray, notInArray, or, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type pg from 'pg';
import { parseUuidV7 } from '@mezon/domain';
import { type SyncedEventDto, type SyncPullResponseDto } from '@mezon/sync';
import { withPgTenantContext } from './connection.js';
import type { VerifiedDeviceContext } from './device-store.js';
import { cloudSyncEvents, cloudStores } from './schema/index.js';
import { cloudSchemaRegistry } from './schema/registry-instance.js';

export class ForeignStoreError extends Error {
  constructor(storeId: string) {
    super(`Store ID "${storeId}" does not belong to the authenticated organization`);
    this.name = 'ForeignStoreError';
  }
}

export class CloudSyncPullStore {
  constructor(private readonly pool: pg.Pool) {}

  async getSyncPullEvents(params: {
    readonly context: VerifiedDeviceContext;
    readonly cursors: Record<string, bigint>;
    readonly limit: number;
  }): Promise<SyncPullResponseDto> {
    return withPgTenantContext(
      this.pool,
      params.context.organizationId,
      async (tx: NodePgDatabase) => {
        // 1. T5: Validate storeIds in cursors belong to the authenticated organization
        const passedStoreIds = Object.keys(params.cursors);
        if (passedStoreIds.length > 0) {
          const storeUuids = passedStoreIds.map((s) => parseUuidV7(s));
          const foundStores = await tx
            .select({ id: cloudStores.id })
            .from(cloudStores)
            .where(
              and(
                eq(cloudStores.organizationId, params.context.organizationId),
                inArray(cloudStores.id, storeUuids),
              ),
            );
          const foundSet = new Set(foundStores.map((s: { id: string }) => s.id));
          for (const storeId of passedStoreIds) {
            if (!foundSet.has(storeId)) {
              throw new ForeignStoreError(storeId);
            }
          }
        }

        // 2. Identify organization-scoped entities per metadata (T4)
        const orgPullEntities = cloudSchemaRegistry
          .all()
          .filter((m) => m.pullScope === 'organization' || m.tenantScope === 'organization')
          .map((m) => m.tableName);

        const scopeFilter =
          orgPullEntities.length > 0
            ? or(
                inArray(cloudSyncEvents.entity, orgPullEntities),
                eq(cloudSyncEvents.storeId, params.context.storeId),
              )
            : eq(cloudSyncEvents.storeId, params.context.storeId);

        // 3. Build position criteria per store
        const positionConditions = passedStoreIds.map((sId) => {
          const curPos = params.cursors[sId] ?? 0n;
          return and(
            eq(cloudSyncEvents.storeId, parseUuidV7(sId)),
            sql`${cloudSyncEvents.position} > ${curPos}`,
          );
        });

        const positionFilter =
          positionConditions.length > 0
            ? or(
                ...positionConditions,
                and(
                  notInArray(
                    cloudSyncEvents.storeId,
                    passedStoreIds.map((id) => parseUuidV7(id)),
                  ),
                  sql`${cloudSyncEvents.position} > 0`,
                ),
              )
            : sql`${cloudSyncEvents.position} > 0`;

        // 4. Query events:
        const queryLimit = params.limit + 1;

        const rawRows = await tx
          .select()
          .from(cloudSyncEvents)
          .where(
            and(
              eq(cloudSyncEvents.organizationId, params.context.organizationId),
              scopeFilter,
              positionFilter,
            ),
          )
          .orderBy(asc(cloudSyncEvents.position), asc(cloudSyncEvents.storeId))
          .limit(queryLimit);

        const hasMore = rawRows.length > params.limit;
        const rows = hasMore ? rawRows.slice(0, params.limit) : rawRows;

        // 5. Compute next cursors
        const nextCursors: Record<string, string> = {};
        for (const [sId, pos] of Object.entries(params.cursors)) {
          nextCursors[sId] = pos.toString();
        }

        const events: SyncedEventDto[] = rows.map((r: typeof cloudSyncEvents.$inferSelect) => {
          const rowPos = r.position;
          const currentStoreCursor = BigInt(nextCursors[r.storeId] ?? '0');
          if (rowPos > currentStoreCursor) {
            nextCursors[r.storeId] = rowPos.toString();
          }

          let parsedPayload: Record<string, unknown> = {};
          try {
            parsedPayload = JSON.parse(r.payload) as Record<string, unknown>;
          } catch {
            parsedPayload = {};
          }

          return {
            eventId: r.id,
            organizationId: r.organizationId,
            storeId: r.storeId,
            deviceId: r.deviceId,
            deviceSeq: r.deviceSeq.toString(),
            hlc: r.hlc,
            type: r.type,
            entity: r.entity,
            entityId: r.entityId,
            entityClass: r.entityClass as 'FACT' | 'ATTR' | 'MONOTONE',
            schemaVersion: r.schemaVersion,
            payload: parsedPayload,
            position: r.position.toString(),
            hlcAdjusted: r.hlcAdjusted,
            receivedAtMs: Number(r.receivedAtMs),
          };
        });

        return {
          events,
          nextCursors,
          hasMore,
        };
      },
    );
  }
}
