import type { LightMyRequestResponse } from 'fastify';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LoginResponseSchema, ProductDetailResponseSchema } from '@mezon/contracts';
import { GS, type PinHasher } from '@mezon/domain';
import { FakeMarkingDriver } from '@mezon/drivers';
import { FixedClock, SeededRandomSource } from '@mezon/test-utils';
import { afterEach, describe, expect, it } from 'vitest';
import { type HubServer, createHubServer } from './index.js';

const HOST = '127.0.0.1:47877';
const fastHasher: PinHasher = {
  hash: (pin) => Promise.resolve(`fast-stub-hash:${pin}`),
  verify: (stored, pin) => Promise.resolve(stored === `fast-stub-hash:${pin}`),
};
const hdr = (t: string): Record<string, string> => ({ host: HOST, authorization: `Bearer ${t}` });
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true, maxRetries: 5 });
});

const EAN = '4006381333931';
const GTIN = `0${EAN}`;
const MARKED_MXIK = '02202001001000001';
const PLAIN_MXIK = '10101001001000001';
const code = (serial: string) => `]d201${GTIN}21${serial}${GS}91EE10${GS}92tail${serial}`;

interface Env {
  hub: HubServer;
  owner: string;
  driver: FakeMarkingDriver;
  marked: string;
  n: () => string;
  call: (
    method: 'POST' | 'GET' | 'DELETE' | 'PATCH',
    url: string,
    payload?: Record<string, unknown>,
  ) => Promise<LightMyRequestResponse>;
  count: (sql: string, ...args: unknown[]) => number;
}

async function boot(seed: number, driver = new FakeMarkingDriver()): Promise<Env> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mezon-marking-'));
  dirs.push(dir);
  const hub = await createHubServer({
    dbPath: path.join(dir, 'hub.db'),
    port: 47877,
    logLevel: 'error',
    clock: new FixedClock(1_770_000_000_000n),
    random: new SeededRandomSource(seed),
    pinHasher: fastHasher,
    markingDriver: driver,
  });
  await hub.app.inject({
    method: 'POST',
    url: '/setup',
    headers: { host: HOST },
    payload: { owner: { fullName: 'Egasi', username: 'owner', pin: '849201' } },
  });
  const owner = LoginResponseSchema.parse(
    (
      await hub.app.inject({
        method: 'POST',
        url: '/auth/login',
        headers: { host: HOST },
        payload: { username: 'owner', pin: '849201' },
      })
    ).json(),
  ).token;
  let i = 0;
  const n = () => `01997200-0000-7000-8000-${(seed * 1000 + ++i).toString(16).padStart(12, '0')}`;
  const call: Env['call'] = (method, url, payload) =>
    hub.app.inject({ method, url, headers: hdr(owner), ...(payload ? { payload } : {}) });
  // [TASDIQLANSIN] list: MXIK prefix 022 needs marking.
  hub.connection.sqlite
    .prepare('UPDATE local_hub_config SET marking_mxik_prefixes_json = \'["022"]\'')
    .run();
  const marked = ProductDetailResponseSchema.parse(
    (
      await call('POST', '/products', {
        name: 'Sigaret',
        unit: 'dona',
        salePrice: '10000',
        mxik: MARKED_MXIK,
        barcodes: [{ barcode: EAN }],
      })
    ).json(),
  ).product.id;
  await call('POST', '/stock/moves/in', {
    productId: marked,
    reason: 'purchase',
    qty: '50000',
    totalCostValue: '250000',
  });
  await call('POST', '/shifts/open', { clientRequestId: n(), openingCash: '0' });
  const count = (sql: string, ...args: unknown[]) =>
    Number((hub.connection.sqlite.prepare(sql).get(...args) as { n: bigint }).n);
  return { hub, owner, driver, marked, n, call, count };
}

async function newCart(env: Env) {
  return (await env.call('POST', '/carts', {})).json<{ cart: { id: string } }>().cart.id;
}
const scan = (env: Env, cartId: string, c: string) =>
  env.call('POST', `/carts/${cartId}/marks`, { code: c });
type CartLine = { productId: string; qty: string };
const lineQty = (res: { json: () => unknown }) =>
  (res.json() as { cart: { lines: CartLine[] } }).cart.lines[0]?.qty;
const complete = (env: Env, cartId: string, total: string) =>
  env.call('POST', `/carts/${cartId}/complete`, {
    clientRequestId: env.n(),
    expectedTotal: total,
    payments: [{ method: 'cash', tenderedAmount: total }],
  });
const errCode = (res: { json: () => unknown }) =>
  (res.json() as { error: { code: string } }).error.code;

