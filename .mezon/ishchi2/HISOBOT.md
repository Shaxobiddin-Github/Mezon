# P3 — reja: T4.1 LAN hub (pinned TLS), T4.2 ko'p kassa, T4.3 terminal printeri va yashik, T2.8 yakuniy integratsion test

Branch: `ishchi2/P3-lan`. U P2 (PR #32) ustidan ochilgan.
Holat: **REJA**. Tasdiq kutmasdan kodga o'tyapman. Tartib: T4.1 → T4.2 → T4.3 → T2.8.

## T4.1 — LAN hub, juftlangan terminallar, pinned TLS

**Hozir.** Hub faqat `127.0.0.1` da HTTP tinglaydi. Bu o'zgarmaydi: lokal POS avvalgidek ishlaydi.

**Yangi LAN tinglovchisi.** Ikkinchi, ixtiyoriy tinglovchi:
- faqat HTTPS, o'z-o'zidan imzolangan ECDSA P-256 sertifikat;
- sertifikat birinchi yoqilganda hub'da yaratiladi;
- yopiq kalit `SafeStoragePort` bilan shifrlanib saqlanadi, repo'ga hech narsa tushmaydi.

DER/X.509 yangi kutubxonasiz, kichik DER yozuvchi bilan yasaladi. Natija Node `X509Certificate` va haqiqiy TLS ulanishida tekshiriladi.

**Juftlash** (TOFU emas, kod bilan o'zaro isbot):
1. Owner/manager hub ekranida bir martalik kod oladi: 10 belgi base32, 5 daqiqa, 5 ta xato urinish `[TASDIQLANSIN]`.
2. Terminal hub sertifikatining SHA-256 barmoq izini ko'radi va kodni **yubormaydi**. Uning o'rniga `HMAC(kod, "terminal" ‖ ko'rgan_barmoq_izi ‖ nonce)` yuboradi.
3. Hub o'z haqiqiy barmoq izi bilan tekshiradi. O'rtadagi odam (MITM) bo'lsa, barmoq izi boshqa bo'ladi va hub rad etadi.
4. Hub `HMAC(kod, "hub" ‖ barmoq_izi ‖ nonce)` bilan javob beradi. Terminal ham hubni tekshiradi.
5. Muvaffaqiyatda hub `terminalId` va 32 baytli maxfiy kalit beradi; hub'da faqat SHA-256 xeshi saqlanadi. Terminal barmoq izini "pin" qiladi. Keyingi ulanishlarda boshqa sertifikat bo'lsa, TLS'ni o'zi uzadi.

**Har LAN so'rovi:**
- TLS + `x-mezon-terminal: <id>.<kalit>` sarlavhasi;
- juftlanmagan yoki bekor qilingan terminal → 401 `TERMINAL_NOT_PAIRED`, route'ga yetmaydi;
- `/lan/pair` yagona ochiq yo'l;
- foydalanuvchi sessiyasi (PIN/token) avvalgidek alohida talab qilinadi.

**Ichki tuzilish.** LAN tinglovchisi so'rovni asosiy ilovaga `inject` orqali uzatadi. Unga ichki, jarayon-maxfiy sarlavha bilan `terminalId` qo'shiladi. Tashqaridan kelgan shu sarlavha olib tashlanadi.

**API (owner/manager, `lan:manage`):**
- `POST /lan/pairing-codes`;
- `GET /lan/terminals`;
- `POST /lan/terminals/:id/revoke`;
- `GET /lan/status` (barmoq izi).

**Testlar.**
- Haqiqiy HTTPS port 0 da: juftlangan terminal ishlaydi.
- Sarlavhasiz, soxta kalit yoki bekor qilingan terminal → 401.
- Boshqa sertifikat (MITM) → TLS rad etiladi; juftlashda barmoq izi mos kelmasa → rad.
- Kod qayta ishlatilmaydi, muddati o'tadi, urinishlar tugaydi.
- Mutatsiyalar.

## T4.2 — ko'p kassa va parallel savdo

**Model.** Har terminal o'z kassasi:
- bitta ochiq smena **terminal bo'yicha** (hozir qurilma bo'yicha);
- savat va savdoda `terminal_id`.

Chek raqami hub bo'ylab bitta ketma-ketlik bo'lib qoladi: noyob va bo'shliqsiz. Sinxron qilinadigan jadvallarga ustun qo'shish bulut kontraktiga ham ta'sir qiladi. Shu sabab avval kontraktni tekshiraman va farqni hisobotda yozaman.

**Mezon testi.** 3 terminal parallel savdo qiladi: zaxira to'g'ri, chek raqamlari noyob va ketma-ket. Har terminal smenasi o'z naqd pulini ko'radi.

### [ishchi2-savol] T4.2: har kassaning o'z smenasi va yashigi

**Topilgan holat.** Hozirgi model "bitta qurilma = bitta kassa". U hub'da ham, bulutda ham indeks bilan mustahkamlangan:
- `uidx_shifts_one_open_per_device` — qurilmada bitta ochiq smena;
- `uidx_shift_cashier_one_active` — smenada bitta faol kassir sessiyasi (yashik);
- naqd pul harakati (`cash_moves`) sessiyaga bog'langan.

Hub bitta qurilma. Shuning uchun 3 terminal bitta smena va bitta yashikni bo'lishadi. Turli kassirlar parallel ishlay olmaydi (`CASHIER_SESSION_MISMATCH`).

**Variantlar** (hammasi sinxron jadvallarga, ya'ni bulut kontraktiga tegadi):

| Variant | Mazmuni | Narxi |
|---|---|---|
| A | Har terminal bulutda alohida "virtual qurilma"; smena `device_id` = terminal | Katta. Bulut hub nomidan boshqa qurilma hodisalarini qabul qilishi kerak; `device_seq` va HLC |
| **B (taklif)** | `shifts`, `shift_cashier_sessions`, `cash_moves` ga `register_id` (NULL = hub); noyoblik `(device, register)` bo'yicha | O'rtacha. Ikkala migratsiya, kontrakt, proyeksiya; eski ma'lumot NULL bilan mos |
| C | Smena umumiy, faqat sessiya terminal bo'yicha | B ga yaqin, lekin smena yopilishi hamma terminalni birga yopadi |

**QAROR (javobsiz, vaqtincha).** Javob kelguncha sinxron jadvallarga tegmayman. Hozir quyidagilar qilindi:
- savat va savdo terminalga bog'landi (`local_carts.terminal_id`, LOCAL);
- `GET /lan/terminals/sales` — kassa bo'yicha tushum;
- mezon testi (3 terminal, 30 dona uchun poyga): zaxira 0, chek raqamlari 1..30 bo'shliqsiz.

Javob B bo'lsa, alohida commit'lar bilan shu paketda qilaman.

## T4.3 — terminal printeri va yashik (bajarildi)

- Har LAN kassada o'z printeri bor: `PUT /lan/terminals/:id/printer`. Sozlanadi:
  - rejim, printer nomi yoki lokal IPv4;
  - port, qog'oz kengligi, kodlash;
  - avtomatik yashik.

  Chek sarlavhasi va pastki matni hub sozlamasidan olinadi.
- Chek, qaytarish cheki, smena hisoboti, test chop etish va yashik **so'ralgan kassaning** printeriga chiqadi.
- Hub kompyuterining o'zi hub printeridan foydalanadi.
- **QAROR (javobsiz):** printeri sozlanmagan LAN kassa hub printeriga **chiqarmaydi**. Yozuv `disabled` bo'ladi, chunki chek boshqa peshtaxtada chiqib qolmasligi kerak.
- Printerni faqat hub kompyuteridan (`LAN_LOCAL_ONLY`) va owner/manager boshqaradi. Ommaviy IP rad etiladi.

**Test** (`multi-register.test.ts`). 3 kassa, Fake printerlar manzil bo'yicha:
- K1 cheki → `.11`, K2 cheki → `.12`;
- printersiz K3 → `disabled`, hech qayerga chiqmaydi;
- K2 yashigi → `.12`;
- hub test chop etishi → `.10`.

**Mutatsiyalar** (hammasi o'ldi):
- P1 — hub printeriga qaytish;
- P2 — kassa printeri e'tiborsiz;
- P3 — chek kassani bilmaydi;
- P4 — yashik kassani bilmaydi;
- M1 — savat kassaga bog'lanmaydi.

## T2.8 — yakuniy integratsion test

Ikki baza: hub SQLite va bulut PostgreSQL. Ssenariy:
- oflayn savdo;
- ikki tomon sinxron;
- bekor qilish va qaytarish;
- uzilish;
- soat farqi.

**Mezon:** oxirida ikki tomonda qoldiq, qarz va tushum teng. Test 10 marta barqaror (seed bilan).

---

# Hisobot: P2 — T3.8 audit xesh zanjiri, T3.7 markirovka (Fake), T3.6 UzQR to'lov yadrosi (Fake)

Branch: `ishchi2/P2-payments`. U P1 (PR #31) ustidan ochilgan. P1 merge bo'lgach, base `main` bo'ladi va `main` shu branch'ga merge qilinadi.
Holat: **HISOBOT**. Tekshiruv kutilyapti. O'zim merge qilmayman.
Tashqi tizimlar (UzQR provayderi, Asl belgisi operatori) uchun endpoint, maydon yoki imzo o'ylab topilmagan. Faqat port va `Fake…Driver` bor; haqiqiy drayverlar T3.0 hujjatidan keyin.

## Qisqa xulosa

| Vazifa | Natija | Asosiy isbot |
|---|---|---|
| T3.8 audit | tayyor | faqat qo'shiladigan SHA-256 zanjir (`0021`), amal tranzaksiyasi ichida yoziladi; `GET /audit`, `GET /audit/verify` (owner), CLI `audit:verify` (chiqish 0/1/2); mutatsiyalar A1–A8 o'ldi |
| T3.7 markirovka | tayyor | GS1 tahlilchisi (17 test), `MarkingDriver` + Fake, `0022`, `/carts/:id/marks`; `completeSale`: kodlar = dona; void va qaytarishda kod bo'shaydi; K1–K8 o'ldi |
| T3.6 UzQR | tayyor | `PaymentDriver` + Fake, `payment_intents` (`0023`); chek faqat `paid` intent bilan yopiladi; kech tasdiq bitta chekka bir marta; Q1–Q8 o'ldi |

`pnpm verify`: yashil (1011 + 17 test).

## T3.6 — qanday ishlaydi

**Holatlar.** Oldinga yo'naluvchi:
- `pending → paid | expired | cancelled | failed`;
- `expired | cancelled → paid` — kech tasdiq, `paid_late = 1`;
- `paid → refunded` — faqat ishlatilmagan intent.

Har o'tish bitta himoyalangan `UPDATE … WHERE status IN (…)`. Ikki parallel so'rov uni ikki marta qo'llay olmaydi.

**Chek yopish.** `completeSale` ichida har `uzqr` to'lovi intentni `provider_ref` bo'yicha atomik oladi. Shartlar:
- `status='paid'`;
- `consumed_by_sale_id IS NULL`;
- summa aniq teng.

Bo'lmasa `PAYMENT_NOT_CONFIRMED` (409) va chek yopilmaydi. Bitta chekda bir nechta QR to'lovi bo'lishi mumkin.

**Provayder.** Provayder SQLite tranzaksiyasidan **tashqarida** chaqiriladi. Oflayn bo'lsa:
- yaratish → 502;
- yangilash holatni o'zgartirmaydi (hech narsa taxmin qilinmaydi).

**Statik QR.** Faqat owner/manager (`payments:confirm`) izoh bilan qo'lda tasdiqlaydi. Tasdiq va `payment.manual_confirmed` audit yozuvi bitta tranzaksiyada.

**Qaytarish.** Faqat `paid` va hech bir chekda ishlatilmagan intent (`payments:confirm`). Dinamik QR'da avval provayder `refund`, keyin holat.

**API:**
- `POST /payments/intents`;
- `GET /payments/intents/:id` — yangilash;
- `POST …/cancel` — kassir;
- `POST …/confirm` va `POST …/refund` — manager/owner.

**Testlar** (`apps/hub/src/payment.test.ts`, 8 ta):
- tasdiqsiz chek yopilmaydi;
- bitta QR ikkinchi chekni yopmaydi;
- noto'g'ri summa yoki noma'lum havola rad etiladi;
- vaqt tugagach kelgan to'lov `paid_late`, bir marta ishlatiladi, qayta yangilash hech narsa yozmaydi;
- bekor qilingan, keyin to'langan → manager qaytaradi (kassir 403, ikkinchi qaytarish 409);
- ishlatilgan QR qaytarilmaydi;
- statik tasdiq: kassir 403, audit yozuvi bor;
- poyga: bir QR bilan ikki chek parallel → aniq bittasi 200;
- provayder oflayn.

**Mutatsiyalar** (hammasi o'ldi):
- Q1 — ishlatilgan tekshiruvi olib tashlandi;
- Q2 — `paid` tekshiruvi olib tashlandi;
- Q3 — summa e'tiborsiz;
- Q4 — kech to'lov belgilanmaydi;
- Q5 — statik tasdiq auditsiz;
- Q6 — ishlatilgan intent qaytariladi;
- Q7 — muddat tugashi qo'llanmaydi;
- Q8 — kassirga `payments:confirm`.

## Rejadan farqlar (ko'rib chiqing)

1. **`consumed_by_sale_id` UNIQUE emas, oddiy indeks.** Bitta chekda ikki QR to'lovi bo'lishi mumkin (fuzz testi buni topdi). Bir intent ikki chekka tushmasligini atomik `UPDATE … consumed_by_sale_id IS NULL` kafolatlaydi (Q1 va poyga testi).
2. **Statik QR'ni kassir emas, owner/manager tasdiqlaydi.** Rejada "kassir, ruxsat bilan" edi. Xavfsizroq variantni tanladim — `QAROR (javobsiz)`.
3. **QR muddati `DEFAULT_QR_TTL_MS = 120 s`** `[TASDIQLANSIN]`.

## Migratsiyalar (lokal)

`0021_audit_log`, `0022_marking`, `0023_payment_intents`. `main` merge bo'lganda, raqamlar nazoratchining lokal migratsiyalari bilan to'qnashsa qayta yaratiladi.

## Egasi uchun savollar

1. MXIK prefikslari ro'yxati (markirovka talab qilinadigan tovarlar) — hozir sozlama `[]` `[TASDIQLANSIN]`.
2. QR muddati: 120 s maqulmi?
3. Statik QR'ni kassir ham tasdiqlay oladimi, yoki faqat manager?
4. Audit zanjirining oxirgi xeshini bulutga "langar" qilish (qurilma egasi butun zanjirni qayta hisoblasa, lokal tekshiruv sezmaydi) — keyingi bosqichga taklif.

## Commit'lar

- `5a00938`, `1d90a1a` — T3.8;
- `b86a357` … `d780442` — T3.7;
- `e771164` … `706f619` — T3.6;
- `096da24` — test turlari.

---

# Hisobot: P1 — T2.6 + T2.5 + bulut buyruq yozuvchi porti + fiskal test qarzi

Branch: `ishchi2/T2.6-projections`. PR: [#31](https://github.com/Shaxobiddin-Github/Mezon/pull/31) (base `main`).
Holat: **HISOBOT**. Tekshiruv kutilyapti.

**Yangilanish (2026-11-18).**
- C1 (PR #30) mening QABUL'im va yashil CI bilan squash-merge qilindi.
- `main` P1 ga merge qilindi. Bulut migratsiyasi endi `0007_sync_parked_and_cloud_hlc`. Avval u `0006` edi; `0006` raqamini C1 `0006_telegram_bot` uchun oldi. Qo'lda yozilgan FORCE RLS / REVOKE / GRANT qatorlari aynan saqlandi.
- `db:check` (ikkala baza), `pnpm verify` va `pg-cloud` (139 test) yashil.
- **QAROR (javobsiz):** `0008` emas, `0007`, chunki drizzle raqamni bo'shliqsiz, ketma-ket beradi. C2 keyin merge qilinsa, o'z raqamini qayta yaratadi (qoidaga ko'ra).
- P2 PR ochildi: #32 (base shu branch).

## Qisqa xulosa

| Qism | Natija | Asosiy isbot |
|---|---|---|
| Fiskal test qarzi + `device_id` | tayyor | nazoratchining Z/OPEN mutatsiyalari 1 o'rniga 5 tadan testda; DEV1/DEV2 o'ldi |
| T2.6 qisman proyeksiya | tayyor | differensial test 200/200 seed; perf p95 9,5 ms (avval 1,23 s) |
| S6 (manfiy balans, A) | tayyor | S6a–S6e mutatsiyalari o'ldi; pull hech qachon proyeksiya xatosida to'xtamaydi |
| Konfliktlar (hub + bulut) | tayyor | API va POS ekrani; tahrir yo'q (strict body testi); audit ustunlari |
| Bulut yozuvchi porti (T2.7b) | tayyor | W1–W6 o'ldi |
| T2.5 bootstrap va tiklash | tayyor | uzilish = uzilmagan (20 seed); tenant filtri har jadval bo'yicha; tiklashda fiskal |

## Commit'lar

| Commit | Mazmun |
|---|---|
| `319f1ba` | T2.6: tegilgan kalitlar bo'yicha qayta hisoblash. Park'dan retry endi proyeksiyalardan **oldin** ishlaydi (T2.4 xatosi). |
| `3009c8b` | Fiskal: faqat yaratgan hub yuboradi; Fake operator smena invariantlari; tasodifiy drayver jadvali testi. |
| `6d6fbfa` | Differensial test, S6 savoli. |
| `5f43ba3` | S6 (A): `0020`, domen, `PROJECTION_FAILED`, `CUSTOMER_OVERPAID`, POS "Ortiqcha to'lov". |
| `d367afd` | Perf testi (50k / 100k / 100k). |
| `87a8adc`, `5ac8a60` | Hub konflikt API'si va POS ekrani. |
| `cd4c8ab` | Bulut `cloud_sync_parked`: ko'rish, retry, o'rganildi; hub proksisi. |
| `b96fa91` | Bulut buyruq yozuvchi porti (`CloudEventWriter`). |
| `d919609`, `732e822`, `a7bc935` | T2.5: bootstrap, tenant filtri, endpoint'lar. |
| `a7bc935`, `ba58e1e` | T2.5: tiklashda `device_id` saqlanadi, `sent` fiskal hujjat davom etadi. |
| `2fcbe3c` | `ALOQA.md` yo'laklar jadvali. |

## T2.6 — proyeksiyalar

- **Kalitlar.** `collectTouchedProjectionKeys`: `stock_moves`, `batches`, `receiving_cost_confirmations`, `goods_receiving_lines`, `products` → mahsulot; `customer_ledger`, `customers` → mijoz; `supplier_ledger`, `suppliers` → yetkazib beruvchi.
- **Hisoblash.** Faqat **qo'llangan** hodisalar hisobga olinadi, park'dan retry ham shunga kiradi. Stock to'liq qayta qurish bilan bitta funksiyada hisoblanadi (`productIds` filtri). 500 dan ortiq mahsulot bo'lsa, bitta to'liq o'tish qilinadi.
- **Differensial test** (`sync-projections-diff.test.ts`):
  - haqiqiy HTTP amallari: savdo, nasiya, qaytarish, void, kirim, narxi noma'lum kirim va tasdiqlash, to'lovlar, tuzatish, yangi mijoz;
  - tasodifiy partiyalar, ota-yozuvni kechiktirish (park/retry), boshqa do'kon ledger hodisalari;
  - har partiyadan keyin 5 proyeksiya jadvali to'liq qayta qurish bilan teng;
  - 200 seed, 207 s.
- **Deterministik testlar.** Kalit yig'uvchining unit testi (D0–D8); D6 park/retry ssenariysi.
- **Perf.** p95 9,5 ms. Mutatsiya (to'liq qayta qurish) bilan 7 805 ms → yiqiladi.

## S6 — manfiy balans (A tasdiqlangan)

- **Migratsiya va domen.** `0020` da `balance >= 0` CHECK yo'q. Domenda manfiy balansda lokal amallar ishlaydi; kamaytirish uni yarata yoki chuqurlashtira olmaydi. Kredit limiti ortiqcha to'lovni 0 qarz deb hisoblaydi.
- **Pull himoyasi.** Har proyeksiya kaliti alohida SAVEPOINT'da. Xato bo'lsa partiya, hodisalar va kursorlar baribir commit bo'ladi, kalit `PROJECTION_FAILED` ga yoziladi va keyingi partiyalarda qayta uriniladi. Sun'iy CHECK testi bor.
- **`CUSTOMER_OVERPAID`.** Faqat ko'rish va "o'rganildi". Balans ≥ 0 bo'lsa o'zi yopiladi. "O'rganildi" qilingani summa o'zgarmaguncha qayta ochilmaydi.
- **POS.** "Ortiqcha toʻlov: X soʻm (mijoz haqqi)".
- **S7 (ochiq savol).** Ortiqcha to'lovli mijozga yangi nasiya ruxsat etilgan; musbat delta ortiqcha to'lovni kamaytiradi. Egasi boshqacha desa, bitta qator o'zgaradi.

## Konfliktlar

| Joy | Endpoint | Ruxsat |
|---|---|---|
| Hub | `GET /sync/conflicts`, `GET /sync/parked` | `sync:read` |
| Hub | `POST /sync/conflicts/:id/resolve` | `sync:resolve` |
| Hub (proksi) | `GET/POST /sync/cloud-parked...` | `sync:read` / `sync:resolve` |
| Bulut | `GET /api/v1/sync/parked`, `POST /api/v1/sync/parked/:id/resolve` | device token, RLS + o'z do'koni |

- Owner va manager kiradi, kassir 403.
- **Retry:**
  - push → o'sha `eventId` bilan outbox'ga qaytadi;
  - pull → saqlangan `event_json` oddiy pull yo'lidan qo'llanadi;
  - projection → kalit qayta hisoblanadi;
  - bulutda → urinishlar oynasi tiklanadi va lokal rad etilgan outbox hodisasi qayta navbatga qo'yiladi.
- **Audit:** `resolution`, `resolved_by_user_id`, `resolution_note`; loglar `sync.conflict_resolved` va `sync.parked_resolved`.
- **POS:** "Sinxron konfliktlar" ekrani va "Bulutda kutayotganlar" bo'limi (uz-Latn, ru).

## Bulut buyruq yozuvchi porti (T2.7b uchun)

Batafsil foydalanish quyidagi "T2.7b uchun port tayyor" bo'limida.

| Mavzu | Qanday ishlaydi |
|---|---|
| HLC | `cloud_hlc_state`, `org_hlc:<org>` lock ostida. HLC joriy vaqt, oxirgi HLC va yozuvning HLC'sidan katta. |
| Oqim | Tashkilot oqimi `store_id = organization_id`; pull kursorida tashkilot kaliti qabul qilinadi. |
| Virtual qurilma | `status = 'system'`, token yo'q. |
| Validatsiya | `processSyncPushBatch`, ya'ni push bilan bir xil yo'l. Store jadvallari rad etiladi. |

## T2.5 — bootstrap va tiklash

| Savol | Javob va isbot |
|---|---|
| Snapshot va pull | Variant A: pull'ning o'zi yuklash. Har sahifa kursorlari bilan bitta tranzaksiyada qo'llanadi, shuning uchun hodisa yo'qolmaydi va ikki marta qo'llanmaydi. `HubSyncBootstrap`: `none` → `in_progress` → `done`; `GET/POST /sync/bootstrap`. |
| Davom ettirish | Test (20 seed): N-sahifada uzilish va jarayon qayta ishga tushishi = uzilmagan yuklash (barcha sinxron jadvallar, proyeksiyalar, kursorlar) va mutlaq to'liqlik. Kursor +1 va "hasMore'siz done" mutatsiyalari 20/20 seed'da o'ldi. |
| Tenant filtri | Registrdan generatsiya qilingan PG testi (har sinxron jadval). Boshqa tashkilot hech qachon; boshqa do'kon faqat tashkilot jadvallari uchun. `scopeFilter` mutatsiyasi o'ldi. |
| Zaxira yoki bulut ustun | Zaxira (T1.13) tiklanadi. Kursorlar zaxiradagi qiymatdan davom etadi va bulut zaxiradan keyingi hodisalarni pull bilan qaytaradi; o'z hodisalari ham keladi, chunki tiklangan outbox'da ular yo'q. Restore B4 `device_seq` va HLC'ni `max(tiklangan, joriy)` qiladi, shuning uchun ketma-ketlik qayta ishlatilmaydi. |
| Zaxirada bor, lekin yuborilmagan hodisalar | Odatdagidek push qilinadi; bulut `eventId` bo'yicha dedup qiladi. |
| Zaxiradan keyin yaratilib yuborilmagan hodisalar | Ular yo'qolgan. Bu T1.13 zaxirasining tabiati, egasini ogohlantirish kerak. |
| `device_id` | **Eski `device_id` saqlanadi** (DB bilan tiklanadi). Shuning uchun `sent` fiskal hujjatlar yetim qolmaydi. Test: zaxiradagi `sent` hujjat tiklangandan keyin `status()` bilan tasdiqlanadi, `submitCount = 1`. |

**Ochiq risk.** Zaxiradan keyin qurilma tokeni almashtirilgan bo'lsa, tiklangan hub eski token bilan 401 oladi va qayta juftlash kerak bo'ladi. Buni T4.x yoki egasining tiklash yo'riqnomasiga yozish kerak.

## Migratsiyalar

- **Lokal `0020_sync_overpaid_conflicts_bootstrap`:**
  - `local_customer_balances` (CHECK olib tashlandi) va `local_sync_conflicts` (audit ustunlari) qayta yaratiladi;
  - `local_sync_apply_state` ga ustunlar `ALTER ADD` bilan qo'shiladi, chunki bu jadvalni sotuv triggeri ishlatadi;
  - `INSERT … SELECT` dagi yangi ustunlar qo'lda tuzatildi: eski yopilgan konfliktlar `auto` oladi.
- **Bulut `0007_sync_parked_and_cloud_hlc`.** C1 ham `0006` ni oladi: kim keyin merge bo'lsa, raqamni o'sha qayta yaratadi.

## Tekshiruv

`pnpm verify` (`ba58e1e`, lokal): 118 test fayli, 968 test; perf 12 fayl, 17 test; E2E 1; `db:check` 0 diff (SQLite va PostgreSQL); depcruise toza (547 modul).

## Ochiq savollar

- **S7.** Ortiqcha to'lovli mijozga nasiya (yuqorida).
- **Bulut va ikki hub paritet testi.** Bulutda mijoz balansi proyeksiyasi yo'q; kabinet C1 da FIFO'ni o'qishda hisoblaydi. Uchta tomonni birga tekshiradigan PG testini C1 merge bo'lgach `loadCustomerDebts` bilan yozish mumkin.

---

# T2.7b uchun port tayyor: `CloudEventWriter` (`b96fa91`)

```ts
import { CloudEventWriter, CloudSyncPushStore } from '@mezon/db-cloud';
const writer = new CloudEventWriter(pool, new CloudSyncPushStore(pool), idGen);
const { results } = await writer.write({
  organizationId,
  nowMs,
  commands: [{ entity: 'products', entityId, type: 'products.updated', payload }],
});
// results[i]: { eventId, status: 'accepted' | 'rejected' | 'duplicate' | 'retry', reason?, error?, hlc }
```

| Mavzu | Qanday ishlaydi |
|---|---|
| Payload | Oddiy sync payload. Ichidagi `deviceId` va `hlc` yozuvchi tomonidan almashtiriladi. |
| Ruxsat etilgan jadvallar | Faqat tashkilot jadvallari. Store jadvallari `ORG_STREAM_STORE_ENTITY` bilan rad etiladi. |
| Validatsiya | Aynan push yo'li: `processSyncPushBatch`. |
| HLC | `cloud_hlc_state`, `org_hlc:<org>` lock ostida. Bir millisekundda `logical` 0, 1, … beriladi. HLC yozuvning joriy HLC'sidan har doim yuqori. |
| Oqim | `store_id = organization_id`. Hub pull kursorida tashkilot kaliti qabul qilinadi. |
| Virtual qurilma | `cloud_devices.status = 'system'`, token yo'q. Soxta token 401/403 oladi (test bor). |
| Testlar | `apps/cloud/src/sync-push.test.ts` → `T2.6b CloudEventWriter` (4 ta). Mutatsiyalar W1–W6 o'ldi. |

**Auditni chaqiruvchi yozadi.** Kim o'zgartirgani (`actorUserId`) port parametri emas: payload'dagi `updatedByUserId` kabi maydonlar orqali o'tadi. Kabinet audit yozuvini o'zi saqlaydi.

---

# P1 — oraliq hisobot: T2.6 tayyor (kod + testlar), keyingisi bulut yozuvchi porti va T2.5

Branch: `ishchi2/T2.6-projections`. PR hali ochilmagan, chunki P1 bitta PR bo'ladi. Kod ko'rinib turishi uchun push qilib boryapman.
`main` (`c40d723`, T2.7a) merge qilingan.

Oraliqda bajarilgan tekshiruvlar:
- **PR #29 (T2.7a):** QABUL va merge qilindi (`c40d723`).
- **C1:** SHARTLI QABUL. PR [#30](https://github.com/Shaxobiddin-Github/Mezon/pull/30) ochildi, S1–S5 testlari kutilmoqda.

## T2.6 — bajarildi

| Commit | Mazmun |
|---|---|
| `319f1ba` | Pull faqat tegilgan kalitlarni qayta hisoblaydi (stock: mahsulot; mijoz; yetkazib beruvchi), to'liq qayta qurish bilan bitta kodda. T2.4 xatosi tuzatildi: park'dan retry endi proyeksiyalardan **oldin** ishlaydi. |
| `3009c8b` | Fiskal: hujjatni faqat yaratgan hub yuboradi; Fake operator smena invariantlari; nazoratchining Z/OPEN mutatsiyalari 1 o'rniga 5 tadan testda ushlanadi. |
| `6d6fbfa` | Differensial test (200 seed), S6 savoli. |
| `5f43ba3` | **S6 (A):** `0020` (balans CHECK olib tashlandi); domen qoidalari; proyeksiya xatosi izolyatsiya qilinadi (`PROJECTION_FAILED`); `CUSTOMER_OVERPAID`; POS "Ortiqcha to'lov: X (mijoz haqqi)"; D1/D2/D6 uchun deterministik testlar. |
| `d367afd` | Perf: 50k mahsulot, 100k ledger, 100k harakat bazasida pull partiyasi **p95 9,5 ms** (< 50; avval 1,23 s). |
| `87a8adc` | Hub konflikt API'si: ko'rish, retry, o'rganildi, audit; tahrir yo'q. |
| `5ac8a60` | POS: menejer uchun "Sinxron konfliktlar" ekrani. |
| `cd4c8ab` | Bulut `cloud_sync_parked`: ko'rish, retry, o'rganildi (device token, RLS + o'z do'koni); hub proksisi; POS bo'limi. |

### Isbotlar

| Tekshiruv | Natija |
|---|---|
| `pnpm verify` (`5ac8a60` da, T2.7a merge'idan oldin) | 106 fayl, 890 test; perf 14; E2E 1; `db:check` 0 diff; depcruise toza |
| Differensial test, 200 seed | 201/201 o'tdi, 207 s. Har partiyadan keyin 5 proyeksiya jadvali to'liq qayta qurish bilan teng. Bo'sh solishtirishga qarshi tekshiruv bor. |
| Perf | p95 9,5 ms. Mutatsiya (to'liq qayta qurish) bilan 7 805 ms → yiqiladi. |

### Mutatsiyalar

| Guruh | Mutatsiyalar | Natija |
|---|---|---|
| Kalit yig'ish | D0–D10 (40 seed) va D1/D2/D6 deterministik | hammasi o'ldi |
| S6 | S6a CHECK qaytariladi; S6b proyeksiya xatosi qayta tashlanadi; S6c kredit limiti manfiy balansni limit deb oladi; S6d `CUSTOMER_OVERPAID` yo'q; S6e `PROJECTION_FAILED` qayta urinilmaydi | hammasi o'ldi |
| Fiskal | DEV1, DEV2, nazoratchining CZ va CO | hammasi o'ldi, CZ va CO 5 tadan |

## S6 bo'yicha qo'shimcha qarorlar (ko'rib chiqish uchun)

- **S7, sizga savol.** Manfiy balansli mijozga yangi nasiya savdo **ruxsat**: musbat delta ortiqcha to'lovni kamaytiradi.
  - Bu "ortiqcha pul qanday ishlatiladi" degan masalaga tegadi. Agar egasi "ortiqcha to'lovli mijozga nasiya yo'q" desa, bitta qator o'zgaradi.
  - To'lov, qaytarish, void va manfiy tuzatish avvalgidek `OVERPAYMENT_NOT_ALLOWED` bilan rad etiladi, chunki ular ortiqcha to'lovni yarata yoki chuqurlashtira olmaydi.
- **T2.4 dagi yashirin xato tuzatildi.** Domen avval `cur < 0` bo'lsa **har qanday** ledger amalini `VALIDATION_ERROR` bilan rad etar edi: sinxrondan ortiqcha to'lov olgan mijozga kassada hech narsa qilib bo'lmas edi.
- **Avtomatik yopish.** `CUSTOMER_OVERPAID` balans ≥ 0 bo'lganda o'zi yopiladi (`resolution = 'auto'`). "O'rganildi" qilingani summa o'zgarmaguncha qayta ochilmaydi.
- **"Ikki hub va bulutda balans teng".** Hub tomonda S6 testi bilan isbotlangan. Bulutda mijoz balansi proyeksiyasi yo'q (C1 dagi `loadCustomerDebts` FIFO'ni o'qishda hisoblaydi). Ikki hub va bulutni birga tekshiradigan PG testini T2.5 bilan birga qo'shaman.

## Konflikt modeli (hub)

| Kelib chiqishi | Qanday aniqlanadi | Retry | O'rganildi |
|---|---|---|---|
| push (bulut rad etgan) | `event_id` outbox'da bor | o'sha event id bilan outbox'ga qaytadi, bulut dedup qiladi | bor |
| pull | `event_json` saqlanadi | saqlangan konvert oddiy pull yo'lidan; yana yiqilsa yangi xato bilan qayta ochiladi; park bo'lsa ochiq qoladi | bor |
| `PROJECTION_FAILED` | kalit bo'yicha | kalit qayta hisoblanadi | bor |
| `CUSTOMER_OVERPAID` | — | yo'q (pulni qaytarish egasining qarori) | bor |

Har yopishda `resolution`, `resolved_by_user_id`, `resolution_note` (≤ 500) yoziladi va `sync.conflict_resolved` log chiqadi. Body strict: ma'lumotni tahrirlash maydoni yo'q (test bor).

## Migratsiyalar

- **Lokal `0020_sync_overpaid_conflicts`.** Ikkita jadval qayta yaratiladi. Eski yopilgan konfliktlar `resolution = 'auto'` oladi: generator buni noto'g'ri yaratgan edi, `INSERT … SELECT` qo'lda tuzatildi.
- **Bulut `0006_sync_parked_resolution`.** C1 ham `0006` ni oladi: kim keyin merge bo'lsa, raqamni o'sha qayta yaratadi (sizning qoidangiz).

## Qolgan ishlar (P1)

1. Bulut buyruq yozuvchi porti (T2.7b uchun). Navbatdagi ish.
2. T2.5: bootstrap, davom ettirish, tenant filtri, tiklash. `device_id` savoliga ham javob shu yerda bo'ladi.
3. `ALOQA.md` yo'laklar jadvali.
4. Oxirida `pnpm verify`, PR va to'liq hisobot.

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
