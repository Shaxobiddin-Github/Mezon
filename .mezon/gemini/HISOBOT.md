## Merge yakuni: T1.2 (`PR #9`)

- **PR #9:** https://github.com/Shaxobiddin-Github/Mezon/pull/9 (`headSha`: `2d47a4138d15d7dea0fb61361e504ed1acbd8358`, 4 ta CI job'ining hammasi `success`: [Run #42836615237](https://github.com/Shaxobiddin-Github/Mezon/actions/runs/42836615237), [Run #42836609028](https://github.com/Shaxobiddin-Github/Mezon/actions/runs/42836609028))
- **Squash and merge commit sarlavhasi:** `T1.2: Ombor, partiya va inventarizatsiya`
- **Merge commit SHA (`main`):** `e9a9431d13cd16af3173e6b674a308b59c3663bb`
- **Branch holati:** `gemini/T1.2-stock` lokal va masofadan o'chirildi; `main` dan `gemini/T1.3-cart-pricing` branch'i ochildi.

---

## Reja: T1.3 — Savat va narx

> **1-alohida commit (`T1.2 test qarzi: yaxlitlash va partiyani aniq tugatish`) — reja tasdiqlangach T1.3 kodidan oldin yoziladi:**
> 1. `packages/domain/src/stock.test.ts` va `packages/db-local/src/stock.test.ts` ga `computeProportionalCost` uchun yuqoriga yaxlitlanadigan holat (`10_000` tiyin / `3 kg` dan `2 kg` chiqim → `6_667` tiyin) qo'shiladi; `divideRoundHalfAwayFromZero` ni `/` ga almashtirish mutatsiyasi testlarni yiqitishini isbotlash.
> 2. `packages/db-local/src/stock.test.ts` ga `applyReplayStockMove` da partiya aynan `0` gacha tugaydigan (`remBatchMilli === needMilli`) holatdan keyin `rebuildStockProjections()` 0 ta `local_stock_conflicts` yozishini va qiymat o'zgarmasligini tekshiruvchi test qo'shiladi; `>=` → `>` mutatsiyasi testni yiqitishini isbotlash.

### 1. Rejalashtirilgan fayllar

- `packages/domain/src/errors.ts`, `auth.ts`, `auth.test.ts`, `index.ts` — yangi ruxsatlar (`cart:write`, `promotions:read`, `promotions:write`, `discounts:config`), xato kodlari (`CART_NOT_FOUND`, `CART_NOT_OPEN`, `CART_NOT_PARKED`, `CART_LINE_NOT_FOUND`, `PROMOTION_NOT_FOUND`, `INVALID_PROMOTION`, `DISCOUNT_OVERRIDE_REQUIRED`, `SUPERVISOR_PIN_REQUIRED`).
- `packages/domain/src/cart.ts`, `packages/domain/src/cart.test.ts` — sof savat hisob-kitob dvigateli, aksiyalar nomzod tanlovi (`N+M`, foiz, summa, `Asia/Tashkent` UTC+5 vaqt siyosati), `allocate` asosida chegirma taqsimlash, `calculateVatIncluded`, tez savdo qatori, limit tekshiruvi va `fast-check` property testlar.
- `packages/contracts/src/cart.ts`, `packages/contracts/src/cart.test.ts`, `packages/contracts/src/index.ts` — savat, qator (katalog / skan / tez savdo), aksiya CRUD, chegirma sozlamalari hamda kassir javoblaridan tannarxni istisno qiluvchi qat'iy Zod 4 sxemalar.
- `packages/db-local/src/schema/index.ts`, `drizzle/0005_cart_pricing.sql`, `drizzle/meta/0005_snapshot.json`, `drizzle/meta/_journal.json` — `promotions` (`ATTR`), `local_carts` (`LOCAL`), `local_cart_lines` (`LOCAL`) hamda `local_hub_config` kengaytmalari (`cashier_max_discount_percent_bp`, `cashier_max_discount_amount`, `quick_sale_default_mxik`, `quick_sale_default_vat_rate_bp`); `0004 → 0005` mavjud bazani saqlab yangilash va `db:check` trigger himoyalari.
- `packages/db-local/src/auth-repo.ts`, `apps/hub/src/auth-service.ts`, `apps/hub/src/hub.test.ts` — T0.6 dagi 3-fazali Argon2id + lock/backoff mexanizmini qayta ishlatuvchi `verifySupervisorPin()` (kassir rolini va noto'g'ri/bloklangan PIN ni rad etadi).
- `packages/db-local/src/cart-repo.ts`, `packages/db-local/src/cart.test.ts`, `packages/db-local/src/index.ts`, `index.test.ts` — `SqliteCartStore`, park/resume, katalog narxi o'zgarishi ogohlantirishi, refresh, supervisor tasdiqli chegirma, `promotions` CRUD.
- `apps/hub/src/error-handler.ts`, `routes.ts`, `server.ts`, `index.ts`, `cart-service.ts`, `cart-routes.ts`, `cart.test.ts` — `/carts/*`, `/promotions/*`, `/cart-settings` endpointlari va integratsion RBAC / PIN / narx o'zgarishi testlari.

