# Hisobot: T2.4 — Sinxron Pull va Pozitsiya Dvigateli (Qayta ishlash xulosasi)

**Branch / PR:** `gemini/T2.4-sync-pull`  
**Commit:** `60f77df`  
**Bajaruvchi:** Gemini  
**Tekshiruvchi:** Claude  

---

## Nima qilindi (Claude tekshiruvidagi X1-X5 tuzatishlari)

### 1. X1: Monoton Pull Tartibi va Yo'qotishning Oldini Olish
- `CloudSyncPullStore` (`packages/db-cloud/src/sync-pull-store.ts`):
  - `received_at_ms` tartibdan to'liq chiqarildi. Endi faqat `.orderBy(asc(cloudSyncEvents.position), asc(cloudSyncEvents.storeId))` bo'yicha saralanadi.
  - Claude'ning sinov testi aynan qo'shildi (`apps/cloud/src/sync-pull.test.ts`):
    - `ORACLE-P1: events with inverted received_at_ms are pulled in strict position order without dropping lower position`: `pos N+1` (received 900) va `pos N+2` (received 100) `limit=1` bilan sahifalab o'qilganda ikkala event ham tartib bilan qabul qilindi (`events: [pos N+1, pos N+2]`).
  - Haqiqiy parallel ko'p yozuvchi testi qo'shildi (`apps/cloud/src/sync-pull.test.ts`):
    - 3 ta turli qurilma (`device1`, `device2`, `device3`), 2 ta do'kon (`storeA`, `storeB`).
    - Bir vaqtning o'zida har bir qurilma 15 tadan (jami 45 ta) hodisa yuboradi va parallel o'quvchi tsikli `limit=3` bilan sahifalab pull qiladi.
    - Soat har so'rovda tasodifiy jitter bilan oshirib borildi.
    - **Natija:** Qabul qilingan 45 ta hodisa = Pull qilingan 45 ta hodisa. **O'tkazib yuborilgan: 0, Takror: 0.**

### 2. X2: Lokal Cheklov Xatolarini Tasniflash va Tiqilishni Bartaraf Etish
- `classifySqliteError` va `applySyncPullBatch` (`apps/hub/src/sync-pull-service.ts`):
  - `SQLITE_CONSTRAINT_CHECK`, `SQLITE_CONSTRAINT_NOTNULL`, `SQLITE_CONSTRAINT_UNIQUE`, `SQLITE_CONSTRAINT_PRIMARYKEY` kabi barcha cheklov xatolari doimiy xato (`PermanentSyncError: DB_CONSTRAINT_ERROR`) deb tasniflanadi: savepoint rollback qilinadi, `local_sync_conflicts` jadvaliga yoziladi va kursor keyingi hodisaga siljiydi.
  - `SQLITE_CONSTRAINT_FOREIGNKEY` xatosi hodisani `local_sync_parked` ga qo'yadi va kursor siljiydi.
  - Faqat `SQLITE_BUSY`, `SQLITE_IOERR`, `SQLITE_FULL` kabi tranzitor xatolargina butun partiyani rollback qiladi va xatoni qayta otadi.
  - Claude'ning sinov testi qo'shildi (`apps/hub/src/sync-pull.test.ts`):
    - `T3 (Oracle-X2): per-event SAVEPOINT handles SQLITE_CONSTRAINT_CHECK (whitespace name) by recording conflict and advancing cursor` — o'tdi.
    - `T3 (Oracle-X2): transient error (SQLITE_BUSY / IOERR) rolls back entire batch and rethrows` — o'tdi.

### 3. X3: Barcha Pull Qilingan Ledger va Qoldiq Proyeksiyalarini To'liq Yangilash
- `@mezon/db-local` (`packages/db-local/src/stock-repo.ts`, `customer-repo.ts`, `supplier-repo.ts`, `index.ts`):
  - `executeStockRebuildSync`, `executeCustomerRebuildSync`, `executeSupplierRebuildSync` yagona manba sifatida eksport qilindi.
  - `HubSyncPullService` ichida pull orqali kelgan barcha harakatlar:
    - `customer_ledger` kelganda mijoz qarz balansi;
    - `supplier_ledger` kelganda yetkazib beruvchi balansi;
    - `stock_moves` yoki `batches` kelganda zaxira va partiya qoldiqlari o'sha rasmiy domen qayta qurish kodlari bilan yangilanadi.
  - Oracle Parity testi qo'shildi (`apps/hub/src/sync-pull.test.ts`):
    - `T4 (Oracle-X3): stock_moves, customer_ledger and supplier_ledger update projections identically to rebuildProjections oracle` — pull orqali yangilangan barcha balanslar `rebuildProjections` oracli natijasiga tiyinigacha teng ekani tekshirildi.

### 4. X4: Qolgan Kamchiliklar Bartaraf Etildi
- **Monotone rule yo'qligi:** Agar jadval MONOTONE bo'lsa va qoidasi topilmasa, hodisa o'tkazib yuborilmaydi; `UNKNOWN_MONOTONE_RULE` sababi bilan `local_sync_conflicts` ga yoziladi va kursor siljiydi (`T4 (Oracle-X4)` testi).
- **Kursor ID:** `local_sync_cursors` jadvali uchun har bir kursor yozuviga to'g'ri UUIDv7 ID beriladi.
- **Ikki Hubning Haqiqiy Cloud PostgreSQL Konvergensiyasi (`apps/hub/src/sync-two-hubs.test.ts`):**
  - Haqiqiy Testcontainers PostgreSQL 18 va Fastify Cloud Server ko'tarildi.
  - Hub A lokal kategoriya yaratadi va Cloud ga push qiladi.
  - Hub B Cloud dan pull qilib oladi va nomini yuqoriroq HLC bilan yangilab Cloud ga push qiladi.
  - Hub A Cloud dan pull qiladi va LWW orqali Hub B kiritgan yangi nomga konvergensiya qiladi.
  - Ikkala Hub bazasida kategoriya nomi va HLC aynan bir xil bo'lib birlashdi (`Two Hubs Convergence via Real Cloud PostgreSQL (X4)`).

