# Reja: T2.3 — Sinxron Push Yadrosi (Outbox Push Engine)

## 0. Kirish va T2.2 yakuni
- **T2.2 xulosasi:** Claude tomonidan `QABUL` qilindi (kod `a76a062`).
- **Qarzlar:** T2.2 qarz commit'ida (`8eb5ecd`) bartaraf etildi:
  - Brute-force rate limiting testi qo'shildi (20 noto'g'ri urinish -> 21-chisi 429; mutatsiya testi bilan isbotlandi);
  - Windows CI runner'ida Testcontainers testlarini `shouldRunPgTests()` orqali shartli skip qilish va Ubuntu `postgres-rls` job'ida esa skip'ni qat'iy taqiqlash yo'lga qo'yildi;
  - Docker aniqlash keshlandi va timeout 10 soniyaga uzaytirildi.
- **CI & Merge:** PR #22 ochildi, GitHub Actions'da barcha 5 ta CI job (`Verify ubuntu`, `Verify windows`, `PostgreSQL RLS`, `Desktop Installer`, `Detect Desktop Changes`) 100% yashil o'tdi va `12072ea1388631c7027e2f5a43c5a1f20f2ea6a1` commit'i bilan `main`ga squash and merge qilindi. `gemini/T2.2-device-pairing` branch'i o'chirildi va `gemini/T2.3-sync-push` branch'i ochildi.

---

## 1. T2.3 Me'moriy tuzilishi va maqsadi

T2.3 vazifasining maqsadi — `GEMINI.md` 4-bo'limidagi sinxronizatsiya spetsifikatsiyasiga to'liq mos keladigan **Push dvigatelini** (Hub yuboruvchisi va Bulut qabul qiluvchisini) qurish.

```text
Do'kon Hub'i (SQLite)                               Bulut (PostgreSQL 18 RLS)
┌─────────────────────────┐                         ┌──────────────────────────────────────────────┐
│  local_outbox (pending) │                         │  POST /api/v1/sync/push                      │
│            │            │                         │    │                                         │
│     [Push Worker]       │   POST /sync/push       │    ├─ 1. Bearer deviceToken (D4) & Status    │
│    (deviceSeq order,    ├────────────────────────►│    ├─ 2. Deduplication: UNIQUE(org, event_id)│
│     batch: max 100)     │   (JSON payload)        │    ├─ 3. Tenant & Store validation           │
│            │            │                         │    ├─ 4. Schema reference check (FK)         │
│            │            │                         │    ├─ 5. Single-writer rule (stock/batches)  │
│            ▼            │                         │    ├─ 6. HLC Skew guard (MAX_SKEW 5 min)     │
│  Response Handler:      │   JSON Response         │    ├─ 7. FACT/ATTR/MONOTONE application      │
│  - accepted  -> acked   │◄────────────────────────┤    └─ 8. Gapless position (advisory lock)    │
│  - duplicate -> acked   │   { results: [...] }    └──────────────────────────────────────────────┘
│  - rejected  -> conflict│
│  - retry     -> backoff │
└─────────────────────────┘
```

---

## 2. a) Hub tomoni (Yuboruvchi - Push Worker)

### 2.1. Paketlash va navbat (`local_outbox`)
1. **Paketlash tartibi:** `local_outbox` jadvalidan `status = 'pending'` bo'lgan yozuvlar qat'iy ravishda `deviceSeq ASC` tartibida olinadi (`SELECT ... WHERE status = 'pending' ORDER BY device_seq ASC LIMIT ?`).
2. **Paket hajmi chegarasi:**
   - Maksimal hodisalar soni: **100 ta hodisa**.
   - Maksimal paket hajmi: **1 MB** (agar 100 taga yetmasdan JSON hajmi 1 MB dan oshsa, paket shu joyda kesiladi).
3. **Fon xizmati (`HubSyncPushWorker`):**
   - Faqat hub bulut bilan juftlangan bo'lsa (`local_cloud_state.status === 'paired'`) ishlaydi.
   - Interval: odatiy holatda har 3-5 soniyada yoki yangi outbox hodisasi qo'shilganda trigger orqali tezkor uyg'onadi.
   - **Eksponensial backoff:** Tarmoq xatolarida (`NETWORK_ERROR`, 502, timeout, server unavailable) urinishlar oralig'i: `1s -> 2s -> 4s -> 8s -> ... -> max 60s`. Muvaffaqiyatli push'dan keyin backoff 0 ga qaytadi.

