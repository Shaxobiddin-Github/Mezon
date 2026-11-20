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
import { HubUpdateGate, startsReceiptWork } from './update-gate.js';
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
  const newCart = () =>
    hub.app.inject({ method: 'POST', url: '/carts', headers: cashier, payload: {} });
  const addLineTo = (id: string) =>
    hub.app.inject({
      method: 'POST',
      url: `/carts/${id}/lines`,
      headers: cashier,
      payload: { kind: 'catalog', productId: product.id, variantId: null, qty: '1000' },
    });
  return { addLine, post, complete, newCart, addLineTo };
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

  it('B1: during the pre-update backup no receipt can start; cancel re-opens selling', async () => {
    const hub = await makeHub();
    const sent: HubWorkerOutgoingMessage[] = [];
    let listener: ((e: { readonly data: unknown }) => void) | null = null;
    const controller = attachHubWorkerController({
      port: { on: (_e, l) => (listener = l), postMessage: (m) => sent.push(m) },
      createServer: () => Promise.resolve(hub),
      exitProcess: () => undefined,
    });
    const deliver = (data: unknown) => listener?.({ data });
    const answer = async (requestId: string) => {
      for (let i = 0; i < 300; i += 1) {
        const m = sent.find((x) => x.type === 'update-readiness' && x.requestId === requestId);
        if (m) return m as Extract<HubWorkerOutgoingMessage, { type: 'update-readiness' }>;
        await new Promise((r) => setTimeout(r, 10));
      }
      throw new Error(`no answer for ${requestId}`);
    };
    try {
      deliver({ type: 'start', dbPath: 'unused', logDir: tempDirs[0], allowedOrigins: [] });
      for (let i = 0; i < 200 && !sent.some((m) => m.type === 'ready'); i += 1) {
        await new Promise((r) => setTimeout(r, 10));
      }
      const s = await seed(hub);

      // A slow backup: the gate must already be closed while it runs.
      let release!: () => void;
      const slow = new Promise<void>((r) => (release = r));
      const realBackup = hub.backupService.createBackup.bind(hub.backupService);
      hub.backupService.createBackup = async (p) => {
        await slow;
        return realBackup(p);
      };
      deliver({ type: 'update-prepare', requestId: 'g1', backupIfReady: true, targetVersion: '3' });
      await new Promise((r) => setTimeout(r, 50));
      const during = await s.newCart();
      expect(during.statusCode).toBe(503);
      expect(during.body).toContain('HUB_UPDATING');
      // The existing (empty) cart cannot get a line either.
      expect(
        (await s.post('lines', { kind: 'catalog', productId: 'x', variantId: null, qty: '1000' }))
          .statusCode,
      ).toBe(503);
      release();
      const done = await answer('g1');
      expect(done.backupId).toMatch(/^backup-/);
      expect(done.readiness?.openReceipts).toBe(0);
      // Still closed after the answer, until the installer stops the hub or the update is cancelled.
      expect((await s.newCart()).statusCode).toBe(503);
      deliver({ type: 'update-cancel' });
      await new Promise((r) => setTimeout(r, 20));
      expect((await s.newCart()).statusCode).toBeLessThan(300);

      // A receipt in progress: the gate re-opens at once and no backup is taken.
      await s.addLine();
      deliver({ type: 'update-prepare', requestId: 'g2', backupIfReady: true, targetVersion: '3' });
      const busy = await answer('g2');
      expect(busy.backupId).toBeNull();
      expect((await s.newCart()).statusCode).toBeLessThan(300);

      // Defence in depth: a receipt that appears during the backup by a path the gate does not
      // cover is seen by the re-check after the backup — no install (no backup id).
      await s.complete();
      let release2!: () => void;
      const slow2 = new Promise<void>((r) => (release2 = r));
      hub.backupService.createBackup = async (p) => {
        await slow2;
        return realBackup(p);
      };
      deliver({ type: 'update-prepare', requestId: 'g3', backupIfReady: true, targetVersion: '3' });
      await new Promise((r) => setTimeout(r, 50));
      hub.updateGate.open(); // simulate an uncovered path
      const sneaky = (await s.newCart()).json<{ cart: { id: string } }>().cart.id;
      expect((await s.addLineTo(sneaky)).statusCode).toBeLessThan(300);
      release2();
      const late = await answer('g3');
      expect(late.readiness?.openReceipts).toBe(1);
      expect(late.backupId).toBeNull();
    } finally {
      await controller.shutdown();
    }
  });

  it('the gate refuses only starting or growing a receipt, and opens by itself after its limit', () => {
    expect(startsReceiptWork('POST', '/carts')).toBe(true);
    expect(startsReceiptWork('POST', '/carts/abc/lines')).toBe(true);
    expect(startsReceiptWork('PATCH', '/carts/abc/lines/l1')).toBe(true);
    expect(startsReceiptWork('POST', '/carts/abc/resume')).toBe(true);
    expect(startsReceiptWork('POST', '/carts/abc/marks?x=1')).toBe(true);
    expect(startsReceiptWork('POST', '/carts/abc/complete')).toBe(false);
    expect(startsReceiptWork('POST', '/carts/abc/park')).toBe(false);
    expect(startsReceiptWork('DELETE', '/carts/abc/lines/l1')).toBe(false);
    expect(startsReceiptWork('GET', '/carts')).toBe(false);
    let now = 0;
    const gate = new HubUpdateGate(() => now, 1000);
    gate.close();
    expect(gate.isClosed()).toBe(true);
    now = 999;
    expect(gate.isClosed()).toBe(true);
    now = 1000;
    expect(gate.isClosed()).toBe(false);
  });
});
