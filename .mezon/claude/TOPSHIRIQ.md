# Claude topshirig'i: T1.8 QABUL → T1.9 rejasi

## 1. T1.8 xulosasi: QABUL (kod `519781c`)

Claude tekshirdi:

- **Toza nusxada lokal `pnpm verify` yashil:** 248 test, sxema diff 0, depcruise toza.
- **`packages/db-cloud` va `apps/desktop` ga tegilmagan.** `packages/drivers` da faqat redact ro'yxati o'zgargan. Egasining vaqtinchalik CI qoidasi bo'yicha merge qilish mumkin.
- **Mustaqil model, 220 qadam:**
  - amallar: 2 ta'minotchi, FIFO va o'rtacha tovar, `warn` rejimi; ma'lum va noma'lum narxli kirim, narxni tasdiqlash, naqd sotuv, naqd va karta to'lov (avans bilan), to'liq qaytarish, `±` tuzatish;
  - 47 kirim, 21 tasdiqlash, 19 qaytarish, 36 to'lov, avans holatlari;
  - kutilgan rad etishlar: 8 naqd yetmasligi, 26 tasdiqlangan qatorni qayta tasdiqlash, 10 ortiqcha qaytarish, partiya tugashi, noma'lum narxli qatorni qaytarish;
  - har qadamda ta'minotchi balansi, `debtBalance`, `advanceBalance`, kassa qoldig'i va miqdor saqlanishi model bilan teng;
  - `total_value` va partiya qiymati hech qachon manfiy emas;
  - har 10 qadamda ombor va ta'minotchi rebuild jonli holat bilan teng;
  - rad etilgan qaytarishda ombor holati o'zgarmaydi.
- **Mutatsiya:** 9 tadan 7 tasi ushlandi. E1 `Q_rem` (FIFO va o'rtacha), E2 qiymat chegarasi, avans FIFO, naqd yetmasligi va PII redact ham ushlandi.

### Test qarzi

T1.9 PR'ining birinchi alohida commit'i: `T1.8 test qarzi: qaytarish chegaralari`. Har birini mutatsiya bilan isbotla.

1. **Ortiqcha qaytarish, 1 milli chegara.** `supplier-repo.ts` dagi `quantityToMilli(validQty) > maxRemainingMilli` sharti `> maxRemainingMilli + 1n` ga o'zgartirilganda testlar yiqilmadi.
   - Test: kg tovar, 2.000 kirim. Avval 1.500 qaytariladi.
   - So'ng 0.500 o'tadi. Shundan keyin 0.001 `SUPPLIER_RETURN_QTY_EXCEEDED` bilan rad etiladi.
   - Alohida holat: 1.500 dan keyin 0.501 rad etiladi.
2. **Partiya tugashi, 1 milli chegara.** `stock-repo.ts` dagi `batchAvailMilli < retMilli` sharti `batchAvailMilli + 1n < retMilli` ga o'zgartirilganda testlar yiqilmadi.
   - Test: FIFO partiya 2.000, shundan 0.700 sotilgan, 1.300 qolgan.
   - 1.301 qaytarish `SUPPLIER_RETURN_BATCH_DEPLETED` bilan rad etiladi. 1.300 qaytarish esa o'tadi.

## 2. Merge

CI limiti tiklanguncha egasining qoidasi amal qiladi.

1. `git pull --ff-only`.
2. PR boshi Claude'ning shu topshiriq commit'i bo'lsin.
3. `T1.8: Ta'minotchi, kirim va ta'minotchi qarzi` nomi bilan Squash and merge qil, SHA'ni yoz, branch'ni o'chir.
4. `main`dan `gemini/T1.9-shifts` branch'ini och.

## 3. T1.9 — Smena va kun yakuni: avval REJA

Kod yozma. Rejani `.mezon/gemini/HISOBOT.md` ga yoz, `[gemini-reja] T1.9` bilan commit qil va push qil, so'ng `node .mezon/kutish.mjs` bilan kut.

GEMINI.md T1.9 talablari:

- smena ochish va yopish;
- kutilgan naqd `cash_moves` dan;
- naqdsiz `payments` dan avtomatik;
- sanoq va farq;
- xarajatlar;
- snapshot o'zgarmas.

Mezonlar:

- naqdsiz summa qo'lda kiritilmaydi;
- qayta yopish tarixni saqlaydi;
- ikki kassir farqi ajraladi.

Rejada quyidagilar aniq bo'lsin:

### a) Smena modeli

- **Smena terminalga (`device_id`) bog'lanadi**, chunki kassa qutisi terminalniki.
  - Bir terminalda bir vaqtda faqat bitta ochiq smena.
  - Bitta smenada bir nechta kassir ishlay oladimi, yoki kassir almashsa smena yopiladimi? "Ikki kassir farqi ajraladi" mezoniga mos qaror qil. Tavsiya: smena terminalniki, ichida kassir kesimlari (`shift_cashier_sessions`); farq har kassir topshirgan paytda alohida hisoblanadi.
- **Ochish:** boshlang'ich naqd sanog'i. Avvalgi smenaning yopilish sanog'i bilan farq bo'lsa, qayd etiladi.
- **Jadval sinflari:** `shifts` (MONOTONE: `open` → `closed`), yopilish snapshot'i (FACT), qayta yopish (FACT, eskisini o'chirmaydi). Qaror qil.

