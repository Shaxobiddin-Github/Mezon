## Hisobot: T0.7 (hamda T0.6 R1 test qarzi)

Branch / PR: `gemini/T0.7-electron-shell` → [PR #7](https://github.com/Shaxobiddin-Github/Mezon/pull/7)
Commitlar:
1. `2506ecf` — `T0.6 test qarzi: R1 failed_attempts tekshiruvi`
2. `55fb963` — `T0.7: Electron qobig'i, utilityProcess hub, fuse va Windows NSIS o'rnatuvchi`

---

### Nima qilindi

1. **T0.6 test qarzi (`2506ecf`):**
   - `packages/db-local/src/auth.test.ts` ga PIN parvoz paytida aylanganda `commitLoginOutcome` sessiya ochmasligi va `failed_attempts` (ham `local_pin_credentials`, ham `local_device_auth_state`) ni oshirmasligini to'g'ridan-to'g'ri tekshiruvchi test qo'shildi.
   - `apps/hub/src/hub.test.ts` dagi R1 testiga `local_device_auth_state WHERE failed_attempts > 0` ning `0n` ekani tekshiruvi qo'shildi.
   - Mutatsiya bilan tasdiqlandi (`auth-repo.ts` dagi erta `if` guard olib tashlanganda): rebuild'siz `packages/db-local/src/auth.test.ts` `Exit code 1` (`localDeviceAuthState` bo'sh emas: `got 1`), rebuild bilan `apps/hub/src/hub.test.ts` `Exit code 1` (`expected 1n to be 0n` on `rawCred?.failed_attempts`).

