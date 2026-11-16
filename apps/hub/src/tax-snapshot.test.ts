import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ApiErrorEnvelopeSchema,
  CartResponseSchema,
  CompleteSaleResponseSchema,
  CreateReturnResponseSchema,
  DailySalesReportResponseSchema,
  DeliverOrderResponseSchema,
  ExcelImportCommitResponseSchema,
  ExcelImportPreviewResponseSchema,
  ListProductsResponseSchema,
  LoginResponseSchema,
  MissingMxikCountResponseSchema,
  OrderActionResponseSchema,
  PrintDocumentResponseSchema,
  ProductDetailResponseSchema,
  SetupResponseSchema,
  TaxProfileResponseSchema,
} from '@mezon/contracts';
import { FakePrinterDriver } from '@mezon/drivers';
import type { PinHasher, UuidV7 } from '@mezon/domain';
import { FixedClock, SeededRandomSource } from '@mezon/test-utils';
import ExcelJS from 'exceljs';
import { afterEach, describe, expect, it } from 'vitest';
import { type HubServer, createHubServer } from './index.js';

/**
 * T3.1 hub integration: organization tax profile (RBAC, deterministic id, audit user, outbox),
 * receipt snapshot immutability across every read path, effective VAT for NEW lines only,
 * "MXIK'siz" list and Excel fiscal columns.
 */

const tempDirs: string[] = [];
const TEST_PORT = 47851;
const HOST_HEADER = `127.0.0.1:${TEST_PORT}`;

const fastHasher: PinHasher = {
  hash: (pin) => Promise.resolve(`fast-stub-hash:${pin}`),
  verify: (stored, pin) => Promise.resolve(stored === `fast-stub-hash:${pin}`),
};

function hdr(token?: string): Record<string, string> {
  return token ? { host: HOST_HEADER, authorization: `Bearer ${token}` } : { host: HOST_HEADER };
}

afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

interface Actors {
  readonly hub: HubServer;
  readonly organizationId: UuidV7;
  readonly owner: { readonly id: string; readonly token: string };
  readonly manager: { readonly id: string; readonly token: string };
  readonly cashier: { readonly id: string; readonly token: string };
  readonly fake: FakePrinterDriver;
  nextReq: () => string;
}

async function bootHub(seed: number, clockMs = 1_762_900_000_000n): Promise<Actors> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mezon-hub-t31-'));
  tempDirs.push(dir);
  const fake = new FakePrinterDriver({ mode: 'network_tcp', target: '192.168.1.200:9100' });
  const hub = await createHubServer({
    dbPath: path.join(dir, 'hub.db'),
    port: TEST_PORT,
    logLevel: 'silent',
    clock: new FixedClock(clockMs),
    random: new SeededRandomSource(seed),
    pinHasher: fastHasher,
    printerDriverFactory: () => fake,
  });
  let n = 1;
  const nextReq = () =>
    `01993100-0000-7000-8000-${(seed * 100000 + n++).toString(16).padStart(12, '0')}`;

  const setupRes = await hub.app.inject({
    method: 'POST',
    url: '/setup',
    headers: hdr(),
    payload: { owner: { fullName: 'Egasi', username: 'owner', pin: '849201' } },
  });
  const organizationId = SetupResponseSchema.parse(setupRes.json()).organizationId;
  const login = async (username: string, pin: string) => {
    const res = await hub.app.inject({
      method: 'POST',
      url: '/auth/login',
      headers: hdr(),
      payload: { username, pin },
    });
    const body = LoginResponseSchema.parse(res.json());
    return { id: body.user.id, token: body.token };
  };
  const owner = await login('owner', '849201');
  for (const u of [
    { fullName: 'Menejer', username: 'mgr', role: 'manager', pin: '739104' },
    { fullName: 'Kassir', username: 'kassa', role: 'cashier', pin: '582914' },
  ]) {
    const r = await hub.app.inject({
      method: 'POST',
      url: '/users',
      headers: hdr(owner.token),
      payload: u,
    });
    expect(r.statusCode).toBe(201);
  }
  const manager = await login('mgr', '739104');
  const cashier = await login('kassa', '582914');
  return { hub, organizationId, owner, manager, cashier, fake, nextReq };
}

