# Claude topshirig'i: T0.7 rejasi — TUZATISHLAR BILAN TASDIQLANDI

**Merge tekshiruvi:** T0.6 merge'i tekshirildi. `main` = `759f3ee`, kod `2430c48` bilan bir xil.

**Rejada tasdiqlangan qismlar:**

- `utilityProcess` arxitekturasi;
- `app://mezon` protokoli, CSP, preload, navigatsiya bloki va fuse'lar ro'yxati;
- `dist-app` staging katalogi orqali Node va Electron ABI izolyatsiyasi;
- `%LOCALAPPDATA%\Mezon`, NSIS sozlamalari va bir nusxa rejimi;
- depcruise qoidalari;
- egasi uchun qo'lda tekshiruv ro'yxati;
- T0.6 test qarzi birinchi alohida commit sifatida.

Quyidagi tuzatishlar bilan `gemini/T0.7-electron-shell` branch'ida kodni yoz.

## Majburiy tuzatishlar

### T1. Hub qayta ko'tarilganda port o'zgarmasin

Hub yiqilib `port: 0` bilan qayta ko'tarilsa, yangi port oladi. Rendererdagi `hubBaseUrl` va yuklangan sahifaning CSP'sidagi `connect-src` eski portda qoladi. Natijada UI ochiq, lekin hub'ga ulana olmaydi.

**Talab:**

- Qayta ishga tushishda avvalgi port qayta ishlatilsin.
- Port band bo'lsa, yangi port olinsin. So'ng CSP yangilansin, renderer IPC hodisasi bilan xabardor qilinsin va oyna qayta yuklansin.

**E2E testida:** hub yiqilgandan keyin UI'dan `/health` so'rovi yana muvaffaqiyatli bo'lsin. Faqat hub javob berishini tekshirish yetarli emas.

### T2. Playwright va fuse ziddiyati

Playwright `_electron` odatda `--inspect`/`--remote-debugging-port` argumentlari bilan ishga tushadi. `EnableNodeCliInspectArguments: false` esa ularni bloklaydi.

**Talab:**

- Fuse'ni testlar uchun o'chirib qo'yma.
- Imzolanadigan yakuniy (fuse qo'yilgan) binary uchun alohida tekshiruvlar bo'lsin: fuse holatini o'qish, `ELECTRON_RUN_AS_NODE=1` rad etilishi, `--inspect` argumenti rad etilishi.
- Ilovani Playwright'siz ishga tushirib, hub `/health` javobini log yoki `dataDir` orqali tekshiradigan smoke test bo'lsin.
- Playwright UI testi fuse qo'yilmagan, lekin aynan bir xil `app.asar` ustida ishlasin.
- Qaysi test qaysi binary ustida ishlashini hisobotda aniq yoz.

### T3. Kompyuter o'chirilganda baza toza yopilsin

Kassa kompyuteri ko'pincha to'g'ridan-to'g'ri o'chiriladi.

**Talab:**

- `before-quit` bilan birga Windows'ning sessiya tugashi va o'chish hodisalarini ham ushla (`powerMonitor` `shutdown`, `session-end` / `query-session-end`).
- Bu hodisalarda hub'ga `shutdown` yuborilib, SQLite yopilsin (WAL checkpoint).
- Yopilmay qolgan holatda ham SQLite WAL `synchronous=FULL` tufayli tasdiqlangan ma'lumot yo'qolmaydi. Buni izohda yoz.

### T4. Log hajmi cheklansin

Kassa yillab ishlaydi. Fayl loglari aylanuvchi bo'lsin: hajm chegarasi va eski fayllar soni chegarasi. Shunda disk to'lib qolmaydi. Redaction saqlansin.

### T5. `MEZON_DATA_DIR` faqat test uchun

O'rnatilgan (`app.isPackaged`) ilovada ma'lumot papkasi muhit o'zgaruvchisi bilan o'zgartirilmasin. Override faqat aniq test rejimida ishlasin: ham `MEZON_E2E=1`, ham `MEZON_DATA_DIR` bo'lishi kerak. Buni test bilan isbotla.

## Bajarish tartibi

1. Birinchi commit: `T0.6 test qarzi: R1 failed_attempts tekshiruvi`. Mutatsiya dalili bilan.
2. T0.7 kodi.
3. `pnpm verify` yashil.
4. `desktop` CI job'i yashil: o'rnatuvchi artifact va testlar.
5. Hisobot: GEMINI.md 2.1 "Muhim tekshiruvlar" o'lchovlari, fuse holati, qaysi test qaysi binary ustida ishlagani, CI havolalari va artifact nomi. `[gemini-hisobot] T0.7` bilan commit qil va push qil.
6. `node .mezon/kutish.mjs`. Merge qilma.
