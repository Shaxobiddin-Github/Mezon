import { generateKeyPairSync, sign as cryptoSign } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ApiErrorEnvelopeSchema,
  CartResponseSchema,
  CompleteSaleResponseSchema,
  FiscalStatusResponseSchema,
  FiscalUnsettledListResponseSchema,
  LoginResponseSchema,
  PrintDocumentResponseSchema,
  ProductDetailResponseSchema,
  SaleFiscalResponseSchema,
} from '@mezon/contracts';
import type { PinHasher } from '@mezon/domain';
import { FakeFiscalDriver, FakePrinterDriver } from '@mezon/drivers';
import { buildRulesSigningMessage, parseRulesPayload, type TrustedRuleKey } from '@mezon/rules';
import { FixedClock, SeededRandomSource } from '@mezon/test-utils';
import { afterEach, describe, expect, it } from 'vitest';
import { type HubServer, createHubServer } from './index.js';

/**
 * T3.3 fiscal core — hub integration with the FakeFiscalDriver only (§3.3). Rules keys are
 * generated at runtime; MXIK values are synthetic.
 */

const tempDirs: string[] = [];
const TEST_PORT = 47862;
const HOST_HEADER = `127.0.0.1:${TEST_PORT}`;
const NOW = 1_763_000_000_000n;
const DAY = 86_400_000n;
const HOUR = 3_600_000n;

const fastHasher: PinHasher = {
  hash: (pin) => Promise.resolve(`fast-stub-hash:${pin}`),
  verify: (stored, pin) => Promise.resolve(stored === `fast-stub-hash:${pin}`),
};
const hdr = (token?: string): Record<string, string> =>
  token ? { host: HOST_HEADER, authorization: `Bearer ${token}` } : { host: HOST_HEADER };

/**
 * P1: every driver of a test is checked after the test — the fake operator refuses a receipt for a
 * shift that is not open / already closed, so ANY queue-order bug fails every test it touches.
 */
const driversInTest: FakeFiscalDriver[] = [];
afterEach(() => {
  const drivers = driversInTest.splice(0);
  for (const d of drivers) {
    expect(d.shiftOrderViolations(), 'fake operator refused a receipt: shift order broken').toEqual(
      [],
    );
  }
});

afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

const key = (() => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const spki = publicKey.export({ type: 'spki', format: 'der' });
  const trusted: TrustedRuleKey = {
    keyId: 'test-k1',
    publicKeyB64: Buffer.from(spki.subarray(12)).toString('base64'),
    validFromMs: 0n,
    validUntilMs: null,
  };
  return { trusted, privatePem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() };
})();

function signedPackage() {
  const payload = {
    packageVersion: '1',
    issuedAtMs: (NOW - DAY).toString(),
    validUntilMs: (NOW + 365n * DAY).toString(),
    sourceRefs: ['SINTETIK-TEST'],
    cashForbidden: { exact: [], prefixes: [] },
    perMxikCashLimit: null,
    expiredGoods: { enabled: true },
  };
  const msg = buildRulesSigningMessage('test-k1', parseRulesPayload(payload));
  return {
    format: 'mezon-rules',
    formatVersion: 1,
    keyId: 'test-k1',
    payload,
    signature: cryptoSign(null, Buffer.from(msg, 'utf8'), key.privatePem).toString('base64'),
  };
}

const RECEIPT_FIELDS = JSON.stringify([
  { key: 'fiscalSign', label: 'SINTETIK-FB' },
  { key: 'fiscalNumber', label: 'SINTETIK-FD' },
]);

interface Env {
  hub: HubServer;
  clock: FixedClock;
  driver: FakeFiscalDriver;
  owner: string;
  manager: string;
  cashier: string;
  n: () => string;
  dbPath: string;
}

async function boot(
  seed: number,
  opts: {
    fiscal?: boolean;
    driver?: FakeFiscalDriver;
    dbPath?: string;
    setup?: boolean;
    afterSent?: () => void;
    printer?: FakePrinterDriver;
  } = {},
): Promise<Env> {
  let p = opts.dbPath;
  if (p === undefined) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mezon-hub-fiscal-'));
    tempDirs.push(dir);
    p = path.join(dir, 'hub.db');
  }
  const clock = new FixedClock(NOW);
  const driver = opts.driver ?? new FakeFiscalDriver();
  if (!driversInTest.includes(driver)) driversInTest.push(driver);
  const hub = await createHubServer({
    dbPath: p,
    port: TEST_PORT,
    logLevel: 'silent',
    clock,
    random: new SeededRandomSource(seed),
    pinHasher: fastHasher,
    sessionTtlMs: 30n * DAY,
    trustedRuleKeys: [key.trusted],
    fiscalDriver: driver,
    ...(opts.printer ? { printerDriverFactory: () => opts.printer! } : {}),
    fiscalWorkerOptions: {
      statusRecheckMs: 1_000n,
      minBackoffMs: 1_000n,
      maxBackoffMs: 8_000n,
      ...(opts.afterSent ? { __afterSentCommitted: opts.afterSent } : {}),
    },
  });
  let i = 1;
  const n = () => `01993300-0000-7000-8000-${(seed * 100000 + i++).toString(16).padStart(12, '0')}`;
  const setup = opts.setup ?? true;
  if (setup) {
    await hub.app.inject({
      method: 'POST',
      url: '/setup',
      headers: hdr(),
      payload: { owner: { fullName: 'Egasi', username: 'owner', pin: '849201' } },
    });
  }
  const login = async (username: string, pin: string) =>
    LoginResponseSchema.parse(
      (
        await hub.app.inject({
          method: 'POST',
          url: '/auth/login',
          headers: hdr(),
          payload: { username, pin },
        })
      ).json(),
    ).token;
  const owner = await login('owner', '849201');
  if (setup) {
    for (const u of [
      { fullName: 'Menejer', username: 'mgr', role: 'manager', pin: '739104' },
      { fullName: 'Kassir', username: 'kassa', role: 'cashier', pin: '582914' },
    ]) {
      await hub.app.inject({ method: 'POST', url: '/users', headers: hdr(owner), payload: u });
    }
    const imp = await hub.app.inject({
      method: 'POST',
      url: '/rules/package',
      headers: hdr(owner),
      payload: { envelope: signedPackage() },
    });
    expect(imp.statusCode, imp.body).toBe(200);
    hub.connection.sqlite
      .prepare('UPDATE local_hub_config SET fiscal_receipt_fields_json = ?')
      .run(RECEIPT_FIELDS);
    if (opts.fiscal ?? true) setFiscalModeSql(hub, true);
  }
  return {
    hub,
    clock,
    driver,
    owner,
    manager: await login('mgr', '739104'),
    cashier: await login('kassa', '582914'),
    n,
    dbPath: p,
  };
}

