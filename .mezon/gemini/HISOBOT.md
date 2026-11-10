## T0.5 Merge xulosasi

- **PR #5** (`gemini/T0.5-uow-outbox`, bosh SHA `aac2f63253e86a3c994da2f73b8b4d2dbd2330f1`, barcha 6 CI check run `success` — Run [#42798505396](https://github.com/Shaxobiddin-Github/Mezon/actions/runs/42798505396) va [#42798497585](https://github.com/Shaxobiddin-Github/Mezon/actions/runs/42798497585)) `T0.5: Asinxron UnitOfWork, outbox va qurilma holati` nomi bilan Squash and merge qilindi.
- **Merge commit SHA (`main`):** `a50e6abdb6824a3743e4fbb2b025a5df0afa4148`
- **`gemini/T0.5-uow-outbox` branch:** masofadan va lokaldan o'chirildi.
- **Yangi branch (`main` @ `a50e6ab` dan):** `gemini/T0.6-hub-auth`

---

## Reja: T0.6 — Hub skeleti va autentifikatsiya

> **Eslatma:** Bu bosqichda faqat reja berilmoqda; Claude tasdig'isiz kod yozilmaydi.

### 0. Qamrov va versiyalar (GEMINI.md 2.1 va T0.6 `h` bandi)

- **Doira:** Fastify HTTP hub skeleti (`127.0.0.1`), lokal hujumlardan himoya, tuzilgan Pino log (+ redaction), yagona xato formati, Zod kontraktlari, birinchi ishga tushirish sehrgari (`POST /setup`), foydalanuvchi (`ATTR`), rollar (`owner`, `manager`, `cashier`), Argon2id PIN + baza darajasidagi foydalanuvchi va qurilma bloklari, SHA-256 xeshli opaque bearer sessiyalar.
- **Doiradan tashqari:** biznes jadvallari (mahsulot, ombor, savdo — F1), Electron (`T0.7`), bulut sinxron API (`F2`), tashqi tarmoq `0.0.0.0` tinglash (`F4`).
- **Paket versiyalari (npm'da tasdiqlangan, GEMINI.md 2.1 bo'yicha `pnpm-lock.yaml` da mahkamlanadi):**
  - `fastify`: `5.12.8` (GEMINI.md: Fastify 5)
  - `pino`: `10.4.0` (GEMINI.md: Pino 10)
  - `zod`: `4.6.7` (GEMINI.md: Zod 4)
  - `@node-rs/argon2`: `2.2.2` (GEMINI.md: `@node-rs/argon2` 2)
  - Cookie va `jose` ishlatilmaydi (sessiya 32 bayt tasodifiy opaque bearer token + SHA-256 hash; CORS uchinchi tomon plaginisiz qat'iy yopiq).

---

### 1. Paketlar chegarasi va rejalashtirilgan fayllar (`g` bandi)

1. **`packages/domain` (sof biznes qoidalari va portlar, tashqi import 0):**
   - `packages/domain/src/errors.ts`: T0.6 `DomainErrorCode` kodlari qo'shiladi (`AUTH_UNAUTHORIZED`, `AUTH_INVALID_CREDENTIALS`, `AUTH_FORBIDDEN`, `AUTH_RATE_LIMITED`, `SETUP_ALREADY_COMPLETED`, `USER_NOT_FOUND`, `USERNAME_ALREADY_EXISTS`, `LAST_OWNER_PROTECTED`, `INVALID_PIN`).
   - `packages/domain/src/auth.ts`:
     - `UserRole = 'owner' | 'manager' | 'cashier'`, `HubPermission = 'users:read' | 'users:write' | 'auth:self'`, rol × ruxsat jadvali `ROLE_PERMISSIONS` va `roleHasPermission(role, permission)`.
     - `PinHasher` port interfeysi (`hash(pin: string): Promise<string>`, `verify(hash: string, pin: string): Promise<boolean>`).
     - `PIN_SECURITY_CONSTANTS` (user lock: 5 xato -> 5 daqiqa / `300_000n` ms; device lock: `300_000n` ms oynada 15 xato -> 5 daqiqa / `300_000n` ms blok; sessiya TTL: 12 soat / `43_200_000n` ms) va sof `validatePinFormat(pin)` + `normalizeUsername(username)` funksiyalari (xato xabarida PIN qiymati hech qachon qaytarilmaydi).
     - `packages/domain/src/auth.test.ts`: RBAC jadvali, username/PIN validatsiya va kuchsiz PIN rad etish testlari.

2. **`packages/contracts` (Zod 4.6.7 sxemalari va DTO tiplar):**
   - `packages/contracts/package.json`: `@mezon/domain` va `zod: 4.6.7`.
   - `packages/contracts/src/index.ts` va `packages/contracts/src/auth.ts`:
     - `ApiErrorEnvelopeSchema`: `{ error: { code, message } }`.
     - `HealthResponseSchema`, `SetupRequestSchema`, `SetupResponseSchema`.
     - `LoginPinRequestSchema`, `LoginResponseSchema`, `LogoutResponseSchema`, `AuthMeResponseSchema`.
     - `CreateUserRequestSchema`, `UpdateUserRequestSchema`, `ResetUserPinRequestSchema`, `UserSummarySchema` (`pinHash`, lockout va `tokenHash` maydonlari DTO'da umuman yo'q).
     - `packages/contracts/src/auth.test.ts`.

3. **`packages/db-local` (sxema, migratsiya, SQLite trigger va auth repozitoriyasi):**
   - `packages/db-local/src/schema/index.ts` — barcha jadvallar `localSchemaRegistry.defineTable(...)` orqali e'lon qilinadi:
     - **`users` (`ATTR`, `tenantScope: 'organization'`)**: sinxron foydalanuvchi va rol jadvali. Ustunlar: `username` (UNIQUE `(organization_id, username)` — aktiv/tombstone siyosati aniq tekshiriladi), `fullName`, `role` (`CHECK (role IN ('owner', 'manager', 'cashier'))`), `isActive` (`sqliteBoolean`). Faqat UoW + T0.5 `insertAttr` / `updateAttr` / `tombstoneAttr` orqali yoziladi (avtomatik `local_outbox` + bir xil HLC + `BEFORE DELETE RAISE(ABORT)` trigger).
     - **`local_hub_config` (`LOCAL`, `tenantScope: 'organization'`)**: birinchi ishga tushirish holati (`storeId`, `deviceId`, `singletonGuard` `CHECK (singleton_guard = 1)` + `UNIQUE(singleton_guard)`, `setupCompletedAtMs`). DB darajasida ikki marta sehrgar o'tishini imkonsiz qiladi.
     - **`local_pin_credentials` (`LOCAL`, `tenantScope: 'organization'`)**: alohida lokal jadval (sinxronlanmaydi, outboxga yozilmaydi). Ustunlar: `userId` (`UNIQUE`, FK `users.id`), `pinHash` (`text` — Argon2id PHC satr), `pinUpdatedAtMs`, `failedAttempts` (`CHECK >= 0`), `lockedUntilMs` (nullable UnixMs), `lastFailedAtMs`. Qayta ishga tushganda blok holati bazadan tiklanadi.
     - **`local_device_auth_state` (`LOCAL`, `tenantScope: 'organization'`)**: qurilma bo'yicha umumiy brute force cheklovi. Ustunlar: `deviceId` (`UNIQUE`), `windowStartedAtMs`, `failedAttempts` (`CHECK >= 0`), `lockedUntilMs` (nullable UnixMs), `lastFailedAtMs`. Har xil foydalanuvchilarni yoki mavjud bo'lmagan nomlarni navbatma-navbat sinab ko'rishni to'sadi va restart'da yo'qolmaydi.
     - **`local_sessions` (`LOCAL`, `tenantScope: 'organization'`)**: opaque sessiya jadvali. Ustunlar: `userId` (FK `users.id`), `deviceId`, `tokenHash` (`UNIQUE`, 64-belgi SHA-256 hex), `expiresAtMs`, `revokedAtMs` (nullable), `lastSeenAtMs`. Raw 32-bayt token bazada saqlanmaydi.
   - `packages/db-local/drizzle/0002_hub_auth.sql` + snapshot/journal (`drizzle-kit` + `BEFORE DELETE RAISE(ABORT)` trigger `users` uchun) -> `pnpm run db:check` (0 diff va trigger tekshiruvi) o'tadi.
   - `packages/db-local/src/auth-repo.ts`: Setup holati, foydalanuvchi o'qish/yozish (UoW ichida), PIN credential + lockout yangilash, qurilma auth limitini tekshirish/oshirish, sessiya yaratish/topish/bekor qilish (foydalanuvchi o'chirilsa, `isActive=false` bo'lsa yoki PIN almashtirilsa barcha aktiv sessiyalari o'sha tranzaksiyada bekor qilinadi).
   - `apps/hub` bevosita `drizzle-orm` yoki `better-sqlite3`ga kirmasligi uchun kerakli barcha baza operatsiyalari `@mezon/db-local` orqali eksport qilinadi.

