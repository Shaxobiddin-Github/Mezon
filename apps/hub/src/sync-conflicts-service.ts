import type {
  SyncConflictDto,
  SyncConflictListResponseDto,
  SyncParkedListResponseDto,
} from '@mezon/contracts';
import type { LocalSqliteConnection } from '@mezon/db-local';
import { DomainError, type UnixMs, type UuidV7, parseUuidV7 } from '@mezon/domain';
import {
  CUSTOMER_OVERPAID,
  type HubSyncPullService,
  PROJECTION_FAILED,
} from './sync-pull-service.js';

export interface SyncConflictContext {
  readonly organizationId: UuidV7;
  readonly storeId: UuidV7;
  readonly deviceId: UuidV7;
}

export interface HubSyncConflictServiceOptions {
  readonly connection: LocalSqliteConnection;
  readonly pullService: HubSyncPullService;
  readonly getContext: () => SyncConflictContext | null;
  readonly nowMs: () => UnixMs;
}

interface ConflictRow {
  id: string;
  organization_id: string;
  store_id: string | null;
  event_id: string;
  entity: string;
  entity_id: string;
  reason: string;
  error: string | null;
  event_json: string | null;
  created_at_ms: number | bigint;
  resolved_at_ms: number | bigint | null;
  resolution: 'retried' | 'acknowledged' | 'auto' | null;
  resolved_by_user_id: string | null;
  resolution_note: string | null;
  in_outbox: number | bigint;
}

const SELECT_CONFLICT = `SELECT c.*, EXISTS (SELECT 1 FROM local_outbox o WHERE o.id = c.event_id) AS in_outbox
  FROM local_sync_conflicts c`;

type Origin = SyncConflictDto['origin'];

function originOf(row: ConflictRow): Origin {
  if (Number(row.in_outbox) === 1) return 'push';
  if (row.reason === PROJECTION_FAILED || row.reason === CUSTOMER_OVERPAID) return 'projection';
  return 'pull';
}

/**
 * Which actions a conflict allows. There is never an action that edits data:
 * - `retry` re-sends a rejected push (same event id; the cloud dedups), re-applies a pulled event
 *   from its stored envelope, or recomputes a failed projection key;
 * - `acknowledge` only records that a person has looked at it.
 * An overpayment is view-only: how the money is returned is the owner's decision (S6).
 */
function allowedActions(row: ConflictRow): SyncConflictDto['allowedActions'] {
  if (row.resolved_at_ms !== null) return [];
  const origin = originOf(row);
  const canRetry =
    origin === 'push' ||
    (origin === 'pull' && row.event_json !== null) ||
    (origin === 'projection' && row.reason === PROJECTION_FAILED);
  return canRetry ? ['retry', 'acknowledge'] : ['acknowledge'];
}

function toDto(row: ConflictRow): SyncConflictDto {
  return {
    id: parseUuidV7(row.id),
    origin: originOf(row),
    storeId: row.store_id === null ? null : parseUuidV7(row.store_id),
    eventId: parseUuidV7(row.event_id),
    entity: row.entity,
    entityId: parseUuidV7(row.entity_id),
    reason: row.reason,
    error: row.error,
    allowedActions: allowedActions(row),
    createdAtMs: String(row.created_at_ms),
    resolvedAtMs: row.resolved_at_ms === null ? null : String(row.resolved_at_ms),
    resolution: row.resolution,
    resolvedByUserId:
      row.resolved_by_user_id === null ? null : parseUuidV7(row.resolved_by_user_id),
    resolutionNote: row.resolution_note,
  };
}

/** T2.6: view and resolve sync conflicts on the hub (manager / owner), with an audit trail. */
export class HubSyncConflictService {
  constructor(private readonly o: HubSyncConflictServiceOptions) {}

  private ctx(): SyncConflictContext {
    const c = this.o.getContext();
    if (c === null) throw new DomainError('AUTH_UNAUTHORIZED', 'Hub setup has not been completed');
    return c;
  }

  private row(id: UuidV7): ConflictRow {
    const c = this.ctx();
    const row = this.o.connection.sqlite
      .prepare(`${SELECT_CONFLICT} WHERE c.id = ? AND c.organization_id = ?`)
      .get(id, c.organizationId) as ConflictRow | undefined;
    if (!row) throw new DomainError('SYNC_CONFLICT_NOT_FOUND', 'Sync conflict not found');
    return row;
  }

