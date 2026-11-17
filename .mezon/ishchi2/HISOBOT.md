# Reja: T3.3 + T3.4 — Fiskal yadro va fiskal chek (bitta PR)

Branch: `ishchi2/T3.3-fiscal`. `main` dan ochilgan, T3.2 merge'idan keyin (`18d4a41`).
Bajaruvchi: ishchi2.
Holat: **REJA**. Kod yozilmagan, tasdiq kutilyapti.

## T3.2 merge holati

- PR #25 squash merge qilindi: `18d4a41 T3.2: Qoidalar dvigateli`. Tekshirilgan head: `944b81c`. Undagi to'rtala job yashil: Verify ubuntu, Verify windows, PG RLS va Detect. Desktop job `skipped`.
- `git diff 944b81c origin/main --stat` bo'sh. `ishchi2/T3.2-rules` remote va lokalda o'chirildi.
- Windows Verify ikki marta yiqildi, ikkalasi ham T1.7 dagi `customer.perf.test.ts` da: avval D4 testi 224 ms (chegara 100 ms), keyin 10k testi 30 s timeout. 10k testi bazani xom SQL bilan to'ldiradi va T3.2 kodini chaqirmaydi. Aynan shu kod bilan `f4c1675` yashil o'tgan edi. Shuning uchun buni runner sekinligi deb hisobladim va faqat Windows job'ini qayta ishga tushirdim. Test o'zgartirilmadi. Windows perf chegaralari flaky bo'lib qolsa, bu nazoratchining qarori.
- Iltimos bajarildi: `claude/T4.6-i18n` → `main` PR #26 ochildi, merge qilinmadi.

**Qat'iy qoida (§3.3):** operator, virtual kassa, OFD protokoli, endpoint, maydon nomlari va imzo jarayoni **o'ylab topilmaydi**. Hamma narsa `FiscalDriver` porti va `FakeFiscalDriver` orqali ishlaydi. Haqiqiy drayver T3.5 da, hujjat kelgach yoziladi. Driver javobidagi maydonlar (belgi, QR matni, raqam) **shaffof satrlar** sifatida saqlanadi va chop etiladi, ular kodda tahlil qilinmaydi.

