# Nazoratchi xulosasi (ishchi2): T3.1 — KICHIK QAYTA ISHLASH, so'ng QABUL

Tekshirildi: `82fea7e` (kod `ba0f53a`). Toza klonda, PostgreSQL testlari Docker bilan.

**Natija:**

- `pnpm verify`: unit va sqlite-hub 417/417 o'tdi.
- Perf testida bitta yiqilish bo'ldi: FTS p95 71 ms, chegara 50 ms. Shu kompyuterda Gemini parallel test ishlatayotgan edi. Test alohida ishga tushirilganda T3.1 da ikki marta va `main` da o'tdi, demak bu yuk. T3.1 ga aloqasi yo'q.
- PR #24 CI: to'rt job ham yashil.

Ish juda yaxshi. Hisobot halol (M1/M2 skript xatosi ochiq yozilgan). Snapshot testi kuchli. Eksportdagi tiyin kesilishi va shtrix-kod ustunining yo'qligi topilib tuzatilgani ayniqsa foydali.

**Mening mustaqil mutatsiyalarim:**

| # | Mutatsiya | Natija |
|---|---|---|
| MU1 | Buyurtmaning katalog qatori `isVatPayer` ni e'tiborsiz qoldiradi | **OMON QOLDI** |
| MU2 | Buyurtmaning tez savdo qatori `isVatPayer` ni e'tiborsiz qoldiradi | **OMON QOLDI** |
| MU3 | Savat katalog qatori bayroqni e'tiborsiz qoldiradi | aniqlandi |
| MU4 | `refresh-prices` eski QQS'ni saqlaydi | aniqlandi |
| MU5 | Excel'da bo'sh QQS katagi tashkilot standartini olmaydi | aniqlandi |
| MU6 | Profil o'qishda `deleted_at_ms IS NULL` sharti olib tashlanadi | **OMON QOLDI** |

Kod to'g'ri, lekin MU1 va MU2 yo'llari testsiz. Mening qoidam: test qarzi bilan merge yo'q.

## Tuzatishlar

### K1. Buyurtma yo'li testlari (MU1, MU2)

Tashkilot QQS to'lovchisi **emas** holatiga o'tgandan **keyin** yangi buyurtma yaratiladi:

- katalog qatori;
- tez savdo qatori (aniq `vatRateBp: 1200` so'ralgan holda ham).

Tekshiriladi:

- buyurtma qatorlarining snapshot'i 0;
- `deliver` dan keyingi sotuv qatorlari ham 0.

Qayta QQS to'lovchisiga o'tilsa, avval yaratilgan bu buyurtma 0 da qoladi. MU1 va MU2 ni qayta ishga tushir va hisobotga yoz.

### K2. O'chirilgan profil (MU6)

Profil id'si deterministik (`id = organization_id`). Sinxron orqali `deleted_at_ms` qo'yilgan profil kelsa, `upsertProfile` uni "yo'q" deb ko'radi va o'sha id bilan INSERT qiladi. Natijada PK xatosi chiqadi.

Ikkala yo'lning birini tanla va test bilan isbotla:

- profilni o'chirish umuman taqiqlanadi (`deleted_at_ms IS NULL` CHECK);
- yoki upsert qatorni id bo'yicha topadi va qayta tiklaydi.

**Test:** profil yaratiladi, `deleted_at_ms` to'g'ridan-to'g'ri SQL bilan qo'yiladi (sinxron qo'llashni taqlid qiladi), so'ng `PUT /settings/tax` → xato yo'q, natijada bitta faol profil.

## Savollaringizga javoblar

- **2-taxmin** (`refresh-prices` QQS'ni qayta qo'llaydi): **to'g'ri**. Bu foydalanuvchining ochiq amali, katalogdan nom va narx bilan birga effektiv stavkani ham qayta oladi.
- **3-taxmin** (`sqlite_master` tekshiruvi): qabul qilindi. Kelgusida eski sxemadagi test o'z ma'lumotlarini SQL bilan yaratadigan qilib qayta yozilsa, bu tekshiruvni olib tashlaymiz. Hozircha qarz sifatida qolsin.
- **Bulut jufti (S1): qaror o'zgardi.** T3.1 deyarli tayyor, T2.3 esa katta qayta ishlashda. Shuning uchun:
  - **T3.1 birinchi bo'lib `main` ga tushadi** (faqat lokal qism, migratsiya `0015`).
  - Gemini T2.3 ni rebase qilganda o'z migratsiyasini `0016` ga ko'chiradi. `organization_tax_profiles` uchun bulut jadvali va sync sxemasini ham Gemini qo'shadi, chunki T2.3 dagi sxema mosligi testi buni talab qiladi. Buni Gemini'ga men yetkazaman.
  - Sen `packages/db-cloud` ga **tegmaysan**. Avvalgi ruxsat bekor.

## Bajarish tartibi

1. K1 va K2, testlari bilan. `pnpm verify` yashil bo'lsin.
2. Commit qil va push qil. PR #24 dagi CI yashil bo'lsin.
3. Hisobot `[ishchi2-hisobot] T3.1`: K1 va K2 test nomlari, MU1, MU2 va MU6 qayta natijasi. Faqat o'zgargan qismini yoz.
4. `node .mezon/kutish.mjs 120 .mezon/claude/TOPSHIRIQ-ishchi2.md`. Merge qilma: QABUL bilan merge ko'rsatmasini beraman. Shu topshiriqda keyingi vazifa (T3.2 rejasi) ham bo'ladi.
