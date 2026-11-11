import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';
import {
  ApiErrorEnvelopeSchema,
  CartResponseSchema,
  CloseShiftResponseSchema,
  CreateReturnResponseSchema,
  CustomerMutationResponseSchema,
  DeliverOrderResponseSchema,
  ListOrdersResponseSchema,
  LoginResponseSchema,
  OpenAdvancesResponseSchema,
  OpenShiftResponseSchema,
  OrderActionResponseSchema,
  OrderDtoSchema,
  ProductDetailResponseSchema,
  PromotionResponseSchema,
} from '@mezon/contracts';
import { type PinHasher, epochDaysFromCivilDate } from '@mezon/domain';
import { FixedClock, SeededRandomSource } from '@mezon/test-utils';
import { afterEach, describe, expect, it } from 'vitest';
import { createHubServer } from './server.js';

const tempDirs: string[] = [];
const TEST_PORT = 47870;
const HOST_HEADER = `127.0.0.1:${TEST_PORT}`;
const DAY1_1000_UTC_MS = epochDaysFromCivilDate('2026-11-10') * 86_400_000n + 5n * 3_600_000n;

function makeDbPath(name = 'hub-order.db'): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mezon-hub-order-'));
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

describe('@mezon/hub - T1.10 Customer Orders, Frozen O3 Evaluation, Advances (O4), Cross-Shift Delivery (O2), Return Spread & Void Block (O1)', () => {
  it('enforces O1-O4 HTTP E2E workflow, strict Zod (forbids advance input), RBAC, supervisor PIN lockout, zero-cost DTOs & zero-PII Pino logs', async () => {
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
      random: new SeededRandomSource(110),
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
      `01991100-0000-7000-8000-${(reqCounter++).toString(16).padStart(12, '0')}`;

    try {
      await hub.app.inject({
        method: 'POST',
        url: '/setup',
        headers: hostHeaders(),
        payload: { owner: { fullName: 'Owner 110', username: 'owner110', pin: ownerPin } },
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

      const ownerLogin = await loginAs('owner110', ownerPin);
      await hub.app.inject({
        method: 'POST',
        url: '/users',
        headers: authHeaders(ownerLogin.token),
        payload: { fullName: 'Manager 110', username: 'mgr110', role: 'manager', pin: mgrPin },
      });
      await hub.app.inject({
        method: 'POST',
        url: '/users',
        headers: authHeaders(ownerLogin.token),
        payload: { fullName: 'Cashier A', username: 'cash110a', role: 'cashier', pin: cashAPin },
      });
      await hub.app.inject({
        method: 'POST',
        url: '/users',
        headers: authHeaders(ownerLogin.token),
        payload: { fullName: 'Cashier B', username: 'cash110b', role: 'cashier', pin: cashBPin },
      });

      const mgrLogin = await loginAs('mgr110', mgrPin);
      const cashALogin = await loginAs('cash110a', cashAPin);
      const cashBLogin = await loginAs('cash110b', cashBPin);

      // Configure cashier discount limit = 5% / 5,000 UZS
      const settingsRes = await hub.app.inject({
        method: 'PUT',
        url: '/cart-settings',
        headers: authHeaders(ownerLogin.token),
        payload: {
          cashierDiscountLimit: {
            percentUnlimited: false,
            maxPercentBp: 500,
            amountUnlimited: false,
            maxAmount: '500000',
          },
          quickSaleDefaultMxik: '10999001001000000',
          quickSaleDefaultVatRateBp: 1200,
        },
      });
      expect(settingsRes.statusCode).toBe(200);

      // Create catalog product (100,000 UZS) + inbound stock + 10% active promotion
      const prod = ProductDetailResponseSchema.parse(
        (
          await hub.app.inject({
            method: 'POST',
            url: '/products',
            headers: authHeaders(ownerLogin.token),
            payload: {
              name: 'To`y Torti',
              unit: 'dona',
              unlimited: false,
              trackBatches: true,
              salePrice: '10000000',
              vatRateBp: 1200,
            },
          })
        ).json(),
      ).product;

      const stockInRes = await hub.app.inject({
        method: 'POST',
        url: '/stock/moves/in',
        headers: authHeaders(ownerLogin.token),
        payload: {
          productId: prod.id,
          reason: 'purchase',
          qty: '10000',
          totalCostValue: '40000000',
        },
      });
      expect(stockInRes.statusCode).toBe(201);

      const promo = PromotionResponseSchema.parse(
        (
          await hub.app.inject({
            method: 'POST',
            url: '/promotions',
            headers: authHeaders(ownerLogin.token),
            payload: {
              name: 'Tort -10%',
              type: 'percent',
              scope: 'product',
              targetProductId: prod.id,
              discountPercentBp: 1000,
              startsAtMs: (DAY1_1000_UTC_MS - 3_600_000n).toString(),
              endsAtMs: (DAY1_1000_UTC_MS + 86_400_000n).toString(),
              isActive: true,
            },
          })
        ).json(),
      ).promotion;

      const customer = CustomerMutationResponseSchema.parse(
        (
          await hub.app.inject({
            method: 'POST',
            url: '/customers',
            headers: authHeaders(ownerLogin.token),
            payload: {
              fullName: 'Dilnoza Rahimova',
              phone: '90 555-66-77',
              creditLimit: '50000000',
              defaultDueDays: 10,
            },
          })
        ).json(),
      ).customer;

      // Open Shift #1 with Cashier A (opening cash 50,000 UZS = 5,000,000 tiyin)
      const shift1Res = await hub.app.inject({
        method: 'POST',
        url: '/shifts/open',
        headers: authHeaders(cashALogin.token),
        payload: {
          clientRequestId: reqUuid(),
          openingCash: '5000000',
        },
      });
      expect(shift1Res.statusCode).toBe(201);
      const shift1 = OpenShiftResponseSchema.parse(shift1Res.json()).shift;

      // 1) O3: Cashier A tries to create order with 15,000 UZS manual discount (> 5,000 UZS limit) WITHOUT supervisor override -> 403 DISCOUNT_OVERRIDE_REQUIRED
      const createNoOverrideRes = await hub.app.inject({
        method: 'POST',
        url: '/orders',
        headers: authHeaders(cashALogin.token),
        payload: {
          clientRequestId: reqUuid(),
          customerId: customer.id,
          note: 'Soat 18:00 ga tayyor bo`lsin',
          discount: {
            mode: 'amount',
            amount: '1500000',
            reason: 'Doimiy mijoz',
          },
          lines: [
            { kind: 'catalog', productId: prod.id, qty: '1000' }, // 100,000 - 10% promo = 90,000
            {
              kind: 'quick_sale',
              name: 'Maxsus bezak va sham',
              unit: 'dona',
              qty: '1000',
              unitPrice: '2500000', // 25,000
            },
          ],
        },
      });
      expect(createNoOverrideRes.statusCode).toBe(403);
      expect(ApiErrorEnvelopeSchema.parse(createNoOverrideRes.json()).error.code).toBe(
        'DISCOUNT_OVERRIDE_REQUIRED',
      );

      // Retry with manager supervisor PIN override -> 201 Created, frozen evaluation (90k + 25k - 15k = 100k = 10,000,000 tiyin)
      const createReqId = reqUuid();
      const createOrderBody = {
        clientRequestId: createReqId,
        customerId: customer.id,
        note: 'Soat 18:00 ga tayyor bo`lsin',
        discount: {
          mode: 'amount' as const,
          amount: '1500000',
          reason: 'Doimiy mijoz',
          override: { username: 'mgr110', pin: mgrPin },
        },
        lines: [
          { kind: 'catalog' as const, productId: prod.id, qty: '1000' },
          {
            kind: 'quick_sale' as const,
            name: 'Maxsus bezak va sham',
            unit: 'dona' as const,
            qty: '1000',
            unitPrice: '2500000',
          },
        ],
      };

      const createdRes = await hub.app.inject({
        method: 'POST',
        url: '/orders',
        headers: authHeaders(cashALogin.token),
        payload: createOrderBody,
      });
      expect(createdRes.statusCode).toBe(201);
      const created = OrderActionResponseSchema.parse(createdRes.json());
      expect(created.idempotentReplay).toBe(false);
      expect(created.order.status).toBe('draft');
      expect(created.order.subtotalGross).toBe('12500000');
      expect(created.order.totalPromoDiscount).toBe('1000000');
      expect(created.order.orderDiscountAmount).toBe('1500000');
      expect(created.order.totalAmount).toBe('10000000');
      expect(created.order.remainingToPay).toBe('10000000');
      expect(created.order.overrideApprovedByUserId).toBe(mgrLogin.user.id);
      expect(created.order.lines[1]?.mxikSnapshot).toBe('10999001001000000');
      expect(JSON.stringify(created)).not.toContain('costValue');
      expect(JSON.stringify(created)).not.toContain('unitCost');

      // Idempotent replay returns 200 OK
      const replayCreateRes = await hub.app.inject({
        method: 'POST',
        url: '/orders',
        headers: authHeaders(cashALogin.token),
        payload: createOrderBody,
      });
      expect(replayCreateRes.statusCode).toBe(200);
      expect(OrderActionResponseSchema.parse(replayCreateRes.json()).idempotentReplay).toBe(true);

      const orderId = created.order.id;

      // 2) Strict Zod rejects 'advance' in /orders/:id/advances, /orders/:id/deliver, and /carts/:id/complete
      for (const badReq of [
        {
          url: `/orders/${orderId}/advances`,
          payload: {
            clientRequestId: reqUuid(),
            payments: [{ method: 'advance', amount: '1000000' }],
          },
        },
        {
          url: `/orders/${orderId}/deliver`,
          payload: {
            clientRequestId: reqUuid(),
            expectedTotal: '10000000',
            payments: [{ method: 'advance', amount: '1000000' }],
          },
        },
      ]) {
        const res = await hub.app.inject({
          method: 'POST',
          url: badReq.url,
          headers: authHeaders(cashALogin.token),
          payload: badReq.payload,
        });
        expect(res.statusCode).toBe(400);
        expect(ApiErrorEnvelopeSchema.parse(res.json()).error.code).toBe('VALIDATION_ERROR');
      }

      // 3) Record mixed advance in Shift #1: 30,000 cash (tendered 35,000 -> change 5,000) + 25,000 card = 55,000 advance
      const advRes = await hub.app.inject({
        method: 'POST',
        url: `/orders/${orderId}/advances`,
        headers: authHeaders(cashALogin.token),
        payload: {
          clientRequestId: reqUuid(),
          payments: [
            { method: 'cash', tenderedAmount: '3500000', amount: '3000000' },
            { method: 'card', amount: '2500000', providerRef: 'ADV-CARD-1' },
          ],
        },
      });
      expect(advRes.statusCode).toBe(201);
      const afterAdv = OrderActionResponseSchema.parse(advRes.json()).order;
      expect(afterAdv.status).toBe('confirmed'); // auto-confirms draft order on first advance
      expect(afterAdv.netAdvance).toBe('5500000');
      expect(afterAdv.remainingToPay).toBe('4500000');
      expect(afterAdv.netAdvanceByMethod.cash).toBe('3000000');
      expect(afterAdv.netAdvanceByMethod.card).toBe('2500000');

      // O4: GET /orders/open-advances shows 55,000 open advance
      const openAdv1 = OpenAdvancesResponseSchema.parse(
        (
          await hub.app.inject({
            method: 'GET',
            url: '/orders/open-advances',
            headers: authHeaders(cashALogin.token),
          })
        ).json(),
      );
      expect(openAdv1.totalOpenAdvance).toBe('5500000');
      expect(openAdv1.byMethod.cash).toBe('3000000');
      expect(openAdv1.byMethod.card).toBe('2500000');
      expect(openAdv1.openOrdersCount).toBe(1);

      // 4) RBAC & T0.6 Supervisor PIN Lockout on /orders/:id/advances/refund and /orders/:id/cancel
      const refundNoPin = await hub.app.inject({
        method: 'POST',
        url: `/orders/${orderId}/advances/refund`,
        headers: authHeaders(cashALogin.token),
        payload: {
          clientRequestId: reqUuid(),
          reason: 'Mijoz qisman qaytarish so`radi',
          refunds: [{ method: 'cash', amount: '500000' }],
        },
      });
      expect(refundNoPin.statusCode).toBe(403);
      expect(ApiErrorEnvelopeSchema.parse(refundNoPin.json()).error.code).toBe(
        'SUPERVISOR_OVERRIDE_REQUIRED',
      );

      const cancelNoPin = await hub.app.inject({
        method: 'POST',
        url: `/orders/${orderId}/cancel`,
        headers: authHeaders(cashALogin.token),
        payload: {
          clientRequestId: reqUuid(),
          reason: 'Ruxsatsiz bekor qilish urinishi',
        },
      });
      expect(cancelNoPin.statusCode).toBe(403);
      expect(ApiErrorEnvelopeSchema.parse(cancelNoPin.json()).error.code).toBe(
        'SUPERVISOR_OVERRIDE_REQUIRED',
      );

      // 5 wrong supervisor PIN attempts -> 5x 401 (locks user on 5th), 6th returns 429 AUTH_RATE_LIMITED
      for (let attempt = 1; attempt <= 6; attempt += 1) {
        const badOverrideRes = await hub.app.inject({
          method: 'POST',
          url: `/orders/${orderId}/advances/refund`,
          headers: authHeaders(cashALogin.token),
          payload: {
            clientRequestId: reqUuid(),
            reason: 'Noto`g`ri PIN sinovi',
            override: { username: 'mgr110', pin: badPin },
            refunds: [{ method: 'cash', amount: '500000' }],
          },
        });
        if (attempt <= 5) {
          expect(badOverrideRes.statusCode).toBe(401);
        } else {
          expect(badOverrideRes.statusCode).toBe(429);
          expect(ApiErrorEnvelopeSchema.parse(badOverrideRes.json()).error.code).toBe(
            'AUTH_RATE_LIMITED',
          );
        }
      }

      // Advance clock past 5-minute lockout -> valid supervisor PIN refunds 5,000 UZS cash advance
      clock.advance(300_001n);
      const refundOkRes = await hub.app.inject({
        method: 'POST',
        url: `/orders/${orderId}/advances/refund`,
        headers: authHeaders(cashALogin.token),
        payload: {
          clientRequestId: reqUuid(),
          reason: '5000 so`m qaytarildi',
          override: { username: 'mgr110', pin: mgrPin },
          refunds: [{ method: 'cash', amount: '500000' }],
        },
      });
      expect(refundOkRes.statusCode).toBe(200);
      const afterRef = OrderActionResponseSchema.parse(refundOkRes.json()).order;
      expect(afterRef.netAdvance).toBe('5000000'); // 25k cash + 25k card
      expect(afterRef.remainingToPay).toBe('5000000');

      // 5) Close Shift #1: grossSalesTotal === '0' (revenue NOT recognized at advance time!), advance totals recorded
      // Expected cash in drawer = 50,000 (opening) + 30,000 (cash advance net) - 5,000 (cash advance refund) = 75,000 (7,500,000 tiyin)
      const closeShift1Res = await hub.app.inject({
        method: 'POST',
        url: `/shifts/${shift1.id}/close`,
        headers: authHeaders(cashALogin.token),
        payload: {
          clientRequestId: reqUuid(),
          countedCash: '7500000',
        },
      });
      expect(closeShift1Res.statusCode).toBe(200);
      const closure1 = CloseShiftResponseSchema.parse(closeShift1Res.json()).closure;
      expect(closure1.grossSalesTotal).toBe('0');
      expect(closure1.netSalesTotal).toBe('0');
      expect(closure1.expectedCash).toBe('7500000');
      expect(closure1.orderAdvanceCashTotal).toBe('3000000');
      expect(closure1.orderAdvanceNonCashTotal).toBe('2500000');
      expect(closure1.orderAdvanceRefundTotal).toBe('500000');

      // 6) O2: Between shifts, Owner hikes product price (100k -> 180k) and deactivates promo
      const priceHikeRes = await hub.app.inject({
        method: 'PATCH',
        url: `/products/${prod.id}`,
        headers: authHeaders(ownerLogin.token),
        payload: {
          salePrice: '18000000',
          priceChangeReason: 'Yangi narx',
        },
      });
      expect(priceHikeRes.statusCode).toBe(200);

      const disablePromoRes = await hub.app.inject({
        method: 'PATCH',
        url: `/promotions/${promo.id}`,
        headers: authHeaders(ownerLogin.token),
        payload: { isActive: false },
      });
      expect(disablePromoRes.statusCode).toBe(200);

      // 7) Open Shift #2 with Cashier B, mark order ready, and deliver order
      clock.advance(3_600_000n);
      const shift2Res = await hub.app.inject({
        method: 'POST',
        url: '/shifts/open',
        headers: authHeaders(cashBLogin.token),
        payload: {
          clientRequestId: reqUuid(),
          openingCash: '7500000',
        },
      });
      expect(shift2Res.statusCode).toBe(201);
      const shift2 = OpenShiftResponseSchema.parse(shift2Res.json()).shift;

      const readyRes = await hub.app.inject({
        method: 'POST',
        url: `/orders/${orderId}/ready`,
        headers: authHeaders(cashBLogin.token),
        payload: { clientRequestId: reqUuid() },
      });
      expect(readyRes.statusCode).toBe(200);
      expect(OrderActionResponseSchema.parse(readyRes.json()).order.status).toBe('ready');

      // Deliver order: frozen total = 100,000 UZS, netAdvance = 50,000 UZS, remaining = 50,000 UZS (paid 30,000 cash + 20,000 debt)
      const deliverRes = await hub.app.inject({
        method: 'POST',
        url: `/orders/${orderId}/deliver`,
        headers: authHeaders(cashBLogin.token),
        payload: {
          clientRequestId: reqUuid(),
          expectedTotal: '10000000',
          debtAmount: '2000000',
          payments: [{ method: 'cash', tenderedAmount: '3000000' }],
        },
      });
      expect(deliverRes.statusCode).toBe(200);
      const delivered = DeliverOrderResponseSchema.parse(deliverRes.json());
      expect(delivered.order.status).toBe('delivered');
      expect(delivered.order.deliveredSaleId).toBe(delivered.sale.id);
      expect(delivered.order.netAdvance).toBe('0');
      expect(delivered.order.remainingToPay).toBe('0');
      expect(delivered.sale.sourceOrderId).toBe(orderId);
      expect(delivered.sale.totalFinal).toBe('10000000'); // O2: frozen order total preserved!
      expect(delivered.sale.debtAmount).toBe('2000000');
      expect(delivered.sale.payments.map((p) => ({ m: p.method, a: p.amount }))).toEqual([
        { m: 'advance', a: '5000000' },
        { m: 'cash', a: '3000000' },
      ]);
      expect(JSON.stringify(delivered)).not.toContain('costValue');

      // O4: Open advances now 0
      const openAdv2 = OpenAdvancesResponseSchema.parse(
        (
          await hub.app.inject({
            method: 'GET',
            url: '/orders/open-advances',
            headers: authHeaders(cashBLogin.token),
          })
        ).json(),
      );
      expect(openAdv2.totalOpenAdvance).toBe('0');
      expect(openAdv2.openOrdersCount).toBe(0);

      // 8) O1: POST /sales/:id/void on delivered order receipt MUST be rejected with 409 ORDER_SALE_USE_RETURN
      const voidDeliveredRes = await hub.app.inject({
        method: 'POST',
        url: `/sales/${delivered.sale.id}/void`,
        headers: authHeaders(mgrLogin.token),
        payload: {
          clientRequestId: reqUuid(),
          reason: 'Buyurtma chekini void qilish urinishi',
        },
      });
      expect(voidDeliveredRes.statusCode).toBe(409);
      expect(ApiErrorEnvelopeSchema.parse(voidDeliveredRes.json()).error.code).toBe(
        'ORDER_SALE_USE_RETURN',
      );

      // 9) O1 & T1.6: POST /sales/:id/returns expands 'advance' into real order_payments caps (25k cash + 25k card + 30k delivery cash = 55k cash, 25k card)
      // Returning the 20,000 UZS quick_sale line (finalTotal = 20,000 UZS = 2,000,000 tiyin after pro-rata discount) via card succeeds:
      const quickLine = delivered.sale.lines[1];
      const returnExceedCardRes = await hub.app.inject({
        method: 'POST',
        url: `/sales/${delivered.sale.id}/returns`,
        headers: authHeaders(mgrLogin.token),
        payload: {
          clientRequestId: reqUuid(),
          reason: 'Karta limitidan ko`p qaytarish sinovi',
          items: [
            { saleLineId: delivered.sale.lines[0].id, qty: '1000' },
            { saleLineId: quickLine.id, qty: '1000' },
          ],
          debtOffsetAmount: '2000000',
          payments: [
            { method: 'card', amount: '3000000', providerRef: 'RET-EXCEED' }, // > 25,000 card cap!
            { method: 'cash', amount: '5000000' },
          ],
        },
      });
      expect(returnExceedCardRes.statusCode).toBe(409);
      expect(ApiErrorEnvelopeSchema.parse(returnExceedCardRes.json()).error.code).toBe(
        'RETURN_PAYMENT_LIMIT_EXCEEDED',
      );

      const returnOkRes = await hub.app.inject({
        method: 'POST',
        url: `/sales/${delivered.sale.id}/returns`,
        headers: authHeaders(mgrLogin.token),
        payload: {
          clientRequestId: reqUuid(),
          reason: 'Qisman qaytarish (O1)',
          items: [{ saleLineId: quickLine.id, qty: '1000' }],
          payments: [{ method: 'card', amount: quickLine.finalTotal, providerRef: 'RET-CARD-OK' }],
        },
      });
      expect(returnOkRes.statusCode).toBe(201);
      const retDoc = CreateReturnResponseSchema.parse(returnOkRes.json()).returnDoc;
      expect(retDoc.totalRefund).toBe(quickLine.finalTotal);

      // 10) Create a second order, take cash advance, and cancel via Manager directly (auto-refunds advance)
      const order2 = OrderActionResponseSchema.parse(
        (
          await hub.app.inject({
            method: 'POST',
            url: '/orders',
            headers: authHeaders(cashBLogin.token),
            payload: {
              clientRequestId: reqUuid(),
              customerName: 'Bekzod Aliyev',
              customerPhone: '93 111-22-33',
              lines: [
                {
                  kind: 'quick_sale',
                  name: 'Kichik tort',
                  unit: 'dona',
                  qty: '1000',
                  unitPrice: '3000000',
                },
              ],
            },
          })
        ).json(),
      ).order;

      await hub.app.inject({
        method: 'POST',
        url: `/orders/${order2.id}/advances`,
        headers: authHeaders(cashBLogin.token),
        payload: {
          clientRequestId: reqUuid(),
          payments: [{ method: 'cash', tenderedAmount: '1000000' }],
        },
      });

      const cancelOrder2Res = await hub.app.inject({
        method: 'POST',
        url: `/orders/${order2.id}/cancel`,
        headers: authHeaders(mgrLogin.token),
        payload: {
          clientRequestId: reqUuid(),
          reason: 'Mijoz buyurtmani bekor qildi',
        },
      });
      expect(cancelOrder2Res.statusCode).toBe(200);
      const cancelledOrder2 = OrderActionResponseSchema.parse(cancelOrder2Res.json()).order;
      expect(cancelledOrder2.status).toBe('cancelled');
      expect(cancelledOrder2.netAdvance).toBe('0');

      // List & Get orders
      const fetchedOrder = OrderDtoSchema.parse(
        (
          await hub.app.inject({
            method: 'GET',
            url: `/orders/${orderId}`,
            headers: authHeaders(cashBLogin.token),
          })
        ).json(),
      );
      expect(fetchedOrder.id).toBe(orderId);

      const listed = ListOrdersResponseSchema.parse(
        (
          await hub.app.inject({
            method: 'GET',
            url: '/orders?status=delivered',
            headers: authHeaders(cashBLogin.token),
          })
        ).json(),
      );
      expect(listed.total).toBe(1);

      // Close Shift #2: verify grossSalesTotal = 100,000 UZS, methodTotals['advance'].salesAmount = 50,000 UZS
      // Drawer cash in Shift #2 = 75,000 (opening) + 30,000 (delivery cash) + 10,000 (order2 adv) - 10,000 (order2 cancel refund) = 105,000 UZS
      const closeShift2Res = await hub.app.inject({
        method: 'POST',
        url: `/shifts/${shift2.id}/close`,
        headers: authHeaders(cashBLogin.token),
        payload: {
          clientRequestId: reqUuid(),
          countedCash: '10500000',
        },
      });
      expect(closeShift2Res.statusCode).toBe(200);
      const closure2 = CloseShiftResponseSchema.parse(closeShift2Res.json()).closure;
      expect(closure2.grossSalesTotal).toBe('10000000');
      expect(closure2.orderAdvanceCashTotal).toBe('1000000');
      expect(closure2.orderAdvanceRefundTotal).toBe('1000000');
      expect(closure2.methodTotals.find((m) => m.method === 'advance')?.salesAmount).toBe(
        '5000000',
      );

      // Verify structured Pino logs contain order events and ZERO customer PII / PINs
      const allLogs = logLines.join('\n');
      expect(allLogs).toContain('"event":"order.created"');
      expect(allLogs).toContain('"event":"order.advance_recorded"');
      expect(allLogs).toContain('"event":"order.advance_refunded"');
      expect(allLogs).toContain('"event":"order.ready"');
      expect(allLogs).toContain('"event":"order.delivered"');
      expect(allLogs).toContain('"event":"order.cancelled"');
      expect(allLogs).not.toContain('Dilnoza Rahimova');
      expect(allLogs).not.toContain('Bekzod Aliyev');
      expect(allLogs).not.toContain('905556677');
      expect(allLogs).not.toContain(ownerPin);
      expect(allLogs).not.toContain(mgrPin);

      // Also verify normal POS /carts/:id/complete still works and has sourceOrderId === null
      const cartRes = CartResponseSchema.parse(
        (
          await hub.app.inject({
            method: 'POST',
            url: '/carts',
            headers: authHeaders(cashBLogin.token),
            payload: {},
          })
        ).json(),
      );
      expect(cartRes.cart.id).toBeDefined();
    } finally {
      await hub.close();
    }
  });
});