function setFiscalModeSql(hub: HubServer, on: boolean) {
  hub.connection.sqlite
    .prepare('UPDATE local_hub_config SET fiscal_mode_enabled = ?')
    .run(on ? 1 : 0);
}

const errCode = (res: { json: () => unknown }) =>
  ApiErrorEnvelopeSchema.parse(res.json()).error.code;

const one = <T>(env: Env, sql: string, ...args: unknown[]): T =>
  env.hub.connection.sqlite.prepare(sql).get(...args) as T;

async function product(env: Env, over: Record<string, unknown> = {}) {
  const res = await env.hub.app.inject({
    method: 'POST',
    url: '/products',
    headers: hdr(env.owner),
    payload: {
      name: `Mahsulot ${env.n().slice(-6)}`,
      unit: 'dona',
      salePrice: '100000',
      mxik: '10101001001000001',
      unlimited: true,
      ...over,
    },
  });
  expect(res.statusCode, res.body).toBe(201);
  return ProductDetailResponseSchema.parse(res.json()).product.id;
}

/** Opens a shift; by default the fiscal shift-open document is confirmed right away. */
async function openShift(env: Env, flush = true, openingCash = '0') {
  const r = await env.hub.app.inject({
    method: 'POST',
    url: '/shifts/open',
    headers: hdr(env.cashier),
    payload: { clientRequestId: env.n(), openingCash },
  });
  expect(r.statusCode, r.body).toBe(201);
  if (flush) await env.hub.fiscalWorker.runOnce();
  return r.json<{ shift: { id: string } }>().shift.id;
}

async function sell(env: Env, productId: string, expectStatus = 200) {
  const cartId = CartResponseSchema.parse(
    (
      await env.hub.app.inject({
        method: 'POST',
        url: '/carts',
        headers: hdr(env.cashier),
        payload: {},
      })
    ).json(),
  ).cart.id;
  const add = await env.hub.app.inject({
    method: 'POST',
    url: `/carts/${cartId}/lines`,
    headers: hdr(env.cashier),
    payload: { kind: 'catalog', productId, qty: '1000' },
  });
  expect(add.statusCode, add.body).toBe(201);
  const res = await env.hub.app.inject({
    method: 'POST',
    url: `/carts/${cartId}/complete`,
    headers: hdr(env.cashier),
    payload: {
      clientRequestId: env.n(),
      expectedTotal: '100000',
      payments: [{ method: 'cash', tenderedAmount: '100000' }],
    },
  });
  expect(res.statusCode, res.body).toBe(expectStatus);
  return res;
}

async function sellOk(env: Env, productId: string) {
  return CompleteSaleResponseSchema.parse((await sell(env, productId)).json()).sale;
}

async function saleFiscal(env: Env, saleId: string) {
  return SaleFiscalResponseSchema.parse(
    (
      await env.hub.app.inject({
        method: 'GET',
        url: `/sales/${saleId}/fiscal`,
        headers: hdr(env.cashier),
      })
    ).json(),
  );
}

async function voidSale(env: Env, saleId: string) {
  return env.hub.app.inject({
    method: 'POST',
    url: `/sales/${saleId}/void`,
    headers: hdr(env.manager),
    payload: { clientRequestId: env.n(), reason: 'Xato chek' },
  });
}

async function returnSale(env: Env, sale: { id: string; lines: readonly { id: string }[] }) {
  const r = await env.hub.app.inject({
    method: 'POST',
    url: `/sales/${sale.id}/returns`,
    headers: hdr(env.manager),
    payload: {
      clientRequestId: env.n(),
      reason: 'Mijoz qaytardi',
      items: [{ saleLineId: sale.lines[0].id, qty: '1000' }],
      payments: [{ method: 'cash', amount: '100000' }],
    },
  });
  expect(r.statusCode, r.body).toBe(201);
  return r.json<{ returnDoc: { id: string } }>().returnDoc.id;
}

async function status(env: Env) {
  return FiscalStatusResponseSchema.parse(
    (
      await env.hub.app.inject({ method: 'GET', url: '/fiscal/status', headers: hdr(env.cashier) })
    ).json(),
  );
}

/** Advance the fixed clock past every backoff and run the worker once. */
async function tick(env: Env, ms = 10_000n) {
  env.clock.advance(ms);
  return env.hub.fiscalWorker.runOnce();
}

describe('T3.3 sale flow: the sale never waits for the driver (§3.2, Variant A)', () => {
  it('fiscal mode → pending doc in the sale tx, NO driver call during the sale; worker confirms once', async () => {
    const env = await boot(4101);
    try {
      const pid = await product(env);
      await openShift(env);
      const base = env.driver.totalSubmitAttempts();
      env.driver.setSubmitMode('offline');
      const sale = await sellOk(env, pid);
      expect(env.driver.totalSubmitAttempts()).toBe(base);
      expect((await saleFiscal(env, sale.id)).doc?.status).toBe('pending');
      env.driver.setSubmitMode('ok');
      await env.hub.fiscalWorker.runOnce();
      const f = await saleFiscal(env, sale.id);
      expect(f.doc?.status).toBe('confirmed');
      expect(f.doc?.fiscalSign).toMatch(/^SINOV-FB-/);
      expect(f.isTestDriver).toBe(true);
      expect(env.driver.submitCount(sale.id)).toBe(1);
      // Outbox carries the fiscal doc events for sync.
      const ev = one<{ n: bigint }>(
        env,
        "SELECT count(*) AS n FROM local_outbox WHERE entity = 'fiscal_docs'",
      ).n;
      expect(ev).toBeGreaterThanOrEqual(3n);
    } finally {
      await env.hub.close();
    }
  });

  it('fiscal mode OFF → no fiscal document at all', async () => {
    const env = await boot(4102, { fiscal: false });
    try {
      const pid = await product(env);
      await openShift(env);
      const sale = await sellOk(env, pid);
      expect((await saleFiscal(env, sale.id)).doc).toBeNull();
      expect(one<{ n: bigint }>(env, 'SELECT count(*) AS n FROM fiscal_docs').n).toBe(0n);
    } finally {
      await env.hub.close();
    }
  });

  it('F6/F9: MXIK-less line in fiscal mode → 422 MXIK_MISSING and NO fiscal doc (full rollback)', async () => {
    const env = await boot(4103);
    try {
      const pid = await product(env, { mxik: null });
      await openShift(env);
      const res = await sell(env, pid, 422);
      expect(errCode(res)).toBe('RULES_BLOCKED');
      expect(res.body).toContain('MXIK_MISSING');
      expect(
        one<{ n: bigint }>(env, "SELECT count(*) AS n FROM fiscal_docs WHERE doc_kind = 'sale'").n,
      ).toBe(0n);
      expect(one<{ n: bigint }>(env, 'SELECT count(*) AS n FROM sales').n).toBe(0n);
      setFiscalModeSql(env.hub, false);
      await sell(env, pid, 200);
    } finally {
      await env.hub.close();
    }
  });
});

