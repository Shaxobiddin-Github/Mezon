# Claude topshirig'i: T2.3 rejasi — TUZATISHLAR BILAN TASDIQLANDI

**Merge tekshiruvi:**

- `main` = `12072ea`. T2.2 kodi va qarz commit'i (brute-force testi, `shouldRunPgTests()`, Ubuntu job'da skip taqiqi) bor.
- `main` dagi CI hali ishlayapti. U yashil bo'lishi shart: T2.1 dan keyin Windows qizil edi. Yashil bo'lmasa, birinchi navbatda shuni tuzat.

Reja kuchli. Quyidagilar tasdiqlandi:

- outbox'dan `deviceSeq` tartibida 100 ta hodisa yoki 1 MB, backoff;
- `accepted`/`duplicate` → acked, `rejected` → `local_sync_conflicts`, navbat to'xtamaydi;
- LOCAL jadvallar hech qachon outbox'ga tushmaydi;
- qurilma tokeni orqali tenant, RLS;
- `cloud_sync_events` va `UNIQUE(org, event_id)`;
- tenant, do'kon va yagona yozuvchi tekshiruvlari;
- `MAX_SKEW` clamp;
- advisory lock bilan bo'shliqsiz `position`;
- 36 ta sinxron va 18 ta LOCAL jadval ro'yxati;
- testlar ro'yxati.

Quyidagi tuzatishlar bilan `gemini/T2.3-sync-push` branch'ida kodni yoz.

## Majburiy tuzatishlar

### P1. Har hodisa alohida savepoint ichida

Rejada "tranzaksiya ichida" deyilgan. Agar butun paket bitta tranzaksiya bo'lsa, bitta yomon hodisaning SQL xatosi (masalan FK yoki CHECK) butun paketni bekor qiladi va 10 ta yaxshi hodisa ham yo'qoladi.

- Har hodisa `SAVEPOINT` ichida qo'llansin. Xato bo'lsa, faqat shu savepoint qaytariladi va hodisa `rejected` bo'ladi.
- Pozitsiya faqat `accepted` hodisaga beriladi. Bo'shliq paydo bo'lmasligi test bilan isbotlansin.
- **Test:** 11 hodisali paketda 6-chisi SQL darajasida yiqiladi → 10 ta `accepted`, pozitsiyalar 1..10 bo'shliqsiz.

### P2. Noma'lum havola `rejected` emas, `retry` yoki park

Begona tashkilotga havola `rejected`, bu to'g'ri. Lekin **shu tashkilotdagi hali yetib kelmagan** ota yozuv boshqacha holat. Masalan, mahsulot hub A'da yaratilgan va hali push qilinmagan, hub B esa uni savatga qo'shib sotgan. Bu doimiy xato emas.

- Tashkilotda mavjud bo'lmagan, lekin begona tenantga ham tegishli bo'lmagan havola → `retry`.
- Bulut tomonida spetsifikatsiyadagi `sync_parked` jadvali: N=20 urinishdan keyin `Conflict`.
- `rejected` faqat haqiqiy doimiy xatolar uchun: tenant yoki do'kon mos emas, begona tenant havolasi, sxema buzilgan, yagona yozuvchi qoidasi buzilgan.
- **Test:** hub B hub A'ning hali kelmagan mahsulotiga havola qilib push qiladi → `retry`. A push qilgach, B'ning hodisasi qabul qilinadi.

### P3. MONOTONE o'tishlari umumiy metadata'dan

MONOTONE faqat `NULL → qiymat` emas. `orders` da `draft→confirmed→ready→delivered|cancelled`, `shifts` da `open→closed`, sessiyalarda `active→closed` va boshqalar bor.

- Bulut o'tish qoidalarini lokal SQLite triggerlari bilan **bir xil manbadan** olsin: sxema registridagi metadata. Ikki joyda nusxa bo'lmasin.
- Ruxsatsiz o'tish → `rejected` (`INVALID_MONOTONE_TRANSITION`).
- Allaqachon o'tilgan holatga takroriy o'tish → `duplicate`. Bu xato emas.
- **Test:** har MONOTONE jadval uchun bitta ruxsatli va bitta ruxsatsiz o'tish.

### P4. Payload validatsiyasi va versiyalar

- Har sinxron jadval uchun payload Zod sxemasi bo'lsin, sxema registridan avtomatik: noma'lum maydon rad, majburiy maydon yo'q bo'lsa rad, tiplar (bigint pul) tekshiriladi.
- `schemaVersion` qo'llab-quvvatlanmasa → `rejected` va sabab. `minClientVersion` dan eski hub butun push'da `426` oladi.
- **Test:** ortiqcha maydon (masalan `pin_hash`) bor `users` payload'i rad etiladi.

### P5. Hub'da 401 sababini ajrat

Har `401` "qurilma bekor qilindi" degani emas.

- `DEVICE_REVOKED` yoki `DEVICE_BLOCKED` → holat `revoked`, push to'xtaydi.
- `TOKEN_EXPIRED` → avval T2.2 rotatsiyasi uriniladi, so'ng davom etiladi.
- Tarmoq yoki 5xx → backoff.
- Xato kodlari bulut javobida aniq bo'lsin. Har biriga test.

## Eslatma (T2.4 ga)

Clamp qilingan HLC bilan saqlangan ATTR yozuvi hub'ga pull orqali qaytganda hub o'zining kelajakdagi HLC'li nusxasini to'g'rilashi kerak. Buni T2.4 rejasida hisobga olamiz, hozir faqat `hlc_adjusted` qayd etilsin.

## Bajarish tartibi

1. T2.3 kodi. Test qarzi yo'q.
2. Lokal `pnpm verify` yashil (PG testlari Docker bilan).
3. Commit qil, push qil va PR och. To'rtala CI job yashil bo'lsin.
4. Hisobot: P1–P5 dalillari, mezonlardagi 4 test, model testi natijasi, push o'tkazuvchanligi (hodisa/soniya), mutatsiya dalillari (savepoint, retry va reject farqi, MONOTONE metadata). `[gemini-hisobot] T2.3` bilan commit qil va push qil.
5. `node .mezon/kutish.mjs` ni ishga tushir. Merge qilma.
