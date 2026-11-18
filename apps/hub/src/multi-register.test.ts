import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LoginResponseSchema, ProductDetailResponseSchema } from '@mezon/contracts';
import type { PinHasher } from '@mezon/domain';
import {
  type PairedTerminalCredentials,
  pairWithLanHub,
  pinnedHubRequest,
} from '@mezon/drivers/node';
import { FixedClock, SeededRandomSource } from '@mezon/test-utils';
import { afterEach, describe, expect, it } from 'vitest';
import { type HubServer, createHubServer } from './index.js';

const HOST = '127.0.0.1:47880';
const fastHasher: PinHasher = {
  hash: (pin) => Promise.resolve(`fast-stub-hash:${pin}`),
  verify: (stored, pin) => Promise.resolve(stored === `fast-stub-hash:${pin}`),
};
const dirs: string[] = [];
const hubs: HubServer[] = [];
afterEach(async () => {
  for (const h of hubs.splice(0)) await h.close();
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true, maxRetries: 5 });
});

interface Register {
  readonly creds: PairedTerminalCredentials;
  readonly token: string;
  call(
    method: 'GET' | 'POST',
    p: string,
    body?: unknown,
  ): Promise<{ status: number; json: { cart: { id: string } } }>;
}

async function bootWithRegisters(seed: number, registers: number, stockUnits: number) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mezon-mreg-'));
  dirs.push(dir);
  const hub = await createHubServer({
    dbPath: path.join(dir, 'hub.db'),
    port: 47880,
    logLevel: 'silent',
    clock: new FixedClock(BigInt(Date.now())),
    random: new SeededRandomSource(seed),
    pinHasher: fastHasher,
  });
  hubs.push(hub);
  const h = (t?: string) => (t ? { host: HOST, authorization: `Bearer ${t}` } : { host: HOST });
  const local = async (
    method: 'GET' | 'POST' | 'PUT',
    url: string,
    token?: string,
    payload?: object,
  ) => hub.app.inject({ method, url, headers: h(token), ...(payload ? { payload } : {}) });
  await local('POST', '/setup', undefined, {
    owner: { fullName: 'Egasi', username: 'owner', pin: '849201' },
  });
  const owner = LoginResponseSchema.parse(
    (await local('POST', '/auth/login', undefined, { username: 'owner', pin: '849201' })).json(),
  ).token;
  for (let i = 1; i <= registers; i++) {
    await local('POST', '/users', owner, {
      fullName: `Kassir ${i}`,
      username: `kassa${i}`,
      role: 'cashier',
      pin: `58291${i}`,
    });
  }
  expect((await local('PUT', '/stock/policy', owner, { policy: 'block' })).statusCode).toBe(200);
  const product = ProductDetailResponseSchema.parse(
    (
      await local('POST', '/products', owner, { name: 'Non', unit: 'dona', salePrice: '5000' })
    ).json(),
  ).product.id;
  expect(
    (
      await local('POST', '/stock/moves/in', owner, {
        productId: product,
        reason: 'purchase',
        qty: String(stockUnits * 1000),
        totalCostValue: String(stockUnits * 3000),
      })
    ).statusCode,
  ).toBe(201);

  const lan = await hub.listenLan({ host: '127.0.0.1', port: 0 });
  const regs: Register[] = [];
  for (let i = 1; i <= registers; i++) {
    const code = (await local('POST', '/lan/pairing-codes', owner)).json<{ code: string }>().code;
    const creds = await pairWithLanHub({
      target: { host: '127.0.0.1', port: lan.port },
      code,
      terminalName: `Kassa ${i}`,
      nonce: randomBytes(18).toString('base64url'),
    });
    const call: Register['call'] = async (method, p, body) => {
      const res = await pinnedHubRequest(creds.hub, {
        method,
        path: p,
        headers: {
          'x-mezon-terminal': `${creds.terminalId}.${creds.terminalKey}`,
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        ...(body !== undefined ? { body } : {}),
      });
      const json = (res.body ? JSON.parse(res.body) : {}) as { cart: { id: string } };
      return { status: res.status, json };
    };
    let token = '';
    // One cashier session drives every register: per-register drawers need a sync contract
    // change ([ishchi2-savol] in HISOBOT); this test proves stock + receipt numbering only.
    const login = await call('POST', '/auth/login', { username: 'kassa1', pin: '582911' });
    expect(login.status).toBe(200);
    token = LoginResponseSchema.parse(login.json).token;
    regs.push({ creds, token, call });
  }
  return { hub, owner, product, regs, local };
}

