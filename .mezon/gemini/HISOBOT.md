## Reja: T1.5 — To'lovlar, aralash to'lov, qaytim va `cash_moves`

**Branch:** `gemini/T1.5-payments` (`main` dan ochildi, commit `740ab2a895a85f83a8c8695baee363f05e45f269`)
**Oldingi PR #11 (T1.4) merge natijasi:**
- PR #11 boshi `f2a65a08f5c645ab90737ccac8297468b32fbbd8` hamda 4 ta CI job (`Verify (ubuntu-latest)`, `Verify (windows-latest)`, `Verify PostgreSQL RLS (ubuntu-latest)`, `Build & E2E Desktop Installer (windows-latest)`) yashil ekani tekshirildi.
- Squash & Merge sarlavhasi: `T1.4: completeSale, chek va idempotentlik`
- Merge commit SHA (`main`): `740ab2a895a85f83a8c8695baee363f05e45f269`
- `gemini/T1.4-complete-sale` lokal va remote branch'lari o'chirildi.

> **Hozirgi bosqich:** faqat REJA. Hech qanday kod yozilmagan. Claude tasdig'idan keyin bajariladi.

---

### 1. Birinchi alohida commit: `T1.4 test qarzi: zaxira chegarasi, idempotentlik do'koni`

T1.5 PR'ining **1-commit'i** faqat quyidagi ikki regressiya testidan iborat bo'ladi (`packages/db-local/src/sale.test.ts` va tegishli Hub tekshiruvi) va har biri ataylab mutatsiya kiritib yiqilishi bilan isbotlanadi:

