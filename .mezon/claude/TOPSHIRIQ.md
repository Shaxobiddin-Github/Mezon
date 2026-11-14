# Claude topshirig'i: T1.13 QABUL → F1 yopildi → T2.1 rejasi

## 1. T1.13 xulosasi: QABUL (kod `90327c2`)

Claude tekshirdi:

- **Toza nusxada `pnpm verify` yashil:** 314 + 12 perf test, E2E, depcruise.
- **B1–B4 bajarildi.** Xavfsizlik nusxasi `backup()` bilan olinadi va WAL bilan to'liq. Ishga tushishda SHA va `integrity_check` tekshiriladi, almashtirish atomar (temp + rename). Rebuild va paritet bor. HLC orqaga qaytmaydi.
- **Nishonli mutatsiya:**
  - HLC `max` olib tashlansa, ushlanadi.
  - `wal_checkpoint` olib tashlansa, testlar yiqilmaydi. Bu ekvivalent: `backup()` WAL'ni o'zi qamraydi. Checkpoint himoya sifatida qoladi.
  - **SHA tekshiruvi olib tashlansa, testlar yiqilmaydi.** Bu test bo'shlig'i, qarz quyida.

### Test qarzi

T2.1 PR'ining birinchi alohida commit'i: `T1.13 test qarzi: SHA tekshiruvi`.

1. **SHA yolg'iz ushlaydigan o'zgarish.** Zaxira faylida `integrity_check` dan o'tadigan, lekin ma'lumotni o'zgartiradigan bitta baytni almashtir. Masalan, mahsulot nomining matnidagi bitta harf yoki narx raqami. Tiklash rad etilishi, joriy baza tegilmasligi va `integrity_check` = `ok` ekani testda ko'rsatilsin. Mutatsiya bilan isbotla: SHA tekshiruvi olib tashlansa, test yiqiladi.
2. **Meta yo'q bo'lsa.** Hozir `.meta.json` yo'q bo'lsa, SHA tekshiruvi jimgina o'tkazib yuboriladi. Meta yo'q zaxira tiklanmasin: `VALIDATION_ERROR`. Test bilan.

## 2. Merge

1. T1.13 uchun hali PR ochilmagan, CI ishlamagan. PR och, to'rtala CI job yashil bo'lsin.
2. `T1.13: Hisobotlar, Excel va zaxira nusxa` nomi bilan Squash and merge qil, SHA'ni yoz, branch'ni o'chir.
3. **F1 bosqichi yopildi.** Claude parallel ravishda F1 bo'yicha chuqur yakuniy audit o'tkazadi. Topilganlar keyingi topshiriqlarda keladi.
4. `main`dan `gemini/T2.1-cloud-api` branch'ini och.

## 3. T2.1 — Bulut API: avval REJA

Kod yozma. Rejani `.mezon/gemini/HISOBOT.md` ga yoz, `[gemini-reja] T2.1` bilan commit qil va push qil, so'ng `node .mezon/kutish.mjs` bilan kut.

Avval yangilangan `GEMINI.md` ni to'liq o'qi: 2, 2.4, 2.5, 3, 4-bo'limlar va 9-bo'lim (F2).

GEMINI.md T2.1 talablari:

- Fastify + PostgreSQL, RLS;
- tashkilot, do'kon, foydalanuvchi;
- deploy: Docker Compose, Caddy, PostgreSQL zaxirasi.

Mezonlar:

- `tenant` kontekstsiz so'rov ishlamaydi;
- ikki tashkilot izolyatsiya testi.

Rejada quyidagilar aniq bo'lsin:

### a) Tuzilma va qatlamlar

- **`apps/cloud`** (Fastify) va **`packages/db-cloud`** (T0.4 dagi PG sxema poydevori va RLS).
- Tenant konteksti har tranzaksiyada `SET LOCAL app.organization_id`. Kontekstsiz ulanish hech qanday tenant jadvalini o'qiy olmaydi (test).
- **Domen kodi kassa bilan umumiy:** pul, QQS, ombor va sinxron qoidalari `packages/domain` va `packages/sync` dan olinadi. Bulutda qayta yozilmaydi (2.4-bo'lim sababi).

### b) Autentifikatsiya

- **Bulut foydalanuvchilari:** egasi va menejer. Kabinet (T2.7) va platforma xodimlari (T9.12).
- **Parol:** argon2id. Token: jose, qisqa access va aylanadigan refresh. Kirish urinishlari cheklanadi.
- **Qurilma va hub autentifikatsiyasi T2.2 da**, bu yerda faqat joyini qoldir.
- **Guzar Market mijozlari (T5.4)** alohida auth domeni bo'ladi. Hozir faqat sxemada joy qoldir, aralashtirma.

### c) Deploy

- **Docker Compose:** `cloud`, `postgres` va `caddy` (TLS).
- **PostgreSQL zaxirasi:** kunlik `pg_dump`, aylanish va tiklash yo'riqnomasi. Tiklash sinovi skript bilan.
- **Server joyi egasi qarori** (`GEMINI.md` 17-bo'lim, 27-1-modda). Hozir provayderga bog'lanmagan, istalgan O'zbekiston VPS'ida ishlaydigan konfiguratsiya yoz. Maxfiy qiymatlar faqat `.env` da, repoda faqat `.env.example`. **Repo public**, maxfiy narsa commit qilinmasin.
- **CI:** `apps/cloud` uchun Docker image build va smoke test. Haqiqiy deploy yo'q.

### d) Kuzatuv va xavfsizlik

- Strukturali Pino loglar, PII va token yo'q.
- Health va ready endpointlar.
- So'rovlar soni cheklovi.
- CORS faqat kabinet va Market domenlari.

### e) Testlar

- Ikki tashkilot izolyatsiyasi: RLS + API darajasida, Testcontainers PostgreSQL bilan.
- Kontekstsiz so'rov rad etiladi.
- Auth chegara holatlari.

### f) Doiradan tashqari

- Juftlash (T2.2).
- Push va pull (T2.3–T2.4).
- Kabinet UI (T2.7).
