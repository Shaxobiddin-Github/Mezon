# Claude topshirig'i: T1.9 QABUL → T1.10 rejasi

## 1. T1.9 xulosasi: QABUL (kod `4542f69`)

Claude tekshirdi:

- **Toza nusxada lokal `pnpm verify` yashil:** `unit` + `sqlite-hub` 258 test, `perf` 10 test (ketma-ket), sxema diff 0, depcruise toza. `db-cloud` va `desktop` ga tegilmagan.
- **B1 tuzatildi.** Claude'ning mustaqil modeli (260 qadam: 33 smena, 17 kassir almashuvi, 63 savdo, 25 qaytarish, void, kassa harakatlari, 11 qayta yopish) endi haqiqiy quti qoldig'i bilan to'liq mos. Tekshirilgan qiymatlar:
  - `drawerCashBalance` = aktiv sessiya `openingFloat` + sessiya harakatlari;
  - smena `expectedCash` = `opening` + barcha harakatlar;
  - usullar bo'yicha summalar;
  - sessiyalarning kutilgan naqdi;
  - `CASHIER_SESSION_MISMATCH`, `SHIFT_ALREADY_CLOSED` (yopiq smena cheki void qilinmaydi), `SHIFT_NOT_OPEN`.
- **Mutatsiya:** 9 tadan 8 tasi ushlandi. Ushlanganlar: kassir egaligi, farq sababi, supervisor chegarasi, naqd yetarliligi, `DAY_HAS_OPEN_SHIFTS`, `isStale`, void smena tekshiruvi, `strictObject`.

### Test qarzi

T1.10 PR'ining birinchi alohida commit'i: `T1.9 test qarzi: yopiq smenani qayta yopish`.

- `closeShift` dagi `if (shiftRow.status !== 'open')` olib tashlanganda testlar yiqilmadi.
- Test: yopilgan smenaga **yangi** `clientRequestId` bilan `closeShift` chaqirilsa, `409 SHIFT_ALREADY_CLOSED` qaytadi (SQLite xatosi yoki 500 emas). Hech qanday yozuv qo'shilmaydi.
- To'g'ri yo'l `recloseShift` ekani ham testda ko'rinsin.
- Mutatsiya bilan isbotla.

## 2. Merge

CI limiti tiklanguncha egasining qoidasi amal qiladi.

1. `git pull --ff-only`.
2. PR boshi Claude'ning shu topshiriq commit'i bo'lsin.
3. `T1.9: Smena va kun yakuni` nomi bilan Squash and merge qil, SHA'ni yoz, branch'ni o'chir.
4. `main`dan `gemini/T1.10-orders-advance` branch'ini och.

## 3. T1.10 — Buyurtma va avans: avval REJA

Kod yozma. Rejani `.mezon/gemini/HISOBOT.md` ga yoz, `[gemini-reja] T1.10` bilan commit qil va push qil, so'ng `node .mezon/kutish.mjs` bilan kut.

GEMINI.md T1.10 talablari:

- holatlar;
- avans `cash_move` ga tushadi;
- tushum faqat topshirilganda;
- katalogda yo'q tovar qatori.

Mezonlar:

- avans olingan va ishlatilgan kunlarda kassa to'g'ri;
- tushum bir marta.

Rejada quyidagilar aniq bo'lsin:

### a) Buyurtma va holatlar

- **Holatlar:** masalan `draft` → `confirmed` → `ready` → `delivered`, yoki `cancelled`. Jadval sinfi va o'tishlar bir tomonlama bo'lsin.
- **Qatorlar:** katalog tovari yoki katalogda yo'q tovar (nomi, birlik, narx, MXIK ixtiyoriy). Narx buyurtma paytida qotiriladimi yoki topshirishda qayta hisoblanadimi? Qaror qil.
- **Mijoz:** majburiymi? T1.7 `customers` bilan bog'lanish.

### b) Avans

- **Avans olish:** naqd bo'lsa `cash_moves` ga yangi kirim turi, ochiq smena va sessiyaga. Naqdsiz bo'lsa to'lov qaydi.
- **Avans tushum emas, majburiyat.** `v_sales_lines` va smenaning savdo summalariga tushmasin, smena yopilishida alohida qator bo'lib ko'rinsin.
- **Avans qaytarish** (buyurtma bekor qilinsa): kassadan chiqim, naqd yetarliligi tekshiruvi, usul cheklovi (T1.6 qoidasi).

### c) Topshirish = savdo

- Topshirishda `completeSale` orqali haqiqiy chek yoziladi. T1.4 ning yagona yo'li buzilmasin: alohida savdo yo'li yaratilmasin.
- Avans to'lovning bir qismi sifatida hisobga olinadi. Bunda yangi to'lov usuli (masalan `advance`) kerak bo'ladi, u naqd qutiga **qayta** tushmasligi kerak. Qolgan qism odatdagi usullar bilan.
- **Tushum bir marta (mezon):** savdo kunida tushum to'liq summa bilan, avans kunida 0.
- **Avans summadan ko'p bo'lsa:** qaytim yoki qolgan avansni qaytarish qoidasi.
- **Ombor** topshirishda chiqadi, buyurtmada emas. Kerak bo'lsa zaxirani band qilish (rezerv) bo'ladimi? Hozircha tavsiya: rezerv yo'q, hujjatlashtir.

### d) Kassa va hisobotlar

- **Model testi (kamida 200 qadam):** avans olish, avans qaytarish, topshirish, bekor qilish, turli smenalar va kunlar. Har smena yopilishida kassa (naqd harakatlari) va tushum (faqat topshirilganda) mustaqil model bilan teng bo'lsin.
- Avans olingan smena va topshirilgan smena boshqa-boshqa bo'lishi ham testlansin.
- Topshirilgan chekni qaytarish (T1.6) avansli savdoda to'g'ri ishlasin: avans qismi qaysi usul bilan qaytariladi? Qaror qil.

### e) Idempotentlik, RBAC va unumdorlik

- Barcha amallar `clientRequestId` + `request_hash` bilan.
- RBAC: kassir buyurtma va avansni qabul qiladi. Bekor qilish va avansni qaytarish supervisor bilan. Qaror qil.
- Sotuvchi ekranida tannarx yo'q.

### f) Doiradan tashqari

- Yetkazib berish va kuryer (F6).
- Onlayn buyurtma (F6).
- Fiskal (F3).
