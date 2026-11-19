// [claude-tekshiruv] P2-K1 isboti: refund provayderga ketgan paytda chek o'sha QR bilan yopiladi.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LoginResponseSchema, ProductDetailResponseSchema } from '@mezon/contracts';
import type { PinHasher } from '@mezon/domain';
import { FakePaymentDriver } from '@mezon/drivers';
import { FixedClock, SeededRandomSource } from '@mezon/test-utils';
import { expect, it } from 'vitest';
import { createHubServer } from './index.js';

const HOST = { host: '127.0.0.1:47879' };
const hasher: PinHasher = {
  hash: (p) => Promise.resolve(`h:${p}`),
  verify: (s, p) => Promise.resolve(s === `h:${p}`),
};

it('P2-K1: refund in flight + sale with the same QR → the customer must not get both', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mezon-race-'));
  const driver = new FakePaymentDriver();
  const hub = await createHubServer({
    dbPath: path.join(dir, 'hub.db'),
    port: 47879,
    logLevel: 'silent',
    clock: new FixedClock(1_771_000_000_000n),
    random: new SeededRandomSource(5),
    pinHasher: hasher,
    paymentDriver: driver,
    paymentQrTtlMs: 60_000n,
  });
  const h = (t?: string) => (t ? { ...HOST, authorization: `Bearer ${t}` } : HOST);
  await hub.app.inject({
    method: 'POST',
    url: '/setup',
    headers: h(),
    payload: { owner: { fullName: 'E', username: 'owner', pin: '849201' } },
  });
  const login = async (u: string, p: string) =>
    LoginResponseSchema.parse(
      (
        await hub.app.inject({
          method: 'POST',
          url: '/auth/login',
          headers: h(),
          payload: { username: u, pin: p },
        })
      ).json(),
    ).token;
  const owner = await login('owner', '849201');
  await hub.app.inject({
    method: 'POST',
    url: '/users',
    headers: h(owner),
    payload: { fullName: 'M', username: 'mgr', role: 'manager', pin: '739104' },
  });
  await hub.app.inject({
    method: 'POST',
    url: '/users',
    headers: h(owner),
    payload: { fullName: 'K', username: 'kassa', role: 'cashier', pin: '582914' },
  });
  const call = (
    t: string,
    method: 'POST' | 'GET',
    url: string,
    payload?: Record<string, unknown>,
  ) => hub.app.inject({ method, url, headers: h(t), ...(payload ? { payload } : {}) });
  const product = ProductDetailResponseSchema.parse(
    (
      await call(owner, 'POST', '/products', { name: 'Olma', unit: 'dona', salePrice: '10000' })
    ).json(),
  ).product.id;
  const cashier = await login('kassa', '582914');
  const manager = await login('mgr', '739104');
  let i = 0;
  const n = () => `01997300-0000-7000-8000-${(++i).toString(16).padStart(12, '0')}`;
  await call(cashier, 'POST', '/shifts/open', { clientRequestId: n(), openingCash: '0' });
  try {
    // A late-paid QR: refundable AND usable by a sale.
    const qr = (
      await call(cashier, 'POST', '/payments/intents', { amount: '10000', kind: 'dynamic' })
    ).json<{ intent: { id: string; providerRef: string } }>().intent;
    await call(cashier, 'POST', `/payments/intents/${qr.id}/cancel`);
    driver.pay(qr.providerRef);
    await call(cashier, 'GET', `/payments/intents/${qr.id}`);

    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const realRefund = driver.refund.bind(driver);
    driver.refund = async (ref, amount) => {
      const res = await realRefund(ref, amount); // the bank returns the money...
      await gate; // ...and our answer is slow to come back
      return res;
    };
    const refundP = call(manager, 'POST', `/payments/intents/${qr.id}/refund`);
    await new Promise((r) => setTimeout(r, 50));
    const cart = (await call(cashier, 'POST', '/carts', {})).json<{ cart: { id: string } }>().cart
      .id;
    await call(cashier, 'POST', `/carts/${cart}/lines`, {
      kind: 'catalog',
      productId: product,
      qty: '1000',
    });
    const sale = await call(cashier, 'POST', `/carts/${cart}/complete`, {
      clientRequestId: n(),
      expectedTotal: '10000',
      payments: [{ method: 'uzqr', amount: '10000', providerRef: qr.providerRef }],
    });
    release();
    const refund = await refundP;
    const moneyBack = driver.stateOf(qr.providerRef) === 'refunded';
    // Safe outcomes: (sale closed AND money not returned) OR (sale refused).
    expect({ sale: sale.statusCode, refund: refund.statusCode, moneyBack }).not.toMatchObject({
      sale: 200,
      moneyBack: true,
    });
  } finally {
    await hub.close();
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
  }
});
