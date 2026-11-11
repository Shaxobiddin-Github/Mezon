## Reja: T1.9 — Smena va kun yakuni

Branch: `gemini/T1.9-shifts` (asos: `main` = `1cd0286`)
T1.8 merge commit SHA: `1cd0286503cd634baff21e4e630f2f63570db7cb` (`PR #15`, `gemini/T1.8-suppliers-receiving` o'chirildi)

> **Ish tartibi (1-commit va 2-bosqich):**
> 1. Reja tasdiqlangach, **birinchi alohida commit** faqat `T1.8 test qarzi: qaytarish chegaralari` (1 milli chegara testlari + ikkala mutatsiya isboti) bilan bajariladi.
> 2. Keyingi commit(lar) da T1.9 funksionalligi va testlari amalga oshiriladi.

---

### 0. T1.8 test qarzi rejasi (1-commit)

- **Fayllar:** `packages/db-local/src/supplier.test.ts` (hamda kerak bo'lsa `supplier-repo.ts` / `stock-repo.ts` mutatsiya tekshiruvi).
- **1. Ortiqcha qaytarish — 1 milli chegara (`supplier-repo.ts`):**
  - `kg` o'lchovli tovar `2.000` (`2000n`) kirim -> avval `1.500` (`1500n`) qaytariladi -> so'ng `0.500` (`500n`) muvaffaqiyatli o'tadi -> keyin `0.001` (`1n`) `SUPPLIER_RETURN_QTY_EXCEEDED` bilan rad etiladi.
  - Alohida holat: `1.500` qaytarilgandan keyin `0.501` (`501n`) darhol `SUPPLIER_RETURN_QTY_EXCEEDED` bilan rad etiladi (DB yozuvi `0`).
  - Mutatsiya isboti: `supplier-repo.ts` dagi `quantityToMilli(validQty) > maxRemainingMilli` ni `> maxRemainingMilli + 1n` ga o'zgartirganda ikkala chegara testi yiqilishi isbotlanadi va tiklanadi.
- **2. Partiya tugashi — 1 milli chegara (`stock-repo.ts`):**
  - FIFO partiya `2.000` (`2000n`), shundan `0.700` (`700n`) sotilgan, `1.300` (`1300n`) qolgan.
  - `1.301` (`1301n`) qaytarish `SUPPLIER_RETURN_BATCH_DEPLETED` bilan rad etiladi (`0` DB o'zgarish); `1.300` (`1300n`) qaytarish esa muvaffaqiyatli o'tadi.
  - Mutatsiya isboti: `stock-repo.ts` dagi `batchAvailMilli < retMilli` ni `batchAvailMilli + 1n < retMilli` ga o'zgartirganda chegara testi yiqilishi isbotlanadi va tiklanadi.

---

### 1. T1.9 Smena modeli (`a`)

- **Terminal bog'liqligi (`device_id`):** Kassa qutisi terminalniki bo'lgani uchun smena `(organization_id, store_id, device_id)` ga bog'lanadi.
- **Yagona ochiq smena kafolati:** SQLite partial unique index `uidx_shifts_one_open_per_device` ON `shifts (organization_id, device_id) WHERE status = 'open'` — bitta terminalda bir vaqtda faqat 1 ta ochiq smena bo'lishini DB darajasida majburlaydi; ikki terminal (`device_id_1`, `device_id_2`) bir vaqtda mustaqil smena yurita oladi.
- **Ketma-ket smena raqami:** `local_device_state.last_shift_seq` ustuni qo'shiladi; tranzaksiya ichida `advanceShiftSeqSync` orqali bo'shliqsiz `shift_no` va `shift_code` (`SHF-<last4>-<000001>`) beriladi.
- **Jadvallar va sinflar (`0011_shifts_day_close.sql`):**
  1. `shifts` (**MONOTONE**, store-scoped):
     - O'zgarmas ochilish maydonlari: `shiftNo`, `shiftCode`, `openedByUserId`, `openedAtMs`, `openingCash`, `prevShiftCloseCash` (oldingi yopiq smenaning oxirgi `countedCash` qiymati, bo'lmasa `null`), `openingDiscrepancy` (`openingCash - prevShiftCloseCash` yoki `0n`), `openingDiscrepancyReason`, `openClientRequestId`, `openRequestHash`.
     - Bir tomonlama o'tish (`open` -> `closed`): `status`, `closedByUserId`, `closedAtMs`, `closeClientRequestId`, `closeRequestHash`.
     - Triggerlar (`trg_shifts_closed_monotone`, `trg_shifts_immutable_open`): `status = 'closed'` bo'lgach har qanday `UPDATE`/`DELETE` bloklanadi; `status = 'open'` da esa faqat bir martalik `open -> closed` o'tishiga ruxsat beriladi.
  2. `shift_cashier_sessions` (**MONOTONE**, store-scoped):
     - *"Ikki kassir farqi ajraladi"* mezoni uchun bitta smena ichida bir nechta kassir ketma-ket ishlay oladi (istalgan payt smenada ko'pi bilan 1 ta aktiv sessiya: `UNIQUE(shift_id) WHERE status = 'active'`).
     - Maydonlar: `shiftId`, `cashierUserId`, `sessionSeq` (1, 2, ...), `status` (`active` -> `closed`), `openedAtMs`, `closedAtMs`, `openingFloat`, `expectedCash`, `countedCash`, `discrepancy`, `discrepancyReason`, `handoffApprovedByUserId`.
     - Kassir almashish (`handoffCashier`): joriy kassir qo'l sanog'i (`countedCash`) ni kiritib o'z sessiyasini yopadi -> o'zining `expectedCash` va `discrepancy` si alohida qayd etiladi; keyingi kassir esa topshirilgan naqddan yangi aktiv sessiya boshlaydi. Smena yopilganda (`closeShift`) qolgan aktiv kassir sessiyasi avtomatik yakunlanadi.
  3. `shift_closures` (**FACT**, store-scoped, append-only):
     - Har bir yopilish va **qayta yopish** uchun alohida o'zgarmas snapshot yozuvi: `shiftId`, `closureSeq` (`1, 2, ...`, `UNIQUE(shift_id, closure_seq)`), `isReclose` (`boolean`), `supersedesClosureId` (avvalgi `shift_closures.id` ga FK), `closedByUserId`, `closedAtMs`, `periodStartMs`, `periodEndMs`, `salesCount`, `returnsCount`, `voidsCount`, `grossSalesTotal`, `returnsTotal`, `netSalesTotal`, `expectedCash`, `countedCash`, `discrepancy`, `discrepancyReason`, `overrideApprovedByUserId`, `clientRequestId`, `requestHash`.
     - Qayta yopishda eski `shift_closures` qatorlari o'chirilmaydi va tahrirlanmaydi (`FACT` triggerlar to'sadi); yangi `closureSeq = prev + 1` yoziladi.
  4. `shift_closure_method_totals` (**FACT**, store-scoped): har bir `closureId` uchun to'lov usuli bo'yicha (`cash`, `card`, `uzqr`, `payme`, `click`, `uzum`, `social_card`, `other`, `debt`) `salesAmount`, `returnsAmount`, `netAmount` qatorlari (`UNIQUE(closure_id, method)`).
  5. `shift_closure_cashiers` (**FACT**, store-scoped): har bir `closureId` uchun shu smenada qatnashgan har bir kassir kesimidagi muzlatilgan snapshot (`cashierSessionId`, `cashierUserId`, `salesCount`, `returnsCount`, `salesTotal`, `returnsTotal`, `cashInTotal`, `cashOutTotal`, `openingFloat`, `expectedCash`, `countedCash`, `discrepancy`).
  6. `day_closes` (**FACT**, store-scoped): Kun yakuni (Z-hisobot qobig'i). `businessDate` (`YYYY-MM-DD`), `closeSeq`, `closedByUserId`, `closedAtMs`, `shiftCount`, `salesCount`, `returnsCount`, `netSalesTotal`, `totalExpectedCash`, `totalCountedCash`, `totalDiscrepancy`, `methodTotalsJson`, hamda F3 uchun bo'sh `fiscalZReportNo`, `fiscalSubmittedAtMs`, `fiscalStatus` (`'not_fiscalized'`) maydonlari (`clientRequestId` + `requestHash` idempotent).

---

### 2. Smenaga bog'lash, DB himoyasi va V1 toraytirish (`b`)

- **Jadvallarni yangilash (`0011_shifts_day_close.sql`):**
  - `sales.shift_id` va `cash_moves.shift_id` allaqachon mavjud; indekslar (`idx_sales_shift_id`, `idx_cash_moves_shift_id`) qo'shiladi/tekshiriladi.
  - `returns` jadvaliga `shift_id` (`sqliteUuidV7('shift_id')`, indeksi bilan) qo'shiladi; eski test/upgrade qatorlari `NULL` qoladi.
  - `v_sales_lines` ko'rinishi qayta yaratilib, har ikkala `UNION ALL` bo'lagiga `shift_id` ustuni qo'shiladi (`s."shift_id"` va `r."shift_id"`).
- **Ochiq smena majburiyligi (`409 SHIFT_NOT_OPEN`):**
  - `completeSale`, `voidSale`, `createReturn`, `customerStore.recordDebtPayment`, `supplierStore.recordPayment(..., method: 'cash')` hamda barcha kassa amallari (`cash_in`, `cash_out`, `encashment`) joriy terminal (`deviceId`) da aktiv (`status = 'open'`) smena bo'lishini talab qiladi (`SHIFT_NOT_OPEN`), va barcha yangi yozuvlarga (`sales`, `returns`, `cash_moves`) aktiv `shift_id` yoziladi.
  - Naqdsiz (`card`, `uzqr` va h.k.) ta'minotchi to'lovlari hamda ombor/katalog operatsiyalari (`postReceiving`, `confirmReceivingLineCost`, `createSupplierReturn`, `adjustStock`) kassa qutisiga tegmagani uchun smenasiz ham ishlaydi.
- **Yopilgan smenaga yozishni DB darajasida to'sish:**
  - `sales`, `returns` va `cash_moves` ga `BEFORE INSERT` SQLite triggerlari qo'yiladi: `WHEN NEW."shift_id" IS NOT NULL AND EXISTS (SELECT 1 FROM "shifts" s WHERE s."id" = NEW."shift_id" AND s."status" <> 'open')` -> `RAISE(ABORT, ...)`.
- **V1 void toraytirish (`return-repo.ts`):**
  - `voidSale` endi nafaqat bir xil biznes kunini, balki **asl chekning `sale.shiftId` si joriy ochiq smena (`currentOpenShift.id`) ga teng bo'lishini** tekshiradi. Agar chek yopiq (yoki smenasiz eski) smenaga tegishli bo'lsa, `voidSale` rad etiladi (`SHIFT_ALREADY_CLOSED` `409`), qaytarish faqat `createReturn` orqali (yangi ochiq smenaga yozilib) amalga oshiriladi.
- **Mavjud testlarni moslashtirish:** `T1.4` (`sale.test.ts`), `T1.6` (`return.test.ts`), `T1.7` (`customer.test.ts`), `T1.8` (`supplier.test.ts`) va `apps/hub` dagi mos test helperlariga boshlang'ich `openShift` chaqiruvi qo'shiladi (eski mantiqqa smenasiz chek/harakat rad etilishi ham alohida test sifatida tekshiriladi).

---

### 3. Kutilgan summalar, naqdsiz avtomatika va farq (`c`)

- **Joriy quti qoldig'i va kutilgan naqd (`expectedCash`):**
  - `shifts.opening_cash` smena ochilganda qutidagi boshlang'ich sanoqni saqlaydi (`cash_moves` ga ikkilamchi `cash_in` qilib yozilmaydi, aks holda avvalgi smenalardan o'tgan balans ikki marta sanaladi).
  - Smena ichidagi kutilgan naqd: `expectedCash = shift.openingCash + SUM(cash_moves.amount_delta WHERE shift_id = shift.id)`.
  - Kassadan chiqim tekshiruvi (`refund_cash_out`, `supplier_payment_out`, `cash_out`, `encashment`): joriy smena qutisidagi mavjud naqd `shift.openingCash + SUM(cash_moves WHERE shift_id = shift.id)` (yoki smenasiz testlar mavjud bo'lmagani uchun aynan shu smena qoldig'i) bilan tekshiriladi; yetmasa `409 INSUFFICIENT_CASH_IN_DRAWER`.
- **Naqdsiz summalar — mutlaqo avtomatik (mezon):**
  - `payments` (`cash` hamda barcha naqdsiz usullar bo'yicha, faqat `sales.voided_at_ms IS NULL`) va `return_payments` (`returns.shift_id = ?`) jadvallaridan `GROUP BY method` bilan hisoblanadi; `change_amount` chegirilgan sof tushum (`amount - changeAmount` yoki naqdsizlarda `changeAmount = 0`).
  - `CloseShiftRequestSchema`, `RecloseShiftRequestSchema` va `HandoffCashierRequestSchema` larda **naqdsiz summa maydoni umuman yo'q** va `z.strictObject` noma'lum maydonlarni (`cardTotal`, `nonCashTotals`, va h.k.) `400` bilan rad etadi (maxsus test bilan isbotlanadi).
- **Sanoq, kupyuralar va katta farqda supervisor PIN:**
  - Kassir/menejer `countedCash` (va ixtiyoriy `denominations?: { nominal: bigint, qty: number }[]`, yig'indisi `countedCash` ga teng bo'lishi shart) kiritadi.
  - `discrepancy = countedCash - expectedCash`.
  - `discrepancy !== 0n` bo'lsa `reason` majburiy.
  - `abs(discrepancy) > maxCashDiscrepancyWithoutOverride` (`local_hub_config`, standart `50_000n` tiyin = 500 so'm) bo'lsa, `owner`/`manager` supervisor PIN tasdig'i (`SUPERVISOR_OVERRIDE_REQUIRED`, T0.6 lockout bilan) majburiy.

---

### 4. Xarajat, inkassatsiya va kassaga kirim (`d`)

- Mavjud `cash_moves` turlaridan foydalaniladi: `cash_in` (`+`), `cash_out` (`-`, xarajat sababi va kategoriyasi: `'supplies' | 'utilities' | 'transport' | 'repair' | 'salary_advance' | 'other'`), `encashment` (`-`, inkassatsiya).
- **RBAC:**
  - Yangi ruxsatlar (`packages/domain/src/auth.ts`):
    - `shifts:read`, `shifts:open`, `shifts:close`: `owner`, `manager`, `cashier`
    - `shifts:reclose`: faqat `owner`, `manager` (`cashier` -> 403)
    - `shifts:cash_move` (`cash_in`, `cash_out`, `encashment`): faqat `owner`, `manager` (`cashier` -> 403, yoki supervisor PIN bilan? Qat'iy va tushunarli qoidaga ko'ra `owner` va `manager` ruxsatli; kassirdan `403 AUTH_FORBIDDEN` qaytadi).
    - `day_close:execute`: faqat `owner`, `manager` (`cashier` -> 403).
- Manfiy balans himoyasi: `cash_out` va `encashment` joriy smena naqdidan oshsa `409 INSUFFICIENT_CASH_IN_DRAWER` qaytaradi.

---

### 5. Yopish, qayta yopish, kun yakuni, model testi va unumdorlik (`e–g`)

- **Tezkor agregat yopish (1,000 chekli smena `<= 500 ms` — mezon `g`):**
  - `closeShift` va `recloseShift` bitta tranzaksiyada (`better-sqlite3` tayyorlangan SQL agregatlar bilan) ishlaydi:
    - `SELECT method, SUM(amount - change_amount) ... FROM payments p INNER JOIN sales s ... WHERE s.shift_id = ? AND s.voided_at_ms IS NULL GROUP BY p.method`
    - `SELECT rp.method, SUM(rp.amount) ... FROM return_payments rp INNER JOIN returns r ... WHERE r.shift_id = ? GROUP BY rp.method`
    - `SELECT SUM(signed_final_total), ... FROM v_sales_lines WHERE organization_id = ? AND store_id = ? AND shift_id = ?`
    - `SELECT type, created_by_user_id, SUM(amount_delta) ... FROM cash_moves WHERE shift_id = ? GROUP BY type, created_by_user_id`
    - Bitta chek qatorlarini xotiraga yuklamasdan ~5 ta indekslangan agregat so'rov bilan 1,000+ chekli smenani `< 50 ms` da yopadi (benchmark test bilan `<= 500 ms` isbotlanadi).
- **Idempotentlik (`clientRequestId` + `requestHash`):**
  - `openShift`, `handoffCashier`, `closeShift`, `recloseShift`, `recordShiftCashMove`, `closeBusinessDay` hammasida qo'llaniladi (`idempotentReplay: true` / `409 IDEMPOTENCY_CONFLICT`).
- **Model testi (`>= 240` qadam, seed'li — mezon `f`):**
  - 2 ta parallel terminal (`device_id_1`, `device_id_2`), 3 ta foydalanuvchi (`owner`, `cashier1`, `cashier2`):
    - smena ochish, kassir almashish (`handoff`), naqd va aralash (`cash + card + uzqr`) savdo, to'liq/qisman qaytarish, void (ochiq smenada o'tadi, yopilganda rad etiladi), qarz to'lovi, ta'minotchiga naqd to'lov, `cash_in`, `cash_out`, `encashment`, smena yopish, qayta yopish (`reclose`), kun yakuni (`closeBusinessDay`).
    - Salbiy tekshiruvlar: smenasiz savdo/qaytarish (`SHIFT_NOT_OPEN`), ikkinchi ochiq smena (`SHIFT_ALREADY_OPEN`), yopiq smenaga yozish (`DB trigger` & domen), naqdsiz qo'lda kiritish (`400`), kassa yetmasligi (`409`).
    - Har bir `handoff`, `closeShift`, `recloseShift` va `closeBusinessDay` da kutilgan naqd, usullar bo'yicha summalar (`payments - return_payments`), `v_sales_lines` jami va har bir kassir kesimi mustaqil xotiradagi model bilan tiyinigacha tengligi tekshiriladi; ikki terminal kesishmasligi tasdiqlanadi.

---

### 6. Rejalashtirilgan fayllar ro'yxati

1. **Test qarzi commit:** `packages/db-local/src/supplier.test.ts` (va mutatsiya dalili).
2. **`@mezon/domain`:** `errors.ts`, `auth.ts`, `shift.ts` (smena holat mashinasi, kutilgan naqd/kassir/usullar hisobi, farq va kun yakuni sof funksiyalari, kanonik hashlar, property testlar), `shift.test.ts`, `index.ts`.
3. **`@mezon/contracts`:** `shift.ts` (`OpenShiftRequestSchema`, `HandoffCashierRequestSchema`, `CloseShiftRequestSchema`, `RecloseShiftRequestSchema`, `CreateShiftCashMoveRequestSchema`, `CloseBusinessDayRequestSchema` — naqdsiz qo'lda maydonsiz strict DTOlar), `shift.test.ts`, `return.ts` (`shiftId` maydoni), `index.ts`.
4. **`@mezon/db-local`:** `schema/index.ts`, `drizzle/0011_shifts_day_close.sql`, `shift-migrations.ts` (triggerlar + `v_sales_lines` + indeks tekshiruvlari), `scripts/check-migrations.mjs`, `device-state.ts`, `shift-repo.ts` (`SqliteShiftStore`), `sale-repo.ts`, `return-repo.ts`, `customer-repo.ts`, `supplier-repo.ts`, `index.ts`, `shift.test.ts` + T1.4/T1.6/T1.7/T1.8 testlarini ochiq smena bilan yangilash.
5. **`apps/hub`:** `error-handler.ts`, `shift-service.ts`, `shift-routes.ts` (`/shifts/open`, `/shifts/current`, `/shifts/current/handoff`, `/shifts/current/close`, `/shifts/:id/reclose`, `/shifts/:id`, `/shifts`, `/shifts/current/cash-moves`, `/day-closes`), `routes.ts`, `server.ts`, `index.ts`, `shift.test.ts` + hub testlarida `openShift`.

### Doiradan tashqari (`h`)

- Fiskal Z-hisobot va OFD (F3).
- Chek va hisobot chop etish (T1.12).
- POS UI (T1.11).