### 2.2. Javoblarni qayta ishlash holatlari
Bulutdan `POST /api/v1/sync/push` ga quyidagi formatdagi javob keladi:
`{ results: Array<{ eventId: string, status: 'accepted' | 'duplicate' | 'rejected' | 'retry', reason?: string }> }`

- **`accepted`:** Hodisa bulutda muvaffaqiyatli qo'llandi.
  - Hub `local_outbox` jadvalida `status = 'acked'`, `pushed_at_ms = nowMs` deb belgilaydi.
- **`duplicate`:** Hodisa oldinroq qabul qilingan (tarmoq uzilib qayta yuborilgan holat).
  - Hub buni ham muvaffaqiyat deb hisoblaydi va `status = 'acked'` deb belgilaydi.
- **`rejected`:** Doimiy xato (masalan, begona do'kon ID, buzilgan payload, mavjud bo'lmagan havola, yagona yozuvchi qoidasining buzilishi).
  - **Navbatni to'smaslik qoidasi:** Xato hodisa hech qachon cheksiz qayta yuborilib butun navbatni to'sib qo'ymasligi shart!
  - `local_outbox` da `status = 'rejected'`, `last_error = reason` deb yoziladi.
  - Yangi `local_sync_conflicts` (yoki `local_stock_conflicts`) jadvaliga ziddiyat yozuvi qayd etiladi (`id`, `event_id`, `entity`, `entity_id`, `reason`, `payload`, `created_at_ms`). Navbat keyingi `deviceSeq` bo'yicha davom etadi.
- **`retry`:** Vaqtinchalik xato (masalan, bulut tomonida vaqtinchalik lock timeout).
  - Hodisa `pending` holatida qoladi, `attempts = attempts + 1`, backoff ishga tushadi va qayta uriniladi.

### 2.3. Faqat sinxron jadvallar kafolati
- T0.5 va T2.2 D3 da o'rnatilgan qoida: Faqat `localSchemaRegistry` da `tableClass !== 'LOCAL'` bo'lgan jadvallar outbox hodisasi hosil qiladi.
- `local_outbox`, `local_pin_credentials`, `local_cloud_state`, `local_device_state`, `local_stock_balances`, `local_carts` kabi LOCAL jadvallar hech qachon `local_outbox` ga tushmaydi.
- Sinxronizatsiya yuboruvchisi paket yig'ishda har bir hodisaning `entityClass !== 'LOCAL'` ekanini qo'shimcha assert qiladi.

### 2.4. Qurilma tokeni va xavfsizlik
- Hub `deviceToken` ni T2.2 D4 da yaratilgan `SafeStoragePort` orqali xotiraga ochadi (`getDecryptedToken()`).
- So'rov `Authorization: Bearer <deviceToken>` header'i bilan yuboriladi.
- Agar bulutdan `401 Unauthorized` yoki `DEVICE_REVOKED` qaytsa:
  - Push jarayoni darhol to'xtatiladi;
  - `local_cloud_state` jadvalidagi holat `status = 'revoked'` ga o'tkaziladi;
  - Tizim loglariga xavfsizlik ogohlantirishi yoziladi;
  - Qayta urinishlar to'xtatiladi (foydalanuvchi do'konni qayta juftlamaguncha).

---

## 3. b) Bulut tomoni (Qabul qiluvchi - Sync Push Engine)

### 3.1. Endpoint va Autentifikatsiya
- **Endpoint:** `POST /api/v1/sync/push`
- **Autentifikatsiya:** T2.2 D2 da yaratilgan `deviceStore.verifyDeviceToken(deviceToken, nowMs)`.
- Token orqali aniqlanadigan kontekst:
  - `organizationId`: Tashkilot IDsi;
  - `storeId`: Do'kon IDsi;
  - `deviceId`: Qurilma IDsi;
  - `deviceStatus`: Agar `active` bo'lmasa -> `401 / 403`.
- Barcha amallar RLS kontekstida bajariladi: `withPgTenantContext(pool, organizationId, ...)`.

### 3.2. Har bir hodisa uchun tekshiruv va qo'llash bosqichlari
Har bir incoming hodisa `SyncEventEnvelope` formatida bo'ladi:
```ts
interface SyncEventEnvelope {
  eventId: UuidV7;
  organizationId: UuidV7;
  storeId: UuidV7 | null;
  deviceId: UuidV7;
  deviceSeq: bigint;
  hlc: string;
  type: string;
  entity: string;
  entityId: UuidV7;
  entityClass: 'FACT' | 'ATTR' | 'MONOTONE';
  schemaVersion: number;
  payload: Record<string, unknown>;
}
```

Tranzaksiya ichida quyidagi qat'iy tartibda ishlov beriladi:

