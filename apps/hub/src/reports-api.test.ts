import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  BackupListResponseSchema,
  CartResponseSchema,
  CreateBackupResponseSchema,
  DailySalesReportResponseSchema,
  ExcelImportCommitResponseSchema,
  ExcelImportPreviewResponseSchema,
  LoginResponseSchema,
  OpenShiftResponseSchema,
  ProductDetailResponseSchema,
  ProfitReportResponseSchema,
  StageRestoreResponseSchema,
} from '@mezon/contracts';
import type { PinHasher } from '@mezon/domain';
import { FixedClock, SeededRandomSource } from '@mezon/test-utils';
import ExcelJS from 'exceljs';
import { afterEach, describe, expect, it } from 'vitest';
import { createHubServer } from './index.js';

const tempDirs: string[] = [];
const TEST_PORT = 47839;
const HOST_HEADER = `127.0.0.1:${TEST_PORT}`;

function makeDbPath(name = 'hub-reports.db'): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mezon-hub-reports-'));
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

describe('T1.13: Hub Reports, Excel Port, and Backup/Restore API', () => {
  it('enforces RBAC cost isolation on daily sales, profit report, and Excel export', async () => {
    const clock = new FixedClock(1_760_000_000_000n);
    const hub = await createHubServer({
      dbPath: makeDbPath(),
      port: TEST_PORT,
      logLevel: 'silent',
      clock,
      random: new SeededRandomSource(203),
      pinHasher: makeFastTestHasher(),
    });

    try {
      // 1. Setup Owner, Manager, Cashier
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
        payload: { fullName: 'Manager', username: 'mgr1', role: 'manager', pin: '739104' },
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
            payload: { username: 'mgr1', pin: '739104' },
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

      // 2. Create product, inbound stock, open shift, and make a sale
      const createProdRes = await hub.app.inject({
        method: 'POST',
        url: '/products',
        headers: authHeaders(ownerToken),
        payload: {
          name: 'Shirin non',
          unit: 'dona',
          salePrice: '500000',
          vatRateBp: 0,
        },
      });
      expect(createProdRes.statusCode).toBe(201);
      const prodId = ProductDetailResponseSchema.parse(createProdRes.json()).product.id;

      await hub.app.inject({
        method: 'POST',
        url: '/stock/moves/in',
        headers: authHeaders(ownerToken),
        payload: {
          productId: prodId,
          qty: '20000',
          totalCostValue: '6000000',
          reason: 'purchase',
        },
      });

      await hub.app.inject({
        method: 'POST',
        url: '/shifts/open',
        headers: authHeaders(cashierToken),
        payload: {
          clientRequestId: '01950000-0000-7000-8000-000000000001',
          openingCash: '10000000',
        },
      });

      const openCartRes = await hub.app.inject({
        method: 'POST',
        url: '/carts',
        headers: authHeaders(cashierToken),
        payload: {},
      });
      expect(openCartRes.statusCode).toBe(201);
      const cartId = CartResponseSchema.parse(openCartRes.json()).cart.id;

      const addLineRes = await hub.app.inject({
        method: 'POST',
        url: `/carts/${cartId}/lines`,
        headers: authHeaders(cashierToken),
        payload: {
          kind: 'catalog',
          productId: prodId,
          qty: '2000',
        },
      });
      expect(addLineRes.statusCode).toBe(201);

      const completeRes = await hub.app.inject({
        method: 'POST',
        url: `/carts/${cartId}/complete`,
        headers: authHeaders(cashierToken),
        payload: {
          clientRequestId: '01950000-0000-7000-8000-000000000002',
          expectedTotal: '1000000',
          payments: [{ method: 'cash', tenderedAmount: '1000000' }],
        },
      });
      expect(completeRes.statusCode).toBe(200);

      // 3. Test /reports/sales/daily:
      // Cashier sees NO costValue and NO grossProfit
      const cashierDailyRes = await hub.app.inject({
        method: 'GET',
        url: '/reports/sales/daily',
        headers: authHeaders(cashierToken),
      });
      expect(cashierDailyRes.statusCode).toBe(200);
      const cashierDaily = DailySalesReportResponseSchema.parse(cashierDailyRes.json());
      expect(cashierDaily.totalCostValue).toBeUndefined();
      expect(cashierDaily.totalGrossProfit).toBeUndefined();
      expect(cashierDaily.days[0].costValue).toBeUndefined();
      expect(cashierDaily.days[0].grossProfit).toBeUndefined();

      // Manager also sees NO costValue and NO grossProfit
      const mgrDailyRes = await hub.app.inject({
        method: 'GET',
        url: '/reports/sales/daily',
        headers: authHeaders(mgrToken),
      });
      expect(mgrDailyRes.statusCode).toBe(200);
      const mgrDaily = DailySalesReportResponseSchema.parse(mgrDailyRes.json());
      expect(mgrDaily.totalCostValue).toBeUndefined();
      expect(mgrDaily.totalGrossProfit).toBeUndefined();

      // Owner DOES see costValue and grossProfit
      const ownerDailyRes = await hub.app.inject({
        method: 'GET',
        url: '/reports/sales/daily',
        headers: authHeaders(ownerToken),
      });
      expect(ownerDailyRes.statusCode).toBe(200);
      const ownerDaily = DailySalesReportResponseSchema.parse(ownerDailyRes.json());
      expect(ownerDaily.totalCostValue).toBe('600000'); // 2 * 3,000 = 6,000
      expect(ownerDaily.totalGrossProfit).toBe('400000'); // 10,000 - 6,000 = 4,000
      expect(ownerDaily.days[0].costValue).toBe('600000');
      expect(ownerDaily.days[0].grossProfit).toBe('400000');

      // 4. Test /reports/profit:
      // Cashier and Manager get 403 Forbidden!
      const cashierProfitRes = await hub.app.inject({
        method: 'GET',
        url: '/reports/profit',
        headers: authHeaders(cashierToken),
      });
      expect(cashierProfitRes.statusCode).toBe(403);

      const mgrProfitRes = await hub.app.inject({
        method: 'GET',
        url: '/reports/profit',
        headers: authHeaders(mgrToken),
      });
      expect(mgrProfitRes.statusCode).toBe(403);

      // Owner gets 200 with profit metrics
      const ownerProfitRes = await hub.app.inject({
        method: 'GET',
        url: '/reports/profit',
        headers: authHeaders(ownerToken),
      });
      expect(ownerProfitRes.statusCode).toBe(200);
      const ownerProfit = ProfitReportResponseSchema.parse(ownerProfitRes.json());
      expect(ownerProfit.totalNetRevenue).toBe('1000000');
      expect(ownerProfit.totalCostValue).toBe('600000');
      expect(ownerProfit.totalGrossProfit).toBe('400000');

      // 5. Test Excel Export /reports/sales/daily/export:
      // Cashier Excel export MUST NOT contain cost or profit headers
      const cashierExcelRes = await hub.app.inject({
        method: 'GET',
        url: '/reports/sales/daily/export',
        headers: authHeaders(cashierToken),
      });
      expect(cashierExcelRes.statusCode).toBe(200);
      const cashierWorkbook = new ExcelJS.Workbook();
      await cashierWorkbook.xlsx.load(cashierExcelRes.rawPayload as unknown as ArrayBuffer);
      const cashierSheet = cashierWorkbook.worksheets[0];
      const cashierHeaders = (cashierSheet.getRow(1).values as string[]).filter(Boolean);
      expect(cashierHeaders).not.toContain('Tannarx (soʻm)');
      expect(cashierHeaders).not.toContain('Yalpi foyda (soʻm)');

      // Owner Excel export DOES contain cost and profit headers
      const ownerExcelRes = await hub.app.inject({
        method: 'GET',
        url: '/reports/sales/daily/export',
        headers: authHeaders(ownerToken),
      });
      expect(ownerExcelRes.statusCode).toBe(200);
      const ownerWorkbook = new ExcelJS.Workbook();
      await ownerWorkbook.xlsx.load(ownerExcelRes.rawPayload as unknown as ArrayBuffer);
      const ownerSheet = ownerWorkbook.worksheets[0];
      const ownerHeaders = (ownerSheet.getRow(1).values as string[]).filter(Boolean);
      expect(ownerHeaders).toContain('Tannarx (soʻm)');
      expect(ownerHeaders).toContain('Yalpi foyda (soʻm)');
    } finally {
      await hub.close();
    }
  });

  it('R2 + R3: enforces owner-only backups and rejects restore when shift is open', async () => {
    const clock = new FixedClock(1_760_000_000_000n);
    const hub = await createHubServer({
      dbPath: makeDbPath(),
      port: TEST_PORT,
      logLevel: 'silent',
      clock,
      random: new SeededRandomSource(204),
      pinHasher: makeFastTestHasher(),
    });

    try {
      await hub.app.inject({
        method: 'POST',
        url: '/setup',
        headers: hostHeaders(),
        payload: { owner: { fullName: 'Owner', username: 'owner', pin: '849201' } },
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
        payload: { fullName: 'Cashier', username: 'cashier1', role: 'cashier', pin: '582914' },
      });

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

      // 1. Cashier gets 403 on /backups
      const cashierListRes = await hub.app.inject({
        method: 'GET',
        url: '/backups',
        headers: authHeaders(cashierToken),
      });
      expect(cashierListRes.statusCode).toBe(403);

      // 2. Owner creates backup
      const createRes = await hub.app.inject({
        method: 'POST',
        url: '/backups/create',
        headers: authHeaders(ownerToken),
        payload: { reason: 'Test backup before shift' },
      });
      expect(createRes.statusCode).toBe(201);
      const backupMeta = CreateBackupResponseSchema.parse(createRes.json()).backup;
      expect(backupMeta.id).toBeDefined();

      const listRes = await hub.app.inject({
        method: 'GET',
        url: '/backups',
        headers: authHeaders(ownerToken),
      });
      expect(listRes.statusCode).toBe(200);
      const backupList = BackupListResponseSchema.parse(listRes.json()).backups;
      expect(backupList.length).toBeGreaterThanOrEqual(1);

      // 3. Open shift -> restore MUST reject with 409
      const shiftRes = await hub.app.inject({
        method: 'POST',
        url: '/shifts/open',
        headers: authHeaders(ownerToken),
        payload: {
          clientRequestId: '01950000-0000-7000-8000-000000000003',
          openingCash: '5000000',
        },
      });
      const shiftId = OpenShiftResponseSchema.parse(shiftRes.json()).shift.id;

      const restoreBlockedRes = await hub.app.inject({
        method: 'POST',
        url: `/backups/${backupMeta.id}/restore`,
        headers: authHeaders(ownerToken),
        payload: { reason: 'Blocked restore test' },
      });
      expect(restoreBlockedRes.statusCode).toBe(409);

      // 4. Close shift -> restore succeeds!
      await hub.app.inject({
        method: 'POST',
        url: `/shifts/${shiftId}/close`,
        headers: authHeaders(ownerToken),
        payload: {
          clientRequestId: '01950000-0000-7000-8000-000000000004',
          countedCash: '5000000',
        },
      });

      const restoreOkRes = await hub.app.inject({
        method: 'POST',
        url: `/backups/${backupMeta.id}/restore`,
        headers: authHeaders(ownerToken),
        payload: { reason: 'Allowed restore test' },
      });
      expect(restoreOkRes.statusCode).toBe(200);
      const restoreData = StageRestoreResponseSchema.parse(restoreOkRes.json());
      expect(restoreData.staged).toBe(true);
      expect(restoreData.requiresRestart).toBe(true);
    } finally {
      await hub.close();
    }
  });

  it('R4: supports two-stage Excel import with previewToken and live re-validation against duplicate barcodes', async () => {
    const clock = new FixedClock(1_760_000_000_000n);
    const hub = await createHubServer({
      dbPath: makeDbPath(),
      port: TEST_PORT,
      logLevel: 'silent',
      clock,
      random: new SeededRandomSource(205),
      pinHasher: makeFastTestHasher(),
    });

    try {
      await hub.app.inject({
        method: 'POST',
        url: '/setup',
        headers: hostHeaders(),
        payload: { owner: { fullName: 'Owner', username: 'owner', pin: '849201' } },
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

      // Seed an existing product with barcode '4006381333931'
      const existingProdRes = await hub.app.inject({
        method: 'POST',
        url: '/products',
        headers: authHeaders(ownerToken),
        payload: {
          name: 'Mavjud Choy',
          unit: 'dona',
          salePrice: '1500000',
          barcodes: [{ barcode: '4006381333931', format: 'ean13' }],
        },
      });
      expect(existingProdRes.statusCode).toBe(201);

      // Create an Excel file in memory with:
      // Row 1: Header
      // Row 2: New item (Pepsi, barcode 036000291452)
      // Row 3: Colliding item (Choy, barcode 4006381333931) -> duplicate conflict!
      const wb = new ExcelJS.Workbook();
      const ws = wb.addWorksheet('Sheet1');
      ws.addRow(['Nomi', 'Artikul', 'Shtrixkod', 'Birlik', 'Narx', 'Min']);
      ws.addRow(['Pepsi 1.5L', 'PEP-15', '036000291452', 'dona', '14000', '10']);
      ws.addRow(['Yangi Choy', 'TEA-99', '4006381333931', 'dona', '20000', '5']);
      const fileBuffer = Buffer.from(await wb.xlsx.writeBuffer());

      // 1. Stage 1: Preview import
      const previewRes = await hub.app.inject({
        method: 'POST',
        url: '/catalog/import/preview',
        headers: {
          ...authHeaders(ownerToken),
          'content-type': 'application/json',
        },
        payload: {
          fileBase64: fileBuffer.toString('base64'),
        },
      });

      expect(previewRes.statusCode).toBe(200);
      const previewData = ExcelImportPreviewResponseSchema.parse(previewRes.json());
      expect(previewData.previewToken).toBeDefined();
      expect(previewData.totalRows).toBe(2);
      expect(previewData.validRows).toBe(2);
      expect(previewData.conflicts.length).toBe(1);
      expect(previewData.conflicts[0].barcode).toBe('4006381333931');

      // 2. Stage 2: Commit import with previewToken
      const commitRes = await hub.app.inject({
        method: 'POST',
        url: '/catalog/import/commit',
        headers: authHeaders(ownerToken),
        payload: {
          previewToken: previewData.previewToken,
          clientRequestId: '01950000-0000-7000-8000-000000000005',
        },
      });

      expect(commitRes.statusCode).toBe(200);
      const commitData = ExcelImportCommitResponseSchema.parse(commitRes.json());
      expect(commitData.importedProductsCount).toBe(1); // Only Pepsi imported, colliding Choy skipped

      // 3. Second commit with same previewToken fails (preview consumed/deleted)
      const reCommitRes = await hub.app.inject({
        method: 'POST',
        url: '/catalog/import/commit',
        headers: authHeaders(ownerToken),
        payload: {
          previewToken: previewData.previewToken,
          clientRequestId: '01950000-0000-7000-8000-000000000006',
        },
      });
      expect(reCommitRes.statusCode).toBe(400);
    } finally {
      await hub.close();
    }
  });
});
