# Nazoratchi topshirig'i (ishchi2): T3.2 — egasining javoblari va qamrov o'zgarishi

> **Git bo'yicha eslatma.** Bu `[claude]` commit sen T3.2a ni yozayotgan paytda qo'shildi. Push'dan oldin `git pull --ff-only` "diverged" desa, `git pull --rebase` qil. Faqat bu fayl o'zgargani uchun bu ruxsat etilgan istisno. `[claude]` commit'ni o'zgartirma, o'z commit'laringni uning ustiga qo'y.

Egasi qonuniy savollarga (S1–S8) javob berdi. **T3.2a ning qolgan qismi o'zgarmaydi** (7f83451 dagi tasdiq kuchda), faqat quyidagilar o'zgaradi.

## Egasining javoblari

| # | Savol | Javob |
|---|---|---|
| S1 | MXIK ro'yxatlari manbasi | Soliq qo'mitasi ro'yxati. Uni platforma (egasi) yangilab turadi, bitta paket **barcha tashkilotlarga** amal qiladi |
| S2 | Imzo kaliti | Egasi saqlaydi. Imzolash egasining CLI'si bilan oflayn qilinadi (`scripts/rules-sign.mjs`) |
| S3 | Naqd pulga taqiqlangan tovar | Bugungi kunda yo'q. Qoida ma'lumotga asoslangan holda qoladi, haqiqiy ro'yxat bo'sh |
| S4 | Naqd limit | 25 mln **bekor qilingan**. Limit **176 mln so'm (400 BHM)**. Naqd qismiga yoki MXIK umumiy summasiga qo'llanishi hali aniq emas, shuning uchun bu paketda sozlanadi |
| S5 | Retsept | Rasmiy retsept blankasi majburiy, lekin kassa uni **tekshirmaydi**. Qoida yozilmaydi |
| S6 | Ijtimoiy karta | Turlari noma'lum. **Keyinga qoldirildi** |
| S7 | Yaroqlilik muddati | Aynan bugun tugaydigan tovar sotiladi. Muddati o'tgan tovar **ogohlantirish** beradi, bloklanmaydi: do'kon uni rasxod sifatida chiqarishi mumkin |
| S8 | Naqdsiz chekni naqd qaytarish | Ruxsat. Qoida yozilmaydi |

## T3.2a ga o'zgarishlar

1. **Ijtimoiy karta olib tashlanadi.** `SOCIAL_CARD_DATA_REQUIRED`, ijtimoiy karta formasi, maydonlari va saqlash qismi T3.2a dan chiqadi. Ijtimoiy karta uchun yangi sinxron ustun yoki jadval **qo'shilmaydi**. Agar allaqachon yozilgan bo'lsa, olib tashla. Natijada T3.2a da bulut jufti kerak bo'lmasligi mumkin: hisobotda aniq yoz.
2. **`EXPIRED_GOODS` endi warn.**
   - Aynan bugun tugaydigan partiya: topilma yo'q.
   - Kecha va undan oldin tugagan partiya: `warn`, savdo davom etadi.
   - Fiskal rejimda ham warn.
   - Chegara testlari (`Asia/Tashkent`, 23:59 va 00:00) shunga mos bo'lsin.
   - Mutatsiya: warn → block yoki `<` → `<=`.
3. **Retsept umuman yo'q.** `PRESCRIPTION_REQUIRED` qoidasi, `prescriptionRequired` paket maydoni va retsept formasi yo'q.
4. **Naqd limit formati (semantikasi T3.2b da):**
   ```ts
   perMxikCashLimit: {
     limitTiyin: string,                 // haqiqiy qiymat faqat paketda (176 mln)
     appliesTo: 'cash' | 'mxikTotal',    // naqd qismiga yoki MXIK umumiy summasiga
     inclusive: boolean,                 // true: limitga teng summa ruxsat
     exempt: { exact: string[], prefixes: string[] },
   } | null
   ```
   Kodda hech qanday limit raqami yo'q. Testlarda sintetik qiymat ishlatiladi.
5. **`cashForbidden` paket formatida qoladi** (aniq moslik va prefikslar).
6. **Imzo kaliti egasida, paket barcha tashkilotlarga.**
   - `trusted-keys.ts` da prod ro'yxati egasi kalit berguncha bo'sh qoladi.
   - Paket tashkilotga bog'lanmaydi (`organizationId` maydoni yo'q).
   - CLI'ning `keygen` buyrug'i yo'riqnomasi `docs/` da qisqa bo'lsin: egasi bitta buyruq bilan repodan tashqarida kalit yaratadi va ochiq kalitni beradi.

## T3.2b (T3.2a dan keyin)

Qoladi:

- `CASH_FORBIDDEN_MXIK` va `MIXED_RECEIPT_CASHLESS`: ma'lumotga asoslangan, bo'sh ro'yxat bilan ishlaydi;
- `MXIK_CASH_LIMIT`: `appliesTo` ning ikkala rejimi va `inclusive`, chegara jadvali bilan.

Retsept va ijtimoiy karta yo'q. Hajm kichik bo'lgani uchun **T3.2b ni T3.2a PR'iga qo'shib yuborishga ruxsat**, agar sen uchun qulay bo'lsa. Shunda bitta PR, bitta hisobot `[ishchi2-hisobot] T3.2`.

## Bajarish tartibi

O'zgarishsiz: kod, `pnpm verify`, PR, CI, hisobot, so'ng `node .mezon/kutish.mjs 120 .mezon/claude/TOPSHIRIQ-ishchi2.md`. Hisobotda yuqoridagi 1–6 bandlar alohida ko'rsatilsin.
