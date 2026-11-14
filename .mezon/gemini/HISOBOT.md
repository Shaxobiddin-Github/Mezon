# Hisobot: T2.1 R1 — Bulut API Xavfsizlik Mustahkamlanishi (S1, S2, S3)

**Branch:** `gemini/T2.1-cloud-api`  
**Commits:**
- `93cd3ab`: T1.13 test qarzi: SHA tekshiruvi
- `80d82d5`: T2.1: Bulut API, PostgreSQL 18 RLS, Fastify va deploy
- `ad53f27`: [gemini-hisobot] T2.1: Bulut API va deploy hisoboti
- `0c15009`: T2.1 R1: Bulut API xavfsizlik mustahkamlanishi (S1, S2, S3)

---

## 1. Nima qilindi (R1 xavfsizlik tuzatishlari)

### 1.1. S1: Ikki alohida ulanish va ishga tushishdagi o'zini tekshirish (Self-Check)
- **Ulanishlar ajratildi:**
  - `DATABASE_ADMIN_URL`: faqat migratsiyalar (`apps/cloud/src/index.ts`) va tashkilot yaratish CLI (`org:create`) uchun ishlatiladi (superuser/admin).
  - `DATABASE_URL`: ilova runtime'i uchun **faqat `mezon_app`** roli (`NOSUPERUSER NOBYPASSRLS`).
  - `deploy/docker-compose.yml` va `.env.example` ikkala ulanish URL'ini ajratgan holda yangilandi.
  - `deploy/init-db/01-init-roles.sh`: PostgreSQL konteyneri birinchi yuklanganda `mezon_app` (`MEZON_APP_DB_PASSWORD`) va `mezon_auth_owner` rollarini avtomatik yaratadi.
- **Ishga tushishdagi o'zini tekshirish (`assertNonSuperuserNonBypassRls`):**
  - `packages/db-cloud/src/connection.ts` da `assertNonSuperuserNonBypassRls(pool)` funksiyasi qo'shildi:
    ```sql
    SELECT rolname, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user
    ```
  - Agar `rolsuper` yoki `rolbypassrls` rost (`true`) bo'lsa, server aniq xato bilan ishga tushmaydi (`Database startup security check failed`).
  - `buildCloudServer` funksiyasining boshiga `await assertNonSuperuserNonBypassRls(conn.pool)` qo'yildi.
- **Dalillar va Mutatsiya:**
  - `apps/cloud/src/server.test.ts` da test: superuser `adminConn` bilan server ishga tushirilganda xato bilan to'xtashi assert qilindi.
  - **Mutatsiya dalili:** Agar `buildCloudServer` dan `assertNonSuperuserNonBypassRls` chaqiruvi olib tashlansa, ushbu test yiqiladi.
  - Testcontainers PG bilan haqiqiy `mezon_app` orqali to'liq HTTP API yo'li sinovdan o'tkazildi (Org A va Org B bir-birining ma'lumotlariga kira olmasligi isbotlandi).

---

### 1.2. S2: `auth_lookup_login` egasi va xavfsizligi
- **Alohida minimal rol:** `mezon_auth_owner WITH NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS`.
- **Huquqlar va RLS:**
  - `GRANT USAGE ON SCHEMA public TO mezon_auth_owner;`
  - `REVOKE ALL ON TABLE cloud_login_identities FROM mezon_auth_owner;`
  - `GRANT SELECT ON TABLE cloud_login_identities, cloud_users, cloud_organizations TO mezon_auth_owner;`
  - `cloud_users` va `cloud_organizations` jadvallarida `mezon_auth_owner` uchun alohida `AS PERMISSIVE FOR SELECT ... USING (true)` RLS siyosatlari belgilandi (`cloud_users_auth_lookup`, `cloud_organizations_auth_lookup`).
- **Funksiya xavfsizligi:**
  - `SET search_path = pg_catalog, public`.
  - Funksiya ichida barcha jadvallar to'liq malakalandi: `public.cloud_login_identities`, `public.cloud_users`, `public.cloud_organizations`.
  - `ALTER FUNCTION auth_lookup_login(text) OWNER TO mezon_auth_owner;`
  - `REVOKE ALL ON FUNCTION auth_lookup_login(text) FROM PUBLIC;`
  - `GRANT EXECUTE ON FUNCTION auth_lookup_login(text) TO mezon_app;`
- **Dalillar:**
  - `packages/db-cloud/src/pg-tenant.test.ts`:
    - Funksiya egasi `mezon_auth_owner` ekani va `rolsuper === false` (superuser emasligi) `pg_proc` va `pg_roles` orqali tekshirildi.
    - `has_function_privilege('public', 'auth_lookup_login(text)', 'EXECUTE') === false` ekani assert qilindi.
    - `mezon_app` to'g'ridan-to'g'ri `cloud_login_identities` ni o'qiy olmasligi (`42501`) tekshirildi.

---

### 1.3. S3: Login normallashtirish va unikal indeks
- **Yagona normallashtirish funksiyasi (`normalizeCloudLogin`):**
  - `@mezon/domain/src/auth.ts` da joylashtirildi, `@mezon/domain` va `@mezon/contracts` dan eksport qilindi.
  - Barcha probellarni qirqadi (`trim`), kichik harfga keltiradi (`toLowerCase`), va O'zbekiston telefon raqamlarini (`901234567`, `998901234567`, `+998 (90) 123-45-67`) standart `+998XXXXXXXXX` ko'rinishiga keltiradi.
- **Sxema va unikal indeks:**
  - `packages/db-cloud/drizzle/0001_cloud_foundation.sql`:
    - `CREATE UNIQUE INDEX "uidx_cloud_login_identities_norm_login" ON "cloud_login_identities" USING btree (lower(trim("login")));`
    - `ALTER TABLE "cloud_login_identities" ADD CONSTRAINT "chk_cloud_login_identities_normalized" CHECK ("login" = lower(trim("login")));`
