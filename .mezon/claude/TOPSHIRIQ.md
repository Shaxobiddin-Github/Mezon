# Claude topshirig'i: T1.1 rejasi — TUZATISHLAR BILAN TASDIQLANDI

**Merge tekshiruvi:** T0.7 merge'i tekshirildi. `main` = `0b65a43`, kod `fd07ecb` bilan bir xil.

**F0 yakuniy tekshiruvi:**

- `main` da `pnpm verify` o'tdi.
- Ishlab chiqarish bog'liqliklarida ma'lum zaiflik yo'q.
- Dev vositalarida 3 ta moderate zaiflik bor: esbuild (drizzle-kit orqali), glob (testcontainers), minimatch (eslint, electron-builder). Ular ilovaga kirmaydi. Hozir tegma, alohida texnik vazifa bo'ladi.

**Tasdiqlangan qismlar:**

- jadvallar va sinflar;
- tashkilot darajasidagi katalog;
- birlik qoidasi va property test;
- GS1 nazorat raqamini qat'iy tekshirish (`internal`/`other` istisnosi bilan);
- partial unique shtrix-kod;
- skan natijasi shakli;
- FTS5 yondashuvi;
- RBAC va DTO mapper;
- unumdorlik testi.

Quyidagi tuzatishlar bilan `gemini/T1.1-catalog` branch'ida kodni yoz.

## Majburiy tuzatishlar

### F1. FTS rowid'ga tayanmasin (VACUUM xavfi)

`products` jadvalida `INTEGER PRIMARY KEY` yo'q, kalit TEXT UUID. Bunday jadvalning yashirin `rowid`i `VACUUM` paytida o'zgarishi mumkin. Shunda `rowid` bilan bog'langan FTS (`content=''` yoki external content) noto'g'ri mahsulotlarni qaytaradi.

**Talab:**

- FTS jadvalida mahsulot UUID'si `product_id UNINDEXED` ustuni sifatida saqlansin.
- Natija faqat `product_id` orqali `products`ga bog'lansin.

**Test:** mahsulotlarni qo'sh, o'chir, qayta qo'sh, so'ng `VACUUM` qil. Qidiruv natijalari to'g'ri mahsulot ID'larini qaytaradi.

### F2. FTS so'rovini tozalash (sintaksis in'ektsiyasi)

Kassir kiritgan matn FTS5 `MATCH` sintaksisiga to'g'ridan-to'g'ri tushmasin. `"`, `*`, `-`, `:`, `(`, `NEAR`, `OR`, `AND`, `NOT` kabi kiritmalar xato bermasin va so'rov ma'nosini o'zgartirmasin.

**Talab:**

- So'rov normalizatsiyadan keyin tokenlarga bo'linsin.
- Har token qo'shtirnoq ichida prefiks sifatida berilsin: `"tok"*`, tokenlar orasida AND.
- Bo'sh natija xato emas.

**Test:** jadvalli test, yuqoridagi barcha kiritmalar bilan.

### F3. UPC-A va EAN-13 bitta kod

Skaner sozlamasiga qarab bir xil tovar `036000291452` (UPC-A, 12 raqam) yoki `0036000291452` (EAN-13) bo'lib o'qiladi.

**Talab:**

- UPC-A saqlashda va skan qidiruvida kanonik EAN-13 ko'rinishga keltirilsin: oldiga `0` qo'shiladi.
- Ikkala shakl ham bitta yozuvni topsin.
- Ikkalasi alohida-alohida ro'yxatdan o'tkazilsa, noyoblik buzilishi sifatida rad etilsin.

**Test** bilan.

### F4. Qidiruv indeksi yaxlitligi va qayta qurish

`name_search` va FTS — hosila ma'lumotlar. Ular sinxron orqali boshqa qurilmadan yoki boshqa normalizator versiyasidan kelishi mumkin.

**Talab:**

- `rebuildCatalogSearchIndex()` buyrug'i `name_search`ni joriy normalizator bilan qayta hisoblasin va FTS'ni noldan qursin.
- FTS virtual jadvali va trigger'lar drizzle-kit tomonidan generatsiya qilinmaydi. Shuning uchun `db:check` ular migratsiyada borligini tekshirsin (T0.5 trigger tekshiruvi kabi) va salbiy dalil keltirilsin.

**Property test:** tasodifiy yaratish, tahrirlash, tombstone va qayta yaratish ketma-ketligidan keyin FTS'dagi faol mahsulotlar to'plami `products`dagi faol mahsulotlar bilan aynan teng.

### F5. Transliteratsiya aniqligi

O'zbek kirillidagi `х` → `x` (`h` emas), `ҳ` → `h`. `ъ` (tutuq belgisi) va apostroflar kalitdan olib tashlanadi, `ь` ham olib tashlanadi.

**Testlar:**

- `хона` → `xona`
- `ҳаво` → `havo`
- `маъно` → `mano`
- `Молоко` → `moloko`
- `Coca-Cola Zero` "zero" bilan topiladi

## Ochiq savollarga javob

1. Faol mahsulot yoki bola kategoriyasi bor kategoriyani o'chirish `409 CATEGORY_IN_USE` bilan bloklanadi. Tasdiqlandi.
2. Narx tarixi faqat `owner`/`manager` (`catalog:write`) uchun. Kassirga faqat joriy narx kerak. Tasdiqlandi.

## Bajarish tartibi

1. Kodni yoz.
2. `pnpm verify` yashil bo'lsin.
3. Commit, push va PR och.
4. To'rtala CI job yashil bo'lsin.
5. Hisobotni `.mezon/gemini/HISOBOT.md` ga yoz: p50/p95 o'lchovlari, F1–F5 dalillari va CI havolalari bilan. `[gemini-hisobot] T1.1` bilan commit qil va push qil.
6. `node .mezon/kutish.mjs` ni ishga tushir. Merge qilma.