1. **`block` rejimida aniq chegara (1 milli yetishmovchilik):**
   - Zaxira aniq `5.000` (`5000n` milli) bo'lgan tovar bilan:
     - `5.000` sotuv muvaffaqiyatli o'tadi (`0.000` qoldiq, `1` chek, `1` `stock_move`).
     - Alohida savatda `5.001` (`5001n` milli) sotuv `409 INSUFFICIENT_STOCK` bilan rad etiladi va bazaga **hech narsa** yozilmaydi (`sales`, `sale_lines`, `payments`, `stock_moves`, `local_outbox`, `last_receipt_seq` o'zgarmaydi).
     - Bitta savatda **xuddi shu tovarning ikki qatori** (`3.000` + `2.001` = `5.001`) ham jamlab rad etiladi (`409 INSUFFICIENT_STOCK`), nol yozuv.
   - **Mutatsiya dalili:** `sale-repo.ts` pre-check'dagi `avail < need` ni `avail + 1n < need` ga o'zgartirib, `applyOutboundStockMoveSync` ga `overridePolicy: 'warn'` uzatilganda yuqoridagi ikkala rad etish testi ham yiqiladi.

2. **Idempotentlik do'kon izolyatsiyasi (`store_id`):**
   - Bir xil `organization_id` ichida 2-do'kon (`storeB`) uchun `clientRequestId = X` bilan sotuv fixture yoziladi.
   - 1-do'kon (`storeA`) kontekstidan, `storeA` savati va **o'sha `clientRequestId = X`** bilan `completeSale` chaqirilganda `IDEMPOTENCY_CONFLICT` (`409`) qaytadi va hech narsa yozilmaydi.
   - **Mutatsiya dalili:** `sale-repo.ts` dagi `existingSale.storeId !== ctx.storeId` sharti olib tashlanganda test yiqiladi.

*(Shuningdek, T1.4 eslatmasi bo'yicha: T1.5 `completeSale` testlarida `validateSalePaymentsInvariant` chaqiruvi olib tashlanganda testlar aniq yiqiladigan qilib yoziladi — e bo'limiga qarang.)*

---

### 2. T1.5 rejasi (`a`–`h`)

#### a) Naqdsiz to'lovlar va integratsiya chegarasi
- Qo'llab-quvvatlanadigan turlar (`PAYMENT_METHODS`): `'cash'`, `'card'`, `'uzqr'`, `'payme'`, `'click'`, `'uzum'`, `'social_card'`, `'other'`.
- T1.5 da tashqi provayder API'lari yo'q (`GEMINI.md` 3.3). Naqdsiz to'lovlar **kassir tasdig'i** bilan qabul qilinadi (terminal/ilova orqali o'tganini kassir tasdiqlaydi) va ixtiyoriy `providerRef` (chek/RRN/tranzaksiya raqami, bo'sh bo'lmagan trim qilingan satr, `<= 128` belgi, yo'q bo'lsa `null`) saqlanadi; `providerMetaJson` hozircha `null`.
- **F3 / T3.6 uchun sxema chegarasi:** `payments` jadvali **`FACT`** (faqat tasdiqlangan, o'zgarmas to'lov faktlari) bo'lib qoladi. Keyinroq F3/T3.6 da real Payme/Click/Uzum/UzQR oqimi qo'shilganda `pending -> confirmed / failed / expired` holat mashinasi va webhook/so'rov izlari alohida **`payment_intents`** (yoki `provider_transactions`) jadvalida turadi va faqat tasdiqlangandan keyin `completeSale` ichida `payments` (`FACT`) yozuviga `provider_ref` orqali bog'lanadi. Shunda `payments` sxemasini buzish yoki `UPDATE` ochish shart bo'lmaydi.

#### b) Aralash to'lov va qaytim qoidalari
1. **Bir nechta qator (`payments[]`) va bir xil turdan bir nechta qator:**
   - **Naqdsiz turlar (`card`, `uzqr`, `payme`, `click`, `uzum`, `social_card`, `other`):** bir turdan **bir nechta qator mumkin** (masalan, 2 ta bank kartasi bo'yicha har birida alohida `providerRef` bilan bo'lib to'lash).
   - **Naqd (`cash`):** **bitta savdoda ko'pi bilan 1 ta `'cash'` qatori** ruxsat etiladi (`> 1` bo'lsa `VALIDATION_ERROR`). Sababi: naqd pul kassirga bir to'plamda beriladi va qaytim bitta operatsiyada qaytariladi; bir nechta naqd qatoriga ruxsat berilsa, qaytimni qaysi qatorga bog'lash sun'iy bo'lib, `cash_moves`, chek chiqarish va validatsiyada ortiqcha noaniqlik tug'diradi.
2. **Qaytim faqat naqddan va naqdsiz ortiqcha bo'lmasligi:**
   - Naqdsiz qatorlar uchun: `amount > 0n`, `changeAmount = 0n`, `tenderedAmount = null` (naqdsiz qatorda `tenderedAmount` yuborilsa `VALIDATION_ERROR` bilan rad etiladi).
   - `nonCashTotal = SUM(naqdsiz amount)`. Talab: `nonCashTotal <= totalFinal - debtAmount`. Agar `nonCashTotal > totalFinal - debtAmount` bo'lsa, **rad etiladi (`VALIDATION_ERROR`)** — naqdsiz to'lovdan qaytim berilmaydi.
   - Naqd qatori bo'lsa: `remainingForCash = totalFinal - debtAmount - nonCashTotal`. Agar `remainingForCash <= 0n` bo'lsa (qolgan summa allaqachon 0), qo'shimcha `'cash'` qatori rad etiladi (`VALIDATION_ERROR`, nol summali to'lov va "pul maydalash" bo'lmasligi uchun). Aks holda `tenderedAmount >= remainingForCash`, `cash.amount = remainingForCash` (`> 0n`), `cash.changeAmount = tenderedAmount - remainingForCash` (`>= 0n`). Agar mijoz `'cash'` qatorida ixtiyoriy `amount` ham yuborsa, `amount === remainingForCash` bo'lishi shart (mos kelmasa `VALIDATION_ERROR`).
3. **Nol va manfiy qatorlar rad etiladi:**
   - Har bir to'lov qatorida `amount > 0n` (va naqdda `tenderedAmount > 0n`) bo'lishi majburiy; `<= 0n` bo'lgan har qanday qator domen va Zod darajasida rad etiladi.
   - `payments` jadvalidagi `CHECK` ham `amount > 0` ga kuchaytiriladi (migratsiya `0007` da).
4. **Jami `0` bo'lgan savdo (100% chegirma):**
   - `totalFinal === 0n` bo'lganda savdo **`payments: []`** (bo'sh massiv, `debtAmount = '0'`) bilan yopiladi.
   - Nol summali `payments` yoki `cash_moves` qatori **yozilmaydi**; `sales` (`total_final = '0'`, `total_paid = '0'`, `debt_amount = '0'`, `change_amount = '0'`), `sale_lines`, `stock_moves` va outbox esa odatdagidek bir tranzaksiyada yoziladi, `SUM(payments) + debt = 0 = totalFinal` invariant saqlanadi. (Agar `totalFinal === 0n` da `payments.length > 0` yuborilsa, `VALIDATION_ERROR` bilan rad etiladi.)
5. **T1.4 so'rovi bilan orqaga moslik:**
   - T1.4 dagi `{ expectedTotal, clientRequestId, payments: [{ method: 'cash', tenderedAmount }] }` so'rovi (bu yerda `cash.amount` ko'rsatilmaydi va `debtAmount` berilmaydi) xuddi avvalgidek `> 0` jami savdolarda o'zgarishsiz ishlaydi.

