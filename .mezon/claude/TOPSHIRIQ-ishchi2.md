# Nazoratchi xulosasi (ishchi2): T3.1 rejasi — TUZATISHLAR BILAN TASDIQLANDI

Reja juda yaxshi. Boshlang'ich holat aniq yozilgan, snapshot yo'llari to'liq ro'yxat qilingan, mutatsiya jadvali tayyor. Excel'dagi `parseFloat` topilmasi va eksport/import ustunlari nomuvofiqligi ham to'g'ri aniqlangan.

Quyidagi qarorlar va tuzatishlar bilan `ishchi2/T3.1-mxik` branch'ida kodni yoz.

## Savollarga javoblar

### S1. Variant B: bulut jufti seniki, lekin cheklangan ruxsat bilan

Gemini T2.3 ni qayta ishlayapti. Unda yangi talab bor: har sinxron jadvalning Zod sxemasi lokal va bulut ustunlariga teng ekanini tekshiruvchi test. Shuning uchun lokal jadvalni bulut juftisiz `main` ga qo'shib bo'lmaydi: test yiqiladi yoki sinxron hodisa rad etiladi.

- Faqat `organization_tax_profiles` uchun ruxsat:
  - `packages/db-cloud/src/schema/domain-tables.ts` ga jadval;
  - bulut migratsiyasi;
  - `packages/contracts/src/sync.ts` ga payload sxemasi va kerak bo'lsa reference/registry yozuvi.
- Boshqa sinxron kodga tegilmaydi.
- **Tartib:** avval lokal qism (1–7 bandlar). Bulut jufti uchun T2.3 `main` ga tushishini kut, keyin rebase qil va qo'sh. Tushganini senga topshiriq orqali xabar qilaman. T2.3 kechiksa, lokal qismni tugatib hisobot ber: T3.1 ni ikki commit'da qabul qilamiz.
- PG testlari senda lokal ishlamaydi. Ularni CI ishga tushiradi, men esa tekshiruvda o'zimda ishga tushiraman.

### S2. Tasdiqlandi

- `is_vat_payer = 0` bo'lsa, snapshot stavkasi 0 bo'ladi, mahsulotning o'z stavkasi o'zgarmaydi. Yagona yordamchi `effectiveVatRate`.
- U qo'llanadigan joylar: katalog qatori, tez savdo qatori (`local_hub_config.quick_sale_default_vat_rate_bp` ham shu funksiyadan o'tadi), buyurtma qatori va buyurtmadan sotuvga o'tish.
- Chekdagi matn T3.4 ga qoladi.

### S3. Umumiy validatsiya qoladi

Rasmiy MXIK formati hujjatsiz kiritilmaydi. MXIK'siz ro'yxat va ogohlantirish yetarli.

### S4. T3.1 ichida qil

Narx, `minStock` va QQS float'siz o'qilsin. Domen'dagi mavjud pul va miqdor parser'idan foydalan, yangisini yozma. Testlar:

- `"1 500,50"`, `"1500.5"`, `"0.005"`, raqam emas, manfiy, juda katta qiymat;
- Excel raqamli katakchasi (number tipi) uchun aniq natija yoki aniq qator xatosi.

### S5. Docker

Qabul qilindi, egasiga yetkazaman. Sening yo'lagingni to'xtatmaydi.

## Majburiy tuzatishlar

### T1. Profil identifikatori deterministik bo'lsin

Ikki hub oflayn holatda bir vaqtda profil yaratsa, ikki xil `id` paydo bo'ladi. Ular sinxronda `UNIQUE (organization_id)` ga uriladi, va bitta tashkilotda ikki STIR kabi holat yuzaga keladi.

- Profil `id` = `organization_id`. Ikkala hub bir xil yozuvni yaratadi, keyin HLC bo'yicha LWW.
- **Test:** ikki mustaqil SQLite bazasida bir xil tashkilot uchun profil yaratiladi → ikkalasining `id` si teng.

### T2. Profil o'zgarishi faqat yangi qatorlarga ta'sir qiladi

`is_vat_payer` yoki `default_vat_rate_bp` o'zgarsa:

- yopilgan cheklar, savatdagi mavjud qatorlar va tasdiqlangan buyurtmalar o'zgarmaydi;
- faqat yangi qo'shilgan qatorlar yangi qiymatni oladi.

6-bo'limdagi jadvalga "profil o'zgarishi" ssenariysini ham qo'sh.

### T3. Kim o'zgartirgani ko'rinsin

- STIR, QQS holati va yuridik nom o'zgarishi muhim amal. Har yozuv outbox hodisasida `userId` bilan bo'lsin.
- Hub'da oxirgi o'zgartirgan foydalanuvchi va vaqt saqlansin: `updated_by_user_id`.
- To'liq audit jurnali T3.8 da bo'ladi.

## Bajarish tartibi

1. Lokal qism: profil, API, POS formasi, Excel, MXIK'siz ro'yxat, snapshot va QQS testlari, T1–T3.
2. `pnpm verify` yashil (PG testlari skip bo'ladi, bu normal).
3. Commit qil va push qil. PR och (`main` ga). CI yashil bo'lsin.
4. Hisobot `[ishchi2-hisobot] T3.1`: har mezon va T1–T3 uchun test nomi, 9-bo'limdagi mutatsiya natijalari, Excel aylanma testi.
5. `node .mezon/kutish.mjs 120 .mezon/claude/TOPSHIRIQ-ishchi2.md`. Merge qilma.
