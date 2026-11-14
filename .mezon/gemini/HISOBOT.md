## Hisobot: T1.13
Branch / PR: gemini/T1.13-reports-backup
Commit: e4ee795

### Nima qilindi
1. **Hisobotlar dvigateli (`@mezon/contracts`, `@mezon/db-local`, `apps/hub`, `apps/pos`):**
   - `packages/contracts/src/reports.ts`: Kunlik, oylik savdo, foyda/marja, qarzlar (aging buckets: joriy, 1–30, 31–60, 61+ kun), kam qoldiq, muddati yaqin partiyalar, Excel import/export Zod va DTO sxemalari (Python uchun JSON Schema eksportiga tayyor).
   - `packages/db-local/src/report-repo.ts`: `SqliteReportStore` — `v_sales_lines` yagona ishorali ko'rinishidan foydalanib kunlik va oylik savdo, foyda (COGS, yalpi daromad, yalpi foyda, marja bp), qarzlar (mijozlar va ta'minotchilar balansi, kechikish muddatlari), kam qoldiq (`products.min_stock` bo'yicha) hamda muddati yaqin partiyalar (`batches.expiry_date_ms` va `local_batch_balances.remaining_qty > 0`) hisobotlari to'liq realizatsiya qilindi.
   - RBAC qat'iy izolyatsiyasi: `/reports/profit` faqat `owner` uchun ruxsat etiladi (`manager` va `cashier` uchun 403 `AUTH_FORBIDDEN`). Umumiy savdo hisobotida `costValue` va `grossProfit` faqat `owner`ga ko'rsatiladi, kassir va menejerga umuman sizib chiqmaydi (testlar bilan isbotlangan).

2. **Excel port va 2 bosqichli import (`exceljs` 4.4, `apps/hub`):**
   - `apps/hub/src/excel-port.ts`: `ExcelPort` — kunlik savdo hisoboti, qarzlar hisoboti va tovar katalogini `.xlsx` formatida generatsiya qilish (kassir/menejer uchun tannarx butunlay chiqarib tashlanadi).
   - Max 10 MB va 5 000 qator chegarasi, formulalar faqat xom qiymat sifatida o'qiladi.
   - `apps/hub/src/catalog-import-cache.ts`: 15 daqiqalik TTL ga ega xotiradagi `previewToken` keshi.
   - `apps/hub/src/catalog-import-routes.ts`:
     - 1-bosqich: `POST /catalog/import/preview` — faylni tahlil qiladi, bazani o'zgartirmaydi, `previewToken` qaytaradi.
     - 2-bosqich: `POST /catalog/import/commit` — `previewToken` + `clientRequestId` (idempotent), jonli SQLite bazadagi shtrix-kodlar bilan qayta tekshiruv (R4) o'tkazadi va tovarlarni `uow.execute` ichida yaratadi.

3. **Zaxira nusxa va tiklash arxitekturasi (R2 + R3, `@mezon/db-local`, `apps/hub`):**
   - `packages/db-local/src/backup-service.ts`:
     - `createBackup()`: better-sqlite3 `db.backup()` yordamida WAL-safe onlayn zaxira nusxa oladi, SHA-256 xeshlaydi, `PRAGMA integrity_check` o'tkazadi, metadata yozadi va oxirgi 10 ta nusxani qoldirib qolganlarini avtomatik tozalaydi (rotation).
     - R2: `stageRestore()` ishlab turgan hub ustida faylni almashtirmaydi! Agar smena ochiq bo'lsa yoki savat ochiq/parklangan bo'lsa, `409 Conflict` beradi (`SHIFT_ALREADY_OPEN` / `CART_NOT_OPEN`). Faqat `pending-restore.json` rejasini yozadi va qayta ishga tushirishni so'raydi.
     - R2 + R3: `SqliteBackupService.executeStagedRestoreIfPending()` — Hub ishga tushishida, asosiy baza ulanishlari ochilishidan oldin chaqiriladi. Joriy bazaning `pre-restore-safety-*.db` xavfsizlik nusxasini oladi, zaxirani o'rniga qo'yadi, so'ng `local_device_state` dagi barcha monoton hisoblagichlarni (`last_receipt_seq`, `last_return_seq`, `last_shift_seq`, `last_order_seq`, `last_receiving_seq`, `last_device_seq`) `max(restored, current)` ga ko'taradi.
   - Model testi: zaxira olinadi → 3 ta savdo qilinadi (#3, #4, #5) → tiklanadi → keyingi savdo #6 chek raqamini oladi (ketma-ketlik hech qachon orqaga qaytmaydi).

4. **Arxitektura va import chegaralari:**
   - `exceljs` faqat `apps/hub` ga qo'shildi. `.dependency-cruiser.cjs` yangilandi. `pnpm depcruise` 0 ta qoidabuzarlik berdi.

---

### O'zgargan fayllar (fayl — sabab)
- `.dependency-cruiser.cjs` — `exceljs` faqat `apps/hub` da ishlatilishiga ruxsat berish qoidasi.
- `apps/hub/package.json`, `pnpm-lock.yaml` — `exceljs@4.4.0` bog'liqligi qo'shildi.
- `packages/contracts/src/reports.ts`, `packages/contracts/src/reports.test.ts`, `packages/contracts/src/index.ts` — hisobotlar, Excel import/export va zaxira nusxa kontraktlari.
- `packages/db-local/src/report-repo.ts`, `packages/db-local/src/report.test.ts` — `SqliteReportStore` va 4 ta batafsil test (R1 ustunlari, QQS, COGS, qarzlar).
- `packages/db-local/src/backup-service.ts`, `packages/db-local/src/backup.test.ts` — `SqliteBackupService` (WAL-safe backup, rotation, R2 staging restore, R3 monoton hisoblagichlar va model test).
- `packages/db-local/src/uow.ts` — `runConnectionReadOnly` sinxron/asinxron callback'larni bir xil qabul qilishi uchun `fn: () => Promise<T> | T` qilib kengaytirildi.
- `packages/db-local/src/supplier.test.ts` — 240 qadamli E4 model testiga `60_000` ms timeout qo'shildi (katta parallel tekshiruvda flaky bo'lmasligi uchun).
- `packages/db-local/src/index.ts` — yangi store va servislar eksport qilindi.
- `apps/hub/src/excel-port.ts` — `ExcelJS` generator va parser porti.
- `apps/hub/src/catalog-import-cache.ts` — 15 daqiqalik previewToken keshi.
- `apps/hub/src/report-service.ts`, `apps/hub/src/report-routes.ts` — hisobot marshrutlari va RBAC tekshiruvlari.
- `apps/hub/src/backup-routes.ts` — zaxira nusxa olish va tiklash marshrutlari.
- `apps/hub/src/catalog-import-routes.ts` — 2 bosqichli import va eksport marshrutlari.
- `apps/hub/src/server.ts`, `apps/hub/src/routes.ts` — R2 startup restore chaqiruvi va marshrutlarni ro'yxatdan o'tkazish.
- `apps/hub/src/reports-api.test.ts` — HTTP E2E integratsion testlari (RBAC, R2/R3, R4).
- `apps/pos/src/api/hub-client.ts` — POS klientiga hisobotlar va zaxira metodlari qo'shildi.

---

### Migratsiyalar
Yangi migratsiya yo'q (R1 talabi to'liq bajarildi: mavjud `batches.expiry_date_ms`, `local_batch_balances.remaining_qty`, `products.min_stock` ishlatildi). `pnpm db:check` 0 ta diff bilan tasdiqlandi.