#### c) Qarz (`debtAmount`)
- Domen invariantida (`validateSalePaymentsInvariant`) va `sales` jadvalida `debtAmount >= 0n` va `SUM(payments.amount) + debtAmount === totalFinal` to'liq qo'llab-quvvatlanadi; `debtAmount > 0n` bo'lib `customerId === null` bo'lsa `CUSTOMER_REQUIRED` tashlanadi.
- **T1.5 qarori:** `customers` profili va `customer_ledger` T1.7 da qo'shiladi. Ledger yozuvisiz qarz yaratib bo'lmagani uchun (`GEMINI.md` 3.1.4), **T1.5 da `SqliteSaleStore.completeSale` va Hub har qanday `debtAmount > 0n` so'rovini `CUSTOMER_REQUIRED` (`400`) bilan rad etadi** (`customerId` berilgan yoki berilmaganidan qat'i nazar, chunki T1.5 da mijoz reestri va `customer_ledger` hali mavjud emas).
- Shu bilan birga, `packages/domain` unit va property testlari to'liq invariantni (`debtAmount > 0n` + `customerId !== null` o'tishini ham, `customerId === null` -> `CUSTOMER_REQUIRED` ni ham) hozirdanoq sinab beradi; T1.7 kelganda faqat `completeSale` ichidagi T1.5 bloki o'rniga `customers` tekshiruvi + `customer_ledger` yozuvi ulanadi.

