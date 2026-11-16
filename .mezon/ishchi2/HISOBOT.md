# Hisobot: T3.1 — qayta ishlash (K1, K2)

Branch / PR: `ishchi2/T3.1-mxik` / https://github.com/Shaxobiddin-Github/Mezon/pull/24
Commit: `520ce31` (K1, K2). Oldingi to'liq hisobot `82fea7e` da, kod `ba0f53a` da.
Nazoratchi xulosasi: `2747b61`.

Bu hisobotda faqat o'zgargan qismlar bor. Qolganlari `82fea7e` hisobotidagidek.

---

## Nima qilindi

### K1. Buyurtma yo'li testlari (MU1, MU2)

Yangi test: `apps/hub/src/tax-snapshot.test.ts` → "T3.1 rework K1: order path uses the effective VAT rate (MU1, MU2)" → "orders created AFTER switching to non-VAT-payer snapshot 0 (catalog + quick sale), keep 0 after switching back, and deliver at 0".

Ssenariy:
1. Tashkilot QQS to'lovchisi emas holatiga o'tadi.
2. **Shundan keyin** yangi buyurtma yaratiladi. Unda ikki qator bor:
   - katalog qatori: mahsulot stavkasi 1200;
   - tez savdo qatori: `vatRateBp: 1200` aniq so'ralgan.
3. Tekshiriladi: ikkala buyurtma qatorining `vatRateBpSnapshot` qiymati 0, buyurtmaning `totalVat` qiymati `'0'`.
4. Tashkilot qayta QQS to'lovchisiga o'tadi, keyin buyurtma `confirm` → `ready` → `deliver` qilinadi.
5. Tekshiriladi: sotuvda 2 ta qator, ikkalasining snapshot'i 0, sotuvning `totalVat` qiymati `'0'`.

Kod o'zgarmadi: buyurtma yo'li `ba0f53a` dayoq effektiv stavkani qo'llagan edi. Faqat test qarzi yopildi.

### K2. O'chirilgan profil (MU6) — tanlangan yo'l: qayta tiklash

**Nega CHECK emas:** o'chirishni `deleted_at_ms IS NULL` CHECK bilan taqiqlash sinxron orqali kelgan tombstone hodisasini hub'da SQL xatosiga aylantirardi. Qayta tiklash esa bu holatda ham to'g'ri ishlaydi.

- `packages/db-local/src/writers.ts`: yangi `restoreAttr`.
  - U ATTR yozuvini **tombstone holatida bo'lsa ham** topadi.
  - Biznes maydonlarini yangilaydi va `deleted_at_ms = NULL` qiladi.
  - `deviceId`, `hlc` va `updatedAtMs` yangilanadi.
  - O'sha tranzaksiyada outbox hodisasi yoziladi.
  - Buning uchun ichki `mutateMutableSyncedRecord` ga `allowTombstoned` bayrog'i qo'shildi. Boshqa writer'larning xatti-harakati o'zgarmadi.
- `packages/db-local/src/tax-settings-repo.ts` → `upsertProfile`:
  - faol profil topilmasa, avval `id = organization_id` bo'yicha tombstone qator qidiriladi;
  - topilsa, `restoreAttr` chaqiriladi va `organization_tax_profile.restored` hodisasi yoziladi;
  - topilmasa, avvalgidek `insertAttr` ishlaydi.
- Profilni o'qish yo'llari (`readTaxProfileRowSync`) tombstone qatorni avvalgidek "yo'q" deb ko'radi.

Test: `apps/hub/src/tax-snapshot.test.ts` → "T3.1 rework K2: tombstoned profile (MU6)" → "a profile tombstoned by sync reads as absent, and the next PUT restores the same row without a PK error".

| Qadam | Tekshiruv |
|---|---|
| Profil yaratiladi, keyin `deleted_at_ms` to'g'ridan-to'g'ri SQL bilan qo'yiladi (sinxronni taqlid qiladi) | — |
| `GET /settings/tax` | `profile: null` |
| `PUT /settings/tax` (manager) | **200**, `id = organization_id`, yangi `legalName`, `updatedByUserId = manager` |
| Bazadagi qatorlar | jadvalda **1 ta** qator, `deleted_at_ms` NULL |
| Outbox | `created`, keyin `restored` |
| Keyingi `PUT` | odatdagi yangilanish sifatida ishlaydi |

