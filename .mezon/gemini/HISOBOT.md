# T1.3 Merge + T1.4 Rejasi (`completeSale`)

> **Branch:** `gemini/T1.4-complete-sale` (yangi `main` dan ochildi)
> **T1.3 Merge Commit SHA:** `462cac770332667a4bdfad48b876e3e2da5cf682` (`T1.3: Savat, aksiyalar va chegirma`, PR #10)
> **Branch tozalash:** `gemini/T1.3-cart-pricing` remote va lokaldan o'chirildi.
> **T1.4 Kod holati:** Kod hali yozilmagan (`TOPSHIRIQ.md` bo'yicha avval reja tasdig'i kutilmoqda).

---

## 0. Commit ketma-ketligi va T1.3 test qarzi (1-commit)

T1.4 PR'ida T1.4 kodidan **oldin** alohida birinchi commit yoziladi:

- **1-commit:** `T1.3 test qarzi: do'kon aksiyasi, limit chegarasi, tasdiq maydonlari`
  1. **`isPromotionActiveAt` do'kon filtri (`packages/domain/src/cart.test.ts` va `packages/db-local/src/cart.test.ts`):**
     - `storeId = storeA` uchun yaratilgan aksiya `storeB` savatiga qo'llanmasligi, `storeId = null` (tarmoq bo'ylab) aksiya esa ham `storeA`, ham `storeB` savatiga qo'llanishi testlanadi.
     - *Mutatsiya isboti:* `isPromotionActiveAt` ichidagi `promo.storeId !== null && storeId !== null && promo.storeId !== storeId` tekshiruvi olib tashlanganda test yiqiladi.
  2. **`doesDiscountExceedCashierLimit` aniq chegaralar (`packages/domain/src/cart.test.ts`):**
     - Summa chegarasi: `disc === maxAmount` ruxsat etiladi (`false`), `disc === maxAmount + 1n` tasdiq talab qiladi (`true`).
     - Foiz chegarasi: masalan `subtotalAfterPromo = 100_000n`, `maxPercentBp = 1000n` (10.00%) bo'lganda `10_000n` ruxsat etiladi (`false`), `10_001n` tasdiq talab qiladi (`true`); `percentUnlimited = true` bo'lsa ham summa chegarasi ishlashi va aksincha tekshiriladi.
     - *Mutatsiya isboti:* `> moneyToTiyin(policy.maxAmount)` ni `> moneyToTiyin(policy.maxAmount) + 1n` ga hamda `discTiyin * 10_000n > subTiyin * policy.maxPercentBp` ni `>= +1` / bo'shatilgan shartga o'zgartirganda chegara testlari yiqiladi.
  3. **`isCartManualDiscountAuthorized` tasdiq juftligi (`packages/domain/src/cart.test.ts`):**
     - Limitdan oshgan chegirma holatida har ikkala yakka-`null` varianti testlanadi:
       - `overrideApprovedByUserId !== null`, lekin `overrideApprovedAmount === null` → `false`
       - `overrideApprovedByUserId === null`, lekin `overrideApprovedAmount !== null` → `false`
     - *Mutatsiya isboti:* `if (params.overrideApprovedByUserId === null || params.overrideApprovedAmount === null)` dagi `||` operatori `&&` ga almashtirilganda testlar yiqiladi.
- **Keyingi commit(lar):** `T1.4: completeSale komandasi, chek/to'lov sxemasi va idempotentlik`

---

## 1. Rejalashtirilgan fayllar

