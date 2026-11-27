import {
  CloudAuthStore,
  CloudEventWriter,
  CloudSyncPushStore,
  CloudTenantStore,
  PG_APP_ROLE_NAME,
  createCloudPgPool,
  migrateCloudDatabase,
  shouldRunPgTests,
  withPgTenantContext,
} from '@mezon/db-cloud';
import { type UuidV7, unixMsFromBigInt } from '@mezon/domain';
import { DeterministicUuidV7Generator } from '@mezon/test-utils';
import * as argon2 from '@node-rs/argon2';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { provisionAppRole } from '../../../packages/db-cloud/ops/provision-app-role.mjs';
import { loadCloudConfig } from './config.js';
import { CloudJwtService } from './jwt.js';
import { buildCloudServer } from './server.js';

const describePg = shouldRunPgTests() ? describe : describe.skip;

describePg('@mezon/cloud - V2 online shop (public window, orders, cabinet)', () => {
  let container: StartedPostgreSqlContainer;
  let adminConn: ReturnType<typeof createCloudPgPool>;
  let appConn: ReturnType<typeof createCloudPgPool>;
  let server: FastifyInstance;
  const idGen = new DeterministicUuidV7Generator();
  const orgA = idGen.nextId();
  const orgB = idGen.nextId();
  const ownerA = idGen.nextId();
  const managerA = idGen.nextId();
  const hubOwnerA = idGen.nextId();
  const productA = idGen.nextId();
  const variantProduct = idGen.nextId();
  const productB = idGen.nextId();
  const nowMs = unixMsFromBigInt(1_795_000_000_000n);
  const password = 'Kabinet2026!';

  const productPayload = (org: UuidV7, id: UuidV7, name: string, hasVariants = false) => ({
    id,
    organizationId: org,
    categoryId: null,
    sku: null,
    skuSearch: null,
    name,
    nameSearch: name.toLowerCase(),
    unit: 'dona',
    unlimited: false,
    minStock: null,
    hasVariants,
    trackBatches: false,
    salePrice: '1000000',
    mxik: null,
    packageCode: null,
    vatRateBp: 1200,
    deviceId: id,
    hlc: '',
    createdAtMs: String(nowMs),
    updatedAtMs: String(nowMs),
    deletedAtMs: null,
  });

  const token = async (login: string) => {
    const res = await server.inject({
      method: 'POST',
      url: '/api/v1/admin/auth/login',
      payload: { login, password },
    });
    expect(res.statusCode, res.payload).toBe(200);
    return (JSON.parse(res.payload) as { accessToken: string }).accessToken;
  };

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:18-alpine').start();
    adminConn = createCloudPgPool({ connectionString: container.getConnectionUri() });
    const appPw = 'test-cabinet-app-password-123456789';
    process.env.MEZON_APP_DB_PASSWORD = appPw;
    await provisionAppRole({ pool: adminConn.pool });
    await migrateCloudDatabase(adminConn.db);
    const appUri = new URL(container.getConnectionUri());
    appUri.username = PG_APP_ROLE_NAME;
    appUri.password = appPw;
    appConn = createCloudPgPool({ connectionString: appUri.toString() });
    const hash = await argon2.hash(password);
    const tenants = new CloudTenantStore(adminConn.pool);
    for (const [org, owner, login] of [
      [orgA, ownerA, 'kab_a'],
      [orgB, idGen.nextId(), 'kab_b'],
    ] as const) {
      await tenants.createOrganizationWithStoreAndOwner({
        organizationId: org,
        storeId: idGen.nextId(),
        ownerUserId: owner,
        loginIdentityId: idGen.nextId(),
        organizationName: `Org ${login}`,
        storeName: 'Bosh',
        storeCode: 'main',
        ownerUsername: login,
        ownerLogin: `${login}@guzar.uz`,
        passwordHash: hash,
        nowMs,
      });
    }
    await withPgTenantContext(adminConn.pool, orgA, async (_tx, c) => {
      await c.query(
        `INSERT INTO cloud_users (id, organization_id, username, role, status, failed_login_attempts, created_at_ms, updated_at_ms)
         VALUES ($1, $2, 'kab_mgr', 'manager', 'active', 0, $3, $3)`,
        [managerA, orgA, String(nowMs)],
      );
      await c.query(
        `INSERT INTO cloud_login_identities (id, login, org_id, user_id, password_hash, created_at_ms, updated_at_ms)
         VALUES ($1, 'kab_mgr@guzar.uz', $2, $3, $4, $5, $5)`,
        [idGen.nextId(), orgA, managerA, hash, String(nowMs)],
      );
    });
    // Products (and one hub user) arrive the normal way: as sync events.
    const writer = new CloudEventWriter(appConn.pool, new CloudSyncPushStore(appConn.pool), idGen);
    const seeded = await writer.write({
      organizationId: orgA,
      nowMs,
      commands: [
        {
          entity: 'products',
          entityId: productA,
          type: 'product.created',
          payload: { ...productPayload(orgA, productA, 'Non'), unlimited: true },
        },
        {
          entity: 'products',
          entityId: variantProduct,
          type: 'product.created',
          payload: productPayload(orgA, variantProduct, 'Futbolka'),
        },
        {
          entity: 'users',
          entityId: hubOwnerA,
          type: 'user.created',
          payload: {
            id: hubOwnerA,
            organizationId: orgA,
            username: 'ega_hub',
            fullName: 'Ega (kassa)',
            role: 'owner',
            isActive: true,
            deviceId: hubOwnerA,
            hlc: '',
            createdAtMs: String(nowMs),
            updatedAtMs: String(nowMs),
            deletedAtMs: null,
          },
        },
      ],
    });
    expect(seeded.results.map((r) => r.status)).toEqual(['accepted', 'accepted', 'accepted']);
    const seededB = await writer.write({
      organizationId: orgB,
      nowMs,
      commands: [
        {
          entity: 'products',
          entityId: productB,
          type: 'product.created',
          payload: productPayload(orgB, productB, 'Boshqa'),
        },
      ],
    });
    expect(seededB.results[0].status).toBe('accepted');

    const secret = 'cabinet-test-jwt-secret-at-least-32-chars';
    server = await buildCloudServer({
      config: loadCloudConfig({
        NODE_ENV: 'test',
        PORT: '3000',
        HOST: '127.0.0.1',
        DATABASE_URL: appUri.toString(),
        JWT_SECRET: secret,
        CORS_ORIGINS: 'http://localhost:5173',
      }),
      conn: appConn,
      jwtService: new CloudJwtService(secret),
      authStore: new CloudAuthStore(appConn.pool),
      clock: { nowMs: () => nowMs },
      idGen,
    });
  }, 120_000);

  afterAll(async () => {
    await server?.close();
    await appConn?.pool.end();
    await adminConn?.pool.end();
    await container?.stop();
  });

  const auth = async (login: string) => ({ authorization: `Bearer ${await token(login)}` });
  const call = async (
    method: 'GET' | 'POST' | 'PUT',
    url: string,
    payload?: unknown,
    headers?: Record<string, string>,
  ) =>
    server.inject({
      method,
      url,
      ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
      ...(headers ? { headers } : {}),
    });
  const shopBody = { slug: 'non-uyi', title: 'Non uyi', phone: '+998901234567', isEnabled: true };
  const order = (
    lines: { productId: string; qty: string }[],
    extra: Record<string, unknown> = {},
  ) => ({
    customerName: 'Aziz',
    customerPhone: '+998 90 111 22 33',
    fulfilment: 'pickup',
    lines,
    ...extra,
  });

  it('a shop that does not exist or is off is a 404 to the public', async () => {
    expect((await call('GET', '/api/v1/public/shops/non-uyi')).statusCode).toBe(404);
    const h = await auth('kab_a@guzar.uz');
    const off = await call('PUT', '/api/v1/admin/shop', { ...shopBody, isEnabled: false }, h);
    expect(off.statusCode, off.payload).toBe(200);
    expect((await call('GET', '/api/v1/public/shops/non-uyi')).statusCode).toBe(404);
    expect((await call('POST', '/api/v1/public/shops/non-uyi/orders', order([]))).statusCode).toBe(
      404,
    );
  });

  it('the slug belongs to one organization only', async () => {
    const h = await auth('kab_a@guzar.uz');
    expect((await call('PUT', '/api/v1/admin/shop', shopBody, h)).statusCode).toBe(200);
    const other = await call('PUT', '/api/v1/admin/shop', shopBody, await auth('kab_b@guzar.uz'));
    expect(other.statusCode).toBe(400);
    expect(
      (await call('PUT', '/api/v1/admin/shop', { ...shopBody, slug: 'Bad Slug!' }, h)).statusCode,
    ).toBe(400);
  });

  it('only published products are on the window; no stock numbers, no other org', async () => {
    const h = await auth('kab_a@guzar.uz');
    let pub = JSON.parse((await call('GET', '/api/v1/public/shops/non-uyi')).payload) as {
      products: { id: string; available: boolean }[];
    };
    expect(pub.products).toEqual([]);
    const put = await call(
      'PUT',
      '/api/v1/admin/shop/products',
      { productIds: [productA, variantProduct, productB], isPublished: true },
      h,
    );
    expect(JSON.parse(put.payload)).toEqual({ changed: 2 }); // productB is another org's
    pub = JSON.parse((await call('GET', '/api/v1/public/shops/non-uyi')).payload) as typeof pub;
    expect(pub.products.map((p) => [p.id, p.available]).sort()).toEqual(
      [
        [productA, true],
        [variantProduct, false],
      ].sort(),
    );
    expect(JSON.stringify(pub)).not.toMatch(/stock|cost|organization/i);
  });

  it('C21: a synced product photo shows on the window; hidden goods keep theirs private', async () => {
    const jpeg = Buffer.from([
      0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0xff,
      0xd9,
    ]);
    const writer = new CloudEventWriter(appConn.pool, new CloudSyncPushStore(appConn.pool), idGen);
    const imagePayload = (productId: UuidV7) => {
      const id = idGen.nextId();
      return {
        entity: 'product_images',
        entityId: id,
        type: 'product_image.created',
        payload: {
          id,
          organizationId: orgA,
          productId,
          mime: 'image/jpeg',
          dataBase64: jpeg.toString('base64'),
          byteSize: jpeg.length,
          deviceId: id,
          hlc: '',
          createdAtMs: String(nowMs),
          updatedAtMs: String(nowMs),
          deletedAtMs: null,
        },
      };
    };
    const res = await writer.write({
      organizationId: orgA,
      nowMs,
      commands: [imagePayload(productA), imagePayload(variantProduct)],
    });
    expect(res.results.map((r) => r.status)).toEqual(['accepted', 'accepted']);

    const pub = JSON.parse((await call('GET', '/api/v1/public/shops/non-uyi')).payload) as {
      products: { id: string; image?: string | null }[];
    };
    const non = pub.products.find((p) => p.id === productA);
    expect(non?.image).toContain(`/products/${productA}/image?v=`);
    const img = await call('GET', non?.image ?? '/x');
    expect(img.statusCode).toBe(200);
    expect(img.headers['content-type']).toBe('image/jpeg');
    expect(Buffer.compare(img.rawPayload, jpeg)).toBe(0);

    // unpublish the shirt: its photo is no longer public
    const h = await auth('kab_a@guzar.uz');
    await call(
      'PUT',
      '/api/v1/admin/shop/products',
      { productIds: [variantProduct], isPublished: false },
      h,
    );
    expect(
      (await call('GET', `/api/v1/public/shops/non-uyi/products/${variantProduct}/image`))
        .statusCode,
    ).toBe(404);
    await call(
      'PUT',
      '/api/v1/admin/shop/products',
      { productIds: [variantProduct], isPublished: true },
      h,
    );
  });

  it('an order is priced by the server, refuses unavailable goods, and shows only with its token', async () => {
    const tamper = await call(
      'POST',
      '/api/v1/public/shops/non-uyi/orders',
      order([{ productId: productA, qty: '2000' }], { price: '1' }),
    );
    expect(tamper.statusCode).toBe(400);
    const none = await call(
      'POST',
      '/api/v1/public/shops/non-uyi/orders',
      order([{ productId: variantProduct, qty: '1000' }]),
    );
    expect(none.statusCode).toBe(409);
    const half = await call(
      'POST',
      '/api/v1/public/shops/non-uyi/orders',
      order([{ productId: productA, qty: '500' }]),
    );
    expect(half.statusCode).toBe(400);
    const ok = await call(
      'POST',
      '/api/v1/public/shops/non-uyi/orders',
      order([
        { productId: productA, qty: '1000' },
        { productId: productA, qty: '1000' },
      ]),
    );
    expect(ok.statusCode, ok.payload).toBe(201);
    const placed = JSON.parse(ok.payload) as {
      order: { id: string; orderNo: number; total: string; status: string; customerPhone: string };
      accessToken: string;
    };
    expect(placed.order).toMatchObject({
      orderNo: 1,
      total: '2000000',
      status: 'new',
      customerPhone: '+998901112233',
    });
    const seen = await call(
      'GET',
      `/api/v1/public/shops/non-uyi/orders/${placed.order.id}?t=${placed.accessToken}`,
    );
    expect(seen.statusCode).toBe(200);
    const wrong = await call(
      'GET',
      `/api/v1/public/shops/non-uyi/orders/${placed.order.id}?t=${'x'.repeat(24)}`,
    );
    expect(wrong.statusCode).toBe(404);
  });

  it('cabinet: the owner sees and moves the order forward; another org sees nothing', async () => {
    const h = await auth('kab_mgr@guzar.uz');
    const list = JSON.parse(
      (await call('GET', '/api/v1/admin/shop/orders', undefined, h)).payload,
    ) as {
      orders: { id: string; status: string }[];
    };
    expect(list.orders).toHaveLength(1);
    const id = list.orders[0].id;
    const acc = await call(
      'POST',
      `/api/v1/admin/shop/orders/${id}/status`,
      { status: 'accepted' },
      h,
    );
    expect(JSON.parse(acc.payload)).toMatchObject({ order: { status: 'accepted' } });
    const back = await call('POST', `/api/v1/admin/shop/orders/${id}/status`, { status: 'new' }, h);
    expect(back.statusCode).toBe(409);
    const b = await call(
      'GET',
      '/api/v1/admin/shop/orders?status=all',
      undefined,
      await auth('kab_b@guzar.uz'),
    );
    expect(JSON.parse(b.payload)).toEqual({ orders: [] });
    const foreign = await call(
      'POST',
      `/api/v1/admin/shop/orders/${id}/status`,
      { status: 'cancelled' },
      await auth('kab_b@guzar.uz'),
    );
    expect(foreign.statusCode).toBe(404);
  });
});