Ko'rib chiqilgan kod:
- `return-repo.ts` (`assertSaleNotFiscalizedForVoidSync` ilgagi hozir bo'sh);
- `day_closes.fiscal_status` (T1.9 dagi `not_fiscalized` / `pending` / `fiscalized`);
- `escpos-encoder.ts` ("SINOV — FISKAL EMAS" banneri, QR yo'q);
- `sync-push-worker.ts` (T2.3 dagi worker naqshi: `setTimeout`, backoff, `stop()`);
- `contracts/src/sync.ts` dagi `MONOTONE_TRANSITION_RULES` va `apps/hub/src/monotone-parity.test.ts` (6 ta MONOTONE jadval);
- `shift-repo.ts` (`openShift`, `closeShift`).

---

## 0. Test qarzi (PR'ning birinchi commit'i, nazoratchining C3 va C4 mutatsiyalari)

- **C3:** bazadagi `local_rule_packages.package_version` qo'lda boshqa songa o'zgartiriladi, envelope'ga tegilmaydi. Kutilgan natija: `GET /rules/package/active` → `invalid`. Test kesh **to'lmagan** va **to'lgan** holatlarda ham yoziladi.
- **C4:** paket bir marta yuklanadi (kesh to'ladi), keyin bazadagi `envelope_json` qo'lda buziladi. Kutilgan natija: keyingi yuklashda `invalid`. Kesh kalit sifatida envelope baytlarini **va** versiya ustunini ishlatishi kerak. Hozirgi kesh faqat envelope'ni solishtiradi, shuning uchun C3 kesh to'lgan holatda omon qoladi. Kalitga versiya ham qo'shiladi.
- Ikkala mutatsiya qayta ishga tushirilib, natijasi hisobotga yoziladi.

---

## 1. `fiscal_docs` modeli

**Jadval `fiscal_docs`:** sinf **MONOTONE**, tenant doirasi `store`. Har bir savdo yoki qaytarish uchun bitta hujjat bo'ladi.

| Ustun | Ma'no |
|---|---|
| `id` | UUIDv7 |
| `organization_id`, `store_id` | tenant |
| `doc_kind` | `'sale' \| 'refund'` |
| `sale_id` | FK `sales` (`kind = 'sale'` bo'lsa) |
| `return_id` | FK `returns` (`kind = 'refund'` bo'lsa) |
| `idempotency_key` | `sale.id` yoki `return.id`; UNIQUE `(organization_id, idempotency_key)` |
| `status` | `pending \| sent \| confirmed \| failed \| rejected` |
| `attempts` | int ≥ 0 |
| `last_error_code`, `last_error_message` | driver xatosi (matn) |
| `sent_at_ms` | oxirgi yuborish oldidan yoziladi |
| `confirmed_at_ms` | driver tasdig'i vaqti |
| `fiscal_sign` | **shaffof** satr, driver javobidan |
| `fiscal_number` | **shaffof** satr |
| `qr_payload` | **shaffof** satr, QR'ga aynan shu chop etiladi |
| `driver_id` | `'fake'` yoki keyin `'<hamkor>'` |
| `offline_deadline_ms` | `created_at_ms + offline_window_ms` (konfiguratsiyadan) |

- **CHECK'lar:** `confirmed` bo'lsa, `fiscal_sign`, `fiscal_number` va `qr_payload` NOT NULL. Shu sababli driver javobisiz belgi bo'lmaydi, buni DB darajasida ham ta'minlayman. `doc_kind` va FK mosligi ham CHECK bilan tekshiriladi.
- **Nega MONOTONE:** hujjat yaratiladi va faqat oldinga qarab o'zgaradi. Fiskal holat `sales` jadvalidan alohida turadi (`schema/index.ts` dagi izoh shuni talab qiladi), shuning uchun `sales` ning MONOTONE kafolati buzilmaydi.
- **Sinxron:** jadval sinxronlanadi, chunki biznes kabineti fiskal holatni ko'rishi kerak. Bulut jufti **mening ishim** (ruxsat faqat o'z jadvalim uchun):
  - `packages/db-cloud/src/schema/domain-tables.ts` ga jadval;
  - bulut migratsiyasi;
  - `packages/contracts/src/sync.ts` ga payload sxemasi va `MONOTONE_TRANSITION_RULES.fiscal_docs`.
  - `sync-push-store.ts` va worker'ga tegmayman.
- **Faqat bitta yozuvchi:** fiskal hujjatni faqat savdo qilingan hub o'zgartiradi. Bulut tasdiqni qabul qiladi, lekin o'zi holatni o'zgartirmaydi.

---

## 2. Holat mashinasi

```
pending ──(worker: sent yozildi)──► sent ──(driver OK)──────────► confirmed   [terminal]
   ▲                                  │──(driver rad etdi)──────► rejected    [terminal → konflikt]
   │                                  └──(uzilish / timeout / 5xx)► failed
   └──────────(qayta urinish)──────────────────────────────────────┘
failed ──(worker yoki manager "qayta yuborish")──► sent
```

- Ruxsat etilgan o'tishlar: `pending→sent`, `sent→confirmed`, `sent→rejected`, `sent→failed`, `failed→sent`. Bulut jufti uchun `sent→sent` (attempts++) ham ruxsat.
- **Taqiqlangan:** `confirmed` dan har qanday o'tish, `rejected` dan har qanday o'tish, `pending→confirmed` (`sent` siz tasdiq), orqaga qaytish.
- **Bitta manba:** lokal SQLite `BEFORE UPDATE` triggerlari va bulutdagi `MONOTONE_TRANSITION_RULES.fiscal_docs` bitta jadvaldan (`FISCAL_DOC_TRANSITIONS` konstantasi `packages/domain`) olinadi. `monotone-parity.test.ts` ga **7-jadval** sifatida qo'shiladi: har bir ruxsatli o'tish ikkala tomonda o'tadi, har bir taqiqlangan o'tish ikkala tomonda rad etiladi.
- **`rejected` → konflikt:** hujjat `rejected` bo'lsa, `local_sync_conflicts` ga emas, alohida fiskal konflikt ro'yxatiga tushadi (8-bo'limdagi UI). Qo'lda hal qilish **qaytarish orqali** bo'ladi. Bekor qilishga (void) yo'l yo'q, 5-bo'limga qarang.

---

## 3. Navbat va idempotentlik

**Fon worker'i:** `apps/hub/src/fiscal-worker.ts`, T2.3 dagi `HubSyncPushWorker` naqshida (`setTimeout`, eksponensial backoff, `stop()`). Ketma-ketlik:

1. **Tanlash:** `pending` yoki `failed` hujjatlar, eng eskisidan.
2. **Ochiq qolgan `sent` hujjat bo'lsa:** worker uni **qayta yubormaydi**. Avval `driver.status(idempotencyKey)` ni so'raydi. Bunday hujjat avvalgi urinishda javob kelmasdan qolgan bo'ladi (qulash yoki uzilish). Javobga qarab:

   | `status` javobi | Natija |
   |---|---|
   | `confirmed` va maydonlar | `confirmed` |
   | `unknown` | `failed`, keyin oddiy qayta urinish |
   | `rejected` | `rejected` |
   | uzilish | `sent` qoladi, backoff |

3. **Yuborish:** `UPDATE … SET status = 'sent', attempts = attempts + 1, sent_at_ms = now` **alohida tranzaksiyada commit qilinadi** (WAL, `synchronous = FULL`). Shundan **keyingina** `driver.submitReceipt(doc)` chaqiriladi.
4. **Javob:** natija alohida tranzaksiyada yoziladi. `confirmed` bo'lsa, shaffof maydonlar va outbox hodisasi bilan.

**Ikki marta fiskallashtirmaslik isboti:**
- Driver'ga har doim `idempotencyKey = sale.id` yuboriladi. Haqiqiy operator ham shu kalit bo'yicha takrorni aniqlashi kerak, bu T3.5 hujjatida tekshiriladi.
- Hub tomonda driver faqat `sent` commit qilingandan keyin chaqiriladi. `sent` holatdagi hujjat esa **faqat `status()` orqali** davom ettiriladi. Shuning uchun driver hech qachon bir kalit bilan ikki marta `submit` olmaydi, agar `status` "yo'q" demagan bo'lsa.
- Bitta worker bir vaqtda bitta hujjatni oladi: hub ichida mutex. Ikkinchi worker instansiyasi bo'lmaydi.

**`FakeFiscalDriver`** (`packages/drivers/src/fiscal/fake-driver.ts`):
- Xotiradagi daftar `idempotencyKey → natija`.
- Takroriy `submit` kelsa, yangi fiskal belgi **berilmaydi**, birinchi natija qaytariladi, `submitCount` hisoblagichi oshadi (testlar shuni tekshiradi).
- Rejimlar: `ok`, `reject`, `timeout`, `throw-after-accept` (driver qabul qilgan, lekin javob yo'qolgan holat), `offline`.
- Belgilar: `SINOV-…` prefiksli, QR matni `SINOV|…`. Haqiqiy formatga o'xshatilmaydi.

**Qulash testi:** child process (T1.4 dagi C1 testi naqshida):
- (a) `sent` commit qilingandan keyin va driver chaqirilishidan **oldin** o'ldiriladi;
- (b) driver `accept` qilgandan keyin, lekin javob yozilishidan oldin o'ldiriladi. Fake driver daftari faylda saqlanadi, shunda u qulashdan keyin ham "ko'rinadi".

Qayta ishga tushgach worker `status()` ni so'raydi: (a) da `unknown`, keyin yuboradi; (b) da `confirmed` qaytadi va **qayta yubormaydi**. Ikkala holatda ham `submitCount` kalit uchun ≤ 1.

---

## 4. Savdo oqimi (§3.2 uzluksizlik)

- **Savdo driver'ni hech qachon kutmaydi.** `completeSaleCoreInTxSync` ichida, fiskal rejim yoqiq bo'lsa, o'sha tranzaksiyada `fiscal_docs(status = 'pending')` yoziladi (§3.1.10 dagi atomiklik). Driver chaqiruvi tranzaksiyadan tashqarida, worker'da bo'ladi.
- **Variantlar:**

  | | Variant A (taklif) | Variant B |
  |---|---|---|
  | Chek | darhol chiqadi, `pending` bo'lsa "FISKAL KUTILMOQDA" bilan; tasdiqdan keyin fiskal nusxa qayta chop etilishi mumkin | tasdiqni N soniya kutadi |
  | §3.2 | buzilmaydi | internet yo'qligi savdoni sekinlashtiradi, buzadi |

  **Variant A ni taklif qilaman.**
- **Oflayn muddat** `local_hub_config.fiscal_offline_window_ms` da saqlanadi. Standart qiymat 24 soat, `[TASDIQLANSIN]` belgisi bilan (2019-yil loyihasi). U API orqali o'zgartirilmaydi, faqat konfiguratsiyadan.
  - Muddatning 75% o'tganda: `GET /fiscal/status` va POS'da ogohlantirish.
  - **Muddat o'tib ketganda:** taklifim — yangi savdo bloklanadi (`FISCAL_OFFLINE_EXPIRED`, `rules` dagi kabi `block`), faqat fiskal rejimda. Sabab: qonuniy talab, §3.2 ham "qonuniy qoida to'xtata oladi" deydi. Bu qonuniy masala, shuning uchun **S1** savoli bilan egasidan tasdiq so'rayman. Javob kelguncha muddat faqat ogohlantiradi.
- **`completeSale` integratsiyasi:** fiskal rejim **o'chiq** bo'lsa, `fiscal_docs` yozilmaydi (hozirgi xatti-harakat). Fiskal rejim T3.3 da faqat testlarda va owner'ning maxsus endpoint'i orqali yoqiladi (6-bo'lim).

---

## 5. Bekor qilish va qaytarish

- **`void`** (`assertSaleNotFiscalizedForVoidSync`):

  | `fiscal_docs` holati | Natija |
  |---|---|
  | `confirmed`, yoki `sent` (natija noma'lum) | `FISCALIZED_SALE_CANNOT_VOID`, faqat qaytarish mumkin |
  | `pending` (hali yuborilmagan) | void mumkin; hujjat **o'sha tranzaksiyada** yakuniy holatga o'tadi (taklif: yangi terminal holat `cancelled`, `pending→cancelled`) va worker uni olmaydi |
  | `failed` | `status()` javobi noma'lum, shuning uchun xavfsiz tomon: void taqiqlanadi, qaytarish orqali (taklif) |
  | `rejected` | void mumkin, chunki operator qabul qilmagan (taklif, **S2**) |

- **Qaytarish:** fiskallashgan (`confirmed`) savdo qaytarilsa, o'sha tranzaksiyada `fiscal_docs(kind = 'refund', idempotency_key = return.id, status = 'pending')` yoziladi. Worker uni `driver.submitRefund` ga yuboradi, oqim xuddi savdodagidek.
- **Fiskallashmagan savdoni qaytarish:** refund hujjati yaratilmaydi. Asl savdo `pending` yoki `failed` bo'lsa, qaytarish **ruxsat etilmaydi**, toki savdo hujjati yakuniy holatga kelmaguncha (`FISCAL_SALE_NOT_SETTLED`). Bu ikki xil holat aralashib ketmasligi uchun. **S3** savoli.

---

## 6. Fiskal rejim

- **MXIK'siz qator** fiskal rejimda **block** bo'ladi. T3.2 dan qolgan bo'shliq: `rules/evaluate` da `MXIK_MISSING` fiskal rejimda `block`ga ko'chadi, oddiy rejimda warn qoladi. Shu bilan limit guruhidan chetda qolgan MXIK'siz qator muammosi ham yopiladi.
- **Smena:**
  - `openShift` fiskal rejimda `driver.openShift()` ni chaqiradi;
  - `closeShift` → `driver.closeShift()` (Z-hisobot);
  - natija `day_closes.fiscal_status` / `fiscal_report_no` ga yoziladi (bu ustunlar T1.9 da mavjud).
  - **§3.2:** driver javob bermasa, smena ochilish yoki yopilishi **bloklanmaydi**: smena operatsiyasi navbatga (`pending`) tushadi va worker davom ettiradi. Ochilmagan fiskal smena paytida savdo qilinishi mumkinmi — **S4** savoli. Hujjat kelguncha taxmin qilmayman, hozircha bloklamayman.
- **Rejimni yoqish:** `PUT /fiscal/mode` faqat **owner** uchun (yangi ruxsat `fiscal:mode`). Oldinga shartlar:
  - imzolangan rules paketi `ok` holatda;
  - driver `status()` ga javob beradi;
  - MXIK'siz faol mahsulotlar soni = 0 (ogohlantirish emas, rad etish).
  - Har bir yoqish yoki o'chirish **audit** sifatida outbox hodisasi bo'ladi (`fiscal_mode.changed`, `userId` bilan). T3.8 dagi to'liq audit jurnaliga keyin ulanadi.
  - **GEMINI.md F3 yakuni:** haqiqiy fiskal ishga tushirish faqat egasining yozma tasdig'i bilan. Shuning uchun `FakeFiscalDriver` bilan rejim yoqiq bo'lsa ham chekda "SINOV — FISKAL EMAS" saqlanadi (7-bo'lim).

---

## 7. T3.4 — Fiskal chek

- **Maydonlar konfiguratsiyadan:** `local_hub_config.fiscal_receipt_fields_json`, `[TASDIQLANSIN]` (2019-yil loyihasi). Format:
  ```json
  [{ "key": "fiscalSign", "label": "FB" }, { "key": "fiscalNumber", "label": "FD" }]
  ```
  Ro'yxat **kodda yo'q**; testlar sintetik ro'yxat ishlatadi. Ruxsat etilgan `key` qiymatlari faqat `fiscal_docs` dagi shaffof maydonlar: `fiscalSign`, `fiscalNumber`, `confirmedAt`, `driverId`, shuningdek tashkilot STIR'i (T3.1).
- **QR:** ESC/POS `GS ( k` buyrug'i (model 2, xato tuzatish M). Bu printer standarti, fiskal API emas. QR'ga `qr_payload` **aynan** joylanadi. Printer drayveri (`escpos-encoder.ts`) kengaytiriladi, `qrPayload` bo'sh bo'lsa QR chiqmaydi.
- **Belgi qoidasi:**

  | Holat | Chekdagi belgi |
  |---|---|
  | `confirmed` va konfiguratsiyadagi **barcha** maydonlar mavjud | "FISKAL CHEK" va fiskal maydonlar, QR |
  | `confirmed`, lekin biror maydon yetishmaydi | "FISKAL CHEK" **chiqmaydi**, "FISKAL MA'LUMOT TO'LIQ EMAS" chiqadi |
  | `pending`, `sent` yoki `failed` | "FISKAL KUTILMOQDA" |
  | fiskal rejim o'chiq yoki `rejected` | "FISKAL EMAS" |
  | Fake drayver (har qanday holat) | qo'shimcha ravishda "SINOV — FISKAL EMAS" (§3.3) |

- **Bayt snapshot testlari:** 58 va 80 mm qog'ozda `confirmed`, `pending`, `failed`, maydon yetishmagan holat, `rejected` va QR. Mavjud `escpos-encoder.test.ts` naqshida.
- **Qayta chop etish:** tasdiqdan keyin hujjat `confirmed` bo'lsa, `POST /sales/:id/print` fiskal nusxani chiqaradi. NUSXA belgisi T1.12 dagidek ishlaydi.

---

## 8. UI

- **Chek ekrani:** fiskal holat belgisi (kutilmoqda, tasdiqlandi, xato, rad etildi), qisqa so'rov bilan yangilanadi.
- **"Fiskallashmagan cheklar" ekrani** (manager va owner): `pending`, `failed`, `rejected` ro'yxati, oflayn muddatgacha qolgan vaqt. "Qayta yuborish" tugmasi `failed→sent` ni worker navbatining boshiga qo'yadi (manager). `rejected` uchun "qaytarish orqali hal qilish" ko'rsatmasi.
- Smena va POS sarlavhasida oflayn muddat ogohlantirishi.
- Barcha matnlar i18n orqali. **T4.6** `main` ga birinchi tushsa, har yangi `uz-Latn` kaliti uchun `RU_MESSAGES` ga ruscha tarjima ham qo'shaman.

---

## 9. Testlar va mutatsiya rejasi

**Domain va drivers (unit):**
- `FISCAL_DOC_TRANSITIONS` jadvali: har ruxsatli va taqiqlangan o'tish;
- `FakeFiscalDriver` idempotentligi: 100 ta takroriy `submit` → 1 ta belgi;
- QR bayt kodlovchisi: uzunlik baytlari, 0 va 7089 chegara qiymatlari.

**db-local:**
- `fiscal_docs` CHECK'lari: `confirmed` maydonlarsiz bo'lmaydi;
- triggerlar;
- `completeSale` fiskal rejimda `pending` yozadi, rollback'da yozmaydi;
- void va qaytarish gate'lari (5-bo'limdagi jadval).

**Hub integratsiya:**
- worker: OK, reject, timeout → `failed` → qayta urinish → `confirmed`;
- `throw-after-accept` → `status()` → `confirmed`, `submitCount = 1`;
- uzilish paytida savdo davom etadi;
- oflayn muddat ogohlantirishi;
- `PUT /fiscal/mode` RBAC (manager 403) va oldinga shartlar;
- MXIK'siz qator fiskal rejimda 422;
- smena ochish va yopish driver bilan, driver ishlamaganda ham smena bloklanmaydi.

**Qulash:** 3-bo'limdagi child process testlari (a) va (b).

**Monotone pariteti:** `fiscal_docs` 7-jadval sifatida.

**Bulut:** `sync-schema-parity.test.ts` va bulut migratsiyasi (`fiscal_docs` uchun PG testlari CI'da).

**Bayt snapshot:** 7-bo'lim.

**Mutatsiyalar** (nazoratchi talab qilganlar va qo'shimchalar):

| # | Mutatsiya | Kutilgan |
|---|---|---|
| F1 | `sent` yozilmasdan driver'ga yuborish | qulash testi (a) va `submitCount` |
| F2 | Uzilishdan keyin `status` so'ramasdan qayta yuborish | `throw-after-accept` testi, `submitCount = 2` |
| F3 | `confirmed → pending` ruxsat etiladi | trigger va parity testi |
| F4 | Fiskal chekni `void` qilishga ruxsat | void gate testi |
| F5 | Maydon yetishmasa ham "FISKAL CHEK" chiqadi | bayt snapshot |
| F6 | MXIK'siz qator fiskal rejimda o'tadi | hub 422 testi |
| F7 | `confirmed` CHECK olib tashlanadi (belgisiz tasdiq) | DB testi |
| F8 | Fake driver takroriy `submit` da yangi belgi beradi | idempotentlik testi |
| F9 | `pending` hujjat savdo tranzaksiyasidan tashqarida yoziladi | rollback testi |
| F10 | Manager fiskal rejimni yoqa oladi | RBAC testi |
| F11 | Oflayn muddat ogohlantirishi o'chiriladi | muddat testi |
| C3, C4 | T3.2 qarzlari | 0-bo'lim |

---

## 10. Bog'liqliklar va fayllar

| Joy | Fayl |
|---|---|
| `packages/domain` | `fiscal.ts`: holatlar, `FISCAL_DOC_TRANSITIONS`, belgi qoidasi (toza funksiya `resolveReceiptFiscalMark`) |
| `packages/drivers` | `fiscal/fiscal-driver.ts` (port interfeysi), `fiscal/fake-driver.ts`; `printer/escpos-encoder.ts` ga QR va belgi qatorlari |
| `packages/contracts` | `fiscal.ts` (API DTO), `sync.ts` (faqat `fiscal_docs` payload sxemasi va transition qoidasi) |
| `packages/db-local` | sxema, migratsiya (`main` dagi oxirgi raqamdan keyingi bo'sh raqam, hozir `0018`, chunki `main` dagi oxirgisi `0017`. PR dan oldin `main` merge qilinadi va raqam qayta tekshiriladi), `fiscal-repo.ts`, `sale-repo.ts` / `return-repo.ts` / `shift-repo.ts` gate'lari |
| `packages/db-cloud` | faqat `fiscal_docs` jadvali va migratsiyasi |
| `apps/hub` | `fiscal-worker.ts`, `fiscal-service.ts`, `fiscal-routes.ts`, `printer-service.ts` (fiskal belgi va QR) |
| `apps/pos` | chek holati va fiskallashmagan cheklar ekrani |
| `packages/rules` | `MXIK_MISSING` fiskal rejimda block |

- depcruise o'zgarmaydi: `drivers` faqat `domain` ni import qiladi, hub `drivers` dan foydalanadi.
- Yangi kutubxona kerak emas: QR uchun printerning o'zi `GS ( k` ni bajaradi, rasm generatsiyasi kerak emas.
- **Hajm:** katta, lekin nazoratchi bitta PR so'radi. Ichida bosqichma-bosqich commit'lar bo'ladi: qarz → model va holat mashinasi → worker → savdo, void va qaytarish → smena va rejim → chek va QR → UI.

---

## Savol

Egasi yoki nazoratchi qarori kerak bo'lgan savollar.

Barcha savollar nazoratchi orqali yuboriladi. "(egasi)" belgisi javob egasidan kelishi kerakligini bildiradi.

- **S1 (egasi):** oflayn muddat (24 soat `[TASDIQLANSIN]`) o'tib ketsa, fiskal rejimda yangi savdo bloklanadimi (taklif) yoki faqat ogohlantirish chiqadimi?
- **S2 (nazoratchi):** `rejected` chekni void qilishga ruxsat beriladimi (taklif: ha, operator qabul qilmagan) yoki faqat qaytarish orqalimi?
- **S3 (nazoratchi):** fiskal holati yakunlanmagan (`pending` / `failed`) savdoni qaytarish bloklanadimi (taklif), yoki refund hujjati asl hujjat yakunlanishini kutib navbatda turadimi?
- **S4 (egasi):** fiskal smena driver'da ochilmagan bo'lsa (oflayn), savdo qilish mumkinmi? Hujjat kelguncha bloklamayman.
- **S5 (nazoratchi):** `void` qilingan `pending` hujjat uchun yangi terminal holat `cancelled` qo'shishga ruxsat beriladimi (spetsifikatsiyada 5 ta holat bor)? Muqobil yo'l: hujjatni o'chirmasdan `rejected` deb belgilash, lekin bu holat ma'nosini buzadi.
