## Reja: T1.6 — Bekor qilish (`voidSale`), qaytarish (`createReturn`) va `v_sales_lines`

### 0. T1.5 merge natijasi (tekshirildi)

- **PR #12 boshi:** `bf1a647d2b8d58c74f2fa5579853c83beb0dcbf5` (T1.5 QABUL commit `b3a940d` + Claude topshirig'i).
- **CI holati:** Ubuntu va Windows bo'yicha barcha 8 ta tekshiruv (`lint`, `typecheck`, `test`, `build`) yashil o'tdi.
- **Squash and merge:** `T1.5: Aralash to'lovlar, qaytim va kassa harakatlari` — Merge commit SHA: `b59aa8762484e93f9e5fca8dbee65ed8d355754e`.
- **Branchlar:** `gemini/T1.5-payments` lokal va masofadan o'chirildi; `main` (`b59aa87`) dan `gemini/T1.6-void-return` branch'i ochilib push qilindi.

---

### 1. Rejalashtirilgan arxitektura va fayllar

- **Sof domen mantiqi (`@mezon/domain`, IO yo'q):**
  - `packages/domain/src/auth.ts`: `sale:void`, `sale:return`, `reports:profit` ruxsatlari (`owner`/`manager` va `owner` darajalari).
  - `packages/domain/src/return.ts` (yangi): kumulyativ proporsional taqsimot (`divideRoundHalfAwayFromZero` orqali), qisman/to'liq qaytarish satrlari hisobi, usul bo'yicha to'lov qaytarish invariantlari, kanonik `request_hash` tuzilmalari (`voidSale` va `createReturn`).
  - `packages/domain/src/return.test.ts` va `packages/domain/src/index.ts`.
- **Kontraktlar (`@mezon/contracts`):**
  - `packages/contracts/src/return.ts` (yangi): `VoidSaleRequestSchema`, `CreateReturnRequestSchema`, `VoidSaleResponseSchema`, `CreateReturnResponseSchema`, `ReturnRecordSchema` (kassir/POS DTO'larida **`costValue` va foyda yo'q**), hamda egasi hisoboti uchun `SalesLinesReportSummarySchema`.
  - `packages/contracts/src/index.ts`, `packages/contracts/src/return.test.ts`.
- **Lokal baza va repozitoriy (`@mezon/db-local`):**
  - `packages/db-local/src/schema/index.ts`: `local_device_state.last_return_seq`, `sales` (`void_client_request_id`, `void_request_hash` va kuchaytirilgan `chk_sales_void_pair`), yangi `FACT` jadvallar (`returns`, `return_lines`, `return_payments`).
  - `packages/db-local/drizzle/0008_void_return.sql` (+ snapshot): jadvallar, `FACT`/`MONOTONE` triggerlar va `v_sales_lines` ko'rinishi.
  - `packages/db-local/src/device-state.ts`: `advanceReturnSeqSync` va `readReturnSeqSync`.
  - `packages/db-local/src/sale-migrations.ts`: `assertSaleMigrationsComplete` va `assertReturnAndViewMigrationsComplete` (`FACT` triggerlar hamda `v_sales_lines` ko'rinishini `db:check` da tekshirish).
  - `packages/db-local/src/stock-repo.ts`: `applyReturnStockMoveSync` ichki tranzaksion yordamchisi (Variant 1 bo'yicha asl partiyaga tiklash va `applyReplayStockMove` orqali jonli balansni yangilash).
  - `packages/db-local/src/return-repo.ts` (yangi): `SqliteReturnStore` (`voidSale`, `createReturn`, `getReturnById`, `listSaleReturns`, `querySalesLinesReport`, F3/T1.7 ilgaklari va test-only `onBeforeCommit` crash nuqtasi).
  - `packages/db-local/src/index.ts`, `packages/db-local/src/index.test.ts`, `packages/db-local/src/return.test.ts`.
- **Hub API (`apps/hub`):**
  - `apps/hub/src/error-handler.ts`: `SALE_ALREADY_VOIDED` (409), `SALE_HAS_RETURNS` (409), `FISCALIZED_SALE_CANNOT_VOID` (409), `RETURN_QTY_EXCEEDED` (409), `RETURN_PAYMENT_LIMIT_EXCEEDED` (409), `INSUFFICIENT_CASH_IN_DRAWER` (409), `SUPERVISOR_OVERRIDE_REQUIRED` (403).
  - `apps/hub/src/return-service.ts` & `apps/hub/src/return-routes.ts` & `apps/hub/src/server.ts`: HTTP marshrutlar, RBAC + supervisor PIN tekshiruvi, xavfsiz audit log (`sale.voided`, `return.created`).
  - `apps/hub/src/return.test.ts`.

---

### 2. Batafsil loyiha qarorlari

#### a) Bekor qilish (`voidSale`) va qaytarish (`createReturn`) farqi

- **`voidSale` qachon ruxsat etiladi?**
  1. Chek shu `organization_id` va `store_id` ga tegishli bo'lishi shart.
  2. Chek hali void qilinmagan bo'lishi (`voided_at_ms IS NULL`). Aks holda (idempotent replay bo'lmasa) `SALE_ALREADY_VOIDED` (409).
  3. Chek bo'yicha birorta ham qaytarish (`returns` qatori) bo'lmasligi shart. Agar kamida bitta qaytarish mavjud bo'lsa — `SALE_HAS_RETURNS` (409).
  4. **F3 fiskallashuv darvozasi (ilgak):** `return-repo.ts` ichida `assertSaleNotFiscalizedForVoidSync(session, sale)` ilgagi qo'yiladi. Hozir F1 da fiskal modul yo'qligi uchun `false` qaytaradi, F3 da esa `fiscal_docs` jadvalidan ushbu chekning fiskallashgan (`fiscalized` / operatorga ketgan) holatini tekshirib, agar fiskallashgan bo'lsa `FISCALIZED_SALE_CANNOT_VOID` bilan rad etadi (fiskallashgan chek faqat `createReturn` orqali qaytariladi).
  5. **Majburiy sabab:** `reason.trim().length >= 1` (1–500 belgi). `sales` jadvalida `chk_sales_void_pair` kuchaytiriladi: yoki `void_*` ustunlarining barchasi `NULL`, yoki barchasi `NOT NULL` va `length(trim(void_reason)) >= 1`.
  6. **Tasdiq:** Supervisor PIN yoki bevosita `owner`/`manager` sessiyasi (`f)` bandda).
- **Ikkinchi void rad etiladi:**
  - Domen/repo qatlami `sale.voidedAtMs !== null` ni tekshirib `SALE_ALREADY_VOIDED` qaytaradi (faqat xuddi shu `void_client_request_id` va bir xil `void_request_hash` bo'lsa idempotent replay qaytadi).
  - Baza darajasida `trg_sales_voided_monotone` (`WHEN OLD."voided_at_ms" IS NOT NULL`) va `trg_sales_immutable_core` (boshqa hech bir asosiy chek/summa/kassir ustunini o'zgartirishga yo'l qo'ymaydi) `ROLLBACK`/`ABORT` beradi.
  - Eslatma: `0008_void_return.sql` da `sales` jadvaliga `void_client_request_id`/`void_request_hash` va yangilangan `chk_sales_void_pair` qo'shilganda SQLite jadvalni qayta qurishi mumkin; shuning uchun `buildSaleMonotoneTriggersSql()` + `trg_sales_no_delete` migratsiya oxirida qayta qo'llanadi (`assertSaleMigrationsComplete` bilan tasdiqlanadi).
- **Void oqibatlari bitta `BEGIN IMMEDIATE` tranzaksiyasida:**
  1. `sales` qatori `updateMonotone(..., { eventType: 'sale.voided', ... })` orqali bir tomonlama yangilanadi (`local_outbox` ga `MONOTONE` hodisa tushadi).
  2. **Zaxira qaytadi (`FACT` `stock_moves`):** chek uchun yaratilgan barcha sotuv chiqimlari (`source_type = 'sale' AND source_id = sale.id`) aynan o'sha `batch_id`, `-qty_delta` va `-cost_value_delta` bilan kompensatsion `reason = 'return'` kirimi sifatida yoziladi (`stock_move.created` outbox'ga tushadi) va jonli balans yangilanadi (`c)` band).
  3. **Pul qaytadi (`FACT` `cash_moves`):** chekdagi naqd to'lov sof summasi (`cash.amount`, ya'ni `tendered - change` = shu chek bo'yicha kassa qutisiga kirgan sof naqd) uchun bitta `type = 'refund_cash_out'`, `amount_delta = -cashAmount`, `source_type = 'sale_void'`, `source_id = sale.id`, `device_id = ctx.uow.deviceId` yozuvi qo'shiladi (`cash_move.created` outbox'ga tushadi).
     - **Tur qarori:** alohida kassa turi qo'shmasdan mavjud `refund_cash_out` (`T1.5` da allaqachon `CASH_MOVE_OUTFLOW_TYPES` da bor) ishlatiladi; void va qaytarish esa `source_type` (`'sale_void'` vs `'return'`) orqali aniq ajratiladi. (Naqdsiz to'lovlar `cash_moves` ga yozilmagan va void/return da `cash_moves` yaratmaydi).
  4. `FACT` jadvallarda (`sale_lines`, `payments`, oldingi `stock_moves`, oldingi `cash_moves`) **hech qanday `UPDATE`/`DELETE` yo'q** — faqat kompensatsiya `FACT` qatorlari yoziladi.

#### b) Qaytarish hujjati (`returns`, `return_lines`, `return_payments` — hammasi `FACT`)

- **Jadvallar:**
  - `returns` (`FACT`, `store`): `sale_id -> sales(id)`, `return_no >= 1` (`UNIQUE(organization_id, device_id, return_no)`), `return_code`, `processed_by_user_id -> users(id)`, `override_approved_by_user_id -> users(id)`, `override_approved_at_ms`, `reason` (`length(trim(reason)) >= 1`), `client_request_id` (`UNIQUE(organization_id, client_request_id)`), `request_hash`, `total_refund`, `total_net_ex_vat`, `total_vat`, `cash_refund_amount`, `non_cash_refund_amount`, `debt_offset_amount` (`DEFAULT 0`), CHECKlar: `cash + non_cash + debt_offset = total_refund`, `total_net_ex_vat + total_vat = total_refund`.
  - `return_lines` (`FACT`, `store`): `return_id -> returns(id)`, `sale_id -> sales(id)`, `sale_line_id -> sale_lines(id)`, `sort_order >= 0`, `line_kind`, `product_id`, `variant_id`, `item_name`, `unit`, `qty > 0` (`dona`/`qadoq` uchun `qty % 1000 = 0`), `unit_price_snapshot`, `vat_rate_bp_snapshot`, `mxik_snapshot`, `package_code_snapshot`, `refund_amount`, `net_ex_vat`, `vat_total`, `cost_value`. `UNIQUE(return_id, sale_line_id)` — bir hujjatda bir chek qatori takrorlanmaydi. CHECK: `net_ex_vat + vat_total = refund_amount`.
  - `return_payments` (`FACT`, `store`): `return_id -> returns(id)`, `sale_id -> sales(id)`, `method`, `amount > 0`, `provider_ref`.
  - Barcha uchala jadvalda `BEFORE UPDATE` va `BEFORE DELETE` `FACT` triggerlari qo'yiladi.
- **Qaytarish raqami qarori:**
  - **Tanlov:** `local_device_state` da alohida `last_return_seq` (`DEFAULT 0`) ustuni ochiladi va `advanceReturnSeqSync` bilan boshqariladi (`RET-<deviceShort>-<000001>`).
  - **Sabab:**
    1) Oddiy savdo cheklari `receipt_no` ketma-ketligi (`1, 2, 3...`) qaytarishlar bilan aralashib ketmaydi; kunlik sotuv cheklar sonini tekshirish oson qoladi.
    2) F3 da fiskal qaytarish hujjati ham alohida fiskal hujjat turi sifatida ketadi — o'z lokal tartib raqamiga ega bo'lishi kassa va fiskal jurnalni toza ajratadi.
    3) `BEGIN IMMEDIATE` ichida oshirilgani uchun rollback/crash bo'lsa raqam yo'qolmaydi.
