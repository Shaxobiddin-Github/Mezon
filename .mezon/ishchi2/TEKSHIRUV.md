# Tekshiruv: C4 — T2.7b kabinet yozuvlari, v1 deploy — QABUL

Tekshiruvchi: ishchi2. Branch: `claude/C4-cabinet-writes` (`82941e2`). Toifa: o'rta.

**Xulosa.** Kod to'g'ri. **QABUL, bitta test sharti bilan (S-C4)**. Merge sharti: S-C4 testi va yashil CI, shu jumladan yangi `deploy-images.yml`. Pastda 3 ta kichik taklif.

## Nima tekshirdim

| Joy | Natija |
|---|---|
| Kabinet foydalanuvchisi | `getActor` faqat `status = 'active'` va owner/manager rolini qaytaradi. Har yozuvda bazadan qayta o'qiladi; bloklangan menejer rad etiladi (test bor). Atribusiya qatori `is_active = false`, PIN yo'q, `kabinet-…` username bilan yaratiladi: kassaga kira olmaydi. Hub'da "bitta owner" cheklovi yo'q (tekshirdim), shuning uchun nofaol owner qatori sinxronda to'qnashmaydi |
| Narx | Faqat `CloudEventWriter` orqali, ya'ni hub push bilan bir xil validatsiya. Kabinet bulut jadvaliga to'g'ridan-to'g'ri yozmaydi. Narx bigint tiyinda, `0..10^12` oralig'ida. Variantli mahsulot rad etiladi. Bir xil narx hech narsa yozmaydi |
| Qurilmani bekor qilish | Faqat owner (menejer 403). `system` qurilma 404, ro'yxatda ham yo'q. Boshqa tashkilot RLS va tenant konteksti bilan to'silgan (test bor) |
| Caddyfile | Bitta domen: `/api/*` va `/health/*` API'ga, qolgani SPA. `X-Forwarded-For` mijozdan olinmaydi (`{remote_host}`). HSTS, nosniff, `X-Frame-Options: DENY` bor |
| `deploy-images.yml` | Ikkala image yig'iladi, admin `index.html` image ichida tekshiriladi, API stack haqiqiy PG bilan `/health/ready` ga yetadi. CI'dagi parollar soxta qiymatlar, sir emas |
| `org:create` | Endi standart parolsiz: test bor |

Testlar: o'zim yurgizdim, PG bilan. `cabinet.test.ts`, `create-org.test.ts`, `hub-cloud-sync.integration.test.ts`, `apps/admin`: **20/20**.

## Mustaqil mutatsiyalar

| # | Mutatsiya | Natija |
|---|---|---|
| C4-M1 | menejer ham qurilmani bekor qila oladi (`role !== 'owner'` tekshiruvi olib tashlandi) | **omon qoldi** |
| C4-M2 | bloklangan foydalanuvchi ham yoza oladi | o'ldi |
| C4-M3 | `system` qurilmani bekor qilish mumkin | o'ldi |

## S-C4 (merge sharti): faol menejer qurilmani bekor qila olmasligini tekshiruvchi test

"Faqat owner bekor qiladi" qoidasi (diqqat qaratishni so'ragan joying) hozir hech qaysi test bilan himoyalanmagan. Sabab: `kab_mgr` oldingi testda bloklanadi, qurilma testida esa menejer bilan urinish umuman yo'q. Agar bo'lganida ham, 403 rol tekshiruvidan emas, `getActor = null` dan kelgan bo'lardi.

Kerakli test: **faol** menejer `POST /api/v1/admin/devices/:id/revoke` → 403, qurilma `active` qoladi. Bu C4-M1 ni o'ldirishi kerak. Fayl seniki, shuning uchun men tegmadim.

## Takliflar (bloklamaydi)

1. **CSP.** Kabinet SPA uchun `Content-Security-Policy` sarlavhasi yo'q. Kabinet ega akkaunti bilan ishlaydi, shuning uchun XSS qarshi qatlam foydali. Masalan: `default-src 'self'; frame-ancestors 'none'; object-src 'none'`.
2. **`kabinet-%` filtri.** `listStaff` username'i `kabinet-` bilan boshlanadigan **haqiqiy** xodimni ham yashiradi. Taklif: hub'da bu prefiksni band qilish yoki filtrni atribusiya belgisiga o'tkazish (masalan, `is_active = false` va PIN yo'q). Kichik.
3. **Narx 0.** Ruxsat etilgan. Agar hub'da 0 narx "bepul" degani bo'lsa, bu to'g'ri. Aks holda kabinetda tasdiq so'rash kerak. Egasiga savol.

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
