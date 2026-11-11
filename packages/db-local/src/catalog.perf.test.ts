import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import {
  type PinHasher,
  createHlcTimestamp,
  normalizeCatalogSearchText,
  serializeHlc,
  unixMsFromBigInt,
} from '@mezon/domain';
import { FixedClock, SeededRandomSource } from '@mezon/test-utils';
import { afterEach, describe, expect, it } from 'vitest';
import {
  SqliteCatalogStore,
  createSqliteCatalogStore,
  createSqliteHubAuthStore,
  migrateLocalDatabase,
  openLocalSqliteDatabase,
} from './index.js';

const FAST_TEST_HASHER: PinHasher = {
  hash: (pin) => Promise.resolve(`$stub$${pin}`),
  verify: (hash, pin) => Promise.resolve(hash === `$stub$${pin}`),
};

const tempDirs: string[] = [];

function createTempDbPath(name = 'catalog-perf.db'): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mezon-catalog-perf-'));
  tempDirs.push(dir);
  return path.join(dir, name);
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 });
  }
});

async function setupCatalogPerfEnv(dbPath = createTempDbPath()) {
  const clock = new FixedClock(1_760_000_000_000n);
  const random = new SeededRandomSource(42);
  const connection = openLocalSqliteDatabase(dbPath);
  migrateLocalDatabase(connection.db);

  const authStore = await createSqliteHubAuthStore({
    connection,
    clock,
    random,
  });
  const pinHash = await FAST_TEST_HASHER.hash('849201');
  const setup = await authStore.completeSetup({
    fullName: 'Owner Test',
    username: 'owner',
    pinHash,
  });

  const catalogStore: SqliteCatalogStore = createSqliteCatalogStore({
    connection,
    getRuntimeContext: () => {
      const ctx = authStore.getActiveRuntimeContext();
      return ctx ? { uow: ctx.uow, organizationId: ctx.config.organizationId } : null;
    },
  });

  return {
    connection,
    catalogStore,
    organizationId: setup.organizationId,
    deviceId: setup.deviceId,
  };
}

