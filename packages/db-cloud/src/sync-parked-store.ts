import { DomainError, type UnixMs, type UuidV7 } from '@mezon/domain';
import type pg from 'pg';
import { withPgTenantContext } from './connection.js';
import type { VerifiedDeviceContext } from './device-store.js';

export interface CloudParkedEventRecord {
  readonly id: string;
  readonly eventId: string;
  readonly entity: string;
  readonly entityId: string;
  readonly missingRefEntity: string;
  readonly missingRefId: string;
  readonly attempts: number;
  readonly status: 'parked' | 'conflict' | 'resolved';
  readonly resolution: 'retried' | 'acknowledged' | null;
  readonly resolvedByUserId: string | null;
  readonly resolvedAtMs: string | null;
  readonly resolutionNote: string | null;
  readonly createdAtMs: string;
}

interface Row {
  id: string;
  event_id: string;
  entity: string;
  entity_id: string;
  missing_ref_entity: string;
  missing_ref_id: string;
  attempts: number;
  status: CloudParkedEventRecord['status'];
  resolution: CloudParkedEventRecord['resolution'];
  resolved_by_user_id: string | null;
  resolved_at_ms: string | null;
  resolution_note: string | null;
  created_at_ms: string;
}

const COLUMNS = `id, event_id, entity, entity_id, missing_ref_entity, missing_ref_id, attempts, status,
  resolution, resolved_by_user_id, resolved_at_ms::text AS resolved_at_ms, resolution_note,
  created_at_ms::text AS created_at_ms`;

function toRecord(r: Row): CloudParkedEventRecord {
  return {
    id: r.id,
    eventId: r.event_id,
    entity: r.entity,
    entityId: r.entity_id,
    missingRefEntity: r.missing_ref_entity,
    missingRefId: r.missing_ref_id,
    attempts: Number(r.attempts),
    status: r.status,
    resolution: r.resolution,
    resolvedByUserId: r.resolved_by_user_id,
    resolvedAtMs: r.resolved_at_ms,
    resolutionNote: r.resolution_note,
    createdAtMs: r.created_at_ms,
  };
}

/**
 * T2.6: the cloud side of parked push events (`cloud_sync_parked`), seen and resolved by the hub that
 * pushed them (device token; tenant RLS + the device's own store). No data is edited:
 * - `retry` resets the attempt counter so the hub's next pushes get a fresh window (repeatable);
 * - `acknowledge` closes it for good (`status = 'resolved'`), with the hub user and note as audit.
 */
export class CloudSyncParkedStore {
  constructor(private readonly pool: pg.Pool) {}

  async listForDevice(device: VerifiedDeviceContext): Promise<CloudParkedEventRecord[]> {
    return withPgTenantContext(this.pool, device.organizationId, async (_tx, client) => {
      const res = await client.query<Row>(
        `SELECT ${COLUMNS} FROM cloud_sync_parked
          WHERE organization_id = $1 AND store_id = $2 AND status <> 'resolved'
          ORDER BY created_at_ms DESC, id DESC LIMIT 500`,
        [device.organizationId, device.storeId],
      );
      return res.rows.map(toRecord);
    });
  }

  async resolve(params: {
    readonly device: VerifiedDeviceContext;
    readonly id: UuidV7;
    readonly action: 'retry' | 'acknowledge';
    readonly userId: UuidV7;
    readonly note: string | null;
    readonly nowMs: UnixMs;
  }): Promise<CloudParkedEventRecord> {
    const d = params.device;
    return withPgTenantContext(this.pool, d.organizationId, async (_tx, client) => {
      const current = await client.query<Row>(
        `SELECT ${COLUMNS} FROM cloud_sync_parked
          WHERE organization_id = $1 AND store_id = $2 AND id = $3 FOR UPDATE`,
        [d.organizationId, d.storeId, params.id],
      );
      const row = current.rows[0];
      if (!row) throw new DomainError('SYNC_CONFLICT_NOT_FOUND', 'Parked event not found');
      if (row.status === 'resolved') {
        throw new DomainError('SYNC_CONFLICT_ALREADY_RESOLVED', 'Parked event already resolved');
      }
      const now = String(params.nowMs);
      const res = await client.query<Row>(
        params.action === 'retry'
          ? `UPDATE cloud_sync_parked
                SET attempts = 0, status = 'parked', resolution = 'retried',
                    resolved_by_user_id = $4, resolved_at_ms = $5, resolution_note = $6,
                    updated_at_ms = $5
              WHERE organization_id = $1 AND store_id = $2 AND id = $3
              RETURNING ${COLUMNS}`
          : `UPDATE cloud_sync_parked
                SET status = 'resolved', resolution = 'acknowledged',
                    resolved_by_user_id = $4, resolved_at_ms = $5, resolution_note = $6,
                    updated_at_ms = $5
              WHERE organization_id = $1 AND store_id = $2 AND id = $3
              RETURNING ${COLUMNS}`,
        [d.organizationId, d.storeId, params.id, params.userId, now, params.note],
      );
      return toRecord(res.rows[0]);
    });
  }
}
