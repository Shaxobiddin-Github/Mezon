## Hisobot: T1.5

Branch / PR: `gemini/T1.5-payments` / https://github.com/Shaxobiddin-Github/Mezon/pull/12
Commitlar:
- `adf9e670d08028a134021394a4a244eb6357cefc` — `T1.4 test qarzi: zaxira chegarasi, idempotentlik do'koni`
- `9f218d94b0e92a8f7af5b2bff10a8eb720dc02ab` — `T1.5: Aralash to'lovlar, qaytim, cash_moves va M1-M5 himoyalar`
- `51070e900f85b0e29bc9919c04ef5f4d5d99481e` — `T1.5: 20 qatorli 3-to'lovli perf testini 5 namunali medianga o'tkazish`

*(Oldingi T1.4 PR #11 `main` ga `740ab2a895a85f83a8c8695baee363f05e45f269` SHA bilan Squash & Merge qilindi va `gemini/T1.4-complete-sale` lokal/remote branch'lari o'chirildi.)*

---

### Nima qilindi

1. **Birinchi alohida commit — T1.4 test qarzi (`adf9e67`, mutatsiya dalillari bilan):**
   - `T1.4 debt (1)` (`block` rejimida aniq 1 milli chegara): `5.000` zaxira bilan `5.000` o'tadi (`0` qoladi), `5.001` yakka qator va `3.000 + 2.001 = 5.001` ikki qatorli savat `INSUFFICIENT_STOCK` (`409`) bilan rad etiladi va bazaga 0 ta yozuv tushadi (`receipt_seq` ham o'zgarmaydi). Mutatsiya dalili: `sale-repo.ts` da `avail < need` → `avail + 1n < need` va `overridePolicy: 'warn'` qo'yilganda aynan `T1.4 debt (1)` yiqildi.
   - `T1.4 debt (2)` (idempotentlik do'kon izolyatsiyasi): bir xil tashkilotdagi boshqa `store_id` dagi `sales` qatori bilan bir xil `clientRequestId` (va hatto bir xil `sourceCartId`) yuborilganda `IDEMPOTENCY_CONFLICT` (`409`) va 0 yozuv. Mutatsiya dalili: `existingSale.storeId !== ctx.storeId` sharti olib tashlanganda `T1.4 debt (2)` `IDEMPOTENCY_CONFLICT` o'rniga `idempotentReplay: true` qaytarib yiqildi.

2. **Domen (`@mezon/domain` — sof `bigint`, tashqi bog'liqliksiz):**
   - `packages/domain/src/errors.ts` va `money.ts`: `'CUSTOMER_REQUIRED'` xato kodi hamda 64-bit SQL integer diapazoni (`MAX_MONEY_TIYIN = 9_223_372_036_854_775_807n`, `isSignedInt64Money`).
   - `packages/domain/src/sale.ts`: `CASH_MOVE_INFLOW_TYPES` (`sale_cash_in`, `debt_payment_in`, `cash_in`), `CASH_MOVE_OUTFLOW_TYPES` (`sale_change_out`, `refund_cash_out`, `cash_out`, `encashment`), `CASH_MOVE_TYPES`, `normalizePaymentProviderRef` (`<= 128`), `resolveSalePayments`, `validateSalePaymentsInvariant` (bitta `cash`, ko'plab naqdsiz qatorlar, nol/manfiy rad, non-cash ortiqcha rad, `totalFinal = 0` → `payments: []`, `debt > 0` va `customerId = null` → `CUSTOMER_REQUIRED`, 64-bit chegara), hamda `canonicalizeCompleteSaleRequest`.

3. **Kontraktlar (`@mezon/contracts`):**
   - `packages/contracts/src/sale.ts`: `BoundedMoneyStringSchema` va `PositiveBoundedMoneyStringSchema` (`<= MAX_MONEY_TIYIN`), `CashSalePaymentInputSchema` (T1.4 bilan orqaga mos), `NonCashSalePaymentInputSchema` (va `providerRef` normallashtirish), `CompleteSaleRequestSchema` (bo'sh `payments: []` va max 1 `cash`), `SaleDtoSchema.completedByUserId` va `CashMoveDtoSchema`.

4. **Lokal baza (`@mezon/db-local`) va `0007_payments_cash_moves.sql`:**
   - `packages/db-local/src/schema/index.ts` va `drizzle/0007_payments_cash_moves.sql`:
     - `sales` (`MONOTONE`): `completed_by_user_id` va `request_hash` qo'shildi (`0007` da mavjud T1.4 qatorlar uchun `completed_by_user_id = cashier_user_id`, `request_hash = 'legacy:' || id`); `__tmp_sale_lines` va `__tmp_payments` orqali `PRAGMA foreign_keys = ON` ostida xavfsiz qayta qurish va barcha `MONOTONE`/`FACT` triggerlarni tiklash.
     - `payments` (`FACT`): `CHECK(amount > 0)` va naqd/naqdsiz `tendered_amount` / `change_amount` cheklovi kuchaytirildi.
     - `cash_moves` (`FACT`, `store`, umumiy `device_id` ustuni bilan): `shift_id` (nullable), `type`, `amount_delta` (ishorali `CHECK`), `source_type`, `source_id`, `payment_id`, `reason`, `created_by_user_id`; indekslar (`idx_cash_moves_terminal` `(organization_id, store_id, device_id, created_at_ms)` bilan).
   - `packages/db-local/src/sale-migrations.ts`: `trg_sales_immutable_core` endi `completed_by_user_id` va `request_hash` ni ham himoyalaydi; `assertSaleMigrationsComplete` `DROP TABLE` dan keyin triggerlar qayta yaratilganini tekshiradi.
   - `packages/db-local/src/sale-repo.ts`: SHA-256 `request_hash` hisobi (`.dependency-cruiser.cjs` da faqat `db-local` uchun `node:crypto` ruxsati, `domain` sof qoldi), `M3` (`debt > 0` → `CUSTOMER_REQUIRED`, `customerId !== null` → `VALIDATION_ERROR`), F3 PF-246 ulanish nuqtasi (to'lov invariantidan keyin, `receipt_no` va ombordan oldin), `cash_moves` yozuvlari (`sale_cash_in` = `+tendered`, `sale_change_out` = `-change` faqat `change > 0` da), hamda terminal bo'yicha `getCashDrawerBalanceSync` va do'kon bo'yicha `getStoreCashBalanceSync`.

5. **Hub API (`apps/hub`):**
   - `apps/hub/src/error-handler.ts`, `sale-service.ts`, `cart-routes.ts`: `CUSTOMER_REQUIRED: 400`, aralash to'lovlar va `completedByUserId` DTO/audit logi (nol tannarx/foyda/marja).

### O'zgargan fayllar
- `.dependency-cruiser.cjs` — `db-local-src-imports` qoidasiga `node:crypto` (`request_hash` SHA-256 uchun) qo'shildi.
- `packages/domain/src/errors.ts`, `money.ts`, `sale.ts`, `index.ts`, `sale.test.ts` — `CUSTOMER_REQUIRED`, `MAX_MONEY_TIYIN`, `CASH_MOVE_TYPES`, `resolveSalePayments`, `validateSalePaymentsInvariant`, `canonicalizeCompleteSaleRequest` va 500 ta property test.
- `packages/contracts/src/sale.ts`, `index.ts`, `sale.test.ts` — aralash to'lov, M4 chegara (`MAX_MONEY_TIYIN`), `completedByUserId`, `CashMoveDtoSchema`.
- `packages/db-local/src/schema/index.ts`, `drizzle/0007_payments_cash_moves.sql`, `drizzle/meta/_journal.json`, `drizzle/meta/0007_snapshot.json`, `src/sale-migrations.ts`, `src/sale-repo.ts`, `src/index.ts`, `src/index.test.ts`, `src/sale.test.ts` — sxema, `0007` migratsiya, triggerlar, repo, M1–M5, 50 ta fuzz va perf testlar.
- `apps/hub/src/error-handler.ts`, `sale-service.ts`, `cart-routes.ts`, `sale.test.ts` — HTTP API, RBAC, M3/M4/M5 E2E testlar va 5 namunali E2E perf testi.

### Migratsiyalar
- `packages/db-local/drizzle/0007_payments_cash_moves.sql` (`meta/0007_snapshot.json`):
  - `sales` (`completed_by_user_id`, `request_hash` + `chk_sales_request_hash_nonempty`, mavjud qatorlar backfill bilan qayta qurildi), `payments` (`amount > 0` va non-cash `tendered_amount IS NULL` CHECK bilan qayta qurildi), `cash_moves` (`FACT`, 4 ta indeks) va barcha `FACT`/`MONOTONE` triggerlari qayta yaratildi.
  - PostgreSQL (`@mezon/db-cloud`) o'zgarmadi (bulut sinxroni F2 da).

---

### Qabul mezonlari va M1–M5 dalillari

- [x] **T1.4 test qarzi 1-commit (`adf9e67`)** — `T1.4 debt (1)` (`avail + 1n < need` + `'warn'` mutatsiyasi bilan yiqildi) va `T1.4 debt (2)` (`storeId` tekshiruvi olinganda `IDEMPOTENCY_CONFLICT` o'rniga replay qaytarib yiqildi).
- [x] **M1 (`0006 -> 0007` mavjud ma'lumot ustida upgrade)** — `packages/db-local/src/sale.test.ts` (`M1: upgrades a pre-populated 0006 DB...`):
  - Baza `0006` ga migratsiya qilinib, 2 ta ko'p qatorli haqiqiy T1.4 chek (`sales` 2, `sale_lines` 4, `payments` 2, `stock_moves`, `local_outbox`, `local_carts`, `last_receipt_seq = 2n`) yozildi, so'ng `0007` `PRAGMA foreign_keys = ON` ostida qo'llandi.
  - Hamma `sales`, `sale_lines`, `payments`, `stock_moves`, `local_outbox` qatorlari va qiymatlari saqlandi; `PRAGMA foreign_key_check = []`; `PRAGMA integrity_check = 'ok'`; `completed_by_user_id === cashier_user_id`, `request_hash === 'legacy:' + id`; qayta yaratilgan barcha `FACT`/`MONOTONE` triggerlar `UPDATE`/`DELETE` ni rad etadi; keyingi T1.5 cheki `receipt_no = 3n` (`last_receipt_seq + 1`) bilan davom etdi.
- [x] **M2 (Kassa qoldig'i terminal `device_id` bo'yicha)** — `cash_moves` umumiy `device_id` ustuni va `idx_cash_moves_terminal` indeksiga ega. `getCashDrawerBalanceSync` (`device_id` bo'yicha) va `getStoreCashBalanceSync` (do'kon bo'yicha) `sale.test.ts` da Device A (`76_000n`) vs Device B (`50_000n`) vs Store (`126_000n`) bilan tekshirildi.
- [x] **M3 (`debt > 0` va `customerId !== null` rad etilishi)** — `debtAmount > 0` → `CUSTOMER_REQUIRED` (`400`); `customerId !== null` (`debtAmount = 0` bo'lsa ham) → `VALIDATION_ERROR` (`400`) va 0 DB yozuvi (`packages/db-local/src/sale.test.ts` va `apps/hub/src/sale.test.ts`).
- [x] **M4 (Summalar chegarasi `MAX_MONEY_TIYIN = 9_223_372_036_854_775_807n`)** — `packages/contracts/src/sale.test.ts` va `apps/hub/src/sale.test.ts`: `tenderedAmount = '9223372036854775807'` HTTP `200` bilan o'tib 64-bit SQLite `changeAmount` va `cash_moves` ga sig'di; `'9223372036854775808'` (+1 tiyin) `tenderedAmount`, `amount` va `expectedTotal` da Zod darajasida HTTP `400 VALIDATION_ERROR` bilan rad etilib, 0 DB yozuvi qoldirdi.
- [x] **M5 (Invariant mutatsiya dalili va aniq xato kodi `400 VALIDATION_ERROR`)** — `sale-repo.ts` dan `validateSalePaymentsInvariant(...)` chaqiruvi vaqtincha olib tashlanganda: `db-local/src/sale.test.ts` da `3` ta test (`DomainError('VALIDATION_ERROR')` o'rniga `SqliteError: SQLITE_CONSTRAINT_CHECK`), `apps/hub/src/sale.test.ts` da `T1.5 HTTP E2E` (`400 VALIDATION_ERROR` o'rniga HTTP `500`) darhol yiqildi.
- [x] **Property testlar soni:** `@mezon/domain` `sale.test.ts` da `500` runs (`numRuns: 500`), `@mezon/db-local` `sale.test.ts` da `50` runs (`numRuns: 50`) haqiqiy SQLite UoW + `cash_moves` pariteti va invariant buzilishida 0 yozuv bilan.
- [x] **20 qatorli, 3 to'lovli savdo vaqti (≤ 300 ms):**
  - `@mezon/db-local` (`card + payme + cash`): **`median=41.36 ms`**, `samples=[53.78, 39.15, 42.92, 41.36, 38.50]`
  - `@mezon/hub` HTTP E2E (`card + uzqr + cash`): **`median=85.57 ms`**, `samples=[102.47, 82.04, 82.01, 85.57, 91.06]`

---

### Test va CI natijasi

1. **Lokal `pnpm run verify` (`51070e9` uchun, exit code `0`):**
   - `prettier --check .` — o'tdi
   - `turbo run build` — `17 successful, 17 total`
   - `node scripts/lint-workspaces.mjs` — `0` xato
   - `turbo run typecheck` — `22 successful, 22 total`
   - `turbo run db:check` — `19 successful, 19 total` (`PostgreSQL`: `0 diff`, `SQLite`: `0 diff` + triggerlar)
   - `vitest run` — `37 passed | 1 skipped (38)` fayl (`190 passed | 2 skipped (192)` test; `pg-rls.test.ts` mahalliy Docker bo'lmagani uchun skip, CI da `postgres-rls` da o'tgan)
   - `depcruise` — `0` qoidabuzarlik (`222 modules, 716 dependencies`)
2. **GitHub Actions CI (`51070e900f85b0e29bc9919c04ef5f4d5d99481e`, PR #12):**
   - `CI` (`pull_request`, run `42862752830`) va `CI` (`push`, run `42862741197`) — barcha **8/8** check-run `success`:
     - `Verify (ubuntu-latest)` — `success`
     - `Verify (windows-latest)` — `success`
     - `Verify PostgreSQL RLS (ubuntu-latest)` — `success`
     - `Build & E2E Desktop Installer (windows-latest)` — `success`

### Tekshirilmagan narsalar
- Real to'lov provayderlari (`Payme`, `Click`, `Uzum`, `UzQR` API), F3 PF-246 qoidalari (`packages/rules`), `customer_ledger` (T1.7), smena ochish/yopish (T1.9) — reja bo'yicha T1.5 doirasidan tashqarida.

### Qilingan taxminlar
- `customerId !== null` uchun T1.5 da `VALIDATION_ERROR` (`400`) tanlandi (`CUSTOMER_NOT_FOUND` o'rniga, chunki mijozlar reestri T1.7 da qo'shiladi); `debtAmount > 0` esa `CUSTOMER_REQUIRED` (`400`) qaytaradi.

### Takliflar
- T1.6 (bekor qilish va qaytarish) da naqd qaytarish `cash_moves` da `'refund_cash_out'` (manfiy `amount_delta`) bilan bir tranzaksiyada yozilsin va terminal naqd balansi (`getCashDrawerBalanceSync`) yetishmovchilik siyosati aniq belgilansin.

### Egasi yoki Claude qarori kerak bo'lgan savollar
- Yo'q.
