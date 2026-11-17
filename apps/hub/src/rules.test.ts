import { generateKeyPairSync, sign as cryptoSign } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ActiveRulesPackageResponseSchema,
  ApiErrorEnvelopeSchema,
  CartResponseSchema,
  CreateBackupResponseSchema,
  ImportRulesPackageResponseSchema,
  LoginResponseSchema,
  OrderActionResponseSchema,
  ProductDetailResponseSchema,
  RulesCheckResponseSchema,
} from '@mezon/contracts';
import type { PinHasher } from '@mezon/domain';
import { buildRulesSigningMessage, parseRulesPayload, type TrustedRuleKey } from '@mezon/rules';
import { FixedClock, SeededRandomSource } from '@mezon/test-utils';
import { afterEach, describe, expect, it } from 'vitest';
import { type HubServer, createHubServer } from './index.js';

/**
 * T3.2a hub integration with REAL Ed25519 (`node:crypto`). Keys are generated at test runtime;
 * nothing secret is committed. Rule data (MXIK lists) is synthetic.
 */

const tempDirs: string[] = [];
const TEST_PORT = 47861;
const HOST_HEADER = `127.0.0.1:${TEST_PORT}`;
const NOW = 1_763_000_000_000n;
const DAY = 86_400_000n;

const fastHasher: PinHasher = {
  hash: (pin) => Promise.resolve(`fast-stub-hash:${pin}`),
  verify: (stored, pin) => Promise.resolve(stored === `fast-stub-hash:${pin}`),
};
const hdr = (token?: string): Record<string, string> =>
  token ? { host: HOST_HEADER, authorization: `Bearer ${token}` } : { host: HOST_HEADER };

afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

interface TestKey {
  readonly trusted: TrustedRuleKey;
  readonly privatePem: string;
}

function makeKey(keyId: string): TestKey {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const spki = publicKey.export({ type: 'spki', format: 'der' });
  return {
    trusted: {
      keyId,
      publicKeyB64: Buffer.from(spki.subarray(12)).toString('base64'),
      validFromMs: 0n,
      validUntilMs: null,
    },
    privatePem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  };
}

function wirePayload(version: number, over: Record<string, unknown> = {}) {
  return {
    packageVersion: String(version),
    issuedAtMs: (NOW - DAY).toString(),
    validUntilMs: (NOW + 30n * DAY).toString(),
    sourceRefs: ['SINTETIK-TEST'],
    cashForbidden: { exact: ['99900000000000001'], prefixes: [] },
    perMxikCashLimit: null,
    expiredGoods: { enabled: true },
    ...over,
  };
}

function signEnvelope(
  payload: Record<string, unknown>,
  signer: TestKey,
  keyId = signer.trusted.keyId,
) {
  const msg = buildRulesSigningMessage(signer.trusted.keyId, parseRulesPayload(payload));
  return {
    format: 'mezon-rules',
    formatVersion: 1,
    keyId,
    payload,
    signature: cryptoSign(null, Buffer.from(msg, 'utf8'), signer.privatePem).toString('base64'),
  };
}

interface Env {
  hub: HubServer;
  dbPath: string;
  owner: string;
  manager: string;
  cashier: string;
  n: () => string;
}

async function boot(
  seed: number,
  trusted: readonly TrustedRuleKey[],
  dbPath?: string,
  setup = true,
): Promise<Env> {
  let p = dbPath;
  if (p === undefined) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mezon-hub-rules-'));
    tempDirs.push(dir);
    p = path.join(dir, 'hub.db');
  }
  const hub = await createHubServer({
    dbPath: p,
    port: TEST_PORT,
    logLevel: 'silent',
    clock: new FixedClock(NOW),
    random: new SeededRandomSource(seed),
    pinHasher: fastHasher,
    trustedRuleKeys: trusted,
  });
  let i = 1;
  const n = () => `01993200-0000-7000-8000-${(seed * 100000 + i++).toString(16).padStart(12, '0')}`;
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
  }
  return {
    hub,
    dbPath: p,
    owner,
    manager: await login('mgr', '739104'),
    cashier: await login('kassa', '582914'),
    n,
  };
}

