## Hisobot: T1.2
Branch / PR: `gemini/T1.2-stock` / https://github.com/Shaxobiddin-Github/Mezon/pull/9
Commit:
- `27418448e612d27bb9c54f81aade20cd7d657ca4` — `T1.1 test qarzi: EAN-8 va FTS tartibi`
- `cd0020426b89be5f829ee781fd0d7d2236aed4da` — `T1.2: Ombor, partiya, FIFO/o'rtacha tannarx va inventarizatsiya`
- `43536f486bb81283f1d3e5bf533dfba1af8163d6` — `T1.2: FTS5 yagona o'tish va SQLite xotira pragmalari optimizatsiyasi`
- `facc046db0511d6fc2b1ea12e7aa4ebe293e0486` — `T1.2: Windows CI uchun disk WAL property test timeoutlari`

### Nima qilindi

1. **T1.1 test qarzi (`2741844`):**
   - `@mezon/domain`: `EAN-8` noto'g'ri nazorat raqamini rad etish (`96385075`) va har bitta raqamni o'zgartiruvchi `fast-check` property testi qo'shildi. Mutatsiya bilan tekshirildi: `verifyGs1CheckDigit` da `ean8` tekshiruvi ataylab chetlab o'tilganda test to'plami yiqildi (keyin qayta tiklandi).
   - `@mezon/db-local`: `products_fts` qidiruv tartibi `ORDER BY f.rank ASC, p."id" ASC` qilib deterministiklashtirildi hamda 30 ta bir xil nomli mahsulotda `limit=10, offset=0/10/20` bilan dublikatsiz va yo'qotishsiz sahifalash testi qo'shildi.

2. **Ombor va partiya domeni (`@mezon/domain/src/stock.ts`):**
   - `STOCK_MOVE_REASONS` (`initial`, `purchase`, `sale`, `return`, `inventory`, `adjustment`, `damaged`, `broken`, `personal`, `lost`), `NEGATIVE_STOCK_POLICIES` (`warn` / `block`), `INVENTORY_COUNT_STATUSES` (`open` / `finalized` / `cancelled`) va `STOCK_CONFLICT_REASONS` (`BATCH_OVERCONSUMED`, `UNKNOWN_COST_SURPLUS`, `ORPHAN_BATCH_REFERENCE`).
   - Qiymatga asoslangan (`remaining_qty` + `remaining_value` tiyinda) proporsional taqsimot (`computeProportionalCost`), FIFO (`planFifoOutboundLegs`) va o'rtacha tannarx (`planAverageOutboundCost`) rejalashtiruvchilari — oxirgi birlik qoldiq tiyinni to'liq yechib oladi, yaxlitlashda 1 tiyin ham yo'qolmaydi.
   - Manfiy zaxira kamomadi (`deficitQty`, `provisionalDeficitValue`), keyingi kirimda kamomadni yopish va kechikkan/sinxron qayta o'ynashdagi qiymat farqi (`costVarianceValue`) — sof replay funksiyasi (`applyReplayStockMove`) hech qachon yiqilmaydi.
   - `computeSurplusCostValue` (**S4**): ortiqcha chiqqan tovar tannarxini hisoblash.

