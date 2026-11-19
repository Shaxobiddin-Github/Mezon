import { type UuidV7, parseUuidV7 } from '@mezon/domain';
import { getTableColumns } from 'drizzle-orm';
import type pg from 'pg';
import { withPgTenantContext } from './connection.js';
import { cloudSchemaRegistry } from './schema/registry-instance.js';

/** A synced row as an ordinary sync payload: camelCase keys, bigint as decimal strings. */
export type SyncRowPayload = Record<string, string | number | boolean | null>;

function columnMap(tableName: string): Map<string, string> {
  const meta = cloudSchemaRegistry.get(tableName);
  if (!meta) throw new Error(`Unknown table "${tableName}"`);
  const map = new Map<string, string>();
  for (const [prop, col] of Object.entries(getTableColumns(meta.table))) {
    map.set((col as { name: string }).name, prop);
  }
  return map;
}

function toPayload(map: Map<string, string>, row: Record<string, unknown>): SyncRowPayload {
  const out: SyncRowPayload = {};
  for (const [name, value] of Object.entries(row)) {
    const prop = map.get(name);
    if (prop === undefined) continue;
    out[prop] =
      typeof value === 'bigint'
        ? value.toString()
        : ((value as string | number | boolean | null | undefined) ?? null);
  }
  return out;
}

/** The camelCase property names of a synced table (to build a new row's payload). */
export function syncPayloadKeys(tableName: string): readonly string[] {
  return [...columnMap(tableName).values()];
}

export interface CabinetActor {
  readonly cloudUserId: UuidV7;
  readonly role: 'owner' | 'manager';
  readonly username: string;
  /** The hub `users` row this cabinet login belongs to, when linked. */
  readonly hubUserId: UuidV7 | null;
}

/**
 * T2.7b reads for cabinet writes. Every read runs under the organization's RLS context, so a row of
 * another organization is simply not found.
 */
export class CloudCabinetStore {
  constructor(private readonly pool: pg.Pool) {}

  /** The current row of an organization-scoped synced table as a sync payload, or null. */
  async loadOrgRow(
    organizationId: UuidV7,
    tableName: 'products' | 'users' | 'customers' | 'categories',
    id: UuidV7,
  ): Promise<SyncRowPayload | null> {
    const map = columnMap(tableName);
    return withPgTenantContext(this.pool, organizationId, async (_tx, client) => {
      const res = await client.query<Record<string, unknown>>(
        `SELECT * FROM "${tableName}" WHERE organization_id = $1 AND id = $2 AND deleted_at_ms IS NULL`,
        [organizationId, id],
      );
      return res.rows[0] ? toPayload(map, res.rows[0]) : null;
    });
  }

  /**
   * The signed-in cabinet user as they are NOW (role and status from the database, not from the
   * access token, which may be minutes old). Null when blocked or no longer owner/manager.
   */
  async getActor(organizationId: UuidV7, cloudUserId: UuidV7): Promise<CabinetActor | null> {
    return withPgTenantContext(this.pool, organizationId, async (_tx, client) => {
      const res = await client.query<{
        id: string;
        role: string;
        username: string;
        status: string;
        hub_user_id: string | null;
      }>(
        `SELECT id, role, username, status, hub_user_id FROM cloud_users
          WHERE organization_id = $1 AND id = $2`,
        [organizationId, cloudUserId],
      );
      const r = res.rows[0];
      if (!r || r.status !== 'active' || (r.role !== 'owner' && r.role !== 'manager')) return null;
      let hubUserId: UuidV7 | null = null;
      try {
        hubUserId = r.hub_user_id === null ? null : parseUuidV7(r.hub_user_id);
      } catch {
        hubUserId = null;
      }
      return { cloudUserId: parseUuidV7(r.id), role: r.role, username: r.username, hubUserId };
    });
  }

