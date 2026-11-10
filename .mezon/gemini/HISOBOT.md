## Hisobot: T1.4

Branch / PR: `gemini/T1.4-complete-sale` / https://github.com/Shaxobiddin-Github/Mezon/pull/11
Commitlar:
- `64ff1a4c03b518269aa0da947bff894e8a2045e0` — `T1.3 test qarzi: do'kon aksiyasi, limit chegarasi, tasdiq maydonlari`
- `e420122c1fcd61ddf10f49e5839cef836f4f249d` — `T1.4: completeSale komandasi, chek/to'lov sxemasi va idempotentlik`
- `a8c863474cf978fd2e11c81fb029046ec5902ad1` — `T1.4: ESLint workspace bo'laklash (CI 2 GB OOM bartaraf)`

*(T1.3 PR #10 `main` ga `462cac770332667a4bdfad48b876e3e2da5cf682` bilan Squash & Merge qilindi va `gemini/T1.3-cart-pricing` o'chirildi.)*

---

### Nima qilindi

1. **T1.3 test qarzi (`64ff1a4`, mutatsiya dalillari bilan):**
   - `packages/domain/src/cart.test.ts` va `packages/db-local/src/cart.test.ts`:
     - **1-mutatsiya (`isPromotionActiveAt` do'kon filtri):** `promo.storeId !== null && storeId !== null && promo.storeId !== storeId` tekshiruvi olib tashlanganda `@mezon/domain` (`false` o'rniga `true`) va `@mezon/db-local` (`30_000n !== 5_000n`) testlari yiqildi.
     - **2-mutatsiya (`doesDiscountExceedCashierLimit` chegaralari):** `> maxAmount + 1n` hamda `%` shartida `+ 10_000n` (1 tiyin bo'shatish) kiritilganda `10_000 / 10_001` va `maxAmount / maxAmount + 1` chegara testlari yiqildi.
     - **3-mutatsiya (`isCartManualDiscountAuthorized` tasdiq juftligi):** `||` → `&&` ga o'zgartirilganda `overrideApprovedByUserId: null` + musbat `overrideApprovedAmount` holati `false` o'rniga `true` qaytarib testni yiqitdi.

2. **Domen (`@mezon/domain` — sof `bigint`, nol `Number`):**
   - `packages/domain/src/sale.ts`: `PAYMENT_METHODS`, `formatReceiptCode` (`<deviceId oxirgi 4 katta hex>-<6+ xonali receipt_no>`, izohda faqat ko'rinish uchun ekani, noyoblik DB `UNIQUE(organization_id, device_id, receipt_no)` bilan kafolatlanishi va F4 da terminal qisqa kodiga o'tishi yozildi), `validateCashSalePayment`, `validateSalePaymentsInvariant` (`SUM(payments.amount) + debtAmount === totalFinal`, qaytim faqat naqdda).
   - `packages/domain/src/errors.ts` va `cart.ts`: `CART_EMPTY`, `SALE_TOTAL_CHANGED`, `IDEMPOTENCY_CONFLICT`, ixtiyoriy `DomainError.details`, hamda `CART_STATUSES` da `'completed'`.

3. **Kontraktlar (`@mezon/contracts`) va log redaksiyasi (`@mezon/drivers`):**
   - `packages/contracts/src/sale.ts`: `CompleteSaleRequestSchema` (`payments[]` `length(1)`, T1.4 da faqat `'cash'`, T1.5 da o'zgarishsiz kengayadi) va `CompleteSaleResponseSchema` (`strictObject` — tannarx/foyda va fiskal holat ustunlarisiz).
   - `packages/contracts/src/auth.ts`: `ApiErrorEnvelopeSchema` da ixtiyoriy tuzilgan `error.details`.
   - `packages/drivers/src/node/redact.ts` (**C2**): `DEFAULT_LOG_REDACT_PATHS` ga `cost`, `costValue`, `costPrice`, `profit`, `margin` (va ularning `*.` / `*.*.` shakllari) qo'shildi.

4. **Lokal baza va `completeSale` tranzaksiyasi (`@mezon/db-local`):**
   - `packages/db-local/src/schema/index.ts` va `drizzle/0006_complete_sale.sql`:
     - **`sales` (`MONOTONE`, `store`):** `receipt_no`, `receipt_code`, `source_cart_id`, `cashier_user_id`, `customer_id`, `shift_id`, `client_request_id` (`UNIQUE`), jami summalar snapshot'i, `total_paid`, `debt_amount`, `change_amount`, supervisor tasdig'i va `voided_*` (fiskal ustunlar **olib tashlandi**, F3 `fiscal_docs` da bo'ladi). Ikki tomonlama `MONOTONE` triggerlar (`trg_sales_voided_monotone`, `trg_sales_immutable_core`) va `assertSaleMigrationsComplete` (`db:check`).
     - **`sale_lines` (`FACT`, `store`):** to'liq snapshot (`item_name`, `unit`, `qty`, `unit_price_snapshot`, aksiya/chegirma/QQS, `mxik_snapshot`, `package_code_snapshot`) va `cost_value` (`stock_moves` dagi `-cost_value_delta` yig'indisi).
     - **`payments` (`FACT`, `store`):** naqd (`tendered_amount`, `change_amount`) + T1.5/F3 (`method`, `provider_ref`, `provider_meta_json`).
     - `local_device_state.last_receipt_seq` (`ALTER TABLE ADD`) va `advanceReceiptSeqSync` (`UPDATE ... RETURNING` tranzaksiya ichida).
     - `local_carts` ga `'completed'` holati, `completed_sale_id`, `completed_at_ms`, `completion_warnings_json` qo'shildi (`PRAGMA foreign_keys = ON` tranzaksiyasi ichida `local_cart_lines` ni xavfsiz saqlab yangilanadi); `listCarts()` tugallangan savatlarni chiqarmaydi.
   - `packages/db-local/src/stock-repo.ts` va `cart-repo.ts`: `applyOutboundStockMoveSync` va `evaluateCartRowInDbSync` ajratildi; `completeSale` ichma-ich `uow.execute` siz aynan shu funksiyalarni chaqiradi.
   - `packages/db-local/src/sale-repo.ts`: idempotentlik (`client_request_id`), server qayta hisobi (`409 SALE_TOTAL_CHANGED` + `details`), override qayta tekshiruvi (`403 DISCOUNT_OVERRIDE_REQUIRED`), `inArray` batch prefetch va `'block'` rejimida bir nechta/dubl-tovar qatorlar bo'yicha jamlangan yetishmovchilik tekshiruvi (`409 INSUFFICIENT_STOCK`), `'warn'` ogohlantirishlari va test-only `__testHooks` (**C1**).

5. **Hub API (`apps/hub`):**
   - `apps/hub/src/sale-service.ts`, `cart-routes.ts`, `routes.ts`, `server.ts`, `error-handler.ts`:
     - `POST /carts/:id/complete` (`200 OK`, `cart:write` RBAC), allow-list mapper (`costValue`/foyda yo'q), `409` `details`, `sale.completed` strukturali Pino audit logi (**C2**), va `__testHooks` ni hech qachon uzatmaslik (**C1**).

6. **CI 2 GB OOM tuzatishi (`a8c8634`):**
   - T1.4 dagi qo'shimcha Drizzle jadvallari (`25` jadval, `~28` tsconfig) bir vaqtda bitta `eslint .` jarayonida V8 heap'ni `2.50 GB` ga chiqarib CI runnerlarning default `2048 MB` limitida OOM (`exit 134`) chaqirdi.
   - `eslint.config.mjs` ga ixtiyoriy `MEZON_LINT_PROJECTS` filtri va `scripts/lint-workspaces.mjs` (3 tadan workspace bo'laklarida barcha ildiz fayllar + `packages/*` + `apps/*` ni aynan o'sha qoidalar bilan tekshirish) qo'shildi (`--max-old-space-size=1024` ostida ham xatosiz o'tadi).

### O'zgargan fayllar (fayl — sabab)

- `eslint.config.mjs`, `package.json`, `scripts/lint-workspaces.mjs` — `MEZON_LINT_PROJECTS` va bo'laklangan `pnpm run lint` (CI 2 GB OOM tuzatishi)
- `packages/domain/src/cart.test.ts`, `packages/db-local/src/cart.test.ts` — T1.3 test qarzi (1-commit)
- `packages/domain/src/errors.ts`, `cart.ts`, `sale.ts`, `sale.test.ts`, `index.ts` — `Sale` domenni hisoblash, formatlash va to'lov invarianti
- `packages/drivers/src/node/redact.ts` — **C2** `cost`/`costValue`/`profit`/`margin` redaksiya qoidalari
- `packages/contracts/src/auth.ts`, `sale.ts`, `sale.test.ts`, `index.ts` — `CompleteSale` Zod 4 DTO va xato `details`
- `packages/db-local/src/schema/index.ts`, `drizzle/0006_complete_sale.sql`, `drizzle/meta/*`, `sale-migrations.ts`, `scripts/check-migrations.mjs` — `sales`/`sale_lines`/`payments`, `last_receipt_seq`, FK-xavfsiz `local_carts` va `MONOTONE` triggerlar
- `packages/db-local/src/device-state.ts`, `stock-repo.ts`, `cart-repo.ts`, `sale-repo.ts`, `sale.test.ts`, `index.test.ts`, `index.ts` — `applyOutboundStockMoveSync`, `evaluateCartRowInDbSync`, `SqliteSaleStore` va testlar
- `apps/hub/src/error-handler.ts`, `sale-service.ts`, `cart-routes.ts`, `routes.ts`, `server.ts`, `index.ts`, `sale.test.ts` — `POST /carts/:id/complete`, RBAC, `C1`/`C2` va HTTP E2E testlar

### Migratsiyalar

- `packages/db-local/drizzle/0006_complete_sale.sql`:
  - `sales` (`MONOTONE`, `trg_sales_no_delete`, `trg_sales_voided_monotone`, `trg_sales_immutable_core`), `sale_lines` (`FACT`, `trg_sale_lines_no_update/delete`), `payments` (`FACT`, `trg_payments_no_update/delete`).
  - `local_device_state` ga `ALTER TABLE ADD last_receipt_seq`.
  - `local_carts` ni `'completed'` holati va `completed_*` ustunlari bilan `PRAGMA foreign_keys = ON` ostida `local_cart_lines` ni saqlab yangilash (`check-migrations.mjs`: 0 diff).

### Qabul mezonlari

- [x] **T1.3 test qarzi va mutatsiya isbotlari (`64ff1a4`)** — `packages/domain/src/cart.test.ts` (`T1.3 test debt (1)..(3)`) va `packages/db-local/src/cart.test.ts` (`storeId` A/B/`null`), uchala mutatsiya testni yiqitishi tasdiqlandi.
- [x] **Atomik yagona tranzaksiya (`b`)** — `applyOutboundStockMoveSync` va `evaluateCartRowInDbSync` ajratildi; `sales`, `sale_lines`, `payments`, `stock_moves`, `local_stock_balances`/`local_batch_balances`, `last_receipt_seq`, `local_carts` va `local_outbox` bitta `uow.execute` da yoziladi.
- [x] **Server qayta hisobi, `SALE_TOTAL_CHANGED` va override (`c`)** — `packages/db-local/src/sale.test.ts` va `apps/hub/src/sale.test.ts` (`409 SALE_TOTAL_CHANGED` va `403 DISCOUNT_OVERRIDE_REQUIRED`).
- [x] **Zaxira siyosati (`block` + `warn` + `unlimited`/`quick_sale`) (`d`)** — `block` rejimida dubl-mahsulot jamlanma yetishmovchiligi ham to'liq rollback + `409 INSUFFICIENT_STOCK` (`insufficientLines` `details`) + `'open'` savat; `warn` rejimida ogohlantirishlar saqlanadi; `unlimited` va `quick_sale` omborga tegmaydi (`costValue = 0`).
- [x] **Chek raqami va fiskal ustunlar yo'qligi (`e`, qaror #1 va #3)** — `last_receipt_seq` rollback va crash'da sarflanmaydi; ko'rinadigan `receipt_code` (`<4hex>-000001`), noyoblik `(organization_id, device_id, receipt_no)`; `sales` da fiskal status ustunlari yo'q.
- [x] **Chidamlilik testlari (`f`):**
  - *Ikki marta bosish (`db-local` va `hub`):* bir xil `(cartId, clientRequestId)` → aynan bitta `sales`, bir xil `receiptNo` va `warnings`, 0 qo'shimcha outbox/stock; boshqa `cartId` bilan qayta ishlatish → `409 IDEMPOTENCY_CONFLICT`.
  - *Parallellik (`db-local` 5 parallel, `hub` 3 parallel):* `Promise.all` natijasida bazada qat'iy 1 ta `sales`; bir xil `clientRequestId` idempotent javob, boshqa ID esa `409 CART_NOT_OPEN` oladi.
  - *Rollback → qayta urinish:* `409 INSUFFICIENT_STOCK` dan keyin `sales = 0`, `last_receipt_seq = 0`, savat `'open'`; kirim qilinib **xuddi shu `clientRequestId`** bilan qayta so'rovda `receiptNo = 1` bilan muvaffaqiyatli yopiladi.
  - *Child process crash testi (`crash-worker.mjs`):* SQLite `WAL` fayl bazada `onBeforeCommit` ichida `process.exit(42)` bilan (`COMMIT` dan oldin) jarayon o'ladi → qayta ochilganda `sales = 0`, `sale_lines = 0`, `payments = 0`, outbox va zaxira o'zgarmagan, `last_receipt_seq = 0`, savat `'open'`, keyingi urinish esa `receiptNo = 1` bilan to'liq o'tadi.
- [x] **C1 dalillari (`__testHooks` izolyatsiyasi):** `__testHooks?: SaleStoreTestHooks` faqat test in'ektsiyasi orqali ishlaydi; `process.env` yoki global bayroq o'qilmaydi (`MEZON_TEST_CRASH_BEFORE_COMMIT=1` bilan ikkala `db-local/src/sale.test.ts` va `hub/src/sale.test.ts` da salbiy tekshiruv o'tdi); `apps/hub/src/server.ts` (`createSqliteSaleStore`) va `apps/desktop` da `__testHooks` uzatilmaydi va mavjud emas.
- [x] **C2 dalillari (`sale.completed` Pino audit logi):** `apps/hub/src/sale.test.ts` da `sale.completed` log qatorlarida PIN, token, `cost`/`costValue`/`costPrice`/`profit`/`margin` kalitlari ham, xom qiymatlari ham yo'qligi tekshirildi; hamda `createHubLogger` + `HUB_LOGGER_REDACT_PATHS` (`DEFAULT_LOG_REDACT_PATHS`) `pin`, `token`, `cost`, `costValue`, `profit` maydonlarini (tashqi va ichki) `[Redacted]` ga aylantirishi isbotlandi.
- [x] **20 qatorli savdo unumdorligi (`<= 300 ms`, `g`):**
  - `@mezon/db-local` (`packages/db-local/src/sale.test.ts`, disk WAL SQLite, 10 FIFO partiyali + 10 o'rtacha): `pnpm run verify` parallel yuklamasida **`115.48 ms`** (yakka ishga tushirishda `40.35 ms`).
  - `@mezon/hub` HTTP E2E (`apps/hub/src/sale.test.ts`, `POST /carts/:id/complete`): `pnpm run verify` parallel yuklamasida **`107.47 ms`** (yakka ishga tushirishda `43.65 ms`).

### Test natijasi (buyruq va haqiqiy chiqish)

1. Qo'shimcha xotira cheklovli lint tekshiruvi (`NODE_OPTIONS=--max-old-space-size=1024 pnpm run lint`): 0 xato.
2. To'liq lokal `pnpm run verify` (`a8c8634` ustida):
   - `prettier --check .` → `All matched files use Prettier code style!`
   - `turbo run build` → `17 successful, 17 total`
   - `node scripts/lint-workspaces.mjs` → 0 xato
   - `turbo run typecheck` → 0 xato
   - `turbo run db:check` → PostgreSQL va SQLite (`0 diff statements`)
   - `vitest run` → `Test Files 37 passed | 1 skipped (38)`, `Tests 180 passed | 2 skipped (182)` (skip: `packages/db-cloud/src/pg-rls.test.ts` lokal Windows'da Docker yo'qligi uchun)
   - `depcruise --config .dependency-cruiser.cjs apps/*/src packages/*/src` → `no dependency violations found (222 modules, 708 dependencies cruised)`
3. GitHub Actions CI (`a8c863474cf978fd2e11c81fb029046ec5902ad1`):
   - Workflow runs: https://github.com/Shaxobiddin-Github/Mezon/actions/runs/42852242967 (PR) va https://github.com/Shaxobiddin-Github/Mezon/actions/runs/42851794566 (push)
   - `Verify (ubuntu-latest)`: `success` — https://github.com/Shaxobiddin-Github/Mezon/actions/runs/42852242967/job/129955766375
   - `Verify (windows-latest)`: `success` — https://github.com/Shaxobiddin-Github/Mezon/actions/runs/42852242967/job/129955766478
   - `Verify PostgreSQL RLS (ubuntu-latest)`: `success` — https://github.com/Shaxobiddin-Github/Mezon/actions/runs/42852242967/job/129955766481
   - `Build & E2E Desktop Installer (windows-latest)`: `success` — https://github.com/Shaxobiddin-Github/Mezon/actions/runs/42852242967/job/129955766153

### Tekshirilmagan narsalar

- `packages/db-cloud/src/pg-rls.test.ts` lokal Windows'da Docker yo'qligi uchun skip qilindi, lekin Ubuntu CI dagi `Verify PostgreSQL RLS` job'ida `success` bilan o'tdi.

### Qilingan taxminlar

- Bo'sh savatni (`lines.length === 0`) yakunlash `400 CART_EMPTY` bilan rad etiladi.
- `parked` holatdagi savat avval `POST /carts/:id/resume` orqali `'open'` ga qaytariladi, shundan keyingina `completeSale` qilinadi (aks holda `409 CART_NOT_OPEN`).

### Takliflar

- T1.5 (aralash to'lovlar va `cash_moves`) hamda T1.6 (`voided_at_ms` bilan bekor qilish va qaytarish) uchun `sales` triggeri (`trg_sales_immutable_core`) va `payments` sxemasi allaqachon tayyor; T1.5 da `CompleteSaleRequestSchema.payments` ni `min(1)` ga ko'tarib `'cash'` qismi uchun `cash_moves` yozish kifoya bo'ladi.

### Egasi yoki Claude qarori kerak bo'lgan savollar

- Yo'q. T1.4 bo'yicha barcha bandlar bajarildi; `QABUL` tasdig'i va T1.5 bo'yicha keyingi topshiriq kutilmoqda.
