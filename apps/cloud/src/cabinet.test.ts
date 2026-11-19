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

describePg('@mezon/cloud - T2.7b cabinet writes (price) through the event writer', () => {
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
  const setPrice = async (login: string, id: string, body: Record<string, unknown>) =>
    server.inject({
      method: 'POST',
      url: `/api/v1/admin/products/${id}/price`,
      headers: { authorization: `Bearer ${await token(login)}` },
      payload: body,
    });
  const q = async <T extends Record<string, unknown>>(sql: string, args: unknown[]) =>
    (await adminConn.pool.query<T>(sql, args)).rows;

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
          payload: productPayload(orgA, productA, 'Non'),
        },
        {
          entity: 'products',
          entityId: variantProduct,
          type: 'product.created',
          payload: productPayload(orgA, variantProduct, 'Futbolka', true),
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

  it('owner changes a price: product, price history (who) and the organization stream all agree', async () => {
    const res = await setPrice('kab_a@guzar.uz', productA, {
      newPrice: '1250000',
      reason: 'Yangi narx',
    });
    expect(res.statusCode, res.payload).toBe(200);
    expect(JSON.parse(res.payload)).toMatchObject({ changed: true, oldPrice: '1000000' });

    const [p] = await q<{ sale_price: string }>(
      'SELECT sale_price::text AS sale_price FROM products WHERE id = $1',
      [productA],
    );
    expect(p.sale_price).toBe('1250000');
    const pc = await q<{ changed_by_user_id: string; old_price: string; new_price: string }>(
      `SELECT changed_by_user_id, old_price::text AS old_price, new_price::text AS new_price
         FROM price_changes WHERE product_id = $1`,
      [productA],
    );
    expect(pc).toEqual([
      { changed_by_user_id: ownerA, old_price: '1000000', new_price: '1250000' },
    ]);
    // The cabinet login got an attribution user that can never work at a kassa.
    const [u] = await q<{ username: string; is_active: boolean; full_name: string }>(
      'SELECT username, is_active, full_name FROM users WHERE id = $1',
      [ownerA],
    );
    expect(u).toMatchObject({ is_active: false, full_name: 'Kabinet: kab_a' });
    expect(u.username).toMatch(/^kabinet-/);
    // Every change is an event of the organization stream (hubs pull it like any store).
    const ev = await q<{ entity: string; store_id: string }>(
      `SELECT entity, store_id FROM cloud_sync_events
        WHERE organization_id = $1 AND entity IN ('users', 'products', 'price_changes')
          AND created_at_ms = $2 ORDER BY position`,
      [orgA, String(nowMs)],
    );
    expect(ev.slice(-3)).toEqual([
      { entity: 'users', store_id: orgA },
      { entity: 'products', store_id: orgA },
      { entity: 'price_changes', store_id: orgA },
    ]);

    const hist = await server.inject({
      method: 'GET',
      url: `/api/v1/admin/products/${productA}/price-changes`,
      headers: { authorization: `Bearer ${await token('kab_a@guzar.uz')}` },
    });
    expect(JSON.parse(hist.payload)).toMatchObject({
      changes: [
        {
          oldPrice: '1000000',
          newPrice: '1250000',
          changedByName: 'Kabinet: kab_a',
          reason: 'Yangi narx',
        },
      ],
    });
  });

  it('the same price again changes nothing; a second change reuses the attribution user', async () => {
    const same = await setPrice('kab_a@guzar.uz', productA, { newPrice: '1250000' });
    expect(JSON.parse(same.payload)).toMatchObject({ changed: false });
    expect((await setPrice('kab_a@guzar.uz', productA, { newPrice: '1300000' })).statusCode).toBe(
      200,
    );
    const n = await q<{ n: string }>(
      'SELECT count(*)::text AS n FROM price_changes WHERE product_id = $1',
      [productA],
    );
    expect(n[0].n).toBe('2');
    const users = await q<{ n: string }>(
      `SELECT count(*)::text AS n FROM users WHERE organization_id = $1 AND username LIKE 'kabinet-%'`,
      [orgA],
    );
    expect(users[0].n).toBe('1');
    // ...and it was written once: no repeated user events overwrite it on every change.
    const userEvents = await q<{ n: string }>(
      `SELECT count(*)::text AS n FROM cloud_sync_events WHERE entity = 'users' AND entity_id = $1`,
      [ownerA],
    );
    expect(userEvents[0].n).toBe('1');
  });

  it('a cabinet login linked to a hub user changes prices as that user', async () => {
    await withPgTenantContext(adminConn.pool, orgA, async (_tx, c) => {
      await c.query('UPDATE cloud_users SET hub_user_id = $1 WHERE id = $2', [hubOwnerA, managerA]);
    });
    expect((await setPrice('kab_mgr@guzar.uz', productA, { newPrice: '1400000' })).statusCode).toBe(
      200,
    );
    const [last] = await q<{ changed_by_user_id: string }>(
      `SELECT changed_by_user_id FROM price_changes WHERE product_id = $1
        ORDER BY created_at_ms DESC, id DESC LIMIT 1`,
      [productA],
    );
    expect(last.changed_by_user_id).toBe(hubOwnerA);
    const [noRow] = await q<{ n: string }>('SELECT count(*)::text AS n FROM users WHERE id = $1', [
      managerA,
    ]);
    expect(noRow.n).toBe('0');
  });

  it('refused: another organization, bad price, a product with variants, a blocked manager', async () => {
    expect((await setPrice('kab_a@guzar.uz', productB, { newPrice: '1' })).statusCode).toBe(404);
    for (const bad of [
      { newPrice: '-1' },
      { newPrice: '1.5' },
      { newPrice: '' },
      { price: '1' },
      { newPrice: '1000000000001' },
    ]) {
      expect((await setPrice('kab_a@guzar.uz', productA, bad)).statusCode).toBe(400);
    }
    expect((await setPrice('kab_a@guzar.uz', variantProduct, { newPrice: '5' })).statusCode).toBe(
      400,
    );
    // The access token is still valid, but the manager is blocked now: the write is refused.
    const mgrToken = await token('kab_mgr@guzar.uz');
    await withPgTenantContext(adminConn.pool, orgA, async (_tx, c) => {
      await c.query(`UPDATE cloud_users SET status = 'blocked' WHERE id = $1`, [managerA]);
    });
    const blocked = await server.inject({
      method: 'POST',
      url: `/api/v1/admin/products/${productA}/price`,
      headers: { authorization: `Bearer ${mgrToken}` },
      payload: { newPrice: '1' },
    });
    expect(blocked.statusCode).toBe(403);
    const [p] = await q<{ sale_price: string }>(
      'SELECT sale_price::text AS sale_price FROM products WHERE id = $1',
      [productA],
    );
    expect(p.sale_price).toBe('1400000');
    // Org B's product is untouched.
    const [pb] = await q<{ sale_price: string }>(
      'SELECT sale_price::text AS sale_price FROM products WHERE id = $1',
      [productB],
    );
    expect(pb.sale_price).toBe('1000000');
  });

  it('devices: list without the cloud virtual device; only the owner revokes; another org cannot', async () => {
    const kassa = idGen.nextId();
    const storeRow = await q<{ id: string }>(
      'SELECT id FROM cloud_stores WHERE organization_id = $1 LIMIT 1',
      [orgA],
    );
    await withPgTenantContext(adminConn.pool, orgA, async (_tx, c) => {
      await c.query(
        `INSERT INTO cloud_devices (id, organization_id, store_id, device_id, name, platform, app_version, status, last_seen_at_ms, created_at_ms, updated_at_ms)
         VALUES ($1, $2, $3, $4, 'Kassa 1', 'windows', '1.0.0', 'active', $5, $5, $5)`,
        [kassa, orgA, storeRow[0].id, idGen.nextId(), String(nowMs)],
      );
    });
    const auth = async (login: string) => ({
      authorization: `Bearer ${await token(login)}`,
    });
    const list = await server.inject({
      method: 'GET',
      url: '/api/v1/admin/devices',
      headers: await auth('kab_a@guzar.uz'),
    });
    const devices = (JSON.parse(list.payload) as { devices: { id: string; status: string }[] })
      .devices;
    expect(devices.map((d) => d.id)).toEqual([kassa]); // the 'system' device is not listed
    const system = await q<{ id: string }>(
      `SELECT id FROM cloud_devices WHERE organization_id = $1 AND status = 'system'`,
      [orgA],
    );
    expect(system).toHaveLength(1);
    const revoke = async (login: string, id: string) =>
      server.inject({
        method: 'POST',
        url: `/api/v1/admin/devices/${id}/revoke`,
        headers: await auth(login),
      });
    expect((await revoke('kab_a@guzar.uz', system[0].id)).statusCode).toBe(404);
    expect((await revoke('kab_b@guzar.uz', kassa)).statusCode).toBe(404);
    expect((await revoke('kab_a@guzar.uz', kassa)).statusCode).toBe(200);
    const [after] = await q<{ status: string }>('SELECT status FROM cloud_devices WHERE id = $1', [
      kassa,
    ]);
    expect(after.status).toBe('revoked');
    const [sys] = await q<{ status: string }>('SELECT status FROM cloud_devices WHERE id = $1', [
      system[0].id,
    ]);
    expect(sys.status).toBe('system');
  });

  it('staff: synced kassa users without cabinet attribution rows', async () => {
    const res = await server.inject({
      method: 'GET',
      url: '/api/v1/admin/staff',
      headers: { authorization: `Bearer ${await token('kab_a@guzar.uz')}` },
    });
    const staff = (JSON.parse(res.payload) as { staff: { username: string; isActive: boolean }[] })
      .staff;
    expect(staff.map((u) => u.username)).toEqual(['ega_hub']);
  });
});