4. **`apps/hub` (Fastify 5.12.8 + Pino 10.4.0 + Argon2id 2.2.2):**
   - `apps/hub/package.json`: `@mezon/domain`, `@mezon/contracts`, `@mezon/db-local`, `@mezon/drivers`, `fastify@5.12.8`, `pino@10.4.0`, `zod@4.6.7`, `@node-rs/argon2@2.2.2` (devDeps: `@mezon/test-utils`).
   - `apps/hub/src/config.ts`: majburiy `host = '127.0.0.1'` (`0.0.0.0` yoki boshqa tashqi IP berilsa xato bilan to'xtaydi), port, `allowedOrigins`, lockout va sessiya TTL sozlamalari.
   - `apps/hub/src/logger.ts`: Pino 10 logger + `redact` qoidalari.
   - `apps/hub/src/security.ts`: `Host` sarlavhasi tekshiruvi (`421 INVALID_HOST`), `Origin` / `Sec-Fetch-Site` tekshiruvi (`403 FORBIDDEN_ORIGIN`), `Cookie`ni e'tiborsiz qoldirish va barcha CORS headerlarini bermasdan `OPTIONS` preflightni rad etish.
   - `apps/hub/src/argon2-pin-hasher.ts`: `@node-rs/argon2` (`Algorithm.Argon2id`) asinxron implementatsiyasi + doimiy vaqtli `DUMMY_PIN_HASH` (startupda yoki modul yuklanganda Argon2id parametrlari bilan bir marta tayyorlanadi, mavjud bo'lmagan foydalanuvchi uchun ham aynan shu `verify` ishlaydi).
   - `apps/hub/src/error-handler.ts`: `ZodError`, Fastify JSON parse xatolari, `DomainError` kodlari (`400`/`401`/`403`/`404`/`409`/`421`/`429`) va noma'lum 500 xatolar uchun yagona `{ error: { code, message } }` javobi (mijozga stack trace chiqmaydi).
   - `apps/hub/src/auth-service.ts`: sehrgar (`setup`), `login` (timingsiz/enumeratsiyasiz va ikki darajali bazadagi blok bilan), `logout`, `authenticateBearer`, foydalanuvchi CRUD va PIN reset.
   - `apps/hub/src/routes/`:
     - `GET /health` (ochiq, `{ status, service, needsSetup }` — PII yo'q)
     - `POST /setup` (bir martalik sehrgar; UoW `BEGIN IMMEDIATE`)
     - `POST /auth/login`
     - `POST /auth/logout` (har qanday autentifikatsiyalangan rol)
     - `GET /auth/me` (har qanday autentifikatsiyalangan rol)
     - `GET /users` (`owner`, `manager`)
     - `POST /users` (`owner`)
     - `PATCH /users/:id` (`owner`)
     - `POST /users/:id/pin` (`owner`)
   - `apps/hub/src/server.ts` & `apps/hub/src/index.ts`: `buildHubApp()` (testlar `fastify.inject` va haqiqiy `listen('127.0.0.1', 0)` uchun) va `startHubServer()`.

5. **`.dependency-cruiser.cjs` (`g` bandi):**
   - `contracts-src-imports` qoidasi: `packages/contracts/src/` faqat `packages/contracts/src/`, `packages/domain/` va `zod`ni import qila oladi.
   - `hub-src-imports` qoidasi: `apps/hub/src/` faqat `apps/hub/src/`, `packages/domain/`, `packages/contracts/`, `packages/db-local/`, `packages/drivers/`, `fastify`, `pino`, `@node-rs/argon2`, `zod` va `node:*` modullarini import qila oladi (`@mezon/db-cloud`, `@mezon/test-utils`, boshqa `apps/*`, `better-sqlite3`/`drizzle-orm`ga to'g'ridan-to'g'ri kirish taqiqlanadi).
   - Salbiy tekshiruv: `apps/hub/src/` ichida `@mezon/db-cloud` import qilinsa `pnpm run depcruise` Exit code 1 berishi tasdiqlanadi.

---

### 2. Muhim texnik yondashuv va asoslar (`a`–`f` bandlar)

#### a) Mahalliy hujumlardan himoya (`127.0.0.1`, CSRF, DNS rebinding)
- Hub faqat `host: '127.0.0.1'` ga bog'lanadi (konfiguratsiya boshqa host bersa darhol xato).
- **DNS rebinding himoyasi (`Host` sarlavhasi):** Fastify `onRequest` hook'i birinchi qadamda `Host` sarlavhasini tekshiradi. Faqat kutilayotgan port bilan `127.0.0.1:<port>` yoki `localhost:<port>` qabul qilinadi (`listen()`dan keyin haqiqiy bog'langan port bilan yangilanadi, `inject` uchun konfiguratsiya porti bilan). `evil.uz:3000`, `127.0.0.1.attacker.uz:3000`, bo'sh/ikki `Host`, boshqa port -> **`421 Misdirected Request`** `{ error: { code: 'INVALID_HOST', message: 'Host header is not allowed' } }`.
- **`Origin` va CSRF himoyasi:** Agar `Origin` sarlavhasi mavjud bo'lsa (istalgan brauzer XHR/fetch/forma yoki sandbox `Origin: null`), u `allowedOrigins` ro'yxatida (standart: bo'sh `[]` yoki aniq konfiguratsiya qilingan `http://127.0.0.1:<port>`/`http://localhost:<port>`) aniq satr sifatida bo'lishi shart. Ro'yxatda bo'lmasa -> **`403 Forbidden`** `{ error: { code: 'FORBIDDEN_ORIGIN', message: 'Origin is not allowed' } }`. Shuningdek `Sec-Fetch-Site: cross-site` ham `403` bilan to'xtatiladi. `Origin` yo'q holat (Electron main, Node/CLI) `Host` tekshiruvi + `Authorization: Bearer` bilan himoyalangan.
- **CORS qat'iy yopiq + Bearer:** Server hech qachon `Set-Cookie` bermaydi va `Cookie`ni o'qimaydi. Autentifikatsiya faqat `Authorization: Bearer <token>` orqali. Barcha `OPTIONS` preflight va ruxsat etilmagan `Origin` so'rovlari `Access-Control-Allow-*` sarlavhalarisiz **`403`** bilan yopiladi.

#### b) PIN (Argon2id), brute force va Pino redaction
- **Argon2id parametrlari (`@node-rs/argon2` 2.2.2, asinxron):**
  - `algorithm: Algorithm.Argon2id`
  - `memoryCost: 19456` (19 MiB = 19 × 1024 KiB), `timeCost: 2`, `parallelism: 1`, `outputLen: 32`.
  - **Asos (OWASP + `GEMINI.md` 4 GB RAM):** OWASP Password Storage Cheat Sheet minimal tavsiyasi `m=19 MiB, t=2, p=1` profiliga to'liq mos va undan past emas; shu bilan birga har tekshiruvda atigi 19 MiB RAM ishlatadi va Rust libuv threadpool'ida asinxron ishlab event loop'ni bloklamaydi (4 GB RAMli monoblokda ham silliq).
- **PIN siyosati (standart `admin/admin` yo'q):**
  - Faqat raqamlar: `6–12` ta raqam (`^\d{6,12}$`); barcha raqamlari bir xil (`000000`, `111111`) yoki oddiy ketma-ket (`123456`, `654321`) PINlar rad etiladi (`400 INVALID_PIN`). (4 raqamli variant bo'yicha savol pastda Claude/Egasi uchun alohida ko'rsatilgan.)
- **Ikki darajali bazadagi blok (restartda saqlanadi):**
  1. *Foydalanuvchi bo'yicha (`local_pin_credentials`):* har noto'g'ri urinishda `failed_attempts += 1`; `5`-xatoda `locked_until_ms = nowMs + 300_000n` (5 daqiqa). `locked_until_ms > nowMs` paytida urinish **`429 AUTH_RATE_LIMITED`** bilan rad etiladi. To'g'ri PIN bilan kirish `failed_attempts = 0` va `locked_until_ms = null` qiladi. Blok bazada turgani uchun Hub qayta ishga tushganda ham blok kuchida qoladi.
  2. *Qurilma bo'yicha (`local_device_auth_state`):* `300_000n` ms oynada foydalanuvchilar bo'yicha (hamda mavjud bo'lmagan username'lar bo'yicha) jami `15` ta xato urinish to'plansa, qurilma `300_000n` ms ga (`429 AUTH_RATE_LIMITED`) bloklanadi. Bu bitta foydalanuvchidan boshqasiga o'tib PIN terish hujumini (user-rotation spray) to'xtatadi. Muvaffaqiyatli login qurilma hisoblagichini bekor qilmaydi (faqat oyna/blok muddati tugagach yangilanadi).
- **Mavjud bo'lmagan foydalanuvchi va vaqt kanali himoyasi:**
  - `username` topilmaganda (yoki `is_active = false` / tombstoned bo'lganda) ham haqiqiy Argon2id `verify(DUMMY_PIN_HASH, pin)` bajariladi va aynan bir xil **`401 AUTH_INVALID_CREDENTIALS`** javobi qaytadi — javob vaqti ham, javob kodi/matni ham foydalanuvchi bor-yo'qligini oshkor qilmaydi.
- **Pino log maxfiyligi:**
  - `pino@10.4.0` `redact` yo'llari: `req.headers.authorization`, `req.headers.cookie`, `pin`, `*.pin`, `newPin`, `*.newPin`, `pinHash`, `*.pinHash`, `token`, `*.token`, `tokenHash`, `*.tokenHash`, `password`, `*.password`, `secret`, `*.secret` -> `"[Redacted]"`. Auth endpointlarda request body umuman loglanmaydi.

#### d) Birinchi ishga tushirish sehrgari (`POST /setup`)
- Sehrgar **faqat** `local_hub_config` bo'sh va `users`da aktiv foydalanuvchi bo'lmaganda ochiq (`GET /health` da `needsSetup: true`).
- `POST /setup` ichida `BEGIN IMMEDIATE` (setup mutex + SQLite immediate tranzaksiya):
  1. `local_hub_config` va `users` sonini qayta tekshiradi; mavjud bo'lsa **`409 SETUP_ALREADY_COMPLETED`**.
  2. `IdGenerator` (UUIDv7) bilan yangi `organizationId`, `storeId`, `deviceId` yaratadi.
  3. `local_hub_config` (`singleton_guard = 1`) va `local_device_state` (`lastDeviceSeq = 0n`) qatorlarini yozadi.
  4. `SqliteUnitOfWork` (`insertAttr`) orqali `owner` foydalanuvchini `users`ga + `local_outbox`ga (`deviceSeq = 1n`) yozadi va `local_pin_credentials`ga Argon2id xeshni saqlaydi — hammasi **bitta atomik tranzaksiyada**.
- Bir vaqtda kelgan ikki `POST /setup` so'rovidan `BEGIN IMMEDIATE` va mutex sababli birinchisi `201 Created`, ikkinchisi `409 Conflict` oladi (`Promise.all` bilan testlanadi).

---

### 3. Test rejasi

1. **`packages/domain/src/auth.test.ts` & `packages/contracts/src/auth.test.ts`:** RBAC rol matritsasi, PIN format cheklovlari, Zod sxema validatsiyasi.
2. **`packages/db-local/src/auth.test.ts`:**
   - Setup bir marta ishlashi (`singleton_guard = 1`) va outbox `deviceSeq = 1n` (`users` = `ATTR`).
   - PIN hash (`local_pin_credentials`) va sessiya (`local_sessions`) uchun outboxda yozuv **bo'lmasligi**.
   - Restart simulyatsiyasi (yangi DB ulanishi + yangi `SqliteUnitOfWork`): foydalanuvchi va qurilma blok holati bazadan saqlanishi.
   - `users` jadvalida `DELETE` trigger (`RAISE(ABORT)`) va `UPDATE`/`tombstoneAttr` HLC/outbox atomikligi.
3. **`apps/hub/src/hub.test.ts` (`fastify.inject` + real `127.0.0.1:0` HTTP port):**
   - **Mahalliy himoya (`a`):** noto'g'ri/soxta/boshqa portli `Host` -> `421`; ruxsat etilmagan `Origin` (`https://evil.com`, `Origin: null`) -> `403`; `OPTIONS` preflight -> `403` + zero `Access-Control-Allow-*` headerlari; `Set-Cookie` yo'qligi, `Cookie` ignor qilinishi; `0.0.0.0` host rad etilishi.
   - **Sehrgar (`d`):** birinchi `POST /setup` -> `201`; keyingi `POST /setup` -> `409`; parallel `Promise.all([setup1, setup2])` -> aniq 1 ta `201` va 1 ta `409`; oddiy/standart PIN (`123456`, `000000`) -> `400`.
   - **Brute force va Argon2id (`b`):**
     - Real `@node-rs/argon2` (`$argon2id$`) bilan hash & verify integratsiya testi.
     - Mavjud bo'lmagan foydalanuvchi uchun ham Argon2id bajarilishi (spy/real hash timing tekshiruvi: farq statistik shovqin doirasida, hech qachon 1ms vs 30ms emas).
     - Foydalanuvchi 5 marta xato -> 5 daqiqaga blok (`429`), Hub qayta yaratilganda (restart) blok davom etadi, `FixedClock`/`MutableClock` bilan 5 daqiqadan keyin ochiladi.
     - Qurilma bo'yicha cheklov: turli mavjud/yo'q foydalanuvchilar navbatma-navbat sinab ko'rilganda `15` xatodan keyin qurilma `429` bilan bloklanadi.
   - **Sessiya (`c`):** 32-bayt token (`SHA-256` bazada), `GET /auth/me` -> `200`, `POST /auth/logout`dan keyin eski token -> `401`, muddati o'tgan token (`MutableClock` bilan TTL oshirilganda) -> `401`, nofaol (`isActive=false`) yoki PINi almashtirilgan user tokeni darhol -> `401`.
   - **Rollar matritsasi (`e`):** (`unauthenticated`, `cashier`, `manager`, `owner`) × barcha endpointlar matritsasi (`200/201/401/403`) + oxirgi aktiv `owner`ni o'chirish/pasaytirishga urinish -> `409`.
   - **Xatolar va Pino log (`f`):** `{ error: { code, message } }` formati (400/401/403/404/409/421/429/500), 500 xatoda stack trace mijozga chiqmasligi; Pino in-memory stream testida PIN, hash, Bearer token va `tokenHash` **hech bir** log qatorida uchramasligi.
4. **Salbiy `depcruise` va `db:check` dalili (`g`):**
   - `apps/hub/src/` ichida `@mezon/db-cloud` import qilinsa `pnpm run depcruise` Exit code 1 berishi.
   - `pnpm verify` (build, lint, typecheck, db:check, vitest, depcruise) Ubuntu va Windows CI'da yashil.

---

### Takliflar va ochiq savol (Claude/Egasi qarori uchun)

1. **PIN uzunligi (`6–12` vs `4–12` raqam):** Rejada xavfsizlik uchun minimal `6` raqam (`6–12`, kuchsiz ketma-ketliklar taqiqlangan) tanlandi, chunki 5-xatogacha himoya bo'lsa-da 4 raqam entropiyasi past. Agar kassirlarga qulaylik uchun `4–12` raqam ma'qul bo'lsa, tasdiqda bildiring — darhol shunga moslaymiz.
2. **Sehrgar javobi (`POST /setup`):** Sehrgar yakunida avtomatik sessiya tokeni bermay, `201 { organizationId, storeId, deviceId, owner }` qaytarib keyingi qadamda `POST /auth/login` orqali kirishni talab qilish rejalashtirildi (toza ajratish uchun). Agar UX uchun `/setup` bir yo'la birinchi `owner` sessiyasini ham qaytarishi ma'qul bo'lsa, tasdiqda ayting.
