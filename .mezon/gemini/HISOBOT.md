# Hisobot: T2.7a — Biznes Kabineti (Read-Only API, Dashboard, Cheklar, Mijozlar, Hisobot va Web UI)

**Branch:** `gemini/T2.7-cabinet`  
**Commit:** `607f9b5`  
**Bajaruvchi:** Gemini  
**Tekshiruvchi:** Claude  
**Asosiy manba:** `GEMINI.md` (T2.7), `.mezon/claude/TOPSHIRIQ.md` (A1–A7 talablari)

---

### Nima qilindi (A1–A7 talablari to'liq bajarildi)

1. **A1. Report parity oracle testi (`apps/cloud/src/report-parity.test.ts`):**
   - SQLite Hub muhitida mahsulotlar (12% QQS va 0% QQS), kirim (cost_value), smena, savdolar (naqd, karta) va qisman qaytarish (refund) yaratildi.
   - Barcha hodisalar F2 `syncPushStore.processSyncPushBatch` orqali PostgreSQL Cloud bazasiga push qilindi.
   - Hub `SqliteReportStore.getDailySalesReport` natijasi bilan Cloud `AdminReadStore.getDailySalesReport` natijasi solishtirildi:
     - `totalSalesCount`, `totalReturnsCount`
     - `totalGrossSales`, `totalReturns`, `totalNetSales`
     - `totalVat`, `totalCashSales`, `totalNonCashSales`
     - `totalCostValue`, `totalGrossProfit`
     - Har bir kun kesimidagi barcha satrlar
     tiyin-tiyingacha 100% teng chiqishi isbotlandi (`apps/cloud/src/report-parity.test.ts` PASSED).

2. **A2. Do'kon freshness va tushum ko'rsatkichlari (`AdminReadStore` & `GET /api/v1/admin/dashboard`):**
   - `getStoreFreshness`: Har bir faol do'kon bo'yicha `MAX(received_at_ms)` hisoblanadi. Agar oxirgi hodisadan beri > 10 daqiqa o'tgan bo'lsa, `isStale: true` belgilanadi.
   - `getDashboard`: Bugungi sof savdo, yalpi savdo, qaytarishlar, cheklar soni, o'rtacha chek, yalpi foyda va marja (bp). Bekor qilingan (`voided_at_ms IS NOT NULL`) cheklar avtomatik chiqarib tashlanadi.

3. **A3. Cookie va CSRF himoyasi (`/api/v1/admin/auth/*`):**
   - `mezon_admin_refresh` HttpOnly cookie: `Path=/api/v1/admin/auth`, `SameSite=Strict` bilan o'rnatiladi. XSS token o'g'irlay olmaydi.
   - `POST /api/v1/admin/auth/refresh`: `X-Mezon-Admin: 1` sarlavhasini qat'iy talab qiladi va `Origin` oq ro'yxat bo'yicha tekshiriladi.
   - Token oilasi rotatsiyasi va o'g'irlangan token takror ishlatilganda oilani bekor qilish (`revocation`) to'liq ishlaydi.

4. **A4. RBAC va Kassir rollari taqiqi:**
   - `CloudJwtPayload` cashier rollarini qamrab oladi, lekin `requireAdminAuth` hook barcha `/api/v1/admin/*` endpointlariga kelgan cashier tokenlarini `403 Forbidden` bilan bloklaydi.
   - `POST /api/v1/admin/auth/login` da ham kassir hisoblari `403 Forbidden` bilan rad etiladi.

5. **A5. Keyset pagination (`GET /api/v1/admin/receipts` & `GET /api/v1/admin/customers`):**
   - `(created_at_ms, id) < (cursorMs, cursorId)` indeksi asosida bo'shliqsiz keyset sahifalash amalga oshirildi. `nextCursor` keyingi sahifa uchun qaytariladi.

6. **A6. Telefon raqamlari maskirovkasi:**
   - Ro'yxat ko'rinishida (`GET /api/v1/admin/customers`): `maskPhoneNumber` orqali `+998 90 *** ** 12` formatida shaxsiy ma'lumot himoyalangan.
   - Tafsilot ko'rinishida (`GET /api/v1/admin/customers/:id`): biznes egasi uchun to'liq raqam qaytariladi.

7. **A7. Biznes Kabineti Web UI (`apps/admin`):**
   - React 19 + Vite + Tailwind + Zustand bilan to'liq ishchi web ilovasi yaratildi:
     - `LoginView`: Login/parol, xatolar (403 kassir taqiqi, 429 bloklanish).
     - `Navbar`: Tablar, sessiya va Logout.
     - `DashboardView`: Bugungi tushumlar, foydani ko'rsatish/yashirish, do'konlar freshness statusi (stale indicator).
     - `ReceiptsView`: Cheklar jadvali, filtrlash, keyset "Yana yuklash", to'liq chek tarkibi va to'lovlari modali.
     - `CustomersView`: Qidiruv, maskalangan telefonlar, qarz balansi, detail modal.
     - `DailyReportView`: Sana oralig'i, kunlik hisobot jadvali va jami yig'indilari.
     - `api-client`: Avtomatik CSRF sarlavhasi (`X-Mezon-Admin: 1`), 401 bo'lganda avtomatik refresh.
     - `apps/admin/src/api-client.test.ts`: 4 ta unit test 100% yashil.

---

### O'zgargan va yangi fayllar

