## T0.6 Merge xulosasi

- **PR #6** (`gemini/T0.6-hub-auth`, bosh SHA `2430c48b4a56e6282093cbe57cdd687e688af871`, barcha 6 CI check run `success` — Run [#42806545966](https://github.com/Shaxobiddin-Github/Mezon/actions/runs/42806545966) va [#42806539992](https://github.com/Shaxobiddin-Github/Mezon/actions/runs/42806539992)) `T0.6: Hub skeleti va autentifikatsiya` nomi bilan Squash and merge qilindi.
- **Merge commit SHA (`main`):** `759f3ee073da8a75fbd32808c67243b50a802b4b`
- **`gemini/T0.6-hub-auth` branch:** masofadan va lokaldan o'chirildi.
- **Yangi branch (`main` @ `759f3ee` dan):** `gemini/T0.7-electron-shell`

---

## Reja: T0.7 — Electron qobig'i (hamda T0.6 test qarzi)

> **Eslatma:** Bu bosqichda faqat reja berilmoqda; Claude tasdig'isiz kod yozilmaydi.

### 0. T0.6 test qarzi (PR #7 ichida birinchi alohida commit)

- **Commit:** `T0.6 test qarzi: R1 failed_attempts tekshiruvi`
- **Muammo:** `auth-repo.ts` dagi TOCTOU himoyasi o'chirilganda `failed_attempts = 0n` assertion'i ham uni ushlay olishi shart (mutatsiya bilan tasdiqlangan holatda: erta `if` guard olib tashlansa `R1` testi haqiqatan yiqilishi kerak). T0.7 kodidan oldin alohida commitda test tuzatiladi va `auth-repo.ts` mutatsiyasi orqali test haqiqatan `failed_attempts` o'sishini ham, sessiya ochilishini ham ushlashi isbotlanadi.

---

### 1. Versiyalar va doira (`GEMINI.md` 2.1 va `g` bandi)

