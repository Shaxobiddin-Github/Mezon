## Hisobot: T1.7

Branch / PR: `gemini/T1.7-customer-ledger` / https://github.com/Shaxobiddin-Github/Mezon/pull/14  
Commit: `fc172c645c16f822a1a0ef454b4aa215b457f9ba` (1-commit: T1.6 test qarzi) + `8f29f348c032cf6aaf94882ddb51e50909167410` (T1.7 kod)

---

### Nima qilindi

1. **T1.6 test qarzi (`fc172c645c16f822a1a0ef454b4aa215b457f9ba` — alohida commit):**
   - `voidSale` o'rtacha tannarxli (`lastUnitCost !== avgCost` ikki xil kirimdan keyin) va FIFO partiyali ombor qoldiqlarining barcha 6 maydonini asl holatiga aniq tiklashi testlandi (`packages/db-local/src/return.test.ts`). Mutatsiya isboti: `packages/domain/src/stock.ts` dagi `applyReplayStockMove` dan `move.reason !== 'return' &&` olib tashlanganda test `lastUnitCost` (`10000n` vs `30000n`) farqi bilan yiqildi.
   - Yarim tiyin (`10 * 500 / 2000 = 2.5`) kumulyativ `HalfAwayFromZero` yaxlitlash testi qo'shildi (`packages/domain/src/return.test.ts`, `packages/db-local/src/return.test.ts`). Mutatsiya isboti: `packages/domain/src/return.ts` dagi `divideRoundHalfAwayFromZero` oddiy `/` ga almashtirilganda testlar `1n` vs `2n` bilan yiqildi.

2. **T1.7 Domen va qoidalar (`packages/domain`):**
   - `auth.ts`: `customers:read`, `customers:write`, `debt:pay` (`owner`/`manager`/`cashier`), hamda `debt:manage` (faqat `owner`/`manager`).
   - `errors.ts`: `CUSTOMER_NOT_FOUND`, `CUSTOMER_PHONE_ALREADY_EXISTS`, `CUSTOMER_INACTIVE`, `CUSTOMER_HAS_OPEN_DEBT`, `CREDIT_LIMIT_EXCEEDED`, `OPENING_BALANCE_ALREADY_EXISTS`, `OVERPAYMENT_NOT_ALLOWED`, `RETURN_DEBT_OFFSET_EXCEEDED`, `SALE_DEBT_HAS_PAYMENTS`.
   - `customer.ts`:
     - Telefon normallashtirish (`normalizeCustomerPhone`): mahalliy O'zbekiston shakllari (`90 123-45-67`, `998...`) -> `+998XXXXXXXXX` va umumiy E.164 (`+[1-9]\d{7,14}`, masalan `+7...`, `+992...`) xato xabarlarida xom raqamni chiqarmasdan qabul qilinadi.
     - Nom qidiruvini `normalizeCatalogSearchText` orqali qayta ishlatish (kirill-lotin).
     - `computeDebtDueAtMs`, `computeOverdueDaysAt` (`Asia/Tashkent` va istalgan IANA `storeTimezone` kesish nuqtasi).
     - **D1 (`computeNextCustomerBalance`):** Barcha ledger yozish yo'llari (`opening_balance`, `sale_debt`, `debt_payment`, `return_offset`, `sale_void`, `adjustment`) ishlatadigan yagona domen qo'riqchisi (`balance >= 0`).
     - **D2 + D3 (`allocateCustomerLedgerFifo`):** `(hlc ASC, id ASC)` bo'yicha bir o'tishli `O(N)` deterministik FIFO taqsimot. Musbat `adjustment` o'z `hlc` o'rnida mustaqil majburiyat bo'lib turadi (`dueAtMs = null`, faqat aniq `dueDays` berilganda muddat olinadi); manfiy `adjustment` eng eski ochiq majburiyatni FIFO bilan yopadi.
     - **D5:** F2 ko'p do'konli oflayn sinxronizatsiya chegaralari (`CREDIT_LIMIT_EXCEEDED_SYNC`, `DUPLICATE_OPENING_BALANCE`, `OVERPAYMENT_CONFLICT`) JSDoc hujjatida (`customer.ts` va `db-local/src/schema/index.ts`) qayd etildi.
   - `return.ts`: `resolveReturnPayments` dan T1.7 placeholder olib tashlandi va haqiqiy `remainingSaleDebt` hamda `paidTowardDebtByMethod` tekshiruvlari ulandi.

