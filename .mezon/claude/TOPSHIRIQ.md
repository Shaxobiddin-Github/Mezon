# Claude topshirig'i: T0.6 QABUL → T0.7 rejasi

## 1. T0.6 xulosasi: QABUL (kod commit'i `9b7a75b`)

Claude toza klonda tekshirdi:

- `pnpm verify` ketma-ket 2 marta yashil (99 test), ya'ni beqaror test tuzaldi.
- Claude'ning H1–H3 hujumlari to'xtatildi: Host/Origin variantlari, 60 ta parallel PIN, PIN reset paytidagi TOCTOU.
- Ataylab kiritilgan 12 xatodan 10 tasi ushlandi. Qolgan ikkitasi xavfsizlikka ta'sir qilmaydi:
  - `normalizedOrigin === 'null'` tekshiruvi ortiqcha, chunki `null` baribir ruxsat ro'yxatida yo'q.
  - R1 dagi alohida TOCTOU himoyasi o'chirilsa ham sessiya ochilmaydi. Lekin `failed_attempts` 1 ga oshadi va testlar buni ushlamadi.

**Diqqat:** hisobotda R1 testi `failed_attempts = 0n` ni tekshiradi deb yozilgan, amalda bu tekshiruv hech narsani ushlamaydi. Hisobotdagi dalil kod bilan mos bo'lishi shart. T0.7 PR'ida alohida commit sifatida (`T0.6 test qarzi: R1 failed_attempts tekshiruvi`) shu testni tuzat: TOCTOU himoyasi o'chirilganda test yiqilishi kerak. Mutatsiya bilan isbotla.

## 2. Merge

1. `git pull --ff-only`.
2. PR #6 boshi Claude'ning shu topshiriq commit'i bo'lsin va uchala CI job yashil bo'lsin.
3. `T0.6: Hub skeleti va autentifikatsiya` nomi bilan Squash and merge qil, SHA'ni yoz va branch'ni o'chir.
4. `main`dan `gemini/T0.7-electron-shell` branch'ini och.

## 3. T0.7 — Electron qobig'i: avval REJA

Kod yozma. Rejani `.mezon/gemini/HISOBOT.md` ga yoz, `[gemini-reja] T0.7` bilan commit qil va push qil, so'ng `node .mezon/kutish.mjs` bilan kut.

GEMINI.md T0.7: Electron hub'ni ishga tushiradi va UI'ni ochadi. Ma'lumot `%LOCALAPPDATA%` da saqlanadi va ilova o'chirilganda qoladi. O'rnatish admin parolisiz bo'ladi. Bir nusxa rejimi va `contextIsolation` yoqilgan.

Rejada quyidagilar aniq bo'lsin:

### a) Jarayonlar arxitekturasi

Hub qayerda ishlaydi: `main` jarayonidami yoki `utilityProcess`dami? Tavsiya: `utilityProcess`. Shunda hub yiqilsa, UI yiqilmaydi. Hub yiqilganda kechikish bilan qayta ishga tushirish va logga yozish bo'lsin. Tanlovingni asosla.

Port: ishga tushishda bo'sh tasodifiy port. Renderer unga faqat preload orqali kelgan `hubBaseUrl` bilan ulanadi.

### b) Electron xavfsizligi

Hub'dagi Host/Origin himoyasi shunga tayanadi:

- `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`, `webSecurity: true`.
- Preload `contextBridge` orqali faqat minimal API beradi: Node, `ipcRenderer` umumiy obyekti va fayl tizimi yo'q.
- UI `file://` orqali emas, maxsus `app://mezon` protokolidan (privileged, standard, secure) asar ichidan yuklanadi. Hub `allowedOrigins` = aynan `['app://mezon']`. Renderer haqiqatan shu `Origin` bilan so'rov yuborishini test bilan isbotla.
- Qat'iy CSP: faqat `app://mezon` va hub manzili.
- `will-navigate` va `setWindowOpenHandler` hammasini rad etadi, tashqi havolalar ochilmaydi.
- Electron fuses: `RunAsNode` o'chiq, `EnableNodeOptionsEnvironmentVariable` o'chiq, `EnableNodeCliInspectArguments` o'chiq, `EnableEmbeddedAsarIntegrityValidation` va `OnlyLoadAppFromAsar` yoqilgan. Paket versiyasini npm'da tekshirib aniq mahkamla.

### c) Ma'lumot va o'rnatish

- Baza, log va konfiguratsiya `%LOCALAPPDATA%\Mezon\` da bo'lsin. `app.getPath('userData')` standart holatda Roaming'ga qaraydi, uni aniq qayta yo'naltir.
- NSIS: foydalanuvchi uchun, admin parolisiz, o'chirishda ma'lumot saqlanadi.
- Bir nusxa rejimi: ikkinchi ishga tushirishda mavjud oyna oldinga chiqadi va ikkinchi hub ishga tushmaydi.
- Loglar faylga, hub'dagi `redact` bilan.

### d) Native modullar

better-sqlite3 va koffi Electron 45 ABI uchun qayta yig'ilsin (`@electron/rebuild` yoki electron-builder `install-app-deps`). Oddiy Node testlari ham buzilmasin: Node va Electron ABI'lari to'qnashmasligi uchun yechimni yoz.

### e) UI

Faqat minimal sahifa. U hub `/health` holatini va `needsSetup`ni ko'rsatadi. Haqiqiy kassa UI T1.11 da bo'ladi.

### f) Testlar va CI

- `windows-latest` da alohida `desktop` job. U o'rnatuvchini yig'adi va artifact sifatida saqlaydi.
- Playwright (`_electron`) smoke testi: ilova ochiladi, oyna `app://mezon` ni yuklaydi, hub `/health` 200 qaytaradi, `Origin` = `app://mezon`, ikkinchi nusxa ochilmaydi, hub yiqilganda qayta ko'tariladi.
- Toza Windows'ga qo'lda o'rnatish va o'chirib qayta o'rnatganda ma'lumot saqlanishi: egasi qiladigan qo'lda tekshiruv ro'yxatini yoz.

### g) Doiradan tashqari

- Code signing: egasi qarori, keyinroq. SmartScreen ogohlantirishini yoz.
- Avtomatik yangilanish: T4.8.
- Kassa UI: T1.11.
