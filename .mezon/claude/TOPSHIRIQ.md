# Claude topshirig'i: T1.13 rejasi — TUZATISHLAR BILAN TASDIQLANDI

**Merge tekshiruvi:**

- `main` = `20ca6ac`. T1.12 kodi Claude'ning `2dd2c2f` commit'i bilan bir xil. Yagona farq: `catalog.test.ts` dagi vaqt chegarasi 30 s → 60 s. Bu ma'qul.
- `GEMINI.md` = `591085c`.

Reja yaxshi. Quyidagilar tasdiqlandi:

- `SqliteReportStore` sof SQL/DTO, HTTP'ga bog'lanmagan, bulutda qayta ishlatiladi; kontraktlar Zod'da (Python uchun JSON Schema);
- foyda faqat `owner`;
- `exceljs` faqat `apps/hub` da, port orqasida, depcruise bilan;
- ikki bosqichli import, shtrix-kod → nom → yangi moslash, 10 MB / 5 000 qator chegarasi, formulalar qiymat sifatida;
- eksportda tannarx faqat `owner` ga;
- `db.backup()`, smena va kun yakunida avtomatik zaxira, 10 ta nusxa aylanishi, `integrity_check` + SHA-256 + meta;
- tiklashdan oldin xavfsizlik nusxasi, so'ng rebuild va summalar tengligi;
- model testi.

Quyidagi tuzatishlar bilan `gemini/T1.13-reports-backup` branch'ida kodni yoz.

## Majburiy tuzatishlar

### R1. Faqat haqiqiy sxema ustunlari

Rejada `batches.expires_at_ms` va `balance_qty` yozilgan. Haqiqiy sxemada partiya muddati `batches.expiry_date_ms`, partiya qoldig'i esa `local_batch_balances.remaining_qty`. `expires_at_ms` boshqa jadvalda (sessiyalar).

- `products.min_stock` mavjud, yangi ustun kerak emas. Variantlarda bo'lmasa, hisobot mahsulot darajasida.
- **Umumiy qoida:** hisobotlar uchun yangi ustun yoki jadval qo'shma. Kerak bo'lsa, hisobotda sanab ber.

### R2. Tiklash ishlab turgan hub ustida emas, qayta ishga tushirish orqali

Rejada "ulanishlar yopiladi, fayl almashtiriladi va yangi ulanish ochiladi" deyilgan. Ishlab turgan hub'da UoW, ochiq tranzaksiyalar va store'lar eski ulanishni ushlab turadi. Bu yarim tiklangan holatga olib kelishi mumkin.

**Talab:**

1. `POST /backups/:id/restore` faqat **tiklash so'rovini** yozadi: tekshiruvdan o'tgan zaxira, kim, qachon, sabab. So'ng hub'ni xavfsiz to'xtatish signalini beradi.
2. Haqiqiy almashtirish hub **ishga tushishida**, baza ochilishidan oldin bajariladi:
   - joriy bazaning xavfsizlik nusxasi;
   - zaxira faylining SHA-256 va `integrity_check` tekshiruvi;
   - almashtirish;
   - migratsiyalar;
   - rebuild.
3. Electron supervisor hub'ni qayta ishga tushiradi (T0.7 mexanizmi). Dev va test rejimida `createHubServer` opsiyasi orqali chaqiriladi.
4. Ochiq smena yoki ochiq savat bo'lsa, tiklash `409` bilan rad etiladi. Egasi avval smenani yopadi.

### R3. Tiklashdan keyin raqamlar orqaga qaytmasin

Eski zaxira tiklanganda `last_receipt_seq`, `last_return_seq`, `last_shift_seq`, `last_order_seq` va `last_receiving_seq` ham orqaga qaytadi. Shunda yangi cheklar mijozga allaqachon berilgan chek raqamlarini qayta oladi (va F3 da fiskal muammo bo'ladi).

**Talab:**

- Tiklashda xavfsizlik nusxasidagi (ya'ni almashtirishdan oldingi bazadagi) barcha hisoblagichlar o'qiladi.
- Tiklangan bazada har biri `max(zaxiradagi, eskidagi)` ga ko'tariladi.
- `device_seq` (outbox) ham shunday ko'tariladi, chunki F2 sinxronida takror `device_seq` xavfli.
- **Test:** zaxira olinadi → yana 3 ta savdo → tiklash → keyingi chek raqami tiklashdan oldingi oxirgi raqamdan katta.
- **F2 uchun eslatma:** tiklash yo'qotilgan hodisalarni bulutdan qayta olish (bootstrap) talab qiladi. Hozir faqat `GEMINI.md` 4-bo'limidagi ziddiyatlar ro'yxatiga yoz.

### R4. Import tasdig'i mijozga ishonmasin

`POST /catalog/import/commit` mijoz yuborgan `rows` ga ishonmasin.

- Sinov natijasi hub'da `previewToken` bilan saqlanadi: TTL bilan, `LOCAL` jadvalda yoki xotirada. Tasdiqda shu saqlangan natija **qayta tekshiriladi**: oradagi o'zgarishlar va yangi shtrix-kod to'qnashuvlari hisobga olinadi.
- `clientRequestId` bilan idempotent.
- Tasdiq faqat `owner`/`manager` uchun.
- **Test:** sinovdan keyin boshqa yo'l bilan bir shtrix-kod band qilinadi. Tasdiq ziddiyat bilan rad etiladi va hech narsa yozilmaydi.

## Bajarish tartibi

1. T1.13 kodi. Test qarzi yo'q.
2. Lokal `pnpm verify` yashil.
3. Commit qil, push qil va PR och. To'rtala CI job yashil bo'lsin.
4. Hisobot: R1–R4 dalillari, zaxira va tiklash model testi, eksportda tannarx yo'qligi testi, 50 000 tovar va 100 000 chekdagi hisobot vaqti. `[gemini-hisobot] T1.13` bilan commit qil va push qil.
5. `node .mezon/kutish.mjs` ni ishga tushir. Merge qilma.
