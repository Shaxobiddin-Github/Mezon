import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LoginResponseSchema, ProductDetailResponseSchema } from '@mezon/contracts';
import {
  type LocalSqliteConnection,
  SqliteCloudStore,
  ensureDeviceStateRowSync,
  localSchemaRegistry,
  migrateLocalDatabase,
  openLocalSqliteDatabase,
} from '@mezon/db-local';
import {
  MonotonicUuidV7Generator,
  type PinHasher,
  parseUuidV7,
  unixMsFromBigInt,
} from '@mezon/domain';
import { type SyncedEventDto } from '@mezon/sync';
import { FixedClock, SeededRandomSource } from '@mezon/test-utils';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHubServer } from './index.js';
import type { SafeStoragePort } from './safe-storage-port.js';
import { HubSyncBootstrap } from './sync-bootstrap.js';
import { HubSyncPullService } from './sync-pull-service.js';
import { HubSyncPullWorker } from './sync-pull-worker.js';

/**
 * T2.5 proof: a load interrupted at page N and resumed after a restart ends EXACTLY like an
 * uninterrupted load — every synced table row, every projection, every cursor.
 */
const T0 = 1_768_000_000_000n;
const HOST = '127.0.0.1:47875';
const fastHasher: PinHasher = {
  hash: (pin) => Promise.resolve(`fast-stub-hash:${pin}`),
  verify: (stored, pin) => Promise.resolve(stored === `fast-stub-hash:${pin}`),
};
const safeStorage: SafeStoragePort = {
  isAvailable: () => true,
  encryptString: (s) => Promise.resolve(Buffer.from(`enc:${s}`)),
  decryptString: (b) => Promise.resolve(b.toString('utf8').replace(/^enc:/, '')),
};
const hdr = (t?: string): Record<string, string> =>
  t ? { host: HOST, authorization: `Bearer ${t}` } : { host: HOST };
const tempDirs: string[] = [];
let stream: SyncedEventDto[] = [];
let scope: { organizationId: string; storeId: string };

function prng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

beforeAll(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mezon-boot-src-'));
  tempDirs.push(dir);
  const clock = new FixedClock(T0);
  const hub = await createHubServer({
    dbPath: path.join(dir, 'src.db'),
    port: 47875,
    logLevel: 'silent',
    clock,
    random: new SeededRandomSource(25),
    pinHasher: fastHasher,
  });
  try {
    await hub.app.inject({
      method: 'POST',
      url: '/setup',
      headers: hdr(),
      payload: { owner: { fullName: 'Egasi', username: 'owner', pin: '849201' } },
    });
    const owner = LoginResponseSchema.parse(
      (
        await hub.app.inject({
          method: 'POST',
          url: '/auth/login',
          headers: hdr(),
          payload: { username: 'owner', pin: '849201' },
        })
      ).json(),
    ).token;
    let n = 0;
    const req = () => `01996000-0000-7000-8000-${(++n).toString(16).padStart(12, '0')}`;
    const post = (url: string, payload: Record<string, unknown>) =>
      hub.app.inject({ method: 'POST', url, headers: hdr(owner), payload });
    await post('/shifts/open', { clientRequestId: req(), openingCash: '0' });
    const products: string[] = [];
    for (let i = 0; i < 6; i += 1) {
      products.push(
        ProductDetailResponseSchema.parse(
          (
            await post('/products', {
              name: `Mahsulot ${i}`,
              unit: 'dona',
              salePrice: '10000',
              ...(i % 2 === 0 ? { trackBatches: true } : {}),
            })
          ).json(),
        ).product.id,
      );
    }
    const customer = (
      await post('/customers', { fullName: 'Ali', creditLimit: '100000000' })
    ).json<{
      customer: { id: string };
    }>().customer.id;
    for (const [i, p] of products.entries()) {
      await post('/stock/moves/in', {
        productId: p,
        reason: 'purchase',
        qty: '9000',
        totalCostValue: '45000',
        ...(i % 2 === 0 ? { batchNumber: `B-${i}` } : {}),
      });
    }
    for (let i = 0; i < 12; i += 1) {
      clock.advance(1_000n);
      const cartId = (await post('/carts', {})).json<{ cart: { id: string } }>().cart.id;
      await post(`/carts/${cartId}/lines`, {
        kind: 'catalog',
        productId: products[i % products.length],
        qty: '1000',
      });
      const debt = i % 3 === 0;
      const sale = await post(
        `/carts/${cartId}/complete`,
        debt
          ? {
              clientRequestId: req(),
              expectedTotal: '10000',
              customerId: customer,
              debtAmount: '10000',
              payments: [],
            }
          : {
              clientRequestId: req(),
              expectedTotal: '10000',
              payments: [{ method: 'cash', tenderedAmount: '10000' }],
            },
      );
      expect(sale.statusCode, sale.body).toBe(200);
    }
    await post(`/customers/${customer}/payments`, {
      clientRequestId: req(),
      method: 'cash',
      amount: '5000',
    });

    const rows = hub.connection.sqlite
      .prepare('SELECT * FROM local_outbox ORDER BY device_seq ASC')
      .all() as Record<string, unknown>[];
    scope = {
      organizationId: String(rows[0].organization_id),
      storeId: String(rows.find((r) => r.store_id !== null)!.store_id),
    };
    stream = rows.map((x, i) => ({
      eventId: parseUuidV7(String(x.id)),
      organizationId: parseUuidV7(scope.organizationId),
      storeId: parseUuidV7(scope.storeId),
      deviceId: parseUuidV7(String(x.device_id)),
      deviceSeq: String(x.device_seq),
      hlc: String(x.hlc),
      type: String(x.type),
      entity: String(x.entity),
      entityId: parseUuidV7(String(x.entity_id)),
      entityClass: String(x.class) as SyncedEventDto['entityClass'],
      schemaVersion: Number(x.schema_version),
      payload: JSON.parse(String(x.payload)) as Record<string, unknown>,
      position: String(i + 1),
      hlcAdjusted: false,
      receivedAtMs: Number(T0),
    }));
  } finally {
    await hub.close();
  }
});

