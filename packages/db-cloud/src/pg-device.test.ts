import { parseUuidV7, unixMsFromBigInt } from '@mezon/domain';
import { DeterministicUuidV7Generator } from '@mezon/test-utils';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { provisionAppRole } from '../ops/provision-app-role.mjs';
import {
  CloudDeviceStore,
  PG_APP_ROLE_NAME,
  createCloudPgPool,
  migrateCloudDatabase,
} from './index.js';
import {
  cloudDevicePairingCodes,
  cloudDeviceTokens,
  cloudDevices,
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
  cloudDevicePairingCodes,
  cloudDevices,
  cloudDeviceTokens,
};

describe('@mezon/db-cloud - Device Pairing, Concurrency & Token Lifecycle (D1, D2)', () => {
  let container: StartedPostgreSqlContainer;
  let adminConn: ReturnType<typeof createCloudPgPool<typeof schema>>;
  let appConn: ReturnType<typeof createCloudPgPool<typeof schema>>;
  let tenantStore: CloudTenantStore;
  let deviceStore: CloudDeviceStore;

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

    const testAppPassword = 'test-mezon-app-password-device-1234';
    process.env.MEZON_APP_DB_PASSWORD = testAppPassword;
    await provisionAppRole({ pool: adminConn.pool });

    // Apply all migrations (including 0002_device_pairing)
    await migrateCloudDatabase(adminConn.db);

    const appConnUri = new URL(container.getConnectionUri());
    appConnUri.username = PG_APP_ROLE_NAME;
    appConnUri.password = testAppPassword;

    appConn = createCloudPgPool({
      connectionString: appConnUri.toString(),
      schema,
    });

    tenantStore = new CloudTenantStore(adminConn.pool);
    deviceStore = new CloudDeviceStore(appConn.pool);

    // Seed Org A & Org B
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
      passwordHash: 'dummy-hash-a',
      nowMs,
    });

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
      passwordHash: 'dummy-hash-b',
      nowMs,
    });
  }, 60_000);

  afterAll(async () => {
    await appConn?.pool?.end();
    await adminConn?.pool?.end();
    await container?.stop();
  });

  it('D1: pre-auth pairing code lookup via SECURITY DEFINER function auth_lookup_pairing_code', async () => {
    // 1. Create pairing code under Org A
    const created = await deviceStore.createPairingCode({
      organizationId: orgA,
      storeId: storeA,
      deviceName: 'Kassa 1 - Monoblok',
      idGen,
      nowMs,
    });

    expect(created.code).toMatch(/^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{8}$/);
    expect(created.storeName).toBe('Do‘kon A');

    // 2. Lookup pairing code as anonymous appConn (no tenant context set)
    const lookup = await deviceStore.lookupPairingCode(created.code);
    expect(lookup).not.toBeNull();
    expect(lookup?.organizationId).toBe(orgA);
    expect(lookup?.storeId).toBe(storeA);
    expect(lookup?.deviceName).toBe('Kassa 1 - Monoblok');
    expect(lookup?.attemptsLeft).toBe(5);
    expect(lookup?.usedAtMs).toBeNull();

    // 3. Lookup invalid code returns null
    const notFound = await deviceStore.lookupPairingCode('INVALID8');
    expect(notFound).toBeNull();
  });

  it('D1: atomic concurrency guard prevents race condition on pairing code', async () => {
    const created = await deviceStore.createPairingCode({
      organizationId: orgA,
      storeId: storeA,
      deviceName: 'Kassa 2 - Planshet',
      idGen,
      nowMs,
    });

    const lookup = await deviceStore.lookupPairingCode(created.code);
    expect(lookup).not.toBeNull();

    const deviceId1 = idGen.nextId();
    const deviceId2 = idGen.nextId();

    // Two parallel pair requests hitting with the same pairing code
    const results = await Promise.allSettled([
      deviceStore.pairDevice({
        pairingLookup: lookup!,
        deviceId: deviceId1,
        platform: 'windows',
        appVersion: '1.0.0',
        idGen,
        nowMs,
      }),
      deviceStore.pairDevice({
        pairingLookup: lookup!,
        deviceId: deviceId2,
        platform: 'android',
        appVersion: '1.0.0',
        idGen,
        nowMs,
      }),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');

    // Exactly one succeeds, exactly one gets PAIRING_ALREADY_USED
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    if (rejected[0]?.status === 'rejected') {
      expect((rejected[0].reason as { code?: string }).code).toBe('PAIRING_ALREADY_USED');
    }
  });

  it('enforces that physical deviceId cannot be paired across different tenants', async () => {
    const deviceId = idGen.nextId();

    // 1. Pair with Org A
    const codeA = await deviceStore.createPairingCode({
      organizationId: orgA,
      storeId: storeA,
      deviceName: 'POS Terminal Org A',
      idGen,
      nowMs,
    });
    const lookupA = await deviceStore.lookupPairingCode(codeA.code);
    expect(lookupA).not.toBeNull();

    const pairedA = await deviceStore.pairDevice({
      pairingLookup: lookupA!,
      deviceId,
      platform: 'windows',
      appVersion: '1.0.0',
      idGen,
      nowMs,
    });
    expect(pairedA.organizationId).toBe(orgA);

    // 2. Try to pair the SAME deviceId with Org B
    const codeB = await deviceStore.createPairingCode({
      organizationId: orgB,
      storeId: storeB,
      deviceName: 'POS Terminal Org B',
      idGen,
      nowMs,
    });
    const lookupB = await deviceStore.lookupPairingCode(codeB.code);
    expect(lookupB).not.toBeNull();

    await expect(
      deviceStore.pairDevice({
        pairingLookup: lookupB!,
        deviceId,
        platform: 'windows',
        appVersion: '1.0.0',
        idGen,
        nowMs,
      }),
    ).rejects.toThrowError(/DEVICE_ALREADY_REGISTERED/);
  });

  it('D2: token verification, grace period rotation, idempotency, and reuse security wipe', async () => {
    const deviceId = idGen.nextId();
    const t0 = unixMsFromBigInt(1_700_000_100_000n);

    // 1. Pair device
    const code = await deviceStore.createPairingCode({
      organizationId: orgA,
      storeId: storeA,
      deviceName: 'Kassa Rotatsiya',
      idGen,
      nowMs: t0,
    });
    const lookup = await deviceStore.lookupPairingCode(code.code);
    const pairResult = await deviceStore.pairDevice({
      pairingLookup: lookup!,
      deviceId,
      platform: 'windows',
      appVersion: '1.0.0',
      idGen,
      nowMs: t0,
    });

    const token1 = pairResult.deviceToken;

    // 2. Verify token 1
    const verify1 = await deviceStore.verifyDeviceToken(token1, t0);
    expect(verify1).not.toBeNull();
    expect(verify1?.deviceId).toBe(deviceId);
    expect(verify1?.status).toBe('active');

    // 3. Rotate token (t0 + 1 hour)
    const t1 = unixMsFromBigInt(1_700_000_100_000n + 3600_000n);
    const clientRequestId = idGen.nextId();
    const rotateRes = await deviceStore.rotateDeviceToken({
      currentToken: token1,
      clientRequestId,
      idGen,
      nowMs: t1,
    });
    const token2 = rotateRes.deviceToken;
    expect(token2).not.toBe(token1);

    // 4. D2: old token within 10-minute grace window is still valid for in-flight retries
    const tGrace = unixMsFromBigInt(BigInt(t1) + 5n * 60n * 1000n); // +5 minutes
    const verifyOldDuringGrace = await deviceStore.verifyDeviceToken(token1, tGrace);
    expect(verifyOldDuringGrace).not.toBeNull();
    expect(verifyOldDuringGrace?.deviceId).toBe(deviceId);

    // 5. New token is fully valid
    const verifyNew = await deviceStore.verifyDeviceToken(token2, tGrace);
    expect(verifyNew).not.toBeNull();
    expect(verifyNew?.deviceId).toBe(deviceId);

    // 6. D2: Idempotent rotate with same clientRequestId returns existing token
    const rotateRetry = await deviceStore.rotateDeviceToken({
      currentToken: token2,
      clientRequestId,
      idGen,
      nowMs: tGrace,
    });
    expect(rotateRetry.expiresAtMs).toBe(rotateRes.expiresAtMs);

    // 7. D2: Old token used AFTER grace period (t1 + 11 minutes) triggers Security Wipe!
    const tAfterGrace = unixMsFromBigInt(BigInt(t1) + 11n * 60n * 1000n);
    await expect(deviceStore.verifyDeviceToken(token1, tAfterGrace)).rejects.toThrowError(
      /DEVICE_TOKEN_REUSE/,
    );

    // 8. Device is now BLOCKED and all tokens are revoked!
    await expect(deviceStore.verifyDeviceToken(token2, tAfterGrace)).rejects.toThrowError(
      /DEVICE_REVOKED/,
    );
  });

  it('revoking device marks device as revoked and invalidates all tokens immediately', async () => {
    const deviceId = idGen.nextId();
    const t0 = unixMsFromBigInt(1_700_000_500_000n);

    const code = await deviceStore.createPairingCode({
      organizationId: orgB,
      storeId: storeB,
      deviceName: 'Kassa Revoke Test',
      idGen,
      nowMs: t0,
    });
    const lookup = await deviceStore.lookupPairingCode(code.code);
    const pairResult = await deviceStore.pairDevice({
      pairingLookup: lookup!,
      deviceId,
      platform: 'linux',
      appVersion: '1.0.0',
      idGen,
      nowMs: t0,
    });

    const token = pairResult.deviceToken;
    const verifyBefore = await deviceStore.verifyDeviceToken(token, t0);
    expect(verifyBefore).not.toBeNull();

    // Find device DB id
    const res = await adminConn.pool.query<{ id: string }>(
      'SELECT id FROM cloud_devices WHERE organization_id = $1 AND device_id = $2',
      [orgB, deviceId],
    );
    expect(res.rows.length).toBe(1);
    const row0 = res.rows[0];
    expect(row0).toBeDefined();
    const deviceDbId = parseUuidV7(row0?.id ?? '');

    // Revoke device
    await deviceStore.revokeDevice({
      organizationId: orgB,
      deviceDbId,
      nowMs: t0,
    });

    // Verification must now fail with DEVICE_REVOKED
    await expect(deviceStore.verifyDeviceToken(token, t0)).rejects.toThrowError(/DEVICE_REVOKED/);
  });
});
