# v1 integratsiya: hamma branch bitta joyda (`claude/v1-integration`)

Bu `main` ga tushadigan PR **emas**. Barcha ochiq ishlar birga ishlashini isbotlash uchun tayyorlandi va to'qnashuvlar oldindan hal qilindi. Shu tufayli merge'lar navbat bilan, kam ish bilan tushadi.

**Tartib** (`origin/main` = `55b38d2` ustidan, `--no-ff`): C2 → P2 → P3 → C4 → C5 → C6.

## To'qnashuvlar va qanday hal qilindi

| Merge | Fayl | Yechim |
| --- | --- | --- |
| P2 | `apps/hub/src/server.ts` | Ikkalasi: litsenziya route'lari va yangilash darvozasi (C2), keyin markirovka, to'lov va audit (P2). |
| P3 | `server.ts` `close()` | Ikkalasi: `licenceService.stop()` va LAN tinglovchisini yopish. |
| P3 | bulut migratsiyasi | P3 ham `0008` ni olgan edi, C2 da esa `0008_licences`. P3 niki `drizzle-kit generate` bilan **`0009_register_shifts`** qilib qayta yaratildi. SQL P3 dagisi bilan bayt-bayt bir xil, `db:check` toza. |
| C4 | `apps/admin/src/api-client.ts`, `apps/cloud/src/server.ts` | Ikkalasi. `LicenceInfo` interfeysining yopuvchi qavsi qo'lda tiklandi. |
| C6 | `.dependency-cruiser.cjs` | Hub: `licensing` + `os`. Desktop: `crypto`, `child_process`, `http`, `https`. |
| C6 | `desktop.spec.ts` | Preload kalitlari: yangilash (C2) va terminal (C6), jami 10 ta. |
| C6 | `main.ts`, `bridge.ts`, i18n, `server.ts` | Ikkalasi. `main.ts` dagi `import {` qo'lda tiklandi. |

## Integratsiyada qo'shilgan tuzatishlar

- **Terminal rejimi va yangilanish (C2 × C6).** Terminalda lokal hub yo'q, shuning uchun ochiq chekni tekshirib bo'lmaydi. Terminalda avtomatik yangilanish o'chiq: IPC `disabled` holatini qaytaradi. Terminal o'rnatuvchi bilan yangilanadi; bu `docs/v1/README.md` da yozilgan.
- **Versiya 1.0.0:** desktop, hub, pos, cloud, admin, bot. Hub bulutga o'z versiyasini `'0.1.0'` deb qattiq yozib yuborardi. Endi `HUB_APP_VERSION` ishlatiladi; test uni `package.json` bilan tekshiradi.
- **O'rnatuvchi nomi:** `Guzar-Setup-<versiya>-x64.exe` (CI artefakt yo'li ham). Exe ichki nomi `Mezon.exe` o'zgarmadi, chunki skriptlar unga bog'langan.
- **`uow.test.ts` property testi:** 120 soniyalik aniq chegara oldi. Alohida 8.7 soniyada o'tadi, lekin to'liq parallel yugurishda (PG konteynerlari bilan) 30 soniyadan oshib ketdi; ikki marta takrorlandi. Bu vaqt chegarasi, tekshiruv emas: test va uning shartlari o'zgarmadi.
- **Hujjatlar:**
  - `docs/pilot/reliz-royxati.md` v1 uchun yangilandi: fiskal o'chiq, UzQR yo'q, qayta ishga tushirish sinovi, bulut va ikkinchi kassa ulash bandlari;
  - `docs/v1/README.md` da ulanish qadamlari haqiqiy ekranlarga moslandi.

## Tekshiruv (shu branch)

- Build, typecheck, lint, depcruise, prettier, `db:check`: yashil.
- `MEZON_REQUIRE_PG_TESTS=1` bilan unit + sqlite-hub + pg-cloud: **1153 test**. Bitta yiqilgan test faqat yuqoridagi vaqt chegarasi edi; tuzatilgach o'tdi. Perf: 17/17.
- POS E2E: yashil.
- Desktop `pack:dir` + E2E: yashil (preload'da 10 ta kalit).
- **Ikki nusxali LAN sinovi** (yig'ilgan `app.asar`): kod → ulanish, barmoq izlari bir xil → qayta ishga tushish → ikkinchi kassada smena va 1-chek. Hub hisobotida `Kassa 2: 1 savdo, 5 000 so'm` ko'rinadi.

## Keyingi qadam

Merge'lar hali **tekshiruvchi QABUL'i** bilan navbatma-navbat: C2 → P2 → P3 → C4 → C5 → C6. Har biriga shu branch'dagi yechimlar ko'chiriladi. Ikkinchi yo'l: shu branch'ni bitta "v1" PR qilib, bir marta tekshirish. Qarorni ishchi2 qaytganda egasi bilan qilamiz.
