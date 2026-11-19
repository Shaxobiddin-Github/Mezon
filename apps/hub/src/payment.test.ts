import type { LightMyRequestResponse } from 'fastify';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LoginResponseSchema, ProductDetailResponseSchema } from '@mezon/contracts';
import type { PinHasher } from '@mezon/domain';
import { FakePaymentDriver, PaymentUnavailableError } from '@mezon/drivers';
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
  ) => Promise<LightMyRequestResponse>;
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

describe('P2-K1/K2: refunds are claimed before the provider; a wrong sum is never lost', () => {
  const lateRefundable = async (env: Env) => {
    const qr = await createQr(env, '10000');
    await env.call(env.cashier, 'POST', `/payments/intents/${qr.id}/cancel`);
    env.driver.pay(qr.providerRef);
    expect((await refresh(env, qr.id)).status).toBe('paid');
    return qr;
  };
  const refund = (env: Env, id: string) =>
    env.call(env.manager, 'POST', `/payments/intents/${id}/refund`);
  const audit = (env: Env, type: string) =>
    env.hub.connection.sqlite
      .prepare(
        'SELECT entity_id, actor_user_id, details_json FROM local_audit_log WHERE event_type = ?',
      )
      .all(type) as { entity_id: string; actor_user_id: string | null; details_json: string }[];
  const details = (row: { details_json: string }) =>
    Object.fromEntries(JSON.parse(row.details_json) as [string, unknown][]);

  it('while the provider handles the refund, a sale cannot use the QR; a provider refusal gives it back', async () => {
    const env = await boot(8611);
    try {
      const qr = await lateRefundable(env);
      const realRefund = env.driver.refund.bind(env.driver);
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      env.driver.refund = async () => {
        await gate;
        return { state: 'failed', reason: 'bank says no' };
      };
      const pending = refund(env, qr.id);
      await new Promise((r) => setTimeout(r, 20));
      // The provider still says "paid" (our request is in flight): that must not reopen the QR.
      expect((await refresh(env, qr.id)).status).toBe('refunding');
      const sale = await payByQr(env, await cartOf(env), qr.providerRef);
      expect(code(sale)).toBe('PAYMENT_NOT_CONFIRMED');
      release();
      const refused = await pending;
      expect(refused.statusCode).toBe(409);
      env.driver.refund = realRefund;
      // Refused by the provider → the money is still ours, the QR is usable again.
      const after = await refresh(env, qr.id);
      expect(after.status).toBe('paid');
      expect(after.paidLate).toBe(true);
      expect((await payByQr(env, await cartOf(env), qr.providerRef)).statusCode).toBe(200);
      expect(audit(env, 'payment.refunded')).toHaveLength(0);
    } finally {
      await env.hub.close();
    }
  });

  it('refund answer lost (provider returned the money, we never heard): stays refunding, refresh settles it from the provider', async () => {
    const env = await boot(8612);
    try {
      const qr = await lateRefundable(env);
      const realRefund = env.driver.refund.bind(env.driver);
      env.driver.refund = async (ref, amount) => {
        await realRefund(ref, amount);
        throw new PaymentUnavailableError('timeout');
      };
      const lost = await refund(env, qr.id);
      expect(lost.statusCode).toBe(502);
      env.driver.refund = realRefund;
      env.driver.setOnline(false);
      expect((await refresh(env, qr.id)).status).toBe('refunding'); // no answer → no guess
      expect(code(await payByQr(env, await cartOf(env), qr.providerRef))).toBe(
        'PAYMENT_NOT_CONFIRMED',
      );
      expect(
        (await env.call(env.manager, 'GET', '/payments/attention'))
          .json<{ intents: Intent[] }>()
          .intents.map((i) => i.status),
      ).toEqual(['refunding']);
      env.driver.setOnline(true);
      expect((await refresh(env, qr.id)).status).toBe('refunded');
      const rows = audit(env, 'payment.refunded');
      expect(rows).toHaveLength(1);
      expect(rows[0].actor_user_id).toBeNull();
      expect(details(rows[0])).toMatchObject({ settledBy: 'provider_status' });
    } finally {
      await env.hub.close();
    }
  });

  it('provider offline before the refund happened: stays refunding (even when the provider says paid); the manager retries it once', async () => {
    const env = await boot(8613);
    try {
      const qr = await lateRefundable(env);
      env.driver.setOnline(false);
      expect((await refund(env, qr.id)).statusCode).toBe(502);
      expect((await refresh(env, qr.id)).status).toBe('refunding');
      env.driver.setOnline(true);
      expect((await refresh(env, qr.id)).status).toBe('refunding');
      expect(env.driver.stateOf(qr.providerRef)).toBe('paid');
      expect(code(await payByQr(env, await cartOf(env), qr.providerRef))).toBe(
        'PAYMENT_NOT_CONFIRMED',
      );
      // The manager retries: the refund goes through, once, with the manager as the audited actor.
      const ok = await refund(env, qr.id);
      expect(ok.statusCode, ok.body).toBe(200);
      expect(env.driver.stateOf(qr.providerRef)).toBe('refunded');
      const rows = audit(env, 'payment.refunded');
      expect(rows).toHaveLength(1);
      expect(rows[0].actor_user_id).not.toBeNull();
      // A second retry is the same refund: no double money, no second audit row.
      expect(code(await refund(env, qr.id))).toBe('PAYMENT_INTENT_INVALID_STATE');
      expect(audit(env, 'payment.refunded')).toHaveLength(1);
    } finally {
      await env.hub.close();
    }
  });

  it('a different sum than the QR asked: amount_mismatch, audited, shown to the manager, never closes a receipt, refunded in full', async () => {
    const env = await boot(8614);
    try {
      const qr = await createQr(env, '10000');
      env.driver.pay(qr.providerRef, 9000n);
      const seen = await refresh(env, qr.id);
      expect(seen.status).toBe('amount_mismatch');
      expect((seen as Intent & { receivedAmount: string }).receivedAmount).toBe('9000');
      expect((await refresh(env, qr.id)).status).toBe('amount_mismatch'); // stable, no duplicate audit
      const rows = audit(env, 'payment.amount_mismatch');
      expect(rows).toHaveLength(1);
      expect(details(rows[0])).toMatchObject({
        expected: '10000',
        received: '9000',
      });
      // The receipt's sum matches the QR, but the money taken does not: refused.
      expect(code(await payByQr(env, await cartOf(env), qr.providerRef))).toBe(
        'PAYMENT_NOT_CONFIRMED',
      );
      expect((await env.call(env.cashier, 'GET', '/payments/attention')).statusCode).toBe(403);
      const list = (await env.call(env.manager, 'GET', '/payments/attention')).json<{
        intents: Intent[];
      }>().intents;
      expect(list.map((i) => [i.id, i.status])).toEqual([[qr.id, 'amount_mismatch']]);
      const back = await refund(env, qr.id);
      expect(back.statusCode, back.body).toBe(200);
      expect(back.json<{ intent: Intent }>().intent.status).toBe('refunded');
      expect(env.driver.stateOf(qr.providerRef)).toBe('refunded'); // the 9000 actually taken
      expect(details(audit(env, 'payment.refunded')[0])).toMatchObject({
        amount: '9000',
      });
      expect(
        (await env.call(env.manager, 'GET', '/payments/attention')).json<{ intents: Intent[] }>()
          .intents,
      ).toEqual([]);
    } finally {
      await env.hub.close();
    }
  });
});
