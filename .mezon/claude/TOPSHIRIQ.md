# Claude topshirig'i: T1.2 rejasi — TUZATISHLAR BILAN TASDIQLANDI

**Merge tekshiruvi:** T1.1 merge'i tekshirildi. `main` = `a5bba26`, kod `d5ccfce` bilan bir xil.

**Rejaning tasdiqlangan qismlari:**

- test qarzi commit'i;
- ledger va jadvallar;
- qiymatga asoslangan hisob (`remaining_qty` + `remaining_value`, oxirgi chiqim qolgan qiymatni oladi). Ikkala qo'lda hisoblangan misol tekshirildi va to'g'ri;
- partiyasiz kamomad va `cost_variance_value`;
- `warn` standart siyosat;
- HLC bo'yicha qayta qurish;
- snapshot'lar o'zgarmasligi;
- RBAC va kassirdan tannarx yashirilishi.

Quyidagi tuzatishlar bilan `gemini/T1.2-stock` branch'ida kodni yoz.

## Majburiy tuzatishlar

### S1. Inventarizatsiya: kutilgan qoldiq har qator sanalgan paytda olinsin

Bu Claude'ning oldingi ko'rsatmasidagi xato, uni tuzat. Kutilgan qoldiqni sanoq boshlanganda olish noto'g'ri.

**Misol:**

1. Sanoq ochilganda qoldiq 10.
2. 2 dona sotildi, ombordagi haqiqiy qoldiq 8.
3. Kassir shundan keyin sanab 8 kiritdi.
4. Reja formulasi: `8 − 10 = −2`, yakuniy qoldiq `10 − 2 − 2 = 6`. **Noto'g'ri, to'g'ri javob 8.**

**Talab:**

- `counted_qty` kiritilgan (yoki yangilangan) paytda shu UoW ichida o'sha paytdagi ledger qoldig'i `expected_qty_at_count` sifatida yozilsin.
- Yakunlashda `adjustment = counted_qty − expected_qty_at_count`.
- Sanalgandan keyin bo'lgan savdolar ledgerda allaqachon bor, shuning uchun ular ikki marta hisoblanmaydi.

**Testlar:**

- (a) 10 → 2 sotildi → 8 sanaldi → yakun 8;
- (b) 10 → 9 sanaldi → keyin 2 sotildi → yakunlandi → yakun 7;
- (c) bir qatorni ikki marta qayta sanash: oxirgi kiritishdagi snapshot ishlatiladi.

Qisman sanoq: `counted_qty` NULL bo'lgan qatorlar hech qanday tuzatish yaratmaydi. Sanalmagan mahsulotlar nolga tushirilmaydi. Test bilan.

### S2. Qayta qurish hech qachon yiqilmasin

Proyeksiyani qayta qurish yiqilsa, kassa ishlamay qoladi. `local_batch_balances.remaining_qty >= 0` kabi CHECK'lar qayta qurishni to'xtatib qo'yishi mumkin. Masalan, bitta partiyani ledgerdagi ikki chiqim ortiqcha ishlatgan bo'lsa (sinxron xatosi yoki qo'lda o'zgartirilgan baza).

**Talab:**

- Proyeksiya jadvallarida qayta qurishni yiqitadigan CHECK bo'lmasin.
- Partiyadan ortiqcha chiqim kamomadga o'tsin.
- Har bir bunday holat uchun `local_stock_conflicts` (LOCAL) jadvaliga yozuv tushsin: mahsulot, partiya, miqdor, sabab. Egasi uni keyin ko'radi.

**Test:** xom SQL bilan partiyani ortiqcha ishlatadigan FACT yozuv qo'shilgandan keyin `rebuildStockProjections()` muvaffaqiyatli tugaydi va konflikt yozuvi paydo bo'ladi.

**Arxitektura qoidasi:** `stock_moves` va `batches` faqat o'sha do'kon hub'ida yoziladi (bitta yozuvchi). Buni sxema izohida va GEMINI.md 4-bo'limida qayd et. Bulut tomonida majburlash F2'da bo'ladi.

### S3. Yakunlangan sanoq qatorlari ham o'zgarmasin

`inventory_counts` trigger'i bor, lekin `inventory_count_lines` ota sanoq `finalized`/`cancelled` bo'lgandan keyin ham o'zgartirilishi mumkin.

**Talab:** `BEFORE INSERT/UPDATE` trigger ota holatini tekshirsin va o'zgartirishni rad etsin. Xom SQL testi bilan.

### S4. Musbat inventarizatsiya tuzatishining tannarxi

Sanoqda ortiqcha tovar chiqsa (musbat tuzatish), uning qiymati qanday aniqlanishini rejada yoz va test qil:

- FIFO tovarda yangi partiya `last_unit_cost` bilan yaratiladi;
- o'rtacha tannarxli tovarda joriy o'rtacha qiymat ishlatiladi;
- tannarx ma'lum bo'lmasa 0 olinadi va konflikt sifatida belgilanadi.

## Ochiq savollarga javob

1. `products.track_batches` va harakat bo'lgandan keyin uni almashtirishni `409 STOCK_COSTING_LOCKED` bilan bloklash — tasdiqlandi.
2. F1'da ombor o'rniga `store_id` ishlatiladi, ko'p ombor F5'da — tasdiqlandi.

## Bajarish tartibi

1. Birinchi commit: test qarzi.
2. T1.2 kodi.
3. `pnpm verify` yashil.
4. Commit qil, push qil va PR och. To'rtala CI job yashil bo'lsin.
5. Hisobot: S1–S4 dalillari, property test tavsifi, qo'lda hisoblangan misollarning test nomlari. `[gemini-hisobot] T1.2` bilan commit qil va push qil.
6. `node .mezon/kutish.mjs` ni ishga tushir. Merge qilma.