3. **PII redaksiyasi va kontraktlar (`packages/drivers`, `packages/contracts`):**
   - `packages/drivers/src/node/redact.ts`: `DEFAULT_LOG_REDACT_PATHS` ga `phone`, `phoneNormalized`, `phoneDigits`, `fullName`, `nameSearch`, `customerName`, `customerPhone`, `customerNote` (`*.`, `*.*.`) qo'shildi.
   - `packages/contracts/src/customer.ts` va `sale.ts`: Qat'iy Zod DTO'lar (tannarx/foyda maydonlarisiz, `ZodError` da PII sizmasdan) va `CompleteSaleRequestSchema` da ixtiyoriy `dueDays`, `creditOverride`.

4. **Lokal SQLite sxema, migratsiya, repozitoriy va T1.5/T1.6 ilgaklari (`packages/db-local`):**
   - `0009_customer_ledger.sql`: `local_hub_config.default_customer_due_days` (default `14`), `customers` (`ATTR`, `organization`), `customer_ledger` (`FACT`, `store`), `local_customer_balances` (`LOCAL`, `organization`), `customers_fts` (FTS5 `content=` siz), partial UNIQUE (`uidx_customers_org_phone_active`, `uidx_customer_ledger_opening_balance`), `BEFORE DELETE/UPDATE` triggerlari.
   - `customer-migrations.ts` + `scripts/check-migrations.mjs`: `customers_fts`, `customer_ledger`/`customers` triggerlari va `uidx_customer_ledger_opening_balance` `db:check` da tekshiriladi (`index.test.ts` da ijobiy/manfiy testlar bilan).
   - `outbox.ts`: `redactOutboxPayloadForDebug` va `formatOutboxRecordForDebug`.
   - `customer-repo.ts`: `SqliteCustomerStore` (CRUD, tombstone qarz himoyasi, FTS5/telefon qidiruvi, SQL Window Function bilan tarix, `cash_moves` `debt_payment_in`, `rebuildCustomerBalances`, `rebuildCustomerSearchIndex`) va `completeSale`/`createReturn`/`voidSale` bilan bitta tranzaksiyada ishlovchi ilgaklar.

5. **Hub HTTP API va RBAC (`apps/hub`):**
   - `customer-service.ts`, `customer-routes.ts` (`GET /customers`, `GET /customers/overdue`, `GET /customers/:id`, `GET /customers/:id/ledger`, `POST /customers`, `PATCH /customers/:id`, `DELETE /customers/:id`, `POST /customers/:id/opening-balance`, `POST /customers/:id/payments`, `POST /customers/:id/adjustments`).
   - `sale-service.ts`: `creditOverride` uchun `authService.verifySupervisorPin` (T0.6 blokirovkasi bilan).
   - `error-handler.ts`: barcha 9 ta yangi `DomainErrorCode` uchun HTTP statuslar (`404` / `409`).

---

### O'zgargan fayllar

**T1.6 test qarzi commit'i (`fc172c6`):**
- `packages/domain/src/return.test.ts` — yarim tiyin kumulyativ `HalfAwayFromZero` yaxlitlash testi.
- `packages/db-local/src/return.test.ts` — `voidSale` da ikki tannarxli `lastUnitCost != avg` tiklanish va yarim tiyin DB testi.

