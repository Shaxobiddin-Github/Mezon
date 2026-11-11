## Reja: T1.8 — Ta'minotchi, kirim hujjati, tannarx, `supplier_ledger` va to'lovlar

### 0. T1.7 merge, Egasining qarori va `ci.yml` 1-commit

- **PR #14 Squash and merge:** Egasi ruxsati bilan (kod `8f29f34` barcha 4 CI jobdan yashil o'tgan, keyingi `8cc7542` va `e99d8be` faqat `.mezon/` fayllari bo'lgan, Claude `QABUL` bergan) `T1.7: Mijoz qarz daftari` nomi bilan merge qilindi — Merge commit SHA: **`fdd1b80396f1fc07f1ee6a63ccf61de6a7575d3c`**.
- **Branchlar:** `gemini/T1.7-customer-ledger` lokal va masofadan o'chirildi; `main` (`fdd1b80`) dan `gemini/T1.8-suppliers-receiving` branch'i ochildi.
- **Vaqtinchalik CI siyosati (egasi qarori):** GitHub Actions bepul limiti 20 kun ichida tiklanguncha qabul sharti = lokal `pnpm verify` + Claude'ning `QABUL`i (`packages/db-cloud` va `apps/desktop` PR'lari limit tiklanguncha merge qilinmaydi).
- **1-commit (`68b2db5` — bajarildi):** Egasining ko'rsatmasiga binoan `.github/workflows/ci.yml` tejamkor qilindi:
  - `push` faqat `main` branch uchun;
  - `push` va `pull_request` da `paths-ignore: ['.mezon/**', '**/*.md']`;
  - `desktop` (`Build & E2E Desktop Installer (windows-latest)`) faqat `main` push'da yoki `detect-changes` (`ubuntu-latest`) GitHub PR API orqali `apps/desktop/**` yoxud `packages/drivers/**` o'zgarganini aniqlaganda ishlaydi.

---

### 1. Reja tasdiqlangandan keyingi 1-kod commit'i — T1.7 test qarzi

Reja tasdiqlangach, T1.8 kodidan oldin **alohida commit** qilinadi (`T1.7 test qarzi: nofaol mijoz, PII redaksiya, test vaqt chegarasi`):

1. **Nofaol mijoz (`packages/db-local/src/customer.test.ts` + mutatsiya isboti):**
   - `isActive = false` mijozga qarzli (`debtAmount > 0`) va qarzsiz (`customerId != null`) savdo `completeSale` da `409 CUSTOMER_INACTIVE` bilan rad etiladi (0 DB yozuv). Qarz to'lovi (`recordDebtPayment`) esa muvaffaqiyatli qabul qilinadi.
   - Mutatsiya: `packages/db-local/src/customer-repo.ts` dagi `if (!customer.isActive)` olib tashlanganda test yiqilishi isbotlanadi.
2. **PII redaksiya sikli (`packages/drivers/src/index.test.ts`):**
   - `DEFAULT_LOG_REDACT_PATHS` (`packages/drivers/src/node/redact.ts`) dagi `customerNote` ning `*.*.customerNote` yo'li ham tekshiriladi va barcha PII kalitlari (`phone`, `phoneNormalized`, `phoneDigits`, `fullName`, `nameSearch`, `customerName`, `customerPhone`, `customerNote`) sikl orqali haqiqiy Pino loggerda 3 ta darajada (`{ [k]: v }`, `{ nested: { [k]: v } }`, `{ req: { body: { [k]: v } } }`) `[Redacted]` bo'lishi tekshiriladi. Mutatsiya: ro'yxatdan istalgan kalit olib tashlanganda test yiqiladi.
3. **Beqaror test vaqt chegarasi (`vitest.config.ts`):**
   - `vitest.config.ts` da `test.projects` orqali og'ir SQLite/HTTP testlari bor `packages/db-local` va `apps/hub` uchun `testTimeout: 30_000` (va `hookTimeout: 30_000`) o'rnatiladi; uzoq model/benchmark testlar o'z aniq timeout'ini (`30_000` / `60_000`) saqlaydi. Unumdorlik chegaralari (`<= 300 ms`, `<= 100 ms`, `<= 20 ms`) o'zgarmaydi.

