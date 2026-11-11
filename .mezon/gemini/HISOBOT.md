## Hisobot: T1.9

Branch / PR: `gemini/T1.9-shifts` / PR #16 (`https://github.com/Shaxobiddin-Github/Mezon/pull/16`)
Commitlar:
- `069736aa47d6b1a8e8bbffcfbcc38347d5049d87` — `T1.8 test qarzi: qaytarish chegaralari`
- `9ac15e709842df1e72c31724640a6fc5eae10b14` — `T1.9: Smena, kassa harakatlari, qayta yopish va kun yakuni`

*(Egasining vaqtinchalik CI qoidasi asosida PR merge qilinmadi va GitHub Actions CI kutilmadi; `packages/db-cloud` hamda `apps/desktop` ga tegilmadi.)*

### Nima qilindi

1. **T1.8 test qarzi (`069736a`):**
   - `packages/db-local/src/supplier.test.ts` ga `T1.8 test qarzi: enforces exact 1-milli return quantity and FIFO batch depletion boundaries` testi qo'shildi (`2.000 kg -> 1.500 -> 0.500 ok -> 0.001` va `0.501` -> `SUPPLIER_RETURN_QTY_EXCEEDED`; FIFO partiya `2.000 -> 0.700 sotildi -> 1.301` -> `SUPPLIER_RETURN_BATCH_DEPLETED` va `1.300` ok).
   - Mutatsiya dalillari (qo'lda sinovdan so'ng darhol tiklangan):
     - `supplier-repo.ts:2825` dagi `quantityToMilli(validQty) > maxRemainingMilli` ni `> maxRemainingMilli + 1n` ga o'zgartirganda `T1.8 test qarzi` testi `1824`-qatorda yiqildi (`SUPPLIER_RETURN_QTY_EXCEEDED` o'rniga `INVALID_UNIT_QUANTITY`).
     - `stock-repo.ts:1314` dagi `batchAvailMilli < retMilli` ni `batchAvailMilli + 1n < retMilli` ga o'zgartirganda `T1.8 test qarzi` testi `1902`-qatorda yiqildi (`SUPPLIER_RETURN_BATCH_DEPLETED` o'rniga `1.301 kg` qaytarish o'tib ketdi).

2. **`@mezon/domain` (`errors.ts`, `auth.ts`, `shift.ts`, `shift.test.ts`, `index.ts`):**
   - T1.9 xato kodlari (`SHIFT_NOT_FOUND`, `SHIFT_ALREADY_OPEN`, `SHIFT_NOT_OPEN`, `SHIFT_ALREADY_CLOSED`, `SHIFT_CLOSURE_NOT_FOUND`, `CASHIER_SESSION_MISMATCH`, `OPENING_DISCREPANCY_REASON_REQUIRED`, `SHIFT_DISCREPANCY_REASON_REQUIRED`, `EXPENSE_CATEGORY_REQUIRED`, `DAY_HAS_OPEN_SHIFTS`, `DAY_CLOSE_NOT_FOUND`, `INVALID_BUSINESS_DATE`) va RBAC ruxsatlari (`shifts:read`, `shifts:open`, `shifts:close`, `shifts:reclose`, `cash_moves:write`, `day_closes:write`, `shifts:configure`).
   - Sof biznes mantiq: X1 smena qoldig'i (`openingCash + cash_moves`), X2 kassir sessiyasi egaligi (`assertOpenShiftAccess` — faqat aktiv kassir yoki `owner`/`manager`), X3 sof `payments.amount` jamlanmasi va `cash_moves` quti ta'siri, X4 kun yakuni va `isStale`, kupyura sanog'i, kanonik SHA-256 request hash, hamda standart farq chegarasi `DEFAULT_MAX_CASH_DISCREPANCY_TIYIN = 1_000_000n` (10 000 so'm).

3. **`@mezon/contracts` (`shift.ts`, `sale.ts`, `return.ts`, `index.ts`):**
   - `z.strictObject` DTOlar (`OpenShiftRequestSchema`, `HandoffCashierRequestSchema`, `CloseShiftRequestSchema`, `RecloseShiftRequestSchema`, `CreateShiftCashMoveRequestSchema`, `CloseBusinessDayRequestSchema`, `UpdateShiftSettingsRequestSchema`). Yopish/almashish/qayta yopish sxemalarida qo'lda naqdsiz summa maydonlari yo'q — ortiqcha kalitlar `400 VALIDATION_ERROR` bilan rad etiladi.
   - `SaleSummaryDto`, `ReturnSummaryDto`, `CashMoveDto` larga `shiftCashierSessionId`, `shiftId`, `expenseCategory` maydonlari qo'shildi.

