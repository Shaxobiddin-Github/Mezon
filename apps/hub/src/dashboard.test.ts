import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LoginResponseSchema } from '@mezon/contracts';
import type { PinHasher } from '@mezon/domain';
import { FixedClock, SeededRandomSource } from '@mezon/test-utils';
import { afterEach, describe, expect, it } from 'vitest';
import { demoBarcode } from './demo-catalog.js';
import { createHubServer } from './index.js';

const HOST = '127.0.0.1:47883';
const fastHasher: PinHasher = {
  hash: (pin) => Promise.resolve(`fast-stub-hash:${pin}`),
  verify: (stored, pin) => Promise.resolve(stored === `fast-stub-hash:${pin}`),
};
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true, maxRetries: 5 });
});

async function boot(seed: number) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mezon-dash-'));
  dirs.push(dir);
  const hub = await createHubServer({
    dbPath: path.join(dir, 'hub.db'),
    port: 47883,
    logLevel: 'silent',
    clock: new FixedClock(1_771_000_000_000n),
    random: new SeededRandomSource(seed),
    pinHasher: fastHasher,
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
  await hub.app.inject({
    method: 'POST',
    url: '/users',
    headers: h(owner),
    payload: { fullName: 'Menejer', username: 'mgr', role: 'manager', pin: '739104' },
  });
  await hub.app.inject({
    method: 'POST',
    url: '/users',
    headers: h(owner),
    payload: { fullName: 'Kassir', username: 'kassa', role: 'cashier', pin: '615283' },
  });
  const call = (token: string, method: 'GET' | 'POST', url: string, payload?: object) =>
    hub.app.inject({ method, url, headers: h(token), ...(payload ? { payload } : {}) });
  return {
    hub,
    owner,
    manager: await login('mgr', '739104'),
    cashier: await login('kassa', '615283'),
    call,
  };
}

type Dash = {
  date: string;
  today: {
    netSales: string;
    salesCount: number;
    grossProfit: string | null;
    newDebt: string;
    debtCollected: string;
    expenses: string;
  };
  yesterdayNetSales: string;
  week: { date: string; netSales: string }[];
  customerDebtTotal: string;
  stock: { costValue: string | null; retailValue: string; lowStock: number; outOfStock: number };
};

describe('C23 owner dashboard', () => {
  it('sums today, the week, debts and stock; profit and cost only for the owner', async () => {
    const env = await boot(9301);
    try {
      expect((await env.call(env.owner, 'POST', '/settings/demo-catalog')).statusCode).toBe(200);
      const before = (await env.call(env.owner, 'GET', '/reports/dashboard')).json<Dash>();
      expect(before.today.salesCount).toBe(0);
      expect(before.week).toHaveLength(7);
      expect(before.week[6]?.date).toBe(before.date);
      expect(BigInt(before.stock.retailValue)).toBeGreaterThan(0n);
      expect(before.stock.costValue).not.toBeNull();

      // a sale of 2 patir non (5 000 each): 4 000 paid in cash, 6 000 on credit
      const customers = (await env.call(env.owner, 'GET', '/customers')).json<{
        items: { id: string; fullName: string }[];
      }>().items;
      const bobur = customers.find((c) => c.fullName === 'Aliyev Bobur');
      expect(bobur).toBeDefined();
      expect(
        (
          await env.call(env.cashier, 'POST', '/shifts/open', {
            clientRequestId: '01950000-0000-7000-8000-1700000000e1',
            openingCash: '0',
          })
        ).statusCode,
      ).toBe(201);
      const cartId = (await env.call(env.cashier, 'POST', '/carts', {})).json<{
        cart: { id: string };
      }>().cart.id;
      const add = await env.call(env.cashier, 'POST', `/carts/${cartId}/lines`, {
        kind: 'scan',
        barcode: demoBarcode(1, 1),
        qty: '2000',
      });
      expect(add.statusCode, add.body).toBe(201);
      const total = add.json<{ cart: { totalFinal: string } }>().cart.totalFinal;
      const debt = (BigInt(total) - 400_000n).toString();
      const sold = await env.call(env.cashier, 'POST', `/carts/${cartId}/complete`, {
        clientRequestId: '01950000-0000-7000-8000-1700000000e2',
        expectedTotal: total,
        customerId: bobur?.id,
        debtAmount: debt,
        payments: [{ method: 'cash', tenderedAmount: '400000' }],
      });
      expect(sold.statusCode, sold.body).toBe(200);

      const owner = (await env.call(env.owner, 'GET', '/reports/dashboard')).json<Dash>();
      expect(owner.today.salesCount).toBe(1);
      expect(owner.today.netSales).toBe(total);
      expect(owner.today.newDebt).toBe(debt);
      expect(owner.week[6]?.netSales).toBe(total);
      expect(owner.today.grossProfit).not.toBeNull();
      expect(BigInt(owner.customerDebtTotal)).toBe(BigInt(debt));
      expect(BigInt(owner.stock.retailValue)).toBe(
        BigInt(before.stock.retailValue) - BigInt(total),
      );

      const manager = (await env.call(env.manager, 'GET', '/reports/dashboard')).json<Dash>();
      expect(manager.today.netSales).toBe(total);
      expect(manager.today.grossProfit).toBeNull();
      expect(manager.stock.costValue).toBeNull();

      expect((await env.call(env.cashier, 'GET', '/reports/dashboard')).statusCode).toBe(403);
    } finally {
      await env.hub.close();
    }
  });
});
