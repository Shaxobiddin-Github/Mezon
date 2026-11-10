## Hisobot: T1.3
Branch / PR: `gemini/T1.3-cart-pricing` / https://github.com/Shaxobiddin-Github/Mezon/pull/10
Commit:
- `721a003b073979709e77e6b5df90b133e3304d32` — `T1.2 test qarzi: yaxlitlash va partiyani aniq tugatish`
- `0ddabfae8204e32526ce8938d6060f54e7afe6ca` — `T1.3: Savat, aksiyalar (N+M), chegirma limiti va supervisor PIN`

### Nima qilindi

1. **T1.2 test qarzi (`721a003`, mutatsiya dalillari bilan):**
   - `packages/domain/src/stock.test.ts` (`T1.2 test debt: rounds up 10,000 / 3 * 2 = 6,667 and drains remBatchMilli === needMilli without conflict`) va `packages/db-local/src/stock.test.ts` (`T1.2 test debt: FIFO rounds up 10,000 / 3 * 2 = 6,667 and exact batch drain produces zero conflicts on rebuild`):
     - **1-mutatsiya isboti:** `computeProportionalCost` dagi `divideRoundHalfAwayFromZero(remVal * takeMilli, remMilli)` oddiy butun bo'lishga (`(remVal * takeMilli) / remMilli`) almashtirilganda `@mezon/domain` (`6666n !== 6667n`) va `@mezon/db-local` (`-6666n !== -6667n`) testlari ikkalasi ham yiqildi (keyin tiklandi).
     - **2-mutatsiya isboti:** `applyReplayStockMove` dagi `remBatchMilli >= needMilli` sharti `remBatchMilli > needMilli` ga almashtirilganda `@mezon/domain` (soxta `BATCH_OVERCONSUMED`) va `@mezon/db-local` (`rebuild.conflictsDetected = 1 !== 0`) testlari ikkalasi ham yiqildi (keyin tiklandi).

2. **Savat va narx domeni (`packages/domain/src/cart.ts`):**
   - To'liq `bigint` asosida (nol `Number`) sof `evaluateCart` hisob-kitob dvigateli:
     - Qator summasi `multiply(unitPriceSnapshot, qty)` bilan hisoblanadi.
     - **Aksiyalar:** `percent`, `fixed_amount` (birlik boshiga: `multiply(discountAmount, qty)`, maksimal `lineGross`) va `buy_x_get_y` (N+M, faqat butun birlikli `dona`/`qadoq` katalog tovarlari).
     - **P1:** `(productId, variantId)` bo'yicha `N+M` miqdorlari guruhlanadi (`assignGroupPromotions`), tekin birliklar `unitPriceSnapshot ASC, line.id ASC` tartibida arzon qatordan boshlab taqsimlanadi, va guruh uchun g'olib `N+M` aksiya qolgan birliklarga `%` aksiya qo'llab ikki marta foyda olish (`double-dip`) ni oldini oladi.
     - **Vaqt siyosati:** `[startsAtMs, endsAtMs)` yarim-ochiq UTC ms oralig'i hamda OS sozlamasidan mustaqil `Asia/Tashkent` (`UTC+05:00`, `TASHKENT_UTC_OFFSET_MS = 18_000_000n`) `toTashkentLocalTime` funksiyasi.
     - **Buyurtma chegirmasi va QQS:** `effectiveOrderDiscount = min(requested, subtotalAfterPromo)`, T0.2 `allocate` bilan qatorlarga proporsional taqsimlash, keyin har qator bo'yicha `calculateVatIncluded(finalTotal, vatRate)` (`net + vat === finalTotal`).

3. **Kontraktlar (`packages/contracts/src/cart.ts`):**
   - **P3:** `CashierDiscountLimitSchema` va `UpdateCartSettingsRequestSchema` da aniq `percentUnlimited: boolean` va `amountUnlimited: boolean` majburiy (null/tushirib qoldirish `400` bilan rad etiladi).
   - Katalog / skan / tez savdo qatorlari, aksiya CRUD va `CartDetailSchema` (tannarx/foyda maydonlarisiz) uchun qat'iy Zod 4 sxemalar.

