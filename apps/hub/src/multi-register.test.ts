import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LoginResponseSchema, ProductDetailResponseSchema } from '@mezon/contracts';
import type { PinHasher } from '@mezon/domain';
import { FakePrinterDriver, type PrinterConfig } from '@mezon/drivers';
import {
  type PairedTerminalCredentials,
  pairWithLanHub,
  pinnedHubRequest,
} from '@mezon/drivers/node';
import { FixedClock, SeededRandomSource } from '@mezon/test-utils';
import { afterEach, describe, expect, it } from 'vitest';
import { type CreateHubServerOptions, type HubServer, createHubServer } from './index.js';

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

async function bootWithRegisters(
  seed: number,
  registers: number,
  stockUnits: number,
  extra: Partial<CreateHubServerOptions> = {},
) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mezon-mreg-'));
  dirs.push(dir);
  const hub = await createHubServer({
    dbPath: path.join(dir, 'hub.db'),
    port: 47880,
    logLevel: 'silent',
    clock: new FixedClock(BigInt(Date.now())),
    random: new SeededRandomSource(seed),
    pinHasher: fastHasher,
    ...extra,
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

describe('T4.3 every register prints on its own printer and opens its own drawer', () => {
  it('receipts, test prints and drawer pulses go to the register they were asked from', async () => {
    const printers = new Map<string, FakePrinterDriver>();
    const printerAt = (host: string) => {
      let p = printers.get(host);
      if (!p) {
        p = new FakePrinterDriver({ mode: 'network_tcp', target: `${host}:9100` });
        printers.set(host, p);
      }
      return p;
    };
    const env = await bootWithRegisters(4301, 3, 10, {
      printerDriverFactory: (config: PrinterConfig) => printerAt(config.host ?? 'none'),
    });
    const hubPrinter = await env.local('PATCH', '/printer/settings', env.owner, {
      mode: 'network_tcp',
      host: '192.168.1.10',
      cashDrawerAutoOpen: true,
    });
    expect(hubPrinter.statusCode, hubPrinter.body).toBe(200);
    const device = (host: string) => ({
      printer: {
        mode: 'network_tcp',
        printerName: null,
        host,
        port: 9100,
        timeoutMs: 3000,
        paperWidthMm: 80,
        encoding: 'translit',
        cashDrawerAutoOpen: true,
      },
    });
    const [r1, r2, r3] = env.regs as [Register, Register, Register];
    for (const [r, host] of [
      [r1, '192.168.1.11'],
      [r2, '192.168.1.12'],
    ] as const) {
      const put = await env.local(
        'PUT',
        `/lan/terminals/${r.creds.terminalId}/printer`,
        env.owner,
        device(host),
      );
      expect(put.statusCode, put.body).toBe(200);
    }
    // Public address refused; managing printers from a register is refused.
    expect(
      (
        await env.local(
          'PUT',
          `/lan/terminals/${r1.creds.terminalId}/printer`,
          env.owner,
          device('8.8.8.8'),
        )
      ).statusCode,
    ).toBe(400);
    const fromLan = await pinnedHubRequest(r1.creds.hub, {
      method: 'PUT',
      path: `/lan/terminals/${r1.creds.terminalId}/printer`,
      headers: {
        'x-mezon-terminal': `${r1.creds.terminalId}.${r1.creds.terminalKey}`,
        authorization: `Bearer ${env.owner}`,
      },
      body: device('192.168.1.99'),
    });
    expect(fromLan.status).toBe(403);

    expect(
      (await r1.call('POST', '/shifts/open', { clientRequestId: reqId(), openingCash: '0' }))
        .status,
    ).toBe(201);
    const sellAndPrint = async (r: Register) => {
      const cart = await r.call('POST', '/carts', {});
      await r.call('POST', `/carts/${cart.json.cart.id}/lines`, {
        kind: 'catalog',
        productId: env.product,
        qty: '1000',
      });
      const done = await r.call('POST', `/carts/${cart.json.cart.id}/complete`, {
        clientRequestId: reqId(),
        expectedTotal: '5000',
        payments: [{ method: 'cash', tenderedAmount: '5000' }],
      });
      expect(done.status).toBe(200);
      const saleId = (done.json as unknown as { sale: { id: string } }).sale.id;
      const print = await r.call('POST', `/sales/${saleId}/print`, { clientRequestId: reqId() });
      expect(print.status).toBe(200);
      return (
        print.json as unknown as { printRecord: { status: string; printerTarget: string | null } }
      ).printRecord;
    };
    expect(await sellAndPrint(r1)).toMatchObject({
      status: 'printed',
      printerTarget: '192.168.1.11:9100',
    });
    expect(await sellAndPrint(r2)).toMatchObject({
      status: 'printed',
      printerTarget: '192.168.1.12:9100',
    });
    // A register without its own printer never prints on someone else's.
    expect(await sellAndPrint(r3)).toMatchObject({ status: 'disabled', printerTarget: null });
    expect(printers.get('192.168.1.11')?.getSentJobs()).toHaveLength(1);
    expect(printers.get('192.168.1.12')?.getSentJobs()).toHaveLength(1);
    expect(printers.get('192.168.1.10')?.getSentJobs() ?? []).toHaveLength(0);

    // Drawer on register 2 (owner logged in there) → pulse on register 2's printer only.
    const ownerOnR2 = await pinnedHubRequest(r2.creds.hub, {
      method: 'POST',
      path: '/printer/cash-drawer/open',
      headers: {
        'x-mezon-terminal': `${r2.creds.terminalId}.${r2.creds.terminalKey}`,
        authorization: `Bearer ${env.owner}`,
      },
      body: { clientRequestId: reqId(), reason: 'Maydalash' },
    });
    expect(ownerOnR2.status, ownerOnR2.body).toBe(200);
    expect(printers.get('192.168.1.12')?.getSentJobs()).toHaveLength(2);
    expect(printers.get('192.168.1.11')?.getSentJobs()).toHaveLength(1);

    // The hub computer itself still uses the hub printer.
    const hubTest = await env.local('POST', '/printer/test-print', env.owner);
    expect(hubTest.statusCode, hubTest.body).toBe(200);
    expect(printers.get('192.168.1.10')?.getSentJobs()).toHaveLength(1);
  });
});
