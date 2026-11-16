# Reja: T3.1 — MXIK va soliq sozlamalari

Branch: `ishchi2/T3.1-mxik` (asos `main` = `12072ea`, ustida `[claude]` `64b743a`)
Bajaruvchi: ishchi2
Holat: **REJA**. Kod yozilmagan, tasdiq kutilyapti.

O'qildi: `GEMINI.md` (to'liq, ayniqsa 3, 4, 5, 10 va 17-bo'limlar), `.mezon/ALOQA.md`, `.mezon/ISHCHI2.md`, `.mezon/claude/TOPSHIRIQ-ishchi2.md`. Ko'rib chiqilgan kod:
- `db-local/src/schema/index.ts`, `registry.ts`, `cart-repo.ts`, `return-repo.ts`, `report-repo.ts`;
- `contracts/src/catalog.ts`;
- `domain/src/vat.ts`, `rounding.ts`, `cart.ts`, `catalog.ts`, `auth.ts`;
- `hub/src/catalog-service.ts`, `excel-port.ts`, `catalog-import-routes.ts`, `printer-service.ts`;
- `drivers/src/printer/escpos-encoder.ts`;
- `apps/pos/src/components/*`, `packages/i18n`.

Gemini'ning tasdiqlangan T2.3 topshirig'ini faqat o'qidim (`origin/gemini/T2.3-sync-push`).

---

## 0. Boshlang'ich holat (sozlash va `pnpm verify`)

Muhit: Node 24.22.1, pnpm 12.18.0, git 2.54. Docker Desktop ishga tushmayapti: o'rnatma buzilgan, registry'da `SOFTWARE\Docker Inc.\Docker Desktop` kaliti yo'q. Shu sababli PG (Testcontainers) testlarini lokal ishga tushira olmayman. Bu testlar faqat `apps/cloud` va `packages/db-cloud` da, ya'ni Gemini yo'lagida. Ular CI'da tekshiriladi.

`pnpm verify` natijasi 0.1-bandda.

### 0.1. `pnpm verify` (boshlang'ich)

