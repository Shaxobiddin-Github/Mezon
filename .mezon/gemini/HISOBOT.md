# T2.2 Rejasi: Qurilma juftlash (Device Pairing), Xavfsizlik va Token Boshqaruvi

## 1. Xavfsizlik qarzi (`T2.1 qarzi: migratsiya alohida konteynerda`)

T2.2 boshlanishidagi eng birinchi alohida commit: `T2.1 qarzi: migratsiya alohida konteynerda`.

1. **`deploy/docker-compose.yml` arxitekturasi:**
   - Bir martalik `migrate` servisi qo'shiladi:
     - `command: pnpm --filter @mezon/cloud db:migrate`
     - Faqat `DATABASE_ADMIN_URL` beriladi. Migratsiyalarni bajaradi, `mezon_app` / `mezon_auth_owner` huquqlarini tekshiradi va tugagach chiqib ketadi (`restart: no`).
   - `cloud` servisi runtime'da:
     - `depends_on: migrate: condition: service_completed_successfully`
     - **Faqat** `DATABASE_URL` (`mezon_app`) ni oladi.
     - `DATABASE_ADMIN_URL` undan butunlay olib tashlanadi.
2. **`apps/cloud` runtime o'zgarishi:**
   - `startCloudServer()` funksiyasidan migratsiya chaqiruvi butunlay chiqarib tashlanadi.
   - Alohida CLI buyrug'i: `pnpm --filter @mezon/cloud db:migrate` (`apps/cloud/src/cli/migrate.ts`).
   - `apps/cloud/package.json` ga `"db:migrate": "tsx src/cli/migrate.ts"` qo'shiladi.
3. **Dokumentatsiya va test:**
   - `.env.example` va `deploy/BACKUP-RESTORE.md` shunga moslashtiriladi.
   - **Test:** Oddiy fayl/konfiguratsiya testi:
     - `docker-compose.yml` da `cloud` servisi environment'ida `DATABASE_ADMIN_URL` yo'qligi tekshiriladi;
     - `migrate` servisi mavjudligi va `cloud` uning muvaffaqiyatli tugashini kutishi (`service_completed_successfully`) assert qilinadi.

---

## 2. Juftlash oqimi (Pairing Flow)

### a) Kabinetda bir martalik kod yaratish
1. **Endpoint:** `POST /api/v1/devices/pairing-codes` (Faqat `owner`).
2. **Kirish:** `{ storeId: UUIDv7, name: string }`.
3. **Kod generatsiyasi:**
   - Kriptografik tasodifiy 8 belgili kod (chalkash `0, O, 1, I, L` belgilarisiz `[2-9A-HJ-NP-Z]{8}`).
   - Kodning SHA-256 xeshi `cloud_device_pairing_codes` jadvalida saqlanadi. Ochiq kod bazaga yozilmaydi.
   - Amal qilish muddati: `expires_at_ms = nowMs + 10 daqiqa` (600_000 ms).
   - Urinishlar chegarasi: `attempts_left = 5`.
4. **Javob:** `{ code: "K7M9P2X4", expiresAtMs, storeId, storeName }`. Ochiq kod egasiga faqat 1 marta ko'rsatiladi.

### b) Hub tomonida kodni kiritish va juftlash
1. **Endpoint:** `POST /api/v1/devices/pair` (Pre-auth endpoint, rate-limited).
2. **Kirish:**
   - `code`: 8 belgili juftlash kodi.
   - `deviceId`: Hub'ning T0.3 dagi UUIDv7 identifikatori (`local_device_state` dagi barqaror apparat/klient ID).
   - `platform`: `'windows' | 'android' | 'linux'`.
   - `appVersion`: string.