let reqSeq = 0;
const reqId = () => `01997400-0000-7000-8000-${(++reqSeq).toString(16).padStart(12, '0')}`;

describe('T4.2 several registers sell in parallel through the LAN hub', () => {
  it('3 registers race for 30 units: exactly 30 receipts, stock 0, receipt numbers 1..30 with no gap', async () => {
    const env = await bootWithRegisters(4201, 3, 30);
    // One business shift for the hub (QAROR: registers share the hub shift, see HISOBOT).
    const open = await env.regs[0].call('POST', '/shifts/open', {
      clientRequestId: reqId(),
      openingCash: '0',
    });
    expect(open.status, JSON.stringify(open.json)).toBe(201);

    const sellOne = async (r: Register) => {
      const cart = await r.call('POST', '/carts', {});
      expect(cart.status).toBe(201);
      const id = cart.json.cart.id;
      const line = await r.call('POST', `/carts/${id}/lines`, {
        kind: 'catalog',
        productId: env.product,
        qty: '1000',
      });
      if (line.status !== 200 && line.status !== 201) return { ok: false, status: line.status };
      const done = await r.call('POST', `/carts/${id}/complete`, {
        clientRequestId: reqId(),
        expectedTotal: '5000',
        payments: [{ method: 'cash', tenderedAmount: '5000' }],
      });
      return { ok: done.status === 200, status: done.status };
    };
    // 12 attempts per register (36 > 30): the block policy must stop exactly the surplus.
    const results = await Promise.all(
      env.regs.map(async (r) => {
        const out = [];
        for (let i = 0; i < 12; i++) out.push(await sellOne(r));
        return out;
      }),
    );
    const flat = results.flat();
    expect(flat.filter((x) => x.ok)).toHaveLength(30);
    expect(flat.filter((x) => !x.ok).every((x) => x.status >= 400 && x.status < 500)).toBe(true);

    const sqlite = env.hub.connection.sqlite;
    const receipts = (
      sqlite.prepare('SELECT receipt_no FROM sales ORDER BY receipt_no').all() as {
        receipt_no: bigint;
      }[]
    ).map((r) => Number(r.receipt_no));
    expect(receipts).toEqual(Array.from({ length: 30 }, (_, i) => i + 1));
    expect(
      sqlite
        .prepare('SELECT qty_on_hand FROM local_stock_balances WHERE product_id = ?')
        .get(env.product),
    ).toEqual({ qty_on_hand: 0n });

    // Every sale is attributed to the register it was rung up on, and the breakdown adds up.
    const perReg = flat.length / 3;
    const breakdown = await env.local(
      'GET',
      `/lan/terminals/sales?fromMs=0&toMs=${Date.now() + 86_400_000}`,
      env.owner,
    );
    expect(breakdown.statusCode, breakdown.body).toBe(200);
    const regs = breakdown.json<{
      registers: {
        terminalId: string | null;
        terminalName: string | null;
        saleCount: number;
        totalFinal: string;
      }[];
    }>().registers;
    expect(regs.map((r) => r.terminalName).sort()).toEqual(['Kassa 1', 'Kassa 2', 'Kassa 3']);
    expect(regs.reduce((s, r) => s + r.saleCount, 0)).toBe(30);
    expect(regs.reduce((s, r) => s + BigInt(r.totalFinal), 0n)).toBe(150_000n);
    for (const [i, r] of env.regs.entries()) {
      const mine = results[i].filter((x) => x.ok).length;
      expect(regs.find((x) => x.terminalId === r.creds.terminalId)?.saleCount).toBe(mine);
      expect(mine).toBeLessThanOrEqual(perReg);
    }
    const sum = sqlite.prepare('SELECT SUM(total_final) AS t FROM sales').get() as { t: bigint };
    expect(sum.t).toBe(150_000n);
  });

  it('a cart opened on the hub computer is attributed to no register (NULL)', async () => {
    const env = await bootWithRegisters(4202, 1, 5);
    const cart = await env.local('POST', '/carts', env.owner, {});
    const id = cart.json<{ cart: { id: string } }>().cart.id;
    const row = env.hub.connection.sqlite
      .prepare('SELECT terminal_id FROM local_carts WHERE id = ?')
      .get(id) as { terminal_id: string | null };
    expect(row.terminal_id).toBeNull();
    const viaLan = await env.regs[0].call('POST', '/carts', {});
    const row2 = env.hub.connection.sqlite
      .prepare('SELECT terminal_id FROM local_carts WHERE id = ?')
      .get(viaLan.json.cart.id) as { terminal_id: string | null };
    expect(row2.terminal_id).toBe(env.regs[0].creds.terminalId);
  });
});
