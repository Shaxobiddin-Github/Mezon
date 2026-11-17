# P1 — ish holati va savol (S6)

Branch: `ishchi2/T2.6-projections` (P1 paketi). Yangi ish tartibiga ko'ra kutmasdan ishlayapman, quyidagi savolga javob kelguncha boshqa qismlarda davom etaman.

## Bajarildi (commit'lar)

| Commit | Mazmun |
|---|---|
| `319f1ba` | **T2.6:** pull faqat tegilgan kalitlarni qayta hisoblaydi. Stock to'liq qayta qurish bilan bir xil funksiyada, `productIds` filtri bilan. Mijoz va yetkazib beruvchi uchun id bo'yicha upsert. |
| `3009c8b` | **Fiskal:** hujjatni faqat yaratgan hub yuboradi. Fake operator smena invariantlari bilan. |
| (shu commit) | Differensial test (200 seed) va savol S6 |

**Kod o'qishda topilgan T2.4 xatosi (tuzatildi).** `retryParkedEvents` proyeksiyalar qayta qurilgandan **keyin** ishlar edi. Natijada park'dan qo'llangan hodisa proyeksiyaga tushmas edi. Endi retry proyeksiyadan oldin ishlaydi va kalitlarini yig'adi. Bunga mutatsiya D6 bor.

**Fiskal (topshiriqdagi test qarzi):**
- `DEV1`/`DEV2`: `device_id` filtri yoki retry tekshiruvi olib tashlansa, test yiqiladi.
- Nazoratchining ikki mutatsiyasi ("Z cheklarni kutmaydi", "cheklar OPEN ni kutmaydi") endi **5 tadan** testda ushlanadi, avval bittadan edi. Buning uchun:
  - Fake smena qoidasi buzilishini qayd qiladi va har fiskal test oxirida "buzilish yo'q" tekshiriladi;
  - yangi tasodifiy drayver jadvali testi (16 seed) qo'shildi.

## Differensial test va mutatsiyalar

