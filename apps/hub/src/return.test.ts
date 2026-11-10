import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';
import {
  ApiErrorEnvelopeSchema,
  CartResponseSchema,
  CompleteSaleResponseSchema,
  CreateReturnResponseSchema,
  ListSaleReturnsResponseSchema,
  LoginResponseSchema,
  ProductDetailResponseSchema,
  ReturnDtoSchema,
  SalesLinesReportSummarySchema,
  VoidSaleResponseSchema,
} from '@mezon/contracts';
import { type PinHasher } from '@mezon/domain';
import { FixedClock, SeededRandomSource } from '@mezon/test-utils';
import { afterEach, describe, expect, it } from 'vitest';
import { createHubServer } from './index.js';

const tempDirs: string[] = [];
const TEST_PORT = 47838;
const HOST_HEADER = `127.0.0.1:${TEST_PORT}`;

const TASHKENT_2359_UTC_MS = BigInt(Date.parse('2026-06-15T18:59:00.000Z'));
const TASHKENT_0001_NEXT_UTC_MS = BigInt(Date.parse('2026-06-15T19:01:00.000Z'));

function makeDbPath(name = 'hub-return.db'): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mezon-hub-return-'));
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
    const dir = tempDirs.pop()!;
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 });
  }
});

describe('@mezon/hub - T1.6 Void, Return, Supervisor Override RBAC, V1-V2 & Audit Security', () => {
  it('enforces full HTTP RBAC, supervisor PIN override + lockout, V1 409 cutoff, V2 cash limits, reports permission & C2 zero-secret audit', async () => {
    const logLines: string[] = [];
    const logStream = new Writable({
      write(chunk, _encoding, callback) {
        logLines.push(Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk));
        callback();
      },
    });

    const clock = new FixedClock(TASHKENT_2359_UTC_MS);
    const hub = await createHubServer({
      dbPath: makeDbPath(),
      port: TEST_PORT,
      clock,
      random: new SeededRandomSource(44),
      pinHasher: makeFastTestHasher(),
      logLevel: 'info',
      logStream,
    });

    const ownerPin = '849201';
    const mgrPin = '592817';
    const cashierPin = '374829';

    try {
      // 1. Bootstrap owner, manager, cashier
      const setupRes = await hub.app.inject({
        method: 'POST',
        url: '/setup',
        headers: hostHeaders(),
        payload: { owner: { fullName: 'Owner', username: 'owner16', pin: ownerPin } },
      });
      expect(setupRes.statusCode).toBe(201);
      const ownerLogin = LoginResponseSchema.parse(
        (
          await hub.app.inject({
            method: 'POST',
            url: '/auth/login',
            headers: hostHeaders(),
            payload: { username: 'owner16', pin: ownerPin },
          })
        ).json(),
      );

      await hub.app.inject({
        method: 'POST',
        url: '/users',
        headers: authHeaders(ownerLogin.token),
        payload: { fullName: 'Manager', username: 'mgr16', role: 'manager', pin: mgrPin },
      });
      await hub.app.inject({
        method: 'POST',
        url: '/users',
        headers: authHeaders(ownerLogin.token),
        payload: { fullName: 'Cashier', username: 'cash16', role: 'cashier', pin: cashierPin },
      });

      const mgrLogin = LoginResponseSchema.parse(
        (
          await hub.app.inject({
            method: 'POST',
            url: '/auth/login',
            headers: hostHeaders(),
            payload: { username: 'mgr16', pin: mgrPin },
          })
        ).json(),
      );
      const cashLogin = LoginResponseSchema.parse(
        (
          await hub.app.inject({
            method: 'POST',
            url: '/auth/login',
            headers: hostHeaders(),
            payload: { username: 'cash16', pin: cashierPin },
          })
        ).json(),
      );

      // 2. Seed catalog + stock
      const prodRes = await hub.app.inject({
        method: 'POST',
        url: '/products',
        headers: authHeaders(ownerLogin.token),
        payload: {
          name: 'Olma',
          unit: 'dona',
          salePrice: '50000',
          vatRateBp: 1200,
        },
      });
      expect(prodRes.statusCode).toBe(201);
      const product = ProductDetailResponseSchema.parse(prodRes.json()).product;

      const inRes = await hub.app.inject({
        method: 'POST',
        url: '/stock/moves/in',
        headers: authHeaders(ownerLogin.token),
        payload: {
          productId: product.id,
          reason: 'purchase',
          qty: '10000',
          totalCostValue: '300000',
        },
      });
      expect(inRes.statusCode).toBe(201);

      const openCartAndComplete = async (qtyMilli: string, clientReqId: string) => {
        const cartRes = await hub.app.inject({
          method: 'POST',
          url: '/carts',
          headers: authHeaders(cashLogin.token),
          payload: {},
        });
        const cartId = CartResponseSchema.parse(cartRes.json()).cart.id;
        await hub.app.inject({
          method: 'POST',
          url: `/carts/${cartId}/lines`,
          headers: authHeaders(cashLogin.token),
          payload: {
            kind: 'catalog',
            productId: product.id,
            variantId: null,
            qty: qtyMilli,
          },
        });
        const totalTiyin = ((BigInt(qtyMilli) / 1000n) * 50_000n).toString();
        const saleRes = await hub.app.inject({
          method: 'POST',
          url: `/carts/${cartId}/complete`,
          headers: authHeaders(cashLogin.token),
          payload: {
            clientRequestId: clientReqId,
            expectedTotal: totalTiyin,
            payments: [
              {
                method: 'cash',
                tenderedAmount: (BigInt(totalTiyin) + 10_000n).toString(),
                amount: totalTiyin,
              },
            ],
          },
        });
        expect(saleRes.statusCode).toBe(200);
        return CompleteSaleResponseSchema.parse(saleRes.json()).sale;
      };

      // Complete 2 sales at 23:59 Asia/Tashkent
      const sale1 = await openCartAndComplete('2000', '01960000-0000-7000-8000-100000000001'); // 100,000 (net cash)
      const sale2 = await openCartAndComplete('3000', '01960000-0000-7000-8000-100000000002'); // 150,000 (net cash)

      // 3. RBAC: Unauthenticated returns 401
      const unauthRes = await hub.app.inject({
        method: 'POST',
        url: `/sales/${sale1.id}/void`,
        headers: hostHeaders(),
        payload: {
          clientRequestId: '01960000-0000-7000-8000-200000000001',
          reason: 'No auth',
        },
      });
      expect(unauthRes.statusCode).toBe(401);

      // Cashier WITHOUT override -> 403 SUPERVISOR_OVERRIDE_REQUIRED (both void and return!)
      const cashNoOverrideVoid = await hub.app.inject({
        method: 'POST',
        url: `/sales/${sale1.id}/void`,
        headers: authHeaders(cashLogin.token),
        payload: {
          clientRequestId: '01960000-0000-7000-8000-200000000002',
          reason: 'Self void',
        },
      });
      expect(cashNoOverrideVoid.statusCode).toBe(403);
      expect(ApiErrorEnvelopeSchema.parse(cashNoOverrideVoid.json()).error.code).toBe(
        'SUPERVISOR_OVERRIDE_REQUIRED',
      );

      const cashNoOverrideRet = await hub.app.inject({
        method: 'POST',
        url: `/sales/${sale1.id}/returns`,
        headers: authHeaders(cashLogin.token),
        payload: {
          clientRequestId: '01960000-0000-7000-8000-200000000003',
          reason: 'Self return',
          items: [{ saleLineId: sale1.lines[0].id, qty: '1000' }],
          payments: [{ method: 'cash', amount: '50000' }],
        },
      });
      expect(cashNoOverrideRet.statusCode).toBe(403);
      expect(ApiErrorEnvelopeSchema.parse(cashNoOverrideRet.json()).error.code).toBe(
        'SUPERVISOR_OVERRIDE_REQUIRED',
      );

      // Cashier trying their OWN PIN as supervisor override -> 403 AUTH_FORBIDDEN
      const selfOverrideRes = await hub.app.inject({
        method: 'POST',
        url: `/sales/${sale1.id}/void`,
        headers: authHeaders(cashLogin.token),
        payload: {
          clientRequestId: '01960000-0000-7000-8000-200000000004',
          reason: 'Self override hack',
          override: { username: 'cash16', pin: cashierPin },
        },
      });
      expect(selfOverrideRes.statusCode).toBe(403);
      expect(ApiErrorEnvelopeSchema.parse(selfOverrideRes.json()).error.code).toBe(
        'AUTH_FORBIDDEN',
      );

      // Wrong supervisor PIN 5x -> T0.6 rate limit lockout blocks even correct PIN on 6th attempt (429 AUTH_RATE_LIMITED)
      for (let attempt = 1; attempt <= 5; attempt += 1) {
        const badPinRes = await hub.app.inject({
          method: 'POST',
          url: `/sales/${sale1.id}/returns`,
          headers: authHeaders(cashLogin.token),
          payload: {
            clientRequestId: `01960000-0000-7000-8000-20000000010${attempt}`,
            reason: 'Wrong PIN attempt',
            items: [{ saleLineId: sale1.lines[0].id, qty: '1000' }],
            payments: [{ method: 'cash', amount: '50000' }],
            override: { username: 'mgr16', pin: '999999' },
          },
        });
        expect(badPinRes.statusCode).toBe(401);
      }
      const lockedOutRes = await hub.app.inject({
        method: 'POST',
        url: `/sales/${sale1.id}/returns`,
        headers: authHeaders(cashLogin.token),
        payload: {
          clientRequestId: '01960000-0000-7000-8000-200000000106',
          reason: 'Locked out PIN',
          items: [{ saleLineId: sale1.lines[0].id, qty: '1000' }],
          payments: [{ method: 'cash', amount: '50000' }],
          override: { username: 'mgr16', pin: mgrPin },
        },
      });
      expect(lockedOutRes.statusCode).toBe(429);
      expect(Number(lockedOutRes.headers['retry-after'])).toBeGreaterThan(0);

      // Cashier WITH valid owner supervisor PIN completes return -> 201 + zero cost fields
      const cashRetOk = await hub.app.inject({
        method: 'POST',
        url: `/sales/${sale1.id}/returns`,
        headers: authHeaders(cashLogin.token),
        payload: {
          clientRequestId: '01960000-0000-7000-8000-200000000201',
          reason: 'Mijoz qaytardi',
          items: [{ saleLineId: sale1.lines[0].id, qty: '1000' }],
          payments: [{ method: 'cash', amount: '50000' }],
          override: { username: 'owner16', pin: ownerPin },
        },
      });
      expect(cashRetOk.statusCode).toBe(201);
      const retJson: unknown = cashRetOk.json();
      const parsedRet = CreateReturnResponseSchema.parse(retJson);
      expect(parsedRet.returnDoc.overrideApprovedByUserId).toBe(ownerLogin.user.id);
      const retKeys = collectJsonKeysDeep(retJson);
      expect(retKeys.has('costValue')).toBe(false);
      expect(retKeys.has('grossProfit')).toBe(false);
      expect(retKeys.has('profit')).toBe(false);

      // V2 via HTTP: sale1 remaining net cash = 50,000 (tendered was 110,000!). Trying 50,001 -> 409 RETURN_PAYMENT_LIMIT_EXCEEDED
      const overCashRetRes = await hub.app.inject({
        method: 'POST',
        url: `/sales/${sale1.id}/returns`,
        headers: authHeaders(ownerLogin.token),
        payload: {
          clientRequestId: '01960000-0000-7000-8000-200000000202',
          reason: 'Over cash cap',
          items: [{ saleLineId: sale1.lines[0].id, qty: '1000' }],
          payments: [{ method: 'cash', amount: '50001' }],
        },
      });
      expect(overCashRetRes.statusCode).toBe(409);
      expect(ApiErrorEnvelopeSchema.parse(overCashRetRes.json()).error.code).toBe(
        'RETURN_PAYMENT_LIMIT_EXCEEDED',
      );

      // Excess qty return -> 409 RETURN_QTY_EXCEEDED
      const excessQtyRetRes = await hub.app.inject({
        method: 'POST',
        url: `/sales/${sale1.id}/returns`,
        headers: authHeaders(ownerLogin.token),
        payload: {
          clientRequestId: '01960000-0000-7000-8000-200000000203',
          reason: 'Over qty cap',
          items: [{ saleLineId: sale1.lines[0].id, qty: '2000' }],
          payments: [{ method: 'cash', amount: '50000' }],
        },
      });
      expect(excessQtyRetRes.statusCode).toBe(409);
      expect(ApiErrorEnvelopeSchema.parse(excessQtyRetRes.json()).error.code).toBe(
        'RETURN_QTY_EXCEEDED',
      );

      // Unknown return ID -> 404 RETURN_NOT_FOUND
      const notFoundRet = await hub.app.inject({
        method: 'GET',
        url: '/returns/01960000-0000-7000-8000-999999999999',
        headers: authHeaders(cashLogin.token),
      });
      expect(notFoundRet.statusCode).toBe(404);

      // Idempotent replay via HTTP returns 200 idempotentReplay: true, differing payload -> 409
      const replayRetRes = await hub.app.inject({
        method: 'POST',
        url: `/sales/${sale1.id}/returns`,
        headers: authHeaders(ownerLogin.token),
        payload: {
          clientRequestId: '01960000-0000-7000-8000-200000000201',
          reason: 'Mijoz qaytardi',
          items: [{ saleLineId: sale1.lines[0].id, qty: '1000' }],
          payments: [{ method: 'cash', amount: '50000' }],
        },
      });
      expect(replayRetRes.statusCode).toBe(200);
      expect(CreateReturnResponseSchema.parse(replayRetRes.json()).idempotentReplay).toBe(true);

      const conflictRetRes = await hub.app.inject({
        method: 'POST',
        url: `/sales/${sale1.id}/returns`,
        headers: authHeaders(ownerLogin.token),
        payload: {
          clientRequestId: '01960000-0000-7000-8000-200000000201',
          reason: 'Ozgargan sabab',
          items: [{ saleLineId: sale1.lines[0].id, qty: '1000' }],
          payments: [{ method: 'cash', amount: '50000' }],
        },
      });
      expect(conflictRetRes.statusCode).toBe(409);
      expect(ApiErrorEnvelopeSchema.parse(conflictRetRes.json()).error.code).toBe(
        'IDEMPOTENCY_CONFLICT',
      );

      // Voiding sale1 (which has a return) fails with 409 SALE_HAS_RETURNS
      const voidHasRet = await hub.app.inject({
        method: 'POST',
        url: `/sales/${sale1.id}/void`,
        headers: authHeaders(ownerLogin.token),
        payload: {
          clientRequestId: '01960000-0000-7000-8000-200000000301',
          reason: 'Try void',
        },
      });
      expect(voidHasRet.statusCode).toBe(409);
      expect(ApiErrorEnvelopeSchema.parse(voidHasRet.json()).error.code).toBe('SALE_HAS_RETURNS');

      // Blank reason -> 400 VALIDATION_ERROR
      const blankReason = await hub.app.inject({
        method: 'POST',
        url: `/sales/${sale2.id}/void`,
        headers: authHeaders(ownerLogin.token),
        payload: {
          clientRequestId: '01960000-0000-7000-8000-200000000302',
          reason: '   ',
        },
      });
      expect(blankReason.statusCode).toBe(400);

      // Same-day void on sale2 by manager directly (no override needed) -> 200
      const voidSale2 = await hub.app.inject({
        method: 'POST',
        url: `/sales/${sale2.id}/void`,
        headers: authHeaders(mgrLogin.token),
        payload: {
          clientRequestId: '01960000-0000-7000-8000-200000000303',
          reason: 'Menejer tomonidan bekor',
        },
      });
      expect(voidSale2.statusCode).toBe(200);
      const voidSale2Json: unknown = voidSale2.json();
      const parsedVoid2 = VoidSaleResponseSchema.parse(voidSale2Json);
      expect(parsedVoid2.sale.status).toBe('voided');
      expect(collectJsonKeysDeep(voidSale2Json).has('costValue')).toBe(false);

      // GET /sales/:id/returns & GET /returns/:id
      const listRetsRes = await hub.app.inject({
        method: 'GET',
        url: `/sales/${sale1.id}/returns`,
        headers: authHeaders(cashLogin.token),
      });
      expect(listRetsRes.statusCode).toBe(200);
      expect(ListSaleReturnsResponseSchema.parse(listRetsRes.json()).returns).toHaveLength(1);

      const getRetRes = await hub.app.inject({
        method: 'GET',
        url: `/returns/${parsedRet.returnDoc.id}`,
        headers: authHeaders(cashLogin.token),
      });
      expect(getRetRes.statusCode).toBe(200);
      expect(ReturnDtoSchema.parse(getRetRes.json()).id).toBe(parsedRet.returnDoc.id);

      // Reports RBAC: cashier -> 403, manager -> 403, owner -> 200!
      expect(
        (
          await hub.app.inject({
            method: 'GET',
            url: '/reports/sales-lines/summary',
            headers: authHeaders(cashLogin.token),
          })
        ).statusCode,
      ).toBe(403);
      expect(
        (
          await hub.app.inject({
            method: 'GET',
            url: '/reports/sales-lines/summary',
            headers: authHeaders(mgrLogin.token),
          })
        ).statusCode,
      ).toBe(403);

      const reportRes = await hub.app.inject({
        method: 'GET',
        url: '/reports/sales-lines/summary',
        headers: authHeaders(ownerLogin.token),
      });
      expect(reportRes.statusCode).toBe(200);
      const reportSummary = SalesLinesReportSummarySchema.parse(reportRes.json());
      // Remaining: 1 dona of sale1 (50,000 total; 12% VAT => net = 44643, vat = 5357; cost = 30,000 => profit = 14643)
      expect(reportSummary.revenue).toBe('50000');
      expect(reportSummary.costValue).toBe('30000');
      expect(BigInt(reportSummary.netRevenue) - BigInt(reportSummary.costValue)).toBe(
        BigInt(reportSummary.grossProfit),
      );

      // Cashier void WITH valid owner supervisor PIN succeeds -> audit records overrideApprovedByUserId
      const sale4 = await openCartAndComplete('1000', '01960000-0000-7000-8000-100000000004');
      const cashierOverrideVoid = await hub.app.inject({
        method: 'POST',
        url: `/sales/${sale4.id}/void`,
        headers: authHeaders(cashLogin.token),
        payload: {
          clientRequestId: '01960000-0000-7000-8000-200000000388',
          reason: 'Supervisor tasdiqladi',
          override: { username: 'owner16', pin: ownerPin },
        },
      });
      expect(cashierOverrideVoid.statusCode).toBe(200);
      expect(VoidSaleResponseSchema.parse(cashierOverrideVoid.json()).sale.status).toBe('voided');

      // V1 HTTP test: Open new sale3 at 23:59, advance FixedClock to 00:01 -> void returns 409 VOID_WINDOW_EXPIRED
      const sale3 = await openCartAndComplete('1000', '01960000-0000-7000-8000-100000000003');
      clock.set(TASHKENT_0001_NEXT_UTC_MS);
      const expiredVoid = await hub.app.inject({
        method: 'POST',
        url: `/sales/${sale3.id}/void`,
        headers: authHeaders(ownerLogin.token),
        payload: {
          clientRequestId: '01960000-0000-7000-8000-200000000399',
          reason: 'Midnight crossed',
        },
      });
      expect(expiredVoid.statusCode).toBe(409);
      expect(ApiErrorEnvelopeSchema.parse(expiredVoid.json()).error.code).toBe(
        'VOID_WINDOW_EXPIRED',
      );

      // Audit logs check: sale.voided & return.created present, ZERO PINs, tokens, or costValue/profit!
      const rawLogs = logLines.join('');
      expect(rawLogs).not.toContain(ownerPin);
      expect(rawLogs).not.toContain(mgrPin);
      expect(rawLogs).not.toContain(cashierPin);
      expect(rawLogs).not.toContain(ownerLogin.token);
      expect(rawLogs).not.toContain(cashLogin.token);

      const parsedLogs = rawLogs
        .split(/\r?\n/)
        .filter((l) => l.trim().startsWith('{'))
        .map((l) => JSON.parse(l) as Record<string, unknown>);
      const voidLogs = parsedLogs.filter((l) => l.event === 'sale.voided');
      const retLogs = parsedLogs.filter((l) => l.event === 'return.created');
      expect(voidLogs.length).toBeGreaterThanOrEqual(2);
      expect(voidLogs.some((l) => l.overrideApprovedByUserId === ownerLogin.user.id)).toBe(true);
      expect(retLogs.length).toBeGreaterThanOrEqual(1);
      expect(retLogs.some((l) => l.overrideApprovedByUserId === ownerLogin.user.id)).toBe(true);
      for (const l of [...voidLogs, ...retLogs]) {
        const keys = collectJsonKeysDeep(l);
        expect(keys.has('costValue')).toBe(false);
        expect(keys.has('grossProfit')).toBe(false);
        expect(keys.has('pin')).toBe(false);
      }
    } finally {
      await hub.close();
    }
  }, 15_000);
});