async function importPkg(env: Env, envelope: unknown, token = env.owner) {
  return env.hub.app.inject({
    method: 'POST',
    url: '/rules/package',
    headers: hdr(token),
    payload: { envelope },
  });
}

const errCode = (res: { json: () => unknown }) =>
  ApiErrorEnvelopeSchema.parse(res.json()).error.code;

async function activeState(env: Env) {
  return ActiveRulesPackageResponseSchema.parse(
    (
      await env.hub.app.inject({
        method: 'GET',
        url: '/rules/package/active',
        headers: hdr(env.cashier),
      })
    ).json(),
  );
}

function setFiscalMode(env: Env, on: boolean) {
  env.hub.connection.sqlite
    .prepare('UPDATE local_hub_config SET fiscal_mode_enabled = ?')
    .run(on ? 1 : 0);
}

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

async function openShift(env: Env) {
  const r = await env.hub.app.inject({
    method: 'POST',
    url: '/shifts/open',
    headers: hdr(env.cashier),
    payload: { clientRequestId: env.n(), openingCash: '0' },
  });
  expect(r.statusCode, r.body).toBe(201);
}

async function cartWith(env: Env, productId: string) {
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
  return cartId;
}

const count = (env: Env, sql: string): bigint =>
  (env.hub.connection.sqlite.prepare(sql).get() as { n: bigint }).n;

