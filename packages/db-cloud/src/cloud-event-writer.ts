import {
  CURRENT_SCHEMA_VERSION,
  type SyncEventEnvelopeDto,
  type SyncEventResultDto,
} from '@mezon/sync';
import {
  MAX_HLC_COUNTER,
  type UnixMs,
  type UuidV7,
  parseHlc,
  parseUuidV7,
  serializeHlc,
  unixMsFromBigInt,
} from '@mezon/domain';
import type pg from 'pg';
import { withPgTenantContext } from './connection.js';
import type { VerifiedDeviceContext } from './device-store.js';
import { cloudSchemaRegistry } from './schema/registry-instance.js';
import type { CloudSyncPushStore } from './sync-push-store.js';

/** One cabinet change (price, staff, setting): an ordinary sync event payload of an org table. */
export interface CloudCommand {
  readonly entity: string;
  readonly entityId: UuidV7;
  /** Event type, e.g. `products.updated`. */
  readonly type: string;
  readonly payload: Record<string, unknown>;
}

export interface CloudEventWriteResult {
  readonly results: readonly (SyncEventResultDto & { readonly hlc?: string })[];
}

/** Status of the organization's virtual cloud device: never `active`, so it can never get a token. */
export const CLOUD_VIRTUAL_DEVICE_STATUS = 'system';

/**
 * T2.6b — the port the cabinet (T2.7b) writes through, so a change made in the cloud reaches every
 * hub of the organization by the normal pull.
 *
 * - **HLC.** `cloud_hlc_state` keeps the organization's cloud clock. Under the advisory lock
 *   `org_hlc:<org>` each command gets `physical = max(now, last.physical, row.physical)` and a logical
 *   counter that strictly increases within a millisecond; it is also strictly above the HLC the row
 *   already has (HLC "receive"), so a hub whose clock ran ahead can never make a cabinet change lose
 *   last-writer-wins. Counter overflow moves to the next millisecond.
 * - **Position stream.** Organization events form their own stream: `store_id = organization_id`,
 *   positions in `cloud_store_sync_positions` under that key. Hubs see it in `{storeId → position}`
 *   like any store (the pull accepts the organization id as a cursor key).
 * - **Virtual device.** One `cloud_devices` row per organization, status `system`: device-token auth
 *   rejects every non-`active` device, and no token is ever issued for it.
 * - **Same validation.** Envelopes go through `CloudSyncPushStore.processSyncPushBatch` — the very
 *   code a hub push takes (tenant, schema, Zod payload, references / parking, MONOTONE rules,
 *   dedup, positions). Store-scoped entities are refused up front: only the hub of a store writes
 *   them (single-writer rule).
 */
export class CloudEventWriter {
  constructor(
    private readonly pool: pg.Pool,
    private readonly pushStore: CloudSyncPushStore,
    private readonly idGen: { nextId(): UuidV7 },
  ) {}

