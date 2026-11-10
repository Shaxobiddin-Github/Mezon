## Hisobot: T1.6

Branch / PR: `gemini/T1.6-void-return` / https://github.com/Shaxobiddin-Github/Mezon/pull/13
Commit: `54445fbc77fe2434d2b6920a3b4b56ed71675308` (`T1.6: Chekni bekor qilish (void), qaytarish va v_sales_lines`)

### Nima qilindi

1. **Sof domen mantiqi (`@mezon/domain`, IO va `Date`/`Number` siz):**
   - `auth.ts`: `sale:void` va `sale:return` huquqlari (`owner`, `manager`; `cashier` da yo'q — faqat supervisor PIN bilan), hamda `reports:profit` ruxsati (qat'iy faqat `owner`).
   - `errors.ts`: T1.6 domen xato kodlari (`VOID_WINDOW_EXPIRED`, `SALE_NOT_FOUND`, `SALE_ALREADY_VOIDED`, `SALE_HAS_RETURNS`, `FISCALIZED_SALE_CANNOT_VOID`, `RETURN_NOT_FOUND`, `SALE_LINE_NOT_FOUND`, `RETURN_QTY_EXCEEDED`, `RETURN_PAYMENT_LIMIT_EXCEEDED`, `INSUFFICIENT_CASH_IN_DRAWER`, `SUPERVISOR_OVERRIDE_REQUIRED`).
   - `stock.ts`: `applyReplayStockMove` qaytarish (`move.reason !== 'return'`) paytida `lastUnitCost` ni o'zgartirmasligi ta'minlandi (V4.1/V4.2 pariteti).
   - `return.ts`: V1 bo'yicha do'kon vaqt zonasi (`Asia/Tashkent` standarti, `assertValidStoreTimeZone`, `getBusinessDateKey`, `isSameBusinessDay`, `assertSaleVoidBusinessDay`, T1.9 izohi bilan), majburiy sabab (`normalizeMandatoryReason`), qaytarish kodi (`formatReturnCode`), `[L, U]` QQS himoyali kumulyativ taqsimot (`computeCumulativeReturnLineAmounts`), ko'p partiyali proporsional zaxira qaytarish oyoqchalari (`allocateReturnStockMoveLegs`, V5 bo'yicha `quick_sale` va `unlimited` uchun bo'sh), V2 sof naqd chegarasi (`payments.amount`) va kross-usul taqiqi (`resolveReturnPayments`, `createEmptyPaymentMethodMap`), kanonik idempotentlik satrlari (`canonicalizeVoidSaleRequest`, `canonicalizeCreateReturnRequest`).
   - `return.test.ts`: 5 ta test (jumladan, V1/V2/V5 va `600` ta `fast-check` kumulyativ yaxlitlash property run).

2. **Kontraktlar (`@mezon/contracts`):**
   - `return.ts` va `index.ts`: `VoidSaleRequestSchema`, `CreateReturnRequestSchema`, `ReturnDtoSchema`, `ReturnLineDtoSchema`, `ReturnPaymentDtoSchema`, `VoidedSaleDtoSchema`, `VoidSaleResponseSchema`, `CreateReturnResponseSchema`, `ListSaleReturnsResponseSchema`, `SalesLinesReportQuerySchema`, `SalesLinesReportSummarySchema`.
   - `ReturnLineDtoSchema` va `SaleLineDtoSchema` kassir/POS javoblaridan `costValue` va foydani qat'iy istisno qiladi; `SalesLinesReportSummarySchema` esa faqat `reports:profit` (`owner`) endpointi uchun ajratilgan.

