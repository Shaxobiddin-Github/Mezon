## Reja: T1.12 — Printer va chek (`@mezon/drivers`, `@mezon/contracts`, `@mezon/db-local`, `apps/hub`, `apps/pos`)

Branch: `gemini/T1.12-printer`
PR #18 (T1.11) Squash and merge SHA: `d8056539da0c45c8561602131dcb499462b68018` (`gemini/T1.11-pos-ui` o'chirildi)

---

### 0. T1.11 test qarzi va mayda tuzatishlar (birinchi alohida commit)

T1.12 PR'ining **birinchi alohida commit'i** sifatida (`T1.11 test qarzi: skaner chegaralari, diagnostika paneli, E2E skrinshot yo'li`) quyidagilar bajariladi:

1. **Skaner minimal uzunlik testi (`apps/pos/src/scanner/scanner-detector.test.ts`):**
   - `2` yoki `3` ta belgi juda tez (`≤ 5–10 ms` oraliqda, masalan `+`, `1`, `2` yoki klaviatura rollover'i) kelib, darhol `Enter` bosilganda `onScan` **chaqirilmasligi** (`scans.length === 0`) tekshiriladi.
   - `scanner-detector.ts` dagi `keyCount >= minLength && buffer.length >= minLength` sharti olib tashlanganda ushbu test yiqilishi (mutatsiya) bilan isbotlanadi.
2. **Skaner `Enter` kechikishi testi (`apps/pos/src/scanner/scanner-detector.test.ts`):**
   - `13` ta raqam tez (`8 ms` oraliqda) kelib, yakunlovchi `Enter` `500 ms` dan keyin bosilganda (`gapToTerminator > maxInterKeyDelayMs`), bu skan **emasligi** (`onScan` chaqirilmasligi) tekshiriladi.
   - `gapToTerminator <= maxInterKeyDelayMs` sharti olib tashlanganda ushbu test yiqilishi (mutatsiya) bilan isbotlanadi.
3. **Diagnostika panelini kassirdan yashirish (`apps/pos/src/App.tsx`, `apps/pos/src/components/PosWorkspaceScreen.tsx`):**
   - Savdo ekranining yuqori qatoridan T0.7 dan qolgan texnik ma'lumotlar (`Hub holati ready`, `http://127.0.0.1:…`, `Qayta ishga tushishlar`, `/health javobi`, `Sozlash kerakmi`, `"Tekshiruvni yangilash"` tugmasi) olib tashlanadi.
   - Savdo ekranining yuqori panelida faqat kassir F.I.Sh./roli, joriy smena kodi, printer/savdo amallari, mavzu (`Kunduzgi`/`Tungi`), `F1` yordam va `Chiqish` qoladi.
   - Texnik diagnostika ma'lumotlari faqat `owner` va `manager` rollari uchun `Ctrl+Shift+D` qisqa yo'li yoki sozlamalar tugmasi orqali ochiladigan alohida `"Tizim diagnostikasi"` modal oynasiga ko'chiriladi (kassir rolida bu tugma ham, modal ham ochilmaydi).
4. **E2E skrinshot yo'li (`apps/pos/e2e/pos.spec.ts`):**
   - `pos.spec.ts` ichida skrinshot `.mezon/gemini/pos-sales-screen.png` ga emas, git tomonidan e'tiborsiz qoldiriladigan `apps/pos/test-results/pos-sales-screen.png` ga yoziladi. Shunda `pnpm verify` ishchi daraxtni (`git status`) hech qachon ifloslantirmaydi.

---

### a) Qatlamlar va Arxitektura qarori

1. **Qayerda ishlaydi (Arxitektura qarori — Hub jarayonida):**
   - Printer drayverlari va ESC/POS kodlovchi **Hub (`apps/hub`) ichida** (Electron'da `utilityProcess` ichida ishlaydigan Hub serverida) ishlaydi. Renderer (`apps/pos`) printerga hech qachon to'g'ridan-to'g'ri murojaat qilmaydi (`contextIsolation: true`, `sandbox: true`).
   - **Asos:**
     1. T4 (Ko'p kassa) va T1.12 talablariga ko'ra, brauzer/UI faqat Hub REST API bilan gaplashadi;
     2. Chek ma'lumotlari (`sales`, `returns`, `shifts`, `local_hub_config`) va chop etish auditi (`receipt_prints`, `cash_drawer_events`) SQLite bazasida yashaydi — Hub bir tranzaksiyada audit yozib, printerga baytlarni yuboradi;
     3. `apps/desktop/scripts/prepare-electron-app.mjs` allaqachon `@mezon/drivers` va `koffi` 3.3.7 ni `dist-app/node_modules` ichiga yig'adi, shuning uchun Hub `utilityProcess` (hamda dev rejimdagi Node.js Hub) `koffi` va `node:net` dan to'g'ridan-to'g'ri foydalana oladi (`packages/drivers` ga `"koffi": "3.3.7"` dependency sifatida qo'shiladi).

2. **Paketlar bo'yicha taqsimot:**
   - **`@mezon/drivers` (`packages/drivers/src/printer/` — sof qism, IO yo'q):**
     - `escpos-encoder.ts`: sof funksiyalar — `ReceiptDocument`, `ReturnReceiptDocument`, `ShiftCloseReportDocument`, `TestPrintDocument` → `Uint8Array` (ESC/POS baytlar ketma-ketligi) hamda `encodeCashDrawerPulse(pin?: 0 | 1): Uint8Array`.
     - `codepage.ts`: kod sahifasi (`'translit'` | `'cp866'` | `'cp1251'`) jadvali va o'zbek lotin/kirill matnini aniq 1-baytli kod sahifasiga yoki ASCII transliteratsiyaga o'giruvchi sof kodlovchi.
     - `layout.ts`: `58mm` (`32` belgi/qator, Font A) va `80mm` (`48` belgi/qator, Font A) uchun so'z bo'yicha o'rash (`wordWrap`), chap/o'ng ustunlarni tekislash (`formatColumns`), chiziqli ajratkichlar (`---`, `===`) va markazlashtirish.
     - `types.ts`: `PrinterDriver` port interfeysi, `PrinterConfig`, `PrintSendResult`, `DiscoveredWindowsPrinter` tiplari.
     - `null-driver.ts` (`NullPrinterDriver` — printersiz rejim: muvaffaqiyatli `{ ok: true, mode: 'disabled', bytesSent: 0 }` qaytaradi, hech qanday IO bajarmaydi).
     - `fake-driver.ts` (`FakePrinterDriver` — testlar uchun: yuborilgan barcha `Uint8Array` buferlarni, pul yashigi impulslarini xotirada saqlaydi va sozlanadigan xato rejimini (`simulateError`) qo'llab-quvvatlaydi).
   - **`@mezon/drivers/node` (`packages/drivers/src/node/printer/` — Node/OS IO qismi):**
     - `windows-raw-driver.ts` (`WindowsRawPrinterDriver`): `koffi` 3 orqali `winspool.drv` funksiyalari (`OpenPrinterW`, `StartDocPrinterW` (`DOC_INFO_1W`, `pDatatype = "RAW"`), `StartPagePrinter`, `WritePrinter`, `EndPagePrinter`, `EndDocPrinter`, `ClosePrinter` va printerlar ro'yxati uchun `EnumPrintersW`) bilan ishlaydi. Windows bo'lmagan OS'da chaqirilsa, aniq `PRINTER_OS_UNSUPPORTED` xatosini qaytaradi; unit testlarda esa `WinspoolBindings` interfeysi mock/stub qilinib, barcha Win32 chaqiruv tartibi va xato holatlari (`OpenPrinterW` false, `WritePrinter` partial write/error, handle cleanup `finally` blokida) tekshiriladi.
     - `network-driver.ts` (`NetworkPrinterDriver`): Node `node:net` `Socket` orqali TCP `host:port` (standart `9100`), qat'iy `timeoutMs` (standart `3000 ms`, `1000..15000 ms`) bilan. Ulanish uzilsa yoki timeout bo'lsa soketni `destroy()` qilib, tuzilgan xato qaytaradi (unit testda lokal `net.createServer` bilan tekshiriladi).

---

### b) Chek tarkibi (`58mm` = 32 ustun, `80mm` = 48 ustun)

Barcha chek va hisobot hujjatlarida F3 gacha tepada va pastda markazlashtirilgan, qalin (`ESC E 1`) **"SINOV — FISKAL EMAS"** banneri majburiy chiqadi. Vaqt va sana do'konning `storeTimezone` (standart `'Asia/Tashkent'`) mintaqasida `YYYY-MM-DD HH:mm:ss` formatida chiqariladi. Pul qiymatlari tiyindan so'mga (`12 500` yoki kasr tiyin bo'lsa `12 500.50`), miqdorlar milli-birlikdan (`1`, `1.5`, `0.255` + birlik nomi `dona`, `kg` va h.k.) formatlanadi.

1. **Savdo cheki (`SaleReceiptDocument`):**
   - **Sarlavha:**
     - `"*** SINOV — FISKAL EMAS ***"` (markazda, qalin)
     - Agar qayta chop etish bo'lsa (`copyNumber > 1` yoki `isReprint === true`): `"*** NUSXA #N (QAYTA CHOP ETILDI) ***"` (markazda, qalin)
     - Do'kon nomi / Tashkilot nomi
     - Chek kodi (`receiptCode`, masalan `R-000001` / `#1`), Smena kodi (`shiftCode`)
     - Sana va vaqt (`storeTimezone` da), Kassir F.I.Sh.
     - Agar mijoz biriktirilgan bo'lsa: Mijoz ismi
   - **Qatorlar (`lines`):**
     - Har bir qator uchun:
       - `1. <Mahsulot nomi>` (`58mm` da 32 belgi, `80mm` da 48 belgiga so'z bo'yicha o'raladi; tez savdo bo'lsa `[Tez savdo]` belgisi bilan)
       - Ikkinchi qator (o'ngga/chapga tekislangan): `   <miqdor> <birlik> x <birlik narx>` ↔ `<grossTotal>`
       - Agar qatorda aksiya (`promoDiscount > 0`) yoki savat chegirmasi (`allocatedOrderDiscount > 0`) bo'lsa: `   Chegirma:` ↔ `-<chegirma summasi>` va yakuniy `   Qator jami:` ↔ `<finalTotal>`
       - QQS stavkasi va summasi: `   QQS (<vatRate>%):` ↔ `<vatTotal>`
   - **Yakuniy summalar:**
     - `Jami (chegirmasiz):` ↔ `<subtotalGross>` (agar chegirma bo'lsa)
     - `Aksiya chegirmasi:` ↔ `-<promoDiscountTotal>` (agar `> 0` bo'lsa)
     - `Chegirma:` ↔ `-<orderDiscountTotal>` (agar `> 0` bo'lsa)
     - **Qalin:** `JAMI TO'LOV:` ↔ `<totalFinal>`
     - `Shu jumladan QQS:` ↔ `<totalVat>`
   - **To'lovlar (`payments`):**
     - Har bir to'lov turi (`Naqd`, `Karta`, `UzQR`, `Payme`, `Click`, `Uzum`, `Ijtimoiy karta`, `Avans`, `Boshqa`):
       - Naqd bo'lsa: `Naqd (berildi):` ↔ `<tenderedAmount>`
       - Boshqa bo'lsa: `<To'lov turi>:` ↔ `<amount>` (agar `providerRef` bo'lsa qavs ichida qisqa ref)
     - Agar `changeAmount > 0`: `Qaytim (naqd):` ↔ `<changeAmount>`
     - Agar `debtAmount > 0`: `Nasiya (qarzga):` ↔ `<debtAmount>`
   - **Pastki qism:**
     - `"Xaridingiz uchun rahmat!"`
     - `"*** SINOV — FISKAL EMAS ***"`
     - Qog'oz uzish (`GS V 66 3` — partial cut with feed).

2. **Qaytarish cheki (`ReturnReceiptDocument` — T1.6):**
   - `"*** SINOV — FISKAL EMAS ***"`
   - `"=== TOVAR QAYTARISH CHEKI ==="` (agar qayta chop etilsa: `"*** NUSXA #N ***"`)
   - Qaytarish kodi (`returnCode`), Asl chek kodi (`saleReceiptCode`), Sana/vaqt, Kassir/Menejer, Sabab (`reason`)
   - Qaytarilgan qatorlar (`itemName`, `qty × unitPrice`, `refundAmount`, `vatTotal`)
   - `JAMI QAYTARILDI:` ↔ `<totalRefund>` (`Shu jumladan QQS: <totalVat>`)
   - Qaytarish usullari (`payments`: `Naqd qaytarildi`, `Karta`, `Qarzdan ayrildi` (`debt_reduction`) va h.k.).

3. **Smena yopilish hisoboti (`ShiftCloseReportDocument` — T1.9 Z-hisobot ko'rinishi):**
   - `"*** SINOV — FISKAL EMAS ***"`
   - `"=== SMENA YOPILISH HISOBOTI ==="` (agar qayta chop etilsa: `"*** NUSXA #N ***"`)
   - Smena kodi (`shiftCode`), Holati (`closed`), Yopish tartib raqami (`closeSeq`), Kassir/Yopuvchi, Ochilgan va yopilgan vaqtlar
   - Savdolar soni (`salesCount`), Qaytarishlar soni (`returnsCount`), Bekor qilinganlar (`voidsCount`)
   - Tushum ko'rsatkichlari: `Yalpi savdo`, `Qaytarishlar`, `Sof savdo`
   - Naqd pul harakati: `Boshlang'ich naqd`, `Naqd savdo (sof)`, `Naqd qaytarish`, `Kassa kirim (cash_in)`, `Kassa chiqim (cash_out)`, `Xarajatlar (expense)`
   - `Kutilgan naqd pul:` ↔ `<expectedCash>`
   - `Sanab chiqilgan naqd:` ↔ `<countedCash>`
   - `Farq (kamomad/ortiqcha):` ↔ `<cashDiscrepancy>`
   - Naqdsiz to'lovlar (`nonCashTotalsByMethod`: Karta, UzQR, Payme, Click, Uzum va h.k.) va `Jami naqdsiz:` ↔ `<nonCashNetTotal>`.

---

### c) Kod sahifasi va o'zbek harflari siyosati

Ko'pchilik termal printerlar UTF-8 ni to'g'ridan-to'g'ri qo'llab-quvvatlamaydi va faqat 1-baytli kod sahifalarini (`ESC t n`) tushunadi.

1. **Uchta kodlash rejimi (`PrinterEncodingMode = 'translit' | 'cp866' | 'cp1251'`):**
   - Standart rejim: `'translit'` (har qanday ESC/POS printerda 100% buzilmasdan chiqadi, `ESC t 0` PC437/ASCII).
   - `'cp866'` (`ESC t 17` — Cyrillic #2 / DOS CP866): kirill harflarini qo'llaydigan printerlar uchun.
   - `'cp1251'` (`ESC t 73` — Windows-1251): Windows-1251 qo'llaydigan printerlar uchun.

2. **Aniq normalizatsiya va transliteratsiya jadvali (`packages/drivers/src/printer/codepage.ts`):**
   - **O'zbek maxsus apostrof va harflari (barcha rejimlarda avval normallashtiriladi):**
     - `Oʻ`, `Oʼ`, `O‘`, `O’`, `O` + `` ` ``, `Ў` (translit rejimida) → `O'`
     - `oʻ`, `oʼ`, `o‘`, `o’`, `o` + `` ` ``, `ў` (translit rejimida) → `o'`
     - `Gʻ`, `Gʼ`, `G‘`, `G’`, `G` + `` ` ``, `Ғ` (translit rejimida) → `G'`
     - `gʻ`, `gʼ`, `g‘`, `g’`, `g` + `` ` ``, `ғ` (translit rejimida) → `g'`
     - Tutuq belgisi (`ʼ` U+02BC, `ʻ` U+02BB, `‘` U+2018, `’` U+2019, `` ` ``) → `'` (`0x27`)
     - Uzun tire (`—` U+2014, `–` U+2013) → `-` (`0x2D`)
     - Maxsus bo'shliqlar (`\u00A0`, `\u202F`) → oddiy bo'shliq (`0x20`)
     - `№` → `No` (`translit` va `cp866` da `0xFC` yoki `No`, `cp1251` da `0xB9`)
   - **`'translit'` rejimida kirill harflari kelsa (masalan mahsulot nomida `Шакар 1кг`, `Қаймоқ`, `Гўшт`, `Ҳолва`):**
     - Standart o'zbek kirill → lotin transliteratsiya jadvali qo'llanadi:
       `А→A, Б→B, В→V, Г→G, Ғ→G', Д→D, Е→Ye/E, Ё→Yo, Ж→J, З→Z, И→I, Й→Y, К→K, Қ→Q, Л→L, М→M, Н→N, О→O, П→P, Р→R, С→S, Т→T, У→U, Ў→O', Ф→F, Х→X, Ҳ→H, Ц→Ts, Ч→Ch, Ш→Sh, Щ→Sh, Ъ→', Ы→I, Ь→, Э→E, Ю→Yu, Я→Ya` (katta va kichik harflar uchun).
   - **`'cp866'` va `'cp1251'` rejimlarida:**
     - `ESC t 17` (`0x1b, 0x74, 0x11`) yoki `ESC t 73` (`0x1b, 0x74, 0x49`) komandasi chek boshida yuboriladi.
     - Lotin ASCII (`0x20..0x7E`) o'z holicha qoladi; rus/o'zbek kirill harflari (`А..Я`, `а..я`, `Ё`, `ё`) mos CP866 / CP1251 1-baytli qiymatiga o'giriladi; CP866/CP1251 da mavjud bo'lmagan o'zbek kirill harflari (`Қ→К`, `қ→к`, `Ғ→Г`, `ғ→г`, `Ҳ→Х`, `ҳ→х`, `Ў→У`, `ў→у`) printerda `?` bo'lib qolmasligi uchun eng yaqin kirill harfiga tushiriladi.
     - Jadvalda yo'q har qanday noma'lum Unicode belgi `?` (`0x3F`) ga tushiriladi.
   - **Testlar:** Bayt snapshot testlari `'translit'`, `'cp866'` va `'cp1251'` rejimlarining har birini o'zbek lotin (`Oʻzbekiston, Gʻijduvon, Qahva aʼlo — 15 000 soʻm`) va kirill (`Қўқон ҳолваси, Ғиждувон гўшти`) matnlari bilan tekshiradi.

---

### d) Xatolar, Qayta chop etish (`receipt_prints`) va Pul yashigi (`cash_drawer`)

1. **Uzluksizlik qoidasi (GEMINI.md 3.2):**
   - Printer o'chiq bo'lishi, tarmoq timeout berishi yoki `winspool.drv` xatosi **savdoni (`completeSale`), qaytarishni (`createReturn`) va smena yopishni (`closeShift`) hech qachon to'xtatmaydi va rollback qilmaydi**.
   - Savdo avval `completeSale` tranzaksiyasida to'liq saqlanadi. So'ng (agar `printer_auto_print_sale = true` bo'lsa yoki foydalanuvchi `"Chop etish"` tugmasini bossa) chop etish chaqiriladi. Agar printer xato bersa, savdo saqlangan holda qoladi, audit jadvaliga `status = 'failed'` va `error_message` yoziladi, UI'da esa sariq/qizil ogohlantirish banneri va **"Qayta chop etish"** tugmasi chiqadi.

2. **Jadval sinfi qarori (`local_receipt_prints` va `local_cash_drawer_events` — `LOCAL`, store-scoped):**
   - **Qaror:** Chop etish urinishlari va pul yashigini ochish auditi lokal terminal/hub qurilmasiga xos operatsion jurnal bo'lgani uchun **`LOCAL`** sinfida (`tenantScope: 'store'`) saqlanadi (`local_receipt_prints` va `local_cash_drawer_events`).
   - **Asos:**
     1. Qaysi chek necha marta qog'ozga chiqqani yoki qog'oz tiqilib qolgani (`status = 'failed'`) lokal fizika hodisasi bo'lib, outbox orqali bulutga va boshqa kassa terminallariga tarqatilishi shart emas (F4 da har terminalning o'z printeri bo'ladi);
     2. Shu bilan birga, `local_receipt_prints` da `document_type` (`'sale' | 'return' | 'shift_close'`), `document_id` (UUIDv7), `print_seq` (`1, 2, 3...`), `copy_number` (`status = 'printed'` bo'lgan nechanchi nusxa ekani), `is_reprint` (`boolean`), `actor_user_id`, `status` (`'printed' | 'failed' | 'disabled'`), `printer_mode` (`'disabled' | 'windows_raw' | 'network_tcp'`), `printer_target`, `bytes_sent`, `error_code`, `error_message`, `created_at_ms` saqlanadi.
     3. **Nusxa raqami (`copyNumber`) hisobi:**
        - Birinchi muvaffaqiyatli chop etish (`copyNumber = 1`, `isReprint = false`) asl nusxa hisoblanadi (chekda `"NUSXA"` yozuvi chiqmaydi).
        - Agar birinchi urinishda printer xato bergan bo'lsa (`status = 'failed'`) va kassir keyin `"Qayta chop etish"` ni bossa, hali hech bir muvaffaqiyatli nusxa chiqmagani yoki oldin chiqqaniga qarab:
          - Agar foydalanuvchi `/sales/:id/print` (yoki `/returns/:id/print`, `/shifts/:id/print`) ni chaqirsa va oldin kamida 1 marta `status = 'printed'` bo'lgan bo'lsa → `isReprint = true`, `copyNumber = previousPrintedCount + 1` va chek tepasida **`*** NUSXA #2 (QAYTA CHOP ETILDI) ***`** chiqadi.
          - Bundan tashqari, `reprint: true` bayrog'i aniq berilsa (masalan chek oynasidan "Nusxa chop etish" bosilsa), har doim `"*** NUSXA #N ***"` belgisi qo'yiladi.

3. **Pul yashigi (`Cash Drawer`):**
   - ESC/POS pul yashigi impulsi: `ESC p m t1 t2` (`0x1b, 0x70, 0x00, 0x19, 0xfa` — Pin 2, ~50ms on / ~500ms off).
   - **Avtomatik ochish:** `printer_cash_drawer_auto_open = true` bo'lganda va savdo chekida naqd to'lov (`cash`) ishtirok etganda (yoki naqd qaytarishda), chek baytlari oxiriga pul yashigi impulsi qo'shiladi (yoki alohida yuboriladi).
   - **Qo'lda ochish (`POST /printer/cash-drawer/open`):**
     - Ruxsat: `printer:cash_drawer` (`owner` va `manager` da bor; `cashier` da esa ixtiyoriy `override: { username, pin }` orqali rahbar tasdig'i bilan).
     - Majburiy `reason` (sabab) talab qilinadi va `local_cash_drawer_events` jadvaliga (`actor_user_id`, `override_approved_by_user_id`, `shift_id`, `reason`, `status`, `error_message`, `created_at_ms`) yoziladi.

---

### e) Sozlamalar, Hub API va Kassa UI

1. **Ma'lumotlar bazasi (`packages/db-local` — migratsiya `0013_printer_and_receipt_prints.sql`):**
   - `local_hub_config` jadvaliga printer sozlamalari ustunlari qo'shiladi:
     - `printer_mode`: `text` (`'disabled' | 'windows_raw' | 'network_tcp'`), standart `'disabled'`
     - `printer_name`: `text` (nullable, Windows printer nomi)
     - `printer_host`: `text` (nullable, TCP IP/hostname)
     - `printer_port`: `integer` (standart `9100`, `1..65535`)
     - `printer_timeout_ms`: `integer` (standart `3000`, `500..30000`)
     - `printer_paper_width_mm`: `integer` (`58 | 80`), standart `80`
     - `printer_encoding`: `text` (`'translit' | 'cp866' | 'cp1251'`), standart `'translit'`
     - `printer_auto_print_sale`: `integer` boolean (`0 | 1`), standart `1` (`true`)
     - `printer_cash_drawer_auto_open`: `integer` boolean (`0 | 1`), standart `1` (`true`)
     - `receipt_header_title`: `text` (nullable — do'kon nomi/sarlavhasi, standart `'MEZON KASSA'`)
     - `receipt_footer_text`: `text` (nullable — pastki yozuv, standart `'Xaridingiz uchun rahmat!'`)
   - `local_receipt_prints` (`LOCAL`, `tenantScope: 'store'`) jadvali.
   - `local_cash_drawer_events` (`LOCAL`, `tenantScope: 'store'`) jadvali.

2. **Ruxsatlar (`packages/domain/src/auth.ts`):**
   - `printer:config` (`owner`, `manager`) — printer sozlamalarini o'zgartirish, Windows printerlar ro'yxatini ko'rish, sinov chekini chiqarish.
   - `printer:cash_drawer` (`owner`, `manager`) — pul yashigini qo'lda ochish (`cashier` esa `override` PIN bilan chaqira oladi).
   - Savdo, qaytarish va smena chekini chop etish / qayta chop etish (`cart:write` / `shifts:read`) kassir uchun ochiq.

3. **Hub REST API marshrutlari (`apps/hub/src/printer-routes.ts`, `apps/hub/src/printer-service.ts`):**
   - `GET /printer/settings` — joriy printer sozlamalarini olish (`auth:self` / `cart:write`).
   - `PATCH /printer/settings` — printer sozlamalarini yangilash (`printer:config` — `owner`/`manager`).
   - `GET /printer/windows-printers` — Windows'da mavjud printerlar ro'yxatini qaytarish (`printer:config`).
   - `POST /printer/test-print` — sinov chekini chop etish (`printer:config`).
   - `POST /printer/cash-drawer/open` — pul yashigini qo'lda ochish (`printer:cash_drawer` yoki kassir + `override`, majburiy `reason` va `local_cash_drawer_events` auditi bilan).
   - `POST /sales/:id/print` — savdo chekini chop etish yoki qayta chop etish (`local_receipt_prints` ga yozadi, printer xato bersa ham `200 OK` ichida `{ status: 'failed', errorCode, errorMessage, printRecord, textPreview }` qaytaradi — savdo buzilmaydi!).
   - `GET /sales/:id/prints` — savdo chekining chop etish tarixi.
   - `POST /returns/:id/print` — qaytarish chekini chop etish / qayta chop etish.
   - `POST /shifts/:id/print-close-report` — yopilgan smena hisobotini chop etish / qayta chop etish.

4. **Kassa UI (`apps/pos`):**
   - **Chek oynasi (`ReceiptModal`):**
     - Savdo yakunlangach, agar `autoPrintSale` yoqilgan bo'lsa, avtomatik `POST /sales/:id/print` chaqiriladi.
     - Oynada chop etish holati ko'rsatiladi: `"Chop etildi (Asl nusxa)"`, `"Printersiz rejim (SINOV)"`, yoki printer xato bersa ogohlantirish: `"Printer xatosi: <sabab>. Savdo saqlandi, chekni qayta chop etishingiz mumkin."`
     - **"Qayta chop etish (Nusxa)"** tugmasi (`POST /sales/:id/print` → `NUSXA #2` va h.k.).
     - Chek matnining vizual ko'rinishi (`textPreview`).
   - **Smena yopish oynasi (`CloseShiftModal`):**
     - Smena yopilgach, `"Smena hisobotini chop etish"` tugmasi (`POST /shifts/:id/print-close-report`).
   - **Printer sozlamalari va Pul yashigi modali (`PrinterSettingsModal`):**
     - `owner` va `manager` uchun: rejim (`Printersiz`, `Windows RAW printer`, `Tarmoq TCP 9100`), printer tanlash yoki `IP:port`, qog'oz kengligi (`58 mm` / `80 mm`), kod sahifasi (`Transliteratsiya`, `CP866`, `CP1251`), avtomatik chop etish, naqd savdoda pul yashigini ochish, `"Sinov chekini chop etish"` va `"Pul yashigini ochish"` tugmalari.

---

### f) Testlar va Real printerda sinov haqida eslatma

1. **Vitest birlik va integratsiya testlari:**
   - `packages/drivers/src/printer/escpos-encoder.test.ts`:
     - `58mm` (32 ustun) va `80mm` (48 ustun) savdo cheki, qaytarish cheki va smena yopilish hisoboti uchun **aniq bayt va matn snapshot testlari**.
     - `"SINOV — FISKAL EMAS"` banneri, `"NUSXA #2"` belgisi, uzun mahsulot nomlarini o'rash, QQS, chegirma, aralash to'lov, qaytim va qarz qatorlari.
     - Kod sahifalari (`'translit'`, `'cp866'`, `'cp1251'`) va o'zbek harflari (`oʻ`, `gʻ`, `ʼ`, kirill harflari) baytma-bayt tekshiruvi.
     - Pul yashigi ESC/POS impulsi (`0x1b, 0x70, ...`) bayt tekshiruvi.
   - `packages/drivers/src/node/printer/drivers.test.ts`:
     - `NetworkPrinterDriver`: lokal `node:net` TCP serverga ulanib baytlarni to'liq yuborish, ulanish rad etilganda (`ECONNREFUSED`) va javob bermaganda (`timeout`) xavfsiz xato qaytarish testi.
     - `WindowsRawPrinterDriver`: mock `WinspoolBindings` orqali `OpenPrinterW -> StartDocPrinterW(RAW) -> StartPagePrinter -> WritePrinter -> EndPagePrinter -> EndDocPrinter -> ClosePrinter` ketma-ketligi va xato holatlarida resurslar tozalanishi testi.
   - `apps/hub/src/printer.test.ts`:
     - Printer xato berganda (`FakePrinterDriver` xato rejimida yoki uzoqqa ulanmagan TCP portda) `completeSale` muvaffaqiyatli yakunlanishi va savdo bazada to'liq saqlanishi.
     - Birinchi chop etish (`copyNumber = 1`, `isReprint = false`) va ikkinchi chop etish (`copyNumber = 2`, `isReprint = true`, baytlarda `"NUSXA #2"` borligi) hamda `local_receipt_prints` audit yozuvlari.
     - Naqd to'lovda pul yashigi avtomatik ochilishi, naqdsiz (`card`) to'lovda ochilmasligi.
     - Qo'lda pul yashigini ochish: kassir `override`siz `403`, menejer yoki kassir+`override` bilan `200` va `local_cash_drawer_events` yozuvi.
     - Kassir `/printer/settings` ni o'zgartira olmasligi (`403`).
   - `apps/pos/e2e/pos.spec.ts`:
     - T1.11 test qarzi (diagnostika paneli kassirda ko'rinmasligi, skrinshot `test-results` ga tushishi) + savdo yakunida chek chop etish va qayta chop etish (`NUSXA #2`) E2E tekshiruvi.

2. **Real printerda sinov:**
   - Hozirgi avtomatlashtirilgan muhitda fizik termal printer ulanmagan; yakuniy hisobotda **"real printerda tekshirilmagan (F1 yakunidagi bir kunlik simulyatsiyada real printerda sinaladi)"** deb aniq qayd etiladi.

---

### g) Doiradan tashqari

- Fiskal chek, OFD QR kodi va virtual kassa integratsiyasi (F3).
- Android Bluetooth/USB printerlari (T4.4).
- Ko'p kassali tarmoqda har terminalning o'z lokal printeri (T4.3).