4. **`@mezon/db-local` (`0011_shifts_day_close.sql`, `shift-repo.ts`, `shift-migrations.ts`):**
   - Smena va kun yakuni jadvallari (`shifts`, `shift_cashier_sessions`, `shift_closures`, `shift_closure_method_totals`, `shift_closure_cashiers`, `day_closes`) hamda `local_hub_config.max_cash_discrepancy_without_override` (`1000000` default) va `local_device_state.last_shift_seq`.
   - `sales`, `returns`, `cash_moves` ga `shift_cashier_session_id`, `returns` ga `shift_id`, `v_sales_lines` ko'rinishiga `shift_id` va `shift_cashier_session_id` ustunlari qo'shildi.
   - SQL `SUM()` ning `int64` oraliq toshish (`SqliteError: integer overflow` `MAX_MONEY_TIYIN` bilan) muammosi oldini olish uchun `getActiveShiftDrawerBalanceSync`, `getActiveStoreCashBalanceSync`, `computeShiftSummaryViaSqlSync` va `handoffCashier` indeksli `.iterate(...)` + ixtiyoriy aniqlikdagi JS `bigint` akkumulyatsiyasiga o'tkazildi.
   - X1 bo'yicha `getActiveShiftDrawerBalanceSync` va `getActiveStoreCashBalanceSync` yagona haqiqat manbai qilib ulandi; eski tarixiy yig'indi funksiyalari `getHistoricalCashMovesTotalSync` va `getHistoricalStoreCashMovesTotalSync` deb qayta nomlandi.

5. **`apps/hub` (`shift-routes.ts`, `shift-service.ts`, `error-handler.ts`, mavjud servis/testlar):**
   - Marshrutlar: `GET /shifts/current`, `PATCH /shifts/settings`, `GET /shifts`, `POST /shifts/open`, `GET /shifts/:id`, `POST /shifts/:id/handoff`, `POST /shifts/:id/close`, `POST /shifts/:id/reclose`, `POST /shifts/:id/cash-moves`, `POST /day-closes`, `GET /day-closes`.
   - `completeSale`, `voidSale`, `createReturn`, `recordDebtPayment` va naqd `supplier` to'lovlari ochiq smenaga ulandi (`409 SHIFT_NOT_OPEN`, `409 CASHIER_SESSION_MISMATCH`); PIN blokirovkasi (5 xato urinish -> 6-urinish `429 AUTH_RATE_LIMITED`) va Pino nol-sir auditi sinovdan o'tdi.

### O'zgargan fayllar

- `GEMINI.md` — 4-bo'limga X5 bo'yicha yopiq smenaga sinxron `INSERT` qoidasi qo'shildi
- `packages/domain/src/{errors.ts,auth.ts,auth.test.ts,shift.ts,shift.test.ts,index.ts}` — T1.9 xato kodlari, ruxsatlar, sof smena/kassa/farq/kun-yakuni funksiyalari va 300-run `fast-check` property testi
- `packages/contracts/src/{shift.ts,shift.test.ts,sale.ts,sale.test.ts,return.ts,return.test.ts,index.ts}` — Qat'iy T1.9 Zod DTOlari
- `packages/db-local/drizzle/{0011_shifts_day_close.sql,meta/_journal.json,meta/0011_snapshot.json}` — `0011` SQLite migratsiyasi va Drizzle snapshot
- `packages/db-local/scripts/check-migrations.mjs`, `packages/db-local/src/schema/index.ts`, `packages/db-local/src/device-state.ts`, `packages/db-local/src/sale-migrations.ts`, `packages/db-local/src/shift-migrations.ts` — Sxema registri (`MONOTONE`/`FACT`/`LOCAL`), triggerlar, X5 izohlari, `v_sales_lines` va upgrade tekshiruvlari
- `packages/db-local/src/{shift-repo.ts,shift.test.ts,sale-repo.ts,return-repo.ts,customer-repo.ts,supplier-repo.ts,index.ts}` — `SqliteShiftStore`, X1–X4, V1 toraytirish, mavjud `sale/return/customer/supplier` testlari (`openShift` moslashuvi) va `packages/db-local/src/supplier.test.ts` (T1.8 test qarzi)
- `apps/hub/src/{shift-routes.ts,shift-service.ts,shift.test.ts,error-handler.ts,routes.ts,server.ts,index.ts,sale-service.ts,return-service.ts,customer-service.ts}` hamda `apps/hub/src/{sale,return,customer,supplier}.test.ts` — Hub HTTP marshrutlari, RBAC, xato xaritalash va E2E testlar

### Migratsiyalar