**T1.7 commit'i (`8f29f34` — 41 fayl):**
- `packages/domain/src/errors.ts` — T1.7 xato kodlari.
- `packages/domain/src/auth.ts` — `customers:read/write`, `debt:pay/manage` huquqlari.
- `packages/domain/src/auth.test.ts` — rol x huquq matritsasi testlari.
- `packages/domain/src/return.ts` — sana kalendar yordamchilarini eksport qilish va `resolveReturnPayments` qarz qoldig'i bilan qayta ulash.
- `packages/domain/src/return.test.ts` — qaytarish qarz cheklovi testlarini yangilash.
- `packages/domain/src/sale.ts` — `canonicalizeCompleteSaleRequest` da ixtiyoriy `dueDays`.
- `packages/domain/src/customer.ts` — yangi domen moduli (telefon, D1, D2/D3 FIFO, kechikish, D5 izohi, hashlar).
- `packages/domain/src/customer.test.ts` — birlik va 300-run `fast-check` property testlar.
- `packages/domain/src/index.ts` — mijoz eksportlari.
- `packages/drivers/src/node/redact.ts` — Pino PII redaktsiya yo'llari.
- `packages/contracts/src/sale.ts` — `CompleteSaleRequestSchema` da `dueDays` va `creditOverride`.
- `packages/contracts/src/customer.ts` — yangi Zod DTO sxemalari.
- `packages/contracts/src/customer.test.ts` — kontraktdagi PII/QQS/DTO testlari.
- `packages/contracts/src/index.ts` — mijoz kontrakti eksportlari.
- `packages/db-local/src/schema/index.ts` — `local_hub_config`, `customers`, `customer_ledger`, `local_customer_balances` sxemalari + D5 izohi.
- `packages/db-local/drizzle/0009_customer_ledger.sql` — yangi SQLite migratsiyasi.
- `packages/db-local/drizzle/meta/0009_snapshot.json`, `_journal.json` — Drizzle migratsiya metama'lumoti.
- `packages/db-local/src/catalog-search-schema.ts` — umumiy FTS5 parametrli shabloni (duplikatsiyasiz).
- `packages/db-local/src/customer-migrations.ts` — migratsiya trigger va partial UNIQUE invariant tekshiruvi.
- `packages/db-local/scripts/check-migrations.mjs` — `assertCustomerMigrationsComplete` ulanishi.
- `packages/db-local/src/timezone.ts` — umumiy `resolveIntlDateKey` yordamchisi.
- `packages/db-local/src/uow.ts` — `SqliteUnitOfWork.nowUnixMs()`.
- `packages/db-local/src/outbox.ts` — `redactOutboxPayloadForDebug` / `formatOutboxRecordForDebug`.
- `packages/db-local/src/customer-repo.ts` — `SqliteCustomerStore` va tranzaksiya ilgaklari.
- `packages/db-local/src/sale-repo.ts` — `completeSale` ga mijoz, kredit limiti, `dueDays` va `sale_debt` yozishni ulash.
- `packages/db-local/src/return-repo.ts` — `createReturn` (`return_offset`) va `voidSale` (`SALE_DEBT_HAS_PAYMENTS` / teskari yozuv) ulash.
- `packages/db-local/src/index.ts` — `customer-repo` va `customer-migrations` eksportlari.
- `packages/db-local/src/index.test.ts` — migratsiya soni (`10n`) va `assertCustomerMigrationsComplete` testlari.
- `packages/db-local/src/sale.test.ts` — noma'lum `customerId` -> `CUSTOMER_NOT_FOUND`.
- `packages/db-local/src/customer.test.ts` — CRUD, PII, D1–D4, 60-qadam model testi, 5k va 10k/100k benchmarklar.
- `apps/hub/src/error-handler.ts` — 9 ta yangi `DomainErrorCode` HTTP status xaritalari.
- `apps/hub/src/sale-service.ts` — `creditOverride` supervisor PIN va `dueDays` uzatish.
- `apps/hub/src/cart-routes.ts` — `sale.completed` PII-siz log maydonlari.
- `apps/hub/src/customer-service.ts` — allow-list DTO xizmat qatlami.
- `apps/hub/src/customer-routes.ts` — `/customers*` HTTP marshrutlari, RBAC va PII-siz loglar.
- `apps/hub/src/routes.ts` — `registerCustomerRoutes` ulanishi.
- `apps/hub/src/server.ts` — `customerStore`, `customerService` va `HubSaleService` ga `authService` uzatish.
- `apps/hub/src/index.ts` — `HubCustomerService` eksporti.
- `apps/hub/src/sale.test.ts` — noma'lum `customerId` `404 CUSTOMER_NOT_FOUND` testi.
- `apps/hub/src/customer.test.ts` — to'liq HTTP E2E RBAC, lockout, PII/tannarx sizmasligi, qaytarish/void testi.

---

### Migratsiyalar

- `packages/db-local/drizzle/0009_customer_ledger.sql` (`db:check`: `SQLite schema matches committed migrations (0 diff statements)`).
  - `local_hub_config` qayta qurishda `0008` bazadan ko'chirish `SELECT` dagi `default_customer_due_days` qiymati `14` ga tuzatildi (aksi holda mavjud bazani yangilashda ustun yo'q xatosi chiqar edi).

---

### D1–D5 dalillari va majburiy ko'rsatkichlar

