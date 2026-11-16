# Nazoratchi xulosasi (ishchi2): T3.1 — QABUL. Keyingi: T3.2 rejasi

## T3.1 — QABUL

Tekshirildi: `54b3618` (kod `520ce31`).

- **K1:** buyurtma yo'li testi MU1 va MU2 ni ushlaydi.
- **K2:** tombstone qatorni tiklash to'g'ri tanlov. CHECK sinxron orqali kelgan tombstone'ni SQL xatosiga aylantirgan bo'lardi. `restoreAttr` faqat `allowTombstoned` bayrog'i bilan ishlaydi, boshqa writer'lar o'zgarmagan.
- `restored` hodisa turini bulut tomoni ham qabul qilishi kerak. Buni Gemini'ga yetkazaman.

### Merge ko'rsatmasi

1. PR #24 ning **oxirgi commit'idagi** to'rtala CI job yashil bo'lishini kut. Desktop installer skip bo'lsa, bu normal.
2. Qizil job bo'lsa, merge qilma. Tuzat va hisobotda yoz.
3. Yashil bo'lsa:
   ```
   gh pr merge 24 --squash --subject "T3.1: MXIK va soliq sozlamalari"
   ```
4. Keyin:
   ```
   git checkout main
   git pull --ff-only
   ```
   `main` daraxti PR'ning oxirgi commit daraxtiga teng ekanini tekshir: `git diff <oxirgi-commit> main --stat` bo'sh chiqishi kerak.
5. `main` dan yangi branch och: `git checkout -b ishchi2/T3.2-rules`.

## T3.2 — Qoidalar dvigateli: REJA

Hozir **faqat reja** yoz.

Avval qayta o'qi:

- `GEMINI.md` 10-bo'limi: talablar jadvali va T3.2;
- 3-bo'lim: §3.3 API o'ylab topmaslik qoidasi.

### Vazifa (GEMINI.md)

`packages/rules`: `evaluate(cart, payments, context) → { block[], warn[] }`.

- Qoidalar paketi imzolangan (Ed25519), versiyalangan va oflayn ishlaydi.
- Qoidalar:
  - naqd pul bloki;
  - aralash chek;
  - 25 mln limiti va istisnolar;
  - retsept;
  - ijtimoiy karta;
  - yaroqlilik muddati.
- UI va hub bir xil kodni ishlatadi. Yakuniy tekshiruv `completeSale` ichida.
- Eskirgan paket ogohlantirish beradi.

**Mezonlar:**

- chegara qiymatli jadval testlari;
- imzosiz paket rad etiladi;
- API, bot va buyurtma yo'llari ham bloklanadi.

### Rejada bo'lishi kerak

1. **Paket formati.**
   - JSON sxemasi (Zod): versiya, `issuedAt`, `validUntil`, qoidalar ma'lumotlari. Ma'lumotlar: taqiqlangan MXIK ro'yxati yoki prefikslari, retseptli MXIK'lar, ijtimoiy karta qoidalari, limitlar va istisnolar.
   - Kanonik serializatsiya: imzo qaysi baytlarga qo'yiladi va qanday qilib deterministik bo'ladi.
   - Muhim: **qoidalarning haqiqiy ma'lumoti (qaysi MXIK taqiqlangan) o'ylab topilmaydi**. Testlarda faqat sintetik ma'lumot ishlatiladi. Haqiqiy ro'yxat manbasi egasiga savol bo'ladi.
2. **Imzo va kalitlar.**
   - Ochiq kalit qayerda turadi: kodda, bir nechta kalit va rotatsiya bilan.
   - Test kaliti va prod kaliti qanday ajratiladi.
   - Prod maxfiy kaliti repoga **hech qachon** kirmaydi. Kim imzolaydi (bulut yoki egasining CLI'si) — egasiga savol.
   - Imzolash CLI'si `scripts/` ga.
   - Ed25519 uchun `node:crypto` yetarlimi, yangi kutubxona kerakmi? Brauzerda (POS UI) qanday tekshiriladi?
3. **Paketni yetkazish.**
   - T2.4 (pull) hali yo'q. Hozircha hub'ga fayl yoki endpoint orqali import qilinadi (faqat owner yoki manager).
   - Saqlash: LOCAL jadval yoki fayl. Bir vaqtda faqat bitta faol versiya bo'ladi.
   - Versiyani orqaga qaytarish taqiqlanadi (rollback himoyasi).
4. **`evaluate` API.**
   - Kirish ma'lumotlari: savat qatorlari (MXIK snapshot, miqdor, summa, partiya va yaroqlilik muddati), to'lovlar (usul, summa), kontekst (vaqt, paket, tashkilot sozlamalari).
   - `block` va `warn` elementlarining tuzilishi: kod, qator, i18n kaliti.
   - Toza funksiya bo'ladi: vaqt va soat parametr sifatida kiradi.
5. **Har qoida uchun aniq semantika:**
   - aralash chek: bitta taqiqlangan tovar bo'lsa, butun chek naqdsiz bo'ladi;
   - 25 mln limiti **bitta chekdagi bitta MXIK** bo'yicha;
   - qisman naqd to'lov qanday hisoblanadi;
   - qaytarish va bekor qilish qoidalarga qanday ta'sir qiladi.
   - Noaniq joyni **taxmin qilma**, egasiga savol qilib yoz.
6. **Retsept va ijtimoiy karta ma'lumotlarini kiritish.**
   - Qaysi maydonlar: karta turi, raqami, tranzaksiya raqami.
   - Qayerda saqlanadi va PII qanday himoyalanadi: log'da maskalanadi, hisobotlarda ko'rinmaydi.
   - Kassa UI'ga ta'siri.
7. **Integratsiya nuqtalari:**
   - `completeSale` dagi yakuniy tekshiruv;
   - buyurtmani `deliver` qilish;
   - API to'g'ridan-to'g'ri chaqirilganda;
   - savat (UI ogohlantirishi).
   - Hammasi bitta kodni ishlatishi isbotlansin.
8. **Paket holatlari:**
   - paket yo'q;
   - muddati o'tgan (eskirgan);
   - imzo buzilgan;
   - versiya eskiroq.
   - Har holatda savdo bloklanadimi yoki faqat ogohlantirish chiqadimi? Rejada asoslab ber. Fiskal rejim T3.3 da: hozir bayroq bilan.
9. **Testlar.**
   - Chegara jadvali: 25 mln − 1 / 25 mln / 25 mln + 1 tiyin, aralash, retsept, muddat chegarasi (aynan bugun yoki kecha).
   - Property testlari.
   - Imzo hujumlari: bir bayt o'zgartirilgan, boshqa kalit, eski versiya.
   - Mutatsiya rejasi.
10. **Bog'liqliklar.** `packages/rules` qaysi paketlarni import qiladi? depcruise qoidalari. Hub ham, POS ham ishlata olishi uchun domen-toza bo'lsin.

### Bajarish tartibi

1. Rejani `.mezon/ishchi2/HISOBOT.md` ga yoz. `[ishchi2-reja] T3.2` bilan commit qil va `ishchi2/T3.2-rules` ga push qil.
2. Kutish skripti joriy branch'ni kuzatadi. Shuning uchun uni yangi branch'da ishga tushir:
   ```
   node .mezon/kutish.mjs 120 .mezon/claude/TOPSHIRIQ-ishchi2.md
   ```
