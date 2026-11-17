import {
  type AdminCustomerDetailResponseDto,
  type AdminCustomersResponseDto,
  type AdminDashboardResponseDto,
  type AdminReceiptDetailResponseDto,
  type AdminReceiptsResponseDto,
  type CloudLoginResponseDto,
  type DailySalesReportResponseDto,
} from '@mezon/contracts';
import {
  CloudAuthStore,
  CloudTenantStore,
  PG_APP_ROLE_NAME,
  createCloudPgPool,
  migrateCloudDatabase,
  shouldRunPgTests,
  withPgTenantContext,
} from '@mezon/db-cloud';
import { unixMsFromBigInt } from '@mezon/domain';
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

describePg('@mezon/cloud - Admin Cabinet API & Security Integration (T2.7a)', () => {
  let container: StartedPostgreSqlContainer;
  let adminConn: ReturnType<typeof createCloudPgPool>;
  let appConn: ReturnType<typeof createCloudPgPool>;
  let server: FastifyInstance;
  let tenantStore: CloudTenantStore;
  let jwtService: CloudJwtService;

  const idGen = new DeterministicUuidV7Generator();
  const orgA = idGen.nextId();
  const orgB = idGen.nextId();
  const storeA = idGen.nextId();
  const storeB = idGen.nextId();
  const ownerA = idGen.nextId();
  const ownerB = idGen.nextId();
  const cashierA = idGen.nextId();
  const deviceA = idGen.nextId();
  const nowMs = unixMsFromBigInt(1_731_772_800_000n); // 2026-11-16 16:00:00 UTC (21:00:00 Tashkent)
  const dummyHlc = '000173177280000:00001:018f23a0-1234-7123-8123-123456789abc';

  const passwordA = 'AdminPassword2026!';
  const jwtSecret = 'test-admin-jwt-secret-very-long-32-chars-ok!';

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:18-alpine').start();
    adminConn = createCloudPgPool({
      connectionString: container.getConnectionUri(),
    });

    const testAppPassword = 'test-admin-api-app-password-secret-1234';
    process.env.MEZON_APP_DB_PASSWORD = testAppPassword;
    await provisionAppRole({ pool: adminConn.pool });
    await migrateCloudDatabase(adminConn.db);

    const appConnUri = new URL(container.getConnectionUri());
    appConnUri.username = PG_APP_ROLE_NAME;
    appConnUri.password = testAppPassword;

    appConn = createCloudPgPool({
      connectionString: appConnUri.toString(),
    });

    tenantStore = new CloudTenantStore(adminConn.pool);
    jwtService = new CloudJwtService(jwtSecret);

    const hashA = await argon2.hash(passwordA);

    // Seed Org A with owner
    await tenantStore.createOrganizationWithStoreAndOwner({
      organizationId: orgA,
      storeId: storeA,
      ownerUserId: ownerA,
      loginIdentityId: idGen.nextId(),
      organizationName: 'Guzar Kabinet Org A',
      storeName: 'Markaziy Do‘kon A',
      storeCode: 'store_a',
      ownerUsername: 'owner_a',
      ownerLogin: 'owner_a@guzar.uz',
      passwordHash: hashA,
      nowMs,
    });

    // Seed Org B
    await tenantStore.createOrganizationWithStoreAndOwner({
      organizationId: orgB,
      storeId: storeB,
      ownerUserId: ownerB,
      loginIdentityId: idGen.nextId(),
      organizationName: 'Guzar Kabinet Org B',
      storeName: 'Do‘kon B',
      storeCode: 'store_b',
      ownerUsername: 'owner_b',
      ownerLogin: 'owner_b@guzar.uz',
      passwordHash: hashA,
      nowMs,
    });

    // Seed Cashier user for Org A (in cloud_users and cloud_login_identities)
    await withPgTenantContext(adminConn.pool, orgA, async (_tx, client) => {
      await client.query(
        `INSERT INTO cloud_users (id, organization_id, username, role, status, failed_login_attempts, created_at_ms, updated_at_ms)
         VALUES ($1, $2, 'cashier_a', 'cashier', 'active', 0, $3, $3)`,
        [cashierA, orgA, nowMs.toString()],
      );
      await client.query(
        `INSERT INTO cloud_login_identities (id, login, org_id, user_id, password_hash, created_at_ms, updated_at_ms)
         VALUES ($1, 'cashier_a@guzar.uz', $2, $3, $4, $5, $5)`,
        [idGen.nextId(), orgA, cashierA, hashA, nowMs.toString()],
      );

      // Insert cashier into domain users table
      await client.query(
        `INSERT INTO users (id, organization_id, device_id, hlc, created_at_ms, updated_at_ms, username, full_name, role, is_active)
         VALUES ($1, $2, $3, $4, $5, $5, 'cashier_a', 'Kassir A', 'cashier', true)`,
        [cashierA, orgA, deviceA, dummyHlc, nowMs.toString()],
      );
      // Insert owner into domain users table
      await client.query(
        `INSERT INTO users (id, organization_id, device_id, hlc, created_at_ms, updated_at_ms, username, full_name, role, is_active)
         VALUES ($1, $2, $3, $4, $5, $5, 'owner_a', 'Admin A', 'owner', true)`,
        [ownerA, orgA, deviceA, dummyHlc, nowMs.toString()],
      );
    });

    const config = loadCloudConfig({
      NODE_ENV: 'test',
      PORT: '3000',
      HOST: '127.0.0.1',
      DATABASE_URL: appConnUri.toString(),
      JWT_SECRET: jwtSecret,
      CORS_ORIGINS: 'http://localhost:5173',
    });

    server = await buildCloudServer({
      config,
      conn: appConn,
      jwtService,
      authStore: new CloudAuthStore(appConn.pool),
      clock: { nowMs: () => nowMs },
    });
  }, 90000);

  afterAll(async () => {
    await server?.close();
    await appConn?.pool.end();
    await adminConn?.pool.end();
    await container?.stop();
  });

  describe('1. Authentication, Cookies, & CSRF (A3, A4)', () => {
    it('rejects login for cashier accounts with 403 Forbidden', async () => {
      const res = await server.inject({
        method: 'POST',
        url: '/api/v1/admin/auth/login',
        payload: {
          login: 'cashier_a@guzar.uz',
          password: passwordA,
        },
      });
      expect(res.statusCode).toBe(403);
      const json = JSON.parse(res.payload) as { message: string };
      expect(json.message).toContain('Cashier accounts cannot access');
    });

    it('rejects login with invalid credentials with 401', async () => {
      const res = await server.inject({
        method: 'POST',
        url: '/api/v1/admin/auth/login',
        payload: {
          login: 'owner_a@guzar.uz',
          password: 'WrongPassword!',
        },
      });
      expect(res.statusCode).toBe(401);
    });

    it('successfully logs in owner, returns accessToken and sets HttpOnly cookie with Path=/api/v1/admin/auth', async () => {
      const res = await server.inject({
        method: 'POST',
        url: '/api/v1/admin/auth/login',
        payload: {
          login: 'owner_a@guzar.uz',
          password: passwordA,
        },
      });

      expect(res.statusCode).toBe(200);
      const json = JSON.parse(res.payload) as CloudLoginResponseDto;
      expect(json.accessToken).toBeDefined();

      const cookieHeader = res.headers['set-cookie'];
      expect(cookieHeader).toBeDefined();
      expect(String(cookieHeader)).toContain('mezon_admin_refresh=');
      expect(String(cookieHeader)).toContain('HttpOnly');
      expect(String(cookieHeader)).toContain('SameSite=Strict');
      expect(String(cookieHeader)).toContain('Path=/api/v1/admin/auth');
    });

    it('rejects refresh when X-Mezon-Admin header is missing (CSRF check)', async () => {
      const res = await server.inject({
        method: 'POST',
        url: '/api/v1/admin/auth/refresh',
        headers: {
          cookie: 'mezon_admin_refresh=dummy',
        },
      });
      expect(res.statusCode).toBe(400);
      const json = JSON.parse(res.payload) as { message: string };
      expect(json.message).toContain('X-Mezon-Admin');
    });

    it('rejects refresh when Origin is disallowed (CSRF check)', async () => {
      const res = await server.inject({
        method: 'POST',
        url: '/api/v1/admin/auth/refresh',
        headers: {
          'x-mezon-admin': '1',
          origin: 'http://malicious-site.com',
          cookie: 'mezon_admin_refresh=dummy',
        },
      });
      expect(res.statusCode).toBe(403);
    });

    it('successfully refreshes token family using valid cookie and rotates refresh token', async () => {
      // 1. Login to get cookie
      const loginRes = await server.inject({
        method: 'POST',
        url: '/api/v1/admin/auth/login',
        payload: {
          login: 'owner_a@guzar.uz',
          password: passwordA,
        },
      });
      const cookieHeader = String(loginRes.headers['set-cookie']);
      const match = cookieHeader.match(/mezon_admin_refresh=([^;]+)/);
      const refreshCookie = match ? match[1] : '';

      // 2. Call refresh
      const refreshRes = await server.inject({
        method: 'POST',
        url: '/api/v1/admin/auth/refresh',
        headers: {
          'x-mezon-admin': '1',
          origin: 'http://localhost:5173',
          cookie: `mezon_admin_refresh=${refreshCookie}`,
        },
      });

      expect(refreshRes.statusCode).toBe(200);
      const refreshJson = JSON.parse(refreshRes.payload) as { accessToken: string };
      expect(refreshJson.accessToken).toBeDefined();

      const newCookieHeader = String(refreshRes.headers['set-cookie']);
      expect(newCookieHeader).toContain('mezon_admin_refresh=');
      const newMatch = newCookieHeader.match(/mezon_admin_refresh=([^;]+)/);
      const nextRefreshCookie = newMatch ? newMatch[1] : '';
      expect(nextRefreshCookie).not.toBe(refreshCookie);

      // 3. Reusing the old refresh cookie triggers reuse detection -> 401
      const reuseRes = await server.inject({
        method: 'POST',
        url: '/api/v1/admin/auth/refresh',
        headers: {
          'x-mezon-admin': '1',
          origin: 'http://localhost:5173',
          cookie: `mezon_admin_refresh=${refreshCookie}`,
        },
      });
      expect(reuseRes.statusCode).toBe(401);
    });

    it('logs out and clears refresh cookie', async () => {
      const res = await server.inject({
        method: 'POST',
        url: '/api/v1/admin/auth/logout',
        headers: {
          'x-mezon-admin': '1',
          cookie: 'mezon_admin_refresh=dummy',
        },
      });
      expect(res.statusCode).toBe(200);
      const cookieHeader = String(res.headers['set-cookie']);
      expect(cookieHeader).toContain('Max-Age=0');
    });
  });

  describe('2. Protected API Endpoints & RBAC (A4, A5, A6)', () => {
    let ownerTokenA: string;
    let cashierTokenA: string;

    beforeAll(async () => {
      ownerTokenA = await jwtService.signAccessToken({
        sub: ownerA,
        org: orgA,
        role: 'owner',
        name: 'Admin A',
      });

      cashierTokenA = await jwtService.signAccessToken({
        sub: cashierA,
        org: orgA,
        role: 'cashier',
        name: 'Kassir A',
      });

      // Insert customer, sale, return into DB
      const custId = idGen.nextId();
      const saleId = idGen.nextId();
      await withPgTenantContext(appConn.pool, orgA, async (_tx, client) => {
        await client.query(
          `INSERT INTO customers (
            id, organization_id, device_id, hlc, created_at_ms, updated_at_ms,
            full_name, name_search, phone_normalized, phone_digits
          ) VALUES (
            $1, $2, $3, $4, $5, $5,
            'Temur Bek', 'temur bek', '+998909876543', '998909876543'
          )`,
          [custId, orgA, deviceA, dummyHlc, nowMs.toString()],
        );

        await client.query(
          `INSERT INTO sales (
            id, organization_id, store_id, device_id, hlc, created_at_ms, updated_at_ms,
            cashier_user_id, completed_by_user_id, customer_id,
            receipt_no, receipt_code, client_request_id, request_hash,
            subtotal_gross, total_promo_discount, subtotal_after_promo,
            manual_discount_mode, manual_discount_value, order_discount_amount,
            total_final, total_net_ex_vat, total_vat, total_paid, debt_amount, change_amount
          ) VALUES (
            $1, $2, $3, $4, $5, $6, $6,
            $7, $7, $8,
            201, 'REC-201', $9, 'hash201',
            2000000, 0, 2000000,
            'none', 0, 0,
            2000000, 1785714, 214286, 2000000, 0, 0
          )`,
          [
            saleId,
            orgA,
            storeA,
            deviceA,
            dummyHlc,
            nowMs.toString(),
            ownerA,
            custId,
            idGen.nextId(),
          ],
        );

        await client.query(
          `INSERT INTO sale_lines (
            id, organization_id, store_id, device_id, hlc, created_at_ms,
            sale_id, sort_order, line_kind, item_name, unit, qty,
            unit_price_snapshot, gross_total, promo_discount, subtotal_after_promo,
            allocated_order_discount, final_total, vat_rate_bp_snapshot,
            net_ex_vat, vat_total, cost_value
          ) VALUES (
            $1, $2, $3, $4, $5, $6,
            $7, 1, 'quick_sale', 'Non', 'dona', 2000,
            1000000, 2000000, 0, 2000000,
            0, 2000000, 1200,
            1785714, 214286, 1200000
          )`,
          [idGen.nextId(), orgA, storeA, deviceA, dummyHlc, nowMs.toString(), saleId],
        );

        await client.query(
          `INSERT INTO payments (
            id, organization_id, store_id, device_id, hlc, created_at_ms,
            sale_id, method, amount, tendered_amount, change_amount
          ) VALUES (
            $1, $2, $3, $4, $5, $6,
            $7, 'cash', 2000000, 2000000, 0
          )`,
          [idGen.nextId(), orgA, storeA, deviceA, dummyHlc, nowMs.toString(), saleId],
        );
      });
    });

    it('rejects unauthenticated requests with 401', async () => {
      const res = await server.inject({
        method: 'GET',
        url: '/api/v1/admin/dashboard',
      });
      expect(res.statusCode).toBe(401);
    });

    it('rejects cashier token from all admin endpoints with 403 (A4)', async () => {
      const endpoints = [
        '/api/v1/admin/dashboard',
        '/api/v1/admin/receipts',
        '/api/v1/admin/customers',
        '/api/v1/admin/products',
        '/api/v1/admin/reports/daily',
        '/api/v1/admin/inventory/low-stock',
        '/api/v1/admin/conflicts',
        '/api/v1/admin/stores/freshness',
      ];

      for (const endpoint of endpoints) {
        const res = await server.inject({
          method: 'GET',
          url: endpoint,
          headers: {
            authorization: `Bearer ${cashierTokenA}`,
          },
        });
        expect(res.statusCode, `Endpoint ${endpoint} should return 403 for cashier`).toBe(403);
      }
    });

    it('returns dashboard metrics for owner including profit and store freshness', async () => {
      const res = await server.inject({
        method: 'GET',
        url: '/api/v1/admin/dashboard',
        headers: {
          authorization: `Bearer ${ownerTokenA}`,
        },
      });

      expect(res.statusCode).toBe(200);
      const json = JSON.parse(res.payload) as AdminDashboardResponseDto;
      expect(json.grossSales).toBe('2000000');
      expect(json.netSales).toBe('2000000');
      expect(json.receiptsCount).toBe(1);
      expect(json.grossProfit).toBe('800000'); // 2000000 - 1200000
      expect(json.stores.length).toBe(1);
      expect(json.stores[0]?.storeName).toBe('Markaziy Do‘kon A');
      expect(json.stores[0]?.isStale).toBe(true);
    });

    it('returns keyset paginated receipts and receipt detail', async () => {
      const listRes = await server.inject({
        method: 'GET',
        url: '/api/v1/admin/receipts?limit=10',
        headers: {
          authorization: `Bearer ${ownerTokenA}`,
        },
      });

      expect(listRes.statusCode).toBe(200);
      const list = JSON.parse(listRes.payload) as AdminReceiptsResponseDto;
      expect(list.items.length).toBe(1);
      expect(list.items[0]?.receiptNumber).toBe('REC-201');
      expect(list.items[0]?.totalTiyin).toBe('2000000');

      const receiptId = list.items[0]?.id;
      const detailRes = await server.inject({
        method: 'GET',
        url: `/api/v1/admin/receipts/${receiptId}`,
        headers: {
          authorization: `Bearer ${ownerTokenA}`,
        },
      });

      expect(detailRes.statusCode).toBe(200);
      const detail = JSON.parse(detailRes.payload) as AdminReceiptDetailResponseDto;
      expect(detail.receiptNumber).toBe('REC-201');
      expect(detail.lines.length).toBe(1);
      expect(detail.lines[0]?.productName).toBe('Non');
      expect(detail.payments.length).toBe(1);
      expect(detail.payments[0]?.method).toBe('cash');
    });

    it('returns customers with masked phone in list and unmasked phone in detail (A6)', async () => {
      const listRes = await server.inject({
        method: 'GET',
        url: '/api/v1/admin/customers',
        headers: {
          authorization: `Bearer ${ownerTokenA}`,
        },
      });

      expect(listRes.statusCode).toBe(200);
      const list = JSON.parse(listRes.payload) as AdminCustomersResponseDto;
      expect(list.items.length).toBe(1);
      expect(list.items[0]?.fullName).toBe('Temur Bek');
      expect(list.items[0]?.maskedPhone).toBe('+998 90 *** ** 43');

      const customerId = list.items[0]?.id;
      const detailRes = await server.inject({
        method: 'GET',
        url: `/api/v1/admin/customers/${customerId}`,
        headers: {
          authorization: `Bearer ${ownerTokenA}`,
        },
      });

      expect(detailRes.statusCode).toBe(200);
      const detail = JSON.parse(detailRes.payload) as AdminCustomerDetailResponseDto;
      expect(detail.fullName).toBe('Temur Bek');
      expect(detail.phone).toBe('+998909876543'); // Unmasked for owner
    });

    it('returns daily sales report matching exact calculation', async () => {
      const res = await server.inject({
        method: 'GET',
        url: '/api/v1/admin/reports/daily',
        headers: {
          authorization: `Bearer ${ownerTokenA}`,
        },
      });

      expect(res.statusCode).toBe(200);
      const json = JSON.parse(res.payload) as DailySalesReportResponseDto;
      expect(json.totalSalesCount).toBe(1);
      expect(json.totalGrossSales).toBe('2000000');
      expect(json.totalNetSales).toBe('2000000');
      expect(json.totalCashSales).toBe('2000000');
      expect(json.totalCostValue).toBe('1200000');
      expect(json.totalGrossProfit).toBe('800000');
    });
  });
});
