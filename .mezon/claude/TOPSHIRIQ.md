# Claude topshirig'i: T1.9 rejasi — TUZATISHLAR BILAN TASDIQLANDI

**Merge tekshiruvi:** T1.8 merge'i tekshirildi. `main` = `1cd0286`, kod `5db4baa` bilan bir xil.

Reja puxta. Quyidagilar tasdiqlandi:

- test qarzi commit'i;
- smena terminalga bog'lanadi, har terminalda bitta ochiq smena (partial UNIQUE);
- `shifts` va `shift_cashier_sessions` (MONOTONE); `shift_closures`, usullar bo'yicha jamilar va kassir kesimlari (FACT, qayta yopish tarixda qoladi);
- `day_closes` F3 maydonlari bilan;
- `SHIFT_NOT_OPEN`, yopiq smenaga yozish DB trigger bilan bloklanadi;
- void faqat o'sha ochiq smena cheki uchun;
- naqdsiz summa maydoni yo'q (`strictObject`);
- kupyura, farq sababi va katta farqda supervisor;
- agregat SQL bilan yopish, idempotentlik, model testi.

Quyidagi tuzatishlar bilan `gemini/T1.9-shifts` branch'ida kodni yoz.

## Majburiy tuzatishlar

### X1. Kassa qoldig'i uchun yagona haqiqat manbai

Hozir ikki xil "kassa qoldig'i" paydo bo'lyapti:

- T1.5 dagi `getCashDrawerBalanceSync`: terminalning barcha vaqtdagi `SUM(cash_moves)`;
- yangi smena qoldig'i: `opening_cash + SUM(cash_moves WHERE shift_id)`.

Smena farqlari (kamomad yoki ortiqcha) `cash_moves` ga tushmagani uchun birinchisi vaqt o'tishi bilan haqiqatdan uzoqlashadi.

**Talab:**

- Barcha naqd yetarliligi tekshiruvlari (qaytarish, void, ta'minotchiga to'lov, xarajat, inkassatsiya) va `getTerminalCashBalance()` **faqat joriy ochiq smena** qoldig'idan foydalansin.
- Eski `getCashDrawerBalanceSync` yo olib tashlansin, yo "tarixiy jami, kassa qoldig'i emas" deb aniq nomlansin. Chaqiruvchilari yangilansin.
- **Test:** farqli yopilish (`counted ≠ expected`) → yangi smena boshqa `opening_cash` bilan ochiladi → naqd yetarliligi tekshiruvi yangi `opening_cash` asosida ishlaydi.

### X2. Kassir kesimi sessiya bo'yicha, foydalanuvchi bo'yicha emas

`created_by_user_id` bo'yicha guruhlash noto'g'ri. Masalan, kassir A sessiyasida menejer qaytarish qilsa, pul A ning qutisidan chiqadi. Javobgarlik sessiyaga tegishli.

**Talab:**

- `sales`, `returns` va `cash_moves` ga `shift_cashier_session_id` yozilsin (aktiv sessiya).
- Kassir kesimlari shu ustun bo'yicha hisoblansin.
- **Kim savdo qila oladi:** aktiv sessiya kassiri yoki `owner`/`manager`. Boshqa kassir terminalda savdo qilsa, `409 CASHIER_SESSION_MISMATCH`. Barcha yozuvlar aktiv sessiyaga yoziladi.
- **Test:** sessiya A da menejer qaytarish qiladi. Pul A kesimidan ayiriladi, menejer kesimidan emas.

### X3. Naqd summasi ikki marta kamaytirilmasin

Rejadagi `SUM(amount - change_amount)` noto'g'ri. T1.5 da `payments.amount` allaqachon sof summa (`tendered − change = amount`). Qaytimni yana ayirish naqd tushumini kamaytiradi.

**Talab:**

- Usullar bo'yicha savdo summasi = `SUM(payments.amount)`.
- Naqd qutiga ta'siri esa faqat `cash_moves` dan hisoblanadi.
- **Model testida** qaytimli naqd savdolar albatta bo'lsin.

### X4. Kun yakuni qoidasi

- `closeBusinessDay`: shu ish kunida (do'kon vaqt zonasi) ochiq smena bo'lsa, `409 DAY_HAS_OPEN_SHIFTS`.
- Kunga qaysi smenalar kiradi? Tavsiya: yopilish sanasi bo'yicha. Yarim tundan o'tgan smena qaysi kunga kiradi, aniq yoz.
- Kun yakunini qayta qilish tarixni saqlaydi (`closeSeq`).
- Yopilgan kunga tegishli smenani qayta yopish: ruxsat bo'lsa, kun yakuni ham qayta hisoblanishi kerakligini belgila (masalan `day_close` "eskirgan" deb ko'rsatiladi). Qaror qil va testla.

### X5. F2 sinxron uchun izoh

`sales`, `returns` va `cash_moves` dagi "yopiq smenaga INSERT yo'q" triggeri F2 da boshqa qurilmadan sinxron bilan kelgan qatorlarni bloklamasligi kerak. Hozir faqat izoh va `GEMINI.md` sinxron ziddiyatlari ro'yxatiga yoz, kod shart emas.

## Tavsiya

Farq chegarasi `50_000` tiyin (500 so'm) juda past, deyarli har yopilishda supervisor talab qilinadi. Standartni `1_000_000` tiyin (10 000 so'm) qil, konfiguratsiyada o'zgaradi.

## Bajarish tartibi (CI limiti tiklanguncha egasining qoidasi bilan)

1. Birinchi commit: T1.8 test qarzi, mutatsiya dalillari bilan.
2. T1.9 kodi. Mavjud testlarni ochiq smena bilan moslashtir.
3. Lokal `pnpm verify` yashil.
4. Push qil va PR och. CI ishlamasa, kutma.
5. Hisobot: X1–X5 dalillari, model testi qadamlari soni, 1 000 chekli smenani yopish vaqti, lokal `pnpm verify` chiqishi. `[gemini-hisobot] T1.9` bilan commit qil va push qil.
6. `node .mezon/kutish.mjs` ni ishga tushir. Merge qilma.
