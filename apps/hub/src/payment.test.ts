import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LoginResponseSchema, ProductDetailResponseSchema } from '@mezon/contracts';
import type { PinHasher } from '@mezon/domain';
import { FakePaymentDriver } from '@mezon/drivers';
import { FixedClock, SeededRandomSource } from '@mezon/test-utils';
import { afterEach, describe, expect, it } from 'vitest';
import { type HubServer, createHubServer } from './index.js';

const HOST = '127.0.0.1:47878';
const fastHasher: PinHasher = {
  hash: (pin) => Promise.resolve(`fast-stub-hash:${pin}`),
  verify: (stored, pin) => Promise.resolve(stored === `fast-stub-hash:${pin}`),
};
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true, maxRetries: 5 });
});

interface Intent {
  id: string;
  status: string;
  providerRef: string;
  paidLate: boolean;
  consumedBySaleId: string | null;
  qrPayload: string | null;
}

interface Env {
  hub: HubServer;
  clock: FixedClock;
  driver: FakePaymentDriver;
  owner: string;
  manager: string;
  cashier: string;
  product: string;
  n: () => string;
  call: (
    token: string,
    method: 'POST' | 'GET',
    url: string,
    payload?: Record<string, unknown>,
  ) => ReturnType<HubServer['app']['inject']>;
}

async function boot(seed: number): Promise<Env> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mezon-pay-'));
  dirs.push(dir);
  const clock = new FixedClock(1_771_000_000_000n);
  const driver = new FakePaymentDriver();
  const hub = await createHubServer({
    dbPath: path.join(dir, 'hub.db'),
    port: 47878,
    logLevel: 'silent',
    clock,
    random: new SeededRandomSource(seed),
    pinHasher: fastHasher,
    paymentDriver: driver,
    paymentQrTtlMs: 60_000n,
  });
  const h = (t?: string) => (t ? { host: HOST, authorization: `Bearer ${t}` } : { host: HOST });
  await hub.app.inject({
    method: 'POST',
    url: '/setup',
    headers: h(),
    payload: { owner: { fullName: 'Egasi', username: 'owner', pin: '849201' } },
  });
  const login = async (username: string, pin: string) =>
    LoginResponseSchema.parse(
      (
        await hub.app.inject({
          method: 'POST',
          url: '/auth/login',
          headers: h(),
          payload: { username, pin },
        })
      ).json(),
    ).token;
  const owner = await login('owner', '849201');
  for (const u of [
    { fullName: 'Menejer', username: 'mgr', role: 'manager', pin: '739104' },
    { fullName: 'Kassir', username: 'kassa', role: 'cashier', pin: '582914' },
  ]) {
    await hub.app.inject({ method: 'POST', url: '/users', headers: h(owner), payload: u });
  }
  const call: Env['call'] = (token, method, url, payload) =>
    hub.app.inject({ method, url, headers: h(token), ...(payload ? { payload } : {}) });
  const product = ProductDetailResponseSchema.parse(
    (
      await call(owner, 'POST', '/products', { name: 'Olma', unit: 'dona', salePrice: '10000' })
    ).json(),
  ).product.id;
  let i = 0;
  const n = () => `01997300-0000-7000-8000-${(seed * 1000 + ++i).toString(16).padStart(12, '0')}`;
  const cashier = await login('kassa', '582914');
  await call(cashier, 'POST', '/shifts/open', { clientRequestId: n(), openingCash: '0' });
  return {
    hub,
    clock,
    driver,
    owner,
    manager: await login('mgr', '739104'),
    cashier,
    product,
    n,
    call,
  };
}

async function cartOf(env: Env, units = 1) {
  const id = (await env.call(env.cashier, 'POST', '/carts', {})).json<{ cart: { id: string } }>()
    .cart.id;
  await env.call(env.cashier, 'POST', `/carts/${id}/lines`, {
    kind: 'catalog',
    productId: env.product,
    qty: String(units * 1000),
  });
  return id;
}
const createQr = async (env: Env, amount: string, kind: 'dynamic' | 'static' = 'dynamic') => {
  const r = await env.call(env.cashier, 'POST', '/payments/intents', { amount, kind });
  expect(r.statusCode, r.body).toBe(201);
  return r.json<{ intent: Intent }>().intent;
};
const refresh = async (env: Env, id: string) =>
  (await env.call(env.cashier, 'GET', `/payments/intents/${id}`)).json<{ intent: Intent }>().intent;
