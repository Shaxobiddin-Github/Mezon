import { spawnSync } from 'node:child_process';
import { generateKeyPairSync, sign as cryptoSign } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  CartResponseSchema,
  CompleteSaleResponseSchema,
  LoginResponseSchema,
  ProductDetailResponseSchema,
} from '@mezon/contracts';
import type { PinHasher } from '@mezon/domain';
import { FakeFiscalDriver } from '@mezon/drivers';
import { FileFakeFiscalLedgerStore } from '@mezon/drivers/node';
import { buildRulesSigningMessage, parseRulesPayload, type TrustedRuleKey } from '@mezon/rules';
import { FixedClock, SeededRandomSource } from '@mezon/test-utils';
import { afterEach, describe, expect, it } from 'vitest';
import { type HubServer, createHubServer } from './index.js';

/**
 * T3.3 crash tests (child process, T1.4 C1 pattern). The FakeFiscalDriver ledger lives in a file,
 * so the "operator" remembers what it accepted after the hub process dies.
 * (a) killed after `sent` is COMMITTED and before the driver call;
 * (b) killed after the driver ACCEPTED but before the reply was written.
 * After restart the worker asks `status()` first: (a) notFound → resubmit once; (b) confirmed →
 * never resubmitted. In both cases submitCount(key) ≤ 1.
 */

const tempDirs: string[] = [];
const TEST_PORT = 47863;
const HOST = `127.0.0.1:${TEST_PORT}`;
const NOW = 1_763_000_000_000n;
const DAY = 86_400_000n;
const fastHasher: PinHasher = {
  hash: (pin) => Promise.resolve(`fast-stub-hash:${pin}`),
  verify: (stored, pin) => Promise.resolve(stored === `fast-stub-hash:${pin}`),
};
const hdr = (t?: string): Record<string, string> =>
  t ? { host: HOST, authorization: `Bearer ${t}` } : { host: HOST };

afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const trusted: TrustedRuleKey = {
  keyId: 'test-k1',
  publicKeyB64: Buffer.from(
    publicKey.export({ type: 'spki', format: 'der' }).subarray(12),
  ).toString('base64'),
  validFromMs: 0n,
  validUntilMs: null,
};

function envelope() {
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
    signature: cryptoSign(null, Buffer.from(msg, 'utf8'), privateKey).toString('base64'),
  };
}

async function open(
  dbPath: string,
  ledger: string,
  seed: number,
  startMs: bigint = NOW,
): Promise<HubServer> {
  return createHubServer({
    dbPath,
    port: TEST_PORT,
    logLevel: 'silent',
    clock: new FixedClock(startMs),
    random: new SeededRandomSource(seed),
    pinHasher: fastHasher,
    trustedRuleKeys: [trusted],
    fiscalDriver: new FakeFiscalDriver({ ledgerStore: new FileFakeFiscalLedgerStore(ledger) }),
    fiscalWorkerOptions: { statusRecheckMs: 0n, minBackoffMs: 0n, maxBackoffMs: 0n },
  });
}

/** Builds a hub with one PENDING sale fiscal doc; returns ids. The hub is closed afterwards. */
async function prepare(seed: number) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mezon-hub-fiscal-crash-'));
  tempDirs.push(dir);
  const dbPath = path.join(dir, 'hub.db');
  const ledger = path.join(dir, 'ledger.json');
  const hub = await open(dbPath, ledger, seed);
  let i = 1;
  const n = () => `01993400-0000-7000-8000-${(seed * 100000 + i++).toString(16).padStart(12, '0')}`;
  try {
    await hub.app.inject({
      method: 'POST',
      url: '/setup',
      headers: hdr(),
      payload: { owner: { fullName: 'Egasi', username: 'owner', pin: '849201' } },
    });
    const owner = LoginResponseSchema.parse(
      (
        await hub.app.inject({
          method: 'POST',
          url: '/auth/login',
          headers: hdr(),
          payload: { username: 'owner', pin: '849201' },
        })
      ).json(),
    ).token;
    await hub.app.inject({
      method: 'POST',
      url: '/rules/package',
      headers: hdr(owner),
      payload: { envelope: envelope() },
    });
    hub.connection.sqlite.prepare('UPDATE local_hub_config SET fiscal_mode_enabled = 1').run();
    const pid = ProductDetailResponseSchema.parse(
      (
        await hub.app.inject({
          method: 'POST',
          url: '/products',
          headers: hdr(owner),
          payload: {
            name: 'Mahsulot',
            unit: 'dona',
            salePrice: '100000',
            mxik: '10101001001000001',
            unlimited: true,
          },
        })
      ).json(),
    ).product.id;
    const shift = await hub.app.inject({
      method: 'POST',
      url: '/shifts/open',
      headers: hdr(owner),
      payload: { clientRequestId: n(), openingCash: '0' },
    });
    expect(shift.statusCode, shift.body).toBe(201);
    await hub.fiscalWorker.runOnce(); // settle the shift-open document
    const cartId = CartResponseSchema.parse(
      (
        await hub.app.inject({ method: 'POST', url: '/carts', headers: hdr(owner), payload: {} })
      ).json(),
    ).cart.id;
    await hub.app.inject({
      method: 'POST',
      url: `/carts/${cartId}/lines`,
      headers: hdr(owner),
      payload: { kind: 'catalog', productId: pid, qty: '1000' },
    });
    const sale = CompleteSaleResponseSchema.parse(
      (
        await hub.app.inject({
          method: 'POST',
          url: `/carts/${cartId}/complete`,
          headers: hdr(owner),
          payload: {
            clientRequestId: n(),
            expectedTotal: '100000',
            payments: [{ method: 'cash', tenderedAmount: '100000' }],
          },
        })
      ).json(),
    ).sale;
    return { dbPath, ledger, saleId: sale.id, dir };
  } finally {
    await hub.close();
  }
}

