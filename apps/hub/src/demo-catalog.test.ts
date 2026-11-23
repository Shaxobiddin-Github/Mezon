import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LoginResponseSchema } from '@mezon/contracts';
import type { PinHasher } from '@mezon/domain';
import { FixedClock, SeededRandomSource } from '@mezon/test-utils';
import { afterEach, describe, expect, it } from 'vitest';
import { DEMO_CATALOG, DEMO_CUSTOMERS, demoBarcode, ean13CheckDigit } from './demo-catalog.js';
import { createHubServer } from './index.js';

const HOST = '127.0.0.1:47879';
const fastHasher: PinHasher = {
  hash: (pin) => Promise.resolve(`fast-stub-hash:${pin}`),
  verify: (stored, pin) => Promise.resolve(stored === `fast-stub-hash:${pin}`),
};
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true, maxRetries: 5 });
});

async function boot(seed: number) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mezon-democat-'));
  dirs.push(dir);
  const hub = await createHubServer({
    dbPath: path.join(dir, 'hub.db'),
    port: 47879,
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
  const call = (token: string, method: 'GET' | 'POST', url: string, payload?: object) =>
    hub.app.inject({ method, url, headers: h(token), ...(payload ? { payload } : {}) });
  return { hub, owner, manager: await login('mgr', '739104'), call };
}

describe('C18 starter catalog data', () => {
  it('has 100 goods in 10 categories, unique names, positive prices and stock', () => {
    const all = DEMO_CATALOG.flatMap((c) => c.products);
    expect(DEMO_CATALOG).toHaveLength(10);
    expect(all).toHaveLength(100);
    expect(new Set(all.map((x) => x.name)).size).toBe(100);
    for (const x of all) {
      expect(x.priceSom).toBeGreaterThan(0);
      expect(x.stock).toBeGreaterThan(x.minStock);
      if (x.unit === 'dona') expect(Number.isInteger(x.stock)).toBe(true);
    }
    expect(DEMO_CUSTOMERS.length).toBeGreaterThan(0);
  });

  it('barcodes are valid in-store EAN-13 codes (prefix 200) and all different', () => {
    // A known EAN-13: 4006381333931
    expect(ean13CheckDigit('400638133393')).toBe(1);
    const codes = DEMO_CATALOG.flatMap((c, ci) =>
      c.products.map((_, pi) => demoBarcode(ci + 1, pi + 1)),
    );
    expect(new Set(codes).size).toBe(100);
    for (const code of codes) {
      expect(code).toMatch(/^200\d{10}$/);
      expect(Number(code[12])).toBe(ean13CheckDigit(code.slice(0, 12)));
    }
  });
});

describe('POST /settings/demo-catalog', () => {
  it('owner loads 100 goods with stock and customers once; a scan finds a product', async () => {
    const env = await boot(9101);
    try {
      const r = await env.call(env.owner, 'POST', '/settings/demo-catalog');
      expect(r.statusCode, r.body).toBe(200);
      expect(r.json()).toEqual({ categories: 10, products: 100, customers: DEMO_CUSTOMERS.length });

      const list = (await env.call(env.owner, 'GET', '/products?limit=1')).json<{
        total: number;
      }>();
      expect(list.total).toBe(100);

      const scan = await env.call(env.owner, 'GET', `/catalog/scan?code=${demoBarcode(1, 1)}`);
      expect(scan.statusCode, scan.body).toBe(200);
      expect(scan.body).toContain(DEMO_CATALOG[0]?.products[0]?.name ?? 'x');

      const balances = (await env.call(env.owner, 'GET', '/stock/balances')).body;
      expect(balances).toContain('60000'); // 60 patir non → 60 000 milli-units

      const customers = (await env.call(env.owner, 'GET', '/customers')).body;
      expect(customers).toContain(DEMO_CUSTOMERS[0]?.fullName ?? 'x');

      // second time: the catalog is no longer empty → refused, nothing doubled
      const again = await env.call(env.owner, 'POST', '/settings/demo-catalog');
      expect(again.statusCode).toBe(400);
      expect(
        (await env.call(env.owner, 'GET', '/products?limit=1')).json<{ total: number }>().total,
      ).toBe(100);
    } finally {
      await env.hub.close();
    }
  });

  it('a manager may not load it', async () => {
    const env = await boot(9102);
    try {
      const r = await env.call(env.manager, 'POST', '/settings/demo-catalog');
      expect(r.statusCode).toBe(403);
    } finally {
      await env.hub.close();
    }
  });
});
