import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  CartResponseSchema,
  CompleteSaleResponseSchema,
  CreateReturnResponseSchema,
  ListSalesResponseSchema,
  LoginResponseSchema,
  ProductDetailResponseSchema,
  SaleReturnContextResponseSchema,
} from '@mezon/contracts';
import {
  type PinHasher,
  ZERO_MONEY,
  computeCumulativeReturnLineAmounts,
  moneyFromTiyin,
  moneyToTiyin,
  parseProductUnit,
  parseUuidV7,
  quantityFromMilli,
} from '@mezon/domain';
import { FixedClock, SeededRandomSource } from '@mezon/test-utils';
import { afterEach, describe, expect, it } from 'vitest';
import { createHubServer } from './index.js';

const tempDirs: string[] = [];
const TEST_PORT = 47839;
const HOST = `127.0.0.1:${TEST_PORT}`;
const T0 = BigInt(Date.parse('2026-11-21T08:00:00.000Z'));

const hasher: PinHasher = {
  hash: (pin) => Promise.resolve(`fast-stub-hash:${pin}`),
  verify: (stored, pin) => Promise.resolve(stored === `fast-stub-hash:${pin}`),
};

afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 });
  }
});

describe('@mezon/hub - C12 receipts history and return context', () => {
  it('lists receipts with search, and the return context gives the exact refund the hub accepts', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mezon-hub-c12-'));
    tempDirs.push(dir);
    const clock = new FixedClock(T0);
    const hub = await createHubServer({
      dbPath: path.join(dir, 'hub.db'),
      port: TEST_PORT,
      clock,
      random: new SeededRandomSource(1212),
      pinHasher: hasher,
      logLevel: 'silent',
    });
    const auth = (token: string) => ({ host: HOST, authorization: `Bearer ${token}` });

    try {
      expect(
        (
          await hub.app.inject({
            method: 'POST',
            url: '/setup',
            headers: { host: HOST },
            payload: { owner: { fullName: 'Ega Aka', username: 'ega12', pin: '481516' } },
          })
        ).statusCode,
      ).toBe(201);
      const owner = LoginResponseSchema.parse(
        (
          await hub.app.inject({
            method: 'POST',
            url: '/auth/login',
            headers: { host: HOST },
            payload: { username: 'ega12', pin: '481516' },
          })
        ).json(),
      ).token;

      expect(
        (
          await hub.app.inject({
            method: 'POST',
            url: '/shifts/open',
            headers: auth(owner),
            payload: { clientRequestId: '01960000-0000-7000-8000-00000000c121', openingCash: '0' },
          })
        ).statusCode,
      ).toBe(201);

      // 3 units at 10 000 so'm with 12% VAT: a partial return of 1 unit has a rounded refund.
      const product = ProductDetailResponseSchema.parse(
        (
          await hub.app.inject({
            method: 'POST',
            url: '/products',
            headers: auth(owner),
            payload: {
              name: 'Qatiq',
              unit: 'dona',
              salePrice: '1000000',
              vatRateBp: 1200,
              unlimited: true,
            },
          })
        ).json(),
      ).product;

      const sell = async (qtyMilli: string, clientRequestId: string) => {
        const cartId = CartResponseSchema.parse(
          (
            await hub.app.inject({
              method: 'POST',
              url: '/carts',
              headers: auth(owner),
              payload: {},
            })
          ).json(),
        ).cart.id;
        await hub.app.inject({
          method: 'POST',
          url: `/carts/${cartId}/lines`,
          headers: auth(owner),
          payload: { kind: 'catalog', productId: product.id, variantId: null, qty: qtyMilli },
        });
        const total = ((BigInt(qtyMilli) / 1000n) * 1_000_000n).toString();
        const res = await hub.app.inject({
          method: 'POST',
          url: `/carts/${cartId}/complete`,
          headers: auth(owner),
          payload: {
            clientRequestId,
            expectedTotal: total,
            payments: [{ method: 'cash', tenderedAmount: total, amount: total }],
          },
        });
        expect(res.statusCode).toBe(200);
        return CompleteSaleResponseSchema.parse(res.json()).sale;
      };

      const first = await sell('3000', '01960000-0000-7000-8000-00000000c122');
      clock.advance(60_000n);
      const second = await sell('1000', '01960000-0000-7000-8000-00000000c123');

      // 1. List: newest first, with cashier, line count, methods and nothing returned yet.
      const list = ListSalesResponseSchema.parse(
        (await hub.app.inject({ method: 'GET', url: '/sales', headers: auth(owner) })).json(),
      ).sales;
      expect(list.map((s) => s.id)).toEqual([second.id, first.id]);
      expect(list[1]).toMatchObject({
        receiptCode: first.receiptCode,
        totalFinal: '3000000',
        cashierName: 'Ega Aka',
        lineCount: 1,
        status: 'completed',
        returnedTotal: '0',
        paymentMethods: ['cash'],
      });

      // 2. Search by receipt number and by code; LIKE wildcards are literal, not "match all".
      const byNo = ListSalesResponseSchema.parse(
        (
          await hub.app.inject({
            method: 'GET',
            url: `/sales?q=${first.receiptNo}`,
            headers: auth(owner),
          })
        ).json(),
      ).sales;
      expect(byNo.map((s) => s.id)).toContain(first.id);
      const byCode = ListSalesResponseSchema.parse(
        (
          await hub.app.inject({
            method: 'GET',
            url: `/sales?q=${encodeURIComponent(second.receiptCode)}`,
            headers: auth(owner),
          })
        ).json(),
      ).sales;
      expect(byCode.map((s) => s.id)).toEqual([second.id]);
      for (const wild of ['%', '_']) {
        const res = ListSalesResponseSchema.parse(
          (
            await hub.app.inject({
              method: 'GET',
              url: `/sales?q=${encodeURIComponent(wild)}`,
              headers: auth(owner),
            })
          ).json(),
        ).sales;
        expect(res).toEqual([]);
      }
      expect(
        (await hub.app.inject({ method: 'GET', url: '/sales', headers: { host: HOST } }))
          .statusCode,
      ).toBe(401);

      // 3. Return context before any return.
      const ctx0 = SaleReturnContextResponseSchema.parse(
        (
          await hub.app.inject({
            method: 'GET',
            url: `/sales/${first.id}/return-context`,
            headers: auth(owner),
          })
        ).json(),
      );
      expect(ctx0.lines).toHaveLength(1);
      expect(ctx0.lines[0]).toMatchObject({ qty: '3000', returnedQty: '0', refundedAmount: '0' });
      expect(ctx0.refundableByMethod).toEqual([{ method: 'cash', amount: '3000000' }]);
      expect(ctx0.remainingSaleDebt).toBe('0');

      // 4. Oracle: the refund the kassa computes from the context (same domain function) is
      //    exactly what the hub accepts; twice, so the second uses the prior-return aggregates.
      const doReturn = async (qtyMilli: string, clientRequestId: string) => {
        const ctx = SaleReturnContextResponseSchema.parse(
          (
            await hub.app.inject({
              method: 'GET',
              url: `/sales/${first.id}/return-context`,
              headers: auth(owner),
            })
          ).json(),
        );
        const line = ctx.lines[0];
        const kassaRefund = computeCumulativeReturnLineAmounts({
          saleLineId: parseUuidV7(line.id),
          unit: parseProductUnit(line.unit),
          soldQty: quantityFromMilli(BigInt(line.qty)),
          previouslyReturnedQty: quantityFromMilli(BigInt(line.returnedQty)),
          requestedQty: quantityFromMilli(BigInt(qtyMilli)),
          soldFinalTotal: moneyFromTiyin(BigInt(line.finalTotal)),
          soldNetExVat: moneyFromTiyin(BigInt(line.netExVat)),
          soldVatTotal: moneyFromTiyin(BigInt(line.vatTotal)),
          previouslyRefunded: moneyFromTiyin(BigInt(line.refundedAmount)),
          previouslyReturnedNet: moneyFromTiyin(BigInt(line.returnedNetExVat)),
          previouslyReturnedVat: moneyFromTiyin(BigInt(line.returnedVatTotal)),
        }).refundAmount;
        const res = await hub.app.inject({
          method: 'POST',
          url: `/sales/${first.id}/returns`,
          headers: auth(owner),
          payload: {
            clientRequestId,
            reason: 'Mijoz qaytardi',
            items: [{ saleLineId: line.id, qty: qtyMilli }],
            payments: [{ method: 'cash', amount: moneyToTiyin(kassaRefund).toString() }],
          },
        });
        expect(res.statusCode).toBe(201);
        const doc = CreateReturnResponseSchema.parse(res.json()).returnDoc;
        expect(doc.totalRefund).toBe(moneyToTiyin(kassaRefund).toString());
        return doc;
      };
      const r1 = await doReturn('1000', '01960000-0000-7000-8000-00000000c124');
      const r2 = await doReturn('2000', '01960000-0000-7000-8000-00000000c125');
      expect(BigInt(r1.totalRefund) + BigInt(r2.totalRefund)).toBe(3_000_000n);
      expect(moneyToTiyin(ZERO_MONEY)).toBe(0n);

      // 5. After the returns: nothing left to return or refund; the list shows the returned total.
      const ctx2 = SaleReturnContextResponseSchema.parse(
        (
          await hub.app.inject({
            method: 'GET',
            url: `/sales/${first.id}/return-context`,
            headers: auth(owner),
          })
        ).json(),
      );
      expect(ctx2.lines[0]).toMatchObject({ returnedQty: '3000', refundedAmount: '3000000' });
      expect(ctx2.refundableByMethod).toEqual([]);
      const after = ListSalesResponseSchema.parse(
        (await hub.app.inject({ method: 'GET', url: '/sales', headers: auth(owner) })).json(),
      ).sales.find((s) => s.id === first.id);
      expect(after?.returnedTotal).toBe('3000000');

      // 6. Unknown sale -> 404.
      const missing = await hub.app.inject({
        method: 'GET',
        url: '/sales/01960000-0000-7000-8000-0000000fffff/return-context',
        headers: auth(owner),
      });
      expect(missing.statusCode).toBe(404);
    } finally {
      await hub.close();
    }
  }, 60_000);
});
