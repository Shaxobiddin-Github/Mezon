# Reja: T1.11 — Kassa UI (`apps/pos`, `@mezon/i18n`, `@mezon/ui`)

- **PR #17 (T1.10: Buyurtma va avans) Squash and merge SHA:** `99ca0d69b0db5113e064178fef9111833f699798` (`gemini/T1.10-orders-advance` branch'i o'chirildi).
- **Joriy branch:** `gemini/T1.11-pos-ui` (boshi `main` = `99ca0d6`).

---

## a) Tuzilma va arxitektura

1. **Paketlar va qatlamlar:**
   - `packages/i18n`:
     - Barcha foydalanuvchi ko'radigan matnlar yagona tiplangan o'zbek lotin (`uz-Latn`) lug'atida saqlanadi (`src/locales/uz-Latn.ts`, `src/index.ts`: `t(key, params)`).
     - UI komponentlarida hech qanday xom matn (hardcoded string) yozilmaydi. Kalitlar guruhlangan (`auth.*`, `shift.*`, `pos.*`, `payment.*`, `parked.*`, `receipt.*`, `errors.*`, `shortcuts.*`) va T4.6 da `i18next` 27 (`uz-Latn`, `uz-Cyrl`, `ru`) ulanishiga 1:1 tayyor bo'ladi.
   - `packages/ui`:
     - Kassa va kelajakdagi admin/android ekranlari uchun umumiy bazaviy UI primitivlar va formatlash yordamchilari (`formatTiyinToUzs`, `formatMillisToQty`, `parseUzsInputToTiyin`, `parseQtyInputToMillis` — faqat `bigint` va satr orqali, `number`/`float` hisobda ishlatilmaydi).
   - `apps/pos` (React 19.3.1 + Vite 8.3.7):
     - `src/api/hub-client.ts`: tiplangan HTTP mijozi. Barcha so'rov va javob tiplari **faqat `@mezon/contracts` Zod sxemalaridan** (`z.input<...>`, `z.output<...>`) olinadi, qo'lda interfeys nusxalanmaydi. Har bir HTTP javob (`2xx` payload va `4xx/5xx` `ErrorResponseSchema`) runtime'da `@mezon/contracts` Zod sxemasi bilan `.parse()` qilinadi.
     - Import chegarasi (`.dependency-cruiser.cjs`): `apps/pos/src` faqat ichki fayllar, `@mezon/contracts`, `@mezon/i18n`, `@mezon/ui`, `react`, `react-dom` va holat/stil paketlarini import qiladi (`@mezon/db-local`, `@mezon/hub`, `@mezon/drivers`, `electron` yoki `node:*` import qilish CI'da taqiqlangan).

2. **Electron (`app://mezon`) va Brauzer Dev rejimi hamda CSP:**
   - **Hub manzili (`baseUrl`):**
     - Electron ichida `window.mezonBridge.getHubState()` va `window.mezonBridge.onHubState()` orqali dinamik `http://127.0.0.1:<port>` olinadi (`apps/pos/src/bridge.ts`).
     - Brauzer dev va Playwright E2E rejimida (`window.mezonBridge` yo'q bo'lganda) `import.meta.env.VITE_HUB_BASE_URL` (yoki `window.__MEZON_HUB_URL__`) orqali faqat loopback (`http://127.0.0.1:<port>`) manziliga ulanadi.
     - Hub CORS: `apps/hub` da lokal rivojlantirish va Electron/Playwright uchun faqat `app://mezon` va `http://127.0.0.1:<port>` / `http://localhost:<port>` origin'lariga ruxsat beriladi (`Authorization: Bearer <token>`, `Content-Type: application/json`).
   - **Qat'iy CSP (`apps/desktop/src/security-policy.ts`):**
     - Desktop CSP: `default-src 'self' app://mezon; script-src 'self' app://mezon; style-src 'self' app://mezon; img-src 'self' app://mezon data:; font-src 'self' app://mezon; connect-src 'self' app://mezon http://127.0.0.1:<port>`.
     - `style-src` ichida `'unsafe-inline'` **yo'q**. Shuning uchun `apps/pos` da `style={{ ... }}` inline atributlari yoki runtime `<style>` tegi ishlatilmaydi — barcha stillar Vite orqali yig'iladigan statik `.css` faylida (Tailwind CSS 4 / CSS o'zgaruvchilari bilan tungi `[data-theme="dark"]` va kunduzgi `[data-theme="light"]` mavzular) bo'ladi.
     - `resolveAppProtocolFilePath('app://mezon/')` faqat `/` yo'lini `index.html` ga yo'naltiradi (`/pos` kabi sub-path diskdan fayl qidirib `404` beradi). Shuning uchun `apps/pos` ichida sahifalararo o'tish URL pathname'ni o'zgartirmasdan holat (state-based screen router) orqali bajariladi (`app://mezon/` o'zgarmaydi).

3. **Holat boshqaruvi (`zustand` 5 yoki React 19 store):**
   - `zustand` (`5.0.12`, GEMINI.md 2.1 ro'yxatidan) + `.dependency-cruiser.cjs` da `pos-src-imports` ga ruxsat:
     - **Sababi:** kassa UI'da global klaviatura/skaner hodisalari, aktiv savat (`CartEvaluationResult`), to'lov oynasi holati va `clientRequestId` React render siklidan tashqarida ham sinxron o'qilishi (`store.getState()`) kerak. `zustand` hech qanday inline style qo'shmaydi, juda yengil va skaner/shortcut handler'laridan to'g'ridan-to'g'ri chaqiriladi.
     - Agar qo'shimcha paket qo'shmaslik ma'qul ko'rilsa, React 19 `useSyncExternalStore` asosidagi 60 qatorlik tiplangan store ham xuddi shu `getState()/setState()/subscribe()` interfeysini beradi. (Rejada `zustand` 5.0.12 asosiy variant sifatida olindi).

---

## b) Ekranlar

1. **Birinchi ishga tushirish (`FirstRunSetupScreen`) va PIN bilan kirish (`PinLoginScreen`):**
   - `GET /auth/setup-status` `needsSetup: true` qaytarsa, boshlang'ich tashkilot/do'kon/egasi yaratish oynasi chiqadi (`POST /auth/setup`).
   - Oddiy holatda PIN kirish ekrani: foydalanuvchi nomi (yoki oxirgi kassir tanlovi) va 4–8 xonali PIN uchun ham klaviatura, ham katta teginish numpad'i (`0–9`, `Tozalash`, `O'chirish`, `Kirish`).
   - 5 marta xato PIN kiritilganda `429 AUTH_RATE_LIMITED` (`retryAfterSeconds`) bo'yicha ekranda qolgan blok vaqti teskari sanoqda ko'rsatiladi.
   - Kirishdan so'ng sessiya tokeni faqat xotirada saqlanadi; foydalanuvchi roli (`owner`, `manager`, `cashier`) va `userId` holatga yoziladi.

2. **Smenani ochish (`OpenShiftScreen`):**
   - Kassir tizimga kirgach, `GET /shifts/current` tekshiriladi. Agar terminalda ochiq smena bo'lmasa (yoki boshqa kassirning smenasi ochiq bo'lsa — ogohlantirish bilan), smena ochish ekrani ko'rsatiladi.
   - Boshlang'ich naqd pul (`openingCash` tiyinda, ixtiyoriy kupyura/tanga kalkulyatori `denominations` bilan) kiritiladi. Agar oldingi smena yopilishidagi naqd qoldiqdan farq qilsa, `openingDiscrepancyReason` maydoni so'raladi (`POST /shifts/open`).

3. **Asosiy Savdo ekrani (`PosSalesScreen`):**
   - **Yuqori panel:** do'kon/terminal nomi, joriy kassir, smena holati, skaner tayyorlik indikatori, kechiktirilgan cheklar soni (`F6`), kassa harakatlari / smena yopish (`F8`), tungi/kunduzgi mavzu almashtirgich (`dark`/`light`), chiqish tugmasi.
   - **Chap/Markaziy qism — Savat jadvali:**
     - Har bir qator: tartib raqami, tovar nomi (variant/birlik bilan), shtrix-kod, miqdor (`+` / `-` va aniq miqdor tahrirlash oynasi — kg/litr/dona uchun), birlik narxi, qator chegirmasi (avtomatik aksiya yoki qo'lda chegirma belgisi), qator yakuniy summasi (`lineTotal`).
     - Tanlangan qator klaviatura (`ArrowUp`/`ArrowDown`) yoki teginish bilan belgilanadi.
   - **O'ng/Yuqori qism — Qidiruv va Tez amallar:**
     - Qidiruv maydoni (`F2`): `GET /catalog/search?q=...` (FTS5 + kategoriya filtri). Natijalar ro'yxatidan Enter yoki bosish bilan savatga qo'shish (`POST /carts/current/lines`).
     - **Tez savdo qatori (`F3`):** katalogda yo'q tovar uchun nom (`customTitle`), birlik (`unit`), miqdor va narx kiritib savatga qo'shish.
     - **Chegirma oynasi (`F4`):** tanlangan qatorga yoki butun savatga foiz (`percent`, bps) yoki aniq summa (`fixed`, tiyin) chegirma berish. Kassir limitidan (`maxCashierDiscountBps`) oshsa yoki `DISCOUNT_OVERRIDE_REQUIRED` qaytsa, darhol **Supervisor PIN oynasi (`SupervisorPinModal`)** ochiladi (`overrideApprovedByUserId` + `overrideSupervisorPin` faqat bir martalik so'rovda yuboriladi, xotirada saqlanmaydi).
   - **Pastki yakuniy panel:**
     - Jami dastlabki summa (`subtotal`), aksiya chegirmasi (`promoDiscountTotal`), qo'lda chegirma (`manualDiscountTotal`), QQS (`vatTotal`) va katta shriftda **To'lanadigan jami (`total`)**.
     - Katta amal tugmalari: `Kechiktirish (F5)`, `Kechiktirilganlar (F6)`, `To'lov (F9 / F12)`.

4. **To'lov ekrani (`PaymentModal`):**
   - `total` summasi, to'lov usullari (`cash`, `card`, `uzqr`, `payme`, `click`, `uzum`, `social_card`, `other`) va aralash to'lov qatorlari.
   - **Naqd to'lov (`cash`):** kassir mijoz bergan naqd pulni (`tenderedCash`) kiritadi yoki tez kupyura tugmalarini (`Aniq summa`, `10 000`, `20 000`, `50 000`, `100 000`, `200 000`) bosadi. Qaytim (`changeDue = tenderedCash - cashApplied`) real vaqtda hisoblanadi; qaytim faqat naqd to'lovdan beriladi.
   - **Qarzga savdo (`debtAmount > 0`):** qolgan summa qarzga yozilishi tanlansa, mijoz qidirish / yangi mijoz yaratish (`GET /customers/search`, `POST /customers`) va to'lov muddati (`dueDays`) majburiy bo'ladi. Mijoz kredit limiti oshsa (`CREDIT_LIMIT_EXCEEDED`), Supervisor PIN oynasi orqali tasdiqlanadi.
   - **Ijtimoiy karta (`social_card`):** tanlanganda `cardType`, `cardLast4`, `transactionRef` maydonlari ko'rsatiladi.
   - Invariant: `SUM(payments.amount) + debtAmount === total` bajarilmaguncha `Savdoni yakunlash (Enter)` tugmasi faol bo'lmaydi.

5. **Kechiktirilgan cheklar oynasi (`ParkedCartsModal`):**
   - Joriy savatni ixtiyoriy izoh (`label`) bilan kechiktirish (`POST /carts/current/park`, `F5`).
   - Kechiktirilgan savatlar ro'yxati (`GET /carts/parked`, `F6`): vaqti, izohi, qatorlar soni, summasi, `Davom ettirish (Resume)` (`POST /carts/parked/:id/resume`) va `O'chirish` (`DELETE /carts/parked/:id`).

6. **Yakunlangan chek ko'rinishi (`ReceiptModal`):**
   - Savdo muvaffaqiyatli yakunlangach (`POST /sales/complete`), ekranda chek tafsilotlari chiqadi:
     - Yuqorida aniq ogohlantirish: **`SINOV — FISKAL EMAS`** (`fiscalStatus: 'non_fiscal'` / fake rejim talabi, GEMINI.md 3.3).
     - `receiptNo`, vaqt, kassir, qatorlar (nomi, miqdori × narxi, chegirma, QQS, jami), to'lov turlari, berilgan naqd, qaytim, qarz summasi.
     - `Yangi savdo (Enter / Esc)` tugmasi (haqiqiy printerda chop etish T1.12 da ulanadi).

7. **Kassa harakatlari va Smenani yopish ekrani (`ShiftManagementModal`):**
   - **Kassa pul harakati (`POST /shifts/current/cash-moves`):** `cash_in` (kassaga kirim), `cash_out` (inkassatsiya/chiqim), `expense` (xarajat) — faqat naqd summa va majburiy `reason` (sabab).
   - **Smenani yopish (`POST /shifts/current/close`):**
     - Kassir **faqat sanalgan haqiqiy naqd pulni (`countedCash`)** (yoki kupyuralar sonini `denominations`) va izohni (`notes`) kiritadi.
     - **Qat'iy qoida (GEMINI.md T1.9 / T1.11):** smena yopish ekranida naqdsiz summa (`card`, `uzqr`, `payme`, `click`, `uzum` va h.k.) kiritish maydoni **umuman bo'lmaydi** — naqdsiz tushumlar backend'da `payments` jadvalidan avtomatik olinadi va faqat yopilgan smena hisobotida ko'rsatiladi.
     - Agar naqd farq ruxsat etilgan chegaradan oshsa (`SUPERVISOR_OVERRIDE_REQUIRED`), Supervisor PIN so'raladi.

---

## c) USB Skaner aniqlash (sof funksiya va global ushlagich)

1. **Sof funksiya (`apps/pos/src/scanner/scanner-detector.ts`):**
   - Tashqi DOM yoki `Date.now()` ga bog'lanmagan sof avtomat:
     ```ts
     export interface ScannerKeyInput {
       readonly key: string;
       readonly code: string;
       readonly ctrlKey: boolean;
       readonly altKey: boolean;
       readonly metaKey: boolean;
       readonly timestampMs: number;
     }
     export interface ScannerDetectorConfig {
       readonly maxInterKeyMs: number; // default: 30 ms
       readonly minLength: number; // default: 4 ta belgi
       readonly terminators: readonly ('Enter' | 'Tab')[];
     }
     ```
   - `stepScannerDetector(state, input, config)` funksiyasi yangi `ScannerDetectorState` va natija hodisasini (`{ type: 'none' | 'buffering' | 'scan_completed' | 'flushed_as_typing', barcode?: string }`) qaytaradi.

2. **GS (`\x1D`, ASCII 29) va DataMatrix / GS1 himoyasi:**
   - Skaner yuborgan GS ajratuvchisi uch xil ko'rinishda kelishi mumkin:
     1. `input.key === '\x1d'` yoki `input.key === '\u001d'` yoki `input.key === 'GroupSeparator'`;
     2. `input.ctrlKey === true && (input.key === ']' || input.code === 'BracketRight' || input.key === '\x1d')` (ko'plab USB HID skanerlar ASCII 29 ni `Ctrl+]` sifatida yuboradi);
     3. `input.code === 'Numpad0'` / Alt-ketma-ketlikdan kelgan `\x1d`.
   - Algoritm bularning barchasini yagona `\x1D` belgisiga normallashtirib buferga qo'shadi.
   - Bufer yakunlanganda `.trim()` **qilinmaydi** va ichki `\x1D`, qavslar, `=`, `+`, `/` yoki boshqa DataMatrix / Asl belgisi belgilari hech qachon o'chirilmaydi — shtrix-kod / marking kodi aynan o'z holicha Hub'ga (`POST /catalog/scan` yoki savatga) yuboriladi.

3. **Belgilar tezligi va fokusdagi `<input>` himoyasi:**
   - Ketma-ket belgilar orasidagi farq `timestampMs - prevTimestampMs <= 30 ms` bo'lsa va kamida `minLength` (`4`) ta belgi yig'ilib `Enter` (yoki `Tab`) bosilsa -> **`scan_completed`**.
   - Agar foydalanuvchi qidiruv maydonida (`<input>`) yozayotgan paytda skaner ishlab ketsa:
     - Birinchi belgi kiritilishi bilan `inputSnapshot` (fokusdagi input'ning skan boshlanishidan oldingi `value` va `selectionStart`) eslab qolinadi;
     - `scan_completed` bo'lganda `event.preventDefault()` va `event.stopPropagation()` chaqiriladi (forma bexosdan submit bo'lib ketmaydi), fokusdagi `<input>` qiymati `inputSnapshot` ga qaytariladi (skaner yozib yuborgan belgilar qidiruv matnini buzmaydi) va skanerlangan kod savatga qo'shiladi.
   - Odamiy tez yozish (`80–120 ms` oraliq): `timestampMs - prevTimestampMs > 30 ms` bo'lgani uchun bufer skaner sifatida qabul qilinmaydi (`flushed_as_typing`), oddiy input yozuvi buzilmaydi va Enter bosilganda skaner emas, oddiy qidiruv ishlaydi.

4. **Unit testlar (`apps/pos/src/scanner/scanner-detector.test.ts`):**
   - Tez yozuvchi odam (`80–120 ms` oraliq bilan 13 xonali kod + `Enter`) -> skaner deb qabul qilinmaydi;
   - USB skaner (`5–15 ms` oraliq bilan EAN-13 + `Enter` yoki `Tab`) -> `scan_completed`;
   - GS1 DataMatrix (`010478000000001221ABC12345\x1D91EE06\x1D92dGVzdA==`) ham to'g'ridan-to'g'ri `\x1D`, ham `Ctrl+]` (`ctrlKey: true, key: ']'`) orqali yuborilganda `\x1D` buzilmasdan to'liq saqlanadi;
   - Qidiruv maydonida `"shakar"` yozib turib (`100 ms` oraliq), ketidan skaner bosilganda (`8 ms` oraliq) -> `"shakar"` matni input'da o'zgarishsiz qoladi, skaner kodi esa alohida `scan_completed` beradi.

---

## d) Pul xavfsizligi UI'da

1. **Idempotent `clientRequestId` boshqaruvi (`completeSale`, kassa harakati, buyurtma):**
   - Kassir `To'lov` oynasini ochganda (yoki savat/to'lov summalari o'zgarganda) bitta UUIDv7 `clientRequestId` yaratiladi va to'lov holatida saqlanadi.
   - `Savdoni yakunlash` tugmasi bosilganda:
     - `isSubmitting = true` qulfi tushadi — ikkinchi marta bosish (`double-click` yoki `Enter`ni ketma-ket bosish) yangi HTTP so'rov yubormaydi;
     - Tarmoq uzilishi (`TypeError: Failed to fetch` / timeout) yoki `5xx` yuz bersa, `clientRequestId` **o'zgartirilmaydi**. Kassir `Qayta urinish` tugmasini bosganda **aynan o'sha `clientRequestId`** qayta yuboriladi va Hub idempotent ravishda o'sha yagona chekni qaytaradi.
     - Faqat savdo muvaffaqiyatli yakunlangach (`200 OK`) yoki kassir savat tarkibini o'zgartirgach yangi `clientRequestId` generatsiya qilinadi.