  list(status: 'open' | 'resolved'): SyncConflictListResponseDto {
    const c = this.ctx();
    const rows = this.o.connection.sqlite
      .prepare(
        `${SELECT_CONFLICT} WHERE c.organization_id = ? AND c.resolved_at_ms IS ${
          status === 'open' ? 'NULL' : 'NOT NULL'
        } ORDER BY c.created_at_ms DESC, c.id DESC LIMIT 500`,
      )
      .all(c.organizationId) as ConflictRow[];
    return { conflicts: rows.map(toDto) };
  }

  listParked(): SyncParkedListResponseDto {
    const c = this.ctx();
    const rows = this.o.connection.sqlite
      .prepare(
        `SELECT id, event_id, entity, entity_id, missing_ref_entity, missing_ref_id, attempts, created_at_ms
           FROM local_sync_parked WHERE organization_id = ?
          ORDER BY created_at_ms DESC, id DESC LIMIT 500`,
      )
      .all(c.organizationId) as {
      id: string;
      event_id: string;
      entity: string;
      entity_id: string;
      missing_ref_entity: string;
      missing_ref_id: string;
      attempts: number | bigint;
      created_at_ms: number | bigint;
    }[];
    return {
      parked: rows.map((r) => ({
        id: parseUuidV7(r.id),
        eventId: parseUuidV7(r.event_id),
        entity: r.entity,
        entityId: parseUuidV7(r.entity_id),
        missingRefEntity: r.missing_ref_entity,
        missingRefId: r.missing_ref_id,
        attempts: Number(r.attempts),
        createdAtMs: String(r.created_at_ms),
      })),
    };
  }

  resolve(params: {
    readonly id: UuidV7;
    readonly action: 'retry' | 'acknowledge';
    readonly note: string | null;
    readonly userId: UuidV7;
  }): { conflict: SyncConflictDto; applied: boolean } {
    const row = this.row(params.id);
    if (row.resolved_at_ms !== null) {
      throw new DomainError('SYNC_CONFLICT_ALREADY_RESOLVED', 'Sync conflict is already resolved');
    }
    if (!allowedActions(row).includes(params.action)) {
      throw new DomainError(
        'SYNC_CONFLICT_ACTION_NOT_ALLOWED',
        `Action "${params.action}" is not allowed for this conflict`,
        { details: { reason: row.reason, origin: originOf(row) } },
      );
    }
    const sqlite = this.o.connection.sqlite;
    const nowMs = this.o.nowMs();
    const close = (resolution: 'retried' | 'acknowledged') => {
      const res = sqlite
        .prepare(
          `UPDATE local_sync_conflicts
              SET resolved_at_ms = ?, resolution = ?, resolved_by_user_id = ?, resolution_note = ?,
                  updated_at_ms = ?
            WHERE id = ? AND resolved_at_ms IS NULL`,
        )
        .run(nowMs, resolution, params.userId, params.note, nowMs, params.id);
      if (res.changes === 0) {
        throw new DomainError(
          'SYNC_CONFLICT_ALREADY_RESOLVED',
          'Sync conflict is already resolved',
        );
      }
    };

    let applied = false;
    if (params.action === 'acknowledge') {
      close('acknowledged');
    } else {
      const origin = originOf(row);
      if (origin === 'push') {
        // Same event id back to the outbox queue: the cloud deduplicates on it.
        sqlite.transaction(() => {
          sqlite
            .prepare(
              `UPDATE local_outbox SET status = 'pending', last_error = NULL, updated_at_ms = ?
                WHERE id = ? AND status = 'rejected'`,
            )
            .run(nowMs, row.event_id);
          close('retried');
        })();
        applied = true;
      } else if (origin === 'pull') {
        applied = this.o.pullService.retryConflictEvent({
          conflictId: params.id,
          userId: params.userId,
          note: params.note,
          context: this.ctx(),
          nowMs,
        });
      } else {
        const c = this.ctx();
        this.o.pullService.recomputeOpenProjectionConflicts({ context: c, nowMs });
        const after = this.row(params.id);
        if (after.resolved_at_ms !== null) {
          sqlite
            .prepare(
              `UPDATE local_sync_conflicts
                  SET resolution = 'retried', resolved_by_user_id = ?, resolution_note = ?
                WHERE id = ?`,
            )
            .run(params.userId, params.note, params.id);
          applied = true;
        }
      }
    }
    return { conflict: toDto(this.row(params.id)), applied };
  }
}
