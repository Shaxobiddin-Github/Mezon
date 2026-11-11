## Hisobot: T1.10

Branch / PR: `gemini/T1.10-orders-advance` / [PR #17](https://github.com/Shaxobiddin-Github/Mezon/pull/17)
Commitlar:

- `ea05627`: `T1.9 test qarzi: yopiq smenani qayta yopish`
- `9152a74` (`9152a74fc480bbafb0759c0183c68f436f0f774f`): `T1.10: Buyurtma va avans — O1..O4 va model testi`

---

### Nima qilindi

1. **1-commit — T1.9 test qarzi (`ea05627`):**
   - `packages/db-local/src/shift.test.ts` va `apps/hub/src/shift.test.ts` ga yopiq smenaga yangi `clientRequestId` bilan `closeShift` / `POST /shifts/:id/close` chaqirilganda **`409 SHIFT_ALREADY_CLOSED`** qaytishi, `shift_closures`, `shift_cashier_sessions`, `local_outbox` qatorlari o'zgarmasligi (`0` yozuv) hamda xuddi shu yopiq smenaga `recloseShift` (`closureSeq = 2`) ishlashi testlari qo'shildi.
   - Mutatsiya isboti: `shift-repo.ts` (`closeShift`) dagi `if (shiftRow.status !== 'open')` tekshiruvi vaqtincha olib tashlanganda har ikki test yiqilishi tasdiqlandi va qayta tiklandi.

2. **Majburiy tuzatishlar (`O1–O4`):**
   - **O1 (Buyurtma chekida `voidSale` taqiqlanadi):**
     - `sales.source_order_id IS NOT NULL` bo'lgan har qanday topshirilgan buyurtma chekida `voidSale` / `POST /sales/:id/void` **`409 ORDER_SALE_USE_RETURN`** bilan rad etiladi (`packages/db-local/src/return-repo.ts`).
     - Bunday chek faqat `createReturn` (`POST /sales/:id/returns`) orqali qaytariladi: chekdagi `'advance'` to'lov qatori buyurtmaning haqiqiy sof `order_payments` usullariga (`cash`, `card`, `uzqr`, `payme`, ...) yoyilib (`resolveOrderReturnEffectivePaidByMethod`), har usul bo'yicha real qaytarish shifti (`originalPaidByMethod`) hisoblanadi.
     - **Mutatsiya dalili:** `return-repo.ts` dagi `if (saleRow.sourceOrderId !== null)` tekshiruvi vaqtincha olib tashlanganda `packages/db-local/src/order.test.ts` dagi 2 ta test (integratsion test + 225-qadam model testi) va `apps/hub/src/order.test.ts` dagi HTTP E2E test darhol yiqildi (`200` qaytib ketdi); tekshiruv tiklangach barcha testlar o'tdi.
   - **O2 (`deliverOrder` vaqtida qayta hisoblash yo'q):**
     - `deliverOrder` `evaluateCart` ni qayta chaqirmaydi va katalog narxini yoki aksiyalarni qayta o'qimaydi — `orders` va `order_lines` da buyurtma yaratilganda qotirilgan snapshot (`unitPriceSnapshot`, `promoDiscount`, `allocatedOrderDiscount`, `finalTotal`, `totalAmount`, `vatTotal`, `netExVat`) to'g'ridan-to'g'ri umumiy **`completeSaleCoreInTxSync`** yadrosiga uzatiladi (`totalFinal === order.totalAmount`).
     - `ORDER_EXCESS_ADVANCE` himoyaviy tekshiruv sifatida `buildDeliverySalePayments` ichida saqlab qolindi.
     - Test: buyurtma yaratilgandan keyin katalog narxi oshirilsa (`100 000 -> 180 000 UZS`) va aksiya o'chirilsa ham, `deliverOrder` chekni aynan buyurtmaning qotirilgan summasida (`totalFinal === order.totalAmount`) yakunlaydi.
   - **O3 (Buyurtmada chegirma va aksiya — bir marta yaratishda):**
     - `evaluateOrderDraft` (`packages/domain/src/order.ts`) T1.3 `evaluateCart` ni qayta ishlatib, buyurtma yaratilishida avtomatik aksiyalar (`percent`, `fixed_amount`, `buy_x_get_y`), qo'lda chegirma (`none | percent | amount`), kassir limiti va supervisor PIN tasdig'ini (`DISCOUNT_OVERRIDE_REQUIRED`) bir marta hisoblaydi hamda `orders` va `order_lines` da o'zgarmas qilib qotiradi (`'catalog'` va `'quick_sale'` qatorlari bilan).
   - **O4 (Ochiq avanslar ko'rinishi):**
     - `getOpenAdvancesTotal()` (`GET /orders/open-advances`) ochiq buyurtmalar (`status IN ('draft', 'confirmed', 'ready')`) bo'yicha mijozlardan olingan va hali savdoga aylanmagan yoki qaytarilmagan sof avans qoldig'ini usullar kesimida (`byMethod`) va jami (`totalOpenAdvance`, `openOrdersCount`) qaytaradi.
     - 225 qadamli 2-terminal / ko'p smena / ko'p kunlik model testida har qadamda `totalOpenAdvance === totalAdvanceIn - totalAdvanceRefund - totalAdvanceAppliedAtDelivery` tengligi tiyinigacha tekshirildi.

3. **Yagona `completeSale` yo'li (`GEMINI.md 3.1.9–3.1.10`) va kassa/tushum hisobi:**
   - `packages/db-local/src/sale-repo.ts` da umumiy **`completeSaleCoreInTxSync`** ajratildi: oddiy POS savat yakunlash (`completeSale`) ham, buyurtmani topshirish (`deliverOrder`) ham aynan shu yagona funksiyadan o'tadi.
   - `method === 'advance'` uchun `payments` jadvalida qator yoziladi, ammo `cash_moves` yozilmaydi (pul avans olinganda `advance_cash_in` / `advance_change_out` bilan kassaga kirgan).
   - Avans olingan smenada savdo tushumi `0` (`grossSalesTotal = 0`, `v_sales_lines` ga kirmaydi), `shift_closures` da esa `orderAdvanceCashTotal`, `orderAdvanceNonCashTotal`, `orderAdvanceRefundTotal` aks etadi; tushum faqat topshirilganda (`deliverOrder`) bir marta `sales` va `v_sales_lines` ga tushadi.

---

### O'zgargan fayllar (fayl — sabab)

- `packages/domain/src/errors.ts` — `ORDER_NOT_FOUND`, `ORDER_EMPTY`, `ORDER_INVALID_TRANSITION`, `ORDER_ADVANCE_EXCEEDS_TOTAL`, `ORDER_ADVANCE_REFUND_EXCEEDED`, `ORDER_EXCESS_ADVANCE`, `ORDER_SALE_USE_RETURN`, `ORDER_TOTAL_CHANGED` xato kodlari.
- `packages/domain/src/auth.ts`, `packages/domain/src/auth.test.ts` — `'orders:read' | 'orders:write' | 'orders:cancel'` ruxsatlari (`cashier` da `orders:cancel` yo'q).
- `packages/domain/src/sale.ts`, `packages/domain/src/sale.test.ts` — `SALE_PAYMENT_METHODS` (`'advance'`), `advance_cash_in`, `advance_change_out`, `advance_refund_out`, `allowAdvancePayment` parametri (`PAYMENT_METHODS` faqat haqiqiy tenderlar uchun o'zgarishsiz qoldi).
- `packages/domain/src/shift.ts`, `packages/domain/src/shift.test.ts` — smena hisobotida `orderAdvanceCashTotal`, `orderAdvanceNonCashTotal`, `orderAdvanceRefundTotal` va `methodTotals` da `'advance'`.
- `packages/domain/src/order.ts`, `packages/domain/src/order.test.ts`, `packages/domain/src/index.ts` — buyurtma holat o'tishlari, `evaluateOrderDraft` (O3), avans olish/qaytarish/bekor qilish, `buildDeliverySalePayments` (O2), `resolveOrderReturnEffectivePaidByMethod` (O1), `computeOpenAdvancesAccounting` (O4), idempotentlik xesh funksiyalari va 300-run `fast-check` property testlari.
- `packages/contracts/src/order.ts`, `packages/contracts/src/order.test.ts`, `packages/contracts/src/sale.ts`, `packages/contracts/src/sale.test.ts`, `packages/contracts/src/return.ts`, `packages/contracts/src/shift.ts`, `packages/contracts/src/index.ts` — T1.10 Zod (`z.strictObject`) kontraktlari, `SaleDto.sourceOrderId`, `VoidedSaleDto.sourceOrderId`, `ShiftClosureDto` avans maydonlari, tannarx yashirilishi testlari.
- `packages/db-local/src/schema/index.ts`, `packages/db-local/drizzle/0012_orders_advance.sql`, `packages/db-local/drizzle/meta/_journal.json`, `packages/db-local/drizzle/meta/0012_snapshot.json`, `packages/db-local/src/order-migrations.ts`, `packages/db-local/src/sale-migrations.ts`, `packages/db-local/src/device-state.ts`, `packages/db-local/scripts/check-migrations.mjs` — `orders` (`MONOTONE`, `origin_device_id`), `order_lines` (`FACT`), `order_payments` (`FACT`), `sales.source_order_id`, `last_order_seq`, `0012` SQLite migratsiyasi va triggerlar.
- `packages/db-local/src/sale-repo.ts`, `packages/db-local/src/return-repo.ts`, `packages/db-local/src/shift-repo.ts`, `packages/db-local/src/cart-repo.ts`, `packages/db-local/src/order-repo.ts`, `packages/db-local/src/index.ts` — `completeSaleCoreInTxSync`, `O1` `voidSale` blokirovkasi va `createReturn` da `'advance'` yoyilishi, `SqliteOrderStore`, smena/kun yakunida avans hisobi.
- `packages/db-local/src/index.test.ts`, `packages/db-local/src/order.test.ts`, `packages/db-local/src/order.perf.test.ts` — `0011 -> 0012` migratsiya testi, O1–O4, SQLite triggerlar, 225-qadam 2-terminal model testi va 20-qatorli `deliverOrder` WAL unumdorlik testi.
- `apps/hub/src/error-handler.ts`, `apps/hub/src/sale-service.ts`, `apps/hub/src/return-service.ts`, `apps/hub/src/shift-service.ts`, `apps/hub/src/order-service.ts`, `apps/hub/src/order-routes.ts`, `apps/hub/src/routes.ts`, `apps/hub/src/server.ts`, `apps/hub/src/index.ts`, `apps/hub/src/order.test.ts`, `apps/hub/src/order.perf.test.ts` — Hub HTTP endpointlari (`/orders`, `/orders/open-advances`, `/orders/:id/*`), RBAC + supervisor PIN lockout, PII-siz Pino audit loglari, HTTP E2E va unumdorlik testlari.

---

### Migratsiyalar

- `packages/db-local/drizzle/0012_orders_advance.sql`:
  - Yangi jadvallar: `orders` (`MONOTONE`), `order_lines` (`FACT`), `order_payments` (`FACT`).
  - `sales` jadvaliga `source_order_id` (`idx_sales_store_order`) qo'shildi va `trg_sales_immutable_core` da qulflandi.
  - `payments`, `cash_moves`, `shift_closures`, `shift_closure_method_totals`, `local_device_state` jadvallari `PRAGMA foreign_keys = ON` ostida bola jadvallarni (`customer_ledger`, `supplier_ledger`, `shift_closure_method_totals`, `shift_closure_cashiers`) `__tmp_*` orqali saqlab qayta tiklash bilan yangilandi; barcha `FACT`/`MONOTONE`/X5 triggerlar qayta yaratildi.
  - `pnpm --filter @mezon/db-local db:check`: `0 diff statements`.

---

### Qabul mezonlari

- [x] **T1.9 test qarzi (`ea05627`)** — yopiq smenaga yangi `clientRequestId` bilan `closeShift` `409 SHIFT_ALREADY_CLOSED` qaytaradi, mutatsiya bilan isbotlangan (`packages/db-local/src/shift.test.ts`, `apps/hub/src/shift.test.ts`).
- [x] **O1: Topshirilgan buyurtma chekida `voidSale` rad etiladi (`409 ORDER_SALE_USE_RETURN`), faqat `createReturn` ishlaydi + mutatsiya dalili** — `packages/db-local/src/order.test.ts`, `apps/hub/src/order.test.ts`.
- [x] **O2: `deliverOrder` qayta narxlamaydi (`totalFinal === order.totalAmount`), yagona `completeSaleCoreInTxSync` orqali o'tadi** — katalog narxi oshirilganda va aksiya o'chirilganda ham buyurtma qotirilgan summada topshiriladi (`packages/db-local/src/order.test.ts`, `apps/hub/src/order.test.ts`).
- [x] **O3: Buyurtma yaratishda T1.3 `evaluateCart` orqali aksiya + chegirma + kassir limiti + supervisor PIN bir marta hisoblanib qotiriladi (`catalog` va `quick_sale`)** — `packages/domain/src/order.test.ts`, `packages/db-local/src/order.test.ts`, `apps/hub/src/order.test.ts`.
- [x] **O4: `getOpenAdvancesTotal()` (`GET /orders/open-advances`) + 225-qadamli 2-terminal model testi** — har qadamda `totalOpenAdvance === totalAdvanceIn - totalAdvanceRefund - totalAdvanceAppliedAtDelivery` va smena yopilishida `expectedCash`, `orderAdvanceCashTotal`, `orderAdvanceNonCashTotal`, `orderAdvanceRefundTotal`, `grossSalesTotal`, `returnsTotal` tiyinigacha teng (`packages/db-local/src/order.test.ts`).
- [x] **Avans olingan va ishlatilgan kunlarda kassa to'g'ri, tushum bir marta** — avans olingan smenada `grossSalesTotal = 0`, topshirilgan smenada `grossSalesTotal = totalFinal`, `cash_moves` da `'advance'` ikki marta yozilmaydi (`packages/db-local/src/order.test.ts`, `apps/hub/src/order.test.ts`).
- [x] **20-qatorli buyurtmani topshirish unumdorligi ≤ 300 ms** — `db-local`: **`40.29 ms`** (`packages/db-local/src/order.perf.test.ts`); `hub` HTTP E2E: **`47.40 ms`** (`apps/hub/src/order.perf.test.ts`).
- [x] **CI-siz ishlash siyosati** — `packages/db-cloud` va `apps/desktop` ga tegilmadi (`git diff main -- packages/db-cloud apps/desktop` bo'sh).

---

### Test natijasi (buyruq va haqiqiy chiqish)

Buyruq: `pnpm verify`

```text
$ pnpm run format:check && pnpm run build && pnpm run lint && pnpm run typecheck && pnpm run db:check && pnpm run test && pnpm run depcruise
$ prettier --check .
Checking formatting...
All matched files use Prettier code style!
$ turbo run build
 Tasks:    13 successful, 13 total
$ node scripts/lint-workspaces.mjs
(0 errors, 0 warnings)
$ turbo run typecheck
 Tasks:    13 successful, 13 total
$ turbo run db:check
@mezon/db-local:db:check: Everything's fine 🐶🔥
@mezon/db-local:db:check: SQLite schema matches committed migrations (0 diff statements).
@mezon/db-cloud:db:check: Everything's fine 🐶🔥
@mezon/db-cloud:db:check: PostgreSQL schema and RLS migrations verified (0 diff statements).
$ pnpm run test:unit && pnpm run test:perf
$ vitest run --project unit --project sqlite-hub

 Test Files  57 passed | 1 skipped (58)
      Tests  276 passed | 2 skipped (278)
   Duration  24.49s

$ vitest run --project perf

[PERF T1.4 db-local] 20-line completeSale (10 FIFO batched + 10 avg) took 42.60 ms
[PERF T1.5 db-local] 20-line completeSale (3 payments: card+payme+cash) median=35.88 ms
[T1.1 Perf 50k products / 70k barcodes WAL] seedMs=5438.8 scan(n=250): p50=0.454ms p95=0.633ms | search(n=100): p50=19.432ms p95=22.675ms
[PERF T1.7 D4] 5,000 entries (1 customer): getCustomerDetail=9.17 ms | createReturn=29.57 ms
[PERF T1.7 10k/100k] seedMs=5584.9 | ftsMs=1.59 | phoneMs=5.25 | balanceMs=0.79 | overdueMs=23.83
[PERF T1.6 db-local] 20-line full createReturn (10 FIFO + 10 avg) median=46.08 ms
[PERF T1.8 100-line receiving]: 173.45 ms
[PERF T1.4 HTTP E2E] 20-line POST /carts/:id/complete took 44.89 ms
[PERF T1.5 HTTP E2E] 20-line 3-payment POST /carts/:id/complete median=37.90 ms
[PERF T1.10 HTTP E2E] 20-line POST /orders/:id/deliver took 47.40 ms
[db-local perf] 20-line order deliverOrder completed in 40.29 ms
[PERF T1.9 db-local] 1,000-receipt shift closeShift elapsed=23.52 ms

 Test Files  9 passed (9)
      Tests  12 passed (12)
   Duration  30.48s

$ depcruise --config .dependency-cruiser.cjs apps/*/src packages/*/src
✔ no dependency violations found (302 modules, 1290 dependencies cruised)
```

---

### Tekshirilmagan narsalar

- `packages/db-cloud/src/pg-rls.test.ts` (2 ta test) lokalda Docker/Testcontainers yo'qligi sababli `skipped` (`packages/db-cloud` ga bu vazifada umuman tegilmadi).
- GitHub Actions CI egasi qaroriga binoan (bepul limit tiklanguncha) ishlatilmadi; barcha tekshiruvlar lokal `pnpm verify` orqali to'liq bajarildi.

---

### Qilingan taxminlar

- Ko'p kassali (multi-terminal) do'konda bir terminalda yaratilgan buyurtma boshqa terminalda tasdiqlanishi, tayyor deb belgilanishi, topshirilishi yoki bekor qilinishi mumkin (`updateMonotone` `device_id` ustunini oxirgi yozgan terminalga yangilaydi). Shu sababli buyurtma tartib raqami (`order_no`) bo'yicha unikal indeks yaratuvchi terminalning o'zgarmas `origin_device_id` ustuniga (`uidx_orders_org_origin_device_no(organization_id, origin_device_id, order_no)`) bog'landi va `origin_device_id` `trg_orders_immutable_core` triggerida qulflandi.

---

### Takliflar

- T1.11 (Kassa UI) da buyurtmalar ro'yxati va topshirish ekranida `remainingToPay` hamda `netAdvanceByMethod` ko'rsatkichlarini bevosita `OrderDto` dan chiqarish kassirga qoldiq to'lovni kiritishni tezlashtiradi.

---

### Egasi yoki Claude qarori kerak bo'lgan savollar

- Savollar yo'q.