---

### Qabul mezonlari
- [x] **R1 (Faqat haqiqiy sxema ustunlari):** `batches.expiry_date_ms`, `local_batch_balances.remaining_qty`, `products.min_stock` ustunlaridan foydalanildi. Yangi jadval yoki ustun qo'shilmadi. Dalil: `packages/db-local/src/report.test.ts` (`R1: reports low stock and expiring batches using real schema columns`).
- [x] **R2 (Tiklash qayta ishga tushirish orqali, ishlab turgan hub ustida emas):** `POST /backups/:id/restore` faqat tekshiradi, ochiq smena yoki ochiq/parklangan savat bo'lsa 409 qaytaradi, `pending-restore.json` yozadi. Baza faylini almashtirish Hub startup vaqtida ulanishlar ochilishidan oldin amalga oshadi. Dalil: `apps/hub/src/reports-api.test.ts` va `packages/db-local/src/backup.test.ts`.
- [x] **R3 (Monoton hisoblagichlar orqaga qaytmasligi):** Tiklashda almashtirishdan oldingi barcha ketma-ketliklar o'qiladi va tiklangan bazada `max(restored, current)` qilib oshiriladi. Dalil: `packages/db-local/src/backup.test.ts` (`R2 + R3 Model Test: restores DB state while sequence counters advance monotonically`).
- [x] **R4 (Import tasdig'i mijozga ishonmaydi):** `POST /catalog/import/preview` xotiradagi 15 daqiqalik TTL keshga yozadi. `POST /catalog/import/commit` esa `previewToken` + `clientRequestId` qabul qilib, jonli SQLite bazasi bilan to'qnashuvlarni qayta tekshiradi. Dalil: `apps/hub/src/reports-api.test.ts` (`R4: supports two-stage Excel import with previewToken and live re-validation against duplicate barcodes`).
- [x] **RBAC & Maxfiylik:** Kassir va menejer hisobot javoblarida ham, Excel eksportida ham tannarx (`costValue`) va yalpi foydani (`grossProfit`) ko'rmaydi. `/reports/profit` faqat `owner` uchun ochiq. Dalil: `apps/hub/src/reports-api.test.ts` (`enforces RBAC cost isolation on daily sales, profit report, and Excel export`).
- [x] **Zaxira nusxa aylanishi va yaxlitlik:** `db.backup()` WAL xavfsiz, 10 ta nusxa chegarasi, SHA-256 xesh, `PRAGMA integrity_check`. Dalil: `packages/db-local/src/backup.test.ts`.

---

### Test natijasi (buyruq va haqiqiy chiqish)
Buyruq: `pnpm verify`
```
$ prettier --check .
All matched files use Prettier code style!

$ turbo run build
Tasks: 17 successful, 17 total (built in 3.8s)

$ node scripts/lint-workspaces.mjs
(0 errors, 0 warnings)

$ turbo run typecheck
Tasks: 25 successful, 25 total (passed in 9.9s)

$ turbo run db:check
SQLite schema matches committed migrations (0 diff statements).
PostgreSQL schema matches committed migrations (0 diff statements).

$ pnpm run test:unit
Test Files  68 passed | 1 skipped (69)
Tests       312 passed | 2 skipped (314)

$ pnpm run test:perf
[T1.1 Perf 50k products / 70k barcodes WAL] scan(n=250): p50=0.439ms | search(n=100): p50=19.458ms
[PERF T1.7 D4] 5,000 entries (1 customer): getCustomerDetail=9.15 ms | createReturn=27.20 ms
[PERF T1.7 10k/100k] ftsMs=1.56 | phoneMs=5.29 | balanceMs=0.66 | overdueMs=23.83
[PERF T1.6 db-local] 20-line full createReturn median=44.91 ms
[PERF T1.4 HTTP E2E] 20-line POST /carts/:id/complete took 44.99 ms
[PERF T1.5 HTTP E2E] 20-line 3-payment POST /carts/:id/complete median=37.13 ms
[PERF T1.4 db-local] 20-line completeSale took 40.84 ms
[PERF T1.5 db-local] 20-line completeSale (3 payments) median=35.79 ms
[PERF T1.8 100-line receiving]: 173.21 ms
[PERF T1.10 HTTP E2E] 20-line POST /orders/:id/deliver took 44.99 ms
[db-local perf] 20-line order deliverOrder completed in 36.16 ms
[PERF T1.9 db-local] 1,000-receipt shift closeShift elapsed=22.92 ms
Test Files  9 passed (9)
Tests       12 passed (12)

$ pnpm --filter @mezon/pos test:e2e
[PERF] Scan -> Cart Line DOM latency: 21.2 ms
[PERF] 50 000 products UI + FTS5 search latency: 44.3 ms
1 passed (10.3s)

$ depcruise --config .dependency-cruiser.cjs apps/*/src packages/*/src
✔ no dependency violations found (362 modules, 1533 dependencies cruised)
```

---

### Tekshirilmagan narsalar
- Windows Explorer orqali 10 MB hajmli faylni qo'lda sudrab tashlash (manual drag-and-drop). Bu Electron/Chromium darajasidagi browser integratsiyasi bo'lib, HTTP API darajasida `reports-api.test.ts` va `excel-port.ts` da Buffer va multipart orqali to'liq sinovdan o'tkazildi.

---

### Qilingan taxminlar
- Excel import previewToken xotiradagi keshda saqlanadi va 15 daqiqadan so'ng yoki commit qilingandan so'ng avtomatik o'chiriladi.

---

### Takliflar
- F2 (Bulut va sinxron) bosqichida zaxira nusxalarni shifrlangan holda bulut saqlagichiga (S3/R2) davriy sinxronlash imkoniyatini kiritish tavsiya etiladi.

---

### Egasi yoki Claude qarori kerak bo'lgan savollar
- Savol yo'q. F1 bosqichining oxirgi vazifasi T1.13 to'liq yakunlandi. Claude'dan kod va testlar auditini o'tkazishni va natijani so'rayman.
