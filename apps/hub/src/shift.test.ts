import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';
import {
  ApiErrorEnvelopeSchema,
  CartResponseSchema,
  CloseBusinessDayResponseSchema,
  CloseShiftResponseSchema,
  CompleteSaleResponseSchema,
  CreateReturnResponseSchema,
  CurrentShiftResponseSchema,
  DayCloseListResponseSchema,
  HandoffCashierResponseSchema,
  LoginResponseSchema,
  OpenShiftResponseSchema,
  ProductDetailResponseSchema,
  ShiftCashMoveResponseSchema,
  ShiftDetailResponseSchema,
  ShiftListResponseSchema,
  UpdateShiftSettingsResponseSchema,
} from '@mezon/contracts';
import { type PinHasher, epochDaysFromCivilDate } from '@mezon/domain';
import { FixedClock, SeededRandomSource } from '@mezon/test-utils';
import { afterEach, describe, expect, it } from 'vitest';
import { createHubServer } from './server.js';

const tempDirs: string[] = [];
const TEST_PORT = 47859;
const HOST_HEADER = `127.0.0.1:${TEST_PORT}`;
const DAY1_1000_UTC_MS = epochDaysFromCivilDate('2026-11-10') * 86_400_000n + 5n * 3_600_000n;

function makeDbPath(name = 'hub-shift.db'): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mezon-hub-shift-'));
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

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 });
    }
  }
});

