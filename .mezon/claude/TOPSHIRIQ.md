# Claude topshirig'i: T1.7 QABUL → T1.8 rejasi

## 1. T1.7 xulosasi: QABUL (kod `8f29f34`)

Claude tekshirdi:

- **Toza nusxada `pnpm verify`:** 226 test o'tadi.
  - Birinchi ishga tushirishda ikkita eski test (`auth.test.ts` T5, `cart.test.ts` persist) yuklama ostida 5 soniyalik vaqt chegarasidan oshib yiqildi.
  - Alohida ishga tushirilganda ham, ikki marta qayta to'liq ishga tushirilganda ham o'tdi. Bu beqarorlik, quyidagi 3-bandga qarang.
- **Mustaqil FIFO model, 300 qadam:**
  - amallar: 4 mijoz (cheksiz, 50 000, 0 va 200 000 limit), qarzli va qarzsiz savdo, naqd va karta qarz to'lovi, kechirish (manfiy tuzatish), qarzli chekni void qilish va to'liq qaytarish;
  - 58 qarzli savdo, 54 to'lov, 15 qaytarish, 8 void;
  - kutilgan rad etishlar: 11 `CREDIT_LIMIT_EXCEEDED`, 39 `OVERPAYMENT_NOT_ALLOWED`, 25 `SALE_DEBT_HAS_PAYMENTS` va boshqalar;
  - har qadamda har mijoz balansi, ochiq majburiyatlar yig'indisi va har chekning qolgan qarzi model bilan tiyinigacha teng;
  - kassa qoldig'i ham teng; `rebuildCustomerBalances()` jonli balans bilan teng.
- **Mutatsiya:** 12 tadan 8 tasi ushlandi. Biri ekvivalent: kechirilgan chekni void qilishni domen `sale_void` qoidasi ham ushlaydi.

### Test qarzi

T1.8 PR'ining birinchi alohida commit'i: `T1.7 test qarzi: nofaol mijoz, PII redaksiya, test vaqt chegarasi`.

1. **Nofaol mijoz.** `customer-repo.ts` dagi `if (!customer.isActive)` olib tashlanganda testlar yiqilmadi. Test: `isActive = false` mijozga qarzli savdo `409 CUSTOMER_INACTIVE` bilan rad etiladi, hech narsa yozilmaydi. Qarz to'lovi esa qabul qilinadi (rejadagi qaror). Mutatsiya bilan isbotla.
2. **PII redaksiya.** `DEFAULT_LOG_REDACT_PATHS` dan `fullName` yoki `customerName` olib tashlanganda testlar yiqilmadi. Test: ro'yxatdagi **har bir** PII kaliti (`phone`, `phoneNormalized`, `phoneDigits`, `fullName`, `customerName`, `customerPhone`, `note`; tashqi, `*.` va `*.*.` darajalarda) haqiqiy Pino logger orqali `[Redacted]` bo'lishi tekshirilsin. Kalitlar ro'yxatini sikl bilan tekshir, shunda yangi kalit qo'shilganda test ham avtomatik qamraydi.
3. **Beqaror vaqt chegarasi.** Og'ir SQLite testlari bor paketlarda (`db-local`, `hub`) vitest `testTimeout` ni oshir (masalan 30 000 ms). Uzoq testlar (model, benchmark) o'z vaqt chegarasini aniq bersin. Unumdorlik chegaralari (≤ 300 ms va hokazo) esa o'zgarmaydi.

## 2. Merge

1. `git pull --ff-only`.
2. PR #14 boshi Claude'ning shu topshiriq commit'i bo'lsin, to'rtala CI job yashil bo'lsin.
3. `T1.7: Mijoz qarz daftari` nomi bilan Squash and merge qil, SHA'ni yoz, branch'ni o'chir.
4. `main`dan `gemini/T1.8-suppliers-receiving` branch'ini och.

## 3. T1.8 — Ta'minotchi va kirim: avval REJA

Kod yozma. Rejani `.mezon/gemini/HISOBOT.md` ga yoz, `[gemini-reja] T1.8` bilan commit qil va push qil, so'ng `node .mezon/kutish.mjs` bilan kut.

GEMINI.md T1.8 talablari:

- ta'minotchi;
- kirim hujjati;
- tannarx;
- muddat;
- `supplier_ledger`;
- to'lovlar.

Mezon: tannarx noma'lum bo'lsa, qarz taxminan yozilmaydi.