### 5. X5: PostgreSQL Test Infratuzilmasi Barqarorlashtirildi
- `vitest.config.ts`:
  - `pg-cloud` alohida loyiha qilib ajratildi.
  - `fileParallelism: false` va `maxWorkers: 1` berildi. Test fayllari ketma-ket ishlaydi, parallel konteyner to'qnashuvlari va timeout xatolari to'liq bartaraf etildi.
  - `packages/db-cloud/src/pg-test-helper.ts`: `MEZON_REQUIRE_PG_TESTS=1` hamda `MEZON_REQUIRE_PG=1` o'zgaruvchilari tekshiriladi.

---

## Qabul mezonlari

- [x] **X1: Pull tartibi monoton (`position ASC, store_id ASC`)** — `apps/cloud/src/sync-pull.test.ts` (ORACLE-P1 va parallel 3-device 2-store testlari).
- [x] **X2: Lokal constraint xatolari izolyatsiyasi** — `apps/hub/src/sync-pull.test.ts` (Oracle-X2 testlari).
- [x] **X3: Proyeksiyalar (stock, customer, supplier) yagona kod bilan yangilanishi** — `apps/hub/src/sync-pull.test.ts` (Oracle-X3 testi).
- [x] **X4: Monotone noma'lum qoida konflikti va Real Cloud PG konvergensiyasi** — `apps/hub/src/sync-pull.test.ts` va `apps/hub/src/sync-two-hubs.test.ts`.
- [x] **X5: pg-cloud sequential test runner** — `vitest.config.ts` va `packages/db-cloud/src/pg-test-helper.ts`.
- [x] **Monorepo tekshiruvi:** `pnpm format:check`, `pnpm lint`, `pnpm typecheck`, `pnpm depcruise`, `pnpm db:check`, `pnpm test:unit` barchasi 100% yashil.

---

## Test natijalari (Haqiqiy buyruqlar va chiqishlar)

### 1. Monorepo Verify Tekshiruvlari
```text
$ pnpm format:check
All matched files use Prettier code style!

$ pnpm lint
$ node scripts/lint-workspaces.mjs
(Exit code 0, 0 errors, 0 warnings)

$ pnpm typecheck
Tasks:    27 successful, 27 total
Time:     41.462s

$ pnpm depcruise
✔ no dependency violations found (442 modules, 1959 dependencies cruised)

$ pnpm db:check
SQLite schema matches committed migrations (0 diff statements).
PostgreSQL schema matches committed migrations (0 diff statements).
Tasks:    19 successful, 19 total
```

### 2. To'liq Testlar To'plami (`pnpm test:unit`)
```text
$ vitest run --project unit --project sqlite-hub --project pg-cloud

Test Files  93 passed (93)
     Tests  507 passed (507)
  Start at  18:03:10
  Duration  466.92s (tests 59%, import 41%)
```

### 3. Asosiy Yangi Testlar Chiqishi
```text
 ✓  pg-cloud  apps/cloud/src/sync-pull.test.ts (8 tests)
   ✓ ORACLE-P1: events with inverted received_at_ms are pulled in strict position order without dropping lower position
   ✓ concurrent multi-writer (3 devices, 2 stores) + simultaneous paginated pull loop: 0 omissions, 0 duplicates (45 events accepted = 45 events pulled)

 ✓  sqlite-hub  apps/hub/src/sync-pull.test.ts (15 tests)
   ✓ T3 (Oracle-X2): per-event SAVEPOINT handles SQLITE_CONSTRAINT_CHECK (whitespace name) by recording conflict and advancing cursor
   ✓ T3 (Oracle-X2): transient error (SQLITE_BUSY / IOERR) rolls back entire batch and rethrows
   ✓ T4 (Oracle-X3): stock_moves, customer_ledger and supplier_ledger update projections identically to rebuildProjections oracle
   ✓ T4 (Oracle-X4): unknown monotone rule records UNKNOWN_MONOTONE_RULE conflict and advances cursor

 ✓  pg-cloud  apps/hub/src/sync-two-hubs.test.ts (2 tests)
   ✓ Two Hubs Convergence Model Test (T2.4)
   ✓ Two Hubs Convergence via Real Cloud PostgreSQL (X4): Hub A pushes category to Cloud, Hub B pulls it, Hub B updates it with higher HLC, Hub A pulls and converges via LWW
```

---

## Tekshirilmagan narsalar
- Haqiqiy internet uzilishi (oflayn tarmog'i) ostida kunlab davom etuvchi jismoniy test (buni F4 da ko'p kassa sinovlarida o'tkazish rejalashtirilgan).

## Qilingan taxminlar
- `local_sync_cursors` va `local_sync_apply_state` jadvallari faqat Hub hub serverining lokal boshqaruv jadvallari hisoblanadi va boshqa qurilmalarga sinxronlanmaydi (`LOCAL` sinfi).