describe('T3.3 worker outcomes and the double-fiscalization guard', () => {
  it('reject → rejected (terminal for the driver); listed as unsettled', async () => {
    const env = await boot(4201);
    try {
      const pid = await product(env);
      await openShift(env);
      const sale = await sellOk(env, pid);
      env.driver.setSubmitMode('reject');
      await env.hub.fiscalWorker.runOnce();
      expect((await saleFiscal(env, sale.id)).doc?.status).toBe('rejected');
      await tick(env);
      expect(env.driver.submitCount(sale.id)).toBe(1);
      const list = FiscalUnsettledListResponseSchema.parse(
        (
          await env.hub.app.inject({
            method: 'GET',
            url: '/fiscal/docs',
            headers: hdr(env.manager),
          })
        ).json(),
      );
      expect(list.docs.map((d) => d.status)).toEqual(['rejected']);
    } finally {
      await env.hub.close();
    }
  });

  it('definitelyNotSent → failed → resubmitted later → confirmed (one sign)', async () => {
    const env = await boot(4202);
    try {
      const pid = await product(env);
      await openShift(env);
      const sale = await sellOk(env, pid);
      const base = env.driver.totalSubmitAttempts();
      env.driver.queueSubmitModes('offline');
      await env.hub.fiscalWorker.runOnce();
      const d1 = (await saleFiscal(env, sale.id)).doc;
      expect(d1?.status).toBe('failed');
      expect(d1?.lastErrorCode).toBe('FAKE_OFFLINE');
      await tick(env);
      expect((await saleFiscal(env, sale.id)).doc?.status).toBe('confirmed');
      expect(env.driver.submitCount(sale.id)).toBe(1);
      expect(env.driver.totalSubmitAttempts() - base).toBe(2);
    } finally {
      await env.hub.close();
    }
  });

  it('F2/F12: lost reply (throw-after-accept) stays SENT, status() confirms, submitCount stays 1', async () => {
    const env = await boot(4203);
    try {
      const pid = await product(env);
      await openShift(env);
      const sale = await sellOk(env, pid);
      env.driver.queueSubmitModes('throw-after-accept');
      await env.hub.fiscalWorker.runOnce();
      const d1 = (await saleFiscal(env, sale.id)).doc;
      expect(d1?.status).toBe('sent');
      expect(d1?.lastErrorCode).toBe('FAKE_REPLY_LOST');
      await tick(env);
      await tick(env);
      expect((await saleFiscal(env, sale.id)).doc?.status).toBe('confirmed');
      expect(env.driver.submitCount(sale.id)).toBe(1);
    } finally {
      await env.hub.close();
    }
  });

  it('timeout (never reached the operator) stays SENT, status()=notFound → failed → resubmit → confirmed', async () => {
    const env = await boot(4204);
    try {
      const pid = await product(env);
      await openShift(env);
      const sale = await sellOk(env, pid);
      env.driver.queueSubmitModes('timeout');
      await env.hub.fiscalWorker.runOnce();
      expect((await saleFiscal(env, sale.id)).doc?.status).toBe('sent');
      await tick(env); // status() → notFound → failed
      expect((await saleFiscal(env, sale.id)).doc?.status).toBe('failed');
      await tick(env); // safe resubmit
      expect((await saleFiscal(env, sale.id)).doc?.status).toBe('confirmed');
      expect(env.driver.submitCount(sale.id)).toBe(1);
    } finally {
      await env.hub.close();
    }
  });

  it('status() unreachable keeps the doc SENT (never resubmitted while the outcome is unknown)', async () => {
    const env = await boot(4205);
    try {
      const pid = await product(env);
      await openShift(env);
      const sale = await sellOk(env, pid);
      const base = env.driver.totalSubmitAttempts();
      env.driver.queueSubmitModes('throw-after-accept');
      await env.hub.fiscalWorker.runOnce();
      env.driver.setStatusMode('offline');
      for (let i = 0; i < 4; i += 1) await tick(env);
      expect((await saleFiscal(env, sale.id)).doc?.status).toBe('sent');
      expect(env.driver.totalSubmitAttempts() - base).toBe(1);
      env.driver.setStatusMode('ok');
      await tick(env);
      expect((await saleFiscal(env, sale.id)).doc?.status).toBe('confirmed');
    } finally {
      await env.hub.close();
    }
  });

  it('fix #3: manager "retry" double-click only re-queues; the driver sees ONE submit', async () => {
    const env = await boot(4206);
    try {
      const pid = await product(env);
      await openShift(env);
      const sale = await sellOk(env, pid);
      env.driver.queueSubmitModes('offline');
      await env.hub.fiscalWorker.runOnce();
      const docId = (await saleFiscal(env, sale.id)).doc!.id;
      env.driver.setSubmitMode('ok');
      const [a, b] = await Promise.all([
        env.hub.app.inject({
          method: 'POST',
          url: `/fiscal/docs/${docId}/retry`,
          headers: hdr(env.manager),
        }),
        env.hub.app.inject({
          method: 'POST',
          url: `/fiscal/docs/${docId}/retry`,
          headers: hdr(env.manager),
        }),
      ]);
      expect([a.statusCode, b.statusCode].filter((c) => c === 200).length).toBeGreaterThanOrEqual(
        1,
      );
      await env.hub.fiscalWorker.runOnce();
      await env.hub.fiscalWorker.runOnce();
      expect((await saleFiscal(env, sale.id)).doc?.status).toBe('confirmed');
      expect(env.driver.submitCount(sale.id)).toBe(1);
      // Retry is refused for a non-failed doc and for the cashier.
      const again = await env.hub.app.inject({
        method: 'POST',
        url: `/fiscal/docs/${docId}/retry`,
        headers: hdr(env.manager),
      });
      expect(again.statusCode).toBe(409);
      const cashier = await env.hub.app.inject({
        method: 'POST',
        url: `/fiscal/docs/${docId}/retry`,
        headers: hdr(env.cashier),
      });
      expect(cashier.statusCode).toBe(403);
    } finally {
      await env.hub.close();
    }
  });
});