3. **Kontraktlar (`@mezon/contracts`):**
   - Mahsulot sxemalariga `trackBatches` (standart `false`, harakat yozilgandan keyin o'zgartirish `409 STOCK_COSTING_LOCKED`).
   - Kassir javoblari uchun alohida `CashierStockBalanceSchema` (faqat miqdor/birlik/`isLowStock`; tannarx, partiya qiymati va `costVarianceValue` maydonlari umuman yo'q), egasi/menejer uchun `StockValuationItemSchema`, `BatchSummarySchema`, `StockMoveSummarySchema`, `StockConflictSummarySchema` va inventarizatsiya sxemalari.

4. **Lokal baza va repozitoriy (`@mezon/db-local`):**
   - `0004_stock.sql`: `local_hub_config.negative_stock_policy` (`'warn'`), `products.track_batches` (`0`), hamda 7 ta yangi jadval: `batches` (`FACT`), `stock_moves` (`FACT`), `inventory_counts` (`MONOTONE`), `inventory_count_lines` (`MONOTONE`), `local_stock_balances` / `local_batch_balances` / `local_stock_conflicts` (`LOCAL`).
   - `0003` -> `0004` migratsiyasida `drizzle-kit` yaratadigan xavfli `DROP TABLE` o'rniga toza `ALTER TABLE ... ADD COLUMN` yozildi (mavjud `products` va `products_fts` triggerlari saqlanadi).
   - `SqliteStockStore` va `rebuildStockProjections()`: `(hlc ASC, id ASC)` tartibida qayta qurish, 0 ta outbox hodisasi chiqarish (`runConnectionProjectionMaintenance` orqali), **S1**–**S4** kafolatlari.
   - `stock-migrations.ts` + `check-migrations.mjs`: `assertStockMigrationsComplete` barcha **S3** triggerlarini `db:check` da tekshiradi.
   - `GEMINI.md` 4-bo'lim va `packages/db-local/src/schema/index.ts` izohida `stock_moves`/`batches` yagona do'kon hub'i yozuvchisi qoidasi (`F2` da bulutda majburlanadi) hujjatlashtirildi.

5. **CI barqarorligi va FTS5 optimizatsiyasi (`43536f4`, `facc046`):**
   - `catalog-repo.ts`: `ORDER BY f.rank ASC, f."product_id" ASC` qo'shilgandan keyin Windows CI runner'ida `searchP95` 50.997 ms ga chiqib qolgani aniqlandi. `products_fts` dan `COUNT(*) OVER()` bilan yagona o'tishda (kategoriyasiz qidiruvda ortiqcha `INNER JOIN products` siz) tayyorlangan so'rovlarni keshlash va `connection.ts` da `temp_store = MEMORY` / `cache_size = -16384` pragmalarini qo'llash orqali 50k WAL qidiruv `p95` lokalda 37.1 ms dan **22.8 ms** ga tushirildi va Windows CI o'tdi.
   - Disk WAL'da 25 marta yangi baza ochib migratsiya qiluvchi property testlarga (`stock.test.ts:759`, `catalog.test.ts:533`) 30 000 ms timeout berildi (assertions va `numRuns` o'zgarmagan).

6. **Hub API (`apps/hub`):**
   - `/stock/balances` (`stock:read` — kassir uchun ruxsat berilgan maydonlar ro'yxati orqali tannarxsiz), `/stock/valuation`, `/stock/batches`, `/stock/moves`, `/stock/moves/in`, `/stock/moves/out`, `/stock/conflicts`, `/stock/policy`, `/stock/projections/rebuild`, `/stock/inventory-counts/*` (`stock:write`, kassirga `403 AUTH_FORBIDDEN`).

### O'zgargan fayllar (fayl — sabab)

- `.mezon/gemini/HISOBOT.md` — T1.2 yakuniy hisoboti
- `GEMINI.md` — 4-bo'limga `stock_moves` / `batches` yagona yozuvchi qoidasi (`F2` da bulut tekshiruvi) eslatmasi
- `packages/domain/src/errors.ts` — `STOCK_COSTING_LOCKED`, `UNLIMITED_PRODUCT_STOCK_NOT_TRACKED`, `INSUFFICIENT_STOCK`, `INVALID_STOCK_MOVE_REASON`, `BATCH_REQUIRED`, `BATCH_NOT_FOUND`, `INVENTORY_COUNT_NOT_FOUND`, `INVENTORY_COUNT_NOT_OPEN`
- `packages/domain/src/auth.ts`, `auth.test.ts`, `index.ts` — `stock:read` (`owner`/`manager`/`cashier`) va `stock:write` (`owner`/`manager`) ruxsatlari + stock domen eksportlari
- `packages/domain/src/stock.ts`, `stock.test.ts` — FIFO/o'rtacha tannarx, kamomad, S4 ortiqcha qiymat va 200-run property test
- `packages/domain/src/catalog.test.ts` — T1.1 test qarzi (`EAN-8` bad check-digit va property test)
- `packages/contracts/src/catalog.ts`, `catalog.test.ts`, `index.ts` — `trackBatches` maydoni va `stock` DTO eksportlari
- `packages/contracts/src/stock.ts`, `stock.test.ts` — ombor, partiya, harakat, konflikt, inventarizatsiya va kassir uchun tannarxsiz DTO sxemalari
- `packages/db-local/src/schema/index.ts` — 7 ta yangi jadval (`FACT`/`MONOTONE`/`LOCAL`), `trackBatches`, `negativeStockPolicy`, yagona yozuvchi izohi
- `packages/db-local/drizzle/0004_stock.sql`, `drizzle/meta/0004_snapshot.json`, `drizzle/meta/_journal.json` — xavfsiz `ALTER TABLE`, yangi jadvallar va `FACT`/`MONOTONE` triggerlar migratsiyasi
- `packages/db-local/src/writers.ts` — `insertMonotone`, `updateMonotone` va umumiy mutable yozuvchi helper
- `packages/db-local/src/stock-migrations.ts`, `scripts/check-migrations.mjs` — `buildStockMonotoneTriggersSql` va `assertStockMigrationsComplete` (`db:check` himoyasi)
- `packages/db-local/src/connection.ts` — `temp_store = MEMORY` va `cache_size = -16384` pragmalari
- `packages/db-local/src/catalog-repo.ts`, `catalog.test.ts` — `trackBatches` + `STOCK_COSTING_LOCKED`, FTS5 `ORDER BY f.rank ASC, f."product_id" ASC` / `COUNT(*) OVER()` yagona o'tish va 30 bir xil mahsulot sahifalash testi
- `packages/db-local/src/stock-repo.ts`, `stock.test.ts` — `SqliteStockStore`, `rebuildStockProjections()`, S1–S4 va 25-run stateful SQLite parity testi
- `packages/db-local/src/index.ts`, `index.test.ts` — eksportlar, `0003 -> 0004` jonli baza yangilash testi va S3 salbiy trigger isbotlari
- `apps/hub/src/error-handler.ts`, `catalog-service.ts`, `index.ts`, `routes.ts`, `server.ts` — stock xatolari mapping'i (`400`/`404`/`409`) va servis ulanishi
- `apps/hub/src/stock-service.ts`, `stock-routes.ts`, `stock.test.ts` — HTTP endpointlar, RBAC va kassir DTO izolyatsiyasi testi

### Migratsiyalar

- `packages/db-local/drizzle/0004_stock.sql`:
  - `local_hub_config` ga `negative_stock_policy TEXT NOT NULL DEFAULT 'warn'` qo'shadi (`ALTER TABLE`).
  - `products` ga `track_batches INTEGER NOT NULL DEFAULT 0` qo'shadi (`ALTER TABLE`, mavjud qatorlar va FTS triggerlar buzilmaydi).
  - `batches`, `stock_moves`, `inventory_counts`, `inventory_count_lines`, `local_stock_balances`, `local_batch_balances`, `local_stock_conflicts` jadvallari va `FACT`/`MONOTONE` triggerlarini yaratadi (`check-migrations.mjs` da 0 diff).

### Qabul mezonlari

- [x] **T1.1 test qarzi (`EAN-8` + `FTS5` tartibi)** — `packages/domain/src/catalog.test.ts` (`F3 & GS1: verifies GS1 check digits...`) va `packages/db-local/src/catalog.test.ts` (`FTS5 pagination stays deterministic without drops or duplicates when 30 products share identical text & rank`).
- [x] **Proyeksiya = ledger yig'indisi va qayta qurish natijasi teng (0 outbox)** — `packages/db-local/src/stock.test.ts`: harakatlar va qayta qurishdan keyin `qtyOnHand === SUM(qty_delta)`, `totalValue === SUM(batch.remainingValue)` va `rebuildProjections()` davomida outbox o'zgarmaydi (`(g) property test...`, `(d) out-of-order HLC replay...`).
- [x] **Qo'lda hisoblangan misollar** — `packages/domain/src/stock.test.ts` hamda `packages/db-local/src/stock.test.ts` (`enforces unit rules, unlimited product blocks, STOCK_COSTING_LOCKED, FACT immutability, and worked manual FIFO & average examples`):
  - `worked example #1: FIFO negative stock unbatched deficit and later closing receipt without losing 1 tiyin` (FIFO + manfiy qoldiqdan keyingi yopilish)
  - `worked example #2: indivisible 10,000 / 3 weighted average cost drains 3,333 then exact remainder 6,667` (bo'linmas o'rtacha tannarxda 1 tiyin yo'qolmasligi)
- [x] **S1 (kutilgan qoldiq har qator sanalgan paytda UoW ichida olinadi, qisman sanoq `NULL`)** — `packages/db-local/src/stock.test.ts`: `S1 & S3: snapshots expected_qty_at_count at line count time (cases a, b, c + partial) and blocks post-finalize line mutations` (a: 10→2 sotildi→8 sanaldi→yakun 8; b: 10→9 sanaldi→2 sotildi→yakun 7; c: bir qatorni ikki marta sanash; hamda `NULL` sanalmagan mahsulot nolga tushirilmasligi).
- [x] **S2 (proyeksiya CHECK'siz, partiya oshsa kamomadga o'tadi + `local_stock_conflicts`)** — `packages/db-local/src/stock.test.ts`: `S2 & S4: rebuildStockProjections survives over-consumed batches & unknown surplus costs, logging owner conflicts accurately` (xom SQL bilan bitta partiyani ortiqcha ishlatuvchi `stock_moves` kiritilgandan keyin `rebuildStockProjections()` xatosiz tugaydi va `BATCH_OVERCONSUMED` konflikti yoziladi; `GEMINI.md` va `schema/index.ts` izohida F2 qoidasi qayd etilgan).
- [x] **S3 (`inventory_counts` va `inventory_count_lines` triggerlari)** — `packages/db-local/src/stock.test.ts` (`S1 & S3...` ichida `finalized` va `cancelled` sanoq qatoriga xom SQL `INSERT`/`UPDATE` urinishi `SQLite` trigger tomonidan rad etilishi) va `packages/db-local/src/index.test.ts` (`F4 negative proof...` da `assertStockMigrationsComplete` salbiy isbotlari: `INSERT` va `UPDATE` triggeri olib tashlansa `db:check` yiqiladi).
- [x] **S4 (ortiqcha sanoq tannarxi)** — `packages/domain/src/stock.test.ts` (`S4: computes surplus inventory cost by mode and flags unknown cost cleanly`) va `packages/db-local/src/stock.test.ts` (`S2 & S4...`): FIFO da `last_unit_cost` bilan yangi partiya, o'rtacha rejimda joriy o'rtacha narx, tannarx noma'lum bo'lsa `0` tiyin + `UNKNOWN_COST_SURPLUS` konflikti.
- [x] **Property testlar tavsifi**:
  1. `packages/domain/src/stock.test.ts` — `property test: inbound = outbound + remaining + variance - provisional holds to exact tiyin across random sequences` (`fast-check`, 200 ta tasodifiy ketma-ketlik): har xil `trackBatches` (FIFO/average), `policy` (`warn`/`block`), vaqt o'zgarishi va har xil kirim/chiqim/ortiqcha/kamomad qadamlaridan so'ng ikki yoqlama qiymat tengligi (`SUM(inboundCost) === SUM(outboundCost) + remainingValue - provisionalDeficitValue + costVarianceValue`) va `totalQty >= 0 => deficitQty === 0` invariantsiz tiyingacha tekshiriladi.
  2. `packages/db-local/src/stock.test.ts` — `(g) property test: live SQLite state & rebuildStockProjections match independent naive ledger model exactly across random ops` (`fast-check`, 25 ta to'liq WAL disk bazasi ssenariysi): tasodifiy kirim, chiqim (`warn`/`block`) va inventarizatsiya amallaridan keyin jonli SQLite `local_stock_balances`/`local_batch_balances`, `stock_moves` ledger yig'indisi hamda mustaqil sodda model bir-biriga tengligi va `rebuildStockProjections()` 0 outbox bilan aynan shu natijani qayta qurishi tekshiriladi.
- [x] **RBAC va kassirdan tannarx yashirish** — `apps/hub/src/stock.test.ts` (`enforces cashier cost-hiding on /stock/balances, blocks write/valuation endpoints with 403, and supports manager workflow`): kassir `/stock/balances` dan faqat miqdorlarni oladi (tannarx/qiymat/farq kalitlari umuman yo'q), `/stock/valuation`, `/stock/batches`, `/stock/moves`, `/stock/moves/*`, `/stock/inventory-counts/*` da `403 AUTH_FORBIDDEN`.
- [x] **0003 → 0004 jonli baza yangilanishi** — `packages/db-local/src/index.test.ts` (`cleanly upgrades a pre-populated 0003 database to 0004 without losing products or FTS triggers`).

### Test natijasi (buyruq va haqiqiy chiqish)

1. Lokal `pnpm verify` (`facc046` ustida):
   - `prettier --check .` → `All matched files use Prettier code style!`
   - `turbo run build` → `17 successful, 17 total`
   - `eslint .` → 0 xato
   - `turbo run typecheck` → `22 successful, 22 total`
   - `turbo run db:check` → PostgreSQL va SQLite migratsiyalar bilan 0 diff (`19 successful, 19 total`)
   - `vitest run` → `Test Files 29 passed | 1 skipped (30)`, `Tests 150 passed | 2 skipped (152)` (skip: `packages/db-cloud/src/pg-rls.test.ts` lokal Windows'da Docker yo'qligi uchun)
   - `catalog.test.ts` 50k WAL natijasi: `[T1.1 Perf 50k products / 70k barcodes WAL] seedMs=5834.5 scan(n=250): p50=0.429ms p95=0.713ms | search(n=100): p50=19.485ms p95=22.701ms`
   - `depcruise --config .dependency-cruiser.cjs apps/*/src packages/*/src` → `no dependency violations found (197 modules, 556 dependencies cruised)`

2. GitHub Actions CI (`facc046db0511d6fc2b1ea12e7aa4ebe293e0486`):
   - Workflow runs: https://github.com/Shaxobiddin-Github/Mezon/actions/runs/42834263476 (PR) va https://github.com/Shaxobiddin-Github/Mezon/actions/runs/42834251233 (push)
   - `Verify (ubuntu-latest)`: `success` — https://github.com/Shaxobiddin-Github/Mezon/actions/runs/42834263476/job/129892145753
   - `Verify (windows-latest)`: `success` — https://github.com/Shaxobiddin-Github/Mezon/actions/runs/42834263476/job/129892145657
   - `Verify PostgreSQL RLS (ubuntu-latest)`: `success` — https://github.com/Shaxobiddin-Github/Mezon/actions/runs/42834263476/job/129892145427
   - `Build & E2E Desktop Installer (windows-latest)`: `success` — https://github.com/Shaxobiddin-Github/Mezon/actions/runs/42834263476/job/129892145132

### Tekshirilmagan narsalar

- `packages/db-cloud/src/pg-rls.test.ts` (2 ta test) lokal Windows mashinasida Docker bo'lmagani uchun skip qilindi; lekin GitHub Actions CI dagi `Verify PostgreSQL RLS (ubuntu-latest)` job'ida to'liq bajarildi va muvaffaqiyatli o'tdi.

### Qilingan taxminlar

- F1 bosqichida `warehouses` jadvali bo'lmagani sababli `batches` va `stock_moves` bevosita `store_id` bilan bog'landi (tasdiqlangan reja bo'yicha).
- `products_fts` faol (`deleted_at_ms IS NULL`) mahsulotlar bilan `trg_products_fts_after_insert`/`update` va `rebuildCatalogSearchIndex` orqali sinxron ushlanadi; kategoriyasiz FTS5 qidiruvda `products_fts` ga to'g'ridan-to'g'ri murojaat qilish F4 invarianti bilan ta'minlanadi.

### Takliflar

- `T1.4` (`completeSale`) da savdo tranzaksiyasini yozishda ham `SqliteStockStore` ning ichki session helper'lari (`applyOutboundInsideSessionSync`) orqali to'g'ridan-to'g'ri bitta `uow.execute` ichida `sale`, `sale_line`, `stock_move` va `local_stock_balances` ni atomar bog'lash maqsadga muvofiq.

### Egasi yoki Claude qarori kerak bo'lgan savollar

- Yo'q. PR #9 merge qilish uchun Claude `QABUL` qarori kutilmoqda.
