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

/**
 * S1/S2 (found in T2.7a review): a refresh must re-read role, status and name from the user row.
 * Before the fix both refresh endpoints minted `role: 'owner'` for anyone and ignored blocked users.
 */
describePg('@mezon/cloud - refresh re-reads identity claims (S1, S2)', () => {
  let container: StartedPostgreSqlContainer;
  let adminConn: ReturnType<typeof createCloudPgPool>;
  let appConn: ReturnType<typeof createCloudPgPool>;
  let server: FastifyInstance;
  let jwtService: CloudJwtService;

  const idGen = new DeterministicUuidV7Generator();
  const org = idGen.nextId();
  const store = idGen.nextId();
  const owner = idGen.nextId();
  const cashier = idGen.nextId();
  const manager = idGen.nextId();
  const demoted = idGen.nextId();
  const blocked = idGen.nextId();
  const nowMs = unixMsFromBigInt(1_731_772_800_000n);
  const password = 'RefreshClaims2026!';
  const jwtSecret = 'test-refresh-claims-jwt-secret-32-chars-min!';
  const ORIGIN = 'http://localhost:5173';

  const setUser = async (userId: string, column: 'role' | 'status', value: string) => {
    await withPgTenantContext(adminConn.pool, org, async (_tx, client) => {
      await client.query(`UPDATE cloud_users SET ${column} = $1 WHERE id = $2`, [value, userId]);
    });
  };

  const deviceLogin = async (login: string) => {
    const res = await server.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { login, password },
    });
    expect(res.statusCode).toBe(200);
    return JSON.parse(res.payload) as { accessToken: string; refreshToken: string };
  };

  const deviceRefresh = (refreshToken: string) =>
    server.inject({ method: 'POST', url: '/api/v1/auth/refresh', payload: { refreshToken } });

  const adminLoginCookie = async (login: string) => {
    const res = await server.inject({
      method: 'POST',
      url: '/api/v1/admin/auth/login',
      payload: { login, password },
    });
    expect(res.statusCode).toBe(200);
    return /mezon_admin_refresh=([^;]+)/.exec(String(res.headers['set-cookie']))?.[1] ?? '';
  };

  const adminRefresh = (cookie: string, extraHeaders: Record<string, string> = {}) =>
    server.inject({
      method: 'POST',
      url: '/api/v1/admin/auth/refresh',
      headers: {
        'x-mezon-admin': '1',
        origin: ORIGIN,
        cookie: `mezon_admin_refresh=${cookie}`,
        ...extraHeaders,
      },
    });

  const claimsOf = async (payload: string) => {
    const body = JSON.parse(payload) as { accessToken: string };
    return jwtService.verifyAccessToken(body.accessToken);
  };

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:18-alpine').start();
    adminConn = createCloudPgPool({ connectionString: container.getConnectionUri() });
    const appPassword = 'test-refresh-claims-app-password-1234';
    process.env.MEZON_APP_DB_PASSWORD = appPassword;
    await provisionAppRole({ pool: adminConn.pool });
    await migrateCloudDatabase(adminConn.db);

    const appUri = new URL(container.getConnectionUri());
    appUri.username = PG_APP_ROLE_NAME;
    appUri.password = appPassword;
    appConn = createCloudPgPool({ connectionString: appUri.toString() });

    const hash = await argon2.hash(password);
    await new CloudTenantStore(adminConn.pool).createOrganizationWithStoreAndOwner({
      organizationId: org,
      storeId: store,
      ownerUserId: owner,
      loginIdentityId: idGen.nextId(),
      organizationName: 'Refresh Claims Org',
      storeName: 'Store',
      storeCode: 'store_rc',
      ownerUsername: 'owner_rc',
      ownerLogin: 'owner_rc@guzar.uz',
      passwordHash: hash,
      nowMs,
    });

    const extraUsers: ReadonlyArray<readonly [string, string, string]> = [
      [cashier, 'cashier_rc', 'cashier'],
      [manager, 'manager_rc', 'manager'],
      [demoted, 'demoted_rc', 'owner'],
      [blocked, 'blocked_rc', 'owner'],
    ];
    await withPgTenantContext(adminConn.pool, org, async (_tx, client) => {
      for (const [id, username, role] of extraUsers) {
        await client.query(
          `INSERT INTO cloud_users (id, organization_id, username, role, status, failed_login_attempts, created_at_ms, updated_at_ms)
           VALUES ($1, $2, $3, $4, 'active', 0, $5, $5)`,
          [id, org, username, role, nowMs.toString()],
        );
        await client.query(
          `INSERT INTO cloud_login_identities (id, login, org_id, user_id, password_hash, created_at_ms, updated_at_ms)
           VALUES ($1, $2, $3, $4, $5, $6, $6)`,
          [idGen.nextId(), `${username}@guzar.uz`, org, id, hash, nowMs.toString()],
        );
      }
    });

    jwtService = new CloudJwtService(jwtSecret);
    server = await buildCloudServer({
      config: loadCloudConfig({
        NODE_ENV: 'test',
        PORT: '3000',
        HOST: '127.0.0.1',
        DATABASE_URL: appUri.toString(),
        JWT_SECRET: jwtSecret,
        CORS_ORIGINS: ORIGIN,
      }),
      conn: appConn,
      jwtService,
      authStore: new CloudAuthStore(appConn.pool),
      clock: { nowMs: () => nowMs },
    });
  }, 120_000);

  afterAll(async () => {
    await server?.close();
    await appConn?.pool.end();
    await adminConn?.pool.end();
    await container?.stop();
  });

  it('a cashier cannot log in to the cloud on either channel (review K3)', async () => {
    const device = await server.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { login: 'cashier_rc@guzar.uz', password },
    });
    expect(device.statusCode).toBe(403);
    const admin = await server.inject({
      method: 'POST',
      url: '/api/v1/admin/auth/login',
      payload: { login: 'cashier_rc@guzar.uz', password },
    });
    expect(admin.statusCode).toBe(403);
  });

  it('a user demoted to cashier: refresh is refused on both channels and the family revoked', async () => {
    await setUser(cashier, 'role', 'manager');
    const device = await deviceLogin('cashier_rc@guzar.uz');
    const cookie = await adminLoginCookie('cashier_rc@guzar.uz');
    await setUser(cashier, 'role', 'cashier');

    // Device channel: 403, and EVERY token of the user is revoked...
    const deviceRes = await deviceRefresh(device.refreshToken);
    expect(deviceRes.statusCode).toBe(403);
    expect(JSON.parse(deviceRes.payload)).not.toHaveProperty('accessToken');
    // ...so the cabinet cookie is dead too (401) and is cleared.
    const adminRes = await adminRefresh(cookie);
    expect(adminRes.statusCode).toBe(401);
    expect(String(adminRes.headers['set-cookie'])).toContain('Max-Age=0');
    // Restoring the role does not revive the old tokens.
    await setUser(cashier, 'role', 'manager');
    expect((await deviceRefresh(device.refreshToken)).statusCode).toBe(401);
    await setUser(cashier, 'role', 'cashier');
  });

  it('admin refresh keeps a manager a manager', async () => {
    const cookie = await adminLoginCookie('manager_rc@guzar.uz');
    const res = await adminRefresh(cookie);
    expect(res.statusCode).toBe(200);
    expect((await claimsOf(res.payload)).role).toBe('manager');
  });

  it('a role change after login takes effect on the next refresh (both channels)', async () => {
    const cookie = await adminLoginCookie('demoted_rc@guzar.uz');
    const device = await deviceLogin('demoted_rc@guzar.uz');
    await setUser(demoted, 'role', 'manager');
    const adminRes = await adminRefresh(cookie);
    expect(adminRes.statusCode).toBe(200);
    expect((await claimsOf(adminRes.payload)).role).toBe('manager');
    const deviceRes = await deviceRefresh(device.refreshToken);
    expect(deviceRes.statusCode).toBe(200);
    expect((await claimsOf(deviceRes.payload)).role).toBe('manager');
  });

  it('a blocked user cannot refresh, and reactivation does not revive the old tokens', async () => {
    const cookie = await adminLoginCookie('blocked_rc@guzar.uz');
    const device = await deviceLogin('blocked_rc@guzar.uz');
    await setUser(blocked, 'status', 'blocked');
    expect((await adminRefresh(cookie)).statusCode).toBe(401);
    expect((await deviceRefresh(device.refreshToken)).statusCode).toBe(401);
    await setUser(blocked, 'status', 'active');
    expect((await adminRefresh(cookie)).statusCode).toBe(401);
    expect((await deviceRefresh(device.refreshToken)).statusCode).toBe(401);
  });

  it('an unknown status value is treated as inactive (allowlist, not denylist)', async () => {
    const device = await deviceLogin('manager_rc@guzar.uz');
    await setUser(manager, 'status', 'suspended');
    try {
      expect((await deviceRefresh(device.refreshToken)).statusCode).toBe(401);
      const login = await server.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { login: 'manager_rc@guzar.uz', password },
      });
      expect(login.statusCode).toBe(403);
    } finally {
      await setUser(manager, 'status', 'active');
    }
  });

  it('owner refresh still yields owner (no regression)', async () => {
    const cookie = await adminLoginCookie('owner_rc@guzar.uz');
    const res = await adminRefresh(cookie);
    expect(res.statusCode).toBe(200);
    const claims = await claimsOf(res.payload);
    expect(claims.role).toBe('owner');
    expect(claims.name).toBe('owner_rc');
  });

  it('admin logout requires the CSRF header and rejects a foreign Origin', async () => {
    const noHeader = await server.inject({
      method: 'POST',
      url: '/api/v1/admin/auth/logout',
      headers: { cookie: 'mezon_admin_refresh=x' },
    });
    expect(noHeader.statusCode).toBe(400);
    const foreign = await server.inject({
      method: 'POST',
      url: '/api/v1/admin/auth/logout',
      headers: {
        'x-mezon-admin': '1',
        origin: 'https://evil.example',
        cookie: 'mezon_admin_refresh=x',
      },
    });
    expect(foreign.statusCode).toBe(403);
  });
});