describe('T3.3 void and refund gates (S2, S3, S5)', () => {
  it('F4 void table: pending/failed/rejected → void ok + cancelled; sent/confirmed → 409', async () => {
    const env = await boot(4301);
    try {
      const pid = await product(env);
      await openShift(env);
      // pending
      const s1 = await sellOk(env, pid);
      expect((await voidSale(env, s1.id)).statusCode).toBe(200);
      expect((await saleFiscal(env, s1.id)).doc?.status).toBe('cancelled');
      // confirmed
      const s2 = await sellOk(env, pid);
      await env.hub.fiscalWorker.runOnce();
      const v2 = await voidSale(env, s2.id);
      expect(v2.statusCode).toBe(409);
      expect(errCode(v2)).toBe('FISCALIZED_SALE_CANNOT_VOID');
      expect((await saleFiscal(env, s2.id)).doc?.status).toBe('confirmed');
      // sent (outcome unknown)
      const s3 = await sellOk(env, pid);
      env.driver.queueSubmitModes('throw-after-accept');
      await env.hub.fiscalWorker.runOnce();
      expect((await saleFiscal(env, s3.id)).doc?.status).toBe('sent');
      expect(errCode(await voidSale(env, s3.id))).toBe('FISCALIZED_SALE_CANNOT_VOID');
      await tick(env); // resolve s3 so it no longer interferes
      // failed
      const s4 = await sellOk(env, pid);
      env.driver.queueSubmitModes('offline');
      await env.hub.fiscalWorker.runOnce();
      expect((await saleFiscal(env, s4.id)).doc?.status).toBe('failed');
      expect((await voidSale(env, s4.id)).statusCode).toBe(200);
      expect((await saleFiscal(env, s4.id)).doc?.status).toBe('cancelled');
      // rejected
      const s5 = await sellOk(env, pid);
      env.driver.queueSubmitModes('reject');
      await env.hub.fiscalWorker.runOnce();
      expect((await saleFiscal(env, s5.id)).doc?.status).toBe('rejected');
      expect((await voidSale(env, s5.id)).statusCode).toBe(200);
      expect((await saleFiscal(env, s5.id)).doc?.status).toBe('cancelled');
      // Cancelled docs are never sent.
      await tick(env);
      expect(env.driver.submitCount(s1.id)).toBe(0);
      expect(env.driver.submitCount(s4.id)).toBe(0);
    } finally {
      await env.hub.close();
    }
  });

  it('S3 queue: return of a PENDING sale is not blocked; the driver sees the sale first, then the refund', async () => {
    const env = await boot(4302);
    try {
      const pid = await product(env);
      await openShift(env);
      env.driver.setSubmitMode('offline');
      const sale = await sellOk(env, pid);
      await env.hub.fiscalWorker.runOnce(); // sale → failed (offline)
      const returnId = await returnSale(env, sale);
      const refund = one<{ status: string; depends_on_doc_id: string }>(
        env,
        'SELECT status, depends_on_doc_id FROM fiscal_docs WHERE return_id = ?',
        returnId,
      );
      expect(refund.status).toBe('pending');
      env.driver.setSubmitMode('ok');
      for (let i = 0; i < 4; i += 1) await tick(env);
      const keys = env.driver.ledgerKeys().filter((k) => !k.includes(':'));
      expect(keys).toEqual([sale.id, returnId]);
      expect(
        one<{ status: string }>(env, 'SELECT status FROM fiscal_docs WHERE return_id = ?', returnId)
          .status,
      ).toBe('confirmed');
      expect(env.driver.submitCount(returnId)).toBe(1);
    } finally {
      await env.hub.close();
    }
  });

  it('S3: refund of a sale whose document ends up rejected is cancelled, never sent', async () => {
    const env = await boot(4303);
    try {
      const pid = await product(env);
      await openShift(env);
      env.driver.setSubmitMode('offline');
      const sale = await sellOk(env, pid);
      const returnId = await returnSale(env, sale);
      env.driver.setSubmitMode('reject');
      for (let i = 0; i < 4; i += 1) await tick(env);
      expect((await saleFiscal(env, sale.id)).doc?.status).toBe('rejected');
      expect(
        one<{ status: string }>(env, 'SELECT status FROM fiscal_docs WHERE return_id = ?', returnId)
          .status,
      ).toBe('cancelled');
      expect(env.driver.submitCount(returnId)).toBe(0);
    } finally {
      await env.hub.close();
    }
  });
});

