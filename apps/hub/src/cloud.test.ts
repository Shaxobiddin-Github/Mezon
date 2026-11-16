import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { type CloudPairDeviceResponseDto, type HubCloudStatusDto } from '@mezon/contracts';
import { localSchemaRegistry } from '@mezon/db-local';
import { unixMsFromBigInt } from '@mezon/domain';
import { FixedClock } from '@mezon/test-utils';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHubServer, type HubServer } from './server.js';

const TEST_PORT = 47892;
const HOST_HEADER = `127.0.0.1:${TEST_PORT}`;

function hostHeaders(): Record<string, string> {
  return { host: HOST_HEADER };
}

function authHeaders(token: string): Record<string, string> {
  return {
    host: HOST_HEADER,
    authorization: `Bearer ${token}`,
  };
}

describe('@mezon/hub - Cloud Pairing, SafeStorage Encryption & Boundary Security (D3, D4, D5)', () => {
  let tmpDir: string;
  let dbPath: string;
  let server: HubServer;
  let clock: FixedClock;

  const testOrgId = '018bcfe5-6800-7000-8000-000000000001';
  const testStoreId = '018bcfe5-6800-7000-8000-000000000002';
  const rawSecret = 'super_secret_device_token_raw_payload_xyz123';
  const testDeviceToken = `${testOrgId}.018bcfe5-6800-7000-8000-000000000003.${rawSecret}`;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mezon-hub-cloud-test-'));
    dbPath = path.join(tmpDir, 'hub.db');
    clock = new FixedClock(unixMsFromBigInt(1_700_000_000_000n));
  });

  afterEach(async () => {
    if (server) {
      await server.close();
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  async function initHub(mockFetch?: typeof fetch): Promise<{ readonly ownerToken: string }> {
    server = await createHubServer({
      dbPath,
      host: '127.0.0.1',
      port: TEST_PORT,
      clock,
      cloudFetchFn: mockFetch,
    });

    // 1. Run /setup to initialize Hub and owner
    const setupRes = await server.app.inject({
      method: 'POST',
      url: '/setup',
      headers: hostHeaders(),
      payload: {
        owner: {
          fullName: 'Admin User',
          username: 'admin',
          pin: '849201',
        },
      },
    });
    expect(setupRes.statusCode).toBe(201);

    // 2. Login as owner
    const loginRes = await server.app.inject({
      method: 'POST',
      url: '/auth/login',
      headers: hostHeaders(),
      payload: {
        username: 'admin',
        pin: '849201',
      },
    });
    expect(loginRes.statusCode).toBe(200);
    const ownerToken = loginRes.json<{ token: string }>().token;
    return { ownerToken };
  }

  it('D5: GET /cloud/status returns unpaired on fresh hub (no /api/v1 prefix)', async () => {
    await initHub();

    const res = await server.app.inject({
      method: 'GET',
      url: '/cloud/status',
      headers: hostHeaders(),
    });

    expect(res.statusCode).toBe(200);
    const status = res.json<HubCloudStatusDto>();
    expect(status.status).toBe('unpaired');
    expect(status.cloudUrl).toBeNull();
    expect(status.organizationId).toBeNull();
    expect(status.storeId).toBeNull();
  });

  it('D4: pairs with cloud, encrypts deviceToken via safeStorage, and stores zero plaintext in SQLite bytes', async () => {
    let capturedBody: Record<string, unknown> | undefined;
    const mockFetch = ((_url: string | URL | Request, init?: RequestInit) => {
      capturedBody = JSON.parse(init?.body as string) as Record<string, unknown>;
      const pairResponse: CloudPairDeviceResponseDto = {
        deviceToken: testDeviceToken,
        organizationId: testOrgId,
        storeId: testStoreId,
        storeName: 'Kattaqo‘rg‘on Do‘kon',
        organizationName: 'Guzar Kattaqo‘rg‘on Savdo',
      };
      return Promise.resolve(
        new Response(JSON.stringify(pairResponse), {
          status: 201,
          headers: { 'Content-Type': 'application/json' },
        }),
      );
    }) as typeof fetch;

    const { ownerToken } = await initHub(mockFetch);

    // 1. POST /cloud/pair
    const pairRes = await server.app.inject({
      method: 'POST',
      url: '/cloud/pair',
      headers: authHeaders(ownerToken),
      payload: {
        cloudUrl: 'https://cloud.guzar.uz',
        code: '23456789',
      },
    });

    expect(pairRes.statusCode).toBe(200);
    const pairData = pairRes.json<{
      success: boolean;
      status: string;
      organizationName: string;
      storeName: string;
    }>();
    expect(pairData.success).toBe(true);
    expect(pairData.status).toBe('paired');
    expect(pairData.storeName).toBe('Kattaqo‘rg‘on Do‘kon');

    // Verify captured outgoing payload sent to cloud (D3: zero credentials/PIN leaked)
    expect(capturedBody?.['code']).toBe('23456789');
    expect(capturedBody?.['deviceId']).toBeDefined();
    expect(capturedBody?.['platform']).toBeDefined();
    expect(capturedBody?.['pin']).toBeUndefined();
    expect(capturedBody?.['pinHash']).toBeUndefined();

    // 2. GET /cloud/status reflects paired state
    const statusRes = await server.app.inject({
      method: 'GET',
      url: '/cloud/status',
      headers: hostHeaders(),
    });
    expect(statusRes.statusCode).toBe(200);
    const statusData = statusRes.json<HubCloudStatusDto>();
    expect(statusData.status).toBe('paired');
    expect(statusData.cloudUrl).toBe('https://cloud.guzar.uz');
    expect(statusData.organizationId).toBe(testOrgId);
    expect(statusData.storeId).toBe(testStoreId);
    expect(statusData.pairedAtMs).toBe(1_700_000_000_000);

    // 3. D4: Inspect SQLite database file on disk! Plaintext token must NEVER appear in bytes!
    server.connection.sqlite.pragma('wal_checkpoint(TRUNCATE)');
    const dbBytes = fs.readFileSync(dbPath);
    const dbText = dbBytes.toString('binary');

    expect(dbText).not.toContain(rawSecret);
    expect(dbText).not.toContain(testDeviceToken);

    // 4. Verify that internal decrypted token matches original
    const decryptedToken = await server.cloudService.getDecryptedToken();
    expect(decryptedToken).toBe(testDeviceToken);
  });

  it('D3: verifies table classes and non-sync isolation', async () => {
    await initHub();

    // local_cloud_state is LOCAL
    const cloudMeta = localSchemaRegistry.all().find((t) => t.tableName === 'local_cloud_state');
    expect(cloudMeta?.tableClass).toBe('LOCAL');

    // local_pin_credentials is LOCAL
    const pinMeta = localSchemaRegistry.all().find((t) => t.tableName === 'local_pin_credentials');
    expect(pinMeta?.tableClass).toBe('LOCAL');

    // users is ATTR (synced)
    const userMeta = localSchemaRegistry.all().find((t) => t.tableName === 'users');
    expect(userMeta?.tableClass).toBe('ATTR');
  });

  it('unpairs hub and clears credentials cleanly', async () => {
    const mockFetch = (() => {
      const pairResponse: CloudPairDeviceResponseDto = {
        deviceToken: testDeviceToken,
        organizationId: testOrgId,
        storeId: testStoreId,
        storeName: 'Do‘kon',
        organizationName: 'Org',
      };
      return Promise.resolve(new Response(JSON.stringify(pairResponse), { status: 201 }));
    }) as typeof fetch;

    const { ownerToken } = await initHub(mockFetch);

    // Pair
    await server.app.inject({
      method: 'POST',
      url: '/cloud/pair',
      headers: authHeaders(ownerToken),
      payload: { cloudUrl: 'https://cloud.guzar.uz', code: '23456789' },
    });

    expect((await server.cloudService.getStatus()).status).toBe('paired');

    // Unpair
    const unpairRes = await server.app.inject({
      method: 'POST',
      url: '/cloud/unpair',
      headers: authHeaders(ownerToken),
    });
    expect(unpairRes.statusCode).toBe(200);

    // Status is now unpaired
    const status = await server.cloudService.getStatus();
    expect(status.status).toBe('unpaired');
    expect(status.organizationId).toBeNull();
    expect(await server.cloudService.getDecryptedToken()).toBeNull();
  });

  it('handles network error, 404, 409, and 429 errors from cloud API cleanly', async () => {
    // 1. Network failure -> 502 NETWORK_ERROR
    const failingFetch = (() => {
      return Promise.reject(new Error('Connection refused to cloud'));
    }) as typeof fetch;

    let currentFetchFn: typeof fetch = failingFetch;
    const { ownerToken } = await initHub((url, init) => currentFetchFn(url, init));

    const netRes = await server.app.inject({
      method: 'POST',
      url: '/cloud/pair',
      headers: authHeaders(ownerToken),
      payload: { cloudUrl: 'https://unreachable.cloud', code: '23456789' },
    });
    expect(netRes.statusCode).toBe(502);

    // 2. 404 Not Found -> 404 PAIRING_CODE_NOT_FOUND
    const notFoundFetch = (() => {
      return Promise.resolve(
        new Response(
          JSON.stringify({ code: 'PAIRING_CODE_NOT_FOUND', message: 'Kodi topilmadi' }),
          {
            status: 404,
          },
        ),
      );
    }) as typeof fetch;

    currentFetchFn = notFoundFetch;
    const nfRes = await server.app.inject({
      method: 'POST',
      url: '/cloud/pair',
      headers: authHeaders(ownerToken),
      payload: { cloudUrl: 'https://cloud.guzar.uz', code: '23456789' },
    });
    expect(nfRes.statusCode).toBe(404);

    // 3. 409 Conflict -> 409 PAIRING_ALREADY_USED
    const conflictFetch = (() => {
      return Promise.resolve(
        new Response(JSON.stringify({ code: 'PAIRING_ALREADY_USED', message: 'Ishlatilgan' }), {
          status: 409,
        }),
      );
    }) as typeof fetch;

    currentFetchFn = conflictFetch;
    const conflictRes = await server.app.inject({
      method: 'POST',
      url: '/cloud/pair',
      headers: authHeaders(ownerToken),
      payload: { cloudUrl: 'https://cloud.guzar.uz', code: '23456789' },
    });
    expect(conflictRes.statusCode).toBe(409);

    // 4. 429 Rate limited -> 429 RATE_LIMITED
    const rateLimitedFetch = (() => {
      return Promise.resolve(
        new Response(JSON.stringify({ code: 'RATE_LIMITED' }), { status: 429 }),
      );
    }) as typeof fetch;

    currentFetchFn = rateLimitedFetch;
    const rlRes = await server.app.inject({
      method: 'POST',
      url: '/cloud/pair',
      headers: authHeaders(ownerToken),
      payload: { cloudUrl: 'https://cloud.guzar.uz', code: '23456789' },
    });
    expect(rlRes.statusCode).toBe(429);
  });
});
