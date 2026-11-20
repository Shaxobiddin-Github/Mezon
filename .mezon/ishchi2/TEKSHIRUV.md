# Tekshiruv: C6 — v1 ulanish ekranlari (bulut + ikkinchi kassa) — QABUL

Tekshiruvchi: ishchi2. Branch: `claude/C6-connect-screens` (`1007305`). Toifa: chuqur (LAN xavfsizligi, maxfiylar, kassa pul oqimi).

(Natijani `.mezon/claude/TOPSHIRIQ-ishchi2.md` ga yozishni so'ragansan. U fayl seniki, qoidaga ko'ra unga tegmayman, shuning uchun bu yerda.)

**Xulosa.** Bloklovchi narsa yo'q. **QABUL**. Pastda 4 ta eslatma bor: hammasi kichik yoki v2 uchun.

## Nima qildim

| Tekshiruv | Natija |
|---|---|
| Toza worktree, `pnpm install --frozen-lockfile`, to'liq build | yashil |
| `apps/hub`, `apps/desktop`, `apps/pos`, `packages/db-local` (unit + sqlite-hub) | **63 fayl, 561 test, hammasi o'tdi** |
| `pnpm lint` | yashil |
| Kodni o'qish | `terminal-proxy.ts`, `terminal-config.ts`, `data-key.ts`, `main.ts` (IPC), `electron-worker.ts`, `lan-server.ts`, `cart-repo.ts`, `security.ts` |

## Diqqat qaratishni so'ragan joylar

- **`terminal-proxy.ts`.**
  - `Host` faqat aniq `127.0.0.1:<port>`: DNS rebinding yopiq.
  - Tashqaridan kelgan `x-mezon-*` olib tashlanadi, kalitni faqat proksi qo'shadi.
  - Pin TLS handshake ichida tekshiriladi (`ca: [certPem]` + `checkServerIdentity`), ya'ni rad etilganda body ketmaydi.
  - **Qo'shimcha tekshirdim:** terminal kompyuteridagi brauzer sahifasi proksiga to'g'ridan-to'g'ri so'rov yuborsa ham, proksi `Origin` va `sec-fetch-site` ni uzatadi. Hub `assertAllowedBrowserOrigin` begona origin'ni 403 qiladi. Shuning uchun proksi kalit qo'shsa ham sahifa hech narsa qila olmaydi, `/auth/login` PIN terish ham.
- **`data-key.ts`.** Buzilgan JSON, noma'lum format yoki noto'g'ri uzunlikdagi kalitda start to'xtaydi, jimgina yangi kalit yaratilmaydi. Yozish atomik (`tmp` + `rename`, `0600`).
- **`mezon:terminal-pair`.** Faqat `needsSetup = true` bo'lsa ulaydi; kirish ma'lumotlari tekshiriladi. Kalit va sertifikat tanasi renderer'ga chiqmaydi (`terminalInfoOf`).
- **`lan-server.ts`.** `OPTIONS` uzatiladi, CORS qarorini asosiy ilovaning hook'i qiladi (u preflight'ni allowlist'siz yopadi). LAN boshqaruvi hamon faqat hub kompyuteridan.
- **`listCarts`.** Kassa bo'yicha filtr bor: `NULL` = hub kassasi.

## Mustaqil mutatsiyalar: 8/9 o'ldi, 1 tasi ekvivalent

| # | Mutatsiya | Natija |
|---|---|---|
| M1 | `listCarts` filtri olib tashlandi | o'ldi (`multi-register`) |
| M2 | proksi `Host` tekshiruvi yo'q | o'ldi |
| M3 | tashqi `x-mezon-*` uzatiladi | o'ldi |
| M4 | proksi har qanday sertifikatga ishonadi (`rejectUnauthorized: false`) | o'ldi |
| M4b | faqat barmoq izi tekshiruvi o'chirildi, CA qoldi | omon qoldi: **ekvivalent**. `ca: [certPem]` boshqa har qanday sertifikatni baribir rad etadi; barmoq izi qo'shimcha himoya qatlami |
| M5 | worker `dataKeyB64` ni e'tiborsiz qoldiradi | o'ldi |
| M6 | buzilgan kalit faylida jimgina yangi kalit | o'ldi |
| M7 | noto'g'ri uzunlikdagi kalit qabul qilinadi | o'ldi |
| M8 | chaqiruvchi kalit sarlavhasini almashtira oladi | o'ldi |

## Eslatmalar (bloklamaydi)

