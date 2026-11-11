# Claude topshirig'i: T1.11 QABUL → T1.12 rejasi

## 1. T1.11 xulosasi: QABUL (kod `ccffc6e`)

Claude tekshirdi:

- **Toza nusxada `pnpm verify` yashil:** 285 + 12 perf test va Playwright E2E. Docker bilan `pg-rls` ham o'tdi.
- **GitHub CI yashil:** ubuntu, windows, PG RLS.
- **API yo'llari:** UI chaqiradigan 24 ta yo'l Hub marshrutlari bilan solishtirildi, hammasi mavjud. Savdo faqat `POST /carts/:id/complete` orqali o'tadi.
- **Skrinshot:** savdo va chek oynasi ishlaydi, "SINOV — FISKAL EMAS" ko'rinadi.
- **Nishonli mutatsiya:** 4 tadan 2 tasi ushlandi:
  - skaner oraliq chegarasi (30 ms → 150 ms);
  - dev CORS bayrog'i (bayroqsiz yoqilsa).

### Test qarzi va mayda tuzatishlar

T1.12 PR'ining birinchi alohida commit'i: `T1.11 test qarzi: skaner chegaralari, diagnostika paneli, E2E skrinshot yo'li`.

1. **Skaner, minimal uzunlik.** `keyCount >= minLength && buffer.length >= minLength` sharti olib tashlanganda testlar yiqilmadi.
   - Test: 2–3 belgi juda tez (≤ 10 ms) va Enter kelsa, bu skan **emas**.
   - Masalan, klaviatura "rollover"i yoki tez bosilgan `+` va Enter.
2. **Skaner, Enter kechikishi.** Tugatuvchigacha bo'lgan oraliq tekshiruvi (`gapToTerminator <= maxInterKeyMs`) olib tashlanganda testlar yiqilmadi.
   - Test: 13 belgi tez keladi, lekin Enter 500 ms dan keyin bosiladi. Bu skan **emas**: odam tez yozib, keyin o'ylab Enter bosgan.
   - Har ikki test mutatsiya bilan isbotlansin.
3. **Diagnostika paneli kassirga ko'rinmasin.** Skrinshotdagi savdo ekranining tepasida T0.7 dan qolgan texnik qator bor: "Hub holati ready, http://127.0.0.1:…, Qayta ishga tushishlar, /health javobi, Sozlash kerakmi: false", hamda "Tekshiruvni yangilash" tugmasi.
   - Bu kassir uchun emas. Alohida "Diagnostika" oynasiga ko'chir (masalan `Ctrl+Shift+D` yoki sozlamalar ichida, faqat `owner`/`manager` uchun).
   - Savdo ekranida kassir, smena, mavzu, `F1` va chiqish qolsin.
4. **E2E skrinshoti git'dagi faylni o'zgartirmasin.** Hozir `pnpm verify` har safar `.mezon/gemini/pos-sales-screen.png` ni qayta yozadi va ish nusxasini "o'zgargan" holatga keltiradi.
   - Skrinshot `apps/pos/test-results/` (`.gitignore` da) ga yozilsin.
   - `.mezon/` ga faqat hisobot uchun qo'lda qo'yiladi.

## 2. Merge

1. `git pull --ff-only`.
2. PR boshi Claude'ning shu topshiriq commit'i bo'lsin, CI yashil bo'lsin.
3. `T1.11: Kassa UI` nomi bilan Squash and merge qil, SHA'ni yoz, branch'ni o'chir.
4. `main`dan `gemini/T1.12-printer` branch'ini och.

## 3. T1.12 — Printer va chek: avval REJA

Kod yozma. Rejani `.mezon/gemini/HISOBOT.md` ga yoz, `[gemini-reja] T1.12` bilan commit qil va push qil, so'ng `node .mezon/kutish.mjs` bilan kut.

GEMINI.md T1.12 talablari:

- `PrinterDriver`: Windows uchun koffi orqali `winspool.drv` RAW; tarmoq uchun TCP 9100;
- real printerda sinov natijasi hisobotda;
- ESC/POS, 58 va 80 mm;
- pul yashigi;
- kod sahifasi yoki transliteratsiya siyosati;
- printersiz rejim.

Mezonlar:

- bayt snapshot testlari;
- printer xatosi savdoni buzmaydi;
- qayta chop etish belgilanadi.

Rejada quyidagilar aniq bo'lsin:

### a) Qatlamlar

- **ESC/POS kodlovchi:** sof funksiya, `packages/drivers` yoki alohida paket. Chek ma'lumoti (`StoredSaleRecord` → `ReceiptDocument`) baytlarga aylanadi. Bayt snapshot testlari bilan.
- **Drayverlar:**
  - `WindowsRawPrinterDriver` (koffi + `winspool.drv`: `OpenPrinter`/`StartDocPrinter`/`WritePrinter`);
  - `NetworkPrinterDriver` (TCP 9100, timeout bilan);
  - `NullPrinterDriver` (printersiz rejim);
  - `FakePrinterDriver` (testlar uchun).
- **Qayerda ishlaydi:** Electron main yoki hub utilityProcess? Renderer'dan to'g'ridan-to'g'ri **emas** (xavfsizlik). IPC yoki Hub endpoint orqali. Qaror qil.

### b) Chek tarkibi

- **Ma'lumotlar:** do'kon nomi, chek kodi, sana va vaqt (`store_timezone`), kassir, qatorlar (nomi, miqdor × narx, chegirma, QQS stavkasi), jami, QQS jami, to'lovlar, qaytim, qarz.
- **"SINOV — FISKAL EMAS"** belgisi F3 gacha majburiy.
- **58 va 80 mm** kengliklari, uzun nomlarni o'rash, ustunlarni tekislash.
- **Qaytarish cheki** (T1.6) va **smena yopilish hisoboti** (T1.9) ham chop etilsin.

### c) Kod sahifasi va o'zbek harflari

- Oʻ, gʻ, ʼ va kirill harflari ko'p printerlarda yo'q.
- **Siyosat:** printerda mos kod sahifasi bo'lsa (CP866 yoki CP1251) uni ishlat; bo'lmasa transliteratsiya qil (`oʻ` → `o'` va hokazo). Qaror va jadval rejada bo'lsin.
- Snapshot testlari ikkala yo'lni qamrab olsin.

### d) Xatolar va qayta chop etish

- Printer xatosi (o'chiq, qog'oz tugagan, timeout) **savdoni buzmaydi**: chek bazada saqlanadi, UI ogohlantiradi va "qayta chop etish" taklif qiladi.
- **Qayta chop etish:** chekda "NUSXA" belgisi bo'ladi. Har bir chop etish urinishi audit yozuviga tushadi: `receipt_prints` (FACT yoki LOCAL, qaror qil) — kim, qachon, nechanchi nusxa, natija.
- **Pul yashigi:** naqd to'lovda avtomatik ochiladi, ESC/POS impulsi bilan. Qo'lda ochish ruxsat bilan va audit bilan.

### e) Sozlamalar va UI

- Printer tanlash (Windows printerlari ro'yxati yoki IP:port), kenglik, kod sahifasi, avtomatik chop etish yoqish/o'chirish, sinov cheki.
- `owner`/`manager` uchun.

### f) Real printerda sinov

Egasida printer bo'lmasligi mumkin. Hisobotda "real printerda tekshirilmagan" deb aniq yoz. Real sinov F1 yakunidagi bir kunlik simulyatsiyada qilinadi.

### g) Doiradan tashqari

- Fiskal chek va QR (F3).
- Android printeri (T4.4).
- Har terminalning o'z printeri (T4.3).