const payByQr = (env: Env, cartId: string, providerRef: string, amount = '10000') =>
  env.call(env.cashier, 'POST', `/carts/${cartId}/complete`, {
    clientRequestId: env.n(),
    expectedTotal: amount,
    payments: [{ method: 'uzqr', amount, providerRef }],
  });
const code = (r: { json: () => unknown }) => (r.json() as { error: { code: string } }).error.code;

describe('T3.6 UzQR: a receipt never closes without a confirmed QR payment', () => {
  it('pending → refused; paid → closes once; the same QR cannot close a second receipt', async () => {
    const env = await boot(8601);
    try {
      const qr = await createQr(env, '10000');
      expect(qr.status).toBe('pending');
      expect(qr.qrPayload).toMatch(/^SINOV\|UZQR\|/);
      const cart = await cartOf(env);
      const early = await payByQr(env, cart, qr.providerRef);
      expect(early.statusCode).toBe(409);
      expect(code(early)).toBe('PAYMENT_NOT_CONFIRMED');
      expect(env.hub.connection.sqlite.prepare('SELECT count(*) AS n FROM sales').get()).toEqual({
        n: 0n,
      });

      env.driver.pay(qr.providerRef);
      expect((await refresh(env, qr.id)).status).toBe('paid');
      const ok = await payByQr(env, cart, qr.providerRef);
      expect(ok.statusCode, ok.body).toBe(200);
      const saleId = ok.json<{ sale: { id: string } }>().sale.id;
      expect((await refresh(env, qr.id)).consumedBySaleId).toBe(saleId);

      const twice = await payByQr(env, await cartOf(env), qr.providerRef);
      expect(code(twice)).toBe('PAYMENT_NOT_CONFIRMED');
    } finally {
      await env.hub.close();
    }
  });

  it('wrong amount and an unknown reference are refused', async () => {
    const env = await boot(8602);
    try {
      const qr = await createQr(env, '9000');
      env.driver.pay(qr.providerRef);
      await refresh(env, qr.id);
      expect(code(await payByQr(env, await cartOf(env), qr.providerRef))).toBe(
        'PAYMENT_NOT_CONFIRMED',
      );
      expect(code(await payByQr(env, await cartOf(env), 'NO-SUCH-REF'))).toBe(
        'PAYMENT_NOT_CONFIRMED',
      );
    } finally {
      await env.hub.close();
    }
  });

  it('late confirmation: expired, then paid → paid_late; it closes ONE receipt and is never written twice', async () => {
    const env = await boot(8603);
    try {
      const qr = await createQr(env, '10000');
      env.clock.advance(61_000n);
      expect((await refresh(env, qr.id)).status).toBe('expired');
      env.driver.pay(qr.providerRef); // the customer's bank confirms after our timeout
      const late = await refresh(env, qr.id);
      expect(late).toMatchObject({ status: 'paid', paidLate: true });
      // Refreshing again changes nothing (no second write).
      expect(await refresh(env, qr.id)).toEqual(late);
      expect((await payByQr(env, await cartOf(env), qr.providerRef)).statusCode).toBe(200);
      expect(code(await payByQr(env, await cartOf(env), qr.providerRef))).toBe(
        'PAYMENT_NOT_CONFIRMED',
      );
    } finally {
      await env.hub.close();
    }
  });

  it('cancelled by the cashier, paid anyway → kept as paid_late and refunded by a manager (once)', async () => {
    const env = await boot(8604);
    try {
      const qr = await createQr(env, '10000');
      expect(
        (await env.call(env.cashier, 'POST', `/payments/intents/${qr.id}/cancel`)).statusCode,
      ).toBe(200);
      env.driver.pay(qr.providerRef);
      expect(await refresh(env, qr.id)).toMatchObject({ status: 'paid', paidLate: true });
      expect(
        (await env.call(env.cashier, 'POST', `/payments/intents/${qr.id}/refund`)).statusCode,
      ).toBe(403);
      const refunded = await env.call(env.manager, 'POST', `/payments/intents/${qr.id}/refund`);
      expect(refunded.statusCode, refunded.body).toBe(200);
      expect(refunded.json<{ intent: Intent }>().intent.status).toBe('refunded');
      expect(env.driver.stateOf(qr.providerRef)).toBe('refunded');
      expect(
        (await env.call(env.manager, 'POST', `/payments/intents/${qr.id}/refund`)).statusCode,
      ).toBe(409);
      expect(code(await payByQr(env, await cartOf(env), qr.providerRef))).toBe(
        'PAYMENT_NOT_CONFIRMED',
      );
    } finally {
      await env.hub.close();
    }
  });

  it('a used QR cannot be refunded', async () => {
    const env = await boot(8605);
    try {
      const qr = await createQr(env, '10000');
      env.driver.pay(qr.providerRef);
      await refresh(env, qr.id);
      expect((await payByQr(env, await cartOf(env), qr.providerRef)).statusCode).toBe(200);
      expect(
        (await env.call(env.manager, 'POST', `/payments/intents/${qr.id}/refund`)).statusCode,
      ).toBe(409);
      expect(env.driver.stateOf(qr.providerRef)).toBe('paid');
    } finally {
      await env.hub.close();
    }
  });

  it('static QR: only a manager confirms by hand, with a note, audited', async () => {
    const env = await boot(8606);
    try {
      const qr = await createQr(env, '10000', 'static');
      expect(qr.providerRef).toMatch(/^STATIC-/);
      expect(
        (
          await env.call(env.cashier, 'POST', `/payments/intents/${qr.id}/confirm`, {
            note: 'Pul tushdi',
          })
        ).statusCode,
      ).toBe(403);
      const conf = await env.call(env.manager, 'POST', `/payments/intents/${qr.id}/confirm`, {
        note: 'Bank ilovasida ko‘rdim',
      });
      expect(conf.statusCode, conf.body).toBe(200);
      const audit = env.hub.connection.sqlite
        .prepare(
          "SELECT entity_id, details_json FROM local_audit_log WHERE event_type = 'payment.manual_confirmed'",
        )
        .all() as { entity_id: string; details_json: string }[];
      expect(audit.map((a) => a.entity_id)).toEqual([qr.id]);
      expect((await payByQr(env, await cartOf(env), qr.providerRef)).statusCode).toBe(200);
      expect(
        (
          await env.call(env.manager, 'POST', `/payments/intents/${qr.id}/confirm`, {
            note: 'yana bir bor',
          })
        ).statusCode,
      ).toBe(409);
    } finally {
      await env.hub.close();
    }
  });

  it('race: two receipts with the same paid QR at once → exactly one closes', async () => {
    const env = await boot(8607);
    try {
      const qr = await createQr(env, '10000');
      env.driver.pay(qr.providerRef);
      await refresh(env, qr.id);
      const [a, b] = await Promise.all([
        payByQr(env, await cartOf(env), qr.providerRef),
        payByQr(env, await cartOf(env), qr.providerRef),
      ]);
      expect([a.statusCode, b.statusCode].sort()).toEqual([200, 409]);
    } finally {
      await env.hub.close();
    }
  });

  it('provider offline: creating a QR fails clearly; refresh keeps the state (nothing is assumed)', async () => {
    const env = await boot(8608);
    try {
      const qr = await createQr(env, '10000');
      env.driver.setOnline(false);
      expect(
        (await env.call(env.cashier, 'POST', '/payments/intents', { amount: '10000' })).statusCode,
      ).toBe(502);
      expect((await refresh(env, qr.id)).status).toBe('pending');
      env.driver.setOnline(true);
      env.driver.pay(qr.providerRef);
      expect((await refresh(env, qr.id)).status).toBe('paid');
    } finally {
      await env.hub.close();
    }
  });
});
