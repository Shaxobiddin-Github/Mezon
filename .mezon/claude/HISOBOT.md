# Hisobot: C2 — T4.7 (obuna, litsenziya) + T4.8 (imzolangan yangilanish, tiklash) (Claude)

Branch: `claude/C2-licence-update`. `main` (C1 squash) merge qilingan, PR diff faqat C2.
T4.4 (web-kassa) **keyingi PR**da: ishchi2 ning T4.1 iga bog'liq.

**Migratsiya:** P1 (`0007_sync_parked_and_cloud_hlc`) birinchi merge bo'ladi. Shundan keyin C2 o'z bulut migratsiyasini `0008_licences` qilib qayta yaratadi.

# T4.8 — imzolangan avtomatik yangilanish va tiklash

## Qabul mezoni

> "Yangilanish ochiq chekni buzmaydi, kassir vaqtini tanlaydi"

| Mezon | Qanday bajarildi | Isbot |
|---|---|---|
| Ochiq chek buzilmaydi | Mahsulotli ochiq chek bo'lsa, o'rnatish **hech qachon** boshlanmaydi. Tekshiruv ikki marta: tanlovda va zaxira olish paytida. Zaxira olinmasa ham o'rnatish yo'q. | `decideInstall` jadval testi (10 holat), "ikki tekshiruv orasida chek ochildi" testi; U1, U2, U10, U13 |
| Kassir vaqtini tanlaydi | "Hozir", "Smena yopilganda", "Soat 22:00 da"; "Bekor qilish". Tanlov qayta ishga tushganda saqlanadi. | U8, U9; restart testi |
| Imzolangan | Ed25519 manifest: versiya, platforma, kanal, URL, **SHA-256 va hajm** imzo ichida. | U4, U5, U6, U7 |
| Tiklash yo'riqnomasi | `docs/pilot/yangilash-va-tiklash.md` | — |

## Qanday ishlaydi

1. Desktop har 6 soatda manifestni oladi: `DEFAULT_UPDATE_MANIFEST_URL` yoki `MEZON_UPDATE_MANIFEST_URL`.
2. Manifest tekshiriladi:
   - imzo;
   - platforma va kanal;
   - versiya joriydan **katta** bo'lishi (eski manifestni qayta yuborish = downgrade, rad etiladi).
3. O'rnatuvchi `.part` ga yuklanadi. Hajm chegarasi bor, SHA-256 va hajm solishtiriladi. Mos kelmasa, fayl o'chiriladi.
4. Kassir vaqtni tanlaydi. Har daqiqada `tick` ishlaydi:
   1. Hub worker'dan **parent port orqali** (HTTP emas, auth kerak emas) holat so'raladi: ochiq cheklar, smenalar, fiskal navbat.
   2. Ruxsat bo'lsa, o'rnatuvchi xeshi **qayta** tekshiriladi.
   3. Hub yana tekshiradi va "Yangilanishdan oldin (x.y.z)" zaxirasini oladi.
   4. Hub toza yopiladi.
   5. NSIS `--updated /S --force-run` ishga tushadi.
5. Qayta ishga tushganda `update-state.json` **imzosi qayta tekshiriladi**. Versiya allaqachon o'rnatilgan bo'lsa, qoldiqlar o'chiriladi.

**Ishonch.** Egasi kalit bermaguncha `PRODUCTION_TRUSTED_UPDATE_KEYS = []` va `DEFAULT_UPDATE_MANIFEST_URL = ''`. Shu holatda yangilanish **o'chiq**: hech narsa so'ralmaydi (test bor).

`scripts/update-sign.mjs`:
- `keygen` kalitni faqat repodan tashqariga yozadi; repo ichiga yozishni rad etadi (tekshirildi);
- `sign` va `verify` desktop'ning o'z manifest kodini ishlatadi, shuning uchun ikki tomon bir xil bo'ladi.

Qo'lda sinov: keygen, sign, `verify --current 0.1.0` → OK; `--current 0.2.0` → "not newer".

## Fayllar

| Joy | Fayllar |
|---|---|
| `apps/desktop/src/update/` | `update-manifest.ts`, `update-manager.ts`, `update-node-ports.ts` (+ test) |
| `apps/desktop` | `hub-supervisor.ts` (`prepareUpdate`), `main.ts`, `preload.cts` (IPC) |
| `apps/hub` | `update-readiness.ts` (+ test), `electron-worker.ts` (`update-prepare` xabari) |
| `apps/pos` | `UpdateBanner.tsx` (+ test), `bridge.ts`, `App.tsx` |
| Boshqa | i18n (uz-Latn, ru); `scripts/update-sign.mjs`; `docs/pilot/yangilash-va-tiklash.md`, `reliz-royxati.md` |

## Testlar

| Fayl | Soni | Nima |
|---|---|---|
| `update-manager.test.ts` | 23 | imzo, platforma, kanal, downgrade, https; versiya solishtirish; qaror jadvali; chek ochiq bo'lsa kutadi, yopilgach zaxira va o'rnatish; ikki tekshiruv orasida chek; zaxira yo'q bo'lsa o'rnatish yo'q; smena va vaqt; vaqt oynasi; buzilgan yuklama; diskda almashtirilgan o'rnatuvchi; soxta yoki eski manifest; restart va tahrirlangan holat fayli; o'rnatilgandan keyin tozalash; o'chiq rejim |
| `hub-supervisor.test.ts` | +1 | hub tayyor bo'lmasa, boshqa `requestId`, noto'g'ri javob yoki javob kelmasa → "kut" |
| `update-readiness.test.ts` | 2 | haqiqiy HTTP: bo'sh savat bloklamaydi, mahsulot qo'shilsa bloklaydi, park → bloklamaydi, resume → bloklaydi, sotildi → bloklamaydi; worker: hub yo'q → null; chek ochiq → zaxira yo'q; chek yopiq → zaxira bor |
| `UpdateBanner.test.ts` | 3 | ko'rinish, sabablar, ru; "22:00" bugun yoki ertaga |

