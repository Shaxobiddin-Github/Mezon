import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  CartResponseSchema,
  LoginResponseSchema,
  ProductDetailResponseSchema,
} from '@mezon/contracts';
import { type PinHasher, epochDaysFromCivilDate } from '@mezon/domain';
import { FixedClock, SeededRandomSource } from '@mezon/test-utils';
import { afterEach, describe, expect, it } from 'vitest';
import {
  type HubWorkerOutgoingMessage,
  type HubWorkerPortLike,
  attachHubWorkerController,
} from './electron-worker.js';
import { createHubServer, type HubServer } from './server.js';
import { readUpdateReadiness } from './update-readiness.js';

const tempDirs: string[] = [];
const PORT = 47871;
const HOST = { host: `127.0.0.1:${PORT}` };
const NOW = epochDaysFromCivilDate('2026-11-18') * 86_400_000n + 6n * 3_600_000n;

const hasher: PinHasher = {
  hash: (pin) => Promise.resolve(`h:${pin}`),
  verify: (stored, pin) => Promise.resolve(stored === `h:${pin}`),
};

afterEach(() => {
  for (const d of tempDirs.splice(0)) {
    fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 });
  }
});

async function makeHub(): Promise<HubServer> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mezon-hub-update-'));
  tempDirs.push(dir);
  return createHubServer({
    dbPath: path.join(dir, 'hub.db'),
    port: PORT,
    clock: new FixedClock(NOW),
    random: new SeededRandomSource(48),
    pinHasher: hasher,
    logLevel: 'warn',
  });
}

/** A cashier with an open shift, a product and an empty cart. */
async function seed(hub: HubServer) {
  let n = 1;
  const req = () => `01990000-0000-7000-8000-${(n++).toString(16).padStart(12, '0')}`;
  await hub.app.inject({
    method: 'POST',
    url: '/setup',
    headers: HOST,
    payload: { owner: { fullName: 'Ega', username: 'ega48', pin: '849201' } },
  });
  const login = async (username: string, pin: string) =>
    LoginResponseSchema.parse(
      (
        await hub.app.inject({
          method: 'POST',
          url: '/auth/login',
          headers: HOST,
          payload: { username, pin },
        })
      ).json(),
    ).token;
  const owner = { ...HOST, authorization: `Bearer ${await login('ega48', '849201')}` };
  await hub.app.inject({
    method: 'POST',
    url: '/users',
    headers: owner,
    payload: { fullName: 'Kassir', username: 'kas48', role: 'cashier', pin: '374829' },
  });
  const cashier = { ...HOST, authorization: `Bearer ${await login('kas48', '374829')}` };
  const product = ProductDetailResponseSchema.parse(
    (
      await hub.app.inject({
        method: 'POST',
        url: '/products',
        headers: owner,
        payload: { name: 'Non', unit: 'dona', unlimited: true, salePrice: '5000', vatRateBp: 0 },
      })
    ).json(),
  ).product;
  const opened = await hub.app.inject({
    method: 'POST',
    url: '/shifts/open',
    headers: cashier,
    payload: { clientRequestId: req(), openingCash: '0' },
  });
  expect(opened.statusCode, opened.body).toBe(201);
  const cart = CartResponseSchema.parse(
    (await hub.app.inject({ method: 'POST', url: '/carts', headers: cashier, payload: {} })).json(),
  ).cart;
  const addLine = async () => {
    const r = await hub.app.inject({
      method: 'POST',
      url: `/carts/${cart.id}/lines`,
      headers: cashier,
      payload: { kind: 'catalog', productId: product.id, variantId: null, qty: '1000' },
    });
    expect(r.statusCode, r.body).toBeLessThan(300);
  };
  const post = (suffix: string, payload: Record<string, unknown> = {}) =>
    hub.app.inject({
      method: 'POST',
      url: `/carts/${cart.id}/${suffix}`,
      headers: cashier,
      payload,
    });
  const complete = () =>
    post('complete', {
      clientRequestId: req(),
      expectedTotal: '5000',
      payments: [{ method: 'cash', tenderedAmount: '5000' }],
    });
  return { addLine, post, complete };
}