4. **Lokal baza (`packages/db-local`):**
   - `0005_cart_pricing.sql`: `local_hub_config` ga 6 ta ustun (`cashier_discount_percent_unlimited`, `cashier_max_discount_percent_bp`, `cashier_discount_amount_unlimited`, `cashier_max_discount_amount`, `quick_sale_default_mxik`, `quick_sale_default_vat_rate_bp`) xavfsiz `ALTER TABLE` orqali qo'shildi, hamda `promotions` (`ATTR`, `target_store_id` + `trg_promotions_no_delete`), `local_carts` (`LOCAL`), `local_cart_lines` (`LOCAL`, `ON DELETE CASCADE`) jadvallari yaratildi.
   - `SqliteCartStore` (`cart-repo.ts`):
     - Savat amallarida `stock_moves` va `local_outbox` ga **hech narsa yozilmaydi**; ilova yopilib yonsa ham savat saqlanadi (`park`/`resume` bilan).
     - **P1:** bir xil `productId + variantId + unitPriceSnapshot` katalog qatoriga skan/qo'shish mavjud qator `qty` sini oshiradi; tez savdo qatorlari birlashtirilmaydi.
     - **Narx ogohlantirishi:** katalog narxi o'zgarsa `priceChangeWarning` qaytadi, `refreshPrices` esa joriy katalog narxini snapshot'ga oladi va birlashib qolgan qatorlarni jamlashga o'tkazadi.
     - **P2:** `override_approved_amount` saqlanadi; savat kattalashib `effectiveOrderDiscount` tasdiqlangan summadan ham, kassir limitidan ham oshsa `revokeOverrideIfNeededSync` tasdiqni avtomatik bekor qiladi (`override_approved_* = null`, `discountOverrideRequired = true`).
   - `SqliteHubAuthStore` (`auth-repo.ts`): T0.6 dagi `runPinVerificationSync` umumiy helper'iga ajratildi va `commitPinVerificationOutcome` (`allowedRoles: ['owner', 'manager']`) qo'shildi.

5. **Hub API (`apps/hub`):**
   - `verifySupervisorPin`: Argon2id, TOCTOU hash himoyasi, 5 xato → 5 daqiqa foydalanuvchi bloki va 2..60s qurilma backoff'ini ishlatadi (`cashier` PIN ni `403`, noto'g'ri PIN ni `401`, bloklanganini `429` bilan rad etadi).
   - `PUT /cart-settings` faqat `owner` ga ruxsat (`discounts:config`); `unlimited: true` yoqilganda javobda `unlimitedDiscountEnabled: true` qaytadi va Pino logga `discount_policy.unlimited_enabled` warning yoziladi.
   - `/carts/*`, `/promotions/*`, `/cart-settings` RBAC bilan himoyalandi va barcha javoblar tannarx/foydasiz allow-list mapper orqali qaytarildi.

### O'zgargan fayllar (fayl — sabab)

- `.mezon/gemini/HISOBOT.md` — T1.3 yakuniy hisoboti
- `packages/domain/src/stock.test.ts` — T1.2 test qarzi (`10,000 / 3 * 2 = 6,667` va `remBatchMilli === needMilli`)
- `packages/domain/src/errors.ts`, `auth.ts`, `auth.test.ts`, `index.ts` — `cart`/`promotions`/`discounts:config` ruxsatlari va savat/aksiya xato kodlari
- `packages/domain/src/cart.ts`, `cart.test.ts` — to'liq `bigint` savat/aksiya/N+M/QQS/P1/P2/P3 dvigateli va property testlar
- `packages/contracts/src/cart.ts`, `cart.test.ts`, `index.ts` — savat, aksiya, P3 chegirma limiti DTO va Zod 4 sxemalari
- `packages/db-local/src/schema/index.ts` — `promotions`, `local_carts`, `local_cart_lines` va `local_hub_config` kengaytmalari
- `packages/db-local/drizzle/0005_cart_pricing.sql`, `meta/0005_snapshot.json`, `meta/_journal.json` — `ALTER TABLE` va yangi jadvallar migratsiyasi + `trg_promotions_no_delete`
- `packages/db-local/src/auth-repo.ts` — umumiy `runPinVerificationSync` va `commitPinVerificationOutcome`
- `packages/db-local/src/cart-repo.ts`, `cart.test.ts`, `index.ts` — `SqliteCartStore` va T1.3 lokal baza testlari
- `packages/db-local/src/stock.test.ts`, `index.test.ts` — T1.2 test qarzi, 22 jadval registri va 6 migratsiya tekshiruvi
- `apps/hub/src/auth-service.ts`, `error-handler.ts`, `routes.ts`, `server.ts`, `index.ts` — `verifySupervisorPin`, xato kodlari va routelarni ulash
- `apps/hub/src/cart-service.ts`, `cart-routes.ts`, `cart.test.ts` — HTTP endpointlar, RBAC, P1/P2/P3, T0.6 lockout va Pino audit testi

