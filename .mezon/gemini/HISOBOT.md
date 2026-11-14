## Hisobot: T1.13 R1 (Tuzatishlar)
Branch / PR: gemini/T1.13-reports-backup
Commit: 90327c2

### Nima qilindi (B1–B4 talablarining to'liq ijrosi)

1. **B1: Safety zaxirasida WAL checkpoint (TRUNCATE) va avariya (crash) tiklanishi:**
   - `packages/db-local/src/backup-service.ts`: `executeStagedRestoreIfPending` joriy bazaning safety zaxirasini olishdan avval `curDb.pragma('wal_checkpoint(TRUNCATE)')` buyrug'ini chaqiradi, so'ng `await curDb.backup(safetyBackupPath)` orqali xavfsizlik nusxasini yaratadi va `PRAGMA integrity_check === 'ok'` ekanini tekshiradi.
   - **Avariya testi (`backup.test.ts` - `B1`):** Alohida bola jarayon (child process) WAL rejimida tranzaksiyani commit qiladi va ulanishni yopmasdan / checkpoint qilmasdan to'satdan chiqib ketadi (`process.exit(0)`). SQLite `-wal` fayli uncheckpointed holatda qoladi. So'ng tiklash (restore) ishga tushiriladi: safety backup yaratiladi va tekshirilganda avariya qilingan yozuv to'liq safety backup'da saqlanganligi isbotlandi.

2. **B2: Jonli bazaga teginishdan oldin validatsiya va atomik almashtirish:**
   - `executeStagedRestoreIfPending` zaxira faylini tekshirishni jonli faylga teginishdan oldin bajaradi:
     - Agar `.meta.json` mavjud bo'lsa, zaxira faylining SHA-256 xeshi metadatadagi `sha256Hex` bilan mosligi tekshiriladi.
     - Zaxira fayli ustida `PRAGMA integrity_check === 'ok'` tekshiriladi.
     - Agar xesh yoki yaxlitlik xato bo'lsa, tiklash darhol to'xtatiladi (`VALIDATION_ERROR`) va jonli baza fayli umuman o'zgartirilmaydi.
   - Faylni almashtirish atomik: zaxira avval `${dbPath}.restore-tmp-${Date.now()}` vaqtinchalik fayliga nusxalanadi, so'ngra atomik `fs.renameSync` orqali almashtiriladi (yarim yozilgan yoki buzuq nusxa live DB o'rniga tushib qolmaydi).
   - **Testlar (`backup.test.ts` - `B2`):**
     - Zaxira faylining 1 bayti buzilganda (tampering) tiklash rad etiladi, jonli baza buzilmaydi.
     - Zaxira fayli PRAGMA integrity_check'dan o'tmaganda tiklash rad etiladi, jonli baza butun qoladi.

3. **B3: Tiklashdan keyin proyeksiyalarni qayta qurish (rebuild) va ledger pariteti:**
   - Hub ishga tushishida tiklash bajarilgach (`wasRestored: true`), yangi `SqliteBackupService.executePostRestoreRebuildAndVerify` funksiyasi chaqiriladi:
     - Qoldiqlar proyeksiyasini qayta qurish: `rebuildStockProjections` / `stockStore.rebuildProjections()`.
     - Mijozlar balansini qayta qurish: `rebuildCustomerBalances()`.
     - Ta'minotchilar balansini qayta qurish: `rebuildSupplierBalances()`.
     - **Paritet tekshiruvi:** `local_stock_balances` summasi `stock_moves.qty_delta` bilan, `local_customer_balances.balance` `customer_ledger.amount_delta` bilan, `local_supplier_balances.balance` `supplier_ledger.amount_delta` bilan to'liq tengligi SQLite `HAVING` orqali tekshiriladi.
     - Zaxira metadatasidagi savdolar soni (`salesCount`) va jami sof tushum (`totalNetSalesTiyin`) tiklangan bazadagi `v_sales_lines` bilan solishtiriladi.
   - **Test (`backup.test.ts` - `B3`):** Proyeksiya jadvallari qo'lda buziladi (`local_stock_balances`, `local_customer_balances`, `local_supplier_balances`) → tiklash va rebuild ishga tushiriladi → proyeksiyalar haqiqiy ledgerlar bilan tiyingacha va grammgacha to'liq mos holga keladi.

4. **B4: HLC monotonligi — tiklangan va joriy vaqtning maksimumiga ko'tarish:**
   - Tiklangan bazadagi `local_device_state` da `last_hlc` qiymati `max(restoredHlc, currentHlc)` leksikografik maksimumiga, `last_uuid_ms` esa `max(restoredMs, currentMs)` ga ko'tariladi.
   - **Test (`backup.test.ts` - `B4`):** Checkpoint A'dan keyin soat oldinga surilib bir nechta amallar bajariladi (`hlcBeforeRestore > hlcAtA`). Tiklash amalga oshirilgach, `last_hlc === hlcBeforeRestore` ekani va hech qachon orqaga chekinmasligi tasdiqlandi.

