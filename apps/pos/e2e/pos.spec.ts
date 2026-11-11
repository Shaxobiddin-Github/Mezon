import { openLocalSqliteDatabase } from '@mezon/db-local';
import type { PinHasher } from '@mezon/domain';
import { createHubServer } from '@mezon/hub';
import { type Page, expect, test } from '@playwright/test';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const posDistDir = path.resolve(currentDir, '../dist');

function makeFastTestHasher(): PinHasher {
  return {
    hash(pin: string): Promise<string> {
      return Promise.resolve(`fast-stub-hash:${pin}`);
    },
    verify(storedHash: string, pin: string): Promise<boolean> {
      return Promise.resolve(storedHash === `fast-stub-hash:${pin}`);
    },
  };
}

function getContentType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.html') return 'text/html; charset=utf-8';
  if (ext === '.js') return 'application/javascript; charset=utf-8';
  if (ext === '.css') return 'text/css; charset=utf-8';
  if (ext === '.json') return 'application/json; charset=utf-8';
  if (ext === '.svg') return 'image/svg+xml';
  return 'application/octet-stream';
}

async function startStaticPosServer(distDir: string): Promise<{
  server: http.Server;
  origin: string;
  close: () => Promise<void>;
}> {
  const server = http.createServer((req, res) => {
    const reqUrl = req.url ?? '/';
    const cleanPath = reqUrl.split('?')[0] ?? '/';
    const targetFile =
      cleanPath === '/' || cleanPath === '/index.html'
        ? path.join(distDir, 'index.html')
        : path.join(distDir, cleanPath.replace(/^\/+/, ''));

    if (!fs.existsSync(targetFile) || fs.statSync(targetFile).isDirectory()) {
      res.writeHead(404);
      res.end('Not Found');
      return;
    }

    res.writeHead(200, { 'content-type': getContentType(targetFile) });
    fs.createReadStream(targetFile).pipe(res);
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });

  const addr = server.address();
  if (addr === null || typeof addr === 'string') {
    throw new Error('Failed to bind static POS server');
  }

  return {
    server,
    origin: `http://127.0.0.1:${String(addr.port)}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

function seedBulkProductsInSqlite(
  dbPath: string,
  organizationId: string,
  deviceId: string,
  hlc: string,
  count: number,
): void {
  const conn = openLocalSqliteDatabase(dbPath);
  const db = conn.sqlite;
  try {
    const nowMs = BigInt(Date.now());

    const insertProduct = db.prepare(`
      INSERT INTO products (
        id, organization_id, hlc, device_id, created_at_ms, updated_at_ms, deleted_at_ms,
        category_id, sku, sku_search, name, name_search, unit, unlimited, min_stock,
        has_variants, track_batches, sale_price, mxik, package_code, vat_rate_bp
      ) VALUES (
        ?, ?, ?, ?, ?, ?, NULL,
        NULL, ?, ?, ?, ?, 'dona', 1, NULL,
        0, 0, ?, '01901001001000000', '123456', 1200
      )
    `);

    const tx = db.transaction(() => {
      for (let i = 1; i <= count; i++) {
        const hexSuffix = i.toString(16).padStart(12, '0');
        const id = `01960000-0000-7000-8000-${hexSuffix}`;
        const sku = `BULK-${String(i).padStart(6, '0')}`;
        const skuSearch = sku.toLowerCase();
        const name = i === count ? 'Maxsus Olma Sharbati 50K' : `Ommaviy Mahsulot ${String(i)}`;
        const nameSearch = name.toLowerCase();
        const price = BigInt((i % 50) * 100000 + 500000);
        insertProduct.run(
          id,
          organizationId,
          hlc,
          deviceId,
          nowMs,
          nowMs,
          sku,
          skuSearch,
          name,
          nameSearch,
          price,
        );
      }
    });

    tx();
  } finally {
    conn.close();
  }
}

async function emitHardwareScannerBurst(
  page: Page,
  keys: ReadonlyArray<{ key: string; code?: string; ctrlKey?: boolean }>,
): Promise<void> {
  await page.evaluate((seq) => {
    for (const item of seq) {
      window.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: item.key,
          code: item.code ?? '',
          ctrlKey: item.ctrlKey ?? false,
          bubbles: true,
          cancelable: true,
        }),
      );
    }
    window.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Enter',
        code: 'Enter',
        bubbles: true,
        cancelable: true,
      }),
    );
  }, keys);
}

test.describe('@mezon/pos Playwright E2E — Kassa UI (T1.11)', () => {
  test('Full POS workflow: Setup -> Login -> Open Shift -> Scan (EAN-13 & DataMatrix GS) -> Human Typist vs Scanner -> Mouse-Free Keyboard Sale -> Park/Resume -> Idempotent Retry -> Shift Cash Move & Close + 50k Search Perf', async ({
    browser,
  }) => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mezon-pos-e2e-'));
    const dbPath = path.join(tempDir, 'pos-e2e.sqlite');

    const staticPos = await startStaticPosServer(posDistDir);
    const hub = await createHubServer({
      dbPath,
      port: 0,
      allowedOrigins: [staticPos.origin],
      enableDevLoopbackCors: true,
      logLevel: 'silent',
      pinHasher: makeFastTestHasher(),
    });
    const bound = await hub.listen();
    const hubBaseUrl = `http://${bound.host}:${String(bound.port)}`;

    try {
      const context = await browser.newContext({
        viewport: { width: 1366, height: 820 },
      });
      const page = await context.newPage();

      await page.addInitScript((url) => {
        (window as unknown as { __MEZON_HUB_URL__: string }).__MEZON_HUB_URL__ = url;
      }, hubBaseUrl);

      await page.goto(staticPos.origin);

      // 1. Setup Wizard screen
      await expect(page.getByTestId('setup-screen')).toBeVisible();
      await expect(page.getByTestId('non-fiscal-badge')).toHaveText('SINOV — FISKAL EMAS');

      await page.getByTestId('setup-fullname-input').fill('Sardor Egasi');
      await page.getByTestId('setup-username-input').fill('owner_sardor');
      await page.getByTestId('setup-pin-input').fill('482910');
      await page.getByTestId('setup-submit-btn').click();

      // 2. Login screen via PIN numpad
      await expect(page.getByTestId('login-screen')).toBeVisible();
      await page.locator('[data-testid^="login-option-"]').first().click();
      for (const digit of ['4', '8', '2', '9', '1', '0']) {
        await page.getByTestId(`login-numpad-${digit}`).click();
      }
      await page.getByTestId('login-submit-btn').click();

      // 3. Open Shift screen
      await expect(page.getByTestId('open-shift-screen')).toBeVisible();

      // Seed catalog products via Hub API using owner token before opening shift
      const loginApiRes = await fetch(`${hubBaseUrl}/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: 'owner_sardor', pin: '482910' }),
      });
      const loginJson = (await loginApiRes.json()) as {
        token: string;
        user: { organizationId: string };
      };
      const ownerToken = loginJson.token;
      const orgId = loginJson.user.organizationId;

      const createCatRes = await fetch(`${hubBaseUrl}/categories`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${ownerToken}`,
        },
        body: JSON.stringify({ name: 'Ichimliklar', sortOrder: 1 }),
      });
      const catJson = (await createCatRes.json()) as { category: { id: string } };

      // Product 1: EAN-13 Coca-Cola (`unlimited: true` so sales never fail stock check)
      const createProd1 = await fetch(`${hubBaseUrl}/products`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${ownerToken}`,
        },
        body: JSON.stringify({
          categoryId: catJson.category.id,
          name: 'Coca-Cola 1.5L',
          sku: 'COLA-15',
          unit: 'dona',
          unlimited: true,
          salePrice: '1200000', // 12 000.00 so'm
          vatRateBp: 1200,
          mxik: '02202001001000000',
          packageCode: '1001',
        }),
      });
      const prod1Json = (await createProd1.json()) as { product: { id: string } };

      const bc1Res = await fetch(`${hubBaseUrl}/products/${prod1Json.product.id}/barcodes`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${ownerToken}`,
        },
        body: JSON.stringify({ barcode: '036000291452', format: 'upca' }),
      });
      expect(bc1Res.status).toBe(201);

      // Product 2: Marked Medicine with GS1 DataMatrix containing \x1D separator
      const gsBarcode = '010478000000002921ABC\x1d91EE01';
      const createProd2 = await fetch(`${hubBaseUrl}/products`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${ownerToken}`,
        },
        body: JSON.stringify({
          categoryId: catJson.category.id,
          name: 'Paratsetamol 500mg',
          sku: 'PARA-500',
          unit: 'qadoq',
          unlimited: true,
          salePrice: '850000', // 8 500.00 so'm
          vatRateBp: 0,
          mxik: '03004001001000000',
          packageCode: '2002',
        }),
      });
      const prod2Json = (await createProd2.json()) as { product: { id: string } };

      const bc2Res = await fetch(`${hubBaseUrl}/products/${prod2Json.product.id}/barcodes`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${ownerToken}`,
        },
        body: JSON.stringify({ barcode: gsBarcode, format: 'internal' }),
      });
      expect(bc2Res.status).toBe(201);

      // Open shift from UI with 100 000 so'm opening cash
      await page.getByTestId('open-shift-cash-input').fill('100000');
      await page.getByTestId('open-shift-reason-input').fill('Boshlangich kassa');
      await page.getByTestId('open-shift-submit-btn').click();

      await expect(page.getByTestId('pos-workspace')).toBeVisible();
      await expect(page.getByTestId('catalog-result-0')).toBeVisible();

      // 4. Scenario 3: Fast human typist in search input (~85ms interval) is NOT treated as scanner
      const searchInput = page.getByTestId('catalog-search-input');
      await searchInput.focus();
      await searchInput.pressSequentially('Cola', { delay: 85 });
      await expect(searchInput).toHaveValue('Cola');
      await expect(page.getByTestId('cart-empty-message')).toBeVisible();

      // Now while searchInput still has 'Cola' focused, emit a hardware scanner burst (<5ms interval)
      // Verify scan -> cart line latency <= 150ms AND searchInput remains 'Cola' untouched!
      const scanStartMs = performance.now();
      await emitHardwareScannerBurst(
        page,
        '0036000291452'.split('').map((ch) => ({ key: ch })),
      );
      await expect(page.getByTestId('cart-line-row-0')).toBeVisible();
      const scanLatencyMs = performance.now() - scanStartMs;
      console.log(`[PERF] Scan -> Cart Line DOM latency: ${scanLatencyMs.toFixed(1)} ms`);
      expect(scanLatencyMs).toBeLessThanOrEqual(150);
      await expect(searchInput).toHaveValue('Cola');

      // Also scan DataMatrix with Ctrl+] (\x1D GS separator)
      const gsKeySequence: Array<{ key: string; code?: string; ctrlKey?: boolean }> = [];
      for (const ch of gsBarcode) {
        if (ch === '\x1d') {
          gsKeySequence.push({ key: ']', code: 'BracketRight', ctrlKey: true });
        } else {
          gsKeySequence.push({ key: ch });
        }
      }
      await emitHardwareScannerBurst(page, gsKeySequence);
      await expect(page.getByTestId('cart-line-row-1')).toBeVisible();

      // Clear search input and blur
      await searchInput.fill('');
      await page.getByTestId('scanner-ready-indicator').click();

      // 5. Scenario 1: Complete sale via Payment Modal and verify Receipt Modal ("SINOV — FISKAL EMAS")
      await page.getByTestId('pos-pay-btn').click();
      await expect(page.getByTestId('payment-modal')).toBeVisible();
      // Total is 12 000 + 8 500 = 20 500 so'm
      await expect(page.getByTestId('payment-total-display')).toContainText('20 500');
      await page.getByTestId('payment-complete-btn').click();

      await expect(page.getByTestId('receipt-modal')).toBeVisible();
      await expect(page.getByTestId('receipt-non-fiscal-banner')).toHaveText('SINOV — FISKAL EMAS');
      await expect(page.getByTestId('receipt-no')).toHaveText('1');

      // Save screenshot of POS workspace + receipt for visual verification
      const screenshotPath = path.resolve(
        currentDir,
        '../../../.mezon/gemini/pos-sales-screen.png',
      );
      await page.screenshot({ path: screenshotPath });

      await page.getByTestId('receipt-new-sale-btn').click();
      await expect(page.getByTestId('receipt-modal')).toBeHidden();

      // 6. Scenario 5: Park (F5) & Resume (F6) cart
      await emitHardwareScannerBurst(
        page,
        '0036000291452'.split('').map((ch) => ({ key: ch })),
      );
      await expect(page.getByTestId('cart-line-row-0')).toBeVisible();

      await page.keyboard.press('F5');
      await expect(page.getByTestId('park-cart-modal')).toBeVisible();
      await page.getByTestId('park-label-input').fill('2-kassa mijoz');
      await page.getByTestId('park-confirm-btn').click();
      await expect(page.getByTestId('park-cart-modal')).toBeHidden();
      await expect(page.getByTestId('cart-empty-message')).toBeVisible();

      // Open Parked Carts list (F6) and resume
      await page.keyboard.press('F6');
      await expect(page.getByTestId('parked-carts-modal')).toBeVisible();
      await page.locator('[data-testid^="parked-resume-btn-"]').first().click();
      await expect(page.getByTestId('parked-carts-modal')).toBeHidden();
      await expect(page.getByTestId('cart-line-row-0')).toBeVisible();

      // 7. Scenario 2: 100% Mouse-free keyboard sale (F2 -> ArrowDown -> Enter -> '+' -> F4 discount -> F9 payment -> Enter complete)
      await page.keyboard.press('F2');
      await expect(searchInput).toBeFocused();
      await page.keyboard.press('ArrowDown');
      await page.keyboard.press('Enter'); // Adds product from catalog results
      await page.keyboard.press('F4');
      await expect(page.getByTestId('discount-modal')).toBeVisible();
      await page.getByTestId('discount-value-input').fill('10'); // 10% discount (>5% limit triggers supervisor override box!)
      await page.getByTestId('discount-submit-btn').click();
      await expect(page.getByTestId('discount-supervisor-box')).toBeVisible();
      await page.getByTestId('discount-supervisor-username').fill('owner_sardor');
      await page.getByTestId('discount-supervisor-pin').fill('482910');
      await page.getByTestId('discount-submit-btn').click();
      await expect(page.getByTestId('discount-modal')).toBeHidden();

      // Open payment via F9 and submit via Enter
      await page.keyboard.press('F9');
      await expect(page.getByTestId('payment-modal')).toBeVisible();
      await page.getByTestId('payment-tendered-cash-input').press('Enter');
      await expect(page.getByTestId('receipt-modal')).toBeVisible();
      await expect(page.getByTestId('receipt-no')).toHaveText('2');
      await page.keyboard.press('Escape');
      await expect(page.getByTestId('receipt-modal')).toBeHidden();

      // 8. Scenario 4: Idempotent completeSale on network retry & double click
      await emitHardwareScannerBurst(
        page,
        '0036000291452'.split('').map((ch) => ({ key: ch })),
      );
      await expect(page.getByTestId('cart-line-row-0')).toBeVisible();

      await page.keyboard.press('F9');
      await expect(page.getByTestId('payment-modal')).toBeVisible();

      let completeInterceptCount = 0;
      await page.route('**/carts/*/complete', async (route) => {
        completeInterceptCount += 1;
        if (completeInterceptCount === 1) {
          // Simulate network drop on first attempt
          await route.abort('failed');
          return;
        }
        await route.continue();
      });

      // First click fails due to simulated network drop
      await page.getByTestId('payment-complete-btn').click();
      await expect(page.getByTestId('payment-retry-btn')).toBeVisible();

      // Retry click in same modal reuses the exact same clientRequestId -> succeeds as Receipt #3
      await page.getByTestId('payment-retry-btn').click();
      await expect(page.getByTestId('receipt-modal')).toBeVisible();
      await expect(page.getByTestId('receipt-no')).toHaveText('3');
      await page.getByTestId('receipt-new-sale-btn').click();

      // 9. Scenario 6: Shift cash move (F8) & Shift Close (verifying zero non-cash input fields)
      await page.keyboard.press('F8');
      await expect(page.getByTestId('shift-manage-modal')).toBeVisible();
      await page.getByTestId('cash-move-amount-input').fill('5000');
      await page.getByTestId('cash-move-reason-input').fill('Tushlik xarajati');
      await page.getByTestId('cash-move-submit-btn').click();

      await page.getByTestId('shift-tab-close-shift').click();
      // Verify close-shift-form has strictly cash recount, discrepancy reason, and note (no non-cash inputs)
      await expect(page.getByTestId('close-shift-counted-cash-input')).toBeVisible();
      const closeFormInputs = await page
        .getByTestId('close-shift-form')
        .locator('input, select')
        .count();
      expect(closeFormInputs).toBe(3); // countedCash + discrepancyReason + closeNote

      await page.getByTestId('close-shift-discrepancy-reason-input').fill('Smena yakuni');
      await page.getByTestId('close-shift-submit-btn').click();

      await expect(page.getByTestId('open-shift-screen')).toBeVisible();
      await expect(page.getByTestId('last-shift-closure-summary')).toBeVisible();
      await expect(page.getByTestId('closure-expected-cash')).toBeVisible();

      // 10. Performance check: Seed 50 000 products and verify search latency <= 150 ms
      const conn = openLocalSqliteDatabase(dbPath);
      const devRow = conn.sqlite
        .prepare('SELECT device_id, last_hlc FROM local_device_state LIMIT 1')
        .get() as {
        device_id: string;
        last_hlc: string;
      };
      conn.close();

      seedBulkProductsInSqlite(dbPath, orgId, devRow.device_id, devRow.last_hlc, 50_000);

      // Re-open shift to enter POS workspace with 50,002 products
      await page.getByTestId('open-shift-reason-input').fill('Yangi smena');
      await page.getByTestId('open-shift-submit-btn').click();
      await expect(page.getByTestId('pos-workspace')).toBeVisible();

      const freshSearchInput = page.getByTestId('catalog-search-input');
      const searchStartMs = performance.now();
      await freshSearchInput.fill('Maxsus Olma Sharbati 50K');
      await expect(page.getByTestId('catalog-result-0')).toContainText('Maxsus Olma Sharbati 50K');
      const searchLatencyMs = performance.now() - searchStartMs;
      console.log(
        `[PERF] 50 000 products UI + FTS5 search latency: ${searchLatencyMs.toFixed(1)} ms`,
      );
      expect(searchLatencyMs).toBeLessThanOrEqual(150);

      await context.close();
    } finally {
      await hub.close();
      await staticPos.close();
      fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });
});