- **Paket versiyalari (npm'da tasdiqlangan, `pnpm-lock.yaml` bilan mahkamlanadi):**
  - `electron`: `45.2.3` (`GEMINI.md`: Electron 45)
  - `electron-builder`: `26.18.0` (`GEMINI.md`: electron-builder 26)
  - `@electron/fuses`: `2.1.3`
  - `@electron/rebuild`: `4.2.1`
  - `playwright` & `@playwright/test`: `1.65.0` (`GEMINI.md`: Playwright 1.65)
  - `react` & `react-dom`: `19.3.1` (`@types/react`: `19.3.0`, `@types/react-dom`: `19.3.0`; `GEMINI.md`: React 19)
  - `vite`: `8.3.7`, `@vitejs/plugin-react`: `6.3.0` (`GEMINI.md`: Vite 8)
  - `koffi`: `3.3.7` (Electron 45 ABI/yuklash tekshiruvi uchun; printer drayveri o'zi `T1.12`da)
- **GEMINI.md 2.1 "Muhim tekshiruvlar":** Electron 45 ichidagi Node major/ABI versiyasi hamda `better-sqlite3`, `@node-rs/argon2` va `koffi` Electron 45 bilan yig'ilishi/yuklanishi amalga oshirishda o'lchanib hisobotga yoziladi.
- **Doiradan tashqari (`g`):**
  - **Code signing:** Egasi qarori (keyinroq); hozir imzosiz yig'iladi va qo'lda o'rnatishda Windows SmartScreen ogohlantirishi kutiladi.
  - **Avtomatik yangilanish (`electron-updater`):** `T4.8` da.
  - **Kassa UI:** `T1.11` da.

---

### 2. Rejalashtirilgan arxitektura va fayllar (`a`–`e`)

#### a) Jarayonlar arxitekturasi (`utilityProcess` vs `main`)

- **Tanlov:** Hub alohida **`Electron.utilityProcess`** (`apps/desktop/src/hub-worker.ts`) ichida ishlaydi (`main` jarayoni ichida emas).
- **Asos:**
  1. Hub (Fastify, SQLite, Argon2id) ichida kutilmagan xato yoki crash bo'lsa **UI va `main` jarayoni qulamaydi**; `main` `exit` hodisasini tutib fayl logga yozadi va cheklangan backoff (`500 ms -> 1 s -> 2 s -> max 5 s`) bilan Hub'ni avtomatik qayta ko'taradi.
  2. SQLite WAL/Argon2id CPU ishi Electron `main` GUI/IPC siklini to'smaydi (4 GB RAM monoblokda silliq UI).
- **Port va `hubBaseUrl`:**
  - Hub `utilityProcess` ichida `{ host: '127.0.0.1', port: 0, allowedOrigins: ['app://mezon'] }` bilan tinglaydi (OS bo'sh tasodifiy port beradi).
  - Hub tayyor bo'lgach parent port orqali `main`ga `{ type: 'ready', baseUrl: 'http://127.0.0.1:<port>' }` uzatadi.
  - Renderer `hubBaseUrl` ni faqat preload'dagi tor IPC (`mezonBridge.getHubBaseUrl()`) orqali oladi va Hub `/health` ga `fetch` yuboradi.
  - `before-quit` da `main` Hub worker'ga `shutdown` yuborib DB toza yopilishini kutadi (va timeoutdan keyin `.kill()`).

#### b) Electron xavfsizligi (`app://mezon`, Fuses, CSP, Preload)

- **`app://mezon` maxsus protokoli (`file://` va `null` taqiq):**
  - `app.whenReady()` dan oldin `protocol.registerSchemesAsPrivileged([{ scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, bypassCSP: false } }])`.
  - `protocol.handle('app', ...)`: faqat `host === 'mezon'` qabul qilinadi, path traversal (`..`) rad etiladi va **faqat `app.asar` ichidagi** `@mezon/pos` UI dist fayllari beriladi.
  - Hub `allowedOrigins: ['app://mezon']` qilib sozlanadi.
- **`BrowserWindow` `webPreferences`:** `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`, `nodeIntegrationInWorker: false`, `nodeIntegrationInSubFrames: false`, `webSecurity: true`, `allowRunningInsecureContent: false`, `webviewTag: false`.
- **Preload (`apps/desktop/src/preload.ts`):** `contextBridge.exposeInMainWorld('mezonBridge', { getHubBaseUrl, getHubRestartCount })` — umumiy `ipcRenderer`, Node API va `fs` umuman ochilmaydi.
- **Qat'iy CSP (`session.defaultSession.webRequest.onHeadersReceived`):**
  `default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src app://mezon http://127.0.0.1:<port>; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'` (faqat aniq hub portiga ruxsat, wildcard yo'q).
- **Navigatsiya va popup blokirovkasi:** `will-navigate` (`app://mezon/` dan tashqari hammasini `preventDefault()`), `setWindowOpenHandler(() => ({ action: 'deny' }))`.
- **Electron Fuses (`@electron/fuses@2.1.3`, `electron-builder` `afterPack` hook orqali):**
  - `RunAsNode: false`
  - `EnableCookieEncryption: true`
  - `EnableNodeOptionsEnvironmentVariable: false`
  - `EnableNodeCliInspectArguments: false`
  - `EnableEmbeddedAsarIntegrityValidation: true`
  - `OnlyLoadAppFromAsar: true`
  - Testda yig'ilgan binary'dan `getCurrentFuseWire` o'qilib ham, `ELECTRON_RUN_AS_NODE=1` sinovi bilan ham tekshiriladi.

#### c) Ma'lumot `%LOCALAPPDATA%\Mezon\`, NSIS, Bir nusxa rejimi va Fayl loglari

- **Katalog yo'li:** Ishga tushishning eng boshida (`requestSingleInstanceLock()`dan oldin) Windows'da `%LOCALAPPDATA%\Mezon\` (Linux/CI da XDG fallback; test izolyatsiyasi uchun `MEZON_DATA_DIR` faqat test muhitida) aniqlanadi va **`app.setPath('userData', dataDir)`** hamda `app.setPath('logs', path.join(dataDir, 'logs'))` ga yo'naltiriladi (standart Roaming emas!).
  - SQLite DB: `<dataDir>\data\mezon.db` (WAL).
  - Loglar: `<dataDir>\logs\mezon-hub.log` (Pino `10.4.0` + `HUB_LOGGER_REDACT_PATHS` redaction) va `mezon-desktop.log`.
- **NSIS (`apps/desktop/electron-builder.yml` / config):**
  - `win.target: ['nsis']`, `nsis: { oneClick: false, perMachine: false, allowElevation: false, allowToChangeInstallationDirectory: true, deleteAppDataOnUninstall: false }` — foydalanuvchi darajasida o'rnatish, admin paroli/UAC so'ramaydi, uninstall paytida `%LOCALAPPDATA%\Mezon\` saqlanadi.
- **Bir nusxa rejimi:** `app.requestSingleInstanceLock()` — `false` bo'lsa darhol `app.quit()` (ikkinchi Hub ochilmaydi); `second-instance` hodisasida asosiy oyna `restore()` + `show()` + `focus()`.

#### d) Native modullar va Node vs Electron ABI izolyatsiyasi

- **Muammo:** `better-sqlite3` V8/NAN ABI ga bog'langan; root `.pnpm` da Electron ABIga qayta yig'ilsa host Node 24 Vitest testlari `ERR_DLOPEN_FAILED` beradi.
- **Yechim (izolyatsiyalangan staging katalogi `apps/desktop/dist-app/`):**
  1. Root `node_modules` hech qachon Electron ABI ga o'zgartirilmaydi -> `pnpm verify` doimo Node 24 ABI da ishlaydi.
  2. `apps/desktop/scripts/prepare-electron-app.mjs` alohida `apps/desktop/dist-app/` (`.gitignore`) ichiga kompilyatsiya qilingan workspace paketlarni (`dist/`, `db-local/drizzle` migratsiya SQLlari, `@mezon/pos/dist`) va kerakli production modullarini (`better-sqlite3`, `@node-rs/argon2`, `koffi`, `fastify`, `pino`, `zod`...) symlinksiz ko'chiradi hamda faqat `dist-app/` ichida **`@electron/rebuild@4.2.1`** bilan Electron `45.2.3` ABI uchun yig'adi.
  3. `electron-builder` `directories.app: 'dist-app'`, `asar: true`, `asarUnpack: ['**/*.node']` bilan `app.asar` va `.node` fayllarini paketlaydi (`afterPack` fuse'larni o'rnatadi).
  4. `db-local/src/migrate.ts` dagi `import.meta.dirname/../drizzle` yondashuvi staging `dist-app` va `app.asar` ichida ham bir xil ishlashi real paketlangan app'da tekshiriladi.

#### e) Minimal UI (`apps/pos`)

- `apps/pos`: React 19 + Vite 8 minimal sahifa (`index.html`, `src/main.tsx`, `src/App.tsx`).
- Preload `window.mezonBridge.getHubBaseUrl()` dan manzilni olib `fetch(`${baseUrl}/health`)` chaqiradi (`Origin: app://mezon`) va ekranda Hub holati (`ok`), `needsSetup`, va xato bo'lsa qayta urinish holatini ko'rsatadi.

#### Depcruise chegaralari (`.dependency-cruiser.cjs`)

- `apps/desktop/src`: faqat `apps/desktop/src`, `packages/(domain|contracts|drivers)`, `electron` va `node:*` (`db-cloud`, `db-local` to'g'ridan-to'g'ri, `apps/pos` importi taqiqlanadi — Hub alohida `utilityProcess` sifatida `dist-app`dan yuklanadi!).
- `apps/pos/src`: faqat `apps/pos/src`, `packages/(contracts|i18n|ui)`, `react`, `react-dom` (Node builtinlar, `electron`, `db-local`, `db-cloud` taqiqlanadi).
- Har ikki qoidaga salbiy `depcruise` dalili keltiriladi.

---

### 3. Testlar va CI (`f` bandi)

1. **Birlik / xavfsizlik testlari:**
   - `T0.6 R1` test qarzi tuzatilib mutatsiya bilan tasdiqlangan test (`auth-repo.ts` + `hub.test.ts`).
   - `apps/desktop`: `resolveDesktopDataDir()` (Windows `LOCALAPPDATA\Mezon`, Roaming emasligi), fuse konfiguratsiyasi va navigatsiya/origin helper testlari.
2. **Playwright (`1.65.0`) `_electron` E2E smoke test (yig'ilgan `app.asar` + fused Electron binary ustida):**
   - Ilova ochiladi, `BrowserWindow` URL `app://mezon/` (hech qanday `file://` yo'q), sahifada Hub `/health` `200` + `needsSetup: true` ko'rinadi.
   - Hub tomoni so'rov `Origin` sarlavhasi aynan `app://mezon` bo'lganini tasdiqlaydi; `<dataDir>/data/mezon.db` va redact qilingan fayl loglari yaratilgan.
   - `ELECTRON_RUN_AS_NODE=1` bilan executable Node sifatida ishga tushmaydi; `window.open` va tashqi `navigate` rad etiladi.
   - Bir nusxa: bir xil `dataDir` bilan 2-nusxa yopiladi, 2-Hub ochilmaydi.
   - Hub crash recovery: `utilityProcess` yiqilganda UI ochiq qoladi va Hub qayta ko'tarilib `/health` yana `200` qaytaradi.
3. **GitHub Actions CI (`.github/workflows/ci.yml`):**
   - `Verify (ubuntu-latest)` va `Verify (windows-latest)`: `pnpm verify` (`T0.7` unit testlar + `depcruise`).
   - Yangi **`desktop` (`Build & E2E Desktop Installer (windows-latest)`)** job: `pnpm --filter @mezon/desktop run pack:win` (staging + `@electron/rebuild` + `electron-builder` NSIS `.exe` + `@electron/fuses`), fuse wire tekshiruvi, Playwright `_electron` smoke testi yig'ilgan `win-unpacked` ustida, hamda `Mezon Setup *.exe` GitHub Actions artifact sifatida yuklanadi.
4. **Egasi uchun toza Windows'da qo'lda tekshiruv ro'yxati (`GEMINI.md` T0.7):**
   1. CI `desktop` artifact'idan NSIS `.exe` o'rnatuvchini yuklab olish.
   2. Oddiy (admin huquqsiz) Windows 10 22H2+ / Windows 11 hisobida o'rnatish (SmartScreen chiqsa `More info -> Run anyway`; UAC admin paroli so'ramasligi shart).
   3. Ilovani ochib, oyna va Hub `/health` ko'ringanini **skrinshot** qilish hamda `%LOCALAPPDATA%\Mezon\data\mezon.db` yaratilganini ko'rish.
   4. Ilovani ikkinchi marta bosganda birinchi oyna oldinga chiqishini tekshirish.
   5. Windows Apps & Features orqali Uninstall qilish va `%LOCALAPPDATA%\Mezon\data\mezon.db` saqlanib qolganini tekshirish.
   6. Qayta o'rnatib ochish va oldingi baza saqlanganini **skrinshot** bilan tasdiqlash.

---

### Egasi yoki Claude qarori kerak bo'lgan savollar

- **Electron 45 + `apps/desktop` utilityProcess bilan Hub ulanishi:** `utilityProcess` kompilyatsiya qilingan `hub-worker.js` orqali `@mezon/hub` ni ishga tushirganda `better-sqlite3`, `@node-rs/argon2` va `koffi` staging `dist-app/node_modules` ichidan yuklanadi — bu `GEMINI.md` 2.1 dagi "Muhim tekshiruvlar"ni ham bir yo'la amalda tasdiqlaydi. Tasdiqlasangiz amalga oshirishni boshlaymiz (`T0.6 test qarzi` commitidan boshlab).
