# Claude topshirig'i: T0.7 QABUL → F0 yakuni → T1.1 rejasi

## 1. T0.7 xulosasi: QABUL (kod `1d61486`)

Claude tekshirdi:

- `pnpm verify` o'tdi.
- `app://mezon` uchun 401 javoblarida ham CORS sarlavhasi bor.
- `win-unpacked` qayta yig'ildi, `verify:fuses` va Playwright E2E o'tdi (ruxsatlar rad etilishi va xato javoblarini o'qish bilan).

## 2. Merge

1. `git pull --ff-only`.
2. PR #7 boshi Claude'ning shu topshiriq commit'i bo'lsin. To'rtala CI job yashil bo'lsin.
3. `T0.7: Electron qobig'i va Windows o'rnatuvchi` nomi bilan Squash and merge qil, SHA'ni yoz va branch'ni o'chir.
4. `main`dan `gemini/T1.1-catalog` branch'ini och.

**F0 bosqichi shu bilan yakunlanadi.** Claude `main` ustida F0 bo'yicha alohida yakuniy tekshiruv o'tkazadi. Unda topilgan narsalar keyingi topshiriqlarda alohida beriladi. Sen T1.1 rejasini davom ettir.

## 3. T1.1 — Katalog: avval REJA

Kod yozma. Rejani `.mezon/gemini/HISOBOT.md` ga yoz, `[gemini-reja] T1.1` bilan commit qil va push qil, so'ng `node .mezon/kutish.mjs` bilan kut.

GEMINI.md T1.1: mahsulot, kategoriya, variant (JSON atributlar), bir nechta shtrix-kod, birliklar (dona, kg, g, litr, metr, m², qadoq), `unlimited` (xizmat/cheksiz), `min_stock`, narx tarixi, qidiruv va skan indekslari. Mezonlar:

- 50 000 mahsulotda skan ≤ 20 ms (domen va baza qismi);
- bitta shtrix-kod faqat bitta yozuvga bog'langan.

Rejada quyidagilar aniq bo'lsin:

### a) Jadvallar va sinflar

- `categories`, `products`, `product_variants`, `product_barcodes`: ATTR, T0.5 yozish yordamchilari va outbox orqali.
- Narx tarixi `price_changes`: FACT, har narx o'zgarishida o'sha UoW ichida yoziladi.
- Katalog tashkilot darajasida bo'ladi. Do'kon bo'yicha alohida narx F5'da. Agar boshqacha taklif qilsang, asosla.
- Fiskal uchun kerakli maydonlar hozirdan bo'lsin (GEMINI.md 8-bo'lim): `mxik` va `package_code` (nullable), `vat_rate_bp` (VatRate).
- Pul uchun `sqliteMoney`, miqdor uchun `sqliteQuantity` ishlatilsin. `real` ishlatilmasin.

### b) Birlik va miqdor qoidasi (domen)

- `dona` va `qadoq` uchun miqdor faqat butun son bo'lsin (`Quantity` 1000 ga karrali). `kg`/`litr`/`metr`/`m²` uchun 0.001 aniqlik.
- Qoida `packages/domain`da sof funksiya bo'lsin va property test bilan tekshirilsin.

### c) Shtrix-kod

- Normalizatsiya: bo'shliqlarni olib tashlash va faqat ruxsat etilgan belgilar.
- EAN-13/EAN-8/UPC-A uchun nazorat raqami tekshiruvi. Noto'g'ri nazorat raqami ogohlantirish beradimi yoki rad etiladimi: tanlovni asosla. Ichki do'kon kodlari ham qo'llab-quvvatlanadi.
- Noyoblik: faol shtrix-kodlar orasida tashkilot bo'yicha noyob (partial unique index, `deleted_at_ms IS NULL`).
- Tarozi yorlig'i (EAN-13 ichida og'irlik yoki narx, `2x` prefiks) T5.8'da bo'ladi. Lekin skan qidiruv funksiyasi hozirdan `{ product, variant?, quantity? }` qaytaradigan qilib loyihalansin, keyin kengaytirish oson bo'lsin.

### d) Nom bo'yicha qidiruv

- O'zbek tilining real holati: lotin va kirill aralash, `o'`/`g'` apostrof variantlari (`'`, `ʻ`, `ʼ`, `‘`).
- Qidiruv uchun normalizatsiya funksiyasi `packages/domain`da bo'lsin: kirill → lotin, apostroflarni birxillashtirish, katta-kichik harf. Testlar bilan.
- SQLite FTS5 yoki boshqa yondashuv: tanlovni asosla. Maqsad: 50 000 mahsulotda nom qidiruvi p95 ≤ 50 ms.

### e) Hub API va RBAC

- Mahsulot va kategoriya CRUD: `owner`, `manager`.
- O'qish va skan qidiruvi: `cashier` ham.
- Zod kontraktlari `@mezon/contracts`da.
- Javoblarda kassirga tannarx ko'rsatilmaydi (GEMINI.md 3.4). Tannarx T1.2 partiyada bo'ladi, lekin DTO hozirdan shunga tayyor tursin.

### f) Unumdorlik testi

- 50 000 mahsulot va 70 000 shtrix-kod bilan seed.
- Skan va nom qidiruvining p50/p95 qiymatlari o'lchansin va hisobotga yozilsin.
- CI'da sekin kompyuter uchun chegara oqilona bo'lsin, lekin regressiyani ushlasin.

### g) Doiradan tashqari

Ombor qoldig'i va partiya (T1.2), narx aksiyalari (T1.3), UI (T1.11).
