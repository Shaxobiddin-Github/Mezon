import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LoginResponseSchema, ProductDetailResponseSchema } from '@mezon/contracts';
import {
  type LocalSqliteConnection,
  ensureDeviceStateRowSync,
  executeCustomerBalancesRebuildSync,
  executeStockProjectionsRebuildSync,
  executeSupplierBalancesRebuildSync,
  migrateLocalDatabase,
  openLocalSqliteDatabase,
} from '@mezon/db-local';
import {
  MonotonicUuidV7Generator,
  type PinHasher,
  type UuidV7,
  parseUuidV7,
  unixMsFromBigInt,
} from '@mezon/domain';
import { type SyncedEventDto } from '@mezon/sync';
import { FixedClock, SeededRandomSource } from '@mezon/test-utils';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type HubServer, createHubServer } from './index.js';
import { HubSyncPullService } from './sync-pull-service.js';

/**
 * T2.6 differential proof (Mezon: "partial result = full result").
 *
 * A SOURCE hub performs random real business operations through its HTTP API (sales, debt sales,
 * returns, voids, stock in, receivings with unknown cost + later confirmation, customer and
 * supplier payments, adjustments, new customers). Its outbox becomes a pull stream that a TARGET
 * hub applies in random batches — with some parents delayed (so children park and retry) and with
 * ledger events of another store interleaved. After EVERY batch the target's incrementally
 * maintained projections must equal a from-scratch rebuild (run inside a SAVEPOINT and rolled
 * back), on every projection table, ignoring only surrogate/bookkeeping columns
 * (`id`, `created_at_ms`, `updated_at_ms`).
 */

const SEEDS = Number(process.env.MEZON_DIFF_SEEDS ?? 200);
const TEST_PORT = 47871;
const HOST = `127.0.0.1:${TEST_PORT}`;
const T0 = 1_765_000_000_000n;
const PRICE = 10_000n; // tiyin per unit
const OWNER_PIN = '849201';

const fastHasher: PinHasher = {
  hash: (pin) => Promise.resolve(`fast-stub-hash:${pin}`),
  verify: (stored, pin) => Promise.resolve(stored === `fast-stub-hash:${pin}`),
};
const hdr = (t?: string): Record<string, string> =>
  t ? { host: HOST, authorization: `Bearer ${t}` } : { host: HOST };

/** mulberry32: deterministic, so every failing seed is reproducible. */
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

const PROJECTION_TABLES = [
  'local_stock_balances',
  'local_batch_balances',
  'local_stock_conflicts',
  'local_customer_balances',
  'local_supplier_balances',
] as const;
const IGNORED_COLUMNS = new Set(['id', 'created_at_ms', 'updated_at_ms']);

type Snapshot = Record<(typeof PROJECTION_TABLES)[number], string[]>;

function snapshot(conn: LocalSqliteConnection): Snapshot {
  const out = {} as Snapshot;
  for (const table of PROJECTION_TABLES) {
    const rows = conn.sqlite.prepare(`SELECT * FROM "${table}"`).all() as Record<string, unknown>[];
    out[table] = rows
      .map((r) =>
        JSON.stringify(
          Object.keys(r)
            .filter((k) => !IGNORED_COLUMNS.has(k))
            .sort()
            .map((k) => [k, typeof r[k] === 'bigint' ? `${String(r[k])}n` : r[k]]),
        ),
      )
      .sort();
  }
  return out;
}

interface Scope {
  readonly organizationId: UuidV7;
  readonly storeId: UuidV7;
}

/** From-scratch rebuild inside a SAVEPOINT; returns its snapshot and rolls everything back. */
function fullRebuildSnapshot(conn: LocalSqliteConnection, scope: Scope, nowMs: bigint): Snapshot {
  let i = 0;
  const now = unixMsFromBigInt(nowMs);
  conn.sqlite.exec('SAVEPOINT diff_full');
  try {
    executeStockProjectionsRebuildSync(conn.sqlite, conn.db, {
      organizationId: scope.organizationId,
      storeId: scope.storeId,
      nextId: () => parseUuidV7(`01990000-0000-7000-8000-${(++i).toString(16).padStart(12, '0')}`),
      nowUnixMs: () => now,
    });
    executeCustomerBalancesRebuildSync(conn.sqlite, conn.db, scope.organizationId, now);
    executeSupplierBalancesRebuildSync(conn.sqlite, conn.db, scope.organizationId, now);
    return snapshot(conn);
  } finally {
    conn.sqlite.exec('ROLLBACK TO diff_full');
    conn.sqlite.exec('RELEASE diff_full');
  }
}

