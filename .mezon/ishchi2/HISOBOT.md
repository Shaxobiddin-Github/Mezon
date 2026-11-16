# Hisobot: T3.1 — MXIK va soliq sozlamalari (lokal qism)

Branch / PR: `ishchi2/T3.1-mxik` / https://github.com/Shaxobiddin-Github/Mezon/pull/24
Kod commit: `ba0f53a` (T3.1: MXIK va soliq sozlamalari). Asos: `main` = `12072ea`, `[claude]` `28dc80b`.
Bajaruvchi: ishchi2.
Holat: **lokal qism tayyor.** Bulut jufti (S1) T2.3 `main` ga tushgach alohida commit bilan qo'shiladi, nazoratchi ko'rsatmasi shunday.

---

## Nima qilindi

### 1. Tashkilot soliq profili
- **Jadval:** `organization_tax_profiles`. Sinf ATTR, tenant doirasi organization.
- **Ustunlar:**
  - `tin`: CHECK 9 ta raqam;
  - `legal_name`, `legal_address`: CHECK bo'sh emas;
  - `is_vat_payer`;
  - `default_vat_rate_bp`: CHECK 0..10000;
  - `updated_by_user_id`: FK → `users` (T3).
- **T1:** CHECK `id = organization_id`. Repo `insertAttr` ga `entityId: organizationId` beradi. Buning uchun `writers.ts` dagi `InsertEntityOptions` ga ixtiyoriy `entityId` qo'shildi.
- **Yozuv:** `UnitOfWork` ichida, outbox'dagi ATTR hodisasi bilan birga:
  - `organization_tax_profile.created`;
  - `organization_tax_profile.updated`.
  - Payload'da `updatedByUserId` bor (T3).
- **Trigger:** `BEFORE DELETE` jismoniy o'chirishni taqiqlaydi (ATTR qoidasi).
- **API** (`apps/hub/src/tax-settings-routes.ts`):

  | Endpoint | Ruxsat |
  |---|---|
  | `GET /settings/tax` | `tax:read` |
  | `PUT /settings/tax` | `tax:write` |

  - Ruxsatlar faqat owner va manager'da, kassir 403 oladi.
  - Profil hali yo'q bo'lsa, javob `{ profile: null }`.

### 2. QQS to'lovchisi bo'lmagan tashkilot (S2, T2)
- Domen'da `effectiveVatRate(rate, isVatPayer)` bor. Uning bp ko'rinishi `effectiveVatRateBp` db-local'da, chunki domen'da `Number` lint bilan taqiqlangan.
- U faqat **yangi** qator snapshot'larida qo'llanadi:
  - savatdagi katalog qatori;
  - tez savdo qatori (`quick_sale_default_vat_rate_bp` ham shu funksiyadan o'tadi);
  - buyurtma qatori (katalog va tez savdo).
- Buyurtmadan sotuvga o'tishda stavka buyurtma qatorining snapshot'idan olinadi, qayta hisoblanmaydi.
- Mahsulotning o'z `vat_rate_bp` qiymati o'zgarmaydi.
- Chekdagi matn T3.4 ga qoldi, printer joylashuvi o'zgartirilmadi.

### 3. Mahsulot formasi (POS)
- Fayl: `apps/pos/src/components/CatalogScreen.tsx`. Yuqori paneldagi "Mahsulotlar" tugmasi faqat owner va manager'ga ko'rinadi.
- Mahsulotlar ro'yxati qidiruv bilan.
- Yaratish va tahrirlash formasi: nom, birlik, narx, MXIK, qadoq kodi, QQS %.
  - Validatsiya contracts'dagi `MxikSchema`, `PackageCodeSchema` va `VatRateBpSchema` bilan, takror kod yo'q.
  - QQS foizi float'siz parse qilinadi: `@mezon/ui` dagi `parseSomInputToTiyinString` ishlatiladi, chunki 2 kasrli foizning masshtabi tiyin bilan bir xil.
- "Soliq sozlamalari" tabi: STIR, yuridik nom, manzil, QQS to'lovchisi belgisi, standart stavka.
- Yangi mahsulotda QQS maydoni tashkilotning standart stavkasi bilan to'ldiriladi.

### 4. Excel (S4)
- **Ustunlar:** import va eksport `CATALOG_SHEET_COLUMNS` ni birgalikda ishlatadi: Nomi, SKU, Shtrix-kod, Birlik, Narx, Min. zaxira, MXIK, Qadoq kodi, QQS (%).
- **Eksportdagi topilmalar tuzatildi:**
  - shtrix-kod ustuni yo'q edi;
  - narx `/ 100n` bilan **butun so'mgacha kesilardi** (tiyin yo'qolardi). Endi aniq o'nlik satr yoziladi.
