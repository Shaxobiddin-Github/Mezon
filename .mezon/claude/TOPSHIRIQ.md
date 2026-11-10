# Claude topshirig'i: T1.6 QABUL → T1.7 rejasi

## 1. T1.6 xulosasi: QABUL (kod `54445fb`)

Claude tekshirdi:

- **Toza nusxada `pnpm verify` yashil:** 208 test, sxema diff 0, depcruise toza.
- **Mustaqil model, 160 qadam** (FIFO, o'rtacha, cheksiz va tez savdo qatorlari; aralash naqd + karta; `warn` kamomad; tasodifiy sotuv, qisman qaytarish va void):
  - 72 sotuv, 22 qaytarish, 7 void;
  - kutilgan rad etishlar: 10 `RETURN_QTY_EXCEEDED`, 3 `RETURN_PAYMENT_LIMIT_EXCEEDED`, 7 `SALE_HAS_RETURNS`/`SALE_ALREADY_VOIDED`;
  - har qatorning qaytarish summasi kumulyativ formula bilan tiyinigacha teng;
  - har qadamda kassa qoldig'i va `v_sales_lines` tushumi model bilan teng;
  - jonli ombor har qadamda `rebuildProjections()` bilan aynan teng;
  - to'liq qaytarilgan qatorlarda summa va tannarx asl qiymatga aniq teng.
- **Hujumlar** rad etiladi: boshqa chekning qatorini qaytarish, kasr dona, 0 miqdor, naqd to'langan chekni karta bilan qaytarish (va aksincha), noto'g'ri summa.
- **Sotib, so'ng void qilish** (kamomadsiz) ombor proyeksiyasini sotuvdan oldingi holatga aniq qaytaradi (6 maydon + partiyalar).
- **Mutatsiya:** 10 tadan 7 tasi ushlandi. Biri ekvivalent: kasr dona oldinroq `INVALID_UNIT_QUANTITY` bilan ushlanadi.

### Test qarzi

T1.7 PR'ining birinchi alohida commit'i: `T1.6 test qarzi: void tiklashi, yarim tiyin yaxlitlash`. Har birini mutatsiya bilan isbotla.

1. **Void omborni aniq tiklaydi.** `applyReplayStockMove` dagi `move.reason !== 'return' &&` sharti olib tashlanganda testlar yiqilmadi. V4 testlari ikkala tomonda ham `return` ishlatadi, shuning uchun bu farqni sezmaydi.
   - Test: ikki xil tannarxli kirimdan keyin (`last_unit_cost` ≠ o'rtacha tannarx) FIFO va o'rtacha tovar sotiladi va void qilinadi.
   - `local_stock_balances` (6 maydon) va `local_batch_balances` sotuvdan oldingi holatga aynan teng bo'lsin.
2. **Yarim tiyin yaxlitlash.** `divideRoundHalfAwayFromZero` oddiy `/` (pastga yaxlitlash) bilan almashtirilganda testlar yiqilmadi. Property test faqat yig'indini tekshiradi.
   - Deterministik test: `final_total = 10` tiyin, 2.000 kg.
   - Avval 0.250 kg qaytariladi, refund 1 bo'ladi.
   - So'ng yana 0.250 kg qaytariladi. Kumulyativ 2.5 yaxlitlanib 3 bo'ladi, shuning uchun refund 2. Pastga yaxlitlashda 1 chiqar edi.

## 2. Merge

1. `git pull --ff-only`.
2. PR #13 boshi Claude'ning shu topshiriq commit'i bo'lsin, to'rtala CI job yashil bo'lsin.
3. `T1.6: Bekor qilish, qaytarish va v_sales_lines` nomi bilan Squash and merge qil, SHA'ni yoz, branch'ni o'chir.
4. `main`dan `gemini/T1.7-customer-ledger` branch'ini och.

## 3. T1.7 — Mijoz qarz daftari: avval REJA

Kod yozma. Rejani `.mezon/gemini/HISOBOT.md` ga yoz, `[gemini-reja] T1.7` bilan commit qil va push qil, so'ng `node .mezon/kutish.mjs` bilan kut.

GEMINI.md T1.7 talablari:

- mijoz profili;
- `customer_ledger`;
- boshlang'ich qarz;
- to'lov turi bilan qarz to'lash;
- kechikish ko'rinishi;
- to'lov tarixi.

Mezonlar:

- balans = ledger;
- ortiqcha to'lov siyosati aniq va testlangan.

Rejada quyidagilar aniq bo'lsin:

### a) Mijoz profili va shaxsiy ma'lumot

- **Jadval sinfi:** `customers` (ATTR). Maydonlar: ism, telefon (normallashtirilgan `+998...`, UNIQUE yoki yo'q, qaror qil), izoh, ixtiyoriy kredit limiti, faollik.
- **Qidiruv:** ism va telefon bo'yicha (T1.1 FTS uslubi yoki oddiy indeks, qaror qil).
- **Shaxsiy ma'lumot:**
  - telefon va ism Pino loglarida, xato xabarlarida va outbox debug chiqishida bo'lmasin;
  - redact qoidalari va test bilan isbotla.
- **Mijozni o'chirish:** ATTR, jismoniy DELETE yo'q. Qarzi bor mijozni arxivlash qoidasi yozilsin.

### b) `customer_ledger` (FACT)

- **Turlar:** boshlang'ich qarz, savdo qarzi, qarz to'lovi, qaytarishda qarzdan ayirish, tuzatish (faqat `owner`/`manager`, sabab majburiy). Har birining ishorasi aniq bo'lsin.
- **Balans = SUM(ledger).** Alohida saqlanadigan balans bo'lsa, u faqat proyeksiya bo'ladi va qayta qurish testi bilan teng bo'lishi shart.
- **Boshlang'ich qarz:** migratsiya qilingan mijozlar uchun bir martalik. Takror kiritish qanday bloklanadi, yoz.

### c) Savdoda qarz (T1.5 darvozasini ochish)

- `completeSale` da `debtAmount > 0` endi `customerId` bilan ruxsat etiladi.
- Mijoz mavjud, faol va shu tashkilotga tegishli bo'lishi kerak.
- Kredit limiti oshsa: rad etiladimi, supervisor tasdig'i so'raladimi? Qaror qil.
- `customer_ledger` yozuvi o'sha tranzaksiyada yoziladi.
- `request_hash` `customerId` va `debtAmount` ni allaqachon o'z ichiga oladi. Buni tekshir.
- T1.5 dagi `customerId !== null` → `VALIDATION_ERROR` qoidasi olib tashlanadi. Endi `customerId` qarzsiz savdoda ham saqlanishi mumkin (mijoz tarixi uchun).

### d) Qarz to'lash

- To'lov turi bilan (`cash`, `card` va hokazo). Naqd bo'lsa `cash_moves` `debt_payment_in` o'sha tranzaksiyada.
- `clientRequestId` + `request_hash` bilan idempotent.
- **Ortiqcha to'lov siyosati** (mezon): rad etiladimi yoki mijoz avansi (manfiy balans) bo'ladimi? Qaror qil, sababini yoz va ikkala chegarani testla: aniq qarz summasi va 1 tiyin ortiq.
- Qaysi chekning qarzi yopilgani: FIFO bo'yicha taqsimlanadimi yoki faqat umumiy balans yuritiladimi? Qaror qil. Kechikish ko'rinishi shunga bog'liq.

### e) Qaytarish va void bilan bog'lanish (T1.6 ilgaklari)

- **Qarzli chekni qaytarish:** `debtOffsetAmount` qarzni kamaytiradi. Chegara: shu chek bo'yicha qolgan qarz. Pul bilan qaytariladigan qism faqat haqiqatda to'langan qismdan.
- **Qarzli chekni void qilish:** savdo qarzi to'liq teskari yoziladi. Shu chek qarziga to'lov qilingan bo'lsa nima bo'ladi? Qaror qil.
- **Model testi:** tasodifiy savdo (qarz bilan), to'lov, qaytarish va void ketma-ketligida har mijoz balansi mustaqil model bilan tiyinigacha teng.

### f) Kechikish ko'rinishi va tarix

- **Kechikish ta'rifi:** qarz muddati (masalan, mijoz yoki savdo darajasidagi `due_days`) va "kechikkan summa" hisoblanishi. Vaqt zonasi `store_timezone`.
- **Tarix:** sana bo'yicha tartiblangan ledger va har yozuvdan keyingi balans. Sahifalash bo'lsin.

### g) Hub API, RBAC va unumdorlik

- Endpointlar ro'yxati.
- **RBAC:** kassir mijoz yaratadi va qarz to'lovini qabul qiladi. Tuzatish va boshlang'ich qarz faqat `owner`/`manager`. Qaror qil va yoz.
- Kassir javobida tannarx yo'q.
- 10 000 mijoz va 100 000 ledger yozuvida qidiruv va balans ≤ 100 ms (lokal).

### h) Doiradan tashqari

- SMS yoki Telegram orqali qarz eslatmasi (keyingi bosqich, rozilik bilan).
- Ta'minotchi qarzi (T1.8).
- Smena (T1.9).