const tempDirs: string[] = [];
let templateDb = '';
let ids: {
  owner: string;
  products: { avg: string; batch: string; unknown: string };
  customers: string[];
  supplier: string;
};

async function inject(
  hub: HubServer,
  method: 'POST' | 'GET' | 'PATCH',
  url: string,
  token: string,
  payload?: unknown,
) {
  return hub.app.inject({
    method,
    url,
    headers: hdr(token),
    ...(payload ? { payload: payload as Record<string, unknown> } : {}),
  });
}

async function login(hub: HubServer): Promise<string> {
  return LoginResponseSchema.parse(
    (
      await hub.app.inject({
        method: 'POST',
        url: '/auth/login',
        headers: hdr(),
        payload: { username: 'owner', pin: OWNER_PIN },
      })
    ).json(),
  ).token;
}

beforeAll(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mezon-diff-template-'));
  tempDirs.push(dir);
  templateDb = path.join(dir, 'template.db');
  const hub = await createHubServer({
    dbPath: templateDb,
    port: TEST_PORT,
    logLevel: 'silent',
    clock: new FixedClock(T0),
    random: new SeededRandomSource(1),
    pinHasher: fastHasher,
  });
  try {
    await hub.app.inject({
      method: 'POST',
      url: '/setup',
      headers: hdr(),
      payload: { owner: { fullName: 'Egasi', username: 'owner', pin: OWNER_PIN } },
    });
    const owner = await login(hub);
    const product = async (name: string, extra: Record<string, unknown>) => {
      const r = await inject(hub, 'POST', '/products', owner, {
        name,
        unit: 'dona',
        salePrice: PRICE.toString(),
        ...extra,
      });
      expect(r.statusCode, r.body).toBe(201);
      return ProductDetailResponseSchema.parse(r.json()).product.id;
    };
    const avg = await product('Olma', {});
    const batch = await product('Sut', { trackBatches: true });
    const unknown = await product('Non', {});
    const customers: string[] = [];
    for (const fullName of ['Ali', 'Vali']) {
      const r = await inject(hub, 'POST', '/customers', owner, {
        fullName,
        creditLimit: '100000000',
        defaultDueDays: 7,
      });
      expect(r.statusCode, r.body).toBe(201);
      customers.push(r.json<{ customer: { id: string } }>().customer.id);
    }
    const sup = await inject(hub, 'POST', '/suppliers', owner, { name: 'Ta’minotchi' });
    expect(sup.statusCode, sup.body).toBe(201);
    const shift = await inject(hub, 'POST', '/shifts/open', owner, {
      clientRequestId: '01990000-0000-7000-8000-00000000aa01',
      openingCash: '100000000',
    });
    expect(shift.statusCode, shift.body).toBe(201);
    ids = {
      owner: 'owner',
      products: { avg, batch, unknown },
      customers,
      supplier: sup.json<{ supplier: { id: string } }>().supplier.id,
    };
  } finally {
    await hub.close();
  }
});