- **Float'siz parse:** narx, `minStock` va QQS domen'dagi `parseMoneyDecimal` va `parseQuantityDecimal` orqali o'qiladi. Ulardan oldin faqat normalizatsiya bor: bo'shliqlar, NBSP va o'nlik vergul. `parseFloat` olib tashlandi.
- **Qator darajasidagi xatolar:** `errorCode` bor (`excelImport.error.*`, i18n). Preview javobida yangi ixtiyoriy `code` maydoni bor. Noto'g'ri qator importni yiqitmaydi.
- **Bo'sh QQS katagi:** tashkilotning standart stavkasi olinadi, profil bo'lmasa 0.
- **Preview va commit:** `mxik`, `packageCode` va `vatRateBp` olib o'tiladi.

### 5. MXIK'siz mahsulotlar
- `GET /products?missingMxik=true`: `q` va `categoryId` bilan ishlaydi.
- `GET /products/missing-mxik/count`.
- Partial indeks `idx_products_org_missing_mxik`.
- POS'da sariq ogohlantirish va filtr bor. Savdo bloklanmaydi.

### 6. i18n
Yangi kalitlar: `catalog.*`, `taxSettings.*`, `excelImport.error.*` (`packages/i18n/src/locales/uz-Latn.ts`).

---

## O'zgargan fayllar (fayl — sabab)

**Domen va contracts**

| Fayl | Sabab |
|---|---|
| `packages/domain/src/vat.ts`, `index.ts` | `effectiveVatRate` |
| `packages/domain/src/auth.ts` | `tax:read`, `tax:write` (owner, manager) |
| `packages/contracts/src/tax-settings.ts` (yangi), `index.ts` | `TinSchema`, profil DTO, `MissingMxikCount` |
| `packages/contracts/src/catalog.ts` | `ListProductsQuerySchema.missingMxik` |
| `packages/contracts/src/reports.ts` | Preview qatoriga `mxik`, `packageCode`, `vatRateBp`; xatoga `code` |

**DB (db-local)**

| Fayl | Sabab |
|---|---|
| `schema/index.ts` | Jadval va partial indeks |
| `drizzle/0015_org_tax_mxik.sql`, `meta/0015_snapshot.json`, `meta/_journal.json` | Migratsiya |
| `tax-settings-repo.ts` (yangi) | Store, `readEffectiveVatSettingsSync`, `effectiveVatRateBp` |
| `writers.ts` | Ixtiyoriy `entityId` |
| `cart-repo.ts`, `order-repo.ts` | Effektiv stavka yangi qatorlarda |
| `catalog-repo.ts` | `missingMxik` filtri, sanoq, eksport uchun shtrix-kodlar |
| `index.ts` | Eksportlar |

**Hub**

| Fayl | Sabab |
|---|---|
| `tax-settings-routes.ts` (yangi), `routes.ts`, `server.ts` | API va ulash |
| `catalog-routes.ts`, `catalog-service.ts` | Sanoq endpoint'i |
| `excel-port.ts`, `catalog-import-routes.ts` | Fiskal ustunlar, float'siz parse, aylanma |

**POS va i18n**

| Fayl | Sabab |
|---|---|
| `components/CatalogScreen.tsx` (yangi) | UI |
| `App.tsx`, `App.css`, `store/pos-store.ts` | `catalog` modali va tugma |
| `api/hub-client.ts` | Yangi metodlar |
| `packages/i18n/src/locales/uz-Latn.ts` | Matnlar |

