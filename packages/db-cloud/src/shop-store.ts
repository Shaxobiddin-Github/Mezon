import { DomainError, type UnixMs, type UuidV7, parseUuidV7 } from '@mezon/domain';
import type pg from 'pg';
import { withPgTenantContext } from './connection.js';

export type ShopOrderStatus = 'new' | 'accepted' | 'ready' | 'done' | 'cancelled';
export type ShopFulfilment = 'pickup' | 'delivery';

export interface ShopSettings {
  readonly id: string;
  readonly storeId: string;
  readonly slug: string;
  readonly title: string;
  readonly phone: string | null;
  readonly address: string | null;
  readonly about: string | null;
  readonly isEnabled: boolean;
}

export interface ShopProductRow {
  readonly productId: string;
  readonly name: string;
  readonly unit: string;
  readonly priceTiyin: bigint;
  readonly categoryName: string | null;
  /** Stock in milli-units at the shop's store; null for unlimited (service) products. */
  readonly stockMilli: bigint | null;
  readonly isPublished: boolean;
}

export interface ShopOrderLineRow {
  readonly productId: string;
  readonly name: string;
  readonly unit: string;
  readonly qtyMilli: bigint;
  readonly priceTiyin: bigint;
  readonly totalTiyin: bigint;
}

export interface ShopOrderRow {
  readonly id: string;
  readonly orderNo: number;
  readonly customerName: string;
  readonly customerPhone: string;
  readonly fulfilment: ShopFulfilment;
  readonly address: string | null;
  readonly note: string | null;
  readonly status: ShopOrderStatus;
  readonly totalTiyin: bigint;
  readonly createdAtMs: bigint;
  readonly updatedAtMs: bigint;
  readonly lines: readonly ShopOrderLineRow[];
}

export interface ShopLookup {
  readonly organizationId: UuidV7;
  readonly storeId: string;
  readonly shopId: string;
}

/** Order status moves the shop may make (forward only; cancel until handed over). */
export const SHOP_ORDER_TRANSITIONS: Readonly<Record<ShopOrderStatus, readonly ShopOrderStatus[]>> =
  {
    new: ['accepted', 'cancelled'],
    accepted: ['ready', 'cancelled'],
    ready: ['done', 'cancelled'],
    done: [],
    cancelled: [],
  };

const MAX_ORDER_LINES = 50;

/**
 * V2 / F5 online shop storage. The public side reaches a tenant ONLY through `lookupSlug`
 * (SECURITY DEFINER); every other call runs under `withPgTenantContext` (RLS).
 */
export class CloudShopStore {
  constructor(
    private readonly pool: pg.Pool,
    private readonly nextId: () => UuidV7,
  ) {}

  async lookupSlug(slug: string): Promise<ShopLookup | null> {
    if (!/^[a-z0-9][a-z0-9-]{2,39}$/.test(slug)) return null;
    const res = await this.pool.query<{
      organization_id: string;
      store_id: string;
      shop_id: string;
    }>('SELECT organization_id, store_id, shop_id FROM shop_lookup_slug($1)', [slug]);
    const r = res.rows[0];
    return r
      ? { organizationId: parseUuidV7(r.organization_id), storeId: r.store_id, shopId: r.shop_id }
      : null;
  }

  /** The organization's shop (one per org for now: its first active store). */
  async getShop(organizationId: UuidV7): Promise<ShopSettings | null> {
    return withPgTenantContext(this.pool, organizationId, async (_tx, client) =>
      readShop(client, organizationId),
    );
  }