afterAll(() => {
  for (const d of tempDirs.splice(0)) {
    fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

interface Generated {
  readonly events: SyncedEventDto[];
  readonly scope: Scope;
  readonly ok: Record<string, number>;
  readonly endMs: bigint;
}

/** Runs random real operations on a copy of the template hub and returns its outbox stream. */
async function generate(seed: number, rnd: () => number): Promise<Generated> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mezon-diff-src-'));
  tempDirs.push(dir);
  const dbPath = path.join(dir, 'source.db');
  fs.copyFileSync(templateDb, dbPath);
  const clock = new FixedClock(T0 + 60_000n);
  const hub = await createHubServer({
    dbPath,
    port: TEST_PORT,
    logLevel: 'silent',
    clock,
    random: new SeededRandomSource(seed),
    pinHasher: fastHasher,
  });
  const ok: Record<string, number> = {};
  let reqN = 0;
  const reqId = () =>
    `01990000-0000-7000-8000-${(seed * 100_000 + ++reqN).toString(16).padStart(12, '0')}`;
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)];
  const qty = () => BigInt(1 + Math.floor(rnd() * 3)) * 1000n;
  try {
    const owner = await login(hub);
    const customers = [...ids.customers];
    const sales: { id: string; lineId: string }[] = [];
    const unknownLines: { receivingId: string; lineId: string }[] = [];
    let batchNo = 0;
    const done = (op: string, status: number) => {
      if (status >= 200 && status < 300) ok[op] = (ok[op] ?? 0) + 1;
    };
    const ops = 20 + Math.floor(rnd() * 40);
    for (let k = 0; k < ops; k += 1) {
      clock.advance(BigInt(1 + Math.floor(rnd() * 5_000)));
      const r = rnd();
      if (r < 0.28) {
        // Sale (cash, or debt on a customer).
        const pid = pick([ids.products.avg, ids.products.batch, ids.products.unknown]);
        const q = qty();
        const cart = await inject(hub, 'POST', '/carts', owner, {});
        const cartId = cart.json<{ cart: { id: string } }>().cart.id;
        await inject(hub, 'POST', `/carts/${cartId}/lines`, owner, {
          kind: 'catalog',
          productId: pid,
          variantId: null,
          qty: q.toString(),
        });
        const total = (q / 1000n) * PRICE;
        const debt = rnd() < 0.4;
        const res = await inject(
          hub,
          'POST',
          `/carts/${cartId}/complete`,
          owner,
          debt
            ? {
                clientRequestId: reqId(),
                expectedTotal: total.toString(),
                customerId: pick(customers),
                debtAmount: total.toString(),
                payments: [],
              }
            : {
                clientRequestId: reqId(),
                expectedTotal: total.toString(),
                payments: [{ method: 'cash', tenderedAmount: total.toString() }],
              },
        );
        done(debt ? 'debtSale' : 'sale', res.statusCode);
        if (res.statusCode === 200) {
          const sale = res.json<{ sale: { id: string; lines: { id: string }[] } }>().sale;
          sales.push({ id: sale.id, lineId: sale.lines[0].id });
        }
      } else if (r < 0.36 && sales.length > 0) {
        const s = sales.splice(Math.floor(rnd() * sales.length), 1)[0];
        const res = await inject(hub, 'POST', `/sales/${s.id}/returns`, owner, {
          clientRequestId: reqId(),
          reason: 'Qaytarish',
          items: [{ saleLineId: s.lineId, qty: '1000' }],
          payments: [{ method: 'cash', amount: PRICE.toString() }],
        });
        done('return', res.statusCode);
      } else if (r < 0.42 && sales.length > 0) {
        const s = sales.splice(Math.floor(rnd() * sales.length), 1)[0];
        const res = await inject(hub, 'POST', `/sales/${s.id}/void`, owner, {
          clientRequestId: reqId(),
          reason: 'Xato',
        });
        done('void', res.statusCode);
      } else if (r < 0.54) {
        const batch = rnd() < 0.5;
        const q = qty() * 3n;
        const res = await inject(hub, 'POST', '/stock/moves/in', owner, {
          productId: batch ? ids.products.batch : ids.products.avg,
          reason: 'purchase',
          qty: q.toString(),
          totalCostValue: ((q / 1000n) * BigInt(4_000 + Math.floor(rnd() * 4_000))).toString(),
          ...(batch ? { batchNumber: `L-${seed}-${++batchNo}` } : {}),
        });
        done('stockIn', res.statusCode);
      } else if (r < 0.62) {
        const draft = await inject(hub, 'POST', '/receiving-drafts', owner, {
          supplierId: ids.supplier,
          supplierInvoiceNo: `INV-${seed}-${k}`,
          lines: [
            {
              productId: ids.products.unknown,
              qty: qty().toString(),
              costUnknown: true,
              totalCostValue: null,
            },
            {
              productId: ids.products.avg,
              qty: qty().toString(),
              costUnknown: false,
              totalCostValue: '25000',
            },
          ],
        });
        if (draft.statusCode === 201) {
          const draftId = draft.json<{ draft: { id: string } }>().draft.id;
          const post = await inject(hub, 'POST', `/receiving-drafts/${draftId}/post`, owner, {
            clientRequestId: reqId(),
          });
          done('receiving', post.statusCode);
          if (post.statusCode === 201) {
            const rec = post.json<{
              receiving: { id: string; lines: { id: string; costUnknown: boolean }[] };
            }>().receiving;
            for (const l of rec.lines) {
              if (l.costUnknown) unknownLines.push({ receivingId: rec.id, lineId: l.id });
            }
          }
        }
      } else if (r < 0.68 && unknownLines.length > 0) {
        const l = unknownLines.splice(Math.floor(rnd() * unknownLines.length), 1)[0];
        const res = await inject(
          hub,
          'POST',
          `/receivings/${l.receivingId}/lines/${l.lineId}/confirm-cost`,
          owner,
          { clientRequestId: reqId(), confirmedTotalCost: '30000', reason: 'Nakladnoy' },
        );
        done('confirmCost', res.statusCode);
      } else if (r < 0.76) {
        const res = await inject(hub, 'POST', `/customers/${pick(customers)}/payments`, owner, {
          clientRequestId: reqId(),
          method: 'cash',
          amount: (PRICE / 2n).toString(),
        });
        done('customerPayment', res.statusCode);
      } else if (r < 0.82) {
        const res = await inject(hub, 'POST', `/suppliers/${ids.supplier}/payments`, owner, {
          clientRequestId: reqId(),
          method: 'card',
          amount: '5000',
        });
        done('supplierPayment', res.statusCode);
      } else if (r < 0.9) {
        const res = await inject(hub, 'POST', `/customers/${pick(customers)}/adjustments`, owner, {
          clientRequestId: reqId(),
          amountDelta: (rnd() < 0.5 ? '' : '-') + '3000',
          reason: 'Tuzatish',
        });
        done('adjustment', res.statusCode);
      } else {
        const res = await inject(hub, 'POST', '/customers', owner, {
          fullName: `Mijoz ${seed}-${k}`,
          creditLimit: '100000000',
        });
        done('newCustomer', res.statusCode);
        if (res.statusCode === 201)
          customers.push(res.json<{ customer: { id: string } }>().customer.id);
      }
    }
    const rows = hub.connection.sqlite
      .prepare('SELECT * FROM local_outbox ORDER BY device_seq ASC')
      .all() as Record<string, unknown>[];
    const storeId = parseUuidV7(String(rows.find((x) => x.store_id !== null)!.store_id));
    const organizationId = parseUuidV7(String(rows[0].organization_id));
    const events: SyncedEventDto[] = rows.map((x, i) => ({
      eventId: parseUuidV7(String(x.id)),
      organizationId,
      storeId,
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
    return {
      events,
      scope: { organizationId, storeId },
      ok,
      endMs: clock.now() as unknown as bigint,
    };
  } finally {
    await hub.close();
  }
}

/**
 * Stream perturbations a real pull can produce:
 * - ledger entries of ANOTHER store of the organization (customer_ledger is pulled org-wide);
 * - a parent row delayed past its children (they park, then retry when it arrives).
 */
function perturb(gen: Generated, rnd: () => number, seed: number): SyncedEventDto[] {
  const otherStore = parseUuidV7('01990000-0000-7000-8000-0000000057e2');
  const otherDevice = parseUuidV7('01990000-0000-7000-8000-0000000d0e22');
  const idGen = new MonotonicUuidV7Generator({
    clock: { now: () => unixMsFromBigInt(T0 + BigInt(seed)) },
    random: new SeededRandomSource(seed + 77),
  });
  const out: SyncedEventDto[] = [];
  for (const e of gen.events) {
    out.push(e);
    if (e.entity === 'customer_ledger' && e.payload.entryType === 'adjustment' && rnd() < 0.7) {
      const id = idGen.nextId();
      out.push({
        ...e,
        eventId: idGen.nextId(),
        entityId: id,
        storeId: otherStore,
        deviceId: otherDevice,
        payload: { ...e.payload, id, sourceId: id, clientRequestId: null, requestHash: null },
      });
    }
  }
  // Delay a few parents (customers / batches / products created during the run).
  for (let n = Math.floor(rnd() * 3); n > 0; n -= 1) {
    const parents = out
      .map((e, i) => [e, i] as const)
      .filter(([e]) => ['customers', 'batches'].includes(e.entity) && e.type.endsWith('created'));
    if (parents.length === 0) break;
    const [, from] = parents[Math.floor(rnd() * parents.length)];
    const [ev] = out.splice(from, 1);
    const to = Math.min(out.length, from + 1 + Math.floor(rnd() * 12));
    out.splice(to, 0, ev);
  }
  return out;
}

describe('T2.6 differential: incremental projections equal a full rebuild after every pull batch', () => {
  const totals: Record<string, number> = {};
  let batchesChecked = 0;
  let parkedSeen = 0;
  let nonEmptyFinal = 0;

  it.each(Array.from({ length: SEEDS }, (_, i) => 9001 + i))('seed %i', async (seed) => {
    const rnd = prng(seed);
    const gen = await generate(seed, rnd);
    for (const [k, v] of Object.entries(gen.ok)) totals[k] = (totals[k] ?? 0) + v;
    const stream = perturb(gen, rnd, seed);

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mezon-diff-dst-'));
    tempDirs.push(dir);
    const conn = openLocalSqliteDatabase(path.join(dir, 'target.db'));
    try {
      migrateLocalDatabase(conn.db);
      const targetDevice = parseUuidV7('01990000-0000-7000-8000-0000000d0e99');
      ensureDeviceStateRowSync(conn.sqlite, conn.db, {
        rowId: parseUuidV7('01990000-0000-7000-8000-0000000d0e98'),
        organizationId: gen.scope.organizationId,
        deviceId: targetDevice,
        initialHlcStr: `${T0.toString().padStart(15, '0')}:00000:${targetDevice}`,
        initialUuidMs: T0,
        nowMs: T0,
      });
      const idGen = new MonotonicUuidV7Generator({
        clock: { now: () => unixMsFromBigInt(T0 + 1n) },
        random: new SeededRandomSource(seed + 5),
      });
      const pull = new HubSyncPullService(conn, idGen);
      let nowMs = gen.endMs + 1_000n;
      for (let at = 0; at < stream.length;) {
        const size = 1 + Math.floor(rnd() * 15);
        const batch = stream.slice(at, at + size);
        at += size;
        nowMs += 1_000n;
        pull.applySyncPullBatch({
          context: { ...gen.scope, deviceId: targetDevice },
          events: batch,
          nextCursors: {},
          nowMs: unixMsFromBigInt(nowMs),
        });
        parkedSeen += Number(
          (
            conn.sqlite.prepare('SELECT count(*) AS n FROM local_sync_parked').get() as {
              n: bigint;
            }
          ).n,
        );
        const partial = snapshot(conn);
        const full = fullRebuildSnapshot(conn, gen.scope, nowMs);
        expect(partial, `seed ${seed}, after event ${at}`).toEqual(full);
        batchesChecked += 1;
      }
      const final = snapshot(conn);
      if (final.local_stock_balances.length > 0 && final.local_customer_balances.length > 0) {
        nonEmptyFinal += 1;
      }
    } finally {
      conn.close();
    }
  });

  it('the generator really exercised every operation and the data is not empty', () => {
    // Guards against a vacuous proof (empty projections compared with empty projections).
    for (const op of [
      'sale',
      'debtSale',
      'return',
      'void',
      'stockIn',
      'receiving',
      'confirmCost',
      'customerPayment',
      'supplierPayment',
      'adjustment',
      'newCustomer',
    ]) {
      expect(totals[op] ?? 0, op).toBeGreaterThan(0);
    }
    expect(batchesChecked).toBeGreaterThan(SEEDS);
    expect(nonEmptyFinal).toBe(SEEDS);
    expect(parkedSeen).toBeGreaterThan(0);
    console.info('[T2.6 diff]', { seeds: SEEDS, batchesChecked, parkedSeen, totals });
  });
});
