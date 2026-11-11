## Reja: T1.10 — Buyurtma va avans

Branch: `gemini/T1.10-orders-advance` (asos: `main` = `a2806d4`)
T1.9 merge commit SHA: `a2806d46c0e0e4c75f776334e20ecf71d8dd534d` (`PR #16`, `gemini/T1.9-shifts` o'chirildi)

> **Ish tartibi:**
> 1. Reja tasdiqlangach, **birinchi alohida commit**: `T1.9 test qarzi: yopiq smenani qayta yopish` (`closeShift` + `SHIFT_ALREADY_CLOSED` + mutatsiya dalili).
> 2. Keyingi commitlarda T1.10 funksionalligi (`domain -> contracts -> db-local -> hub`) va testlari bajariladi.

---

### 0. T1.9 test qarzi rejasi (1-commit)

- **Fayllar:** `packages/db-local/src/shift.test.ts`, `apps/hub/src/shift.test.ts`.
- **Test:**
  - Smena ochiladi va `closeShift` bilan yopiladi (`closureSeq = 1`).
  - Xuddi shu yopiq smenaga **yangi** `clientRequestId` bilan yana `closeShift` chaqiriladi -> **`409 SHIFT_ALREADY_CLOSED`** qaytadi (SQLite xatosi yoki 500 emas). `shift_closures`, `shift_cashier_sessions`, `local_outbox` qatorlari soni o'zgarmaydi (`0` yozuv).
  - Xuddi shu holatda `recloseShift` chaqirilganda esa `closureSeq = 2` muvaffaqiyatli yaratilishi ko'rsatiladi.
  - HTTP E2E da ham yopiq smenaga yangi `clientRequestId` bilan `POST /shifts/:id/close` `409 SHIFT_ALREADY_CLOSED` qaytarishi tekshiriladi.
- **Mutatsiya isboti:** `shift-repo.ts` (`closeShift`) dagi `if (shiftRow.status !== 'open')` tekshiruvi vaqtincha olib tashlanganda yuqoridagi testlar yiqilishi isbotlanadi va tiklanadi.

---

### 1. Buyurtma va holatlar (`a`)

- **Jadvallar va sinflar (`0012_orders_advance.sql`):**
  1. `orders` — **`MONOTONE`**, store-scoped (`organization_id`, `store_id`).
     - Ustunlar: `orderNo` (`last_order_seq` dan bo'shliqsiz), `orderCode` (`ORD-<last4>-<000001>`), `status`, `customerId` (nullable FK -> `customers.id`), `customerName` (majburiy snapshot), `customerPhoneNormalized` (ixtiyoriy E.164), `dueAtMs` (ixtiyoriy topshirish vaqti), `note`, `totalAmount`, `createdByUserId`, `confirmedAtMs`, `readyAtMs`, `deliveredAtMs`, `deliveredSaleId` (nullable FK -> `sales.id`), `cancelledAtMs`, `cancelledByUserId`, `cancelReason`, `createClientRequestId`, `createRequestHash`.
     - **Bir tomonlama holatlar:**
       - `draft` -> `confirmed` | `cancelled`
       - `confirmed` -> `ready` | `delivered` | `cancelled`
       - `ready` -> `delivered` | `cancelled`
       - `delivered` va `cancelled` — terminal (`UPDATE` / `DELETE` SQLite trigger bilan to'liq bloklanadi; ruxsat etilmagan o'tishlar `BEFORE UPDATE` trigger bilan to'siladi).
  2. `order_lines` — **`FACT`**, store-scoped (`organization_id`, `store_id`, `order_id` -> `orders.id`).
     - Buyurtma yaratilishida o'zgarmas `FACT` snapshot sifatida yoziladi (`FACT` triggerlar tahrirlash va o'chirishni bloklaydi; shuning uchun `draft` da xato qilinsa bekor qilinib yangisi yaratiladi — sinxron bilan 100% mos).
     - `lineKind`: `'catalog' | 'quick_sale'` (`CART_LINE_KINDS` bilan bir xil).
       - `'catalog'`: `productId` (`products.id`), `variantId` ixtiyoriy, katalogdan `itemName`, `unit`, `mxikSnapshot`, `packageCodeSnapshot`, `vatRateBpSnapshot`.
       - `'quick_sale'` (katalogda yo'q tovar): `productId = null`, `variantId = null`, foydalanuvchi kiritgan `itemName`, `unit`, `unitPriceSnapshot`, `mxikSnapshot` (ixtiyoriy), `vatRateBpSnapshot` (default hub sozlamasidan).
- **Narx qotirilishi (qaror):**
  - Narx (`unitPriceSnapshot`, `lineTotal`, `totalAmount`) **buyurtma yaratilganda qotiriladi**. Topshirish paytida katalog narxi o'zgarsa ham buyurtma narxi o'zgarmaydi (`fixed at order`), chunki mijoz shu narx asosida avans to'lagan.
- **Mijoz (qaror):**
  - `customerId` ixtiyoriy (`customers` bilan bog'lash tavsiya etiladi, aktiv mijoz tekshiriladi `CUSTOMER_INACTIVE`), lekin har buyurtmada `customerName` (yoki tanlangan `customer.fullName`) saqlanadi. Topshirishda qarz (`debtAmount > 0`) ishlatilsa `customerId` **majburiy** (`CUSTOMER_REQUIRED` + T1.7 kredit limiti tekshiruvi).

---

### 2. Avans (`b`)

- **`order_payments` (`FACT`, store-scoped):**
  - `orderId`, `shiftId` (`shifts.id`, majburiy), `shiftCashierSessionId` (`shift_cashier_sessions.id`, majburiy), `kind` (`'advance' | 'advance_refund'`), `method` (`PAYMENT_METHODS`), `amount` (`> 0`), `tenderedAmount`, `changeAmount`, `providerRef`, `reason`, `createdByUserId`, `overrideApprovedByUserId`, `clientRequestId`, `requestHash`.
- **Avans olish (`recordOrderAdvance`):**
  - Faqat `draft`, `confirmed`, `ready` buyurtmalarga olinadi (`draft` bo'lsa avtomatik `confirmed` ga o'tadi).
  - Yig'indi `netAdvance + amount <= order.totalAmount` (`409 ORDER_ADVANCE_EXCEEDS_TOTAL`).
  - Ochiq smena va aktiv kassir sessiyasi majburiy (`409 SHIFT_NOT_OPEN` / `409 CASHIER_SESSION_MISMATCH`).
  - **Naqd avans:** `cash_moves` ga yangi tur **`advance_cash_in`** (`+tenderedAmount`) va agar qaytim bo'lsa **`advance_change_out`** (`-changeAmount`) yoziladi (sof o'zgarish = `+amount`).
  - **Naqdsiz avans (`card`, `uzqr`, ...):** faqat `order_payments` ga yoziladi, `cash_moves` ga yozilmaydi.
- **Avans tushum emas, majburiyat:**
  - `v_sales_lines` va `shift_closures.grossSalesTotal` / `netSalesTotal` ga **kirmaydi** (avans olingan kunda savdo tushumi `0`).
  - `shift_closures` da alohida majburiyat ustunlari qo'shiladi: `orderAdvanceCashTotal`, `orderAdvanceNonCashTotal`, `orderAdvanceRefundTotal`. Kassa qutisi (`drawerCashBalance`, `expectedCash`) esa `cash_moves` orqali avans naqdini to'g'ri hisobga oladi.
- **Avans qaytarish (`refundOrderAdvance` / `cancelOrder`):**
  - Buyurtma bekor qilinsa qolgan `netAdvance > 0` alohida `advance_refund` yozuvlari bilan to'liq qaytariladi (yoki oldindan `refundOrderAdvance` qilinadi).
  - T1.6 V2 usul cheklovi: har usuldan faqat o'sha usulda olingan va hali qaytarilmagan miqdorgacha (`netMethodAdvance`) qaytariladi.
  - Naqd avans qaytarilganda **`advance_refund_out`** (`-amount`) `cash_moves` ga tushadi va avval `getActiveShiftDrawerBalanceSync >= cashRefund` tekshiriladi (`409 INSUFFICIENT_CASH_IN_DRAWER`).
  - Yopiq smenaga `order_payments` `INSERT` qilish DB trigger bilan to'siladi (X5 F2 sinxron izohi bilan).

---

### 3. Topshirish = yagona `completeSale` yo'li (`c`)

- **Yagona yo'l (`GEMINI.md 3.1.9`):**
  - `deliverOrder` alohida savdo jadvali yozuvchisi yaratmaydi — `sale-repo.ts` dagi umumiy tranzaksiya yadrosi (**`completeSaleCoreInTxSync`**) orqali `sales` (`sourceOrderId`), `sale_lines`, `payments`, `stock_moves`, `cash_moves`, `customer_ledger`, `local_outbox` ni yozadi!
  - Barcha amallar (`orders.status = 'delivered'`, `deliveredSaleId`, chek, ombor chiqimi, to'lovlar, kassa harakati) **bitta `BEGIN IMMEDIATE` tranzaksiyada** bajariladi.
- **Yangi to'lov usuli `'advance'`:**
  - `payments` (`chk_payments_method`) va `shift_closure_method_totals` ga `'advance'` qo'shiladi (`sales.totalPaid` da hisobga olinadi, `SUM(payments) + debt = totalFinal`).
  - **Oddiy POS `completeSale` API da `'advance'` taqiqlanadi** (`400 VALIDATION_ERROR`): `'advance'` faqat `deliverOrder` ichidan qolgan `netAdvance` summasi qadar qo'llanadi.
  - **`cash_moves` da ikki marta yozilmaydi:** `completeSaleCoreInTxSync` `method === 'advance'` qatori uchun `cash_moves` yaratmaydi (pul avans olinganda kirgan); faqat topshirish paytidagi yangi `'cash'` to'lovlari `sale_cash_in` / `sale_change_out` ga tushadi.
- **Tushum bir marta (mezon):**
  - Avans olingan kunda: kassa naqdi ko'payadi, savdo tushumi = `0`.
  - Topshirish kunida: chek to'liq summa (`totalFinal`) bilan `sales` va `v_sales_lines` ga tushadi -> tushum aynan bir marta hisoblanadi.
- **Ombor va rezerv (qaror):**
  - Buyurtma yaratilganda **ombor rezervi (band qilish) qilinmaydi** (`catalog`/`quick_sale` zaxirasi topshirish paytidagina `applyOutboundStockMoveSync` orqali chiqadi va `negative_stock_policy` `'block'`/`'warn'` ishlaydi; bu hujjatda aniq yoziladi).
- **Avans > chek summasi holati:**
  - `recordOrderAdvance` `netAdvance <= order.totalAmount` ni majburlaydi. Agar topshirishda qo'llanadigan `netAdvance` `totalFinal` dan katta bo'lib qolsa (`appliedAdvance = min(netAdvance, totalFinal)`), ortiqcha qism `deliverOrder` bilan birga `refundOrderAdvance` (yoki `deliverOrder` dagi majburiy `excessRefundPayments`) orqali qaytariladi (`409 ORDER_EXCESS_ADVANCE`), kassa ham shunga mos yangilanadi.

---

### 4. Avansli savdoni qaytarish / Void (`d`, T1.6)

- **Qaror (`createReturn`):**
  - Chekdagi `method === 'advance'` **haqiqiy qaytarish usuli emas** (`return_payments` da `'advance'` ishlatilmaydi — mijozga haqiqiy naqd/karta qaytarilishi shart!).
  - `createReturn` da `originalPaidByMethod` hisoblanayotganda: agar chek `sourceOrderId` ga ega bo'lsa, chekdagi `'advance'` summasi o'sha buyurtmaning sof haqiqiy `order_payments` usullariga (`cash`, `card`, ...) yoyib beriladi (`effectiveOriginalPaidByMethod`). Shunda kassir avansda naqd to'langan qismni `cash` bilan (qutidan `refund_cash_out` va `INSUFFICIENT_CASH_IN_DRAWER` nazorati bilan), kartadagi qismni `card` bilan qaytara oladi.
- **Qaror (`voidSale`, V1):**
  - Smena ichidagi topshirilgan buyurtma cheki `voidSale` qilinsa (`orders.status = 'delivered'` o'zgarmaydi — `MONOTONE`!), `cashRefundAmount` topshirishdagi naqd to'lov + buyurtma avansidagi sof naqd ulushidan iborat bo'lib, `refund_cash_out` bilan kassadan qaytariladi (naqdsiz qism bilan mutanosib). *(Agar avans va topshirish turli smenalarda bo'lsa, V1 qoidasiga ko'ra void faqat topshirilgan smena ochiqligida ishlaydi, va kassa harakatlari yig'indisi har ikki smenada 0 ga yopiladi!)*
- **Model testi (kamida 200 qadam):**
  - 2 terminal / ko'p kun / ko'p smenali deterministic model testi (`TOTAL_STEPS >= 220`): buyurtma yaratish (`catalog` + `quick_sale`), avans olish (`cash` + `card`), smena yopish, boshqa smenada qo'shimcha avans yoki avans qaytarish, bekor qilish, topshirish (`advance` + `cash` + `card` + `debt`), topshirilgan chekni qaytarish va void qilish, kun yakuni (`closeBusinessDay`).
  - Har smena yopilishida `expectedCash`, `orderAdvanceCashTotal`, `orderAdvanceNonCashTotal`, `orderAdvanceRefundTotal`, `grossSalesTotal`, `returnsTotal`, `v_sales_lines` va usul kesimlari mustaqil model bilan tiyinigacha tengligi tekshiriladi (avans olingan smena != topshirilgan smena holati alohida tekshiriladi!).

---

### 5. Idempotentlik, RBAC, unumdorlik va doira (`e`, `f`)

- **Idempotentlik:** barcha 7 komanda (`createOrder`, `confirmOrder`, `markOrderReady`, `recordOrderAdvance`, `refundOrderAdvance`, `deliverOrder`, `cancelOrder`) `clientRequestId` + kanonik SHA-256 `requestHash` bilan (`IDEMPOTENCY_CONFLICT` 409).
- **RBAC:**
  - `orders:read`, `orders:write` -> `owner`, `manager`, `cashier`.
  - `orders:cancel` (hamda `refundOrderAdvance` va `cancelOrder`) -> `owner` va `manager` to'g'ridan-to'g'ri; `cashier` esa **majburiy supervisor PIN override** (`T0.6` 5-urinish lockout bilan, aks holda `403 SUPERVISOR_OVERRIDE_REQUIRED`).
  - Kassir javoblarida `costValue` / `costPrice` mutlaqo qaytmaydi.
- **Unumdorlik:** 20-qatorli buyurtmani topshirish (`deliverOrder` `completeSale` orqali) real WAL SQLite da `<= 300 ms` (`apps/hub` va `db-local` `.perf.test.ts` loyihasida alohida benchmark!).
- **Doiradan tashqari (`f`):** yetkazib berish/kuryer, onlayn buyurtma (F6), fiskal (F3).

---

### 6. Rejalashtirilgan fayllar ro'yxati

1. **T1.9 test qarzi (1-commit):** `packages/db-local/src/shift.test.ts`, `apps/hub/src/shift.test.ts`.
2. **`@mezon/domain`:** `errors.ts`, `auth.ts`, `sale.ts`, `shift.ts`, `order.ts`, `order.test.ts` (jumladan `fast-check` property testlar), `index.ts`.
3. **`@mezon/contracts`:** `order.ts`, `order.test.ts`, `sale.ts`, `shift.ts`, `index.ts`.
4. **`@mezon/db-local`:** `schema/index.ts`, `drizzle/0012_orders_advance.sql`, `drizzle/meta/{_journal.json,0012_snapshot.json}`, `order-migrations.ts`, `device-state.ts`, `scripts/check-migrations.mjs`, `order-repo.ts`, `sale-repo.ts` (`completeSaleCoreInTxSync`), `return-repo.ts`, `shift-repo.ts`, `index.ts`, `index.test.ts` (`0011 -> 0012`), `order.test.ts`, `order.perf.test.ts`.
5. **`apps/hub`:** `error-handler.ts`, `order-service.ts`, `order-routes.ts`, `routes.ts`, `server.ts`, `index.ts`, `order.test.ts`, `order.perf.test.ts`.