describe('T3.2a signed package import (real Ed25519)', () => {
  it('RBAC: cashier cannot import; manager can; active state is readable by cashier', async () => {
    const key = makeKey('test-k1');
    const env = await boot(3201, [key.trusted]);
    try {
      expect((await activeState(env)).state).toBe('missing');
      const env1 = signEnvelope(wirePayload(1), key);
      const denied = await importPkg(env, env1, env.cashier);
      expect(denied.statusCode).toBe(403);
      const ok = await importPkg(env, env1, env.manager);
      expect(ok.statusCode, ok.body).toBe(200);
      expect(ImportRulesPackageResponseSchema.parse(ok.json()).packageVersion).toBe('1');
      const st = await activeState(env);
      expect(st.state).toBe('ok');
      expect(st.packageVersion).toBe('1');
      expect(st.payload?.cashForbidden.exact).toEqual(['99900000000000001']);
    } finally {
      await env.hub.close();
    }
  });

  it('signature attacks are rejected and nothing is stored', async () => {
    const key = makeKey('test-k1');
    const other = makeKey('test-k2');
    const env = await boot(3202, [key.trusted, other.trusted]);
    try {
      const good = signEnvelope(wirePayload(5), key);
      // unsigned
      const { signature: _s, ...unsigned } = good;
      expect((await importPkg(env, unsigned)).statusCode).toBe(400);
      // one payload byte changed after signing
      const tampered = { ...good, payload: { ...good.payload, sourceRefs: ['SINTETIK-TESU'] } };
      expect(errCode(await importPkg(env, tampered))).toBe('RULES_SIGNATURE_INVALID');
      // one signature bit flipped
      const sig = Buffer.from(good.signature, 'base64');
      sig[10] = (sig[10] ?? 0) ^ 0x01;
      expect(errCode(await importPkg(env, { ...good, signature: sig.toString('base64') }))).toBe(
        'RULES_SIGNATURE_INVALID',
      );
      // signed with another (trusted) key but claims key k1
      expect(errCode(await importPkg(env, signEnvelope(wirePayload(5), other, 'test-k1')))).toBe(
        'RULES_SIGNATURE_INVALID',
      );
      // keyId swapped on a valid envelope (keyId is inside the signed text)
      expect(errCode(await importPkg(env, { ...good, keyId: 'test-k2' }))).toBe(
        'RULES_SIGNATURE_INVALID',
      );
      // untrusted key id
      const stranger = makeKey('stranger');
      expect(errCode(await importPkg(env, signEnvelope(wirePayload(5), stranger)))).toBe(
        'RULES_KEY_UNTRUSTED',
      );
      expect(count(env, 'SELECT COUNT(*) AS n FROM local_rule_packages')).toBe(0n);
      expect((await importPkg(env, good)).statusCode).toBe(200);
    } finally {
      await env.hub.close();
    }
  });

  it('rollback protection, idempotent replay, conflict and exactly one active package', async () => {
    const key = makeKey('test-k1');
    const env = await boot(3203, [key.trusted]);
    try {
      const v2 = signEnvelope(wirePayload(2), key);
      expect((await importPkg(env, v2)).statusCode).toBe(200);
      const replay = await importPkg(env, v2);
      expect(replay.statusCode).toBe(200);
      expect(ImportRulesPackageResponseSchema.parse(replay.json()).idempotentReplay).toBe(true);
      expect(errCode(await importPkg(env, signEnvelope(wirePayload(1), key)))).toBe(
        'RULES_PACKAGE_ROLLBACK',
      );
      expect(
        errCode(
          await importPkg(env, signEnvelope(wirePayload(2, { sourceRefs: ['BOSHQA'] }), key)),
        ),
      ).toBe('RULES_PACKAGE_CONFLICT');
      // parallel imports v4 and v3: final active is v4; v3 either rolled back or superseded
      const [r4, r3] = await Promise.all([
        importPkg(env, signEnvelope(wirePayload(4), key)),
        importPkg(env, signEnvelope(wirePayload(3), key)),
      ]);
      expect(r4.statusCode).toBe(200);
      expect([200, 409]).toContain(r3.statusCode);
      expect((await activeState(env)).packageVersion).toBe('4');
      expect(count(env, 'SELECT COUNT(*) AS n FROM local_rule_packages WHERE is_active = 1')).toBe(
        1n,
      );
      expect(errCode(await importPkg(env, signEnvelope(wirePayload(3), key)))).not.toBe(undefined);
    } finally {
      await env.hub.close();
    }
  });

  it('a stored package tampered in the DB is re-verified on load → invalid; fiscal mode then blocks sales', async () => {
    const key = makeKey('test-k1');
    const env = await boot(3204, [key.trusted]);
    try {
      await importPkg(env, signEnvelope(wirePayload(1), key));
      env.hub.connection.sqlite
        .prepare(
          "UPDATE local_rule_packages SET envelope_json = replace(envelope_json, '99900000000000001', '99900000000000002')",
        )
        .run();
      expect((await activeState(env)).state).toBe('invalid');

      const pid = await product(env);
      await openShift(env);
      const cartId = await cartWith(env, pid);
      const pay = {
        clientRequestId: env.n(),
        expectedTotal: '100000',
        payments: [{ method: 'cash', tenderedAmount: '100000' }],
      };
      setFiscalMode(env, true);
      const blocked = await env.hub.app.inject({
        method: 'POST',
        url: `/carts/${cartId}/complete`,
        headers: hdr(env.cashier),
        payload: pay,
      });
      expect(blocked.statusCode).toBe(422);
      expect(errCode(blocked)).toBe('RULES_BLOCKED');
      expect(blocked.body).toContain('PACKAGE_INVALID');
      setFiscalMode(env, false);
      const ok = await env.hub.app.inject({
        method: 'POST',
        url: `/carts/${cartId}/complete`,
        headers: hdr(env.cashier),
        payload: { ...pay, clientRequestId: env.n() },
      });
      expect(ok.statusCode, ok.body).toBe(200);
    } finally {
      await env.hub.close();
    }
  });
});