#### d) `cash_moves` jadvali (`FACT`, `store`)
- **Sxema (`packages/db-local` + `0007_payments_cash_moves.sql`):**
  - Jadval sinfi: **`FACT`** (`tenantScope: 'store'`), umumiy ustunlar + immutable triggerlar (`buildSqliteTriggersSql`, UPDATE/DELETE taqiqlangan).
  - Ustunlar:
    - `shift_id`: `sqliteUuidV7('shift_id')` **nullable** (T1.9 da smena ochish/yopish majburiy bo'ladi).
    - `type`: `text('type').notNull()` — barcha kassa harakat turlari oldindan nomlanadi (`CASH_MOVE_TYPES`):
      - Kirimlar (`amount_delta > 0`): `'sale_cash_in'` (T1.5 savdo naqdi), `'debt_payment_in'` (T1.7 qarz to'lovi), `'cash_in'` (T1.9 kassaga qo'lda kirim / boshlang'ich kiritma).
      - Chiqimlar (`amount_delta < 0`): `'sale_change_out'` (T1.5 savdo qaytimi), `'refund_cash_out'` (T1.6 qaytarish naqdi), `'cash_out'` (T1.9 kassa xarajati), `'encashment'` (T1.9 inkassatsiya).
    - `amount_delta`: `sqliteMoney('amount_delta').notNull()` — ishorali `bigint` tiyinda (`amount_delta <> 0` va SQL `CHECK` har bir `type` ning ishorasini tekshiradi: kirim `> 0`, chiqim `< 0`).
    - `source_type`: `text('source_type').notNull()` (`'sale'`, keyin `'refund'`, `'customer_ledger'`, `'shift'`, `'manual'`).
    - `source_id`: `sqliteUuidV7('source_id').notNull()` (T1.5 da `saleId`).
    - `payment_id`: `sqliteUuidV7('payment_id').references(() => payments.id)` nullable (savdodan kelgan harakatni aniq `payments` qatoriga bog'lash uchun).
    - `reason`: `text('reason')` nullable.
    - `created_by_user_id`: `sqliteUuidV7('created_by_user_id').notNull().references(() => users.id)` (`actorUserId`).
  - Indekslar: `(organization_id, store_id, created_at_ms)`, `(organization_id, store_id, shift_id, created_at_ms)`, `(source_type, source_id)`.
- **Savdo paytida yozilish:**
  - `completeSale` tranzaksiyasi ichida, agar `'cash'` to'lovi bo'lsa:
    1. `sale_cash_in`: `amount_delta = +tenderedAmount`, `source_type = 'sale'`, `source_id = saleId`, `payment_id = cashPaymentId`, + outbox (`cash_move.created`).
    2. Agar `changeAmount > 0n` bo'lsa: `sale_change_out`: `amount_delta = -changeAmount`, `source_type = 'sale'`, `source_id = saleId`, `payment_id = cashPaymentId`, + outbox (`cash_move.created`). (`changeAmount === 0n` bo'lganda nol qator yozilmaydi.)
  - Shunda `(+tenderedAmount) + (-changeAmount) = +cash.amount` va kassadagi naqd qoldig'i = `SELECT COALESCE(SUM(amount_delta), 0) FROM cash_moves WHERE organization_id = ? AND store_id = ?` (F4/T1.9 da `device_id` / `shift_id` bo'yicha ham kesim). `getCashDrawerBalanceSync` yordamchisi qo'shiladi.

#### e) Invariant va testlar
- `resolveAndValidateSalePayments` + `validateSalePaymentsInvariant` faqat serverda qayta hisoblangan **`detail.totalFinal`** ga nisbatan tekshiradi (klient yuborgan `expectedTotal` ga emas).
- **Mutatsiyadan himoya (`validateSalePaymentsInvariant` olib tashlansa test yiqilishi):**
  - `resolveSalePayments` da (masalan, faqat `card` bilan kam to'lash `10_000 < 50_000`, yoki faqat `card` bilan ortiqcha to'lash `60_000 > 50_000`, yoki `cash` da noto'g'ri `amount` berilishi) qatorlarni jamlash va yakuniy `SUM(amount) + debt === totalFinal` hamda non-cash ortiqcha tekshiruvini aynan `validateSalePaymentsInvariant` bajaradi.
  - Agar `sale-repo.ts` dan `validateSalePaymentsInvariant` chaqiruvi olib tashlansa, `completeSale` `400 VALIDATION_ERROR` o'rniga SQLite `chk_sales_totals_balance` (`500`) yoki noto'g'ri qaytim yozishga tushib qoladi va `db-local` hamda Hub `completeSale` testlari aniq yiqiladi.
- **Property-based testlar (`fast-check`):**
  - Tasodifiy savdo jami (`0` dan katta summalargacha), tasodifiy to'lov turlari soni va bo'linishlari, naqd ortiqchasi (`tendered >= cashAmount`), qarz (`customerId` bilan / siz):
    - Barcha yaroqli kombinatsiyalar o'tadi (`SUM(amount) + debt === totalFinal`, `nonCashChange === 0n`, `cashMovesNet === cashAmount`).
    - Har qanday buzilish (kam to'lash, ortiqcha naqdsiz, `2` ta naqd, `0` yoki manfiy summa, `totalFinal = 0` ga to'lov, `customerId = null` bilan qarz) rad etiladi; `completeSale` integratsion property/fuzz testida xato holatda bazaga 0 ta qator yozilgani (`sales`, `payments`, `cash_moves`, `stock_moves`, `local_outbox`, `receipt_no`) tekshiriladi.

#### f) T1.4 dan qolgan ikki aniqlik
1. **Kanonik so'rov xeshi (`sales.request_hash`):**
   - `packages/domain/src/sale.ts` ichida sof `canonicalizeCompleteSaleRequest` funksiyasi kanonik deterministik satr tuzadi: `cartId` (UUID), `expectedTotal` (tiyin), `debtAmount` (tiyin, default `'0'`), `customerId` (`null` yoki UUID), va tartibni saqlagan holda normallashtirilgan `payments[]` (har elementda `method`, `amount` tiyin/`null`, `tenderedAmount` tiyin/`null`, trim qilingan `providerRef ?? null`).
   - `packages/db-local/src/sale-repo.ts` `node:crypto` orqali SHA-256 (`request_hash`, 64 hex) hisoblaydi (`.dependency-cruiser.cjs` dagi `db-local-src-imports` ga `crypto` qo'shiladi; `packages/domain` esa hech narsaga bog'lanmaydi, sof qoladi).
   - `clientRequestId` takror kelganda: `storeId`, `sourceCartId` va `requestHash` bir xil bo'lsa idempotent eski javob qaytadi; **istalgan biri (jumladan `payments[]` tarkibi/summasi) farq qilsa `409 IDEMPOTENCY_CONFLICT`**.
2. **`sales.completed_by_user_id`:**
   - `sales` jadvaliga `completed_by_user_id` (`NOT NULL`, `users.id` ga FK) va `request_hash` (`NOT NULL`) qo'shiladi.
   - `sales.cashier_user_id` = `cartRow.cashierUserId` (savat egasi), `sales.completed_by_user_id` = `actorUserId` (savdoni yakunlagan foydalanuvchi, masalan menejer), `cash_moves.created_by_user_id` = `actorUserId`.
   - **SQLite migratsiya (`0007_payments_cash_moves.sql`) va triggerlar:** `sales` va `payments` jadvalini qayta qurishda mavjud qatorlar (`completed_by_user_id = cashier_user_id`, `request_hash` legacy belgi) xavfsiz ko'chiriladi; `trg_sales_voided_monotone`, `trg_sales_immutable_core` (endi `completed_by_user_id` va `request_hash` o'zgarishini ham bloklaydi) hamda `FACT`/`MONOTONE` triggerlari (`buildSqliteTriggersSql`) qayta yaratiladi va `assertSaleMigrationsComplete` yangi ustunlar va `cash_moves` triggerlarini majburiy tekshiradi.
   - `SaleDtoSchema` va `sale.completed` audit logi `completedByUserId` ni qaytaradi.