describe('@mezon/hub - update readiness (T4.8)', () => {
  it('counts a receipt in progress only while an open cart has lines; parked and completed carts do not block', async () => {
    const hub = await makeHub();
    try {
      const s = await seed(hub);
      // An empty cart is not a receipt in progress.
      expect(readUpdateReadiness(hub.connection)).toMatchObject({ openReceipts: 0, openShifts: 1 });
      await s.addLine();
      expect(readUpdateReadiness(hub.connection).openReceipts).toBe(1);
      expect((await s.post('park')).statusCode).toBeLessThan(300);
      // A parked cart is stored in the database and survives a restart.
      expect(readUpdateReadiness(hub.connection).openReceipts).toBe(0);
      expect((await s.post('resume')).statusCode).toBeLessThan(300);
      expect(readUpdateReadiness(hub.connection).openReceipts).toBe(1);
      const done = await s.complete();
      expect(done.statusCode, done.body).toBe(200);
      expect(readUpdateReadiness(hub.connection)).toMatchObject({ openReceipts: 0, openShifts: 1 });
    } finally {
      await hub.close();
    }
  });

  it('the worker answers over the parent port and backs up only when no receipt is open', async () => {
    const hub = await makeHub();
    const sent: HubWorkerOutgoingMessage[] = [];
    let listener: ((e: { readonly data: unknown }) => void) | null = null;
    const port: HubWorkerPortLike = {
      on: (_e, l) => (listener = l),
      postMessage: (m) => sent.push(m),
    };
    const controller = attachHubWorkerController({
      port,
      createServer: () => Promise.resolve(hub),
      exitProcess: () => undefined,
    });
    const deliver = (data: unknown) => listener?.({ data });
    const answer = async (requestId: string) => {
      for (let i = 0; i < 200; i += 1) {
        const m = sent.find((x) => x.type === 'update-readiness' && x.requestId === requestId);
        if (m) return m as Extract<HubWorkerOutgoingMessage, { type: 'update-readiness' }>;
        await new Promise((r) => setTimeout(r, 10));
      }
      throw new Error(`no answer for ${requestId}`);
    };
    try {
      // Before the hub runs: no readiness, so the update must wait.
      deliver({ type: 'update-prepare', requestId: 'r0', backupIfReady: true, targetVersion: '1' });
      expect(await answer('r0')).toMatchObject({ readiness: null, backupId: null });

      deliver({ type: 'start', dbPath: 'unused', logDir: tempDirs[0], allowedOrigins: [] });
      for (let i = 0; i < 200 && !sent.some((m) => m.type === 'ready'); i += 1) {
        await new Promise((r) => setTimeout(r, 10));
      }
      const s = await seed(hub);
      await s.addLine();
      deliver({ type: 'update-prepare', requestId: 'r1', backupIfReady: true, targetVersion: '2' });
      const busy = await answer('r1');
      expect(busy.readiness?.openReceipts).toBe(1);
      expect(busy.backupId).toBeNull();

      await s.complete();
      deliver({ type: 'update-prepare', requestId: 'r2', backupIfReady: true, targetVersion: '2' });
      const free = await answer('r2');
      expect(free.readiness?.openReceipts).toBe(0);
      expect(free.backupId).toMatch(/^backup-/);
      const backups = hub.backupService.listBackups().map((b) => b.reason);
      expect(backups).toContain('Yangilanishdan oldin (2)');

      // Without backupIfReady nothing is written.
      deliver({
        type: 'update-prepare',
        requestId: 'r3',
        backupIfReady: false,
        targetVersion: '2',
      });
      expect((await answer('r3')).backupId).toBeNull();
    } finally {
      await controller.shutdown();
    }
  });
});
