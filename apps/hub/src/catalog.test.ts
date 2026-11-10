import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ApiErrorEnvelopeSchema,
  BarcodeResponseSchema,
  CategoryResponseSchema,
  ListCategoriesResponseSchema,
  ListPriceChangesResponseSchema,
  ListProductsResponseSchema,
  LoginResponseSchema,
  ProductDetailResponseSchema,
  ProductResponseSchema,
  ScanBarcodeResponseSchema,
  VariantResponseSchema,
} from '@mezon/contracts';
import type { PinHasher } from '@mezon/domain';
import { FixedClock, SeededRandomSource } from '@mezon/test-utils';
import { afterEach, describe, expect, it } from 'vitest';
import { createHubServer } from './index.js';

const tempDirs: string[] = [];
const TEST_PORT = 47833;
const HOST_HEADER = `127.0.0.1:${TEST_PORT}`;

function makeDbPath(name = 'hub-catalog.db'): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mezon-hub-cat-'));
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

function jsonHeaders(token?: string): Record<string, string> {
  return token ? { host: HOST_HEADER, authorization: `Bearer ${token}` } : { host: HOST_HEADER };
}

afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

describe('@mezon/hub - T1.1 Catalog API, RBAC, DTO safety, F2/F3/F5 & fiscal fields', () => {
  it('supports end-to-end catalog CRUD, UPC-A/EAN-13 scan, Uzbek/FTS5 search, RBAC, and zero cost leak', async () => {
    const clock = new FixedClock(1_760_000_000_000n);
    const hub = await createHubServer({
      dbPath: makeDbPath(),
      port: TEST_PORT,
      logLevel: 'silent',
      clock,
      random: new SeededRandomSource(101),
      pinHasher: makeFastTestHasher(),
    });

    try {
      // Unauthenticated requests blocked cleanly before and after setup
      const anonRes = await hub.app.inject({
        method: 'GET',
        url: '/products',
        headers: jsonHeaders(),
      });
      expect(anonRes.statusCode).toBe(401);

      // Setup first owner (no server restart before calling catalog routes)
      const setupRes = await hub.app.inject({
        method: 'POST',
        url: '/setup',
        headers: jsonHeaders(),
        payload: {
          owner: { fullName: 'Aziz Owner', username: 'owner', pin: '849201' },
        },
      });
      expect(setupRes.statusCode).toBe(201);

      const loginOwner = await hub.app.inject({
        method: 'POST',
        url: '/auth/login',
        headers: jsonHeaders(),
        payload: { username: 'owner', pin: '849201' },
      });
      expect(loginOwner.statusCode).toBe(200);
      const ownerToken = LoginResponseSchema.parse(loginOwner.json()).token;

      // Create manager and cashier accounts
      const mgrCreate = await hub.app.inject({
        method: 'POST',
        url: '/users',
        headers: authHeaders(ownerToken),
        payload: {
          fullName: 'Madina Manager',
          username: 'manager1',
          role: 'manager',
          pin: '739104',
        },
      });
      expect(mgrCreate.statusCode).toBe(201);

      const cashierCreate = await hub.app.inject({
        method: 'POST',
        url: '/users',
        headers: authHeaders(ownerToken),
        payload: {
          fullName: 'Karim Kassir',
          username: 'cashier1',
          role: 'cashier',
          pin: '582914',
        },
      });
      expect(cashierCreate.statusCode).toBe(201);

      const mgrToken = LoginResponseSchema.parse(
        (
          await hub.app.inject({
            method: 'POST',
            url: '/auth/login',
            headers: jsonHeaders(),
            payload: { username: 'manager1', pin: '739104' },
          })
        ).json(),
      ).token;

      const cashierToken = LoginResponseSchema.parse(
        (
          await hub.app.inject({
            method: 'POST',
            url: '/auth/login',
            headers: jsonHeaders(),
            payload: { username: 'cashier1', pin: '582914' },
          })
        ).json(),
      ).token;

      // Manager creates category hierarchy
      const parentCatRes = await hub.app.inject({
        method: 'POST',
        url: '/categories',
        headers: authHeaders(mgrToken),
        payload: { name: 'Ichimliklar', sortOrder: 1 },
      });
      expect(parentCatRes.statusCode).toBe(201);
      const parentCat = CategoryResponseSchema.parse(parentCatRes.json()).category;

      const childCatRes = await hub.app.inject({
        method: 'POST',
        url: '/categories',
        headers: authHeaders(mgrToken),
        payload: { name: 'Salqin ichimliklar', parentId: parentCat.id, sortOrder: 2 },
      });
      expect(childCatRes.statusCode).toBe(201);
      const childCat = CategoryResponseSchema.parse(childCatRes.json()).category;

      // Reject deleting parent category with child (409 CATEGORY_IN_USE)
      const blockedCatDel = await hub.app.inject({
        method: 'DELETE',
        url: `/categories/${parentCat.id}`,
        headers: authHeaders(mgrToken),
      });
      expect(blockedCatDel.statusCode).toBe(409);
      expect(ApiErrorEnvelopeSchema.parse(blockedCatDel.json()).error.code).toBe('CATEGORY_IN_USE');

      // Manager creates products with fiscal fields + UPC-A barcode
      const badQtyRes = await hub.app.inject({
        method: 'POST',
        url: '/products',
        headers: authHeaders(mgrToken),
        payload: {
          name: 'Bad qty',
          unit: 'dona',
          minStock: '1500',
          salePrice: '500000',
        },
      });
      expect(badQtyRes.statusCode).toBe(400);
      expect(ApiErrorEnvelopeSchema.parse(badQtyRes.json()).error.code).toBe(
        'INVALID_UNIT_QUANTITY',
      );

      const createCola = await hub.app.inject({
        method: 'POST',
        url: '/products',
        headers: authHeaders(mgrToken),
        payload: {
          categoryId: childCat.id,
          sku: 'COLA-Z',
          name: 'Coca-Cola Zero',
          unit: 'dona',
          minStock: '10000',
          salePrice: '1100000',
          mxik: '02202001001000001',
          packageCode: '998877',
          vatRateBp: 1200,
          barcodes: [{ barcode: '036000291452', format: 'upca' }],
          priceChangeReason: 'Boshlangich narx',
        },
      });
      expect(createCola.statusCode).toBe(201);
      const colaDetail = ProductDetailResponseSchema.parse(createCola.json());
      expect(colaDetail.barcodes[0]?.barcode).toBe('0036000291452');
      expect(colaDetail.product.vatRateBp).toBe(1200);

      // Another product in Cyrillic + fractional weight unit
      const createHavo = await hub.app.inject({
        method: 'POST',
        url: '/products',
        headers: authHeaders(mgrToken),
        payload: {
          categoryId: childCat.id,
          name: 'ҳаво тозалагич маъно хона',
          unit: 'kg',
          minStock: '5500', // 5.5 kg allowed
          salePrice: '2400000',
          barcodes: [{ barcode: 'INT-HAVO-1', format: 'internal' }],
        },
      });
      expect(createHavo.statusCode).toBe(201);
      const havoId = ProductDetailResponseSchema.parse(createHavo.json()).product.id;

      // Reject deleting child category while active product attached
      const blockedLeafCatDel = await hub.app.inject({
        method: 'DELETE',
        url: `/categories/${childCat.id}`,
        headers: authHeaders(mgrToken),
      });
      expect(blockedLeafCatDel.statusCode).toBe(409);

      // Adding duplicate EAN-13 form of existing UPC-A rejects with 409 BARCODE_ALREADY_EXISTS
      const dupBcRes = await hub.app.inject({
        method: 'POST',
        url: `/products/${havoId}/barcodes`,
        headers: authHeaders(mgrToken),
        payload: { barcode: '0036000291452', format: 'ean13' },
      });
      expect(dupBcRes.statusCode).toBe(409);
      expect(ApiErrorEnvelopeSchema.parse(dupBcRes.json()).error.code).toBe(
        'BARCODE_ALREADY_EXISTS',
      );

      // Bad GS1 check digit rejected with 400 INVALID_BARCODE_CHECK_DIGIT
      const badCheckRes = await hub.app.inject({
        method: 'POST',
        url: `/products/${havoId}/barcodes`,
        headers: authHeaders(mgrToken),
        payload: { barcode: '4006381333932', format: 'ean13' },
      });
      expect(badCheckRes.statusCode).toBe(400);
      expect(ApiErrorEnvelopeSchema.parse(badCheckRes.json()).error.code).toBe(
        'INVALID_BARCODE_CHECK_DIGIT',
      );

      // Update product price and check variant workflow
      clock.advance(5_000n);
      const patchCola = await hub.app.inject({
        method: 'PATCH',
        url: `/products/${colaDetail.product.id}`,
        headers: authHeaders(mgrToken),
        payload: { salePrice: '1250000', priceChangeReason: 'Narx yangilandi' },
      });
      expect(patchCola.statusCode).toBe(200);
      expect(ProductResponseSchema.parse(patchCola.json()).product.salePrice).toBe('1250000');

      const varCreate = await hub.app.inject({
        method: 'POST',
        url: `/products/${colaDetail.product.id}/variants`,
        headers: authHeaders(mgrToken),
        payload: {
          name: 'Banka 0.33L',
          sku: 'COLA-033',
          attributes: { hajm: '0.33L', turi: 'banka' },
          salePrice: '850000',
        },
      });
      expect(varCreate.statusCode).toBe(201);
      const variant = VariantResponseSchema.parse(varCreate.json()).variant;

      const varPatch = await hub.app.inject({
        method: 'PATCH',
        url: `/products/${colaDetail.product.id}/variants/${variant.id}`,
        headers: authHeaders(mgrToken),
        payload: { salePrice: null },
      });
      expect(varPatch.statusCode).toBe(200);
      expect(VariantResponseSchema.parse(varPatch.json()).variant.effectiveSalePrice).toBe(
        '1250000',
      );

      const varBcRes = await hub.app.inject({
        method: 'POST',
        url: `/products/${colaDetail.product.id}/barcodes`,
        headers: authHeaders(mgrToken),
        payload: {
          barcode: '96385074',
          format: 'ean8',
          variantId: variant.id,
        },
      });
      expect(varBcRes.statusCode).toBe(201);
      const varBc = BarcodeResponseSchema.parse(varBcRes.json()).barcode;

      // Cashier CAN read catalog, search (F2+F5), and scan BOTH UPC-A & EAN-13 forms cleanly
      const cashierCats = await hub.app.inject({
        method: 'GET',
        url: '/categories',
        headers: authHeaders(cashierToken),
      });
      expect(cashierCats.statusCode).toBe(200);
      expect(ListCategoriesResponseSchema.parse(cashierCats.json()).categories).toHaveLength(2);

      const scanUpca = await hub.app.inject({
        method: 'GET',
        url: '/catalog/scan?code=036000291452',
        headers: authHeaders(cashierToken),
      });
      expect(scanUpca.statusCode).toBe(200);
      const parsedScanUpca = ScanBarcodeResponseSchema.parse(scanUpca.json());
      expect(parsedScanUpca.product.id).toBe(colaDetail.product.id);
      expect(parsedScanUpca.quantity).toBeNull();

      const scanEan13 = await hub.app.inject({
        method: 'GET',
        url: '/catalog/scan?code=0036000291452',
        headers: authHeaders(cashierToken),
      });
      expect(scanEan13.statusCode).toBe(200);
      expect(ScanBarcodeResponseSchema.parse(scanEan13.json()).product.id).toBe(
        colaDetail.product.id,
      );

      const scanVar = await hub.app.inject({
        method: 'GET',
        url: '/catalog/scan?code=96385074',
        headers: authHeaders(cashierToken),
      });
      expect(scanVar.statusCode).toBe(200);
      expect(ScanBarcodeResponseSchema.parse(scanVar.json()).variant?.id).toBe(variant.id);

      const scanMissing = await hub.app.inject({
        method: 'GET',
        url: '/catalog/scan?code=4006381333931',
        headers: authHeaders(cashierToken),
      });
      expect(scanMissing.statusCode).toBe(404);

      // Search as cashier (zero, xona, havo, mano, and FTS operator safety NEAR)
      for (const [query, expectedId] of [
        ['zero', colaDetail.product.id],
        ['xona', havoId],
        ['havo', havoId],
        ['mano', havoId],
      ] as const) {
        const sr = await hub.app.inject({
          method: 'GET',
          url: `/products?q=${encodeURIComponent(query)}`,
          headers: authHeaders(cashierToken),
        });
        expect(sr.statusCode).toBe(200);
        const page = ListProductsResponseSchema.parse(sr.json());
        expect(page.products.map((p) => p.id)).toContain(expectedId);
        // Ensure zero leakage of sensitive keys in serialized JSON response
        const rawText = JSON.stringify(sr.json());
        expect(rawText).not.toMatch(/costPrice|cost_price|profit|margin|pinHash|nameSearch/i);
      }

      const ftsInjectionRes = await hub.app.inject({
        method: 'GET',
        url: `/products?q=${encodeURIComponent('NEAR OR " * - : (')}`,
        headers: authHeaders(cashierToken),
      });
      expect(ftsInjectionRes.statusCode).toBe(200);

      // RBAC: cashier BLOCKED from ALL catalog write routes AND price-changes history!
      const forbiddenRequests: ReadonlyArray<{
        readonly method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
        readonly url: string;
        readonly payload?: Record<string, unknown>;
      }> = [
        { method: 'GET', url: `/products/${colaDetail.product.id}/price-changes` },
        { method: 'POST', url: '/categories', payload: { name: 'Forbidden Cat' } },
        { method: 'PATCH', url: `/categories/${parentCat.id}`, payload: { name: 'Hack' } },
        { method: 'DELETE', url: `/categories/${parentCat.id}` },
        {
          method: 'POST',
          url: '/products',
          payload: { name: 'Forbidden', unit: 'dona', salePrice: '1000' },
        },
        { method: 'PATCH', url: `/products/${havoId}`, payload: { salePrice: '1' } },
        { method: 'DELETE', url: `/products/${havoId}` },
        {
          method: 'POST',
          url: `/products/${colaDetail.product.id}/variants`,
          payload: { name: 'Hack' },
        },
        {
          method: 'PATCH',
          url: `/products/${colaDetail.product.id}/variants/${variant.id}`,
          payload: { name: 'Hack' },
        },
        {
          method: 'DELETE',
          url: `/products/${colaDetail.product.id}/variants/${variant.id}`,
        },
        {
          method: 'POST',
          url: `/products/${havoId}/barcodes`,
          payload: { barcode: 'INT-HACK', format: 'internal' },
        },
        {
          method: 'DELETE',
          url: `/products/${colaDetail.product.id}/barcodes/${varBc.id}`,
        },
      ];

      for (const req of forbiddenRequests) {
        const res = await hub.app.inject({
          method: req.method,
          url: req.url,
          headers: authHeaders(cashierToken),
          payload: req.payload,
        });
        expect(res.statusCode).toBe(403);
        expect(ApiErrorEnvelopeSchema.parse(res.json()).error.code).toBe('AUTH_FORBIDDEN');
      }

      // Manager CAN read price history
      const priceHistRes = await hub.app.inject({
        method: 'GET',
        url: `/products/${colaDetail.product.id}/price-changes`,
        headers: authHeaders(mgrToken),
      });
      expect(priceHistRes.statusCode).toBe(200);
      const hist = ListPriceChangesResponseSchema.parse(priceHistRes.json()).priceChanges;
      expect(hist.length).toBeGreaterThanOrEqual(2);

      // Delete barcode, variant, product, then leaf & parent categories cleanly
      expect(
        (
          await hub.app.inject({
            method: 'DELETE',
            url: `/products/${colaDetail.product.id}/barcodes/${varBc.id}`,
            headers: authHeaders(ownerToken),
          })
        ).statusCode,
      ).toBe(200);
      expect(
        (
          await hub.app.inject({
            method: 'DELETE',
            url: `/products/${colaDetail.product.id}/variants/${variant.id}`,
            headers: authHeaders(ownerToken),
          })
        ).statusCode,
      ).toBe(200);
      expect(
        (
          await hub.app.inject({
            method: 'DELETE',
            url: `/products/${colaDetail.product.id}`,
            headers: authHeaders(ownerToken),
          })
        ).statusCode,
      ).toBe(200);
      expect(
        (
          await hub.app.inject({
            method: 'DELETE',
            url: `/products/${havoId}`,
            headers: authHeaders(ownerToken),
          })
        ).statusCode,
      ).toBe(200);
      expect(
        (
          await hub.app.inject({
            method: 'DELETE',
            url: `/categories/${childCat.id}`,
            headers: authHeaders(ownerToken),
          })
        ).statusCode,
      ).toBe(200);
      expect(
        (
          await hub.app.inject({
            method: 'DELETE',
            url: `/categories/${parentCat.id}`,
            headers: authHeaders(ownerToken),
          })
        ).statusCode,
      ).toBe(200);
    } finally {
      await hub.close();
    }
  });
});
