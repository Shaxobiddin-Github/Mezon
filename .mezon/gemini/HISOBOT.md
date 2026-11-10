## Hisobot: T0.7 (hamda qayta ishlash `R1`, `R2`, T0.6 R1 test qarzi)

Branch / PR: `gemini/T0.7-electron-shell` → [PR #7](https://github.com/Shaxobiddin-Github/Mezon/pull/7)
Commitlar:
1. `2506ecf` — `T0.6 test qarzi: R1 failed_attempts tekshiruvi`
2. `55fb963` — `T0.7: Electron qobig'i, utilityProcess hub, fuse va Windows NSIS o'rnatuvchi`
3. `a148a70` — `T0.7: R1 xato CORS va R2 ruxsat bloki tuzatishlari`
4. `1d61486` — `T0.7: R2 E2E ruxsat tekshiruvini boshsiz CI ga moslash`

---

### Nima qilindi

#### A. Qayta ishlash (`f59dbfb`) tuzatishlari (`a148a70`, `1d61486`)

1. **R1 (YUQORI) — Barcha status kodlari (4xx / 5xx) da `app://mezon` uchun CORS va `Retry-After` eksporti:**
   - `apps/hub/src/security.ts` dagi `onSend` hook'idan `reply.statusCode < 400` cheklovi olib tashlandi: ruxsat ro'yxatidagi `app://` origin uchun barcha javoblarda (2xx, 401, 403, 429, 500) `Access-Control-Allow-Origin: app://mezon`, `Access-Control-Expose-Headers: Retry-After` va `Vary: Origin` qo'shiladi (`OPTIONS` preflight javobida ham `Access-Control-Expose-Headers: Retry-After` beriladi).
   - Ro'yxatda yo'q origin (`https://evil.uz`, `app://evil`, `file://`, `null`) uchun barcha CORS sarlavhalari (jumladan `Access-Control-Allow-Origin`, `Access-Control-Expose-Headers`) olib tashlanadi.
   - `apps/hub/src/hub.test.ts` (`inject`): `app://mezon` bilan `401` (`/auth/me`, `/auth/login`), `403` (kassir `/users`), `429` (`Retry-After >= 1` bilan haqiqiy 5 xato urinish lockout'i) va `500` (`/__test-boom`) da CORS sarlavhalari mavjudligi; `app://evil`, `file://` va `https://evil.uz` da esa 403 va 500 yo'lida ham umuman yo'qligi tekshirildi.
   - `apps/desktop/e2e/desktop.spec.ts`: renderer (`page.evaluate`) ichidan `POST /auth/login` noto'g'ri PIN da `status === 401`, `error.code === 'AUTH_INVALID_CREDENTIALS'` hamda qayta tiklanishdan keyingi setup + 5 noto'g'ri urinishda `status === 429`, `error.code === 'AUTH_RATE_LIMITED'` va `headers.get('retry-after') >= 1` ni o'qiy olishi tasdiqlandi.

2. **R2 (O'RTA) — Electron ruxsat so'rovlarini standart ravishda rad etish:**
   - `apps/desktop/src/main.ts` (`registerSessionPermissionHandlers`, `app.whenReady()` ichida):
     - `session.defaultSession.setPermissionRequestHandler((_, permission, cb) => { ... cb(false); })`
     - `session.defaultSession.setPermissionCheckHandler(() => false)`
     - `session.defaultSession.setDevicePermissionHandler(() => false)`
   - `apps/desktop/e2e/desktop.spec.ts`: renderer ichida `Notification.requestPermission()` → `'denied'`, `navigator.permissions.query` (`geolocation`, `camera`) → `'denied'`, `navigator.geolocation.getCurrentPosition` → `code = 1` (`PERMISSION_DENIED`), `navigator.mediaDevices.getUserMedia({ video: true })` → rad etiladi (`NotAllowedError` lokal kamerada / `NotFoundError` boshsiz CI VM da, `mediaGranted === false`). Shu paytda `fetch('http://127.0.0.1:<port>/...')` odatdagidek ishlaydi.

3. **README.md eslatma:**
   - Windows da `makensis` 260 belgilik yo'l (`MAX_PATH`) chegarasi sabab repozitoriyani qisqa yo'lda (masalan `D:\mezon`) saqlash haqidagi eslatma qo'shildi.

#### B. Avvalgi T0.7 hamda T0.6 R1 ishlari (`2506ecf`, `55fb963`)

- **T0.6 R1 test qarzi (`2506ecf`):** `packages/db-local/src/auth.test.ts` va `apps/hub/src/hub.test.ts` ga `failed_attempts = 0n` va `local_device_auth_state` tekshiruvlari qo'shildi; mutatsiyalar (`Exit code 1`) bilan tasdiqlandi.
- **Jarayonlar, xavfsizlik, T1–T5 (`55fb963`):** `Electron.utilityProcess.fork` orqali `@mezon/hub` (`electron-worker-entry.mts`), avvalgi portni qayta ishlatish va `EADDRINUSE` fallback + CSP/reload (`T1`), `app://mezon` + strict CSP + sandbox preload + `@electron/fuses` (`T2`), `before-quit` + `query-session-end`/`session-end` + `powerMonitor.shutdown` + WAL `synchronous=FULL` (`T3`), aylanuvchi loglar + Pino redaction (`T4`), `MEZON_DATA_DIR` faqat `!isPackaged && MEZON_E2E=1` (`T5`).
- **GEMINI.md 2.1 o'lchovlari:** Host Node `v24.21.0` (`modules: "137"`); Electron `45.2.3` ichidagi Node `24.22.2` (`modules: "150"`, Chrome `156.0.8078.80`). `better-sqlite3@13.0.3` (`prebuilds/win32-x64.node`), `@node-rs/argon2@2.2.2` va `koffi@3.3.7` N-API orqali Electron 45 da yuklandi (`verify-electron-abi.mjs`: `sqliteCheck: true`, `argon2Check: true`, `koffiLoaded: true`).

---

### O'zgargan fayllar

- `apps/hub/src/security.ts` — `onSend` da `app://` uchun barcha status kodlarida CORS va `Access-Control-Expose-Headers: Retry-After`
- `apps/hub/src/hub.test.ts` — `401`, `403`, `429` (`Retry-After`), `500` va unallowlisted origin testlari
- `apps/desktop/src/main.ts` — `setPermissionRequestHandler`, `setPermissionCheckHandler`, `setDevicePermissionHandler`
- `apps/desktop/e2e/desktop.spec.ts` — R1 (renderer `401`/`429`+`Retry-After`) va R2 (Notification/geo/camera/getUserMedia rad etilishi) E2E tekshiruvlari
- `README.md` — Windows `D:\mezon` qisqa yo'l eslatmasi
- (Hamda `55fb963` va `2506ecf` dagi barcha T0.7 / R1 fayllari avvalgidek)

---

### Migratsiyalar

Yo'q (`db:check` = 0 diff).

---

### Qaysi test qaysi binary ustida ishladi (`T2`)

1. **Yakuniy fuse qo'yilgan binary (`apps/desktop/dist-electron/win-unpacked/Mezon.exe`):**
   - `verify-packaged-desktop.mjs`: `getCurrentFuseWire` (`0=48, 1=49, 2=48, 3=48, 4=49, 5=49, 6=48, 7=48, 8=49`), `ELECTRON_RUN_AS_NODE=1` bloki, `--inspect` bloki, va Playwright'siz smoke launch (Port `61747`, `%LOCALAPPDATA%\Mezon\data\mezon.db`, `T5` decoy e'tiborsiz, 2-nusxa bloki).
2. **Fuse qo'yilmagan Electron binary (`node_modules/electron/dist/electron.exe`) + aynan o'sha `dist-electron/win-unpacked/resources/app.asar`:**
   - `apps/desktop/e2e/desktop.spec.ts`: `app://mezon/`, `/health` `200`, R1 (`401 AUTH_INVALID_CREDENTIALS` + `429` `Retry-After`), R2 (Notification/geolocation/camera/`getUserMedia`), CSP, preload/sandbox, `window.open`/`will-navigate`, bir nusxa, `T1` hub crash recovery (bir xil port + band portda yangi port/reload).

---

### Qabul mezonlari

- [x] `T0.6 R1` test qarzi (`2506ecf`) — mutatsiya bilan tasdiqlangan
- [x] `R1` xato javoblarida (`401`, `403`, `429 Retry-After`, `500`) `app://mezon` CORS + E2E — `hub.test.ts` & `desktop.spec.ts`
- [x] `R2` Electron permission handlerlari (`request`, `check`, `device`) + E2E — `main.ts` & `desktop.spec.ts`
- [x] `T1`–`T5`, `pack:win`, `verify:abi`, `verify:fuses`, `test:e2e`, `depcruise` (va salbiy dalillar)
- [x] To'rtala CI job (`1d61486`) yashil + NSIS `.exe` artifact (`mezon-desktop-win-x64-nsis`, `124,243,305` bayt)
- [ ] Toza Windows'da qo'lda o'rnatish, uninstall va qayta o'rnatish skrinshot bilan — **Egasi bajaradi**

---

### Test natijasi

1. **`pnpm verify` (`1d61486` da):**
   - `prettier --check .`, `turbo run build` (17/17), `eslint .` (0 xato), `turbo run typecheck` (19/19), `turbo run db:check` (0 diff)
   - `vitest run`: `21 passed | 1 skipped (22)`, `118 passed | 2 skipped (120)` (`pg-rls.test.ts` Ubuntu CI da `MEZON_REQUIRE_PG=1` bilan to'liq o'tgan)
   - `depcruise`: `✔ no dependency violations found (169 modules, 413 dependencies cruised)`
2. **Packaged & E2E (`1d61486` / `a148a70`):**
   - `pack:win`: `Mezon-Setup-0.1.0-x64.exe` (`125,212,680` bayt)
   - `verify:abi`: `electron 45.2.3`, `node 24.22.2`, `modules 150`, `sqliteCheck: true`, `argon2Check: true`, `koffiLoaded: true`
   - `verify:fuses`: barcha fuse + `ELECTRON_RUN_AS_NODE=1` + `--inspect` + smoke launch o'tdi
   - `test:e2e`: `1 passed` (`5.1s` / `7.5s`)
3. **GitHub Actions CI (`1d61486`):**
   - Pull Request run [#42818650884](https://github.com/Shaxobiddin-Github/Mezon/actions/runs/42818650884): `Verify (ubuntu-latest)` (`success`), `Verify (windows-latest)` (`success`), `Verify PostgreSQL RLS (ubuntu-latest)` (`success`), `Build & E2E Desktop Installer (windows-latest)` (`success`), artifact: **`mezon-desktop-win-x64-nsis`** (`124,243,305` bayt).
   - Push run [#42818642737](https://github.com/Shaxobiddin-Github/Mezon/actions/runs/42818642737): barcha 4 job `success`.

---

### Tekshirilmagan narsalar

- Toza Windows'da qo'lda o'rnatuvchi + Uninstall + Qayta o'rnatish skrinshotlari (Egasi bajaradi).
- Haqiqiy OS reboot / `WM_QUERYENDSESSION`.
- Code signing (doiradan tashqari; SmartScreen ogohlantirishi kutiladi).

---

### Qilingan taxminlar

- Uch nativ modul (`better-sqlite3@13.0.3`, `@node-rs/argon2@2.2.2`, `koffi@3.3.7`) N-API prebuilts orqali ishlaydi; boshsiz CI VM da jismoniy veb-kamera bo'lmagani uchun `getUserMedia` `NotFoundError` qaytarishi mumkinligi `permissions.query` va `Notification`/`geolocation` bilan birga qoplandi.

---

### Takliflar

- Keyingi bosqichda haqiqiy `.ico` ilova ikonkasini qo'shgach `signExecutable: false` ga o'tish mumkin.

---

### Egasi yoki Claude qarori kerak bo'lgan savollar

- PR #7 (`1d61486`) va yangi hisobot commitidan keyin CI natijasi asosida `QABUL` qarori kutilmoqda; toza Windows qo'lda tekshiruvi Egasi tomonidan `mezon-desktop-win-x64-nsis` artifact orqali bajarilishi mumkin.