---

### 2. Arxitektura qarorlari (`a`–`h`)

#### a) Savat qayerda yashaydi
- **Sof hisob-kitob (`packages/domain`):** savat holatini hisoblash (`evaluateCart` / `calculateCartTotals`) IO'siz sof funksiya bo'ladi: qatorlar, amaldagi aksiyalar ro'yxati, buyurtma darajasidagi qo'lda chegirma va `nowMs` beriladi, qatorlar kesimidagi barcha summalar, qo'llangan aksiya, taqsimlangan chegirma va QQS qaytadi.
- **Lokal saqlash (`LOCAL` jadvallar):** `local_carts` va `local_cart_lines` (`tenantScope: 'store'`, `LOCAL`) SQLite'da saqlanadi, `local_outbox` ga umuman yozilmaydi va sinxronlanmaydi. Ilova o'chib yonsa ham kassirning ochiq va kechiktirilgan (`parked`) cheklari saqlanib qoladi.
- **Park / Resume:** `POST /carts/:id/park` ochiq savatni `status = 'parked'` ga o'tkazadi (`park_label`, `parked_at_ms` saqlanadi). `POST /carts/:id/resume` esa kechiktirilgan chekni qayta `'open'` ga o'tkazadi; agar kassirda shu payt bo'sh `'open'` savat turgan bo'lsa (`0` ta qator) u tozalanadi, agar ichida qatori bo'lsa yo'qolmasligi uchun avtomatik `'parked'` qilinadi.
- **Ombor va outbox daxlsizligi:** savat bosqichida `stock_moves`, `batches` va `local_outbox` ga **hech narsa yozilmaydi**. Zaxiradan chiqim va `sale` hodisasi faqat T1.4 `completeSale` ichida yoziladi.

#### b) Narx snapshot'i
- Qator qo'shilganda joriy katalogdan (`product.salePrice` yoki `variant.salePrice ?? product.salePrice`), nom, birlik, kategoriya va fiskal maydonlar (`mxik`, `package_code`, `vat_rate_bp`) qatorda snapshot sifatida yozib olinadi.
- **Katalog narxi savat ochiq/parked turganda o'zgarsa:** **kassirga ogohlantirish bilan ixtiyoriy qayta narxlash** tanlanadi (jim ustidan yozish YO'Q, savatni bloklash ham YO'Q):
  - *Asos:* mijoz kassa oldida turganda menejer katalog narxini o'zgartirsa, chek summasi kassir xabarisiz o'zgarib ketishi kassa mojarosiga olib keladi; bloklash esa uzluksiz savdo qoidasini (`GEMINI.md` 3.2) buzadi.
  - Savat o'qilganda (`GET /carts/:id`, `resume`, park/cart ro'yxati) har bir katalog qatori joriy `products`/`product_variants` narxi bilan solishtiriladi va farq bo'lsa javobda `priceChangeWarning: { snapshotUnitPrice, currentUnitPrice }` (yoki o'chirilgan bo'lsa `catalogDeleted: true`) qaytadi.
  - Kassir `POST /carts/:id/refresh-prices` orqali bir harakat bilan joriy katalog narxlarini snapshot'ga yangilay oladi (yoki snapshot narxida davom etishi mumkin; yakuniy siyosat T1.4 da ham ulanadi).

