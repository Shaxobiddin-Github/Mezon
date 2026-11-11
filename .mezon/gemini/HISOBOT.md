## Hisobot: T1.9 R1

Branch / PR: `gemini/T1.9-shifts` / PR #16 (`https://github.com/Shaxobiddin-Github/Mezon/pull/16`)
Commitlar:
- `069736aa47d6b1a8e8bbffcfbcc38347d5049d87` — `T1.8 test qarzi: qaytarish chegaralari`
- `9ac15e709842df1e72c31724640a6fc5eae10b14` — `T1.9: Smena, kassa harakatlari, qayta yopish va kun yakuni`
- `4542f69bc0b64315248b25e5b0cc9fdf5421f6ad` — `T1.9 R1: Kassir almashishdagi haqiqiy kassa (B1) va PERF loyihasi (B2)`

*(Yangi commit bilan tuzatildi, amend qilinmadi. Egasining vaqtinchalik CI qoidasi asosida merge qilinmadi va `packages/db-cloud` / `apps/desktop` ga tegilmadi.)*

### Nima qilindi

1. **B1 — Kassir almashgandan keyingi mavjud naqd pul (`X1` sessiya chegarasi):**
   - `packages/db-local/src/shift-repo.ts`:
     - `getActiveShiftDrawerBalanceSync` endi jismoniy kassa qoldig'ini **aktiv sessiyaning `openingFloat` i + shu sessiyadagi `cash_moves` yig'indisi** (`shift_cashier_session_id = activeSession.id` yoki `sessionSeq = 1 AND shift_cashier_session_id IS NULL`) bo'yicha hisoblaydi (`openingCash: ctx.activeSession.openingFloat`). Shunda barcha chiqim tekshiruvlari (qaytarish, void, ta'minotchiga naqd to'lov, xarajat, inkassatsiya), `getCurrentShift().drawerCashBalance` va `getTerminalCashBalance()` oldingi sessiya kamomadidan oshiqcha pul sarflanishiga yo'l qo'ymaydi.
     - `getActiveStoreCashBalanceSync` do'kondagi har bir ochiq smena terminali uchun `getActiveShiftDrawerBalanceSync` ni chaqirib jamlaydi (kod takrorlanishisiz yagona haqiqat manbai).
   - `packages/domain/src/shift.ts` va `packages/db-local/src/shift-repo.ts` izohlarida ikki tushuncha munosabati hujjatlashtirildi:
     - joriy sarflanadigan quti qoldig'i = `activeSession.openingFloat + SUM(activeSession cash_moves)`;
     - smena yopilishi `expectedCash` = `O_shift + SUM(barcha smena cash_moves)`, natijada `D_shift = C_final - (O_shift + SUM(M_i)) = SUM(D_i)` saqlanadi.
   - `packages/db-local/src/shift.test.ts` va `apps/hub/src/shift.test.ts`:
     - `240` qadamli 2-terminalli model testida `verifyTerminalDrawer` (`shift.test.ts:1048`) va void/return/cash-move quti tekshiruvlari (`1215`, `1245`, `1276`) `activeSess.openingFloat + activeSess.cashDelta` ga moslandi.
     - Maxsus B1 testi (`B1 (X1 session physical cash)...`) va HTTP E2E B1 tekshiruvi (`GET /shifts/current`, `POST /shifts/:id/cash-moves`) qo'shildi.
   - **B1 mutatsiya dalili:** `getActiveShiftDrawerBalanceSync` vaqtincha eski formulaga (`ctx.shift.openingCash` va `shift_id` bo'yicha barcha `cash_moves`) qaytarilib `pnpm exec vitest run packages/db-local/src/shift.test.ts` ishga tushirilganda 2 ta test yiqildi (so'ng tiklandi):
     - `model test (>= 240 steps across 2 parallel terminals A & B)...`: `AssertionError: expected 133000n to be 131000n` (`packages/db-local/src/shift.test.ts:1050`)
     - `B1 (X1 session physical cash)...`: `AssertionError: expected 8573n to be 8473n` (`packages/db-local/src/shift.test.ts:1725`)

