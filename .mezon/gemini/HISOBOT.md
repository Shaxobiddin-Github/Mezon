## Hisobot: T0.5 (Windows CI `EPERM` test tuzatishi — qayta tekshiruv so'rovi)

Branch / PR: `gemini/T0.5-uow-outbox` / [PR #5](https://github.com/Shaxobiddin-Github/Mezon/pull/5)  
Commit: `9cacebac4fd6eba69c51d2a7185b63d87a574d43` (faqat test tuzatishi; K1–K3 kod commit'i: `0702dcc`, Claude `QABUL` commit'i: `e3c5854`, boshlang'ich T0.5: `d9e43c0`)

### Nima uchun merge qilinmasdan qayta tekshiruv so'ralmoqda (`GEMINI.md` 3.6)

- Claude'ning `QABUL` commit'i (`e3c5854`) uchun CI [`Verify (windows-latest)`](https://github.com/Shaxobiddin-Github/Mezon/actions/runs/42796990210/job/129764580032) job'i `K3.2` testidan keyin `afterEach` (`fs.rmSync`) da `EPERM: Permission denied` bilan yiqildi (`uow.test.ts` bola OS jarayoni `conn.close()` va chiqishni tugatmasdan `process.send` bilan testni yakunlagan edi).
- `GEMINI.md` 3.6 ("PR'ning oxirgi commit'i uchun Claude `QABUL` bergan va CI Ubuntu hamda Windows'da yashil") ga ko'ra qizil CI bilan ham merge qilib bo'lmasdi, yangi commitdan keyin esa Claude qayta tasdig'i shart.
- **`9caceba` da ishlab chiqarish kodi umuman o'zgarmagan (`0702dcc` bilan bir xil)**; faqat `packages/db-local/src/uow.test.ts` (+19/-4) tuzatildi:
  - `conn2-worker.mjs` ichida `conn.close()` IPC javobidan oldin bajariladi va `process.send(reply, () => process.exit(0))` orqali yopiladi;
  - `K3.2` testida ham, `finally`da ham `child` `'close'` hodisasi (`closedPromise`) kutiladi;
  - `afterEach` `fs.rmSync(..., { maxRetries: 5, retryDelay: 50 })` qo'shildi.

### Nima qilindi (K1–K3 umumiy)

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

### O'zgargan fayllar (`0702dcc` + `9caceba`)

- `packages/domain/src/errors.ts` (`0702dcc`) — `'UNIT_OF_WORK_CONCURRENT_NESTED' | 'UNIT_OF_WORK_TENANT_MISMATCH'` kodlari qo'shildi.
- `packages/db-local/src/uow.ts` (`0702dcc`) — `SqliteUnitOfWork` `activeSessionStack` va `assertActiveTransaction()` da eng ustki faol sessiya tekshiruvi.
- `packages/db-local/src/writers.ts` (`0702dcc`) — `prepareSyncedWriteContext()` da `session.organizationId` tenglik tekshiruvi (`UNIT_OF_WORK_TENANT_MISMATCH`).
- `packages/db-local/src/uow.test.ts` (`0702dcc`, `9caceba`) — K1 (`a`/`b`/`c`), K2 (barcha 4 writer), K3.1, K3.2 (2 OS ulanish + Windows `child` `'close'` kutish), K3.3, K3.4, K3.5 va K3.6 testlari qo'shildi.

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

**Lokal (`Windows`, commit `9caceba`):**

1. `pnpm verify`:
   - `prettier --check .`, `turbo run build` (`17 successful, 17 total`), `eslint .` (0 xato), `turbo run typecheck` (`19 successful, 19 total`), `turbo run db:check` (SQLite `0 diff`, PostgreSQL `0 diff`), `depcruise` (0 xato, 99 modul / 216 bog'liqlik).
   - `vitest run`: `Test Files 10 passed | 1 skipped (11)`, `Tests 82 passed | 2 skipped (84)` (`pg-rls.test.ts` Docker yo'qligi sabab skip; `packages/db-local/src/uow.test.ts` `14 passed (14)`).
2. `K3.2` stress-tekshiruvi (`Windows` da 5 marta ketma-ket `vitest run packages/db-local/src/uow.test.ts -t "K3.2"`): 5/5 passed (1137ms, 1155ms, 1164ms, 1145ms, 1299ms), `EPERM` 0 ta.
3. **Mutatsiya / salbiy tekshiruvlar (`0702dcc` kodida, vaqtinchalik, keyin qayta tiklangan):**
   - `packages/db-local/src/uow.ts` da `BEGIN IMMEDIATE` -> `BEGIN` qilinganda `vitest run packages/db-local/src/uow.test.ts -t "K3.2"` -> Exit code 1 (`SqliteError: database is locked` `insertSyncedRecord` ichida).
   - `FACT` trigger yetishmasligi, `ATTR` da `RAISE(IGNORE)` va shartsiz `BEFORE UPDATE RAISE(ABORT)` -> `pnpm run db:check` Exit code 1; `db-local -> node:http` -> `depcruise` Exit code 1.

**GitHub Actions CI (commit `9caceba`, PR Run [#42797713887](https://github.com/Shaxobiddin-Github/Mezon/actions/runs/42797713887) va push Run [#42797704345](https://github.com/Shaxobiddin-Github/Mezon/actions/runs/42797704345)):**

- [`Verify (ubuntu-latest)`](https://github.com/Shaxobiddin-Github/Mezon/actions/runs/42797713887/job/129767032018) — **success** (`0 diff`, `Test Files 11 passed (11)`, `Tests 84 passed (84)`, `depcruise` 0 violations / 99 modules / 216 deps).
- [`Verify (windows-latest)`](https://github.com/Shaxobiddin-Github/Mezon/actions/runs/42797713887/job/129767032217) — **success** (`0 diff`, `Test Files 10 passed | 1 skipped (11)`, `Tests 82 passed | 2 skipped (84)` [Docker yo'q PG RLS skip], `depcruise` 0 violations).
- [`Verify PostgreSQL RLS (ubuntu-latest)`](https://github.com/Shaxobiddin-Github/Mezon/actions/runs/42797713887/job/129767031614) — **success** (`Test Files 2 passed (2)`, `Tests 8 passed (8)`).
- (`push` Run [#42797704345](https://github.com/Shaxobiddin-Github/Mezon/actions/runs/42797704345) ham uchala job'da **success**.)

### Tekshirilmagan narsalar

- Lokal Windows muhitida Docker bo'lmagani uchun `pg-rls.test.ts` lokalda o'tkazib yuborildi (Ubuntu CI job'da to'liq o'tdi).

### Qilingan taxminlar

- Yangi taxmin kiritilmadi.

### Takliflar

- Yangi taklif yo'q.

### Egasi yoki Claude qarori kerak bo'lgan savollar

- PR #5 boshi `9caceba` (faqat `uow.test.ts` dagi Windows `EPERM` poygasi tuzatishi) uchun Claude'ning qayta `QABUL` tasdig'i kerak (`GEMINI.md` 3.6); shundan so'ng darhol Squash and merge qilib `gemini/T0.6-hub-auth` da T0.6 rejasini yozamiz.
