## Hisobot: T0.6 — Qayta ishlash (`R1` va `R2`)

Branch / PR: `gemini/T0.6-hub-auth` / [PR #6](https://github.com/Shaxobiddin-Github/Mezon/pull/6)  
Commit: `9b7a75b6b4089986be0bbcd3b92ff6d2767f1fea` (`R1`–`R2` tuzatishlari; boshlang'ich T0.6: `07afc281f2bbddd016d46b16e9f4c2a3083e117a`)

### Qayta ishlash (`R1` va `R2`)

1. **R1 (YUQORI — PIN reset bilan login TOCTOU poygasi):**
   - [`packages/db-local/src/auth-repo.ts`](packages/db-local/src/auth-repo.ts) ichidagi `commitLoginOutcome()` endi `verifiedPinHash: string | null` ni majburiy parametr sifatida qabul qiladi (`auth-service.ts` Phase 1 snapshotdagi `snap.pinHash` ni uzatadi).
   - `BEGIN IMMEDIATE` tranzaksiyasi ichida bazadagi `cred.pinHash !== input.verifiedPinHash` bo'lsa (PIN tekshiruv paytida `POST /users/:id/pin` orqali almashtirilgan bo'lsa), sessiya ochilmaydi hamda `failed_attempts` (user va device) oshirilmasdan `{ kind: 'invalid_credentials' }` qaytadi -> mijoz **`401 AUTH_INVALID_CREDENTIALS`** oladi.
   - Test ([`hub.test.ts`](apps/hub/src/hub.test.ts)): `rejects in-flight login when PIN is reset mid-verification (TOCTOU R1) without creating a session or incrementing failed_attempts` (300 ms kechikadigan maxsus `pinHasher`, 60 ms o'tgach `POST /users/:id/pin` = `200`, kechikkan login = `401`, resetdan keyingi `local_sessions` soni = `0n`, `failed_attempts` = `0n`, `locked_until_ms` = `null`).

2. **R2 (O'RTA — paralel yuklamada 5000 ms timeout barqarorligi):**
   - Og'ir tsikl, `fast-check` property va ko'p jarayonli testlarga aniq `30_000` ms timeout berildi (`hech bir assertion zaiflashtirilmadi`):
     - `packages/domain/src/hlc.test.ts`: `survives 70,000 now() calls ...` (284-qator) va HLC `fast-check` property testi (651-qator) -> `30_000` ms.
     - `packages/domain/src/uuidv7.test.ts`: UUIDv7 `fast-check` property testi (392-qator) -> `30_000` ms.
     - `packages/db-local/src/uow.test.ts`: child-process crash recovery (`process.exit(42)`), `fast-check` property test va `K3.2` 2-process `BEGIN IMMEDIATE` testi -> `30_000` ms.
     - `apps/hub/src/hub.test.ts`: haqiqiy `@node-rs/argon2` testi va `R1` sekin hasher testi -> `30_000` ms.

### Nima qilindi (T0.6 umumiy)

Rejadagi barcha talablar (`a`–`h`) va Claude belgilagan `T1`–`T6` tuzatishlar to'liq amalga oshirildi:

1. **Domen qoidalari va RBAC (`packages/domain`):**
   - [`packages/domain/src/auth.ts`](packages/domain/src/auth.ts): `USER_ROLES` (`owner`, `manager`, `cashier`), `ROLE_PERMISSION_TABLE` va `roleHasPermission()` (`auth:self`, `users:read`, `users:write`, `users:unlock`), `PinHasher` porti, `PIN_SECURITY_CONSTANTS`, `validatePinFormat()` (6–12 raqam, takroriy `000000`/`111111` va ketma-ket `123456`/`654321` PINlarni rad etadi, xatoda PINni oshkor qilmaydi), `normalizeUsername()`, `validateFullName()`, `computeDeviceCooldownDelayMs()` (`15`-xatodan boshlab 2s, 4s, 8s, 16s, 32s, 60s max), `computeRetryAfterSeconds()`.
   - [`packages/domain/src/errors.ts`](packages/domain/src/errors.ts): T0.6 kodlari (`VALIDATION_ERROR`, `INVALID_PIN`, `AUTH_UNAUTHORIZED`, `AUTH_INVALID_CREDENTIALS`, `AUTH_FORBIDDEN`, `AUTH_RATE_LIMITED`, `SETUP_ALREADY_COMPLETED`, `USER_NOT_FOUND`, `USERNAME_ALREADY_EXISTS`, `LAST_OWNER_PROTECTED`, `INVALID_HOST`, `FORBIDDEN_ORIGIN`) hamda ixtiyoriy `retryAfterSeconds`.

2. **Zod kontraktlar (`packages/contracts`):**
   - `zod@4.6.7` qo'shildi.
   - [`packages/contracts/src/auth.ts`](packages/contracts/src/auth.ts): `ApiErrorEnvelopeSchema` (`{ error: { code, message } }`), `SetupRequestSchema`/`SetupResponseSchema`, `LoginOptionsResponseSchema`, `LoginRequestSchema` (`username` yoki `userId` + PIN), `LoginResponseSchema`, `LogoutResponseSchema`, `AuthMeResponseSchema`, `CreateUserRequestSchema`, `UpdateUserRequestSchema`, `ResetUserPinRequestSchema`, `UnlockUserResponseSchema`, `DeleteUserResponseSchema`, `UserSummarySchema` (`pinHash`, lockout va `tokenHash`siz).

3. **SQLite sxema, migratsiya va auth store (`packages/db-local`):**
   - [`packages/db-local/src/schema/index.ts`](packages/db-local/src/schema/index.ts):
     - `users` (`ATTR`, `tenantScope: 'organization'`) — T5 bo'yicha partial unique index `uidx_users_org_username` (`WHERE "users"."deleted_at_ms" IS NULL`).
     - `local_hub_config` (`LOCAL`, `singleton_guard = 1` + `UNIQUE`).
     - `local_pin_credentials` (`LOCAL` — Argon2id hash va 5-xatoli user blok holati, bulut/outboxga chiqmaydi).
     - `local_device_auth_state` (`LOCAL` — T1 bo'yicha 5-daqiqalik oyna + 15-xatodan keyingi 2..60s progressiv kechikish).
     - `local_sessions` (`LOCAL` — 64-belgi SHA-256 `token_hash`, `expires_at_ms`, `revoked_at_ms`, `last_seen_at_ms`).
   - [`packages/db-local/src/uow.ts`](packages/db-local/src/uow.ts): ulanish darajasidagi umumiy FIFO mutex (`connectionMutexes` WeakMap), `runConnectionReadOnly()`, `bootstrapSqliteHubUnitOfWork()`.
   - [`packages/db-local/src/auth-repo.ts`](packages/db-local/src/auth-repo.ts): barcha yozuvlar `uow.execute` / `bootstrapSqliteHubUnitOfWork` orqali, barcha o'qishlar `uow.runReadOnly` / `runConnectionReadOnly` orqali (`T4`); `local_sessions.last_seen_at_ms` daqiqada eng ko'pi 1 marta (`>= 60_000n` ms) yangilanadi (`T4`); `users` `ATTR` `insertAttr`/`updateAttr`/`tombstoneAttr` orqali outboxga atomik yoziladi; oxirgi aktiv `owner` himoyasi (`LAST_OWNER_PROTECTED`).

4. **Hub HTTP server va himoya (`apps/hub`):**
   - Fastify `5.12.8`, Pino `10.4.0`, `@node-rs/argon2` `2.2.2`, Zod `4.6.7`.
   - [`apps/hub/src/config.ts`](apps/hub/src/config.ts) & [`apps/hub/src/security.ts`](apps/hub/src/security.ts): faqat `127.0.0.1`; `Host` (`127.0.0.1:<port>`/`localhost:<port>` bo'lmasa `421 INVALID_HOST`); `Origin` allowlist & `Sec-Fetch-Site: cross-site` (`403 FORBIDDEN_ORIGIN`); `OPTIONS` preflight va `Access-Control-*` sarlavhalari qat'iy yopiq; cookie ishlatilmaydi, faqat `Authorization: Bearer`.
   - [`apps/hub/src/argon2-pin-hasher.ts`](apps/hub/src/argon2-pin-hasher.ts): OWASP minimal profili `Argon2id`, `m=19456` KiB (19 MiB), `t=2`, `p=1`, `outputLen=32`; mavjud bo'lmagan/nofaol foydalanuvchi uchun ham doimiy `dummyPinHash` orqali Argon2id tekshiruvi.
   - [`apps/hub/src/auth-service.ts`](apps/hub/src/auth-service.ts): `login()` 4 fazali (read snapshot -> tranzaksiya tashqarisida async Argon2id -> `uow.execute` ichida muvaffaqiyatsiz urinish yoki sessiyani commit qilish -> commitdan keyin HTTP xatosi otish, `T2`).
   - [`apps/hub/src/logger.ts`](apps/hub/src/logger.ts) & [`apps/hub/src/error-handler.ts`](apps/hub/src/error-handler.ts): Pino `redact` (`authorization`, `cookie`, `pin`, `pinHash`, `token`, `tokenHash`, `password`, `secret`), `{ error: { code, message } }` konverti va stack trace'ni yashirish.
   - [`apps/hub/src/routes.ts`](apps/hub/src/routes.ts): `GET /health`, `POST /setup`, `GET /auth/login-options` (`T6`), `POST /auth/login` (`username` yoki `userId`), `POST /auth/logout`, `GET /auth/me`, `GET /users`, `POST /users`, `PATCH /users/:id`, `POST /users/:id/pin`, `POST /users/:id/unlock` (`T3`), `DELETE /users/:id`.

5. **Import chegaralari va TypeScript/ESLint:**
   - [`.dependency-cruiser.cjs`](.dependency-cruiser.cjs): `contracts-src-imports` va `hub-src-imports` (`apps/hub` `db-cloud`ni import qila olmaydi).
   - [`eslint.config.mjs`](eslint.config.mjs): `./apps/*/tsconfig.test.json` qo'shildi.

### O'zgargan fayllar (`07afc28`)

- `.dependency-cruiser.cjs`, `eslint.config.mjs`, `pnpm-lock.yaml` — depcruise chegaralari, ESLint test tsconfigni ulash va exact paket versiyalarini mahkamlash.
- `packages/domain/src/{errors.ts,auth.ts,index.ts,auth.test.ts}` — RBAC, PIN qoidalari, progressiv backoff, auth `DomainError` kodlari.
- `packages/contracts/{package.json,tsconfig.json,tsconfig.test.json,src/{auth.ts,index.ts,auth.test.ts}}` — Zod 4.6.7 kontraktlar va testlar.
- `packages/db-local/{src/{schema/index.ts,uow.ts,auth-repo.ts,index.ts,index.test.ts,uow.test.ts,auth.test.ts},drizzle/{0002_hub_auth.sql,meta/{_journal.json,0002_snapshot.json}}}` — T0.6 jadvallari, migratsiya + `users` `BEFORE DELETE` triggeri, connection FIFO mutex, `SqliteHubAuthStore` va testlar (`uow.test.ts` property test timeout `30_000` ms).
- `apps/hub/{package.json,tsconfig.json,tsconfig.test.json,src/{config.ts,logger.ts,argon2-pin-hasher.ts,security.ts,error-handler.ts,auth-service.ts,routes.ts,server.ts,index.ts,hub.test.ts}}` — Hub HTTP server va to'liq integratsiya testlari.

### Migratsiyalar

- `packages/db-local/drizzle/0002_hub_auth.sql`: `local_device_auth_state`, `local_hub_config`, `local_pin_credentials`, `local_sessions`, `users` (`ATTR`) hamda `uidx_users_org_username` (`WHERE "users"."deleted_at_ms" IS NULL`) va `trg_users_no_delete` (`BEFORE DELETE RAISE(ABORT)`).

### Qabul mezonlari

- [x] **a) Mahalliy himoya** — `hub.test.ts`: `0.0.0.0` rad etilishi, real `127.0.0.1:0` tinglash, 7 ta soxta/noto'g'ri `Host` -> `421`, noto'g'ri `Origin`/`null`/`Sec-Fetch-Site: cross-site` -> `403`, `OPTIONS` preflight -> `403` (`Access-Control-*`siz), `Cookie` ignor qilinishi va `Set-Cookie` yo'qligi.
- [x] **b) PIN, Argon2id, brute force va log redaction** — `hub.test.ts`: haqiqiy `@node-rs/argon2` (`$argon2id$v=19$m=19456,t=2,p=1$...`), mavjud bo'lmagan foydalanuvchi uchun `verify(dummyHash, pin)` chaqirilishi va bir xil 401 javobi, 5 xatodan keyin baza + restartdan keyin ham `429` blok, T1 bo'yicha 15+ xatodan keyin `2, 4, 8, 16, 32, 60, 60` s `Retry-After` va kutishdan keyin egasi kira olishi, Pino stream loglarida PIN/hash/token/tokenHash `0` ta va `[Redacted]` borligi.
- [x] **c) Ma'lumot & T4 & T5** — `auth.test.ts` va `hub.test.ts`: `users` outboxda `ATTR` (`deleted_at_ms IS NULL` partial unique bilan tombstone nomni qayta ishlatish `T5`), `local_pin_credentials`/`local_sessions` outboxga yozilmasligi, `last_seen_at_ms` < 60s da yozilmay `>= 60s` da yangilanishi (`T4`), logout/expiry/`isActive=false`/PIN reset sessiyani darhol yopishi.
- [x] **d) Sehrgar (`POST /setup`)** — `hub.test.ts` va `auth.test.ts`: parallel `Promise.all` da aniq 1 ta `201` va 1 ta `409 SETUP_ALREADY_COMPLETED`, kuchsiz PIN va `admin/admin` rad etilishi.
- [x] **e) & T3 Rollar** — `hub.test.ts`: (`unauthenticated`, `cashier`, `manager`, `owner`) × (`/auth/me`, `/auth/logout`, `GET /users`, `POST /users`, `PATCH /users/:id`, `POST /users/:id/unlock`, `POST /users/:id/pin`, `DELETE /users/:id`) to'liq matritsasi, oxirgi `owner` himoyasi.
- [x] **T2 (Commit before reject)** — `hub.test.ts`: 5 xatodan keyin to'g'ridan-to'g'ri SQLite `SELECT failed_attempts, locked_until_ms FROM local_pin_credentials` da `failed_attempts = 5n` va `locked_until_ms` saqlangan.
- [x] **T6 (`login-options` va `userId` login)** — `hub.test.ts`: ochiq `GET /auth/login-options` faqat aktiv `{ id, fullName, role }` qaytaradi; `{ userId, pin }` login ishlaydi.
- [x] **f) & g) Xatolar, versiyalar va chegara** — `{ error: { code, message } }` (stack siz), salbiy `depcruise` (`apps/hub -> @mezon/db-cloud` Exit code 1; `packages/contracts -> @mezon/db-local` Exit code 1) va salbiy `db:check` (`trg_users_no_delete` olib tashlansa Exit code 1).