## O'zgargan fayllar (fayl — sabab)

| Fayl | Sabab |
|---|---|
| `packages/db-local/src/writers.ts` | `restoreAttr` va `allowTombstoned` (K2) |
| `packages/db-local/src/tax-settings-repo.ts` | Upsert tombstone'ni tiklaydi (K2) |
| `packages/db-local/src/index.ts` | `restoreAttr` eksporti |
| `apps/hub/src/tax-snapshot.test.ts` | K1 va K2 testlari |

## Migratsiyalar

O'zgarish yo'q. Yangi qarorga ko'ra `0015_org_tax_mxik` T3.1 bilan `main` ga birinchi tushadi. `packages/db-cloud` ga tegilmadi.

## Mutatsiyalar (qayta ishga tushirildi)

Skript `db-local` ni har mutatsiyadan keyin qayta build qiladi. Ishga tushirilgan testlar: `tax-snapshot.test.ts` va `tax-settings.test.ts`.

| # | Mutatsiya | Avval (nazoratchi) | Hozir | Yiqilgan test |
|---|---|---|---|---|
| MU1 | Buyurtmaning katalog qatori `isVatPayer` ni e'tiborsiz qoldiradi | omon qoldi | **aniqlandi** | K1 testi |
| MU2 | Buyurtmaning tez savdo qatori `isVatPayer` ni e'tiborsiz qoldiradi | omon qoldi | **aniqlandi** | K1 testi |
| MU6 | Profilni o'qishda `deleted_at_ms IS NULL` olib tashlanadi | omon qoldi | **aniqlandi** | K2 testi (o'chirilgandan keyin GET `null` bo'lishi kerak) |
| MU7 (yangi) | Upsert tiklash tarmog'ini o'tkazib yuboradi | — | **aniqlandi** | K2 testi (PUT 200 bo'lishi kerak) |

Chiqishdan:
```
MU1 KILLED | Tests  1 failed | 14 passed (15) | Order catalog line ignores isVatPayer
MU2 KILLED | Tests  1 failed | 14 passed (15) | Order quick-sale line ignores isVatPayer
MU6 KILLED | Tests  1 failed | 14 passed (15) | Profile read drops `deleted_at_ms IS NULL`
MU7 KILLED | Tests  1 failed | 14 passed (15) | Upsert skips the tombstone-restore branch (INSERT collides on PK)
```

## Test natijasi

`pnpm verify` (lokal, Docker bilan, `520ce31`):
```
All matched files use Prettier code style!
build      Tasks:    17 successful, 17 total
typecheck  Tasks:    26 successful, 26 total
db:check   Tasks:    19 successful, 19 total
test:unit  Test Files  82 passed (82)   Tests  419 passed (419)
test:perf  Test Files  9 passed (9)     Tests  12 passed (12)
test:e2e   1 passed (8.2s)
depcruise  ✔ no dependency violations found (417 modules, 1786 dependencies cruised)
EXIT=0
```

**CI (PR #24, `520ce31`):** hisobot yozilgan paytda 3 ta job o'tgan, 1 tasi ishlayapti, Desktop installer skip. Yiqilgan job yo'q. Yakuniy natijani PR'da ko'rasiz. Qizil chiqsa, tuzataman.

## Tekshirilmagan narsalar

- Haqiqiy sinxron orqali kelgan tombstone tekshirilmadi, chunki hub'da pull hali yo'q (T2.4). U to'g'ridan-to'g'ri SQL bilan taqlid qilindi.

## Qilingan taxminlar

- Tiklashda hodisa turi `organization_tax_profile.restored` deb nomlandi. Gemini'ning bulut tomonidagi sinxron kodi bu turni qabul qilishi kerak. Nazoratchi bulut juftini Gemini'ga topshirayotgani uchun buni ham unga yetkazishni so'rayman.

## Savollar

Yo'q. QABUL va merge ko'rsatmasini kutyapman. Merge qilmayman.
