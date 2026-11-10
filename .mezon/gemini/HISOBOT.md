## Hisobot: T1.1 — Katalog

Branch / PR: `gemini/T1.1-catalog` / [PR #8](https://github.com/Shaxobiddin-Github/Mezon/pull/8)  
Kod commit SHA: `d8f4e77b3fce5ecd76eddb903ba81e5167bd03a1` (`T1.1: Katalog, shtrix-kod, FTS5 qidiruv va Hub API`)

---

### Nima qilindi

1. **Domen qoidalari (`packages/domain`):**
   - `PRODUCT_UNITS` (`dona`, `kg`, `g`, `litr`, `metr`, `m2`, `qadoq`) va `validateQuantityForUnit`: `dona`/`qadoq` da faqat `1000n` (`1.000`) ga karrali butun miqdorlar ruxsat etiladi, kasr yoki manfiy qiymatlar `DomainError('INVALID_UNIT_QUANTITY')` bilan rad etiladi (`fast-check` property testi bilan tasdiqlangan).
   - **GS1 va F3 (`UPC-A` ↔ `EAN-13` kanonikalizatsiyasi):** `verifyGs1CheckDigit` (`EAN-13`, `EAN-8`, `UPC-A` Modulo-10), `prepareBarcodeForStorage` (GS1 nazorat raqamini qat'iy tekshirish, `internal`/`other` istisnosi, 12 raqamli `UPC-A` ni oldiga `'0'` qo'shib kanonik 13 raqamli `EAN-13` ga keltirish), `buildScanBarcodeCandidates` (`0` + `UPC-A` birinchi nomzod sifatida).
   - **F5 va F2 (`normalizeCatalogSearchText`, `buildFtsPrefixQuery`):** o'zbek kirill→lotin transliteratsiyasi (`х` → `x`, `ҳ` → `h`, `қ` → `q`, `ў` → `o`, `ғ` → `g`, `ш` → `sh`, `ч` → `ch`, `ё/ю/я/е/ц` kontekstli xaritalash), `ъ`/`ь` va barcha apostroflarni olib tashlash, ajratgichlarni bo'shliqqa o'girish, hamda FTS5 sintaksis in'ektsiyasini (`"`, `*`, `-`, `:`, `(`, `NEAR`, `OR`, `AND`, `NOT`) barcha tokenlarni `"tok"*` shaklida `AND` bilan ulash orqali neytrallashtirish.
   - `canonicalizeVariantAttributes` / `parseVariantAttributesJson` (kalitlar bo'yicha kanonik tartiblangan JSON).
   - `HubPermission` ga `'catalog:read'` (`owner`, `manager`, `cashier`) va `'catalog:write'` (`owner`, `manager`) qo'shildi.

2. **Kontraktlar (`packages/contracts`):**
   - Kategoriyalar, mahsulotlar, variantlar, shtrix-kodlar, narx o'zgarish tarixi va `/catalog/scan` uchun qat'iy `z.strictObject` Zod sxemalari (`packages/contracts/src/catalog.ts`). Pul (`salePrice`, `oldPrice`, `newPrice`) va miqdor (`minStock`, `quantity`) JSON da `BigIntStringSchema` satr ko'rinishida.

3. **Lokal SQLite sxemasi, FTS5 va repozitoriy (`packages/db-local`):**
   - `packages/db-local/drizzle/0003_catalog.sql`: `categories`, `products`, `product_variants`, `product_barcodes` (`ATTR`, `organization` scope) va `price_changes` (`FACT`, `organization` scope) — barcha fiskal ustunlar (`mxik`, `package_code`, `vat_rate_bp`), partial unique indekslar, `idx_products_active_join` covering indeksi va `CHECK` cheklovlari hamda immutability triggerlari bilan.
   - **F1 (`rowid` xavfisiz FTS5):** `products_fts` mustaqil FTS5 virtual jadvali (`product_id UNINDEXED`, `organization_id UNINDEXED`, `name_search`, `sku_search`, `tokenize='unicode61 remove_diacritics 0'`, `prefix='2 3'`), `content=` ishlatilmaydi, barcha qidiruv va triggerlar qat'iy UUID `product_id` orqali bog'lanadi (`DELETE + VACUUM` dan keyin ham to'g'ri ID lar qaytishi testlangan).
   - **F4 (`rebuildCatalogSearchIndex` + `db:check`):** `name_search`/`sku_search` va `products_fts` ni noldan qayta qurish (outbox hodisasi chiqarmaydi) + `assertCatalogSearchMigrationsComplete` migratsiyada `products_fts`, `content=` yo'qligi va `AFTER INSERT`/`AFTER UPDATE` FTS triggerlari borligini `db:check` da tekshiradi.
   - `SqliteCatalogStore`: kategoriya sikl va `CATEGORY_IN_USE` tekshiruvi, narx o'zgarganda atomik `price_changes` + outbox yozuvi, variant/mahsulot o'chirilganda kaskad tombstone, 1-belgili so'rovlar uchun B-tree diapazon va 2+ belgili so'rovlar uchun FTS5 qidiruvi.

4. **Hub API va RBAC (`apps/hub`):**
   - `HubCatalogService` (aniq maydon ro'yxatli DTO mapperlar — `costPrice`/`profit`/`nameSearch` hech qachon javobga kirmaydi).
   - Marshrutlar: `/categories`, `/products`, `/products/:id/variants`, `/products/:id/barcodes`, `/products/:id/price-changes` (faqat `catalog:write` — kassir `403 AUTH_FORBIDDEN` oladi), `/catalog/scan` (`catalog:read`).

---

### Majburiy tuzatishlar (F1–F5) bo'yicha dalillar

- **F1 (VACUUM va `rowid` mustaqilligi):** `0003_catalog.sql` da `products_fts(product_id UNINDEXED, organization_id UNINDEXED, name_search, sku_search)` (`content=` yo'q); `catalog-repo.ts` da `INNER JOIN "products" p ON p."id" = f."product_id"`. Test: `packages/db-local/src/catalog.test.ts` — `"F1, F2, F5: survives DELETE+VACUUM without rowid drift..."` (qo'shish → o'chirish → qayta qo'shish/tahrirlash → `VACUUM;` → barcha qidiruvlar aniq UUID larni qaytaradi).
- **F2 (FTS sintaksis in'ektsiyasi):** `buildFtsPrefixQuery` faqat `[a-z0-9]+` tokenlarni `"tok"*` shaklida `AND` bilan birlashtiradi; bo'sh/faqat belgi kiritmalarda `null` qaytarib bo'sh natija beradi. Testlar: `packages/domain/src/catalog.test.ts` (property test + jadvalli test) va `packages/db-local/src/catalog.test.ts` (`"`, `*`, `-`, `:`, `(`, `)`, `NEAR`, `OR`, `AND`, `NOT`, `cola OR "pepsi"* -not:near(`).
- **F3 (UPC-A ↔ EAN-13):** `036000291452` va `0036000291452` saqlashda `'0036000291452'` ga keltiriladi (`uidx_product_barcodes_org_barcode` ikkalasini alohida ro'yxatdan o'tkazishni `BARCODE_ALREADY_EXISTS` / HTTP `409` bilan bloklaydi). `buildScanBarcodeCandidates` ikkala shaklda ham bitta mahsulotni topadi. Testlar: `domain/src/catalog.test.ts`, `db-local/src/catalog.test.ts`, `hub/src/catalog.test.ts`.
- **F4 (Indeks yaxlitligi, `rebuildCatalogSearchIndex`, `db:check` salbiy dalili):**
  - `packages/db-local/src/catalog.test.ts` da buzilgan `name_search` + orphan `products_fts` qatori `rebuildCatalogSearchIndex` bilan tiklandi (0 outbox hodisa); `fast-check` stateful property testi ketma-ket `create`/`update`/`delete` dan keyin `products_fts` va faol `products` ID to'plamlari aynan tengligini tasdiqladi.
  - **`db:check` salbiy dalili:** Ishlab chiqish jarayonida tirik `pnpm --filter @mezon/db-local run db:check` trigger regex nomuvofiqligida `Error: AFTER INSERT trigger on "products" must insert into "products_fts"` bilan 1-kodda yiqildi; bundan tashqari `packages/db-local/src/index.test.ts` dagi `"F4 negative proof: rejects migrations missing products_fts, rowid coupling, or broken FTS sync triggers"` testi `products_fts` olib tashlanganda, `content = 'products'` qo'shilganda va `DELETE FROM products_fts` o'rniga `rowid` ishlatilganda `assertCatalogSearchMigrationsComplete` xato tashlashini doimiy tekshiradi.
- **F5 (Transliteratsiya aniqligi):** `хона -> xona`, `ҳаво -> havo`, `маъно -> mano`, `Молоко -> moloko`, `Coca-Cola Zero -> coca cola zero` (`zero` bilan topiladi) ham `domain` unit testida, ham `db-local` FTS5 qidiruv testida, ham `apps/hub` `/products?q=...` API testida tasdiqlandi.

---

### 50 000 mahsulot / 70 000 shtrix-kod WAL disk unumdorlik natijalari

`packages/db-local/src/catalog.test.ts` (`meets <= 20ms barcode scan & fast FTS search on 50,000 products + 70,000 barcodes (real WAL disk DB)` — haqiqiy diskdagi SQLite WAL baza):

- **Urug'lash (seed):** 50 000 mahsulot + 70 000 shtrix-kod + FTS5 trigger indekslash = `8949.6 ms`
- **Skan (`n = 250`, `store.scanBarcode`):** **`p50 = 0.403 ms`**, **`p95 = 0.478 ms`** (chegara `<= 20 ms`)
- **Nom bo'yicha qidiruv (`n = 100`, `store.listProducts({ q, limit: 20 })`):** **`p50 = 20.986 ms`**, **`p95 = 25.519 ms`** (chegara `<= 50 ms`)

*(Eslatma: boshlang'ich o'lchovda `ORDER BY p.name_search` sababli 10k qatorli temp B-tree sort tufayli `p95 = 136.3 ms` chiqqan edi; `idx_products_active_join` covering indeksi, `ORDER BY f.rank ASC` va `offset === 0 && hitRows.length < limit` holatida ortiqcha `COUNT(*)` ni o'tkazib yuborish bilan `p95 = 25.519 ms` ga tushirildi.)*

---

### O'zgargan fayllar (fayl — sabab)

- `packages/domain/src/errors.ts` — Katalog va shtrix-kod `DomainErrorCode` kodlari (`INVALID_UNIT_QUANTITY`, `INVALID_BARCODE_CHECK_DIGIT`, `CATEGORY_IN_USE`, `BARCODE_ALREADY_EXISTS` va h.k.).
- `packages/domain/src/auth.ts` — `'catalog:read'` va `'catalog:write'` `HubPermission` ruxsatlari (`cashier` faqat `'catalog:read'`).
- `packages/domain/src/catalog.ts` — Birliklar, miqdor qoidasi, GS1 Modulo-10, F3 UPC-A→EAN-13 kanonikalizatsiyasi, F5/F2 o'zbek transliteratsiyasi va FTS so'rov tozalash, variant atributlari kanonikalizatsiyasi.
- `packages/domain/src/index.ts`, `packages/domain/src/auth.test.ts`, `packages/domain/src/catalog.test.ts` — Eksportlar va property/unit testlar.
- `packages/contracts/src/catalog.ts`, `packages/contracts/src/index.ts`, `packages/contracts/src/catalog.test.ts` — Barcha katalog endpointlari uchun qat'iy Zod DTO va so'rov sxemalari hamda testlar.
- `packages/db-local/src/schema/index.ts` — `categories`, `products`, `product_variants`, `product_barcodes`, `price_changes` jadvallari (`localSchemaRegistry`).
- `packages/db-local/src/catalog-search-schema.ts` — `products_fts` FTS5 va trigger SQL generatori hamda `assertCatalogSearchMigrationsComplete` (`db:check` verifikatori).
- `packages/db-local/scripts/check-migrations.mjs` — `db:check` ga `assertCatalogSearchMigrationsComplete` ulandi.
- `packages/db-local/src/uow.ts` — `runConnectionProjectionMaintenance` (mutex ostida outbox'siz proyeksiya tiklash tranzaksiyasi).
- `packages/db-local/src/auth-repo.ts` — `getActiveRuntimeContext()` hub setup'dan keyin qayta ishga tushirishsiz `SqliteCatalogStore` ulanishi uchun.
- `packages/db-local/src/catalog-repo.ts` — `SqliteCatalogStore` va `rebuildCatalogSearchIndex`.
- `packages/db-local/src/index.ts`, `packages/db-local/src/index.test.ts`, `packages/db-local/src/catalog.test.ts` — Eksportlar, registr + salbiy `db:check` FTS testi, F1–F5 va 50k WAL unumdorlik testlari.
- `packages/db-local/drizzle/0003_catalog.sql`, `meta/0003_snapshot.json`, `meta/_journal.json` — T1.1 SQL migratsiyasi (jadvallar, indekslar, CHECK'lar, immutability triggerlari va FTS5 + triggerlar).
- `apps/hub/src/error-handler.ts` — Yangi `DomainErrorCode` larni HTTP `400`/`404`/`409` ga xaritalash.
- `apps/hub/src/catalog-service.ts`, `apps/hub/src/catalog-routes.ts`, `apps/hub/src/routes.ts`, `apps/hub/src/server.ts`, `apps/hub/src/index.ts`, `apps/hub/src/catalog.test.ts` — Katalog xizmati, maydon ro'yxatli DTO mapper, RBAC marshrutlari va to'liq HTTP integratsion testlar.

---

### Migratsiyalar

- `packages/db-local/drizzle/0003_catalog.sql`:
  - 5 ta jadval: `categories`, `products`, `product_variants`, `product_barcodes` (`ATTR`), `price_changes` (`FACT`).
  - Fiskal maydonlar: `products.mxik`, `products.package_code`, `products.vat_rate_bp`.
  - Partial unique indekslar (`uidx_categories_org_root_name`, `uidx_categories_org_child_name`, `uidx_products_org_sku`, `uidx_product_variants_org_sku`, `uidx_product_barcodes_org_barcode`), covering indeks `idx_products_active_join`.
  - 5 ta jadval immutability triggerlari + `products_fts` FTS5 virtual jadvali (`product_id UNINDEXED`, `organization_id UNINDEXED`) + `trg_products_fts_after_insert` / `trg_products_fts_after_update`.

---

### Qabul mezonlari

- [x] `50 000` mahsulotda skan ≤ 20 ms (`domain` va `db-local`) — `scan(n=250): p50=0.403ms, p95=0.478ms` (`packages/db-local/src/catalog.test.ts`)
- [x] Bir shtrix-kod do'kon/tashkilot ichida bitta faol yozuvga bog'lanadi; UPC-A/EAN-13 kanonik yagona — `uidx_product_barcodes_org_barcode`, `prepareBarcodeForStorage` (F3 testlari)
- [x] `dona`/`qadoq` kasr rad etiladi, `5.5 kg` qabul qilinadi — `validateQuantityForUnit` + `fast-check` property test
- [x] F1–F5 talablarining barchasi (`VACUUM`, FTS5 operator xavfsizligi, UPC-A↔EAN-13, `rebuildCatalogSearchIndex` + `db:check` + property test, transliteratsiya) — barcha testlar o'tdi
- [x] RBAC va DTO xavfsizligi (kassir `catalog:write` va `price-changes` dan `403`, tannarx maydonlari yo'q) — `apps/hub/src/catalog.test.ts`
- [x] `pnpm verify` va 4 ta CI job (Ubuntu, Windows, PostgreSQL RLS, Desktop NSIS) yashil

---

### Test natijasi (buyruq va haqiqiy chiqish)

1. **`pnpm verify` (lokal Windows):** `Command exited with code 0`
   - `format:check` — All matched files use Prettier code style!
   - `build` — 17/17 packages successful
   - `eslint .` — 0 xato
   - `typecheck` — 17/17 packages successful
   - `db:check` — PostgreSQL & SQLite 0 diff statements (`assertSqliteTriggersMigrationsComplete` + `assertCatalogSearchMigrationsComplete` o'tdi)
   - `vitest run` — **25 passed test files (135 passed tests)**; `packages/db-cloud/src/pg-rls.test.ts` (2 tests) lokal Windows da Docker yo'qligi sababli skipped (CI da yashil o'tdi).
   - `depcruise` — `no dependency violations found (183 modules, 481 dependencies cruised)`

2. **GitHub Actions CI (commit `d8f4e77b3fce5ecd76eddb903ba81e5167bd03a1`):**
   - `push` workflow run: [#42824173511](https://github.com/Shaxobiddin-Github/Mezon/actions/runs/42824173511) — **4/4 job `success`**:
     - `Verify (ubuntu-latest)` — `success` ([job](https://github.com/Shaxobiddin-Github/Mezon/actions/runs/42824173511/job/129856971626))
     - `Verify (windows-latest)` — `success` ([job](https://github.com/Shaxobiddin-Github/Mezon/actions/runs/42824173511/job/129856971652))
     - `Verify PostgreSQL RLS (ubuntu-latest)` — `success` ([job](https://github.com/Shaxobiddin-Github/Mezon/actions/runs/42824173511/job/129856971805))
     - `Build & E2E Desktop Installer (windows-latest)` — `success` ([job](https://github.com/Shaxobiddin-Github/Mezon/actions/runs/42824173511/job/129856971313))
   - `pull_request` (PR #8) workflow run: [#42824224171](https://github.com/Shaxobiddin-Github/Mezon/actions/runs/42824224171) — **4/4 job `success`**:
     - `Verify (ubuntu-latest)` — `success` ([job](https://github.com/Shaxobiddin-Github/Mezon/actions/runs/42824224171/job/129857159248))
     - `Verify (windows-latest)` — `success` ([job](https://github.com/Shaxobiddin-Github/Mezon/actions/runs/42824224171/job/129857158719))
     - `Verify PostgreSQL RLS (ubuntu-latest)` — `success` ([job](https://github.com/Shaxobiddin-Github/Mezon/actions/runs/42824224171/job/129857159335))
     - `Build & E2E Desktop Installer (windows-latest)` — `success` ([job](https://github.com/Shaxobiddin-Github/Mezon/actions/runs/42824224171/job/129857159220))

---

### Tekshirilmagan narsalar

- Lokal Windows muhitida `packages/db-cloud/src/pg-rls.test.ts` (2 ta test) o'tkazib yuborilgan (`postgres-rls` Ubuntu CI jobi to'liq yashil o'tdi).
- Katalog UI (`T1.11`), Excel import (`T1.13`), ombor/FIFO (`T1.2`) va tarozi `2x` shtrix-kod (`T5.8`) ushbu vazifa doirasidan tashqarida.

---

### Qilingan taxminlar

- 12 raqamli `UPC-A` shtrix-kodlari saqlashda kanonik 13 raqamli `'0' + upca` ga aylantiriladi, shu bilan birga asl manbani kuzatish uchun `format: 'upca'` saqlanadi; noyoblik esa `(organization_id, barcode)` bo'yicha kanonik satr ustida ta'minlanadi.
- FTS5 qidiruvi `f.rank ASC` bo'yicha tartiblanadi va `offset === 0 && hitRows.length < limit` holatida ortiqcha `COUNT(*)` so'rovini bajarmaydi (20 ms atrofidagi qidiruv kechikishini saqlab qolish uchun).

---

### Takliflar

1. `F2` sinxron qabulida (`applyRemoteCatalogEvent`) yangi/o'zgargan mahsulotlarda `rebuildCatalogSearchIndex` yoki qator darajasidagi normalizatsiyani qayta qo'llash foydali bo'ladi, shunda boshqa qurilmadagi normalizator versiyasidan qat'i nazar FTS5 mos qoladi.
2. `T5.8` (tarozi `2x` yorlig'i) da `scanCatalogBarcode` ichidagi `quantity: null` maydonini tarozi vazni/soni bilan to'ldirish marshrut kontraktini o'zgartirmasdan ulanadi.

---

### Egasi yoki Claude qarori kerak bo'lgan savollar

Yo'q (PR #8 bo'yicha `QABUL` tekshiruvi kutilmoqda).
