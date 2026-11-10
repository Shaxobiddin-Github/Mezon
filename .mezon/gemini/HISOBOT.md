## T1.1 Merge xulosasi

- **PR #8** (`gemini/T1.1-catalog`, bosh SHA `d5ccfce263de54441df0292ea8a5d252b035e74e`, barcha 8 CI check run `success` — Run [#42826641570](https://github.com/Shaxobiddin-Github/Mezon/actions/runs/42826641570) va [#42826630033](https://github.com/Shaxobiddin-Github/Mezon/actions/runs/42826630033)) `T1.1: Katalog, shtrix-kod va qidiruv` nomi bilan Squash and merge qilindi.
- **Merge commit SHA (`main`):** `a5bba260c261468f377f0cdfdfa161beac1dc9b9`
- **`gemini/T1.1-catalog` branch:** masofadan va lokaldan o'chirildi.
- **Yangi branch (`main` @ `a5bba26` dan):** `gemini/T1.2-stock`

---

## Reja: T1.2 — Ombor va partiya

> **Eslatma:** Hozir faqat reja taqdim etilmoqda. Claude tasdig'isiz T1.2 kodi yozilmaydi.

### 0. Birinchi alohida commit (`T1.1 test qarzi: EAN-8 va FTS tartibi`)

T1.2 kodidan avval alohida commit'da bajariladi:
1. `packages/domain/src/catalog.test.ts` ga noto'g'ri nazorat raqamli EAN-8 (`96385075`) `INVALID_BARCODE_CHECK_DIGIT` bilan rad etilishi va 7-raqamli `fast-check` EAN-8 korruptsiya testi qo'shiladi (vaqtinchalik mutatsiya bilan isbotlanadi).
2. `packages/db-local/src/catalog-repo.ts` dagi FTS qidiruv so'rovi `ORDER BY f.rank ASC, p."id" ASC` qilib barqarorlashtiriladi (`p."id"` `idx_products_active_join` covering indeksi ichida bo'lgani uchun heap o'qishi qo'shilmaydi) va 30+ bir xil nomli mahsulot sahifalashi testlanadi.

---

### a) Ledger, partiya va jadvallar (`packages/db-local`, `0004_stock.sql`)

