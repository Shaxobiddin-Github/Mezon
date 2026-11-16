# Claude xulosasi: T2.3 — QABUL. Keyingi: T2.4 rejasi

## T2.3 — QABUL

Tekshirildi: `3d1ca53` (kod `0723b9e`, `45b9985`). Toza klonda, toza build bilan.

- `MEZON_REQUIRE_PG_TESTS=1 pnpm verify` yashil: 89 fayl, 472 test, perf 12/12, depcruise toza.
- Sinov testlarim: 23 test, shu jumladan 7 ta sinov stsenariysi, hammasi o'tdi.
- Mutatsiyalar: 10 tadan 8 tasi aniqlandi. Ular orasida 23503 va worker `listen()` ham bor, ular avval omon qolgan edi. Bitta mutatsiyaning andozasi topilmadi, chunki kod qayta formatlangan, lekin park tozalashni sinov testim tekshiradi. Bittasi zararsiz: erishib bo'lmaydigan tarmoq.
- PR #23 CI: to'rtala job yashil.
- Soliq profili bulut jufti to'g'ri: RLS `mezon_current_organization_id()` bilan, DELETE grant'i yo'q, `id = organization_id` CHECK bor.

Kichik eslatma: hisobotda RLS `app.current_organization_id` deb yozilgan, kodda esa to'g'ri funksiya ishlatilgan. Hisobotdagi da'volar kod bilan bir xil bo'lsin.

### Merge ko'rsatmasi

1. PR #23 ning **oxirgi commit'i** (shu `[claude]` commit) uchun to'rtala CI job yashil bo'lishini kut.
2. Squash merge: `T2.3: Sinxron push yadrosi`.
3. `main` daraxti PR'ning oxirgi commit'iga teng ekanini tekshir: `git diff <oxirgi-commit> origin/main --stat` bo'sh chiqishi kerak.
4. `gemini/T2.3-sync-push` branch'ini o'chir.
5. `main` dan `gemini/T2.4-sync-pull` ni och.

**Eslatma:** ishchi2 T3.2a ni yozyapti. Uning lokal migratsiyasi `0017` bo'ladi. Ruxsat bilan u o'z yangi sinxron ustunlari uchun bulut juftini ham qo'shadi. ishchi2 fayllariga tegma.

## T2.4 — Pull va pozitsiya: REJA

GEMINI.md 4-bo'limi (Pull, Vaqt, Konfliktlar). **Mezonlar:**

- parallel yozishda hodisa o'tkazib yuborilmaydi (PostgreSQL'da haqiqiy parallel test);
- parked hodisa qayta qo'llanadi.

Hozir **faqat reja** yoz. Rejada quyidagilar bo'lsin.

1. **Kursor modeli.**
   - Pozitsiya har do'kon uchun alohida. Bitta hub o'z tashkilotining bir nechta do'konidan hodisa oladi, demak kursor `{storeId → position}` xaritasi bo'ladi.
   - API shakli: `GET /api/v1/sync/pull`, kursorlar, `limit`, `hasMore`.
   - Kursor hub'da LOCAL jadvalda saqlanadi.
2. **Nima pull qilinadi (qamrov).** Taklif:
   - tashkilot doirasidagi hodisalar barcha do'konlardan;
   - do'kon doirasidagi hodisalar (`stock_moves`, `batches`, `sales` va boshqalar) faqat o'z do'konidan.
   - Asosla. RLS va do'kon filtri bilan test qil: boshqa tenant hodisasi hech qachon kelmaydi.
3. **Echo bostirish.** Hub'ning o'z hodisalari qayta qo'llanmaydi, lekin kursor siljiydi.
   - **Istisno:** server HLC'ni clamp qilgan (`hlc_adjusted`) o'z ATTR hodisasi. Hub lokal qatorining kelajakdagi HLC'sini server qiymatiga tushirishi kerak. Aks holda hub'dagi nusxa LWW'da abadiy g'olib bo'lib qoladi. Test bilan ko'rsat.
4. **Hub'da qo'llash.**
   - FACT: id bo'yicha idempotent INSERT.
   - ATTR: HLC bo'yicha LWW, tombstone va `restored` bilan.
   - MONOTONE: o'tish qoidalari va lokal triggerlar.
   - **Pull qilingan hodisa lokal outbox'ga qayta tushmasligi** kerak, aks holda cheksiz aylanish bo'ladi.
   - Proyeksiyalar (qoldiq va qarzlar) qayta hisoblanadi. To'liq qayta qurish T2.6 da, hozir tegilgan yozuvlar hisoblanadi.
5. **Sinxron rejimidagi triggerlar.** 4-bo'limda: yopiq smenaga kechikib kelgan `sales`, `returns` va `cash_moves` bloklanmaydi, smena yoki `day_close` "eskirgan" deb belgilanadi va konflikt yoziladi. Bu rejim qanday yoqiladi (sessiya bayrog'i yoki ulanish bo'yicha)? Lokal yozuvlarga hech qachon ta'sir qilmasligi isbotlansin.
6. **Atomiklik.** Hodisani qo'llash va kursorni siljitish bitta SQLite tranzaksiyasida bo'ladi. Yarim yo'lda qulasa, qayta pull'da hodisa ikki marta qo'llanmaydi va o'tkazib ham yuborilmaydi. Test: qo'llash o'rtasida ataylab xato chiqariladi.
7. **Hub'dagi park.** Lokal ota yozuv hali yo'q bo'lsa (masalan boshqa do'kondagi mahsulot), hodisa lokal park jadvaliga tushadi va kursor siljiydi. Har siklda qayta uriniladi, N=20 dan keyin Conflict. Bulutdagi `cloud_sync_parked` ham har siklda qayta qo'llanadimi yoki faqat hub'ning qayta yuborishida? Rejada aniq yoz.
8. **Haqiqiy parallel test (PG).** Bir nechta parallel writer (turli qurilmalar, bitta do'kon) push qiladi, shu bilan birga puller pull qiladi. Oxirida pull qilingan hodisalar to'plami accepted to'plamiga aynan teng: o'tkazib yuborilgan ham, takrori ham yo'q. Pozitsiya commit tartibi bilan qanday bog'liqligini (advisory lock commit'gacha ushlab turiladi) testda isbotla.
9. **Ikki hub modeli testi.** Bitta tashkilot, ikki do'kon, ikki hub. Ular oflayn ishlaydi (mahsulot, narx o'zgarishi, savdo, qarz), keyin ikkalasi sinxronlanadi. Oxirida tashkilot doirasidagi ma'lumotlar ikkala hub'da teng bo'lishi kerak.
10. **Worker.** Pull worker push worker bilan bir siklda ishlaydi: avval push, keyin pull. Backoff va 401/403 xatti-harakati push bilan bir xil. `listen()` va `close()` lifecycle testi bo'lsin.
11. **Mutatsiya rejasi:**
    - echo bostirish o'chiriladi;
    - kursor tranzaksiyadan tashqarida siljiydi;
    - do'kon filtri olib tashlanadi;
    - pull qilingan hodisa outbox'ga yoziladi;
    - clamp tuzatishi o'chiriladi;
    - park o'tkazib yuboriladi.

## Bajarish tartibi

1. Merge (yuqoridagi ko'rsatma bo'yicha).
2. Rejani `.mezon/gemini/HISOBOT.md` ga yoz. `[gemini-reja] T2.4` bilan commit qil va `gemini/T2.4-sync-pull` ga push qil.
3. `node .mezon/kutish.mjs` ni yangi branch'da ishga tushir.