2. **T0.7 Electron qobig'i va xavfsizlik (`55fb963`):**
   - **Jarayonlar arxitekturasi (`utilityProcess` + `T1`):** `@mezon/hub` worker sifatida (`apps/hub/src/electron-worker-entry.mts` → `dist/electron-worker-entry.mjs`) `Electron.utilityProcess.fork(..., { stdio: 'pipe' })` ichida ishlaydi. `HubSupervisor` (`apps/desktop/src/hub-supervisor.ts`) qulashdan keyin backoff (`500 ms -> 1000 ms -> 2000 ms -> 5000 ms`) bilan avvalgi portni qayta ishlatishga urinadi; `EADDRINUSE` bo'lsa `electron-worker.ts` qisman serverni yopib `port: 0` ga o'tadi, `main.ts` esa yangi port bo'yicha CSP `connect-src` ni yangilab `mezon:hub-state` IPC hodisasi yuboradi va `reloadIgnoringCache()` orqali oynani qayta yuklaydi.
   - **Electron xavfsizligi (`app://mezon`, CSP, Preload, Fuses):**
     - `app://mezon` `standard` + `secure` custom protokoli (`file://` va `null` yo'q), raw va dekodlangan dot-segment (`..`, `%2e%2e`, `\0`, `\`) traversal himoyasi (`resolveAppProtocolFilePath`).
     - Hub (`apps/hub/src/config.ts`, `security.ts`) `app://mezon` allowlisted custom Electron origin'ini qabul qiladi (`Access-Control-Allow-Origin: app://mezon`, `Vary: Origin`, `credentials` yo'q), `http://`/`https://` va `app://evil`/`file://` lar esa T0.6 dagidek `403` qaytadi.
     - `BrowserWindow`: `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`, `webSecurity: true`, `webviewTag: false`, `preload.cts` (`dist/preload.cjs`) faqat `getHubState` va `onHubState` ni ochadi (`ipcRenderer`/`fs`/Node yo'q). Strict CSP inline `<script>`/style ni bloklaydi (`unsafe-inline` va `unsafe-eval` yo'q). `setWindowOpenHandler` va `will-navigate` tashqi URL larni bloklaydi.
     - `@electron/fuses@2.1.3` (`after-pack-fuses.mjs`): `RunAsNode=false`, `EnableCookieEncryption=true`, `EnableNodeOptionsEnvironmentVariable=false`, `EnableNodeCliInspectArguments=false`, `EnableEmbeddedAsarIntegrityValidation=true`, `OnlyLoadAppFromAsar=true`, `GrantFileProtocolExtraPrivileges=false`.
   - **Ma'lumot papkasi (`T5`), NSIS va Bir nusxa:**
     - `resolveDesktopDataDir`: Windows da `%LOCALAPPDATA%\Mezon\` (`Roaming` emas), `requestSingleInstanceLock()` va Chromium boshlanishidan oldin `app.setPath('userData', ...)` va `app.setPath('logs', ...)` ga o'rnatiladi. `MEZON_DATA_DIR` o'rnatilgan (`isPackaged=true`) ilovada butunlay e'tiborsiz qoldiriladi; faqat `!isPackaged && MEZON_E2E === '1' && MEZON_DATA_DIR` bo'lgandagina ishlaydi.
     - NSIS (`electron-builder.yml`): `oneClick: false`, `perMachine: false`, `allowElevation: false`, `deleteAppDataOnUninstall: false`.
   - **Yopilish va WAL (`T3`) hamda Aylanuvchi loglar (`T4`):**
     - `before-quit`, `BrowserWindow` (`query-session-end`, `session-end`), va `powerMonitor.on('shutdown')` da `supervisor.shutdown()` chaqirilib Hub/SQLite tozalanadi (timeout fallback `.kill()`). Kutilmagan elektr uzilishida SQLite WAL `synchronous=FULL` tasdiqlangan ma'lumotni saqlashi izohda qayd etildi.
     - `@mezon/drivers/node` ichida `RotatingFileLogStream` (`maxBytes: 5 MiB`, `maxFiles: 5`) va `DEFAULT_LOG_REDACT_PATHS` yaratildi; Hub (`mezon-hub.log`) va Desktop (`mezon-desktop.log`) ikkisi ham aylanuvchi + redacted (`[Redacted]`) log yozadi.
   - **Staging & Nativ ABI (`dist-app/`) hamda `GEMINI.md` 2.1 "Muhim tekshiruvlar":**
     - Root `node_modules` host Node ABI da saqlanadi; `apps/desktop/scripts/prepare-electron-app.mjs` symlinksiz `apps/desktop/dist-app/` ni tayyorlaydi va `electron-builder` `beforeBuild` + `files: from: node_modules` orqali ASAR (`asarUnpack: ['**/*.node']`) ichiga joylaydi.
     - **O'lchov natijalari:** Host Node `v24.21.0` (`modules: "137"`, `win32 x64`); Electron `45.2.3` ichidagi Node `24.22.2` (`modules: "150"`, Chrome `156.0.8078.80`, `win32 x64`). `better-sqlite3@13.0.3` (`node-addon-api`, `gypfile: false`, `prebuilds/win32-x64.node`), `@node-rs/argon2@2.2.2` va `koffi@3.3.7` N-API prebuilts orqali Visual Studio C++ Build Tools'siz ham Electron `45.2.3` (`ABI 150`) ichida yuklanib ishlashi `verify-electron-abi.mjs` bilan tasdiqlandi (`sqliteCheck: true`, `argon2Check: true`, `koffiLoaded: true`, `koffiVersion: "3.3.7"`). Legacy V8/NAN modullar uchun `@electron/rebuild@4.2.1` yo'li saqlandi.
   - **Minimal React UI (`apps/pos`):** React 19.3.1 + Vite 8.3.7 minimal kassa qobiq sahifasi `window.mezonBridge` orqali `/health` natijasini (`status`, `needsSetup`, `hub-url`, `restartCount`) ko'rsatadi.
   - **CI (`.github/workflows/ci.yml`):** `desktop` (`Build & E2E Desktop Installer (windows-latest)`) jobi qo'shildi.

---

### O'zgargan fayllar (asosiy)

- `packages/db-local/src/auth.test.ts`, `apps/hub/src/hub.test.ts` — R1 `failed_attempts` test qarzi + `app://mezon` xavfsizlik testi
- `packages/drivers/src/node/{redact.ts,rotating-log-stream.ts,rotating-log-stream.test.ts,index.ts}`, `packages/drivers/{package.json,tsconfig.json,tsconfig.test.json}` — aylanuvchi log oqimi va redaction konstantalari
- `apps/hub/src/{config.ts,security.ts,logger.ts,electron-worker.ts,electron-worker-entry.mts,electron-worker.test.ts}` — `app://mezon` allowlisted CORS, worker lifecycle (`preferredPort` + `EADDRINUSE` fallback + `shutdown`)
- `apps/pos/{package.json,tsconfig.json,tsconfig.test.json,vite.config.ts,index.html,src/*}` — minimal React 19 + Vite 8 `/health` UI va bridge testlari
- `apps/desktop/{package.json,tsconfig.json,tsconfig.test.json,electron-builder.yml,playwright.config.mjs}` — Electron 45 konfiguratsiyasi
- `apps/desktop/src/{paths.ts,paths.test.ts,security-policy.ts,security-policy.test.ts,desktop-logger.ts,desktop-logger.test.ts,hub-supervisor.ts,hub-supervisor.test.ts,preload.cts,main.ts,index.ts}` — main process, `app://mezon`, CSP, preload, supervisor, T1–T5
- `apps/desktop/scripts/{prepare-electron-app.mjs,before-build.mjs,after-pack-fuses.mjs,verify-electron-abi.mjs,verify-packaged-desktop.mjs}` — staging, fuses, ABI va yakuniy `.exe` smoke tekshiruvlari
- `apps/desktop/e2e/desktop.spec.ts` — Playwright `_electron` UI E2E testi
- `.dependency-cruiser.cjs`, `eslint.config.mjs`, `.prettierignore`, `.gitignore`, `pnpm-workspace.yaml`, `pnpm-lock.yaml`, `.github/workflows/ci.yml`, `README.md` — cheklovlar, build allowlist va CI

