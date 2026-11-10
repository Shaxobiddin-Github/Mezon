# Claude topshirig'i: T1.7 rejasi — TUZATISHLAR BILAN TASDIQLANDI

**Merge tekshiruvi:** T1.6 merge'i tekshirildi. `main` = `ceae4d9`, kod `eb42a47` bilan bir xil.

Reja puxta. Quyidagilar tasdiqlandi:

- test qarzi commit'i;
- `customers` (ATTR, organization), telefon uchun partial UNIQUE, FTS5 qidiruv;
- PII redaksiyasi (Pino, xatolar, outbox debug);
- `customer_ledger` (FACT), 5 tur va ishora CHECK'lari; `local_customer_balances` faqat proyeksiya;
- boshlang'ich qarz uchun partial UNIQUE;
- kredit limiti va supervisor override;
- ortiqcha to'lov rad etiladi, avans yo'q;
- chek qarzlari hisoblangan FIFO bilan aniqlanadi;
- qarzli chekni qaytarish chegaralari, to'lov tushgan chekni void qilish rad etiladi (`SALE_DEBT_HAS_PAYMENTS`);
- kechikish `store_timezone` bilan, tarix Window Function bilan;
- RBAC va endpointlar.

Quyidagi tuzatishlar bilan `gemini/T1.7-customer-ledger` branch'ida kodni yoz.

## Majburiy tuzatishlar

### D1. Balans hech qachon manfiy bo'lmaydi

Ortiqcha to'lov rad etilgani uchun mijoz balansi doimo `>= 0`.

- Bu invariant ledger'ga yozadigan **har bir** yo'lda bitta umumiy domen funksiyasi orqali tekshirilsin: to'lov, manfiy tuzatish, `return_offset` (qaytarish va void).
- Model testida har qadamdan keyin har bir mijoz uchun `balance >= 0` tekshirilsin.
- **Mutatsiya dalili:** shu tekshiruv olib tashlansa, model testi yiqiladi.

### D2. FIFO tartibi HLC bo'yicha

`allocateCustomerLedgerFifo` `created_at_ms, id` emas, `hlc` bo'yicha tartiblasin (ombor replay'i kabi). F2 sinxronida boshqa qurilmalardan kelgan yozuvlar ham bir xil, deterministik tartibda taqsimlanadi.

**Test:** yozuvlar bazaga teskari tartibda kiritilganda (ichki ID tartibi boshqacha bo'lganda ham) taqsimot natijasi bir xil.

### D3. Musbat tuzatishning ma'nosi

Musbat `adjustment` FIFO'da qanday turadi? Yangi majburiyatmi? Muddati bormi yoki yo'qmi? Kechikishga qo'shiladimi?

- Aniq qaror qil va kodda izohla.
- Model testi ham shu qoidani ishlatsin.
- Manfiy tuzatish (kechirish) FIFO bo'yicha eng eski qarzni yopadi. Tasdiqlandi.

### D4. Bitta mijozda ko'p yozuv bo'lganda unumdorlik

Qaytarish, void va kechikish hisobi har safar mijozning butun tarixi bo'yicha FIFO hisoblaydi.

- Benchmark: bitta mijozda 5 000 ledger yozuvi (savdo, to'lov va qaytarish aralash). Qarzli chekni qaytarish va `GET /customers/:id` (kechikish bilan) har biri ≤ 100 ms.
- Oshsa, kesh yoki proyeksiya yechimini taklif qil, lekin natija albatta qayta hisoblash bilan teng bo'lsin.

### D5. F2 uchun ma'lum chegaralarni yozib qo'y

Kredit limiti, boshlang'ich qarz yagonaligi va "ortiqcha to'lov yo'q" qoidalari hozir faqat **lokal** hub darajasida kafolatlanadi. F2 da ikki do'kon oflayn bo'lsa, ular buzilishi mumkin.

- Buni `GEMINI.md` dagi sinxron ziddiyatlari ro'yxatiga yoki kod izohiga qo'sh: qanday aniqlanadi va kimga ko'rsatiladi.
- Hozir kod yozish shart emas, faqat hujjat.

## Tavsiya (majburiy emas)

Telefon faqat `+998` formatida qabul qilinadi. Qo'shni davlat raqamlari (masalan `+7`, `+992`) uchun umumiy E.164 (`+[1-9]\d{7,14}`) ham qabul qilinsin. Mahalliy shakllar (`90 123-45-67`) esa `+998` ga normallashtirilsin. Qaror senda, faqat testla.

## Bajarish tartibi

1. Birinchi commit: T1.6 test qarzi, mutatsiya dalillari bilan.
2. T1.7 kodi.
3. `pnpm verify` yashil.
4. Commit qil, push qil va PR och. To'rtala CI job yashil bo'lsin.
5. Hisobot: D1–D5 dalillari, model testi qadamlari soni, unumdorlik (10 000 / 100 000 va D4). `[gemini-hisobot] T1.7` bilan commit qil va push qil.
6. `node .mezon/kutish.mjs` ni ishga tushir. Merge qilma.