2. **B2 — Unumdorlik testlarini alohida ketma-ket `perf` Vitest loyihasiga ajratish:**
   - `vitest.config.ts` da 3 ta loyiha tuzildi:
     - `unit` (`groupOrder: 0`): `**/*.perf.test.ts`, `packages/db-local/**`, `apps/hub/**` chiqarib tashlangan;
     - `sqlite-hub` (`groupOrder: 0`): `packages/db-local/**/*.test.ts`, `apps/hub/**/*.test.ts` (`**/*.perf.test.ts` chiqarib tashlangan);
     - `perf` (`groupOrder: 1`): `['packages/**/*.perf.test.ts', 'apps/**/*.perf.test.ts']`, **`fileParallelism: false`**, **`maxWorkers: 1`**, `testTimeout: 60_000`.
   - `package.json`: `"test:unit": "vitest run --project unit --project sqlite-hub"`, `"test:perf": "vitest run --project perf"`, `"test": "pnpm run test:unit && pnpm run test:perf"`.
   - Barcha 10 ta `PERF` testi 7 ta alohida `*.perf.test.ts` faylga ko'chirildi (barcha chegaralar `<= 20 ms`, `<= 50 ms`, `<= 100 ms`, `<= 300 ms`, `<= 500 ms` o'zgarishsiz qoldi).

### O'zgargan fayllar

- `packages/domain/src/shift.ts` — B1 quti qoldig'i va `D_shift = SUM(D_i)` munosabati hujjatlashtirildi
- `packages/db-local/src/shift-repo.ts` — `getActiveShiftDrawerBalanceSync` (`activeSession.openingFloat` + aktiv sessiya `cash_moves`) va `getActiveStoreCashBalanceSync` tuzatildi
- `packages/db-local/src/shift.test.ts` — Model testi `openingFloat + cashDelta` ga o'tkazildi, B1 to'liq testi (`8 573 -> 8 473`, `8 474` rad etish, `8 473` o'tishi, `D_1 + D_2 = D_shift`) qo'shildi, 1 000 chekli PERF testi ajratildi
- `apps/hub/src/shift.test.ts` — HTTP E2E B1 tekshiruvi (`GET /shifts/current` `'8473'`, `'8474'` -> `409 INSUFFICIENT_CASH_IN_DRAWER`, `'8473'` -> `201`) qo'shildi
- `vitest.config.ts` va `package.json` — `perf` loyihasi (`fileParallelism: false`, `maxWorkers: 1`, `groupOrder: 1`) va `test:unit && test:perf` zanjiri
- `packages/db-local/src/{catalog,sale,return,customer,supplier,shift}.perf.test.ts` hamda `apps/hub/src/sale.perf.test.ts` — Ajratilgan 10 ta ketma-ket PERF benchmark testi
- `packages/db-local/src/{catalog,sale,return,customer,supplier}.test.ts` hamda `apps/hub/src/sale.test.ts` — Ko'chirilgan PERF bloklari va ortiqcha importlar tozalandi

### Migratsiyalar

R1 bosqichida yangi migratsiya qo'shilmadi (`0011_shifts_day_close.sql` o'zgarishsiz qoldi, `db:check` 0 diff).

### Qabul mezonlari (R1)

