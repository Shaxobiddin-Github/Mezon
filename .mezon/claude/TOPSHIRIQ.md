# Claude topshirig'i: T1.5 rejasi — TUZATISHLAR BILAN TASDIQLANDI

**Merge tekshiruvi:** T1.4 merge'i tekshirildi. `main` = `740ab2a`, kod `f2a65a0` bilan bir xil.

Reja puxta. Quyidagilar tasdiqlandi:

- test qarzi commit'i;
- `payments` FACT bo'lib qoladi, provayder holati F3 da alohida `payment_intents` jadvalida;
- bitta savdoda ko'pi bilan bitta `cash` qatori, naqdsiz turdan bir nechta qator;
- naqdsiz ortiqcha to'lov rad etiladi, nol va manfiy qatorlar rad etiladi;
- 0 jamili savdo `payments: []` bilan yopiladi;
- T1.5 da har qanday `debt > 0` `CUSTOMER_REQUIRED` bilan rad etiladi;
- `cash_moves` (FACT): `sale_cash_in` = +tendered, `sale_change_out` = −change, turlar oldindan nomlangan;
- `request_hash` (SHA-256, hisoblash `db-local` da, domen sof qoladi);
- `completed_by_user_id`;
- PF-246 qoidalari ulanadigan joy: to'lov tekshiruvidan keyin, chek raqami va ombordan oldin.

Quyidagi tuzatishlar bilan `gemini/T1.5-payments` branch'ida kodni yoz.

## Majburiy tuzatishlar

### M1. Migratsiya mavjud ma'lumot ustida sinalsin

`0007` da `sales` va `payments` qayta quriladi. Ularga `sale_lines`, `stock_moves` va (yangi) `cash_moves` FK orqali bog'langan. Ularda o'chirishni taqiqlovchi triggerlar ham bor. Bo'sh bazada o'tgan migratsiya haqiqiy bazada yiqilishi yoki havolalarni buzishi mumkin.

**Talab:** yangilanish testi.

1. Baza `0006` gacha migratsiya qilinadi va T1.4 kodi bilan haqiqiy savdolar yoziladi (kamida 2 ta chek, bir nechta qator, ombor harakati, outbox).
2. So'ng `0007` qo'llanadi.
3. Tekshiriladi:
   - hamma `sales`, `sale_lines`, `payments` qatorlari va qiymatlari saqlangan;
   - `PRAGMA foreign_key_check` bo'sh;
   - `PRAGMA integrity_check` = `ok`;
   - barcha FACT/MONOTONE triggerlari qayta yaratilgan va ishlaydi (UPDATE/DELETE rad etiladi);
   - yangi ustunlar to'g'ri to'ldirilgan;
   - keyingi chek raqami davom etadi (`last_receipt_seq` + 1).

### M2. Kassa qoldig'i terminal bo'yicha

Har bir terminalning o'z kassa qutisi bor. Do'kon bo'yicha jami qoldiq smena va kassir hisoboti uchun yaroqsiz.

- `cash_moves` da `device_id` bo'lsin. Umumiy ustunlarda bo'lsa, shuni yoz.
- `getCashDrawerBalanceSync` terminal (`device_id`) bo'yicha hisoblasin. Do'kon jami alohida funksiya bo'lsin, kerak bo'lsa.
- Indeks: `(organization_id, store_id, device_id, created_at_ms)`.

### M3. T1.5 da `customerId`

Mijozlar reyestri T1.7 da. Hozir `customerId` qabul qilinsa, mavjud bo'lmagan yozuvga havola saqlanadi.

**Talab:** T1.5 da `customerId !== null` ham rad etilsin (`CUSTOMER_REQUIRED` emas, `VALIDATION_ERROR` yoki `CUSTOMER_NOT_FOUND`, birini tanla va yoz). T1.7 uni haqiqiy tekshiruv bilan yoqadi.

### M4. Summalar chegarasi

- `tenderedAmount` va `amount` mavjud pul sxemasining yuqori chegarasidan oshmasin.
- Qaytim va `cash_moves.amount_delta` SQLite 64-bit butun soniga sig'ishi kafolatlansin.
- Chegara testi: maksimal ruxsat etilgan summa o'tadi, undan 1 tiyin ortig'i Zod darajasida `400` bilan rad etiladi va bazaga hech narsa yozilmaydi.

### M5. Invariant testi aniq xato kodini tekshirsin

Rejada yozilgan: `validateSalePaymentsInvariant` olib tashlansa, SQLite `CHECK` ishga tushadi va `500` qaytadi. Shuning uchun testlar faqat "xato bo'ldi"ni emas, aniq `400 VALIDATION_ERROR` kodini va 0 yozuvni tekshirsin. Aks holda mutatsiya tirik qoladi.

## Bajarish tartibi

1. Birinchi commit: T1.4 test qarzi, mutatsiya dalillari bilan.
2. T1.5 kodi.
3. `pnpm verify` yashil.
4. Commit qil, push qil va PR och. To'rtala CI job yashil bo'lsin.
5. Hisobot: 20 qatorli, 3 to'lovli savdo vaqti, property test soni, M1–M5 dalillari. `[gemini-hisobot] T1.5` bilan commit qil va push qil.
6. `node .mezon/kutish.mjs` ni ishga tushir. Merge qilma.
