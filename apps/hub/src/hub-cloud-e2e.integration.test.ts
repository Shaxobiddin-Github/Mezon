import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  CompleteSaleResponseSchema,
  LoginResponseSchema,
  ProductDetailResponseSchema,
  SyncPushRequestSchema,
  parseAndValidateSyncCursors,
} from '@mezon/contracts';
import {
  CloudEventWriter,
  CloudSyncPullStore,
  CloudSyncPushStore,
  PG_APP_ROLE_NAME,
  createCloudPgPool,
  migrateCloudDatabase,
  shouldRunPgTests,
} from '@mezon/db-cloud';
import {
  MonotonicUuidV7Generator,
  type PinHasher,
  type UuidV7,
  parseUuidV7,
  unixMsFromBigInt,
} from '@mezon/domain';
import { FixedClock, SeededRandomSource } from '@mezon/test-utils';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { provisionAppRole } from '../../../packages/db-cloud/ops/provision-app-role.mjs';
import { type HubServer, createHubServer } from './server.js';

/**
 * T2.8 final integration test: a real hub (SQLite) and a real cloud (PostgreSQL + RLS app role).
 * Each run: offline sales, a cloud outage in the middle, debt sales, a void, a return, a debt
 * payment, a cabinet price change written in the cloud and pulled by the hub, and a hub clock
 * that runs 10 minutes behind the cloud. At the end stock, customer debt and revenue must be equal
 * on both sides. 10 seeded runs (the criterion: stable 10 times).
 */
const describePg = shouldRunPgTests() ? describe : describe.skip;

const HOST = '127.0.0.1:47881';
const TOKEN = 'e2e-device-token';
const fastHasher: PinHasher = {
  hash: (pin) => Promise.resolve(`fast-stub-hash:${pin}`),
  verify: (stored, pin) => Promise.resolve(stored === `fast-stub-hash:${pin}`),
};