- **Qo'llanish joylari:**
  - `CloudLoginRequestSchema` z.transform orqali kiruvchi loginni avtomatik normallashtiradi.
  - `tenantStore.createOrganizationWithStoreAndOwner` va `create-org` CLI egasining loginini normallashtirib yozadi.
  - `authStore.lookupLogin` normallashtirilgan login bo'yicha qidiradi.
- **Dalillar:**
  - `packages/contracts/src/cloud-auth.test.ts`: email, telefon va loginlar normallashtirilishi testlandi.
  - `packages/db-cloud/src/pg-tenant.test.ts`:
    - `OWNER_A@GUZAR.UZ` dublikatini kiritishga urinish `23505` (unique_violation) bilan rad etildi.
    - `auth_lookup_login` katta-kichik harfli qidiruvda (`OWNER_A@GUZAR.UZ`, `owner_a@guzar.uz`) har doim aynan bitta natija qaytarishi testlandi.
  - `apps/cloud/src/server.test.ts`: HTTP `/api/v1/auth/login` orqali `  OWNER_A@GUZAR.UZ  ` bilan muvaffaqiyatli login qilish testlandi.

---

## 2. O'zgargan fayllar

- `packages/domain/src/auth.ts`, `index.ts` — `normalizeCloudLogin` funksiyasi qo'shildi va eksport qilindi.
- `packages/contracts/src/cloud-auth.ts`, `cloud-auth.test.ts`, `index.ts` — `normalizeCloudLogin` integratsiyasi va testlari.
- `packages/db-cloud/src/connection.ts`, `index.ts` — `assertNonSuperuserNonBypassRls` qo'shildi va eksport qilindi.
- `packages/db-cloud/drizzle/0001_cloud_foundation.sql` — `mezon_auth_owner` roli, RLS siyosatlari, funksiya egasi, `lower(trim(login))` unikal indeksi va CHECK cheklovi.
- `packages/db-cloud/ops/provision-app-role.mjs` — `mezon_auth_owner` ga ortiqcha aralashish olib tashlandi.
- `packages/db-cloud/src/auth-store.ts`, `tenant-store.ts` — login normallashtirish integratsiyasi.
- `packages/db-cloud/src/pg-tenant.test.ts` — S1, S2, S3 qabul mezonlari testlari.
- `apps/cloud/src/config.ts` — `DATABASE_ADMIN_URL` parametri qo'shildi.
- `apps/cloud/src/index.ts` — migratsiyani `databaseAdminUrl` orqali, serverni `databaseUrl` orqali ishga tushirish.
- `apps/cloud/src/server.ts` — `buildCloudServer` da `assertNonSuperuserNonBypassRls` o'zini tekshirish chaqiruvi.
- `apps/cloud/src/cli/create-org.ts`, `create-org.test.ts` — `databaseAdminUrl` orqali provisioning.
- `apps/cloud/src/server.test.ts` — superuser rad etilishi testi va case-insensitive HTTP login testi.
- `deploy/docker-compose.yml`, `.env.example`, `deploy/init-db/01-init-roles.sh` — runtime va admin URL lari ajratildi, rol provisioning skripti qo'shildi.

---

## 3. Qabul mezonlari

- [x] **S1: Ikki alohida ulanish va superuser rad etilishi:** `DATABASE_ADMIN_URL` va `DATABASE_URL` ajratildi. Superuser ulanishida `buildCloudServer` rad etadi (`apps/cloud/src/server.test.ts`).
- [x] **S1: mezon_app paroli:** `.env` dan olinadi, repoda hech qanday maxfiy parol yo'q.
- [x] **S2: `auth_lookup_login` xavfsizligi:** Egasi `mezon_auth_owner` (`rolsuper = false`), `PUBLIC` da `EXECUTE` yo'q, `search_path` xavfsiz (`pg_catalog, public`) (`packages/db-cloud/src/pg-tenant.test.ts`).
- [x] **S3: Login normallashtirish:** Katta-kichik harfli dublikat `23505` bilan rad etiladi. Funksiya hech qachon birdan ortiq qator qaytarmaydi (`pg-tenant.test.ts`, `cloud-auth.test.ts`, `server.test.ts`).
- [x] **pnpm verify:** Barcha 17 paket build va typecheck, lint (0 xato), db:check (0 diff), depcruise (0 violation) va 349 ta test yashil.
- [x] **Docker smoke test:** `docker build -f deploy/Dockerfile -t mezon-cloud:smoke .` muvaffaqiyatli yig'ildi.

---

## 4. Test natijalari

### a) `pnpm verify` to'liq chiqishi:
```text
$ prettier --check .
All matched files use Prettier code style!

$ turbo run build
Tasks: 17 successful, 17 total

$ node scripts/lint-workspaces.mjs
(0 errors, 0 warnings)

$ turbo run typecheck
Tasks: 26 successful, 26 total

$ turbo run db:check
PostgreSQL schema matches committed migrations (0 diff statements).
SQLite schema matches committed migrations (0 diff statements).

$ vitest run --project unit --project sqlite-hub
Test Files: 73 passed (73)
Tests: 349 passed (349)

$ vitest run --project perf
Test Files: 9 passed (9)
Tests: 12 passed (12)

$ pnpm --filter @mezon/pos test:e2e
1 passed (13.2s)

$ depcruise --config .dependency-cruiser.cjs apps/*/src packages/*/src
✔ no dependency violations found (390 modules, 1651 dependencies cruised)
```

### b) Docker smoke image:
```text
naming to docker.io/library/mezon-cloud:smoke done
unpacking to docker.io/library/mezon-cloud:smoke done
```