describe('T3.3 offline window, flags and fiscal mode switch', () => {
  it('F11 / fix #2: the warning follows the OLDEST unsettled doc (one old + many new)', async () => {
    const env = await boot(4401);
    try {
      const pid = await product(env);
      await openShift(env);
      env.driver.setSubmitMode('offline');
      expect((await status(env)).offlineWarning).toBe('none');
      await sellOk(env, pid); // the old one
      env.clock.advance(19n * HOUR);
      for (let i = 0; i < 3; i += 1) await sellOk(env, pid); // fresh ones
      expect((await status(env)).offlineWarning).toBe('approaching');
      env.clock.advance(5n * HOUR + 1n);
      const st = await status(env);
      expect(st.offlineWarning).toBe('expired');
      expect(st.counts.pending).toBe(4);
      // S1 flag OFF (default): expired only warns, sales continue.
      await sellOk(env, pid);
      // S1 flag ON: expired blocks new sales in fiscal mode.
      env.hub.connection.sqlite
        .prepare("UPDATE local_hub_config SET fiscal_offline_expired_action = 'block'")
        .run();
      const blocked = await sell(env, pid, 422);
      expect(errCode(blocked)).toBe('FISCAL_BLOCKED');
      expect(blocked.body).toContain('FISCAL_OFFLINE_EXPIRED');
      // Settling the backlog lifts the block.
      env.driver.setSubmitMode('ok');
      for (let i = 0; i < 3; i += 1) await tick(env);
      expect((await status(env)).offlineWarning).toBe('none');
      await sellOk(env, pid);
    } finally {
      await env.hub.close();
    }
  });

  it('S4 flag: an unconfirmed fiscal shift blocks sales only when the flag is on', async () => {
    const env = await boot(4402);
    try {
      const pid = await product(env);
      env.driver.setSubmitMode('offline');
      const shiftId = await openShift(env, false);
      expect(
        one<{ status: string }>(env, "SELECT status FROM fiscal_docs WHERE doc_kind = 'shift_open'")
          .status,
      ).toBe('pending');
      await sellOk(env, pid);
      env.hub.connection.sqlite
        .prepare("UPDATE local_hub_config SET fiscal_shift_not_open_action = 'block'")
        .run();
      const r = await sell(env, pid, 422);
      expect(r.body).toContain('FISCAL_SHIFT_NOT_OPEN');
      env.driver.setSubmitMode('ok');
      await tick(env);
      expect(
        one<{ status: string }>(
          env,
          "SELECT status FROM fiscal_docs WHERE doc_kind = 'shift_open' AND shift_id = ?",
          shiftId,
        ).status,
      ).toBe('confirmed');
      await sellOk(env, pid);
    } finally {
      await env.hub.close();
    }
  });

  it('fix #4: shift close (Z) goes through the queue, never blocks the shift, never submits twice', async () => {
    const env = await boot(4403);
    try {
      env.driver.setSubmitMode('offline');
      const shiftId = await openShift(env, false);
      const close = await env.hub.app.inject({
        method: 'POST',
        url: `/shifts/${shiftId}/close`,
        headers: hdr(env.cashier),
        payload: { clientRequestId: env.n(), countedCash: '0' },
      });
      expect(close.statusCode, close.body).toBe(200);
      env.driver.setSubmitMode('ok');
      env.driver.queueSubmitModes('throw-after-accept');
      for (let i = 0; i < 5; i += 1) await tick(env);
      const z = `${shiftId}:close`;
      expect(env.driver.submitCount(z)).toBe(1);
      expect(env.driver.submitCount(`${shiftId}:open`)).toBe(1);
      expect(
        one<{ n: bigint }>(env, "SELECT count(*) AS n FROM fiscal_docs WHERE status = 'confirmed'")
          .n,
      ).toBe(2n);
    } finally {
      await env.hub.close();
    }
  });

  it('F10: PUT /fiscal/mode is owner-only and enforces preconditions; every change is applied atomically', async () => {
    const env = await boot(4404, { fiscal: false });
    try {
      const put = (token: string, enabled: boolean) =>
        env.hub.app.inject({
          method: 'PUT',
          url: '/fiscal/mode',
          headers: hdr(token),
          payload: { enabled },
        });
      expect((await put(env.manager, true)).statusCode).toBe(403);
      expect((await put(env.cashier, true)).statusCode).toBe(403);
      await product(env, { mxik: null });
      env.driver.setStatusMode('offline');
      env.hub.connection.sqlite
        .prepare("UPDATE local_hub_config SET fiscal_receipt_fields_json = '[]'")
        .run();
      const bad = await put(env.owner, true);
      expect(bad.statusCode).toBe(422);
      expect(errCode(bad)).toBe('FISCAL_MODE_PRECONDITION_FAILED');
      for (const f of [
        'DRIVER_UNREACHABLE',
        'PRODUCTS_WITHOUT_MXIK',
        'RECEIPT_FIELDS_NOT_CONFIGURED',
      ]) {
        expect(bad.body).toContain(f);
      }
      expect((await status(env)).modeEnabled).toBe(false);
      // Fix every precondition.
      env.driver.setStatusMode('ok');
      env.hub.connection.sqlite
        .prepare('UPDATE local_hub_config SET fiscal_receipt_fields_json = ?')
        .run(RECEIPT_FIELDS);
      env.hub.connection.sqlite.prepare("UPDATE products SET mxik = '10101001001000001'").run();
      const ok = await put(env.owner, true);
      expect(ok.statusCode, ok.body).toBe(200);
      expect((await status(env)).modeEnabled).toBe(true);
      expect((await put(env.owner, false)).statusCode).toBe(200);
      expect((await status(env)).modeEnabled).toBe(false);
    } finally {
      await env.hub.close();
    }
  });

  it('enabling requires a verified rules package in state ok', async () => {
    const env = await boot(4405, { fiscal: false });
    try {
      env.hub.connection.sqlite
        .prepare(
          "UPDATE local_rule_packages SET envelope_json = replace(envelope_json, 'SINTETIK-TEST', 'SINTETIK-XXXX')",
        )
        .run();
      const r = await env.hub.app.inject({
        method: 'PUT',
        url: '/fiscal/mode',
        headers: hdr(env.owner),
        payload: { enabled: true },
      });
      expect(r.statusCode).toBe(422);
      expect(r.body).toContain('RULES_PACKAGE_NOT_OK');
    } finally {
      await env.hub.close();
    }
  });
});