describe('T3.2a final rules check in every sale path', () => {
  it('fiscal mode + missing package blocks cart complete AND order deliver; off → warn only', async () => {
    const env = await boot(3205, []);
    try {
      const pid = await product(env);
      await openShift(env);
      setFiscalMode(env, true);
      const cartId = await cartWith(env, pid);
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
      expect(res.statusCode).toBe(422);
      expect(res.body).toContain('PACKAGE_MISSING');

      const order = OrderActionResponseSchema.parse(
        (
          await env.hub.app.inject({
            method: 'POST',
            url: '/orders',
            headers: hdr(env.cashier),
            payload: {
              clientRequestId: env.n(),
              customerName: 'Mijoz',
              lines: [{ kind: 'catalog', productId: pid, qty: '1000' }],
            },
          })
        ).json(),
      ).order;
      for (const step of ['confirm', 'ready']) {
        await env.hub.app.inject({
          method: 'POST',
          url: `/orders/${order.id}/${step}`,
          headers: hdr(env.cashier),
          payload: { clientRequestId: env.n() },
        });
      }
      const deliver = await env.hub.app.inject({
        method: 'POST',
        url: `/orders/${order.id}/deliver`,
        headers: hdr(env.cashier),
        payload: {
          clientRequestId: env.n(),
          expectedTotal: '100000',
          payments: [{ method: 'cash', tenderedAmount: '100000' }],
        },
      });
      expect(deliver.statusCode).toBe(422);
      expect(deliver.body).toContain('PACKAGE_MISSING');

      setFiscalMode(env, false);
      const check = RulesCheckResponseSchema.parse(
        (
          await env.hub.app.inject({
            method: 'POST',
            url: `/carts/${cartId}/rules-check`,
            headers: hdr(env.cashier),
            payload: {},
          })
        ).json(),
      );
      expect(check.block).toEqual([]);
      expect(check.warn.map((w) => w.code)).toContain('PACKAGE_MISSING');
    } finally {
      await env.hub.close();
    }
  });

  it('expired batch only WARNS (owner S7): the sale completes and stock is deducted', async () => {
    const env = await boot(3206, []);
    try {
      const pid = await product(env, { unlimited: false, trackBatches: true });
      const inbound = await env.hub.app.inject({
        method: 'POST',
        url: '/stock/moves/in',
        headers: hdr(env.owner),
        payload: {
          productId: pid,
          reason: 'purchase',
          qty: '5000',
          totalCostValue: '250000',
          batchNumber: 'P-1',
          expiryDateMs: (NOW - 2n * DAY).toString(),
        },
      });
      expect(inbound.statusCode, inbound.body).toBe(201);
      await openShift(env);
      setFiscalMode(env, false);
      const cartId = await cartWith(env, pid);
      const res = await env.hub.app.inject({
        method: 'POST',
        url: `/carts/${cartId}/complete`,
        headers: hdr(env.cashier),
        payload: {
          clientRequestId: env.n(),
          expectedTotal: '100000',
          payments: [{ method: 'card', amount: '100000' }],
        },
      });
      expect(res.statusCode, res.body).toBe(200);
      expect(count(env, 'SELECT COUNT(*) AS n FROM sales')).toBe(1n);
      expect(
        count(
          env,
          "SELECT COUNT(*) AS n FROM stock_moves WHERE reason = 'sale' AND batch_id IS NOT NULL",
        ),
      ).toBe(1n);
    } finally {
      await env.hub.close();
    }
  });

  it('cash ban: preview and final return the same code, a direct API call gets 422 with FULL rollback, cashless passes', async () => {
    const key = makeKey('test-k1');
    const env = await boot(3207, [key.trusted]);
    try {
      expect((await importPkg(env, signEnvelope(wirePayload(1), key))).statusCode).toBe(200);
      const banned = await product(env, {
        mxik: '99900000000000001',
        unlimited: false,
        trackBatches: true,
      });
      await env.hub.app.inject({
        method: 'POST',
        url: '/stock/moves/in',
        headers: hdr(env.owner),
        payload: {
          productId: banned,
          reason: 'purchase',
          qty: '5000',
          totalCostValue: '250000',
          batchNumber: 'B-1',
        },
      });
      await openShift(env);
      const cartId = await cartWith(env, banned);
      const cashPayments = [{ method: 'cash', tenderedAmount: '100000' }];
      const check = RulesCheckResponseSchema.parse(
        (
          await env.hub.app.inject({
            method: 'POST',
            url: `/carts/${cartId}/rules-check`,
            headers: hdr(env.cashier),
            payload: { payments: cashPayments },
          })
        ).json(),
      );
      expect(check.block.map((b) => b.code)).toEqual(['CASH_FORBIDDEN_MXIK']);

      const before = {
        sales: count(env, 'SELECT COUNT(*) AS n FROM sales'),
        moves: count(env, 'SELECT COUNT(*) AS n FROM stock_moves'),
        cash: count(env, 'SELECT COUNT(*) AS n FROM cash_moves'),
        outboxFacts: count(
          env,
          "SELECT COUNT(*) AS n FROM local_outbox WHERE entity IN ('sales','sale_lines','payments','stock_moves','cash_moves')",
        ),
        receipt: count(env, 'SELECT last_receipt_seq AS n FROM local_device_state'),
      };
      const direct = await env.hub.app.inject({
        method: 'POST',
        url: `/carts/${cartId}/complete`,
        headers: hdr(env.cashier),
        payload: { clientRequestId: env.n(), expectedTotal: '100000', payments: cashPayments },
      });
      expect(direct.statusCode).toBe(422);
      expect(errCode(direct)).toBe('RULES_BLOCKED');
      const details = ApiErrorEnvelopeSchema.parse(direct.json()).error.details as {
        block: { code: string }[];
      };
      expect(details.block.map((b) => b.code)).toEqual(check.block.map((b) => b.code));
      expect(count(env, 'SELECT COUNT(*) AS n FROM sales')).toBe(before.sales);
      expect(count(env, 'SELECT COUNT(*) AS n FROM stock_moves')).toBe(before.moves);
      expect(count(env, 'SELECT COUNT(*) AS n FROM cash_moves')).toBe(before.cash);
      expect(count(env, 'SELECT last_receipt_seq AS n FROM local_device_state')).toBe(
        before.receipt,
      );
      expect(
        count(
          env,
          "SELECT COUNT(*) AS n FROM local_outbox WHERE entity IN ('sales','sale_lines','payments','stock_moves','cash_moves')",
        ),
      ).toBe(before.outboxFacts);

      const card = await env.hub.app.inject({
        method: 'POST',
        url: `/carts/${cartId}/complete`,
        headers: hdr(env.cashier),
        payload: {
          clientRequestId: env.n(),
          expectedTotal: '100000',
          payments: [{ method: 'card', amount: '100000' }],
        },
      });
      expect(card.statusCode, card.body).toBe(200);
    } finally {
      await env.hub.close();
    }
  });

  it('per-MXIK cash limit from the signed package blocks cart complete AND order deliver; card passes', async () => {
    const key = makeKey('test-k1');
    const env = await boot(3209, [key.trusted]);
    try {
      const limited = wirePayload(1, {
        cashForbidden: { exact: [], prefixes: [] },
        perMxikCashLimit: {
          limitTiyin: '99999', // synthetic: just below the 100000-tiyin product
          appliesTo: 'mxikTotal',
          inclusive: true,
          exempt: { exact: [], prefixes: [] },
        },
      });
      expect((await importPkg(env, signEnvelope(limited, key))).statusCode).toBe(200);
      const pid = await product(env);
      await openShift(env);
      const cartId = await cartWith(env, pid);
      const blocked = await env.hub.app.inject({
        method: 'POST',
        url: `/carts/${cartId}/complete`,
        headers: hdr(env.cashier),
        payload: {
          clientRequestId: env.n(),
          expectedTotal: '100000',
          payments: [{ method: 'cash', tenderedAmount: '100000' }],
        },
      });
      expect(blocked.statusCode).toBe(422);
      expect(blocked.body).toContain('MXIK_CASH_LIMIT');

      const order = OrderActionResponseSchema.parse(
        (
          await env.hub.app.inject({
            method: 'POST',
            url: '/orders',
            headers: hdr(env.cashier),
            payload: {
              clientRequestId: env.n(),
              customerName: 'Mijoz',
              lines: [{ kind: 'catalog', productId: pid, qty: '1000' }],
            },
          })
        ).json(),
      ).order;
      for (const step of ['confirm', 'ready']) {
        await env.hub.app.inject({
          method: 'POST',
          url: `/orders/${order.id}/${step}`,
          headers: hdr(env.cashier),
          payload: { clientRequestId: env.n() },
        });
      }
      const deliver = await env.hub.app.inject({
        method: 'POST',
        url: `/orders/${order.id}/deliver`,
        headers: hdr(env.cashier),
        payload: {
          clientRequestId: env.n(),
          expectedTotal: '100000',
          payments: [{ method: 'cash', tenderedAmount: '100000' }],
        },
      });
      expect(deliver.statusCode).toBe(422);
      expect(deliver.body).toContain('MXIK_CASH_LIMIT');

      const ok = await env.hub.app.inject({
        method: 'POST',
        url: `/carts/${cartId}/complete`,
        headers: hdr(env.cashier),
        payload: {
          clientRequestId: env.n(),
          expectedTotal: '100000',
          payments: [{ method: 'card', amount: '100000' }],
        },
      });
      expect(ok.statusCode, ok.body).toBe(200);
    } finally {
      await env.hub.close();
    }
  });
});