describe('T3.7 marking codes at the cash register', () => {
  it('one code per unit: scanning adds units, a duplicate is refused, the receipt moves the codes atomically', async () => {
    const env = await boot(7301);
    try {
      const cart = await newCart(env);
      const a = await scan(env, cart, code('S1'));
      expect(a.statusCode, a.body).toBe(201);
      expect(lineQty(a)).toBe('1000');
      const b = await scan(env, cart, code('S2'));
      expect(lineQty(b)).toBe('2000');
      const dup = await scan(env, cart, code('S1'));
      expect(dup.statusCode).toBe(409);
      expect(errCode(dup)).toBe('MARKING_CODE_DUPLICATE');

      const done = await complete(env, cart, '20000');
      expect(done.statusCode, done.body).toBe(200);
      expect(
        env.count('SELECT count(*) AS n FROM local_sale_marks WHERE released_at_ms IS NULL'),
      ).toBe(2);
      expect(env.count('SELECT count(*) AS n FROM local_cart_marks')).toBe(0);

      // Sold codes cannot be sold again.
      const again = await scan(env, await newCart(env), code('S1'));
      expect(again.statusCode).toBe(409);
      expect(errCode(again)).toBe('MARKING_CODE_ALREADY_SOLD');
    } finally {
      await env.hub.close();
    }
  });

  it('codes != units: the receipt is refused and NOTHING is written (no sale, codes still in the cart)', async () => {
    const env = await boot(7302);
    try {
      const cart = await newCart(env);
      await scan(env, cart, code('M1'));
      const line = (await env.call('GET', `/carts/${cart}`)).json<{
        cart: { lines: { id: string }[] };
      }>().cart.lines[0];
      expect(
        (await env.call('PATCH', `/carts/${cart}/lines/${line.id}`, { qty: '2000' })).statusCode,
      ).toBe(200);
      const bad = await complete(env, cart, '20000');
      expect(bad.statusCode).toBe(422);
      expect(errCode(bad)).toBe('MARKING_CODES_INCOMPLETE');
      expect(env.count('SELECT count(*) AS n FROM sales')).toBe(0);
      expect(env.count('SELECT count(*) AS n FROM local_cart_marks')).toBe(1);
      expect(env.count('SELECT count(*) AS n FROM local_sale_marks')).toBe(0);
    } finally {
      await env.hub.close();
    }
  });

  it('void releases every code; a return releases one code per returned unit', async () => {
    const env = await boot(7303);
    try {
      const c1 = await newCart(env);
      await scan(env, c1, code('V1'));
      const s1 = (await complete(env, c1, '10000')).json<{ sale: { id: string } }>().sale;
      expect(
        (
          await env.call('POST', `/sales/${s1.id}/void`, {
            clientRequestId: env.n(),
            reason: 'Xato',
          })
        ).statusCode,
      ).toBe(200);
      expect((await scan(env, await newCart(env), code('V1'))).statusCode).toBe(201);

      const c2 = await newCart(env);
      await scan(env, c2, code('R1'));
      await scan(env, c2, code('R2'));
      const s2 = (await complete(env, c2, '20000')).json<{
        sale: { id: string; lines: { id: string }[] };
      }>().sale;
      const ret = await env.call('POST', `/sales/${s2.id}/returns`, {
        clientRequestId: env.n(),
        reason: 'Qaytdi',
        items: [{ saleLineId: s2.lines[0].id, qty: '1000' }],
        payments: [{ method: 'cash', amount: '10000' }],
      });
      expect(ret.statusCode, ret.body).toBe(201);
      expect(
        env.count(
          "SELECT count(*) AS n FROM local_sale_marks WHERE sale_id = ? AND released_reason = 'return'",
          s2.id,
        ),
      ).toBe(1);
      expect(
        env.count(
          'SELECT count(*) AS n FROM local_sale_marks WHERE sale_id = ? AND released_at_ms IS NULL',
          s2.id,
        ),
      ).toBe(1);
    } finally {
      await env.hub.close();
    }
  });

  it('operator answers: MXIK mismatch and "already sold" refuse; operator offline keeps the code as unchecked', async () => {
    const driver = new FakeMarkingDriver({ [GTIN]: '02202999999999999' });
    const env = await boot(7304, driver);
    try {
      const cart = await newCart(env);
      const mismatch = await scan(env, cart, code('X1'));
      expect(mismatch.statusCode).toBe(409);
      expect(errCode(mismatch)).toBe('MARKING_CODE_MISMATCH');
      driver.setOnline(false);
      const offline = await scan(env, cart, code('X2'));
      expect(offline.statusCode, offline.body).toBe(201);
      expect(offline.json<{ checkStatus: string }>().checkStatus).toBe('unchecked');
      driver.setOnline(true);
      driver.markSold(GTIN, 'X3');
      const sold = await scan(env, cart, code('X3'));
      expect(errCode(sold)).toBe('MARKING_CODE_ALREADY_SOLD');
    } finally {
      await env.hub.close();
    }
  });

  it('the EAN scanner is untouched; a code of a product that needs no marking is refused; removing a code removes a unit', async () => {
    const env = await boot(7305);
    try {
      const scanEan = await env.call('GET', `/catalog/scan?code=${EAN}`);
      expect(scanEan.statusCode).toBe(200);
      expect(scanEan.json<{ product: { id: string } }>().product.id).toBe(env.marked);
      const cart = await newCart(env);
      const notCode = await scan(env, cart, EAN);
      expect(notCode.statusCode).toBe(400);
      expect(errCode(notCode)).toBe('MARKING_CODE_INVALID');

      env.hub.connection.sqlite
        .prepare(`UPDATE products SET mxik = ? WHERE id = ?`)
        .run(PLAIN_MXIK, env.marked);
      const notRequired = await scan(env, cart, code('P1'));
      expect(errCode(notRequired)).toBe('MARKING_NOT_REQUIRED');
      env.hub.connection.sqlite
        .prepare(`UPDATE products SET mxik = ? WHERE id = ?`)
        .run(MARKED_MXIK, env.marked);

      await scan(env, cart, code('D1'));
      const two = await scan(env, cart, code('D2'));
      const markId = two
        .json<{ marks: { id: string; codeKey: string }[] }>()
        .marks.find((m) => m.codeKey.endsWith(':D1'))!.id;
      const removed = await env.call('DELETE', `/carts/${cart}/marks/${markId}`);
      expect(removed.statusCode).toBe(200);
      expect(lineQty(removed)).toBe('1000');
      expect((await scan(env, await newCart(env), code('D1'))).statusCode).toBe(201);
    } finally {
      await env.hub.close();
    }
  });

  it('removing the cart line (ordinary path) frees its codes for another cart', async () => {
    const env = await boot(7306);
    try {
      const cart = await newCart(env);
      const res = await scan(env, cart, code('L1'));
      const lineId = res.json<{ cart: { lines: { id: string }[] } }>().cart.lines[0].id;
      expect((await env.call('DELETE', `/carts/${cart}/lines/${lineId}`)).statusCode).toBe(200);
      expect(env.count('SELECT count(*) AS n FROM local_cart_marks')).toBe(0);
      expect((await scan(env, await newCart(env), code('L1'))).statusCode).toBe(201);
    } finally {
      await env.hub.close();
    }
  });
  it('P2-K3: a code sold by another register while the operator check runs is refused and leaves NO mark behind', async () => {
    const env = await boot(7307);
    try {
      const real = env.driver.check.bind(env.driver);
      for (const [label, withExisting, serial] of [
        ['existing line', true, 'R1'],
        ['new line', false, 'R2'],
      ] as const) {
        const slow = await newCart(env);
        if (withExisting) expect((await scan(env, slow, code('R0'))).statusCode).toBe(201);
        let release!: () => void;
        const gate = new Promise<void>((r) => (release = r));
        let gated = false;
        env.driver.check = async (req) => {
          const res = await real(req);
          if (!gated && req.serial === serial) {
            gated = true;
            await gate; // the operator answers slowly...
          }
          return res;
        };
        const slowScan = scan(env, slow, code(serial));
        await new Promise((r) => setTimeout(r, 20));
        // ...meanwhile another register scans and sells the same code.
        const fast = await newCart(env);
        expect((await scan(env, fast, code(serial))).statusCode, label).toBe(201);
        expect((await complete(env, fast, '10000')).statusCode, label).toBe(200);
        release();
        const res = await slowScan;
        expect(res.statusCode, label).toBe(409);
        expect(errCode(res), label).toBe('MARKING_CODE_ALREADY_SOLD');
        expect(
          env.count('SELECT count(*) AS n FROM local_cart_marks WHERE cart_id = ?', slow),
          label,
        ).toBe(withExisting ? 1 : 0);
        const lines = (await env.call('GET', `/carts/${slow}`)).json<{
          cart: { lines: CartLine[] };
        }>().cart.lines;
        expect(
          lines.map((l) => l.qty),
          label,
        ).toEqual(withExisting ? ['1000'] : []);
        env.driver.check = real;
      }
    } finally {
      await env.hub.close();
    }
  });
});