**Testlar**
- Yangi: `packages/domain/src/vat.test.ts`, `packages/contracts/src/tax-settings.test.ts`, `packages/db-local/src/tax-settings.test.ts`, `apps/hub/src/tax-snapshot.test.ts`, `apps/hub/src/excel-port.test.ts`.
- Yangilangan: `catalog.perf.test.ts` (MXIK'siz o'lchovi), `index.test.ts` (registry ro'yxati va migratsiyalar soni 15 → 16), `reports.test.ts` (fixture'ga yangi majburiy maydonlar).

Yangi kutubxona qo'shilmadi. Tegilmagan fayllar: `apps/cloud/**`, `packages/db-cloud/**`, `apps/hub/src/sync*`, `packages/contracts/src/sync.ts`, `.mezon/claude/*`, `.mezon/gemini/*`.

## Migratsiyalar

`0015_org_tax_mxik.sql`:
- `CREATE TABLE organization_tax_profiles`. Unda CHECK'lar bor, shu jumladan `id = organization_id` va STIR.
- UNIQUE `(organization_id) WHERE deleted_at_ms IS NULL`.
- Partial indeks `idx_products_org_missing_mxik`.
- `trg_organization_tax_profiles_no_delete`.

`db:check`: "SQLite schema matches committed migrations (0 diff statements)".

`origin/main` hali `12072ea` da (oxirgi migratsiya `0014`), shuning uchun `0015` bo'sh. Gemini'ning `0015_sync_conflicts` migratsiyasi oldin tushsa, merge'dan oldin rebase qilaman, migratsiyani `0016` ga ko'chiraman va jurnalni qayta yarataman.

---

## Qabul mezonlari

- [x] **Chek snapshot'i keyingi tahrirdan ta'sirlanmaydi.** Test: `apps/hub/src/tax-snapshot.test.ts` → "sale detail, reprint, return, reports, order→sale and open cart keep old name/MXIK/VAT after product and profile edits". Chekdan keyin mahsulotning nomi, MXIK va QQS stavkasi **va** tashkilotning QQS to'lovchisi holati o'zgartiriladi. Keyin quyidagilar tekshiriladi:
  1. savdo detali (`saleStore.getSaleById`): eski nom, MXIK va 1200 bp, `totalVat` 120000;
  2. chekni qayta chop etish: `NUSXA` qatoridan tashqari matn asl chek bilan aynan bir xil, "YANGI" so'zi yo'q;
  3. kunlik hisobot: `totalVat` 120000;
  4. qaytarish: qatorda eski nom, MXIK, 1200 bp, `vatTotal` 120000;
  5. tahrirdan oldin yaratilgan buyurtma → `confirm` → `ready` → `deliver`: sotuv qatorida eski nom va 1200 bp;
  6. ochiq savatdagi mavjud qator o'zgarmaydi (T2).
- [x] **QQS yaxlitlash testlari.** Test: `packages/domain/src/vat.test.ts`, 25 ta test.
  - Chegara jadvali: 0; 1, 4 va 5 tiyin; 112; aniq yarim qiymatlar (14 → 2, 42 → 5); 0%; 100%; 2^53 dan katta summa; manfiy summalar.
  - Property testlar: `net + vat = gross`, `|vat| ≤ |gross|`, ishora simmetriyasi, monotonlik, `0% ⇒ 0`, xato ≤ 0.5 tiyin.
  - Ko'p qatorli chek, 12% + 0% va summa chegirmasi. Qo'lda hisoblangan: QQS 9643, net 80357.
  - Qator bo'yicha yaxlitlash hujjatlashtirildi: 3 × 14 tiyin → Σ 6, chek darajasida hisoblansa 5 bo'lardi.
  - QQS to'lovchisi bo'lmagan chek: `totalVat` 0.
  - Property: tasodifiy 0%/12% cheklar foiz chegirmasi bilan, Σ qator QQS = `totalVat`.