2. **`409 SALE_TOTAL_CHANGED` himoyasi:**
   - Agar `POST /sales/complete` `409 SALE_TOTAL_CHANGED` qaytarsa (aksiya muddati tugagan yoki savat summasi yangilangan bo'lsa), UI savatni qayta o'qiydi (`GET /carts/current`), eski summa va yangi summani yonma-yon ko'rsatib kassirdan aniq tasdiq so'raydi (`"Savat summasi o'zgardi: 50 000 so'm -> 55 000 so'm. Yangi summa bilan davom etasizmi?"`). Kassir tasdiqlamaguncha savdo qayta yuborilmaydi.

3. **Biznes xatolarini aniq o'zbekcha ko'rsatish:**
   - `INSUFFICIENT_STOCK`: qaysi mahsulotlarda qoldiq yetmagani (`details.shortages`: mahsulot nomi, so'ralgan miqdor va mavjud qoldiq) jadval ko'rinishida chiqariladi va savatda o'sha qatorlar qizil bilan ajratib ko'rsatiladi;
   - `SHIFT_NOT_OPEN`: `"Smena ochilmagan. Savdo qilish uchun avval smenani oching"` + smena ochish ekraniga o'tish;
   - `CASHIER_SESSION_MISMATCH`: `"Terminalda boshqa kassirning smenasi ochiq. O'z smenangizga kiring"`;
   - `DISCOUNT_OVERRIDE_REQUIRED` / `SUPERVISOR_OVERRIDE_REQUIRED` / `CREDIT_LIMIT_EXCEEDED`: tushunarli sabab bilan Supervisor PIN oynasini ochadi.

4. **Tannarx va foyda izolyatsiyasi (GEMINI.md 3.4):**
   - Kassir UI kodida va `@mezon/contracts` katalog/savat/savdo sxemalarida `costPrice`, `profit`, `margin` maydonlari umuman yo'q (avvalgi bosqichlarda backend'da ham kassir javoblaridan olib tashlangan; E2E testda ham DOM va tarmoq javoblarida bu kalitlar yo'qligi tekshiriladi).

---

## e) Klaviatura va unumdorlik

1. **Sichqonsiz to'liq savdo — Tugmalar xaritasi:**
   - `F1`: Klaviatura yorliqlari yordam oynasi (`ShortcutsModal`)
   - `F2`: Mahsulot qidiruv maydoniga fokus (`SearchInput`)
   - `F3`: Tez savdo (katalogda yo'q tovar) oynasi (`QuickSaleModal`)
   - `F4`: Chegirma oynasi (tanlangan qator yoki butun savat) (`DiscountModal`)
   - `F5`: Joriy savatni kechiktirish (`ParkCartModal`)
   - `F6`: Kechiktirilgan cheklar ro'yxati (`ParkedCartsModal`)
   - `F7`: Mijoz tanlash / qarz uchun mijoz bog'lash
   - `F8`: Kassa pul harakati va Smena yopish oynasi (`ShiftManagementModal`)
   - `F9` yoki `F12` yoki `Ctrl+Enter`: To'lov oynasini ochish (`PaymentModal`) / To'lov oynasi ochiq bo'lsa savdoni tasdiqlash
   - `ArrowUp` / `ArrowDown`: Savat qatorlari yoki qidiruv natijalari bo'ylab harakatlanish
   - `+` / `=` va `-`: Tanlangan savat qatori miqdorini 1 birlikka oshirish / kamaytirish
   - `Enter` (savat qatorida): Tanlangan qator miqdorini aniq kiritish oynasi
   - `Delete` / `Backspace` (savat qatorida): Tanlangan qatorni savatdan o'chirish
   - `Escape`: Ochiq modalni yopish yoki qidiruv maydonini tozalash

2. **Teginish (Touch) ergonomikasi:**
   - Barcha interaktiv tugmalar, numpad katakchalari va savat qatori boshqaruvlari kamida **`48×48 px`** (`min-h-12 min-w-12`, katta numpad va to'lov tugmalari `56–64 px`) o'lchamda bo'ladi.

3. **Unumdorlik maqsadlari va testlari:**
   - **Skan -> savatdagi qator ko'rinishi:** `<= 100 ms` (Playwright/perf testda skan hodisasidan DOM'da savat qatori paydo bo'lguncha o'lchanadi);
   - **50 000 tovarli katalogda qidiruv + UI render:** `<= 150 ms` (Hub + SQLite FTS5 + UI ro'yxat; qidiruv natijalari sahifalab/cheklangan 50 ta eng mos qator bilan ko'rsatiladi, DOM minglab tugun bilan to'lib qolmaydi).

---

## f) E2E (Playwright) va Test rejasi

Playwright testlari (`apps/pos/e2e/pos.spec.ts`) test oldidan haqiqiy `@mezon/hub` serverini vaqtinchalik SQLite bazasi bilan `127.0.0.1:0` portida ishga tushiradi va `apps/pos` UI'ni Chromium'da (Ubuntu va Windows CI'da headless rejimda) tekshiradi:

1. **Skan -> To'lov -> Chek (va 50k qidiruv / <= 100 ms skan tezligi):**
   - PIN bilan kirish -> smena ochish -> USB skaner tezligida (`8 ms` oraliq) shtrix-kod va GS (`\x1D`) belgili DataMatrix yuborish -> savatda qator `<= 100 ms` ichida chiqishi -> naqd to'lov (`tenderedCash`, qaytim hisobi) -> `SINOV — FISKAL EMAS` belgili chek ekrani.
2. **Sichqonsiz to'liq savdo (100% klaviatura):**
   - Sichqoncha (`page.click`) umuman ishlatilmasdan faqat klaviatura (`PIN` + `Enter`, smena ochish `Enter`, `F2` qidiruv -> `ArrowDown` -> `Enter`, `+` miqdor oshirish, `F4` chegirma, `F9` to'lov -> `Enter` yakunlash) bilan savdoni boshidan oxirigacha yakunlash.
3. **Tez yozgan odam skaner deb qabul qilinmaydi:**
   - Qidiruv maydoniga `85 ms` oraliq bilan shtrix-kodga o'xshash matn va `Enter` yuborilganda u skaner sifatida savatga tushib ketmaydi, balki oddiy qidiruv natijasini chiqaradi.
4. **Ikki marta bosish va tarmoq uzilishi -> bitta chek (`clientRequestId` idempotentligi):**
   - To'lovni tasdiqlash tugmasini ketma-ket ikki marta bosish hamda birinchi `POST /sales/complete` javobini tarmoqda uzib qo'yib (Playwright route intercept: Hub bazaga yozadi, lekin javob uziladi) `Qayta urinish` bosilganda aynan o'sha `clientRequestId` ketishi va bazada faqat **bitta** chek (`receipt_no = 1`) hosil bo'lishi isbotlanadi.
5. **Kechiktirilgan chek (`park` / `resume`):**
   - Birinchi mijoz savatini `F5` bilan kechiktirish -> ikkinchi mijozga savdo qilish -> `F6` orqali kechiktirilgan savatni qayta tiklash va yakunlash.
6. **Smena ochish, kassa harakati va smena yopish:**
   - `F8` orqali `expense` / `cash_in` kiritish -> smenani yopish ekranida **naqdsiz summa kiritish maydoni yo'qligini** (`expect(page.locator(...)).toHaveCount(0)`) tekshirish -> `countedCash` kiritib smenani yopish va kutilgan naqd/naqdsiz summalar to'g'riligini tasdiqlash.

---

## g) Doiradan tashqari (bu vazifada qilinmaydi)

- Haqiqiy printer va ESC/POS bayt drayverlari (`T1.12`);
- Hisobotlar, Excel import/eksport va zaxira nusxa (`T1.13`);
- Android Capacitor qobig'i (`T4.4`);
- Ko'p tilli (`uz-Cyrl`, `ru`) tarjima va til almashtirish (`T4.6`).
