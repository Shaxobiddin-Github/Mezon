import { generateKeyPairSync, sign as cryptoSign } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  CartResponseSchema,
  LoginResponseSchema,
  ProductDetailResponseSchema,
} from '@mezon/contracts';
import type { PinHasher } from '@mezon/domain';
import {
  FakeFiscalDriver,
  type FiscalDriver,
  type FiscalStatusResult,
  type FiscalSubmitRequest,
  type FiscalSubmitResult,
} from '@mezon/drivers';
import { buildRulesSigningMessage, parseRulesPayload, type TrustedRuleKey } from '@mezon/rules';
import { FixedClock, SeededRandomSource } from '@mezon/test-utils';
import { afterEach, describe, expect, it } from 'vitest';
import { type HubServer, createHubServer } from './index.js';

/**
 * T3.3 S1 (owner: "the backlog must not freeze the till"). 500 unsettled documents, a slow fake
 * driver (50 ms per call) and 20 sales while the worker drains the queue. Every sale stays within
 * the normal completion budget, the driver is NEVER called inside a SQLite write transaction, and
 * every document ends `confirmed` exactly once.
 */

const tempDirs: string[] = [];
const TEST_PORT = 47864;
const HOST = `127.0.0.1:${TEST_PORT}`;
const NOW = 1_763_000_000_000n;
const DAY = 86_400_000n;
const BACKLOG = 500;
const SALES_DURING_DRAIN = 20;
const P95_BUDGET_MS = 300;

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

/** Wraps the fake driver and records whether any driver call happened inside a write transaction. */
class TxProbeDriver implements FiscalDriver {
  public readonly driverId = 'fake';
  public readonly isTestDriver = true;
  public callsInsideTx = 0;
  public isInTx: () => boolean = () => false;
  public constructor(public readonly inner: FakeFiscalDriver) {}
  public submit(r: FiscalSubmitRequest): Promise<FiscalSubmitResult> {
    if (this.isInTx()) this.callsInsideTx += 1;
    return this.inner.submit(r);
  }
  public status(k: string): Promise<FiscalStatusResult> {
    if (this.isInTx()) this.callsInsideTx += 1;
    return this.inner.status(k);
  }
  public ping(): Promise<void> {
    return this.inner.ping();
  }
}

function p95(samples: readonly number[]): number {
  const s = [...samples].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil(s.length * 0.95) - 1)] ?? 0;
}

describe('T3.3 S1 backlog drain never freezes the till (perf)', () => {
  it(`${String(BACKLOG)} unsettled docs + 50 ms driver: ${String(SALES_DURING_DRAIN)} sales during the drain stay p95 < ${String(P95_BUDGET_MS)} ms; all confirmed once`, async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mezon-hub-fiscal-perf-'));
    tempDirs.push(dir);
    const fake = new FakeFiscalDriver({ latencyMs: 50 });
    const probe = new TxProbeDriver(fake);
    const hub: HubServer = await createHubServer({
      dbPath: path.join(dir, 'hub.db'),
      port: TEST_PORT,
      logLevel: 'silent',
      clock: new FixedClock(NOW),
      random: new SeededRandomSource(6101),
      pinHasher: fastHasher,
      sessionTtlMs: 30n * DAY,
      trustedRuleKeys: [trusted],
      fiscalDriver: probe,
      fiscalWorkerOptions: { statusRecheckMs: 0n, minBackoffMs: 0n, maxBackoffMs: 0n },
    });
    probe.isInTx = () => hub.connection.sqlite.inTransaction;
    let i = 1;
    const n = () => `01993500-0000-7000-8000-${(610100000 + i++).toString(16).padStart(12, '0')}`;
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

      /** One full sale; returns the completion request time (ms), like `sale.perf.test.ts`. */
      const sale = async (): Promise<number> => {
        const cartId = CartResponseSchema.parse(
          (
            await hub.app.inject({
              method: 'POST',
              url: '/carts',
              headers: hdr(owner),
              payload: {},
            })
          ).json(),
        ).cart.id;
        await hub.app.inject({
          method: 'POST',
          url: `/carts/${cartId}/lines`,
          headers: hdr(owner),
          payload: { kind: 'catalog', productId: pid, qty: '1000' },
        });
        const t0 = performance.now();
        const res = await hub.app.inject({
          method: 'POST',
          url: `/carts/${cartId}/complete`,
          headers: hdr(owner),
          payload: {
            clientRequestId: n(),
            expectedTotal: '100000',
            payments: [{ method: 'cash', tenderedAmount: '100000' }],
          },
        });
        const ms = performance.now() - t0;
        expect(res.statusCode, res.body).toBe(200);
        return ms;
      };

      // Baseline with an empty queue.
      while (hub.fiscalStore.headUnsettledSync() !== null) await hub.fiscalWorker.runOnce();
      const baseline: number[] = [];
      for (let k = 0; k < SALES_DURING_DRAIN; k += 1) baseline.push(await sale());
      while (hub.fiscalStore.headUnsettledSync() !== null) await hub.fiscalWorker.runOnce();

      // Offline period: the backlog builds up (the worker is not running).
      for (let k = 0; k < BACKLOG; k += 1) await sale();
      const count = (sql: string) => (hub.connection.sqlite.prepare(sql).get() as { n: bigint }).n;
      expect(count("SELECT count(*) AS n FROM fiscal_docs WHERE status = 'pending'")).toBe(
        BigInt(BACKLOG),
      );

      // Internet is back: drain in the background while the till keeps selling.
      const drain = (async () => {
        while (hub.fiscalStore.headUnsettledSync() !== null) await hub.fiscalWorker.runOnce();
      })();
      await new Promise((r) => setTimeout(r, 300));
      const confirmedBefore = count(
        "SELECT count(*) AS n FROM fiscal_docs WHERE status = 'confirmed'",
      );
      const during: number[] = [];
      for (let k = 0; k < SALES_DURING_DRAIN; k += 1) during.push(await sale());
      const pendingAfterSales = count(
        "SELECT count(*) AS n FROM fiscal_docs WHERE status IN ('pending', 'sent', 'failed')",
      );
      await drain;

      console.info(
        `[PERF T3.3 S1] baseline p95=${p95(baseline).toFixed(1)} ms | during drain p95=${p95(during).toFixed(1)} ms max=${Math.max(...during).toFixed(1)} ms | drain still had ${pendingAfterSales.toString()} docs after the sales`,
      );
      // The sales really happened while the backlog was draining.
      expect(pendingAfterSales).toBeGreaterThan(0n);
      expect(confirmedBefore).toBeLessThan(BigInt(BACKLOG));
      expect(p95(during)).toBeLessThan(P95_BUDGET_MS);
      // The driver is never called inside a SQLite write transaction.
      expect(probe.callsInsideTx).toBe(0);
      // Nothing lost, nothing doubled.
      const total = count('SELECT count(*) AS n FROM fiscal_docs');
      expect(count("SELECT count(*) AS n FROM fiscal_docs WHERE status = 'confirmed'")).toBe(total);
      expect(BigInt(fake.ledgerKeys().length)).toBe(total);
      expect(fake.ledgerKeys().every((k) => fake.submitCount(k) === 1)).toBe(true);
    } finally {
      await hub.close();
    }
  }, 300_000);
});