- `packages/domain/src/errors.ts`, `auth.ts`, `index.ts`, `sale.ts`, `sale.test.ts` — sof `completeSale` hisob/to'lov/invariant tekshiruvlari (`bigint`), `SALE_TOTAL_CHANGED`, `CART_EMPTY`, `IDEMPOTENCY_CONFLICT` xato kodlari, `sales:read` ruxsati.
- `packages/contracts/src/sale.ts`, `sale.test.ts`, `auth.ts` (yoki `common`), `index.ts` — `CompleteSaleRequestSchema`, `CompleteSaleResponseSchema` (tannarx/foydasiz), `ApiErrorEnvelopeSchema` da ixtiyoriy tuzilgan `details` maydoni (`SALE_TOTAL_CHANGED` uchun yangilangan summa va `INSUFFICIENT_STOCK` uchun yetishmayotgan qatorlar ro'yxati).
- `packages/db-local/src/schema/index.ts`, `drizzle/0006_complete_sale.sql`, `drizzle/meta/*` — `sales` (`MONOTONE`), `sale_lines` (`FACT`), `payments` (`FACT`), `local_device_state.last_receipt_seq`, `local_carts` da `'completed'` holati va mahalliy idempotentlik/ogohlantirish metama'lumoti.
- `packages/db-local/src/device-state.ts` — `advanceReceiptSeqSync` (xuddi `last_device_seq` kabi tranzaksiya ichida `UPDATE ... RETURNING`).
- `packages/db-local/src/stock-repo.ts` — `applyOutboundStockMoveSync(session, ...)` ichki session funksiyasini export qilish (T1.2 `recordOutboundMove` va `completeSale` aynan bir xil mantiqdan foydalanadi).
- `packages/db-local/src/cart-repo.ts` — `assertCartEditableSync` / savat o'qish va `'completed'` ga o'tkazish session helper'lari.
- `packages/db-local/src/sale-repo.ts`, `sale.test.ts`, `index.ts` — `SqliteSaleStore.completeSale`, rollback / parallel / child-process `process.exit` crash testlari, 20 qatorli unumdorlik testi.
- `apps/hub/src/error-handler.ts`, `cart-service.ts`, `cart-routes.ts`, `server.ts`, `sale.test.ts` — `POST /carts/:id/complete` endpointi, kassir javobida tannarx/foyda yo'qligi, HTTP RBAC/409/idempotentlik/parallel testlar.

---

## 2. Me'moriy yechim (`a`–`h` bandlar)

### a) Hujjatlar va sinflar

Barcha yangi sinxron jadvallar `localSchemaRegistry` orqali e'lon qilinadi (`bigint` pul/miqdor ustunlarida avtomatik `CHECK(typeof(...) = 'integer')`, `hlc` va UUIDv7 tekshiruvlari bilan):

1. **`sales` (`tableClass: 'MONOTONE'`, `tenantScope: 'store'`):**
   - Umumiy ustunlar: `id` (UUIDv7), `organization_id`, `store_id`, `device_id`, `hlc`, `created_at_ms`, `updated_at_ms` (`deleted_at_ms` yo'q; `trg_sales_no_delete` triggeri).
   - Chek raqamlash va bog'lanishlar:
     - `receipt_no` (`sqliteBigint`, `NOT NULL`, `>= 1`) — qurilma bo'yicha bo'shliqsiz ketma-ket raqam (`UNIQUE(organization_id, device_id, receipt_no)`).
     - `receipt_code` (`text`, `NOT NULL`) — ko'rinadigan chek raqami snapshot'i (masalan `9F2A-000001`).
     - `source_cart_id` (`sqliteUuidV7`, nullable) — qaysi `local_carts` savatidan yopilgani (F2 da boshqa qurilmalarda `local_carts` bo'lmasligi mumkinligi uchun FK qattiq emas yoki mahalliy savat saqlanadi).
     - `cashier_user_id` (`sqliteUuidV7`, `NOT NULL`, FK → `users.id`).
     - `customer_id` (`sqliteUuidV7`, nullable — T1.7 `customers` jadvali qo'shilganda bog'lanadi).
     - `shift_id` (`sqliteUuidV7`, nullable — T1.9 da majburiy bo'ladi).
     - `client_request_id` (`sqliteUuidV7`, `NOT NULL`, `UNIQUE(organization_id, client_request_id)`).
   - Narx va chegirma snapshot'i (`sqliteMoney`, barchasi `>= 0`):
     - `subtotal_gross`, `total_promo_discount`, `subtotal_after_promo`, `manual_discount_mode` (`'none'|'percent'|'amount'`), `manual_discount_value` (`sqliteBigint`), `manual_discount_reason` (`text`, nullable), `order_discount_amount`, `total_final`, `total_net_ex_vat`, `total_vat`.
     - `total_paid` (`>= 0`, T1.4 da `= total_final`), `debt_amount` (`>= 0`, T1.4 da `0`, T1.7 uchun tayyor), `change_amount` (`>= 0`).
   - Supervisor tasdig'i snapshot'i:
     - `override_approved_by_user_id` (nullable FK → `users.id`), `override_approved_amount` (nullable `sqliteMoney`), `override_approved_at_ms` (nullable `sqliteUnixMs`).
   - Fiskal holat ustunlari (F3 uchun joy):
     - `fiscal_status` (`text`, `NOT NULL`, `'pending' | 'fiscalized' | 'skipped' | 'failed'`, T1.4 da `'pending'`), `fiscal_receipt_no` (`text`, nullable — F3 dan oldin har doim `NULL`, chunki `GEMINI.md` 3.3 bo'yicha fiskal belgi faqat driver javobidan keyin yoziladi).
   - `MONOTONE` bekor qilish (T1.6 uchun):
     - `voided_at_ms` (nullable `sqliteUnixMs`), `voided_by_user_id` (nullable FK → `users.id`), `void_reason` (nullable `text`).
     - **SQLite `BEFORE UPDATE` `MONOTONE` triggeri:** `sales` da summalar, qator havolalari, `receipt_no`, `client_request_id`, `cashier_user_id` va h.k. **hech qachon tahrirlanmaydi**. Faqat `OLD.voided_at_ms IS NULL AND NEW.voided_at_ms IS NOT NULL` bir tomonlama o'tishiga ruxsat beriladi (`OLD.voided_at_ms IS NOT NULL` bo'lsa `RAISE(ABORT)`).

2. **`sale_lines` (`tableClass: 'FACT'`, `tenantScope: 'store'`):**
   - Triggerlar: `trg_sale_lines_no_update`, `trg_sale_lines_no_delete` (to'liq o'zgarmas `FACT`).
   - Ustunlar:
     - `sale_id` (`sqliteUuidV7`, `NOT NULL`, FK → `sales.id`), `sort_order` (`sqliteInt`, `>= 0`).
     - `line_kind` (`'catalog' | 'quick_sale'`), `product_id` (nullable FK → `products.id`), `variant_id` (nullable FK → `product_variants.id`), `category_id_snapshot` (nullable `sqliteUuidV7`).
     - Snapshot maydonlari: `item_name`, `unit`, `qty` (`sqliteQuantity`, `> 0`), `unit_price_snapshot` (`sqliteMoney`, `>= 0`).
     - Aksiya va soliq snapshot'i: `applied_promotion_id` (nullable `sqliteUuidV7`), `applied_promotion_name` (nullable `text`), `free_units` (`sqliteBigint`, `>= 0`), `gross_total`, `promo_discount`, `subtotal_after_promo`, `allocated_order_discount`, `final_total`, `vat_rate_bp_snapshot` (`sqliteInt`), `net_ex_vat`, `vat_total`.
     - Qonuniy / F3 snapshot: `mxik_snapshot` (nullable `text`), `package_code_snapshot` (nullable `text`).
     - Tannarx snapshot (foyda hisobi uchun, **kassir DTO'siga kiritilmaydi**): `cost_value` (`sqliteMoney`, `>= 0`, `stock_moves` dagi `-cost_value_delta` yig'indisi; `unlimited` va `quick_sale` qatorlari uchun `0`).

3. **`payments` (`tableClass: 'FACT'`, `tenantScope: 'store'`):**
   - Triggerlar: `trg_payments_no_update`, `trg_payments_no_delete` (to'liq o'zgarmas `FACT`).
   - Ustunlar:
     - `sale_id` (`sqliteUuidV7`, `NOT NULL`, FK → `sales.id`).
     - `method` (`'cash' | 'card' | 'uzqr' | 'payme' | 'click' | 'uzum' | 'social_card' | 'other'`; T1.4 API faqat `'cash'` qabul qiladi).
     - `amount` (`sqliteMoney`, `>= 0`) — chek summasiga yopiladigan sof ulush.
     - `tendered_amount` (`sqliteMoney`, nullable) — naqdda xaridor bergan pul (`>= amount`).
     - `change_amount` (`sqliteMoney`, `NOT NULL`, `>= 0`) — naqdda `tendered_amount - amount`, naqdsizda `0`.
     - T1.5 / F3 kengaytma ustunlari (hozir `NULL`): `provider_ref` (`text`), `provider_meta_json` (`text`).
     - Invariant: Domen va SQLite `CHECK`: `method = 'cash'` da `tendered_amount IS NOT NULL AND tendered_amount - change_amount = amount`; barcha to'lovlar uchun `SUM(payments.amount) + sales.debt_amount = sales.total_final` (`debt_amount = 0` bo'lgani uchun T1.4 da `SUM(payments.amount) = sales.total_final`).

4. **`local_carts` kengayishi (`LOCAL`, migratsiya `0006`):**
   - `status` CHECK `('open', 'parked', 'completed')` ga kengaytiriladi va `completed_sale_id` (nullable `sqliteUuidV7`), `completed_at_ms` (nullable `sqliteUnixMs`), `completion_warnings_json` (nullable `text`) ustunlari qo'shiladi.
   - Shu orqali yakunlangan savatga boshqa `clientRequestId` bilan ikkinchi so'rov kelganda `404 CART_NOT_FOUND` emas, aynan `409 CART_NOT_OPEN` qaytadi; xuddi shu `clientRequestId` bilan qayta so'rov esa ogohlantirishlar bilan birga bir xil javobni qaytaradi.

5. **Ledger, fiskal hujjat, audit va outbox (GEMINI.md 3.1.10):**
   - T1.4 da bitta `uow.execute` tranzaksiyasida quyidagilar yoziladi: `sales`, `sale_lines[]`, `payments[]`, `stock_moves[]` (ombor ledgeri) + `local_stock_balances` / `local_batch_balances`, `local_device_state` (`last_receipt_seq` + `last_device_seq`), `local_carts` status o'tishi hamda barcha sinxron yozuvlar uchun `local_outbox` (`sale.completed`, `sale_line.created`, `payment.created`, `stock_move.created`).
   - `cash_moves` T1.5 da, `customer_ledger` T1.7 da, `shifts` majburiyligi T1.9 da, `fiscal_docs` esa F3 da aynan shu tranzaksiya session'i ichiga ulanadi (`h` bandga qarang).
   - Audit: har bir chekda `cashier_user_id`, `override_approved_by_user_id`, `device_id`, `hlc`, `created_at_ms` va `local_outbox` hodisalari yoziladi; Hub esa `sale.completed` strukturali Pino audit logini yozadi (foyda/tannarxsiz).

---

### b) Bitta tranzaksiya, ichma-ich `execute` yo'q

- T1.2 dagi `SqliteStockStore.recordOutboundMove` ichidagi `this.applyOutboundInsideSessionSync(session, ...)` alohida export qilinadigan **`applyOutboundStockMoveSync(session, params)`** funksiyasiga chiqariladi (T1.2 dagi FIFO/o'rtacha tannarx, partiya yechish, kesh yangilash va `stock_move.created` outbox yozish mantig'ining o'zi).
- `SqliteStockStore.recordOutboundMove` `uow.execute((session) => applyOutboundStockMoveSync(session, ...))` ni chaqiradi; `completeSale` ham o'zining bitta `uow.execute((session) => ...)` tranzaksiyasi ichida aynan shu `applyOutboundStockMoveSync` ni chaqiradi. **Ombor mantig'i nusxalanmaydi** va T0.5 `UNIT_OF_WORK_REENTRANCY` himoyasi buzilmaydi (`savepoint`/nested `execute` ham shart emas, chunki biror xatoda tashqi `uow.execute` `ROLLBACK` hamma yozuvni qaytaradi).
- Xuddi shunday savat o'qish/baholash (`loadCartForEvaluationSync(session, ...)`), `advanceReceiptSeqSync`, `insertMonotone(sales)`, `insertFact(sale_lines)`, `insertFact(payments)` va `local_carts` ni `'completed'` ga o'tkazish hammasi o'sha bitta `session` ustida bajariladi.

---

### c) Server tomonida qayta hisoblash va chek yaxlitligi

`uow.execute` ichida, har qanday yozuvdan oldin:

1. `session.nowUnixMs()` va `session.nextId()` olinadi (testda deterministik soat bilan vaqt boshqariladi).
2. Savat qatorlari bo'sh bo'lsa → `400 CART_EMPTY` (bo'sh chek yaratilmaydi).
3. **Narx snapshot vs katalog:** Savatga qo'shilgan qatorlardagi `unitPriceSnapshot`, `itemName`, `mxikSnapshot`, `packageCodeSnapshot`, `vatRateBpSnapshot` bilan katalogdagi amaldagi narx/atributlar solishtiriladi:
   - `evaluateCart` joriy `session.nowUnixMs()` bilan `promotions` (va `storeId`) hamda savatdagi `manualDiscount` va `overrideApproved*` maydonlarini qayta hisoblaydi (`T1.3`).
   - Eslatma: T1.3 siyosati bo'yicha katalog narxi o'zgargan bo'lsa, savatdagi snapshot kassir `refreshPrices` bosmaguncha saqlanadi; lekin **muddati tugagan yoki yangi boshlangan aksiya**, qo'shilgan/o'chirilgan qator natijasida `evaluated.totalFinal !== BigInt(expectedTotal)` chiqsa → tranzaksiya hech narsa yozmay to'xtaydi va **`409 SALE_TOTAL_CHANGED`** qaytadi (`details` da `expectedTotal`, `actualTotal` va yangilangan `evaluateCart` jamilari bilan).
4. **Chegirma tasdig'i:** `assertCartDiscountAuthorized(evaluated)` qayta tekshiriladi; agar limit yoki `override_approved_amount` dan oshgan bo'lsa → `403 DISCOUNT_OVERRIDE_REQUIRED`.
5. **Naqd to'lov tekshiruvi:** `tenderedAmount < evaluated.totalFinal` bo'lsa → `400 VALIDATION_ERROR` (`INSUFFICIENT_PAYMENT` / aniq xabar). `0` so'mlik chek (100% chegirma) uchun `tenderedAmount >= 0n`, `change = tenderedAmount` qo'llab-quvvatlanadi.

---

### d) Zaxira siyosati (`block` vs `warn`, `unlimited` va `quick_sale`)

- Qaysi zaxira siyosati ishlatiladi: `local_hub_config.negative_stock_policy` (`'block' | 'warn'`). (Kassir request orqali `block` ni yumshata olmaydi.)
- Har qator bo'yicha harakat:
  - `line.lineKind === 'quick_sale'` → omborga tegmaydi (`stock_moves` yozilmaydi), `cost_value = 0n`.
  - `line.lineKind === 'catalog'` va mahsulot `unlimited === true` → omborga tegmaydi (`stock_moves` yozilmaydi), `cost_value = 0n`.
  - Boshqa barcha `catalog` qatorlari → `applyOutboundStockMoveSync(session, { reason: 'sale', sourceType: 'sale', sourceId: saleId, needQty: line.qty, overridePolicy: hubPolicy, ... })` chaqiriladi:
    - `sale_lines.cost_value` sifatida qaytgan `moves` ning `-costValueDelta` yig'indisi (tiyinda) yoziladi.
    - **`block` rejimida:** Agar bitta yoki bir nechta qatorda (yoki bir xil mahsulotning bir nechta qatori jamlanganda) yetishmovchilik aniqlansa, yetishmayotgan barcha qatorlar tafsiloti (`cartLineId`, `productId`, `variantId`, `itemName`, `requestedQty`, `availableQty`, `deficitQty`) yig'ilib **`409 INSUFFICIENT_STOCK`** tashlanadi. SQLite butun `BEGIN IMMEDIATE` tranzaksiyasini rollback qiladi (`sales`, `sale_lines`, `payments`, oldingi qatorlarning `stock_moves`, `local_outbox`, `last_receipt_seq` hammasi 0 ga qaytadi), `local_carts.status` **`'open'` bo'lib qoladi**.
    - **`warn` rejimida:** `applyOutboundStockMoveSync` T1.2 qoidasi bo'yicha zaxirani manfiyga tushiradi (`lastUnitCost` bo'yicha provizor tannarx bilan) va `NEGATIVE_STOCK` ogohlantirishlarini qaytaradi; savdo muvaffaqiyatli yakunlanadi va ogohlantirishlar chek javobida + `local_carts.completion_warnings_json` da saqlanadi.

---

### e) Chek raqami (`receipt_no`)

- `local_device_state` jadvaliga `last_receipt_seq` (`sqliteBigint`, `NOT NULL`, `DEFAULT 0`, `>= 0`) ustuni qo'shiladi (`0006` migratsiyasida `ALTER TABLE`).
- `completeSale` tranzaksiyasi ichida `advanceReceiptSeqSync(sqlite, { deviceId, updatedAtMs })`:
  ```sql
  UPDATE local_device_state
  SET last_receipt_seq = last_receipt_seq + 1, updated_at_ms = ?
  WHERE device_id = ?
  RETURNING last_receipt_seq
  ```
- **Rollback xavfsizligi:** `last_receipt_seq` xuddi `last_device_seq` kabi faqat SQLite ichida tranzaksiya payti oshiriladi; `INSUFFICIENT_STOCK`, `SALE_TOTAL_CHANGED`, xato to'lov yoki jarayon o'ldirilganda SQLite rollback raqamni avtomatik qaytaradi — **birorta raqam iste'mol qilinmaydi va teshik qolmaydi**.
- **Ko'rinadigan format:** `<deviceId oxirgi 4 ta katta hex belgisi>-<kamida 6 xonali 0 bilan to'ldirilgan receiptNo>`, masalan `A1B2-000001`, `A1B2-000002` (F4 da ko'p terminal bir do'konda offline ishlaganda ham chek kodlari to'qnashmasligi uchun). `sales` da ikkala qiymat ham saqlanadi: tartiblash/noyoblik uchun `receipt_no` (`bigint`) va chop etish/UI uchun `receipt_code` (`string`).
- **Fiskal raqam:** Alohida `fiscal_receipt_no` (`null`) va `fiscal_status = 'pending'`; faqat F3 da haqiqiy fiskal drayver javobidan keyin to'ldiriladi.

---

### f) Idempotentlik, parallellik va jarayon uzilishi

1. **Birinchi tekshiruv (tranzaksiya ichida `client_request_id`):**
   - `sales` dan `(organization_id, client_request_id)` bo'yicha qidiriladi.
   - Agar yozuv mavjud bo'lsa:
     - `existing.sourceCartId !== cartId` bo'lsa → `409 IDEMPOTENCY_CONFLICT` (begona savat uchun eski `clientRequestId` ishlatilmasligi uchun).
     - Aks holda mavjud `sales`, `sale_lines`, `payments` va `local_carts.completion_warnings_json` o'qilib, **hech qanday yangi yozuv, ombor harakati yoki outbox qo'shmasdan** aynan o'sha natija qaytariladi (`idempotentReplay: true/false` ixtiyoriy yoki bir xil DTO).
2. **Savat holatini tekshirish:**
   - Agar `client_request_id` bazada bo'lmasa (`yangi` yoki oldingi urinish rollback bo'lgan):
     - Savat topilmasa → `404 CART_NOT_FOUND`.
     - Savat holati `'open'` bo'lmasa (`'parked'` yoki `'completed'`) → **`409 CART_NOT_OPEN`**.
     - Oldingi urinish rollback bo'lgan bo'lsa, savat hali `'open'` va `client_request_id` bo'sh bo'lgani uchun qayta urinish toza boshidan bajariladi.
3. **Parallellik:**
   - `SqliteUnitOfWork` barcha so'rovlarni FIFO `AsyncMutex` + `BEGIN IMMEDIATE` orqali ketma-ketlashtiradi.
   - Bir savatga parallel kelgan 2 ta `completeSale`: 1-si tranzaksiyani tugatib `local_carts.status = 'completed'` qiladi; 2-si mutex navbatida kirib, bir xil `clientRequestId` bo'lsa idempotent o'sha chekni oladi, boshqa `clientRequestId` bo'lsa `409 CART_NOT_OPEN` oladi. Ikkita chek chiqishi mumkin emas.
4. **Rejalashtirilgan chidamlilik testlari:**
   - *Ikki marta bosish:* bir xil `(cartId, clientRequestId)` ketma-ket 2 marta — 1 ta `sale`, 1 ta `receipt_no`, 1 marta ombor chiqimi, 1 to'plam outbox.
   - *Parallel so'rovlar:* `Promise.all` bilan ham bir xil `clientRequestId`, ham har xil `clientRequestId` bilan 2–5 parallel `POST /carts/:id/complete` — jami 1 ta `sale`.
   - *Rollback → qayta urinish:* `block` rejimida yetishmayotgan zaxira bilan `completeSale` → `409 INSUFFICIENT_STOCK` (0 ta `sale`, 0 ta `stock_move`, 0 ta `outbox`, `last_receipt_seq` = 0, savat `'open'`) → kirim qilinib **xuddi shu `clientRequestId`** bilan qayta `completeSale` → `receipt_no = 1` bilan muvaffaqiyatli yakunlanadi.
   - *Child process crash testi:* haqiqiy fayl SQLite (`WAL`) da alohida Node child process `completeSale` tranzaksiyasi o'rtasida (`sales`, `sale_lines`, `payments`, `stock_moves`, `local_outbox`, `last_receipt_seq` yozilgach, lekin `COMMIT` dan oldin test-hook orqali) `process.exit(1)` bilan o'ladi → ota jarayon bazani qayta ochib tekshiradi: 0 ta `sale`, 0 ta `sale_line`, 0 ta `payment`, 0 ta `stock_move`, 0 ta yangi `outbox`, `last_receipt_seq = 0`, savat `'open'` va keyingi urinishda chek to'liq (`receipt_no = 1`) o'tadi.

---

### g) Hub API, RBAC va unumdorlik

- **Endpoint:** `POST /carts/:id/complete` (`200 OK`)
  - Ruxsat: `'cart:write'` (`cashier`, `manager`, `owner` ruxsatli; token yo'q → `401`).
  - Kirish tanasi (`CompleteSaleRequestSchema`, `strictObject`):
    - `clientRequestId`: `UuidV7Schema`
    - `expectedTotal`: `BigIntStringSchema`
    - `payments`: hozir `length(1)` va `method: 'cash'`, `tenderedAmount: BigIntStringSchema` (T1.5 da massiv elementlari ko'payishi bilan endpoint va schema buzilmasdan kengayadi).
  - Javob (`CompleteSaleResponseSchema`, `strictObject`):
    - `sale`: `id`, `receiptNo` (satr), `receiptCode`, `storeId`, `cashierUserId`, `status` (`'completed'`), jami summalar (`subtotalGross`, `totalPromoDiscount`, `subtotalAfterPromo`, `orderDiscountAmount`, `totalFinal`, `totalNetExVat`, `totalVat`, `totalPaid`, `changeAmount`), `fiscalStatus`, `createdAtMs`, `lines[]` (`costValue`siz!), `payments[]`.
    - `warnings`: `NEGATIVE_STOCK` ro'yxati (`productId`, `variantId`, `deficitQty`).
  - **Tannarx yashirish:** `sale_lines.cost_value` DB da saqlanadi (T1.6 qaytarish va T1.13 egasi hisoboti uchun), lekin `/carts/:id/complete` javob DTO'sida (`strictObject` mapper orqali) **umuman chiqmaydi**; test barcha rollarda `cost` / `costValue` / `profit` / `margin` kalitlari yo'qligini tekshiradi.
- **Unumdorlik (`<= 300 ms`):**
  - Tranzaksiya ichida N+1 so'rovlardan qochish uchun barcha qatorlarning mahsulotlari, variantlari, aktiv aksiyalari va zaxira qoldiqlari `inArray` bilan oldindan yig'ilib o'qiladi (`batch prefetch`).
  - Test: 20 ta katalog qatorli savatni (FIFO partiyalar bilan) Hub HTTP + haqiqiy SQLite (diskdagi temp fayl, `WAL`) orqali yakunlash vaqti o'lchanib, `<= 300 ms` mezoni tekshiriladi va natijasi hisobotga yoziladi.

---

### h) Doiradan tashqari va kelgusi vazifalarga moslashuv

Quyidagilar T1.4 doirasiga kirmaydi, lekin sxema va interfeys ularga **o'zgarishsiz** kengayadigan qilib loyihalanadi:

- **T1.5 (To'lovlar, `cash_moves`, so'mga yaxlitlash):** `payments` jadvali `card`, `uzqr`, `payme`, `click`, `uzum`, `social_card`, `other`, `provider_ref`, `provider_meta_json` ni hozirdan qo'llaydi; `POST /carts/:id/complete` dagi `payments[]` massivi T1.5 da aralash to'lovlarga tayyor; T1.5 da xuddi shu tranzaksiya `session` i ichida `'cash'` to'lovlari uchun `cash_moves` yoziladi.
- **T1.6 (Bekor qilish va qaytarish):** `sales` `MONOTONE` sinfida `voided_at_ms`, `voided_by_user_id`, `void_reason` ustunlari va bir tomonlama trigger bilan tayyor; `sale_lines.cost_value` foyda/qaytarish tannarxini tiklash uchun saqlanadi.
- **T1.7 (Mijoz qarz daftari):** `sales.customer_id` va `sales.debt_amount` (`SUM(payment) + debt = total`) ustunlari mavjud.
- **T1.9 (Smena majburiyligi):** `sales.shift_id` (hozir `nullable`) mavjud; T1.9 da ochiq smena talabi qo'shiladi.
- **T1.12 (Printer va chek):** `receipt_code`, qator snapshot'lari, tekin birliklar (`free_units`), chegirmalar va QQS (`vat_rate_bp_snapshot`, `vat_total`) chek chop etish uchun to'liq saqlanadi.
- **F3 (Fiskal):** `sales.fiscal_status` (`'pending'`), `fiscal_receipt_no` (`NULL`) va `sale_lines.mxik_snapshot` / `package_code_snapshot` tayyor.

---

### Takliflar va ochiq savollar

1. **`receipt_code` formati (`(e)` bandi):** F4 da bir do'konda bir nechta kassa apparati offline ishlashi mumkinligi uchun `receipt_code` ni `<deviceId oxirgi 4 hex>-<6 xonali receipt_no>` (masalan `A1B2-000001`) ko'rinishida qilishni taklif qilaman, toki bir kunlik cheklarda ikki apparatning `000001` i adashmasin. Oddiy `000001` ma'qulroq bo'lsa, tasdiqlang.
2. **Park qilingan savatni to'g'ridan-to'g'ri yopish:** Kassir `parked` savatni avval `POST /carts/:id/resume` bilan `'open'` qilishi, `completeSale` esa faqat `status === 'open'` savatni qabul qilishi rejalashtirildi (aks holda `409 CART_NOT_OPEN`). Bu T1.3 oqimi bilan mosmi?
3. **`sales` da `fiscal_status` ustuni:** F3 da alohida `fiscal_docs` jadvali qo'shilishi kutilmoqda (`GEMINI.md` 8-bo'lim: "`fiscal_doc` holati"). `sales` da `fiscal_status` (`'pending'` default, F3 da update qilinadigan MONOTONE ustuni yoki `fiscal_docs` jadvali bilan birga) qolishi ma'qulmi, yoki T1.4 da faqat `fiscal_status` qoldirilib F3 da `fiscal_docs` ulansinmi?
4. **Hujjat tasdig'i (`b` / `g`):** `CompleteSaleRequestSchema` da `payments: [{ method: 'cash', tenderedAmount }]` massivi (T1.4 da `length(1)` cheklovi bilan) T1.5 ga o'tishda API sinmasligi uchun ishlatilsinmi?