  /** Price history of a product (newest first), with who changed it. */
  async listPriceChanges(
    organizationId: UuidV7,
    productId: UuidV7,
    limit = 50,
  ): Promise<
    {
      id: string;
      oldPrice: string | null;
      newPrice: string;
      changedByName: string | null;
      reason: string | null;
      createdAtMs: string;
    }[]
  > {
    return withPgTenantContext(this.pool, organizationId, async (_tx, client) => {
      const res = await client.query<{
        id: string;
        old_price: string | null;
        new_price: string;
        full_name: string | null;
        reason: string | null;
        created_at_ms: string;
      }>(
        `SELECT pc.id, pc.old_price::text AS old_price, pc.new_price::text AS new_price,
                u.full_name, pc.reason, pc.created_at_ms::text AS created_at_ms
           FROM price_changes pc
           LEFT JOIN users u ON u.organization_id = pc.organization_id AND u.id = pc.changed_by_user_id
          WHERE pc.organization_id = $1 AND pc.product_id = $2
          ORDER BY pc.created_at_ms DESC, pc.id DESC
          LIMIT $3`,
        [organizationId, productId, limit],
      );
      return res.rows.map((r) => ({
        id: r.id,
        oldPrice: r.old_price,
        newPrice: r.new_price,
        changedByName: r.full_name,
        reason: r.reason,
        createdAtMs: r.created_at_ms,
      }));
    });
  }
}

/** A cabinet command (same shape as `CloudCommand` of the event writer). */
export interface CabinetCommand {
  readonly entity: string;
  readonly entityId: UuidV7;
  readonly type: string;
  readonly payload: SyncRowPayload;
}

/**
 * T2.7b attribution row for a cabinet login that is not linked to a hub user: inactive, and with no
 * PIN (credentials are hub-local), so it only names who changed what and can never sign in.
 */
export function cabinetAttributionUserCommand(p: {
  readonly organizationId: UuidV7;
  readonly cloudUserId: UuidV7;
  readonly username: string;
  readonly role: 'owner' | 'manager';
  readonly nowMs: bigint | number;
}): CabinetCommand {
  const now = String(p.nowMs);
  return {
    entity: 'users',
    entityId: p.cloudUserId,
    type: 'user.created',
    payload: {
      id: p.cloudUserId,
      organizationId: p.organizationId,
      username: `kabinet-${p.cloudUserId.slice(-12)}`,
      fullName: `Kabinet: ${p.username}`.slice(0, 120),
      role: p.role,
      isActive: false,
      deviceId: p.cloudUserId, // replaced by the writer
      hlc: '', // replaced by the writer
      createdAtMs: now,
      updatedAtMs: now,
      deletedAtMs: null,
    },
  };
}

/** T2.7b price change: the product row with the new price, and the price-history fact. */
export function priceChangeCommands(p: {
  readonly organizationId: UuidV7;
  readonly product: SyncRowPayload;
  readonly newPriceTiyin: bigint;
  readonly changedByUserId: UuidV7;
  readonly reason: string | null;
  readonly priceChangeId: UuidV7;
  readonly nowMs: bigint | number;
}): CabinetCommand[] {
  const now = String(p.nowMs);
  const productId = parseUuidV7(String(p.product.id));
  const oldPrice = p.product.salePrice === null ? null : String(p.product.salePrice);
  const newPrice = p.newPriceTiyin.toString();
  return [
    {
      entity: 'products',
      entityId: productId,
      type: 'product.updated',
      payload: { ...p.product, salePrice: newPrice, updatedAtMs: now },
    },
    {
      entity: 'price_changes',
      entityId: p.priceChangeId,
      type: 'price_change.recorded',
      payload: {
        id: p.priceChangeId,
        organizationId: p.organizationId,
        productId,
        variantId: null,
        oldPrice,
        newPrice,
        changedByUserId: p.changedByUserId,
        reason: p.reason,
        deviceId: p.priceChangeId, // replaced by the writer
        hlc: '', // replaced by the writer
        createdAtMs: now,
      },
    },
  ];
}