describe('T3.2a rollback protection survives backup restore', () => {
  it('backup at v3, import v5, restore the backup → v4 is still rejected', async () => {
    const key = makeKey('test-k1');
    const env = await boot(3208, [key.trusted]);
    let dbPath = env.dbPath;
    try {
      await importPkg(env, signEnvelope(wirePayload(3), key));
      const backup = CreateBackupResponseSchema.parse(
        (
          await env.hub.app.inject({
            method: 'POST',
            url: '/backups/create',
            headers: hdr(env.owner),
            payload: { reason: 'T3.2 test' },
          })
        ).json(),
      ).backup;
      await importPkg(env, signEnvelope(wirePayload(5), key));
      const staged = await env.hub.app.inject({
        method: 'POST',
        url: `/backups/${backup.id}/restore`,
        headers: hdr(env.owner),
        payload: { reason: 'T3.2 restore' },
      });
      expect(staged.statusCode, staged.body).toBe(200);
      dbPath = env.dbPath;
    } finally {
      await env.hub.close();
    }
    const env2 = await boot(3208, [key.trusted], dbPath, false);
    try {
      expect((await activeState(env2)).packageVersion).toBe('3');
      expect(errCode(await importPkg(env2, signEnvelope(wirePayload(4), key)))).toBe(
        'RULES_PACKAGE_ROLLBACK',
      );
      expect((await importPkg(env2, signEnvelope(wirePayload(6), key))).statusCode).toBe(200);
    } finally {
      await env2.hub.close();
    }
  });
});

describe('T3.2a trustedRuleKeys is test/DI only', () => {
  it('createHubServer throws when trustedRuleKeys is passed under NODE_ENV=production', async () => {
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      await expect(
        createHubServer({
          dbPath: path.join(os.tmpdir(), 'never.db'),
          port: TEST_PORT,
          logLevel: 'silent',
          trustedRuleKeys: [],
        }),
      ).rejects.toThrow(/test\/DI-only/);
    } finally {
      process.env.NODE_ENV = prev;
    }
  });

  it('the Electron worker (production entry) never passes trustedRuleKeys', () => {
    for (const f of ['electron-worker.ts', 'electron-worker-entry.mts']) {
      const src = fs.readFileSync(path.join(import.meta.dirname, f), 'utf8');
      expect(src, f).not.toContain('trustedRuleKeys');
    }
  });
});
