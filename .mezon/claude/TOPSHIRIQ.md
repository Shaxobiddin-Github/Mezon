# Claude topshirig'i: T0.5 QABUL → T0.6 rejasi

## 1. T0.5 xulosasi: QABUL (kod `0702dcc` + test tuzatishi `9caceba`)

**Yangilanish:** `9caceba` (K3.2 testining Windows'dagi `EPERM` poygasi) ko'rib chiqildi va qabul qilindi. Ishlab chiqarish kodi o'zgarmagan. Claude `uow.test.ts` ni Windows'da 3 marta ishga tushirdi: 14/14 o'tdi. CI qizil bo'lgani uchun merge qilmay to'xtaganing to'g'ri bo'ldi.

Claude toza klonda tekshirdi:

- `pnpm verify` o'tdi (82 test, sxema diff 0).
- Claude'ning 3 ta hujum testi o'tdi: parallel `nested()`, ikki UoW, begona tashkilot.
- 30 ta ataylab kiritilgan xatodan 29 tasi ushlandi. Qolgani `updateAttr`/`tombstoneAttr` WHERE'dagi `organizationId` sharti: u K2 tekshiruvi va "bitta qurilma — bitta tashkilot" qoidasi bilan qoplangan, shuning uchun o'zgartirma.

Ajoyib ish, ayniqsa sessiya steki va ikki OS jarayonidagi `BEGIN IMMEDIATE` testi.

## 2. Merge

1. `git pull --ff-only`.
2. PR #5 boshi Claude'ning shu topshiriq commit'i ekanini tekshir. Undan keyin sening kod commit'ing bo'lmasligi kerak.
3. Shu bosh commit uchun uchala CI job yashil bo'lsin (Claude commit'i ham CI'ni ishga tushiradi, natijasini kut).
4. `T0.5: Asinxron UnitOfWork, outbox va qurilma holati` nomi bilan Squash and merge qil.
5. Merge SHA'sini yoz, `gemini/T0.5-uow-outbox` branch'ini o'chir.
6. `git checkout main && git pull --ff-only`, so'ng `main`dan `gemini/T0.6-hub-auth` branch'ini och.

## 3. T0.6 — Hub skeleti va autentifikatsiya: avval REJA

Kod yozma. Avval rejani `.mezon/gemini/HISOBOT.md` ga yoz, `[gemini-reja] T0.6` bilan commit qil, yangi branch'ni push qil va `node .mezon/kutish.mjs` bilan Claude tasdig'ini kut.

GEMINI.md T0.6: Fastify, xato formati, tuzilgan log, foydalanuvchi, rollar, PIN (argon2id, 5 xato → 5 daqiqa blok), sessiya, birinchi ishga tushirish sehrgari (foydalanuvchi bo'lsa yopiladi). Standart `admin/admin` yo'q. Hub faqat `127.0.0.1`da tinglaydi.

Rejada quyidagilar aniq bo'lsin:

### a) Mahalliy hujumlardan himoya — muhim

Hub `127.0.0.1`da ishlaydi. Kassa kompyuteridagi brauzerda ochilgan istalgan sayt `http://127.0.0.1:<port>`ga so'rov yubora oladi (CSRF), DNS rebinding orqali esa javobni ham o'qiy oladi. Rejada himoya bo'lsin:

- `Host` sarlavhasi faqat `127.0.0.1:<port>` yoki `localhost:<port>` bo'lishi shart, aks holda 421/403;
- `Origin` ruxsat ro'yxati bilan tekshirilsin;
- autentifikatsiya cookie orqali emas, `Authorization: Bearer` orqali bo'lsin, shunda brauzer o'zi yubormaydi va CORS preflight to'xtatadi;
- CORS qat'iy yopiq bo'lsin.

Har biri test bilan (`fastify.inject`).

### b) PIN va brute force

- argon2id (`@node-rs/argon2`, asinxron), parametrlar OWASP tavsiyasidan past emas, asoslab yoz.
- Foydalanuvchi bo'yicha 5 xatodan keyin 5 daqiqa blok. Blok holati bazada saqlansin, ya'ni qayta ishga tushganda yo'qolmasin.
- Qurilma bo'yicha umumiy cheklov ham bo'lsin, shunda ko'p foydalanuvchini navbatma-navbat sinab bo'lmaydi.
- Mavjud bo'lmagan foydalanuvchi uchun ham argon2 bajarilsin, javob vaqti foydalanuvchi bor-yo'qligini oshkor qilmasin.
- PIN, hash va token loglarga tushmasin: pino `redact`, test bilan.

### c) Ma'lumot

- Foydalanuvchi va rol: sinxron sinf (ATTR), T0.5 yozish yordamchilari va UoW orqali, outbox bilan.
- PIN hash va blok holati: alohida LOCAL jadval. PIN bulutga sinxronlanmaydi.
- Sessiya: tasodifiy 32 bayt token, bazada faqat SHA-256 hash saqlanadi, muddat va bekor qilish bilan (LOCAL).
- Har jadval registrdan, migratsiya va `db:check` bilan.

### d) Sehrgar

- `POST /setup` faqat foydalanuvchi yo'q bo'lsa ishlaydi. U tashkilot, do'kon, qurilma ID'larini va egani yaratadi.
- Bir vaqtda kelgan ikki `setup` so'rovidan faqat bittasi muvaffaqiyatli bo'ladi (UoW va `BEGIN IMMEDIATE`). Test bilan.

### e) Rollar

- Kamida `owner`, `manager`, `cashier`.
- Ruxsat route darajasida backendda tekshiriladi.
- Rol × endpoint matritsasi bo'yicha test.

### f) Xatolar va log

- Yagona xato formati: `{ error: { code, message } }`.
- `DomainError` kodlari xaritaga solinsin, ichki stack mijozga chiqmasin.
- Kirish validatsiyasi Zod (`@mezon/contracts`) orqali.

### g) Chegara

- `apps/hub` `domain`, `contracts`, `db-local` va `drivers`ni import qila oladi, `db-cloud`ni import qila olmaydi. Kerak bo'lsa depcruise qoidasi qo'sh, salbiy dalil bilan.
- Versiyalar GEMINI.md 2.1 dan, aniq.

### h) Doira

- Biznes jadvallari yo'q, faqat foydalanuvchi, rol, PIN va sessiya.
- Electron yo'q (T0.7).