1. **Kalit fayli yo'qolsa.** Buzilgan fayl startni to'xtatadi. Lekin fayl **o'chirilgan** bo'lsa, jimgina yangi kalit yaratiladi. Bazadagi eski shifrlangan maxfiylar (bulut tokeni, LAN kaliti) o'qilmay qoladi va xato keyinroq, chalkash ko'rinishda chiqadi. Taklif: bazada shifrlangan maxfiy bor bo'lsa-yu kalit fayli yo'q bo'lsa, aniq xabar bilan to'xtash (yoki hech bo'lmasa log'da ogohlantirish).
2. **Terminal "ajralish".** `mezon:terminal-leave` faqat lokal konfiguratsiyani o'chiradi, hub'da terminal faol qoladi. Kalit faqat o'sha diskda edi va o'chdi, shuning uchun xavf kichik. Lekin ekranda "egasi hub'da bu kassani bekor qilsin" degan maslahat bo'lsa yaxshi.
3. **`main.ts` IPC testsiz.** `needsSetup` himoyasi va kirish tekshiruvi Electron ichida, unit test bilan qoplanmagan. Qo'lda ikki nusxali sinov qilgansan, v1 uchun yetarli. v2 da IPC handler'larni sof funksiyaga ajratib test qilish mumkin.
4. **`/carts/:id/...` kassa tekshiruvi** — o'zing yozgandek v2. Ro'yxat filtrlangani uchun UI'dan yo'l yo'q.

## Keyingi qadam

PR'lar ochiladi, navbat: C2 (#34) → P2 (#32) → P3 (#33) → C4 → C5 → C6. Har biri QABUL va yashil CI bilan.

---

# Qayta tekshiruv: C1 (`c36c8c0`) — QABUL (kod). Merge: CI yashil bo'lgach

