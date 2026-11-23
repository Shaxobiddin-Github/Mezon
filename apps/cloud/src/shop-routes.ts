import { createHash, randomBytes } from 'node:crypto';
import {
  type AdminShopProductDto,
  PlaceShopOrderRequestSchema,
  type PublicShopResponseDto,
  SaveAdminShopRequestSchema,
  SetShopOrderStatusRequestSchema,
  SetShopProductsRequestSchema,
  ShopOrderStatusSchema,
  type ShopOrderDto,
} from '@mezon/contracts';
import type {
  CloudShopStore,
  CloudTelegramStore,
  ShopOrderRow,
  ShopSettings,
} from '@mezon/db-cloud';
import { DomainError, type UnixMs, type UuidV7, parseUuidV7 } from '@mezon/domain';
import type { TelegramClient } from '@mezon/drivers';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

const sha256 = (v: string) => createHash('sha256').update(v).digest('hex');

const ERROR_STATUS: Partial<Record<string, number>> = {
  VALIDATION_ERROR: 400,
  INVALID_UNIT_QUANTITY: 400,
  INSUFFICIENT_STOCK: 409,
  ORDER_NOT_FOUND: 404,
  ORDER_INVALID_TRANSITION: 409,
  STORE_NOT_FOUND: 404,
};

export function toShopOrderDto(o: ShopOrderRow): ShopOrderDto {
  return {
    id: o.id,
    orderNo: o.orderNo,
    customerName: o.customerName,
    customerPhone: o.customerPhone,
    fulfilment: o.fulfilment,
    address: o.address,
    note: o.note,
    status: o.status,
    total: o.totalTiyin.toString(),
    createdAtMs: o.createdAtMs.toString(),
    updatedAtMs: o.updatedAtMs.toString(),
    lines: o.lines.map((l) => ({
      productId: l.productId,
      name: l.name,
      unit: l.unit,
      qty: l.qtyMilli.toString(),
      price: l.priceTiyin.toString(),
      total: l.totalTiyin.toString(),
    })),
  };
}

const settingsDto = (s: ShopSettings | null) =>
  s === null
    ? null
    : {
        slug: s.slug,
        title: s.title,
        phone: s.phone,
        address: s.address,
        about: s.about,
        isEnabled: s.isEnabled,
      };