  async saveShop(params: {
    readonly organizationId: UuidV7;
    readonly slug: string;
    readonly title: string;
    readonly phone: string | null;
    readonly address: string | null;
    readonly about: string | null;
    readonly isEnabled: boolean;
    readonly nowMs: UnixMs;
  }): Promise<ShopSettings> {
    try {
      return await withPgTenantContext(this.pool, params.organizationId, async (_tx, client) => {
        const existing = await readShop(client, params.organizationId);
        if (existing) {
          await client.query(
            `UPDATE cloud_shops SET slug = $2, title = $3, phone = $4, address = $5, about = $6,
                    is_enabled = $7, updated_at_ms = $8
              WHERE organization_id = $1 AND id = $9`,
            [
              params.organizationId,
              params.slug,
              params.title,
              params.phone,
              params.address,
              params.about,
              params.isEnabled,
              params.nowMs,
              existing.id,
            ],
          );
        } else {
          const store = await client.query<{ id: string }>(
            `SELECT id FROM cloud_stores WHERE organization_id = $1 AND is_active
              ORDER BY created_at_ms, id LIMIT 1`,
            [params.organizationId],
          );
          const storeId = store.rows[0]?.id;
          if (!storeId) throw new DomainError('STORE_NOT_FOUND', 'Organization has no store');
          await client.query(
            `INSERT INTO cloud_shops (id, organization_id, created_at_ms, updated_at_ms, store_id,
                    slug, title, phone, address, about, is_enabled)
             VALUES ($1, $2, $3, $3, $4, $5, $6, $7, $8, $9, $10)`,
            [
              this.nextId(),
              params.organizationId,
              params.nowMs,
              storeId,
              params.slug,
              params.title,
              params.phone,
              params.address,
              params.about,
              params.isEnabled,
            ],
          );
        }
        const saved = await readShop(client, params.organizationId);
        if (!saved) throw new Error('shop not saved');
        return saved;
      });
    } catch (err) {
      if ((err as { code?: string }).code === '23505') {
        throw new DomainError('VALIDATION_ERROR', 'This shop link is taken', {
          details: { field: 'slug', reason: 'taken' },
        });
      }
      throw err;
    }
  }

  /** Cabinet: every active product with its online flag. Public: only published ones. */
  async listProducts(
    organizationId: UuidV7,
    storeId: string,
    onlyPublished: boolean,
  ): Promise<ShopProductRow[]> {
    return withPgTenantContext(this.pool, organizationId, async (_tx, client) => {
      const res = await client.query<{
        id: string;
        name: string;
        unit: string;
        sale_price: string;
        unlimited: boolean;
        category_name: string | null;
        stock: string;
        is_published: boolean | null;
      }>(
        `SELECT p.id, p.name, p.unit, p.sale_price, p.unlimited, c.name AS category_name,
                COALESCE((SELECT SUM(sm.qty_delta) FROM stock_moves sm
                           WHERE sm.organization_id = p.organization_id AND sm.product_id = p.id
                             AND sm.store_id = $2::uuid), 0) AS stock,
                sp.is_published
           FROM products p
           LEFT JOIN categories c ON c.id = p.category_id AND c.organization_id = p.organization_id
           LEFT JOIN cloud_shop_products sp
                  ON sp.organization_id = p.organization_id AND sp.product_id = p.id::text
          WHERE p.organization_id = $1 AND p.deleted_at_ms IS NULL AND NOT p.has_variants
            ${onlyPublished ? 'AND sp.is_published IS TRUE AND p.sale_price > 0' : ''}
          ORDER BY c.name NULLS LAST, p.name
          LIMIT 2000`,
        [organizationId, storeId],
      );
      return res.rows.map((r) => ({
        productId: r.id,
        name: r.name,
        unit: r.unit,
        priceTiyin: BigInt(r.sale_price),
        categoryName: r.category_name,
        stockMilli: r.unlimited ? null : BigInt(r.stock),
        isPublished: r.is_published === true,
      }));
    });
  }