### Migratsiyalar

- `packages/db-local/drizzle/0005_cart_pricing.sql`:
  - `local_hub_config` ga `ALTER TABLE ADD COLUMN` bilan `cashier_discount_percent_unlimited`, `cashier_max_discount_percent_bp`, `cashier_discount_amount_unlimited`, `cashier_max_discount_amount`, `quick_sale_default_mxik`, `quick_sale_default_vat_rate_bp` qo'shildi.
  - `promotions` (`ATTR`, `trg_promotions_no_delete`), `local_carts` (`LOCAL`), `local_cart_lines` (`LOCAL`, `ON DELETE CASCADE`) yaratildi (`check-migrations.mjs`: 0 diff).

### Qabul mezonlari

- [x] **T1.2 test qarzi va mutatsiya isbotlari (`721a003`)** — `packages/domain/src/stock.test.ts` (`T1.2 test debt: rounds up 10,000 / 3 * 2 = 6,667 and drains remBatchMilli === needMilli without conflict`) va `packages/db-local/src/stock.test.ts` (`T1.2 test debt: FIFO rounds up 10,000 / 3 * 2 = 6,667 and exact batch drain produces zero conflicts on rebuild`); ikkala mutatsiya bilan testlarning yiqilishi tekshirildi.
- [x] **P1 (skan birlashtirish, guruhlangan N+M va taqsimlash)** — `packages/db-local/src/cart.test.ts` (`persists local carts across restart...`: 3 marta skan → 1 qator `qty=3` → 1 tekin), `packages/domain/src/cart.test.ts` (`P1: pools N+M across different-price lines of same product...`: 2+1 turli narxli qatorlarda eng arzon qatorga berilishi + 100-run property test).
- [x] **P2 (`override_approved_amount` va savat o'sganda tasdiq bekor qilinishi)** — `packages/domain/src/cart.test.ts`, `packages/db-local/src/cart.test.ts` (`P2: revokes supervisor discount approval when cart grows past override_approved_amount...`) va `apps/hub/src/cart.test.ts` (`enforces full RBAC, P1 line merge & N+M, P2 override_approved_amount...`: 10% tasdiqdan keyin savat kattalashganda tasdiq bekor bo'lishi va `403 DISCOUNT_OVERRIDE_REQUIRED` qaytishi).
- [x] **P3 (aniq `unlimited` bayrog'i, faqat `owner`, javob + log)** — `packages/contracts/src/cart.test.ts` (`null`/tushirib qoldirish rad etilishi), `apps/hub/src/cart.test.ts` (`owner` ga `200`, `manager`/`cashier` ga `403 AUTH_FORBIDDEN`, javobda `unlimitedDiscountEnabled: true`, Pino logda `discount_policy.unlimited_enabled`).
- [x] **N+M worked misollar (`2+1`) va kasr cheklovi** — `packages/domain/src/cart.test.ts` (`computes N+M (2+1) across exact worked examples and blocks fractional N+M`: `2→0`, `3→1`, `5→1`, `6→2`; `kg` uchun rad etiladi).
- [x] **Chegirma taqsimoti, QQS va property testlar tavsifi**:
  1. `packages/domain/src/cart.test.ts` — `P1: pools N+M across different-price lines...` ichida 2 ta `fast-check` property test (100 tadan run): (A) ixtiyoriy qator bo'linishi `[q1..q5]`, istalgan narx va istalgan `buyQty/freeQty` da `totalFreeUnits`, `totalPromoDiscount` va `totalFinal` birlashtirilgan qator bilan teng; (B) raqobatdosh `10%` aksiyasi (10 ga karrali narxda) bilan birga ham bo'lingan qatorlarda `N+M` + `%` dubl-foyda olinmasligi.
  2. `packages/domain/src/cart.test.ts` — `property test: Σ lineFinalTotal = cartTotal, Σ allocated = orderDiscount, Σ vat + net = totalFinal, and zero negative values` (`fast-check`, 200 run): katalog va tez savdo aralash qatorlar, barcha turdagi aksiyalar va order chegirmalarida `Σ lineFinalTotal === totalFinal`, `Σ allocatedOrderDiscount === effectiveOrderDiscount`, `Σ promoDiscount === totalPromoDiscount`, `netExVat + vatTotal === finalTotal` va barcha summalar `>= 0n`.
- [x] **Kassir cheklovlari, T0.6 PIN lockout va tannarx yashirish** — `apps/hub/src/cart.test.ts` (`enforces full RBAC...`: kassir limitdan oshira olmaydi, `cashier` PIN'i rad etiladi, 5 xato PIN → 429 `AUTH_RATE_LIMITED` + `Retry-After`, javoblarda tannarx/foyda/PIN yo'q).
- [x] **Tez savdo qatori, narx ogohlantirishi, park/resume va 0 outbox/ombor** — `packages/db-local/src/cart.test.ts` (`persists local carts across restart...`) va `apps/hub/src/cart.test.ts`.

### Test natijasi (buyruq va haqiqiy chiqish)

1. Lokal `pnpm verify` (`0ddabfa` ustida):
   - `prettier --check .` → `All matched files use Prettier code style!`
   - `turbo run build` → `17 successful, 17 total`
   - `eslint .` → 0 xato
   - `turbo run typecheck` → 0 xato
   - `turbo run db:check` → PostgreSQL va SQLite (`19 successful, 19 total`, 0 diff)
   - `vitest run` → `Test Files 33 passed | 1 skipped (34)`, `Tests 163 passed | 2 skipped (165)` (skip: `packages/db-cloud/src/pg-rls.test.ts` lokal Windows'da Docker yo'qligi uchun)
   - `depcruise --config .dependency-cruiser.cjs apps/*/src packages/*/src` → `no dependency violations found (209 modules, 632 dependencies cruised)`

2. GitHub Actions CI (`0ddabfae8204e32526ce8938d6060f54e7afe6ca`):
   - Workflow runs: https://github.com/Shaxobiddin-Github/Mezon/actions/runs/42842445847 (PR) va https://github.com/Shaxobiddin-Github/Mezon/actions/runs/42842364034 (push)
   - `Verify (ubuntu-latest)`: `success` — https://github.com/Shaxobiddin-Github/Mezon/actions/runs/42842445847/job/129920925932
   - `Verify (windows-latest)`: `success` — https://github.com/Shaxobiddin-Github/Mezon/actions/runs/42842445847/job/129920924623
   - `Verify PostgreSQL RLS (ubuntu-latest)`: `success` — https://github.com/Shaxobiddin-Github/Mezon/actions/runs/42842445847/job/129920924203
   - `Build & E2E Desktop Installer (windows-latest)`: `success` — https://github.com/Shaxobiddin-Github/Mezon/actions/runs/42842445847/job/129920924654

### Tekshirilmagan narsalar

- `packages/db-cloud/src/pg-rls.test.ts` (2 ta test) lokal Windows mashinasida Docker bo'lmagani uchun skip qilindi; GitHub Actions CI dagi `Verify PostgreSQL RLS (ubuntu-latest)` job'ida to'liq bajarildi va muvaffaqiyatli o'tdi.

### Qilingan taxminlar

- O'zbekiston chakana POS savdosida mahsulot `sale_price` qiymati QQS bilan birga (`VAT-inclusive`) hisoblangani uchun har qatorning chegirmadan keyingi yakuniy summasi ustida `calculateVatIncluded` qo'llandi (`net + vat === finalTotal`).
- `promotions` `ATTR` jadvalida do'kon bo'yicha ixtiyoriy filtr `target_store_id` (`null` = tashkilotning barcha do'konlari) deb nomlandi, shunda `writers.ts` dagi tenant `store_id` sharti (`tenantScope: 'organization'`) buzilmaydi.

### Takliflar

- `T1.4` (`completeSale`) da `SqliteCartStore.assertCartDiscountAuthorized` hamda `local_carts` / `local_cart_lines` o'qilib, bitta `uow.execute` tranzaksiyasi ichida katalog narxi drifti siyosati va zaxira chiqimi (`applyOutboundInsideSessionSync`) bilan birga atomar yakunlanishi maqsadga muvofiq.

### Egasi yoki Claude qarori kerak bo'lgan savollar

- Yo'q. PR #10 merge qilish uchun Claude `QABUL` qarori kutilmoqda.
