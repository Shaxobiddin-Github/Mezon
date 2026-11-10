import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ApiErrorEnvelopeSchema,
  CreateStockMovesResponseSchema,
  FinalizeInventoryCountResponseSchema,
  InventoryCountDetailResponseSchema,
  ListBatchesResponseSchema,
  ListCashierStockBalancesResponseSchema,
  ListStockConflictsResponseSchema,
  ListStockMovesResponseSchema,
  ListStockValuationResponseSchema,
  LoginResponseSchema,
  NegativeStockPolicyResponseSchema,
  ProductDetailResponseSchema,
  RebuildStockProjectionsResponseSchema,
} from '@mezon/contracts';
import type { PinHasher } from '@mezon/domain';
import { FixedClock, SeededRandomSource } from '@mezon/test-utils';
import { afterEach, describe, expect, it } from 'vitest';
import { createHubServer } from './index.js';

const tempDirs: string[] = [];
const TEST_PORT = 47834;
const HOST_HEADER = `127.0.0.1:${TEST_PORT}`;

function makeDbPath(name = 'hub-stock.db'): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mezon-hub-stock-'));
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
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

describe('@mezon/hub - T1.2 Stock API, Batches, Inventory Counts (S1-S4) & RBAC Cost Isolation', () => {
  it('enforces cashier cost-hiding on /stock/balances, blocks write/valuation endpoints with 403, and supports manager workflow', async () => {
    const clock = new FixedClock(1_760_000_000_000n);
    const hub = await createHubServer({
      dbPath: makeDbPath(),
      port: TEST_PORT,
      logLevel: 'silent',
      clock,
      random: new SeededRandomSource(202),
      pinHasher: makeFastTestHasher(),
    });

    try {
      await hub.app.inject({
        method: 'POST',
        url: '/setup',
        headers: hostHeaders(),
        payload: {
          owner: { fullName: 'Owner', username: 'owner', pin: '849201' },
        },
      });

      const ownerToken = LoginResponseSchema.parse(
        (
          await hub.app.inject({
            method: 'POST',
            url: '/auth/login',
            headers: hostHeaders(),
            payload: { username: 'owner', pin: '849201' },
          })
        ).json(),
      ).token;

      await hub.app.inject({
        method: 'POST',
        url: '/users',
        headers: authHeaders(ownerToken),
        payload: { fullName: 'Manager', username: 'manager1', role: 'manager', pin: '739104' },
      });
      await hub.app.inject({
        method: 'POST',
        url: '/users',
        headers: authHeaders(ownerToken),
        payload: { fullName: 'Cashier', username: 'cashier1', role: 'cashier', pin: '582914' },
      });

      const mgrToken = LoginResponseSchema.parse(
        (
          await hub.app.inject({
            method: 'POST',
            url: '/auth/login',
            headers: hostHeaders(),
            payload: { username: 'manager1', pin: '739104' },
          })
        ).json(),
      ).token;

      const cashierToken = LoginResponseSchema.parse(
        (
          await hub.app.inject({
            method: 'POST',
            url: '/auth/login',
            headers: hostHeaders(),
            payload: { username: 'cashier1', pin: '582914' },
          })
        ).json(),
      ).token;

      // Create batch-tracked product & unlimited service product
      const batchProd = ProductDetailResponseSchema.parse(
        (
          await hub.app.inject({
            method: 'POST',
            url: '/products',
            headers: authHeaders(mgrToken),
            payload: {
              name: 'Sut 1L',
              unit: 'dona',
              trackBatches: true,
              minStock: '3000',
              salePrice: '1200000',
            },
          })
        ).json(),
      ).product;

      const svcProd = ProductDetailResponseSchema.parse(
        (
          await hub.app.inject({
            method: 'POST',
            url: '/products',
            headers: authHeaders(mgrToken),
            payload: {
              name: 'Paket',
              unit: 'dona',
              unlimited: true,
              salePrice: '50000',
            },
          })
        ).json(),
      ).product;

      // Manager receives initial batch (+5 @ 40,000)
      const inRes = await hub.app.inject({
        method: 'POST',
        url: '/stock/moves/in',
        headers: authHeaders(mgrToken),
        payload: {
          productId: batchProd.id,
          reason: 'initial',
          qty: '5000',
          totalCostValue: '4000000',
          batchNumber: 'LOT-SUT-1',
        },
      });
      expect(inRes.statusCode).toBe(201);
      const inDto = CreateStockMovesResponseSchema.parse(inRes.json());
      expect(inDto.batch?.remainingQty).toBe('5000');

      // Trying to switch trackBatches to false after stock move -> 409 STOCK_COSTING_LOCKED
      const lockRes = await hub.app.inject({
        method: 'PATCH',
        url: `/products/${batchProd.id}`,
        headers: authHeaders(mgrToken),
        payload: { trackBatches: false },
      });
      expect(lockRes.statusCode).toBe(409);
      expect(ApiErrorEnvelopeSchema.parse(lockRes.json()).error.code).toBe('STOCK_COSTING_LOCKED');

      // Unlimited stock move blocked with 400 UNLIMITED_PRODUCT_STOCK_NOT_TRACKED
      const unlimRes = await hub.app.inject({
        method: 'POST',
        url: '/stock/moves/in',
        headers: authHeaders(mgrToken),
        payload: {
          productId: svcProd.id,
          reason: 'initial',
          qty: '1000',
          totalCostValue: '0',
        },
      });
      expect(unlimRes.statusCode).toBe(400);
      expect(ApiErrorEnvelopeSchema.parse(unlimRes.json()).error.code).toBe(
        'UNLIMITED_PRODUCT_STOCK_NOT_TRACKED',
      );

      // Cashier CAN read /stock/balances, with ZERO cost/valuation/variance keys anywhere in JSON!
      const cashierBalRes = await hub.app.inject({
        method: 'GET',
        url: '/stock/balances',
        headers: authHeaders(cashierToken),
      });
      expect(cashierBalRes.statusCode).toBe(200);
      const cashierRawJson = JSON.stringify(cashierBalRes.json());
      expect(cashierRawJson).not.toMatch(
        /cost|totalValue|total_value|profit|margin|variance|unitCost|initialCostValue/i,
      );
      const balDto = ListCashierStockBalancesResponseSchema.parse(cashierBalRes.json());
      expect(balDto.balances.find((b) => b.productId === batchProd.id)?.qtyOnHand).toBe('5000');
      expect(balDto.balances.find((b) => b.productId === svcProd.id)?.qtyOnHand).toBeNull();

      // Cashier is FORBIDDEN (403) from ALL valuation, batches, moves, conflicts, policy, rebuild, inventory counts!
      const forbiddenCalls: ReadonlyArray<{
        readonly method: 'GET' | 'POST' | 'PATCH' | 'PUT';
        readonly url: string;
        readonly payload?: Record<string, unknown>;
      }> = [
        { method: 'GET', url: '/stock/valuation' },
        { method: 'GET', url: '/stock/batches' },
        { method: 'GET', url: '/stock/moves' },
        { method: 'GET', url: '/stock/conflicts' },
        { method: 'GET', url: '/stock/policy' },
        { method: 'PUT', url: '/stock/policy', payload: { policy: 'block' } },
        { method: 'POST', url: '/stock/projections/rebuild' },
        {
          method: 'POST',
          url: '/stock/moves/in',
          payload: {
            productId: batchProd.id,
            reason: 'purchase',
            qty: '1000',
            totalCostValue: '1',
          },
        },
        {
          method: 'POST',
          url: '/stock/moves/out',
          payload: { productId: batchProd.id, reason: 'damaged', qty: '1000' },
        },
        { method: 'POST', url: '/stock/inventory-counts', payload: {} },
      ];
      for (const req of forbiddenCalls) {
        const res = await hub.app.inject({
          method: req.method,
          url: req.url,
          headers: authHeaders(cashierToken),
          payload: req.payload,
        });
        expect(res.statusCode).toBe(403);
        expect(ApiErrorEnvelopeSchema.parse(res.json()).error.code).toBe('AUTH_FORBIDDEN');
      }

      // Manager negative policy toggle test
      expect(
        NegativeStockPolicyResponseSchema.parse(
          (
            await hub.app.inject({
              method: 'GET',
              url: '/stock/policy',
              headers: authHeaders(mgrToken),
            })
          ).json(),
        ).policy,
      ).toBe('warn');

      expect(
        NegativeStockPolicyResponseSchema.parse(
          (
            await hub.app.inject({
              method: 'PUT',
              url: '/stock/policy',
              headers: authHeaders(mgrToken),
              payload: { policy: 'block' },
            })
          ).json(),
        ).policy,
      ).toBe('block');

      const blockedOut = await hub.app.inject({
        method: 'POST',
        url: '/stock/moves/out',
        headers: authHeaders(mgrToken),
        payload: { productId: batchProd.id, reason: 'sale', qty: '6000' },
      });
      expect(blockedOut.statusCode).toBe(409);
      expect(ApiErrorEnvelopeSchema.parse(blockedOut.json()).error.code).toBe('INSUFFICIENT_STOCK');

      // Warn override proceeds cleanly with NEGATIVE_STOCK warning
      const warnOut = await hub.app.inject({
        method: 'POST',
        url: '/stock/moves/out',
        headers: authHeaders(mgrToken),
        payload: { productId: batchProd.id, reason: 'sale', qty: '6000', policy: 'warn' },
      });
      expect(warnOut.statusCode).toBe(201);
      const warnDto = CreateStockMovesResponseSchema.parse(warnOut.json());
      expect(warnDto.warnings[0]?.code).toBe('NEGATIVE_STOCK');
      expect(warnDto.warnings[0]?.deficitQty).toBe('1000');

      // Inventory count flow (HTTP S1): restock +4 (balance -> 3), start count, sell 1 (balance -> 2), count 4 -> adj +2 -> final 4!
      await hub.app.inject({
        method: 'POST',
        url: '/stock/moves/in',
        headers: authHeaders(mgrToken),
        payload: {
          productId: batchProd.id,
          reason: 'purchase',
          qty: '4000',
          totalCostValue: '3600000',
        },
      });

      const startCountRes = await hub.app.inject({
        method: 'POST',
        url: '/stock/inventory-counts',
        headers: authHeaders(mgrToken),
        payload: { productIds: [batchProd.id], note: 'Kechki sanoq' },
      });
      expect(startCountRes.statusCode).toBe(201);
      const started = InventoryCountDetailResponseSchema.parse(startCountRes.json());

      await hub.app.inject({
        method: 'POST',
        url: '/stock/moves/out',
        headers: authHeaders(mgrToken),
        payload: { productId: batchProd.id, reason: 'sale', qty: '1000' },
      }); // balance now 2,000

      const recordLinesRes = await hub.app.inject({
        method: 'PATCH',
        url: `/stock/inventory-counts/${started.count.id}/lines`,
        headers: authHeaders(mgrToken),
        payload: { lines: [{ productId: batchProd.id, countedQty: '4000' }] },
      });
      expect(recordLinesRes.statusCode).toBe(200);
      expect(
        InventoryCountDetailResponseSchema.parse(recordLinesRes.json()).lines[0]
          ?.expectedQtyAtCount,
      ).toBe('2000');

      const finRes = await hub.app.inject({
        method: 'POST',
        url: `/stock/inventory-counts/${started.count.id}/finalize`,
        headers: authHeaders(mgrToken),
      });
      expect(finRes.statusCode).toBe(200);
      const finDto = FinalizeInventoryCountResponseSchema.parse(finRes.json());
      expect(finDto.count.status).toBe('finalized');
      expect(finDto.lines[0]?.adjustmentQty).toBe('2000');

      // Cannot re-finalize or mutate closed count
      const retryFin = await hub.app.inject({
        method: 'POST',
        url: `/stock/inventory-counts/${started.count.id}/finalize`,
        headers: authHeaders(mgrToken),
      });
      expect(retryFin.statusCode).toBe(409);

      // Manager reads valuation, batches, moves, conflicts, rebuild
      expect(
        ListStockValuationResponseSchema.parse(
          (
            await hub.app.inject({
              method: 'GET',
              url: '/stock/valuation',
              headers: authHeaders(mgrToken),
            })
          ).json(),
        ).valuations[0]?.qtyOnHand,
      ).toBe('4000');

      expect(
        ListBatchesResponseSchema.parse(
          (
            await hub.app.inject({
              method: 'GET',
              url: '/stock/batches',
              headers: authHeaders(mgrToken),
            })
          ).json(),
        ).batches.length,
      ).toBeGreaterThanOrEqual(1);

      expect(
        ListStockMovesResponseSchema.parse(
          (
            await hub.app.inject({
              method: 'GET',
              url: '/stock/moves',
              headers: authHeaders(mgrToken),
            })
          ).json(),
        ).moves.length,
      ).toBeGreaterThanOrEqual(4);

      expect(
        ListStockConflictsResponseSchema.parse(
          (
            await hub.app.inject({
              method: 'GET',
              url: '/stock/conflicts',
              headers: authHeaders(mgrToken),
            })
          ).json(),
        ).conflicts,
      ).toEqual([]);

      expect(
        RebuildStockProjectionsResponseSchema.parse(
          (
            await hub.app.inject({
              method: 'POST',
              url: '/stock/projections/rebuild',
              headers: authHeaders(mgrToken),
            })
          ).json(),
        ).movesReplayed,
      ).toBeGreaterThanOrEqual(4);
    } finally {
      await hub.close();
    }
  });
});