### b) Smenaga bog'lash (T1.4–T1.8 dagi `shift_id`)

- `completeSale`, qaytarish, void, qarz to'lovi, ta'minotchiga to'lov va `cash_moves`: ochiq smena bo'lmasa nima bo'ladi? Tavsiya: savdo va naqd harakatlari ochiq smenasiz **rad etiladi** (`SHIFT_NOT_OPEN`). Hozirgi testlarni shunga moslashtir.
- Barcha yangi yozuvlarga `shift_id` yoziladi. Eski (smenasiz) yozuvlar `NULL` qoladi.
- **V1 toraytirish (T1.6 dagi va'da):** void endi faqat **o'sha ochiq smenadagi** chek uchun. Yopilgan smena cheki faqat qaytarish orqali.

### c) Kutilgan summalar va farq

- **Kutilgan naqd** = boshlang'ich naqd + smenadagi `cash_moves` yig'indisi (savdo kirimi, qaytim, qaytarish, qarz to'lovi, ta'minotchiga to'lov, xarajat, inkassatsiya, kirim).
- **Naqdsiz summalar** usullar bo'yicha `payments` va `return_payments` dan avtomatik hisoblanadi. Qo'lda kiritish maydoni umuman bo'lmaydi (mezon). API ham qabul qilmaydi; test bilan isbotla.
- **Sanoq:** kassir haqiqiy naqdni kiritadi (ixtiyoriy kupyura bo'yicha). Farq = sanoq − kutilgan. Farqning sababi; katta farqda supervisor tasdig'i, chegarani konfiguratsiyada saqla.

### d) Xarajat, inkassatsiya va kassaga kirim

- `cash_out` (xarajat, sabab va toifa bilan), `encashment` (inkassatsiya), `cash_in` (kassaga qo'yish).
- T1.5 da nomlangan turlardan foydalan.
- RBAC: kim qila oladi? Naqd yetmasa rad etiladi (T1.6 qoidasi).

### e) Yopish va qayta yopish

- **Yopilish snapshot'i o'zgarmas.** Unda quyidagilar bo'ladi:
  - smena davri;
  - savdolar soni va jami (`v_sales_lines` dan, qaytarishlar bilan);
  - usullar bo'yicha summalar;
  - kutilgan naqd, sanoq va farq;
  - kassir kesimlari.
- **Qayta yopish:** sanoq xato kiritilgan bo'lsa, yangi snapshot yoziladi va eskisi tarixda qoladi. Faqat supervisor, sabab bilan.
- **Smena yopilgandan keyin unga yozib bo'lmaydi.** DB darajasida ham.
- **Kun yakuni (Z-hisobot):** bir kundagi barcha smenalar jamlanmasi. F3 fiskal Z-hisobot keyin ulanadi, buning uchun joy qoldir.

### f) Model testi va idempotentlik

- Ochish, yopish va qayta yopish `clientRequestId` + `request_hash` bilan idempotent.
- **Model testi (kamida 200 qadam, seed'li):**
  - amallar: smena ochish, ikki kassir, savdo (naqd va aralash), qaytarish, void, qarz to'lovi, ta'minotchiga to'lov, xarajat, inkassatsiya, yopish, qayta yopish;
  - har yopilishda kutilgan naqd, usullar bo'yicha summalar va kassir kesimlari mustaqil model bilan tiyinigacha teng;
  - ikki terminal (`device_id`) parallel smenalari bir-biriga aralashmasin.

### g) Unumdorlik

1 000 chekli smenani yopish ≤ 500 ms (lokal).

### h) Doiradan tashqari

- Fiskal Z-hisobot va OFD (F3).
- Chek va hisobot chop etish (T1.12).
- POS UI (T1.11).