  async setPublished(params: {
    readonly organizationId: UuidV7;
    readonly productIds: readonly UuidV7[];
    readonly isPublished: boolean;
    readonly nowMs: UnixMs;
  }): Promise<number> {
    return withPgTenantContext(this.pool, params.organizationId, async (_tx, client) => {
      let changed = 0;
      for (const productId of params.productIds) {
        const exists = await client.query(
          'SELECT 1 FROM products WHERE organization_id = $1 AND id = $2 AND deleted_at_ms IS NULL',
          [params.organizationId, productId],
        );
        if (exists.rowCount === 0) continue;
        await client.query(
          `INSERT INTO cloud_shop_products (id, organization_id, created_at_ms, updated_at_ms,
                  product_id, is_published)
           VALUES ($1, $2, $3, $3, $4, $5)
           ON CONFLICT (organization_id, product_id)
           DO UPDATE SET is_published = EXCLUDED.is_published, updated_at_ms = EXCLUDED.updated_at_ms`,
          [this.nextId(), params.organizationId, params.nowMs, productId, params.isPublished],
        );
        changed += 1;
      }
      return changed;
    });
  }

  /**
   * A customer's order. Lines are priced HERE from `products` (the browser's prices are never
   * trusted); a product that is not published, has no price or lacks the stock is refused.
   */
  async placeOrder(params: {
    readonly shop: ShopLookup;
    readonly customerName: string;
    readonly customerPhone: string;
    readonly fulfilment: ShopFulfilment;
    readonly address: string | null;
    readonly note: string | null;
    readonly lines: readonly { readonly productId: UuidV7; readonly qtyMilli: bigint }[];
    readonly accessTokenHash: string;
    readonly nowMs: UnixMs;
  }): Promise<ShopOrderRow> {
    if (params.lines.length === 0 || params.lines.length > MAX_ORDER_LINES) {
      throw new DomainError('VALIDATION_ERROR', 'An order needs 1-50 lines');
    }
    const orgId = params.shop.organizationId;
    return withPgTenantContext(this.pool, orgId, async (_tx, client) => {
      const merged = new Map<string, bigint>();
      for (const l of params.lines)
        merged.set(l.productId, (merged.get(l.productId) ?? 0n) + l.qtyMilli);
      const ids = [...merged.keys()];
      const res = await client.query<{
        id: string;
        name: string;
        unit: string;
        sale_price: string;
        unlimited: boolean;
        stock: string;
      }>(
        `SELECT p.id, p.name, p.unit, p.sale_price, p.unlimited,
                COALESCE((SELECT SUM(sm.qty_delta) FROM stock_moves sm
                           WHERE sm.organization_id = p.organization_id AND sm.product_id = p.id
                             AND sm.store_id = $3::uuid), 0) AS stock
           FROM products p
           JOIN cloud_shop_products sp
             ON sp.organization_id = p.organization_id AND sp.product_id = p.id::text
          WHERE p.organization_id = $1 AND p.id = ANY($2::uuid[]) AND p.deleted_at_ms IS NULL
            AND sp.is_published AND p.sale_price > 0 AND NOT p.has_variants`,
        [orgId, ids, params.shop.storeId],
      );
      const byId = new Map(res.rows.map((r) => [r.id, r]));
      const lines: ShopOrderLineRow[] = [];
      const unavailable: string[] = [];
      let total = 0n;
      for (const [productId, qtyMilli] of merged) {
        const p = byId.get(productId);
        if (!p) {
          unavailable.push(productId);
          continue;
        }
        if ((p.unit === 'dona' || p.unit === 'qadoq') && qtyMilli % 1000n !== 0n) {
          throw new DomainError('INVALID_UNIT_QUANTITY', 'Whole units only for this product');
        }
        if (!p.unlimited && BigInt(p.stock) < qtyMilli) {
          unavailable.push(productId);
          continue;
        }
        const price = BigInt(p.sale_price);
        const lineTotal = (price * qtyMilli + 500n) / 1000n;
        total += lineTotal;
        lines.push({
          productId,
          name: p.name,
          unit: p.unit,
          qtyMilli,
          priceTiyin: price,
          totalTiyin: lineTotal,
        });
      }
      if (unavailable.length > 0) {
        throw new DomainError('INSUFFICIENT_STOCK', 'Some products are not available', {
          details: { productIds: unavailable },
        });
      }
      const no = await client.query<{ n: number }>(
        `UPDATE cloud_shops SET next_order_no = next_order_no + 1, updated_at_ms = $3
          WHERE organization_id = $1 AND id = $2 AND is_enabled
          RETURNING next_order_no - 1 AS n`,
        [orgId, params.shop.shopId, params.nowMs],
      );
      const orderNo = no.rows[0]?.n;
      if (orderNo === undefined) throw new DomainError('STORE_NOT_FOUND', 'Shop is closed');
      const orderId = this.nextId();
      await client.query(
        `INSERT INTO cloud_shop_orders (id, organization_id, created_at_ms, updated_at_ms, shop_id,
                store_id, order_no, customer_name, customer_phone, fulfilment, address, note, status,
                total_tiyin, access_token_hash)
         VALUES ($1, $2, $3, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'new', $12, $13)`,
        [
          orderId,
          orgId,
          params.nowMs,
          params.shop.shopId,
          params.shop.storeId,
          orderNo,
          params.customerName,
          params.customerPhone,
          params.fulfilment,
          params.address,
          params.note,
          total,
          params.accessTokenHash,
        ],
      );
      for (const l of lines) {
        await client.query(
          `INSERT INTO cloud_shop_order_lines (id, organization_id, created_at_ms, updated_at_ms,
                  order_id, product_id, name, unit, qty_milli, price_tiyin, total_tiyin)
           VALUES ($1, $2, $3, $3, $4, $5, $6, $7, $8, $9, $10)`,
          [
            this.nextId(),
            orgId,
            params.nowMs,
            orderId,
            l.productId,
            l.name,
            l.unit,
            l.qtyMilli,
            l.priceTiyin,
            l.totalTiyin,
          ],
        );
      }
      const order = await readOrder(client, orgId, orderId);
      if (!order) throw new Error('order not saved');
      return order;
    });
  }

