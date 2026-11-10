import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  type PinHasher,
  type UuidV7,
  createHlcTimestamp,
  normalizeCatalogSearchText,
  serializeHlc,
  unixMsFromBigInt,
} from '@mezon/domain';
import { FixedClock, SeededRandomSource } from '@mezon/test-utils';
import fc from 'fast-check';
import { afterEach, describe, expect, it } from 'vitest';
import {
  SqliteCatalogStore,
  createSqliteCatalogStore,
  createSqliteHubAuthStore,
  listAllOutboxRecordsSync,
  migrateLocalDatabase,
  openLocalSqliteDatabase,
  rebuildCatalogSearchIndex,
} from './index.js';

const FAST_TEST_HASHER: PinHasher = {
  hash: (pin) => Promise.resolve(`$stub$${pin}`),
  verify: (hash, pin) => Promise.resolve(hash === `$stub$${pin}`),
};

const tempDirs: string[] = [];

function createTempDbPath(name = 'catalog.db'): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mezon-catalog-'));
  tempDirs.push(dir);
  return path.join(dir, name);
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

async function setupCatalogEnv(dbPath = createTempDbPath()) {
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
    dbPath,
    clock,
    connection,
    authStore,
    catalogStore,
    organizationId: setup.organizationId,
    ownerId: setup.owner.id,
    deviceId: setup.deviceId,
  };
}

