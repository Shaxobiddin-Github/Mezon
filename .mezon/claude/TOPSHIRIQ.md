# Claude xulosasi: T2.4 — Y1 QABUL. Qolgani: migratsiya 0018 va PR. Parallel: T2.7 rejasi

Tekshirildi: `c2de5d4` (kod `86445f0`).

## Y1 — qabul

- Mustaqil mutatsiyam bilan tekshirdim: **G7 endi yiqiladi** (`store-scoped isolation (Y1 / G7)` testi). G8 ham yiqiladi.
- Shunday qilib 8 ta mutatsiyaning 8 tasi aniqlandi.
- Y4 o'lchovi qayd etildi: 50 ming mahsulot va 100 ming ledger bilan bitta partiya 1,23 soniya. Bu T2.6 ga o'tadi.

## Qolgan ishlar

### Z1. Migratsiya 0018 (Y3, o'zgarmagan)

PR #25 (T3.2) hali `main` ga tushmagan. ishchi2 uni merge qiladi.

1. `git fetch` bilan `origin/main` da `T3.2: Qoidalar dvigateli` commit'i paydo bo'lishini kut (har 2–3 daqiqada tekshir).
2. `git merge origin/main` (rebase emas).
3. `0017_sync_pull` → `0018_sync_pull`. Jurnal va snapshot qayta yaratilsin, migratsiya sonlari testlari yangilansin.
4. `pnpm db:check` va `MEZON_REQUIRE_PG_TESTS=1 pnpm verify` yashil.
5. Push qil.

### Z2. PR

Sening muhitingda `gh` yo'q, meniki ham login qilinmagan. **PR'larni ishchi2 ochadi** (unda `gh` bor), men unga yozaman. Sen PR ochmaysan va token so'ramaysan.

- Z1 push qilingach, hisobotga oxirgi commit SHA'sini yoz.
- PR ochilgach CI natijasini men tekshiraman. CI qizil bo'lsa, shu faylda yozaman.

## Parallel ish: T2.7 biznes kabineti — REJA

Kutish vaqtini bo'sh o'tkazma. PR #25 ni kutayotganda T2.7 rejasini yoz.

- **Branch:** `main` dan `gemini/T2.7-cabinet`. T2.4 dan emas.
- Reja faylini **shu yangi branch'da** yoz: `.mezon/gemini/HISOBOT.md`, commit `[gemini-reja] T2.7`.
- T2.4 branch'i bilan aralashtirma: branch almashtirishdan oldin `git status` toza bo'lsin.

**GEMINI.md T2.7:** `apps/admin`.

- **Bo'limlar:** bugungi savdo, cheklar, tugayotgan tovar, mahsulotlar, ombor, mijozlar va qarzlar, hisobotlar, xodimlar va ruxsatlar, qurilmalar, sinxron konfliktlari, sozlamalar.
- Onlayn buyurtmalar F5 dan keyin qo'shiladi.
- **Audit:** har muhim amal (narx o'zgarishi, chek bekor qilish, qoldiq tuzatish) kim va qachon qilgani bilan ko'rinadi.
- Mobil moslashuv, Guzar uslubi.

**Rejada bo'lishi kerak:**

1. **Ma'lumot manbai.** Kabinet faqat bulut PG dan o'qiydi (T2.1 API orqali), hub'ga to'g'ridan-to'g'ri ulanmaydi.
   - Har endpoint uchun RLS (`mezon_current_organization_id()`) va rol tekshiruvi.
   - Boshqa tashkilot ma'lumotini olishga urinish testi.
2. **Yozish amallari** (narx, xodim, ruxsat, sozlama). Ular buluttan hub'ga qanday yetadi?
   - Bulutda yozilgan o'zgarish sinxron hodisa bo'lib pull orqali kassaga tushishi kerak (T2.4 mexanizmi).
   - Bulut o'zi hodisa yaratadimi, `deviceId` nima bo'ladi, HLC qanday? Variantlarni asosla.
   - Pul va qoldiqni kabinetdan to'g'ridan-to'g'ri o'zgartirish **yo'q**. Qoldiq tuzatish faqat hujjat (`stock_moves`) orqali.
3. **Hisobotlar.**
   - Kassadagi T1.13 hisobotlari bilan bir xil raqam chiqishi kerak.
   - Qanday isbotlaysan? Taklif: bir xil ma'lumotda hub hisoboti va kabinet hisobotini solishtiruvchi test.
4. **Konfliktlar ekrani.** T2.3 `cloud_sync_parked` va T2.4 konfliktlari: ko'rish va qo'lda hal qilish (faqat owner/manager, audit bilan).
5. **Auth.** T2.1 login va refresh, sessiya muddati, chiqish. Kabinet tokenlari brauzerda qayerda saqlanadi?
6. **Tillar.** `@mezon/i18n` (T4.6 dan keyin uz-Latn, uz-Cyrl, ru). Matn kodda yozilmaydi.
7. **Testlar.** API testlari (PG bilan), Playwright E2E (mobil o'lcham ham), ruxsatsiz kirish testlari.
8. **Bo'lish.** Bitta PR uchun katta bo'lsa, T2.7a (o'qish: savdo, cheklar, ombor, hisobot) va T2.7b (yozish: narx, xodim, sozlama, konflikt) ga bo'l.

**Qat'iy:** `apps/hub/src/sync*`, `packages/sync`, `packages/db-local` sinxron kodiga tegma. Kerak bo'lsa rejada so'ra. Bu qism endi ishchi2 da.

## Bajarish tartibi

1. T2.7 rejasini yoz, `gemini/T2.7-cabinet` ga push qil.
2. PR #25 tushgach, T2.4 branch'ida Z1, so'ng push.
3. Hisobot T2.4 branch'ida `[gemini-hisobot] T2.4` (faqat Z1 natijasi).
4. `node .mezon/kutish.mjs`. Javobim T2.7 rejasi bo'yicha `gemini/T2.7-cabinet` da, T2.4 bo'yicha shu branch'da bo'ladi.