| Qadam | Natija |
|---|---|
| `format:check` | ✅ `All matched files use Prettier code style!` |
| `build` | ✅ `Tasks: 17 successful, 17 total` |
| `lint` | ✅ |
| `typecheck` | ✅ `Tasks: 26 successful, 26 total` |
| `db:check` | ✅ `Tasks: 19 successful, 19 total` |
| `test:unit` (unit + sqlite-hub) | ✅ `Test Files 72 passed \| 5 skipped (77)`, `Tests 330 passed \| 41 skipped (371)` |
| `test:perf` | ✅ `Test Files 9 passed (9)`, `Tests 12 passed (12)` |
| `test:e2e:pos` | Birinchi ishga tushirishda ❌: Playwright brauzeri o'rnatilmagan edi (`Executable doesn't exist ... chrome-headless-shell.exe`). Bu muhit muammosi. `playwright install chromium-headless-shell` dan keyin ✅ `1 passed`: scan → savat 20.6 ms, 50k FTS 47.2 ms |
| `depcruise` | ✅ `no dependency violations found (406 modules, 1723 dependencies cruised)` |

**Skip bo'lgan 5 fayl** Docker'siz PG testlari (`shouldRunPgTests()`): `apps/cloud/src/cli/create-org.test.ts`, `apps/cloud/src/server.test.ts`, `packages/db-cloud/src/pg-{device,rls,tenant}.test.ts`.

**Xulosa:** kod o'zgarishisiz boshlang'ich holat yashil. Faqat PG testlari lokal tekshirilmadi.

---

## 1. Tashkilot soliq sozlamalari

### Joyi: yangi jadval `organization_tax_profiles`

- **Sinf:** `ATTR`. Tahrirlanadi va HLC bo'yicha LWW.
- **Tenant doirasi:** `organization`. STIR, yuridik nom va QQS holati tashkilotga tegishli, do'konga emas. Ularni biznes kabineti (T2.7) va keyin fiskal chek (T3.4) o'qiydi.
- **Bitta tashkilot uchun bitta qator:** `uidx_org_tax_profiles_org` UNIQUE `(organization_id) WHERE deleted_at_ms IS NULL`.
- **Nega `local_hub_config` emas:** u `LOCAL`, ya'ni sinxronlanmaydi va bitta hub'ga tegishli. Ikki do'konli tashkilotda ikki xil STIR paydo bo'lib qoladi. Bulutga ham chiqmaydi.

### Ustunlar

Umumiy ustunlar registrdan keladi.

| Ustun | Tip | Cheklov |
|---|---|---|
| `tin` | text | `NOT NULL`, CHECK `length = 9` va faqat raqam (`GLOB '[0-9]*'` + uzunlik) |
| `legal_name` | text | `NOT NULL`, `trim` qilingandan keyin ≥ 1 belgi |
| `legal_address` | text | `NOT NULL`, `trim` qilingandan keyin ≥ 1 belgi |
| `is_vat_payer` | bool | `NOT NULL`, `IN (0,1)` |
| `default_vat_rate_bp` | int | `NOT NULL`, `0..10000` |

### Contracts

`packages/contracts/src/tax-settings.ts` (yangi fayl) va `index.ts` dan eksport:
- `TinSchema`: 9 raqam, faqat format tekshiriladi. Nazorat raqami algoritmi qo'shilmaydi, chunki uni o'ylab topmayman.
- `OrganizationTaxProfileSchema`, `UpdateTaxProfileRequestSchema`, `TaxProfileResponseSchema`.
- Mavjud `VatRateBpSchema` qayta ishlatiladi.

### API (hub)

Yangi fayl: `apps/hub/src/tax-settings-routes.ts`.

| Endpoint | Ruxsat | Kim |
|---|---|---|
| `GET /settings/tax` | yangi `tax:read` | owner, manager |
| `PUT /settings/tax` | yangi `tax:write` | owner, manager |

- Kassir ikkala endpoint'da 403 oladi.
- Profil hali yo'q bo'lsa, `GET` 404 emas, `{ profile: null }` qaytaradi.
- Yozuv `UnitOfWork` ichida bajariladi va o'sha tranzaksiyada outbox'ga ATTR hodisasi yoziladi (3.1-bo'lim, 11-band).
- Ruxsatlar `packages/domain/src/auth.ts` dagi `ROLE_PERMISSION_TABLE` ga qo'shiladi.

### Sinxronga ta'siri (savol S1)

Yangi sinxron jadval qo'shilsa, Gemini'ning T2.3 kodi uni registrdan avtomatik oladi: payload Zod sxemasi va "36 sinxron jadval" ro'yxati. Lekin bulutda mos jadval kerak bo'ladi (`packages/db-cloud`). Bu Gemini yo'lagi, unga ruxsatsiz tegmayman. 3-bo'limdagi S1 savoliga qarang.

---

## 2. QQS to'lovchisi bo'lmagan tashkilot (savol S2)

`GEMINI.md` da QQS to'lovchisi bo'lmagan tashkilot uchun **aniq qoida yo'q**. Mavjud QQS modeli:
- 3.1-bo'lim, 8-band: chek qatorida QQS o'sha paytdagi qiymatda (snapshot) saqlanadi.
- T0.2: QQS hisobi.
- Kod: `domain/src/cart.ts` QQS'ni har qator bo'yicha, chegirma taqsimlangandan keyin `calculateVatIncluded` bilan ajratadi. Ya'ni QQS narx ichida va har qatorda yaxlitlanadi.

Shuning uchun quyidagini **taklif** qilaman va tasdiqni kutaman:

- `is_vat_payer = 0` bo'lsa, savatga qator qo'shilganda **samarali stavka 0** bo'ladi: `vat_rate_bp_snapshot = 0`. Mahsulotning o'z `vat_rate_bp` qiymati o'zgarmaydi, shuning uchun tashkilot keyin QQS to'lovchisiga aylansa, katalogni qayta tahrirlash kerak bo'lmaydi.
  - Snapshot olinadigan joylar: `cart-repo.ts` (katalog va tez savdo qatori) va buyurtma qatori (`order-repo`).
  - Bitta yordamchi funksiya bo'ladi: domen'da `effectiveVatRate(productRateBp, isVatPayer)`.
- Hisobotlar o'zgarmaydi. Ular snapshot'dan (`v_sales_lines`) o'qiydi, shuning uchun QQS 0 bo'lib chiqadi.
- **Chekdagi matn:** stavka 0 bo'lganda "QQS (0%)" chiqadimi, "QQSsiz" chiqadimi yoki satr umuman chiqmaydimi, bu **qonuniy chek maydoni masalasi**. U `[TASDIQLANSIN]` (10-bo'lim, "Chek maydonlari ro'yxati") va T3.4 ga tegishli. T3.1 da printer joylashuvini **o'zgartirmayman**, mavjud xatti-harakat qoladi.

---

## 3. Mahsulot formasi (MXIK, qadoq kodi, QQS)

POS'da hozir katalogni boshqarish ekrani yo'q, faqat tez savdo modali bor. `apps/admin` esa bulut kabineti (T2.7) uchun. Shuning uchun:

- **`apps/pos`:** yangi `CatalogScreen.tsx`. Unda mahsulot ro'yxati (qidiruv bilan), yaratish va tahrirlash modali bo'ladi. Faqat `catalog:write` ruxsati bor foydalanuvchilarga ko'rinadi: owner va manager.
- **Maydonlar:** mavjud `CreateProductRequestSchema` va `UpdateProductRequestSchema` dagilar. Formada QQS foizda kiritiladi (masalan `12`), ichkarida basis point'ga aylanadi (`1200`). Aylantirish float'siz, satrni tahlil qilish orqali bo'ladi.
- **Validatsiya:** klientda `MxikSchema`, `PackageCodeSchema` va `VatRateBpSchema` contracts'dan **import qilinadi**, takror yozilmaydi. Hub ham aynan shu sxemalar bilan tekshiradi.
- **Standart QQS:** yangi mahsulotda QQS maydoni tashkilot profilidagi `default_vat_rate_bp` bilan to'ldiriladi. Profil bo'lmasa, 0 bilan.
- **MXIK formati (savol S3):** hozir `normalizeFiscalCode` 1–N xavfsiz ASCII belgini qabul qiladi. Rasmiy MXIK formatini (uzunlik va raqamlar) o'ylab topmayman, mavjud validatsiya qoladi.

---

## 4. Excel import va eksport

`apps/hub/src/excel-port.ts` va `catalog-import-routes.ts`:

- **Import:** 7, 8 va 9-ustunlar qo'shiladi: `MXIK`, `Qadoq kodi`, `QQS (%)`. Ustunlar oxiriga qo'shiladi, shuning uchun mavjud fayllar ishlashda davom etadi.
- **Qator darajasidagi xato:** MXIK, qadoq kodi yoki QQS noto'g'ri bo'lsa, faqat shu qator `invalidRows` ga tushadi. Xatoda kod va i18n kaliti bo'ladi. Qolgan qatorlar import qilinadi. Bo'sh QQS bo'lsa, tashkilotning standart stavkasi olinadi.
- **Commit:** `ExcelImportCommitRequestSchema` va keshdagi preview qatorlari yangi maydonlarni olib o'tadi. Mahsulot `mxik`, `package_code` va `vat_rate_bp` bilan yaratiladi.
- **Eksport:** `generateCatalogWorkbook` ga `Shtrix-kod`, `MXIK`, `Qadoq kodi` va `QQS (%)` qo'shiladi. Eksport ustunlari import ustunlari bilan **bir xil tartibda** bo'ladi, shunda eksport qilingan faylni qayta import qilish mumkin. Hozir eksportda shtrix-kod ustuni yo'q, import esa 3-ustunni shtrix-kod deb o'qiydi. Bu nomuvofiqlik shu ishda tuzatiladi.
- **Topilma (savol S4):** importda narx `parseFloat` bilan o'qiladi (`excel-port.ts`, "Price parsing" qismi). Bu 3.1-bo'lim, 1-bandga zid. Yangi QQS ustunini float'siz parse qilaman. Shu fayl ichida narx va `minStock` ni ham satr asosidagi o'nlik parser'ga o'tkazishni taklif qilaman, test bilan. Tasdiqlansa, T3.1 ichida qilaman.

---

## 5. MXIK'siz mahsulotlar ro'yxati

- **API:** `ListProductsQuerySchema` ga ixtiyoriy `missingMxik: boolean` filtri qo'shiladi. Yangi endpoint ochilmaydi, mavjud `GET /catalog/products` kengaytiriladi. Sanoq uchun `GET /catalog/products/missing-mxik/count` qo'shiladi.
- **Indeks:** `idx_products_org_missing_mxik` `(organization_id, name_search, id) WHERE mxik IS NULL AND deleted_at_ms IS NULL`. 50 000 mahsulotda perf testi qo'shiladi.
- **UI:** `CatalogScreen` da "MXIK'siz (N)" filtri va sariq ogohlantirish bo'ladi: "Fiskal chek uchun MXIK kerak bo'ladi". Savdo **bloklanmaydi**. Fiskal rejimdagi xatti-harakat T3.2 da hal qilinadi.

---

## 6. Snapshot mezoni: tekshiriladigan yo'llar

Har bir yo'l uchun ssenariy bir xil: chek (yoki buyurtma) yaratiladi, keyin mahsulotning `name`, `mxik`, `package_code` va `vat_rate_bp` qiymatlari **va** tashkilotning `is_vat_payer` holati o'zgartiriladi.

| # | Yo'l | Kutilgan natija |
|---|---|---|
| 1 | Savdo detali (`GET /sales/:id`) | Qatorlarda eski nom, MXIK, qadoq kodi, QQS stavkasi va summasi |
| 2 | Chekni qayta chop etish (`printer-service`, `FakePrinter` baytlari) | Eski nom va QQS, baytlar asl chek baytlariga teng (reprint belgisidan tashqari) |
| 3 | Qaytarish (to'liq va qisman) | `return_lines` snapshot'i sotuv qatoridan olinadi, mahsulotdan emas |
| 4 | Kunlik va oylik hisobotlar, Excel hisobot eksporti | QQS va tushum o'zgarmaydi |
| 5 | Buyurtma qatori va buyurtmadan sotuvga o'tish | Buyurtma snapshot'i saqlanadi |
| 6 | Savatdagi qator (tahrirdan oldin qo'shilgan) | Mavjud xatti-harakat avval test bilan **qayd etiladi**, keyin tasdiq olinadi |

6-band: savatdagi qator hozir snapshot'ni qo'shilgan paytdagi qiymatda ushlab turadi. Shuni test bilan mahkamlayman.

**Test fayllari:**
- `apps/hub/src/tax-snapshot.test.ts`: API orqali 1, 2, 3, 4 va 5-yo'llar;
- `packages/db-local/src/sale.test.ts`: repo darajasi.

---

## 7. QQS yaxlitlash testlari

### Domen (`packages/domain/src/vat.test.ts`, yangi)

**Chegara jadvali**, `calculateVatIncluded`:

| Kirish | Kutilgan |
|---|---|
| gross 0 | vat 0 |
| gross 1 tiyin, 12% | vat 0 |
| gross 112, 12% | vat 12 |
| aniq yarim qiymat (masalan gross 56, 12%) | yaxlitlash yo'nalishi qo'lda hisoblab tekshiriladi |
| stavka 0 | vat 0 |
| stavka 10000 | maksimal stavka |
| juda katta summa (> 2^53) | aniq natija |
| manfiy summa (qaytarish) | ishora simmetriyasi |

**Property testlar** (fast-check):
- `net + vat === gross`;
- `0 ≤ |vat| ≤ |gross|`;
- `f(-x) = -f(x)`;
- gross o'sganda vat kamaymaydi;
- `rate = 0` bo'lsa `vat = 0`.

### Savat va chek (`cart.test.ts` kengaytiriladi)

- Ko'p qatorli chek: 0% va 12% aralash.
- Chegirmalar: foiz chegirma, summa chegirmasi va aksiya.
- Property: `Σ qator vat = totalVat` va `Σ (net + vat) = totalFinal`.
- QQS to'lovchisi bo'lmagan tashkilot: `totalVat = 0`.
- Qo'lda hisoblangan misol: QQS har qatorda yaxlitlangani uchun chek darajasida hisoblangan QQS'dan farq qilishi mumkin. Bu farq misolda hujjatlashtiriladi.

### Qaytarish

Qisman qaytarishda qaytarilgan QQS yig'indisi asl qator QQS'idan oshmaydi.

---

## 8. Migratsiya va sxema registri

Lokal ish nomi `0015_org_tax_mxik.sql`. Gemini T2.3 da `0015_sync_conflicts` qo'shyapti. Shuning uchun PR ochishdan oldin `origin/main` ga rebase qilaman va migratsiyani `main` dagi oxirgi raqamdan keyingi bo'sh raqamga ko'chiraman (ehtimol `0016`). Keyin drizzle jurnalini qayta yarataman. `main` ga tushgan migratsiyani tahrirlamayman.

| O'zgarish | Sinf | Tenant |
|---|---|---|
| Yangi jadval `organization_tax_profiles` | ATTR | organization |
| `products` ga yangi partial indeks `idx_products_org_missing_mxik` (ustun qo'shilmaydi) | — | — |

- `products` ustunlari o'zgarmaydi: `mxik`, `package_code` va `vat_rate_bp` allaqachon bor.
- Sxema registri testlaridagi jadval va migratsiya sonlari, shuningdek `['…', 'ATTR']` ro'yxati yangilanadi.
- Ruxsatlar (`tax:read`, `tax:write`) faqat domen jadvalida, ular migratsiya emas.

---

## 9. Test rejasi va mutatsiyalar

| Mezon yoki qoida | Test | Mutatsiya (kod ataylab buziladi, test yiqilishi kerak) |
|---|---|---|
| Snapshot | `tax-snapshot.test.ts` (6-bo'limdagi 1–5-yo'llar) | Reprint qatorida `itemName` mahsulotdan o'qiladi; qaytarishda QQS mahsulotdan olinadi |
| QQS yaxlitlash | `vat.test.ts`, `cart.test.ts` | `divideRoundHalfAwayFromZero` → oddiy bo'lish; qator emas, chek darajasida yaxlitlash |
| QQS to'lovchisi emas | `cart.test.ts`, hub testi | `effectiveVatRate` bayroqni e'tiborsiz qoldiradi |
| RBAC | `tax-settings.test.ts`: kassir 403 (GET va PUT), manager/owner 200 | Kassirga `tax:write` beriladi |
| STIR | contracts va DB CHECK testlari: 8 raqam, 10 raqam, harf, bo'shliq rad etiladi | Regex `\d{8,9}` ga o'zgartiriladi; CHECK olib tashlanadi |
| Excel qator xatosi | `excel-port` testi: 1 noto'g'ri MXIK + 3 yaxshi qator → 3 import, 1 xato | Noto'g'ri qatorda `throw` qilinadi |
| Excel aylanma | eksport → import → bir xil maydonlar | Eksport ustun tartibi buziladi |
| MXIK'siz ro'yxat | hub testi va perf testi | `mxik IS NULL` sharti olib tashlanadi |
| Bitta tashkilot — bitta profil | DB testi | UNIQUE indeks olib tashlanadi |
| Outbox | Profil yozilganda outbox'da ATTR hodisasi; rollback'da outbox bo'sh | Outbox yozuvi olib tashlanadi |
| Ikki tenant | B tashkilotning profili A'da ko'rinmaydi | `organization_id` filtri olib tashlanadi |

Mutatsiyalar qo'lda qilinadi, natijasi (qaysi test yiqilgani) hisobotga yoziladi va kod qaytariladi.

---

## 10. i18n

- Yangi UI matnlari `packages/i18n/src/locales/uz-Latn.ts` ga `catalog.*` va `taxSettings.*` kalitlari bilan qo'shiladi.
- Hub yangi xatolarni kod bilan qaytaradi: `INVALID_TIN`, `INVALID_MXIK_ROW` va hokazo. UI ularni i18n orqali tarjima qiladi.
- Mavjud hub xabarlarini (ular hozir qattiq yozilgan) qayta yozmayman, bu vazifadan tashqari.

---

## O'zgaradigan fayllar (reja)

- `packages/contracts/src/tax-settings.ts` (yangi), `catalog.ts`, `index.ts`
- `packages/domain/src/vat.ts` (`effectiveVatRate`), `auth.ts` (ruxsatlar), `vat.test.ts` (yangi)
- `packages/db-local/src/schema/index.ts`, `tax-settings-repo.ts` (yangi), `cart-repo.ts`, `order-repo.ts`, `catalog-repo.ts`, `drizzle/00xx_*.sql`, `drizzle/meta/*`, `index.test.ts`
- `apps/hub/src/tax-settings-routes.ts` (yangi), `catalog-routes.ts`, `catalog-service.ts`, `excel-port.ts`, `catalog-import-routes.ts`, `routes.ts` va testlar
- `apps/pos/src/components/CatalogScreen.tsx` (yangi), `api/hub-client.ts`, `App.tsx`
- `packages/i18n/src/locales/uz-Latn.ts`

**Tegmayman:** `apps/cloud/**`, `packages/db-cloud/**`, `apps/hub/src/sync*`, `packages/contracts/src/sync.ts`, `.mezon/claude/*`, `.mezon/gemini/*`.

Yangi kutubxona qo'shilmaydi.

---

## Egasi yoki nazoratchi qarori kerak bo'lgan savollar

- **S1. Bulutdagi jadval.** `organization_tax_profiles` sinxron (ATTR) bo'ladi. Uning bulutdagi jufti (`packages/db-cloud` sxemasi va migratsiyasi) Gemini yo'lagida.
  - Variant A: men faqat lokal jadvalni qo'shaman, bulut juftini Gemini T2.3 yoki T2.4 ichida qo'shadi.
  - Variant B: menga `packages/db-cloud` ga faqat shu jadval uchun tegishga ruxsat beriladi.
  - Variant C: T3.1 da jadval vaqtincha `LOCAL` bo'ladi, keyin ATTR'ga o'tkaziladi. Buni tavsiya qilmayman.
  - Qaysi biri? Gemini'ning T2.3 dagi "36 sinxron jadval" ro'yxatiga ham ta'sir qiladi.
- **S2. QQS to'lovchisi bo'lmagan tashkilot.** 2-bo'limdagi taklif ("samarali stavka 0, mahsulot stavkasi o'zgarmaydi") tasdiqlanadimi? Chekdagi matn ("QQSsiz" va hokazo) T3.4 ga qoldiriladimi?
- **S3. MXIK formati.** Qat'iy format validatsiyasi (uzunlik, faqat raqamlar) kerakmi? Kerak bo'lsa, manba hujjatini bering. Hozirgi umumiy validatsiya qoladi.
- **S4. Excel `parseFloat`.** Narx va `minStock` ni float'siz parser'ga o'tkazish T3.1 ichida qilinsinmi yoki alohida vazifa bo'lsinmi?
- **S5. Docker.** Lokal Docker Desktop buzilgan, PG testlarini lokal ishga tushira olmayman. Mening yo'lagimga bu ta'sir qilmaydi, PG testlari CI'da ishlaydi. Tuzatish egasining ishi.