  async write(params: {
    readonly organizationId: UuidV7;
    readonly commands: readonly CloudCommand[];
    readonly nowMs: UnixMs;
  }): Promise<CloudEventWriteResult> {
    const org = parseUuidV7(params.organizationId);
    const results: (SyncEventResultDto & { hlc?: string })[] = [];
    const allowed: CloudCommand[] = [];
    const eventIds = new Map<CloudCommand, UuidV7>();
    for (const c of params.commands) {
      const eventId = this.idGen.nextId();
      eventIds.set(c, eventId);
      const meta = cloudSchemaRegistry.get(c.entity);
      if (
        meta === undefined ||
        meta.tableClass === 'LOCAL' ||
        meta.tenantScope !== 'organization'
      ) {
        results.push({
          eventId,
          status: 'rejected',
          reason: 'VALIDATION_ERROR',
          error: `ORG_STREAM_STORE_ENTITY: "${c.entity}" is not an organization table the cloud may write`,
        });
        continue;
      }
      allowed.push(c);
    }
    if (allowed.length === 0) return { results };

    const allocated = await withPgTenantContext(this.pool, org, async (_tx, client) => {
      await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`org_hlc:${org}`]);
      const st = await client.query<{
        device_id: string;
        physical_ms: string;
        logical: number;
        last_device_seq: string;
      }>(
        `SELECT device_id, physical_ms::text AS physical_ms, logical, last_device_seq::text AS last_device_seq
           FROM cloud_hlc_state WHERE organization_id = $1`,
        [org],
      );
      let deviceId: UuidV7;
      let physical: bigint;
      let logical: number;
      let seq: bigint;
      const now = BigInt(params.nowMs);
      if (st.rows[0]) {
        deviceId = parseUuidV7(st.rows[0].device_id);
        physical = BigInt(st.rows[0].physical_ms);
        logical = st.rows[0].logical;
        seq = BigInt(st.rows[0].last_device_seq);
      } else {
        deviceId = this.idGen.nextId();
        physical = 0n;
        logical = 0;
        seq = 0n;
        await client.query(
          `INSERT INTO cloud_devices (id, organization_id, store_id, device_id, name, platform, app_version, status, last_seen_at_ms, created_at_ms, updated_at_ms)
           VALUES ($1, $2, $3, $4, 'Bulut (kabinet)', 'cloud', '0', $5, $6, $6, $6)`,
          [this.idGen.nextId(), org, org, deviceId, CLOUD_VIRTUAL_DEVICE_STATUS, String(now)],
        );
      }
      const out: { command: CloudCommand; hlc: string; seq: bigint }[] = [];
      for (const c of allowed) {
        const meta = cloudSchemaRegistry.get(c.entity)!;
        const row = await client.query<{ hlc: string }>(
          `SELECT hlc FROM "${meta.tableName}" WHERE organization_id = $1 AND id = $2`,
          [org, c.entityId],
        );
        let rowPhysical = -1n;
        let rowLogical = -1;
        if (row.rows[0]?.hlc) {
          const h = parseHlc(row.rows[0].hlc);
          rowPhysical = BigInt(h.physicalMs);
          rowLogical = h.logical;
        }
        const target = [now, physical, rowPhysical].reduce((a, b) => (a > b ? a : b));
        let nextLogical = 0;
        if (target === physical) nextLogical = logical + 1;
        if (target === rowPhysical && rowLogical + 1 > nextLogical) nextLogical = rowLogical + 1;
        physical = target;
        logical = nextLogical;
        if (logical > MAX_HLC_COUNTER) {
          physical += 1n;
          logical = 0;
        }
        seq += 1n;
        out.push({
          command: c,
          hlc: serializeHlc({ physicalMs: unixMsFromBigInt(physical), logical, nodeId: deviceId }),
          seq,
        });
      }
      await client.query(
        `INSERT INTO cloud_hlc_state (id, organization_id, created_at_ms, updated_at_ms, device_id, physical_ms, logical, last_device_seq)
         VALUES ($1, $2, $3, $3, $4, $5, $6, $7)
         ON CONFLICT (organization_id) DO UPDATE SET
           physical_ms = EXCLUDED.physical_ms, logical = EXCLUDED.logical,
           last_device_seq = EXCLUDED.last_device_seq, updated_at_ms = EXCLUDED.updated_at_ms`,
        [this.idGen.nextId(), org, String(now), deviceId, String(physical), logical, String(seq)],
      );
      return { deviceId, out };
    });

    const events: SyncEventEnvelopeDto[] = allocated.out.map(({ command, hlc, seq }) => ({
      eventId: eventIds.get(command)!,
      organizationId: org,
      storeId: org,
      deviceId: allocated.deviceId,
      deviceSeq: seq.toString(),
      hlc,
      type: command.type,
      entity: command.entity,
      entityId: command.entityId,
      entityClass: cloudSchemaRegistry.get(command.entity)!
        .tableClass as SyncEventEnvelopeDto['entityClass'],
      schemaVersion: CURRENT_SCHEMA_VERSION,
      // The device and HLC inside the payload are the allocated ones, never the caller's.
      payload: {
        ...command.payload,
        ...('deviceId' in command.payload ? { deviceId: allocated.deviceId } : {}),
        ...('hlc' in command.payload ? { hlc } : {}),
      },
    }));
    const context: VerifiedDeviceContext = {
      organizationId: org,
      storeId: org,
      deviceId: allocated.deviceId,
      deviceName: 'Bulut (kabinet)',
      status: 'active', // in-process caller; the stored device row stays `system` (no token)
    };
    const pushed = await this.pushStore.processSyncPushBatch({
      context,
      events,
      nowMs: params.nowMs,
    });
    const hlcByEvent = new Map(events.map((e) => [e.eventId, e.hlc]));
    for (const r of pushed.results) results.push({ ...r, hlc: hlcByEvent.get(r.eventId) });
    return { results };
  }
}