- **D1 (Balans hech qachon manfiy emas + mutatsiya isboti):**
  - Barcha ledger yo'llari `packages/domain/src/customer.ts` dagi yagona `computeNextCustomerBalance` funksiyasidan o'tadi hamda `local_customer_balances` ustida `CHECK (balance >= 0)` SQL himoyasi bor.
  - Model test (`packages/db-local/src/customer.test.ts`, **60 ta tasodifiy ko'p-mijozli qadam**, har qadamda `balance >= 0n`, SQL `SUM(amount_delta)`, `local_customer_balances` va mustaqil FIFO model tengligi + oxirida `rebuildCustomerBalances` tekshiriladi) + domen property testi (`packages/domain/src/customer.test.ts`, **300 ta `fast-check` run**).
  - **D1 Mutatsiya isboti (bajarildi va asl holatga qaytarildi):** `computeNextCustomerBalance` dagi `debt_payment`, `adjustment` va yakuniy `next < 0n` qo'riqchisi vaqtincha olib tashlanganda:
    - `packages/domain/src/customer.test.ts` (`D1: computeNextCustomerBalance blocks negative balance...`): yiqildi (`expected [Function] to throw an error`);
    - `packages/db-local/src/customer.test.ts` (`D1 + D2 + D3 model test: 60 seeded random...` va boundary testi): yiqildi (`expected SqliteError: CHECK constraint failed ... to match object { code: 'OVERPAYMENT_NOT_ALLOWED' }`).
- **D2 (FIFO tartibi `hlc` bo'yicha):**
  - `allocateCustomerLedgerFifo` faqat `(hlc ASC, id ASC)` bo'yicha saralaydi.
  - `packages/db-local/src/customer.test.ts` (`D2 + D3: enforces HLC FIFO ordering even under out-of-order DB insertion...`): teskari `id`, teskari `created_at_ms` va teskari SQL kiritish tartibida ham natija bir xilligi testlandi.
- **D3 (Musbat/manfiy `adjustment` qoidalari):**
  - Musbat `adjustment` o'z `hlc` joyida mustaqil majburiyat yaratadi; `due_at_ms` odatiy holatda `NULL` (kechikish qo'zg'atmaydi, faqat aniq `dueDays` berilganda muddat olinadi) va FIFO to'lov navbatida qatnashadi. Manfiy `adjustment` FIFO bilan eng eski majburiyatni yopadi (`fifoWaivedTotal`). Kod izohi `packages/domain/src/customer.ts` va model testda tasdiqlandi.
- **D4 (1 mijozda 5 000 ledger yozuvi benchmarki <= 100 ms):**
  - Yakuniy `pnpm verify` dagi natija (`packages/db-local/src/customer.test.ts`):
    `[PERF T1.7 D4] 5,000 entries (1 customer): getCustomerDetail=16.29 ms | createReturn=43.02 ms` (ikkisi ham `<= 100 ms`).
- **10 000 mijoz + 100 000 ledger qatori benchmarki <= 100 ms:**
  - Yakuniy `pnpm verify` dagi natija:
    `[PERF T1.7 10k/100k] seedMs=10436.7 | ftsMs=1.15 | phoneMs=5.39 | balanceMs=0.65 | overdueMs=23.99` (barchasi `<= 100 ms`).
- **D5 (F2 uchun ma'lum chegaralar hujjati):**
  - `packages/domain/src/customer.ts` (`computeNextCustomerBalance` JSDoc) va `packages/db-local/src/schema/index.ts` da `CREDIT_LIMIT_EXCEEDED_SYNC`, `DUPLICATE_OPENING_BALANCE`, `OVERPAYMENT_CONFLICT` aniqlash va `apps/admin` da ko'rsatish qoidalari hujjatlashtirildi.

---

### Qabul mezonlari

- [x] `T1.6` test qarzi alohida 1-commitda (`fc172c6`) mutatsiya isbotlari bilan yopildi.
- [x] `customers` (`ATTR`, `organization`), E.164 + O'zbekiston telefon normallashtirish, faol mijoz uchun partial UNIQUE, FTS5 + telefon qidiruvi (`ftsMs=1.15`, `phoneMs=5.39`).
- [x] PII himoyasi: Pino redaksiya, `ZodError`/`DomainError` da xom PII yo'q, `formatOutboxRecordForDebug`, `apps/hub` da haqiqiy Pino oqimi va xato javoblarida PII sizmasligi isbotlandi.
- [x] `customer_ledger` (`FACT`, `store`), `opening_balance` partial UNIQUE (`uidx_customer_ledger_opening_balance`), `local_customer_balances` (`LOCAL`) + `rebuildCustomerBalances`.
- [x] Kredit limiti va supervisor PIN override (`creditOverride`, T0.6 5-urinish lockout bilan), D1 (`balance >= 0` + mutatsiya), D2 (`hlc, id`), D3 (`adjustment`), D4 (`16.29 ms` / `43.02 ms`), D5 (F2 izohi).
- [x] `createReturn` (`return_offset`) va `voidSale` (`SALE_DEBT_HAS_PAYMENTS`) hamda SQL Window Function tarixi.
- [x] `pnpm verify` va barcha 4 ta GitHub CI job (`pull_request` va `push` workflowlarida) yashil.

---

### Test natijasi

1. **Lokal to'liq tekshiruv (`pnpm verify`):**
   - Buyruq: `pnpm run format:check && pnpm run build && pnpm run lint && pnpm run typecheck && pnpm run db:check && pnpm run test && pnpm run depcruise`
   - Natija (exit code `0`):
     - `prettier --check .`: `All matched files use Prettier code style!`
     - `turbo run build`: `17 successful, 17 total` (`3.644s`)
     - `lint-workspaces.mjs`: 0 xato
     - `turbo run typecheck`: `22 successful, 22 total` (`10.047s`)
     - `turbo run db:check`: `19 successful, 19 total` (`SQLite` va `PostgreSQL` `0 diff statements`)
     - `vitest run`: `45 passed | 1 skipped (46)` fayl, `226 passed | 2 skipped (228)` test (`Duration 19.59s`; `packages/db-cloud/src/pg-rls.test.ts` lokal Postgres yo'qligi sabab skip — CI da o'tadi):
       - `packages/domain/src/customer.test.ts`: `5/5` (`300` ta `fast-check` property run)
       - `packages/contracts/src/customer.test.ts`: `3/3`
       - `packages/db-local/src/customer.test.ts`: `6/6` (60-qadam model test, D4 `16.29 ms / 43.02 ms`, 10k/100k `1.15 / 5.39 / 0.65 / 23.99 ms`)
       - `apps/hub/src/customer.test.ts`: `1/1`
     - `depcruise`: `no dependency violations found (251 modules, 909 dependencies cruised)`

2. **GitHub Actions CI (commit `8f29f348c032cf6aaf94882ddb51e50909167410`):**
   - `pull_request` workflow (`42885577886`): barcha 4 job (`Verify (ubuntu-latest)`, `Verify (windows-latest)`, `Verify PostgreSQL RLS (ubuntu-latest)`, `Build & E2E Desktop Installer (windows-latest)`) **success** (`https://github.com/Shaxobiddin-Github/Mezon/actions/runs/42885577886`).
   - `push` workflow (`42885565122`): dastlab parallel kontentsiya sabab `Verify (windows-latest)` dagi T1.1 `catalog.test.ts:725` (`searchP95=104.118ms <= 50ms`) yiqilgan; `rerun-failed-jobs` dan keyin barcha 4 job **success** (`https://github.com/Shaxobiddin-Github/Mezon/actions/runs/42885565122`).

---

### Tekshirilmagan narsalar

- Yangi UI komponentlari (`apps/pos`, `apps/admin`) bu vazifa doirasida yo'q (keyingi vazifalarda).
- Lokal muhitda PostgreSQL RLS (`pg-rls.test.ts`) Docker yo'qligi sabab skip qilindi, lekin CI `Verify PostgreSQL RLS (ubuntu-latest)` jobida muvaffaqiyatli o'tdi.

### Qilingan taxminlar

- `POST /carts/:id/complete` da `creditOverride` berilmaganida `owner`/`manager` ham mijozning `creditLimit` chegarasini tasodifan bosib o'tmasligi uchun kredit limitidan oshish faqat aniq `creditOverride` (PIN tasdiqlash) bilan ochiladi.
- Telefon normalizatsiyasida mahalliy O'zbekiston raqamlari (`90...`, `998...`) `+998...` ga keltiriladi, xalqaro raqamlar uchun `+` bilan boshlanuvchi E.164 (`+[1-9]\d{7,14}`) qabul qilinadi.

### Takliflar

- T1.1 `catalog.test.ts:725` (`searchP95 <= 50 ms`) umumiy Windows CI runnerda parallel `push` + `pull_request` kontentsiyasiga sezgir; kelajakda CI workflow concurrency yoki warm-up/median ko'rsatkichga qarash foydali bo'ladi.

### Egasi yoki Claude qarori kerak bo'lgan savollar

- Yo'q. PR #14 Claude tekshiruvi (`QABUL` / `QAYTA ISHLASH`) kutilmoqda.