---

### 2. Rejalashtirilgan arxitektura va fayllar (T1.8)

- **`@mezon/domain`:**
  - `auth.ts`: `suppliers:read`, `suppliers:write`, `receiving:read`, `receiving:write`, `supplier_debt:pay`, `supplier_debt:manage` — **barchasi faqat `owner` va `manager`** uchun (`cashier` da birortasi yo'q).
  - `errors.ts`: `SUPPLIER_NOT_FOUND` (404), `SUPPLIER_TIN_ALREADY_EXISTS` (409), `SUPPLIER_PHONE_ALREADY_EXISTS` (409), `SUPPLIER_INACTIVE` (409), `SUPPLIER_HAS_OPEN_BALANCE` (409), `RECEIVING_NOT_FOUND` (404), `RECEIVING_NOT_DRAFT` (409), `RECEIVING_EMPTY` (400), `RECEIVING_LINE_NOT_FOUND` (404), `RECEIVING_LINE_COST_UNKNOWN` (409), `RECEIVING_LINE_COST_ALREADY_CONFIRMED` (409), `SUPPLIER_RETURN_NOT_FOUND` (404), `SUPPLIER_RETURN_QTY_EXCEEDED` (409), `SUPPLIER_RETURN_BATCH_DEPLETED` (409).
  - `sale.ts`: `CASH_MOVE_OUTFLOW_TYPES` ga `'supplier_payment_out'` qo'shiladi (`CASH_MOVE_TYPES` ga kiradi).
  - `stock.ts`:
    - `STOCK_MOVE_REASONS` & `OUTBOUND_STOCK_REASONS` ga `'supplier_return'`, `STOCK_SOURCE_TYPES` ga `'supplier_return'` va `'receiving'`/`'purchase'` ulanishi.
    - `applyReplayStockMove`: `isUnknownCostPurchase` belgilanganda (`cost_unknown = 1`) `state.lastUnitCost` ni `0n` ga tushirib buzmaydi va `UNKNOWN_COST_SURPLUS` konfliktini qo'shadi.
    - Yangi sof funksiya `applyStockCostConfirmation(state, confirmation)`: noma'lum narx tasdiqlanganda qolgan zaxiraga (`Q_rem`) mutanosib qiymat qo'shadi (`shareOnHand`) va allaqachon sotilgan/defitsit yopgan qismni `costVarianceValue` ga o'tkazib, T1.2 balans tenglamasini (`ledgerInCost + confirmedCost === ledgerOutCost + totalValue - provisionalDeficitValue + costVarianceValue`) tiyinigacha saqlaydi.
  - `supplier.ts` (yangi): STIR (9 raqam) va telefon normalizatsiyasi (`normalizeCustomerPhone` qayta ishlatiladi), nom qidiruvini `normalizeCatalogSearchText` bilan qayta ishlatish, HLC tartibidagi ikki tomonlama FIFO + avans taqsimlovchi `allocateSupplierLedgerFifo`, kechikish hisobi (`computeDebtDueAtMs` / `computeOverdueDaysAt` qayta ishlatiladi), kanonik idempotentlik hash funksiyalari, F2 sinxron chegaralari izohi.
- **`@mezon/drivers` (`src/node/redact.ts`):**
  - `DEFAULT_LOG_REDACT_PATHS` ga `supplierName`, `contactPerson`, `supplierPhone`, `supplierNote`, `tin` (va `*.` / `*.*.` shakllari) qo'shiladi; PII sikl testi bilan qamraladi.
- **`@mezon/contracts` (`supplier.ts` — yangi):**
  - Ta'minotchi CRUD, kirim qoralamasi (`POST/PATCH/POST /receivings/:id/post`, `POST /receivings/:id/cancel`), narx tasdiqlash (`POST /receivings/:id/lines/:lineId/confirm-cost`), ta'minotchi qarzi tarixi/to'lov/tuzatish (`opening-balance`, `payments`, `adjustments`), ta'minotchiga qaytarish (`POST /receivings/:id/returns`) uchun qat'iy Zod DTO'lar.
- **`@mezon/db-local` (`0010_suppliers_receiving.sql`, `supplier-repo.ts`, `supplier-migrations.ts`, `stock-repo.ts`):**
  - `applyInboundInsideSessionSync` (va uning prefetch yordamchisi) `stock-repo.ts` dan ichki funksiya sifatida eksport qilinadi; `rebuildStockProjections()` esa `stock_moves` + `receiving_cost_confirmations` ni `(hlc, id)` bo'yicha birga qayta o'ynaydi.
  - `outbox.ts` `formatOutboxRecordForDebug`: `suppliers` PII maydonlarini ham redaksiya qiladi.
- **`apps/hub` (`supplier-service.ts`, `supplier-routes.ts`, `error-handler.ts`, `routes.ts`, `server.ts`):**
  - Barcha marshrutlarda `owner`/`manager` RBAC (`cashier` -> `403 AUTH_FORBIDDEN`), PII va tannarx logga chiqmaydi (`supplierId`/`receivingId`/`entryId`/`amount` faqat kerakli ruxsatli logda).

---

### 3. Batafsil loyiha qarorlari (`a`–`i`)

#### a) Ta'minotchi (`suppliers`, `ATTR`, `organization`)

- **Jadval:** `suppliers` (`ATTR`, `tenantScope: 'organization'`).
- **Ustunlar:** `name` (`1..200`), `name_search` (`normalizeCatalogSearchText`), `tin` (`TEXT`, nullable, kiritilsa qat'iy **9 ta raqam** `/^\d{9}$/`), `phone_normalized` (`+998...` yoki umumiy E.164 `+[1-9]\d{7,14}`, nullable), `phone_digits`, `contact_person`, `note`, `default_due_days` (`1..3650`, nullable -> `local_hub_config.default_supplier_due_days` default `14`), `is_active`.
- **STIR va Telefon UNIQUE qarori:**
  - Ikkalasi uchun ham faol yozuvlarda **partial UNIQUE indeks**:
    - `uidx_suppliers_org_tin_active ON suppliers(organization_id, tin) WHERE deleted_at_ms IS NULL AND tin IS NOT NULL` (`409 SUPPLIER_TIN_ALREADY_EXISTS`);
    - `uidx_suppliers_org_phone_active ON suppliers(organization_id, phone_normalized) WHERE deleted_at_ms IS NULL AND phone_normalized IS NOT NULL` (`409 SUPPLIER_PHONE_ALREADY_EXISTS`).
  - *Sabab:* Bitta ta'minotchi ikki marta ochilib qarzdorlik/avans bo'linib ketishini bazaviy darajada oldini oladi; tombstone arxivlangandan keyin qayta ochish mumkin.
- **FTS5 qidiruv va PII:** `suppliers_fts` (`buildEntityFtsSearchSql` qayta ishlatiladi); Pino, Zod/Domain xatolari va outbox debug'da PII chiqmaydi.
- **Arxivlash (`tombstoneAttr`):** `supplierBalance !== 0n` (ochiq qarz **yoki** ochiq avans bor) bo'lsa `409 SUPPLIER_HAS_OPEN_BALANCE` bilan rad etiladi. `balance === 0n` da `tombstoneAttr` bilan arxivlanadi (`BEFORE DELETE` trigger saqlanadi).

#### b) Kirim hujjati (`draft -> posted / cancelled`)

- **Jadvallar va sinf tanlovi:**
  - **Qoralama (`LOCAL`):** `local_receiving_drafts` + `local_receiving_draft_lines` (`tableClass: 'LOCAL'`, `store` scope). Holat: `'draft' | 'posted' | 'cancelled'`. Faqat `'draft'` holatda sarlavha va qatorlar qo'shiladi/tahrirlanadi/o'chiriladi; `cancel` -> `'cancelled'` qiladi. Qoralama sinxronlanmaydi (T1.3 `local_carts` bilan bir xil yondashuv — tahrir shovqini outbox'ga chiqmaydi).
  - **Joylangan hujjat (`FACT`):** `goods_receivings` + `goods_receiving_lines` (`tableClass: 'FACT'`, `store` scope). SQLite `BEFORE UPDATE` / `BEFORE DELETE` triggerlari joylangan hujjatni 100% o'zgarmas qiladi (`id = draft.id`). `local_device_state.last_receiving_seq` orqali bo'shliqsiz `receiving_no` (`RCV-...`) beriladi.
  - **Joylashdan keyingi xatolarni tuzatish:** Joylangan hujjat tahrirlanmaydi. Miqdor xatosi / tovar qaytarish uchun -> **`supplier_returns` (`FACT`)** (`f` band); noma'lum narxni aniqlash uchun -> **`receiving_cost_confirmations` (`FACT`)** (`c` band); summaviy ma'muriy tuzatish uchun -> `supplier_ledger` da **`adjustment`** (`owner`/`manager` + `reason`).
- **Qatorlar:**
  - `productId`, `variantId`, `qty` (`sqliteQuantity > 0`), `costUnknown` (`0 | 1`), `totalCostValue` (**jami qator tannarxi**, `sqliteMoney >= 0`, `costUnknown = 1` da `0` saqlanadi — kasrli kg'da yaxlitlash xatosi bo'lmasligi uchun birlik emas jami kiritiladi; `unitCostPreview` faqat ko'rsatish uchun), `batchNumber` (nullable), `expiryDateMs` (nullable positive Unix ms).
  - `product.trackBatches === false` bo'lsa `batchNumber` / `expiryDateMs` berilishi `400 VALIDATION_ERROR` bilan rad etiladi. `trackBatches === true` da ikkisi ixtiyoriy/nullable (T1.2 `recordInboundMove` bilan mos) va to'g'ridan-to'g'ri `batches` (`supplierId` bilan) ga o'tadi.
- **Atomiklik va T1.2 qayta ishlatish:**
  - `postReceiving` bitta `uow.execute` tranzaksiyada: `goods_receivings`, `goods_receiving_lines`, **har qator uchun `applyInboundInsideSessionSync(..., { reason: 'purchase', sourceType: 'purchase', sourceId: receiving.id, supplierId, isUnknownCost })`**, ma'lum narxli jami `> 0n` bo'lsa `supplier_ledger` (`receiving_debt`) + `local_supplier_balances`, hamda barcha outbox yozuvlarini yozadi.
- **Differensial test (T1.5 B1 usuli):**
  - `postReceiving` dan keyin barcha tovarlarning `local_stock_balances` (6 maydon) va `local_batch_balances` holati huddi o'sha qatorlarni `stockStore.recordInboundMove` bilan ketma-ket kiritgandagi natija bilan tengligi testlanadi.

#### c) Tannarx noma'lum (`costUnknown = true` -> narxni tasdiqlash)

- **Joylash paytida:**
  - `costUnknown = true` qator `applyInboundInsideSessionSync` ga `totalCostValue = 0n, isUnknownCost = true` bilan kiradi: ombor qoldig'i darhol ortadi, `batches.initial_cost_value = 0`, `batches.supplier_id = supplierId`.
  - `applyReplayStockMove`: `isUnknownCost` harakat `lastUnitCost` ni `0n` ga **buzmaydi** va `local_stock_conflicts` ga `UNKNOWN_COST_SURPLUS` yozadi.
  - `supplier_ledger` ga bu qator uchun **qarz yozilmaydi** (faqat `costUnknown = false` qatorlar summasi bo'yicha qarz yoziladi).
- **Keyin narx tasdiqlanganda (`receiving_cost_confirmations`, `FACT`):**
  - Alohida `confirmReceivingLineCost` buyrug'i (`POST /receivings/:id/lines/:lineId/confirm-cost`, faqat `owner`/`manager`, `clientRequestId` + `requestHash` idempotent, bitta qatorga faqat bir marta `uidx_receiving_cost_confirms_line`!).
  - Bitta tranzaksiyada:
    1. `receiving_cost_confirmations` (`FACT`) yoziladi (`confirmedTotalCost > 0n` yoki `>= 0n`, `reason`, `dueDays`).
    2. `confirmedTotalCost > 0n` bo'lsa `supplier_ledger` ga `receiving_debt` (`+confirmedTotalCost`, `sourceType = 'receiving_cost_confirm'`, `dueAtMs` tasdiqlash vaqtidan `dueDays` bilan) yoziladi + `local_supplier_balances` yangilanadi.
    3. `applyStockCostConfirmation` orqali ombor qayta baholanadi: batch/pulda qolgan sotilmagan `Q_rem` qismga mutanosib `shareOnHand` qiymat qo'shiladi (`totalValue` va `batch.remainingValue`), allaqachon sotilgan/defitsitga ketgan `confirmedTotalCost - shareOnHand` esa `costVarianceValue` ga yoziladi, `lastUnitCost` yangilanadi va tegishli `UNKNOWN_COST_SURPLUS` konflikt `resolvedAtMs = nowMs` bilan yopiladi.
    4. `rebuildStockProjections()` `stock_moves` + `receiving_cost_confirmations` ni `(hlc, id)` tartibida qayta o'ynab jonli holat bilan 100% bir xil natija beradi.

#### d) `supplier_ledger` (`FACT`, `store` scope) va Avans qarori

- **Turlar:** `opening_balance` (`+`), `receiving_debt` (`+`), `supplier_payment` (`-`), `supplier_return` (`-`), `adjustment` (`+/-`).
- **Ortiqcha to'lov / Avans (QAROR):**
  - **Ruxsat beriladi!** `local_supplier_balances.balance` **`>= 0` ga cheklanmaydi** (`balance` manfiy bo'lishi mumkin).
  - `balance > 0`: biz ta'minotchiga qarzdormiz (`netDebt = balance`).
  - `balance < 0`: bizda ta'minotchiga **oldindan to'lov / avans** bor (`advanceBalance = -balance`).
- **FIFO va muddat (`allocateSupplierLedgerFifo`):**
  - `(hlc ASC, id ASC)` tartibida bir o'tishli `O(N)` replay (`allocateCustomerLedgerFifo` bilan bir xil HLC prinsipi + T1.7 `computeDebtDueAtMs`/`computeOverdueDaysAt` qayta ishlatiladi):
    - Kredit (`supplier_payment`, `supplier_return`, `-adjustment`) avval eng eski ochiq debit majburiyatlarni (`opening_balance`, `receiving_debt`, `+adjustment`) FIFO bilan yopadi;
    - Ortiqcha kredit **`unappliedAdvance`** puliga yig'iladi (`overdueAmount = 0`);
    - Keyinchalik HLC bo'yicha yangi debit majburiyat (`receiving_debt`, `+adjustment`) kelganda avval mavjud `unappliedAdvance` avtomatik uni qo'playdi, faqat ortgan qismi `remainingDebt > 0` va `dueAtMs` bilan kechikish hisobiga kiradi.
- **Proyeksiya (`local_supplier_balances`, `LOCAL`):** `rebuildSupplierBalances()` `supplier_ledger` dan to'liq qayta quradi va test natijani tekshiradi.

#### e) Ta'minotchiga to'lov

- **Naqd to'lov (`cash`):** Shu terminalning kassa naqd qoldig'i (`readTerminalCashBalanceSync`) tekshiriladi: `balance < amount` -> `409 INSUFFICIENT_CASH_IN_DRAWER`. Yetarli bo'lsa bitta tranzaksiyada `cash_moves` da **`supplier_payment_out`** (`amountDelta = -amount`, `sourceType = 'supplier_payment'`) va `supplier_ledger` (`supplier_payment`) yoziladi. (`0010` migratsiyada `cash_moves` jadvali `PRAGMA foreign_keys=ON` ostida xavfsiz yangi CHECK bilan qayta quriladi).
- **Naqdsiz to'lov (`card`, `uzqr`, `payme`, `click`, `uzum`, `other`):** `cash_moves` ga yozilmaydi (`providerRef?` saqlanadi). (`social_card` ta'minotchiga to'lovda qabul qilinmaydi).
- **Idempotency:** `clientRequestId` + kanonik `request_hash` (`409 IDEMPOTENCY_CONFLICT` yoki `200 idempotentReplay: true`).

#### f) Ta'minotchiga qaytarish (`supplier_returns` + `supplier_return_lines`, `FACT`)

- **Qaror:** T1.8 ichida to'liq amalga oshiriladi.
- **Qoidalar:**
  - Faqat joylangan (`goods_receivings`) qatordan qaytariladi.
  - `cost_status === 'unknown'` qator qaytarilmaydi (`409 RECEIVING_LINE_COST_UNKNOWN` — avval narx tasdiqlanishi kerak).
  - `returnQty <= receivingLine.qty - sum(previousSupplierReturnsOnLine)` (ortiqcha -> `409 SUPPLIER_RETURN_QTY_EXCEEDED`).
  - **Ombor chiqimi:**
    - `stock_moves` da `reason = 'supplier_return'`, `sourceType = 'supplier_return'`, `sourceId = supplierReturn.id`.
    - Partiyali tovarda **aynan asl `batchId` dan** chiqim qilinadi; agar shu partiyadan qolgan zaxira `< returnQty` bo'lsa `409 SUPPLIER_RETURN_BATCH_DEPLETED` bilan rad etiladi.
    - Partiyasiz tovarda `qtyOnHand >= returnQty` tekshiriladi (`INSUFFICIENT_STOCK`), `costValueDelta` asl kirim qatorining narxidan mutanosib (`computeProportionalCost` + oxirgi to'liq qoldiqda aniq qoldiq tiyin) olinadi (`applyOutboundExactCostSync`), o'rtacha pul va qoldiq farqi nazorat qilinadi.
  - `supplier_ledger` ga `-totalReturnCost` (`entryType = 'supplier_return'`) yoziladi (agar oldindan to'langan bo'lsa avansga aylanishi mumkin).

#### g) RBAC, maxfiylik va unumdorlik

- **RBAC:** Ta'minotchi, kirim, narx tasdiqlash, to'lov va qaytarish **faqat `owner` va `manager`** uchun; `cashier` da `403 AUTH_FORBIDDEN`.
- **Maxfiylik:** PII (`name`, `phone`, `tin`, `contactPerson`) xato xabarlari, Pino loglari va outbox debug'da chiqmaydi; kassir API'lariga tannarx kirishlari umuman ochilmaydi.
- **Unumdorlik:** 100 qatorli kirim hujjatini joylash (`postReceiving`) haqiqiy WAL disk SQLite'da **`<= 500 ms`** (100 qator uchun ommaviy prefetch + bitta tranzaksiya).

#### h) Model testi

- Mustaqil TypeScript modeli bilan kamida **60 qadamli** tasodifiy ketma-ketlik (aralash ma'lum va `costUnknown = true` kirimlar, sotuvlar, `confirmReceivingLineCost`, naqd/karta to'lovlar avans bilan, ta'minotchiga qaytarish, tuzatish `+`/`-`):
  - Har qadamda ta'minotchi balansi + avansi + kechikishi, kassa qoldig'i va ombor zaxira/qiymat tenglamasi, yakunda `rebuildSupplierBalances()` va `rebuildStockProjections()` tiyinigacha tekshiriladi.

#### i) Doiradan tashqari

- Purchase order / avtomatik buyurtma, smena (T1.9), fiskal integratsiya (F3).

---

### Egasi yoki Claude qarori kerak bo'lgan savollar

- Yo'q. Reja tasdiqlangach 1-navbatda `T1.7 test qarzi`, keyin `T1.8` amalga oshiriladi.
