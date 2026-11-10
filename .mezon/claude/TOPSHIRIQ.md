# Claude topshirig'i: T1.5 QABUL → T1.6 rejasi

## 1. T1.5 xulosasi: QABUL (kod `b3a940d`)

Claude tekshirdi:

- **Toza nusxada `pnpm verify` yashil:** 191 test, sxema diff 0, depcruise toza.
- **B1 tuzatildi.** Claude'ning differensial testi endi o'tadi: `completeSale` bilan sotilgan tovar `recordOutboundMove` bilan sotilgan egizagi bilan har qadamda bir xil. `warn` rejimi, kamomad, o'rtacha va FIFO tovarlar sinaldi.
- **Pool yuklovchi mutatsiyasi:** to'rtta maydon (`lastUnitCost`, `deficitQty`, `provisionalDeficitValue`, `costVarianceValue`) har biri alohida olib tashlanganda Gemini testlari yiqildi. B2 ham ushlandi.
- **To'lov modeli:** 400 kombinatsiyada yana mos keldi.
- **Ekvivalent mutatsiya:** `batchedKeys` filtri tirik qoldi. Bu ekvivalent, chunki partiyalar so'rovi baribir faqat partiyali tovarlar bo'yicha ketadi. Qoldir.

Test qarzi yo'q.

## 2. Merge

1. `git pull --ff-only`.
2. PR #12 boshi Claude'ning shu topshiriq commit'i bo'lsin, to'rtala CI job yashil bo'lsin.
3. `T1.5: Aralash to'lovlar, qaytim va kassa harakatlari` nomi bilan Squash and merge qil, SHA'ni yoz, branch'ni o'chir.
4. `main`dan `gemini/T1.6-void-return` branch'ini och.

## 3. T1.6 — Bekor qilish va qaytarish: avval REJA

Kod yozma. Rejani `.mezon/gemini/HISOBOT.md` ga yoz, `[gemini-reja] T1.6` bilan commit qil va push qil, so'ng `node .mezon/kutish.mjs` bilan kut.

GEMINI.md T1.6 talablari:

- `voided_at` (MONOTONE);
- to'liq va qisman qaytarish;
- narx asl chekdan olinadi;
- bir tovar ortiqcha qaytmaydi;
- qarzdan ayirish varianti;
- hisobotlar yagona ishorali `v_sales_lines` ko'rinishidan.

Mezonlar:

- ikki marta qaytarish rad etiladi;
- qaytarilgan chekni bekor qilish rad etiladi;
- foyda va tushum hisobi to'g'ri.

Shuningdek GEMINI.md F3: fiskallashgan chek faqat qaytarish orqali bekor qilinadi.

Rejada quyidagilar aniq bo'lsin:

### a) Bekor qilish (void) va qaytarish farqi

- **Void qachon ruxsat etiladi?** Masalan: faqat qaytarishi yo'q chek, faqat menejer yoki supervisor tasdig'i bilan, sabab majburiy. F3 da fiskallashgan chek void qilinmaydi, faqat qaytariladi; hozir buning uchun joy qoldir.
- Ikkinchi void rad etiladi (MONOTONE trigger + domen xatosi).
- **Void oqibatlari bitta tranzaksiyada:**
  - zaxira qaytadi;
  - kassa harakati qaytadi (`refund_cash_out` yoki alohida tur, qaror qil);
  - tegishli outbox yoziladi.
  - FACT jadvallarda o'zgartirish yo'q, faqat kompensatsiya qatorlari.

### b) Qaytarish hujjati

- **Jadvallar:** masalan `returns` va `return_lines` (FACT). Har qator asl `sale_line_id` ga havola qiladi.
- **Qaytarish raqami:** chek raqami ketma-ketligidan foydalanadimi yoki alohida `last_return_seq` bo'ladimi? Qaror qil. F3 da qaytarish ham fiskal hujjat bo'ladi.
- **Qaytariladigan miqdor chegarasi:** `sotilgan − oldin qaytarilgan`. U `BEGIN IMMEDIATE` ichida hisoblanadi. Ikki parallel qisman qaytarish chegaradan oshsa, biri rad etiladi.
- **Summa asl chekdan olinadi**, aksiya va taqsimlangan chegirma hisobga olingan `final_total` dan.
  - Qisman qaytarishda yaxlitlash shunday bo'lsin: qatorning barcha qisman qaytarishlari jami `final_total` ga **aniq teng** bo'lsin. Masalan, kumulyativ usul: `refund_k = round(final × cumQty_k / qty) − round(final × cumQty_{k−1} / qty)`.
  - QQS va tannarx uchun ham xuddi shu usul ishlatilsin.
  - Property test: tasodifiy bo'linishlarda yig'indi aniq teng.

### c) Ombor

- Qaytarilgan tovar qanday tannarx bilan kirim qilinadi?
  - Variant 1: asl sotuvning tannarxi proporsional, asl partiyalarga.
  - Variant 2: yangi "qaytarish" partiyasi asl tannarx bilan.
- Qaror qil va sababini yoz.
- `rebuildProjections()` jonli balans bilan teng bo'lishi shart. T1.5 B1 dagi differensial usulni qo'lla.
- Kamomaddagi tovar qaytarilganda nima bo'ladi, yoz.

### d) Pulni qaytarish

- **Usullar jami = qaytarish summasi.**
- **Har bir usul chegarasi:** shu chekda shu usul bilan to'langan, minus oldingi qaytarishlar.
  - Naqd to'langan chekka karta bilan qaytarishga ruxsat bormi? Qaror qil.
- **Naqd qaytarish** `cash_moves` da `refund_cash_out` bilan, shu terminalda yoziladi.
  - Terminalda naqd yetmasa nima bo'ladi: rad etiladimi, ogohlantiriladimi? Qaror qil.
- **Qarzdan ayirish (T1.7):** hozir T1.5 da qarzli savdo yo'q. Sxema va funksiyada joy qoldir. Rejada qanday ulanishini ko'rsat.

### e) `v_sales_lines` va hisobot

- Yagona ishorali ko'rinish: sotuv qatorlari `+`, qaytarish qatorlari `−`, void qilingan chek qatorlari chiqarib tashlanadi yoki teskari belgilanadi. Qaror qil.
- Tushum, QQS, tannarx va foyda shu ko'rinishdan olinadi.
- **Model testi:** tasodifiy sotuv, qisman qaytarish va void ketma-ketligi uchun jami tushum, tannarx va foyda mustaqil model bilan tiyinigacha teng.

### f) Idempotentlik, RBAC va audit

- Void va qaytarish `clientRequestId` + `request_hash` bilan idempotent, T1.5 dagi kabi.
- **RBAC:** kim qaytarish qila oladi? Kassir faqat supervisor tasdig'i bilanmi? Qaror qil va yoz.
- Sabab majburiy. Audit logda PIN, token va tannarx yo'q.
- Kassir javobida tannarx yo'q.

### g) Mezonlar uchun aniq testlar

- ikki marta qaytarish (to'liq qaytarilgan qatorni yana qaytarish) rad etiladi;
- qaytarishi bor chekni void qilish rad etiladi;
- void qilingan chekni qaytarish rad etiladi;
- parallel qaytarishlar;
- jarayon o'ldirilsa yarim qaytarish qolmaydi (T1.4 dagi child process usuli).

### h) Doiradan tashqari

- Fiskal qaytarish hujjati (F3).
- Mijoz qarzidan ayirish (T1.7 da ulanadi).
- Smena (T1.9).
