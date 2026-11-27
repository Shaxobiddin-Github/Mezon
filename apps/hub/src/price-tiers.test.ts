import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LoginResponseSchema } from '@mezon/contracts';
import type { PinHasher } from '@mezon/domain';
import { FixedClock, SeededRandomSource } from '@mezon/test-utils';
import { afterEach, describe, expect, it } from 'vitest';
import { createHubServer } from './index.js';

const HOST = '127.0.0.1:47881';
const fastHasher: PinHasher = {
  hash: (pin) => Promise.resolve(`fast-stub-hash:${pin}`),
  verify: (stored, pin) => Promise.resolve(stored === `fast-stub-hash:${pin}`),
};
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true, maxRetries: 5 });
});

async function boot(seed: number) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mezon-tiers-'));
  dirs.push(dir);
  const hub = await createHubServer({
    dbPath: path.join(dir, 'hub.db'),
    port: 47881,
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
    payload: { fullName: 'Kassir', username: 'kassa', role: 'cashier', pin: '739104' },
  });
  const call = (token: string, method: 'GET' | 'POST' | 'PUT', url: string, payload?: object) =>
    hub.app.inject({ method, url, headers: h(token), ...(payload ? { payload } : {}) });
  return { hub, owner, cashier: await login('kassa', '739104'), call };
}

type Line = {
  qty: string;
  appliedPromotionName: string | null;
  finalTotal: string;
};

describe('C20 wholesale tiers and favourites over the hub API', () => {
  it('owner sets tiers; a cashier sale gets the wholesale price from the threshold', async () => {
    const env = await boot(9201);
    try {
      const created = await env.call(env.owner, 'POST', '/products', {
        name: 'Coca cola 1,5 l',
        unit: 'dona',
        salePrice: '2000000',
      });
      expect(created.statusCode, created.body).toBe(201);
      const productId = created.json<{ product: { id: string } }>().product.id;

      // the cashier may read but not change tiers
      const denied = await env.call(env.cashier, 'PUT', `/products/${productId}/price-tiers`, {
        tiers: [{ minQty: '5000', unitPrice: '1900000' }],
      });
      expect(denied.statusCode).toBe(403);

      // a tier dearer than the shelf price is refused
      const dear = await env.call(env.owner, 'PUT', `/products/${productId}/price-tiers`, {
        tiers: [{ minQty: '5000', unitPrice: '2100000' }],
      });
      expect(dear.statusCode).toBe(400);

      const set = await env.call(env.owner, 'PUT', `/products/${productId}/price-tiers`, {
        tiers: [
          { minQty: '10000', unitPrice: '1800000' },
          { minQty: '5000', unitPrice: '1900000' },
        ],
      });
      expect(set.statusCode, set.body).toBe(200);
      expect(
        set.json<{ tiers: { minQty: string; unitPrice: string }[] }>().tiers.map((t) => t.minQty),
      ).toEqual(['5000', '10000']);

      const list = await env.call(
        env.cashier,
        'GET',
        `/catalog/price-tiers?productIds=${productId}`,
      );
      expect(list.json<{ tiers: unknown[] }>().tiers).toHaveLength(2);

      const shift = await env.call(env.cashier, 'POST', '/shifts/open', {
        clientRequestId: '01950000-0000-7000-8000-1700000000d1',
        openingCash: '0',
      });
      expect(shift.statusCode, shift.body).toBe(201);
      const cartId = (await env.call(env.cashier, 'POST', '/carts', {})).json<{
        cart: { id: string };
      }>().cart.id;
      const add = async (qty: string) =>
        (
          await env.call(env.cashier, 'POST', `/carts/${cartId}/lines`, {
            kind: 'catalog',
            productId,
            qty,
          })
        ).json<{ cart: { totalFinal: string; lines: Line[] } }>().cart;

      expect((await add('4000')).totalFinal).toBe('8000000'); // 4 x 20 000
      const five = await add('1000'); // the 5th bottle crosses the tier
      expect(five.totalFinal).toBe('9500000'); // 5 x 19 000
      expect(five.lines[0]?.appliedPromotionName).toBe('Ulgurji narx');
      expect((await add('5000')).totalFinal).toBe('18000000'); // 10 x 18 000

      // removing all tiers brings the shelf price back
      const cleared = await env.call(env.owner, 'PUT', `/products/${productId}/price-tiers`, {
        tiers: [],
      });
      expect(cleared.json<{ tiers: unknown[] }>().tiers).toHaveLength(0);
      const again = (await env.call(env.cashier, 'GET', `/carts/${cartId}`)).json<{
        cart: { totalFinal: string };
      }>().cart;
      expect(again.totalFinal).toBe('20000000');
    } finally {
      await env.hub.close();
    }
  });

  it('a cashier stars and un-stars goods; the favourites filter lists only them', async () => {
    const env = await boot(9202);
    try {
      const mk = async (name: string) =>
        (
          await env.call(env.owner, 'POST', '/products', {
            name,
            unit: 'dona',
            salePrice: '100000',
          })
        ).json<{ product: { id: string } }>().product.id;
      const a = await mk('Non');
      await mk('Sut');

      const star = await env.call(env.cashier, 'PUT', `/catalog/favorites/${a}`, {
        favorite: true,
      });
      expect(star.statusCode, star.body).toBe(200);
      expect(star.json<{ productIds: string[] }>().productIds).toEqual([a]);
      // idempotent
      await env.call(env.cashier, 'PUT', `/catalog/favorites/${a}`, { favorite: true });

      const favs = (await env.call(env.cashier, 'GET', '/products?favoritesOnly=true')).json<{
        products: { id: string }[];
        total: number;
      }>();
      expect(favs.total).toBe(1);
      expect(favs.products[0]?.id).toBe(a);

      const unstar = await env.call(env.cashier, 'PUT', `/catalog/favorites/${a}`, {
        favorite: false,
      });
      expect(unstar.json<{ productIds: string[] }>().productIds).toEqual([]);
    } finally {
      await env.hub.close();
    }
  });
});