1. **Deduplikatsiya (Takror nazorati):**
   - `cloud_sync_events` jadvalida `UNIQUE(organization_id, event_id)` mavjud.
   - Agar hodisa avval qabul qilingan bo'lsa -> natija: `{ eventId, status: 'duplicate' }`. Hech qanday qayta yozish bo'lmaydi.
2. **Tenant & Store tekshiruvi:**
   - `envelope.organizationId !== context.organizationId` -> darhol `rejected` (`TENANT_MISMATCH`).
   - Agar `envelope.storeId` ko'rsatilgan bo'lsa va u `context.storeId` ga teng bo'lmasa -> `rejected` (`STORE_MISMATCH`).
   - Qurilma o'zi tegishli bo'lmagan do'kon nomidan hodisa yubora olmaydi.
3. **Payload havolalari (Foreign Entity / Reference integrity):**
   - Hodisadagi chet havolalar (masalan, `sale_lines.sale_id`, `stock_moves.product_id`, `payments.sale_id`) shu tashkilotga tegishli ekanligi umumiy sxema metama'lumotlari (`foreignKeys`) bo'yicha tekshiriladi.
   - Agar payload boshqa tashkilotga tegishli `id`ga havola qilsa yoki mavjud bo'lmagan majburiy ota entity'ga tayansa -> `rejected` (`FOREIGN_ENTITY_MISMATCH`).
4. **Yagona yozuvchi qoidasi (Single-Writer Rule):**
   - `stock_moves` va `batches` jadvallari faqat o'sha do'kon hub'idan yozilishi mumkin (`GEMINI.md` 4-bo'lim).
   - Agar do'kon B hub'i do'kon A omboriga tegishli harakat yuborsa -> `rejected` (`SINGLE_WRITER_VIOLATION`).
5. **Vaqt nazorati (HLC Skew Guard):**
   - Kelajakdagi soat: Agar `parseHlc(envelope.hlc).wallTimeMs > nowMs + 5 daqiqa (MAX_SKEW)` bo'lsa:
   - Server hodisaning HLC'sini serverning joriy HLC vaqtiga tushiradi (`clamped_hlc`) va hodisada `hlc_adjusted = true` deb qayd etadi.
   - Soati orqada yoki buzilgan qurilma boshqa qurilmalarning to'g'ri ma'lumotlarini ezib (overwrite) keta olmaydi.
6. **Klass qoidalari (Entity Class Rules):**
   - **`FACT`:**
     - O'zgarmas hodisalar (masalan, `sale_lines`, `payments`, `cash_moves`, `stock_moves`, `return_lines`).
     - Faqat `INSERT` qilinadi. Hech qanday `UPDATE` yoki `DELETE` bo'lishi mumkin emas.
   - **`ATTR`:**
     - Tahrirlanadigan holatlar (masalan, `products`, `customers`, `categories`, `users`).
     - HLC bo'yicha Oxirgi Yozuvchi Yutadi (Last-Write-Wins / LWW).
     - Agar bazadagi mavjud qatorning `hlc >= incoming.hlc` bo'lsa: yangi yozuv qo'llanmaydi (chunki bazadagi yozuv yangiroq), ammo hodisa muvaffaqiyatli qabul qilingan hisoblanadi (`accepted`).
     - Agar `incoming.hlc > current.hlc` bo'lsa: satr yangilanadi (`UPDATE ... SET ..., hlc = incoming.hlc`).
   - **`MONOTONE`:**
     - Bir tomonlama o'tishlar (masalan, `sales.voided_at_ms`, `orders.delivered_at_ms`, `shifts.closed_at_ms`, `inventory_counts.finalized_at_ms`).
     - Faqat ruxsat etilgan bir tomonlama o'tish: `NULL -> NON-NULL`.
     - Agar allaqachon `voided` bo'lgan chekni qayta ochish yoki o'zgartirish kelgan bo'lsa -> `rejected` (`INVALID_MONOTONE_TRANSITION`).
7. **Bo'shliqsiz pozitsiya hisoblagichi (Pull uchun poydevor):**
   - Har bir do'kon uchun alohida `cloud_store_sync_positions` jadvali (`organization_id`, `store_id`, `last_position`).
   - Har bir qabul qilingan (`accepted`) hodisa yozilayotganda do'kon bo'yicha tranzaksiyaviy qulf olinadi:
     `SELECT pg_advisory_xact_lock(hashtext('store_sync:' || store_id))`
   - Pozitsiya olinadi: `position = last_position + 1`, `cloud_sync_events` ga yoziladi va `last_position` yangilanadi.
   - Natijada har bir do'kon uchun hodisalar qat'iy 1, 2, 3... ketma-ketlikda, bo'shliqsiz saqlanadi (T2.4 Pull uchun tayyor poydevor).