- **Qaytariladigan miqdor chegarasi:**
  - `BEGIN IMMEDIATE` ichida `prevReturnedQty = COALESCE(SUM(qty), 0)` (`return_lines` dan `sale_line_id` bo'yicha) hisoblanadi va `remainingQty = saleLine.qty - prevReturnedQty` bilan solishtiriladi.
  - `requestQty > remainingQty` bo'lsa `RETURN_QTY_EXCEEDED` (409) tashlanadi. Shu bois parallel qaytarishlarda SQLite yozish qulfi ikkinchi so'rovni ketma-ket navbatga qo'yadi va birinchisi tugagandan keyin ikkinchisi yangilangan qoldiqni ko'rib rad etadi.
- **Asl chekdan kumulyativ summa, QQS va tannarx:**
  - Asos: `sale_lines` dagi `final_total` (barcha aksiya va taqsimlangan chegirma hisobga olingan yakuniy summa), `vat_total`, `net_ex_vat` va `cost_value`.
  - `prevQty = prevReturnedQty`, `nextQty = prevQty + requestQty`, `Q = saleLine.qty`:
    - `cumRefund(q) = divideRoundHalfAwayFromZero(saleLine.finalTotal * q, Q)` -> `refundAmount = cumRefund(nextQty) - cumRefund(prevQty)` (shuning uchun $\sum \text{refundAmount}_k \equiv \text{saleLine.finalTotal}$).
    - `cumCost(q) = divideRoundHalfAwayFromZero(saleLine.costValue * q, Q)` -> `costValue = cumCost(nextQty) - cumCost(prevQty)` ($\sum \text{costValue}_k \equiv \text{saleLine.costValue}$).
    - **QQS va `netExVat` invariantini bir vaqtda saqlash:** Ba'zi kam uchraydigan kasr nisbatlarda mustaqil kumulyativ delta `vatRawDelta` `refundAmount` dan 1 tiyinga katta bo'lib `netExVat = refundAmount - vatDelta < 0` chiqib qolishi mumkin (masalan `final=10, vat=9, Q=4`). Shuning uchun `vatTotal` ni kumulyativ qiymat `round(line.vatTotal * nextQty / Q)` ga nisbatan matematik jihatdan doim bo'sh bo'lmagan $[L, U]$ oraliqda (`L = max(prevVat, cumRefund(nextQty) - line.netExVat)`, `U = min(line.vatTotal, cumRefund(nextQty) - prevNet)`) clamp qilamiz va `vatTotal = cumVatNext - prevVat`, `netExVat = refundAmount - vatTotal` olamiz.
    - Natija: har qanday tasodifiy bo'linishda (1) $0 \le \text{vatTotal}, 0 \le \text{netExVat}$, (2) $\text{netExVat} + \text{vatTotal} = \text{refundAmount}$, (3) barcha qisman qaytarishlar jami `final_total`, `vat_total` va `net_ex_vat` ga **aniq tiyinigacha teng**! Bu `fast-check` bilan isbotlanadi.

#### c) Ombor

- **Tanlov: Variant 1 (asl sotuvning tannarxi va asl partiyalariga proporsional tiklash).**
- **Sabablari:**
  1. FIFO partiyali tovarda (ayniqsa yaroqlilik muddatli mahsulotlarda) mijozga berilgan tovar qaysi partiyadan va qaysi tannarx bilan chiqqan bo'lsa, o'sha `batch_id` ga qaytishi muddat nazorati va FIFO ketma-ketligini buzmaydi (`Variant 2` esa asl muddatni yo'qotib ortiqcha sun'iy partiyalar ko'paytiradi).
  2. Chek to'liq qaytarilganda yoki void qilinganda ombor qiymati (`totalValue`) va partiya qoldig'i aynan sotuvdan oldingi holatga qaytadi.
- **Amalga oshirish mexanizmi (`applyReturnStockMoveSync`):**
  - `stock_moves` da `chk_stock_moves_source_type` allaqachon `'return'` ni ruxsat etadi; shuning uchun `stock_moves` `FACT` jadvalini migratsiyada qayta qurishga hojat qolmaydi (`voidSale` uchun `sourceType = 'return', sourceId = sale.id`; `createReturn` uchun `sourceType = 'return', sourceId = returnId` — UUIDv7 lar hech qachon to'qnashmaydi).
  - **Void** da: `stock_moves WHERE source_type = 'sale' AND source_id = sale.id` dagi har bir oyoqcha (`move`) uchun exact teskari `qty = -move.qtyDelta`, `costValue = -move.costValueDelta`, `batchId = move.batchId` bilan kirim yoziladi.
  - **Qisman qaytarish** da: chekdagi shu `sale_line` ga mos sotuv chiqim oyoqchalari (`stock_moves` `id ASC` bo'yicha; agar bir chekda bir xil `(productId, variantId)` ikki satr bo'lsa, `sort_order` bo'yicha deterministik bo'lib beriladi) bo'ylab `[prevQty .. prevQty + requestQty]` kesimi proporsional kumulyativ formulada oyoqchalarga taqsimlanadi, har bir tegilgan `origMove.batchId` ga o'z ulushi bilan kirim yoziladi (`sum(legs.qty) === line.qty`, `sum(legs.cost) === line.costValue`).
  - **Mavjud partiya vs partiyasiz kamomad oyoqchasi:**
    - Agar `origMove.batchId !== null`: yangi `batches` qatori ochilmaydi; `applyReturnStockMoveSync` xuddi `applyReplayStockMove` (`packages/domain/src/stock.ts:482-498`) kabi mavjud `local_batch_balances` ga (`remainingQty`, `remainingValue`) tiklaydi.
    - Agar `trackBatches === true && origMove.batchId === null` (`warn` rejimda kamomaddan partiyasiz sotilgan oyoqcha): `netQty > 0` holatda qoldiq FIFO'dan tashqarida osilib qolmasligi uchun **faqat shu holda** zaxira qaytarish partiyasi (`batches` `FACT`, `batchNumber = 'RET-...'`, `expiryDateMs = null`) ochiladi va `stock_move.batch_id` unga bog'lanadi (`netQty = 0` bo'lsa ham `local_batch_balances` da `remainingQty = 0` bo'lib qoladi).
  - **Kamomaddagi tovar qaytarilganda (`deficitQty > 0`):**
    - `applyReturnStockMoveSync` to'g'ridan-to'g'ri `packages/domain/src/stock.ts` dagi `applyReplayStockMove` ni chaqiradi (`rebuildStockProjections()` bilan bitta funksiya!):
      - Qaytgan `qty` avval `deficitQty` ni qoplaydi (`coverQty`), `provisionalDeficitValue` va `costVarianceValue` ni mos ravishda yopadi/sozlaydi;
      - Ortgan `netQty` va `netVal` haqiqiy qoldiq (`qtyOnHand`, `totalValue`) hamda tegishli partiyaga qo'shiladi;
      - `reason = 'return'` uchun `valTiyin = 0n` bo'lsa ham `UNKNOWN_COST_SURPLUS` konflikti chiqmaydi.
    - Natija: jonli `local_stock_balances` / `local_batch_balances` har qadamda `rebuildStockProjections()` bilan **100% bir xil** (T1.5 B1 differensial testi bilan isbotlanadi).

#### d) Pulni qaytarish

- **Usullar jami:** `SUM(return_payments.amount) + debtOffsetAmount = return.totalRefund` (T1.6 da `debtOffsetAmount = 0n`).
- **Har bir usul chegarasi (kross-usul taqiqi):**
  - **Qaror:** Naqd to'langan chekka karta (yoki boshqa to'lov turi) bilan qaytarishga **RUXSAT BERILMAYDI** (va aksincha). Har bir usul $m$ uchun maksimal limit:
    `limit(m) = originalPaid(sale, m) − priorReturned(sale, m)`.
  - **Sabab:** Naqd pul intizomi, ekvayring/to'lov provayderlari mosligi va naqdlashtirish/aylanma suiiste'mollarni oldini olish uchun mijoz qaysi usulda to'lagan bo'lsa, faqat o'sha usul limiti doirasida qaytariladi.
- **Naqd qaytarish va terminal kassa qutisi:**
  - `method = 'cash'` ulushi shu terminal (`ctx.uow.deviceId`) bo'yicha `cash_moves` ga `type = 'refund_cash_out'`, `amount_delta = -cashRefundAmount`, `source_type = 'return'` (`createReturn`) yoki `'sale_void'` (`voidSale`) bo'lib yoziladi.
  - **Qaror: Terminalda naqd yetmasa:** `getCashDrawerBalanceSync(...) < cashRefundAmount` bo'lsa tranzaksiya **QAT'IY RAD ETILADI (`INSUFFICIENT_CASH_IN_DRAWER`, 409)**.
  - **Sabab:** Kassada jismonan mavjud bo'lmagan naqd pulni berib bo'lmaydi; manfiy kassa qoldig'i kassa daftari (`cash_moves`) va smena (`T1.9`) hisobini buzadi (agar kassa inkassatsiya qilingan bo'lsa, avval kassa kirim operatsiyasi qilinishi kerak).
- **Qarzdan ayirish ilgagi (T1.7 ulanish nuqtasi):**
  - `returns` jadvalida `debt_offset_amount` (`DEFAULT 0`), kontraktdagi ixtiyoriy `debtOffsetAmount` va `return-repo.ts` ichidagi `applyReturnDebtOffsetHookSync` ilgagi tayyorlanadi.
  - Hozir T1.6 da `debtOffsetAmount > 0n` yoki `sale.debtAmount > 0n` bo'lsa `CUSTOMER_REQUIRED` bilan rad etiladi; T1.7 da shu ilgak `customer_ledger` ga mijoz qarzini kamaytiruvchi `FACT` yozuvini aynan shu tranzaksiya ichida qo'shadi va `limit(paid)` faqat haqiqatda to'langan qismni (`totalPaid - priorPaidRefunds`) qaytarishga cheklaydi.

#### e) `v_sales_lines` va hisobotlar

- **Ko'rinish dizayni (`CREATE VIEW "v_sales_lines"`):**
  - **Qaror: Void qilingan cheklar (`sales.voided_at_ms IS NOT NULL`) `v_sales_lines` dan chiqarib tashlanadi (`WHERE s.voided_at_ms IS NULL`), faqat haqiqiy sotuv qatorlari (`+1`) va qaytarish qatorlari (`-1`) birlashtiriladi (`UNION ALL`).**
  - **Sabab:** Void qilingan chek bekor hisoblanadi; agar uni `+` va `−` juft qator bilan chiqarsak, sana/smena filtrlari (masalan kecha urilib bugun void bo'lgan chek), sotilgan chek/qator soni va o'rtacha chek hisoblari buziladi. Void bo'lgan chekka qaytarish bo'la olmasligi sababli `WHERE s.voided_at_ms IS NULL` hech qachon etim qaytarish qatorini qoldirmaydi; voidlar auditi esa `sales` jadvalining o'zidan o'qiladi.
  - **Ustunlar:** `organization_id`, `store_id`, `device_id`, `record_kind` (`'sale'` | `'return'`), `event_at_ms`, `document_id`, `sale_id`, `sale_line_id`, `return_id`, `product_id`, `variant_id`, `category_id_snapshot`, `item_name`, `unit`, `sign` (`1` | `-1`), `signed_qty`, `signed_final_total`, `signed_net_ex_vat`, `signed_vat_total`, `signed_cost_value`.
- **Hisobotlar va model testi:**
  - `querySalesLinesReport` faqat `v_sales_lines` dan jamlab `revenue` (`SUM(signed_final_total)`), `netRevenue` (`SUM(signed_net_ex_vat)`), `vatTotal` (`SUM(signed_vat_total)`), `costValue` (`SUM(signed_cost_value)`), `grossProfit` (`SUM(signed_net_ex_vat) - SUM(signed_cost_value)`) qaytaradi.
  - Tasodifiy sotuvlar (aksiya, chegirma, QQS, tez savdo, FIFO), qisman qaytarishlar va voidlar ketma-ketligida `v_sales_lines` natijasi mustaqil TypeScript hisoblash modeli bilan **tiyinigacha teng** bo'lishi test qilinadi.

#### f) Idempotentlik, RBAC va audit

- **Idempotentlik (`clientRequestId` + SHA-256 `request_hash`):**
  - `voidSale`: `sales` jadvalidagi `void_client_request_id` (`UNIQUE(organization_id, void_client_request_id) WHERE void_client_request_id IS NOT NULL`) va `void_request_hash` (`canonical({ saleId, reason })`). Takror so'rovda bir xil hash -> `idempotentReplay: true` (`200`), boshqa payload/chek -> `409 IDEMPOTENCY_CONFLICT`.
  - `createReturn`: `returns` jadvalidagi `UNIQUE(organization_id, client_request_id)` va `request_hash` (`canonical({ saleId, reason, items, payments, debtOffsetAmount })`). Takror so'rovda bir xil hash -> `idempotentReplay: true` (`200`), boshqa payload -> `409 IDEMPOTENCY_CONFLICT`.
  - Eslatma: Supervisor PIN/`override` maydonlari `request_hash` ga kiritilmaydi.
- **RBAC qarori:**
  - `owner` va `manager`: `sale:void` va `sale:return` huquqiga ega (bevosita `override` siz ham bajara oladi).
  - `cashier`: mustaqil ravishda na void, na qaytarish qila olmaydi — **faqat supervisor (`owner` yoki `manager`) PIN tasdig'i (`override: { username, pin }`)** orqali ruxsat beriladi (`authService.verifySupervisorPin`, kassir PIN'i `403 AUTH_FORBIDDEN`, 5 xato PIN da `T0.6` blokirovkasi ishlaydi).
  - `reports:profit` (`v_sales_lines` tannarx va foyda): **faqat `owner`** (`cashier` va `manager` javoblarida `costValue` va foyda mutlaqo bo'lmaydi).
- **Sabab va Audit log:**
  - `reason` majburiy (trim qilinganda bo'sh emas).
  - Strukturali Pino audit loglari (`sale.voided`, `return.created`): `organizationId`, `storeId`, `saleId`, (`returnId`, `returnCode`), `actorUserId`, `overrideApprovedByUserId`, summa va usullar qayd etiladi; **PIN, parol, token, `costValue` va foyda logga ham, kassir DTO'siga ham umuman tushmaydi**.

---

### 3. Qabul mezonlari uchun rejalashtirilgan testlar (`g`)

1. **Kumulyativ yaxlitlash property testi (`@mezon/domain`, `fast-check`):** tasodifiy `finalTotal`, `vatTotal`, `costValue`, `qty` va ketma-ket qisman bo'linishlarda yig'indi qat'iy teng, `netExVat >= 0`, `vatTotal >= 0`.
2. **Ortiqcha / ikki marta qaytarish:** to'liq qaytarilgan qatorni qayta qaytarish yoki qolgan miqdordan `0.001` ortiq so'rash -> `RETURN_QTY_EXCEEDED` (409).
3. **Qaytarishi bor chekni void qilish:** qisman qaytarilgandan keyin `voidSale` -> `SALE_HAS_RETURNS` (409), chek void bo'lmaydi.
4. **Void qilingan chekni qaytarish va qayta void:** void qilingan chekka `createReturn` -> `SALE_ALREADY_VOIDED` (409); ikkinchi boshqa so'rovli `voidSale` -> `SALE_ALREADY_VOIDED` (409); xom SQL `UPDATE sales` -> SQLite trigger `ABORT`.
5. **Parallel qisman qaytarishlar:** bir chekka bir vaqtda ikki parallel `createReturn` (jami qoldiqdan oshadigan) -> biri muvaffaqiyatli, ikkinchisi `RETURN_QTY_EXCEEDED`, umumiy qaytgan miqdor hech qachon sotilgandan oshmaydi.
6. **Child process crash safety (`C1`):** `onBeforeCommit` test hooki bilan haqiqiy child process `SIGKILL` (void uchun ham, qaytarish uchun ham) -> restartdan keyin yarim yozuvlar, `last_return_seq` yoki `last_device_seq` bo'shliqlari yo'q.
7. **Ombor differensial testi (B1 usuli):** FIFO partiyali, o'rtacha va kamomad (`warn`) tovarlarda sotuv -> qaytarish -> void ketma-ketligida jonli balans `rebuildStockProjections()` bilan har qadamda teng.
8. **Pul va kassa chegaralari:** kross-usul qaytarish rad etilishi, kassa qutisida naqd yetmaganda `INSUFFICIENT_CASH_IN_DRAWER`, T1.7 qarz ilgagi rad etishi.
9. **`v_sales_lines` model testi:** tasodifiy sotuv, qisman qaytarish va void ketma-ketligida `v_sales_lines` dan olingan tushum, QQS, tannarx va foyda mustaqil model bilan tiyinigacha teng.
10. **Hub RBAC / Idempotency / Audit E2E (`apps/hub`):** kassir supervisor PIN'isiz `403`, kassir o'z PIN'i bilan `403`, 5 xato supervisor PIN lockout, manager/owner bevosita o'tadi, `409 IDEMPOTENCY_CONFLICT`, javoblarda va audit logda PIN/token/tannarx/foyda sizmasligi.

---

### 4. Doiradan tashqari (`h`)

- Fiskal qaytarish cheki va OFD integratsiyasi (`F3`; hozir faqat `assertSaleNotFiscalizedForVoidSync` ilgagi va alohida `last_return_seq` qoldiriladi).
- Mijoz qarzidan ayirish va qarzli chekni qaytarish/void (`T1.7`; hozir `debt_offset_amount` ustuni va `applyReturnDebtOffsetHookSync` ilgagi qoldiriladi).
- Smena va kun yakuni (`T1.9`), chek chop etish (`T1.12`) va POS UI (`T1.11`).
