import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LoginResponseSchema, ProductDetailResponseSchema } from '@mezon/contracts';
import {
  type LocalSqliteConnection,
  ensureDeviceStateRowSync,
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
import { afterAll, describe, expect, it } from 'vitest';
import { type HubServer, createHubServer } from './index.js';
import { HubSyncPullService } from './sync-pull-service.js';

/**
 * T2.6 perf (the Y4 base of T2.4: 50k products, 100k customer-ledger rows, plus 100k stock moves):
 * one pull batch carrying a stock move and a ledger entry must apply in < 50 ms (p95 of 20), because
 * it runs inside the hub's write transaction and a sale waits for it. Before T2.6 the same batch
 * rebuilt every projection: 1.23 s.
 */
const PRODUCTS = 50_000;
const CUSTOMERS = 5_000;
const LEDGER_ROWS = 100_000;
const STOCK_MOVES = 100_000;
const BATCHES = 20;
const T0 = 1_766_000_000_000n;
const HOST = '127.0.0.1:47872';
const fastHasher: PinHasher = {
  hash: (pin) => Promise.resolve(`fast-stub-hash:${pin}`),
  verify: (stored, pin) => Promise.resolve(stored === `fast-stub-hash:${pin}`),
};
const hdr = (t?: string): Record<string, string> =>
  t ? { host: HOST, authorization: `Bearer ${t}` } : { host: HOST };

const tempDirs: string[] = [];
afterAll(() => {
  for (const d of tempDirs.splice(0)) {
    fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

function cloneRows(
  conn: LocalSqliteConnection,
  table: string,
  templateId: string,
  n: number,
  nextId: () => string,
  mutate: (row: Record<string, unknown>, i: number) => void,
): void {
  const row = conn.sqlite.prepare(`SELECT * FROM "${table}" WHERE id = ?`).get(templateId) as
    Record<string, unknown> | undefined;
  if (!row) throw new Error(`template row missing in ${table}`);
  const cols = Object.keys(row);
  const stmt = conn.sqlite.prepare(
    `INSERT INTO "${table}" (${cols.map((c) => `"${c}"`).join(', ')}) VALUES (${cols
      .map(() => '?')
      .join(', ')})`,
  );
  conn.sqlite.transaction(() => {
    for (let i = 0; i < n; i += 1) {
      const r = { ...row, id: nextId() };
      mutate(r, i);
      stmt.run(...cols.map((c) => r[c]));
    }
  })();
}

function p95(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil(s.length * 0.95) - 1)];
}

describe('T2.6 perf: one pull batch on the 50k / 100k base', () => {
  it(`stock move + ledger entry batch applies in < 50 ms (p95 of ${BATCHES})`, async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mezon-t26-perf-'));
    tempDirs.push(dir);
    const srcPath = path.join(dir, 'source.db');
    const clock = new FixedClock(T0);
    let hub: HubServer = await createHubServer({
      dbPath: srcPath,
      port: 47872,
      logLevel: 'silent',
      clock,
      random: new SeededRandomSource(26),
      pinHasher: fastHasher,
    });
    const inject = (method: 'POST', url: string, token: string, payload: unknown) =>
      hub.app.inject({
        method,
        url,
        headers: hdr(token),
        payload: payload as Record<string, string>,
      });
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
    const product = ProductDetailResponseSchema.parse(
      (
        await inject('POST', '/products', owner, { name: 'Olma', unit: 'dona', salePrice: '10000' })
      ).json(),
    ).product.id;
    const customer = (
      await inject('POST', '/customers', owner, { fullName: 'Ali', creditLimit: '100000000' })
    ).json<{ customer: { id: string } }>().customer.id;
    let n = 0;
    const req = () => `01990000-0000-7000-8000-${(++n).toString(16).padStart(12, '0')}`;
    const stockIn = () =>
      inject('POST', '/stock/moves/in', owner, {
        productId: product,
        reason: 'purchase',
        qty: '1000',
        totalCostValue: '5000',
      });
    const adjust = () =>
      inject('POST', `/customers/${customer}/adjustments`, owner, {
        clientRequestId: req(),
        amountDelta: '1000',
        reason: 'Tuzatish',
      });
    expect((await stockIn()).statusCode).toBe(201);
    expect((await adjust()).statusCode).toBe(201);
    const ctx = hub.connection.sqlite
      .prepare('SELECT organization_id AS o, store_id AS s FROM stock_moves LIMIT 1')
      .get() as { o: string; s: string };
    const baseSeq = (
      hub.connection.sqlite.prepare('SELECT max(device_seq) AS m FROM local_outbox').get() as {
        m: bigint;
      }
    ).m;
    await hub.close();

    // The target: a copy of the source as it is now, grown to the Y4 volume.
    const dstPath = path.join(dir, 'target.db');
    fs.copyFileSync(srcPath, dstPath);
    const conn = openLocalSqliteDatabase(dstPath);
    try {
      const gen = new MonotonicUuidV7Generator({
        clock: { now: () => unixMsFromBigInt(T0) },
        random: new SeededRandomSource(27),
      });
      const nextId = () => gen.nextId();
      const tmpl = (table: string) =>
        (conn.sqlite.prepare(`SELECT id FROM "${table}" LIMIT 1`).get() as { id: string }).id;
      const productIds: string[] = [];
      cloneRows(conn, 'products', product, PRODUCTS, nextId, (r, i) => {
        r.name = `Mahsulot ${i}`;
        r.name_search = `mahsulot ${i}`;
        productIds.push(String(r.id));
      });
      const customerIds: string[] = [];
      cloneRows(conn, 'customers', customer, CUSTOMERS, nextId, (r, i) => {
        r.full_name = `Mijoz ${i}`;
        r.name_search = `mijoz ${i}`;
        customerIds.push(String(r.id));
      });
      cloneRows(conn, 'customer_ledger', tmpl('customer_ledger'), LEDGER_ROWS, nextId, (r, i) => {
        // The touched customer carries a realistic 200-entry history; the rest spread evenly.
        r.customer_id = i < 200 ? customer : customerIds[i % CUSTOMERS];
        r.source_id = r.id;
        r.client_request_id = null;
        r.request_hash = null;
      });
      cloneRows(conn, 'stock_moves', tmpl('stock_moves'), STOCK_MOVES, nextId, (r, i) => {
        r.product_id = i < 200 ? product : productIds[i % PRODUCTS];
      });
      conn.sqlite.exec('ANALYZE');
      const targetDevice = parseUuidV7('01990000-0000-7000-8000-0000000d0e99');
      ensureDeviceStateRowSync(conn.sqlite, conn.db, {
        rowId: parseUuidV7('01990000-0000-7000-8000-0000000d0e98'),
        organizationId: parseUuidV7(ctx.o),
        deviceId: targetDevice,
        initialHlcStr: `${T0.toString().padStart(15, '0')}:00000:${targetDevice}`,
        initialUuidMs: T0,
        nowMs: T0,
      });

      // BATCHES more (stock move, ledger entry) pairs on the source → the pull stream.
      hub = await createHubServer({
        dbPath: srcPath,
        port: 47872,
        logLevel: 'silent',
        clock,
        random: new SeededRandomSource(28),
        pinHasher: fastHasher,
      });
      const owner2 = LoginResponseSchema.parse(
        (
          await hub.app.inject({
            method: 'POST',
            url: '/auth/login',
            headers: hdr(),
            payload: { username: 'owner', pin: '849201' },
          })
        ).json(),
      ).token;
      for (let i = 0; i < BATCHES; i += 1) {
        clock.advance(1_000n);
        expect(
          (
            await hub.app.inject({
              method: 'POST',
              url: '/stock/moves/in',
              headers: hdr(owner2),
              payload: {
                productId: product,
                reason: 'purchase',
                qty: '1000',
                totalCostValue: '5000',
              },
            })
          ).statusCode,
        ).toBe(201);
        expect(
          (
            await hub.app.inject({
              method: 'POST',
              url: `/customers/${customer}/adjustments`,
              headers: hdr(owner2),
              payload: { clientRequestId: req(), amountDelta: '1000', reason: 'Tuzatish' },
            })
          ).statusCode,
        ).toBe(201);
      }
      const rows = hub.connection.sqlite
        .prepare('SELECT * FROM local_outbox WHERE device_seq > ? ORDER BY device_seq')
        .all(baseSeq) as Record<string, unknown>[];
      await hub.close();
      const events: SyncedEventDto[] = rows.map((x, i) => ({
        eventId: parseUuidV7(String(x.id)),
        organizationId: parseUuidV7(ctx.o),
        storeId: parseUuidV7(ctx.s),
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
      const perBatch = Math.ceil(events.length / BATCHES);
      expect(events.some((e) => e.entity === 'stock_moves')).toBe(true);
      expect(events.some((e) => e.entity === 'customer_ledger')).toBe(true);

      const pull = new HubSyncPullService(conn, gen);
      const times: number[] = [];
      for (let b = 0; b < BATCHES; b += 1) {
        const batch = events.slice(b * perBatch, (b + 1) * perBatch);
        const t = performance.now();
        const res = pull.applySyncPullBatch({
          context: {
            organizationId: parseUuidV7(ctx.o),
            storeId: parseUuidV7(ctx.s),
            deviceId: targetDevice,
          },
          events: batch,
          nextCursors: { [ctx.s]: BigInt(b + 1) },
          nowMs: unixMsFromBigInt(T0 + 100_000n + BigInt(b)),
        });
        times.push(performance.now() - t);
        expect(res.appliedCount).toBe(batch.length);
      }
      const touchedBalance = conn.sqlite
        .prepare('SELECT balance FROM local_customer_balances WHERE customer_id = ?')
        .get(customer) as { balance: bigint } | undefined;
      expect(touchedBalance, 'the touched customer was projected').toBeDefined();
      console.info(
        `[T2.6 perf] ${String(PRODUCTS)} products, ${String(LEDGER_ROWS)} ledger, ${String(STOCK_MOVES)} moves: ` +
          `batch p95 ${p95(times).toFixed(1)} ms, max ${Math.max(...times).toFixed(1)} ms`,
      );
      expect(p95(times)).toBeLessThan(50);
    } finally {
      conn.close();
    }
  });
});
