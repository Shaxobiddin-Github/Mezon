import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';
import {
  ApiErrorEnvelopeSchema,
  CartResponseSchema,
  CompleteSaleResponseSchema,
  LoginResponseSchema,
  ProductDetailResponseSchema,
} from '@mezon/contracts';
import type { PinHasher } from '@mezon/domain';
import { FixedClock, SeededRandomSource } from '@mezon/test-utils';
import { afterEach, describe, expect, it } from 'vitest';
import { createHubLogger, createHubServer } from './index.js';

const tempDirs: string[] = [];
const TEST_PORT = 47836;
const HOST_HEADER = `127.0.0.1:${TEST_PORT}`;

function makeDbPath(name = 'hub-sale.db'): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mezon-hub-sale-'));
  tempDirs.push(dir);
  return path.join(dir, name);
}

function makeFastTestHasher(): PinHasher {
  return {
    hash: (pin) => Promise.resolve(`fast-stub-hash:${pin}`),
    verify: (storedHash, pin) => Promise.resolve(storedHash === `fast-stub-hash:${pin}`),
  };
}

function authHeaders(token: string): Record<string, string> {
  return {
    host: HOST_HEADER,
    authorization: `Bearer ${token}`,
  };
}

function hostHeaders(): Record<string, string> {
  return { host: HOST_HEADER };
}

function collectJsonKeysDeep(value: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) {
      collectJsonKeysDeep(item, out);
    }
  } else if (typeof value === 'object' && value !== null) {
    for (const [k, v] of Object.entries(value)) {
      out.add(k);
      collectJsonKeysDeep(v, out);
    }
  }
  return out;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