3. **Bulutda tekshirish:**
   - Kodning SHA-256 xeshi bo'yicha qidiriladi.
   - Agar kod topilmasa: IP va urinish hisoblagichi oshiriladi -> `401 / 400`.
   - Agar `expires_at_ms < nowMs` bo'lsa -> `410 Gone: Juftlash kodining muddati o'tgan`.
   - Agar `attempts_left <= 0` bo'lsa -> `429 Too Many Requests: Kod bloklangan`.
   - Agar `used_at_ms IS NOT NULL` bo'lsa -> `409 Conflict: Kod allaqachon ishlatilgan`.
   - Har muvaffaqiyatsiz urinishda `attempts_left = attempts_left - 1`.
   - Muvaffaqiyatli tekshiruvda darhol `used_at_ms = nowMs` belgilanadi (bir martalik kafolat).
4. **Apparat bog'lanishi (Device Identity):**
   - Agar ushbu `deviceId` allaqachon `cloud_devices` jadvalida mavjud bo'lsa:
     - Agar u boshqa tashkilotga (`organization_id != pairing.organization_id`) tegishli bo'lsa -> `409 Conflict: Qurilma allaqachon boshqa tashkilotga bog'langan`.
     - Agar ayni shu tashkilotga tegishli bo'lsa -> eski tokenlari bekor qilinadi va yangilanadi (re-pairing).
   - Yangi qurilma bo'lsa: `cloud_devices` jadvaliga yangi qator yoziladi (`status = 'active'`, `store_id = pairing.store_id`, `name = pairing.device_name`).
5. **Qurilma tokeni berish:**
   - 32 bayt tasodifiy maxfiy qiymat (`rawSecret`).
   - Format: `<organizationId>.<deviceId>.<rawSecret>`.
   - Bulutda faqat SHA-256 xeshi `cloud_device_tokens` jadvaliga yoziladi.
   - Hub'ga qaytariladi: `{ deviceToken, organizationId, storeId, storeName, organizationName }`.

---

## 3. Qurilma tokeni: format, saqlash, aylantirish va bekor qilish

### a) Format va Tenant konteksti
- Token formati: `<organizationId>.<deviceId>.<rawSecret>`.
- Kiruvchi so'rovda server `organizationId` va `deviceId` ni ajratib oladi va so'rovni `withPgTenantContext(organizationId)` ichida RLS ostida bajaradi.
- Prefiks soxtalashtirilsa, boshqa tenant kontekstida token xeshi topilmaydi -> `401 Unauthorized`.

### b) Hub'da xavfsiz saqlash
- Desktop (Electron) muhitida: Electron `safeStorage.encryptString(deviceToken)` orqali OS kalit omborida (Windows DPAPI, macOS Keychain, Linux Secret Service) shifrlanadi.
- Hub SQLite bazasida (`local_cloud_state`) faqat shifrlangan bufer saqlanadi (`encrypted_device_token BLOB`). Hech qachon ochiq matn yozilmaydi.
- Headless / test muhitida: `SafeStoragePort` interfeysi orqali test shifrlash adapteri ishlatiladi.

### c) Tokenni aylantirish (Rotation)
- **Endpoint:** `POST /api/v1/devices/rotate-token` (Bearer `<deviceToken>`).
- Yangi 32 bayt maxfiy qiymat va yangi token beriladi.
- Eski token darhol `revoked_at_ms = nowMs` qilinadi.
- **Reuse detection & Security Wipe:** Agar bekor qilingan token qayta ishlatilsa, qurilmaning BARCHA tokenlari bekor qilinadi va `cloud_devices.status = 'blocked'` belgilanadi. Barcha keyingi so'rovlar `401` oladi.

### d) Qurilmani bekor qilish (Revocation)
- **Endpoint:** `POST /api/v1/devices/:id/revoke` (Faqat kabinet egasi `owner`).
- `cloud_devices.status = 'revoked'`, `cloud_device_tokens` dagi barcha tokenlar `revoked_at_ms = nowMs`.
- Shundan so'ng ushbu qurilmadan kelgan har qanday so'rov darhol `401 Unauthorized` oladi.

---

## 4. Hub va bulut bog'lanishi: jadvallar va xavfsizlik chegarasi

### a) Bulut jadvallari (PostgreSQL RLS ostida)
1. `cloud_device_pairing_codes`:
   - `id`: UUIDv7 (PK)
   - `organization_id`: UUIDv7 (tenant RLS)
   - `store_id`: UUIDv7
   - `device_name`: text
   - `code_hash`: text (SHA-256)
   - `attempts_left`: integer
   - `expires_at_ms`: bigint
   - `used_at_ms`: bigint | null
   - `created_at_ms`: bigint
2. `cloud_devices`:
   - `id`: UUIDv7 (PK)
   - `organization_id`: UUIDv7 (tenant RLS)
   - `store_id`: UUIDv7
   - `device_id`: UUIDv7 (unikal hub apparat ID)
   - `name`: text
   - `platform`: text ('windows' | 'android' | 'linux')
   - `app_version`: text
   - `status`: text ('active' | 'blocked' | 'revoked')
   - `last_seen_at_ms`: bigint
   - `created_at_ms`: bigint
   - `updated_at_ms`: bigint