const PROFILE_PAYER = {
  tin: '305123456',
  legalName: '"Guzar Savdo" MChJ',
  legalAddress: 'Kattaqoʻrgʻon sh., Mustaqillik 1',
  isVatPayer: true,
  defaultVatRateBp: 1200,
};

describe('T3.1 organization tax profile API', () => {
  it('RBAC: cashier 403 on read and write; manager/owner can read and write', async () => {
    const a = await bootHub(3101);
    try {
      for (const method of ['GET', 'PUT'] as const) {
        const res = await a.hub.app.inject({
          method,
          url: '/settings/tax',
          headers: hdr(a.cashier.token),
          ...(method === 'PUT' ? { payload: PROFILE_PAYER } : {}),
        });
        expect(res.statusCode, method).toBe(403);
        expect(ApiErrorEnvelopeSchema.parse(res.json()).error.code).toBe('AUTH_FORBIDDEN');
      }
      const empty = await a.hub.app.inject({
        method: 'GET',
        url: '/settings/tax',
        headers: hdr(a.manager.token),
      });
      expect(empty.statusCode).toBe(200);
      expect(TaxProfileResponseSchema.parse(empty.json()).profile).toBeNull();

      const put = await a.hub.app.inject({
        method: 'PUT',
        url: '/settings/tax',
        headers: hdr(a.manager.token),
        payload: PROFILE_PAYER,
      });
      expect(put.statusCode).toBe(200);
      const ownerRead = await a.hub.app.inject({
        method: 'GET',
        url: '/settings/tax',
        headers: hdr(a.owner.token),
      });
      expect(TaxProfileResponseSchema.parse(ownerRead.json()).profile?.tin).toBe('305123456');
      // No unauthenticated access
      const anon = await a.hub.app.inject({ method: 'GET', url: '/settings/tax', headers: hdr() });
      expect(anon.statusCode).toBe(401);
    } finally {
      await a.hub.close();
    }
  });

  it('STIR validation: 8/10 digits, letters, spaces are rejected with 400 and nothing is written', async () => {
    const a = await bootHub(3102);
    try {
      for (const tin of ['12345678', '1234567890', '12345678a', '1234 5678', '']) {
        const res = await a.hub.app.inject({
          method: 'PUT',
          url: '/settings/tax',
          headers: hdr(a.owner.token),
          payload: { ...PROFILE_PAYER, tin },
        });
        expect(res.statusCode, tin).toBe(400);
      }
      const read = await a.hub.app.inject({
        method: 'GET',
        url: '/settings/tax',
        headers: hdr(a.owner.token),
      });
      expect(TaxProfileResponseSchema.parse(read.json()).profile).toBeNull();
      const outboxCount = a.hub.connection.sqlite
        .prepare(
          `SELECT COUNT(*) AS n FROM local_outbox WHERE entity = 'organization_tax_profiles'`,
        )
        .get() as { n: bigint };
      expect(outboxCount.n).toBe(0n);
    } finally {
      await a.hub.close();
    }
  });

  it('T1 + T3: id equals organization_id; every write records updated_by_user_id and an outbox ATTR event carrying it', async () => {
    const a = await bootHub(3103);
    try {
      const created = TaxProfileResponseSchema.parse(
        (
          await a.hub.app.inject({
            method: 'PUT',
            url: '/settings/tax',
            headers: hdr(a.manager.token),
            payload: PROFILE_PAYER,
          })
        ).json(),
      ).profile;
      expect(created?.id).toBe(a.organizationId);
      expect(created?.organizationId).toBe(a.organizationId);
      expect(created?.updatedByUserId).toBe(a.manager.id);

      const updated = TaxProfileResponseSchema.parse(
        (
          await a.hub.app.inject({
            method: 'PUT',
            url: '/settings/tax',
            headers: hdr(a.owner.token),
            payload: { ...PROFILE_PAYER, isVatPayer: false, legalName: 'Yangi nom MChJ' },
          })
        ).json(),
      ).profile;
      expect(updated?.id).toBe(a.organizationId);
      expect(updated?.updatedByUserId).toBe(a.owner.id);
      expect(updated?.isVatPayer).toBe(false);

      const rows = a.hub.connection.sqlite
        .prepare(
          `SELECT type, class, entity_id, payload FROM local_outbox
           WHERE entity = 'organization_tax_profiles' ORDER BY device_seq`,
        )
        .all() as Array<{ type: string; class: string; entity_id: string; payload: string }>;
      expect(rows.map((r) => r.type)).toEqual([
        'organization_tax_profile.created',
        'organization_tax_profile.updated',
      ]);
      expect(rows.every((r) => r.class === 'ATTR' && r.entity_id === a.organizationId)).toBe(true);
      expect(rows[0]?.payload).toContain(a.manager.id);
      expect(rows[1]?.payload).toContain(a.owner.id);
      expect(rows[1]?.payload).toContain('Yangi nom MChJ');

      // Exactly one physical row per organization.
      const count = a.hub.connection.sqlite
        .prepare('SELECT COUNT(*) AS n FROM organization_tax_profiles')
        .get() as { n: bigint };
      expect(count.n).toBe(1n);
    } finally {
      await a.hub.close();
    }
  });

  it('T1: two independent hubs of the same organization create the profile with the same entity id', async () => {
    // Same seed ⇒ same organization id on both hubs (precondition), but separate SQLite files/devices.
    const a = await bootHub(3104);
    const aOrg = a.organizationId;
    const aProfile = TaxProfileResponseSchema.parse(
      (
        await a.hub.app.inject({
          method: 'PUT',
          url: '/settings/tax',
          headers: hdr(a.owner.token),
          payload: PROFILE_PAYER,
        })
      ).json(),
    ).profile;
    await a.hub.close();

    const b = await bootHub(3104);
    try {
      expect(b.organizationId).toBe(aOrg);
      const bProfile = TaxProfileResponseSchema.parse(
        (
          await b.hub.app.inject({
            method: 'PUT',
            url: '/settings/tax',
            headers: hdr(b.manager.token),
            payload: { ...PROFILE_PAYER, legalName: 'Boshqa hub' },
          })
        ).json(),
      ).profile;
      expect(aProfile?.id).toBe(aOrg);
      expect(bProfile?.id).toBe(aProfile?.id);
    } finally {
      await b.hub.close();
    }
  });
});