### Test natijasi (oxirgi tahrirdan keyin)

**Lokal (`Windows`, commit `9b7a75b`, `pnpm verify` ketma-ket 3 marta):**

1. **1-run:** `Test Files 14 passed | 1 skipped (15)`, `Tests 99 passed | 2 skipped (101)`, Vitest `10.50s` (`70,000 now()` `4447ms`, `TOCTOU R1` `1335ms`), `db:check` `0 diff`, `depcruise` `0` xato (`138 modules, 344 deps`).
2. **2-run:** `Test Files 14 passed | 1 skipped (15)`, `Tests 99 passed | 2 skipped (101)`, Vitest `10.66s` (`70,000 now()` `4598ms`, `TOCTOU R1` `1335ms`), `0` xato.
3. **3-run:** `Test Files 14 passed | 1 skipped (15)`, `Tests 99 passed | 2 skipped (101)`, Vitest `11.04s` (`70,000 now()` `4761ms`, `TOCTOU R1` `1327ms`), `0` xato.
   *(Lokal Windows muhitida Docker bo'lmagani uchun `pg-rls.test.ts` skip qilingan.)*
- **Salbiy tekshiruvlar (`07afc28` da tasdiqlangan, qayta tiklangan):**
  - `apps/hub/src/index.ts` -> `@mezon/db-cloud` => `depcruise` Exit code 1 (`hub-src-imports`).
  - `packages/contracts/src/index.ts` -> `@mezon/db-local` => `depcruise` Exit code 1 (`contracts-src-imports`).
  - `0002_hub_auth.sql` da `trg_users_no_delete` olib tashlansa => `db:check` Exit code 1.

**GitHub Actions CI (commit `9b7a75b`, PR Run [#42804480413](https://github.com/Shaxobiddin-Github/Mezon/actions/runs/42804480413) va push Run [#42804472884](https://github.com/Shaxobiddin-Github/Mezon/actions/runs/42804472884)):**

- [`Verify (ubuntu-latest)`](https://github.com/Shaxobiddin-Github/Mezon/actions/runs/42804480413/job/129790023611) — **success** (`0 diff`, `Test Files 14 passed | 1 skipped (15)`, `Tests 99 passed | 2 skipped (101)` [`pg-rls`], `13.71s`, `depcruise` 0 violations / 138 modules / 344 deps).
- [`Verify (windows-latest)`](https://github.com/Shaxobiddin-Github/Mezon/actions/runs/42804480413/job/129790023547) — **success** (`0 diff`, `Test Files 14 passed | 1 skipped (15)`, `Tests 99 passed | 2 skipped (101)`, `24.66s`, `depcruise` 0 violations).
- [`Verify PostgreSQL RLS (ubuntu-latest)`](https://github.com/Shaxobiddin-Github/Mezon/actions/runs/42804480413/job/129790023313) — **success** (`Test Files 2 passed (2)`, `Tests 8 passed (8)`, `14.00s`).
- (`push` Run [#42804472884](https://github.com/Shaxobiddin-Github/Mezon/actions/runs/42804472884) ham uchala job'da **success**.)

### Tekshirilmagan narsalar

- Lokal Windows muhitida Docker bo'lmagani sabab `pg-rls.test.ts` lokalda o'tkazib yuborildi (Ubuntu CI job'larida to'liq o'tdi).

### Qilingan taxminlar

- Yangi taxmin kiritilmadi; barcha yondashuvlar tasdiqlangan T0.6 rejasi va `T1`–`T6` tuzatishlariga mos.

### Takliflar

- Yangi taklif yo'q.

### Egasi yoki Claude qarori kerak bo'lgan savollar

- Savol yo'q; PR #6 (`9b7a75b`) Claude tekshiruvi uchun tayyor.