afterAll(() => {
  for (const d of tempDirs.splice(0)) {
    fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

/** A fake cloud pull endpoint with the real cursor semantics (position > cursor, ordered, paged). */
function fakeCloud(opts: { failAtCall?: number }) {
  let calls = 0;
  const fetchFn: typeof fetch = (input) => {
    calls += 1;
    if (opts.failAtCall !== undefined && calls === opts.failAtCall) {
      return Promise.reject(new Error('network down'));
    }
    const url = new URL(input);
    const limit = Number(url.searchParams.get('limit') ?? '100');
    const cursors: Record<string, bigint> = {};
    for (const pair of (url.searchParams.get('cursors') ?? '').split(',').filter(Boolean)) {
      const [s, p] = pair.split(':');
      cursors[s] = BigInt(p);
    }
    const remaining = stream.filter((e) => BigInt(e.position) > (cursors[e.storeId] ?? 0n));
    const page = remaining.slice(0, limit);
    const nextCursors: Record<string, string> = {};
    for (const [s, p] of Object.entries(cursors)) nextCursors[s] = p.toString();
    for (const e of page) nextCursors[e.storeId] = e.position;
    return Promise.resolve(
      new Response(
        JSON.stringify({ events: page, nextCursors, hasMore: remaining.length > limit }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
  };
  return { fetchFn, calls: () => calls };
}

async function openTarget(dbPath: string, fresh: boolean, fetchFn: typeof fetch, pageSize: number) {
  const conn = openLocalSqliteDatabase(dbPath);
  const deviceId = parseUuidV7('01996000-0000-7000-8000-0000000d0e99');
  if (fresh) {
    migrateLocalDatabase(conn.db);
    ensureDeviceStateRowSync(conn.sqlite, conn.db, {
      rowId: parseUuidV7('01996000-0000-7000-8000-0000000d0e98'),
      organizationId: parseUuidV7(scope.organizationId),
      deviceId,
      initialHlcStr: `${T0.toString().padStart(15, '0')}:00000:${deviceId}`,
      initialUuidMs: T0,
      nowMs: T0,
    });
  }
  const idGen = new MonotonicUuidV7Generator({
    clock: { now: () => unixMsFromBigInt(T0 + 1n) },
    random: new SeededRandomSource(9),
  });
  const cloudStore = new SqliteCloudStore(conn);
  if (fresh) {
    await cloudStore.saveCloudState({
      status: 'paired',
      cloudUrl: 'https://cloud.test',
      organizationId: parseUuidV7(scope.organizationId),
      organizationName: 'Org',
      storeId: parseUuidV7(scope.storeId),
      storeName: 'Store',
      encryptedDeviceToken: Buffer.from('enc:tok').toString('base64'),
      pairedAtMs: unixMsFromBigInt(T0),
      nowMs: unixMsFromBigInt(T0),
      idGen,
    });
  }
  const clock = { now: () => unixMsFromBigInt(T0 + 100_000n) };
  const worker = new HubSyncPullWorker({
    pullService: new HubSyncPullService(conn, idGen),
    cloudStore,
    safeStorage,
    getDeviceId: () => deviceId,
    clock,
    idGen,
    fetchFn,
    pageSize,
    minBackoffMs: 0,
    maxBackoffMs: 0,
  });
  return {
    conn,
    bootstrap: new HubSyncBootstrap({ connection: conn, pullWorker: worker, nowMs: clock.now }),
  };
}

const PROJECTIONS = new Set([
  'local_stock_balances',
  'local_batch_balances',
  'local_stock_conflicts',
  'local_customer_balances',
  'local_supplier_balances',
]);

/** Every synced table in full, projections without surrogate columns, and the cursors. */
function fingerprint(conn: LocalSqliteConnection): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  const tables = [
    ...localSchemaRegistry
      .all()
      .filter((m) => m.tableClass !== 'LOCAL')
      .map((m) => m.tableName),
    ...PROJECTIONS,
    'local_sync_cursors',
  ];
  for (const t of tables) {
    const drop =
      PROJECTIONS.has(t) || t === 'local_sync_cursors'
        ? ['id', 'created_at_ms', 'updated_at_ms']
        : [];
    out[t] = (conn.sqlite.prepare(`SELECT * FROM "${t}"`).all() as Record<string, unknown>[])
      .map((r) =>
        JSON.stringify(
          Object.keys(r)
            .filter((k) => !drop.includes(k))
            .sort()
            .map((k) => [k, typeof r[k] === 'bigint' ? String(r[k]) : r[k]]),
        ),
      )
      .sort();
  }
  return out;
}

describe('T2.5 bootstrap: interrupted + resumed = uninterrupted', () => {
  it.each(Array.from({ length: 20 }, (_, i) => 2501 + i))('seed %i', async (seed) => {
    const rnd = prng(seed);
    const pageSize = 3 + Math.floor(rnd() * 12);
    const pages = Math.ceil(stream.length / pageSize);
    const failAt = 1 + Math.floor(rnd() * pages);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mezon-boot-dst-'));
    tempDirs.push(dir);

    const ref = await openTarget(path.join(dir, 'ref.db'), true, fakeCloud({}).fetchFn, pageSize);
    const refRun = await ref.bootstrap.run();
    expect(refRun).toMatchObject({ state: 'done', stoppedBecause: 'caught_up' });
    // Absolute completeness (not only cut == ref): every streamed entity is here, nothing parked
    // or in conflict, and the cursor stands on the last position.
    for (const e of stream) {
      const row = ref.conn.sqlite
        .prepare(`SELECT 1 FROM "${e.entity}" WHERE id = ?`)
        .get(e.entityId);
      expect(row, `${e.entity} ${e.entityId}`).toBeDefined();
    }
    const one = (q: string) => (ref.conn.sqlite.prepare(q).get() as { n: number | bigint }).n;
    expect(Number(one('SELECT count(*) AS n FROM local_sync_parked'))).toBe(0);
    expect(Number(one('SELECT count(*) AS n FROM local_sync_conflicts'))).toBe(0);
    expect(Number(one('SELECT max(last_position) AS n FROM local_sync_cursors'))).toBe(
      stream.length,
    );
    const want = fingerprint(ref.conn);
    ref.conn.close();
    expect(want.sales.length, 'the stream really carries sales').toBeGreaterThan(0);

    const cutPath = path.join(dir, 'cut.db');
    const first = await openTarget(
      cutPath,
      true,
      fakeCloud({ failAtCall: failAt }).fetchFn,
      pageSize,
    );
    const cut = await first.bootstrap.run();
    // Nothing applied yet (failed on the first page) keeps the state at 'none'.
    const cutState = failAt === 1 ? 'none' : 'in_progress';
    expect(cut).toMatchObject({ state: cutState, stoppedBecause: 'cloud_unavailable' });
    expect(cut.pagesApplied).toBe(failAt - 1);
    first.conn.close(); // the process dies here

    const again = await openTarget(cutPath, false, fakeCloud({}).fetchFn, pageSize);
    expect(again.bootstrap.status().state).toBe(cutState);
    const resumed = await again.bootstrap.run();
    expect(resumed).toMatchObject({ state: 'done', stoppedBecause: 'caught_up' });
    expect(fingerprint(again.conn)).toEqual(want);
    again.conn.close();
  });
});
