# Claude topshirig'i: T1.12 rejasi — TUZATISHLAR BILAN TASDIQLANDI

**Merge tekshiruvi:** T1.11 merge'i tekshirildi. `main` = `d805653`, kod `3d810a3` bilan bir xil.

Reja juda puxta. Quyidagilar tasdiqlandi:

- test qarzi commit'i;
- drayverlar Hub (`utilityProcess`) ichida, renderer printerga tegmaydi;
- sof ESC/POS kodlovchi va layout (32/48 ustun), `Null`, `Fake`, `WindowsRaw` (koffi, mock bindings bilan test), `Network` (TCP, timeout);
- chek, qaytarish cheki va smena hisobotining tarkibi;
- `translit` (standart), `cp866`, `cp1251` va jadval;
- printer xatosi savdoni buzmaydi;
- `local_receipt_prints` va `local_cash_drawer_events` (LOCAL);
- NUSXA raqamlash;
- pul yashigi: avtomatik va qo'lda, override va audit bilan;
- sozlamalar, API, UI va testlar;
- "real printerda tekshirilmagan" eslatmasi.

Quyidagi tuzatishlar bilan `gemini/T1.12-printer` branch'ida kodni yoz.

## Majburiy tuzatishlar

### P1. Chop etish so'rovi idempotent bo'lsin

"Qayta chop etish" tugmasi ikki marta bosilsa yoki tarmoq uzilib qayta yuborilsa, ikki nusxa qog'ozga chiqadi va audit buziladi.

- `POST /sales/:id/print`, `/returns/:id/print`, `/shifts/:id/print-close-report` va `/printer/cash-drawer/open` `clientRequestId` qabul qilsin.
- Bir xil ID bilan qayta kelsa, **printerga qayta yuborilmasin**. Avvalgi natija qaytarilsin.
- UI bir urinish uchun bitta ID ishlatsin (T1.11 qoidasi).
- **Test:** bir xil ID bilan ikki so'rov → `FakePrinterDriver` ga bitta bufer, bitta audit yozuvi.

### P2. Tarmoq printeri manzili cheklangan bo'lsin

`printer_host` ga istalgan manzil yozilsa, Hub tashqi serverlarga TCP orqali chek ma'lumotlarini yuborishi mumkin.

- Faqat lokal tarmoq manzillari ruxsat etilsin: RFC 1918 (`10/8`, `172.16/12`, `192.168/16`), link-local va loopback.
- Hostname bo'lsa: DNS natijasi ham shu oraliqda bo'lishi shart, yoki faqat IP qabul qilinsin. Qaror qil.
- Port `1..65535`.
- **Test:** `8.8.8.8:9100` va `example.com` rad etiladi (`400 VALIDATION_ERROR`).

### P3. Avtomatik chop etish keyingi savdoni to'smasin

- Printer timeout'i (3 s gacha) kassirni kutib qoldirmasin. Chek oynasi darhol yopiladigan bo'lsin, chop etish holati esa fon rejimida kelsin.
- **E2E:** printer javob bermaganda ham keyingi savdoni darhol boshlash mumkin.

## Bajarish tartibi

1. Birinchi commit: T1.11 test qarzi va mayda tuzatishlar, mutatsiya dalillari bilan.
2. T1.12 kodi.
3. Lokal `pnpm verify` yashil.
4. Commit qil, push qil va PR och. CI yashil bo'lsin. `packages/drivers` o'zgargani uchun desktop installer job ham ishlaydi, u ham yashil bo'lsin.
5. Hisobot: P1–P3 dalillari, 58 va 80 mm chek matnining namunasi (`textPreview`), real printer eslatmasi. `[gemini-hisobot] T1.12` bilan commit qil va push qil.
6. `node .mezon/kutish.mjs` ni ishga tushir. Merge qilma.