describe('T3.4 fiscal receipt through the real print path', () => {
  it('pending → "FISKAL KUTILMOQDA"; after confirmation the reprint carries the fiscal rows + QR; missing config → incomplete', async () => {
    const printer = new FakePrinterDriver();
    const env = await boot(4501, { printer });
    try {
      const set = await env.hub.app.inject({
        method: 'PATCH',
        url: '/printer/settings',
        headers: hdr(env.owner),
        payload: { mode: 'network_tcp', host: '127.0.0.1', port: 9100 },
      });
      expect(set.statusCode, set.body).toBe(200);
      const pid = await product(env);
      await openShift(env);
      const sale = await sellOk(env, pid);
      const print = async () =>
        PrintDocumentResponseSchema.parse(
          (
            await env.hub.app.inject({
              method: 'POST',
              url: `/sales/${sale.id}/print`,
              headers: hdr(env.cashier),
              payload: { clientRequestId: env.n() },
            })
          ).json(),
        ).printRecord.textPreview;
      const p1 = await print();
      expect(p1).toContain('FISKAL KUTILMOQDA');
      expect(p1).toContain('SINOV');
      expect(p1).not.toContain('FISKAL CHEK');
      await env.hub.fiscalWorker.runOnce();
      const p2 = await print();
      expect(p2).toContain('FISKAL CHEK');
      expect(p2).toContain('SINTETIK-FB:');
      expect(p2).toContain('NUSXA');
      const lastJob = printer.getSentJobs().at(-1)!.bytes;
      // The opaque QR text from the driver is embedded verbatim in the printed bytes.
      expect(Buffer.from(lastJob).includes(Buffer.from(`SINOV|${sale.id}|`))).toBe(true);
      env.hub.connection.sqlite
        .prepare("UPDATE local_hub_config SET fiscal_receipt_fields_json = '[]'")
        .run();
      const p3 = await print();
      expect(p3).toContain("FISKAL MA'LUMOT TO'LIQ EMAS");
      expect(p3).not.toContain('FISKAL CHEK');
    } finally {
      await env.hub.close();
    }
  });
});

describe('T3.3 database guarantees', () => {
  it('F7: a confirmed document without the opaque driver fields is impossible (CHECK), opaque fields never appear before confirmation', async () => {
    const env = await boot(4601);
    try {
      const pid = await product(env);
      await openShift(env);
      const sale = await sellOk(env, pid);
      const docId = (await saleFiscal(env, sale.id)).doc!.id;
      const db = env.hub.connection.sqlite;
      db.prepare(
        "UPDATE fiscal_docs SET status = 'sent', sent_at_ms = 1, attempts = 1 WHERE id = ?",
      ).run(docId);
      expect(() =>
        db
          .prepare("UPDATE fiscal_docs SET status = 'confirmed', confirmed_at_ms = 2 WHERE id = ?")
          .run(docId),
      ).toThrow(/CHECK constraint failed: chk_fiscal_docs_confirmed_fields/);
      expect(() =>
        db
          .prepare(
            "UPDATE fiscal_docs SET status = 'confirmed', confirmed_at_ms = 2, fiscal_sign = 'S', fiscal_number = 'N', qr_payload = '' WHERE id = ?",
          )
          .run(docId),
      ).toThrow(/chk_fiscal_docs_confirmed_fields/);
      expect(() =>
        db.prepare("UPDATE fiscal_docs SET fiscal_sign = 'S' WHERE id = ?").run(docId),
      ).toThrow(/chk_fiscal_docs_confirmed_fields/);
      db.prepare(
        "UPDATE fiscal_docs SET status = 'confirmed', confirmed_at_ms = 2, fiscal_sign = 'S', fiscal_number = 'N', qr_payload = 'Q' WHERE id = ?",
      ).run(docId);
      expect((await saleFiscal(env, sale.id)).doc?.status).toBe('confirmed');
    } finally {
      await env.hub.close();
    }
  });
});

describe('T3.3 S4 owner decision: sales allowed with a warning, strict driver order', () => {
  it('shift not open on the driver → sales proceed (warn), then the driver gets open → receipts → close (Z)', async () => {
    const env = await boot(4701);
    try {
      const pid = await product(env);
      env.driver.setSubmitMode('offline');
      const shiftId = await openShift(env, false);
      await env.hub.fiscalWorker.runOnce(); // shift open fails (driver offline)
      const st = await status(env);
      expect(st.shiftNotOpenAction).toBe('warn');
      expect(st.shiftNotOpenOnDriver).toBe(true);
      const s1 = await sellOk(env, pid);
      const s2 = await sellOk(env, pid);
      const close = await env.hub.app.inject({
        method: 'POST',
        url: `/shifts/${shiftId}/close`,
        headers: hdr(env.cashier),
        payload: { clientRequestId: env.n(), countedCash: '200000' },
      });
      expect(close.statusCode, close.body).toBe(200);
      env.driver.setSubmitMode('ok');
      for (let i = 0; i < 3; i += 1) await tick(env);
      expect(env.driver.ledgerKeys()).toEqual([
        `${shiftId}:open`,
        s1.id,
        s2.id,
        `${shiftId}:close`,
      ]);
      expect((await status(env)).shiftNotOpenOnDriver).toBe(false);
      expect(
        one<{ n: bigint }>(env, "SELECT count(*) AS n FROM fiscal_docs WHERE status <> 'confirmed'")
          .n,
      ).toBe(0n);
    } finally {
      await env.hub.close();
    }
  });
});

