## Reja: T1.7 — Mijoz qarz daftari (`customers`, `customer_ledger`, qarz to'lash va kechikish)

### 0. T1.6 merge natijasi (tekshirildi)

- **PR #13 boshi:** `eb42a470fd9eab331985fd15baea15d3ee936ddc` (T1.6 QABUL + Claude topshirig'i).
- **CI holati:** `eb42a47` bo'yicha barcha tekshiruvlar (`Verify (ubuntu-latest)`, `Verify (windows-latest)`, `Verify PostgreSQL RLS (ubuntu-latest)`, `Build & E2E Desktop Installer (windows-latest)`) `push` (`42878277782`) va `pull_request` (`42878287698`) workflowlarida yashil o'tdi.
- **Squash and merge:** `T1.6: Bekor qilish, qaytarish va v_sales_lines` — Merge commit SHA: **`ceae4d91f6dceff549248f57a66d0295b6697516`**.
- **Branchlar:** `gemini/T1.6-void-return` lokal va masofadan o'chirildi; `main` (`ceae4d91`) dan `gemini/T1.7-customer-ledger` branch'i ochildi.

---

### 1. Birinchi alohida commit — T1.6 test qarzi

T1.7 PR'ining 1-commit'i faqat T1.6 test qarzi uchun ajratiladi (`T1.6 test qarzi: void tiklashi, yarim tiyin yaxlitlash`):

