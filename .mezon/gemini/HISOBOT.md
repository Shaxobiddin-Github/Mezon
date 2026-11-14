## Reja: T1.13 — Hisobotlar, Excel import/eksport va SQLite zaxira nusxa

Branch: `gemini/T1.13-reports-backup`
Oldingi merge SHA'lari:
- PR #19 (`docs/guzar-roadmap`): `38e52aa` (`docs: GEMINI.md ni Guzar konsepsiyasiga moslash`)
- PR #20 (`claude/T1.12-printer`): `20ca6ac` (`T1.12: Printer va chek`)

---

### 0. Vazifa maqsadi va doirasi

T1.13 — **F1 (Oflayn kassa) bosqichining yakuniy vazifasi**. Ushbu vazifadan so'ng Claude F1 bo'yicha to'liq audit o'tkazadi va do'kon yagona kompyuterda to'liq avtonom ishlashga tayyor bo'ladi.

**Doira:**
1. **Hisobotlar dvigateli (`@mezon/db-local`, `@mezon/contracts`, `apps/hub`, `apps/pos`):**
   - Kunlik va oylik savdo hisoboti (yalpi savdo, qaytarishlar, sof savdo, QQS, cheklar soni, to'lov usullari taqsimoti).
   - Foyda va tannarx hisoboti (**qat'iy faqat `owner` roli uchun** — COGS, yalpi foyda, marja).
   - Qarzlar hisoboti (mijozlar qarzi — muddati o'tgan / joriy, ta'minotchilar qarzi).
   - Kam qoldiq hisoboti (minimal zaxira me'yoridan kam qolgan tovarlar).
   - Muddati yaqin tovarlar hisoboti (partiyalar muddati bo'yicha ogohlantirish).
2. **Excel import va eksport (`exceljs` 4.4 port orqasida, faqat Hub ichida):**
   - 2 bosqichli import: **1-bosqich: sinov (dry-run / preview)** — xatolar, ziddiyatlar, moslashuvlar tahlili (bazaga hech narsa yozilmaydi); **2-bosqich: tasdiq (commit)** — bitta tranzaksiyada mahsulotlar va ixtiyoriy boshlang'ich qoldiqni yaratish/yangilash.
   - Shtrix-kod (UPC-A → EAN-13 kanonik, T1.1) va normallashtirilgan nom bo'yicha moslash.
   - Hisobotlar va tovar katalogini `.xlsx` formatiga eksport qilish (kassir/menejer eksportida tannarx va foyda ustunlari butunlay chiqarib tashlanadi).
   - Xavfsizlik: hajm chegarasi (max 10MB, max 5 000 qator), formulalar va makroslar faqat xom matn/qiymat sifatida o'qiladi.
3. **Avtomatik zaxira nusxa, yaxlitlik va tiklash (SQLite Online Backup API, WAL safe):**
   - Zaxira nusxa olish (better-sqlite3 `db.backup()`, savdoni va WAL rejimini to'xtatmaydi).
   - Avtomatik zaxira jadvallari: har smena yopilganda (`/shifts/:id/close`), kun yakunida (`/day-close`) yoki qo'lda (`/backups/create`).
   - Aylanish (rotation): oxirgi N ta (standart 10 ta) nusxa saqlanadi, eskilari avtomatik tozalanadi.
   - Yaxlitlik tekshiruvi: `PRAGMA integrity_check`, SHA-256 xesh va metadata fayli (`backup-meta.json`).
   - Xavfsiz tiklash: bazani almashtirishdan oldin avval joriy bazaning "pre-restore" nusxasi olinadi; tiklashdan so'ng barcha proyeksiyalar (`rebuildBalances`, `rebuildCustomerBalances`, `rebuildSupplierBalances`) qayta quriladi va summalar ledger'lar bilan tiyinigacha teng ekani tekshiriladi.
   - Model testi: savdo, qaytarish, qarz va kirimlardan so'ng zaxira olinadi, tiklanadi va tushum, qarz, qoldiq, kassa tiyinigacha tengligi isbotlanadi.

**Doiradan tashqari:**
- Bulutga zaxira nusxa yuklash (F2, T2.5).
- Kengaytirilgan tahlil va bashorat (F9, T9.4).

---

### a) Hisobotlar arxitekturasi va ma'lumot manbalari

1. **Haqiqat manbai (yangi hisob-kitob yo'q):**
   - **Savdo va qaytarishlar:** `v_sales_lines` SQLite ko'rinishi (`sale_lines` `+`, `return_lines` `-`, bekor qilinganlar chetlatilgan). Chek darajasidagi to'lovlar `payments` va `return_payments` jadvallaridan olinadi (`X3` qoidasi: `amount` to'g'ridan-to'g'ri olinadi, qaytim ikki marta ayrilmaydi).
   - **Qarzlar:** `local_customer_balances` va `customer_ledger` (mijoz qarzi, `due_at_ms` bo'yicha 1–30, 31–60, 60+ kunlik kechikish toifalari); `local_supplier_balances` va `supplier_ledger` (ta'minotchi qarzi).
   - **Qoldiqlar:** `local_stock_balances` va `products`/`product_variants` dagi `min_stock` ustunlari.
   - **Partiya muddatlari:** `batches` jadvali (`expires_at_ms` va `balance_qty > 0`).

2. **Vaqt va chegaralar:**
   - Barcha sana filtrlari (`from`, `to`, `date`, `month`) do'konning `store_timezone` (standart `Asia/Tashkent`) mintaqasida `[startOfDay, endOfDay]` yoki `[startOfMonth, endOfMonth]` unix millisekundlariga o'giriladi.
   - Vaqt hisoblash funksiyalari `packages/domain/src/timezone.ts` (yoki yangi `reports.ts`) sof domen yordamchilariga tayanadi.

3. **Rollar va Maxfiylik (RBAC & Security Invariant):**
   - **Tannarx va foyda faqat `owner`:**
     - `/reports/profit` endpointi faqat `owner` roliga ruxsat beradi (`manager` va `cashier` uchun `403 AUTH_FORBIDDEN`).
     - Umumiy savdo hisobotida (`/reports/sales/daily`, `/reports/sales/monthly`) `costValue`, `netProfit`, `marginPercent` maydonlari umuman bo'lmaydi yoki faqat `owner` so'ragan taqdirda qo'shiladi.
     - Kassir va menejer javoblarida `cost_value`, `profit`, `margin` maydonlari mavjud emasligi bo'yicha qat'iy API va kontrakt testlari yoziladi.
   - **Guzar biznes kabineti (F2, T2.7) va bulut bilan moslik:**
     - Hisobot mantiqi `packages/db-local/src/report-repo.ts` (`SqliteReportStore`) ichida sof SQL va domen DTO sifatida yoziladi. U hech qanday Fastify yoki HTTP kontekstiga bog'lanmaydi, shuning uchun F2 da aynan shu kontraktlar bulut PostgreSQL jadvallarida ham qayta ishlatiladi.
   - **Python xizmatlari (GEMINI.md 2.4) uchun tayyorgarlik:**
     - Barcha hisobot DTO'lari `packages/contracts/src/reports.ts` ichida Zod sxemalari orqali qat'iy tiplashtiriladi.
     - Zod sxemalari standart JSON Schema / OpenAPI ga eksport qilinadi, shunda kelgusida Python tahlil xizmatlari (`services/analytics`) ushbu kontraktlardan Pydantic modellarini to'g'ridan-to'g'ri generatsiya qila oladi.

---

### b) Excel Import va Eksport (`exceljs`)

1. **Kutubxona joylashuvi va chegaralari:**
   - `exceljs` `4.4.0` versiyasi faqat `apps/hub/package.json` ga o'rnatiladi (GEMINI.md 2.1: *exceljs faqat port orqasida va faqat hub ichida*).
   - Pure paketlar (`domain`, `rules`, `contracts`, `pos`) `exceljs` ni import qilmaydi (`.dependency-cruiser.cjs` qoidasi bilan himoyalanadi).
   - `ExcelPort` interfeysi:
     ```ts
     export interface ExcelImportRow {
       readonly rowNumber: number;
       readonly barcode: string | null;
       readonly name: string;
       readonly sku: string | null;
       readonly unit: ProductUnit;
       readonly salePrice: Money;
       readonly costPrice: Money | null;
       readonly minStock: Quantity | null;
       readonly initialStock: Quantity | null;
     }
     ```

2. **2 bosqichli Import jarayoni:**
   - **1-bosqich: Sinov (`POST /catalog/import/preview` — Multipart file / ArrayBuffer):**
     - Fayl hajmi tekshiriladi (maksimal 10 MB, maksimal 5 000 qator).
     - Formulalar va makroslar e'tiborsiz qoldiriladi (faqat `cell.value` xom matn/raqam sifatida o'qiladi).
     - Moslashuv (Matching) iyerarxiyasi:
       1. **Shtrix-kod bo'yicha:** Shtrix-kod kanonizatsiya qilinadi (`normalizeBarcode`: UPC-A bo'lsa 13 xonali EAN-13 ga o'giriladi). Mavjud `product_barcodes` bilan moslansa → `update` harakati.
       2. **Nom bo'yicha:** Agar shtrix-kod ko'rsatilmagan bo'lsa yoki topilmasa, tovar nomi normallashtirilib (`normalizeProductName`: o'zbek lotin/kirill harflari, probellar tozalash), `products.name_search` bilan solishtiriladi.
       3. **Yangi tovar:** Hech qaysi mezon mos kelmasa → `create` harakati.
     - Ziddiyatlar va xatolar:
       - Fayl ichidagi takroriy shtrix-kodlar;
       - Mavjud boshqa tovarning shtrix-kodiga to'qnashuv;
       - Noto'g'ri narx, bo'sh nom, qo'llab-quvvatlanmaydigan o'lchov birligi;
     - **Natija:** Baza o'zgarmaydi. Klientga batafsil tahlil qaytariladi:
       ```json
       {
         "previewToken": "UUIDv7",
         "totalRows": 150,
         "validRows": 148,
         "createsCount": 120,
         "updatesCount": 28,
         "errors": [{ "rowNumber": 4, "error": "Narx musbat son bo'lishi shart" }],
         "conflicts": [],
         "rows": [...]
       }
       ```
   - **2-bosqich: Tasdiq (`POST /catalog/import/commit`):**
     - `clientRequestId` va tasdiqlangan qatorlar ro'yxati yuboriladi.
     - Bitta atomik SQLite tranzaksiyasida (`uow.execute`):
       - Tovarlar yaratiladi yoki yangilanadi (`ATTR` outbox hodisasi bilan);
       - Shtrix-kodlar bog'lanadi;
       - Agar boshlang'ich qoldiq ko'rsatilgan bo'lsa, har biriga `stock_move` ('initial' turi, `FACT`) yoziladi va outbox hodisasi bitta tranzaksiyada qayd etiladi.

3. **Eksport (`GET /reports/sales/export`, `/reports/debts/export`, `/catalog/export`):**
   - Natija `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet` oqimi sifatida yuklanadi.
   - Sarlavhalar, ustun kengliklari, raqamlar va sanalar chiroyli formatlanadi.
   - **Xavfsizlik:** Agar so'rov yuboruvchi `owner` bo'lmasa, tannarx (`costPrice`), foyda (`grossProfit`) va marja ustunlari generatsiya qilinayotgan jadvaldan to'liq chiqarib tashlanadi.

---

### c) Zaxira nusxa (SQLite Online Backup, Integrity, Restore)

1. **SQLite Online Backup dvigateli (`better-sqlite3` `backup` API):**
   - SQLite WAL rejimida ishlayotganda faylni oddiy `fs.copyFileSync` bilan ko'chirish shisha sinishi (corrupt backup) xavfini tug'diradi.
   - `SqliteBackupStore` better-sqlite3 ning rasmiy `db.backup(destinationPath)` asinxron metodidan foydalanadi. Bu kassa savdosini, tranzaksiyalarni va o'qish/yozishni aslo to'xtatmaydi (`progress` monitoring bilan).

2. **Avtomatlashtirish va Aylanish (Rotation):**
   - Zaxira papkasi: `%LOCALAPPDATA%/Guzar/backups` (yoki SQLite bazasi yonidagi `backups/` katalogi).
   - Avtomatik triggerlar:
     1. Har smena yopilganda (`/shifts/:id/close` muvaffaqiyatli yakunlangach, fon vazifasi sifatida);
     2. Har kun yakunida (`/day-close` muvaffaqiyatli yakunlangach);
     3. Egasi tomonidan istalgan paytda qo'lda (`POST /backups`).
   - Aylanish siyosati: Oxirgi 10 ta zaxira nusxa saqlanadi. 11-nusxa yaratilganda eng eskilari xavfsiz o'chiriladi.

3. **Yaxlitlik (Integrity Check) va Metadata:**
   - Zaxira fayli yaratilgach:
     1. Yangi nusxa `better-sqlite3` orqali ochilib, `PRAGMA integrity_check` chaqiriladi (agar `ok` bo'lmasa, fayl darhol yaroqsiz deb belgilanadi).
     2. Faylning SHA-256 xeshi hisoblanadi.
     3. Yonida `<backup_id>.meta.json` fayli yoziladi (sana, hajm, SHA-256, joriy ledgerlar balansi: zaxira tushumi, qarzlar jami, tovarlar soni).

4. **Xavfsiz Tiklash (Restore) kafolati:**
   - `POST /backups/:id/restore` faqat `owner` roliga ruxsat beriladi.
   - **Qat'iy xavfsizlik chorasi:** Mavjud ishchi bazaga teginishdan oldin, hozirgi bazaning favqulodda "pre-restore-safety.db" zaxira nusxasi olinadi.
   - Maqsadli zaxira faylining SHA-256 xeshi va `PRAGMA integrity_check` tekshiriladi.
   - Baza ulanishlari yopiladi, fayl almashtiriladi va yangi ulanish ochiladi.
   - Zaxiradan tiklangandan so'ng darhol **barcha proyeksiyalarni qayta qurish** buyrug'i ishga tushiriladi (`rebuildBalances`, `rebuildCustomerBalances`, `rebuildSupplierBalances`).
   - **Qabul mezoni:** Tiklangan bazadagi zaxira nusxa metadatasidagi summalar bilan ledger summalarining tiyinigacha aniq tengligi tasdiqlanadi.

5. **Model testi (Test Invariant):**
   - Savdo, qaytarish, mijoz qarzi, ta'minotchi kirimi va kassa harakatlari amalga oshiriladi.
   - Zaxira olinadi (`backup-1`).
   - Keyin qo'shimcha operatsiyalar bajariladi yoki baza buziladi.
   - `backup-1` dan qayta tiklanadi.
   - Tushum, mijoz qarzi, ta'minotchi qarzi, tovar qoldiqlari va kassa qoldig'i tiyinigacha `backup-1` holatiga teng ekani property/model testi bilan isbotlanadi.

---

### d) O'zgaradigan va yaratiladigan fayllar ro'yxati

1. **`packages/contracts`:**
   - `src/reports.ts`: Zod sxemalari — `DailySalesReportQuerySchema`, `MonthlySalesReportQuerySchema`, `ProfitReportQuerySchema`, `DebtsReportQuerySchema`, `LowStockReportQuerySchema`, `ExpiringBatchesReportQuerySchema`, `ExcelImportPreviewResponseSchema`, `ExcelImportCommitRequestSchema`, `BackupRecordSchema`, `BackupListResponseSchema`.
   - `src/reports.test.ts`: Kontrakt va ruxsat berilgan maydonlar testlari.
2. **`packages/db-local`:**
   - `src/report-repo.ts`: `SqliteReportStore` — `v_sales_lines`, qarzlar, qoldiqlar, partiyalar bo'yicha sof agregatsiyalar.
   - `src/backup-service.ts`: `SqliteBackupService` — SQLite online backup, `PRAGMA integrity_check`, SHA-256 xeshlash, zaxiradan tiklash va proyeksiyalar tekshiruvi.
   - `src/report.test.ts`: Barcha hisobotlar, vaqt zonalari, chegaralar va rollar testlari.
   - `src/backup.test.ts`: Yaxlitlik, xavfsiz tiklash, model testi (tushum, qarz, qoldiq tiyinigacha teng).
3. **`apps/hub`:**
   - `package.json`: `"exceljs": "4.4.0"` qo'shiladi.
   - `src/excel-port.ts`: `exceljs` bilan ishlaydigan adapter (import parsing, 2 bosqichli validatsiya, `.xlsx` generatsiya).
   - `src/report-routes.ts`: `/reports/sales/*`, `/reports/profit`, `/reports/debts`, `/reports/stock/low`, `/reports/batches/expiring`, `/reports/*/export`.
   - `src/catalog-import-routes.ts`: `/catalog/import/preview`, `/catalog/import/commit`, `/catalog/export`.
   - `src/backup-routes.ts`: `/backups`, `/backups/create`, `/backups/:id/restore`, `/backups/:id/download`.
   - `src/reports-api.test.ts`: Fastify orqali to'liq API testi — xususan kassir va menejer javobida tannarx yo'qligini isbotlash.
4. **`apps/pos`:**
   - `src/api/hub-client.ts`: Hisobot, import/eksport va zaxira metodlari.
   - `src/components/ReportsModal.tsx`: Egasi va menejer uchun savdo, qarzlar, kam qoldiq va zaxira nusxalar paneli (kassirga ko'rinmaydi).
5. **`.dependency-cruiser.cjs`:**
   - `exceljs` faqat `apps/hub` ga cheklanganini kafolatlash.

---

### e) Qabul mezonlari va tekshirish usullari

1. **Hisobotlar va Rollar:**
   - [ ] Savdo hisoboti (kunlik va oylik) `v_sales_lines` dan aniq vaqt zonasida hisoblanadi.
   - [ ] Foyda va tannarx faqat `owner` roliga beriladi. Kassir va menejer so'raganda `403` qaytadi yoki javobdan tannarx to'liq chiqarib tashlanadi (API testi dalil).
   - [ ] Qarzlar hisoboti kechikkan kunlar bo'yicha to'g'ri taqsimlanadi.
   - [ ] Kam qoldiq va muddati o'tadigan partiyalar to'g'ri ro'yxatlanadi.
2. **Excel Import/Eksport:**
   - [ ] 1-bosqich: Sinov rejimida bazaga yozilmaydi, xatolar va ziddiyatlar ko'rsatiladi.
   - [ ] 2-bosqich: Tasdiqlanganda bitta tranzaksiyada tovarlar yaratiladi/yangilanadi va boshlang'ich qoldiq uchun outbox `stock_move` yoziladi.
   - [ ] Kassir eksport qilgan `.xlsx` faylida tannarx va foyda ustunlari yo'q.
3. **Zaxira nusxa va Tiklash:**
   - [ ] SQLite online backup savdo davom etayotganda ham buzilmasdan to'liq nusxa oladi.
   - [ ] Tiklashdan oldin joriy bazaning zaxira nusxasi olinadi.
   - [ ] Zaxiradan tiklanganda summalar ledgerlar bilan tiyinigacha teng bo'ladi (model testi dalil).
4. **Sifat:**
   - [ ] `pnpm verify` (lint, typecheck, format, test, db:check, depcruise) to'liq yashil.
   - [ ] CI da Windows Desktop Installer va barcha testlar yashil.