function writeChild(dir: string): string {
  const here = import.meta.dirname;
  const url = (...p: string[]) => JSON.stringify(pathToFileURL(path.resolve(here, ...p)).href);
  const file = path.join(dir, 'crash-fiscal-worker.mjs');
  fs.writeFileSync(
    file,
    [
      `import { createHubServer } from ${url('..', 'dist', 'index.js')};`,
      `import { FakeFiscalDriver } from ${url('..', '..', '..', 'packages', 'drivers', 'dist', 'index.js')};`,
      `import { FileFakeFiscalLedgerStore } from ${url('..', '..', '..', 'packages', 'drivers', 'dist', 'node', 'index.js')};`,
      `import { FixedClock, SeededRandomSource } from ${url('..', '..', '..', 'packages', 'test-utils', 'dist', 'index.js')};`,
      'const [mode, dbPath, ledger] = process.argv.slice(2);',
      'const driver = new FakeFiscalDriver({',
      '  ledgerStore: new FileFakeFiscalLedgerStore(ledger),',
      "  submitMode: mode === 'b' ? 'throw-after-accept' : 'ok',",
      '  onAcceptedBeforeReply: () => process.exit(43),',
      '});',
      'const hub = await createHubServer({',
      `  dbPath, port: ${TEST_PORT}, logLevel: 'silent', clock: new FixedClock(${NOW.toString()}n),`,
      '  random: new SeededRandomSource(9), fiscalDriver: driver,',
      "  fiscalWorkerOptions: { __afterSentCommitted: () => { if (mode === 'a') process.exit(42); } },",
      '});',
      'await hub.fiscalWorker.runOnce();',
      'process.exit(0);',
    ].join('\n'),
    'utf8',
  );
  return file;
}

const docOf = (hub: HubServer, saleId: string) =>
  hub.connection.sqlite
    .prepare("SELECT status, attempts FROM fiscal_docs WHERE sale_id = ? AND doc_kind = 'sale'")
    .get(saleId) as { status: string; attempts: bigint };

describe('T3.3 crash tests (F1)', () => {
  it('(a) killed after `sent` commit, before the driver: restart → status()=notFound → ONE submit', async () => {
    const p = await prepare(5101);
    const child = spawnSync(process.execPath, [writeChild(p.dir), 'a', p.dbPath, p.ledger], {
      encoding: 'utf8',
      timeout: 60_000,
    });
    expect(child.status, child.stderr).toBe(42);
    const probe = new FakeFiscalDriver({ ledgerStore: new FileFakeFiscalLedgerStore(p.ledger) });
    expect(probe.submitCount(p.saleId)).toBe(0);

    // Restart one minute later (the status re-check is due).
    const hub = await open(p.dbPath, p.ledger, 5102, NOW + 60_000n);
    try {
      expect(docOf(hub, p.saleId).status).toBe('sent'); // durable before the driver call
      await hub.fiscalWorker.runOnce(); // status() → notFound → failed
      expect(docOf(hub, p.saleId).status).toBe('failed');
      await hub.fiscalWorker.runOnce(); // safe resubmit
      expect(docOf(hub, p.saleId).status).toBe('confirmed');
      expect(probe.submitCount(p.saleId)).toBe(1);
    } finally {
      await hub.close();
    }
  });

  it('(b) killed after the driver accepted, before the reply was written: restart → status()=confirmed, NO resubmit', async () => {
    const p = await prepare(5201);
    const child = spawnSync(process.execPath, [writeChild(p.dir), 'b', p.dbPath, p.ledger], {
      encoding: 'utf8',
      timeout: 60_000,
    });
    expect(child.status, child.stderr).toBe(43);
    const probe = new FakeFiscalDriver({ ledgerStore: new FileFakeFiscalLedgerStore(p.ledger) });
    expect(probe.submitCount(p.saleId)).toBe(1);

    const hub = await open(p.dbPath, p.ledger, 5202, NOW + 60_000n);
    try {
      expect(docOf(hub, p.saleId).status).toBe('sent');
      await hub.fiscalWorker.runOnce();
      expect(docOf(hub, p.saleId).status).toBe('confirmed');
      await hub.fiscalWorker.runOnce();
      expect(probe.submitCount(p.saleId)).toBe(1);
    } finally {
      await hub.close();
    }
  });
});
