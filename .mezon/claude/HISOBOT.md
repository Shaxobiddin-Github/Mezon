# Hisobot: C2 / T4.7 — Obuna, tariflar va imzolangan litsenziya (Claude)

Branch: `claude/C2-licence-update` (C1 ustida; C1 merge bo'lgach diff faqat T4.7 bo'ladi).
T4.8 (imzolangan yangilanish) va T4.4 (web-kassa) **keyingi PR**larda: bu PR faqat T4.7.

## Egasining qarori (17-noyabr)

"Tariflar shundayligicha qoladi":

| Tarif | Narx (oy) | Do'kon | Kassa (qurilma) |
|---|---|---|---|
| Start | 124 000 so'm | 1 | 2 |
| Business | 249 000 so'm | 3 | 10 |
| Pro | 499 000 so'm | cheksiz | cheksiz |

- Bepul sinov: 14 kun, Business chegaralari.
- Imtiyozli davr: litsenziya tugagach 7 kun.

## Qarorlar

| Mavzu | Qaror |
|---|---|
| Litsenziya | Ed25519 imzo (T3.2 qoidalar paketi sxemasi): kanonik JSON + `keyId`, tashkilotga bog'langan, cheklovlar imzo ichida. Maxfiy kalit faqat egada (`scripts/licence-sign.mjs keygen` repodan tashqariga yozadi). `PRODUCTION_TRUSTED_LICENCE_KEYS = []` egasi kalit berguncha. |
| Holatlar | `trial` → `active` → `grace` (7 kun, to'liq chegaralar) → `expired` |
| Muddat tugashi | **Savdo hech qachon to'xtamaydi** (GEMINI §2). `expired` faqat o'sishni to'xtatadi: yangi do'kon, yangi kassa. |
| Ishonch | Bazadagi `plan` / `valid_*` ustunlari faqat indeks. Har o'qishda envelope qayta tekshiriladi; buzilgani e'tiborsiz qoldiriladi va `invalidLicence` deb ko'rsatiladi. |
| Tekshiruv joylari | `POST /stores`, `POST /devices/pairing-codes` (qulaylik uchun) va `POST /devices/pair` (asosiy tekshiruv: kod chegara to'lishidan oldin berilgan bo'lsa ham) → `402 PLAN_LIMIT_REACHED`. |
| Kassa | Imzolangan envelope'larni bulutdan oladi (`/api/v1/devices/licence`), `licence-cache.json` ga atomik yozadi, har o'qishda qayta tekshiradi. Oflaynda ham tarifni biladi. Faqat ogohlantirish beradi. |
| Hisob-faktura | `cloud_platform_invoices`, oyiga bitta (UNIQUE), CLI: `licence import / invoice / paid`. |

## Fayllar

- `packages/licensing` (yangi, sof): `catalog.ts`, `licence.ts`, `trusted-keys.ts`; depcruise qoidasi: faqat `domain` + `rules`.
- `packages/db-cloud`: `licence-tables.ts`, migratsiya `0007_licences` (RLS), `licence-store.ts`.
- `apps/cloud`: `licence-service.ts`, `licence-routes.ts` (`GET /admin/licence`, `GET /devices/licence`), `server.ts` (tekshiruvlar), `cli/licence.ts`.
- `apps/hub`: `licence-service.ts`, `licence-routes.ts` (`GET /licence/status`).
- `apps/admin`: `LicenceCard`. `apps/pos`: `LicenceBanner`.
- `scripts/licence-sign.mjs`. i18n: 19 kalit (tarif nomlari brend sifatida himoyalangan).

## Testlar

| Fayl | Testlar | Nima |
|---|---|---|
| `packages/licensing/src/licence.test.ts` | 9 | imzo, boshqa tashkilot, noma'lum kalit, kalit muddati, holatlar, chegaralar, expired = o'sish muzlaydi |
| `apps/cloud/src/licence.test.ts` (PG) | 8 | trial 4-do'kon 402; trial tugagach o'sish yo'q, o'qish bor; CLI import Start → chegaralar; **kod oldin berilgan, ulanishda 402**; buzilgan litsenziya CLI'da rad, bazada e'tiborsiz; boshqa tashkilot litsenziyasi; hisob-faktura bir marta va `paid`; imtiyozli davr va expired |
| `apps/hub/src/licence-service.test.ts` | 6 | ulanmagan kassa; olish va oflayn; xato bo'lsa eski kesh; qo'lda buzilgan kesh; boshqa tashkilot; noto'g'ri javob keshlanmaydi |
| `apps/pos/src/components/LicenceBanner.test.ts` | 2 | qachon ko'rinadi, "savdo davom etadi" |

## Mutatsiyalar: 10/10 o'ldirildi

| # | Mutatsiya | Yiqilgan test |
|---|---|---|
| L1 | do'kon chegarasi tekshirilmaydi | 4-do'kon |
| L2 | ulanish paytidagi qurilma tekshiruvi yo'q | kod oldin berilgan → 402 |
| L3 | kod berishdagi tekshiruv yo'q | trial tugagach; Start chegarasi |
| L4 | bazadagi envelope tekshirilmay ishonchli | buzilgan qator; boshqa tashkilot |
| L5 | tashkilot tekshirilmaydi | unit; boshqa tashkilot |
| L6 | imzo tekshirilmaydi | unit; CLI |
| L7 | imtiyozli davr yo'q | unit; grace |
| L8 | muddat tugagach o'sish muzlamaydi | unit (birinchi variantda omon qolgan, test qo'shildi) |
| L9 | chegara bittaga siljigan | unit; 4-do'kon |
| L10 | sinov tugamaydi | unit; trial tugagach |

## Tekshiruv

build, typecheck, **keshsiz** lint, format, depcruise (565 modul), `db:check` (lokal va bulut) — yashil. Bulut + db-cloud PG testlari ketma-ket — yashil.

## ishchi2 uchun tekshiruv so'rovi

Toifa: **chuqur** (auth, pul, migratsiya). Ayniqsa:
1. Muddat tugashi **hech qayerda** savdo yoki sinxronni to'xtatmasligi (sync push / pull / sale yo'lida litsenziya kodi yo'qligi).
2. Imzoni chetlab o'tish: bazaga yozilgan qator, kassadagi kesh fayli.
3. Hisob va ulanishdagi poyga holati: tekshiruv va INSERT bitta tranzaksiyada emas (bitta egasi amali; qurilma ulanishi rate-limit bilan). Agar buni xavf deb hisoblasang, yoz.
4. `GET /devices/licence` faqat o'z tashkilotini qaytarishi.
