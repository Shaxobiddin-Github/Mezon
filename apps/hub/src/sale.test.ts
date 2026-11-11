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
import { MAX_MONEY_TIYIN, type PinHasher } from '@mezon/domain';
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

      const shiftOpenRes = await hub.app.inject({
        method: 'POST',
        url: '/shifts/open',
        headers: authHeaders(cashierLogin.token),
        payload: {
          clientRequestId: '01950000-0000-7000-8000-1400000000a1',
          openingCash: '0',
        },
      });
      expect(shiftOpenRes.statusCode).toBe(201);

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

  it('T1.5 HTTP E2E: mixed payments, manager completedByUserId, idempotency hash, zero-total, M3/M4/M5 exact 400 codes & 0 DB writes', async () => {
    const logLines: string[] = [];
    const clock = new FixedClock(1_760_000_000_000n);
    const hub = await createHubServer({
      dbPath: makeDbPath('hub-t15.db'),
      port: TEST_PORT + 2,
      logLevel: 'info',
      logStream: new Writable({
        write(chunk, _enc, cb) {
          logLines.push(Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk));
          cb();
        },
      }),
      clock,
      random: new SeededRandomSource(94),
      pinHasher: makeFastTestHasher(),
    });
    const hostHdr = `127.0.0.1:${TEST_PORT + 2}`;
    const hdrs = (tok?: string) =>
      tok ? { host: hostHdr, authorization: `Bearer ${tok}` } : { host: hostHdr };

    const countRows = () => ({
      sales: (
        hub.connection.sqlite.prepare('SELECT COUNT(*) as c FROM "sales"').get() as { c: bigint }
      ).c,
      payments: (
        hub.connection.sqlite.prepare('SELECT COUNT(*) as c FROM "payments"').get() as { c: bigint }
      ).c,
      cashMoves: (
        hub.connection.sqlite.prepare('SELECT COUNT(*) as c FROM "cash_moves"').get() as {
          c: bigint;
        }
      ).c,
      outbox: (
        hub.connection.sqlite.prepare('SELECT COUNT(*) as c FROM "local_outbox"').get() as {
          c: bigint;
        }
      ).c,
    });

    try {
      await hub.app.inject({
        method: 'POST',
        url: '/setup',
        headers: hdrs(),
        payload: { owner: { fullName: 'T15 Owner', username: 'owner15', pin: '849201' } },
      });
      const ownerLogin = LoginResponseSchema.parse(
        (
          await hub.app.inject({
            method: 'POST',
            url: '/auth/login',
            headers: hdrs(),
            payload: { username: 'owner15', pin: '849201' },
          })
        ).json(),
      );
      await hub.app.inject({
        method: 'POST',
        url: '/users',
        headers: hdrs(ownerLogin.token),
        payload: { fullName: 'T15 Cashier', username: 'cashier15', role: 'cashier', pin: '319482' },
      });
      await hub.app.inject({
        method: 'POST',
        url: '/users',
        headers: hdrs(ownerLogin.token),
        payload: { fullName: 'T15 Manager', username: 'manager15', role: 'manager', pin: '618394' },
      });
      const cashierLogin = LoginResponseSchema.parse(
        (
          await hub.app.inject({
            method: 'POST',
            url: '/auth/login',
            headers: hdrs(),
            payload: { username: 'cashier15', pin: '319482' },
          })
        ).json(),
      );
      const managerLogin = LoginResponseSchema.parse(
        (
          await hub.app.inject({
            method: 'POST',
            url: '/auth/login',
            headers: hdrs(),
            payload: { username: 'manager15', pin: '618394' },
          })
        ).json(),
      );

      const shiftOpen15 = await hub.app.inject({
        method: 'POST',
        url: '/shifts/open',
        headers: hdrs(cashierLogin.token),
        payload: {
          clientRequestId: '01950000-0000-7000-8000-1500000000a1',
          openingCash: '0',
        },
      });
      expect(shiftOpen15.statusCode).toBe(201);

      const prodRes = ProductDetailResponseSchema.parse(
        (
          await hub.app.inject({
            method: 'POST',
            url: '/products',
            headers: hdrs(ownerLogin.token),
            payload: {
              name: 'Non T15',
              unit: 'dona',
              trackBatches: false,
              salePrice: '50000',
            },
          })
        ).json(),
      );
      await hub.app.inject({
        method: 'POST',
        url: '/stock/moves/in',
        headers: hdrs(ownerLogin.token),
        payload: {
          productId: prodRes.product.id,
          reason: 'initial',
          qty: '100000',
          totalCostValue: '2000000',
        },
      });

      // 1) Cashier opens cart (2 * 50_000 = 100_000); MANAGER closes with 2x card + uzqr + cash w/ change
      const cart1 = CartResponseSchema.parse(
        (
          await hub.app.inject({
            method: 'POST',
            url: '/carts',
            headers: hdrs(cashierLogin.token),
            payload: {},
          })
        ).json(),
      );
      const cart1Added = CartResponseSchema.parse(
        (
          await hub.app.inject({
            method: 'POST',
            url: `/carts/${cart1.cart.id}/lines`,
            headers: hdrs(cashierLogin.token),
            payload: {
              kind: 'catalog',
              productId: prodRes.product.id,
              variantId: null,
              qty: '2000',
            },
          })
        ).json(),
      );
      expect(cart1Added.cart.totalFinal).toBe('100000');

      const mixedReqId = '01950000-0000-7000-8000-f10000000001';
      const mixedPayload = {
        clientRequestId: mixedReqId,
        expectedTotal: '100000',
        payments: [
          { method: 'card', amount: '20000', providerRef: '  CARD-A  ' },
          { method: 'card', amount: '15000', providerRef: 'CARD-B' },
          { method: 'uzqr', amount: '25000', providerRef: 'QR-1' },
          // Remaining for cash = 40_000; tendered 50_000 -> change 10_000
          { method: 'cash', tenderedAmount: '50000' },
        ],
      };

      const resMixed = await hub.app.inject({
        method: 'POST',
        url: `/carts/${cart1.cart.id}/complete`,
        headers: hdrs(managerLogin.token),
        payload: mixedPayload,
      });
      expect(resMixed.statusCode).toBe(200);
      const completed1 = CompleteSaleResponseSchema.parse(resMixed.json());
      expect(completed1.sale.cashierUserId).toBe(cashierLogin.user.id);
      expect(completed1.sale.completedByUserId).toBe(managerLogin.user.id);
      expect(completed1.sale.totalPaid).toBe('100000');
      expect(completed1.sale.debtAmount).toBe('0');
      expect(completed1.sale.changeAmount).toBe('10000');
      expect(completed1.sale.payments).toHaveLength(4);
      expect(completed1.sale.payments[0]?.providerRef).toBe('CARD-A');
      expect(completed1.sale.payments[3]?.amount).toBe('40000');
      expect(await hub.saleStore.getTerminalCashBalance()).toBe(40_000n);

      // Security: ZERO cost/profit keys in response or logs
      const keys1 = collectJsonKeysDeep(resMixed.json());
      for (const k of ['cost', 'costValue', 'costPrice', 'profit', 'margin', 'requestHash']) {
        expect(keys1.has(k)).toBe(false);
      }

      // 2) Identical idempotent replay -> 200 same sale; changed payments with same clientRequestId -> 409 IDEMPOTENCY_CONFLICT
      const replayRes = await hub.app.inject({
        method: 'POST',
        url: `/carts/${cart1.cart.id}/complete`,
        headers: hdrs(managerLogin.token),
        payload: {
          ...mixedPayload,
          payments: [
            { method: 'card', amount: '20000', providerRef: 'CARD-A' },
            ...mixedPayload.payments.slice(1),
          ],
        },
      });
      expect(replayRes.statusCode).toBe(200);
      expect(CompleteSaleResponseSchema.parse(replayRes.json()).sale.id).toBe(completed1.sale.id);

      const snapAfterMixed = countRows();
      const conflictRes = await hub.app.inject({
        method: 'POST',
        url: `/carts/${cart1.cart.id}/complete`,
        headers: hdrs(managerLogin.token),
        payload: {
          ...mixedPayload,
          payments: [
            { method: 'payme', amount: '20000', providerRef: 'CARD-A' },
            ...mixedPayload.payments.slice(1),
          ],
        },
      });
      expect(conflictRes.statusCode).toBe(409);
      expect(ApiErrorEnvelopeSchema.parse(conflictRes.json()).error.code).toBe(
        'IDEMPOTENCY_CONFLICT',
      );
      expect(countRows()).toEqual(snapAfterMixed);

      // 3) Open cart 2 (1 * 50_000) to test M3, M4, M5 HTTP validation errors & 0 DB writes
      const cart2 = CartResponseSchema.parse(
        (
          await hub.app.inject({
            method: 'POST',
            url: '/carts',
            headers: hdrs(cashierLogin.token),
            payload: {},
          })
        ).json(),
      );
      await hub.app.inject({
        method: 'POST',
        url: `/carts/${cart2.cart.id}/lines`,
        headers: hdrs(cashierLogin.token),
        payload: {
          kind: 'catalog',
          productId: prodRes.product.id,
          variantId: null,
          qty: '1000',
        },
      });

      // M3: debt > 0 -> 400 CUSTOMER_REQUIRED; unknown customerId -> 404 CUSTOMER_NOT_FOUND; 0 DB writes
      const snapBeforeErrors = countRows();
      const debtRes = await hub.app.inject({
        method: 'POST',
        url: `/carts/${cart2.cart.id}/complete`,
        headers: hdrs(cashierLogin.token),
        payload: {
          clientRequestId: '01950000-0000-7000-8000-f10000000010',
          expectedTotal: '50000',
          debtAmount: '10000',
          payments: [{ method: 'card', amount: '40000' }],
        },
      });
      expect(debtRes.statusCode).toBe(400);
      expect(ApiErrorEnvelopeSchema.parse(debtRes.json()).error.code).toBe('CUSTOMER_REQUIRED');
      expect(countRows()).toEqual(snapBeforeErrors);

      const custRes = await hub.app.inject({
        method: 'POST',
        url: `/carts/${cart2.cart.id}/complete`,
        headers: hdrs(cashierLogin.token),
        payload: {
          clientRequestId: '01950000-0000-7000-8000-f10000000011',
          expectedTotal: '50000',
          customerId: '01950000-0000-7000-8000-c00000000099',
          payments: [{ method: 'cash', tenderedAmount: '50000' }],
        },
      });
      expect(custRes.statusCode).toBe(404);
      expect(ApiErrorEnvelopeSchema.parse(custRes.json()).error.code).toBe('CUSTOMER_NOT_FOUND');
      expect(countRows()).toEqual(snapBeforeErrors);

      // M5: Underpayment/overpayment/extra cash/0/negative MUST return EXACT HTTP 400 VALIDATION_ERROR (never 500) + 0 DB writes
      const invalidPayPayloads = [
        { payments: [{ method: 'card', amount: '49999' }] },
        { payments: [{ method: 'card', amount: '50001' }] },
        {
          payments: [
            { method: 'card', amount: '50000' },
            { method: 'cash', tenderedAmount: '1000' },
          ],
        },
        { payments: [{ method: 'cash', tenderedAmount: '49999' }] },
        { payments: [{ method: 'cash', tenderedAmount: '50000', amount: '40000' }] },
        { payments: [{ method: 'cash', tenderedAmount: '0' }] },
        { payments: [{ method: 'card', amount: '0' }] },
        { payments: [{ method: 'card', amount: '-50' }] },
        {
          payments: [
            { method: 'cash', tenderedAmount: '25000' },
            { method: 'cash', tenderedAmount: '25000' },
          ],
        },
      ];
      for (let idx = 0; idx < invalidPayPayloads.length; idx += 1) {
        const badRes = await hub.app.inject({
          method: 'POST',
          url: `/carts/${cart2.cart.id}/complete`,
          headers: hdrs(cashierLogin.token),
          payload: {
            clientRequestId: `01950000-0000-7000-8000-f100000001${String(idx).padStart(2, '0')}`,
            expectedTotal: '50000',
            ...invalidPayPayloads[idx],
          },
        });
        expect(badRes.statusCode).toBe(400);
        expect(ApiErrorEnvelopeSchema.parse(badRes.json()).error.code).toBe('VALIDATION_ERROR');
        expect(countRows()).toEqual(snapBeforeErrors);
      }

      // M4: 1 tiyin over MAX_MONEY_TIYIN rejected at Zod layer with 400 VALIDATION_ERROR and 0 DB writes
      const overMax = (MAX_MONEY_TIYIN + 1n).toString();
      for (const badMaxPayload of [
        { payments: [{ method: 'cash', tenderedAmount: overMax }] },
        { payments: [{ method: 'card', amount: overMax }] },
      ]) {
        const overRes = await hub.app.inject({
          method: 'POST',
          url: `/carts/${cart2.cart.id}/complete`,
          headers: hdrs(cashierLogin.token),
          payload: {
            clientRequestId: '01950000-0000-7000-8000-f10000000201',
            expectedTotal: '50000',
            ...badMaxPayload,
          },
        });
        expect(overRes.statusCode).toBe(400);
        expect(ApiErrorEnvelopeSchema.parse(overRes.json()).error.code).toBe('VALIDATION_ERROR');
        expect(countRows()).toEqual(snapBeforeErrors);
      }

      // M4 exact max allowed cash tender passes cleanly and persists 64-bit SQLite integers + cash_moves
      const maxStr = MAX_MONEY_TIYIN.toString();
      const maxRes = await hub.app.inject({
        method: 'POST',
        url: `/carts/${cart2.cart.id}/complete`,
        headers: hdrs(cashierLogin.token),
        payload: {
          clientRequestId: '01950000-0000-7000-8000-f10000000202',
          expectedTotal: '50000',
          payments: [{ method: 'cash', tenderedAmount: maxStr }],
        },
      });
      expect(maxRes.statusCode).toBe(200);
      const completedMax = CompleteSaleResponseSchema.parse(maxRes.json());
      expect(completedMax.sale.changeAmount).toBe((MAX_MONEY_TIYIN - 50_000n).toString());
      // Terminal cash drawer increased by exact net cash sale amount (+50_000) despite MAX int64 tender/change!
      expect(await hub.saleStore.getTerminalCashBalance()).toBe(90_000n);

      // 4) 100%-discounted zero-total checkout via HTTP completes with payments: [] and adds 0 payments/cash_moves
      const cartZero = CartResponseSchema.parse(
        (
          await hub.app.inject({
            method: 'POST',
            url: '/carts',
            headers: hdrs(ownerLogin.token),
            payload: {},
          })
        ).json(),
      );
      await hub.app.inject({
        method: 'POST',
        url: `/carts/${cartZero.cart.id}/lines`,
        headers: hdrs(ownerLogin.token),
        payload: {
          kind: 'catalog',
          productId: prodRes.product.id,
          variantId: null,
          qty: '1000',
        },
      });
      const discRes = await hub.app.inject({
        method: 'PUT',
        url: `/carts/${cartZero.cart.id}/discount`,
        headers: hdrs(ownerLogin.token),
        payload: {
          mode: 'percent',
          percentBp: 10_000,
          reason: '100% owner promo',
          override: { username: 'owner15', pin: '849201' },
        },
      });
      expect(discRes.statusCode).toBe(200);

      const snapBeforeZero = countRows();
      const nonEmptyZeroRes = await hub.app.inject({
        method: 'POST',
        url: `/carts/${cartZero.cart.id}/complete`,
        headers: hdrs(ownerLogin.token),
        payload: {
          clientRequestId: '01950000-0000-7000-8000-f10000000300',
          expectedTotal: '0',
          payments: [{ method: 'cash', tenderedAmount: '100' }],
        },
      });
      expect(nonEmptyZeroRes.statusCode).toBe(400);
      expect(ApiErrorEnvelopeSchema.parse(nonEmptyZeroRes.json()).error.code).toBe(
        'VALIDATION_ERROR',
      );
      expect(countRows()).toEqual(snapBeforeZero);

      const zeroRes = await hub.app.inject({
        method: 'POST',
        url: `/carts/${cartZero.cart.id}/complete`,
        headers: hdrs(ownerLogin.token),
        payload: {
          clientRequestId: '01950000-0000-7000-8000-f10000000301',
          expectedTotal: '0',
          payments: [],
        },
      });
      expect(zeroRes.statusCode).toBe(200);
      const zeroCompleted = CompleteSaleResponseSchema.parse(zeroRes.json());
      expect(zeroCompleted.sale.payments).toEqual([]);
      const snapAfterZero = countRows();
      expect(snapAfterZero.sales).toBe(snapBeforeZero.sales + 1n);
      expect(snapAfterZero.payments).toBe(snapBeforeZero.payments);
      expect(snapAfterZero.cashMoves).toBe(snapBeforeZero.cashMoves);

      // Verify sale audit logs captured completedByUserId and paymentMethods
      const saleAuditLogs = logLines
        .join('')
        .trim()
        .split(/\r?\n/)
        .filter((l) => l.length > 0)
        .map((l) => JSON.parse(l) as Record<string, unknown>)
        .filter((l) => l.event === 'sale.completed');
      expect(saleAuditLogs.some((l) => l.completedByUserId === managerLogin.user.id)).toBe(true);
    } finally {
      await hub.close();
    }
  });
});