1. **`products` jadvaliga `track_batches` (`ATTR`):**
   - `sqliteBoolean('track_batches').notNull().default(false)` (`false` = o'rtacha tannarx, `true` = FIFO partiyali tovar). Mavjud `/products` API kontraktida ixtiyoriy (`default: false`).
   - Agar mahsulot bo'yicha allaqachon `stock_moves` yozilgan bo'lsa, `track_batches` ni almashtirish `409 VALIDATION_ERROR` (yoki `STOCK_COSTING_LOCKED`) bilan rad etiladi.

2. **`batches`** (`tableClass: 'FACT'`, **`tenantScope: 'store'`**):
   - Umumiy FACT sinxron ustunlari (`id`, `organization_id`, `store_id`, `device_id`, `hlc`, `created_at_ms`).
   - `product_id` (`sqliteUuidV7 notNull -> products.id`), `variant_id` (`sqliteUuidV7 nullable -> product_variants.id`).
   - `batch_number` (`text nullable`), `expiry_date_ms` (`sqliteUnixMs nullable`).
   - `initial_qty` (`sqliteQuantity notNull`, `CHECK (initial_qty > 0)`).
   - `initial_cost_value` (`sqliteMoney notNull`, `CHECK (initial_cost_value >= 0)`) — birlik tannarx emas, partiyaning **umumiy boshlang'ich qiymati** tiyinda.
   - `supplier_id` (`sqliteUuidV7 nullable`, T1.8 uchun tayyor ustun).
   - Indeks: `idx_batches_store_prod_fifo` (`(organization_id, store_id, product_id, variant_id, hlc, id)`).

3. **`stock_moves`** (`tableClass: 'FACT'`, **`tenantScope: 'store'`**):
   - Umumiy FACT sinxron ustunlari.
   - `product_id` (`sqliteUuidV7 notNull -> products.id`), `variant_id` (`sqliteUuidV7 nullable -> product_variants.id`), `batch_id` (`sqliteUuidV7 nullable -> batches.id`).
   - `qty_delta` (`sqliteQuantity notNull`, `CHECK (qty_delta <> 0)`) — kirim/qaytarish/musbat inventarizatsiya `> 0`, savdo/chiqim/manfiy tuzatish `< 0`.
   - `cost_value_delta` (`sqliteMoney notNull`) — ishorali qiymat snapshot'i (`CHECK ((qty_delta > 0 AND cost_value_delta >= 0) OR (qty_delta < 0 AND cost_value_delta <= 0))`).
   - `reason` (`text notNull`): `'initial' | 'purchase' | 'sale' | 'return' | 'inventory' | 'adjustment' | 'damaged' | 'broken' | 'personal' | 'lost'` (GEMINI.md 8-bo'lim T1.2 dagi barcha 10 sabab).
   - `source_type` (`text notNull`: `'stock_entry' | 'inventory_count' | 'sale' | 'return' | 'purchase' | 'adjustment'`), `source_id` (`sqliteUuidV7 notNull`).
   - `created_by_user_id` (`sqliteUuidV7 notNull -> users.id`), `note` (`text nullable`).
   - Indekslar: `(organization_id, store_id, product_id, variant_id, hlc, id)`, `(organization_id, store_id, batch_id, hlc, id)`, `(organization_id, store_id, source_type, source_id)`.
   - FACT sinfi sabab `UPDATE` va `DELETE` SQLite trigger bilan taqiqlanadi; tuzatish faqat teskari harakat bilan.

4. **`inventory_counts` va `inventory_count_lines`** (`tableClass: 'MONOTONE'`, **`tenantScope: 'store'`**):
   - `inventory_counts`: `status` (`'open' | 'finalized' | 'cancelled'`), `started_by_user_id`, `finalized_by_user_id` (nullable), `finalized_at_ms` (`sqliteUnixMs nullable`), `note`. SQLite `BEFORE UPDATE` triggeri `OLD.status <> 'open'` bo'lganda har qanday o'zgartirishni `RAISE(ABORT, ...)` bilan bloklaydi (haqiqiy MONOTONE kafolati).
   - `inventory_count_lines`: `count_id`, `product_id`, `variant_id`, `expected_qty_at_start` (`sqliteQuantity notNull`), `counted_qty` (`sqliteQuantity nullable`), `adjustment_qty` (`sqliteQuantity nullable`, yakunlashda `counted_qty - expected_qty_at_start` yoziladi).

5. **`local_stock_balances` va `local_batch_balances`** (`tableClass: 'LOCAL'`, `tenantScope: 'store'`):
   - Sinxronlanmaydi (`LOCAL`), faqat ledgerdan yangilanadi va `rebuildStockProjections()` bilan noldan quriladi.
   - `local_stock_balances`: `store_id`, `product_id`, `variant_id` (nullable; partial unique indekslar variantli/variantsiz uchun), `qty_on_hand` (`sqliteQuantity`), `total_value` (`sqliteMoney >= 0`), `deficit_qty` (`sqliteQuantity >= 0`), `provisional_deficit_value` (`sqliteMoney >= 0`), `cost_variance_value` (`sqliteMoney`, manfiy qoldiq yoki kechikkan sinxron farqi uchun), `last_unit_cost` (`sqliteMoney nullable`), `updated_at_ms`.
   - `local_batch_balances`: `store_id`, `batch_id` (unique), `product_id`, `variant_id`, `hlc` (FIFO tartib tezligi uchun), `remaining_qty` (`sqliteQuantity >= 0`), `remaining_value` (`sqliteMoney >= 0`).

6. **`unlimited` va birlik siyosati:**
   - `product.unlimited === true` mahsulotlarda qoldiq yuritilmaydi; ombor kirim/chiqim/inventarizatsiya harakatlari `DomainError('UNLIMITED_PRODUCT_STOCK_NOT_TRACKED')` qaytaradi. T1.4 savdoda `unlimited` qatorlar `stock_moves` yaratmaydi va qoldiq tekshiruvidan ozod bo'ladi.
   - Har harakatda `abs(qty_delta)` T1.1 `validateQuantityForUnit(product.unit, absQty)` orqali tekshiriladi (`dona`/`qadoq` kasrsiz; `kg`/`litr` 0.001 aniqlikda).

7. **Manfiy qoldiq siyosati konfiguratsiyasi:**
   - `local_hub_config` ga `negative_stock_policy` (`'warn' | 'block'`, default `'warn'`) qo'shiladi (`F2` da sinxron do'kon sozlamasiga ko'tariladi).

---

### b) Tannarx aniqligi: tiyin yo'qolmasligi (`packages/domain/src/stock.ts`)

- Birlik narxini ko'paytirib yaxlitlash qoldig'ini yo'qotmaslik uchun har bir partiya va o'rtacha havza **`remaining_qty` + `remaining_value`** (tiyin) saqlaydi:
  - Qisman chiqim (`takeQty < remQty`):
    `takeVal = divideRoundHalfAwayFromZero(remVal * takeQty, remQty)`
    Yangi qoldiq: `remQty' = remQty - takeQty`, `remVal' = remVal - takeVal`.
  - Oxirgi chiqim (`takeQty === remQty`):
    **`takeVal = remVal`** (qolgan barcha tiyinlar oxirgi birliklar bilan chiqadi).
- **FIFO (`track_batches = true`):** eng eski aktiv partiyalar (`remaining_qty > 0`, tartib `hlc ASC, id ASC`) ketma-ket yechiladi; bitta chiqim bir nechta partiyani ishlatsa har partiya bo'yicha alohida `stock_moves` satri (aniq `batch_id`, `qty_delta`, `cost_value_delta`) yoziladi.
- **O'rtacha tannarx (`track_batches = false`):** xuddi shu formula mahsulotning `(qty_on_hand, total_value)` qoldig'iga qo'llanadi.
- **Invariant (`fast-check` property test):** Har partiya va har mahsulot uchun:
  `SUM(kirim qiymatlari) === SUM(chiqim qiymatlari) + qoldiq_qiymat + cost_variance_value`
  Musbat qoldiqli barcha ketma-ketliklarda `cost_variance_value === 0n` va `SUM(kirim) === SUM(chiqim) + qoldiq_qiymat` tiyinigacha teng.

---

### c) Manfiy qoldiq siyosati va qo'lda hisoblangan misollar

- **Siyosat va standart qiymat:**
  - `negative_stock_policy` `local_hub_config` da saqlanadi; standart qiymati **`'warn'`** (GEMINI.md 3.2: savdo to'xtamasligi uchun).
  - `'warn'` rejimida qoldiq 0 dan pastga tushsa harakat bajariladi va natijada `{ warnings: [{ code: 'NEGATIVE_STOCK', ... }] }` qaytariladi.
  - `'block'` rejimida (yoki so'rov explicit `policy: 'block'` ko'rsatsa) `qty > available` bo'lganda tranzaksiya to'liq rollback qilinadi (`409 INSUFFICIENT_STOCK`).
- **Manfiy qoldiqda FIFO va O'rtacha tannarx ("partiyasiz kamomad" + keyingi kirim yopishi):**
  1. Mavjud musbat qoldiq/partiyalar avval 0 gacha aniq yechiladi.
  2. Yetmagan `deficitStep` qismi uchun `stock_moves` ga `batch_id = NULL` ("partiyasiz kamomad") yoziladi; chiqim qiymati snapshot'i oxirgi ma'lum birlik tannarxi (`last_unit_cost ?? 0n`) asosida `multiply(last_unit_cost, deficitStep)` qilib olinadi (`provisional_deficit_value += provisionalCost`, `deficit_qty += deficitStep`).
  3. Keyingi kirim (`+inQty`, `+inVal`) kelganda avval `coverQty = min(inQty, deficit_qty)` kamomadni yopadi (`coverVal = coverQty === inQty ? inVal : divideRoundHalfAwayFromZero(inVal * coverQty, inQty)`):
     - **FIFO da:** yangi partiyadan faqat qolgan `netQty = inQty - coverQty`, `netVal = inVal - coverVal` `local_batch_balances` ga tushadi (`netQty = 0` bo'lsa partiya darhol tugagan hisoblanadi).
     - **O'rtacha da:** `(qty_on_hand, total_value)` ga faqat `netQty`, `netVal` qo'shiladi (`qty_on_hand` kamomaddan keyingi musbat/nol holatga o'tadi).
     - `provisional_portion` va `coverVal` orasidagi farq (`coverVal - provisional_portion`) `cost_variance_value` ga yig'iladi; oldingi `stock_moves` snapshot'i o'zgartirilmaydi.

- **Qo'lda hisoblangan misollar:**
  - **1-misol (FIFO manfiy → keyingi kirim):**
    1. Partiya A kirim: `+2 dona`, `20 000` tiyin (`last_unit_cost = 10 000`). Qoldiq: `qty = 2`, `val = 20 000`.
    2. Savdo chiqim: `-5 dona` (`warn`): Partiya A to'liq chiqadi (`2 dona = 20 000` tiyin); kamomad `3 dona` (`batch_id = NULL`, taxminiy `3 × 10 000 = 30 000`). Jami savdo snapshot = `-50 000` tiyin. Proyeksiya: `qty = -3`, `val = 0`, `deficit_qty = 3`, `provisional_deficit_value = 30 000`.
    3. Partiya B kirim: `+5 dona`, `60 000` tiyin (`12 000/dona`). Kamomad yopish: `coverQty = 3`, `coverVal = divide(60 000 × 3, 5) = 36 000` tiyin. Partiya B qoldig'i: `2 dona`, `60 000 - 36 000 = 24 000` tiyin. Farq `cost_variance_value = 36 000 - 30 000 = +6 000` tiyin. Tekshiruv: `kirim (20 000 + 60 000 = 80 000) === chiqim (50 000) + qoldiq (24 000) + farq (6 000) = 80 000`.
  - **2-misol (O'rtacha tannarx, bo'linmas tiyin qoldig'i):**
    1. Kirim: `+3 kg`, `10 000` tiyin (`3 333.33...` tiyin/kg). Proyeksiya: `qty = 3000`, `val = 10 000`.
    2. Chiqim `-1 kg` (`1000`): `takeVal = round(10 000 × 1000 / 3000) = 3 333`. Qoldiq: `qty = 2000`, `val = 6 667`.
    3. Chiqim `-2 kg` (`2000`, oxirgi qism): **`takeVal = 6 667`** (qolgan barcha tiyin). Qoldiq: `0`, `0`. Tekshiruv: `3 333 + 6 667 = 10 000`.

---

### d) Tartib va sinxron (`HLC`)

- **Qayta qurish tartibi:** `rebuildStockProjections()` barcha `batches` va `stock_moves` yozuvlarini qat'iy **`(hlc ASC, id ASC)`** tartibida qayta ijro etadi — shu sababli barcha qurilmalarda bir xil deterministik natija chiqadi.
- **Snapshot o'zgarmasligi:** Allaqachon yozilgan `stock_moves.cost_value_delta` (`FACT`) hamda kelajakdagi `sale_line` tannarx snapshot'lari kechikkan sinxron hodisa kelganda ham **hech qachon tahrirlanmaydi**.
- **Farq hisobga olinishi:** Kechikkan sinxron kirim (yoki chiqim) HLC tartibida o'tmishga tushib qayta qurilganda, haqiqiy qayta hisoblangan zaxira qiymati va oldin snapshotted bo'lgan harakatlar qiymati orasidagi farq **`local_stock_balances.cost_variance_value`** ustunida aks etadi. Natijada zaxira qoldig'i va partiya qoldig'i har doim ledger yig'indisiga, umumiy qiymat tenglamasi esa tiyinigacha muvozanatda qoladi.

---

### e) Inventarizatsiya

- `startInventoryCount`: bitta UoW da `inventory_counts` (`status: 'open'`) va har mahsulot uchun hozirgi `local_stock_balances.qty_on_hand` dan **`expected_qty_at_start`** snapshot'ini yozadi.
- Sanoq davomida kassa savdolari va oddiy harakatlar to'sqinliksiz davom etadi.
- `finalizeInventoryCount`: bitta UoW da har sanalgan qator uchun:
  **`adjustment = counted_qty - expected_qty_at_start`**
  Agar `adjustment <> 0n` bo'lsa `reason: 'inventory'`, `source_type: 'inventory_count'`, `source_id: count.id` bilan `stock_moves` (va musbat FIFO farqida partiya) yoziladi; `inventory_counts.status = 'finalized'` qilinadi (MONOTONE trigger qayta yakunlashni bloklaydi).
- **Test:** `10 dona` qoldiq bilan sanoq ochiladi (`expected_qty_at_start = 10`), sanoq paytida `2 dona` savdo bo'ladi (qoldiq `8`), sanoqda `9` sanalsa `adjustment = 9 - 10 = -1` -> yakuniy qoldiq `10 - 2 - 1 = 7` chiqishi tekshiriladi.

---

### f) Hub API va RBAC (`packages/contracts`, `packages/domain`, `apps/hub`)

- **Ruxsatlar (`HubPermission`):**
  - `'stock:read'` → `owner`, `manager`, `cashier`
  - `'stock:write'` → `owner`, `manager` (`cashier` ga YO'Q)
- **Tannarx himoyasi (`GEMINI.md` 3.4):**
  - `GET /stock/balances` (`stock:read`): rolga ko'ra kassirga `CashierStockBalanceSchema` (faqat `productId`, `variantId`, `qtyOnHand`, `unlimited`, `minStock`, `isLowStock` — **`totalValue`/`unitCost`/`profit`/`costVariance` umuman yo'q**!), `owner`/`manager` ga ham alohida tannarx/qiymat endpointlari.
  - `GET /stock/valuation`, `GET /stock/batches`, `GET /stock/moves`, `POST /stock/moves/in`, `POST /stock/moves/out`, `POST /stock/projections/rebuild`, `/stock/inventory-counts/*` barchasi **`stock:write`** bilan himoyalangan — kassir **`403 AUTH_FORBIDDEN`** oladi.
  - API testida kassir javoblarida `costValue`, `totalValue`, `initialCostValue`, `unitCost`, `costVarianceValue`, `profit` kalitlari umuman yo'qligi qat'iy tekshiriladi.

---

### g) Qayta qurish (`rebuildStockProjections`)

- `rebuildStockProjections(connection, { organizationId, storeId })`: mutex ostida outbox hodisasiz `local_stock_balances` va `local_batch_balances` ni o'chirib, `batches` + `stock_moves` (`ORDER BY hlc ASC, id ASC`) asosida to'liq noldan tiklaydi.
- **`fast-check` property test:** tasodifiy kirim, partiyali FIFO chiqim, o'rtacha chiqim, qaytarish, manfiy qoldiq + yopish, inventarizatsiya va HLC bo'yicha tartibsiz yozuvlardan keyin oddiy mustaqil referens model bilan `qty_on_hand`, har partiya `remaining_qty`/`remaining_value` va mahsulot qiymati (ham jonli, ham `rebuildStockProjections()` dan keyin) aynan solishtiriladi.

---

### Takliflar va ochiq savollar

1. **`products.track_batches` va metod almashish qoidasi:** `products` jadvaliga `track_batches BOOLEAN DEFAULT false` ustunini qo'shish va mahsulot bo'yicha allaqachon `stock_moves` mavjud bo'lsa `track_batches` ni o'zgartirishni `409` bilan bloklash taklif etiladi. Tasdiqlaysizmi?
2. **`F1` da `warehouse_id` o'rniga `store_id`:** Bitta do'konda bitta ombor bo'lgani uchun `stock_moves` va `batches` da hozircha `store_id` (`tenantScope: 'store'`) bilan cheklanish, ko'p ombor (`warehouses` jadvali) ni `F5` ga qoldirish taklif etiladi. Tasdiqlaysizmi?