describe('@mezon/hub - T1.9 Shifts, Cashier Sessions, X1-X4, RBAC, Supervisor PIN Lockout & Audit', () => {
  it('enforces full HTTP workflow, strict Zod (400 on manual non-cash), RBAC, X1-X4, V1, PIN lockout & zero-secret Pino audit', async () => {
    const logLines: string[] = [];
    const logStream = new Writable({
      write(chunk, _encoding, callback) {
        logLines.push(Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk));
        callback();
      },
    });

    const clock = new FixedClock(DAY1_1000_UTC_MS);
    const hub = await createHubServer({
      dbPath: makeDbPath(),
      port: TEST_PORT,
      clock,
      random: new SeededRandomSource(109),
      pinHasher: makeFastTestHasher(),
      logLevel: 'info',
      logStream,
      maxUserFailedAttempts: 5,
    });

    const ownerPin = '849201';
    const mgrPin = '592817';
    const cashAPin = '374829';
    const cashBPin = '619283';
    const badPin = '917354';

    let reqCounter = 1;
    const reqUuid = () =>
      `01990000-0000-7000-8000-${(reqCounter++).toString(16).padStart(12, '0')}`;

    try {
      await hub.app.inject({
        method: 'POST',
        url: '/setup',
        headers: hostHeaders(),
        payload: { owner: { fullName: 'Owner', username: 'owner19', pin: ownerPin } },
      });

      const loginAs = async (username: string, pin: string) =>
        LoginResponseSchema.parse(
          (
            await hub.app.inject({
              method: 'POST',
              url: '/auth/login',
              headers: hostHeaders(),
              payload: { username, pin },
            })
          ).json(),
        );

      const ownerLogin = await loginAs('owner19', ownerPin);
      await hub.app.inject({
        method: 'POST',
        url: '/users',
        headers: authHeaders(ownerLogin.token),
        payload: { fullName: 'Manager', username: 'mgr19', role: 'manager', pin: mgrPin },
      });
      await hub.app.inject({
        method: 'POST',
        url: '/users',
        headers: authHeaders(ownerLogin.token),
        payload: { fullName: 'Cashier A', username: 'cash19a', role: 'cashier', pin: cashAPin },
      });
      await hub.app.inject({
        method: 'POST',
        url: '/users',
        headers: authHeaders(ownerLogin.token),
        payload: { fullName: 'Cashier B', username: 'cash19b', role: 'cashier', pin: cashBPin },
      });

      const mgrLogin = await loginAs('mgr19', mgrPin);
      const cashALogin = await loginAs('cash19a', cashAPin);
      const cashBLogin = await loginAs('cash19b', cashBPin);

      const prod = ProductDetailResponseSchema.parse(
        (
          await hub.app.inject({
            method: 'POST',
            url: '/products',
            headers: authHeaders(ownerLogin.token),
            payload: {
              name: 'Pishloq T19',
              unit: 'dona',
              unlimited: true,
              salePrice: '100000',
              vatRateBp: 0,
            },
          })
        ).json(),
      ).product;

      // 1) Initial GET /shifts/current returns null shift + 1,000,000 threshold
      const initCurrent = CurrentShiftResponseSchema.parse(
        (
          await hub.app.inject({
            method: 'GET',
            url: '/shifts/current',
            headers: authHeaders(cashALogin.token),
          })
        ).json(),
      );
      expect(initCurrent.shift).toBeNull();
      expect(initCurrent.maxCashDiscrepancyWithoutOverride).toBe('1000000');

      // 2) Cashier A opens Shift #1 with openingCash = 100,000
      const openReqId = reqUuid();
      const openedRes = await hub.app.inject({
        method: 'POST',
        url: '/shifts/open',
        headers: authHeaders(cashALogin.token),
        payload: {
          clientRequestId: openReqId,
          openingCash: '100000',
          denominations: [{ nominal: '50000', count: 2 }],
        },
      });
      expect(openedRes.statusCode).toBe(201);
      const opened = OpenShiftResponseSchema.parse(openedRes.json());
      expect(opened.shift.status).toBe('open');
      expect(opened.drawerCashBalance).toBe('100000');

      // Idempotent replay returns 200
      const openReplayRes = await hub.app.inject({
        method: 'POST',
        url: '/shifts/open',
        headers: authHeaders(cashALogin.token),
        payload: {
          clientRequestId: openReqId,
          openingCash: '100000',
          denominations: [{ nominal: '50000', count: 2 }],
        },
      });
      expect(openReplayRes.statusCode).toBe(200);
      expect(OpenShiftResponseSchema.parse(openReplayRes.json()).idempotentReplay).toBe(true);

      // 3) Cashier B blocked 409 CASHIER_SESSION_MISMATCH on cart complete
      const cartB = CartResponseSchema.parse(
        (
          await hub.app.inject({
            method: 'POST',
            url: '/carts',
            headers: authHeaders(cashBLogin.token),
            payload: {},
          })
        ).json(),
      ).cart;
      await hub.app.inject({
        method: 'POST',
        url: `/carts/${cartB.id}/lines`,
        headers: authHeaders(cashBLogin.token),
        payload: { kind: 'catalog', productId: prod.id, variantId: null, qty: '1000' },
      });
      const mismatchSaleRes = await hub.app.inject({
        method: 'POST',
        url: `/carts/${cartB.id}/complete`,
        headers: authHeaders(cashBLogin.token),
        payload: {
          clientRequestId: reqUuid(),
          expectedTotal: '100000',
          payments: [{ method: 'cash', tenderedAmount: '100000' }],
        },
      });
      expect(mismatchSaleRes.statusCode).toBe(409);
      expect(ApiErrorEnvelopeSchema.parse(mismatchSaleRes.json()).error.code).toBe(
        'CASHIER_SESSION_MISMATCH',
      );

      // 4) Cashier A completes mixed sale (cash 60k tendered w/ 10k change => 50k net + card 50k) => X3 test
      const cartA = CartResponseSchema.parse(
        (
          await hub.app.inject({
            method: 'POST',
            url: '/carts',
            headers: authHeaders(cashALogin.token),
            payload: {},
          })
        ).json(),
      ).cart;
      await hub.app.inject({
        method: 'POST',
        url: `/carts/${cartA.id}/lines`,
        headers: authHeaders(cashALogin.token),
        payload: { kind: 'catalog', productId: prod.id, variantId: null, qty: '1000' },
      });
      const saleARes = await hub.app.inject({
        method: 'POST',
        url: `/carts/${cartA.id}/complete`,
        headers: authHeaders(cashALogin.token),
        payload: {
          clientRequestId: reqUuid(),
          expectedTotal: '100000',
          payments: [
            { method: 'cash', tenderedAmount: '60000' },
            { method: 'card', amount: '50000', providerRef: 'RRN-T19' },
          ],
        },
      });
      expect(saleARes.statusCode).toBe(200);
      const saleA = CompleteSaleResponseSchema.parse(saleARes.json()).sale;
      expect(saleA.shiftId).toBe(opened.shift.id);
      expect(saleA.shiftCashierSessionId).toBe(opened.shift.activeCashierSession?.id);

      // 5) RBAC check: cashier forbidden 403 on cash-moves, reclose, day-closes, settings
      for (const route of [
        {
          method: 'POST' as const,
          url: `/shifts/${opened.shift.id}/cash-moves`,
          payload: {
            clientRequestId: reqUuid(),
            type: 'cash_in',
            amount: '10000',
            reason: 'Cashier denied',
          },
        },
        {
          method: 'POST' as const,
          url: `/shifts/${opened.shift.id}/reclose`,
          payload: { clientRequestId: reqUuid(), countedCash: '100000', reason: 'Denied' },
        },
        {
          method: 'POST' as const,
          url: '/day-closes',
          payload: { clientRequestId: reqUuid(), businessDate: '2026-11-10' },
        },
        {
          method: 'PATCH' as const,
          url: '/shifts/settings',
          payload: { maxCashDiscrepancyWithoutOverride: '100000' },
        },
      ]) {
        const res = await hub.app.inject({
          method: route.method,
          url: route.url,
          headers: authHeaders(cashALogin.token),
          payload: route.payload,
        });
        expect(res.statusCode).toBe(403);
      }

      // 6) Strict Zod 400 checks: reject manual non-cash totals in handoff, close, reclose
      for (const ep of ['handoff', 'close', 'reclose']) {
        const res = await hub.app.inject({
          method: 'POST',
          url: `/shifts/${opened.shift.id}/${ep}`,
          headers: authHeaders(mgrLogin.token),
          payload: {
            clientRequestId: reqUuid(),
            countedCash: '150000',
            ...(ep === 'handoff' ? { nextCashierUserId: cashBLogin.user.id } : {}),
            ...(ep === 'reclose' ? { reason: 'Fix' } : {}),
            cardTotal: '50000',
          },
        });
        expect(res.statusCode).toBe(400);
      }

      // 7) X2: Manager processes return during Cashier A's session (cash 20k + card 80k = 100k? Wait: cash capped at 50k, card capped at 50k -> full 100k return!)
      const mgrRetRes = await hub.app.inject({
        method: 'POST',
        url: `/sales/${saleA.id}/returns`,
        headers: authHeaders(mgrLogin.token),
        payload: {
          clientRequestId: reqUuid(),
          reason: 'Manager return on Cashier A session',
          items: [{ saleLineId: saleA.lines[0].id, qty: '1000' }],
          payments: [
            { method: 'cash', amount: '50000' },
            { method: 'card', amount: '50000', providerRef: 'RET-RRN' },
          ],
        },
      });
      expect(mgrRetRes.statusCode).toBe(201);
      const mgrRet = CreateReturnResponseSchema.parse(mgrRetRes.json()).returnDoc;
      expect(mgrRet.shiftCashierSessionId).toBe(opened.shift.activeCashierSession?.id);

      // Drawer balance = 100k + 50k - 50k = 100,000
      // Manager cash_in +50k -> drawer = 150,000
      const cashInRes = await hub.app.inject({
        method: 'POST',
        url: `/shifts/${opened.shift.id}/cash-moves`,
        headers: authHeaders(mgrLogin.token),
        payload: {
          clientRequestId: reqUuid(),
          type: 'cash_in',
          amount: '50000',
          reason: 'Safe topup',
        },
      });
      expect(cashInRes.statusCode).toBe(201);
      expect(ShiftCashMoveResponseSchema.parse(cashInRes.json()).drawerCashBalance).toBe('150000');

      // 8) Handoff Cashier A -> Cashier B with 0 discrepancy
      const handoffRes = await hub.app.inject({
        method: 'POST',
        url: `/shifts/${opened.shift.id}/handoff`,
        headers: authHeaders(cashALogin.token),
        payload: {
          clientRequestId: reqUuid(),
          nextCashierUserId: cashBLogin.user.id,
          countedCash: '150000',
        },
      });
      expect(handoffRes.statusCode).toBe(200);
      expect(
        HandoffCashierResponseSchema.parse(handoffRes.json()).activeSession.cashierUserId,
      ).toBe(cashBLogin.user.id);

      // 9) Threshold + T0.6 supervisor PIN lockout test on close: lower threshold to 100k, try 200k shortage
      const setRes = await hub.app.inject({
        method: 'PATCH',
        url: '/shifts/settings',
        headers: authHeaders(ownerLogin.token),
        payload: { maxCashDiscrepancyWithoutOverride: '100000' },
      });
      expect(setRes.statusCode).toBe(200);
      expect(
        UpdateShiftSettingsResponseSchema.parse(setRes.json()).maxCashDiscrepancyWithoutOverride,
      ).toBe('100000');

      // No override -> 403 SUPERVISOR_OVERRIDE_REQUIRED (wait: 0 counted vs 150k expected = 150k shortage > 100k threshold!)
      const needPinRes = await hub.app.inject({
        method: 'POST',
        url: `/shifts/${opened.shift.id}/close`,
        headers: authHeaders(cashBLogin.token),
        payload: {
          clientRequestId: reqUuid(),
          countedCash: '0',
          discrepancyReason: 'Missing tray',
        },
      });
      expect(needPinRes.statusCode).toBe(403);
      expect(ApiErrorEnvelopeSchema.parse(needPinRes.json()).error.code).toBe(
        'SUPERVISOR_OVERRIDE_REQUIRED',
      );

      // Wrong supervisor PIN attempts trigger T0.6 lockout (5 failed attempts lock -> 6th hits 429 AUTH_RATE_LIMITED)
      for (let i = 0; i < 5; i += 1) {
        const bad = await hub.app.inject({
          method: 'POST',
          url: `/shifts/${opened.shift.id}/close`,
          headers: authHeaders(cashBLogin.token),
          payload: {
            clientRequestId: reqUuid(),
            countedCash: '0',
            discrepancyReason: 'Missing tray',
            override: { username: 'mgr19', pin: badPin },
          },
        });
        expect(bad.statusCode).toBe(401);
      }
      const locked = await hub.app.inject({
        method: 'POST',
        url: `/shifts/${opened.shift.id}/close`,
        headers: authHeaders(cashBLogin.token),
        payload: {
          clientRequestId: reqUuid(),
          countedCash: '0',
          discrepancyReason: 'Missing tray',
          override: { username: 'mgr19', pin: badPin },
        },
      });
      expect(locked.statusCode).toBe(429);

      // Owner PIN still unlocked -> close succeeds!
      const closeOkRes = await hub.app.inject({
        method: 'POST',
        url: `/shifts/${opened.shift.id}/close`,
        headers: authHeaders(cashBLogin.token),
        payload: {
          clientRequestId: reqUuid(),
          countedCash: '0',
          discrepancyReason: 'Missing tray',
          override: { username: 'owner19', pin: ownerPin },
        },
      });
      expect(closeOkRes.statusCode).toBe(200);
      const closed = CloseShiftResponseSchema.parse(closeOkRes.json());
      expect(closed.closure.closureSeq).toBe(1);
      // X3: cash salesAmount = 50000 (not double-reduced by change!)
      expect(closed.closure.methodTotals.find((m) => m.method === 'cash')?.salesAmount).toBe(
        '50000',
      );
      // X2: Cashier A session has manager return attributed
      expect(closed.closure.cashiers[0].returnsCount).toBe(1);

      // 10) X4 HTTP: open Shift 2 -> DAY_HAS_OPEN_SHIFTS -> close Shift 2 -> day close -> reclose Shift 1 -> isStale=true -> day close seq=2
      const sh2Res = await hub.app.inject({
        method: 'POST',
        url: '/shifts/open',
        headers: authHeaders(cashALogin.token),
        payload: {
          clientRequestId: reqUuid(),
          openingCash: '100000',
          openingDiscrepancyReason: 'Fresh float',
        },
      });
      expect(sh2Res.statusCode).toBe(201);
      const sh2Id = OpenShiftResponseSchema.parse(sh2Res.json()).shift.id;

      // X1: Shift 2 drawer cash balance = 100,000; attempting cash_out 100,001 rejects 409
      const overOutRes = await hub.app.inject({
        method: 'POST',
        url: `/shifts/${sh2Id}/cash-moves`,
        headers: authHeaders(ownerLogin.token),
        payload: {
          clientRequestId: reqUuid(),
          type: 'cash_out',
          amount: '100001',
          reason: 'Over X1 limit',
        },
      });
      expect(overOutRes.statusCode).toBe(409);

      // Day close rejected 409 DAY_HAS_OPEN_SHIFTS while Shift 2 open
      const dcBlockedRes = await hub.app.inject({
        method: 'POST',
        url: '/day-closes',
        headers: authHeaders(ownerLogin.token),
        payload: { clientRequestId: reqUuid(), businessDate: '2026-11-10' },
      });
      expect(dcBlockedRes.statusCode).toBe(409);
      expect(ApiErrorEnvelopeSchema.parse(dcBlockedRes.json()).error.code).toBe(
        'DAY_HAS_OPEN_SHIFTS',
      );

      // Close Shift 2 -> execute Day Close seq=1 -> reclose Shift 1 -> verify isStale=true -> execute Day Close seq=2
      await hub.app.inject({
        method: 'POST',
        url: `/shifts/${sh2Id}/close`,
        headers: authHeaders(cashALogin.token),
        payload: { clientRequestId: reqUuid(), countedCash: '100000' },
      });

      const dc1Res = await hub.app.inject({
        method: 'POST',
        url: '/day-closes',
        headers: authHeaders(ownerLogin.token),
        payload: { clientRequestId: reqUuid(), businessDate: '2026-11-10' },
      });
      expect(dc1Res.statusCode).toBe(201);
      expect(CloseBusinessDayResponseSchema.parse(dc1Res.json()).dayClose.isStale).toBe(false);

      const reclose1Res = await hub.app.inject({
        method: 'POST',
        url: `/shifts/${opened.shift.id}/reclose`,
        headers: authHeaders(ownerLogin.token),
        payload: {
          clientRequestId: reqUuid(),
          countedCash: '150000',
          reason: 'Found cash tray in office safe',
          override: { username: 'owner19', pin: ownerPin },
        },
      });
      expect(reclose1Res.statusCode).toBe(200);
      expect(CloseShiftResponseSchema.parse(reclose1Res.json()).closure.closureSeq).toBe(2);

      const dcList1 = DayCloseListResponseSchema.parse(
        (
          await hub.app.inject({
            method: 'GET',
            url: '/day-closes?businessDate=2026-11-10',
            headers: authHeaders(cashALogin.token),
          })
        ).json(),
      );
      expect(dcList1.dayCloses[0].isStale).toBe(true);

      const dc2Res = await hub.app.inject({
        method: 'POST',
        url: '/day-closes',
        headers: authHeaders(ownerLogin.token),
        payload: { clientRequestId: reqUuid(), businessDate: '2026-11-10' },
      });
      expect(dc2Res.statusCode).toBe(201);
      expect(CloseBusinessDayResponseSchema.parse(dc2Res.json()).dayClose.closeSeq).toBe(2);
      expect(CloseBusinessDayResponseSchema.parse(dc2Res.json()).dayClose.isStale).toBe(false);

      const shiftsList = ShiftListResponseSchema.parse(
        (
          await hub.app.inject({
            method: 'GET',
            url: '/shifts?status=closed',
            headers: authHeaders(cashALogin.token),
          })
        ).json(),
      );
      expect(shiftsList.total).toBe(2);

      const det = ShiftDetailResponseSchema.parse(
        (
          await hub.app.inject({
            method: 'GET',
            url: `/shifts/${opened.shift.id}`,
            headers: authHeaders(cashALogin.token),
          })
        ).json(),
      );
      expect(det.closures).toHaveLength(2);

      // B1 HTTP E2E: Handoff shortage (-100) clamps GET /shifts/current drawerCashBalance & outflow guards to 8,473
      const openB1Res = await hub.app.inject({
        method: 'POST',
        url: '/shifts/open',
        headers: authHeaders(cashALogin.token),
        payload: {
          clientRequestId: reqUuid(),
          openingCash: '0',
          openingDiscrepancyReason: 'Fresh drawer for B1 HTTP test',
        },
      });
      expect(openB1Res.statusCode).toBe(201);
      const b1ShiftId = OpenShiftResponseSchema.parse(openB1Res.json()).shift.id;

      await hub.app.inject({
        method: 'POST',
        url: `/shifts/${b1ShiftId}/cash-moves`,
        headers: authHeaders(mgrLogin.token),
        payload: {
          clientRequestId: reqUuid(),
          type: 'cash_in',
          amount: '8573',
          reason: 'B1 seed expected 8,573',
        },
      });

      const hoB1Res = await hub.app.inject({
        method: 'POST',
        url: `/shifts/${b1ShiftId}/handoff`,
        headers: authHeaders(cashALogin.token),
        payload: {
          clientRequestId: reqUuid(),
          nextCashierUserId: cashBLogin.user.id,
          countedCash: '8473',
          discrepancyReason: 'Missing 100 tiyin',
        },
      });
      expect(hoB1Res.statusCode).toBe(200);
      expect(HandoffCashierResponseSchema.parse(hoB1Res.json()).drawerCashBalance).toBe('8473');

      const curB1 = CurrentShiftResponseSchema.parse(
        (
          await hub.app.inject({
            method: 'GET',
            url: '/shifts/current',
            headers: authHeaders(cashBLogin.token),
          })
        ).json(),
      );
      expect(curB1.drawerCashBalance).toBe('8473');

      const blockedEncash = await hub.app.inject({
        method: 'POST',
        url: `/shifts/${b1ShiftId}/cash-moves`,
        headers: authHeaders(mgrLogin.token),
        payload: {
          clientRequestId: reqUuid(),
          type: 'encashment',
          amount: '8474',
          reason: 'Exceeds physical cash',
        },
      });
      expect(blockedEncash.statusCode).toBe(409);
      expect(ApiErrorEnvelopeSchema.parse(blockedEncash.json()).error.code).toBe(
        'INSUFFICIENT_CASH_IN_DRAWER',
      );

      const exactEncash = await hub.app.inject({
        method: 'POST',
        url: `/shifts/${b1ShiftId}/cash-moves`,
        headers: authHeaders(mgrLogin.token),
        payload: {
          clientRequestId: reqUuid(),
          type: 'encashment',
          amount: '8473',
          reason: 'Exact physical cash',
        },
      });
      expect(exactEncash.statusCode).toBe(201);
      expect(ShiftCashMoveResponseSchema.parse(exactEncash.json()).drawerCashBalance).toBe('0');

      // Zero PINs / bearer tokens leaked in Pino logs
      const rawLogs = logLines.join('');
      for (const secret of [
        ownerPin,
        mgrPin,
        cashAPin,
        cashBPin,
        badPin,
        ownerLogin.token,
        mgrLogin.token,
        cashALogin.token,
        cashBLogin.token,
      ]) {
        expect(rawLogs).not.toContain(secret);
      }
    } finally {
      await hub.close();
    }
  });
});