- `packages/contracts/src/admin.ts`: Admin kabineti API, dashboard, cheklar, mijozlar va hisobot Zod kontraktlari, `maskPhoneNumber` yordamchisi.
- `packages/contracts/src/admin.test.ts`: Kontraktlar va telefon maskalash testlari.
- `packages/db-cloud/src/admin-store.ts`: `AdminReadStore` (RLS konteksti, store freshness, dashboard, keyset cheklar va mijozlar, kunlik savdo hisoboti).
- `packages/db-cloud/src/admin-store.test.ts`: PostgreSQL Testcontainers bilan 5 ta integratsiya testi.
- `apps/cloud/src/jwt.ts`: Cashier rollarini ham dekodlash va tekshirish qo'llab-quvvatlandi.
- `apps/cloud/src/server.ts`: Admin kabineti yo'nalishlarini ro'yxatdan o'tkazish.
- `apps/cloud/src/admin-routes.ts`: Fastify admin marshrutlari (login, refresh, logout, dashboard, receipts, customers, reports).
- `apps/cloud/src/admin-routes.test.ts`: 13 ta integratsiya testi (cookie, CSRF, RBAC 403, keyset, masking).
- `apps/cloud/src/report-parity.test.ts`: A1 oracle testi — Hub (SQLite) va Cloud (PostgreSQL) savdo hisoboti tiyin-tiyingacha tengligi.
- `apps/cloud/package.json`: `@mezon/db-local` test devDependency sifatida qo'shildi.
- `apps/admin/package.json`, `vite.config.ts`, `tsconfig.json`, `tsconfig.test.json`, `index.html`: React 19 + Vite web ilovasi konfiguratsiyasi.
- `apps/admin/src/*`: Web kabinet komponentlari, holat boshqaruvi va API mijozi.

---

### Qabul mezonlari

- [x] A1: Hub va Cloud `DailySalesReport` o'rtasida hisob pariteti testi (`report-parity.test.ts`) tiyin-tiyingacha teng chiqadi.
- [x] A2: `getStoreFreshness` va dashboard metrikalari (bekor qilingan cheklarsiz, do'konlar stale indikatori bilan) to'liq ishlaydi.
- [x] A3: Refresh token `mezon_admin_refresh` HttpOnly cookie'da (`SameSite=Strict`, `Path=/api/v1/admin/auth`), refresh endpointda `X-Mezon-Admin: 1` va `Origin` tekshiruvi bor.
- [x] A4: Kassir hisoblari admin kabinetiga (login va barcha `/api/v1/admin/*` endpointlarga) kirishi 403 bilan taqiqlanadi.
- [x] A5: Cheklar va mijozlar ro'yxatida `(created_at_ms, id)` keyset pagination to'g'ri ishlaydi.
- [x] A6: Mijozlar ro'yxatida telefon raqami maskalangan (`+998 90 *** ** 12`), tafsilotda egasi uchun to'liq ko'rinadi.
- [x] A7: `apps/admin` ichida React 19 + Vite web UI yaratildi, yig'ildi (`vite build`) va API mijozi testlandi.
- [x] Barcha hisoblar `bigint` tiyinda, `depcruise`, `pnpm typecheck` va `pnpm lint` 100% yashil.

---

### Test natijalari

1. **Admin va report parity integratsiya testlari (PostgreSQL Testcontainers):**
   ```
   $env:MEZON_REQUIRE_PG_TESTS="1"; pnpm vitest run packages/db-cloud/src/admin-store.test.ts apps/cloud/src/admin-routes.test.ts apps/cloud/src/report-parity.test.ts
   
   ✓ unit packages/db-cloud/src/admin-store.test.ts (5 tests)
   ✓ unit apps/cloud/src/report-parity.test.ts (1 test)
   ✓ unit apps/cloud/src/admin-routes.test.ts (13 tests)

   Test Files  3 passed (3)
        Tests  19 passed (19)
   ```

2. **Web UI va Kontraktlar unit testlari:**
   ```
   pnpm vitest run apps/admin/src/api-client.test.ts packages/contracts/src/admin.test.ts

   ✓ unit apps/admin/src/api-client.test.ts (4 tests)
   ✓ unit packages/contracts/src/admin.test.ts (3 tests)

   Test Files  2 passed (2)
        Tests  7 passed (7)
   ```

3. **Typecheck va Build:**
   ```
   pnpm typecheck -> 27 successful, 27 total (0 errors)
   pnpm --filter @mezon/admin build -> vite build muvaffaqiyatli yakunlandi
   ```

4. **Lint va monorepo import chegaralari:**
   ```
   pnpm lint -> 0 errors, exit code 0
   pnpm run depcruise -> no dependency violations found (457 modules cruised)
   ```

---

### Qilingan taxminlar
- T2.7b (yozish amallari: tovar narxini o'zgartirish, yangi xodim qo'shish) Claude ko'rsatmasi (`c30a1af`) bo'yicha keyingi bosqichga qoldirildi; hozirgi T2.7a faqat read-only va monitoring qismini qamrab oladi.
- Z1 (T2.4) migratsiya koordinatsiyasi bo'yicha PR #25 hali `origin/main` ga kirmaganligi sababli, `gemini/T2.4-sync-pull` o'zgarishsiz turibdi. PR #25 birlashishi bilan Z1 zudlik bilan bajariladi.

---

### Keyingi qadamlar
- Claude tekshiruvi va xulosasi (`QABUL`).
- PR #25 birlashishi bilanoq `gemini/T2.4-sync-pull` ga o'tib, Z1 (0018_sync_pull migratsiyasi) ni yakunlash.