---

## 4. Bulut sxemasi: Sinxron jadvallari ro'yxati

F2 bosqichida PostgreSQL bazasida saqlanadigan va sinxron qilinadigan jadvallar ro'yxati:

### 4.1. Sinxron qilinadigan 36 ta domen jadvali:
| # | Jadval nomi | Sinfi | Tenant Scope | Izoh |
|---|---|---|---|---|
| 1 | `users` | `ATTR` | `organization` | Xodimlar (PIN va parolsiz) |
| 2 | `categories` | `ATTR` | `organization` | Katalog toifalari |
| 3 | `products` | `ATTR` | `organization` | Mahsulotlar katalogi |
| 4 | `product_variants` | `ATTR` | `organization` | Mahsulot variantlari |
| 5 | `product_barcodes` | `ATTR` | `organization` | Shtrixkodlar |
| 6 | `price_changes` | `FACT` | `organization` | Narx o'zgarishlari tarixi |
| 7 | `batches` | `ATTR` | `organization` | Mahsulot partiyalari (Single-writer) |
| 8 | `stock_moves` | `FACT` | `organization` | Ombor harakatlari (Single-writer) |
| 9 | `inventory_counts` | `MONOTONE` | `organization` | Qayta sanash (reviziya) |
| 10 | `inventory_count_lines` | `FACT` | `organization` | Sanash qatorlari |
| 11 | `promotions` | `ATTR` | `organization` | Aksiyalar va chegirmalar |
| 12 | `sales` | `MONOTONE` | `organization` | Savdolar / Cheklar |
| 13 | `sale_lines` | `FACT` | `organization` | Chek qatorlari (snapshot) |
| 14 | `payments` | `FACT` | `organization` | To'lovlar |
| 15 | `cash_moves` | `FACT` | `organization` | Kassa pul harakatlari |
| 16 | `returns` | `FACT` | `organization` | Qaytuv hujjatlari |
| 17 | `return_lines` | `FACT` | `organization` | Qaytuv qatorlari |
| 18 | `return_payments` | `FACT` | `organization` | Qaytuv to'lovlari |
| 19 | `customers` | `ATTR` | `organization` | Mijozlar bazasi |
| 20 | `customer_ledger` | `FACT` | `organization` | Mijoz qarz daftari |
| 21 | `suppliers` | `ATTR` | `organization` | Ta'minotchilar |
| 22 | `goods_receivings` | `MONOTONE` | `organization` | Kirim fakturalari |
| 23 | `goods_receiving_lines` | `FACT` | `organization` | Kirim qatorlari |
| 24 | `receiving_cost_confirmations` | `FACT` | `organization` | Tannarx tasdiqlashlari |
| 25 | `supplier_returns` | `FACT` | `organization` | Ta'minotchiga qaytarish |
| 26 | `supplier_return_lines` | `FACT` | `organization` | Ta'minotchiga qaytarish qatorlari |
| 27 | `supplier_ledger` | `FACT` | `organization` | Ta'minotchi qarz daftari |
| 28 | `shifts` | `MONOTONE` | `organization` | Kassir smenalari |
| 29 | `shift_cashier_sessions` | `FACT` | `organization` | Smena kassir sessiyalari |
| 30 | `shift_closures` | `FACT` | `organization` | Smena yopilishlari |
| 31 | `shift_closure_method_totals` | `FACT` | `organization` | Smena to'lov usullari yig'indisi |
| 32 | `shift_closure_cashiers` | `FACT` | `organization` | Smena kassirlari balansi |
| 33 | `day_closes` | `FACT` | `organization` | Kun yakunlari (Z-hisobot) |
| 34 | `orders` | `MONOTONE` | `organization` | Oldindan buyurtmalar |
| 35 | `order_lines` | `FACT` | `organization` | Buyurtma qatorlari |
| 36 | `order_payments` | `FACT` | `organization` | Buyurtma avans to'lovlari |

### 4.2. Sinxron tizim jadvallari (Bulutda yangi qo'shiladigan):
- `cloud_sync_events` (`id`, `organization_id`, `store_id`, `device_id`, `device_seq`, `position`, `hlc`, `type`, `entity`, `entity_id`, `class`, `schema_version`, `payload`, `created_at_ms`):
  - `UNIQUE(organization_id, event_id)` — takrorlarni aniqlash;
  - `UNIQUE(organization_id, store_id, position)` — bo'shliqsiz pull oqimi.
