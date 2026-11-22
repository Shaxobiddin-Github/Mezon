import { sql } from 'drizzle-orm';
import { boolean, check, index, integer, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { pgBigint } from '../columns.js';
import { cloudSchemaRegistry } from './registry-instance.js';

/**
 * V2 / F5 first step: the online shop window ("onlayn vitrina"). Cloud-only (`LOCAL`) tables,
 * organization-scoped under RLS. The public page finds a shop by its slug only through the
 * SECURITY DEFINER function `shop_lookup_slug`; everything after that runs under the tenant.
 *
 * - `cloud_shops`: one per store; the public link is `/s/<slug>`. Off until the owner enables it.
 * - `cloud_shop_products`: the products the owner put on sale online ("savdoga chiqarilgan").
 *   Name, price and stock always come from the synced `products` / `stock_moves`, never copied.
 * - `cloud_shop_orders` / `_lines`: what a customer ordered. Prices are fixed when the order is
 *   placed (server-side, from `products`); the shop hands it over through the kassa as usual.
 */
export const cloudShops = cloudSchemaRegistry.defineTable(
  { name: 'cloud_shops', tableClass: 'LOCAL', tenantScope: 'organization' },
  (common) => ({
    ...common,
    storeId: text('store_id').notNull(),
    slug: text('slug').notNull(),
    title: text('title').notNull(),
    phone: text('phone'),
    address: text('address'),
    about: text('about'),
    isEnabled: boolean('is_enabled').notNull().default(false),
    nextOrderNo: integer('next_order_no').notNull().default(1),
  }),
  (self) => [
    uniqueIndex('uidx_cloud_shops_slug').on(self.slug),
    uniqueIndex('uidx_cloud_shops_store').on(self.organizationId, self.storeId),
    check('chk_cloud_shops_slug', sql`${self.slug} ~ '^[a-z0-9][a-z0-9-]{2,39}$'`),
    check('chk_cloud_shops_title', sql`length(trim(${self.title})) BETWEEN 1 AND 80`),
    check('chk_cloud_shops_next_no', sql`${self.nextOrderNo} >= 1`),
  ],
);

export const cloudShopProducts = cloudSchemaRegistry.defineTable(
  { name: 'cloud_shop_products', tableClass: 'LOCAL', tenantScope: 'organization' },
  (common) => ({
    ...common,
    productId: text('product_id').notNull(),
    isPublished: boolean('is_published').notNull().default(true),
  }),
  (self) => [
    uniqueIndex('uidx_cloud_shop_products_product').on(self.organizationId, self.productId),
  ],
);

export const cloudShopOrders = cloudSchemaRegistry.defineTable(
  { name: 'cloud_shop_orders', tableClass: 'LOCAL', tenantScope: 'organization' },
  (common) => ({
    ...common,
    shopId: text('shop_id').notNull(),
    storeId: text('store_id').notNull(),
    orderNo: integer('order_no').notNull(),
    customerName: text('customer_name').notNull(),
    customerPhone: text('customer_phone').notNull(),
    fulfilment: text('fulfilment').notNull(),
    address: text('address'),
    note: text('note'),
    status: text('status').notNull(),
    totalTiyin: pgBigint('total_tiyin').notNull(),
    /** SHA-256 of the random token the customer keeps to see the order status. */
    accessTokenHash: text('access_token_hash').notNull(),
  }),
  (self) => [
    uniqueIndex('uidx_cloud_shop_orders_no').on(self.organizationId, self.shopId, self.orderNo),
    index('idx_cloud_shop_orders_status').on(self.organizationId, self.status, self.createdAtMs),
    check('chk_cloud_shop_orders_fulfilment', sql`${self.fulfilment} IN ('pickup', 'delivery')`),
    check(
      'chk_cloud_shop_orders_status',
      sql`${self.status} IN ('new', 'accepted', 'ready', 'done', 'cancelled')`,
    ),
    check('chk_cloud_shop_orders_total', sql`${self.totalTiyin} >= 0`),
    check('chk_cloud_shop_orders_phone', sql`${self.customerPhone} ~ '^\\+?[0-9]{9,15}$'`),
  ],
);

export const cloudShopOrderLines = cloudSchemaRegistry.defineTable(
  { name: 'cloud_shop_order_lines', tableClass: 'LOCAL', tenantScope: 'organization' },
  (common) => ({
    ...common,
    orderId: text('order_id').notNull(),
    productId: text('product_id').notNull(),
    name: text('name').notNull(),
    unit: text('unit').notNull(),
    qtyMilli: pgBigint('qty_milli').notNull(),
    priceTiyin: pgBigint('price_tiyin').notNull(),
    totalTiyin: pgBigint('total_tiyin').notNull(),
  }),
  (self) => [
    index('idx_cloud_shop_order_lines_order').on(self.organizationId, self.orderId),
    check('chk_cloud_shop_order_lines_qty', sql`${self.qtyMilli} > 0`),
    check(
      'chk_cloud_shop_order_lines_money',
      sql`${self.priceTiyin} >= 0 AND ${self.totalTiyin} >= 0`,
    ),
  ],
);
