## Hisobot: T1.8

Branch / PR: `gemini/T1.8-suppliers-receiving` / PR #15 (`https://github.com/Shaxobiddin-Github/Mezon/pull/15`)
Commitlar:
- `68b2db5` — `T1.8: ci.yml ni tejamkor qilish`
- `38323ab` — `T1.7 test qarzi: nofaol mijoz, PII redaksiya, test vaqt chegarasi`
- `519781c` (`519781c2ef461b61c3c583f16cfc69d21b7bb5ed`) — `T1.8: Ta'minotchi, kirim hujjati, noma'lum tannarx, avans FIFO va qaytarish`

> **Vaqtinchalik CI siyosati eslatmasi:** Egasi ko'rsatmasiga binoan GitHub Actions bepul limiti tiklanguncha CI kutilmadi va `packages/db-cloud` hamda `apps/desktop` ga tegilmadi; qabul mezoni lokal `pnpm verify` + Claude tekshiruvi hisoblanadi.

---

### Nima qilindi

1. **`ci.yml` tejamkorligi (`68b2db5`):** Push trigger faqat `main` uchun qoldirildi, `.mezon/**` va `**/*.md` o'zgarishlarida CI ishlamaydi, Windows desktop jobi esa faqat `main` push yoki `apps/desktop/` / `packages/drivers/` o'zgargandagina ishga tushadi.
2. **T1.7 test qarzi (`38323ab`):** `vitest.config.ts` ga `unit` va `sqlite-hub` loyihalar bo'yicha 30s timeout; `PII_LOG_REDACT_KEYS` ro'yxatini kengaytirish (`note` bilan) hamda barcha PII kalitlarini Pino'da top/`*.`/`*.*.` darajalarda tekshirish; `CUSTOMER_INACTIVE` da sotuvni rad etib 0 yozuv qoldirish va qarz to'loviga ruxsat berish testlari + mutatsiya isbotlari bajarildi.
3. **Domen (`@mezon/domain`):**
   - `suppliers:read`, `suppliers:write`, `receiving:read`, `receiving:write`, `supplier_debt:pay`, `supplier_debt:manage` ruxsatlari faqat `owner` va `manager` ga berildi (`cashier` uchun `false`).
   - O'zbekiston 9 raqamli STIR (`normalizeSupplierTin`), E.164/UZ telefon (`normalizeSupplierPhone`), PII-xavfsiz xatolar va 14 ta T1.8 xato kodi.
   - `supplier_payment_out` naqd chiqim turi (`CASH_MOVE_OUTFLOW_TYPES`), `supplier_return` ombor chiqim sababi/manbasi.
   - **Avans ruxsat etilgan ikki tomonlama HLC FIFO (`supplier.ts`):** `computeNextSupplierBalance` manfiy balansga (`balance < 0` — oldindan to'lov/avans) ruxsat beradi; `allocateSupplierLedgerFifo` `(hlc ASC, id ASC)` tartibida avansni keyingi `opening_balance`/`receiving_debt`/`adjustment (+)` majburiyatiga avtomatik yopadi (`advanceApplied`), kechikish esa faqat `Asia/Tashkent` kesish nuqtasi bo'yicha qolgan ochiq qarzga hisoblanadi.
   - **E1 (noma'lum tannarx qayta baholash):** `applyStockCostConfirmation` FIFO partiyalar uchun `Q_rem = batch.remainingQty`, o'rtacha tannarxli pul uchun esa `Q_rem = min(max(qtyOnHand, 0), lineQty)` (eng oxirgi kirim deb qaraladi) formulasidan foydalanadi; sotilib ketgan ulush farqi `costVarianceValue` ga tushadi, `totalValue >= 0` va `remainingValue >= 0` saqlanadi.
   - **E2 (qaytarish chiqimi):** O'rtacha pulda qaytarish chiqimi `min(returnCost, totalValue)` bilan cheklanadi, oshgan qism `costVarianceValue` ga yoziladi; `supplier_ledger` da esa asl hujjat tannarxi to'liq kamayadi.
   - `fast-check` (300 run) property testlari va E1 Oracle A & B + E2 birlik testlari.
4. **Kontraktlar va drayverlar (`@mezon/contracts`, `@mezon/drivers`):**
   - `PII_LOG_REDACT_KEYS` ga `supplierName`, `contactPerson`, `supplierPhone`, `supplierNote`, `tin` qo'shildi.
   - `suppliers`, `receiving-drafts`, `receivings`, `confirm-cost`, `returns`, `supplier-returns`, `ledger`, `opening-balance`, `payments`, `adjustments` uchun qat'iy Zod sxemalari (`social_card` ta'minotchi to'lovida taqiqlangan).
5. **Lokal baza (`@mezon/db-local`):**
   - `0010_suppliers_receiving.sql`: 10 ta yangi jadval (`suppliers`, `local_receiving_drafts`, `local_receiving_draft_lines`, `goods_receivings`, `goods_receiving_lines`, `receiving_cost_confirmations`, `supplier_returns`, `supplier_return_lines`, `supplier_ledger`, `local_supplier_balances`), partial UNIQUE (`tin`, `phone_normalized`, `opening_balance`), `uidx_receiving_cost_confirms_line`, `suppliers_fts` FTS5 va triggerlar, `cash_moves`/`stock_moves`/`local_device_state`/`local_hub_config` yangilanishlari (`PRAGMA foreign_keys = ON` bilan sinovdan o'tgan `0009 -> 0010` migratsiya).
   - `applyInboundStockMoveSync`, `applyCostConfirmationStockRevaluationSync`, `applySupplierReturnStockOutboundSync` va `rebuildStockProjections()` birgalikda `goods_receiving_lines (cost_unknown)` va `receiving_cost_confirmations` xronologiyasini `(hlc, kind, id)` tartibida qayta o'ynaydi hamda `UNKNOWN_COST_SURPLUS` konfliktlarini yopadi.
   - `outbox.ts` debug formatteri `suppliers` yozuvlari uchun `name` / `nameSearch` / `tin` / telefon / aloqa shaxs / izohni `[Redacted]` qiladi.
6. **Hub API (`apps/hub`):**
   - 21 ta ta'minotchi, qoralama, kirim, narx tasdiqlash, qaytarish va daftar marshrutlari (`owner`/`manager` ga ruxsat, `cashier` barcha 21 marshrutda `403 AUTH_FORBIDDEN`).
   - Fastify/Pino `req.url` query parametr sanitizatori (`sanitizeRequestUrlForLog`): `/suppliers?q=...` va `/customers?q=...` kabi so'rovlarda `q`, `tin`, `phone`, `pin`, `token` qiymatlari `[Redacted]` qilinib, STIR/PII logga chiqishi oldi olindi.

---

### O'zgargan fayllar (fayl — sabab)

- `.github/workflows/ci.yml` — tejamkor CI triggerlar (main push, doc/mezon ignore, desktop shartli job)
- `vitest.config.ts` — `unit` va `sqlite-hub` loyihalari hamda 30s timeout
- `packages/domain/src/errors.ts` — T1.8 `DomainErrorCode` kodlari (14 ta)
- `packages/domain/src/auth.ts`, `auth.test.ts` — T1.8 RBAC ruxsatlari (`owner`/`manager` faqat)
- `packages/domain/src/sale.ts`, `sale.test.ts` — `supplier_payment_out` chiqim turi
- `packages/domain/src/stock.ts` — E1 (`applyStockCostConfirmation`), E2 (`supplier_return` va pul pol himoyasi), `ReplayCostConfirmationEvent`
- `packages/domain/src/supplier.ts`, `supplier.test.ts`, `index.ts` — STIR/telefon normallashtirish, avansli FIFO, E1/E2 domen mantiqi va 300-run property test
- `packages/drivers/src/node/redact.ts`, `packages/drivers/src/node/index.ts`, `packages/drivers/src/index.test.ts` — PII log redaksiya kalitlari
- `packages/contracts/src/supplier.ts`, `supplier.test.ts`, `index.ts` — T1.8 qat'iy Zod so'rov/javob DTOlari
- `packages/db-local/src/schema/index.ts` — T1.8 jadvallari, CHECKlar va indekslar
- `packages/db-local/drizzle/0010_suppliers_receiving.sql`, `meta/0010_snapshot.json`, `meta/_journal.json` — T1.8 SQLite migratsiyasi
- `packages/db-local/src/supplier-migrations.ts`, `scripts/check-migrations.mjs` — FTS5 va UNIQUE indeks tekshiruvi
- `packages/db-local/src/device-state.ts` — `last_receiving_seq` va `last_supplier_return_seq` atomik hisoblagichlari
- `packages/db-local/src/outbox.ts` — `suppliers` debug PII redaktsiyasi
- `packages/db-local/src/stock-repo.ts`, `customer-repo.ts` — umumiy kirim/E1/E2 yordamchilari va `rebuildStockProjections()` integratsiyasi
- `packages/db-local/src/supplier-repo.ts` — `SqliteSupplierStore` (CRUD, FTS5+STIR qidiruv, qoralama, `postReceiving`, E1, E2, E3, Window Function daftar, rebuildlar)
- `packages/db-local/src/index.ts`, `index.test.ts`, `customer.test.ts`, `stock.test.ts`, `supplier.test.ts` — eksportlar, migratsiya/upgrade testlari, E1–E4 + B1 + 100-qatorli perf testi
- `apps/hub/src/error-handler.ts`, `customer-service.ts`, `logger.ts`, `routes.ts`, `server.ts`, `index.ts` — xato kodlari, `req.url` query sanitizatsiyasi, DI ulanishi
- `apps/hub/src/supplier-service.ts`, `supplier-routes.ts`, `supplier.test.ts` — HTTP xizmati, 21 ta marshrut va E2E/RBAC/PII testlari

---

### Migratsiyalar

- `packages/db-local/drizzle/0010_suppliers_receiving.sql` (Drizzle `0010_snapshot.json` va `meta/_journal.json` bilan; `pnpm verify` ichidagi `db:check` da `0 diff statements`).
- Bulut (`packages/db-cloud`) ga tegilmadi.

---

### Qabul mezonlari

- [x] **E1 (Noma'lum tannarx va alohida kompensatsiya):** `receiving_cost_confirmations` (FACT, bir qatorga bir marta), FIFO (`Q_rem = remainingQty`) va o'rtacha pul (`Q_rem = min(max(qtyOnHand, 0), lineQty)`). **Oracle A:** FIFO va o'rtacha tovarda noma'lum kirim + darhol tasdiqlash natijasida `local_stock_balances` (6 maydon), `local_batch_balances` va ta'minotchi balansi to'g'ridan-to'g'ri kirim bilan 100% teng (`supplier.test.ts` E1). **Oracle B:** oralikda sotuvlar bilan `SUM(inbound) + SUM(confirmed) = SUM(outbound) + totalValue - provisionalDeficitValue + costVarianceValue` va `rebuildStockProjections()` tengligi isbotlangan.
- [x] **E2 (Ta'minotchiga qaytarish pul pol himoyasi):** O'rtacha `10@100` puldan `5@150` qaytarishda `totalValue = 0`, `costVarianceValue = -50`, `supplier_ledger = -150`, FIFO `kirim -> to'liq qaytarish` esa kirimdan oldingi holatga teng (`supplier.test.ts` E2 + rebuild).
- [x] **E3 (Nofaol ta'minotchi + mutatsiya isboti):** `isActive = false` ta'minotchiga `postReceiving` `409 SUPPLIER_INACTIVE` qaytaradi (0 DB yozuv), to'lov, narx tasdiqlash va qaytarish esa qabul qilinadi (`packages/db-local` va `apps/hub` E2E). Mutatsiya: `supplier-repo.ts` dagi `if (!supplier.isActive)` tekshiruvi vaqtincha o'chirilganda `E3` testi `AssertionError: promise resolved ... instead of rejecting` (`supplier.test.ts:1192`) bilan yiqildi, keyin tiklandi.
- [x] **E4 (`>= 200` qadam model testi):** **240 qadam**li seedlangan multi-ta'minotchi model testi (ma'lum/noma'lum kirim, tasdiqlash, sotuv, avansli naqd va karta to'lov, qaytarish, `±` tuzatish, soat sakrashlari); **har bir qadamda** ta'minotchi balansi/avansi/kechikish summasi, kassa balansi va E1.4 ombor saqlanish tenglamasi tekshirildi, yakunda esa proyeksiyalar tozalanib `rebuildSupplierBalances()` + `rebuildStockProjections()` tengligi tasdiqlandi.
- [x] **B1 va idempotentlik:** `postReceiving` `recordInboundMove` bilan barcha 6 balans va partiya maydonlarida teng; `clientRequestId` takrorida `idempotentReplay = true`, boshqa payloadda `409 IDEMPOTENCY_CONFLICT`.
- [x] **Kassa himoyasi va `social_card`:** Naqd chiqim kassada yetmasa `409 INSUFFICIENT_CASH_IN_DRAWER`; `social_card` Zod sxemasi hamda domen tomonidan rad etiladi.
- [x] **RBAC va PII xavfsizligi:** `cashier` barcha 21 HTTP marshrutda `403 AUTH_FORBIDDEN` oladi; xato xabarlarida STIR/telefon/ism yo'q; Pino loglari va HTTP so'rov URL `q` parametrlari `[Redacted]` qilinadi (`apps/hub/src/supplier.test.ts`).
- [x] **100 qatorli kirim tezligi (`<= 500 ms`):** Haqiqiy disk WAL SQLite'da `[PERF T1.8 100-line receiving]: 459.02 ms` (to'liq parallel `pnpm verify` yukida; izolyatsiya qilingan `db-local` yugurishda `148.21 ms`).

---

### Test natijasi (buyruq va haqiqiy chiqish)

Yakuniy commit (`519781c`) dan oldin (yakuniy kod o'zgarishlaridan so'ng) bajarilgan to'liq `pnpm verify` (`exit code 0`):

```text
$ pnpm verify
$ prettier --check . -> All matched files use Prettier code style!
$ turbo run build -> Tasks: 17 successful, 17 total
$ node scripts/lint-workspaces.mjs -> 0 errors
$ turbo run typecheck -> 22/22 successful
$ turbo run db:check:
  @mezon/db-cloud: PostgreSQL schema matches committed migrations (0 diff statements).
  @mezon/db-local: SQLite schema matches committed migrations (0 diff statements).
$ vitest:
  packages/domain/src/supplier.test.ts (6 tests) 370ms (incl. 300-run fast-check)
  packages/contracts/src/supplier.test.ts (3 tests) 32ms
  packages/db-local/src/supplier.test.ts (8 tests) 14117ms
    [PERF T1.8 100-line receiving]: 459.02 ms
  apps/hub/src/supplier.test.ts (2 tests) 2026ms
  Jami: Test Files  49 passed | 1 skipped (50), Tests  248 passed | 2 skipped (250)
  (skipped: packages/db-cloud/src/pg-rls.test.ts — Docker PostgreSQL yo'q)
$ depcruise --config .dependency-cruiser.cjs apps/*/src packages/*/src
  no dependency violations found (265 modules, 1018 dependencies cruised)
```

Izolyatsiya qilingan qayta tekshiruv (`supplier.test.ts` + E3 mutatsiya dalili):
- Oddiy holatda: `packages/db-local/src/supplier.test.ts` `8 passed`, `[PERF T1.8 100-line receiving]: 148.21 ms`.
- Mutatsiya (`if (!supplier.isActive)` olib tashlangan): `1 failed | 7 passed (8)` — `E3` testi `AssertionError: promise resolved ... instead of rejecting` (`supplier.test.ts:1192`) bilan yiqildi, so'ng qayta tiklandi.

---

### Tekshirilmagan narsalar

- **PostgreSQL RLS (`packages/db-cloud/src/pg-rls.test.ts`):** Muhitda Docker PostgreSQL mavjud emasligi sababli 2 ta test skip qilindi (`packages/db-cloud` fayllariga T1.8 da tegilmadi).
- **GitHub Actions CI:** Egasi ko'rsatmasiga binoan GitHub Actions bepul limiti tiklanguncha CI ishga tushishi/o'tishi kutilmadi.

---

### Qilingan taxminlar

- Ta'minotchiga beriladigan `receiving_cost_confirmations` tasdiqlash qadamidan so'ng, `GET /receivings/:id` va `GET /receivings` dagi `unknownCostLineCount` va `knownCostTotal` jonli tasdiqlangan holatni (qolgan tasdiqlanmagan qatorlar soni va jami samarali tannarxni) aks ettiradi, asl `goods_receivings` jadvali esa o'zgarmas FACT sifatida qoladi.
- `sanitizeRequestUrlForLog` faqat nozik query parametr qiymatlarini (`q`, `tin`, `phone`, `pin`, `token`, `secret`, `password`) `[Redacted]` qiladi; marshrut yo'llari va no-PII filtrlari (`status`, `overdueOnly`, `costUnknownOnly`) o'zgarishsiz qoladi.

---

### Takliflar

- T2 da `costVarianceValue` ko'rsatkichi egasi foyda hisobotida alohida qator sifatida chiqarilishi (`TOPSHIRIQ.md` da ham qayd etilgan).
- F3 da kiruvchi QQS (`vatRateBp`, `vatAmount`) hisobga olinadigan QQS hisoboti bilan bog'lanadi (ustunlar allaqachon `local_receiving_draft_lines` va `goods_receiving_lines` da tayyor).

---

### Egasi yoki Claude qarori kerak bo'lgan savollar

Yo'q. PR #15 merge uchun Claude'ning `QABUL` tekshiruvini kutmoqda.