function som(tiyin: bigint): string {
  return (tiyin / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
}

/** Short Uzbek message for the owner's Telegram (no customer phone beyond what staff needs). */
export function formatNewOrderMessage(shopTitle: string, o: ShopOrderRow): string {
  const lines = o.lines
    .slice(0, 10)
    .map((l) => {
      const qty =
        l.unit === 'dona' || l.unit === 'qadoq'
          ? (l.qtyMilli / 1000n).toString()
          : (Number(l.qtyMilli) / 1000).toString();
      return `• ${l.name} — ${qty} ${l.unit}`;
    })
    .join('\n');
  return [
    `🛒 Yangi onlayn buyurtma #${String(o.orderNo)} — ${shopTitle}`,
    `${o.customerName}, ${o.customerPhone}`,
    o.fulfilment === 'delivery' ? `Yetkazib berish: ${o.address ?? ''}` : 'Olib ketadi',
    lines,
    `Jami: ${som(o.totalTiyin)} soʻm`,
  ].join('\n');
}

/**
 * V2 / F5 online shop:
 * - GET  /api/v1/public/shops/:slug                    shop window (no login; rate-limited)
 * - POST /api/v1/public/shops/:slug/orders             a shopper's order (prices from the server)
 * - GET  /api/v1/public/shops/:slug/orders/:id?t=...   order status, only with its token
 * - GET/PUT /api/v1/admin/shop, GET/PUT /api/v1/admin/shop/products,
 *   GET /api/v1/admin/shop/orders, POST /api/v1/admin/shop/orders/:id/status   (owner / manager)
 * A new order is announced to the owner's Telegram when the bot is configured; a failed message
 * never fails the order.
 */
export function registerShopRoutes(
  app: FastifyInstance,
  o: {
    readonly store: CloudShopStore;
    readonly telegramStore: CloudTelegramStore;
    readonly telegramClient: TelegramClient | null;
    readonly requireAdminAuth: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>;
    readonly clock: { nowMs(): UnixMs };
  },
): void {
  const fail = (reply: FastifyReply, err: unknown) => {
    if (err instanceof DomainError) {
      const status = ERROR_STATUS[err.code];
      if (status !== undefined) {
        return reply
          .code(status)
          .send({ error: err.code, code: err.code, message: err.message, details: err.details });
      }
    }
    throw err;
  };
  const bad = (reply: FastifyReply, message = 'Validation Error') =>
    reply.code(400).send({ error: 'VALIDATION_ERROR', code: 'VALIDATION_ERROR', message });
  const uuid = (raw: string): UuidV7 | null => {
    try {
      return parseUuidV7(raw);
    } catch {
      return null;
    }
  };
  const publicLimit = { rateLimit: { max: 60, timeWindow: '1 minute' } };
  const orderLimit = { rateLimit: { max: 10, timeWindow: '10 minutes' } };

  app.get<{ Params: { slug: string } }>(
    '/api/v1/public/shops/:slug',
    { config: publicLimit },
    async (req, reply) => {
      const shop = await o.store.lookupSlug(req.params.slug.toLowerCase());
      if (shop === null)
        return reply.code(404).send({ error: 'NOT_FOUND', code: 'SHOP_NOT_FOUND' });
      const settings = await o.store.getShop(shop.organizationId);
      if (settings === null)
        return reply.code(404).send({ error: 'NOT_FOUND', code: 'SHOP_NOT_FOUND' });
      const products = await o.store.listProducts(shop.organizationId, shop.storeId, true);
      const body: PublicShopResponseDto = {
        shop: {
          slug: settings.slug,
          title: settings.title,
          phone: settings.phone,
          address: settings.address,
          about: settings.about,
        },
        products: products.map((p) => ({
          id: p.productId,
          name: p.name,
          unit: p.unit,
          price: p.priceTiyin.toString(),
          category: p.categoryName,
          available: p.stockMilli === null || p.stockMilli > 0n,
        })),
      };
      void reply.header('cache-control', 'public, max-age=30');
      return body;
    },
  );

  app.post<{ Params: { slug: string } }>(
    '/api/v1/public/shops/:slug/orders',
    { config: orderLimit },
    async (req, reply) => {
      const shop = await o.store.lookupSlug(req.params.slug.toLowerCase());
      if (shop === null)
        return reply.code(404).send({ error: 'NOT_FOUND', code: 'SHOP_NOT_FOUND' });
      const body = PlaceShopOrderRequestSchema.safeParse(req.body);
      if (!body.success) return bad(reply);
      const d = body.data;
      if (d.fulfilment === 'delivery' && (d.address ?? '').length < 5) {
        return bad(reply, 'Address is required for delivery');
      }
      const lines: { productId: UuidV7; qtyMilli: bigint }[] = [];
      for (const l of d.lines) {
        const id = uuid(l.productId);
        const qty = BigInt(l.qty);
        if (id === null || qty <= 0n || qty > 1_000_000_000n) return bad(reply);
        lines.push({ productId: id, qtyMilli: qty });
      }
      const accessToken = randomBytes(18).toString('base64url');
      let order: ShopOrderRow;
      try {
        order = await o.store.placeOrder({
          shop,
          customerName: d.customerName,
          customerPhone: d.customerPhone,
          fulfilment: d.fulfilment,
          address: d.fulfilment === 'delivery' ? (d.address ?? null) : null,
          note: d.note && d.note.length > 0 ? d.note : null,
          lines,
          accessTokenHash: sha256(accessToken),
          nowMs: o.clock.nowMs(),
        });
      } catch (err) {
        return fail(reply, err);
      }
      void notifyStaff(shop.organizationId, order).catch((err: unknown) =>
        req.log.warn({ err, event: 'shop.order_notify_failed' }, 'Telegram notify failed'),
      );
      return reply.code(201).send({ order: toShopOrderDto(order), accessToken });
    },
  );

  app.get<{ Params: { slug: string; id: string }; Querystring: { t?: string } }>(
    '/api/v1/public/shops/:slug/orders/:id',
    { config: publicLimit },
    async (req, reply) => {
      const shop = await o.store.lookupSlug(req.params.slug.toLowerCase());
      const id = uuid(req.params.id);
      const token = req.query.t ?? '';
      if (shop === null || id === null || token.length < 16) {
        return reply.code(404).send({ error: 'NOT_FOUND', code: 'ORDER_NOT_FOUND' });
      }
      const order = await o.store.getOrderForCustomer(shop, id, sha256(token));
      if (order === null)
        return reply.code(404).send({ error: 'NOT_FOUND', code: 'ORDER_NOT_FOUND' });
      return { order: toShopOrderDto(order) };
    },
  );

  async function notifyStaff(orgId: UuidV7, order: ShopOrderRow): Promise<void> {
    if (o.telegramClient === null) return;
    const settings = await o.store.getShop(orgId);
    const text = formatNewOrderMessage(settings?.title ?? '', order);
    for (const target of await o.telegramStore.listStaffTargets(orgId)) {
      await o.telegramClient.sendMessage(target.chatId, text).catch(() => undefined);
    }
  }

  // ---- cabinet ----
  const pre = { preHandler: [o.requireAdminAuth] };

  app.get('/api/v1/admin/shop', pre, async (req) => {
    return { shop: settingsDto(await o.store.getShop(req.user!.org)) };
  });

  app.put('/api/v1/admin/shop', pre, async (req, reply) => {
    const body = SaveAdminShopRequestSchema.safeParse(req.body);
    if (!body.success) return bad(reply);
    const d = body.data;
    const nz = (v: string | undefined) => (v && v.length > 0 ? v : null);
    try {
      const saved = await o.store.saveShop({
        organizationId: req.user!.org,
        slug: d.slug,
        title: d.title,
        phone: nz(d.phone),
        address: nz(d.address),
        about: nz(d.about),
        isEnabled: d.isEnabled,
        nowMs: o.clock.nowMs(),
      });
      return { shop: settingsDto(saved) };
    } catch (err) {
      return fail(reply, err);
    }
  });

  app.get('/api/v1/admin/shop/products', pre, async (req) => {
    const shop = await o.store.getShop(req.user!.org);
    const storeId = shop?.storeId ?? '00000000-0000-7000-8000-000000000000';
    const rows = await o.store.listProducts(req.user!.org, storeId, false);
    const items: AdminShopProductDto[] = rows.map((p) => ({
      productId: p.productId,
      name: p.name,
      unit: p.unit,
      price: p.priceTiyin.toString(),
      category: p.categoryName,
      stock: p.stockMilli === null ? null : p.stockMilli.toString(),
      isPublished: p.isPublished,
    }));
    return { items };
  });

  app.put('/api/v1/admin/shop/products', pre, async (req, reply) => {
    const body = SetShopProductsRequestSchema.safeParse(req.body);
    if (!body.success) return bad(reply);
    const ids: UuidV7[] = [];
    for (const raw of body.data.productIds) {
      const id = uuid(raw);
      if (id === null) return bad(reply);
      ids.push(id);
    }
    const changed = await o.store.setPublished({
      organizationId: req.user!.org,
      productIds: ids,
      isPublished: body.data.isPublished,
      nowMs: o.clock.nowMs(),
    });
    return { changed };
  });

  app.get<{ Querystring: { status?: string } }>(
    '/api/v1/admin/shop/orders',
    pre,
    async (req, reply) => {
      const raw = req.query.status ?? 'open';
      const parsed = ShopOrderStatusSchema.safeParse(raw);
      if (raw !== 'open' && raw !== 'all' && !parsed.success) return bad(reply);
      const status = raw === 'open' || raw === 'all' ? raw : (parsed.data ?? 'open');
      const orders = await o.store.listOrders(req.user!.org, status);
      return { orders: orders.map(toShopOrderDto) };
    },
  );

  app.post<{ Params: { id: string } }>(
    '/api/v1/admin/shop/orders/:id/status',
    pre,
    async (req, reply) => {
      const id = uuid(req.params.id);
      const body = SetShopOrderStatusRequestSchema.safeParse(req.body);
      if (id === null || !body.success) return bad(reply);
      try {
        const order = await o.store.setOrderStatus({
          organizationId: req.user!.org,
          orderId: id,
          status: body.data.status,
          nowMs: o.clock.nowMs(),
        });
        return { order: toShopOrderDto(order) };
      } catch (err) {
        return fail(reply, err);
      }
    },
  );
}