describe('T3.1 receipt snapshot immutability (criterion 1) and NEW-line-only VAT (T2)', () => {
  it('sale detail, reprint, return, reports, order→sale and open cart keep old name/MXIK/VAT after product and profile edits', async () => {
    const a = await bootHub(3105);
    const { hub } = a;
    try {
      // Printer + tax profile (payer, 12%)
      expect(
        (
          await hub.app.inject({
            method: 'PATCH',
            url: '/printer/settings',
            headers: hdr(a.owner.token),
            payload: { mode: 'network_tcp', host: '192.168.1.200', port: 9100 },
          })
        ).statusCode,
      ).toBe(200);
      await hub.app.inject({
        method: 'PUT',
        url: '/settings/tax',
        headers: hdr(a.owner.token),
        payload: PROFILE_PAYER,
      });

      const mkProduct = async (name: string, mxik: string, price: string) => {
        const res = await hub.app.inject({
          method: 'POST',
          url: '/products',
          headers: hdr(a.owner.token),
          payload: { name, unit: 'dona', salePrice: price, mxik, vatRateBp: 1200, unlimited: true },
        });
        expect(res.statusCode).toBe(201);
        return ProductDetailResponseSchema.parse(res.json()).product.id;
      };
      const p1 = await mkProduct('Choy Ahmad', '10101001001000001', '1120000'); // 11 200 so'm
      const p2 = await mkProduct('Shakar', '10101001001000002', '560000');

      await hub.app.inject({
        method: 'POST',
        url: '/shifts/open',
        headers: hdr(a.cashier.token),
        payload: { clientRequestId: a.nextReq(), openingCash: '0' },
      });

      const newCart = async () =>
        CartResponseSchema.parse(
          (
            await hub.app.inject({
              method: 'POST',
              url: '/carts',
              headers: hdr(a.cashier.token),
              payload: {},
            })
          ).json(),
        ).cart.id;
      const addLine = async (cartId: string, payload: Record<string, unknown>) => {
        const res = await hub.app.inject({
          method: 'POST',
          url: `/carts/${cartId}/lines`,
          headers: hdr(a.cashier.token),
          payload,
        });
        expect(res.statusCode).toBe(201);
        return CartResponseSchema.parse(res.json()).cart;
      };

      // Sale S1 with p1 at 12%: VAT = 1 120 000 * 1200 / 11200 = 120 000 tiyin.
      const cartA = await newCart();
      await addLine(cartA, { kind: 'catalog', productId: p1, qty: '1000' });
      const s1 = CompleteSaleResponseSchema.parse(
        (
          await hub.app.inject({
            method: 'POST',
            url: `/carts/${cartA}/complete`,
            headers: hdr(a.cashier.token),
            payload: {
              clientRequestId: a.nextReq(),
              expectedTotal: '1120000',
              payments: [{ method: 'cash', tenderedAmount: '1120000' }],
            },
          })
        ).json(),
      ).sale;
      expect(s1.totalVat).toBe('120000');
      const firstPrint = PrintDocumentResponseSchema.parse(
        (
          await hub.app.inject({
            method: 'POST',
            url: `/sales/${s1.id}/print`,
            headers: hdr(a.cashier.token),
            payload: { clientRequestId: a.nextReq() },
          })
        ).json(),
      ).printRecord;
      expect(firstPrint.textPreview).toContain('Choy Ahmad');

      // Open cart B holds a p1 line; order O1 (draft) holds p1 — both BEFORE the edits.
      const cartB = await newCart();
      await addLine(cartB, { kind: 'catalog', productId: p1, qty: '1000' });
      const orderRes = await hub.app.inject({
        method: 'POST',
        url: '/orders',
        headers: hdr(a.cashier.token),
        payload: {
          clientRequestId: a.nextReq(),
          customerName: 'Mijoz T3.1',
          lines: [{ kind: 'catalog', productId: p1, qty: '1000' }],
        },
      });
      expect(orderRes.statusCode, orderRes.body).toBe(201);
      const orderId = OrderActionResponseSchema.parse(orderRes.json()).order.id;

      // ---- Edits: product name/MXIK/VAT AND organization becomes non-VAT-payer ----
      expect(
        (
          await hub.app.inject({
            method: 'PATCH',
            url: `/products/${p1}`,
            headers: hdr(a.owner.token),
            payload: { name: 'Choy YANGI', mxik: '99999999999999999', vatRateBp: 1500 },
          })
        ).statusCode,
      ).toBe(200);
      expect(
        (
          await hub.app.inject({
            method: 'PUT',
            url: '/settings/tax',
            headers: hdr(a.owner.token),
            payload: { ...PROFILE_PAYER, isVatPayer: false },
          })
        ).statusCode,
      ).toBe(200);

      // 1) Sale detail (store read path used by sale/print/return services)
      const s1After = await hub.saleStore.getSaleById(s1.id);
      expect(s1After?.lines[0]?.itemName).toBe('Choy Ahmad');
      expect(s1After?.lines[0]?.mxikSnapshot).toBe('10101001001000001');
      expect(s1After?.lines[0]?.vatRateBpSnapshot).toBe(1200);
      expect(s1After?.totalVat.toString()).toBe('120000');

      // 2) Reprint: same receipt content except the reprint marker
      const reprint = PrintDocumentResponseSchema.parse(
        (
          await hub.app.inject({
            method: 'POST',
            url: `/sales/${s1.id}/print`,
            headers: hdr(a.cashier.token),
            payload: { clientRequestId: a.nextReq() },
          })
        ).json(),
      ).printRecord;
      expect(reprint.isReprint).toBe(true);
      expect(reprint.textPreview).toContain('Choy Ahmad');
      expect(reprint.textPreview).not.toContain('YANGI');
      const stripReprint = (txt: string) =>
        txt
          .split('\n')
          .filter((l) => !l.includes('NUSXA'))
          .join('\n');
      expect(stripReprint(reprint.textPreview)).toBe(stripReprint(firstPrint.textPreview));

      // 3) Daily report (snapshot-based): VAT unchanged
      const daily = DailySalesReportResponseSchema.parse(
        (
          await hub.app.inject({
            method: 'GET',
            url: '/reports/sales/daily',
            headers: hdr(a.owner.token),
          })
        ).json(),
      );
      expect(daily.totalVat).toBe('120000');

      // 4) Return: lines copied from the sale line snapshot, not the product
      const ret = CreateReturnResponseSchema.parse(
        (
          await hub.app.inject({
            method: 'POST',
            url: `/sales/${s1.id}/returns`,
            headers: hdr(a.manager.token),
            payload: {
              clientRequestId: a.nextReq(),
              reason: 'Snapshot testi',
              items: [{ saleLineId: s1.lines[0]?.id, qty: '1000' }],
              payments: [{ method: 'cash', amount: '1120000' }],
            },
          })
        ).json(),
      ).returnDoc;
      expect(ret.lines[0]?.itemName).toBe('Choy Ahmad');
      expect(ret.lines[0]?.mxikSnapshot).toBe('10101001001000001');
      expect(ret.lines[0]?.vatRateBpSnapshot).toBe(1200);
      expect(ret.lines[0]?.vatTotal).toBe('120000');

      // 5) Order created before the edits → delivered sale keeps the order snapshot (T2)
      for (const step of ['confirm', 'ready']) {
        const res = await hub.app.inject({
          method: 'POST',
          url: `/orders/${orderId}/${step}`,
          headers: hdr(a.cashier.token),
          payload: { clientRequestId: a.nextReq() },
        });
        expect(res.statusCode, `${step}: ${res.body}`).toBe(200);
      }
      const deliverRes = await hub.app.inject({
        method: 'POST',
        url: `/orders/${orderId}/deliver`,
        headers: hdr(a.cashier.token),
        payload: {
          clientRequestId: a.nextReq(),
          expectedTotal: '1120000',
          payments: [{ method: 'cash', tenderedAmount: '1120000' }],
        },
      });
      expect(deliverRes.statusCode, deliverRes.body).toBe(200);
      const delivered = DeliverOrderResponseSchema.parse(deliverRes.json());
      expect(delivered.sale.lines[0]?.itemName).toBe('Choy Ahmad');
      expect(delivered.sale.lines[0]?.vatRateBpSnapshot).toBe(1200);
      expect(delivered.sale.totalVat).toBe('120000');

      // 6) Existing open-cart line is untouched by the profile change (T2)
      const cartBNow = CartResponseSchema.parse(
        (
          await hub.app.inject({
            method: 'GET',
            url: `/carts/${cartB}`,
            headers: hdr(a.cashier.token),
          })
        ).json(),
      ).cart;
      expect(cartBNow.lines[0]?.name).toBe('Choy Ahmad');
      expect(cartBNow.lines[0]?.vatRateBpSnapshot).toBe(1200);

      // NEW lines after the change: catalog (p2 @1200 → 0) and quick sale (1200 → 0)
      const cartBWithNew = await addLine(cartB, { kind: 'catalog', productId: p2, qty: '1000' });
      const p2Line = cartBWithNew.lines.find((l) => l.productId === p2);
      expect(p2Line?.vatRateBpSnapshot).toBe(0);
      const cartC = await newCart();
      const cartCDetail = await addLine(cartC, {
        kind: 'quick_sale',
        name: 'Bozor mahsuloti',
        unit: 'dona',
        qty: '1000',
        unitPrice: '1000000',
        vatRateBp: 1200,
      });
      expect(cartCDetail.lines[0]?.vatRateBpSnapshot).toBe(0);
      const cartD = await newCart();
      const cartDDetail = await addLine(cartD, { kind: 'catalog', productId: p1, qty: '1000' });
      expect(cartDDetail.lines[0]?.name).toBe('Choy YANGI');
      expect(cartDDetail.lines[0]?.vatRateBpSnapshot).toBe(0);
      // The product's own configured rate is untouched by the payer switch (S2).
      const p1Detail = ProductDetailResponseSchema.parse(
        (
          await hub.app.inject({
            method: 'GET',
            url: `/products/${p1}`,
            headers: hdr(a.owner.token),
          })
        ).json(),
      ).product;
      expect(p1Detail.vatRateBp).toBe(1500);

      // Explicit user "refresh prices" re-reads the catalog and so re-applies the effective rate.
      const refreshed = CartResponseSchema.parse(
        (
          await hub.app.inject({
            method: 'POST',
            url: `/carts/${cartB}/refresh-prices`,
            headers: hdr(a.cashier.token),
            payload: {},
          })
        ).json(),
      ).cart;
      const p1Refreshed = refreshed.lines.find((l) => l.productId === p1);
      expect(p1Refreshed?.name).toBe('Choy YANGI');
      expect(p1Refreshed?.vatRateBpSnapshot).toBe(0);

      // Switching back to payer: new lines get the product's (edited) rate again.
      await hub.app.inject({
        method: 'PUT',
        url: '/settings/tax',
        headers: hdr(a.owner.token),
        payload: PROFILE_PAYER,
      });
      const cartE = await newCart();
      const cartEDetail = await addLine(cartE, { kind: 'catalog', productId: p1, qty: '1000' });
      expect(cartEDetail.lines[0]?.vatRateBpSnapshot).toBe(1500);
    } finally {
      await hub.close();
    }
  });
});

