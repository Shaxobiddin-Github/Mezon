import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';
import {
  ApiErrorEnvelopeSchema,
  CartResponseSchema,
  CartSettingsResponseSchema,
  ListCartsResponseSchema,
  ListPromotionsResponseSchema,
  LoginResponseSchema,
  ProductDetailResponseSchema,
  PromotionResponseSchema,
} from '@mezon/contracts';
import type { PinHasher } from '@mezon/domain';
import { FixedClock, SeededRandomSource } from '@mezon/test-utils';
import { afterEach, describe, expect, it } from 'vitest';
import { createHubServer } from './index.js';

const tempDirs: string[] = [];
const TEST_PORT = 47835;
const HOST_HEADER = `127.0.0.1:${TEST_PORT}`;

function makeDbPath(name = 'hub-cart.db'): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mezon-hub-cart-'));
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

describe('@mezon/hub - T1.3 Cart, Promotions (N+M), P1/P2/P3 Discount Policy, PIN Lockout & RBAC', () => {
  it('enforces full RBAC, P1 line merge & N+M, P2 override_approved_amount, T0.6 PIN lockout, P3 unlimited audit, and zero cost leak', async () => {
    const clock = new FixedClock(1_760_000_000_000n);
    const logLines: string[] = [];
    const logStream = new Writable({
      write(chunk, _enc, cb) {
        logLines.push(Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk));
        cb();
      },
    });

    const hub = await createHubServer({
      dbPath: makeDbPath(),
      port: TEST_PORT,
      logLevel: 'warn',
      logStream,
      clock,
      random: new SeededRandomSource(91),
      pinHasher: makeFastTestHasher(),
    });

    try {
      // 1. Setup owner, create manager & cashier, log all 3 in
      const setupRes = await hub.app.inject({
        method: 'POST',
        url: '/setup',
        headers: hostHeaders(),
        payload: {
          owner: { fullName: 'Ega T13', username: 'owner13', pin: '849201' },
        },
      });
      expect(setupRes.statusCode).toBe(201);

      const ownerLogin = LoginResponseSchema.parse(
        (
          await hub.app.inject({
            method: 'POST',
            url: '/auth/login',
            headers: hostHeaders(),
            payload: { username: 'owner13', pin: '849201' },
          })
        ).json(),
      );

      await hub.app.inject({
        method: 'POST',
        url: '/users',
        headers: authHeaders(ownerLogin.token),
        payload: { fullName: 'Menejer T13', username: 'mgr13', role: 'manager', pin: '592817' },
      });
      await hub.app.inject({
        method: 'POST',
        url: '/users',
        headers: authHeaders(ownerLogin.token),
        payload: { fullName: 'Kassir T13', username: 'cash13', role: 'cashier', pin: '374829' },
      });

      const mgrLogin = LoginResponseSchema.parse(
        (
          await hub.app.inject({
            method: 'POST',
            url: '/auth/login',
            headers: hostHeaders(),
            payload: { username: 'mgr13', pin: '592817' },
          })
        ).json(),
      );
      const cashierLogin = LoginResponseSchema.parse(
        (
          await hub.app.inject({
            method: 'POST',
            url: '/auth/login',
            headers: hostHeaders(),
            payload: { username: 'cash13', pin: '374829' },
          })
        ).json(),
      );

      // 2. P3: default cashier limits are 0% / 0 amount, unlimited=false; manager/cashier cannot PUT /cart-settings
      const defaultSettings = CartSettingsResponseSchema.parse(
        (
          await hub.app.inject({
            method: 'GET',
            url: '/cart-settings',
            headers: authHeaders(cashierLogin.token),
          })
        ).json(),
      );
      expect(defaultSettings.cashierDiscountLimit).toEqual({
        percentUnlimited: false,
        maxPercentBp: 0,
        amountUnlimited: false,
        maxAmount: '0',
      });
      expect(defaultSettings.unlimitedDiscountEnabled).toBe(false);

      const mgrSettingsForbidden = await hub.app.inject({
        method: 'PUT',
        url: '/cart-settings',
        headers: authHeaders(mgrLogin.token),
        payload: {
          cashierDiscountLimit: {
            percentUnlimited: false,
            maxPercentBp: 500,
            amountUnlimited: false,
            maxAmount: '100000',
          },
        },
      });
      expect(mgrSettingsForbidden.statusCode).toBe(403);
      expect(ApiErrorEnvelopeSchema.parse(mgrSettingsForbidden.json()).error.code).toBe(
        'AUTH_FORBIDDEN',
      );

      const cashSettingsForbidden = await hub.app.inject({
        method: 'PUT',
        url: '/cart-settings',
        headers: authHeaders(cashierLogin.token),
        payload: {
          cashierDiscountLimit: {
            percentUnlimited: false,
            maxPercentBp: 500,
            amountUnlimited: false,
            maxAmount: '100000',
          },
        },
      });
      expect(cashSettingsForbidden.statusCode).toBe(403);

      // P3 null/omitted rejection (400 VALIDATION_ERROR)
      const nullUnlimitedBad = await hub.app.inject({
        method: 'PUT',
        url: '/cart-settings',
        headers: authHeaders(ownerLogin.token),
        payload: {
          cashierDiscountLimit: {
            maxPercentBp: null,
            maxAmount: '0',
          },
        },
      });
      expect(nullUnlimitedBad.statusCode).toBe(400);

      // Owner sets 5% / 20,000 limit + quick-sale defaults
      const ownerUpdateSettings = await hub.app.inject({
        method: 'PUT',
        url: '/cart-settings',
        headers: authHeaders(ownerLogin.token),
        payload: {
          cashierDiscountLimit: {
            percentUnlimited: false,
            maxPercentBp: 500,
            amountUnlimited: false,
            maxAmount: '20000',
          },
          quickSaleDefaultMxik: '10203040506070809',
          quickSaleDefaultVatRateBp: 1200,
        },
      });
      expect(ownerUpdateSettings.statusCode).toBe(200);
      expect(
        CartSettingsResponseSchema.parse(ownerUpdateSettings.json()).unlimitedDiscountEnabled,
      ).toBe(false);

      // 3. Product & Promotions RBAC (cashier 403 on POST/PATCH/DELETE promotions; manager 201)
      const colaCreated = ProductDetailResponseSchema.parse(
        (
          await hub.app.inject({
            method: 'POST',
            url: '/products',
            headers: authHeaders(mgrLogin.token),
            payload: {
              name: 'Pepsi 1.5L',
              unit: 'dona',
              salePrice: '100000',
              vatRateBp: 1200,
              barcodes: [{ barcode: '4600494000119', format: 'ean13' }],
            },
          })
        ).json(),
      );

      const cashPromoForbidden = await hub.app.inject({
        method: 'POST',
        url: '/promotions',
        headers: authHeaders(cashierLogin.token),
        payload: {
          name: 'Blocked',
          type: 'percent',
          scope: 'all',
          discountPercentBp: 1000,
          startsAtMs: '1759999000000',
        },
      });
      expect(cashPromoForbidden.statusCode).toBe(403);

      const promoCreateRes = await hub.app.inject({
        method: 'POST',
        url: '/promotions',
        headers: authHeaders(mgrLogin.token),
        payload: {
          name: 'Pepsi 2+1',
          type: 'buy_x_get_y',
          scope: 'product',
          targetProductId: colaCreated.product.id,
          buyQty: 2,
          freeQty: 1,
          startsAtMs: '1759999000000',
          endsAtMs: '1760100000000',
        },
      });
      expect(promoCreateRes.statusCode).toBe(201);
      const promoDto = PromotionResponseSchema.parse(promoCreateRes.json()).promotion;
      expect(promoDto.buyQty).toBe(2);

      const cashPromoRead = await hub.app.inject({
        method: 'GET',
        url: '/promotions?activeOnly=true',
        headers: authHeaders(cashierLogin.token),
      });
      expect(cashPromoRead.statusCode).toBe(200);
      expect(ListPromotionsResponseSchema.parse(cashPromoRead.json()).promotions).toHaveLength(1);

      // 4. Cashier opens cart, scans barcode 3 times -> P1 merges into 1 line qty=3 -> 1 free unit (200,000 total)
      const openCartRes = await hub.app.inject({
        method: 'POST',
        url: '/carts',
        headers: authHeaders(cashierLogin.token),
      });
      expect(openCartRes.statusCode).toBe(201);
      const cartId = CartResponseSchema.parse(openCartRes.json()).cart.id;

      for (let i = 0; i < 3; i++) {
        await hub.app.inject({
          method: 'POST',
          url: `/carts/${cartId}/lines`,
          headers: authHeaders(cashierLogin.token),
          payload: { kind: 'scan', barcode: '4600494000119' },
        });
      }

      const afterScans = CartResponseSchema.parse(
        (
          await hub.app.inject({
            method: 'GET',
            url: `/carts/${cartId}`,
            headers: authHeaders(cashierLogin.token),
          })
        ).json(),
      ).cart;
      expect(afterScans.lines).toHaveLength(1);
      expect(afterScans.lines[0]?.qty).toBe('3000');
      expect(afterScans.totalFreeUnits).toBe(1);
      expect(afterScans.totalFinal).toBe('200000');

      // Ensure zero cost/margin/profit/pinHash leaks
      const serialized = JSON.stringify(afterScans);
      expect(serialized).not.toMatch(/cost|margin|profit|pinHash/i);

      // Reduce qty back to 1 (total = 100,000) to test discount limits & P2 clean arithmetic
      const firstLine = afterScans.lines[0];
      if (!firstLine) {
        throw new Error('Expected merged line');
      }
      const firstLineId = firstLine.id;
      await hub.app.inject({
        method: 'PATCH',
        url: `/carts/${cartId}/lines/${firstLineId}`,
        headers: authHeaders(cashierLogin.token),
        payload: { qty: '1000' },
      });

      // Within 5% limit -> succeeds without override (5% on 100,000 = 5,000 <= 20,000)
      const withinLimitRes = await hub.app.inject({
        method: 'PUT',
        url: `/carts/${cartId}/discount`,
        headers: authHeaders(cashierLogin.token),
        payload: { mode: 'percent', percentBp: 500 },
      });
      expect(withinLimitRes.statusCode).toBe(200);
      expect(CartResponseSchema.parse(withinLimitRes.json()).cart.totalFinal).toBe('95000');

      // 5. Exceeds 5% limit (10% = 10,000): without override -> 403 DISCOUNT_OVERRIDE_REQUIRED
      const noOverrideRes = await hub.app.inject({
        method: 'PUT',
        url: `/carts/${cartId}/discount`,
        headers: authHeaders(cashierLogin.token),
        payload: { mode: 'percent', percentBp: 1000 },
      });
      expect(noOverrideRes.statusCode).toBe(403);
      expect(ApiErrorEnvelopeSchema.parse(noOverrideRes.json()).error.code).toBe(
        'DISCOUNT_OVERRIDE_REQUIRED',
      );

      // Cashier PIN rejected as supervisor override (403 AUTH_FORBIDDEN)
      const cashierOverrideRes = await hub.app.inject({
        method: 'PUT',
        url: `/carts/${cartId}/discount`,
        headers: authHeaders(cashierLogin.token),
        payload: {
          mode: 'percent',
          percentBp: 1000,
          override: { username: 'cash13', pin: '374829' },
        },
      });
      expect(cashierOverrideRes.statusCode).toBe(403);
      expect(ApiErrorEnvelopeSchema.parse(cashierOverrideRes.json()).error.code).toBe(
        'AUTH_FORBIDDEN',
      );

      // Wrong manager PIN -> 401; 5 failures triggers T0.6 user lockout (429 AUTH_RATE_LIMITED)
      for (let attempt = 1; attempt <= 4; attempt++) {
        const badPin = await hub.app.inject({
          method: 'PUT',
          url: `/carts/${cartId}/discount`,
          headers: authHeaders(cashierLogin.token),
          payload: {
            mode: 'percent',
            percentBp: 1000,
            override: { username: 'mgr13', pin: '999999' },
          },
        });
        expect(badPin.statusCode).toBe(401);
      }
      const fifthBadPin = await hub.app.inject({
        method: 'PUT',
        url: `/carts/${cartId}/discount`,
        headers: authHeaders(cashierLogin.token),
        payload: {
          mode: 'percent',
          percentBp: 1000,
          override: { username: 'mgr13', pin: '999999' },
        },
      });
      expect(fifthBadPin.statusCode).toBe(401);

      // Now even CORRECT manager PIN is rate-limited (429 with Retry-After)!
      const lockedOut = await hub.app.inject({
        method: 'PUT',
        url: `/carts/${cartId}/discount`,
        headers: authHeaders(cashierLogin.token),
        payload: {
          mode: 'percent',
          percentBp: 1000,
          override: { username: 'mgr13', pin: '592817' },
        },
      });
      expect(lockedOut.statusCode).toBe(429);
      expect(Number(lockedOut.headers['retry-after'])).toBeGreaterThan(0);

      // Advance clock past 5 minutes -> manager PIN succeeds cleanly (creates approval ceiling 10,000)!
      clock.advance(301_000n);
      // Note: ensure promo stays active or verify with clock advance (endsAtMs = 1_760_100_000_000n > 1_760_000_301_000n)
      const mgrApproveRes = await hub.app.inject({
        method: 'PUT',
        url: `/carts/${cartId}/discount`,
        headers: authHeaders(cashierLogin.token),
        payload: {
          mode: 'percent',
          percentBp: 1000,
          reason: 'Doimiy mijoz',
          override: { username: 'mgr13', pin: '592817' },
        },
      });
      expect(mgrApproveRes.statusCode).toBe(200);
      const approvedCart = CartResponseSchema.parse(mgrApproveRes.json()).cart;
      expect(approvedCart.overrideApprovedByUserId).toBe(mgrLogin.user.id);
      expect(approvedCart.overrideApprovedAmount).toBe('10000');
      expect(approvedCart.discountOverrideRequired).toBe(false);

      // 6. P2: Cart grows -> discount becomes 20,000 > overrideApprovedAmount (10,000) -> approval REVOKED!
      const grownRes = await hub.app.inject({
        method: 'POST',
        url: `/carts/${cartId}/lines`,
        headers: authHeaders(cashierLogin.token),
        payload: {
          kind: 'quick_sale',
          name: 'Qo‘shimcha xizmat',
          unit: 'dona',
          qty: '1000',
          unitPrice: '100000',
        },
      });
      expect(grownRes.statusCode).toBe(201);
      const grownCart = CartResponseSchema.parse(grownRes.json()).cart;
      expect(grownCart.overrideApprovedByUserId).toBeNull();
      expect(grownCart.overrideApprovedAmount).toBeNull();
      expect(grownCart.discountOverrideRequired).toBe(true);
      expect(grownCart.lines[1]?.mxikSnapshot).toBe('10203040506070809');

      // Re-confirming 10% discount without supervisor PIN fails with 403 DISCOUNT_OVERRIDE_REQUIRED!
      const revokedConfirm = await hub.app.inject({
        method: 'PUT',
        url: `/carts/${cartId}/discount`,
        headers: authHeaders(cashierLogin.token),
        payload: { mode: 'percent', percentBp: 1000 },
      });
      expect(revokedConfirm.statusCode).toBe(403);
      expect(ApiErrorEnvelopeSchema.parse(revokedConfirm.json()).error.code).toBe(
        'DISCOUNT_OVERRIDE_REQUIRED',
      );

      // Park -> List -> Resume -> Delete cart flow
      const parked = CartResponseSchema.parse(
        (
          await hub.app.inject({
            method: 'POST',
            url: `/carts/${cartId}/park`,
            headers: authHeaders(cashierLogin.token),
            payload: { label: 'Stol 4' },
          })
        ).json(),
      ).cart;
      expect(parked.status).toBe('parked');
      expect(
        ListCartsResponseSchema.parse(
          (
            await hub.app.inject({
              method: 'GET',
              url: '/carts',
              headers: authHeaders(cashierLogin.token),
            })
          ).json(),
        ).carts,
      ).toHaveLength(1);

      const resumed = CartResponseSchema.parse(
        (
          await hub.app.inject({
            method: 'POST',
            url: `/carts/${cartId}/resume`,
            headers: authHeaders(cashierLogin.token),
          })
        ).json(),
      ).cart;
      expect(resumed.status).toBe('open');

      // Price change warning -> refresh-prices -> line delete -> cart delete & promotion update/delete
      await hub.app.inject({
        method: 'PATCH',
        url: `/products/${colaCreated.product.id}`,
        headers: authHeaders(mgrLogin.token),
        payload: { salePrice: '115000', priceChangeReason: 'Narx oshdi' },
      });
      const withPriceWarn = CartResponseSchema.parse(
        (
          await hub.app.inject({
            method: 'GET',
            url: `/carts/${cartId}`,
            headers: authHeaders(cashierLogin.token),
          })
        ).json(),
      ).cart;
      expect(withPriceWarn.priceWarningsCount).toBe(1);

      const afterRefresh = CartResponseSchema.parse(
        (
          await hub.app.inject({
            method: 'POST',
            url: `/carts/${cartId}/refresh-prices`,
            headers: authHeaders(cashierLogin.token),
          })
        ).json(),
      ).cart;
      expect(afterRefresh.priceWarningsCount).toBe(0);
      expect(afterRefresh.lines[0]?.unitPriceSnapshot).toBe('115000');

      const secondLine = afterRefresh.lines[1];
      if (!secondLine) {
        throw new Error('Expected second cart line');
      }
      const secondLineId = secondLine.id;
      const afterLineDel = CartResponseSchema.parse(
        (
          await hub.app.inject({
            method: 'DELETE',
            url: `/carts/${cartId}/lines/${secondLineId}`,
            headers: authHeaders(cashierLogin.token),
          })
        ).json(),
      ).cart;
      expect(afterLineDel.lines).toHaveLength(1);

      const delCartRes = await hub.app.inject({
        method: 'DELETE',
        url: `/carts/${cartId}`,
        headers: authHeaders(cashierLogin.token),
      });
      expect(delCartRes.statusCode).toBe(200);

      // Promotion update & tombstone delete (cashier 403, manager 200)
      const patchPromo = await hub.app.inject({
        method: 'PATCH',
        url: `/promotions/${promoDto.id}`,
        headers: authHeaders(mgrLogin.token),
        payload: { name: 'Pepsi 2+1 Yangi', isActive: false },
      });
      expect(patchPromo.statusCode).toBe(200);
      expect(PromotionResponseSchema.parse(patchPromo.json()).promotion.isActive).toBe(false);

      const cashDelPromo = await hub.app.inject({
        method: 'DELETE',
        url: `/promotions/${promoDto.id}`,
        headers: authHeaders(cashierLogin.token),
      });
      expect(cashDelPromo.statusCode).toBe(403);

      const mgrDelPromo = await hub.app.inject({
        method: 'DELETE',
        url: `/promotions/${promoDto.id}`,
        headers: authHeaders(mgrLogin.token),
      });
      expect(mgrDelPromo.statusCode).toBe(200);

      // 7. P3: Owner enables unlimited discount -> response flags it AND Pino logs warning cleanly (no PINs in logs!)
      const unlimRes = await hub.app.inject({
        method: 'PUT',
        url: '/cart-settings',
        headers: authHeaders(ownerLogin.token),
        payload: {
          cashierDiscountLimit: {
            percentUnlimited: true,
            maxPercentBp: 0,
            amountUnlimited: true,
            maxAmount: '0',
          },
        },
      });
      expect(unlimRes.statusCode).toBe(200);
      const unlimDto = CartSettingsResponseSchema.parse(unlimRes.json());
      expect(unlimDto.unlimitedDiscountEnabled).toBe(true);

      const combinedLogs = logLines.join('');
      expect(combinedLogs).toContain('discount_policy.unlimited_enabled');
      expect(combinedLogs).not.toContain('592817');
      expect(combinedLogs).not.toContain('849201');
      expect(combinedLogs).not.toContain('374829');
    } finally {
      await hub.close();
    }
  });
});