#### c) Aksiyalar (`promotions`)
- **`promotions` jadvali (`ATTR`, `tenantScope: 'organization'`):** ixtiyoriy `storeId` (null = butun tashkilot, UUID = bitta do'kon), `name`, `type` (`'percent' | 'fixed_amount' | 'buy_x_get_y'`), `scope` (`'product' | 'category' | 'all'`), `targetProductId`, `targetCategoryId`, `discountPercentBp` (`1..10000`), `discountAmount` (`> 0n` tiyin), `buyQty` (`>= 1`), `freeQty` (`>= 1`), `startsAtMs`, `endsAtMs` (nullable; mavjud bo'lsa `endsAtMs > startsAtMs`), `isActive`.
- **Summa aksiyasi birligi (`fixed_amount`):** chegirma **birlik boshiga** (`multiply(discountAmount, qty)`, maksimal `lineGross`) hisoblanadi. *Asos:* aks holda kassir 3 ta bir xil tovarni 3 ta alohida qatorga skan qilib 3 marta chegirma olishi mumkin bo'lardi; birlik boshiga hisoblash qatorlarni birlashtirish/ajratishda doim bir xil natija beradi.
- **Amal qilish oralig'i va vaqt mintaqasi:**
  - Tekshiruv UTC Unix ms'da: `startsAtMs <= nowMs && (endsAtMs === null || nowMs < endsAtMs)` (boshlanishi kiradi, tugashi kirmaydi).
  - Vaqt mintaqasi siyosati: O'zbekiston bo'yicha yagona `Asia/Tashkent` (`UTC+05:00`, doimiy siljish `18_000_000n` ms, DST yo'q). Kelajakda kunlik soat / hafta kuni qoidalari `nowMs + 18_000_000n` orqali OS sozlamasidan mustaqil hisoblanadi.
- **Ustma-ust qo'llash va determinizm:**
  - Bitta qatorga eng ko'pi **1 ta** aksiya — xaridorga eng katta tiyin chegirma (`promoDiscount`) beradigani tanlanadi.
  - Tenglikda deterministik tanlov: `promotion.id` (UUIDv7) bo'yicha leksikografik eng kichigi yutadi.
  - Qator aksiyalaridan keyin qolgan summaning ustiga buyurtma darajasidagi qo'lda chegirma qo'llanadi.
- **N+M (`buy_x_get_y`):**
  - Faqat butun birlikli (`unit IN ('dona', 'qadoq')`) tovarlar uchun; kasr birlikli (`kg`, `g`, `litr`, `metr`, `m2`) tovarlarda `product` qamrovli `N+M` yaratish rad etiladi (`INVALID_PROMOTION`), `category`/`all` qamrovli `N+M` esa hisoblashda kasr birlikli qatorlarga qo'llanmaydi.
  - Tekin birliklar: `wholeQty = qtyMilli / 1000n`, `freeUnits = (wholeQty / BigInt(N + M)) * BigInt(M)`, `promoDiscount = moneyFromTiyin(freeUnits * moneyToTiyin(unitPrice))`.
  - Misollar (`2+1`, narx `10_000` so'm): `qty=2 → 0` tekin (`20_000`); `qty=3 → 1` tekin (`20_000`); `qty=5 → 1` tekin (`40_000`); `qty=6 → 2` tekin (`40_000`).
- **Qiymat chegarasi:** har qanday aksiya chegirmasi `lineGross` dan oshmaydi (`clamp`), qator summasi hech qachon manfiy bo'lmaydi.

#### d) Qo'lda chegirma va ruxsat
- **`local_hub_config` sozlamalari (faqat `owner` tahrirlaydi):**
  - `cashierMaxDiscountPercentBp`: nullable int `0..10000` (migratsiya standarti: `0` — tasdiqsiz foiz chegirmasi ruxsat etilmagan).
  - `cashierMaxDiscountAmount`: nullable `sqliteMoney` `>= 0n` (migratsiya standarti: `0n` — tasdiqsiz summa chegirmasi `0`).
- **Limit tekshiruvi (backendda):**
  - Buyurtma darajasidagi qo'lda chegirma `effectiveOrderDiscount = min(requestedDiscount, subtotalAfterPromo)` ga chegaralanadi (`subtotalAfterPromo` dan oshmaydi).
  - Agar `effectiveOrderDiscount > 0n` bo'lsa:
    - `cashierMaxDiscountPercentBp !== null` bo'lsa: `effectiveOrderDiscount * 10000n <= subtotalAfterPromo * BigInt(cashierMaxDiscountPercentBp)` bajarilishi shart (kassir summa kiritib foiz limitini aylanib o'ta olmaydi).
    - `cashierMaxDiscountAmount !== null` bo'lsa: `effectiveOrderDiscount <= cashierMaxDiscountAmount` bajarilishi shart.
    - Agar ikkala chegara ham `null` bo'lsa chegirma limitsiz ruxsat etiladi; bitta chegara non-null bo'lsa o'sha chegara tekshiriladi; ikkalasi ham non-null bo'lsa ikkalasi ham birga bajarilishi shart.
  - Limitdan oshsa: so'rovda `override: { selector (userId | username), pin }` bo'lishi majburiy (aks holda `403 DISCOUNT_OVERRIDE_REQUIRED`).
- **Supervisor PIN tasdig'i (`T0.6` bilan bir xil himoya):**
  - `HubAuthService.verifySupervisorPin` T0.6 dagi 3-fazali jarayonni (SQLite lock'idan tashqarida Argon2id, TOCTOU hash tekshiruvi, 5 xato → 5 daqiqa foydalanuvchi bloki, qurilma 2..60s backoff) ishlatadi va faqat faol `owner` yoki `manager` ni qabul qiladi (`cashier` rad etiladi).
  - Tasdiqlagan foydalanuvchi ID va vaqti (`overrideApprovedByUserId`, `overrideApprovedAtMs`) `local_carts` da saqlanadi. Qator qo'shilib/o'zgarib chegirma yangi limitdan chiqsa tasdiq tozalanadi va qayta tasdiq talab qilinadi.

#### e) Taqsimlash va yaxlitlash
1. `lineGross = multiply(unitPriceSnapshot, qty)`.
2. Eng yaxshi aksiya chegirmasi: `linePromoDiscount = min(bestPromoDiscount, lineGross)`, `lineSubtotalAfterPromo = lineGross - linePromoDiscount`.
3. Buyurtma chegirmasi (`orderDiscount`): foiz bo'lsa `divideRoundHalfAwayFromZero(totalAfterPromo * BigInt(bp), 10000n)`, summa bo'lsa `min(amount, totalAfterPromo)`.
4. `orderDiscount > 0n` bo'lsa T0.2 `allocate(orderDiscount, lineSubtotalAfterPromo[])` bilan qatorlarga taqsimlanadi (`lineAllocatedDiscount`); `totalAfterPromo === 0n` bo'lsa barcha taqsimot `0n`.
5. `lineFinalTotal = lineSubtotalAfterPromo - lineAllocatedDiscount` (`>= 0n`).
6. **QQS:** O'zbekiston chakana savdosida katalog narxi QQS bilan birga (`VAT-inclusive`) bo'lgani uchun har bir qator bo'yicha `calculateVatIncluded(lineFinalTotal, lineVatRate)` hisoblanadi (`lineNetExVat + lineVat === lineFinalTotal`).
- **Property testlar (`fast-check`):**
  - `Σ lineFinalTotal === cartTotal` (`Σ lineSubtotalAfterPromo - effectiveOrderDiscount`)
  - `Σ lineAllocatedDiscount === effectiveOrderDiscount`
  - `Σ linePromoDiscount === totalPromoDiscount`
  - Har qator uchun `lineFinalTotal >= 0n`, `lineVat >= 0n`, `lineNetExVat + lineVat === lineFinalTotal`.

#### f) Tez savdo qatori va F3 mosligi
- Qator `kind: 'quick_sale'`: `productId = null`, `variantId = null`, erkin `name` (`1..200`), `unit`, `qty` (`dona`/`qadoq` da butun son), `unitPrice` (`>= 0n`), ixtiyoriy `mxik` / `vatRateBp`.
- `local_hub_config` da `quick_sale_default_mxik` (nullable text) va `quick_sale_default_vat_rate_bp` (nullable int `0..10000`) saqlanadi (`owner` sozlaydi). Qatorda ko'rsatilmagan bo'lsa shu standart qiymatlar (`vatRateBp ?? 0`) snapshot qilinadi.
- F1 da `quick_sale_default_mxik` `NULL` bo'lsa ham tez savdo bemalol ishlaydi; F3 (`T3.1`/`T3.2`) ulanganda esa egasi umumiy MXIK'ni sozlab qo'ysa barcha yangi tez savdo qatorlari tayyor MXIK snapshot'iga ega bo'ladi, `mxikSnapshot === null` qatorlarni esa `T3.2` qoidalar dvigateli fiskal rejim siyosatiga qarab aniqlaydi — sxema o'zgartirishsiz F3 ga tayyor.

#### g) Hub API va RBAC
- `cart:write` (`owner`, `manager`, `cashier`):
  - `POST /carts`, `GET /carts`, `GET /carts/:id`, `DELETE /carts/:id`
  - `POST /carts/:id/lines` (productId / variantId / barcode skan / quick_sale), `PATCH /carts/:id/lines/:lineId`, `DELETE /carts/:id/lines/:lineId`
  - `PUT /carts/:id/discount`, `POST /carts/:id/refresh-prices`, `POST /carts/:id/park`, `POST /carts/:id/resume`
  - `GET /cart-settings`
- `promotions:read` (`owner`, `manager`, `cashier`): `GET /promotions`
- `promotions:write` (`owner`, `manager`): `POST /promotions`, `PATCH /promotions/:id`, `DELETE /promotions/:id` (kassirga `403 AUTH_FORBIDDEN`)
- `discounts:config` (faqat `owner`): `PUT /cart-settings` (`cashier` va `manager` ga `403 AUTH_FORBIDDEN`)
- Kassir javoblarida tannarx, partiya qiymati va foyda maydonlari mutlaqo bo'lmaydi.

#### h) Doiradan tashqari
`completeSale`, to'lovlar va ombordan chiqim (`T1.4`/`T1.5`), naqd pulni so'mga yaxlitlash (`T1.5`), kassa UI (`T1.11`).

---

### 3. Rejalashtirilgan testlar

- **Commit 1 (`T1.2 test qarzi`):** yuqoriga yaxlitlash (`10_000 / 3 * 2 → 6_667` tiyin) domen + ombor testlari va partiyani aynan `0` gacha tugatish (`remBatchMilli === needMilli`) bo'yicha soxta konflikt chiqmasligi testi (ikkala mutatsiya bilan isbotlanadi).
- **Domen birlik & property testlari (`packages/domain/src/cart.test.ts`):** `N+M` (`2+1` uchun `2/3/5/6` va kasr birlik bloki), foiz/summa aksiya qamrovi va `[start, end)` chegarasi, tenglikda `id` bo'yicha determinizm, `allocate` 1-tiyin taqsimoti, `VAT` ichidan ajratish, tez savdo, va `fast-check` balans invariantlari.
- **Kontrakt & DB testlari (`packages/contracts/src/cart.test.ts`, `packages/db-local/src/cart.test.ts`, `index.test.ts`):** `0004 → 0005` mavjud ma'lumotlar bilan migratsiya testi, `local_carts` crashdan keyin saqlanishi, park/resume, katalog narxi o'zgarganda ogohlantirish + refresh, `local_outbox` ga yozilmasligi.
- **Hub API & Xavfsizlik (`apps/hub/src/cart.test.ts`):** kassir limitdan oshira olmasligi (`403 DISCOUNT_OVERRIDE_REQUIRED`), `manager`/`owner` to'g'ri PIN bilan tasdiqlashi, `cashier` PIN'i rad etilishi, 5 marta xato PIN → 5 daqiqa blok va qurilma backoff'i (`T0.6`), `promotions` va `/cart-settings` RBAC matritsasi, javoblarda tannarx/foyda yo'qligi.