---

### O'zgargan fayllar (fayl — sabab)
- `packages/db-local/src/backup-service.ts`:
  - `executeStagedRestoreIfPending`: B1 (WAL checkpoint TRUNCATE va safety backup integrity), B2 (pre-restore SHA-256 + integrity check, atomic temp rename), B4 (HLC va UUID ms monotonicity).
  - `executePostRestoreRebuildAndVerify`: B3 (stock, customer, supplier proyeksiyalarini qayta qurish, ledger paritetini tekshirish va salesCount/totalNetSalesTiyin verifikatsiyasi).
- `packages/db-local/src/backup.test.ts`:
  - B1, B2, B3, B4 talablariga mos 4 ta yangi qat'iy test qo'shildi (avariya child process, buzuq bayt / buzuq integrity, proyeksiyalar buzilishi va rebuild pariteti, HLC monotonligi).
- `packages/db-local/src/index.ts`:
  - Yangi natija tiplari (`StagedRestoreExecutionOutcome`, `PostRestoreRebuildResult`) eksport qilindi.
- `apps/hub/src/server.ts`:
  - Hub startup jarayonida baza ochilgach, agar `restoreOutcome.wasRestored` bo'lsa, `SqliteBackupService.executePostRestoreRebuildAndVerify` chaqirilib proyeksiyalar va paritet tekshirilishi ulandi.

---

### Qabul mezonlari
- [x] **B1 (WAL checkpoint safety backup):** Live DB dan pre-restore safety backup olishdan oldin `wal_checkpoint(TRUNCATE)` bajariladi va integrity tekshiriladi. Child process committed WAL crash testi to'liq o'tdi.
- [x] **B2 (Pre-restore validation & atomic swap):** Live DB ga tegmasdan oldin SHA-256 va `PRAGMA integrity_check` tekshiriladi. Buzuq faylda live DB ga ziyon yetmaydi. Fayl almashtirish vaqtinchalik fayl orqali atomik rename bilan bajariladi.
- [x] **B3 (Projection rebuild & ledger parity):** Hub startida stock, customer va supplier proyeksiyalari ledgerlardan qayta quriladi. Paritet buzilsa xato beradi.
- [x] **B4 (HLC monotonicity):** `last_hlc` va `last_uuid_ms` leksikografik `max(restored, current)` ga ko'tariladi, orqaga sakrash yo'q.

---

### Test natijasi (buyruq va haqiqiy chiqish)
Buyruq: `pnpm verify`
```
$ prettier --check .
All matched files use Prettier code style!

$ turbo run build
Tasks: 17 successful, 17 total (built in 3.9s)

$ node scripts/lint-workspaces.mjs
(0 errors, 0 warnings)

$ turbo run typecheck
Tasks: 25 successful, 25 total (passed in 9.8s)

$ turbo run db:check
SQLite schema matches committed migrations (0 diff statements).
PostgreSQL schema matches committed migrations (0 diff statements).

$ pnpm run test:unit
Test Files  68 passed | 1 skipped (69)
Tests       316 passed | 2 skipped (318)

$ pnpm run test:perf
[PERF T1.4 HTTP E2E] 20-line POST /carts/:id/complete took 44.01 ms
[PERF T1.5 HTTP E2E] 20-line 3-payment POST /carts/:id/complete median=37.21 ms
[PERF T1.4 db-local] 20-line completeSale took 40.13 ms
[PERF T1.5 db-local] 20-line completeSale (3 payments) median=37.50 ms
[PERF T1.8 100-line receiving]: 174.83 ms
[PERF T1.10 HTTP E2E] 20-line POST /orders/:id/deliver took 45.57 ms
[db-local perf] 20-line order deliverOrder completed in 35.91 ms
[PERF T1.9 db-local] 1,000-receipt shift closeShift elapsed=24.36 ms
Test Files  9 passed (9)
Tests       12 passed (12)

$ pnpm --filter @mezon/pos test:e2e
1 passed (10.3s)

$ depcruise --config .dependency-cruiser.cjs apps/*/src packages/*/src
✔ no dependency violations found (362 modules, 1541 dependencies cruised)
```

---

### Tekshirilmagan narsalar
- Faqat real POS apparatidagi jismoniy monoblok (haqiqiy elektr uzilishi), bu esa faqat real Windows 10 monoblokda sinovdan o'tkaziladi.

### Qilingan taxminlar
- Post-restore rebuild hub serveri ishga tushganda faqat tiklash amalga oshgan holatda (`restoreOutcome.wasRestored === true`) avtomatik ishga tushadi, oddiy ishga tushishlarda esa ortiqcha I/O yuklama qilmaydi.
