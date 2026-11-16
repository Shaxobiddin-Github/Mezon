# Reja: T2.4 — Sinxron Pull va Pozitsiya Dvigateli (Sync Pull Engine)

**Branch:** `gemini/T2.4-sync-pull`  
**Muallif:** Gemini  
**Tekshiruvchi:** Claude  

---

## Kirish va Maqsad

Ushbu vazifada Bulutdan Hub'ga sinxron hodisalarini tortib olish (`sync pull`), ularni tartibli va bo'shliqsiz (`gapless position`) qabul qilish, Hub SQLite bazasiga xavfsiz va atomik qo'llash, echo'ni bostirish (server HLC clamp istisnosi bilan), bog'liqlik yetib kelmagan hodisalarni lokal park qilish va qayta urinish mexanizmi yaratiladi.

---

## 1. Kursor Modeli

1. **Ko'p do'konli kursor tuzilmasi (`{ [storeId: string]: bigint }`):**
   - Bulutda har bir do'kon uchun pozitsiya hisoblagichi alohida yuritiladi: `UNIQUE(organization_id, store_id, position)`.
   - Bitta Hub o'z tashkilotining bir nechta do'konlaridan hodisa olishi mumkin (tashkilot doirasidagi ma'lumotlar barcha do'konlardan, do'kon doirasidagilar esa faqat o'z do'konidan keladi).
   - Shu sababli kursor yakka son emas, balki xarita (`Record<string, bigint>`) ko'rinishida bo'ladi: `{ [storeId: string]: bigint }`.

2. **API shakli (`GET /api/v1/sync/pull`):**
   - **Endpoint:** `GET /api/v1/sync/pull`
   - **Query parametrlar:**
     - `cursors`: Vergul bilan ajratilgan `storeId:position` juftliklari (masalan: `store_1:105,store_2:42`). Agar kursor berilmagan bo'lsa, 0 dan boshlanadi.
     - `limit`: Bir so'rovda qaytariladigan maksimal hodisalar soni (default: 100, max: 500).
   - **Autentifikatsiya va Headers:**
     - `Authorization: Bearer <deviceAccessToken>`
     - `x-mezon-device-id`: So'rov yuborayotgan Hub'ning qurilma ID'si.
   - **Response (`SyncPullResponse`):**
     ```ts
     interface SyncPullResponse {
       events: Array<{
         eventId: string;
         organizationId: string;
         storeId: string;
         deviceId: string;
         deviceSeq: string;
         hlc: string;
         type: string;
         entity: string;
         entityId: string;
         class: 'FACT' | 'ATTR' | 'MONOTONE';
         schemaVersion: number;
         payload: Record<string, unknown>;
         position: string;
         hlcAdjusted?: boolean;
         originalHlc?: string;
       }>;
       nextCursors: Record<string, string>;
       hasMore: boolean;
     }
     ```

3. **Kursorning Hub'da saqlanishi:**
   - Hub'da `local_sync_cursors` jadvali (LOCAL class) yaratiladi:
     - `organization_id TEXT NOT NULL`
     - `store_id TEXT NOT NULL`
     - `last_position INTEGER NOT NULL`
     - `updated_at_ms INTEGER NOT NULL`
     - `PRIMARY KEY (organization_id, store_id)`
   - Ushbu jadval hodisalarni SQLite'ga qo'llash bilan bitta tranzaksiya ichida yangilanadi.

---

## 2. Nima Pull Qilinadi (Qamrov va Izolyatsiya)

1. **Tashkilot doirasi (`tenantScope === 'organization'`):**
   - **Jadvallar:** `categories`, `products`, `product_variants`, `product_barcodes`, `organization_tax_profiles`, `promotions`, `customers`, `suppliers` va boshqalar.
   - **Mantiq:** Tashkilotning BARCHA do'konlaridan kelgan tashkilot-doirasidagi hodisalar har qanday Hub'ga pull qilinadi. Sababi: katalog, narxlar, mijozlar va soliq profili butun tashkilot (barcha filiallar) uchun yagona bo'lishi shart.

2. **Do'kon doirasi (`tenantScope === 'store'`):**
   - **Jadvallar:** `stock_moves`, `batches`, `sales`, `sale_lines`, `payments`, `returns`, `return_lines`, `return_payments`, `shifts`, `shift_cashier_sessions`, `shift_closures`, `day_closes`, `cash_moves`, `goods_receivings`, `inventory_counts` va h.k.
   - **Mantiq:** Hub faqat O'Z do'koniga (`clientContext.storeId`) tegishli do'kon-doirasidagi hodisalarni pull qiladi (masalan, o'sha do'kondagi boshqa terminal yoki bulut orqali yaratilgan buyurtmalar/harakatlar). Boshqa filiallarning qoldig'i yoki cheklari bu hub'ning lokal bazasiga tushmaydi.

3. **RLS va Do'kon filtri kafolati:**
   - PostgreSQL darajasida: `cloud_sync_events` jadvali RLS bilan qattiq himoyalangan (`organization_id = mezon_current_organization_id()`). Boshqa tenant hodisalari hech qanday holatda ko'rinmaydi.
   - SQL so'rovida qamrov filtri:
     ```sql
     WHERE organization_id = $orgId
       AND (
         scope = 'organization'
         OR (scope = 'store' AND store_id = $hubStoreId)
       )
       AND (
         -- har bir do'kon uchun o'z kursori bo'yicha
         (store_id = $s1 AND position > $p1) OR ...
       )
     ORDER BY position ASC
     LIMIT $limit
     ```
   - Integratsiya testi bilan boshqa tenant hodisasi kelmasligi va boshqa filialning store-scoped hodisasi filtrlanishi isbotlanadi.

---

## 3. Echo Bostirish va `hlc_adjusted` Istisnosi

1. **Standart Echo bostirish:**
   - Agar qabul qilingan hodisaning `event.deviceId === currentDeviceId` bo'lsa:
     - Bu hodisani Hub o'zi yaratib push qilgan.
     - Hub ushbu hodisani lokal bazaga qayta qo'llamaydi (`skip`), chunki lokal ma'lumot allaqachon mavjud.
     - LEKIN kursor o'sha do'kon bo'yicha siljiydi (`nextCursor` qabul qilinadi), aks holda navbat tiqilib qoladi.

2. **`hlc_adjusted` Istisnosi (Server HLC Clamp):**
   - Agar Hub soati oldinga ketgan bo'lsa va server hodisani qabul qilganda `MAX_SKEW` chegarasi sababli HLC'ni server vaqtiga tushirgan (`clamped`) bo'lsa:
     - Bulut hodisada `hlcAdjusted: true` va yangi `effectiveHlc` ni qaytaradi.
     - **Hub nima qilishi kerak?** Garchi hodisa `event.deviceId === currentDeviceId` bo'lsa ham, Hub o'zining lokal qatoridagi HLC'sini server tushirgan `effectiveHlc` ga yangilashi (pasaytirishi) shart!
     - **Sababi:** Agar Hub lokal qatordagi HLC'ni pasaytirmasa (masalan, lokalda 2030 yil, serverda 2026 yil), kelgusida boshqa qurilma 2027 yilda shu qatorni yangilasa, LWW qoidasi bo'yicha Hub'ning 2030 yildagi nusxasi abadiy ustun keladi va boshqa qurilmaning o'zgarishini qabul qilmaydi.
   - **Test:** Soati oldinda bo'lgan Hub hodisasi clamp qilinib qaytganda lokal qatordagi HLC server HLC'siga tushirilishi va keyingi yangilanishlarni to'g'ri qabul qilishi test bilan isbotlanadi.

---

## 4. Hub'da Qo'llash Mantiqi (Apply Engine)

1. **FACT jadvallar:**
   - `INSERT OR IGNORE` (yoki `ON CONFLICT (id) DO NOTHING`). Fact yozuvlar o'zgarmas bo'lgani uchun allaqachon mavjud bo'lsa xato bermay o'tkazib yuboriladi.

2. **ATTR jadvallar:**
   - LWW (Last-Write-Wins) semantikasi:
     - Agar `incomingEvent.hlc > localRow.hlc` bo'lsa: qator yangilanadi.
     - Soft tombstone: agar `payload.deletedAtMs` mavjud bo'lsa, `deleted_at_ms` qiymati yoziladi.
     - Qayta tiklash (`restored` event): `deleted_at_ms = NULL` qilinadi.
     - Agar `incomingEvent.hlc <= localRow.hlc` bo'lsa: yangilash e'tiborsiz qoldiriladi.

3. **MONOTONE jadvallar:**
   - Ruxsat etilgan o'tishlar tekshiriladi (`checkMonotoneTransition`).
   - Ruxsat etilgan ustunlar (`voided_at_ms`, `closed_at_ms` va h.k.) yangilanadi.

4. **Outbox Izolyatsiyasi (Cheksiz aylanishning oldini olish):**
   - Pull qilingan hodisalarni qo'llashda oddiy domen komandalari/repozitoriylari chaqirilmaydi.
   - To'g'ridan-to'g'ri `applySyncPullBatch` yozuvchi moduli ishlatiladi.
   - Tranzaksiya ichida `local_outbox` jadvaliga UMUMAN YOZILMAYDI. Buni tekshiruvchi test outbox soni 0 bo'lib qolishini tasdiqlaydi.

5. **Proyeksiyalarni yangilash (Balances & Ledgers):**
   - Agar pull orqali yangi `stock_move` kelsa -> `local_stock_balances` ga harakat miqdori qo'shiladi/ayriladi.
   - Agar yangi `customer_ledger` kelsa -> `local_customer_balances` yangilanadi.
   - Agar yangi `supplier_ledger` kelsa -> `local_supplier_balances` yangilanadi.
   - (To'liq qayta qurish komandasi T2.6 da qilinadi; T2.4 da pull qilingan yozuvlar bo'yicha differensial hisob ishlaydi).

---

## 5. Sinxron Rejimidagi Triggerlar (Sync Session Mode)

1. **Muammo:**
   - SQLite'da `sales`, `returns` va `cash_moves` jadvallarida `BEFORE INSERT` triggerlar mavjud bo'lib, ular yopiq smenaga (`closed_at_ms IS NOT NULL`) yangi yozuv qo'shishni `RAISE(FAIL, ...)` bilan bloklaydi.
   - Ammo oflayn ishlagan boshqa terminaldan yoki kechikib kelgan sinxron hodisasi yopiq smenaga tegishli bo'lsa, uni bloklash sinxron oqimini butunlay to'xtatib qo'yadi.

2. **Yechim (Sinxron Sessiya Bayrog'i):**
   - SQLite temp jadvali orqali ulanish/tranzaksiya sessiya rejimi joriy qilinadi:
     `CREATE TEMP TABLE IF NOT EXISTS _sync_session (in_sync INTEGER PRIMARY KEY);`
   - Pull tranzaksiyasi boshlanishida:
     `INSERT OR REPLACE INTO temp._sync_session VALUES (1);`
   - Tranzaksiya yakunida (yoki xatolik yuz berganda `finally` blokida):
     `DELETE FROM temp._sync_session;`
   - Trigger mantiqi yangilanadi:
     ```sql
     WHEN (
       (SELECT in_sync FROM temp._sync_session LIMIT 1) IS NULL
       OR (SELECT in_sync FROM temp._sync_session LIMIT 1) = 0
     )
     AND (SELECT closed_at_ms FROM shifts WHERE id = NEW.shift_id) IS NOT NULL
     BEGIN
       SELECT RAISE(FAIL, 'SHIFT_CLOSED: cannot insert into closed shift');
     END;
     ```
   - Agar `in_sync = 1` bo'lsa: trigger xato bermaydi, balki tegishli smena/`day_close` yozuviga `is_stale = 1` (yoki eskirgan belgisi) qo'yiladi va `local_sync_conflicts` ga yozuv kiritiladi.
   - **Xavfsizlik kafolati:** Oddiy kassa/savdo jarayonida `_sync_session` 0 yoki mavjud bo'lmaydi, shuning uchun mahalliy sotuvlar uchun yopiq smena qoidasi 100% o'zgarmas saqlanadi.

---

## 6. Atomiklik va Xatoliklarga Chidamlilik

1. **Bitta Tranzaksiya Qoidasi:**
   - Bir pull partiyasidagi barcha hodisalar (masalan, 100 ta hodisa), ularning proyeksiyalari va yangilangan `local_sync_cursors` qiymatlari **bitta SQLite tranzaksiyasida** bajariladi.
2. **Crash & Rollback kafolati:**
   - Agar 100 ta hodisadan 75-sida kutilmagan disk, qoida yoki parser xatosi chiqsa:
     - Tranzaksiya to'liq `ROLLBACK` qilinadi.
     - Hech qanday qator bazada qolmaydi.
     - `local_sync_cursors` o'zgarmaydi.
   - Keyingi pull siklida Hub aynan o'sha kursor pozitsiyasidan boshlab qayta so'raydi.
   - **Test:** Batch o'rtasida sun'iy xato chiqarilganda baza dastlabki holatida qolishi va kursor siljimaganligi isbotlanadi.

---

## 7. Hub'dagi Park Mexanizmi (`local_sync_parked`)

1. **Qachon park qilinadi?**
   - Agar kelgan hodisaning xorijiy kaliti (masalan, `sale_lines` keldi, lekin `sale` hali yo'q; yoki `product` keldi, lekin `category` hali yo'q) lokal bazada topilmasa:
   - Hodisa `local_sync_parked` jadvaliga yoziladi.
   - Do'konning kursori to'xtab qolmasdan **siljiydi** (`advance`).

2. **Qayta urinish va Konflikt:**
   - Har bir pull siklida, yangi partiya muvaffaqiyatli qo'llangach, `local_sync_parked` dagi yozuvlar qayta tekshiriladi (`retry parked events`).
   - Agar ota yozuv yetib kelgan bo'lsa: hodisa lokal bazaga qo'llanadi va `local_sync_parked` dan o'chiriladi.
   - Agar 20 marta urinishda ham bog'liqlik topilmasa (`attempts >= 20`): hodisa `local_sync_conflicts` ga `DEPENDENCY_UNRESOLVED` sababi bilan o'tkaziladi va parked'dan o'chiriladi.

3. **Bulutdagi `cloud_sync_parked` qanday qayta qo'llanadi?**
   - Bulutda hodisa push qilinganda FK yo'qligi sababli `cloud_sync_parked` ga tushgan bo'lsa:
     - Har safar yangi `push` partiyasi qabul qilinganda, ushbu do'konning parked hodisalari avtomatik qayta tekshiriladi.
     - Agar ota yozuv boshqa bir push orqali yetib kelgan bo'lsa, parked hodisa qo'llanadi, `cloud_sync_events` ga chiqariladi va o'z pozitsiyasini oladi (va keyin Hub'ga pull orqali yetkaziladi).

---

## 8. Haqiqiy Parallel Test (PostgreSQL Advisory Lock)

1. **Muammo va Arxitektura Yechimi:**
   - PostgreSQL sequence'lari tranzaksiyadan tashqarida oshadi. Agar 1-tranzaksiya pozitsiya 1 ni, 2-tranzaksiya pozitsiya 2 ni olsa, lekin 2-tranzaksiya 1-dan oldin commit bo'lsa: pull qiluvchi kursor 2 ni ko'rib o'qib ketadi va 1-tranzaksiya keyinroq commit bo'lganda uning hodisasi abadiy o'tkazib yuboriladi!
   - Shu sababli GEMINI.md 4-bo'limi talabi: har bir do'kon bo'yicha `pg_advisory_xact_lock(hashtext('sync_pos:' || store_id))` olinadi va pozitsiya hisoblagichi tranzaksiya ichida oshiriladi. Advisory lock tranzaksiya `COMMIT` bo'lguncha boshqa yozuvchilarni kutdiradi.

2. **Parallel Test Stsenariysi:**
   - Testcontainers PostgreSQL ustida ishlaydi.
   - 5 ta parallel worker (turli qurilmalar, bitta do'kon) bir vaqtda doimiy ravishda hodisalarni `push` qiladi (jami masalan 200 ta hodisa).
   - Shu bilan parallel ravishda 1 ta puller uzluksiz `pull` qilib turadi.
   - **Kutilgan natija:**
     - Puller olgan barcha hodisalar pozitsiyalari bo'shliqsiz (1, 2, 3, ..., 200) ketma-ketlikda bo'ladi.
     - Bitta ham hodisa o'tkazib yuborilmaydi va bitta ham dublikat bo'lmaydi.
     - accepted hodisalar to'plami == pulled hodisalar to'plami.

---

## 9. Ikki Hub Modeli Testi (Two Hubs Offline -> Convergence)

1. **Stsenariy:**
   - Bitta tashkilot, ikkita do'kon (Do'kon A va Do'kon B).
   - Ikkita mustaqil Hub (Hub A va Hub B SQLite bazalari).
2. **Oflayn ish:**
   - Hub A oflayn holda yangi mahsulot `Product-A` yaratadi va narxini belgilaydi.
   - Hub B oflayn holda yangi mahsulot `Product-B` yaratadi va yangi mijoz `Customer-B` qo'shadi.
   - Ikkala Hub ham o'z do'konida savdo va ombor harakatlarini amalga oshiradi.
3. **Sinxronizatsiya:**
   - Ikkala Hub internetga ulanadi:
     - Hub A: `push` -> Bulutga yuboradi, so'ng `pull` qiladi.
     - Hub B: `push` -> Bulutga yuboradi, so'ng `pull` qiladi.
     - Hub A yana bir marta `pull` qiladi.
4. **Kutilgan natija (Konvergensiya):**
   - Tashkilot doirasidagi ma'lumotlar (`products`, `customers`) har ikkala Hub'da 100% teng bo'ladi (Hub A da `Product-B` va `Customer-B` paydo bo'ladi; Hub B da `Product-A` paydo bo'ladi).
   - Do'kon doirasidagi ma'lumotlar (`sales`, `stock_moves`) esa faqat o'z do'konida qoladi, ikkinchi Hub'ga aralashib ketmaydi.

---

## 10. Hub Pull Worker

1. **Ishlash tartibi:**
   - `HubSyncPullWorker` push worker bilan hamkorlikda yoki yagona sinxron siklida ishlaydi:
     `Push (avval lokal o'zgarishlarni jo'natish) -> Pull (bulutdan yangiliklarni qabul qilish)`.
   - Agar push paytida yangi hodisa accepted bo'lsa, echo bostirish tufayli pull uni qayta qo'llamaydi.
2. **Backoff va Tarmoq xatoliklari:**
   - Tarmoq uzilishi: exponential backoff (1s, 2s, 4s, 8s, max 30s).
   - 401 / 403: token yangilanishini kutish yoki agar `DEVICE_REVOKED` bo'lsa ishni to'xtatish.
3. **Lifecycle:**
   - `server.listen()` chaqirilganda worker start bo'ladi.
   - `server.close()` chaqirilganda worker to'xtatiladi.
   - `pullWorker.isRunning()` flagi lifecycle testida tekshiriladi.

---

## 11. Mutatsiya Testlari Rejasi

Quyidagi 6 ta qasddan buzilgan mutatsiya test qilinadi va ularning testlar tomonidan aniqlanishi shart:

1. **`echo_suppression_removed`:**
   - O'z qurilmasi hodisalarini bostirish o'chirib qo'yilsa -> Hub o'z hodisasini qayta qo'llashga urinadi va test buni darhol ushlaydi (chunki takror qo'llash yoki ortiqcha disk yozuvlari chiqadi).
2. **`cursor_outside_transaction`:**
   - Kursor tranzaksiyadan tashqarida (masalan, hodisalar qo'llanmasdan oldin yoki alohida tranzaksiyada) yangilansa -> qo'llash paytida xato sodir bo'lganda kursor siljib ketganligi testi buni fosh qiladi.
3. **`store_filter_removed`:**
   - Do'kon filtri olib tashlansa -> boshqa filialning savdolari yoki ombor harakatlari Hub'ga tushib qoladi va test buni rad etadi.
4. **`pull_event_written_to_outbox`:**
   - Pull orqali kelgan hodisa lokal outbox'ga yozilsa -> outbox bo'sh bo'lishi kerak degan test yiqiladi.
5. **`clamp_adjustment_skipped`:**
   - Server HLC clamp qilgan hodisaning lokal qatordagi HLC'si pasaytirilmasa -> kelgusida boshqa qurilmaning yangilanishi lokal nusxani o'zgartira olmasligi testi buni aniqlaydi.
6. **`park_skipped`:**
   - Ota yozuvi yo'q hodisa park qilinmasdan xato bersa yoki kursor to'xtab qolsa -> butun navbat to'xtab qolganligi testi buni fosh qiladi.

---

## Qabul Mezonlari (T2.4)

- [ ] PostgreSQL'da parallel yozishda birorta ham hodisa o'tkazib yuborilmaydi (haqiqiy parallel PG testcontainers testi).
- [ ] Parked hodisa ota yozuv kelgach qayta qo'llanadi va 20 ta urinishdan keyin konfliktga o'tadi.
- [ ] Echo to'g'ri bostiriladi, server HLC clamp qilinganda esa lokal HLC to'g'ri pasaytiriladi.
- [ ] Yopiq smenaga sinxron hodisasi kelsa trigger bloklamaydi, balki konflikt qayd etadi; oddiy mahalliy savdoni esa bloklayveradi.
- [ ] Ikki mustaqil Hub oflayn ishlagandan so'ng to'liq konvergensiyaga erishadi.
- [ ] `MEZON_REQUIRE_PG_TESTS=1 pnpm verify` 100% yashil o'tadi.