---

### Migratsiyalar

Yo'q (T0.7 faqat desktop qobig'i va UI; `db:check` = 0 diff).

---

### Qaysi test qaysi binary ustida ishladi (`T2`)

1. **Yakuniy fuse qo'yilgan binary (`apps/desktop/dist-electron/win-unpacked/Mezon.exe`):**
   - `verify-packaged-desktop.mjs`: `getCurrentFuseWire` flaglarini tekshiradi (`0=48, 1=49, 2=48, 3=48, 4=49, 5=49, 6=48, 7=48, 8=49`), `ELECTRON_RUN_AS_NODE=1` ni rad etadi, `--inspect=0 --inspect-brk=0` da debugger ochilmasligini tekshiradi, va Playwright'siz smoke launch (`LOCALAPPDATA=<temp>`, `MEZON_E2E=1`, `MEZON_DATA_DIR=<decoy>`) orqali paketlangan ilova `MEZON_DATA_DIR` ni inkor etishini (`T5`), `<LOCALAPPDATA>\Mezon\data\mezon.db` yaratishini, Hub `/health` `200` berishini va 2-nusxa `exit=0` bilan birinchi oynani fokuslashini tasdiqlaydi.
2. **Fuse qo'yilmagan Electron binary (`node_modules/electron/dist/electron.exe`) + aynan o'sha `dist-electron/win-unpacked/resources/app.asar` (va `app.asar.unpacked`):**
   - `apps/desktop/e2e/desktop.spec.ts` (Playwright `1.65.0`): `app://mezon/` yuklanishi (`file://` emas), `/health` (`Origin: app://mezon` -> `200`, `Origin: file://` -> `403`), inline `<script>` CSP bloki, sandbox/preload chegarasi, tashqi `window.open` / `will-navigate` bloki, bir nusxa rejimi, va `T1` ikkala holat (hub kill -> o'sha portda tiklanish + hub kill & port band -> yangi portda CSP va oyna qayta yuklanishi + UI `/health` `200`).

---

### Qabul mezonlari

- [x] `T0.6 R1` test qarzi birinchi alohida commit (`2506ecf`) — mutatsiya bilan tasdiqlangan
- [x] Hub `utilityProcess` ichida va `T1` (o'sha portda ham, port band bo'lganda yangi port + CSP/reload bilan ham UI `/health` `200`) — `electron-worker.test.ts`, `hub-supervisor.test.ts`, `desktop.spec.ts` (3/3 ketma-ket)
- [x] `T2` Fused `Mezon.exe` alohida verify + Playwright `_electron` aynan bir xil `app.asar` ustida — `verify-packaged-desktop.mjs` va `desktop.spec.ts`
- [x] `T3` `before-quit`, `query-session-end`, `session-end`, `powerMonitor.shutdown` + WAL `synchronous=FULL` izohi — `apps/desktop/src/main.ts`
- [x] `T4` Aylanuvchi loglar + Pino redaction saqlanishi — `rotating-log-stream.test.ts`, `desktop-logger.test.ts`, `electron-worker.test.ts`
- [x] `T5` `MEZON_DATA_DIR` faqat `!isPackaged && MEZON_E2E=1 && MEZON_DATA_DIR` da ishlashi — `paths.test.ts` va packaged `Mezon.exe` smoke testi
- [x] `depcruise` (`apps/desktop/src`, `apps/pos/src`, `packages/drivers/src/node`) va salbiy dalillar — `apps/desktop/src -> @mezon/db-local` (Exit 1), `apps/pos/src -> node:fs` (Exit 1)
- [x] `desktop` CI jobi yashil + NSIS `.exe` artifact — Run [`#42814444774`](https://github.com/Shaxobiddin-Github/Mezon/actions/runs/42814444774) va [`#42814412213`](https://github.com/Shaxobiddin-Github/Mezon/actions/runs/42814412213), artifact **`mezon-desktop-win-x64-nsis`** (`124,243,258` bayt, `Mezon-Setup-0.1.0-x64.exe`)
- [ ] Toza Windows'da qo'lda o'rnatish, uninstall va qayta o'rnatishdan keyin ma'lumot qolishini skrinshot bilan tasdiqlash — **Egasi bajaradi** (quyidagi ro'yxat bo'yicha)

---

### Test natijasi

1. **`pnpm verify` (oxirgi kod o'zgarishidan keyin):**
   - `prettier --check .` → 0 xato
   - `turbo run build` → 17/17 muvaffaqiyatli (shundan `@mezon/pos` Vite 8 build)
   - `eslint .` → 0 xato
   - `turbo run typecheck` → 19/19 muvaffaqiyatli
   - `turbo run db:check` → PostgreSQL & SQLite 0 diff
   - `vitest run` → `21 passed | 1 skipped (22)` (`118 passed | 2 skipped (120)`; skip qilingan 2 ta test `pg-rls.test.ts` Ubuntu CI da `MEZON_REQUIRE_PG=1` bilan to'liq o'tgan)
   - `depcruise` → `✔ no dependency violations found (169 modules, 413 dependencies cruised)`
2. **`pnpm --filter @mezon/desktop run pack:win` & `verify:abi`:** `Mezon-Setup-0.1.0-x64.exe` (`125,212,312` bayt) yig'ildi; ABI `150` tekshiruvi (`sqliteCheck: true`, `argon2Check: true`, `koffiLoaded: true`) o'tdi.
3. **`pnpm --filter @mezon/desktop run verify:fuses`:** barcha fuse bitlari, `ELECTRON_RUN_AS_NODE=1` bloki, `--inspect` bloki, va packaged `Mezon.exe` smoke launch (Port `60518`, DB yaratilishi, `T5` decoy e'tiborsiz qolishi, 2-nusxa bloki) o'tdi.
4. **`pnpm --filter @mezon/desktop run test:e2e` (ketma-ket 3 marta):** `1 passed` x 3 (`6.7s`, `6.4s`, `6.2s`).
5. **GitHub Actions CI (`55fb963`):**
   - Pull Request run [#42814444774](https://github.com/Shaxobiddin-Github/Mezon/actions/runs/42814444774): `Verify (ubuntu-latest)` (`success`), `Verify (windows-latest)` (`success`), `Verify PostgreSQL RLS (ubuntu-latest)` (`success`), `Build & E2E Desktop Installer (windows-latest)` (`success`, artifact `mezon-desktop-win-x64-nsis`).
   - Push run [#42814412213](https://github.com/Shaxobiddin-Github/Mezon/actions/runs/42814412213): barcha 4 job `success`.

---

### Tekshirilmagan narsalar

- **Toza Windows mashinada NSIS o'rnatuvchi + Uninstall + Qayta o'rnatish (skrinshotlar bilan):** CI `windows-latest` da NSIS `.exe` artifact yig'ildi (`mezon-desktop-win-x64-nsis`), lekin haqiqiy kassa kompyuterida GUI o'rnatuvchi ustasi + SmartScreen + Uninstall -> `%LOCALAPPDATA%\Mezon\` saqlanishi egasi tomonidan tekshiriladi.
- **Haqiqiy OS shutdown/restart paytida `WM_QUERYENDSESSION` (`query-session-end` / `session-end` / `powerMonitor.shutdown`):** Unit/supervisor shutdown yo'li testlangan, lekin haqiqiy Windows tizimini qayta yuklash testi o'tkazilmagan.
- **Code signing:** Hozircha imzosiz yig'iladi (`signAndEditExecutable: false`), shuning uchun Windows SmartScreen ogohlantirishi chiqishi normal holat (T4/tijorat bosqichida EV/OV sertifikat bilan hal qilinadi).

---

### Egasi uchun toza Windows'da qo'lda tekshiruv ro'yxati

1. PR #7 CI (`Run #42814444774`) dan **`mezon-desktop-win-x64-nsis`** artifact'ini yuklab oling (`Mezon-Setup-0.1.0-x64.exe`).
2. Oddiy (admin huquqsiz) Windows 10 22H2+ / Windows 11 hisobida ishga tushiring (SmartScreen chiqsa `More info -> Run anyway`; UAC admin paroli so'ramasligi shart).
3. Ilovani ochib, `app://mezon/`, Hub `/health: ok` (`needsSetup: true`) ko'ringanini **skrinshot** qiling va `%LOCALAPPDATA%\Mezon\data\mezon.db` hamda `%LOCALAPPDATA%\Mezon\logs\mezon-hub.log` borligini tekshiring.
4. Ikkinchi marta ishga tushirganda 1-oyna oldinga chiqishini tekshiring.
5. Windows *Apps & Features* orqali Mezon ni Uninstall qiling, `%LOCALAPPDATA%\Mezon\data\mezon.db` o'chirilmaganini tekshiring.
6. Qayta o'rnating va avvalgi ma'lumot papkasi saqlanganini **skrinshot** bilan tasdiqlang.

---

### Qilingan taxminlar

- Hozircha barcha uch nativ bog'liqlik (`better-sqlite3@13.0.3`, `@node-rs/argon2@2.2.2`, `koffi@3.3.7`) N-API asosida prebuilt binary yetkazib beradi, shu sabab MSVC Build Tools bo'lmagan muhitda ham Electron 45 ABI (`150`) da ishlaydi; kelajakda legacy V8/NAN modul qo'shilsa `@electron/rebuild` uni avtomatik aniqlab yig'adi.
- Fuses faqat Windows `win32` (`Mezon.exe`) uchun sozlangan (T0.7 talabi Windows NSIS o'rnatuvchi).

---

### Takliflar

- Keyingi bosqichda (`F1`/`T1.12`) haqiqiy ilova ikonkasini (`build/icon.ico`) qo'shish `electron-builder` da `signAndEditExecutable: false` o'rniga `signExecutable: false` ishlatishga va brend ikonkasini qo'yishga imkon beradi.

---

### Egasi yoki Claude qarori kerak bo'lgan savollar

- Yuqoridagi toza Windows qo'lda tekshiruv ro'yxatini bajarish (yoki `T0.7` ni shu CI natijalari bilan qabul qilib qo'lda tekshiruvni Egasi bajarishiga kelishish) bo'yicha qaroringiz kerak.
