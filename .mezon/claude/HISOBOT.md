# Hisobot: C1 — T2.8 Telegram bot va T3.9 pilot hujjatlari (Claude)

Branch: `claude/C1-telegram-pilot`. **T2.7a (`gemini/T2.7-cabinet`) ustiga qurilgan**, shuning uchun PR o'sha merge bo'lgach toza ko'rinadi.
T2.7b (kabinetdan yozish) P1 dagi bulut "buyruq yozuvchi" portini kutadi, bu PR'da yo'q.

## Reja (qisqa) va qarorlar

| Mavzu | Qaror | Sabab |
|---|---|---|
| Qayerda ishlaydi | Bulutda (`apps/cloud`): webhook + rejalashtiruvchi | Xulosa va qarz bulut ma'lumotidan hisoblanadi |
| Telegram porti | `TelegramClient` (`packages/drivers`), `FakeTelegramClient`, `HttpTelegramClient` (ochiq Bot API) | Testlar tarmoqsiz; matn doim `parse_mode` siz (ism orqali markup kiritib bo'lmaydi) |
| Bog'lash | Kabinet bir martalik kod beradi (15 daqiqa, faqat SHA-256 xeshi saqlanadi); `/start <kod>` | Kod `<org hex>_<sir>` — tenant konteksti refresh token kabi (T2.1); 64 belgidan qisqa |
| Mijoz roziligi | Mijoz ulanadi, lekin "Ha, roziman" bosmaguncha **hech narsa** yuborilmaydi; `/stop` hamma narsani uzadi | GEMINI.md: "rozilik bilan" |
| Takror yuborish | Yuborishdan **oldin** `(link, tur, davr)` bazada band qilinadi (UNIQUE) | Ikki bulut nusxasi yoki qayta ishga tushish xabarni ikki marta yubormaydi |
| Davr | Xulosa: kuniga bir marta, `TELEGRAM_DIGEST_HOUR` (21:00 Toshkent) dan keyin. Eslatma: ISO haftada ko'pi bilan bir marta, `TELEGRAM_REMINDER_HOUR` (10:00) dan keyin | Spam yo'q |
| Bloklangan chat | 403 / "chat not found" → bog'lanish bekor qilinadi | Bloklangan chatga qayta-qayta urinish yo'q |
| RLS ostida chat → tashkilot | `telegram_orgs_for_chat`, `telegram_active_orgs` — SECURITY DEFINER, `mezon_auth_owner` (T2.1 `auth_lookup_login` naqshi) | `mezon_app` boshqa tenantni o'qiy olmaydi |
| Webhook | `X-Telegram-Bot-Api-Secret-Token` doimiy vaqtli taqqoslash; bot sozlanmagan bo'lsa 404 | Token va sir faqat muhit o'zgaruvchisida |

## Yo'l-yo'lakay topilgan va tuzatilgan bo'shliq

- **Kabinetda "muddati o'tgan qarz" doim 0 edi** (T2.7a dan). Endi bulut kassa bilan **bir xil** domen FIFO'sini (`allocateCustomerLedgerFifo`) sinxron qilingan `customer_ledger` ustida ishlatadi (`loadCustomerDebts`). Ro'yxat, tafsilot va qarz eslatmasi shu hisobdan foydalanadi.

## Fayllar

- `packages/drivers/src/telegram/telegram-client.ts` (+ test): port, Fake, HTTP; xatolar `chatUnavailable` / `transient` / `permanent`; tarmoq xatosida token xabarga tushmaydi.
- `packages/db-cloud`:
  - `schema/telegram-tables.ts`;
  - migratsiya `0005_telegram_bot.sql` (**raqam PR #27 dan keyin qayta tekshiriladi**);
  - `telegram-store.ts`, `customer-debt.ts`; `admin-store.ts` da overdue.
- `apps/cloud`:
  - `config.ts` (token va sir birga bo'lishi shart);
  - `telegram-routes.ts`;
  - `telegram/bot-service.ts`, `scheduler.ts`, `messages.ts`;
  - `server.ts` (ulash, `telegramScheduler`); `index.ts` (start);
  - `admin-routes.ts` dan `createRequireAdminAuth` ajratildi.
- `apps/admin`: `TelegramCard` (bosh sahifa), mijoz tafsilotida "Eslatma havolasi".
- `packages/i18n`: 26 kalit (uz-Latn, ru; kirill avtomatik). Testda `{placeholder}` va `/buyruq` til tekshiruvidan chiqarildi, `Telegram` brend sifatida himoyalandi.
- `docs/pilot/`: kassir yo'riqnomasi, nosozliklar kitobi, reliz ro'yxati.

## Testlar

`apps/cloud/src/telegram.test.ts` (PG, Fake Telegram, boshqariladigan soat), 8 ta:

- webhook siri yo'q yoki noto'g'ri → 401, noto'g'ri update e'tiborsiz;
- kassir havola ololmaydi (403); owner `t.me/...?start=` havolasini oladi; kod qayta ishlatilmaydi; muddati o'tgan kod rad etiladi;
- xulosa 20:00 da yo'q, 21:00 da bitta, qayta tick'da yo'q; raqamlar kassa formulasi bo'yicha (foyda `net_ex_vat − cost`);
- mijoz: rozilikdan oldin eslatma yo'q; begona chat va **shu tashkilotdagi boshqa chat** rozilik bera olmaydi; rozilikdan keyin bitta; o'sha hafta qayta yo'q; keyingi hafta bitta; matnda qarz va muddati o'tgani (rus tilida);
- kabinetdagi muddati o'tgan qarz FIFO bo'yicha (5 000 000, 0 emas);
- bloklangan chat bog'lanishni bekor qiladi va qayta urinilmaydi; `/stop` hammasini uzadi;
- boshqa tashkilot o'zganing mijoziga havola ololmaydi (404).

`telegram-client.test.ts`: 9 ta (status → xato turi, `parse_mode` yo'q, token oqib chiqmaydi).

## Mutatsiyalar: 12/12 o'ldirildi

| # | Mutatsiya | Yiqitgan test |
|---|---|---|
| T1 | webhook siri tekshirilmaydi | webhook siri |
| T2 | yuborish band qilish eksklyuziv emas | xulosa bir marta; haftalik eslatma |
| T3 | rozilsiz eslatma | mijoz rozilik |
| T4 | istalgan chat rozilik beradi | shu tashkilotdagi boshqa chat (birinchi variantda omon qolgan, test kuchaytirildi) |
| T6 | kod qayta ishlatiladi | bir martalik kod |
| T7 | kod muddati yo'q | muddati o'tgan kod |
| T8 | bloklangan chat bekor qilinmaydi | bloklangan chat |
| T9 | xulosa soatga qaramaydi | 20:00 da yo'q |
| T10 | eslatma kunlik | o'sha hafta qayta yo'q |
| T11 | kabinet overdue = 0 | FIFO overdue |
| T12 | boshqa tashkilot mijozi qabul qilinadi | 404 |
| T13 | foyda QQS bilan | xulosa raqamlari |

## Tekshiruv

- format, build, lint, typecheck, depcruise (519 modul), `db:check` (lokal va bulut 0 farq) — yashil.
- `apps/cloud`, `packages/db-cloud`, `drivers`, `i18n`, `admin` testlari ketma-ket: **26 fayl, 183 test o'tdi**.

## ishchi2 uchun tekshiruv so'rovi

Chuqur tekshiruv toifasi: auth (webhook, havola kodlari), shaxsiy ma'lumot (mijozga xabar, rozilik), RLS (SECURITY DEFINER funksiyalar). Ayniqsa qarang:

1. `telegram_orgs_for_chat` / `telegram_active_orgs` faqat tashkilot id'sini qaytaradimi, boshqa hech narsani oshkor qilmaydimi.
2. Rozilik callback'i: link id taxmin qilinsa ham boshqa chat rozilik bera olmasligi.
3. Xulosa matnida faqat shu tashkilot ma'lumoti borligi (`getDashboard` storeId'siz: tashkilotning barcha do'konlari).
4. Mijoz eslatmasida mijozning boshqa shaxsiy ma'lumoti yo'qligi.