1. **Void omborni aniq tiklaydi (`packages/db-local/src/return.test.ts`):**
   - Ikki xil tannarxli kirimdan keyin (masalan, 1-kirim `2.000 kg @ 10_000n` va 2-kirim `2.000 kg @ 30_000n` -> o'rtacha `20_000n`, `lastUnitCost = 30_000n`) ham FIFO partiyali, ham o'rtacha tannarxli tovar sotiladi va `voidSale` qilinadi.
   - Tekshiruv: `local_stock_balances` barcha 6 maydoni (xususan `lastUnitCost === 30_000n`) va `local_batch_balances` sotuvdan oldingi snapshotga aynan teng.
   - Mutatsiya isboti: `packages/domain/src/stock.ts` dagi `applyReplayStockMove` dan `move.reason !== 'return' &&` sharti olib tashlansa test darhol yiqiladi (`lastUnitCost` asl `30_000n` o'rniga qaytish tannarxiga tushib qoladi).
2. **Yarim tiyin yaxlitlash (`packages/domain/src/return.test.ts` va `packages/db-local/src/return.test.ts`):**
   - Deterministik test: `final_total = 10` tiyin, `qty = 2.000` kg (`2_000n` milli).
   - 1-qisman qaytarish `0.250` kg -> `round(10 * 250 / 2000 = 1.25) = 1` tiyin.
   - 2-qisman qaytarish `0.250` kg -> kumulyativ `round(10 * 500 / 2000 = 2.5) = 3` tiyin (`HalfAwayFromZero`), shuning uchun delta refund `3 - 1 = 2` tiyin (oddiy `/` pastga yaxlitlashda `2 - 1 = 1` chiqar edi).
   - Mutatsiya isboti: `divideRoundHalfAwayFromZero` oddiy bo'lishga almashtirilganda test yiqiladi.

---

### 2. Rejalashtirilgan arxitektura va fayllar

- **`@mezon/domain` (IO siz, sof BigInt):**
  - `auth.ts`: `customers:read`, `customers:write`, `debt:pay` (`owner`, `manager`, `cashier`), hamda `debt:manage` (faqat `owner`, `manager`).
  - `errors.ts`: `CUSTOMER_NOT_FOUND` (404), `CUSTOMER_PHONE_ALREADY_EXISTS` (409), `CUSTOMER_INACTIVE` (409), `CUSTOMER_HAS_OPEN_DEBT` (409), `CREDIT_LIMIT_EXCEEDED` (409), `OPENING_BALANCE_ALREADY_EXISTS` (409), `OVERPAYMENT_NOT_ALLOWED` (409), `RETURN_DEBT_OFFSET_EXCEEDED` (409), `SALE_DEBT_HAS_PAYMENTS` (409).
  - `customer.ts` (yangi): telefon normalizatsiyasi (`+998XXXXXXXXX`), mijoz ism qidiruv matnini `normalizeCatalogSearchText` orqali qayta ishlatish, FIFO qarz taqsimoti (`allocateCustomerLedgerFifo`), `dueAtMs` / `overdue` hisobi (`store_timezone` asosida), `opening_balance`/`debt_payment`/`adjustment` invariantlari va kanonik idempotentlik satrlari (`canonicalizeDebtPaymentRequest`, `canonicalizeOpeningBalanceRequest`, `canonicalizeDebtAdjustmentRequest`).
  - `sale.ts` / `return.ts`: `resolveReturnPayments` dan T1.7 placeholder rad etishini olib tashlab `remainingSaleDebt` va `paidTowardDebtByMethod` chegaralariga ulash.
- **`@mezon/drivers` (`src/node/redact.ts`):**
  - `DEFAULT_LOG_REDACT_PATHS` ga mijoz PII maydonlarini (`phone`, `phoneNormalized`, `fullName`, `customerName`, `customerPhone`, `note` va ularning `*.` / `*.*.` shakllari) qo'shish.
- **`@mezon/contracts`:**
  - `customer.ts` (yangi): `CreateCustomerRequestSchema`, `UpdateCustomerRequestSchema`, `CustomerDtoSchema`, `CustomerDetailDtoSchema`, `CustomerListQuerySchema`, `CustomerLedgerQuerySchema`, `CustomerLedgerEntryDtoSchema`, `CreateOpeningBalanceRequestSchema`, `CreateDebtPaymentRequestSchema`, `CreateDebtAdjustmentRequestSchema` (kassir javoblarida `costValue`/foyda yo'q).
  - `sale.ts` / `cart.ts`: `CompleteSaleRequestSchema` da ixtiyoriy `dueDays` va `creditOverride` (supervisor PIN); `SaleDtoSchema` da `customerId`.
- **`@mezon/db-local`:**
  - `schema/index.ts` va `drizzle/0009_customer_ledger.sql`:
    - `local_hub_config.default_customer_due_days` (`INTEGER DEFAULT 14`, nullable `>= 1 AND <= 3650`);
    - `customers` (`ATTR`, `organization`): `full_name`, `name_search`, `phone_normalized`, `phone_digits`, `credit_limit`, `default_due_days`, `note`, `is_active`;
    - `customer_ledger` (`FACT`, `store`): `customer_id`, `entry_type`, `amount_delta`, `source_type`, `source_id`, `sale_id`, `payment_method`, `provider_ref`, `cash_move_id`, `due_at_ms`, `reason`, `created_by_user_id`, `override_approved_by_user_id`, `client_request_id`, `request_hash`;
    - `local_customer_balances` (`LOCAL`, `organization`): `customer_id` (PK), `balance`, `total_debt_accrued`, `total_settled`, `last_activity_at_ms`, `updated_at_ms`;
    - `customers_fts` (FTS5 virtual jadvali va sinxron triggerlar).
  - `customer-migrations.ts` (yangi) + `scripts/check-migrations.mjs`: `customers_fts`, `customer_ledger` FACT triggerlari, `customers` no-DELETE trigger va `uidx_customer_ledger_opening_balance` ni `db:check` da tekshirish (manfiy testlar bilan).
  - `outbox.ts`: `formatOutboxRecordForDebug(record)` / `redactOutboxPayloadForDebug` (outbox debug chiqishida PII va maxfiy kalitlarni `[Redacted]` qilish).
  - `customer-repo.ts` (yangi): `SqliteCustomerStore` (CRUD, tombstone, `customers_fts` + telefon qidiruvi, `rebuildCustomerSearchIndex`, `recordOpeningBalance`, `recordDebtPayment`, `recordDebtAdjustment`, `getCustomerDetail`, `listOverdueCustomers`, `listCustomerLedger`, `rebuildCustomerBalances`).
  - `sale-repo.ts` & `return-repo.ts`: T1.5/T1.6 qarz ilgaklarini haqiqiy `customers` va `customer_ledger` operatsiyalari bilan ulash.
- **`apps/hub`:**
  - `customer-service.ts`, `customer-routes.ts`, `error-handler.ts`, `routes.ts`, `server.ts`, `sale-service.ts`.

---

### 3. Batafsil loyiha qarorlari (`a`–`h`)

#### a) Mijoz profili va shaxsiy ma'lumot

- **Jadval sinfi va doira:** `customers` = `ATTR`, `tenantScope: 'organization'` (filiallararo umumiy mijoz profili; F2 sinxroniga tayyor).
- **Ustunlar:**
  - `full_name` (`TEXT NOT NULL`, trim `1..200`); `name_search` (`normalizeCatalogSearchText` orqali);
  - `phone_normalized` (`TEXT`, **nullable** — lekin kiritilganda qat'iy O'zbekiston E.164 formatiga normallashtiriladi: `+998XXXXXXXXX`, ya'ni `+998` + 9 ta raqam; `90 123-45-67`, `998901234567`, `+998(90)1234567` qabul qilinadi, noto'g'ri format `400 VALIDATION_ERROR`);
  - `phone_digits` (`TEXT`, faqat raqamlar `998XXXXXXXXX`, FTS va prefiks qidiruvi uchun);
  - `credit_limit` (`sqliteMoney`, **nullable**: `null` = cheksiz, `>= 0n` = tiyinda maksimal qarz limiti; `0n` = qarzga sotish taqiqlanadi);
  - `default_due_days` (`sqliteInt`, **nullable**: `1..3650` kun; `null` bo'lsa `local_hub_config.default_customer_due_days` olinadi);
  - `note` (`TEXT`, nullable), `is_active` (`sqliteBoolean NOT NULL DEFAULT 1`).
- **Telefon UNIQUE siyosati:**
  - **Qaror:** Faol mijozlar uchun **partial UNIQUE index**: `uidx_customers_org_phone_active ON customers(organization_id, phone_normalized) WHERE deleted_at_ms IS NULL AND phone_normalized IS NOT NULL` (`409 CUSTOMER_PHONE_ALREADY_EXISTS`).
  - **Sabab:** (1) Kassada dublikat mijoz yaratilib kredit limiti aylanib o'tilishining oldini oladi; (2) telefonsiz mijozlar uchun `NULL` ruxsat etiladi; (3) arxivlangan (tombstone) mijoz raqami qayta ishlatilishi mumkin.
- **Qidiruv (`10 000 mijoz <= 100 ms`):**
  - `customers_fts` (SQLite FTS5, `T1.1` `products_fts` bilan bir xil uslubda: `customer_id UNINDEXED`, `organization_id UNINDEXED`, `name_search`, `phone_digits`, `tokenize = 'unicode61 remove_diacritics 0'`, `prefix = '2 3'`, `content=` siz, `AFTER INSERT`/`AFTER UPDATE` triggerlar) + `idx_customers_org_phone_active` B-tree indeksi.
  - Kirill↔lotin normallashtirish ham, telefon qidiruvi ham 1–5 ms ichida ishlaydi (`rebuildCustomerSearchIndex` ta'mirlash buyrug'i bilan).
- **Shaxsiy ma'lumot (PII) himoyasi (Pino, xatolar, outbox debug):**
  1. **Pino loglari:** `DEFAULT_LOG_REDACT_PATHS` (`packages/drivers/src/node/redact.ts`) ga `phone`, `phoneNormalized`, `fullName`, `customerName`, `customerPhone`, `note` (va `*.` / `*.*.` yo'llari) qo'shiladi; Hub loglarida mijoz operatsiyalari faqat `customerId` + summa bilan yoziladi.
  2. **Xato xabarlari:** Hech bir `DomainError`, `ZodError` yoki HTTP xato matniga mijoz ismi yoki telefon raqami kiritilmaydi.
  3. **Outbox debug chiqishi:** `local_outbox.payload` F2 sinxronizatsiyasi uchun `customers` maydonlarini saqlasa-da, har qanday diagnostika/debug chiqishi uchun `formatOutboxRecordForDebug(record)` funksiyasi yoziladi — u PII va maxfiy maydonlarni `[Redacted]` ga aylantiradi.
  - **Test dalili:** Haqiqiy Pino oqimi, API xato javoblari (`400/403/404/409`) hamda `formatOutboxRecordForDebug` ustida test bilan ism/telefon sizmasligi isbotlanadi.
- **Mijozni o'chirish / arxivlash:**
  - `customers` = `ATTR` (SQLite `BEFORE DELETE` trigger jismoniy o'chirishni bloklaydi).
  - Arxivlash (`tombstoneAttr`): agar `customerBalance !== 0n` bo'lsa **`409 CUSTOMER_HAS_OPEN_DEBT`** bilan rad etiladi. Qarzi `0` bo'lgan mijoz `tombstoneAttr` bilan arxivlanadi (`customer_ledger` va `sales` tarixiy FK lar saqlanadi). Qarzi bor mijozga yangi qarz bermaslik uchun esa `isActive = false` qilinadi (`isActive = false` arxivlamasdan qarz undirish imkonini saqlaydi).

#### b) `customer_ledger` (`FACT`, `store` scope)

- **Ustunlar:** `id`, `organization_id`, `store_id`, `device_id`, `hlc`, `created_at_ms` (`FACT` — `BEFORE UPDATE`/`DELETE` triggerlari), hamda:
  - `customer_id -> customers(id)`, `entry_type`, `amount_delta` (`sqliteMoney`), `source_type`, `source_id`, `sale_id -> sales(id)`, `payment_method`, `provider_ref`, `cash_move_id -> cash_moves(id)`, `due_at_ms`, `reason`, `created_by_user_id -> users(id)`, `override_approved_by_user_id -> users(id)`, `client_request_id`, `request_hash`.
- **5 ta tur va qat'iy ishoralar (`CHECK` bilan):**
  1. `opening_balance`: `amount_delta > 0` (+, qarz ortadi; `reason` majburiy, `source_type = 'opening_balance'`).
  2. `sale_debt`: `amount_delta > 0` (+, qarz ortadi; `sale_id NOT NULL`, `source_type = 'sale'`).
  3. `debt_payment`: `amount_delta < 0` (−, qarz kamayadi; `payment_method NOT NULL`, `source_type = 'debt_payment'`, `cash` bo'lsa `cash_move_id NOT NULL`).
  4. `return_offset`: `amount_delta < 0` (−, qarz kamayadi; `sale_id NOT NULL`, `source_type IN ('return', 'sale_void')`).
  5. `adjustment`: `amount_delta <> 0` (+ qarz qo'shish yoki − qarz kamaytirish/kechirish; faqat `owner`/`manager`, `reason` majburiy; manfiy tuzatish `|amountDelta| <= currentBalance` bilan chegaralanadi).
- **Balans = `SUM(amount_delta)` + Proyeksiya (`local_customer_balances`):**
  - `local_customer_balances` (`LOCAL` jadval, PK `customer_id`) tezkor balans ko'rish uchun kesh/proyeksiyadir, sinxronlanmaydi.
  - `rebuildCustomerBalances()` barcha ledgerdan qayta quradi; har qadamda jonli balans == `SUM(customer_ledger.amount_delta)` == `rebuildCustomerBalances()` testda isbotlanadi.
- **Boshlang'ich qarz takror kiritilishini bloklash:**
  - `PARTIAL UNIQUE INDEX uidx_customer_ledger_opening_balance ON customer_ledger(organization_id, customer_id) WHERE entry_type = 'opening_balance'` (baza darajasida 2-marta kiritish imkonsiz, xato kodi `409 OPENING_BALANCE_ALREADY_EXISTS`). Takror so'rov xuddi o'sha `clientRequestId` + `requestHash` bilan kelsa idempotent replay (`200`), boshqa `clientRequestId` bilan kelsa `409 OPENING_BALANCE_ALREADY_EXISTS`.

#### c) Savdoda qarz (`T1.5` darvozasini ochish)

- `packages/db-local/src/sale-repo.ts`:
  - `debtAmount > 0n` va `customerId === null` -> **`400 CUSTOMER_REQUIRED`** saqlanadi.
  - `customerId !== null` -> `customers` tekshiriladi: topilmasa/arxivlangan/boshqa tenant bo'lsa **`404 CUSTOMER_NOT_FOUND`**; `is_active === 0` bo'lsa **`409 CUSTOMER_INACTIVE`**.
  - **Qarzsiz savdo (`debtAmount === 0n`):** `customerId` berilsa, `sales.customer_id` da saqlanadi (T1.5 dagi `VALIDATION_ERROR` olib tashlanadi).
  - **Kredit limiti (`creditLimit !== null`):** `currentBalance + debtAmount > creditLimit` bo'lganda standart kassir/menejer savdosi **`409 CREDIT_LIMIT_EXCEEDED`** bilan rad etiladi. Agar supervisor (`owner`/`manager`) PIN tasdig'i (`creditOverride`) yoki `owner`/`manager` bevosita ruxsati berilsa, `override_approved_by_user_id` `customer_ledger` ga yozilib ruxsat beriladi.
  - **Atomiklik va `request_hash`:** `debtAmount > 0n` bo'lsa o'sha `BEGIN IMMEDIATE` tranzaksiyada `customer_ledger` (`sale_debt`) + `local_outbox` + `local_customer_balances` yoziladi. `packages/domain/src/sale.ts` dagi `canonicalizeCompleteSaleRequest` allaqachon `debtAmount` va `customerId` ni o'z ichiga oladi (va ixtiyoriy `dueDays` qo'shilsa u ham hashga kiritiladi; `creditOverride` PIN'i kirmaydi).

#### d) Qarz to'lash va FIFO vs Umumiy balans

- **To'lov turlari va kassa:** barcha `PAYMENT_METHODS` ruxsat etiladi. `method === 'cash'` bo'lsa, o'sha tranzaksiyada `cash_moves` (`FACT`, `store`, `device_id`) ga **`type = 'debt_payment_in'`**, `amountDelta = +amount`, `sourceType = 'debt_payment'`, `sourceId = ledgerEntryId` yoziladi.
- **Idempotentlik:** `clientRequestId` + SHA-256 `request_hash` (`canonicalizeDebtPaymentRequest`).
- **Ortiqcha to'lov siyosati (Mezon):**
  - **Qaror: Ortiqcha to'lov QAT'IY RAD ETILADI (`409 OVERPAYMENT_NOT_ALLOWED`), manfiy balans (mijoz avansi) YARATILMAYDI.**
  - **Sabab:** (1) Kassir noto'g'ri nol qo'shib yuborganda darhol himoyalash; (2) manfiy balans qarz daftarini avans hamyoniga aylantirib FIFO va void/qaytarish qoidalarini murakkablashtirmasligi (buyurtma avansi `T1.10` da alohida bo'ladi); (3) mijoz balansi doim `>= 0n` invariantini saqlash.
  - **Chegara testlari:** joriy balans `B` bo'lganda `amount === B` o'tadi (`balance -> 0n`), `amount === B + 1n` -> `409 OVERPAYMENT_NOT_ALLOWED`, `B === 0n` da har qanday to'lov -> `409 OVERPAYMENT_NOT_ALLOWED`.
- **Chek qarzini FIFO bo'yicha hisoblash:**
  - **Qaror:** Bazada to'lov mijoz darajasida (`debt_payment`) bitta yozuv sifatida yuritiladi (alohida taqsimot jadvalisiz), **chek kesimidagi ochiq qarz va kechikish esa deterministik `allocateCustomerLedgerFifo` sof domen funksiyasi bilan `created_at_ms ASC, id ASC` tartibida hisoblanadi**:
    1. Har qanday chek bo'yicha `return_offset` (`sale_id`) bevosita shu chekning `sale_debt` qarzidan ayriladi;
    2. `debt_payment` va manfiy `adjustment`lar FIFO tartibida (`opening_balance` -> eng eski `sale_debt` -> keyingi `sale_debt`) ochiq qarzlarni yopadi.
  - **Natija:** `SUM(ochiq qarzlar) === SUM(customer_ledger.amount_delta)` invariantga 100% teng qoladi va har chekning o'z `due_at_ms` sanasi bo'yicha aniq kechikish ko'rinadi.

#### e) Qaytarish va void bilan bog'lanish (T1.6 ilgaklari)

- **Qarzli chekni qaytarish (`createReturn`):**
  - `sale.debtAmount > 0n` chekida `sale.customerId` bo'lishi shart. `allocateCustomerLedgerFifo` shu chekning joriy qolgan qarzi `saleRemainingDebt` ni va FIFO bo'yicha shu chekka to'langan qarz ulushlari `paidTowardDebtByMethod(m)` ni hisoblaydi.
  - Chegaralar:
    - `debtOffsetAmount <= saleRemainingDebt` (oshsa **`409 RETURN_DEBT_OFFSET_EXCEEDED`**);
    - Har to'lov usuli $m$ uchun `payments[m] <= originalPaid(sale, m) + paidTowardDebtByMethod(m) - priorReturned(sale, m)` (oshsa **`409 RETURN_PAYMENT_LIMIT_EXCEEDED`**; naqdda V2 `INSUFFICIENT_CASH_IN_DRAWER` ham saqlanadi);
    - `SUM(payments) + debtOffsetAmount === return.totalRefund`.
  - O'sha tranzaksiyada `customer_ledger` ga `return_offset` (`amountDelta = -debtOffsetAmount`, `sourceType = 'return'`, `sourceId = returnId`, `saleId = sale.id`) va `local_customer_balances` yoziladi.
- **Qarzli chekni void qilish (`voidSale`):**
  - **Qaror:**
    - Agar chek qarziga FIFO bo'yicha hali **to'lov tushmagan** bo'lsa (`fifoPaidTowardSale === 0n`, manfiy `adjustment` tegmagan va `currentBalance >= sale.debtAmount`): `voidSale` ruxsat etiladi va o'sha tranzaksiyada `-sale.debtAmount` (`return_offset`, `sourceType = 'sale_void'`, `saleId = sale.id`) bilan chek qarzi to'liq teskari yoziladi.
    - Agar chek qarziga **allaqachon to'lov qilingan** bo'lsa (`fifoPaidTowardSale > 0n` yoki `currentBalance < sale.debtAmount`): **`voidSale` RAD ETILADI (`409 SALE_DEBT_HAS_PAYMENTS`)**, chunki to'liq `-sale.debtAmount` yozilsa mijoz balansi manfiyga (`-fifoPaidTowardSale`) tushib qoladi. Bunday chek `createReturn` orqali qaytariladi (qolgan qarz `debtOffset` bilan, to'langani to'lov usuli bilan yopiladi).
- **Model testi:** tasodifiy mijozlar, kreditli savdolar, turli usullardagi qarz to'lovlari, qisman/to'liq qaytarishlar, tuzatishlar va voidlar ketma-ketligida har mijoz balansi, chek qarzlari va kassa qoldig'i mustaqil TypeScript modeli bilan tiyinigacha teng bo'ladi.

#### f) Kechikish ko'rinishi va tarix

- **Kechikish ta'rifi (`store_timezone`):**
  - Har `sale_debt` va `opening_balance` qatoriga `dueDays` (mijoz `defaultDueDays` -> aks holda `local_hub_config.default_customer_due_days`, standart `14` kun) bo'yicha muddat belgilanadi (`dueDays = null` bo'lsa muddatsiz).
  - `dueDateKey = addDaysToDateKey(getBusinessDateKey(createdAtMs, storeTimezone), dueDays)`. Kechikish `dueDateKey` tugagandan keyingi ish kuni `00:00:00.000` (do'kon vaqt zonasida) boshlanadi va shu chegara Unix ms qiymati `customer_ledger.due_at_ms` da saqlanadi (`todayKey > dueDateKey` ⇔ `nowMs >= dueAtMs`).
  - `overdueAmount` = `allocateCustomerLedgerFifo` dagi barcha `dueAtMs !== null && nowMs >= dueAtMs` bo'lgan ochiq qarzlardan qolgan qismlar yig'indisi; `oldestOverdueDays` = eng eski kechikkan majburiyat kunlar farqi.
- **Tarix (`GET /customers/:id/ledger`):**
  - SQLite Window Function `SUM(amount_delta) OVER (PARTITION BY organization_id, customer_id ORDER BY created_at_ms ASC, id ASC ROWS UNBOUNDED PRECEDING)` orqali har qator uchun aniq `balanceAfter` hisoblanib `created_at_ms DESC, id DESC` (yoki `ASC`) bo'yicha sahifalanib (`limit`, `offset`) qaytariladi.

#### g) Hub API, RBAC va unumdorlik (`10 000` mijoz, `100 000` ledger `<= 100 ms`)

- **RBAC:**
  - `customers:read`, `customers:write` (yaratish/kontakt tahriri: `fullName`, `phone`, `note`), `debt:pay` (qarz to'lash): `owner`, `manager`, `cashier`.
  - `debt:manage` (`opening-balance`, `adjustments`, `creditLimit`/`defaultDueDays`/`isActive` belgilash/o'zgartirish, arxivlash): **qat'iy faqat `owner`, `manager`** (`cashier` ga `403 AUTH_FORBIDDEN`; kassir `POST /customers` da `creditLimit`/`defaultDueDays` bersa ham `403`).
- **Endpointlar:**
  - `GET /customers` (`q`, `overdueOnly`, `includeInactive`, `limit`, `offset`)
  - `POST /customers` (`customers:write`; `creditLimit`/`defaultDueDays` berilsa `debt:manage`)
  - `GET /customers/overdue`
  - `GET /customers/:id`
  - `PATCH /customers/:id` (`customers:write`; `creditLimit`/`defaultDueDays`/`isActive` o'zgarsa `debt:manage`)
  - `DELETE /customers/:id` (arxivlash/tombstone, balans `!== 0` bo'lsa `409`)
  - `GET /customers/:id/ledger` (`limit`, `offset`, `order`, `entryType`)
  - `POST /customers/:id/opening-balance` (`debt:manage`)
  - `POST /customers/:id/payments` (`debt:pay`)
  - `POST /customers/:id/adjustments` (`debt:manage`)
- **Tannarx yo'q:** javoblarda va loglarda `costValue` / foyda mutlaqo bo'lmaydi.
- **Unumdorlik (`<= 100 ms`):** `customers_fts` (FTS5), `idx_customers_org_phone_active`, `local_customer_balances` (`PK`), `idx_customer_ledger_cust_created` (`organization_id, customer_id, created_at_ms, id`) hamda prepared statements orqali **10 000 mijoz va 100 000 ledger yozuvili haqiqiy WAL SQLite disk bazasida** qidiruv, balans va sahifalangan tarix `<= 100 ms` benchmarki yoziladi.

#### h) Doiradan tashqari

- SMS / Telegram orqali mijozlarga qarz eslatmasi yuborish (`T2.8`, rozilik bilan).
- Ta'minotchi qarzi va kirim (`T1.8`).
- Smena va kun yakuni (`T1.9`).
