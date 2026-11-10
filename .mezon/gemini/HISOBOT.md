## T0.7 Merge xulosasi (F0 yakuni)

- **PR #7** (`gemini/T0.7-electron-shell`, bosh SHA `fd07ecb5243291bf34b1fc4145b2c3f5e0af7b6e`, barcha 8 CI check run `success` — Run [#42819904716](https://github.com/Shaxobiddin-Github/Mezon/actions/runs/42819904716) va [#42819895783](https://github.com/Shaxobiddin-Github/Mezon/actions/runs/42819895783), artifact `mezon-desktop-win-x64-nsis`) `T0.7: Electron qobig'i va Windows o'rnatuvchi` nomi bilan Squash and merge qilindi.
- **Merge commit SHA (`main`):** `0b65a438f8de4bcf03a93b28eb8301066a54de73`
- **`gemini/T0.7-electron-shell` branch:** masofadan va lokaldan o'chirildi.
- **Yangi branch (`main` @ `0b65a43` dan):** `gemini/T1.1-catalog`

---

## Reja: T1.1 — Katalog

> **Eslatma:** Bu bosqichda faqat reja berilmoqda; Claude tasdig'isiz kod yozilmaydi.

### a) Ma'lumotlar bazasi jadvallari va sinflari (`packages/db-local`)

Barcha 5 ta katalog jadvali **`tenantScope: 'organization'`** bilan `localSchemaRegistry.defineTable(...)` orqali e'lon qilinadi (chunki katalog tashkilot darajasida umumiy; do'kon bo'yicha alohida narx F5'da qo'shiladi — hozirdan `organization` darajasi 50 000 mahsulotni har filialga nusxalamasdan yuritish imkonini beradi). Pul uchun `sqliteMoney`, miqdor uchun `sqliteQuantity`, `INTEGER` tekshiruvlari va T0.5 immutability triggerlari (`assertSqliteTriggersMigrationsComplete`) majburiy.

1. **`categories`** (`tableClass: 'ATTR'`):
   - Umumiy ATTR sinxron ustunlari (`id`, `organization_id`, `device_id`, `hlc`, `created_at_ms`, `updated_at_ms`, `deleted_at_ms`).
   - `name` (`text notNull`), `name_search` (`text notNull` — normalizatsiya qilingan qidiruv nomi).
   - `parent_id` (`sqliteUuidV7`, nullable — ierarxiya uchun; repo siklik `parent_id` zanjirini rad etadi).
   - `sort_order` (`sqliteInt notNull default 0`).
   - Indekslar: bir ota ostidagi faol kategoriyalar nomi noyobligi uchun partial unique indeks `(organization_id, COALESCE(parent_id, ''), name_search) WHERE deleted_at_ms IS NULL` (yoki root/child alohida partial index); ota bo'yicha indeks `(organization_id, parent_id) WHERE deleted_at_ms IS NULL`.