function prng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describePg('T2.8 hub ↔ cloud end-to-end: both sides agree on stock, debt and revenue', () => {
  let container: StartedPostgreSqlContainer;
  let admin: ReturnType<typeof createCloudPgPool>;
  let app: ReturnType<typeof createCloudPgPool>;
  let cloud: FastifyInstance;
  let cloudUrl = '';
  const cloudClock = { nowMs: 1_771_000_000_000n };
  /** The hub under test registers its ids here; the fake device auth uses them. */
  let ctx: { organizationId: UuidV7; storeId: UuidV7; deviceId: UuidV7 } | null = null;
  let online = true;
  const dirs: string[] = [];

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:18-alpine').start();
    admin = createCloudPgPool({ connectionString: container.getConnectionUri() });
    process.env.MEZON_APP_DB_PASSWORD = 'e2e-app-password-not-a-secret-1234';
    await provisionAppRole({ pool: admin.pool });
    await migrateCloudDatabase(admin.db);
    const uri = new URL(container.getConnectionUri());
    uri.username = PG_APP_ROLE_NAME;
    uri.password = process.env.MEZON_APP_DB_PASSWORD;
    app = createCloudPgPool({ connectionString: uri.toString() });
    const pushStore = new CloudSyncPushStore(app.pool);
    const pullStore = new CloudSyncPullStore(app.pool);

    cloud = Fastify({ logger: false });
    cloud.addHook('onRequest', async (req, reply) => {
      if (!online) return reply.code(503).send({ code: 'UNAVAILABLE' });
      if (req.headers.authorization !== `Bearer ${TOKEN}` || ctx === null) {
        return reply.code(401).send({ code: 'DEVICE_UNAUTHORIZED' });
      }
    });
    const device = () => ({ ...ctx!, deviceName: 'Kassa', status: 'active' as const });
    cloud.post('/api/v1/sync/push', async (req, reply) => {
      const parsed = SyncPushRequestSchema.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ code: 'VALIDATION' });
      return pushStore.processSyncPushBatch({
        context: device(),
        events: parsed.data.events,
        nowMs: unixMsFromBigInt(cloudClock.nowMs),
      });
    });
    cloud.get('/api/v1/sync/pull', async (req, reply) => {
      const q = req.query as { cursors?: string; limit?: string };
      const cursors = parseAndValidateSyncCursors(q.cursors);
      if (!cursors.success) return reply.code(400).send({ code: 'INVALID_CURSORS' });
      return pullStore.getSyncPullEvents({
        context: device(),
        cursors: cursors.cursors,
        limit: q.limit ? Number(q.limit) : 100,
      });
    });
    cloudUrl = await cloud.listen({ host: '127.0.0.1', port: 0 });
  }, 180_000);

  afterAll(async () => {
    await cloud?.close();
    await app?.pool.end();
    await admin?.pool.end();
    await container?.stop();
    for (const d of dirs) fs.rmSync(d, { recursive: true, force: true, maxRetries: 5 });
  });

  async function runScenario(seed: number) {
    const rnd = prng(seed);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mezon-e2e-'));
    dirs.push(dir);
    // The hub clock runs 10 minutes BEHIND the cloud (clock skew).
    const hubClock = new FixedClock(cloudClock.nowMs - 600_000n);
    const hub: HubServer = await createHubServer({
      dbPath: path.join(dir, 'hub.db'),
      port: 47881,
      logLevel: 'silent',
      clock: hubClock,
      random: new SeededRandomSource(seed),
      pinHasher: fastHasher,
    });
    try {
      const h = (t?: string) => (t ? { host: HOST, authorization: `Bearer ${t}` } : { host: HOST });
      const call = async (
        method: 'GET' | 'POST' | 'PUT',
        url: string,
        token?: string,
        payload?: object,
      ) => {
        const r = await hub.app.inject({
          method,
          url,
          headers: h(token),
          ...(payload ? { payload } : {}),
        });
        return r;
      };
      const setup = (
        await call('POST', '/setup', undefined, {
          owner: { fullName: 'Egasi', username: 'owner', pin: '849201' },
        })
      ).json<{ organizationId: UuidV7; storeId: UuidV7; deviceId: UuidV7 }>();
      ctx = {
        organizationId: parseUuidV7(setup.organizationId),
        storeId: parseUuidV7(setup.storeId),
        deviceId: parseUuidV7(setup.deviceId),
      };
      const org = ctx.organizationId;
      const now = String(cloudClock.nowMs);
      await admin.pool.query(
        `INSERT INTO cloud_organizations (id, organization_id, name, status, created_at_ms, updated_at_ms)
         VALUES ($1, $1, $2, 'active', $3, $3)`,
        [org, `E2E ${seed}`, now],
      );
      await admin.pool.query(
        `INSERT INTO cloud_stores (id, organization_id, name, code, is_active, created_at_ms, updated_at_ms)
         VALUES ($1, $2, 'Do''kon', $3, true, $4, $4)`,
        [ctx.storeId, org, `s${seed}`, now],
      );
      const idGen = new MonotonicUuidV7Generator({
        clock: { now: () => unixMsFromBigInt(cloudClock.nowMs) },
        random: new SeededRandomSource(seed + 1000),
      });
      await hub.cloudStore.saveCloudState({
        status: 'paired',
        cloudUrl,
        organizationId: org,
        organizationName: 'E2E',
        storeId: ctx.storeId,
        storeName: "Do'kon",
        encryptedDeviceToken: (await hub.safeStorage.encryptString(TOKEN)).toString('base64'),
        pairedAtMs: unixMsFromBigInt(hubClock.now()),
        nowMs: unixMsFromBigInt(hubClock.now()),
        idGen,
      });

      const owner = LoginResponseSchema.parse(
        (await call('POST', '/auth/login', undefined, { username: 'owner', pin: '849201' })).json(),
      ).token;
      let seq = 0;
      const rid = () =>
        `01997500-0000-7000-8000-${(seed * 100_000 + ++seq).toString(16).padStart(12, '0')}`;
      const ok = (r: Awaited<ReturnType<typeof call>>, code = 200) => {
        expect(r.statusCode, r.body).toBe(code);
        return Promise.resolve(r);
      };

      const syncAll = async () => {
        for (let i = 0; i < 50; i++) {
          const p = await hub.pushWorker.pushBatch();
          if (p.status === 'idle') break;
          if (p.status !== 'ok') throw new Error(`push ${p.status}`);
          if (p.pushed === 0) break;
        }
        for (let i = 0; i < 50; i++) {
          const p = await hub.pullWorker.pullBatch();
          if (p.status === 'idle') break;
          if (p.status !== 'ok') throw new Error(`pull ${p.status}`);
          if (p.pulled === 0) break;
        }
      };

      // Catalogue, stock, customer, shift.
      const productIds: string[] = [];
      for (const [name, price] of [
        ['Non', '5000'],
        ['Sut', '12000'],
      ] as const) {
        const p = ProductDetailResponseSchema.parse(
          (
            await ok(
              await call('POST', '/products', owner, { name, unit: 'dona', salePrice: price }),
              201,
            )
          ).json(),
        ).product.id;
        productIds.push(p);
        await ok(
          await call('POST', '/stock/moves/in', owner, {
            productId: p,
            reason: 'purchase',
            qty: '100000',
            totalCostValue: '300000',
          }),
          201,
        );
      }
      const customer = (
        await ok(
          await call('POST', '/customers', owner, {
            fullName: 'Mijoz Ali',
            creditLimit: '10000000',
          }),
          201,
        )
      ).json<{ customer: { id: string } }>().customer.id;
      await ok(
        await call('POST', '/shifts/open', owner, { clientRequestId: rid(), openingCash: '0' }),
        201,
      );
      await syncAll();

      const prices = new Map<string, bigint>([
        [productIds[0], 5000n],
        [productIds[1], 12000n],
      ]);
      const sell = async (debt: boolean) => {
        const cart = (await ok(await call('POST', '/carts', owner, {}), 201)).json<{
          cart: { id: string };
        }>().cart.id;
        let total = 0n;
        for (const p of productIds) {
          const units = 1 + Math.floor(rnd() * 3);
          await ok(
            await call('POST', `/carts/${cart}/lines`, owner, {
              kind: 'catalog',
              productId: p,
              qty: String(units * 1000),
            }),
            201,
          );
          total += prices.get(p)! * BigInt(units);
        }
        const debtAmount = debt ? total / 2n : 0n;
        const res = await ok(
          await call('POST', `/carts/${cart}/complete`, owner, {
            clientRequestId: rid(),
            expectedTotal: total.toString(),
            ...(debt ? { customerId: customer, debtAmount: debtAmount.toString() } : {}),
            payments: [{ method: 'cash', tenderedAmount: (total - debtAmount).toString() }],
          }),
        );
        return CompleteSaleResponseSchema.parse(res.json()).sale;
      };

      // 1. Online sales.
      const sales = [];
      for (let i = 0; i < 2 + Math.floor(rnd() * 3); i++) sales.push(await sell(rnd() < 0.4));
      await syncAll();

      // 2. Cloud outage: the hub keeps selling; push fails and nothing is lost.
      online = false;
      for (let i = 0; i < 2 + Math.floor(rnd() * 3); i++) sales.push(await sell(rnd() < 0.5));
      const debtSale = await sell(true);
      const failed = await hub.pushWorker.pushBatch();
      expect(failed.status).not.toBe('ok');
      // Void one cash sale and return part of another while offline.
      const victim = sales.find((s) => s.debtAmount === '0')!;
      await ok(
        await call('POST', `/sales/${victim.id}/void`, owner, {
          clientRequestId: rid(),
          reason: 'Xato chek',
        }),
      );
      const retFrom = sales.find((s) => s.id !== victim.id && s.debtAmount === '0') ?? null;
      if (retFrom !== null) {
        const line = retFrom.lines[0];
        await ok(
          await call('POST', `/sales/${retFrom.id}/returns`, owner, {
            clientRequestId: rid(),
            reason: 'Qaytarildi',
            items: [{ saleLineId: line.id, qty: '1000' }],
            payments: [{ method: 'cash', amount: line.unitPriceSnapshot }],
          }),
          201,
        );
      }
      // The customer pays part of the debt while the cloud is down.
      await ok(
        await call('POST', `/customers/${customer}/payments`, owner, {
          clientRequestId: rid(),
          method: 'cash',
          amount: (BigInt(debtSale.debtAmount) / 2n).toString(),
        }),
        201,
      );
      online = true;
      hubClock.advance(60_000n);
      cloudClock.nowMs += 60_000n;
      await syncAll();

      // 3. Cabinet price change written in the cloud, pulled by the hub, then used by a sale.
      const created = hub.connection.sqlite
        .prepare(
          "SELECT payload FROM local_outbox WHERE entity = 'products' AND entity_id = ? ORDER BY device_seq DESC LIMIT 1",
        )
        .get(productIds[0]) as { payload: string };
      const newPrice = 5500n + BigInt(Math.floor(rnd() * 10) * 100);
      const payload = JSON.parse(created.payload) as Record<string, unknown>;
      const writer = new CloudEventWriter(app.pool, new CloudSyncPushStore(app.pool), idGen);
      const w = await writer.write({
        organizationId: org,
        nowMs: unixMsFromBigInt(cloudClock.nowMs),
        commands: [
          {
            entity: 'products',
            entityId: parseUuidV7(productIds[0]),
            type: 'products.updated',
            payload: {
              ...payload,
              salePrice: newPrice.toString(),
              updatedAtMs: String(cloudClock.nowMs),
            },
          },
        ],
      });
      expect(w.results.map((r) => r.status)).toEqual(['accepted']);
      await syncAll();
      const hubPrice = hub.connection.sqlite
        .prepare('SELECT sale_price FROM products WHERE id = ?')
        .get(productIds[0]) as { sale_price: bigint };
      // The hub clock is 10 min behind, yet the cabinet change wins (HLC receive rule).
      expect(hubPrice.sale_price).toBe(newPrice);
      prices.set(productIds[0], newPrice);
      sales.push(await sell(false));
      await syncAll();

      // 4. Both sides agree.
      const outboxLeft = hub.connection.sqlite
        .prepare("SELECT count(*) AS n FROM local_outbox WHERE status <> 'acked'")
        .get() as { n: bigint };
      expect(outboxLeft.n).toBe(0n);
      const parked = await admin.pool.query<{ n: number }>(
        'SELECT count(*)::int AS n FROM cloud_sync_parked WHERE organization_id = $1',
        [org],
      );
      expect(parked.rows[0]?.n).toBe(0);

      const q = async (sql: string) =>
        (await admin.pool.query<{ k: string; v: string }>(sql, [org])).rows
          .map((r) => `${r.k}=${r.v}`)
          .sort();
      const l = (sql: string) =>
        (hub.connection.sqlite.prepare(sql).all(org) as { k: string; v: bigint }[])
          .map((r) => `${r.k}=${String(r.v)}`)
          .sort();
      const stockSql = `SELECT product_id AS k, SUM(qty_delta) AS v FROM stock_moves WHERE organization_id = $ GROUP BY product_id`;
      const debtSql = `SELECT customer_id AS k, SUM(amount_delta) AS v FROM customer_ledger WHERE organization_id = $ GROUP BY customer_id`;
      const revenueSql = `SELECT 'revenue' AS k, COALESCE(SUM(total_final), 0) AS v FROM sales WHERE organization_id = $ AND voided_at_ms IS NULL`;
      const refundSql = `SELECT 'refunds' AS k, COALESCE(SUM(total_refund), 0) AS v FROM returns WHERE organization_id = $`;
      for (const sql of [stockSql, debtSql, revenueSql, refundSql]) {
        expect(await q(sql.replace('$', '$1')), sql).toEqual(l(sql.replace('$', '?')));
      }
      // Hub projections equal the event sums (and so the cloud).
      const hubStock = l(
        'SELECT product_id AS k, qty_on_hand AS v FROM local_stock_balances WHERE organization_id = ?',
      );
      expect(hubStock).toEqual(await q(stockSql.replace('$', '$1')));
      const hubDebt = l(
        'SELECT customer_id AS k, balance AS v FROM local_customer_balances WHERE organization_id = ?',
      );
      expect(hubDebt).toEqual(await q(debtSql.replace('$', '$1')));
      expect(BigInt(hubDebt[0].split('=')[1])).toBeGreaterThan(0n);
    } finally {
      ctx = null;
      online = true;
      await hub.close();
    }
  }

  it.each(Array.from({ length: 10 }, (_, i) => 2801 + i))('run %i', async (seed) => {
    await runScenario(seed);
  });
});