describe('T3.3 K1 shift order: receipts after OPEN, Z after the last receipt', () => {
  const closeShift = async (env: Env, shiftId: string, counted: string) => {
    const r = await env.hub.app.inject({
      method: 'POST',
      url: `/shifts/${shiftId}/close`,
      headers: hdr(env.cashier),
      payload: { clientRequestId: env.n(), countedCash: counted },
    });
    expect(r.statusCode, r.body).toBe(200);
  };

  it('a receipt in backoff when the shift closes: the driver still gets open → receipt → close', async () => {
    const env = await boot(4801);
    try {
      const pid = await product(env);
      const shiftId = await openShift(env); // open confirmed
      const sale = await sellOk(env, pid);
      env.driver.queueSubmitModes('offline');
      await env.hub.fiscalWorker.runOnce(); // receipt → failed (backoff)
      expect((await saleFiscal(env, sale.id)).doc?.status).toBe('failed');
      await closeShift(env, shiftId, '100000');
      for (let i = 0; i < 3; i += 1) await tick(env);
      expect(env.driver.ledgerKeys()).toEqual([`${shiftId}:open`, sale.id, `${shiftId}:close`]);
    } finally {
      await env.hub.close();
    }
  });

  it('OPEN rejected → receipts and Z are PARKED (never auto-cancelled, listed), the next shift still flows', async () => {
    const env = await boot(4802);
    try {
      const pid = await product(env);
      env.driver.queueSubmitModes('reject');
      const shift1 = await openShift(env); // the open document is rejected
      const s1 = await sellOk(env, pid);
      await closeShift(env, shift1, '100000');
      const shift2 = await openShift(env, false, '100000');
      const s2 = await sellOk(env, pid);
      for (let i = 0; i < 4; i += 1) await tick(env);
      const d1 = (await saleFiscal(env, s1.id)).doc;
      expect(d1?.status).toBe('pending');
      expect(d1?.lastErrorCode).toBe('FISCAL_SHIFT_NOT_OPENED');
      expect((await saleFiscal(env, s2.id)).doc?.status).toBe('confirmed');
      const keys = env.driver.ledgerKeys();
      expect(keys).toEqual([`${shift1}:open`, `${shift2}:open`, s2.id]);
      expect(keys).not.toContain(s1.id);
      expect(keys).not.toContain(`${shift1}:close`);
      const list = FiscalUnsettledListResponseSchema.parse(
        (
          await env.hub.app.inject({
            method: 'GET',
            url: '/fiscal/docs',
            headers: hdr(env.manager),
          })
        ).json(),
      );
      const parked = list.docs.filter((d) => d.lastErrorCode === 'FISCAL_SHIFT_NOT_OPENED');
      expect(parked.map((d) => d.docKind).sort()).toEqual(['sale', 'shift_close']);
    } finally {
      await env.hub.close();
    }
  });
});

describe('T3.3 K1 no deadlock after a clock correction', () => {
  it('Z created "earlier" than its receipt (clock moved back) waits for it without freezing the queue', async () => {
    const env = await boot(4901);
    try {
      const pid = await product(env);
      const shiftId = await openShift(env);
      env.clock.advance(600_000n);
      const sale = await sellOk(env, pid);
      env.driver.queueSubmitModes('offline');
      await env.hub.fiscalWorker.runOnce(); // receipt → failed (backoff)
      env.clock.set(NOW + 300_000n); // Windows clock correction: back by 5 minutes
      const close = await env.hub.app.inject({
        method: 'POST',
        url: `/shifts/${shiftId}/close`,
        headers: hdr(env.cashier),
        payload: { clientRequestId: env.n(), countedCash: '100000' },
      });
      expect(close.statusCode, close.body).toBe(200);
      await env.hub.fiscalWorker.runOnce(); // Z is due, receipt not yet: Z must wait
      expect(env.driver.submitCount(`${shiftId}:close`)).toBe(0);
      for (let i = 0; i < 80; i += 1) await tick(env);
      expect(env.driver.ledgerKeys()).toEqual([`${shiftId}:open`, sale.id, `${shiftId}:close`]);
    } finally {
      await env.hub.close();
    }
  });
});

describe('T3.3 queue order details', () => {
  it('F15 / S3: a refund waits while its sale document is still in backoff', async () => {
    const env = await boot(5001);
    try {
      const pid = await product(env);
      await openShift(env);
      const sale = await sellOk(env, pid);
      env.driver.queueSubmitModes('offline');
      await env.hub.fiscalWorker.runOnce(); // sale doc → failed, next check in the future
      const returnId = await returnSale(env, sale);
      await env.hub.fiscalWorker.runOnce(); // same instant: only the refund is due
      expect(env.driver.submitCount(returnId)).toBe(0);
      expect(
        one<{ status: string; last_error_code: string | null }>(
          env,
          'SELECT status, last_error_code FROM fiscal_docs WHERE return_id = ?',
          returnId,
        ),
      ).toEqual({ status: 'pending', last_error_code: 'FISCAL_WAITING_DEPENDENCY' });
      for (let i = 0; i < 3; i += 1) await tick(env);
      expect(env.driver.ledgerKeys().filter((k) => !k.includes(':'))).toEqual([sale.id, returnId]);
    } finally {
      await env.hub.close();
    }
  });

  it('S1: independent receipts drain OLDEST first even when an older one was retried', async () => {
    const env = await boot(5002);
    try {
      const pid = await product(env);
      await openShift(env);
      const s1 = await sellOk(env, pid);
      env.driver.queueSubmitModes('offline');
      await env.hub.fiscalWorker.runOnce(); // s1 → failed (backoff)
      const s2 = await sellOk(env, pid);
      const s3 = await sellOk(env, pid);
      await tick(env);
      expect(env.driver.ledgerKeys().filter((k) => !k.includes(':'))).toEqual([
        s1.id,
        s2.id,
        s3.id,
      ]);
    } finally {
      await env.hub.close();
    }
  });
});

describe('P1 a fiscal document is submitted ONLY by the hub that created it', () => {
  it('a document of another hub (arrived by pull) is view-only: never submitted, retry refused', async () => {
    const env = await boot(4901);
    try {
      const pid = await product(env);
      await openShift(env);
      const own = await sellOk(env, pid);
      // A second sale with fiscal mode off has no document; we then give it one "from another
      // hub" exactly as the pull path does (a raw INSERT carrying the creator's device_id).
      setFiscalModeSql(env.hub, false);
      const foreignSale = await sellOk(env, pid);
      const failedSale = await sellOk(env, pid);
      setFiscalModeSql(env.hub, true);
      const foreignDevice = '01993300-0000-7000-8000-0000000f0e1d';
      const ownDocId = (await saleFiscal(env, own.id)).doc!.id;
      const cols =
        'organization_id, store_id, hlc, created_at_ms, updated_at_ms, doc_kind, return_id, shift_id, depends_on_doc_id, attempts, next_check_at_ms, driver_id, offline_deadline_ms';
      const copy = env.hub.connection.sqlite.prepare(
        `INSERT INTO fiscal_docs (id, device_id, sale_id, idempotency_key, status, ${cols})
         SELECT ?, ?, ?, ?, ?, ${cols} FROM fiscal_docs WHERE id = ?`,
      );
      copy.run(env.n(), foreignDevice, foreignSale.id, foreignSale.id, 'pending', ownDocId);
      const failedDocId = env.n();
      copy.run(failedDocId, foreignDevice, failedSale.id, failedSale.id, 'failed', ownDocId);

      for (let i = 0; i < 3; i += 1) await tick(env);

      expect((await saleFiscal(env, own.id)).doc?.status).toBe('confirmed');
      expect(env.driver.submitCount(own.id)).toBe(1);
      expect(env.driver.submitCount(foreignSale.id)).toBe(0);
      expect(env.driver.submitCount(failedSale.id)).toBe(0);
      expect(env.driver.ledgerKeys()).not.toContain(foreignSale.id);
      expect((await saleFiscal(env, foreignSale.id)).doc?.status).toBe('pending');

      const retry = await env.hub.app.inject({
        method: 'POST',
        url: `/fiscal/docs/${failedDocId}/retry`,
        headers: hdr(env.manager),
      });
      expect(retry.statusCode).toBe(409);
      expect(errCode(retry)).toBe('FISCAL_DOC_INVALID_STATE');
      await tick(env);
      expect(env.driver.submitCount(failedSale.id)).toBe(0);
    } finally {
      await env.hub.close();
    }
  });
});

