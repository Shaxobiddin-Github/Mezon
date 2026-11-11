import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import {
  DeliverOrderResponseSchema,
  LoginResponseSchema,
  OrderActionResponseSchema,
  ProductDetailResponseSchema,
} from '@mezon/contracts';
import type { PinHasher } from '@mezon/domain';
import { FixedClock, SeededRandomSource } from '@mezon/test-utils';
import { afterEach, describe, expect, it } from 'vitest';
import { createHubServer } from './index.js';

const tempDirs: string[] = [];
const TEST_PORT = 47875;

function makeDbPath(name = 'hub-order-perf.db'): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mezon-hub-order-perf-'));
  tempDirs.push(dir);
  return path.join(dir, name);
}

function makeFastTestHasher(): PinHasher {
  return {
    hash: (pin) => Promise.resolve(`fast-stub-hash:${pin}`),
    verify: (storedHash, pin) => Promise.resolve(storedHash === `fast-stub-hash:${pin}`),
  };
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  }
});

describe('@mezon/hub [PERF] - T1.10 HTTP E2E 20-line order delivery benchmark', () => {
  it('meets <= 300ms HTTP E2E target for POST /orders/:id/deliver on a 20-line order over disk WAL SQLite', async () => {
    const clock = new FixedClock(1_760_000_000_000n);
    const hub = await createHubServer({
      dbPath: makeDbPath('hub-order-perf-20.db'),
      port: TEST_PORT,
      logLevel: 'silent',
      clock,
      random: new SeededRandomSource(110),
      pinHasher: makeFastTestHasher(),
    });

    try {
      const headersHost = { host: `127.0.0.1:${TEST_PORT}` };
      await hub.app.inject({
        method: 'POST',
        url: '/setup',
        headers: headersHost,
        payload: { owner: { fullName: 'Perf Owner', username: 'ownerop', pin: '849201' } },
      });
      const login = LoginResponseSchema.parse(
        (
          await hub.app.inject({
            method: 'POST',
            url: '/auth/login',
            headers: headersHost,
            payload: { username: 'ownerop', pin: '849201' },
          })
        ).json(),
      );
      const authHdr = { ...headersHost, authorization: `Bearer ${login.token}` };

      const shiftRes = await hub.app.inject({
        method: 'POST',
        url: '/shifts/open',
        headers: authHdr,
        payload: {
          clientRequestId: '01950000-0000-7000-8000-110000000001',
          openingCash: '0',
        },
      });
      expect(shiftRes.statusCode).toBe(201);

      const orderLines: Array<{
        readonly kind: 'catalog';
        readonly productId: string;
        readonly qty: string;
      }> = [];

      for (let i = 0; i < 20; i += 1) {
        const p = ProductDetailResponseSchema.parse(
          (
            await hub.app.inject({
              method: 'POST',
              url: '/products',
              headers: authHdr,
              payload: {
                name: `Order Perf Item ${String(i + 1)}`,
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
        orderLines.push({
          kind: 'catalog',
          productId: p.product.id,
          qty: '1000',
        });
      }

      const createdOrder = OrderActionResponseSchema.parse(
        (
          await hub.app.inject({
            method: 'POST',
            url: '/orders',
            headers: authHdr,
            payload: {
              clientRequestId: '01950000-0000-7000-8000-110000000002',
              customerName: 'Perf Customer',
              confirmImmediately: true,
              lines: orderLines,
            },
          })
        ).json(),
      ).order;

      const advOrder = OrderActionResponseSchema.parse(
        (
          await hub.app.inject({
            method: 'POST',
            url: `/orders/${createdOrder.id}/advances`,
            headers: authHdr,
            payload: {
              clientRequestId: '01950000-0000-7000-8000-110000000003',
              payments: [{ method: 'card', amount: '500000', providerRef: 'PERF-ADV-1' }],
            },
          })
        ).json(),
      ).order;

      const t0 = performance.now();
      const deliverRes = await hub.app.inject({
        method: 'POST',
        url: `/orders/${createdOrder.id}/deliver`,
        headers: authHdr,
        payload: {
          clientRequestId: '01950000-0000-7000-8000-110000000004',
          expectedTotal: advOrder.totalAmount,
          payments: [{ method: 'cash', tenderedAmount: advOrder.remainingToPay }],
        },
      });
      const elapsedMs = performance.now() - t0;

      expect(deliverRes.statusCode).toBe(200);
      const parsed = DeliverOrderResponseSchema.parse(deliverRes.json());
      expect(parsed.sale.lines.length).toBe(20);
      expect(elapsedMs).toBeLessThanOrEqual(300);
      console.info(
        `[PERF T1.10 HTTP E2E] 20-line POST /orders/:id/deliver took ${elapsedMs.toFixed(2)} ms`,
      );
    } finally {
      await hub.close();
    }
  }, 30_000);
});