Tekshiruvchi: ishchi2. PR [#30](https://github.com/Shaxobiddin-Github/Mezon/pull/30).

## Mutatsiyalar (bir xil runner, yangi commit)

| Kod | Mutatsiya | Natija |
|---|---|---|
| C1 | rozilik `chat_id` siz | o'ldi |
| C2 | bloklangan yoki kassirga tushirilgan menejerga xulosa | **o'ldi** (S1 testi) |
| C3 | rozilsiz eslatma | o'ldi |
| C4 | o'chirilgan mijozga eslatma | **o'ldi** (S2) |
| C5 | faol emas foydalanuvchi kodi | **o'ldi** (S3) |
| C6 | bekor qilingan bog'lanish ham qaytadi | omon qoldi, **ekvivalent** (kelishilgan) |
| C7 | guruh chatida `/start` | **o'ldi** (S4) |
| C8 | qayta bog'lashda eski bog'lanish qoladi | **o'ldi** (S5) |

Shartlar S1–S5 bajarildi. T2.7a K1–K5 tuzatishlari ham ko'rildi.

## Merge to'xtatildi: CI qizil

`c36c8c0` uchun Verify ubuntu va windows yiqildi. Sababi lint, kod mantig'ida xato yo'q:

```
packages/drivers/src/telegram/telegram-client.ts
  113:44  error  @typescript-eslint/no-unnecessary-type-assertion
  149:17  error  @typescript-eslint/no-unnecessary-type-assertion
```

Bu ikkala xato `eslint --fix` bilan tuzatiladi. Branch sening yo'lagingda, shuning uchun men tegmadim. Tuzatish push qilinib CI yashil bo'lgach, ko'rsatmang bo'yicha squash merge qilaman: `C1: Telegram bot va pilot hujjatlari`.

---

# Tekshiruv: C1 — T2.8 Telegram bot va T3.9 pilot hujjatlari

Tekshiruvchi: ishchi2.
Commit: `0477787` (`claude/C1-telegram-pilot`).

**Xulosa: SHARTLI QABUL.** Kodda xato topmadim. Lekin quyidagi xavfsizlik va maxfiylik himoyalarining **testi yo'q**: kod buzilganda hech bir test yiqilmaydi. PR'ni merge qilishdan oldin quyidagi testlar qo'shilsin (S1–S5). Shundan keyin men qayta mutatsiya qilib, QABUL beraman.

## 1. Build va testlar

- `pnpm install --frozen-lockfile` va to'liq build toza.
- `telegram.test.ts` (PG) va `telegram-client.test.ts`: 2 fayl, 17 test o'tdi.

## 2. So'ralgan nuqtalar

| # | Nuqta | Natija |
|---|---|---|
| 1 | `telegram_orgs_for_chat` / `telegram_active_orgs` | Faqat `organization_id` ni qaytaradi. Funksiyalar egasi `mezon_auth_owner` (NOLOGIN, NOINHERIT, BYPASSRLS emas; T2.1 naqshi). `PUBLIC` dan `EXECUTE` olingan, faqat `mezon_app` ga berilgan. `search_path` qotirilgan. `mezon_auth_owner` ga `cloud_telegram_links` dan SELECT va `USING (true)` beriladi, lekin u login qila olmaydi. **To'g'ri.** |
| 2 | Link id taxmin qilinsa ham boshqa chat rozilik bera olmaydi | UPDATE `organization_id`, `id`, `chat_id`, `kind = 'customer'` va `revoked_at_ms IS NULL` ga bog'langan. `chat_id` Telegram'ning imzolangan update'idan olinadi (webhook siri). **To'g'ri.** C1 mutatsiyasini (`chat_id` sharti olib tashlandi) test ushladi. |
| 3 | Xulosada faqat shu tashkilot ma'lumoti | `getDashboard` `withPgTenantContext` (RLS) ichida, `storeId` siz: tashkilotning barcha do'konlari. Boshqa tashkilot ko'rinmaydi. **To'g'ri.** |
| 4 | Mijoz eslatmasida ortiqcha shaxsiy ma'lumot yo'q | Faqat do'kon nomi, mijoz ismi (80 belgigacha kesiladi), qarz va muddati o'tgan summa. Telefon, cheklar va boshqa mijozlar yo'q. Matn `parse_mode` siz, ism orqali markup kiritib bo'lmaydi. **To'g'ri.** |

Qo'shimcha tekshirdim:
- webhook siri `timingSafeEqual` bilan, uzunlik oldin solishtiriladi;
- bot sozlanmagan bo'lsa 404;
- kod berish route'lari Bearer bilan himoyalangan, shuning uchun CSRF tegishli emas;
- yuborishdan oldin `(link, kind, period)` band qilinadi (UNIQUE);
- xulosa yuborish paytida foydalanuvchi qayta tekshiriladi (`status = 'active' AND role IN ('owner','manager')`);
- eslatma faqat rozilik bergan va o'chirilmagan mijozga ketadi.

## 3. Mustaqil mutatsiyalar (8 ta: 2 o'ldi, 6 omon qoldi)

| Kod | Mutatsiya | Natija |
|---|---|---|
| C1 | rozilik UPDATE `chat_id` ni tekshirmaydi | o'ldi (1) |
| C2 | xulosa **bloklangan yoki lavozimi pasaytirilgan** menejerga ham yuboriladi (`listStaffTargets` dan `status`/`role` sharti olib tashlandi) | **omon qoldi** |
| C3 | rozilsiz eslatma | o'ldi (1) |
| C4 | **o'chirilgan mijozga** eslatma (`c.deleted_at_ms IS NULL` olib tashlandi) | **omon qoldi** |
| C5 | staff kodi faol bo'lmagan yoki kassir foydalanuvchi uchun ham qabul qilinadi (`consumeLinkCode` dagi tekshiruv) | **omon qoldi** |
| C6 | `telegram_orgs_for_chat` bekor qilingan bog'lanishlarni ham qaytaradi | omon qoldi. **Ekvivalent:** keyingi UPDATE'lar `revoked_at_ms IS NULL` ni filtrlaydi, xatti-harakat o'zgarmaydi. Test talab qilinmaydi. |
| C7 | guruh chatida `/start` ishlaydi (`chat.type === 'private'` olib tashlandi) | **omon qoldi** |
| C8 | `bindChat` shu nishonning eski bog'lanishini bekor qilmaydi | **omon qoldi.** Natijada partial UNIQUE indeks INSERT'ni yiqitadi va qayta bog'lash jim xato bo'ladi. |

## 4. Shartlar: merge'dan oldin qo'shiladigan testlar

- **S1 (C2, eng muhimi, maxfiylik).** Menejer xulosaga ulangan. U `blocked` qilinadi yoki `cashier` ga tushiriladi. Keyingi kun 21:00 da unga xulosa **yo'q**, egaga esa bor.
- **S2 (C4).** Rozilik bergan va qarzi bor mijoz o'chiriladi (`deleted_at_ms`). Keyingi hafta eslatma yo'q.
- **S3 (C5).** Staff kodi berilgach foydalanuvchi bloklanadi. `/start <kod>` "kod yaroqsiz" deb javob beradi, bog'lanish yo'q.
- **S4 (C7).** Guruh chatida `/start <kod>`: bog'lanish yo'q, kod iste'mol qilinmaydi.
- **S5 (C8).** Bir mijozga ikkinchi kod va boshqa chat: eski bog'lanish bekor qilinadi, yangisi ishlaydi. Eslatma faqat yangi chatga, bir marta ketadi.

## 5. Kichik izohlar (bloklamaydi)

- Vaqtinchalik Telegram xatosida yetkazish `failed` bo'lib qoladi va o'sha davr ichida qayta urinilmaydi: kunlik xulosa yoki haftalik eslatma yo'qoladi. Bu "spam yo'q" qaroriga mos. Agar egasi uchun muhim bo'lsa, `failed` yetkazishni bir marta qayta urinish mumkin.
- `consumeLinkCode` staff foydalanuvchi faol emasligini aniqlasa ham kodni `used` qiladi. Bu xavfsiz tomonga xato, lekin foydalanuvchi uchun yangi kod kerak bo'ladi.

---

# Tekshiruv: PR #29 — T2.7a biznes kabineti (o'qish qismi)

Tekshiruvchi: ishchi2.
Commit: `110c406` (`gemini/T2.7-cabinet`).

**Xulosa: QABUL.** Bloklovchi xato yo'q. Quyidagi kichik topilmalar keyingi PR'da (C1 yoki T2.7b) tuzatilsin.

## 1. Toza build va testlar

- Alohida worktree'da `pnpm install --frozen-lockfile` va `pnpm verify` yashil:
  - unit + sqlite + pg: 112 fayl, 698 test;
  - perf: 11 fayl, 16 test;
  - E2E: 1;
  - `db:check`: 0 diff;
  - depcruise toza.
- PG testlari haqiqatan ishladi, skip bo'lmadi. Alohida ishga tushirganda `admin-routes`, `auth-refresh-claims`, `report-parity`, `admin-store` va `error-handler` testlari 5 fayl, 32 test bo'lib o'tdi.

## 2. So'ralgan nuqtalar

| # | Nuqta | Natija |
|---|---|---|
| 1 | Refresh rol va holatni bazadan o'qiydi | **To'g'ri.** `rotateRefreshToken` foydalanuvchi qatoridan `role`, `status` va `username` ni o'qiydi. `status` ruxsat ro'yxati bilan tekshiriladi (`active` dan boshqasi rad). Faol bo'lmagan yoki ruxsatsiz rolda butun token oilasi bekor qilinadi. Bekor qilish `throw` dan oldin commit bo'ladi. Admin kanalida `allowedRoles: ['owner','manager']`. Mutatsiyalar R1–R3 o'ldi. |
| 2 | `report-parity.test.ts` haqiqiy ma'lumotni ko'radimi | **Ha.** Haqiqiy hub store'lari bilan savdo, qaytarish, void va chegirma qilinadi, outbox bulutga push qilinadi va hub hamda bulut hisobotlari tiyinigacha solishtiriladi. Bo'sh ma'lumotdan himoya: `days > 0`, `salesCount > 0`, aniq kunlar ro'yxati (R2), void chiqarilgani. S1–S3 mutatsiyalari shu testni yiqitdi. |
| 3 | `cloudErrorHandler` 500 ichki xabarni ochmaydi | **To'g'ri.** 500 da faqat `{"error":"Internal Server Error"}` qaytadi, to'liq xato logga yoziladi. R6 o'ldi. |
| 4 | `admin-store.perf.test.ts` raqamlari | Mening mashinamda: kvitansiyalar 1-sahifa 67,7 ms, 22-sahifa 66,3 ms (chegara 200); dashboard 93,6 ms (chegara 500); 31 kunlik hisobot (53 352 chek) 463 ms (chegara 3000); low-stock 297,6 ms; mahsulotlar sahifasi 26,3 ms (chegara 200). **Low-stock vaqtiga chegara yo'q**, quyidagi K4 ga qarang. |

## 3. Mustaqil oracle

`packages/db-cloud/src/admin-oracle.test.ts` (shu commit'da qo'shildi).

Barcha bulut hisobot bucket'lari `resolveIntlDateKey` ga tayanadi. U natijani 15 daqiqalik slot bo'yicha keshlaydi. Oracle har vaqtni keshsiz, yangi `Intl.DateTimeFormat` bilan hisoblaydi va ikkalasini solishtiradi:
- 8 zona: Tashkent, +05:45, +05:30, 30 daqiqalik DST, −03:30, +12:45 va boshqalar;
- 2000–2040 yillar oralig'ida 32 000 ta tasodifiy vaqt;
- yarim tun va DST o'tishlari atrofida har daqiqa va ±1 ms.

Natija: o'tdi, 15 daqiqalik slot taxmini to'g'ri. **Muhim:** slot 1 soatga oshirilsa (TZ1), PR'ning o'z testlari buni ushlamaydi, faqat oracle ushlaydi. Shuning uchun uni PR'ga qo'shdim.

## 4. Mutatsiyalar (13/13 o'ldi)

| Kod | Mutatsiya | Yiqilgan testlar |
|---|---|---|
| R1 | asosiy `/auth/refresh` rolni standart qiymatdan oladi | 2 |
| R2 | admin refresh `allowedRoles` ni e'tiborsiz qoldiradi | 1 |
| R3 | refresh `status` ni tekshirmaydi | 2 |
| R4 | `requireAdminAuth` kassirni o'tkazadi | 1 |
| R5 | admin login kassirni o'tkazadi | 1 |
| R6 | 500 javobida `err.message` | 1 |
| R7 | refresh CSRF sarlavhasi tekshiruvi yo'q | 2 |
| S1 | kunlik hisobot void savdolarni hisoblaydi | 3 |
| S2 | qaytarish belgisi yo'qoladi | 3 |
| S3 | qaytarish to'lovlari naqddan ayrilmaydi | 1 |
| S4 | mijozlar ro'yxatida telefon maskalanmaydi | 3 |
| TZ1 | kesh sloti 1 soat | 2 (faqat oracle) |
| TZ2 | kun kaliti UTC'da | 4 |

## 5. Topilmalar (bloklamaydi)

- **K1. Noto'g'ri kiritishga 400 o'rniga 500.** Ichki xabar ochilmaydi, lekin status noto'g'ri va logda keraksiz `error` paydo bo'ladi. Probe natijalari:

  | So'rov | Javob |
  |---|---|
  | `dashboard?storeId=not-a-uuid` | 500 |
  | `inventory/low-stock?storeId=not-a-uuid` | 500 |
  | `dashboard?tz=Not/AZone` | 500 |
  | `receipts?cursor=abc:def` | 500 |
  | `receipts?cursor=123:not-a-uuid` | 500 |
  | `customers?cursor=abc:def` | 500 |
  | `products?cursor=abc:def` | 500 |

  Sababi: `parseUuidV7` / `BigInt(...)` / `Intl` xatolari, PG `22P02`. **Tuzatish:** query'lar uchun Zod schema'lar (`storeId: UuidV7Schema`, `tz` — IANA zonalar ro'yxatidan, kursor `^\d+:<uuid>$`).
- **K2. Kunlik hisobotning do'kon/zona filtri o'lik kod.** `DailySalesReportQuerySchema` strict, shuning uchun `storeId` va `tz` "Unrecognized key" bilan 400 qaytaradi. Route esa `rawQuery.storeId`/`tz` ni o'qiydi, lekin unga hech qachon yetib bormaydi. UI ularni yubormaydi. Natijada hisobot doim butun tashkilot bo'yicha va standart zonada. Ko'p do'konli egasi uchun do'kon filtri kerak bo'lsa, schema'ga qo'shilsin. Kerak bo'lmasa, o'lik kod olib tashlansin.
- **K3. JWT endi `cashier` ni qabul qiladi.** Asosiy `/api/v1/auth/login` va `/auth/refresh` rolni cheklamaydi, shuning uchun bulutdagi kassir hisobi `/api/v1/me` va `/api/v1/stores` ga kira oladi. Egasi-only route'lar `role !== 'owner'` ni tekshiradi, eskalatsiya topmadim. `/me` da `role as 'owner' | 'manager'` esa tipni yolg'on qiladi. **Tavsiya:** asosiy kanal uchun ham `allowedRoles` yoki `/me` DTO'ga `cashier`.
- **K4.** `admin-store.perf.test.ts` da low-stock vaqtiga `expect` yo'q (297,6 ms o'lchandi). Chegara qo'shilsin, masalan < 500 ms.
- **K5.** Mijoz qidiruvida (`ILIKE '%…%'`) foydalanuvchi kiritgan `%` va `_` escape qilinmaydi. Xavfsizlik muammosi emas (parametrlangan), faqat qidiruv aniqligiga ta'sir qiladi.

## 6. Merge

QABUL. CI yashil bo'lsa, ko'rsatma bo'yicha squash qilaman: `T2.7a: Biznes kabineti (o'qish qismi)`.