#### g) Hub API, RBAC va unumdorlik
- `POST /carts/:id/complete` (`authorize(authService, request, 'cart:write')` — avtorizatsiyasiz `401`, ruxsatsiz rol `403`):
  - `CompleteSaleRequestSchema` (`@mezon/contracts`) naqd (`{ method: 'cash', tenderedAmount, amount? }`), naqdsiz (`{ method: 'card' | ..., amount, providerRef? }`), bo'sh `payments: []` (`totalFinal = 0` uchun), hamda ixtiyoriy `debtAmount` va `customerId` ni qabul qiladi.
  - Eski T1.4 so'rovlari to'liq ishlayveradi.
  - `CUSTOMER_REQUIRED` -> HTTP `400` (`apps/hub/src/error-handler.ts`).
  - `CompleteSaleResponseSchema` (`strictObject`): barcha `payments[]`, `totalPaid`, `debtAmount`, `changeAmount`, `completedByUserId` qaytadi; **tannarx/foyda/marja maydonlari mutlaqo yo'q** (API test va Pino log tekshiruvi).
- **Unumdorlik:** 20 qatorli savat (partiyali/o'rtacha tannarx aralash) + 3 xil to'lov turi (`cash` + `card` + `uzqr`) bilan `completeSale` bitta `BEGIN IMMEDIATE` tranzaksiyada **`<= 300 ms`** ichida yakunlanishi test/o'lchov bilan tasdiqlanadi.

#### h) Doiradan tashqari va F3 nuqtasi
- **F3 PF-246 qoidalari (`packages/rules`):** T1.5 doirasida emas; lekin `SqliteSaleStore.completeSale` ichidagi aniq ulanish nuqtasi belgilab ketiladi — 3-bosqich (server jami qayta hisobi + chegirma tasdig'i + to'lovlar `resolveAndValidateSalePayments` / `validateSalePaymentsInvariant`) **tugaganidan darhol keyin va `advanceReceiptSeqSync` hamda zaxira/ledger yozuvlaridan OLDIN** (ya'ni `block[]` qaytarsa, chek raqami ham sarflanmaydi, zaxira ham yechilmaydi).
- **Real provayder integratsiyalari (T3.6)**, **mijoz va `customer_ledger` (T1.7)**, **smena ochish/yopish va `shift_id` majburiyligi (T1.9)** — T1.5 doirasidan tashqarida.

---

### 3. O'zgaradigan fayllar rejasi
- `packages/domain/src/errors.ts`, `sale.ts`, `sale.test.ts`
- `packages/contracts/src/sale.ts`, `sale.test.ts`
- `.dependency-cruiser.cjs`
- `packages/db-local/src/schema/index.ts`, `drizzle/0007_payments_cash_moves.sql`, `drizzle/meta/*`, `src/sale-migrations.ts`, `src/sale-repo.ts`, `src/sale.test.ts`
- `apps/hub/src/error-handler.ts`, `src/sale-service.ts`, `src/cart-routes.ts`, `src/sale.test.ts`
