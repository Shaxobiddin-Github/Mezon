import { generateKeyPairSync, sign } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  CloudAuthStore,
  CloudTenantStore,
  PG_APP_ROLE_NAME,
  createCloudPgPool,
  migrateCloudDatabase,
  shouldRunPgTests,
  withPgTenantContext,
} from '@mezon/db-cloud';
import { type UnixMs, unixMsFromBigInt } from '@mezon/domain';
import {
  type LicencePayload,
  PLAN_CATALOG,
  type TrustedLicenceKey,
  buildLicenceSigningMessage,
  licencePayloadToWire,
} from '@mezon/licensing';
import { DeterministicUuidV7Generator } from '@mezon/test-utils';
import * as argon2 from '@node-rs/argon2';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { provisionAppRole } from '../../../packages/db-cloud/ops/provision-app-role.mjs';
import { runLicenceCommand } from './cli/licence.js';
import { loadCloudConfig } from './config.js';
import { CloudJwtService } from './jwt.js';
import { buildCloudServer } from './server.js';

const describePg = shouldRunPgTests() ? describe : describe.skip;
const DAY = 86_400_000n;
const T0 = 1_731_902_400_000n; // 2024-11-18 04:00 UTC

const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const PUB = (publicKey.export({ type: 'spki', format: 'der' }) as Buffer)
  .subarray(-32)
  .toString('base64');
const KEYS: TrustedLicenceKey[] = [
  { keyId: 'test-licence', publicKeyB64: PUB, validFromMs: 0n, validUntilMs: null },
];

function signed(p: LicencePayload, keyId = 'test-licence') {
  const signature = sign(
    null,
    Buffer.from(buildLicenceSigningMessage(keyId, p), 'utf8'),
    privateKey,
  ).toString('base64');
  return { payload: licencePayloadToWire(p), keyId, signature };
}