## Mutatsiyalar: 14/14 o'ldi

| # | Mutatsiya | Natija |
|---|---|---|
| U1 | ochiq chek e'tiborsiz | o'ldi |
| U2 | ikkinchi tekshiruv yo'q | o'ldi |
| U3 | o'rnatishdan oldin xesh yo'q | o'ldi |
| U4 | yuklagandan keyin xesh yo'q | o'ldi |
| U5 | downgrade ruxsat | o'ldi |
| U6 | imzo e'tiborsiz | o'ldi |
| U7 | restartda imzo tekshirilmaydi | o'ldi |
| U8 | "smena yopilganda" smenani kutmaydi | o'ldi |
| U9 | 7 kunlik oyna yo'q | o'ldi |
| U10 | zaxira olinmasa ham o'rnatadi | birinchi variantda **omon qoldi** → test qo'shildi → o'ldi |
| U11 | bo'sh savat bloklaydi | o'ldi |
| U12 | park qilingan chek bloklaydi | o'ldi |
| U13 | chek ochiq bo'lsa ham zaxira | o'ldi |
| U14 | supervisor tayyor bo'lmagan hub'dan so'raydi | o'ldi |

## T4.7 ga tuzatish (o'z topilmam)

**Muammo.** Kassadagi litsenziya keshi tashkilot id'sini **faylning o'zidan** olardi. Boshqa tashkilotning haqiqiy Pro litsenziyasini nusxalab, faylda tashkilotni o'zgartirsa, kassa "Pro" ko'rsatardi. Ta'siri faqat banner edi, chegaralar bulutda.

**Tuzatish.** Endi tekshiruv kassa **ulangan** tashkilot bo'yicha. Fayldagi tashkilot boshqacha bo'lsa, `invalidLicence` qaytadi.

**Testlar:** 2 ta qo'shildi. H1 va H2 mutatsiyalari o'ldi (H2 birinchi variantda omon qolgan, test qo'shildi).

## Tekshiruv paytida tuzatilgan

**Zaxira uchun kutish vaqti.** Zaxira so'rovi 30 soniyada javob olmasa, "javob yo'q" deb qaytardi va keyingi `tick` yangi zaxira boshlardi. Katta bazada bu har daqiqada bitta yangi zaxira degani edi.

Tuzatish: zaxira bilan so'rovda kutish vaqti 10 daqiqa, oddiy so'rovda 30 soniya. `busy` bayrog'i `tick`larni ustma-ust qo'ymaydi.

## Tekshirilmagan qism (halol)

- **Haqiqiy NSIS o'rnatuvchining jim o'rnatishi va o'zi qayta ochilishi.** Testlarda o'rnatuvchi Fake. Birinchi imzolangan reliz pilot kompyuterida qo'lda sinaladi; bu `reliz-royxati.md` ga yozildi.
- **Windows kod imzosi (Authenticode).** Bu egasining sertifikati bilan bog'liq, alohida masala. Bizning Ed25519 manifestimiz o'rnatuvchining o'zini xesh bilan bog'laydi.

## Tekshiruv

`pnpm verify` (`MEZON_REQUIRE_PG_TESTS=1`):

| Bosqich | Natija |
|---|---|
| format, build, keshsiz lint, typecheck, `db:check` | yashil |
| unit + sqlite-hub + pg-cloud | 122 fayl, **778 test** |
| perf | 16 test. Bitta yugurishda `sale.perf` 303 ms / 300 ms bo'lib, yuklama ostida tasodifiy yiqildi. Alohida 2 marta qayta yugurtirildi, ikkalasida ham o'tdi. |
| POS E2E | 1 |
| depcruise | 578 modul, toza |

**Depcruise qoidasi kengaytirildi.** Desktop'ga `crypto` va `child_process` ruxsat etildi. Ular faqat yangilash moduli uchun kerak: imzo va SHA-256 tekshiruvi, tekshirilgan o'rnatuvchini ishga tushirish.

**Verify topgan haqiqiy xato (T4.7 kodida).**
- Muammo: `HubLicenceService.refresh` da token shifrini ochish `try` dan tashqarida edi. Fon rejimidagi yangilashda bu ushlanmagan rad etishga (unhandled rejection) aylanardi.
- Tuzatish: butun funksiya `try` ichiga olindi.
- Test: regressiya testi qo'shildi.

## ishchi2 uchun tekshiruv so'rovi

Toifa: **chuqur** (o'rnatish, zaxira, imzo). Ayniqsa:
1. O'rnatishni ochiq chek bilan boshlashning biror yo'li bormi: poyga, hub qayta ishga tushishi, LAN terminal T4.1?
2. Imzoni chetlab o'tish: `update-state.json`, `.part` fayl, manifest URL'idagi redirect.
3. `prepareUpdate` timeout'i va zaxira davomiyligi: katta bazada 30 s yetadimi?
4. T4.7 qismi (oldingi so'rov) o'z kuchida.

---

# T4.7 — obuna, tariflar va imzolangan litsenziya

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
| `apps/hub/src/licence-service.test.ts` | 8 | ulanmagan kassa; olish va oflayn; xato bo'lsa eski kesh; qo'lda buzilgan kesh; boshqa tashkilot; **kesh boshqa tashkilotga qayta yozilgan**; **boshqa tashkilotdan qolgan bo'sh kesh**; noto'g'ri javob keshlanmaydi |
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
