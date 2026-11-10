## Hisobot: T0.5

Branch / PR: `gemini/T0.5-uow-outbox` / [PR #5](https://github.com/Shaxobiddin-Github/Mezon/pull/5)  
Commit: `0702dcc600544d4de20a41fbf244b5c29361d8f0` (qayta ishlash K1–K3; boshlang'ich T0.5 commit: `d9e43c03188ea965639012ef707d01e63817ec84`)

### Nima qilindi

Claude'ning `.mezon/claude/TOPSHIRIQ.md` (`d9e43c0` bo'yicha `QAYTA ISHLASH`) barcha topilmalari tuzatildi va testlar bilan isbotlandi:

1. **K1 (`UNIT_OF_WORK_CONCURRENT_NESTED`):**
   - [`packages/domain/src/errors.ts`](packages/domain/src/errors.ts) ga `'UNIT_OF_WORK_CONCURRENT_NESTED'` va `'UNIT_OF_WORK_TENANT_MISMATCH'` xato kodlari qo'shildi.
   - [`packages/db-local/src/uow.ts`](packages/db-local/src/uow.ts) ichidagi `SqliteUnitOfWork` endi har bir tashqi tranzaksiya davomida `activeSessionStack` yuritadi (`execute()` boshida tashqi sessiya push/pop, `nested()` boshida `childSession` push/pop).
   - `SqliteUnitOfWorkSession.assertActiveTransaction()` eng ustki tekshiruv sifatida `this.uow.topActiveSession() !== this` bo'lsa darhol `DomainError('UNIT_OF_WORK_CONCURRENT_NESTED')` otadi.
   - Natija: parallel `s.nested()` chaqiruvlari (`Promise.allSettled([p1, p2])`) ham, bola savepoint ochiq turganda ota sessiyadan yozish (`insertFact`, `insertAttr`, `updateAttr`, `tombstoneAttr`) yoki `s.nested()` ochish ham darhol rad etiladi; chuqur ichma-ich (`c1.nested(c2)`) va ketma-ket `nested()` esa avvalgidek ishlaydi.

2. **K2 (`UNIT_OF_WORK_TENANT_MISMATCH`):**
   - [`packages/db-local/src/writers.ts`](packages/db-local/src/writers.ts) ichidagi umumiy `prepareSyncedWriteContext()` yordamchisida (`insertFact`, `insertAttr`, `updateAttr`, `tombstoneAttr` tomonidan chaqiriladi) `validOrgId !== session.organizationId` tekshiruvi qo'shildi; teng bo'lmasa `DomainError('UNIT_OF_WORK_TENANT_MISMATCH')` tashlanadi.

3. **K3 (6 ta test qamrovi bo'shlig'i yopildi):**
   - **K3.1:** `nested()` tugagach (muvaffaqiyatli ham, xato bilan rollback bo'lganda ham) tashqariga saqlab qolingan `child` sessiyadan yozish yoki `child.nested()` chaqirish darhol `UNIT_OF_WORK_SESSION_CLOSED` qaytarishi alohida test bilan tekshirildi.
   - **K3.2:** Ikki alohida OS jarayonidagi ikki ulanish (`conn1` asosiy jarayonda `SELECT` -> IPC signal `'write'` -> `await delay(150)` -> `insertFact`; `conn2` child jarayonda real `SqliteUnitOfWork` orqali `insertFact`) testi yozildi. Muhim kuzatuv: bir xil Node.js oqimida `better-sqlite3` sinxron C++ `busy_timeout` chaqiruvi event loop'ni band qilib qo'ygani uchun ikki OS jarayonida tekshirildi — `BEGIN IMMEDIATE` bilan ikkala ulanish `busy_timeout` doirasida muvaffaqiyatli yakunlaydi, `BEGIN IMMEDIATE` o'rniga oddiy `BEGIN` qo'yilganda esa `conn1` eski read-snapshot'dan write-upgrade qila olmay `SqliteError: database is locked` (`SQLITE_BUSY`) bilan yiqiladi (mutatsiya bilan tasdiqlandi).
   - **K3.3:** `appendOutboxEventSync` ni SQLite tranzaksiyasidan tashqarida chaqirish darhol xato berishi testlandi.
   - **K3.4:** `SqliteOutboxRepository.listPending()` `acked` va `rejected` qatorlarni chiqarib tashlab faqat `pending` qatorlarni `device_seq` tartibida (hamda `limit` bilan) qaytarishi testlandi.
   - **K3.5:** Tashkilot (`organization`) darajasidagi `attrItems` jadvaliga `storeId` berilganda `insertAttr` darhol rad etishi (`must not receive a storeId`) va do'kon (`store`) darajasidagi `factSales` jadvalida `storeId`siz `insertFact` rad etilishi testlandi.
   - **K3.6:** `assertActiveTransaction()` ichidagi `!sqlite.open || !sqlite.inTransaction` tekshiruvi **yetib bo'ladigan** (`reachable`) tarmoqdir: callback ichida xom SQL `ROLLBACK` (yoki `OR ROLLBACK`) bajarilsa, `session.closed === false` va `AsyncLocalStorage` konteksti faol turgan holda SQLite tranzaksiyasi yopilgan bo'ladi va keyingi operatsiya `UNIT_OF_WORK_REQUIRED` otadi, mutex esa `finally` orqali toza bo'shatiladi. Test bilan isbotlandi (shuningdek `sqlite.close()` ham avvalgi crash testida bor).

### O'zgargan fayllar (`0702dcc` — K1–K3 qayta ishlash)

- `packages/domain/src/errors.ts` — `'UNIT_OF_WORK_CONCURRENT_NESTED' | 'UNIT_OF_WORK_TENANT_MISMATCH'` kodlari qo'shildi.
- `packages/db-local/src/uow.ts` — `SqliteUnitOfWork` `activeSessionStack` va `assertActiveTransaction()` da eng ustki faol sessiya tekshiruvi.
- `packages/db-local/src/writers.ts` — `prepareSyncedWriteContext()` da `session.organizationId` tenglik tekshiruvi (`UNIT_OF_WORK_TENANT_MISMATCH`).
- `packages/db-local/src/uow.test.ts` — K1 (`a`/`b`/`c`), K2 (barcha 4 writer), K3.1, K3.2 (2 OS ulanish), K3.3, K3.4, K3.5 va K3.6 testlari qo'shildi.

(Boshlang'ich T0.5 (`d9e43c0`) da yaratilgan/yangilangan fayllar ham PR #5 tarkibida saqlanadi: `packages/domain/src/uow.ts`, `packages/domain/src/index.ts`, `packages/db-local/src/schema/index.ts`, `packages/db-local/src/device-state.ts`, `packages/db-local/src/outbox.ts`, `packages/db-local/src/triggers.ts`, `packages/db-local/src/registry.ts`, `packages/db-local/src/index.ts`, `packages/db-local/src/index.test.ts`, `packages/db-local/scripts/check-migrations.mjs`, `packages/db-local/drizzle/0001_uow_outbox_device_state.sql`, `packages/db-local/drizzle/meta/0001_snapshot.json`, `packages/db-local/drizzle/meta/_journal.json`, `packages/db-local/package.json`, `.dependency-cruiser.cjs`, `pnpm-lock.yaml`.)

### Migratsiyalar

- Yangi migratsiya qo'shilmadi (PR #5 dagi `packages/db-local/drizzle/0001_uow_outbox_device_state.sql` o'zgarmagan).
- `pnpm run db:check`: SQLite (`0 diff statements`) va PostgreSQL (`0 diff statements`) hamda SQLite immutability trigger tekshiruvi o'tdi.

### Qabul mezonlari (K1–K3 va T0.5)

- [x] **K1 (a/b/c)** — `uow.test.ts`: `K1: rejects concurrent parallel nested() calls and parent-session writes while child savepoint is active, while allowing deep & sequential nested()` (`Promise.allSettled([p1, p2])` da `p2` `UNIT_OF_WORK_CONCURRENT_NESTED` bilan rad etildi, 0 yo'qolgan qator; `s` dan barcha 4 writer + `c1` dan ichki `c2` ochiq paytda rad etildi; `c1 -> c2` va ketma-ket `nested()` o'tdi).
- [x] **K2** — `uow.test.ts`: `K2: rejects writes with foreign organizationId across all 4 writers with UNIT_OF_WORK_TENANT_MISMATCH` (`insertFact`, `insertAttr`, `updateAttr`, `tombstoneAttr` begona `orgB` bilan `UNIT_OF_WORK_TENANT_MISMATCH` qaytardi).
- [x] **K3.1** — `uow.test.ts`: `K3.1: closes child savepoint session immediately on exit or rollback while outer UoW is still active` (`UNIT_OF_WORK_SESSION_CLOSED` muvaffaqiyatli va xato rollback holatlarida).
- [x] **K3.2** — `uow.test.ts`: `K3.2: BEGIN IMMEDIATE acquires write lock upfront across two separate OS connections preventing SQLITE_BUSY write-upgrade error` + `BEGIN` mutatsiya tekshiruvi (`SqliteError: database is locked` ushlandi).
- [x] **K3.3, K3.4, K3.6** — `uow.test.ts`: `K3.3, K3.4, K3.6: enforces appendOutboxEventSync inTransaction check, listPending status filtering, and mid-callback ROLLBACK/close guard`.
- [x] **K3.5** — `uow.test.ts`: Test 1 da `insertAttr(..., { organizationId, storeId })` `must not receive a storeId` xatosi bilan rad etildi.
- [x] **T0.5 asosiy mezonlari (saqlanib qolgan)** — rollback'da outbox bo'sh, `rollback -> commit` ketma-ketligi, savepoint izolyatsiyasi, reentrant `execute()`/`runReadOnly()` rad etilishi, `COMMIT` xatosida mutex bo'shashi, OS jarayon qulashi (`process.exit(42)`), qayta ishga tushganda `device_seq` va HLC/UUIDv7 monotonligi, triggerlar (`FACT`/`ATTR`/`MONOTONE`), `fast-check` property test.

### Test natijasi (oxirgi tahrirdan keyin)

**Lokal (`Windows`):**

1. `pnpm exec prettier --check .` -> `All matched files use Prettier code style!` (Exit code 0)
2. `pnpm verify`:
   - `turbo run build`: `17 successful, 17 total`
   - `eslint .`: 0 xato
   - `turbo run typecheck`: `19 successful, 19 total`
   - `turbo run db:check`: SQLite (`0 diff statements`), PostgreSQL (`0 diff statements`)
   - `vitest run`: `Test Files 10 passed | 1 skipped (11)`, `Tests 82 passed | 2 skipped (84)` (`pg-rls.test.ts` Docker yo'qligi sabab skip; `packages/db-local/src/uow.test.ts` `14 passed (14)`).
   - `depcruise`: `no dependency violations found (99 modules, 216 dependencies cruised)`
3. **Mutatsiya / salbiy tekshiruvlar (vaqtinchalik, keyin qayta tiklangan):**
   - `packages/db-local/src/uow.ts` da `BEGIN IMMEDIATE` -> `BEGIN` qilinganda `vitest run packages/db-local/src/uow.test.ts -t "K3.2"` -> Exit code 1 (`SqliteError: database is locked` `insertSyncedRecord` ichida).
   - `FACT` trigger yetishmasligi, `ATTR` da `RAISE(IGNORE)` va shartsiz `BEFORE UPDATE RAISE(ABORT)` -> `pnpm run db:check` Exit code 1; `db-local -> node:http` -> `depcruise` Exit code 1.

**GitHub Actions CI (commit `0702dcc`, Run [#42795409253](https://github.com/Shaxobiddin-Github/Mezon/actions/runs/42795409253)):**

- [`Verify (ubuntu-latest)`](https://github.com/Shaxobiddin-Github/Mezon/actions/runs/42795409253/job/129759219411) — **success** (`0 diff`, `Test Files 11 passed (11)`, `Tests 84 passed (84)`, `uow.test.ts` 14 tests / 3059ms, `depcruise` 0 violations / 99 modules / 216 deps).
- [`Verify (windows-latest)`](https://github.com/Shaxobiddin-Github/Mezon/actions/runs/42795409253/job/129759219321) — **success** (`0 diff`, `Test Files 10 passed | 1 skipped (11)`, `Tests 82 passed | 2 skipped (84)` [Docker yo'q PG RLS skip], `uow.test.ts` 14 tests / 5252ms, `depcruise` 0 violations).
- [`Verify PostgreSQL RLS (ubuntu-latest)`](https://github.com/Shaxobiddin-Github/Mezon/actions/runs/42795409253/job/129759218670) — **success** (`Test Files 2 passed (2)`, `Tests 8 passed (8)`, `pg-rls.test.ts` 2 passed / 13769ms).

### Tekshirilmagan narsalar

- Lokal Windows muhitida Docker bo'lmagani uchun `pg-rls.test.ts` lokalda o'tkazib yuborildi (Ubuntu CI job'da to'liq o'tdi).

### Qilingan taxminlar

- Yangi taxmin kiritilmadi.

### Takliflar

- Yangi taklif yo'q.

### Egasi yoki Claude qarori kerak bo'lgan savollar

- Savol yo'q; PR #5 (`0702dcc`) Claude tekshiruvi uchun tayyor.
