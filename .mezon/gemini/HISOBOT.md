## Hisobot: T1.11 — Kassa UI (`apps/pos`, `@mezon/i18n`, `@mezon/ui`)

Branch / PR: `gemini/T1.11-pos-ui` / PR #18 (`https://github.com/Shaxobiddin-Github/Mezon/pull/18`)
Commit: `ccffc6e`
PR #17 (T1.10) Squash and merge SHA: `99ca0d69b0db5113e064178fef9111833f699798` (`gemini/T1.10-orders-advances` branch'i o'chirildi)

---

### Nima qilindi

1. **U1–U4 majburiy tuzatishlar to'liq bajarildi:**
   - **U1 (Faqat mavjud Hub API'si):** Kassa UI (`apps/pos/src/api/hub-client.ts`) faqat mavjud Hub marshrutlaridan foydalanadi (`/health`, `/setup/bootstrap`, `/auth/pin-login`, `/auth/logout`, `/auth/me`, `/shifts/current`, `/shifts/open`, `/shifts/:id/cash-moves`, `/shifts/:id/close`, `/catalog/search`, `/catalog/scan`, `/carts`, `/carts/:id`, `/carts/:id/scan`, `/carts/:id/items`, `/carts/:id/items/:lineId`, `/carts/:id/quick-sale`, `/carts/:id/discount`, `/carts/:id/park`, `/carts/:id/resume`, `/carts/:id/cancel`, `/carts/:id/complete`, `/sales/:id`, `/customers`, `/promotions`). Har qanday savdo yagona `POST /carts/:id/complete` (`completeSale`) komandasi orqali o'tadi.
   - **U2 (Kontraktda yo'q maydonlar o'ylab topilmadi):** `@mezon/contracts` sxemalariga hech qanday uydirma to'lov yoki javob maydonlari qo'shilmadi. Naqdsiz to'lovlar uchun mavjud `providerRef` maydonidan foydalanildi; chek oynasida `"SINOV — FISKAL EMAS"` yozuvi doimiy i18n satri (`t('receipt.nonFiscalBanner')`) sifatida ko'rsatiladi; rahbar tasdig'i uchun `@mezon/contracts`dagi mavjud `override: { username, pin }` va `creditOverride: { supervisorUsername, supervisorPin, reason }` maydonlari ishlatildi.
   - **U3 (Dev CORS ishlab chiqarishda yoqilmaydi):** `createHubServer(options)` ga faqat aniq `enableDevLoopbackCors: true` uzatilgandagina (`apps/hub/src/config.ts`, `apps/hub/src/security.ts`, `apps/hub/src/server.ts`) loopback origin'lar (`http://127.0.0.1:<port>`, `http://localhost:<port>`) uchun CORS preflight (`OPTIONS`) va `Access-Control-Allow-Origin` javoblari yoqiladi. `process.env` o'zgaruvchisi orqali avtomatik yoqilmaydi va Electron worker (`apps/hub/src/electron-worker.ts`) bu bayroqni hech qachon yoqmaydi. Standart Hub konfiguratsiyasida `http://localhost:5173` origin'idan kelgan `POST /carts` so'rovi `403 FORBIDDEN_ORIGIN` bilan rad etilishi `apps/hub/src/hub.test.ts` da testlandi.
   - **U4 (E2E Windows va Ubuntu CI'da):** `.github/workflows/ci.yml` da Playwright Chromium keshi (`actions/cache@v4`) bilan `pnpm verify` ichida `pnpm run test:e2e:pos` ham `ubuntu-latest`, ham `windows-latest` joblarida ishga tushadi va yashil o'tdi.

2. **Ko'p tilli lug'at (`@mezon/i18n`) va pul/miqdor formatlash hamda mavzu yordamchilari (`@mezon/ui`):**
   - `packages/i18n/src/locales/uz-Latn.ts` va `packages/i18n/src/index.ts`: `i18next` 27 asosida sinxron `initPosI18n()` va barcha kassa UI ekranlari, tugmalar, klaviatura qisqa yo'llari, to'lov turlari, smena va xato xabarlari uchun to'liq `uz-Latn` lug'ati yaratildi.
   - `packages/ui/src/index.ts`: tiyin va milli-birliklar uchun `bigint`-xavfsiz formatlash/parslash funksiyalari (`formatTiyinToSom`, `parseSomInputToTiyin`, `formatMilliQuantity`, `parseDecimalToMilli`, `computeChangePreviewTiyin` — faqat `bigint` arifmetikasi, `number`/`float` ishlatilmaydi) hamda kunduzgi/tungi mavzu (`ThemeMode`: `'light' | 'dark'`) yordamchilari yozildi.

3. **USB HID Skaner Detektori va DataMatrix / GS1 (`\x1d`) qo'llovi:**
   - `packages/domain/src/catalog.ts` va `packages/contracts/src/cart.ts`: `MAX_CATALOG_BARCODE_LENGTH = 128` va `BARCODE_ALLOWED_REGEX = /^[\x1dA-Za-z0-9._+/=()-]+$/` orqali GS1 DataMatrix (`\x1d` Group Separator va qavslar/belgilar) shtrix-kodlari buzilmasdan domen va kontrakt darajasida qabul qilinishi ta'minlandi.
   - `apps/pos/src/scanner/scanner-detector.ts`: sof TypeScript USB skaner detektori (`createScannerDetector`) yozildi:
     - Belgilar orasidagi maksimal kechikish `maxInterKeyDelayMs = 35 ms`, o'rtacha tezlik `maxAverageIntervalMs = 25 ms`, minimal uzunlik `minLength = 4` va yakunlovchi `Enter` / `Tab`.
     - GS1 Group Separator (`\x1d`, `GroupSeparator` yoki `Ctrl+]`) belgilarini kesib tashlamasdan buferga `\x1d` sifatida yozadi.
     - Faol `<input>`, `<textarea>`, `[data-scanner-ignore="true"]` elementlarida oddiy yozishni (shu jumladan tez yozuvchi — ~55–80 ms/belgi bilan yozib `Enter` bosgan odamni) skaner deb qabul qilmaydi va formani buzmaydi; fokus qidiruv maydonida bo'lganda haqiqiy yuqori tezlikdagi skan oqimini (`≤ 25 ms/belgi`) aniqlab, qidiruv matnini tozalaydi va `POST /carts/:id/scan` ga yuboradi.

4. **Kassa UI ekranlari, teginish va sichqonsiz klaviatura boshqaruvi (`apps/pos`):**
   - `AuthAndShiftScreens.tsx`: birinchi ishga tushirish sehrgari (`BootstrapWizardScreen`), PIN-kod orqali kirish (`PinLoginScreen` — katta sensorli numpad + klaviatura), smena ochish (`OpenShiftScreen` — boshlang'ich naqd pul bilan).
   - `PosWorkspaceScreen.tsx`: chap panelda savat qatorlari (`ArrowUp`/`ArrowDown` navigatsiyasi, `+`/`-` miqdor, `Delete` o'chirish, `F3` qator chegirmasi, `F4` savat chegirmasi, `F6` kechiktirish, `F7` kechiktirilgan cheklar ro'yxati va soni badge'i, `F8` tez savdo, `F9`/`F12` to'lov oynasi), o'ng panelda `F2` mahsulot qidiruv (`@tanstack/react-virtual` 3 bilan virtuallashtirilgan ro'yxat), sensorli numpad va amallar.
   - `PosModals.tsx` va `PaymentAndShiftModals.tsx`:
     - Tez savdo (`F8`), qator/savat chegirmasi (`F3`/`F4`) va kassir limitidan (`max_discount_pct`) oshganda rahbar (`owner`/`manager`) PIN tasdig'i (`override`).
     - Kechiktirilgan cheklar (`F6` saqlash, `F7` ro'yxatdan davom ettirish).
     - To'lov oynasi (`F9`/`F12`): 8 ta to'lov usuli (`cash`, `card`, `uzqr`, `payme`, `click`, `uzum`, `social_card`, `other`), tez kupura tugmalari, aralash to'lov, qisman yoki to'liq qarzga (`debt` + mijoz tanlash/yaratish + kredit limiti oshsa rahbar tasdig'i), qaytim faqat naqddan hisoblanishi, barqaror `clientRequestId` (UUIDv7) bilan idempotent qayta urinish.
     - Chek oynasi (`ReceiptModal`): `"SINOV — FISKAL EMAS"` banneri, `receiptNo`, qatorlar, chegirma, QQS, to'lovlar, qaytim va `Enter`/`Escape` bilan yangi savatga o'tish.
     - Smena kassa amallari (`cash_in`, `cash_out`, `expense`) va smena yopish (`CloseShiftModal`: haqiqiy sanab chiqilgan naqd pulni kiritish, yakunlanganidan so'ng kutilgan naqd, naqdsiz tushum va farq (`variance`) ko'rsatkichi).
   - **Tannarx maxfiyligi:** UI hech qayerda `cost_price`, `cost`, `margin` yoki `profit` maydonlarini so'ramaydi va DOM'da ko'rsatmaydi (Playwright E2E da tekshirildi).

---

### O'zgargan fayllar (fayl — sabab)

- `packages/i18n/package.json`, `packages/i18n/tsconfig.json`, `packages/i18n/tsconfig.test.json`, `packages/i18n/src/locales/uz-Latn.ts`, `packages/i18n/src/index.ts`, `packages/i18n/src/index.test.ts` — `i18next` 27 konfiguratsiyasi, `uz-Latn` kassa lug'ati va testlari.
- `packages/ui/package.json`, `packages/ui/tsconfig.json`, `packages/ui/tsconfig.test.json`, `packages/ui/src/index.ts`, `packages/ui/src/index.test.ts` — `bigint` pul/miqdor formatlash va parslash yordamchilari, mavzu (`light`/`dark`) funksiyalari va birlik testlari.
- `packages/domain/src/catalog.ts`, `packages/contracts/src/cart.ts` — GS1 DataMatrix (`\x1d` Group Separator va uzun shtrix-kodlar, `MAX_CATALOG_BARCODE_LENGTH = 128`) qo'llovi.
- `apps/hub/src/config.ts`, `apps/hub/src/security.ts`, `apps/hub/src/server.ts`, `apps/hub/src/hub.test.ts` — **U3**: faqat `enableDevLoopbackCors: true` berilgandagina dev loopback CORS yoqilishi; standart Hub konfiguratsiyasida `http://localhost:5173` `403 FORBIDDEN_ORIGIN` bilan rad etilishi testi.
- `apps/pos/package.json`, `apps/pos/tsconfig.test.json`, `apps/pos/playwright.config.mjs` — `@mezon/pos` bog'liqliklari (`@tanstack/react-query`, `@tanstack/react-virtual`, `zustand`, `i18next`, `@mezon/contracts`, `@mezon/domain`, `@mezon/i18n`, `@mezon/ui`) va Playwright E2E konfiguratsiyasi.
- `apps/pos/src/scanner/scanner-detector.ts`, `apps/pos/src/scanner/scanner-detector.test.ts` — USB skaner detektori (EAN-13, DataMatrix, GS1 `\x1d`, tez yozuvchi inson filtri) va testlari.
- `apps/pos/src/utils/browser-uuid.ts` — brauzerda Web Crypto (`crypto.getRandomValues`) asosida monoton UUIDv7 generatori (`clientRequestId` uchun).
- `apps/pos/src/api/hub-client.ts` — **U1 & U2**: mavjud Hub API marshrutlari uchun tipga xavfsiz HTTP klient.
- `apps/pos/src/store/pos-store.ts` — Zustand 5 asosida kassa UI holati, fokuslangan qator, modallar, mavzu va barqaror `paymentAttemptClientRequestId`.
- `apps/pos/src/components/AuthAndShiftScreens.tsx`, `apps/pos/src/components/PosWorkspaceScreen.tsx`, `apps/pos/src/components/PosModals.tsx`, `apps/pos/src/components/PaymentAndShiftModals.tsx`, `apps/pos/src/App.tsx`, `apps/pos/src/App.css`, `apps/pos/src/bridge.ts`, `apps/pos/src/index.ts` — kassa UI ekranlari, klaviatura qisqa yo'llari, modallar va kunduzgi/tungi mavzu stillari.
- `apps/pos/e2e/pos.spec.ts` — Playwright E2E testlari (to'liq savdo oqimi, skaner vs tez yozuvchi, DataMatrix `\x1d`, sichqonsiz klaviatura savdosi, kechiktirilgan chek, idempotent to'lov, smena yopish va 50 000 mahsulot qidiruv tezligi).
- `.dependency-cruiser.cjs`, `package.json`, `.github/workflows/ci.yml`, `vitest.config.ts` — dependency-cruiser qoidasi, `test:e2e:pos` skripti va CI'da Playwright Chromium keshi.
- `.mezon/gemini/pos-sales-screen.png` — kassa savdo va chek ekranining skrinshoti.

---

### Migratsiyalar

- Yo'q (`0 diff statements` — SQLite va PostgreSQL sxemalari o'zgarmadi).

---

### Qabul mezonlari va U1–U4 dalillari

- [x] **U1 — Faqat mavjud Hub API'si va yagona `completeSale` yo'li:** `apps/pos/src/api/hub-client.ts` faqat mavjud Hub marshrutlariga murojaat qiladi; savdo faqat `POST /carts/:id/complete` orqali yakunlanadi (`apps/pos/e2e/pos.spec.ts`).
- [x] **U2 — Kontraktda yo'q maydonlar o'ylab topilmadi:** `@mezon/contracts` to'lov va savdo javobi o'zgartirilmadi; `"SINOV — FISKAL EMAS"` chek oynasida `t('receipt.nonFiscalBanner')` orqali ko'rsatiladi (`apps/pos/src/components/PaymentAndShiftModals.tsx`, `apps/pos/e2e/pos.spec.ts`).
- [x] **U3 — Dev CORS ishlab chiqarishda yoqilmaydi:** `apps/hub/src/hub.test.ts` (`U3: rejects http://localhost:5173 by default with 403 FORBIDDEN_ORIGIN and only allows loopback dev CORS when enableDevLoopbackCors is explicitly true`) — standart Hub `http://localhost:5173` dan `POST /carts` so'rovini `403 FORBIDDEN_ORIGIN` bilan rad etadi.
- [x] **U4 — E2E Windows va Ubuntu CI'da:** PR #18 (`ccffc6e`) da `Verify (ubuntu-latest)` va `Verify (windows-latest)` joblarida Playwright E2E yashil o'tdi.
  - **Playwright E2E davomiyligi:** lokal `10.7 s` (`pos.spec.ts` test: `6.9 s`).
  - **Skanerdan savat qatorigacha (`Scan -> Cart Line DOM`) kechikish:** `28.0 ms` (maqsad `≤ 150 ms`).
  - **50 000 mahsulotda UI + FTS5 qidiruv kechikishi:** `46.2 ms` (maqsad `≤ 150 ms`).
- [x] **Sichqonsiz savdo (klaviatura bilan):** `apps/pos/e2e/pos.spec.ts` da `page.mouse.click` chaqirmasdan `F2` (qidiruv) → `Enter` (savatga qo'shish) → `+` (miqdorni oshirish) → `F8` (tez savdo) → `F4` (chegirma + rahbar PIN) → `F9` (to'lov) → `Enter` (chekni yakunlash va yopish) to'liq o'tdi.
- [x] **Tez yozgan odam skaner deb qabul qilinmaydi + DataMatrix `\x1d` buzilmaydi:** `apps/pos/src/scanner/scanner-detector.test.ts` (4 ta birlik test) va `apps/pos/e2e/pos.spec.ts` (60 ms/belgi bilan yozib `Enter` bosgan foydalanuvchi `/carts/:id/scan` ni chaqirmaydi; `010478000000012121ABC123\x1d91EE06\x1d92dGVzdA==` DataMatrix kodi `\x1d` bilan aynan uzatiladi).
- [x] **Kechiktirilgan chek, idempotent `clientRequestId`, smena yopish, kunduzgi/tungi mavzu va tannarx maxfiyligi:** `apps/pos/e2e/pos.spec.ts` da to'liq tekshirildi.
- [x] **Skrinshot:** `.mezon/gemini/pos-sales-screen.png` fayliga saqlandi.

---

### Test natijasi (buyruq va haqiqiy chiqish)

```text
$ pnpm verify
$ pnpm run format:check && pnpm run build && pnpm run lint && pnpm run typecheck && pnpm run db:check && pnpm run test && pnpm run depcruise
Checking formatting... All matched files use Prettier code style!
Tasks: 17 successful, 17 total (build)
$ node scripts/lint-workspaces.mjs (0 errors, 0 warnings)
Tasks: 17 successful, 17 total (typecheck)
PostgreSQL schema matches committed migrations (0 diff statements).
SQLite schema matches committed migrations (0 diff statements).

$ vitest run --project unit --project sqlite-hub
 Test Files  60 passed | 1 skipped (61)
      Tests  283 passed | 2 skipped (285)

$ vitest run --project perf
 Test Files  9 passed (9)
      Tests  12 passed (12)

$ pnpm --filter @mezon/pos test:e2e
Running 1 test using 1 worker
[PERF] Scan -> Cart Line DOM latency: 28.0 ms
[PERF] 50 000 products UI + FTS5 search latency: 46.2 ms
  ok 1 e2e\pos.spec.ts:161:3 › @mezon/pos Playwright E2E — Kassa UI (T1.11) › Full POS workflow: Setup -> Login -> Open Shift -> Scan (EAN-13 & DataMatrix GS) -> Human Typist vs Scanner -> Mouse-Free Keyboard Sale -> Park/Resume -> Idempotent Retry -> Shift Cash Move & Close + 50k Search Perf (6.9s)
  1 passed (10.7s)

$ depcruise --config .dependency-cruiser.cjs apps/*/src packages/*/src
✔ no dependency violations found (318 modules, 1348 dependencies cruised)

$ pnpm --filter @mezon/desktop test:e2e
  ok 1 e2e\desktop.spec.ts:97:1 › Playwright unfused Electron against identical app.asar: app://mezon, CSP, single instance, and T1 Hub crash recovery (6.4s)
  1 passed (7.1s)
```

GitHub Actions CI (PR #18, commit `ccffc6e`):
- `Verify (ubuntu-latest)`: **success**
- `Verify (windows-latest)`: **success**
- `Verify PostgreSQL RLS (ubuntu-latest)`: **success**
- `Detect Desktop Changes`: **success**

---

### Tekshirilmagan narsalar

- Fizik USB shtrix-kod skaner qurilmasi (Playwright E2E va Vitest'da real `KeyboardEvent` oqimi va `timeStamp` intervallari bilan simulyatsiya qilindi).

### Qilingan taxminlar

- Yo'q. Barcha yechimlar tasdiqlangan T1.11 rejasi va U1–U4 ko'rsatmalariga qat'iy amal qilgan holda bajarildi.

### Takliflar

- Keyingi T1.12 (Printer va chek) vazifasida `ReceiptModal` dagi chop etish/qayta chop etish holatlarini `PrinterDriver` bilan bog'lash.

### Egasi yoki Claude qarori kerak bo'lgan savollar

- Yo'q.