3. `cloud_device_tokens`:
   - `id`: UUIDv7 (PK)
   - `organization_id`: UUIDv7 (tenant RLS)
   - `device_id`: UUIDv7
   - `token_hash`: text (SHA-256)
   - `expires_at_ms`: bigint
   - `revoked_at_ms`: bigint | null
   - `created_at_ms`: bigint

### b) Bulutga umuman chiqmaydigan ma'lumotlar (Zero-Leakage Boundary)
Quyidagi jadvallar va ma'lumotlar faqat do'kon hub'ining lokal SQLite bazasida qoladi, sinxronga (T2.3) ham, juftlashga (T2.2) ham hech qachon chiqmaydi:
- `users`: Kassirlar va xodimlar ro'yxati, ularning Argon2id PIN xeshlari (`pin_hash`). Kassir PIN xeshlari faqat lokal hub'da tekshiriladi.
- `sessions`: Kassa terminallarining faol sessiyalari va ularning sessiya tokenlari.
- `user_locks`: Kassirlarning PIN xatolari hisoblagichlari va vaqtinchalik bloklash holatlari.
- `local_device_state`: Do'kon apparatining lokal hisoblagichlari (`last_device_seq`, `last_hlc`, `last_uuid_ms`).
- Sinxron hodisalari (`local_outbox`): Outbox payload'larida foydalanuvchi PIN yoki parollari bilan bog'liq hodisalar umuman yaratilmaydi.

### c) Hub tomonidagi holat va amallar
- `local_cloud_state` jadvali (SQLite LOCAL):
  - `pairing_status`: 'unpaired' | 'paired' | 'revoked'
  - `cloud_url`: text
  - `organization_id`: text
  - `store_id`: text
  - `encrypted_device_token`: blob
  - `paired_at_ms`: bigint
  - `last_sync_at_ms`: bigint
- Hub API:
  - `GET /api/v1/cloud/status` — Ulanish holati (faqat `owner` va `manager`).
  - `POST /api/v1/cloud/pair` — Juftlash kodi orqali bulutga ulanish (faqat `owner`).
  - `POST /api/v1/cloud/unpair` — Ulanishni uzish va lokal tokenni o'chirish (faqat `owner`).

---

## 5. Testlar rejasi

1. **Xavfsizlik qarzi testi:**
   - `docker-compose.yml` da `cloud` servisida `DATABASE_ADMIN_URL` yo'qligi va `migrate` konteyneri orqali ishga tushishi assert qilinadi.
2. **Juftlash oqimi testlari:**
   - To'g'ri 8 belgili kod bilan juftlash muvaffaqiyatli o'tadi va tenant-prefixed token qaytaradi.
   - Muddati o'tgan kod (`expires_at_ms < now`) rad etiladi (`410`).
   - Bir marta ishlatilgan kod bilan qayta juftlash rad etiladi (`409`).
   - 5 ta noto'g'ri urinishdan so'ng kod bloklanadi (`429`).
   - Boshqa tashkilotga bog'langan `deviceId` ni qayta juftlash rad etiladi (`409`).
3. **Qurilma tokeni va bekor qilish testlari:**
   - Qurilma o'z tokeni bilan bulut API'dan o'z holatini oladi.
   - Soxta tenant prefiksli token bilan so'rov `401` oladi.
   - Egasi qurilmani bekor qilgach (`status = 'revoked'`), qurilma so'rovi darhol `401` oladi.
   - Token rotatsiyasi va qayta ishlatilgan token bilan murojaat qilinganda barcha tokenlar bekor qilinishi (Security Wipe).
4. **Nol-oqish (Zero-Leakage) testi:**
   - Hub'dan bulutga boradigan barcha so'rovlar (headers, query, body) tekshiriladi: `pin_hash`, PIN qiymati yoki lokal sessiya ma'lumotlari mavjud emasligi assert qilinadi.
5. **Ikki tashkilot izolyatsiyasi testi:**
   - Org A uchun yaratilgan juftlash kodi bilan Org B hub'ini juftlab bo'lmaydi.
   - Org A qurilmasi Org B resurslarini ko'ra olmaydi yoki o'zgartira olmaydi.

---

## 6. Doiradan tashqari
- Savdo va ombor hodisalarini sinxronlash (T2.3 Push, T2.4 Pull).
- Biznes kabineti React UI (T2.7).