`apps/hub/src/sync-projections-diff.test.ts`:
- **Manba hub** haqiqiy HTTP orqali tasodifiy amallar bajaradi: savdo, qarzga savdo, qaytarish, void, kirim (partiyali va o'rtacha), narxi noma'lum kirim va keyin tasdiqlash, mijoz va yetkazib beruvchi to'lovi, tuzatish, yangi mijoz.
- Uning outbox'i **maqsad hub**ga tasodifiy partiyalarda yuboriladi. Ba'zi ota-yozuvlar kechiktiriladi (park va retry), boshqa do'kon ledger hodisalari aralashtiriladi.
- Har partiyadan keyin barcha 5 proyeksiya jadvali SAVEPOINT ichidagi to'liq qayta qurish bilan solishtiriladi (`id`, `created_at_ms`, `updated_at_ms` dan tashqari).
- Bo'sh solishtirishga qarshi tekshiruv: har amal turi kamida bir marta bajarilgan, yakuniy proyeksiyalar bo'sh emas, park holatlari bor.

Mutatsiyalar (40 seed):

| Kod | Mutatsiya | Natija |
|---|---|---|
| D0 | `stock_moves` kaliti yig'ilmaydi | 41/41 yiqildi |
| D1 | `receiving_cost_confirmations` yig'ilmaydi | 21/41 |
| D2 | `batches` yig'ilmaydi | 3/41 |
| D4 | qisman qayta hisoblash boshqa mahsulot konfliktlarini o'chiradi | 37/41 |
| D5 | yangi mijoz yig'ilmaydi | 41/41 |
| D6 | park'dan retry kalit yig'maydi | 3/41 |
| D7 | `customer_ledger` yig'ilmaydi | 40/41 |
| D8 | `supplier_ledger` yig'ilmaydi | 41/41 |
| D10 | qisman qayta hisoblashda moves filtri yo'q | 41/41 |

## S6. SAVOL: mijoz balansi proyeksiyasi manfiy bo'lishi (T2.4 dan qolgan xato)

`local_customer_balances` da `CHECK (balance >= 0)` bor. Ledger hodisalari pull'da tartibsiz kelishi mumkin:
- `customer_ledger` tashkilot bo'yicha pull qilinadi, do'konlar oqimi aralash keladi;
- ikki do'kon bir qarzni oflayn holatda kamaytirsa, bu **haqiqiy** ortiqcha to'lov.

Shunda FIFO manfiy balans hisoblaydi, CHECK **butun pull partiyasini** yiqitadi va xato `transient` deb tasniflanadi. Natijada shu tashkilotning pull'i **cheksiz to'xtaydi**. Eski kod (to'liq qayta qurish) ham xuddi shu INSERT'da yiqilardi.

Isbot: differensial test 200 seed'dan 11 tasida tabiiy ravishda shu xatoga uchradi: `SqliteError: CHECK constraint failed: chk_local_customer_balances_nonneg`. Bu boshqa do'kondan kelgan manfiy tuzatish bilan bo'ldi. Test hozir **qizil**: uni o'chirmadim va zaiflashtirmadim.

**Taklif (A).**
- Proyeksiyada `balance >= 0` CHECK olib tashlanadi. Manfiy balans = mijozning haqi (ortiqcha to'lov). Ledger haqiqat, proyeksiya uni aks ettirishi shart.
- Bu LOCAL jadval, shuning uchun SQLite'da jadvalni qayta yaratuvchi migratsiya kerak.
- Manfiy balans konflikt ekranida ko'rinadi (`CUSTOMER_OVERPAID`, faqat ko'rish/"o'rganildi").
- Kassadagi `OVERPAYMENT_NOT_ALLOWED` qoidasi (lokal to'lov) o'zgarmaydi.

**Muqobil (B).** Manfiy qiladigan ledger hodisasini park/konfliktga yuborish. Bunda lokal ledger bulutdan ajralib qoladi, shuning uchun men rad etaman.

Yetkazib beruvchi balansida bu CHECK yo'q (faqat `accrued`/`credited` ≥ 0), u yerda muammo yo'q.

**Javob kelguncha:** konflikt API, POS ekrani va perf ustida ishlayman. A tasdiqlansa, migratsiya `0020`, test va mutatsiya qo'shaman.

---

# Reja: T2.6 (proyeksiyalar va konfliktlar) + T2.5 (bootstrap va tiklash)

Branch: `ishchi2/T2.6-projections`, `main` (`93c4f12`) dan.
Topshiriq: `9c3efe2`.
Holat: **REJA**. Tasdiq kutilyapti, kod yozilmagan.
Parallel holat: PR #27 hisobot bilan merge ruxsatini kutyapti (`ishchi2/T3.3-fiscal`, `93dc8be`).

Ikki alohida PR bo'ladi: avval T2.6, keyin T2.5. Bulut hodisa yozuvchisi (T2.7b uchun port) T2.6 dan keyin alohida kichik PR (T2.6b) sifatida taklif qilinadi.

Ruxsat doirasi:
- **Tegaman:** `apps/cloud/**` (kabinet fayllaridan tashqari), `packages/db-cloud/**` (`admin-store.ts` dan tashqari), `apps/hub/src/sync*`, `packages/sync/**`, `packages/contracts/src/sync.ts`. Proyeksiya funksiyalari uchun `packages/db-local/src/{stock,customer,supplier}-repo.ts`. POS'da konflikt ekrani.
- **Tegmayman:** `apps/admin`, `apps/cloud/src/admin-*`, `packages/db-cloud/src/admin-store.ts`, `.mezon/claude/*`, `.mezon/gemini/*`.

---

## 0. Test qarzi (T2.6 PR'ning birinchi commit'i)

`FakeFiscalDriver` haqiqiy operatorning o'zgarmas qoidalarini majburlaydi. Har biri `rejected` (kod `SHIFT_NOT_OPEN` / `SHIFT_CLOSED`) qaytaradi:

| Qoida | Natija |
|---|---|
| Ochilmagan smenaga chek (`sale` yoki `refund`) | `rejected` |
| `shift_close` dan keyin shu smenaga chek | `rejected` |
| Ochilmagan smenani yopish | `rejected` |

Smena holati drayver daftarida (`ledger`) saqlanadi. Shuning uchun qayta ishga tushirilgandan keyin ham saqlanib qoladi.

Fake'ga smena tushunchasini berish uchun `FiscalSubmitRequest.shiftId` savdo va refund uchun ham to'ldiriladi: unga `shiftIdOfDocSync` bilan chekning smenasi yoziladi. Hozir bu maydon faqat smena hujjatlarida bor, cheklarda `null`. Bu fiskal port o'zgarishi: T3.5 haqiqiy drayveriga ham kerak bo'ladi (operatorga smena raqami yuboriladi).

**Isbot:** nazoratchining ikki mutatsiyasini ("Z cheklarni kutmaydi", "cheklar `open` ni kutmaydi") qayta ishlataman. Har biri kamida 3 ta testni yiqitishi kerak (hozir bittadan), hisobotda ro'yxati bilan.

---

## T2.6 — Proyeksiyalar va konfliktlar

### 1. Hozirgi holat (o'lchangan)

`HubSyncPullService.applySyncPullBatch` partiyada `stock_moves`/`batches`, `customer_ledger` yoki `supplier_ledger` bo'lsa, yozish tranzaksiyasi ichida **to'liq** qayta quradi:

| Funksiya | Nima qiladi |
|---|---|
| `executeStockProjectionsRebuildSync` | Do'konning barcha `stock_moves` va `receiving_cost_confirmations` larini o'qiydi, har pool (`product_id` + `variant_id`) uchun replay qiladi. `local_stock_balances`, `local_batch_balances`, `local_stock_conflicts` larni do'kon bo'yicha butunlay o'chirib, qayta yozadi. |
| `executeCustomerBalancesRebuildSync` | Har mijoz uchun FIFO hisoblaydi, `local_customer_balances` ni tashkilot bo'yicha o'chirib, qayta yozadi. |
| `executeSupplierBalancesRebuildSync` | Xuddi shu, yetkazib beruvchilar uchun. |

Y4: 50k mahsulot va 100k ledger bo'lganda partiya 1,23 s davom etadi.

### 2. Tegilgan kalitlar

Pull hodisalarni qo'llagach, quyidagi to'plamlar yig'iladi. Faqat **haqiqatan qo'llangan** hodisalar hisobga olinadi; echo, park yoki konflikt bo'lganlari olinmaydi.

| Hodisa | Kalit | Proyeksiya |
|---|---|---|
| `stock_moves` | (`product_id`, `variant_id`) | stock pool |
| `batches` | partiyaning (`product_id`, `variant_id`) | stock pool |
| `receiving_cost_confirmations` | (`product_id`, `variant_id`) | stock pool (hozir bu yerda **e'tibordan chetda qolgan**, quyida qarang) |
| `goods_receiving_lines` (`cost_unknown` replay'ga ta'sir qiladi) | qatorning `product_id`/`variant_id` | stock pool |
| `products` ATTR yangilanishi | `track_batches` o'zgargan bo'lsa, shu mahsulotning barcha pool'lari | stock pool |
| `customer_ledger` | `customer_id` | `local_customer_balances` |
| `supplier_ledger` | `supplier_id` | `local_supplier_balances` |
| `customers` / `suppliers` yangi yozuv | id | balans qatori paydo bo'lishi uchun |

Hozirgi kodda faqat `stock_moves`/`batches` va ikki ledger tekshiriladi. `receiving_cost_confirmations` va `track_batches` o'zgarishi ham proyeksiyani o'zgartiradi. Differensial test buni ushlashi kerak, ushlamasa test zaif. Tegilgan kalitni aniqlash generator ichida markazlashtiriladi: bitta `collectTouchedProjectionKeys(event, row)` funksiyasi va uning birlik testi bo'ladi.

### 3. Qisman qayta hisoblash

Har proyeksiya uchun kalit bo'yicha funksiya. To'liq qayta qurish ham **shu funksiyani barcha kalitlar uchun chaqiradi**, shuning uchun mantiq bitta bo'ladi va ikki kod yo'li ajralib ketmaydi.

- **Stock:** `recomputeStockPoolsSync(db, scope, keys)`.
  - Har kalit uchun shu pool'ning moves va confirmations'ini (`idx_stock_moves_store_prod_hlc` indeksi bor) HLC tartibida olib, xuddi hozirgidek `applyReplayStockMove` / `applyStockCostConfirmation` bilan replay qiladi.
  - Keyin faqat shu pool'ning `local_stock_balances`, `local_batch_balances` va `local_stock_conflicts` qatorlarini almashtiradi.
  - Pool'lar bir-biriga bog'liq emas: replay holati pool kaliti bo'yicha alohida, bu kodda tasdiqlandi.
- **Mijoz va yetkazib beruvchi:** `recomputeCustomerBalancesSync(keys)` va `recomputeSupplierBalancesSync(keys)` mavjud `readCustomerLedgerFifoSync` / supplier ekvivalentini faqat berilgan id'lar uchun chaqiradi.
- **Qator id'si.** Hozirgi to'liq qayta qurish yangi id beradi:
  - stock uchun `nextId()`;
  - mijoz uchun indeksdan hosil qilingan sintetik id. Bu id mijozlar tartibiga bog'liq, shuning uchun qisman yangilashda ziddiyat chiqaradi.

  **Taklif:** proyeksiya qatori id'si **deterministik** bo'ladi va tabiiy kalitdan olinadi. Mavjud qator bo'lsa, uning id'si saqlanadi; yangi qator uchun `nextId()` ishlatiladi. Differensial taqqoslash tabiiy kalit bo'yicha olib boriladi va `id`, `created_at_ms`, `updated_at_ms` ustunlarini chiqarib tashlaydi (savol S1).
- **Tranzaksiya:** pull tranzaksiyasi ichida qoladi. Natija "qisman = to'liq" bo'lishi uchun proyeksiya hodisalar bilan atomik yangilanadi.

### 4. Differensial test (Mezon isboti)

`apps/hub/src/sync-projections-diff.test.ts` (`sqlite-hub` loyihasi):

- **Generator** (seed bilan qayta takrorlanadigan, `mulberry32` PRNG): savdo, qaytarish, void, kirim (`cost_unknown` va keyin tasdiqlash bilan), qarz savdosi va to'lovi, yetkazib beruvchiga qarz va to'lov, mahsulotda `track_batches` almashinuvi, boshqa do'kondan `customer_ledger`.
- **Manba:** hodisalar haqiqiy hub servislari bilan "manba hub" da yaratiladi va outbox'dan olinadi. Shunda payloadlar haqiqiy bo'ladi.
- **Qo'llash:** maqsad hub'ga tasodifiy o'lchamli partiyalarda, tasodifiy tartibda `applySyncPullBatch` orqali yuboriladi. Partiyalarning bir qismi aralashtiriladi: kech kelgan eski HLC va park, keyin retry.
- **Har partiyadan keyin:**
  1. barcha proyeksiya jadvallari o'qiladi (qisman natija);
  2. `SAVEPOINT` ichida to'liq qayta qurish ishga tushiriladi va qayta o'qiladi;
  3. `ROLLBACK TO`.

  Ikkala natija tabiiy kalit bo'yicha saralanib, `id`/`created_at_ms`/`updated_at_ms` dan tashqari barcha ustunlar bo'yicha `toEqual` bilan solishtiriladi. Pul bigint holida taqqoslanadi.
- **Hajm:** 200 seed, har birida 20–60 amal. Shablon baza bir marta migratsiya qilinadi va har seed uchun nusxalanadi. CI vaqtini o'lchab hisobotga yozaman. 60 s dan oshsa, savol bilan qaytaman.
- **Mutatsiyalar** (har biri testni yiqitishi kerak):

  | Kod | Mutatsiya |
  |---|---|
  | D1 | `receiving_cost_confirmations` tegilgan kalitlardan chiqarildi |
  | D2 | `track_batches` o'zgarishi e'tiborsiz |
  | D3 | `variant_id` kalitdan tushirildi |
  | D4 | stock'da konfliktlar pool bo'yicha o'chirilmaydi |
  | D5 | mijoz balansi faqat mavjud qatorda yangilanadi (yangi mijoz yo'qoladi) |
  | D6 | parklangan hodisa retry'da qo'llanganida kalit yig'ilmaydi |

### 5. Perf

`apps/hub/src/sync-pull-projections.perf.test.ts`: Y4 bilan bir xil baza (50k mahsulot, 100k `customer_ledger`, real `stock_moves` taqsimoti bilan). Bitta partiya (1 `stock_moves` va 1 `customer_ledger`) **< 50 ms**, p95, 20 marta takrorlanadi.

Mutatsiya: to'liq qayta qurishni qaytarish testni yiqitadi.

### 6. Konfliktlar API va POS ekrani

**Hub** (`apps/hub/src/sync-conflicts-*.ts`):

| Endpoint | Ruxsat | Vazifa |
|---|---|---|
| `GET /sync/conflicts?status=open\|resolved` | `sync:read` (owner, manager) | `local_sync_conflicts` ro'yxati |
| `GET /sync/parked` | `sync:read` | `local_sync_parked` ro'yxati (urinishlar, qaysi ref yetishmaydi) |
| `POST /sync/conflicts/:id/resolve` `{ action: 'retry' \| 'acknowledge', note? }` | `sync:resolve` (owner, manager) | hal qilish |

- **Retry:**
  - pull'dan kelgan konflikt bo'lsa, payload pull bilan bir xil yo'l orqali qayta qo'llanadi;
  - push'da rad etilgan bo'lsa, hodisa outbox'ga **o'sha `eventId` bilan** qayta navbatga qo'yiladi (bulut dedup idempotent).

  Ikkala holatda ham yangi ma'lumot yozilmaydi.
- **Acknowledge** faqat "o'rganildi" deb belgilaydi.
- **Qo'lda tahrir yo'q:** API'da payload qabul qiladigan maydon yo'q, `.strict()` schema bilan.
- **Audit:** `local_sync_conflicts` ga yangi ustunlar `resolution` (`retried`/`acknowledged`), `resolved_by_user_id`, `resolution_note` va mavjud `resolved_at_ms`. Bitta qayta hal qilish taqiqlanadi (409). Strukturalangan log `sync.conflict_resolved`. Hub'da umumiy audit jadvali yo'q (savol S2).

**Bulut:**
- `GET /sync/parked` va `POST /sync/parked/:id/resolve` (qurilma tokeni, faqat o'z do'koni, RLS bilan). Hub ularni POS'ga proksi qiladi.
- Ruxsat etilgan amallar: retry (yetishmagan ref endi bormi, qayta tekshiriladi) va acknowledge.
- Audit ustunlari `cloud_sync_parked` da (`resolved_by_user_id` hub foydalanuvchisi, `resolution`, `resolved_at_ms`).
- Kabinet uchun bulut tomonida faqat store funksiyasi bo'ladi, kabinet route'i senga.

**POS:**
- "Sinxron konfliktlar" ekrani faqat manager/owner'ga ko'rinadi.
- Ekranda ro'yxat, sabab, sana, ikki tugma va izoh maydoni bo'ladi.
- Uz-Latn va RU matnlari qo'shiladi.

**Testlar:** RBAC (kassir 403), qayta hal qilish 409, retry muvaffaqiyatli bo'lganda konflikt yopiladi va proyeksiya yangilanadi, acknowledge ma'lumotni o'zgartirmaydi (jadval xeshi oldin va keyin teng).

### 7. Bulut hodisa yozuvchisi (T2.7b porti) — taklif, alohida PR T2.6b

**HLC.** Yangi jadval `cloud_hlc_state(organization_id PK, physical_ms, logical, node_id)`. Har tashkilotning bulut node_id'si UUIDv7, bir marta yaratiladi.
- Yozuvchi tashkilot advisory lock'i (`hashtext('org_sync:' || org)`) ostida `max(now, last.physical)` ni oladi.
- Shu millisekundda bo'lsa `logical+1`, overflow bo'lsa keyingi ms'ga o'tadi (domain `hlc.ts` dagi qoida, kod qayta ishlatiladi).
- Holat o'sha tranzaksiyada yangilanadi. Bir millisekundda ikki o'zgarish `logical` 0 va 1 ni oladi, test bilan.

**Pozitsiya oqimi.**
- Tashkilot darajasidagi hodisalar uchun alohida "tashkilot oqimi" bo'ladi: `store_id = organization_id`, pozitsiya `cloud_store_sync_positions` da shu kalit bilan.
- Hub uni oddiy do'kon kursori kabi `{storeId → position}` da saqlaydi. Yangi hub kursorsiz bo'lsa, `position > 0` dan oladi; bu `sync-pull-store.ts` dagi mavjud mantiq.
- O'zgartirish: `ForeignStoreError` tekshiruvi `organization_id` ni ham ruxsat etilgan oqim sifatida qabul qiladi.
- Bu oqimga faqat `tenantScope = 'organization'` jadvallar yoziladi. Do'kon jadvali bo'lsa, xato.
- Muqobil variant: `cloud_stores` da virtual qator. Bu do'konlar ro'yxatini ifloslaydi, shuning uchun rad etdim.

**Virtual qurilma.**
- `cloud_devices` da har tashkilot uchun bitta qator: `platform = 'cloud'`, `status = 'system'`.
- U uchun **token yaratilmaydi**, juftlash kodi ham yo'q.
- Auth middleware `status <> 'active'` bo'lsa rad etadi. Test: shu qurilma id'si bilan qo'lda yaratilgan token login va push'da 401/403 oladi.
- `device_seq` o'sha lock ostida oshiriladi.

**Validatsiya.**
- `sync-push-store.ts` dagi har hodisa uchun bajariladigan qadamlar alohida `validateAndApplySyncEvent(tx, ctx, event)` ga ajratiladi: Zod payload, tenant, FK yoki park, sinf qoidalari, MONOTONE qoidalari, pozitsiya.
- Push ham, bulut yozuvchisi ham shu funksiyani chaqiradi. Test: yaroqsiz payload ikkala yo'lda bir xil xato kodini beradi (jadval testi).

**Port** (T2.7b uchun): `CloudEventWriter.write(ctx: {organizationId, actorUserId}, events: CloudCommand[])`, natija `{accepted, positions}`. Kabinet bu portni chaqiradi, men route yozmayman.

---

## T2.5 — Bootstrap va qayta tiklash

### 1. Yangi hub: snapshot va pull

**Variant A (taklif): pull'ning o'zi, alohida snapshot yo'q.**
- Bulut har do'kon oqimi uchun barcha hodisalarni pozitsiya bo'yicha saqlaydi (`cloud_sync_events`). Yangi hub kursorsiz pull qiladi va hamma narsa tartib bilan keladi.
- Afzalligi:
  - kursor bitta haqiqat manbai;
  - hodisa yo'qolmaydi yoki ikki marta qo'llanmaydi, chunki pull allaqachon `(organization_id, id)` echo/dedup va pozitsiya kursoriga tayanadi.
- Kamchiligi: katta tashkilotda uzoq davom etadi. 100k hodisa uchun o'lchab hisobotga yozaman.

**Variant B: snapshot.** Bulut proyeksiya jadvallarining nusxasini pozitsiya `P` da beradi, keyin `P` dan pull qilinadi. Bu bulutda barcha jadvallarning **izchil** nusxasini talab qiladi. Buning uchun `REPEATABLE READ` tranzaksiya kerak va `P` o'sha tranzaksiyada `cloud_store_sync_positions` dan o'qiladi. Bulutdagi jadvallar hub sxemasi bilan bir xil emas, qo'shimcha konvertor kerak. Murakkabroq.

**Taklif:** T2.5 da A. B ni o'lchov natijasiga qarab keyingi bosqichga qoldiraman (savol S3).

### 2. Uzilgan yuklashdan davom etish

- Har pull sahifasi bitta SQLite tranzaksiyasida qo'llanadi va kursorlar shu tranzaksiyada yangilanadi (T2.4 da shunday).
- Uzilsa, oxirgi commit qilingan sahifadan davom etadi.
- Bootstrap holati: `local_hub_config.bootstrap_state` (`none` / `in_progress` / `done`). `done` bo'lguncha savdo ochilmaydi, POS "Yuklanmoqda N/M" ko'rsatadi.
- **Test:** yuklash N-sahifada majburan uziladi (pull fetch ichida `throw` yoki child-process kill). Qayta ishga tushgach, natija to'liq yuklash bilan teng bo'ladi: barcha jadvallar va proyeksiyalar §4 dagi taqqoslash bilan, kursorlar ham teng. N tasodifiy, 20 seed.

### 3. Tenant filtri

- Har jadval uchun jadval testi: boshqa tashkilot (va do'kon jadvallari uchun boshqa do'kon) hodisalari bootstrap natijasida hech bir jadvalga tushmaydi.
- Qoida T2.4 `pullScope` bilan bir xil, chunki bootstrap = pull.
- Test registrdan generatsiya qilinadi: yangi jadval qo'shilsa, test o'zi uni qamraydi.
- Mutatsiya: `scopeFilter` dan do'kon sharti olib tashlanadi, test yiqiladi.

### 4. Mavjud hubni tiklash

**Taklif:**
1. Lokal zaxira (T1.13) tiklanadi.
2. Kursorlar zaxiradagi qiymatdan davom etadi va bulutdan **faqat zaxiradan keyingi** hodisalar pull qilinadi.

Ustunlik: hodisa darajasida konflikt bo'lmaydi, chunki bir xil `eventId` echo sifatida o'tkaziladi. Bulut — umumiy haqiqat, zaxira esa tezlik uchun.

**Outbox'dagi yuborilmagan hodisalar:**
- Zaxira olingandan keyin yaratilgan, lekin yuborilmagan hodisalar zaxirada yo'q, ular yo'qolgan. Egasini ogohlantirish kerak.
- Zaxirada bor, lekin yuborilmagan hodisalar tiklashdan keyin odatdagidek push qilinadi (dedup idempotent).
- `device_seq` ziddiyati:
  - zaxiradan keyin bulutga yuborilgan seq'lar qayta ishlatilsa, bulut ularni boshqa hodisa sifatida rad etadi;
  - **taklif:** tiklangan hub yangi `device_id` bilan qayta juftlanadi (T2.2), eski qurilma `revoked`;
  - zaxiradagi yuborilmagan hodisalar eski `device_id` bilan saqlangan. Ularni qayta yuborish yo'lini aniqlash kerak (savol S4).

**Fiskal (`fiscal_docs`):**
- Tiklangan hubda `sent` hujjatlar worker orqali faqat `status()` bilan davom etadi (F-A). Idempotentlik kaliti saqlangan, shuning uchun ikki marta fiskallashtirish xavfi yo'q.
- `pending` hujjat operatorda allaqachon bo'lishi mumkin (zaxiradan keyin yuborilgan). Kalit idempotent, operator birinchi natijani qaytaradi (Fake'da bor; T3.5 da tasdiqlanishi kerak).
- **Taklif:** worker faqat `driver_id` va shu hub yaratgan (`device_id` mos) hujjatlarni yuboradi. Pull orqali kelgan boshqa hub hujjati faqat ko'rsatiladi.
- Test: tiklash ssenariysida `sent` → `status()` → `confirmed`, `submitCount` oshmaydi.

---

## Savollar

- **S1.** Differensial taqqoslashda `id`, `created_at_ms`, `updated_at_ms` ni chiqarib tashlash maqbulmi? Ular surrogat va hisobga oid ustunlar, proyeksiya qiymati emas. Muqobil: id'larni tabiiy kalitdan deterministik qilish. Bu mavjud mijoz balansi id formulasini o'zgartiradi va migratsiyasiz ishlaydi, chunki proyeksiya LOCAL.
- **S2.** Konflikt hal qilish auditi uchun konflikt jadvalidagi ustunlar va strukturalangan log yetarlimi, yoki hub'da umumiy `local_audit_log` jadvali kerakmi? Ikkinchisi kengroq sxema o'zgarishi.
- **S3.** T2.5 bootstrap uchun Variant A (snapshotsiz, to'liq pull) qabul qilinadimi? 100k hodisa uchun vaqtni o'lchab beraman.
- **S4.** Tiklangan hub yangi `device_id` olishi va zaxiradagi yuborilmagan hodisalarni yangi qurilma nomidan qayta raqamlab yuborishi to'g'rimi? Bu egasining qarori bo'lishi mumkin: hodisaning "kim yaratgan" ma'lumoti o'zgaradi.
- **S5.** Bulut yozuvchisi (T2.6b) T2.6 dan oldin kerakmi? T2.7b uchun kerak bo'lsa, tartibni o'zgartiraman.

## Bajarish tartibi (tasdiqdan keyin)

1. **T2.6:**
   1. test qarzi commit'i;
   2. kalit yig'ish va qisman funksiyalar;
   3. differensial test;
   4. perf;
   5. konflikt API va POS;
   6. mutatsiyalar, `pnpm verify`, PR.
2. **T2.6b:** bulut yozuvchisi, alohida PR.
3. **T2.5:** alohida PR.
