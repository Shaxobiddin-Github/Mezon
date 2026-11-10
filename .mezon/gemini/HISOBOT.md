## Hisobot: T1.5 (R1 — B1 va B2 tuzatildi)

Branch / PR: `gemini/T1.5-payments` / https://github.com/Shaxobiddin-Github/Mezon/pull/12
Commitlar:
- `adf9e670d08028a134021394a4a244eb6357cefc` — `T1.4 test qarzi: zaxira chegarasi, idempotentlik do'koni`
- `9f218d94b0e92a8f7af5b2bff10a8eb720dc02ab` — `T1.5: Aralash to'lovlar, qaytim, cash_moves va M1-M5 himoyalar`
- `51070e900f85b0e29bc9919c04ef5f4d5d99481e` — `T1.5: 20 qatorli 3-to'lovli perf testini 5 namunali medianga o'tkazish`
- `b3a940ddb2a6080abec62c2a51661a19bdd49139` — `T1.5 R1: B1 stock pool batch prefetch (6 maydon) va B2 test qarzi`

*(Oldingi T1.4 PR #11 `main` ga `740ab2a895a85f83a8c8695baee363f05e45f269` SHA bilan Squash & Merge qilindi va `gemini/T1.4-complete-sale` lokal/remote branch'lari o'chirildi.)*

---

### R1 tuzatishlari (`b3a940d`)

1. **B1. `completeSale` ombor pool prefetch'ini yagona yuklovchiga birlashtirish:**
   - `packages/db-local/src/stock-repo.ts`: yagona `applyPoolBalanceRowToState` (barcha 6 maydonni ko'chiradi: `qtyOnHand`, `totalValue`, `deficitQty`, `provisionalDeficitValue`, `costVarianceValue`, `lastUnitCost`) hamda eksport qilingan batch yuklovchi `prefetchMutablePoolStatesSync` (`stockPoolKey`, `StockPoolPrefetchTarget`) qo'shildi. Endi `loadMutablePoolStateSync` va `prefetchMutablePoolStatesSync` aynan bir xil `applyPoolBalanceRowToState` dan foydalanadi — qo'lda maydon nusxalash yo'q.
   - `packages/db-local/src/sale-repo.ts`: qo'lda `localStockBalances` / `localBatchBalances` nusxalash butunlay olib tashlandi; `completeSale` to'g'ridan-to'g'ri `prefetchMutablePoolStatesSync(...)` va `stockPoolKey(...)` ni chaqiradi.
   - **Differensial regressiya testi (`packages/db-local/src/sale.test.ts` — `B1 regression`):**
     - Ikkita o'rtacha tannarxli (`avgSale` vs `avgDirect`, dastlabki `3.000` kg / `5121` tiyin = `1707n` tiyin/kg) va ikkita FIFO partiyali (`fifoSale` vs `fifoDirect`) tovar bilan `'warn'` rejimida **36 ta seed'li qadam** (normal sotuv, kamomadga tushish, kamomad ichida ketma-ket sotuvlar, har xil narxda qisman/to'liq qayta kirim).
     - Har bir qadamda `local_stock_balances` ning barcha 6 maydoni (`qtyOnHand`, `totalValue`, `deficitQty`, `provisionalDeficitValue`, `costVarianceValue`, `lastUnitCost`), har qadamdagi `sale_lines.costValue === -SUM(stock_moves.costValueDelta)`, jami chiqim `costValueDelta`, hamda FIFO `local_batch_balances` (`remainingQty`, `remainingValue`) ikkala yo'lda ham to'liq teng.
     - Oxirida `env.stockStore.rebuildProjections()` chaqirilib, qayta qurilgan barcha 4 tovar balansi va partiyalar jonli jadvallar bilan aynan teng ekani tasdiqlandi.
   - **B1 ikki mutatsiya dalili:**
     - **1-mutatsiya (`lastUnitCost`):** `applyPoolBalanceRowToState` dan `state.lastUnitCost = row.lastUnitCost` olib tashlanganda `B1 regression` darhol yiqildi (`avgDirect`/`avgSale` da `lastUnitCost`: kutilgan `null` o'rniga `1805n`; `fifoDirect`/`fifoSale` da `null` o'rniga `3776n`).
     - **2-mutatsiya (`deficitQty`):** `applyPoolBalanceRowToState` dan `state.deficitQty = row.deficitQty` olib tashlanganda `B1 regression` darhol yiqildi (`avg` da `costVarianceValue`: `0n` vs `-30335n`, `provisionalDeficitValue`: `30540n` vs `0n`; `fifo` da `deficitQty`: `0n` vs `7662n`, `totalValue`: `46523n` vs `37816n`, partiyalar farqli).

2. **B2. Test qarzi (`packages/domain/src/sale.test.ts`):**
   - `validateSalePaymentsInvariant` ga to'g'ridan-to'g'ri `{ method: 'card', amount: 100_000n, tenderedAmount: 100_000n, changeAmount: 0n }` berilganda `VALIDATION_ERROR` tashlashini tekshiruvchi unit test qo'shildi.
   - **Mutatsiya dalili:** `validateSalePaymentsInvariant` dan `if (p.tenderedAmount !== null)` tekshiruvi olib tashlanganda aynan shu test (`sale.test.ts:295`) yiqildi.

---

### Nima qilindi (T1.5 jami)

1. **T1.4 test qarzi (`adf9e67`, mutatsiya dalillari bilan):** `block` rejimida aniq `5.000` / `5.001` (`3.000 + 2.001`) chegara va boshqa `store_id` bilan `IDEMPOTENCY_CONFLICT`.
2. **Domen (`@mezon/domain`):** `CUSTOMER_REQUIRED`, `MAX_MONEY_TIYIN = 9_223_372_036_854_775_807n`, `CASH_MOVE_TYPES`, `resolveSalePayments`, `validateSalePaymentsInvariant`, `canonicalizeCompleteSaleRequest`, 500 ta `fast-check` property test va B2 unit testi.
3. **Kontraktlar (`@mezon/contracts`):** T1.4 bilan mos kengaytirilgan aralash to'lovlar, M4 `MAX_MONEY_TIYIN` chegarasi, `completedByUserId`, `CashMoveDtoSchema`.
4. **Lokal baza (`@mezon/db-local`) va `0007_payments_cash_moves.sql`:**
   - `sales` (`completed_by_user_id`, `request_hash`, triggerlar tiklangan), `payments` (`amount > 0` va non-cash CHECK), `cash_moves` (`FACT`, terminal indeksi `idx_cash_moves_terminal`), `getCashDrawerBalanceSync` (terminal `device_id`) va `getStoreCashBalanceSync`.
   - `prefetchMutablePoolStatesSync` orqali yagona 6 maydonli pool yuklash (`stock-repo.ts`), B1 36 qadamli differensial test + `rebuildProjections()`, M1 (`0006 -> 0007` haqiqiy cheklar upgrade), M2–M5 va 50 ta DB fuzz testi.
5. **Hub API (`apps/hub`):** `POST /carts/:id/complete` aralash to'lovlar, `CUSTOMER_REQUIRED: 400`, M3/M4/M5 E2E testlar, `completedByUserId` audit logi (nol tannarx/foyda).

### O'zgargan fayllar (R1 da yangilanganlar bilan)
- `.dependency-cruiser.cjs`
- `packages/domain/src/errors.ts`, `money.ts`, `sale.ts`, `index.ts`, `sale.test.ts`
- `packages/contracts/src/sale.ts`, `index.ts`, `sale.test.ts`
- `packages/db-local/src/schema/index.ts`, `drizzle/0007_payments_cash_moves.sql`, `drizzle/meta/_journal.json`, `drizzle/meta/0007_snapshot.json`, `src/sale-migrations.ts`, `src/stock-repo.ts`, `src/sale-repo.ts`, `src/index.ts`, `src/index.test.ts`, `src/sale.test.ts`
- `apps/hub/src/error-handler.ts`, `sale-service.ts`, `cart-routes.ts`, `sale.test.ts`

### Migratsiyalar
- `packages/db-local/drizzle/0007_payments_cash_moves.sql` (`meta/0007_snapshot.json`): `sales`, `payments`, `cash_moves` (`FACT`) va barcha `FACT`/`MONOTONE` triggerlari (`db:check` `0 diff`).

---

### Qabul mezonlari va M1–M5 / B1–B2 dalillari

- [x] **T1.4 test qarzi (`adf9e67`)** — mutatsiyalar bilan isbotlangan.
- [x] **B1 (`stock-repo.ts` yagona loader + differensial test)** — 36 qadam (`avg` + `fifo`, `'warn'`, kamomad + qayta kirim) va `rebuildProjections()` pariteti o'tdi; `lastUnitCost` va `deficitQty` mutatsiyalarining har biri alohida testni yiqitdi.
- [x] **B2 (`validateSalePaymentsInvariant` non-cash `tenderedAmount !== null`)** — domain unit testi qo'shildi, mutatsiya bilan yiqitildi.
- [x] **M1 (`0006 -> 0007`)** — 2 haqiqiy chek, `foreign_key_check = []`, `integrity_check = 'ok'`, triggerlar faol, `receipt_no = 3n`.
- [x] **M2 (`cash_moves` `device_id` + `getCashDrawerBalanceSync`)** — Device A (`76_000n`), Device B (`50_000n`), Store (`126_000n`).
- [x] **M3 (`debt > 0` → `CUSTOMER_REQUIRED`, `customerId !== null` → `VALIDATION_ERROR`)** — 0 DB yozuvi.
- [x] **M4 (`MAX_MONEY_TIYIN = 9_223_372_036_854_775_807n`)** — max o'tadi (`200`), `+1` (`...808`) Zod darajasida `400 VALIDATION_ERROR` (0 DB yozuvi).
- [x] **M5 (`validateSalePaymentsInvariant` mutatsiyasi)** — `db-local` da `SQLITE_CONSTRAINT_CHECK`, Hub da `500` vs kutilgan `400 VALIDATION_ERROR` bilan ushlandi.
- [x] **Property testlar soni:** `@mezon/domain` `500` runs, `@mezon/db-local` `50` runs.
- [x] **20 qatorli, 3 to'lovli savdo vaqti (≤ 300 ms):**
  - `@mezon/db-local` (`card + payme + cash`): **`median=38.99 ms`**, `samples=[40.99, 34.69, 33.70, 38.99, 39.96]`
  - `@mezon/hub` HTTP E2E (`card + uzqr + cash`): **`median=89.71 ms`**, `samples=[89.71, 99.28, 97.06, 79.50, 84.42]`

---

### Test va CI natijasi

1. **Lokal `pnpm run verify` (`b3a940d` uchun, exit code `0`):**
   - `prettier --check .` — o'tdi
   - `turbo run build` — `17 successful, 17 total`
   - `node scripts/lint-workspaces.mjs` — `0` xato
   - `turbo run typecheck` — `22 successful, 22 total`
   - `turbo run db:check` — `19 successful, 19 total` (`0 diff`)
   - `vitest run` — `37 passed | 1 skipped (38)` fayl (`191 passed | 2 skipped (193)` test; `pg-rls.test.ts` mahalliy Docker yo'qligi uchun skip, CI da `postgres-rls` da o'tgan)
   - `depcruise` — `0` qoidabuzarlik (`222 modules, 716 dependencies`)
2. **GitHub Actions CI (`b3a940ddb2a6080abec62c2a51661a19bdd49139`, PR #12):**
   - `CI` (`pull_request`, run `42865931904`) va `CI` (`push`, run `42865924043`) — barcha **8/8** check-run `success`:
     - `Verify (ubuntu-latest)` — `success`
     - `Verify (windows-latest)` — `success`
     - `Verify PostgreSQL RLS (ubuntu-latest)` — `success`
     - `Build & E2E Desktop Installer (windows-latest)` — `success`

### Tekshirilmagan narsalar
- Real to'lov provayderlari (`Payme`, `Click`, `Uzum`, `UzQR` API), F3 PF-246 qoidalari (`packages/rules`), `customer_ledger` (T1.7), smena ochish/yopish (T1.9) — reja bo'yicha T1.5 doirasidan tashqarida.

### Qilingan taxminlar
- `customerId !== null` uchun T1.5 da `VALIDATION_ERROR` (`400`) tanlandi (`debtAmount > 0` → `CUSTOMER_REQUIRED`).

### Takliflar
- T1.6 da naqd qaytarish `cash_moves` da `'refund_cash_out'` (manfiy `amount_delta`) bilan bir tranzaksiyada yozilsin.

### Egasi yoki Claude qarori kerak bo'lgan savollar
- Yo'q.