describe("T3.1 MXIK'siz mahsulotlar", () => {
  it('lists/counts only active products without MXIK, supports text filter, readable by cashier', async () => {
    const a = await bootHub(3106);
    try {
      const mk = async (name: string, mxik: string | null) => {
        const res = await a.hub.app.inject({
          method: 'POST',
          url: '/products',
          headers: hdr(a.owner.token),
          payload: { name, unit: 'dona', salePrice: '100000', mxik },
        });
        return ProductDetailResponseSchema.parse(res.json()).product.id;
      };
      await mk('Olma', '10101001001000003');
      const noMxik1 = await mk('Non bugdoy', null);
      const noMxik2 = await mk('Non javdar', null);
      await mk('Sut', null);
      const deleted = await mk('Ochirilgan non', null);
      await a.hub.app.inject({
        method: 'DELETE',
        url: `/products/${deleted}`,
        headers: hdr(a.owner.token),
      });

      const count = MissingMxikCountResponseSchema.parse(
        (
          await a.hub.app.inject({
            method: 'GET',
            url: '/products/missing-mxik/count',
            headers: hdr(a.cashier.token),
          })
        ).json(),
      );
      expect(count.count).toBe(3);

      const all = ListProductsResponseSchema.parse(
        (
          await a.hub.app.inject({
            method: 'GET',
            url: '/products?missingMxik=true',
            headers: hdr(a.cashier.token),
          })
        ).json(),
      );
      expect(all.total).toBe(3);
      expect(all.products.every((p) => p.mxik === null)).toBe(true);
      expect(all.products.map((p) => p.name)).toEqual(['Non bugdoy', 'Non javdar', 'Sut']);

      const filtered = ListProductsResponseSchema.parse(
        (
          await a.hub.app.inject({
            method: 'GET',
            url: '/products?missingMxik=true&q=non',
            headers: hdr(a.cashier.token),
          })
        ).json(),
      );
      expect(filtered.products.map((p) => p.id).sort()).toEqual([noMxik1, noMxik2].sort());

      // Filling the MXIK removes it from the list.
      await a.hub.app.inject({
        method: 'PATCH',
        url: `/products/${noMxik1}`,
        headers: hdr(a.owner.token),
        payload: { mxik: '10101001001000004' },
      });
      const after = MissingMxikCountResponseSchema.parse(
        (
          await a.hub.app.inject({
            method: 'GET',
            url: '/products/missing-mxik/count',
            headers: hdr(a.owner.token),
          })
        ).json(),
      );
      expect(after.count).toBe(2);
    } finally {
      await a.hub.close();
    }
  });
});