Rejada quyidagilar aniq bo'lsin:

### a) Ta'minotchi

- `suppliers` (ATTR): nomi, STIR (INN, 9 raqam, ixtiyoriy, UNIQUE yoki yo'q, qaror qil), telefon, izoh, faollik.
- PII qoidalari mijozdagi kabi.
- Arxivlash: qarzi bor ta'minotchi bo'yicha qoida.

### b) Kirim hujjati

- **Holatlar:** `draft` → `posted`. Ehtimol `cancelled`, qaror qil.
  - Qoralama tahrirlanadi. Joylangan (posted) hujjat o'zgarmaydi: FACT yoki MONOTONE, sinfni tanla.
  - Joylashdan keyingi xatolar qanday tuzatiladi: teskari hujjat yoki ta'minotchiga qaytarish? Qaror qil.
- **Qatorlar:** tovar va variant, miqdor, tannarx (birlik yoki jami, qaror qil), partiya raqami, yaroqlilik muddati (partiyali tovarda majburiymi?).
- **Joylash bitta tranzaksiyada:** ombor kirimi + `supplier_ledger` + outbox.
  - Ombor kirimi T1.2 dagi `recordInboundMove` ichki funksiyasi orqali o'tsin. Nusxa yo'q, T1.4 b) qoidasi.
- **Differensial test:** kirim hujjatini joylash ombor holatini xuddi shu qatorlar bilan `recordInboundMove` chaqirgandek o'zgartirsin. 6 maydon va partiyalar teng bo'lsin (T1.5 B1 usuli).

### c) Tannarx noma'lum (mezon)

- Qator tannarxsiz joylanishi mumkinmi? Masalan, narx keyin keladi.
- Ruxsat bo'lsa:
  - ombor T1.2 dagi noma'lum tannarx mexanizmi bilan qanday ishlaydi;
  - `supplier_ledger` ga shu qator uchun qarz **yozilmaydi**;
  - keyin tannarx aniqlanganda qarz va tannarx qanday yangilanadi: alohida "narxni tasdiqlash" hujjati.
- Bu oqim to'liq va testlangan bo'lsin: noma'lum → aniq, ombor qiymati va qarz to'g'ri.

### d) `supplier_ledger`

- **Turlar:** boshlang'ich qarz, kirim qarzi, to'lov, qaytarish, tuzatish.
- **Balans = SUM.** Proyeksiya bo'lsa, rebuild testi bo'lsin.
- **Ortiqcha to'lov (avans):** ta'minotchiga oldindan to'lash amalda keng tarqalgan. Ruxsat berilsinmi? Qaror qil.
  - Agar ruxsat bo'lsa, manfiy balans ma'nosi va FIFO qoidalari aniq yozilsin.
- **FIFO va muddat:** T1.7 dagi HLC tartibi va kechikish hisobini qayta ishlat.

### e) Ta'minotchiga to'lov

- Naqd to'lov `cash_moves` da yangi chiqim turi bilan, shu terminalda yoziladi. Naqd yetmasa `INSUFFICIENT_CASH_IN_DRAWER`.
- Naqdsiz to'lov ham qayd etiladi.
- `clientRequestId` + `request_hash` bilan idempotent.

### f) Ta'minotchiga qaytarish (ixtiyoriy)

- Joylangan kirimdan tovarni qaytarish T1.8 ichidami yoki keyinroqmi? Qaror qil.
- Agar T1.8 da bo'lsa:
  - asl partiya va asl tannarx bilan chiqim;
  - `supplier_ledger` dan ayirish;
  - ortiqcha qaytarish rad etiladi.

### g) RBAC, maxfiylik va unumdorlik

- **RBAC:** ta'minotchi, kirim va to'lovlar `owner`/`manager` uchun. Kassir umuman ko'rmaydimi? Qaror qil.
- **Tannarx** faqat ruxsatli rollarga ko'rinadi.
- 100 qatorli kirim hujjatini joylash ≤ 500 ms (lokal).

### h) Model testi

Tasodifiy kirim (shu jumladan tannarxsiz), narxni tasdiqlash, to'lov va qaytarish ketma-ketligida ta'minotchi balansi, ombor qiymati va kassa mustaqil model bilan tiyinigacha teng bo'lsin.

### i) Doiradan tashqari

- Buyurtma (purchase order) va avtomatik buyurtma.
- Smena (T1.9).
- Fiskal (F3).