describe('@mezon/db-local [PERF] - T1.1 Catalog 50k WAL benchmark', () => {
  it('meets <= 20ms barcode scan & fast FTS search on 50,000 products + 70,000 barcodes (real WAL disk DB)', async () => {
    const env = await setupCatalogPerfEnv();
    try {
      const totalProducts = 50_000;
      const nowMs = 1_760_000_000_000n;
      const sampleBarcodes: string[] = [];

      const seedStart = performance.now();
      const seedTx = env.connection.sqlite.transaction(() => {
        const insProd = env.connection.sqlite.prepare(
          `INSERT INTO "products" (
             "id", "organization_id", "device_id", "hlc", "created_at_ms", "updated_at_ms",
             "deleted_at_ms", "category_id", "sku", "sku_search", "name", "name_search",
             "unit", "unlimited", "min_stock", "has_variants", "sale_price", "mxik", "package_code", "vat_rate_bp"
           ) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?, 'dona', 0, NULL, 0, 1500000, NULL, NULL, 0)`,
        );
        const insBarcode = env.connection.sqlite.prepare(
          `INSERT INTO "product_barcodes" (
             "id", "organization_id", "device_id", "hlc", "created_at_ms", "updated_at_ms",
             "deleted_at_ms", "product_id", "variant_id", "barcode", "format"
           ) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, NULL, ?, 'internal')`,
        );

        const hlcFull = serializeHlc(createHlcTimestamp(unixMsFromBigInt(nowMs), 0, env.deviceId));

        for (let i = 0; i < totalProducts; i++) {
          const id = `01990000-0000-7000-8000-${String(i).padStart(12, '0')}`;
          const baseName =
            i % 5 === 0
              ? `Coca-Cola Zero ${i}`
              : i % 5 === 1
                ? `Молоко хона ${i}`
                : i % 5 === 2
                  ? `O'rik ҳаво ${i}`
                  : i % 5 === 3
                    ? `Shakar маъно ${i}`
                    : `Sut mahsuloti nomer ${i}`;
          const sku = `SKU-${String(i).padStart(6, '0')}`;
          const nameSearch = normalizeCatalogSearchText(baseName);
          const skuSearch = normalizeCatalogSearchText(sku);

          insProd.run(
            id,
            env.organizationId,
            env.deviceId,
            hlcFull,
            nowMs,
            nowMs,
            sku,
            skuSearch,
            baseName,
            nameSearch,
          );

          const bc1Id = `01990001-0000-7000-8000-${String(i).padStart(12, '0')}`;
          const bc1Code = `200${String(i).padStart(10, '0')}`;
          insBarcode.run(
            bc1Id,
            env.organizationId,
            env.deviceId,
            hlcFull,
            nowMs,
            nowMs,
            id,
            bc1Code,
          );

          if (i % 250 === 0) {
            sampleBarcodes.push(bc1Code);
          }

          if (i < 20_000) {
            const bc2Id = `01990002-0000-7000-8000-${String(i).padStart(12, '0')}`;
            const bc2Code = `ALT-${String(i).padStart(8, '0')}`;
            insBarcode.run(
              bc2Id,
              env.organizationId,
              env.deviceId,
              hlcFull,
              nowMs,
              nowMs,
              id,
              bc2Code,
            );
            if (i % 400 === 0) {
              sampleBarcodes.push(bc2Code);
            }
          }
        }
      });
      seedTx.immediate();
      const seedMs = performance.now() - seedStart;

      const prodCountRow = env.connection.sqlite
        .prepare('SELECT COUNT(*) AS cnt FROM "products"')
        .safeIntegers(false)
        .get() as { readonly cnt: number };
      const bcCountRow = env.connection.sqlite
        .prepare('SELECT COUNT(*) AS cnt FROM "product_barcodes"')
        .safeIntegers(false)
        .get() as { readonly cnt: number };
      expect(prodCountRow.cnt).toBe(50_000);
      expect(bcCountRow.cnt).toBe(70_000);

      const scanTimes: number[] = [];
      for (const code of sampleBarcodes) {
        const t0 = performance.now();
        const hit = await env.catalogStore.scanBarcode(code);
        const dt = performance.now() - t0;
        expect(hit).not.toBeNull();
        scanTimes.push(dt);
      }

      const searchQueries = [
        'zero',
        'coca cola zero',
        'xona',
        'havo',
        'mano',
        'moloko',
        'orik',
        'shakar 123',
        'nomer 4999',
        'sut',
      ];
      const searchTimes: number[] = [];
      for (let round = 0; round < 10; round++) {
        for (const q of searchQueries) {
          const t0 = performance.now();
          const page = await env.catalogStore.listProducts({ q, limit: 20, offset: 0 });
          const dt = performance.now() - t0;
          expect(page.products.length).toBeGreaterThan(0);
          searchTimes.push(dt);
        }
      }

      const percentile = (arr: readonly number[], p: number): number => {
        const sorted = [...arr].sort((a, b) => a - b);
        const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
        return sorted[idx] ?? 0;
      };

      const scanP50 = percentile(scanTimes, 50);
      const scanP95 = percentile(scanTimes, 95);
      const searchP50 = percentile(searchTimes, 50);
      const searchP95 = percentile(searchTimes, 95);

      console.info(
        `[T1.1 Perf 50k products / 70k barcodes WAL] seedMs=${seedMs.toFixed(1)} ` +
          `scan(n=${scanTimes.length}): p50=${scanP50.toFixed(3)}ms p95=${scanP95.toFixed(3)}ms | ` +
          `search(n=${searchTimes.length}): p50=${searchP50.toFixed(3)}ms p95=${searchP95.toFixed(3)}ms`,
      );

      expect(scanP95).toBeLessThanOrEqual(20);
      expect(searchP95).toBeLessThanOrEqual(50);
    } finally {
      env.connection.close();
    }
  }, 60_000);
});