- [x] **B1.1–B1.3: Almashishda −100 kamomad → B sessiyasida `drawerCashBalance` = `8 473` + B harakatlari; `8 474` qaytarish va inkassatsiya `INSUFFICIENT_CASH_IN_DRAWER`, `8 473` o'tadi; `D_shift = SUM(D_i)`** — `packages/db-local/src/shift.test.ts` (`B1 (X1 session physical cash)...`, `-100n + 25n = -75n`), model testi (`240` qadam), hamda `apps/hub/src/shift.test.ts` HTTP E2E.
- [x] **B1.4: Mutatsiya dalili** — Eski formula qaytarilganda `model test` (`133000n !== 131000n`) va `B1` (`8573n !== 8473n`) yiqildi.
- [x] **B2: Barcha `PERF` testlari alohida `perf` loyihasida (`fileParallelism: false`), `pnpm verify` oxirida yolg'iz ketma-ket ishlaydi, chegaralar o'zgarmagan** — `vitest.config.ts`, `package.json` hamda `task-8335` chiqishi (`7 passed (7)`, `10 passed (10)`, `catalog` FTS p95 = `25.613ms <= 50ms`, `supplier` 100-line = `232.52ms <= 500ms`, `shift` 1,000-receipt = `22.91ms <= 500ms`).

### Test natijasi

Buyruq: `pnpm verify` (`task-8335`, chiqish kodi `0`):
- `prettier --check .`: `All matched files use Prettier code style!`
- `turbo run build`: `Tasks: 17 successful, 17 total`
- `node scripts/lint-workspaces.mjs`: `0` xato
- `turbo run typecheck`: `Tasks: 22 successful, 22 total`
- `turbo run db:check`: `PostgreSQL schema matches committed migrations (0 diff statements).` & `SQLite schema matches committed migrations (0 diff statements).`
- `pnpm run test:unit` (`vitest run --project unit --project sqlite-hub`): `Test Files  53 passed | 1 skipped (54)`, `Tests  258 passed | 2 skipped (260)`, `Duration  23.46s` (`packages/db-cloud/src/pg-rls.test.ts` skipped)
- `pnpm run test:perf` (`vitest run --project perf`, `fileParallelism: false`, `maxWorkers: 1`): `Test Files  7 passed (7)`, `Tests  10 passed (10)`, `Duration  48.25s`:
  - `T1.1 Catalog 50k/70k WAL`: `scan p95=0.747ms <= 20ms | search p95=25.613ms <= 50ms`
  - `T1.4 db-local 20-line`: `69.15 ms <= 300ms`
  - `T1.5 db-local 20-line 3-pay`: `median=93.94 ms <= 300ms`
  - `T1.6 db-local 20-line return`: `median=45.15 ms <= 300ms`
  - `T1.7 D4 5k`: `getCustomerDetail=9.18 ms | createReturn=29.45 ms` (`<= 100ms`)
  - `T1.7 10k/100k`: `ftsMs=1.66 | phoneMs=5.33 | balanceMs=0.75 | overdueMs=24.61` (`<= 100ms`)
  - `T1.8 100-line receiving`: `232.52 ms <= 500ms`
  - `T1.9 1,000-receipt closeShift`: `22.91 ms <= 500ms`
  - `T1.4 HTTP E2E 20-line`: `129.59 ms <= 300ms`
  - `T1.5 HTTP E2E 20-line 3-pay`: `median=38.57 ms <= 300ms`
- `depcruise --config .dependency-cruiser.cjs apps/*/src packages/*/src`: `✔ no dependency violations found (286 modules, 1169 dependencies cruised)`

### Tekshirilmagan narsalar

- `packages/db-cloud/src/pg-rls.test.ts` (2 test skipped — PostgreSQL Testcontainers lokal Docker muhiti yoqilmagan).
- GitHub Actions CI (egasining vaqtinchalik qoidasi bo'yicha kutilmadi).

### Qilingan taxminlar

- R1 ga oid qo'shimcha taxmin yo'q (avvalgi `HISOBOT.md` dagi `MAX_MONEY_TIYIN` va `businessDate` taxminlari o'z kuchida).

### Takliflar

- Yo'q.

### Egasi yoki Claude qarori kerak bo'lgan savollar

- Claude PR #16 (`4542f69` va `HISOBOT` commit) bo'yicha yakuniy qarorini kutaman.