describe('@mezon/hub - T1.4 POST /carts/:id/complete, RBAC, 409 details, cost-hiding, C1/C2 & 20-line E2E perf', () => {
  it('completes cash sale via HTTP as cashier, enforces 409/401/403/idempotency/concurrency, hides cost, and passes C1+C2 log audit', async () => {
    const clock = new FixedClock(1_760_000_000_000n);
    const logLines: string[] = [];
    const logStream = new Writable({
      write(chunk, _enc, cb) {
        logLines.push(Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk));
        cb();
      },
    });

    const prevCrashEnv = process.env.MEZON_TEST_CRASH_BEFORE_COMMIT;
    process.env.MEZON_TEST_CRASH_BEFORE_COMMIT = '1';

    const hub = await createHubServer({
      dbPath: makeDbPath(),
      port: TEST_PORT,
      logLevel: 'info',
      logStream,
      clock,
      random: new SeededRandomSource(92),
      pinHasher: makeFastTestHasher(),
    });

    try {
      const ownerPin = '849201';
      const cashierPin = '319482';

      await hub.app.inject({
        method: 'POST',
        url: '/setup',
        headers: hostHeaders(),
        payload: { owner: { fullName: 'Ega T14', username: 'owner14', pin: ownerPin } },
      });

      const ownerLogin = LoginResponseSchema.parse(
        (
          await hub.app.inject({
            method: 'POST',
            url: '/auth/login',
            headers: hostHeaders(),
            payload: { username: 'owner14', pin: ownerPin },
          })
        ).json(),
      );

      await hub.app.inject({
        method: 'POST',
        url: '/users',
        headers: authHeaders(ownerLogin.token),
        payload: {
          fullName: 'Kassir T14',
          username: 'cashier14',
          role: 'cashier',
          pin: cashierPin,
        },
      });

      const cashierLogin = LoginResponseSchema.parse(
        (
          await hub.app.inject({
            method: 'POST',
            url: '/auth/login',
            headers: hostHeaders(),
            payload: { username: 'cashier14', pin: cashierPin },
          })
        ).json(),
      );

      // Owner sets 'block' negative stock policy & creates product with batch cost
      const polRes = await hub.app.inject({
        method: 'PUT',
        url: '/stock/policy',
        headers: authHeaders(ownerLogin.token),
        payload: { policy: 'block' },
      });
      expect(polRes.statusCode).toBe(200);

      const prodRes = ProductDetailResponseSchema.parse(
        (
          await hub.app.inject({
            method: 'POST',
            url: '/products',
            headers: authHeaders(ownerLogin.token),
            payload: {
              name: 'Halva',
              unit: 'dona',
              salePrice: '100000',
              trackBatches: true,
              vatRateBp: 1200,
              mxik: '17049099001000000',
              packageCode: 'PKG9',
            },
          })
        ).json(),
      );

      await hub.app.inject({
        method: 'POST',
        url: '/stock/moves/in',
        headers: authHeaders(ownerLogin.token),
        payload: {
          productId: prodRes.product.id,
          reason: 'purchase',
          qty: '1000', // only 1 in stock
          totalCostValue: '65000',
          batchNumber: 'HAL-1',
        },
      });

      // Unauthenticated request rejected
      const unauthRes = await hub.app.inject({
        method: 'POST',
        url: '/carts/01950000-0000-7000-8000-000000000001/complete',
        headers: hostHeaders(),
        payload: {
          clientRequestId: '01950000-0000-7000-8000-111111111101',
          expectedTotal: '100000',
          payments: [{ method: 'cash', tenderedAmount: '100000' }],
        },
      });
      expect(unauthRes.statusCode).toBe(401);

      // Cashier opens cart & adds 2 units (insufficient in block mode)
      const opened = CartResponseSchema.parse(
        (
          await hub.app.inject({
            method: 'POST',
            url: '/carts',
            headers: authHeaders(cashierLogin.token),
            payload: {},
          })
        ).json(),
      );

      await hub.app.inject({
        method: 'POST',
        url: `/carts/${opened.cart.id}/lines`,
        headers: authHeaders(cashierLogin.token),
        payload: {
          kind: 'catalog',
          productId: prodRes.product.id,
          variantId: null,
          qty: '2000',
        },
      });

      // Stale expectedTotal -> 409 SALE_TOTAL_CHANGED with updated actualTotal
      const staleRes = await hub.app.inject({
        method: 'POST',
        url: `/carts/${opened.cart.id}/complete`,
        headers: authHeaders(cashierLogin.token),
        payload: {
          clientRequestId: '01950000-0000-7000-8000-111111111102',
          expectedTotal: '100000',
          payments: [{ method: 'cash', tenderedAmount: '250000' }],
        },
      });
      expect(staleRes.statusCode).toBe(409);
      const staleBody = ApiErrorEnvelopeSchema.parse(staleRes.json());
      expect(staleBody.error.code).toBe('SALE_TOTAL_CHANGED');
      expect(staleBody.error.details).toMatchObject({
        expectedTotal: '100000',
        actualTotal: '200000',
      });

      // Block shortage -> 409 INSUFFICIENT_STOCK with insufficientLines details & open cart preserved
      const retryReqId = '01950000-0000-7000-8000-111111111103';
      const shortRes = await hub.app.inject({
        method: 'POST',
        url: `/carts/${opened.cart.id}/complete`,
        headers: authHeaders(cashierLogin.token),
        payload: {
          clientRequestId: retryReqId,
          expectedTotal: '200000',
          payments: [{ method: 'cash', tenderedAmount: '250000' }],
        },
      });
      expect(shortRes.statusCode).toBe(409);
      const shortBody = ApiErrorEnvelopeSchema.parse(shortRes.json());
      expect(shortBody.error.code).toBe('INSUFFICIENT_STOCK');
      expect(Array.isArray(shortBody.error.details?.insufficientLines)).toBe(true);

      const cartAfterShort = CartResponseSchema.parse(
        (
          await hub.app.inject({
            method: 'GET',
            url: `/carts/${opened.cart.id}`,
            headers: authHeaders(cashierLogin.token),
          })
        ).json(),
      );
      expect(cartAfterShort.cart.status).toBe('open');

      // Restock +1 and retry with SAME retryReqId (concurrent double-click + alt clientRequestId)
      await hub.app.inject({
        method: 'POST',
        url: '/stock/moves/in',
        headers: authHeaders(ownerLogin.token),
        payload: {
          productId: prodRes.product.id,
          reason: 'purchase',
          qty: '1000',
          totalCostValue: '70000',
          batchNumber: 'HAL-2',
        },
      });

      const [res1, res2, resConflict] = await Promise.all([
        hub.app.inject({
          method: 'POST',
          url: `/carts/${opened.cart.id}/complete`,
          headers: authHeaders(cashierLogin.token),
          payload: {
            clientRequestId: retryReqId,
            expectedTotal: '200000',
            payments: [{ method: 'cash', tenderedAmount: '250000' }],
          },
        }),
        hub.app.inject({
          method: 'POST',
          url: `/carts/${opened.cart.id}/complete`,
          headers: authHeaders(cashierLogin.token),
          payload: {
            clientRequestId: retryReqId,
            expectedTotal: '200000',
            payments: [{ method: 'cash', tenderedAmount: '250000' }],
          },
        }),
        hub.app.inject({
          method: 'POST',
          url: `/carts/${opened.cart.id}/complete`,
          headers: authHeaders(cashierLogin.token),
          payload: {
            clientRequestId: '01950000-0000-7000-8000-111111111199',
            expectedTotal: '200000',
            payments: [{ method: 'cash', tenderedAmount: '250000' }],
          },
        }),
      ]);

      expect(res1.statusCode).toBe(200);
      expect(res2.statusCode).toBe(200);
      expect(resConflict.statusCode).toBe(409);
      expect(ApiErrorEnvelopeSchema.parse(resConflict.json()).error.code).toBe('CART_NOT_OPEN');

      const sale1 = CompleteSaleResponseSchema.parse(res1.json());
      const sale2 = CompleteSaleResponseSchema.parse(res2.json());
      expect(sale1.sale.id).toBe(sale2.sale.id);
      expect(sale1.sale.receiptNo).toBe('1');
      expect(sale1.sale.receiptCode).toMatch(/^[0-9A-F]{4}-000001$/);
      expect(sale1.sale.changeAmount).toBe('50000');

      // Verify warn-mode completes negative stock via HTTP & discount override check enforced at completion
      await hub.app.inject({
        method: 'PUT',
        url: '/stock/policy',
        headers: authHeaders(ownerLogin.token),
        payload: { policy: 'warn' },
      });

      const cartWarn = CartResponseSchema.parse(
        (
          await hub.app.inject({
            method: 'POST',
            url: '/carts',
            headers: authHeaders(cashierLogin.token),
            payload: {},
          })
        ).json(),
      );
      await hub.app.inject({
        method: 'POST',
        url: `/carts/${cartWarn.cart.id}/lines`,
        headers: authHeaders(cashierLogin.token),
        payload: { kind: 'catalog', productId: prodRes.product.id, variantId: null, qty: '1000' },
      });
      // Supervisor approves 20% discount on 100,000 -> overrideApprovedAmount = 20,000
      const discRes1 = await hub.app.inject({
        method: 'PUT',
        url: `/carts/${cartWarn.cart.id}/discount`,
        headers: authHeaders(cashierLogin.token),
        payload: {
          mode: 'percent',
          percentBp: 2000,
          reason: 'VIP',
          override: { username: 'owner14', pin: ownerPin },
        },
      });
      expect(discRes1.statusCode).toBe(200);
      // Grow cart to 200,000 -> 20% = 40,000 > 20,000 -> override revoked; completion must fail 403!
      const cartGrown = CartResponseSchema.parse(
        (
          await hub.app.inject({
            method: 'POST',
            url: `/carts/${cartWarn.cart.id}/lines`,
            headers: authHeaders(cashierLogin.token),
            payload: {
              kind: 'catalog',
              productId: prodRes.product.id,
              variantId: null,
              qty: '1000',
            },
          })
        ).json(),
      );
      expect(cartGrown.cart.discountOverrideRequired).toBe(true);
      const overrideRequiredRes = await hub.app.inject({
        method: 'POST',
        url: `/carts/${cartWarn.cart.id}/complete`,
        headers: authHeaders(cashierLogin.token),
        payload: {
          clientRequestId: '01950000-0000-7000-8000-111111111120',
          expectedTotal: cartGrown.cart.totalFinal,
          payments: [{ method: 'cash', tenderedAmount: cartGrown.cart.totalFinal }],
        },
      });
      expect(overrideRequiredRes.statusCode).toBe(403);
      expect(ApiErrorEnvelopeSchema.parse(overrideRequiredRes.json()).error.code).toBe(
        'DISCOUNT_OVERRIDE_REQUIRED',
      );

      // Re-approve 20% discount with owner PIN, then complete negative stock under 'warn' policy -> 200 + warnings!
      const reapproveHttpRes = await hub.app.inject({
        method: 'PUT',
        url: `/carts/${cartWarn.cart.id}/discount`,
        headers: authHeaders(cashierLogin.token),
        payload: {
          mode: 'percent',
          percentBp: 2000,
          reason: 'VIP re-approved',
          override: { username: 'owner14', pin: ownerPin },
        },
      });
      expect(reapproveHttpRes.statusCode).toBe(200);
      const reapproved = CartResponseSchema.parse(reapproveHttpRes.json());
      const warnCompletedRes = await hub.app.inject({
        method: 'POST',
        url: `/carts/${cartWarn.cart.id}/complete`,
        headers: authHeaders(cashierLogin.token),
        payload: {
          clientRequestId: '01950000-0000-7000-8000-111111111121',
          expectedTotal: reapproved.cart.totalFinal,
          payments: [{ method: 'cash', tenderedAmount: '200000' }],
        },
      });
      expect(warnCompletedRes.statusCode).toBe(200);
      const warnSale = CompleteSaleResponseSchema.parse(warnCompletedRes.json());
      expect(warnSale.sale.receiptNo).toBe('2');
      expect(warnSale.sale.receiptCode).toMatch(/^[0-9A-F]{4}-000002$/);
      expect(warnSale.warnings).toEqual([
        {
          code: 'NEGATIVE_STOCK',
          productId: prodRes.product.id,
          variantId: null,
          deficitQty: '2000',
        },
      ]);

      // Security: ZERO cost/profit/margin keys anywhere in HTTP response JSON
      const keys = collectJsonKeysDeep(res1.json());
      for (const forbiddenKey of [
        'cost',
        'costValue',
        'costPrice',
        'profit',
        'margin',
        'pinHash',
      ]) {
        expect(keys.has(forbiddenKey)).toBe(false);
      }

      // C2 Audit log check: 'sale.completed' present, ZERO PINs, tokens, or cost/profit leaked
      const fullLogText = logLines.join('');
      const parsedLogs = fullLogText
        .trim()
        .split(/\r?\n/)
        .filter((l) => l.length > 0)
        .map((l) => JSON.parse(l) as Record<string, unknown>);
      const saleAuditLogs = parsedLogs.filter((l) => l.event === 'sale.completed');
      expect(saleAuditLogs.length).toBeGreaterThanOrEqual(1);
      expect(fullLogText).not.toContain(ownerPin);
      expect(fullLogText).not.toContain(cashierPin);
      expect(fullLogText).not.toContain(ownerLogin.token);
      expect(fullLogText).not.toContain(cashierLogin.token);
      for (const logObj of saleAuditLogs) {
        const logKeys = collectJsonKeysDeep(logObj);
        for (const k of ['cost', 'costValue', 'costPrice', 'profit', 'margin', 'pin', 'token']) {
          expect(logKeys.has(k)).toBe(false);
        }
      }

      // Prove Pino redact configuration masks PIN, token, cost, costValue, and profit if ever passed
      const redactCaptured: string[] = [];
      const redactingLogger = createHubLogger({
        level: 'info',
        stream: new Writable({
          write(chunk, _enc, cb) {
            redactCaptured.push(Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk));
            cb();
          },
        }),
      });
      redactingLogger.info(
        {
          event: 'sale.completed',
          pin: '319482',
          token: 'secret-bearer-token',
          costValue: '135000',
          cost: '135000',
          profit: '65000',
          nested: { costValue: '135000', profit: '65000', token: 'nested-tok' },
        },
        'redaction check',
      );
      const redactedOut = redactCaptured.join('');
      expect(redactedOut).not.toContain('319482');
      expect(redactedOut).not.toContain('secret-bearer-token');
      expect(redactedOut).not.toContain('135000');
      expect(redactedOut).not.toContain('65000');
      expect(redactedOut).not.toContain('nested-tok');
      expect(redactedOut).toContain('[Redacted]');
    } finally {
      if (prevCrashEnv === undefined) {
        delete process.env.MEZON_TEST_CRASH_BEFORE_COMMIT;
      } else {
        process.env.MEZON_TEST_CRASH_BEFORE_COMMIT = prevCrashEnv;
      }
      await hub.close();
    }
  });

  it('meets <= 300ms HTTP E2E completion target for a 20-line cart on disk WAL SQLite', async () => {
    const clock = new FixedClock(1_760_000_000_000n);
    const hub = await createHubServer({
      dbPath: makeDbPath('hub-perf-20.db'),
      port: TEST_PORT + 1,
      logLevel: 'silent',
      clock,
      random: new SeededRandomSource(93),
      pinHasher: makeFastTestHasher(),
    });

    try {
      const headersHost = { host: `127.0.0.1:${TEST_PORT + 1}` };
      await hub.app.inject({
        method: 'POST',
        url: '/setup',
        headers: headersHost,
        payload: { owner: { fullName: 'Perf Owner', username: 'ownerp', pin: '849201' } },
      });
      const login = LoginResponseSchema.parse(
        (
          await hub.app.inject({
            method: 'POST',
            url: '/auth/login',
            headers: headersHost,
            payload: { username: 'ownerp', pin: '849201' },
          })
        ).json(),
      );
      const authHdr = { ...headersHost, authorization: `Bearer ${login.token}` };

      const cart = CartResponseSchema.parse(
        (
          await hub.app.inject({
            method: 'POST',
            url: '/carts',
            headers: authHdr,
            payload: {},
          })
        ).json(),
      );

      let latestCartTotal = '0';
      for (let i = 0; i < 20; i += 1) {
        const p = ProductDetailResponseSchema.parse(
          (
            await hub.app.inject({
              method: 'POST',
              url: '/products',
              headers: authHdr,
              payload: {
                name: `HTTP Perf ${i + 1}`,
                unit: 'dona',
                trackBatches: i % 2 === 0,
                salePrice: String((i + 1) * 10_000),
              },
            })
          ).json(),
        );
        await hub.app.inject({
          method: 'POST',
          url: '/stock/moves/in',
          headers: authHdr,
          payload: {
            productId: p.product.id,
            reason: 'purchase',
            qty: '5000',
            totalCostValue: String((i + 1) * 30_000),
          },
        });
        const lineAdded = CartResponseSchema.parse(
          (
            await hub.app.inject({
              method: 'POST',
              url: `/carts/${cart.cart.id}/lines`,
              headers: authHdr,
              payload: { kind: 'catalog', productId: p.product.id, variantId: null, qty: '1000' },
            })
          ).json(),
        );
        latestCartTotal = lineAdded.cart.totalFinal;
      }

      const t0 = performance.now();
      const completeRes = await hub.app.inject({
        method: 'POST',
        url: `/carts/${cart.cart.id}/complete`,
        headers: authHdr,
        payload: {
          clientRequestId: '01950000-0000-7000-8000-666666666601',
          expectedTotal: latestCartTotal,
          payments: [{ method: 'cash', tenderedAmount: latestCartTotal }],
        },
      });
      const elapsedMs = performance.now() - t0;

      expect(completeRes.statusCode).toBe(200);
      const parsed = CompleteSaleResponseSchema.parse(completeRes.json());
      expect(parsed.sale.lines.length).toBe(20);
      expect(elapsedMs).toBeLessThanOrEqual(300);
      console.info(
        `[PERF T1.4 HTTP E2E] 20-line POST /carts/:id/complete took ${elapsedMs.toFixed(2)} ms`,
      );
    } finally {
      await hub.close();
    }
  });
});