describe('P1 random driver schedules: the operator never sees a broken shift order', () => {
  /** Deterministic PRNG (mulberry32) so every failing seed is reproducible. */
  const prng = (seed: number) => {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  };
  const SUBMIT_MODES = [
    'ok',
    'ok',
    'ok',
    'offline',
    'offline',
    'timeout',
    'throw-after-accept',
  ] as const;

  // Short, random clock steps (shorter than the backoff) are what lets a later document become due
  // while an earlier one still waits — exactly where a missing gate would reorder the operator.
  it.each(Array.from({ length: 16 }, (_, i) => 7001 + i))(
    'seed %i: shifts, sales and refunds under random failures drain in a valid operator order',
    async (seed) => {
      const rnd = prng(seed);
      const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)];
      const env = await boot(seed);
      try {
        const pid = await product(env);
        let shiftId: string | null = null;
        let drawer = 0n;
        const sales: { id: string; lines: readonly { id: string }[] }[] = [];
        const step = async () => {
          if (rnd() < 0.6) {
            env.driver.setSubmitMode(pick(SUBMIT_MODES));
            env.driver.setStatusMode(rnd() < 0.8 ? 'ok' : 'offline');
            env.clock.advance(BigInt(Math.floor(rnd() * 4000)));
            await env.hub.fiscalWorker.runOnce();
          }
        };
        for (let op = 0; op < 18; op += 1) {
          if (shiftId === null) {
            shiftId = await openShift(env, false, drawer.toString());
          } else {
            const r = rnd();
            if (r < 0.5) {
              sales.push(await sellOk(env, pid));
              drawer += 100_000n;
            } else if (r < 0.7 && sales.length > 0) {
              await returnSale(env, sales.splice(Math.floor(rnd() * sales.length), 1)[0]);
              drawer -= 100_000n;
            } else if (r < 0.85) {
              const close = await env.hub.app.inject({
                method: 'POST',
                url: `/shifts/${shiftId}/close`,
                headers: hdr(env.cashier),
                payload: { clientRequestId: env.n(), countedCash: drawer.toString() },
              });
              expect(close.statusCode, close.body).toBe(200);
              shiftId = null;
            }
          }
          await step();
        }
        // Drain: the network comes back for good.
        env.driver.setSubmitMode('ok');
        env.driver.setStatusMode('ok');
        for (let i = 0; i < 40; i += 1) await tick(env);
        const notConfirmed = env.hub.connection.sqlite
          .prepare("SELECT doc_kind, status FROM fiscal_docs WHERE status <> 'confirmed'")
          .all();
        expect(notConfirmed).toEqual([]);
        for (const k of env.driver.ledgerKeys()) expect(env.driver.submitCount(k), k).toBe(1);
        expect(env.driver.shiftOrderViolations()).toEqual([]);
      } finally {
        await env.hub.close();
      }
    },
  );
});

describe('T2.5 restore from a local backup keeps the device identity; fiscal resumes', () => {
  it('a SENT document in the backup is resumed by status() after the restore: one submit, same device_id', async () => {
    const env = await boot(4951);
    let reopened: Env | null = null;
    try {
      const pid = await product(env);
      const shiftId = await openShift(env);
      const sale = await sellOk(env, pid);
      env.driver.queueSubmitModes('throw-after-accept'); // the operator has it, the reply is lost
      await env.hub.fiscalWorker.runOnce();
      expect((await saleFiscal(env, sale.id)).doc?.status).toBe('sent');
      expect(env.driver.submitCount(sale.id)).toBe(1);
      const deviceBefore = one<{ d: string }>(
        env,
        'SELECT device_id AS d FROM local_device_state',
      ).d;

      const backup = await env.hub.app.inject({
        method: 'POST',
        url: '/backups/create',
        headers: hdr(env.owner),
        payload: { reason: 'T2.5 restore test' },
      });
      expect(backup.statusCode, backup.body).toBe(201);
      const backupId = backup.json<{ backup: { id: string } }>().backup.id;
      const close = await env.hub.app.inject({
        method: 'POST',
        url: `/shifts/${shiftId}/close`,
        headers: hdr(env.cashier),
        payload: { clientRequestId: env.n(), countedCash: '100000' },
      });
      expect(close.statusCode, close.body).toBe(200);
      const staged = await env.hub.app.inject({
        method: 'POST',
        url: `/backups/${backupId}/restore`,
        headers: hdr(env.owner),
        payload: { reason: 'T2.5 restore test' },
      });
      expect(staged.statusCode, staged.body).toBe(200);
      await env.hub.close();

      // Restart: the staged restore runs before the hub opens its connections.
      reopened = await boot(4952, { dbPath: env.dbPath, setup: false, driver: env.driver });
      expect(one<{ d: string }>(reopened, 'SELECT device_id AS d FROM local_device_state').d).toBe(
        deviceBefore,
      );
      expect((await saleFiscal(reopened, sale.id)).doc?.status).toBe('sent');
      reopened.clock.advance(60_000n);
      await reopened.hub.fiscalWorker.runOnce();
      const after = (await saleFiscal(reopened, sale.id)).doc;
      expect(after?.status).toBe('confirmed');
      expect(env.driver.submitCount(sale.id)).toBe(1);
    } finally {
      if (reopened) await reopened.hub.close();
      else await env.hub.close().catch(() => undefined);
    }
  });
});
