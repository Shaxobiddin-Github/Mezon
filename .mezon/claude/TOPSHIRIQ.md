# Claude topshirig'i: T1.8 rejasi — TUZATISHLAR BILAN TASDIQLANDI

**Merge tekshiruvi:** T1.7 merge'i tekshirildi. `main` = `fdd1b80`, kod `e99d8be` bilan bir xil. `ci.yml` o'zgarishi (`68b2db5`) tasdiqlandi.

Reja puxta. Quyidagilar tasdiqlandi:

- T1.7 test qarzi commit'i.
- `suppliers` (ATTR), STIR va telefon uchun partial UNIQUE, PII qoidalari.
- Qoralama (LOCAL) → joylangan hujjat (FACT), bo'shliqsiz `receiving_no`, joylashdan keyin faqat kompensatsiya hujjatlari.
- Jami qator tannarxi kiritiladi, birlik tannarxi emas.
- Noma'lum tannarx uchun qarz yozilmaydi; `receiving_cost_confirmations` (FACT) har qator uchun bir marta.
- **Avans ruxsat etiladi** (manfiy balans). Bu to'g'ri qaror: ta'minotchiga oldindan to'lash amalda keng tarqalgan.
- HLC FIFO, avans keyingi qarzni avtomatik yopadi.
- `supplier_payment_out`, naqd yetmasa rad etiladi. Ta'minotchiga `social_card` bilan to'lov yo'q.
- Ta'minotchiga qaytarish T1.8 ichida, asl partiyadan.
- RBAC faqat `owner`/`manager`.

Quyidagi tuzatishlar bilan `gemini/T1.8-suppliers-receiving` branch'ida kodni yoz.

## Majburiy tuzatishlar

### E1. Narxni tasdiqlash formulasi aniq bo'lsin va ikki oracle bilan isbotlansin

FIFO partiyada `Q_rem` aniq: shu partiyaning qoldig'i. Lekin **o'rtacha tannarxli tovarda** noma'lum narxli kirim umumiy pulga qo'shilib ketadi, undan "qancha qoldi" degan narsa yo'q.

**Talab:**

1. **O'rtacha tannarxli tovar uchun aniq qoida.** Tavsiya:
   `Q_rem = min(max(qtyOnHand, 0), lineQty)`, ya'ni noma'lum kirim eng oxirgi kelgan deb hisoblanadi.
   Boshqasini tanlasang, sababini yoz. Formula sof domen funksiyasida va izohda bo'lsin.
2. **Invariantlar:** `totalValue >= 0`, `remainingValue >= 0`. T1.2 balans tenglamasi tiyinigacha saqlanadi. `rebuildStockProjections()` jonli holat bilan teng.
3. **Oracle A (differensial).** Ikkita egizak tovar olinadi:
   - birinchisi narxi noma'lum holda kirim qilinib, darhol `X` ga tasdiqlanadi;
   - ikkinchisi to'g'ridan-to'g'ri `X` narx bilan kirim qilinadi.
   - Oradagi sotuvlarsiz `local_stock_balances` (6 maydon) va `local_batch_balances` aynan teng bo'lsin.
   - FIFO va o'rtacha tovar uchun alohida.
4. **Oracle B (saqlanish).** Orada sotuvlar, kamomad va qisman sotuv bo'lgan tasodifiy ketma-ketlikda har qadamda quyidagi tenglik tiyinigacha saqlansin:
   `jami kirim qiymati (tasdiqlanganlari bilan) = jami chiqim qiymati + totalValue − provisionalDeficitValue + costVarianceValue`

### E2. Ta'minotchiga qaytarish ombor qiymatini manfiy qilmasin

O'rtacha tannarxli pulda asl kirim narxi bilan qaytarish (`applyOutboundExactCostSync`) joriy o'rtacha narxdan qimmat bo'lishi mumkin. Masalan:

- pul: 10 dona, jami 100 (o'rtacha 10);
- qaytarish: asl narxi 30 bo'lgan 5 dona, ya'ni 150.

Natijada `totalValue` manfiy bo'ladi.

**Talab:**

- Chiqim qiymati pulning mavjud qiymatidan oshmasin. Farq `costVarianceValue` ga yozilsin. Qoidani izohla.
- `supplier_ledger` dagi kamayish esa asl narx bo'yicha qoladi, chunki ta'minotchi bilan hisob asl hujjat bo'yicha.
- **Testlar:**
  - yuqoridagi chegara holati;
  - FIFO uchun differensial: kirim → orada hech narsa yo'q → to'liq qaytarish. Natija kirimdan oldingi ombor holatiga aynan teng.

### E3. Nofaol ta'minotchi

- Nofaol ta'minotchiga yangi kirim joylash `409 SUPPLIER_INACTIVE` bilan rad etiladi.
- To'lov, narxni tasdiqlash va qaytarish esa qabul qilinadi.
- Test va mutatsiya bilan isbotla.

### E4. Model testi kattaroq bo'lsin

60 qadam kam. Kamida **200 qadam**, seed'li va bir nechta ta'minotchi bilan:

- ma'lum va noma'lum narxli kirim;
- tasdiqlash;
- sotuv;
- avansli naqd va karta to'lov;
- qaytarish;
- `±` tuzatish.

Har qadamda tekshiriladi: ta'minotchi balansi, avans, kechikkan summa, kassa, ombor tenglamasi (E1.4). Oxirida ikkala rebuild.

## Ma'lumot uchun (hozir kod shart emas)

- **Kirim QQS'i** (hisobga olinadigan QQS) F3 yoki hisobotlar bosqichida qo'shiladi. Hozir `goods_receiving_lines` ga ixtiyoriy `vat_rate_bp` va `vat_amount` ustunlarini qo'shib qo'yish arzon. Qaror senda.
- `costVarianceValue` jamisi T2 da egasining foyda hisobotida alohida qator bo'lib ko'rinishi kerak. Hozir hech narsa shart emas.

## Bajarish tartibi (CI limiti tiklanguncha egasining qoidasi bilan)

1. Birinchi commit: T1.7 test qarzi, mutatsiya dalillari bilan.
2. T1.8 kodi.
3. Lokal `pnpm verify` yashil.
4. Push qil va PR och. CI ishlamasa, kutma.
5. Hisobot: E1–E4 dalillari, model testi qadamlari soni, 100 qatorli kirim vaqti, lokal `pnpm verify` chiqishi. `[gemini-hisobot] T1.8` bilan commit qil va push qil.
6. `node .mezon/kutish.mjs` ni ishga tushir. Merge qilma.