  /** Public status check: the order is shown only with its access token (hash match). */
  async getOrderForCustomer(
    shop: ShopLookup,
    orderId: UuidV7,
    accessTokenHash: string,
  ): Promise<ShopOrderRow | null> {
    return withPgTenantContext(this.pool, shop.organizationId, async (_tx, client) => {
      const ok = await client.query(
        `SELECT 1 FROM cloud_shop_orders
          WHERE organization_id = $1 AND id = $2 AND shop_id = $3 AND access_token_hash = $4`,
        [shop.organizationId, orderId, shop.shopId, accessTokenHash],
      );
      return ok.rowCount === 0 ? null : readOrder(client, shop.organizationId, orderId);
    });
  }

  async listOrders(
    organizationId: UuidV7,
    status: ShopOrderStatus | 'open' | 'all',
  ): Promise<ShopOrderRow[]> {
    return withPgTenantContext(this.pool, organizationId, async (_tx, client) => {
      const where =
        status === 'all'
          ? ''
          : status === 'open'
            ? `AND status IN ('new', 'accepted', 'ready')`
            : 'AND status = $2';
      const res = await client.query<{ id: string }>(
        `SELECT id FROM cloud_shop_orders WHERE organization_id = $1 ${where}
          ORDER BY created_at_ms DESC LIMIT 200`,
        status === 'all' || status === 'open' ? [organizationId] : [organizationId, status],
      );
      const out: ShopOrderRow[] = [];
      for (const r of res.rows) {
        const o = await readOrder(client, organizationId, r.id);
        if (o) out.push(o);
      }
      return out;
    });
  }