describePg('@mezon/cloud - T4.7 licences, plan limits and invoices', () => {
  let container: StartedPostgreSqlContainer;
  let adminConn: ReturnType<typeof createCloudPgPool>;
  let appConn: ReturnType<typeof createCloudPgPool>;
  let server: FastifyInstance;
  let nowMs: UnixMs = unixMsFromBigInt(T0);
  const idGen = new DeterministicUuidV7Generator();
  const org = idGen.nextId();
  const otherOrg = idGen.nextId();
  const store = idGen.nextId();
  const password = 'Licence2026!';
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mezon-licence-'));
  const runCli = (cmd: string, args: Record<string, string>) =>
    runLicenceCommand(cmd, args, {
      pool: appConn.pool,
      trustedKeys: KEYS,
      nowMs,
      log: () => undefined,
    });

  const ownerToken = async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { login: 'lic_owner@guzar.uz', password },
    });
    return (JSON.parse(res.payload) as { accessToken: string }).accessToken;
  };
  const createStore = async (code: string) =>
    server.inject({
      method: 'POST',
      url: '/api/v1/stores',
      headers: { authorization: `Bearer ${await ownerToken()}` },
      payload: { name: `Do'kon ${code}`, code },
    });
  const pairingCode = async () =>
    server.inject({
      method: 'POST',
      url: '/api/v1/devices/pairing-codes',
      headers: { authorization: `Bearer ${await ownerToken()}` },
      payload: { storeId: store, name: 'Kassa' },
    });
  const status = async () => {
    const login = await server.inject({
      method: 'POST',
      url: '/api/v1/admin/auth/login',
      payload: { login: 'lic_owner@guzar.uz', password },
    });
    const token = (JSON.parse(login.payload) as { accessToken: string }).accessToken;
    const res = await server.inject({
      method: 'GET',
      url: '/api/v1/admin/licence',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    return JSON.parse(res.payload) as {
      state: string;
      plan: string | null;
      limits: { maxStores: number | null; maxDevices: number | null };
      invalidLicence: boolean;
      usage: { stores: number; devices: number };
      invoices: { period: string; amountTiyin: string; status: string }[];
    };
  };
  const addActiveDevice = async () => {
    await withPgTenantContext(adminConn.pool, org, async (_tx, c) => {
      await c.query(
        `INSERT INTO cloud_devices (id, organization_id, store_id, device_id, name, platform, app_version, status, last_seen_at_ms, created_at_ms, updated_at_ms)
         VALUES ($1, $2, $3, $4, 'K', 'windows', '1.0.0', 'active', $5, $5, $5)`,
        [idGen.nextId(), org, store, idGen.nextId(), String(nowMs)],
      );
    });
  };

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:18-alpine').start();
    adminConn = createCloudPgPool({ connectionString: container.getConnectionUri() });
    const appPw = 'test-licence-app-password-1234567';
    process.env.MEZON_APP_DB_PASSWORD = appPw;
    await provisionAppRole({ pool: adminConn.pool });
    await migrateCloudDatabase(adminConn.db);
    const appUri = new URL(container.getConnectionUri());
    appUri.username = PG_APP_ROLE_NAME;
    appUri.password = appPw;
    appConn = createCloudPgPool({ connectionString: appUri.toString() });
    const hash = await argon2.hash(password);
    const tenants = new CloudTenantStore(adminConn.pool);
    for (const [o, s, login] of [
      [org, store, 'lic_owner'],
      [otherOrg, idGen.nextId(), 'lic_other'],
    ] as const) {
      await tenants.createOrganizationWithStoreAndOwner({
        organizationId: o,
        storeId: s,
        ownerUserId: idGen.nextId(),
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
    server = await buildCloudServer({
      config: loadCloudConfig({
        NODE_ENV: 'test',
        PORT: '3000',
        HOST: '127.0.0.1',
        DATABASE_URL: appUri.toString(),
        JWT_SECRET: 'licence-test-jwt-secret-at-least-32-chars',
        CORS_ORIGINS: 'http://localhost:5173',
      }),
      conn: appConn,
      jwtService: new CloudJwtService('licence-test-jwt-secret-at-least-32-chars'),
      authStore: new CloudAuthStore(appConn.pool),
      clock: { nowMs: () => nowMs },
      trustedLicenceKeys: KEYS,
    });
  }, 120_000);

  afterAll(async () => {
    await server?.close();
    await appConn?.pool.end();
    await adminConn?.pool.end();
    await container?.stop();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('trial: Business limits; the 4th store is refused with 402', async () => {
    const s = await status();
    expect(s.state).toBe('trial');
    expect(s.limits).toEqual(PLAN_CATALOG.business.limits);
    expect(s.usage.stores).toBe(1);
    expect((await createStore('s2')).statusCode).toBe(201);
    expect((await createStore('s3')).statusCode).toBe(201);
    const fourth = await createStore('s4');
    expect(fourth.statusCode).toBe(402);
    expect(JSON.parse(fourth.payload)).toMatchObject({
      code: 'PLAN_LIMIT_REACHED',
      kind: 'stores',
      limit: 3,
    });
  });

  it('trial over without a licence: growth frozen, reading still works', async () => {
    nowMs = unixMsFromBigInt(T0 + 15n * DAY);
    const s = await status();
    expect(s.state).toBe('expired');
    expect((await createStore('late')).statusCode).toBe(402);
    expect((await pairingCode()).statusCode).toBe(402);
    expect(
      (
        await server.inject({
          method: 'GET',
          url: '/api/v1/stores',
          headers: { authorization: `Bearer ${await ownerToken()}` },
        })
      ).statusCode,
    ).toBe(200);
  });

  it('a signed Start licence imported by the CLI becomes active with its own limits', async () => {
    const env = signed({
      licenceId: idGen.nextId(),
      organizationId: org,
      plan: 'start',
      limits: PLAN_CATALOG.start.limits,
      issuedAtMs: T0,
      validFromMs: T0 + 15n * DAY,
      validUntilMs: T0 + 45n * DAY,
    });
    const file = path.join(tmp, 'start.json');
    fs.writeFileSync(file, JSON.stringify(env));
    await runCli('import', { file });
    await runCli('import', { file }); // idempotent
    const s = await status();
    expect(s.state).toBe('active');
    expect(s.plan).toBe('start');
    expect(s.limits).toEqual({ maxStores: 1, maxDevices: 2 });
    // Already 3 stores > 1: no new store, but nothing existing is touched.
    expect((await createStore('s5')).statusCode).toBe(402);
    // Devices: 0 of 2 -> codes allowed until 2 active devices exist.
    const early = await pairingCode();
    expect(early.statusCode).toBe(201);
    const earlyCode = (JSON.parse(early.payload) as { code: string }).code;
    await addActiveDevice();
    await addActiveDevice();
    // A code issued before the limit was reached is refused at pairing time (authoritative check).
    const pair = await server.inject({
      method: 'POST',
      url: '/api/v1/devices/pair',
      payload: {
        code: earlyCode,
        deviceId: idGen.nextId(),
        platform: 'windows',
        appVersion: '1.0.0',
      },
    });
    expect(pair.statusCode).toBe(402);
    expect(JSON.parse(pair.payload)).toMatchObject({ code: 'PLAN_LIMIT_REACHED', kind: 'devices' });
    const third = await pairingCode();
    expect(third.statusCode).toBe(402);
    expect(JSON.parse(third.payload)).toMatchObject({ kind: 'devices', limit: 2 });
  });

  it('the CLI refuses a tampered or untrusted licence; a tampered row in the DB is ignored', async () => {
    const env = signed({
      licenceId: idGen.nextId(),
      organizationId: org,
      plan: 'start',
      limits: PLAN_CATALOG.start.limits,
      issuedAtMs: T0,
      validFromMs: T0,
      validUntilMs: T0 + 400n * DAY,
    });
    const tampered = {
      ...env,
      payload: { ...env.payload, plan: 'pro', limits: { maxStores: null, maxDevices: null } },
    };
    const file = path.join(tmp, 'tampered.json');
    fs.writeFileSync(file, JSON.stringify(tampered));
    await expect(runCli('import', { file })).rejects.toThrow(/signature/i);

    // Someone with DB access writes it directly: the status re-verifies and ignores it.
    await withPgTenantContext(adminConn.pool, org, async (_tx, c) => {
      await c.query(
        `INSERT INTO cloud_licences (id, organization_id, created_at_ms, updated_at_ms, licence_id, plan, envelope_json, valid_from_ms, valid_until_ms)
         VALUES ($1, $2, $3, $3, $4, 'pro', $5, $6, $7)`,
        [
          idGen.nextId(),
          org,
          String(nowMs),
          env.payload.licenceId,
          JSON.stringify(tampered),
          String(T0),
          String(T0 + 400n * DAY),
        ],
      );
    });
    const s = await status();
    expect(s.plan).toBe('start');
    expect(s.invalidLicence).toBe(true);
  });

  it("another organization's licence does not apply to this one", async () => {
    const forOther = signed({
      licenceId: idGen.nextId(),
      organizationId: otherOrg,
      plan: 'pro',
      limits: PLAN_CATALOG.pro.limits,
      issuedAtMs: T0,
      validFromMs: T0,
      validUntilMs: T0 + 400n * DAY,
    });
    await withPgTenantContext(adminConn.pool, org, async (_tx, c) => {
      await c.query(
        `INSERT INTO cloud_licences (id, organization_id, created_at_ms, updated_at_ms, licence_id, plan, envelope_json, valid_from_ms, valid_until_ms)
         VALUES ($1, $2, $3, $3, $4, 'pro', $5, $6, $7)`,
        [
          idGen.nextId(),
          org,
          String(nowMs),
          forOther.payload.licenceId,
          JSON.stringify(forOther),
          String(T0),
          String(T0 + 400n * DAY),
        ],
      );
    });
    expect((await status()).plan).toBe('start');
  });

  it('invoice: issued once at the plan price, then marked paid', async () => {
    await runCli('invoice', { org, period: '2024-12' });
    await runCli('invoice', { org, period: '2024-12' });
    let s = await status();
    expect(s.invoices).toEqual([
      expect.objectContaining({ period: '2024-12', amountTiyin: '12400000', status: 'issued' }),
    ]);
    await runCli('paid', { org, period: '2024-12' });
    s = await status();
    expect(s.invoices[0]?.status).toBe('paid');
  });

  it('grace for 7 days after the licence ends, then expired', async () => {
    nowMs = unixMsFromBigInt(T0 + 46n * DAY);
    expect((await status()).state).toBe('grace');
    expect((await pairingCode()).statusCode).toBe(402); // still at the Start device limit
    nowMs = unixMsFromBigInt(T0 + 53n * DAY);
    expect((await status()).state).toBe('expired');
    await expect(runCli('invoice', { org, period: '2025-01' })).rejects.toThrow(/No billable/);
  });

  it('the device licence endpoint requires a device token', async () => {
    const res = await server.inject({ method: 'GET', url: '/api/v1/devices/licence' });
    expect(res.statusCode).toBe(401);
  });
});