describe('T3.1 Excel import/export fiscal columns', () => {
  async function workbookBase64(rows: ReadonlyArray<ReadonlyArray<string | number | null>>) {
    const wb = new ExcelJS.Workbook();
    const sheet = wb.addWorksheet('Mahsulotlar');
    sheet.addRow([
      'Nomi',
      'Artikul (SKU)',
      'Shtrix-kod',
      'Oʻlchov birligi',
      'Sotish narxi (soʻm)',
      'Minimal zaxira',
      'MXIK',
      'Qadoq kodi',
      'QQS (%)',
    ]);
    for (const r of rows) sheet.addRow([...r]);
    return Buffer.from(await wb.xlsx.writeBuffer()).toString('base64');
  }

  it('invalid MXIK/VAT/price are row-level errors with codes; valid rows import with fiscal fields and org default VAT', async () => {
    const a = await bootHub(3107);
    try {
      await a.hub.app.inject({
        method: 'PUT',
        url: '/settings/tax',
        headers: hdr(a.owner.token),
        payload: { ...PROFILE_PAYER, defaultVatRateBp: 1200 },
      });
      const fileBase64 = await workbookBase64([
        ['Choy', 'CH-1', '4780000000014', 'dona', '1 500,50', '5', '10101001001000005', 'P1', '12'],
        ['Yomon MXIK', null, null, 'dona', '1000', null, 'MXIK BOR!', null, null],
        ['Yomon QQS', null, null, 'dona', '1000', null, null, null, '150'],
        ['Kichik tiyin', null, null, 'dona', '0.005', null, null, null, null],
        ['Bo‘sh QQS', null, null, 'kg', 1500.5, '2.5', null, null, null],
        ['Float artefakt', null, null, 'dona', 0.1 + 0.2, null, null, null, null],
        ['Manfiy narx', null, null, 'dona', '-5', null, null, null, null],
        ['Juda katta', null, null, 'dona', '99999999999999999999', null, null, null, null],
        ['Matn narx', null, null, 'dona', 'abc', null, null, null, null],
      ]);
      const previewRes = await a.hub.app.inject({
        method: 'POST',
        url: '/catalog/import/preview',
        headers: hdr(a.owner.token),
        payload: { fileBase64 },
      });
      expect(previewRes.statusCode, previewRes.body).toBe(200);
      const preview = ExcelImportPreviewResponseSchema.parse(previewRes.json());
      expect(preview.totalRows).toBe(9);
      expect(preview.validRows).toBe(2);
      const codes = Object.fromEntries(preview.errors.map((e) => [e.rowNumber, e.code]));
      expect(codes).toEqual({
        3: 'excelImport.error.invalidMxik',
        4: 'excelImport.error.invalidVat',
        5: 'excelImport.error.invalidPrice',
        7: 'excelImport.error.invalidPrice',
        8: 'excelImport.error.invalidPrice',
        9: 'excelImport.error.invalidPrice',
        10: 'excelImport.error.invalidPrice',
      });
      const choy = preview.rows.find((r) => r.name === 'Choy');
      expect(choy?.salePrice).toBe('150050');
      expect(choy?.mxik).toBe('10101001001000005');
      expect(choy?.packageCode).toBe('P1');
      expect(choy?.vatRateBp).toBe(1200);
      const numeric = preview.rows.find((r) => r.name === 'Bo‘sh QQS');
      expect(numeric?.salePrice).toBe('150050'); // numeric cell 1500.5 → exact
      expect(numeric?.minStockMilli).toBe('2500');
      expect(numeric?.vatRateBp).toBe(1200); // empty → organization default

      const commitRes = await a.hub.app.inject({
        method: 'POST',
        url: '/catalog/import/commit',
        headers: hdr(a.owner.token),
        payload: { previewToken: preview.previewToken, clientRequestId: a.nextReq() },
      });
      expect(commitRes.statusCode, commitRes.body).toBe(200);
      const commit = ExcelImportCommitResponseSchema.parse(commitRes.json());
      expect(commit.importedProductsCount).toBe(2);
      const list = ListProductsResponseSchema.parse(
        (
          await a.hub.app.inject({
            method: 'GET',
            url: '/products',
            headers: hdr(a.owner.token),
          })
        ).json(),
      );
      const imported = list.products.find((p) => p.name === 'Choy');
      expect(imported?.mxik).toBe('10101001001000005');
      expect(imported?.packageCode).toBe('P1');
      expect(imported?.vatRateBp).toBe(1200);
      expect(imported?.salePrice).toBe('150050');
    } finally {
      await a.hub.close();
    }
  });

  it('round trip: export → import preview yields identical name/SKU/barcode/unit/price/minStock/MXIK/package/VAT', async () => {
    const a = await bootHub(3108);
    try {
      const products = [
        {
          name: 'Choy 0.5',
          sku: 'CH-05',
          unit: 'dona',
          salePrice: '1234567',
          minStock: '3000',
          mxik: '10101001001000006',
          packageCode: '1500234',
          vatRateBp: 1200,
          barcodes: [{ barcode: '4780000000021' }],
        },
        {
          name: 'Guruch',
          unit: 'kg',
          salePrice: '1999',
          minStock: '1250',
          mxik: null,
          packageCode: null,
          vatRateBp: 1250,
        },
      ];
      for (const p of products) {
        const res = await a.hub.app.inject({
          method: 'POST',
          url: '/products',
          headers: hdr(a.owner.token),
          payload: p,
        });
        expect(res.statusCode, res.body).toBe(201);
      }
      const exportRes = await a.hub.app.inject({
        method: 'GET',
        url: '/catalog/export',
        headers: hdr(a.owner.token),
      });
      expect(exportRes.statusCode).toBe(200);
      const fileBase64 = exportRes.rawPayload.toString('base64');
      const preview = ExcelImportPreviewResponseSchema.parse(
        (
          await a.hub.app.inject({
            method: 'POST',
            url: '/catalog/import/preview',
            headers: hdr(a.owner.token),
            payload: { fileBase64 },
          })
        ).json(),
      );
      expect(preview.errors).toEqual([]);
      const byName = new Map(preview.rows.map((r) => [r.name, r]));
      for (const p of products) {
        const r = byName.get(p.name);
        expect(r, p.name).toBeDefined();
        expect(r?.sku ?? null).toBe(p.sku ?? null);
        expect(r?.barcode ?? null).toBe(p.barcodes?.[0]?.barcode ?? null);
        expect(r?.unit).toBe(p.unit);
        expect(r?.salePrice).toBe(p.salePrice);
        expect(r?.minStockMilli).toBe(p.minStock);
        expect(r?.mxik).toBe(p.mxik);
        expect(r?.packageCode).toBe(p.packageCode);
        expect(r?.vatRateBp).toBe(p.vatRateBp);
      }
    } finally {
      await a.hub.close();
    }
  });
});