- `cloud_store_sync_positions` (`organization_id`, `store_id`, `last_position`, `updated_at_ms`):
  - Har do'konning eng so'nggi global pozitsiyasi.

### 4.3. Bulutga umuman sinxron qilinmaydigan 17 ta LOCAL jadval:
`local_device_state`, `local_outbox`, `local_hub_config`, `local_pin_credentials`, `local_device_auth_state`, `local_sessions`, `local_stock_balances`, `local_batch_balances`, `local_stock_conflicts`, `local_carts`, `local_cart_lines`, `local_customer_balances`, `local_receiving_drafts`, `local_receiving_draft_lines`, `local_supplier_balances`, `local_receipt_prints`, `local_cash_drawer_events`, `local_cloud_state`.
*(Eslatma: Qoldiqlar va balanslar proyeksiyalar hisoblanadi va bulutda ledger jadvallari orqali hisoblanadi, sinxron qilinmaydi).*

---

## 5. c) Testlar rejasi

### 5.1. Mezonlardagi asosiy to'rtlik:
1. **1 yomon + 10 yaxshi hodisa:**
   - 11 ta hodisadan iborat bitta paket yuboriladi (10 ta normal savdo/qator va 1 ta begona/buzilgan hodisa).
   - Natija: 10 ta yaxshi hodisa `accepted`, 1 ta yomon hodisa `rejected`.
   - Hub tomonida yomon hodisa `local_sync_conflicts` ga chiqariladi, `local_outbox` dagi navbat to'xtab qolmasdan keyingi paketga o'tadi.
2. **Begona `store_id` testi:**
   - Do'kon A tokeni bilan do'kon B ga tegishli `store_id` li hodisa push qilinadi.
   - Natija: Bulut hodisani `rejected` qiladi (`STORE_MISMATCH`), baza holati o'zgarmaydi.
3. **Begona havola (Foreign Key) testi:**
   - Org A tokeni bilan `sale_lines` hodisasi yuboriladi, lekin uning `sale_id` si Org B dagi savdoga havola qiladi (cross-tenant havola buzilishi).
   - Natija: `rejected` (`FOREIGN_ENTITY_MISMATCH`).
4. **Parallel ikki push poygasi (Haqiqiy PG parallelligi):**
   - Ikki parallel jarayon ayni bir xil hodisalar paketini bir vaqtning o'zida yuboradi.
   - Natija: Bitta jarayon `accepted` oladi, ikkinchisi `duplicate` oladi. Har bir hodisa bulutda faqat 1 marta qo'llanadi, hisoblar va pozitsiyalar 1 tiyingacha to'g'ri bo'ladi.

### 5.2. Tarmoq uzilishlari va chegaraviy holatlar:
5. **Yarim paket uzilishi va javob yo'qolishi:**
   - Paket bulutga yetib bordi va yozildi, lekin tarmoq uzilib Hub javobni olmadi. Hub butun paketni qayta yuboradi.
   - Natija: Barcha hodisalar `duplicate` sifatida tasdiqlanadi (`acked`), takroriy INSERT yoki hisob buzilishi bo'lmaydi.
6. **Kelajakdagi HLC (Soat buzilishi):**
   - Soati 1 soat oldinda bo'lgan Hub ATTR va FACT hodisalari yuboradi.
   - Natija: `MAX_SKEW` (5 min) dan oshgani sababli HLC server vaqtiga tushiriladi (`hlc_adjusted = true`).
7. **LWW ATTR poygasi:**
   - Eski HLC'li mahsulot nomi yangilanishi va yangi HLC'li nom.
   - Natija: Bazada faqat eng katta HLC'li nom qoladi.

### 5.3. Model testi:
8. **Ko'p do'konli model testi:**
   - 2 ta mustaqil Hub (Do'kon 1 va Do'kon 2) tasodifiy savdo, qaytarish, kirim va harakat hodisalarini hosil qiladi va bulutga push qiladi.
   - Bulutdagi FACT yig'indilari (savdo summalari, `stock_moves` miqdorlari, `customer_ledger` qarz yig'indilari) har ikkala Hub'dagi ko'rsatkichlar bilan tiyinigacha aniq teng bo'lishi tekshiriladi.

---

## 6. d) Doiradan tashqari
- `GET /api/v1/sync/pull` (T2.4).
- To'liq baza snapshot'ini olish va yangi terminalni bootstrap qilish (T2.5).
- Biznes egasi kabinetidagi ziddiyatlarni ko'rish va boshqarish UI'si (T2.6).
- Guzar Market ochiq katalog proyeksiyasi (`public_*` jadvallari — F5 bosqichida).