3. **Lokal baza va ombor/kassa/repozitoriy (`@mezon/db-local`):**
   - `schema/index.ts` va `0008_void_return.sql`: `local_device_state.last_return_seq`, `local_hub_config.store_timezone` (`DEFAULT 'Asia/Tashkent'`), `sales.void_client_request_id` va `sales.void_request_hash` (`uidx_sales_org_void_client_req`, kuchaytirilgan `chk_sales_void_pair`), hamda yangi `FACT` jadvallar (`returns`, `return_lines`, `return_payments`).
   - `sale-migrations.ts` va `scripts/check-migrations.mjs`: V3 (`trg_sales_voided_monotone`, `trg_sales_immutable_core`), `buildSalesLinesViewSql()` (`v_sales_lines` void qilingan cheklarni chiqarib tashlaydi, qolgan sotuv `+1` va qaytarish `-1` yozuvlarini birlashtiradi), hamda `assertReturnAndViewMigrationsComplete()` (`db:check` da manfiy tekshiruvlar bilan).
   - `auth-repo.ts`, `cart-repo.ts`, `device-state.ts`, `sale-repo.ts`: eski migratsiyalardan (`M1` upgrade) moslikni saqlash uchun aniq ustunli so'rovlar, `advanceReturnSeqSync` va `readReturnSeqSync`.
   - `stock-repo.ts`: `applyReturnStockMoveSync` (Variant 1 bo'yicha asl partiyaga va asl tannarxga tiklash; `warn` kamomaddan partiyasiz sotilgan oyoqchalar uchun `'RET-' + saleLineId` zaxira partiyasi; jonli balans to'g'ridan-to'g'ri `applyReplayStockMove` orqali yangilanadi).
   - `return-repo.ts`: `SqliteReturnStore` (`voidSale`, `createReturn`, `getReturnById`, `listSaleReturns`, `querySalesLinesReport`, `setStoreTimezone`, `getStoreTimezone`), F3 fiskal darvoza ilgagi (`assertSaleNotFiscalizedForVoidSync`), T1.7 qarz ilgagi (`assertAndApplyDebtHookSync`) va C1 test ilgagi (`ReturnStoreTestHooks`).

4. **Hub HTTP API (`apps/hub`):**
   - `return-service.ts`, `return-routes.ts`, `error-handler.ts`, `routes.ts`, `server.ts`: `POST /sales/:id/void`, `POST /sales/:id/returns`, `GET /sales/:id/returns`, `GET /returns/:id`, `GET /reports/sales-lines/summary` (`reports:profit` — faqat `owner`).
   - Kassir void/qaytarish uchun supervisor (`owner`/`manager`) PIN tasdig'i (`verifySupervisorPin`), T0.6 blokirovkasi, hamda `sale.voided` / `return.created` Pino audit loglari (PIN, parol, token, `costValue` va foydasiz).

### O'zgargan fayllar (fayl — sabab)

- `packages/domain/src/auth.ts`, `auth.test.ts` — `sale:void`, `sale:return` (`owner`/`manager`), `reports:profit` (`owner`) huquqlari va testlari.
- `packages/domain/src/errors.ts` — T1.6 xato kodlari.
- `packages/domain/src/stock.ts` — `applyReplayStockMove` ichida qaytarishda `lastUnitCost` ni o'zgarmas saqlash (`move.reason !== 'return'`).
- `packages/domain/src/return.ts`, `return.test.ts`, `index.ts` — void/qaytarish sof biznes mantiqi, V1/V2/V5 qoidalari, kumulyativ taqsimot va 600 ta `fast-check` property testi.
- `packages/contracts/src/return.ts`, `return.test.ts`, `index.ts` — T1.6 Zod so'rov/javob kontraktlari va `costValue`/foyda yashirilishi testlari.
- `packages/db-local/src/schema/index.ts`, `drizzle/0008_void_return.sql`, `drizzle/meta/_journal.json`, `drizzle/meta/0008_snapshot.json` — T1.6 SQLite sxemasi va migratsiyasi.
- `packages/db-local/src/sale-migrations.ts`, `scripts/check-migrations.mjs` — V3 triggerlari, `v_sales_lines` ko'rinishi va `db:check` himoyalari.
- `packages/db-local/src/auth-repo.ts`, `cart-repo.ts`, `device-state.ts`, `sale-repo.ts` — aniq ustunli o'qishlar (`M1` mosligi), `last_return_seq` boshqaruvi va `sale-repo` helperlari eksporti.
- `packages/db-local/src/stock-repo.ts` — `applyReturnStockMoveSync` tranzaksion ombor tiklash yordamchisi.
- `packages/db-local/src/return-repo.ts`, `index.ts`, `index.test.ts`, `sale.test.ts`, `return.test.ts` — `SqliteReturnStore`, migratsiya testlari va V1–V5 / V4 oracle / `v_sales_lines` / C1 / perf testlari.
- `apps/hub/src/error-handler.ts`, `sale-service.ts`, `return-service.ts`, `return-routes.ts`, `routes.ts`, `server.ts`, `return.test.ts` — HTTP marshrutlar, xato kodlari, supervisor PIN RBAC, Pino audit va E2E testlar.

### Migratsiyalar

- `packages/db-local/drizzle/0008_void_return.sql` (`meta/0008_snapshot.json`):
  - `PRAGMA foreign_keys = ON` ostida `cash_moves`, `payments`, `sale_lines` vaqtinchalik jadvallar orqali saqlanib `sales` (`void_client_request_id`, `void_request_hash`, `uidx_sales_org_void_client_req`, kuchaytirilgan `chk_sales_void_pair`), `local_device_state` (`last_return_seq`), `local_hub_config` (`store_timezone`) qayta qurildi;
  - `returns`, `return_lines`, `return_payments` (`FACT`, `store`) jadvallari yaratildi;
  - barcha `FACT`/`MONOTONE` (V3) triggerlar va `v_sales_lines` ko'rinishi qo'llandi (`db:check`: `0 diff statements`).

### V1–V5 majburiy tuzatishlar dalillari

- **V1 (Void faqat o'sha ish kunida):**
  - `packages/domain/src/return.ts` (`getBusinessDateKey`, `assertSaleVoidBusinessDay`, `Asia/Tashkent` standarti, T1.9 smena toraytirish izohi) va `packages/db-local/src/return-repo.ts` (`voidSale`).
  - `packages/domain/src/return.test.ts`, `packages/db-local/src/return.test.ts` hamda `apps/hub/src/return.test.ts`: `FixedClock` orqali `23:59` dagi chekni `00:01` da void qilish `409 VOID_WINDOW_EXPIRED` bilan rad etildi (huddi shu chek `createReturn` orqali qaytariladi).
- **V2 (`voidSale` va `createReturn` da naqd chegarasi bir xil):**
  - `packages/db-local/src/return-repo.ts`: `voidSale` ham, `createReturn` ham terminal kassa qutisida naqd yetmasa `INSUFFICIENT_CASH_IN_DRAWER` (`409`) qaytaradi; `originalPaid(sale, 'cash')` faqat `payments.amount` (sof naqd) ni oladi (`tenderedAmount` ni emas).
  - `packages/domain/src/return.test.ts`, `packages/db-local/src/return.test.ts`, `apps/hub/src/return.test.ts`: naqd + karta aralash chekda qaytimli holatda `payments.amount` dan 1 tiyin ortiq naqd qaytarish `409 RETURN_PAYMENT_LIMIT_EXCEEDED`, kassa qutisida naqd yetmaganda esa `409 INSUFFICIENT_CASH_IN_DRAWER` qaytarishi isbotlandi.
- **V3 (`sales` void ustunlari faqat bir marta va birga yoziladi):**
  - `packages/db-local/src/sale-migrations.ts` (`trg_sales_voided_monotone`, `trg_sales_immutable_core`) va `packages/db-local/src/return.test.ts`: void qilinmagan chekka yolg'iz `void_reason` (yoki boshqa void maydoni) yozish, hamda void qilingandan keyin `voided_at_ms`, `voided_by_user_id`, `void_reason`, `void_client_request_id` va `void_request_hash` ustunlaridan istalgan birini xom SQL `UPDATE` bilan o'zgartirish SQLite triggerlari tomonidan rad etildi.
- **V4 (Ombor uchun kuchli oracle):**
  - `packages/db-local/src/return.test.ts` (`V4.1 & V4.2 Strong Oracles`):
    1. **V4.1 (`voidSale` ≡ to'liq `createReturn`):** egizak tovarlarda bittasi void qilindi, ikkinchisi to'liq qaytarildi — `local_stock_balances` ning barcha 6 maydoni va `local_batch_balances` aynan teng chiqdi.
    2. **V4.2 (3 ta tasodifiy qisman qaytarish ≡ bitta to'liq qaytarish):** FIFO, o'rtacha tannarx va `warn` kamomadli rejimlarning har birida seed'li tasodifiy 3 ta qisman qaytarish yig'indisi bitta to'liq qaytarish bilan ham ombor balansi/partiyalari, ham jami `refund`, `vat`, `net` va `cost` bo'yicha aynan teng chiqdi; yakunda `rebuildProjections()` pariteti ham teng bo'ldi.
- **V5 (`quick_sale` va `unlimited` qatorlar):**
  - `packages/domain/src/return.ts`, `packages/db-local/src/return-repo.ts` va `packages/db-local/src/return.test.ts`: `quick_sale` hamda `unlimited` tovar qatorlari void yoki qaytarilganda 0 ta `stock_moves` yozilishi, pul va `v_sales_lines` esa to'g'ri hisoblanishi testda isbotlandi.

### Qabul mezonlari (1–10 testlar, property va perf natijalari)

- [x] **1-mezon (Kumulyativ yaxlitlash property testi):** `packages/domain/src/return.test.ts` — **`600` ta `fast-check` run** barcha qisman bo'linishlarda yig'indi tiyinigacha teng va `netExVat >= 0`, `vatTotal >= 0`, `netExVat + vatTotal = refundAmount` ekanini tasdiqladi.
- [x] **2-mezon (Ortiqcha / ikki marta qaytarish):** `packages/db-local/src/return.test.ts` — to'liq qaytarilgan qatorni qayta qaytarish va `0.001` ortiq so'rash `RETURN_QTY_EXCEEDED` bilan rad etildi.
- [x] **3-mezon (Qaytarishi bor chekni void qilish):** `packages/db-local/src/return.test.ts` — qisman qaytarilgandan keyin `voidSale` `SALE_HAS_RETURNS` bilan rad etildi, chek void bo'lmadi.
- [x] **4-mezon (Void qilingan chek va xom SQL himoyasi):** `packages/db-local/src/return.test.ts` — void qilingan chekka `createReturn` va ikkinchi `voidSale` `SALE_ALREADY_VOIDED` bilan rad etildi; xom SQL `UPDATE`/`DELETE` trigger tomonidan bloklandi.
- [x] **5-mezon (Parallel qisman qaytarishlar):** `packages/db-local/src/return.test.ts` — bir chekka parallel ikki `createReturn` so'rovidan biri o'tdi, qoldiqdan oshgan ikkinchisi `RETURN_QTY_EXCEEDED` bilan rad etildi.
- [x] **6-mezon (Child process crash safety C1):** `packages/db-local/src/return.test.ts` — alohida child process ichida `onBeforeCommit` orqali `process.exit(42)` bilan ham `voidSale`, ham `createReturn` uzildi; restartdan keyin yarim yozuvlar va `last_return_seq` / `last_device_seq` bo'shliqlari yo'q.
- [x] **7-mezon (Ombor differensial + V4.1/V4.2 oracle + `rebuildProjections()`):** `packages/db-local/src/return.test.ts` — FIFO, o'rtacha va `warn` kamomad holatlarida V4.1, V4.2 va `rebuildProjections()` pariteti to'liq o'tdi.
- [x] **8-mezon (Pul, kassa chegaralari va T1.7 ilgagi):** `packages/db-local/src/return.test.ts` va `apps/hub/src/return.test.ts` — kross-usul taqiqi, V2 `INSUFFICIENT_CASH_IN_DRAWER`, `RETURN_PAYMENT_LIMIT_EXCEEDED` va T1.7 qarz ilgagi rad etishlari o'tdi.
- [x] **9-mezon (`v_sales_lines` mustaqil model testi):** `packages/db-local/src/return.test.ts` — tasodifiy sotuvlar, qisman qaytarishlar va voidlar ketma-ketligida `v_sales_lines` jami tushum, QQS, tannarx va foydasi mustaqil TypeScript modeli bilan tiyinigacha teng chiqdi.
- [x] **10-mezon (Hub RBAC, Idempotency va C2 Audit E2E):** `apps/hub/src/return.test.ts` — kassir supervisor PIN'isiz `403`, kassir o'z PIN'i bilan `403`, 5 xato PIN T0.6 `429` lockout, manager/owner bevosita `200`, `409 IDEMPOTENCY_CONFLICT`, `403` foyda hisobotida kassir/manager cheklovi va `200` `owner` ruxsati, hamda javob/Pino loglarida PIN/token/`costValue`/foyda sizmasligi o'tdi.
- [x] **Property testlar soni:** `@mezon/domain/src/return.test.ts` — **`600` ta** `fast-check` run.
- [x] **20 qatorli chekni to'liq qaytarish tezligi (≤ 300 ms):**
  - `@mezon/db-local` (10 FIFO + 10 avg, WAL SQLite disk bazasida): **`median=52.30 ms`**, `samples=[61.93, 42.69, 62.64, 38.48, 52.30]`.

### Test natijasi (buyruq va haqiqiy chiqish)

1. **Lokal `pnpm verify` (`54445fb` ustida, exit code `0`):**
   - `prettier --check .` — `All matched files use Prettier code style!`
   - `turbo run build` — `17 successful, 17 total`
   - `node scripts/lint-workspaces.mjs` — `0` xato
   - `turbo run typecheck` — `22 successful, 22 total`
   - `turbo run db:check` — `19 successful, 19 total` (`PostgreSQL` hamda `SQLite`: `0 diff statements`)
   - `vitest run` — `Test Files 41 passed | 1 skipped (42)`, `Tests 208 passed | 2 skipped (210)` (`packages/db-cloud/src/pg-rls.test.ts` mahalliy Docker yo'qligi uchun skip qilingan, CI `Verify PostgreSQL RLS (ubuntu-latest)` da ishlaydi). T1.6 fayllari:
     - `packages/domain/src/return.test.ts` (`5 tests`) `309ms`
     - `packages/domain/src/auth.test.ts` (`4 tests`) `15ms`
     - `packages/contracts/src/return.test.ts` (`3 tests`) `36ms`
     - `packages/db-local/src/return.test.ts` (`7 tests`) `11148ms`
     - `packages/db-local/src/index.test.ts` (`10 tests`) `1201ms`
     - `packages/db-local/src/sale.test.ts` (`12 tests`) `9408ms`
     - `apps/hub/src/return.test.ts` (`1 test`) `1127ms`
   - `depcruise --config .dependency-cruiser.cjs apps/*/src packages/*/src` — `no dependency violations found (235 modules, 813 dependencies cruised)`

2. **GitHub Actions CI (`54445fbc77fe2434d2b6920a3b4b56ed71675308` — barcha 4 job `push` va `pull_request` da yashil):**
   - `Verify (ubuntu-latest)` — `success`: https://github.com/Shaxobiddin-Github/Mezon/actions/runs/42875861876/job/130038865480
   - `Verify (windows-latest)` — `success`: https://github.com/Shaxobiddin-Github/Mezon/actions/runs/42875861876/job/130038865647
   - `Verify PostgreSQL RLS (ubuntu-latest)` — `success`: https://github.com/Shaxobiddin-Github/Mezon/actions/runs/42875861876/job/130038865164
   - `Build & E2E Desktop Installer (windows-latest)` — `success`: https://github.com/Shaxobiddin-Github/Mezon/actions/runs/42875861876/job/130038865892

### Tekshirilmagan narsalar

- Haqiqiy PostgreSQL RLS integratsiya testlari (`pg-rls.test.ts`) lokalda Docker yo'qligi sababli mahalliy mashinada ishga tushirilmadi (lekin CI `Verify PostgreSQL RLS (ubuntu-latest)` jobida muvaffaqiyatli o'tdi).
- F3 fiskal qaytarish hujjati (hozir faqat `assertSaleNotFiscalizedForVoidSync` ilgagi), T1.7 mijoz qarzi bo'yicha void/qaytarish (`assertAndApplyDebtHookSync` ilgagi) hamda T1.9 smena kesimi — rejaga ko'ra keyingi bosqichlarda ulanadi.

### Qilingan taxminlar

- Hozir `voidSale` do'kon vaqt zonasi (`local_hub_config.store_timezone`, standarti `Asia/Tashkent`) bo'yicha o'sha ish kuni chegarasini tekshiradi; `T1.9` da smenalar qo'shilgach bu qoida "faqat ochiq smenadagi chek" ga toraytiriladi (`packages/domain/src/return.ts` va `return-repo.ts` da izoh qoldirilgan).

### Takliflar

- Keyingi bosqichlarda (`T1.9`) ochiq smena ID sini `voidSale` va `createReturn` ichidagi audit/kassa yozuvlariga bog'lab, yopilgan smena cheklarini void qilishni avtomatik yopish rejalashtirilganicha qoldirilsin.

### Egasi yoki Claude qarori kerak bo'lgan savollar

- Hozircha yo'q. T1.6 PR #13 (`gemini/T1.6-void-return`) Claude tekshiruvi (`QABUL`) uchun tayyor; ko'rsatmaga binoan merge qilinmadi.
