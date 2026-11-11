import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import {
  CartResponseSchema,
  CompleteSaleResponseSchema,
  LoginResponseSchema,
  ProductDetailResponseSchema,
} from '@mezon/contracts';
import { type PinHasher } from '@mezon/domain';
import { FixedClock, SeededRandomSource } from '@mezon/test-utils';
import { afterEach, describe, expect, it } from 'vitest';
import { createHubServer } from './index.js';

const tempDirs: string[] = [];
const TEST_PORT = 47846;

function makeDbPath(name = 'hub-sale-perf.db'): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mezon-hub-sale-perf-'));
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
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

describe('@mezon/hub [PERF] - T1.4 & T1.5 HTTP E2E benchmarks', () => {
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

      const shiftPerf1 = await hub.app.inject({
        method: 'POST',
        url: '/shifts/open',
        headers: authHdr,
        payload: {
          clientRequestId: '01950000-0000-7000-8000-1400000000b1',
          openingCash: '0',
        },
      });
      expect(shiftPerf1.statusCode).toBe(201);

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
  }, 30_000);

  it('T1.5 HTTP E2E perf: 20-line cart with 3 payment types (card + uzqr + cash) completes <= 300ms', async () => {
    const clock = new FixedClock(1_760_000_000_000n);
    const hub = await createHubServer({
      dbPath: makeDbPath('hub-perf-t15-3pay.db'),
      port: TEST_PORT + 3,
      logLevel: 'silent',
      clock,
      random: new SeededRandomSource(95),
      pinHasher: makeFastTestHasher(),
    });

    try {
      const hdr = { host: `127.0.0.1:${TEST_PORT + 3}` };
      await hub.app.inject({
        method: 'POST',
        url: '/setup',
        headers: hdr,
        payload: { owner: { fullName: 'Perf15 Owner', username: 'owner15p', pin: '849201' } },
      });
      const login = LoginResponseSchema.parse(
        (
          await hub.app.inject({
            method: 'POST',
            url: '/auth/login',
            headers: hdr,
            payload: { username: 'owner15p', pin: '849201' },
          })
        ).json(),
      );
      const authHdr = { ...hdr, authorization: `Bearer ${login.token}` };

      const shiftPerf2 = await hub.app.inject({
        method: 'POST',
        url: '/shifts/open',
        headers: authHdr,
        payload: {
          clientRequestId: '01950000-0000-7000-8000-1500000000b1',
          openingCash: '0',
        },
      });
      expect(shiftPerf2.statusCode).toBe(201);

      const samplesMs: number[] = [];
      let expectedDrawerTotal = 0n;
      const prodIds: string[] = [];
      for (let i = 0; i < 20; i += 1) {
        const p = ProductDetailResponseSchema.parse(
          (
            await hub.app.inject({
              method: 'POST',
              url: '/products',
              headers: authHdr,
              payload: {
                name: `HTTP T15 Perf ${i + 1}`,
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
            qty: '10000',
            totalCostValue: String((i + 1) * 30_000),
          },
        });
        prodIds.push(p.product.id);
      }

      for (let run = 1; run <= 5; run += 1) {
        const runCart = CartResponseSchema.parse(
          (
            await hub.app.inject({
              method: 'POST',
              url: '/carts',
              headers: authHdr,
              payload: {},
            })
          ).json(),
        );
        let runTotal = '0';
        for (const pid of prodIds) {
          const lineAdded = CartResponseSchema.parse(
            (
              await hub.app.inject({
                method: 'POST',
                url: `/carts/${runCart.cart.id}/lines`,
                headers: authHdr,
                payload: { kind: 'catalog', productId: pid, variantId: null, qty: '1000' },
              })
            ).json(),
          );
          runTotal = lineAdded.cart.totalFinal;
        }
        const totalBig = BigInt(runTotal);
        const pCard = (totalBig / 3n).toString();
        const pUzqr = (totalBig / 3n).toString();
        const cashNeed = totalBig - BigInt(pCard) - BigInt(pUzqr);

        const t0 = performance.now();
        const completeRes = await hub.app.inject({
          method: 'POST',
          url: `/carts/${runCart.cart.id}/complete`,
          headers: authHdr,
          payload: {
            clientRequestId: `01950000-0000-7000-8000-66666666670${run}`,
            expectedTotal: runTotal,
            payments: [
              { method: 'card', amount: pCard, providerRef: 'HTTP-CARD' },
              { method: 'uzqr', amount: pUzqr, providerRef: 'HTTP-QR' },
              { method: 'cash', tenderedAmount: (cashNeed + 25_000n).toString() },
            ],
          },
        });
        samplesMs.push(performance.now() - t0);

        expect(completeRes.statusCode).toBe(200);
        const parsed = CompleteSaleResponseSchema.parse(completeRes.json());
        expect(parsed.sale.lines).toHaveLength(20);
        expect(parsed.sale.payments).toHaveLength(3);
        expect(parsed.sale.changeAmount).toBe('25000');
        expectedDrawerTotal += cashNeed;
      }

      const sorted = [...samplesMs].sort((a, b) => a - b);
      const medianMs = sorted[Math.floor(sorted.length / 2)] ?? 0;
      expect(await hub.saleStore.getTerminalCashBalance()).toBe(expectedDrawerTotal);
      expect(medianMs).toBeLessThanOrEqual(300);
      console.info(
        `[PERF T1.5 HTTP E2E] 20-line 3-payment POST /carts/:id/complete median=${medianMs.toFixed(2)} ms samples=[${samplesMs.map((v) => v.toFixed(2)).join(', ')}]`,
      );
    } finally {
      await hub.close();
    }
  }, 30_000);
});