2. **`products`** (`tableClass: 'ATTR'`):
   - Umumiy ATTR sinxron ustunlari.
   - `category_id` (`sqliteUuidV7`, nullable — berilganda o'sha `organization_id` dagi faol kategoriya bo'lishi shart).
   - `sku` (`text`, nullable — normallashtirilgan artikul).
   - `name` (`text notNull`), `name_search` (`text notNull`).
   - `unit` (`text notNull`, SQL `CHECK (unit IN ('dona', 'kg', 'g', 'litr', 'metr', 'm2', 'qadoq'))`).
   - `unlimited` (`sqliteBoolean notNull default false` — xizmat va cheksiz tovarlar uchun).
   - `min_stock` (`sqliteQuantity`, nullable — `NULL` ogohlantirish yo'q; aks holda `>= 0n` va birlik qoidasi bo'yicha tekshiriladi).
   - `has_variants` (`sqliteBoolean notNull default false`).
   - `sale_price` (`sqliteMoney notNull`, SQL `CHECK (sale_price >= 0)`).
   - Fiskal maydonlar hozirdan (`GEMINI.md` 8-bo'lim): `mxik` (`text`, nullable), `package_code` (`text`, nullable), `vat_rate_bp` (`sqliteInt notNull default 0`, `CHECK (vat_rate_bp >= 0 AND vat_rate_bp <= 10000)` — `VatRate` basis points).
   - Indekslar: `uidx_products_org_sku` (`(organization_id, sku) WHERE sku IS NOT NULL AND deleted_at_ms IS NULL`), `idx_products_org_name_search` (`(organization_id, name_search, id) WHERE deleted_at_ms IS NULL`), `idx_products_org_category` (`(organization_id, category_id) WHERE deleted_at_ms IS NULL`).
3. **`product_variants`** (`tableClass: 'ATTR'`):
   - Umumiy ATTR sinxron ustunlari.
   - `product_id` (`sqliteUuidV7 notNull`, `products.id` ga tegishli va o'sha `organization_id` da).
   - `name` (`text notNull`), `name_search` (`text notNull`).
   - `sku` (`text`, nullable).
   - `attributes_json` (`text notNull` — kanonik saralangan JSON atributlar ob'ekti, masalan `{"olcham":"XL","rang":"qora"}`).
   - `sale_price` (`sqliteMoney`, nullable — `NULL` bo'lsa ota mahsulot `sale_price` ni meros oladi; belgilansa `>= 0`).
   - Indekslar: `(organization_id, product_id) WHERE deleted_at_ms IS NULL` va `uidx_product_variants_org_sku` (`(organization_id, sku) WHERE sku IS NOT NULL AND deleted_at_ms IS NULL`).
4. **`product_barcodes`** (`tableClass: 'ATTR'`):
   - Umumiy ATTR sinxron ustunlari.
   - `product_id` (`sqliteUuidV7 notNull`), `variant_id` (`sqliteUuidV7`, nullable — berilganda o'sha `product_id` va `organization_id` dagi faol variant bo'lishi shart).
   - `barcode` (`text notNull` — normallashtirilgan shtrix-kod).
   - `format` (`text notNull`, `CHECK (format IN ('ean13', 'ean8', 'upca', 'internal', 'other'))`).
   - **Noyoblik va tezkor skan indeksi:** `UNIQUE INDEX uidx_product_barcodes_org_barcode ON product_barcodes(organization_id, barcode) WHERE deleted_at_ms IS NULL` — tashkilot ichida faol bitta shtrix-kod faqat bitta mahsulot/variant yozuviga bog'lanishini ham kafolatlaydi, ham 70 000 qator ichidan `O(log N)` (< 1–2 ms) da topadi.
5. **`price_changes`** (`tableClass: 'FACT'`):
   - Umumiy FACT sinxron ustunlari (`id`, `organization_id`, `device_id`, `hlc`, `created_at_ms`).
   - `product_id` (`sqliteUuidV7 notNull`), `variant_id` (`sqliteUuidV7`, nullable).
   - `old_price` (`sqliteMoney`, nullable — yangi mahsulot/variant ochilganda `NULL`, narx tahririda avvalgi `Money`).
   - `new_price` (`sqliteMoney notNull`, SQL `CHECK (new_price >= 0)`).
   - `changed_by_user_id` (`sqliteUuidV7 notNull`).
   - `reason` (`text`, nullable).
   - Indeks: `(organization_id, product_id, created_at_ms)` tarix so'rovlari uchun.
   - **Atomik yozish:** Narx belgilash/o'zgartirish (`createProduct`, `updateProduct` narx o'zgarganda, `createVariant`, `updateVariant` narx o'zgarganda) bitta UoW tranzaksiyasida ATTR (`insertAttr`/`updateAttr`) bilan birga `insertFact` orqali `price_changes` + outbox'ga yozadi.

**Sinov jadvallari emas, haqiqiy migratsiya:** `packages/db-local/drizzle/0003_catalog.sql` + `db:check` (0 diff) + barcha 5 jadvalga immutability triggerlari.

---

### b) Birlik va miqdor qoidasi (`packages/domain`)

- Birliklar (`PRODUCT_UNITS`): `'dona' | 'kg' | 'g' | 'litr' | 'metr' | 'm2' | 'qadoq'`.
- `packages/domain/src/catalog.ts` da sof funksiya `validateQuantityForUnit(unit, quantity, { allowZero? })`:
  - `dona` va `qadoq` uchun `quantityToMilli(quantity) % 1000n === 0n` bo'lishi shart (kasr bo'lsa `DomainError('INVALID_UNIT_QUANTITY')`).
  - `kg`, `g`, `litr`, `metr`, `m2` uchun 0.001 (`1n` milli) aniqlik ruxsat etiladi (`>= 1n`, yoki `min_stock` uchun `allowZero: true` bilan `>= 0n`).
- Fast-check property testi: `dona`/`qadoq` uchun `1000n` ga karrali bo'lmagan har qanday qiymat doim xato tashlashi, `k * 1000n` esa qabul qilinishi; kasr birliklarda `>= 1n` doim qabul qilinishi tekshiriladi.

---

### c) Shtrix-kod (`packages/domain` + `packages/db-local`)

- **Normalizatsiya (`normalizeBarcode`):** bosh va oxirgi bo'shliqlar, tab/yangi qatorlar olib tashlanadi; ichki bo'shliqlar olib tashlanadi. Ruxsat etilgan belgilar: `^[A-Za-z0-9._-]+$`, uzunlik `1..64`. Aks holda `DomainError('INVALID_BARCODE')`.
- **Nazorat raqami (`verifyGs1CheckDigit`) va rad etish/ogohlantirish tanlovi:**
  - `EAN-13` (13 raqam), `EAN-8` (8 raqam), `UPC-A` (12 raqam) uchun GS1 Modulo-10 nazorat raqami sof domen funksiyasi bilan tekshiriladi.
  - **Tanlov (Rad etish, lekin `internal`/`other` istisnosi bilan):** Ro'yxatdan o'tkazishda `format` GS1 (`ean13`, `ean8`, `upca`) bo'lsa (yoki 8/12/13 raqamli kodda format aniq `'internal'`/`'other'` deb belgilanmagan bo'lsa), noto'g'ri nazorat raqami **qat'iy rad etiladi (`DomainError('INVALID_BARCODE_CHECK_DIGIT')`)** — chunki xato nazorat raqami import/kiritish xatosi bo'lib, saqlansa skaner kassada hech qachon tovarni topa olmaydi. Do'kon o'zining GS1 bo'lmagan ichki raqamli kodini saqlamoqchi bo'lsa `format: 'internal'` (yoki `'other'`) ko'rsatadi — bu holda nazorat raqami tekshirilmaydi.
- **Noyoblik:** Tashkilot ichida faol shtrix-kodlar orasida `UNIQUE(organization_id, barcode) WHERE deleted_at_ms IS NULL`; o'chirilgan (tombstone) shtrix-kod qayta ishlatilishi mumkin.
- **Tarozi yorlig'iga tayyor skan qidiruv natijasi:** `scanCatalogBarcode` natijasi `{ product, variant, barcode, quantity }` shaklida qaytariladi (`T1.1` da `quantity: null`, `T5.8` da `2x` tarozi prefiksidan ajratilgan og'irlik/miqdor to'ldiriladi).

---

### d) Nom bo'yicha qidiruv (`packages/domain` + `packages/db-local`)

- **O'zbek tili normalizatsiyasi (`normalizeCatalogSearchText`, `packages/domain` da sof funksiya):**
  1. Unicode NFC normalizatsiya va kichik harfga o'tkazish (`toLowerCase()`).
  2. Kirill → Lotin transliteratsiyasi (`ў → o'`, `ғ → g'`, `қ → q`, `ҳ → h`, `ш → sh`, `ч → ch`, `щ → shch`, `ё → yo`, `ю → yu`, `я → ya`, `е` so'z boshida/unlidan keyin `ye`, aks holda `e`, `ц → s`, `ж → j` va h.k.).
  3. Barcha apostrof variantlarini (`'`, `ʻ`, `ʼ`, `‘`, `’`, `` ` ``, `´`, `ˈ`) birxillashtirish va qidiruv indeksi kalitida apostrofsiz kanonikal ko'rinishga keltirish (`"O'rik"` / `"oʻrik"` / `"ўрик"` / `"orik"` → `"orik"`, `"G'ijduvon"` / `"ғиждувон"` / `"gijduvon"` → `"gijduvon"`), chunki tezkor kassa qidiruvida kassir ko'pincha apostrof belgisini termaydi. Asl `name` maydoni o'zgartirilmay saqlanadi.
  4. Ortiqcha bo'shliqlarni bitta bo'shliqqa siqish va `trim()`.
- **SQLite FTS5 + Trigger sinxronizatsiyasi:**
  - `better-sqlite3@13.0.3` da **FTS5 (`unicode61` va `trigram`) kompilyatsiya qilinganligi amalda tekshirildi**.
  - **Tanlov:** `products_fts` virtual jadvali (`USING fts5(name_search, sku_search, content='', tokenize='unicode61 remove_diacritics 0', prefix='2 3')` yoki `rowid` bog'langan external-content FTS5) hamda `products` ga `AFTER INSERT` / `AFTER UPDATE` triggerlari (`deleted_at_ms IS NULL` faol qatorlarni FTS5 da tutadi, tombstone qilinganlarni FTS5 dan o'chiradi). Variant SKU/nomi bo'yicha ham qidirish uchun variantlar soni kichik/indekslangan `product_variants(organization_id, name_search)` yoki `products_fts` bilan birlashtiriladi.
  - **Asos:** `LIKE '%...%'` 50 000 qatorda to'liq skan (~50–120 ms) beradi; oddiy B-tree `LIKE 'abc%'` esa ikkinchi so'zni (`"Coca Cola Zero"` → `"zero"`) topa olmaydi. `FTS5 unicode61` (`prefix='2 3'`) ko'p so'zli nomlarning istalgan so'zidan 2+ belgili prefiks qidiruvini ~1–5 ms da bajaradi; 1 belgili so'rovda `idx_products_org_name_search` ustida `name_search LIKE 'a%'` B-tree indeksi ishlaydi. Barcha so'rovlarda `products.organization_id = ? AND products.deleted_at_ms IS NULL` filtri majburiy.

---

### e) Hub API va RBAC (`packages/contracts`, `packages/domain`, `apps/hub`)

- `packages/domain/src/auth.ts` dagi `HubPermission`:
  - `'catalog:read'` → `owner`, `manager`, `cashier`
  - `'catalog:write'` → `owner`, `manager`
- **Endpointlar (`apps/hub`):**
  - Kategoriyalar (`catalog:read` / `catalog:write`): `GET /categories`, `POST /categories`, `PATCH /categories/:id`, `DELETE /categories/:id` (tombstone; faol bola kategoriya yoki faol mahsulot bog'langan bo'lsa rad etiladi).
  - Mahsulotlar (`catalog:read` / `catalog:write`): `GET /products` (`q`, `categoryId`, `limit`, `offset`), `GET /products/:id`, `POST /products`, `PATCH /products/:id`, `DELETE /products/:id` (tombstone: mahsulot, variantlar va shtrix-kodlar bitta UoW da yopiladi).
  - Variantlar va shtrix-kodlar (`catalog:write`): `POST /products/:id/variants`, `PATCH /products/:id/variants/:variantId`, `DELETE /products/:id/variants/:variantId`, `POST /products/:id/barcodes`, `DELETE /products/:id/barcodes/:barcodeId`.
  - Narx tarixi (`catalog:read` yoki `catalog:write` — faqat sotish narxi tarixi, tannarx yo'q): `GET /products/:id/price-changes`.
  - Skan qidiruvi (`catalog:read` — kassir ham foydalanadi): `GET /catalog/scan?code=...` → `{ product, variant, barcode, quantity }` yoki `404`.
- `@mezon/contracts`: qat'iy Zod (`strictObject`) sxemalari; pul va miqdor JSON da `BigIntStringSchema` satr ko'rinishida.
- **Tannarx himoyasi (`GEMINI.md` 3.4):** Katalogda `cost_price` ustuni yo'q (T1.2 partiyada bo'ladi), ammo javob DTO larida aniq maydon ro'yxatli mapper (`toProductDto`) ishlatiladi va kassir javobida tannarx/foyda maydonlari bo'lmasligi test bilan tekshiriladi.

---

### f) Unumdorlik testi (`packages/db-local` / `apps/hub`)

- Vaqtinchalik diskdagi SQLite WAL bazaga **50 000 ta mahsulot** (lotin + kirill aralash nomlar, kategoriyalar, variantlar bilan) va **70 000 ta shtrix-kod** urug'lanadi (seed).
- 200+ shtrix-kod skani va 100+ turli o'zbekcha (lotin/kirill/apostrof) nom qidiruvi bo'yicha `p50` va `p95` kechikishlari `performance.now()` bilan o'lchanib natijalar hisobotga yoziladi.
- **CI chegaralari:** Mahalliy maqsad: skan `p95 ≤ 20 ms`, nom qidiruvi `p95 ≤ 50 ms`. Sekin CI VM larda regressiyani ushlash bilan birga yolg'on yiqilish bo'lmasligi uchun testda real disk WAL da: skan `p95 ≤ 20 ms` va qidiruv `p95 ≤ 50 ms` (yoki CI yuklamasi uchun aniq asoslangan `p95` chegarasi, o'lchov paytida haqiqiy ms lar qayd etiladi).

---

### g) Doiradan tashqari

- Ombor harakatlari, partiyalar, FIFO/o'rtacha tannarx va inventarizatsiya (`T1.2`).
- Savat, aksiyalar va chegirmalar (`T1.3`).
- Tarozi `2x` shtrix-kod parsinki (`T5.8`).
- Do'konlar bo'yicha alohida narxlar (`F5`).
- Kassa va katalog UI (`T1.11`).

---

### Takliflar va ochiq savollar

1. **T1.1 uchun `category_id` bo'yicha o'chirish siyosati:** Faol mahsulot yoki bola kategoriyasi bor kategoriyani `DELETE` (tombstone) qilishni `409 CATEGORY_IN_USE` bilan bloklash taklif etiladi (aks holda yetim kategoriya havolalari paydo bo'ladi). Tasdiqlaysizmi?
2. **Narx o'zgarish tarixi (`GET /products/:id/price-changes`) ruxsati:** Sotish narxi tarixi (tannarxsiz) kassirga ham ko'rinishi kerakmi (`catalog:read`) yoki faqat `owner`/`manager` (`catalog:write`) gami? (`catalog:write` qilib cheklash xavfsizroq, kassirga faqat joriy narx kerak.)
