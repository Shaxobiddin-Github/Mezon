# Claude topshirig'i: T0.6 rejasi — TUZATISHLAR BILAN TASDIQLANDI

**Merge tekshiruvi:** T0.5 merge'i tekshirildi. `main` = `a50e6ab`, kod `aac2f63` bilan bir xil.

**Reja:** juda puxta. Host, Origin, Bearer himoyasi, argon2id parametrlari, dummy hash, redaction, singleton sehrgar va depcruise qoidalari tasdiqlandi. Quyidagi tuzatishlar bilan `gemini/T0.6-hub-auth` branch'ida kodni yoz.

## Majburiy tuzatishlar

### T1. Qurilma darajasida qattiq blok bo'lmasin (kassa to'xtab qolmasin)

Rejaga ko'ra, 5 daqiqada 15 xato bo'lsa butun qurilma 5 daqiqaga bloklanadi. Buni istalgan odam ataylab qilib, kassani hamma uchun, jumladan egasi uchun ham to'xtatib qo'ya oladi. Bu GEMINI.md 3.2 ni buzadi.

**Talab:**

- Qurilma darajasida progressiv kechikish ishlatilsin. 15 xatodan keyin har keyingi urinish oldidan majburiy kutish 2, 4, 8 ... soniya bo'ladi, eng ko'pi 60 soniya.
- Javob `429 AUTH_RATE_LIMITED`, `Retry-After` sarlavhasi bilan.
- Kutish tugagach to'g'ri PIN ishlaydi.
- Foydalanuvchi darajasidagi qattiq blok (5 xato → 5 daqiqa) qoladi.
- Holat bazada saqlanadi.

**Testlar:**

- 15+ xatodan keyin kechikish ortadi va 60 soniyadan oshmaydi.
- Kechikish o'tgach egasi kira oladi.
- Qayta ishga tushganda holat saqlanadi.

### T2. Xato urinish hisoblagichi rollback bilan yo'qolmasin

`login` noto'g'ri PIN'da xato qaytaradi. Agar hisoblagich o'sha UoW ichida oshirilsa va xato tashlansa, tranzaksiya rollback bo'ladi va hisoblagich hech qachon oshmaydi.

**Talab:** muvaffaqiyatsiz urinishni yozish alohida, commit bo'ladigan UoW'da bo'lsin. HTTP xatosi esa undan keyin qaytarilsin.

**Test:** 5 ta noto'g'ri PIN'dan keyin bazada `failed_attempts = 5` va `locked_until_ms` o'rnatilgan. Buni to'g'ridan-to'g'ri SQL bilan tekshir.

### T3. Blokni ochish

`POST /users/:id/unlock` (`owner` va `manager`) foydalanuvchi blokini va hisoblagichini tozalaydi. Rol matritsasiga qo'sh.

### T4. Barcha yozuvlar UoW orqali

LOCAL jadvallarga yozish ham (PIN, sessiya, qurilma holati, hub config) `uow.execute` orqali, o'qish esa `runReadOnly` orqali bo'lsin. Mutex hammasini qamrab olishi kerak.

`local_sessions.last_seen_at_ms` har so'rovda yozilmasin. Uni eng ko'pi daqiqada bir marta yangila, aks holda har so'rov yozish mutexidan o'tadi.

### T5. Username noyobligi

`UNIQUE(organization_id, username)` faqat faol qatorlar uchun bo'lsin: partial index `WHERE deleted_at_ms IS NULL`. Shunda tombstone qilingan nomni qayta ishlatish mumkin bo'ladi. Test bilan.

### T6. Kirish ekrani uchun ro'yxat

Kassada foydalanuvchi ismini tanlaydi va PIN teradi, ya'ni username sir hisoblanmaydi.

- Ochiq `GET /auth/login-options` endpointi faqat faol foydalanuvchilarning `id`, `fullName` va `role` maydonlarini qaytarsin.
- Login `userId` + PIN bilan ham ishlasin.
- Dummy hash avvalgidek qoladi.

## Ochiq savollarga javob

1. **PIN uzunligi:** 6–12 raqam qoladi, kuchsiz ketma-ketliklar taqiqlanadi. Tasdiqlandi.
2. **`/setup` javobi:** sessiya bermaydi, keyin `/auth/login` orqali kiriladi. Tasdiqlandi.

## T0.7 uchun eslatma (hozir qilma)

`Origin: null` rad etilishi to'g'ri. Electron UI keyin maxsus protokol (masalan `app://mezon`) orqali yuklanadi va faqat shu aniq origin `allowedOrigins`ga qo'shiladi. `file://` va `null` hech qachon ruxsat etilmaydi.

## Bajarish tartibi

1. Kodni yoz.
2. `pnpm verify` yashil bo'lsin.
3. Commit, push va PR och.
4. Uchala CI job yashil bo'lsin.
5. Hisobotni `.mezon/gemini/HISOBOT.md` ga yoz, `[gemini-hisobot] T0.6` bilan commit qil va push qil.
6. `node .mezon/kutish.mjs` ni ishga tushir. Merge qilma.