  async setOrderStatus(params: {
    readonly organizationId: UuidV7;
    readonly orderId: UuidV7;
    readonly status: ShopOrderStatus;
    readonly nowMs: UnixMs;
  }): Promise<ShopOrderRow> {
    return withPgTenantContext(this.pool, params.organizationId, async (_tx, client) => {
      const cur = await readOrder(client, params.organizationId, params.orderId);
      if (!cur) throw new DomainError('ORDER_NOT_FOUND', 'Order not found');
      if (!SHOP_ORDER_TRANSITIONS[cur.status].includes(params.status)) {
        throw new DomainError(
          'ORDER_INVALID_TRANSITION',
          `Cannot move ${cur.status} → ${params.status}`,
        );
      }
      const upd = await client.query(
        `UPDATE cloud_shop_orders SET status = $3, updated_at_ms = $4
          WHERE organization_id = $1 AND id = $2 AND status = $5`,
        [params.organizationId, params.orderId, params.status, params.nowMs, cur.status],
      );
      if (upd.rowCount !== 1) {
        throw new DomainError('ORDER_INVALID_TRANSITION', 'The order changed meanwhile');
      }
      const next = await readOrder(client, params.organizationId, params.orderId);
      if (!next) throw new Error('order vanished');
      return next;
    });
  }
}

async function readShop(
  client: pg.PoolClient,
  organizationId: UuidV7,
): Promise<ShopSettings | null> {
  const res = await client.query<{
    id: string;
    store_id: string;
    slug: string;
    title: string;
    phone: string | null;
    address: string | null;
    about: string | null;
    is_enabled: boolean;
  }>(
    `SELECT id, store_id, slug, title, phone, address, about, is_enabled FROM cloud_shops
      WHERE organization_id = $1 ORDER BY created_at_ms LIMIT 1`,
    [organizationId],
  );
  const r = res.rows[0];
  return r
    ? {
        id: r.id,
        storeId: r.store_id,
        slug: r.slug,
        title: r.title,
        phone: r.phone,
        address: r.address,
        about: r.about,
        isEnabled: r.is_enabled,
      }
    : null;
}

async function readOrder(
  client: pg.PoolClient,
  organizationId: UuidV7,
  orderId: string,
): Promise<ShopOrderRow | null> {
  const res = await client.query<{
    id: string;
    order_no: number;
    customer_name: string;
    customer_phone: string;
    fulfilment: ShopFulfilment;
    address: string | null;
    note: string | null;
    status: ShopOrderStatus;
    total_tiyin: string;
    created_at_ms: string;
    updated_at_ms: string;
  }>(
    `SELECT id, order_no, customer_name, customer_phone, fulfilment, address, note, status,
            total_tiyin, created_at_ms, updated_at_ms
       FROM cloud_shop_orders WHERE organization_id = $1 AND id = $2`,
    [organizationId, orderId],
  );
  const o = res.rows[0];
  if (!o) return null;
  const lines = await client.query<{
    product_id: string;
    name: string;
    unit: string;
    qty_milli: string;
    price_tiyin: string;
    total_tiyin: string;
  }>(
    `SELECT product_id, name, unit, qty_milli, price_tiyin, total_tiyin FROM cloud_shop_order_lines
      WHERE organization_id = $1 AND order_id = $2 ORDER BY created_at_ms, id`,
    [organizationId, orderId],
  );
  return {
    id: o.id,
    orderNo: o.order_no,
    customerName: o.customer_name,
    customerPhone: o.customer_phone,
    fulfilment: o.fulfilment,
    address: o.address,
    note: o.note,
    status: o.status,
    totalTiyin: BigInt(o.total_tiyin),
    createdAtMs: BigInt(o.created_at_ms),
    updatedAtMs: BigInt(o.updated_at_ms),
    lines: lines.rows.map((l) => ({
      productId: l.product_id,
      name: l.name,
      unit: l.unit,
      qtyMilli: BigInt(l.qty_milli),
      priceTiyin: BigInt(l.price_tiyin),
      totalTiyin: BigInt(l.total_tiyin),
    })),
  };
}