- `packages/db-local/drizzle/0011_shifts_day_close.sql`:
  - `shifts` (`MONOTONE`, `uidx_shifts_one_open_per_device`), `shift_cashier_sessions` (`MONOTONE`, `uidx_shift_sessions_one_active`), `shift_closures` (`FACT`), `shift_closure_method_totals` (`FACT`), `shift_closure_cashiers` (`FACT`), `day_closes` (`FACT`, F3 bo'sh maydonlari `fiscal_z_report_no`, `fiscal_submitted_at_ms`, `fiscal_status = 'not_fiscalized'`).
  - `local_hub_config.max_cash_discrepancy_without_override` (`DEFAULT 1000000`), `local_device_state.last_shift_seq`.
  - `returns.shift_id`, `(sales|returns|cash_moves).shift_cashier_session_id`, qayta qurilgan `v_sales_lines` (`shift_id`, `shift_cashier_session_id`), va yopiq smenaga `BEFORE INSERT` triggerlari (`X5` F2 sinxron izohlari bilan SQLda ham, `GEMINI.md` 4-bo'limda ham).
  - `pnpm --filter @mezon/db-local db:check` (va root `pnpm verify`): `SQLite schema matches committed migrations (0 diff statements).`
  - `packages/db-local/src/index.test.ts`: `cleanly upgrades a pre-populated 0010 database to 0011 preserving data, defaults & FKs`.

### Qabul mezonlari

- [x] **Smena ochish/yopish, ketma-ket `shift_no`, bir terminal = bir ochiq smena (`SHIFT_NOT_OPEN` / `SHIFT_ALREADY_OPEN`)** — `packages/db-local/src/shift.test.ts` (`enforces lifecycle guards...`, `enforces SQLite MONOTONE, FACT, X5 closed-shift INSERT guards...`) va `apps/hub/src/shift.test.ts`.
- [x] **Naqdsiz summa qo'lda kiritilmaydi** — `packages/contracts/src/shift.test.ts` (`STRICTLY rejects manual non-cash inputs in close, reclose, and handoff schemas (400)`) va `apps/hub/src/shift.test.ts` (`400` rad etilishi).
- [x] **Qayta yopish tarixni saqlaydi (`closureSeq = 1, 2, ...`, append-only `FACT`)** — `packages/db-local/src/shift.test.ts` (`enforces lifecycle guards, handoff discrepancy thresholds (10,000 UZS default + custom), append-only reclose FACT history, & opening float continuity`) va `FACT` trigger tekshiruvlari.
- [x] **Ikki kassir farqi ajraladi (`shift_cashier_sessions`)** — `packages/domain/src/shift.test.ts` (`property test (300 runs): D_shift === SUM(D_i) across arbitrary K handoffs, moves & counts`) hamda `db-local/src/shift.test.ts`.
- [x] **X1: Kassa qoldig'i uchun yagona haqiqat manbai (`openingCash + SUM(cash_moves WHERE shift_id)`)** — `packages/db-local/src/shift.test.ts` (`X1: enforces new shift openingCash (not historical cash_moves sum) as single source of truth across ALL outflow guards`) hamda `MAX_MONEY_TIYIN` regression testi (`handles 40_000n prior cash + MAX_MONEY_TIYIN cash tender & change without SQLite int64 SUM overflow`).
- [x] **X2: Kassir kesimi sessiya bo'yicha (`shift_cashier_session_id`) va `409 CASHIER_SESSION_MISMATCH`** — `packages/domain/src/shift.test.ts` (`X2 & X3 exact worked example...`), `packages/db-local/src/shift.test.ts` (`X2, X3, V1: attributes manager returns/voids to active cashier session, blocks wrong cashier 409 CASHIER_SESSION_MISMATCH...`) va `apps/hub/src/shift.test.ts`.
- [x] **X3: Naqd summasi ikki marta kamaytirilmaydi (`payments.amount` sof, quti faqat `cash_moves`)** — `packages/db-local/src/shift.test.ts` (`X2, X3, V1... never subtracts change twice`) hamda 240-qadamli model testi (qaytimli naqd savdolar bilan).
- [x] **X4: Kun yakuni (`DAY_HAS_OPEN_SHIFTS`, yopilish sanasi bo'yicha `businessDate`, `closeSeq` tarixi, qayta yopishda `isStale`)** — `packages/db-local/src/shift.test.ts` (`X4: assigns overnight shifts by closing date, blocks DAY_HAS_OPEN_SHIFTS, marks isStale on reclose, & preserves history`).
- [x] **X5: F2 sinxron izohlari** — `packages/db-local/drizzle/0011_shifts_day_close.sql:545-573`, `packages/db-local/src/shift-migrations.ts:55-64`, va `GEMINI.md` 4-bo'lim "Konfliktlar" ro'yxatiga yozildi.
- [x] **V1: Void faqat o'sha ochiq smena ichida (`409 SHIFT_ALREADY_CLOSED`)** — `packages/db-local/src/shift.test.ts`, `packages/db-local/src/return.test.ts`, va `apps/hub/src/return.test.ts`.
- [x] **Model testi (`240` qadam, 2 parallel terminal A & B)** — `packages/db-local/src/shift.test.ts` (`TOTAL_STEPS = 240`, almashishlar, qaytimli naqd/karta savdolar, void, qaytarish, kassa kirim/chiqim/inkassatsiya, yopish, qayta yopish va `day_closes` parity).
- [x] **1 000 chekli smenani yopish benchmarki (`<= 500 ms`)** — `[PERF T1.9 db-local] 1,000-receipt shift closeShift elapsed=34.01 ms` (`task-8117`, 1 000 savdo + 50 qaytarish + 1 050 kassa harakati).
- [x] **RBAC, 10 000 so'm (`1_000_000n`) standart supervisor chegarasi, PIN lockout (5 xato urinish -> 6-urinish `429`) va Pino nol-sir auditi** — `apps/hub/src/shift.test.ts` (`enforces full HTTP workflow, strict Zod (400 on manual non-cash), RBAC, X1-X4, V1, PIN lockout & zero-secret Pino audit`).

### Test natijasi

Oxirgi tahrirdan (`GEMINI.md` X5 izohi) keyingi to'liq lokal tekshiruv: `pnpm verify` (chiqish kodi `0`):
- `prettier --check .`: `All matched files use Prettier code style!`
- `turbo run build`: `Tasks: 17 successful, 17 total`
- `node scripts/lint-workspaces.mjs`: xato `0`, ogohlantirish `0`
- `turbo run typecheck`: `Tasks: 22 successful, 22 total`
- `turbo run db:check`: `PostgreSQL schema matches committed migrations (0 diff statements).` & `SQLite schema matches committed migrations (0 diff statements).` (`19 successful, 19 total`)
- `vitest run`: `Test Files  53 passed | 1 skipped (54)`, `Tests  267 passed | 2 skipped (269)`, `Duration  34.23s`
  - Asosiy natijalar: `packages/domain/src/shift.test.ts (4/4)`, `packages/contracts/src/shift.test.ts (4/4)`, `packages/db-local/src/shift.test.ts (8/8)`, `packages/db-local/src/index.test.ts (12/12)`, `packages/db-local/src/sale.test.ts (12/12)`, `packages/db-local/src/return.test.ts (9/9)`, `packages/db-local/src/customer.test.ts (7/7)`, `packages/db-local/src/supplier.test.ts (9/9)`, `apps/hub/src/shift.test.ts (1/1)`.
  - `[PERF T1.9 db-local] 1,000-receipt shift closeShift elapsed=34.01 ms`
  - Skipped: `packages/db-cloud/src/pg-rls.test.ts (2 tests | 2 skipped)` (PostgreSQL Testcontainers talab qiladi).
- `depcruise --config .dependency-cruiser.cjs apps/*/src packages/*/src`: `✔ no dependency violations found (279 modules, 1116 dependencies cruised)`

### Tekshirilmagan narsalar

- `packages/db-cloud/src/pg-rls.test.ts` (2 test — Testcontainers / Docker PostgreSQL muhiti bu lokal tekshiruvda yoqilmagan).
- GitHub Actions bulut CI (`pull_request` / `push` runnerlar egasi qoidasi bo'yicha limit tiklanguncha kutilmadi).

### Qilingan taxminlar

- `closeShift` dagi kassir sessiyasi `cashInTotal` (`shift_closure_cashiers.cash_in_total` 64-bit SQLite integer ustuni) umumiy summasi bir sessiya ichida `MAX_MONEY_TIYIN` (`9_223_372_036_854_775_807n` tiyin) dan oshmasligi taxmin qilindi; oraliq o'tish summalari (masalan `40_000 + MAX_MONEY_TIYIN - change`) esa JS `bigint` da hisoblanib `SqliteError: integer overflow` chiqarmaydi.
- `day_closes` kunlik jamlanmasiga kechadan o'tgan (overnight) smena X4 bo'yicha **yopilgan vaqtdagi (`closedAtMs` do'kon vaqt zonasida)** ish kuniga kiritildi (`TOPSHIRIQ.md` tavsiyasi bilan mos).

### Takliflar

- T1.11 / T1.12 bosqichida `GET /shifts/:id` va `POST /day-closes` javoblaridan Z-hisobot va X-hisobot printer shablonlarini bevosita olish mumkin (barcha usullar kesimi va kassir kesimlari snapshot'i tayyor).

### Egasi yoki Claude qarori kerak bo'lgan savollar

- Hozircha ochiq savol yo'q; Claude PR #16 va T1.9 bo'yicha `QABUL` qarorini kutaman (CI vaqtincha qoidasi sabab `QABUL` dan keyingi merge harakatini alohida ko'rsatmaga ko'ra bajaraman).
