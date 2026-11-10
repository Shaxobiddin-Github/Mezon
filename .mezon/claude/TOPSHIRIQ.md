# Claude topshirig'i: T1.6 rejasi — TUZATISHLAR BILAN TASDIQLANDI

**Merge tekshiruvi:** T1.5 merge'i tekshirildi. `main` = `b59aa87`, kod `bf1a647` bilan bir xil.

Reja juda puxta. Quyidagilar tasdiqlandi:

- `voidSale` va `createReturn` ajratilgan; F3 fiskal darvozasi ilgak sifatida.
- `returns`, `return_lines`, `return_payments` (FACT), alohida `last_return_seq`.
- Kumulyativ taqsimot. QQS uchun `[L, U]` oraliqda clamp qilish ham tasdiqlandi.
- Ombor: Variant 1 (asl partiya va asl tannarx). Kamomad oyoqchasi uchun qaytarish partiyasi.
- Kross-usul qaytarish taqiqlangan. Naqd yetmasa `INSUFFICIENT_CASH_IN_DRAWER`.
- `v_sales_lines`: void qilingan cheklar chiqarib tashlanadi.
- `request_hash` bilan idempotentlik. RBAC: kassir faqat supervisor PIN bilan, foyda faqat `owner` ga.
- Testlar ro'yxati (1–10).

Quyidagi tuzatishlar bilan `gemini/T1.6-void-return` branch'ida kodni yoz.

## Majburiy tuzatishlar

### V1. Void faqat o'sha ish kunida

Void qilingan chek `v_sales_lines` dan butunlay chiqib ketadi. Shuning uchun kechagi chekni bugun void qilish kechagi kun hisobotini orqaga qarab o'zgartiradi. T1.9 da yopilgan smena (Z-hisobot) raqamlari ham shunday o'zgarib qoladi.

**Talab:**

- `voidSale` faqat chek bilan bir xil ish kunida ruxsat etiladi. Ish kuni do'kon vaqt zonasi bo'yicha hisoblanadi, standart `Asia/Tashkent`.
- Eskiroq chek faqat `createReturn` orqali qaytariladi. Xato kodi `VOID_WINDOW_EXPIRED` (409).
- T1.9 da bu qoida "faqat ochiq smenadagi chek" ga toraytiriladi. Izohda yoz.
- **Test:** kun chegarasi. 23:59 dagi chekni 00:01 da void qilish rad etiladi. Vaqt zonasi bilan, `FixedClock` orqali.

### V2. Void va qaytarishda naqd chegarasi bir xil

- `INSUFFICIENT_CASH_IN_DRAWER` tekshiruvi `voidSale` uchun ham ishlasin, faqat `createReturn` uchun emas.
- Naqd usul chegarasi `originalPaid(sale, 'cash')` deganda chekdagi sof naqd summa (`payments.amount`) tushuniladi, `tendered` emas. Shuni kodda va testda aniq ko'rsat.
- **Test:** naqd + karta bilan to'langan chek. Naqd qismidan 1 tiyin ortiq naqd qaytarish rad etiladi.

### V3. `sales` dagi void ustunlari faqat bir marta yoziladi

`void_client_request_id` va `void_request_hash` MONOTONE o'tishga kiradi.

- Trigger ularni `NULL` → qiymat o'tishiga faqat `voided_at_ms` bilan birga ruxsat bersin.
- Keyin ularni, shuningdek `void_reason` va `voided_by_user_id` ni o'zgartirish rad etilsin.
- **Test:** xom SQL bilan har birini void dan keyin o'zgartirish. Void qilinmagan chekka faqat `void_reason` yozish ham rad etiladi.

### V4. Ombor uchun kuchli oracle

Rejadagi 7-test (har qadamda `rebuildProjections` bilan tenglik) ga qo'shimcha ravishda ikki differensial test bo'lsin:

1. **Void ≡ to'liq qaytarish.** Ikkita egizak tovar bir xil tarix bilan olinadi. Biri sotilib void qilinadi, ikkinchisi xuddi shunday sotilib, hamma qatorlari bitta `createReturn` bilan to'liq qaytariladi. Shundan keyin `local_stock_balances` (6 maydon) va `local_batch_balances` aynan teng bo'lsin.
2. **Qisman qaytarishlar ≡ bitta to'liq qaytarish.** Bitta qatorning 3 ta tasodifiy qisman qaytarishi bitta to'liq qaytarish bilan bir xil ombor holatini va bir xil jami `refund`, `vat`, `net` va `cost` ni berishi kerak.

FIFO, o'rtacha va `warn` kamomadli holatlarning har biri, seed'li tasodifiy qadamlar bilan.

### V5. Omborga tegmaydigan qatorlar

- `quick_sale` va `unlimited` tovar qatorlari qaytarilganda yoki void qilinganda `stock_moves` yozilmaydi.
- Pul va `v_sales_lines` esa to'g'ri hisoblanadi.
- Testda ko'rsat.

## Bajarish tartibi

1. T1.6 kodi. T1.5 dan test qarzi yo'q.
2. `pnpm verify` yashil.
3. Commit qil, push qil va PR och. To'rtala CI job yashil bo'lsin.
4. Hisobot: V1–V5 dalillari, 1–10 testlar natijasi, property test soni, qaytarish vaqti (20 qatorli chekni to'liq qaytarish, ≤ 300 ms). `[gemini-hisobot] T1.6` bilan commit qil va push qil.
5. `node .mezon/kutish.mjs` ni ishga tushir. Merge qilma.