- [x] **T1 (deterministik id).**
  - "T1: two independent hubs of the same organization create the profile with the same entity id": ikki alohida SQLite bazasi, bir xil tashkilot, natijada `id` ikkalasida bir xil va `organization_id` ga teng.
  - "T1 + T3 …": `id = organization_id`, fizik jihatdan bitta qator.
  - db-local: CHECK `id ≠ organization_id` qatorni rad etadi.
- [x] **T2 (faqat yangi qatorlar).** Snapshot testining davomi:
  - savatdagi mavjud qator 1200 da qoladi;
  - yangi katalog qatori (p2) 0 oladi;
  - yangi tez savdo qatori (1200 so'ralgan) 0 oladi;
  - yangi savatdagi p1: yangi nom, 0;
  - mahsulotning o'z stavkasi 1500 da qoladi;
  - tashkilot qayta QQS to'lovchisiga aylansa, yangi qator 1500 oladi.
- [x] **T3 (kim o'zgartirgani).** "T1 + T3 …":
  - `updatedByUserId` avval manager, keyin owner;
  - outbox'da `created` va `updated` hodisalari, class ATTR, `entity_id = org`;
  - payload ichida tegishli foydalanuvchi id'si bor.
- [x] **RBAC.** "RBAC: cashier 403 on read and write; manager/owner can read and write". Autentifikatsiyasiz so'rov 401 oladi.
- [x] **STIR validatsiyasi.**
  - contracts: 8 va 10 raqam, harf, bo'shliq, bo'sh satr, arabcha raqamlar rad etiladi;
  - API: 400 qaytadi va hech narsa yozilmaydi (outbox 0);
  - DB CHECK.
- [x] **Rollback.** db-local: "a failed write rolls back the profile AND its outbox event; the next write succeeds". FK xatosi yoki `INVALID_TIN` bo'lsa, profil ham, outbox ham bo'sh qoladi. Keyingi yozuv normal ishlaydi.
- [x] **Excel qator xatolari (S4).** "invalid MXIK/VAT/price are row-level errors…":

  | Kiritilgan qiymat | Natija |
  |---|---|
  | `"1 500,50"` | 150050 tiyin |
  | raqamli katak `1500.5` | 150050 tiyin |
  | `"0.005"` | `invalidPrice` |
  | `0.1 + 0.2` (float artefakti) | `invalidPrice` |
  | `"-5"` | `invalidPrice` |
  | `"99999999999999999999"` | `invalidPrice` (int64 dan katta) |
  | `"abc"` | `invalidPrice` |
  | MXIK `"MXIK BOR!"` | `invalidMxik` |
  | QQS `"150"` | `invalidVat` |

  9 qatordan 2 tasi import qilindi. Bo'sh QQS katagi tashkilot standarti 1200 ni oldi. Parser'ning unit testlari `apps/hub/src/excel-port.test.ts` da.
- [x] **Excel aylanma.** "round trip: export → import preview yields identical …": nom, SKU, shtrix-kod, birlik, narx (tiyinigacha), `minStock`, MXIK, qadoq kodi va QQS bir xil chiqadi. Xatolar ro'yxati bo'sh.
- [x] **MXIK'siz ro'yxat.** "lists/counts only active products without MXIK …": sanoq 3; o'chirilgan mahsulot kirmaydi; `q=non` filtri ishlaydi; kassir o'qiy oladi; MXIK to'ldirilgach sanoq 2. Perf: 50 000 MXIK'siz mahsulotda (eng og'ir holat) sanoq, sahifa va filtr birgalikda p95 **117 ms**.

## Mutatsiya dalillari

Har mutatsiya bitta matnli o'zgarish. Skript tegishli testlarni ishga tushiradi va faylni qaytaradi. db-local yoki domen o'zgarsa, paket qayta build qilinadi, chunki hub ularni `dist` dan import qiladi. Natija: **16 tadan 16 tasi aniqlandi.**

| # | Mutatsiya | Natija | Yiqilgan test |
|---|---|---|---|
| M1 | Mahsulot tahriri mavjud `sale_lines` snapshot'ini qayta yozadi | aniqlandi | snapshot testi (tax-snapshot) |
| M2 | Qaytarish QQS'ni sotuv qatoridan emas, mahsulotdan oladi | aniqlandi | snapshot testi (qaytarish) |
| M3 | Yaxlitlash: `>=` → `>` (yarimda pastga) | aniqlandi | `vat.test` boundary: 14→2, 42→5, 100% 5→3, manfiy |
| M4 | Savat qator stavkasini e'tiborsiz qoldiradi | aniqlandi | `vat.test`: 12%+0% misol, 3×14, property |
| M5 | `effectiveVatRate` bayroqni e'tiborsiz qoldiradi | aniqlandi | `vat.test` (2), db-local `effectiveVatRateBp`, snapshot testi |
| M6 | Kassirga `tax:read` va `tax:write` beriladi | aniqlandi | RBAC testi |
| M7 | `TinSchema` 8–9 raqamni qabul qiladi | aniqlandi | contracts `TinSchema` |
| M8 | Migratsiyadagi STIR CHECK olib tashlanadi | aniqlandi | db-local DB CHECK testi |
| M9 | `entityId: organizationId` olib tashlanadi (tasodifiy id) | aniqlandi | 9 ta test, shu jumladan ikki hub va T1+T3 |
| M10 | Yangilashda `updated_by_user_id` eski qiymatda qoladi | aniqlandi | T1 + T3 testi |
| M11 | Excel'da noto'g'ri qator butun importni yiqitadi | aniqlandi | Excel qator xatolari testi |
| M12 | Eksportda MXIK va qadoq kodi ustunlari o'rni almashadi | aniqlandi | Excel aylanma testi |
| M13 | Narx `parseFloat × 100` bilan o'qiladi | aniqlandi | `excel-port.test` (money), Excel import testi |
| M14 | MXIK'siz ro'yxatda `mxik IS NULL` sharti olib tashlanadi | aniqlandi | MXIK'siz testi |
| M15 | Tez savdo qatori effektiv stavkani chetlab o'tadi | aniqlandi | snapshot/T2 testi (tez savdo 0) |
| M16 | Profil o'zgarishi savatdagi mavjud qatorlarni qayta yozadi | aniqlandi | snapshot/T2 testi (mavjud qator 1200) |

Shaffoflik uchun: birinchi ishga tushirishda M1 va M2 **omon qolgan** edi. Sababi testda emas, skriptda edi: ular db-local fayllarini o'zgartiradi, lekin skript db-local'ni qayta build qilmagan. Hub testlari esa `dist` dan o'qiydi, ya'ni buzilgan kod umuman ishga tushmagan. Skriptga `rebuild` qo'shildi va qayta ishga tushirilgach ikkalasi ham aniqlandi.

## Test natijasi (buyruq va haqiqiy chiqish)

`pnpm verify` (lokal, Docker yoqilgan, kod commit `ba0f53a`):
```
All matched files use Prettier code style!
build      Tasks:    17 successful, 17 total
typecheck  Tasks:    26 successful, 26 total
db:check   Tasks:    19 successful, 19 total
test:unit  Test Files  82 passed (82)   Tests  417 passed (417)
test:perf  Test Files  9 passed (9)     Tests  12 passed (12)
test:e2e   1 passed (9.6s)
depcruise  ✔ no dependency violations found (417 modules, 1786 dependencies cruised)
EXIT=0
```

- Boshlang'ich holatda 371 test bor edi. PG testlari endi skip bo'lmaydi: egasi Docker'ni o'rnatdi.
- Perf: `[T3.1 Perf 50k] missing-MXIK count+page+filter p95=117.224ms`. T1.1 skan p95 0.669 ms, qidiruv p95 28.4 ms.

**CI (PR #24):** _yakuniy holati quyida, "CI" bo'limida._

## Tekshirilmagan narsalar

- **Bulut jufti (S1):** `packages/db-cloud` jadvali, bulut migratsiyasi va `contracts/src/sync.ts` payload sxemasi hali yo'q. Nazoratchi ko'rsatmasi bo'yicha ular T2.3 `main` ga tushgach qo'shiladi.
- **POS UI:** `CatalogScreen` uchun Playwright E2E yozilmadi. UI typecheck va lint'dan o'tadi, mavjud E2E ham o'tadi. Formadagi validatsiya contracts sxemalarini ishlatadi va ular unit testlar bilan qoplangan. Ekranni qo'lda ochib ko'rmadim.
- **Chekdagi QQS matni** QQS to'lovchisi bo'lmagan tashkilot uchun ("QQSsiz" va hokazo) T3.4 ga qoldirildi.

## Qilingan taxminlar (nazoratchi ko'rib chiqsin)

1. **Profil yo'q bo'lsa,** tashkilot QQS to'lovchisi deb hisoblanadi va standart stavka 0 bo'ladi. Bu T3.1 dan oldingi xatti-harakatning aynan o'zi: mahsulot stavkasi o'zgarishsiz snapshot qilinadi.
2. **`POST /carts/:id/refresh-prices`** foydalanuvchining ochiq amali. U avvaldan narx va MXIK'ni katalogdan qayta o'qirdi, endi effektiv QQS stavkasini ham qayta qo'llaydi. Profilning o'zgarishi o'zi esa mavjud qatorlarga tegmaydi (T2), bu M16 bilan isbotlangan. Agar `refresh-prices` QQS'ga tegmasligi kerak bo'lsa, ayting.
3. **Eski sxemaga moslik:** `readEffectiveVatSettingsSync` jadval yo'q bo'lsa `DEFAULT_VAT_SETTINGS` ni qaytaradi. Bu jadval mavjudligini `sqlite_master` orqali tekshiradi va kesh ishlatmaydi. Sabab: mavjud `sale.test.ts` M1 testi bazani 0006 gacha migratsiya qiladi, savdolarni **joriy** savat kodi bilan yaratadi, keyin 0007 ga ko'taradi. Ya'ni savat yo'li eski sxemada ham ishlashi kerak va testni o'zgartirmadim. Production hub ishga tushishda doim oxirgi migratsiyagacha ko'tariladi. Bu holat test bilan qoplangan.
4. **Excel preview qatoridagi yangi maydonlar** `mxik`, `packageCode`, `vatRateBp` majburiy qilindi, chunki hub ularni doim qaytaradi. `reports.test.ts` fixture'i shunga moslab yangilandi va yangi tekshiruv qo'shildi. Xato qatoridagi `code` maydoni ixtiyoriy, eski klientlar buzilmaydi.
5. **Eksport hajmi:** eksport mavjud `listProducts({ limit: 5000 })` chegarasini saqlaydi. Bu chegarani o'zgartirmadim.

## Takliflar

- Mavjud hub xabarlari (masalan Excel import route'idagi xatolar) hali qattiq yozilgan o'zbekcha matnlar. Alohida vazifada kod va i18n ko'rinishiga o'tkazish mumkin.
- `CatalogScreen` uchun Playwright E2E (MXIK kiritish, MXIK'siz filtri, soliq sozlamalari). Buni T3.2 bilan birga qilish qulay bo'ladi.

## Egasi yoki nazoratchi qarori kerak bo'lgan savollar

- 2-taxmin (`refresh-prices` QQS'ni qayta qo'llashi) to'g'rimi?
- Bulut jufti (S1): T2.3 tushganini topshiriq orqali bildirasizmi? Shu ko'rsatmani kutyapman. Merge qilmayman.

## CI

PR #24 (run 43818551481). Hisobot yozilgan paytdagi holat:

| Job | Holat |
|---|---|
| Detect Desktop Changes | ✅ pass |
| Verify PostgreSQL RLS (ubuntu-latest) | ✅ pass (44s) |
| Verify (ubuntu-latest) | ⏳ ishlayapti |
| Verify (windows-latest) | ⏳ ishlayapti |
| Build & E2E Desktop Installer (windows-latest) | skip (desktop o'zgarmagan) |

Verify job'lari hisobot commit qilinganda hali tugamagan edi. Natijani shu PR'da ko'rasiz. Ulardan biri qizil bo'lsa, tuzataman va bu yerga yozaman.
