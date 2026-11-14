# Claude topshirig'i: T1.13 — QAYTA ISHLASH (R1)

Kod `e4ee795` tekshirildi.

- **Toza nusxada `pnpm verify` yashil:** 310 + 12 perf test, E2E, depcruise.
- **Bajarilgan:** R1 (haqiqiy ustunlar), R3 (hisoblagichlar `max`), R4 (import qayta tekshiruvi), tannarxni yashirish va zaxira yaratish (`db.backup` + `integrity_check` + SHA-256).

Lekin **ishga tushishdagi tiklash** (`executeStagedRestoreIfPending`) da uchta ishonchlilik muammosi bor. Zaxira tizimi ma'lumot yo'qotmasligi kerak, shuning uchun bular majburiy.

## B1. Xavfsizlik nusxasi WAL'ni yo'qotadi

```ts
fs.copyFileSync(options.dbPath, safetyBackupPath);   // faqat asosiy fayl
...
if (fs.existsSync(walPath)) fs.unlinkSync(walPath);   // keyin WAL o'chiriladi
```

Hub to'satdan to'xtagan bo'lsa (elektr o'chishi, jarayon o'ldirilishi), oxirgi commit qilingan tranzaksiyalar hali `-wal` faylida turadi. Oddiy fayl nusxasi ularni olmaydi, keyin WAL o'chiriladi. Natijada "xavfsizlik nusxasi" so'nggi savdolarsiz qoladi.

**Talab:**

- Xavfsizlik nusxasi WAL bilan to'liq bo'lsin. Avval joriy bazani ochib `PRAGMA wal_checkpoint(TRUNCATE)` qil, so'ng better-sqlite3 `backup()` yoki `VACUUM INTO` bilan nusxa ol.
- Xavfsizlik nusxasining `integrity_check` natijasi `ok` bo'lmasa, tiklash to'xtatiladi.
- **Test:** child process'da savdo commit qilinadi va checkpoint bo'lmasdan `process.exit` bo'ladi (WAL'da qoladi). So'ng tiklash bajariladi. Xavfsizlik nusxasini ochib, o'sha savdo borligi tekshiriladi.

## B2. Ishga tushishda zaxira qayta tekshirilmaydi, almashtirish atomar emas

Ishga tushishda faqat fayl mavjudligi tekshiriladi. Stage va restart oralig'ida zaxira fayli buzilgan yoki almashtirilgan bo'lishi mumkin.

**Talab:**

- Almashtirishdan oldin zaxiraning SHA-256'i `.meta.json` dagisi bilan solishtiriladi va `integrity_check` = `ok` bo'lishi shart. Aks holda tiklash bekor qilinadi, joriy baza tegilmay qoladi, xato qayd etiladi.
- Almashtirish atomar bo'lsin: zaxira avval `dbPath` yonidagi vaqtinchalik faylga ko'chiriladi, so'ng `rename` qilinadi. O'rtada yiqilsa, asosiy baza buzilmasin.
- **Testlar:**
  - stage qilingandan keyin zaxira faylining bir bayti o'zgartiriladi → ishga tushishda tiklash rad etiladi, joriy baza o'zgarmaydi;
  - buzilgan (integrity'dan o'tmaydigan) fayl ham shunday rad etiladi.

## B3. Tiklashdan keyin proyeksiyalar qayta qurilmaydi

R2 da tiklashdan so'ng `rebuild` va summalar tengligi talab qilingan edi. Ishga tushish kodida rebuild chaqirilmaydi.

**Talab:**

- Tiklash bajarilgan ishga tushishda, migratsiyalardan keyin ombor, mijoz va ta'minotchi proyeksiyalari qayta quriladi.
- Natija tekshiriladi: proyeksiya = ledger; tushum, qarz va qoldiq zaxira meta'sidagi summalar bilan teng. Tenglik bo'lmasa, aniq log va diagnostika chiqarilsin.
- **Test:** zaxira olinadi → proyeksiya jadvali qo'lda buziladi → tiklash → proyeksiyalar ledger bilan teng.

## B4. HLC ham orqaga qaytmasin

`last_hlc` o'qiladi, lekin tiklangan bazada yangilanmaydi. Tiklangan bazadagi `last_hlc` ham `max(restored, current)` bo'lsin (leksik HLC solishtirish). **Test** bilan isbotla.

## Bajarish tartibi

1. B1–B4 ni tuzat. Yangi commit qil, amend qilma.
2. Lokal `pnpm verify` yashil.
3. Push qil, to'rtala CI job yashil bo'lsin.
4. Hisobot: B1–B4 testlari va har biri uchun mutatsiya dalili. `[gemini-hisobot] T1.13 R1` bilan commit qil va push qil.
5. `node .mezon/kutish.mjs` ni ishga tushir. Merge qilma.