describe('@mezon/db-local - T1.1 Catalog persistence, F1-F5 guarantees, and 50k WAL perf', () => {
  it('enforces category tree cycle guards, sibling uniqueness, and CATEGORY_IN_USE protection', async () => {
    const env = await setupCatalogEnv();
    try {
      const drinks = await env.catalogStore.createCategory({ name: 'Ichimliklar', sortOrder: 1 });
      const sodas = await env.catalogStore.createCategory({
        name: 'Gazli ichimliklar',
        parentId: drinks.id,
        sortOrder: 2,
      });
      const colas = await env.catalogStore.createCategory({
        name: 'Kola',
        parentId: sodas.id,
      });

      // Duplicate sibling blocked regardless of Uzbek spelling variants
      await expect(env.catalogStore.createCategory({ name: 'Ичимликлар' })).rejects.toMatchObject({
        code: 'CATEGORY_ALREADY_EXISTS',
      });

      // Same name under different parent is allowed
      const rootKola = await env.catalogStore.createCategory({ name: 'Kola' });
      expect(rootKola.id).not.toBe(colas.id);

      // Cycle detection (self and descendant)
      await expect(
        env.catalogStore.updateCategory(drinks.id, { parentId: drinks.id }),
      ).rejects.toMatchObject({ code: 'CATEGORY_CYCLE' });
      await expect(
        env.catalogStore.updateCategory(drinks.id, { parentId: colas.id }),
      ).rejects.toMatchObject({ code: 'CATEGORY_CYCLE' });

      // Deleting parent with active child category fails cleanly
      await expect(env.catalogStore.deleteCategory(drinks.id)).rejects.toMatchObject({
        code: 'CATEGORY_IN_USE',
      });

      // Attach product to leaf category -> blocks delete
      const prod = await env.catalogStore.createProduct({
        categoryId: colas.id,
        name: 'Pepsi 1L',
        unit: 'dona',
        salePrice: '1200000',
        actorUserId: env.ownerId,
      });
      await expect(env.catalogStore.deleteCategory(colas.id)).rejects.toMatchObject({
        code: 'CATEGORY_IN_USE',
      });

      // Removing product allows deleting leaf category, and name becomes reusable after tombstone
      await env.catalogStore.deleteProduct(prod.product.id);
      await env.catalogStore.deleteCategory(colas.id);
      const recreated = await env.catalogStore.createCategory({
        name: 'Kola',
        parentId: sodas.id,
      });
      expect(recreated.id).not.toBe(colas.id);
    } finally {
      env.connection.close();
    }
  });

  it('validates product updates, price_changes FACT immutability, variants, and cascade tombstones', async () => {
    const env = await setupCatalogEnv();
    try {
      const created = await env.catalogStore.createProduct({
        sku: 'SHK-55',
        name: 'Shakar qandi',
        unit: 'kg',
        minStock: '5500', // 5.5 kg valid
        salePrice: '1400000',
        mxik: '01701001001000001',
        packageCode: '12345',
        vatRateBp: 1200,
        barcodes: [{ barcode: '4006381333931', format: 'ean13' }],
        priceChangeReason: 'Boshlangich narx',
        actorUserId: env.ownerId,
      });

      expect(created.product.vatRateBp).toBe(1200);
      expect(created.barcodes).toHaveLength(1);

      // Switching kg -> dona with fractional minStock (5.5) fails domain & SQL check
      await expect(
        env.catalogStore.updateProduct(created.product.id, {
          unit: 'dona',
          actorUserId: env.ownerId,
        }),
      ).rejects.toMatchObject({ code: 'INVALID_UNIT_QUANTITY' });

      // Non-price update does NOT emit noisy price_changes row
      await env.catalogStore.updateProduct(created.product.id, {
        name: 'Oq shakar',
        actorUserId: env.ownerId,
      });
      let history = await env.catalogStore.listPriceChanges(created.product.id);
      expect(history).toHaveLength(1);
      expect(history[0]?.oldPrice).toBeNull();
      expect(history[0]?.newPrice).toBe(1400000n);

      // Advance clock so DESC created_at_ms order is deterministic, update price
      env.clock.advance(1_000n);
      await env.catalogStore.updateProduct(created.product.id, {
        salePrice: '1650000',
        priceChangeReason: 'Yangi partiya',
        actorUserId: env.ownerId,
      });
      history = await env.catalogStore.listPriceChanges(created.product.id);
      expect(history).toHaveLength(2);
      expect(history[0]?.oldPrice).toBe(1400000n);
      expect(history[0]?.newPrice).toBe(1650000n);
      expect(history[0]?.reason).toBe('Yangi partiya');

      // FACT immutability on price_changes
      expect(() =>
        env.connection.sqlite.prepare('UPDATE price_changes SET new_price = 1').run(),
      ).toThrow(/FACT table "price_changes" is immutable/);
      expect(() => env.connection.sqlite.prepare('DELETE FROM price_changes').run()).toThrow(
        /FACT table "price_changes" forbids physical DELETE/,
      );

      // Variants inherit or override parent price and canonicalize attribute order
      const variant = await env.catalogStore.createVariant(created.product.id, {
        name: '2kg qadoq',
        sku: 'SHK-2KG',
        attributes: { qadoq: '2kg', navi: 'oliy' },
        salePrice: null,
        actorUserId: env.ownerId,
      });
      expect(variant.effectiveSalePrice).toBe(1650000n);
      expect(variant.attributes).toEqual({ navi: 'oliy', qadoq: '2kg' });

      env.clock.advance(1_000n);
      const updatedVar = await env.catalogStore.updateVariant(created.product.id, variant.id, {
        salePrice: '3100000',
        reason: 'Maxsus narx',
        actorUserId: env.ownerId,
      });
      expect(updatedVar.effectiveSalePrice).toBe(3100000n);

      await env.catalogStore.createBarcode(created.product.id, {
        barcode: 'INT-SHK-2KG',
        format: 'internal',
        variantId: variant.id,
      });

      // Deleting variant cascades attached barcode tombstone and resets hasVariants
      await env.catalogStore.deleteVariant(created.product.id, variant.id);
      const afterVarDel = await env.catalogStore.getProductDetail(created.product.id);
      expect(afterVarDel.variants).toHaveLength(0);
      expect(afterVarDel.barcodes.map((b) => b.barcode)).toEqual(['4006381333931']);
      expect(afterVarDel.product.hasVariants).toBe(false);

      // Scanning deleted variant barcode returns null; scanning active product barcode works
      expect(await env.catalogStore.scanBarcode('INT-SHK-2KG')).toBeNull();
      const scanHit = await env.catalogStore.scanBarcode('4006381333931');
      expect(scanHit?.product.id).toBe(created.product.id);

      // Deleting product cascades remaining barcode so barcode becomes reusable
      await env.catalogStore.deleteProduct(created.product.id);
      expect(await env.catalogStore.scanBarcode('4006381333931')).toBeNull();

      const outbox = listAllOutboxRecordsSync(env.connection.db);
      expect(outbox.some((e) => e.type === 'price_change.recorded')).toBe(true);
      expect(outbox.some((e) => e.type === 'product.deleted')).toBe(true);
    } finally {
      env.connection.close();
    }
  });

  it('F3: treats 12-digit UPC-A and 13-digit 0+UPC-A as the same canonical barcode', async () => {
    const env = await setupCatalogEnv();
    try {
      const p1 = await env.catalogStore.createProduct({
        name: 'Amerikancha sous',
        unit: 'dona',
        salePrice: '2500000',
        barcodes: [{ barcode: '036000291452', format: 'upca' }],
        actorUserId: env.ownerId,
      });
      expect(p1.barcodes[0]?.barcode).toBe('0036000291452');

      // Both 12-digit UPC-A and 13-digit EAN-13 scans find the same record
      const hitUpc = await env.catalogStore.scanBarcode('036000291452');
      const hitEan = await env.catalogStore.scanBarcode('0036000291452');
      expect(hitUpc?.product.id).toBe(p1.product.id);
      expect(hitEan?.product.id).toBe(p1.product.id);
      expect(hitUpc?.quantity).toBeNull();

      // Registering 0036000291452 (EAN-13) on another product fails uniqueness check
      await expect(
        env.catalogStore.createProduct({
          name: 'Dublikat tovar',
          unit: 'dona',
          salePrice: '100000',
          barcodes: [{ barcode: '0036000291452', format: 'ean13' }],
          actorUserId: env.ownerId,
        }),
      ).rejects.toMatchObject({ code: 'BARCODE_ALREADY_EXISTS' });

      // Bad GS1 check digit rejected unless marked internal/other
      await expect(
        env.catalogStore.createBarcode(p1.product.id, {
          barcode: '036000291453',
          format: 'upca',
        }),
      ).rejects.toMatchObject({ code: 'INVALID_BARCODE_CHECK_DIGIT' });
    } finally {
      env.connection.close();
    }
  });

  it('F1, F2, F5: survives DELETE+VACUUM without rowid drift, prevents FTS5 syntax injection, and finds Uzbek Cyrillic', async () => {
    const env = await setupCatalogEnv();
    try {
      const xona = await env.catalogStore.createProduct({
        name: 'хона безаги',
        unit: 'dona',
        salePrice: '500000',
        actorUserId: env.ownerId,
      });
      const havo = await env.catalogStore.createProduct({
        name: 'ҳаво тозалагич',
        unit: 'dona',
        salePrice: '1500000',
        actorUserId: env.ownerId,
      });
      const deletedTemp = await env.catalogStore.createProduct({
        name: 'Vaqtincha mahsulot',
        unit: 'dona',
        salePrice: '100000',
        actorUserId: env.ownerId,
      });
      const mano = await env.catalogStore.createProduct({
        name: 'маъно китоби',
        unit: 'dona',
        salePrice: '800000',
        actorUserId: env.ownerId,
      });
      const moloko = await env.catalogStore.createProduct({
        name: 'Молоко 3.2%',
        unit: 'litr',
        salePrice: '1200000',
        actorUserId: env.ownerId,
      });
      const colaZero = await env.catalogStore.createProduct({
        name: 'Coca-Cola Zero',
        unit: 'dona',
        salePrice: '900000',
        actorUserId: env.ownerId,
      });

      // F1: delete middle product, add more rows, tombstone another, then VACUUM SQLite!
      await env.catalogStore.deleteProduct(deletedTemp.product.id);
      const extra = await env.catalogStore.createProduct({
        name: 'Yangi choy',
        unit: 'dona',
        salePrice: '300000',
        actorUserId: env.ownerId,
      });
      await env.catalogStore.updateProduct(havo.product.id, {
        name: 'ҳаво совутгич',
        actorUserId: env.ownerId,
      });
      env.connection.sqlite.exec('VACUUM;');

      // Every active search returns exact right product UUID even after VACUUM shifted table rowids
      const resXona = await env.catalogStore.listProducts({ q: 'xona' });
      expect(resXona.products.map((p) => p.id)).toEqual([xona.product.id]);

      const resHavo = await env.catalogStore.listProducts({ q: 'havo' });
      expect(resHavo.products.map((p) => p.id)).toEqual([havo.product.id]);

      const resMano = await env.catalogStore.listProducts({ q: 'mano' });
      expect(resMano.products.map((p) => p.id)).toEqual([mano.product.id]);

      const resMoloko = await env.catalogStore.listProducts({ q: 'moloko' });
      expect(resMoloko.products.map((p) => p.id)).toEqual([moloko.product.id]);

      const resZero = await env.catalogStore.listProducts({ q: 'zero' });
      expect(resZero.products.map((p) => p.id)).toEqual([colaZero.product.id]);

      const resChoy = await env.catalogStore.listProducts({ q: 'choy' });
      expect(resChoy.products.map((p) => p.id)).toEqual([extra.product.id]);

      const resDeleted = await env.catalogStore.listProducts({ q: 'vaqtincha' });
      expect(resDeleted.products).toHaveLength(0);

      // 1-char B-tree prefix fallback
      const singleChar = await env.catalogStore.listProducts({ q: 'c' });
      expect(singleChar.products.map((p) => p.id)).toEqual([colaZero.product.id]);

      // F2: table test of syntax-breaking / FTS operator inputs (none throw)
      const injectionInputs = [
        '"',
        '*',
        '-',
        ':',
        '(',
        ')',
        'NEAR',
        'OR',
        'AND',
        'NOT',
        'cola OR "pepsi"* -not:near(',
      ];
      for (const raw of injectionInputs) {
        const res = await env.catalogStore.listProducts({ q: raw });
        expect(res.total).toBeGreaterThanOrEqual(0);
      }

      // Searching literal word "cola OR zero" still matches Coca-Cola Zero via literal AND ("cola"* AND "or"* AND "zero"* -> actually "or" isn't in Coca-Cola Zero, while "cola zero" matches!)
      const colaBoth = await env.catalogStore.listProducts({ q: 'cola -zero*' });
      expect(colaBoth.products.map((p) => p.id)).toEqual([colaZero.product.id]);
    } finally {
      env.connection.close();
    }
  });

  it('F4: rebuildCatalogSearchIndex repairs stale name_search & drifted FTS without emitting outbox events + stateful parity property test', async () => {
    const env = await setupCatalogEnv();
    try {
      const p1 = await env.catalogStore.createProduct({
        name: 'Маъно хона',
        sku: 'MX-01',
        unit: 'dona',
        salePrice: '100000',
        actorUserId: env.ownerId,
      });

      const outboxBeforeRebuild = listAllOutboxRecordsSync(env.connection.db).length;

      // Simulate stale normalizer / corrupted FTS table
      env.connection.sqlite
        .prepare('UPDATE "products" SET "name_search" = ?, "sku_search" = ? WHERE "id" = ?')
        .run('stale bad', 'stale', p1.product.id);
      env.connection.sqlite.prepare('DELETE FROM "products_fts"').run();
      env.connection.sqlite
        .prepare(
          'INSERT INTO "products_fts" ("product_id", "organization_id", "name_search", "sku_search") VALUES (?, ?, ?, ?)',
        )
        .run('01950000-0000-7000-8000-999999999999', env.organizationId, 'ghost row', 'ghost');

      const stats = await rebuildCatalogSearchIndex(env.connection, env.organizationId);
      expect(stats.productsUpdated).toBe(1);
      expect(stats.ftsIndexedCount).toBe(1);

      // Zero new outbox events emitted during index rebuild
      expect(listAllOutboxRecordsSync(env.connection.db)).toHaveLength(outboxBeforeRebuild);

      const hits = await env.catalogStore.listProducts({ q: 'mano xona' });
      expect(hits.products.map((p) => p.id)).toEqual([p1.product.id]);
      const ghostHits = await env.catalogStore.listProducts({ q: 'ghost' });
      expect(ghostHits.products).toHaveLength(0);
    } finally {
      env.connection.close();
    }

    // F4 stateful property test: active product_ids in products_fts === active rows in products
    type Op =
      | { readonly kind: 'create'; readonly name: string }
      | { readonly kind: 'update'; readonly pickIdx: number; readonly name: string }
      | { readonly kind: 'delete'; readonly pickIdx: number };

    const opArb: fc.Arbitrary<Op> = fc.oneof(
      fc.record({
        kind: fc.constant('create' as const),
        name: fc.constantFrom(
          'Coca-Cola Zero',
          'хона безаги',
          'ҳаво тоза',
          'маъно',
          'Молоко 2.5%',
          "O'rik sharbat",
        ),
      }),
      fc.record({
        kind: fc.constant('update' as const),
        pickIdx: fc.integer({ min: 0, max: 20 }),
        name: fc.constantFrom('Yangilangan tovar', 'Қора чой', 'Печенье', 'Мед и лимон'),
      }),
      fc.record({
        kind: fc.constant('delete' as const),
        pickIdx: fc.integer({ min: 0, max: 20 }),
      }),
    );

    await fc.assert(
      fc.asyncProperty(fc.array(opArb, { minLength: 5, maxLength: 20 }), async (ops) => {
        const runEnv = await setupCatalogEnv();
        try {
          const activeIds: UuidV7[] = [];
          let counter = 0;

          for (const op of ops) {
            counter += 1;
            if (op.kind === 'create' || activeIds.length === 0) {
              const name = `${op.kind === 'delete' ? 'Tovar' : op.name} ${counter}`;
              const created = await runEnv.catalogStore.createProduct({
                name,
                unit: 'dona',
                salePrice: '100000',
                actorUserId: runEnv.ownerId,
              });
              activeIds.push(created.product.id);
            } else if (op.kind === 'update') {
              const idx = op.pickIdx % activeIds.length;
              const targetId = activeIds[idx];
              if (targetId !== undefined) {
                await runEnv.catalogStore.updateProduct(targetId, {
                  name: `${op.name} v${counter}`,
                  actorUserId: runEnv.ownerId,
                });
              }
            } else {
              const idx = op.pickIdx % activeIds.length;
              const [removedId] = activeIds.splice(idx, 1);
              if (removedId) {
                await runEnv.catalogStore.deleteProduct(removedId);
              }
            }
          }

          const readActiveIds = (): string[] =>
            (
              runEnv.connection.sqlite
                .prepare('SELECT "id" FROM "products" WHERE "deleted_at_ms" IS NULL ORDER BY "id"')
                .all() as Array<{ readonly id: string }>
            ).map((r) => r.id);

          const readFtsIds = (): string[] =>
            (
              runEnv.connection.sqlite
                .prepare('SELECT "product_id" FROM "products_fts" ORDER BY "product_id"')
                .all() as Array<{ readonly product_id: string }>
            ).map((r) => r.product_id);

          const expected = [...activeIds].sort();
          expect(readActiveIds()).toEqual(expected);
          expect(readFtsIds()).toEqual(expected);

          // Also match after explicit full rebuildCatalogSearchIndex()
          await rebuildCatalogSearchIndex(runEnv.connection);
          expect(readFtsIds()).toEqual(expected);
        } finally {
          runEnv.connection.close();
        }
      }),
      { numRuns: 15 },
    );
  });

  it('meets <= 20ms barcode scan & fast FTS search on 50,000 products + 70,000 barcodes (real WAL disk DB)', async () => {
    const env = await setupCatalogEnv();
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

      // Verify seeded row counts
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

      // Measure 250 barcode scans
      const scanTimes: number[] = [];
      for (const code of sampleBarcodes) {
        const t0 = performance.now();
        const hit = await env.catalogStore.scanBarcode(code);
        const dt = performance.now() - t0;
        expect(hit).not.toBeNull();
        scanTimes.push(dt);
      }

      // Measure 100 FTS & B-tree searches across Latin/Cyrillic/multi-word/prefix queries
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
