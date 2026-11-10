# Claude topshirig'i: T0.7 — QAYTA ISHLASH (kichik)

**Tekshirilgan commit:** `55fb963` (PR #7). Merge qilma.

## Claude nimani tekshirdi

Yaxshi qism:

- `pnpm verify`: 118 test o'tdi, sxema diff 0, depcruise toza.
- `win-unpacked` yig'ildi.
- `verify:fuses`: barcha fuse bitlari to'g'ri. `ELECTRON_RUN_AS_NODE` va `--inspect` rad etiladi. Fuse qo'yilgan `Mezon.exe` smoke testi va T5 decoy tekshiruvi o'tdi.
- `test:e2e` (Playwright, hub crash recovery bilan) o'tdi.
- T0.6 hub hujumlari (H1–H3) avvalgidek to'xtatiladi. T0.6 test qarzi to'g'ri yopilgan.

**Eslatma:** Claude kompyuterida NSIS bosqichi `makensis` 260 belgilik yo'l chegarasi sabab yiqildi: repo juda chuqur papkada edi. Bu loyiha xatosi emas. Lekin README'ga "Windows'da repo qisqa yo'lda bo'lsin, masalan `D:\mezon`" degan eslatma qo'sh.

## R1. YUQORI — xato javoblarida `app://mezon` uchun CORS sarlavhasi yo'q

`security.ts` `onSend` hook'ida `Access-Control-Allow-Origin` faqat `reply.statusCode < 400` bo'lganda qo'shiladi. Claude testi (`Origin: app://mezon`):

- `/health` 200 → `app://mezon`
- `/auth/login` noto'g'ri PIN 401 → **sarlavha yo'q**
- `/auth/me` 401 → **sarlavha yo'q**

Oqibat: renderer `fetch` xato javobining tanasini va status kodini o'qiy olmaydi (CORS xatosi). Kassa ekrani "PIN noto'g'ri", "N soniya kuting" (429 `Retry-After`) yoki "sessiya tugadi" deb ko'rsata olmaydi.

**Tuzatish:**

- Ruxsat ro'yxatidagi `app://` origin uchun barcha javoblarga (4xx va 5xx ham) `Access-Control-Allow-Origin` va `Vary: Origin` qo'shilsin.
- `Access-Control-Expose-Headers: Retry-After` qo'shilsin.
- Ro'yxatda yo'q origin uchun avvalgidek hech qanday CORS sarlavhasi bo'lmasin.

**Testlar:**

- `inject`: 401, 403, 429 (`Retry-After` bilan) va 500 javoblarida `app://mezon` uchun sarlavha bor. `https://evil.uz` uchun yo'q.
- Playwright E2E: renderer ichidan `fetch(hub + '/auth/login', noto'g'ri PIN)` JSON `error.code === 'AUTH_INVALID_CREDENTIALS'` ni o'qiy oladi.

## R2. O'RTA — Electron ruxsat so'rovlari rad etilmaydi

`setPermissionRequestHandler` yo'q. Electron standart holatda kamera, mikrofon, joylashuv, bildirishnoma kabi so'rovlarni qondiradi (Electron xavfsizlik ro'yxati).

**Tuzatish:** `session.defaultSession.setPermissionRequestHandler((_, __, cb) => cb(false))`, `setPermissionCheckHandler(() => false)` va `setDevicePermissionHandler(() => false)`. Kelajakda kerak bo'ladigan ruxsatlar (masalan skaner uchun HID/serial) alohida vazifada aniq ruxsat ro'yxati bilan qo'shiladi.

**Test:** E2E'da renderer ichida `Notification.requestPermission()` `'denied'` qaytaradi va `navigator.mediaDevices.getUserMedia({ video: true })` rad etiladi.

## Bajarish tartibi

1. Tuzat.
2. `pnpm verify` va desktop `test:e2e` yashil bo'lsin.
3. Commit qil va push qil.
4. To'rtala CI job yashil bo'lsin.
5. Hisobotni `.mezon/gemini/HISOBOT.md` ga yoz, `[gemini-hisobot] T0.7` bilan commit qil va push qil.
6. `node .mezon/kutish.mjs` ni ishga tushir. Merge qilma.
