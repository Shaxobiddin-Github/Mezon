import type { CloudLoginResponseDto, CloudStoreDto, CloudUserDto } from '@mezon/contracts';
import { unixMsFromBigInt } from '@mezon/domain';
import { DeterministicUuidV7Generator } from '@mezon/test-utils';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import * as argon2 from '@node-rs/argon2';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  PG_APP_ROLE_NAME,
  createCloudPgPool,
  migrateCloudDatabase,
  CloudAuthStore,
  CloudTenantStore,
} from '@mezon/db-cloud';
import { provisionAppRole } from '../../../packages/db-cloud/ops/provision-app-role.mjs';
import { loadCloudConfig } from './config.js';
import { CloudJwtService } from './jwt.js';
import { buildCloudServer } from './server.js';

describe('@mezon/cloud - HTTP API, Fastify, Auth & Multi-Tenant RLS Integration', () => {
  let container: StartedPostgreSqlContainer;
  let adminConn: ReturnType<typeof createCloudPgPool>;
  let appConn: ReturnType<typeof createCloudPgPool>;
  let server: FastifyInstance;
  let authStore: CloudAuthStore;
  let tenantStore: CloudTenantStore;

  const idGen = new DeterministicUuidV7Generator();
  const orgA = idGen.nextId();
  const orgB = idGen.nextId();
  const storeA = idGen.nextId();
  const storeB = idGen.nextId();
  const ownerA = idGen.nextId();
  const ownerB = idGen.nextId();
  const nowMs = unixMsFromBigInt(1_700_000_000_000n);

  const passwordA = 'CorrectHorseBatteryStaple2026!';
  const passwordB = 'OrgBSecretPassword2026!';

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:18-alpine').start();
    adminConn = createCloudPgPool({
      connectionString: container.getConnectionUri(),
    });

    const testAppPassword = 'test-cloud-api-app-password-secret-1234';
    process.env.MEZON_APP_DB_PASSWORD = testAppPassword;
    await provisionAppRole({ pool: adminConn.pool });
    await migrateCloudDatabase(adminConn.db);

    const appConnUri = new URL(container.getConnectionUri());
    appConnUri.username = PG_APP_ROLE_NAME;
    appConnUri.password = testAppPassword;

    appConn = createCloudPgPool({
      connectionString: appConnUri.toString(),
    });

    authStore = new CloudAuthStore(appConn.pool);
    tenantStore = new CloudTenantStore(adminConn.pool);

    const hashA = await argon2.hash(passwordA);
    const hashB = await argon2.hash(passwordB);

    // Seed Org A
    await tenantStore.createOrganizationWithStoreAndOwner({
      organizationId: orgA,
      storeId: storeA,
      ownerUserId: ownerA,
      loginIdentityId: idGen.nextId(),
      organizationName: 'Guzar Kattaqo‘rg‘on Org A',
      storeName: 'Do‘kon A',
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
      organizationName: 'Guzar Samarqand Org B',
      storeName: 'Do‘kon B',
      storeCode: 'store_b',
      ownerUsername: 'owner_b',
      ownerLogin: 'owner_b@guzar.uz',
      passwordHash: hashB,
      nowMs,
    });

    const config = loadCloudConfig({
      DATABASE_URL: appConnUri.toString(),
      JWT_SECRET: 'super-secure-jwt-secret-key-at-least-32-chars-long-12345',
      CORS_ORIGINS: 'http://localhost:3000,http://localhost:5173',
      NODE_ENV: 'test',
    });

    server = await buildCloudServer({
      config,
      conn: appConn,
      jwtService: new CloudJwtService(config.jwtSecret),
      authStore,
      tenantStore: new CloudTenantStore(appConn.pool),
      idGen,
      clock: { nowMs: () => nowMs },
    });

    await server.ready();
  }, 60_000);

  afterAll(async () => {
    if (server) await server.close();
    if (appConn) await appConn.close();
    if (adminConn) await adminConn.close();
    if (container) await container.stop();
  });

  describe('Health Endpoints', () => {
    it('returns 200 ok on /health/live', async () => {
      const res = await server.inject({
        method: 'GET',
        url: '/health/live',
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ status: 'ok' });
    });

    it('returns 200 ok on /health/ready when database is alive', async () => {
      const res = await server.inject({
        method: 'GET',
        url: '/health/ready',
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ status: 'ok', database: 'connected' });
    });
  });

  describe('S1: Database Startup Self-Check & Superuser Rejection', () => {
    it('refuses to start when DATABASE_URL connects with superuser privileges', async () => {
      const superuserConfig = loadCloudConfig({
        DATABASE_URL: container.getConnectionUri(), // admin superuser connection!
        JWT_SECRET: 'super-secure-jwt-secret-key-at-least-32-chars-long-12345',
        NODE_ENV: 'test',
      });

      await expect(
        buildCloudServer({
          config: superuserConfig,
          conn: adminConn,
        }),
      ).rejects.toThrow(/Database startup security check failed/);
    });
  });

  describe('Authentication & Progressive Lockout (C1, C5)', () => {
    it('rejects unknown user with 401', async () => {
      const res = await server.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: {
          login: 'nonexistent@guzar.uz',
          password: 'SomePassword123',
        },
      });
      expect(res.statusCode).toBe(401);
      expect(res.json()).toMatchObject({ error: 'Unauthorized' });
    });

    it('rejects incorrect password with 401', async () => {
      const res = await server.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: {
          login: 'owner_a@guzar.uz',
          password: 'WrongPassword!',
        },
      });
      expect(res.statusCode).toBe(401);
      expect(res.json()).toMatchObject({ error: 'Unauthorized' });
    });

    it('locks out account after 5 failed login attempts (progressive lockout)', async () => {
      // 4 more wrong attempts for owner_a
      for (let i = 0; i < 3; i++) {
        const res = await server.inject({
          method: 'POST',
          url: '/api/v1/auth/login',
          payload: {
            login: 'owner_a@guzar.uz',
            password: `WrongPassword${i}!`,
          },
        });
        expect(res.statusCode).toBe(401);
      }

      // 5th failed attempt -> 429 Too Many Requests
      const lockRes = await server.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: {
          login: 'owner_a@guzar.uz',
          password: 'WrongPassword5th!',
        },
      });
      expect(lockRes.statusCode).toBe(429);
      const lockData = lockRes.json<{ error: string; message: string }>();
      expect(lockData.error).toBe('Too Many Requests');
      expect(lockData.message).toContain('locked for 5 minutes');

      // Even with correct password, now blocked due to lockout!
      const correctWhileLocked = await server.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: {
          login: 'owner_a@guzar.uz',
          password: passwordA,
        },
      });
      expect(correctWhileLocked.statusCode).toBe(429);
      const lockedData = correctWhileLocked.json<{ error: string; message: string }>();
      expect(lockedData.error).toBe('Too Many Requests');
      expect(lockedData.message).toContain('temporarily locked');

      // Reset lockout for owner_a so other tests can proceed
      await authStore.resetLoginFailure({
        organizationId: orgA,
        userId: ownerA,
        nowMs,
      });
    });

    it('successfully logs in with valid credentials and returns C2 tenant-prefixed token', async () => {
      const res = await server.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: {
          login: 'owner_a@guzar.uz',
          password: passwordA,
        },
      });

      expect(res.statusCode).toBe(200);
      const data = res.json<CloudLoginResponseDto>();
      expect(data).toHaveProperty('accessToken');
      expect(data).toHaveProperty('refreshToken');
      expect(data.user).toEqual({
        id: ownerA,
        organizationId: orgA,
        username: 'owner_a',
        role: 'owner',
      });

      // C2 check: refreshToken MUST start with organizationId prefix!
      expect(data.refreshToken.startsWith(`${orgA}.`)).toBe(true);
    });

    it('successfully logs in with case-variant and whitespace-padded login (S3 normalization)', async () => {
      const res = await server.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: {
          login: '  OWNER_A@GUZAR.UZ  ',
          password: passwordA,
        },
      });

      expect(res.statusCode).toBe(200);
      const data = res.json<CloudLoginResponseDto>();
      expect(data.user.id).toBe(ownerA);
      expect(data.user.organizationId).toBe(orgA);
    });
  });

  describe('C2 Refresh Token Rotation & Reuse Detection Under RLS', () => {
    let initialRefreshToken: string;

    beforeAll(async () => {
      const res = await server.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: {
          login: 'owner_a@guzar.uz',
          password: passwordA,
        },
      });
      initialRefreshToken = res.json<CloudLoginResponseDto>().refreshToken;
    });

    it('rejects refresh token with forged organization prefix (anti-spoofing)', async () => {
      const parts = initialRefreshToken.split('.');
      const forgedToken = `${orgB}.${parts[1]}`; // Forging Org B prefix on Org A's token

      const res = await server.inject({
        method: 'POST',
        url: '/api/v1/auth/refresh',
        payload: { refreshToken: forgedToken },
      });

      expect(res.statusCode).toBe(401);
      expect(res.json<{ error: string }>().error).toBe('Unauthorized');
    });

    it('successfully rotates refresh token and returns new pair', async () => {
      const res = await server.inject({
        method: 'POST',
        url: '/api/v1/auth/refresh',
        payload: { refreshToken: initialRefreshToken },
      });

      expect(res.statusCode).toBe(200);
      const data = res.json<{ accessToken: string; refreshToken: string }>();
      expect(data).toHaveProperty('accessToken');
      expect(data).toHaveProperty('refreshToken');
      expect(data.refreshToken.startsWith(`${orgA}.`)).toBe(true);
      expect(data.refreshToken).not.toBe(initialRefreshToken);

      // Subsequent attempt with old initialRefreshToken MUST trigger reuse detection!
      const reuseRes = await server.inject({
        method: 'POST',
        url: '/api/v1/auth/refresh',
        payload: { refreshToken: initialRefreshToken },
      });

      expect(reuseRes.statusCode).toBe(401);
      const reuseData = reuseRes.json<{ error: string; message: string }>();
      expect(reuseData.error).toBe('Unauthorized');
      expect(reuseData.message).toContain('reuse detected');

      // And the active token issued during the first rotation must ALSO now be revoked!
      const victimRes = await server.inject({
        method: 'POST',
        url: '/api/v1/auth/refresh',
        payload: { refreshToken: data.refreshToken },
      });

      expect(victimRes.statusCode).toBe(401);
      const victimData = victimRes.json<{ error: string; message: string }>();
      expect(victimData.error).toBe('Unauthorized');
      expect(victimData.message).toContain('reuse detected');
    });
  });

  describe('Protected Endpoints & Tenant Isolation (RLS)', () => {
    let tokenOrgA: string;
    let tokenOrgB: string;

    beforeAll(async () => {
      const loginA = await server.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { login: 'owner_a@guzar.uz', password: passwordA },
      });
      tokenOrgA = loginA.json<CloudLoginResponseDto>().accessToken;

      const loginB = await server.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { login: 'owner_b@guzar.uz', password: passwordB },
      });
      tokenOrgB = loginB.json<CloudLoginResponseDto>().accessToken;
    });

    it('requires authentication for /api/v1/me', async () => {
      const res = await server.inject({
        method: 'GET',
        url: '/api/v1/me',
      });
      expect(res.statusCode).toBe(401);
    });

    it('returns authenticated user information on /api/v1/me', async () => {
      const res = await server.inject({
        method: 'GET',
        url: '/api/v1/me',
        headers: { authorization: `Bearer ${tokenOrgA}` },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json<{ user: CloudUserDto }>().user).toEqual({
        id: ownerA,
        organizationId: orgA,
        username: 'owner_a',
        role: 'owner',
      });
    });

    it('lists only own stores under RLS isolation', async () => {
      const resA = await server.inject({
        method: 'GET',
        url: '/api/v1/stores',
        headers: { authorization: `Bearer ${tokenOrgA}` },
      });
      expect(resA.statusCode).toBe(200);
      const storesA = resA.json<{ stores: CloudStoreDto[] }>().stores;
      expect(storesA).toHaveLength(1);
      expect(storesA[0].id).toBe(storeA);
      expect(storesA[0].organizationId).toBe(orgA);

      const resB = await server.inject({
        method: 'GET',
        url: '/api/v1/stores',
        headers: { authorization: `Bearer ${tokenOrgB}` },
      });
      expect(resB.statusCode).toBe(200);
      const storesB = resB.json<{ stores: CloudStoreDto[] }>().stores;
      expect(storesB).toHaveLength(1);
      expect(storesB[0].id).toBe(storeB);
      expect(storesB[0].organizationId).toBe(orgB);
    });

    it('creates store in own organization and does not leak to other organizations', async () => {
      const createRes = await server.inject({
        method: 'POST',
        url: '/api/v1/stores',
        headers: { authorization: `Bearer ${tokenOrgA}` },
        payload: {
          name: 'Filial Kattaqo‘rg‘on 2',
          code: 'store_a_branch2',
        },
      });

      expect(createRes.statusCode).toBe(201);
      const newStore = createRes.json<{ store: CloudStoreDto }>().store;
      expect(newStore.organizationId).toBe(orgA);
      expect(newStore.code).toBe('store_a_branch2');

      // Org A now has 2 stores
      const listA = await server.inject({
        method: 'GET',
        url: '/api/v1/stores',
        headers: { authorization: `Bearer ${tokenOrgA}` },
      });
      expect(listA.json<{ stores: CloudStoreDto[] }>().stores).toHaveLength(2);

      // Org B STILL has only 1 store!
      const listB = await server.inject({
        method: 'GET',
        url: '/api/v1/stores',
        headers: { authorization: `Bearer ${tokenOrgB}` },
      });
      expect(listB.json<{ stores: CloudStoreDto[] }>().stores).toHaveLength(1);
      expect(listB.json<{ stores: CloudStoreDto[] }>().stores[0].id).toBe(storeB);
    });
  });
});
