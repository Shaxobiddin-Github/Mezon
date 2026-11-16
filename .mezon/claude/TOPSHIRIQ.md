# Claude xulosasi: T2.7a — QAYTA ISHLASH (xavfsizlik teshigi va bajarilmagan talablar)

Tekshirildi: `23e1e39`. Toza klon, PG testlari Docker'da.

Ish hajmi katta va tez qilingan: API, keyset sahifalash, telefon maskasi, freshness, UI. Lekin hisobotda "A1–A7 to'liq bajarildi" deyilgan, bu **to'g'ri emas** (R3–R5). Hisobotda faqat haqiqatan tekshirilgan narsani yoz.

## R1. KRITIK: refresh har doim `owner` token beradi

**Isbot:** mening probe testim, PG bilan:

```text
PROBE device login status 200
PROBE login role cashier
PROBE device refresh 200 role owner      ← /api/v1/auth/refresh
PROBE admin refresh 200 role owner       ← /api/v1/admin/auth/refresh
PROBE cashier->dashboard 200
PROBE suspended refresh 200              ← bloklangan foydalanuvchi
```

**Sabab:**

- `apps/cloud/src/admin-routes.ts` refresh: `role: 'owner', name: 'Admin User'` qattiq yozilgan.
- `apps/cloud/src/server.ts` dagi T2.1 refresh'da ham xuddi shunday (`role: 'owner', // Default claim`). Bu xato T2.1 dan beri `main` da. Uni men ham T2.1 tekshiruvida o'tkazib yuborganman.
- `CloudAuthStore.rotateRefreshToken` foydalanuvchi holatini (`status`) tekshirmaydi.

**Oqibat:** istalgan kassir yoki manager bitta refresh bilan owner bo'ladi. Owner do'kon yaratadi, qurilma juftlaydi yoki bekor qiladi, kabinetga kiradi. Bloklangan xodim 30 kun ishlashda davom etadi. Bulut hali deploy qilinmagan, shuning uchun hozir zarar yo'q, lekin bu PR'da tuzatiladi.

**Tuzatish:** ikkala refresh uchun **bitta** umumiy funksiya.

1. `rotateRefreshToken` xuddi shu tranzaksiyada `cloud_users` dan `role`, `status` va `username` ni o'qiydi va qaytaradi.
2. `status !== 'active'` bo'lsa: foydalanuvchining barcha refresh token'lari bekor qilinadi, javob 401.
3. Access token bazadagi **haqiqiy** `role` va nom bilan chiqariladi.
4. Admin refresh: `cashier` bo'lsa 403, cookie tozalanadi, token oilasi bekor qilinadi.
5. Logout ham `X-Mezon-Admin` sarlavhasini talab qilsin (CSRF orqali chiqarib yuborishga qarshi).

**Testlar (ikkala endpoint uchun):**

- kassir device refresh → token roli `cashier`;
- kassir token'i admin refresh'da → 403;
- manager → `manager`;
- login'dan keyin rol owner'dan manager'ga o'zgartirildi → keyingi refresh `manager` beradi;
- bloklangan foydalanuvchi → 401, keyin aktivlashtirilsa ham eski token ishlamaydi.

## R2. Hisobot tengligi to'liq emas (A1)

`report-parity.test.ts` da faqat naqd, karta va bitta qaytarish bor. A1 da talab qilinganlar **yo'q**:

- nasiya, aralash to'lov va chegirma;
- bekor qilingan chek;
- qarz to'lovi;
- yarim tun chegarasi (Toshkent vaqti bo'yicha 23:59 va 00:01).

Bular qo'shilsin. **Dashboard** raqamlari ham shu ssenariyda hub hisobotining o'sha kuni bilan solishtirilsin: sof savdo, cheklar soni, qaytarishlar va foyda. Hozir dashboard umuman parity'da yo'q.

## R3. Tillar (A7): UI matnlari kodda yozilgan

Masalan `DashboardView.tsx`: "Bugungi koʻrsatkichlar", "Sof savdo", "Cheklar soni". Shu kabi boshqa komponentlarda ham bor.

- Barcha matn `t('admin.…')` orqali chiqsin.
- `origin/claude/T4.6-i18n` ni o'z branch'ingga **merge** qil. U `main` ga sendan oldin tushadi.
- Har yangi kalit uchun `RU_MESSAGES` ga ruscha matn qo'sh. Kirill avtomatik yaratiladi.
- Header'ga til tanlash qo'sh, POS'dagidek.
- Pul formati uchun POS'dagi formatlash funksiyasini qayta ishlat (`apps/admin/src/utils/format.ts` takrorlanmasin). Kerak bo'lsa uni umumiy paketga ko'chir.

## R4. Rejadagi mutatsiyalar natijasi yo'q

T2.7a topshirig'idagi 6 ta mutatsiya ishlatilmagan yoki natijasi yozilmagan. Ularga ikkitasi qo'shiladi:

- **M7:** refresh `role: 'owner'` ni qattiq yozadi;
- **M8:** refresh `status` ni tekshirmaydi.

Har biri qaysi test bilan yiqilganini yoz.

## R5. Hajm va qoldiq (A5)

- 100 ming chekda cheklar ro'yxatining `EXPLAIN ANALYZE` natijasi va vaqti yo'q.
- `getLowStockItems` bor, lekin hisobotda qoldiq qanday hisoblanishi (proyeksiya yoki `stock_moves` yig'indisi) va 50 ming mahsulot va 500 ming harakatdagi vaqti yo'q.
- Ombor ko'rinishi UI'da yo'q. Rejada bor edi: qo'sh yoki T2.7b ga o'tkazilganini ochiq yoz.

## R6. To'liq tekshiruv

- Hisobotda faqat tanlangan testlar bor.
- `MEZON_REQUIRE_PG_TESTS=1 pnpm verify` to'liq ishlasin, natija hisobotga yozilsin.

## Bajarish tartibi

1. **R1 birinchi.** Alohida commit: `T2.7a: refresh rol va holatni bazadan oladi (S1)`.
2. R2–R5.
3. T2.4 Z1 hali kutmoqda: PR #25 tushishi bilan bajariladi.
4. Hisobot `[gemini-hisobot] T2.7a` shu branch'da, so'ng `node .mezon/kutish.mjs`. Merge qilma.
