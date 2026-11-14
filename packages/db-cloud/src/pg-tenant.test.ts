import { createHash, randomBytes } from 'node:crypto';
import { unixMsFromBigInt } from '@mezon/domain';
import { DeterministicUuidV7Generator } from '@mezon/test-utils';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { provisionAppRole } from '../ops/provision-app-role.mjs';
import { CloudAuthStore } from './auth-store.js';
import {
  PG_APP_ROLE_NAME,
  assertNonSuperuserNonBypassRls,
  createCloudPgPool,
  migrateCloudDatabase,
  withPgTenantContext,
} from './index.js';
import {
  cloudLoginIdentities,
  cloudOrganizations,
  cloudRefreshTokens,
  cloudStores,
  cloudUsers,
} from './schema/index.js';
import { CloudTenantStore } from './tenant-store.js';

const schema = {
  cloudOrganizations,
  cloudStores,
  cloudUsers,
  cloudRefreshTokens,
  cloudLoginIdentities,
};

describe('@mezon/db-cloud - PostgreSQL 18 Tenant Isolation & Pre-Auth Security (C1, C2)', () => {
  let container: StartedPostgreSqlContainer;
  let adminConn: ReturnType<typeof createCloudPgPool<typeof schema>>;
  let appConn: ReturnType<typeof createCloudPgPool<typeof schema>>;
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

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:18-alpine').start();
    adminConn = createCloudPgPool({
      connectionString: container.getConnectionUri(),
      schema,
    });

    const testAppPassword = 'test-mezon-app-password-secret-1234';
    process.env.MEZON_APP_DB_PASSWORD = testAppPassword;
    await provisionAppRole({ pool: adminConn.pool });

    // Apply migrations (0000_rls_foundation and 0001_cloud_foundation)
    await migrateCloudDatabase(adminConn.db);

    const appConnUri = new URL(container.getConnectionUri());
    appConnUri.username = PG_APP_ROLE_NAME;
    appConnUri.password = testAppPassword;

    appConn = createCloudPgPool({
      connectionString: appConnUri.toString(),
      schema,
    });

    authStore = new CloudAuthStore(appConn.pool);
    tenantStore = new CloudTenantStore(adminConn.pool);

    // Seed Organization A
    await tenantStore.createOrganizationWithStoreAndOwner({
      organizationId: orgA,
      storeId: storeA,
      ownerUserId: ownerA,
      loginIdentityId: idGen.nextId(),
      organizationName: 'Guzar Org A',
      storeName: 'Do‘kon A',
      storeCode: 'store_a',
      ownerUsername: 'owner_a',
      ownerLogin: 'owner_a@guzar.uz',
      passwordHash: 'argon2-dummy-hash-a',
      nowMs,
    });

    // Seed Organization B
    await tenantStore.createOrganizationWithStoreAndOwner({
      organizationId: orgB,
      storeId: storeB,
      ownerUserId: ownerB,
      loginIdentityId: idGen.nextId(),
      organizationName: 'Guzar Org B',
      storeName: 'Do‘kon B',
      storeCode: 'store_b',
      ownerUsername: 'owner_b',
      ownerLogin: 'owner_b@guzar.uz',
      passwordHash: 'argon2-dummy-hash-b',
      nowMs,
    });
  }, 60_000);

  afterAll(async () => {
    await appConn?.pool.end();
    await adminConn?.pool.end();
    await container?.stop();
  });

  describe('C1: Pre-Auth Login Lookup and Security Definer Isolation', () => {
    it('forbids mezon_app role from directly querying cloud_login_identities table (42501)', async () => {
      const client = await appConn.pool.connect();
      try {
        await expect(client.query('SELECT * FROM cloud_login_identities')).rejects.toMatchObject({
          code: '42501',
        });
      } finally {
        client.release();
      }
    });

    it('allows mezon_app to lookup login via auth_lookup_login SECURITY DEFINER function', async () => {
      const resA = await authStore.lookupLogin('owner_a@guzar.uz');
      expect(resA).not.toBeNull();
      expect(resA?.userId).toBe(ownerA);
      expect(resA?.organizationId).toBe(orgA);
      expect(resA?.passwordHash).toBe('argon2-dummy-hash-a');
      expect(resA?.userRole).toBe('owner');
      expect(resA?.userStatus).toBe('active');

      const nonExistent = await authStore.lookupLogin('nobody@guzar.uz');
      expect(nonExistent).toBeNull();
    });

    it('rejects duplicate login across different organizations (global uniqueness)', async () => {
      // Trying to create another organization with same login 'owner_a@guzar.uz'
      const orgC = idGen.nextId();
      await expect(
        tenantStore.createOrganizationWithStoreAndOwner({
          organizationId: orgC,
          storeId: idGen.nextId(),
          ownerUserId: idGen.nextId(),
          loginIdentityId: idGen.nextId(),
          organizationName: 'Guzar Org C',
          storeName: 'Do‘kon C',
          storeCode: 'store_c',
          ownerUsername: 'owner_c',
          ownerLogin: 'owner_a@guzar.uz', // DUPLICATE LOGIN
          passwordHash: 'argon2-hash-c',
          nowMs,
        }),
      ).rejects.toMatchObject({ code: '23505' }); // unique_violation
    });

    it('rejects case-variant duplicate login (S3)', async () => {
      const orgD = idGen.nextId();
      await expect(
        tenantStore.createOrganizationWithStoreAndOwner({
          organizationId: orgD,
          storeId: idGen.nextId(),
          ownerUserId: idGen.nextId(),
          loginIdentityId: idGen.nextId(),
          organizationName: 'Guzar Org D',
          storeName: 'Do‘kon D',
          storeCode: 'store_d',
          ownerUsername: 'owner_d',
          ownerLogin: 'OWNER_A@GUZAR.UZ', // Case-variant of owner_a@guzar.uz
          passwordHash: 'argon2-hash-d',
          nowMs,
        }),
      ).rejects.toMatchObject({ code: '23505' });
    });

    it('returns exact single result for case-variant search in auth_lookup_login (S3)', async () => {
      const res1 = await authStore.lookupLogin('OWNER_A@GUZAR.UZ');
      const res2 = await authStore.lookupLogin('owner_a@guzar.uz');
      const res3 = await authStore.lookupLogin('  Owner_A@Guzar.Uz  ');
      expect(res1?.userId).toBe(ownerA);
      expect(res2?.userId).toBe(ownerA);
      expect(res3?.userId).toBe(ownerA);
    });

    it('verifies auth_lookup_login function owner is mezon_auth_owner and not superuser (S2)', async () => {
      const res = await adminConn.pool.query<{
        proname: string;
        owner_name: string;
        is_superuser: boolean;
      }>(`
        SELECT p.proname, r.rolname AS owner_name, r.rolsuper AS is_superuser
        FROM pg_proc p
        JOIN pg_roles r ON r.oid = p.proowner
        WHERE p.proname = 'auth_lookup_login'
      `);
      expect(res.rows).toHaveLength(1);
      expect(res.rows[0].owner_name).toBe('mezon_auth_owner');
      expect(res.rows[0].is_superuser).toBe(false);
    });

    it('verifies PUBLIC role has no EXECUTE privilege on auth_lookup_login (S2)', async () => {
      const res = await adminConn.pool.query<{ has_privilege: boolean }>(`
        SELECT has_function_privilege('public', 'auth_lookup_login(text)', 'EXECUTE') AS has_privilege
      `);
      expect(res.rows[0].has_privilege).toBe(false);
    });

    it('assertNonSuperuserNonBypassRls rejects superuser / bypassrls connection (S1)', async () => {
      // appConn role is mezon_app (NOSUPERUSER, NOBYPASSRLS) -> must succeed
      await expect(assertNonSuperuserNonBypassRls(appConn.pool)).resolves.toBeUndefined();

      // adminConn role is postgres (SUPERUSER) -> must throw
      await expect(assertNonSuperuserNonBypassRls(adminConn.pool)).rejects.toThrow(
        /Database startup security check failed/,
      );
    });
  });

  describe('C2: Tenant-Prefixed Refresh Token and Rotation Under RLS', () => {
    it('rotates refresh token within own tenant and prevents cross-tenant spoofing', async () => {
      const tokenA1Id = idGen.nextId();
      const rawSecret = randomBytes(32).toString('base64url');
      const tokenHash1 = createHash('sha256').update(rawSecret).digest('hex');

      // Save initial refresh token for Org A
      await authStore.saveRefreshToken({
        organizationId: orgA,
        tokenId: tokenA1Id,
        userId: ownerA,
        tokenHash: tokenHash1,
        expiresAtMs: unixMsFromBigInt(1_700_100_000_000n),
        nowMs,
      });

      // Rotating under Org A succeeds
      const tokenA2Id = idGen.nextId();
      const rawSecret2 = randomBytes(32).toString('base64url');
      const tokenHash2 = createHash('sha256').update(rawSecret2).digest('hex');

      const rotated = await authStore.rotateRefreshToken({
        organizationId: orgA,
        oldTokenHash: tokenHash1,
        newTokenId: tokenA2Id,
        newTokenHash: tokenHash2,
        newExpiresAtMs: unixMsFromBigInt(1_700_200_000_000n),
        nowMs,
      });
      expect(rotated.userId).toBe(ownerA);

      // Attempting to rotate or query Org A token under Org B context MUST fail (RLS blocks sight)
      const tokenBId = idGen.nextId();
      const fakeSecret = randomBytes(32).toString('base64url');
      const fakeHash = createHash('sha256').update(fakeSecret).digest('hex');

      await expect(
        authStore.rotateRefreshToken({
          organizationId: orgB, // SPOOFED PREFIX
          oldTokenHash: tokenHash2,
          newTokenId: tokenBId,
          newTokenHash: fakeHash,
          newExpiresAtMs: unixMsFromBigInt(1_700_300_000_000n),
          nowMs,
        }),
      ).rejects.toMatchObject({ code: 'AUTH_UNAUTHORIZED' });
    });

    it('detects token reuse and revokes all active sessions for that user', async () => {
      const tokenId = idGen.nextId();
      const secret = randomBytes(32).toString('base64url');
      const hash1 = createHash('sha256').update(secret).digest('hex');

      await authStore.saveRefreshToken({
        organizationId: orgA,
        tokenId,
        userId: ownerA,
        tokenHash: hash1,
        expiresAtMs: unixMsFromBigInt(1_700_100_000_000n),
        nowMs,
      });

      // First rotation succeeds
      const nextTokenId = idGen.nextId();
      const secret2 = randomBytes(32).toString('base64url');
      const hash2 = createHash('sha256').update(secret2).digest('hex');

      await authStore.rotateRefreshToken({
        organizationId: orgA,
        oldTokenHash: hash1,
        newTokenId: nextTokenId,
        newTokenHash: hash2,
        newExpiresAtMs: unixMsFromBigInt(1_700_200_000_000n),
        nowMs,
      });

      // Second attempt using ALREADY REVOKED hash1 -> MUST trigger reuse detection!
      const attackerTokenId = idGen.nextId();
      const attackerHash = createHash('sha256').update('attacker').digest('hex');

      await expect(
        authStore.rotateRefreshToken({
          organizationId: orgA,
          oldTokenHash: hash1, // REUSED OLD TOKEN
          newTokenId: attackerTokenId,
          newTokenHash: attackerHash,
          newExpiresAtMs: unixMsFromBigInt(1_700_300_000_000n),
          nowMs,
        }),
      ).rejects.toThrow(/reuse detected/);

      // Now hash2 MUST also be revoked due to security wipe!
      const victimTokenId = idGen.nextId();
      const victimHash = createHash('sha256').update('victim').digest('hex');

      await expect(
        authStore.rotateRefreshToken({
          organizationId: orgA,
          oldTokenHash: hash2,
          newTokenId: victimTokenId,
          newTokenHash: victimHash,
          newExpiresAtMs: unixMsFromBigInt(1_700_300_000_000n),
          nowMs,
        }),
      ).rejects.toThrow(/reuse detected/);
    });
  });

  describe('PostgreSQL RLS Multi-Tenant Isolation', () => {
    it('enforces fail-closed RLS: query without organization_id context returns 0 rows', async () => {
      const client = await appConn.pool.connect();
      try {
        const stores = await client.query('SELECT * FROM cloud_stores');
        expect(stores.rows).toHaveLength(0);

        const users = await client.query('SELECT * FROM cloud_users');
        expect(users.rows).toHaveLength(0);
      } finally {
        client.release();
      }
    });

    it('strictly isolates stores and organizations between Org A and Org B', async () => {
      const appTenantStore = new CloudTenantStore(appConn.pool);

      const storesA = await appTenantStore.listStores(orgA);
      expect(storesA).toHaveLength(1);
      expect(storesA[0].id).toBe(storeA);
      expect(storesA[0].code).toBe('store_a');

      const storesB = await appTenantStore.listStores(orgB);
      expect(storesB).toHaveLength(1);
      expect(storesB[0].id).toBe(storeB);
      expect(storesB[0].code).toBe('store_b');

      // Org A cannot read Org B's organization
      const orgBFromA = await withPgTenantContext(appConn.pool, orgA, async (tx) => {
        return tx.select().from(cloudOrganizations).where(eq(cloudOrganizations.id, orgB));
      });
      expect(orgBFromA).toHaveLength(0);
    });

    it('rejects cross-tenant INSERT via RLS WITH CHECK (42501)', async () => {
      // Under Org A context, trying to insert a store with organization_id = Org B
      await expect(
        withPgTenantContext(appConn.pool, orgA, async (tx) => {
          await tx.insert(cloudStores).values({
            id: idGen.nextId(),
            organizationId: orgB, // MISMATCH
            name: 'Rogue Store',
            code: 'rogue',
            isActive: true,
            createdAtMs: nowMs,
            updatedAtMs: nowMs,
          });
        }),
      ).rejects.toMatchObject({
        cause: { code: '42501' },
      });
    });
  });
});
