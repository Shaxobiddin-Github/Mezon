# Claude topshirig'i: T1.1 QABUL → T1.2 rejasi

## 1. T1.1 xulosasi: QABUL (kod `d8f4e77`)

Claude tekshirdi:

- `pnpm verify` o'tdi: 135 test, sxema diff 0.
- **Mustaqil qidiruv modeli:** 400 ta tasodifiy yaratish/tahrirlash/o'chirishdan keyin 120 ta lotin, kirill va apostrofli so'rovda FTS natijalari oddiy prefiks modeli bilan aynan teng chiqdi.
- **Sahifalash:** bir xil nomli 30 mahsulotda takror ham, tushib qolish ham yo'q.
- **Mutatsiya:** 16 ta ataylab kiritilgan xatodan 15 tasi ushlandi.

Ajoyib ish, ayniqsa VACUUM xavfsiz FTS va unumdorlik optimizatsiyasi.

**Test qarzi.** T1.2 PR'ining birinchi alohida commit'i: `T1.1 test qarzi: EAN-8 va FTS tartibi`.

1. EAN-8 nazorat raqami tekshiruvi o'chirilganda (`prepareBarcodeForStorage` ichidagi EAN-8 `verifyGs1CheckDigit` sharti) testlar yiqilmadi. Noto'g'ri nazorat raqamli EAN-8 rad etilishini tekshiruvchi test qo'sh va buni mutatsiya bilan isbotla.
2. FTS qidiruvi `ORDER BY f.rank ASC` bo'yicha tartiblanadi. Teng reytingda sahifalash barqaror bo'lishi uchun ikkinchi kalit `p.id` qo'shilsin. B-tree yo'lida bu allaqachon bor.

## 2. Merge

1. `git pull --ff-only`.
2. PR #8 boshi Claude'ning shu topshiriq commit'i bo'lsin, to'rtala CI job yashil bo'lsin.
3. `T1.1: Katalog, shtrix-kod va qidiruv` nomi bilan Squash and merge qil, SHA'ni yoz va branch'ni o'chir.
4. `main`dan `gemini/T1.2-stock` branch'ini och.

## 3. T1.2 — Ombor va partiya: avval REJA

Kod yozma. Rejani `.mezon/gemini/HISOBOT.md` ga yoz, `[gemini-reja] T1.2` bilan commit qil va push qil, so'ng `node .mezon/kutish.mjs` bilan kut.

GEMINI.md T1.2 talablari:

- `stock_move` sabablari: boshlang'ich, kirim, savdo, qaytarish, inventarizatsiya, tuzatish, buzildi, sindi, shaxsiy, yo'qoldi;
- `batch` (muddat, tannarx);
- partiyali tovarda FIFO, boshqasida o'rtacha tannarx;
- qoldiq proyeksiyasi va inventarizatsiya.

Mezonlar:

- proyeksiya = ledger yig'indisi;
- FIFO qo'lda hisoblangan misollar bilan teng;
- qayta qurish natijasi teng.

Rejada quyidagilar aniq bo'lsin:

### a) Ledger va sinflar

- `stock_moves`: FACT, do'kon darajasida.
  - Ishorali `Quantity`, `reason` va manba hujjat (`source_type`, `source_id`).
  - Ixtiyoriy `batch_id` va tannarx qiymati snapshot'i.
  - Faqat qo'shiladi, tuzatish teskari harakat bilan.
- `batches`: kirim paytida yaratiladigan FACT. Muddat va kirim tannarxi saqlanadi.
- Qoldiq va partiya qoldig'i: LOCAL proyeksiya jadvallari. Ular sinxronlanmaydi va ledgerdan qayta quriladi (GEMINI.md 3.1 5-band).
- `unlimited` mahsulotlar uchun qoldiq hisoblanmaydi. Siyosatni yoz.
- Har harakatda miqdor T1.1 birlik qoidasi bilan tekshirilsin.

### b) Tannarx aniqligi: tiyin yo'qolmasin

- Tannarx birlik narxi × miqdor bilan qayta hisoblanib, yaxlitlash qoldig'i yig'ilib bormasin.
- Qiymatga asoslangan hisob yuritilsin: har partiya `remaining_qty` va `remaining_value` saqlaydi.
- Chiqim qiymati `remaining_value × olinadigan / remaining_qty` (T0.2 `divideRoundHalfAwayFromZero`). Partiyaning oxirgi miqdori qolgan qiymatni to'liq oladi.
- O'rtacha tannarx uchun ham xuddi shu qoida: umumiy qiymat va umumiy miqdor yuritiladi.

**Invariant (property test):** har partiya va har mahsulot uchun `kirim qiymati = chiqim qiymatlari yig'indisi + qoldiq qiymat`, tiyinigacha aniq.

### c) Manfiy qoldiq

Kassa savdoni to'xtatmasligi kerak (GEMINI.md 3.2). Real hayotda hisob xato bo'ladi.

Rejada yoz:

- siyosat (rad etish yoki ogohlantirish) qayerda saqlanadi va standart qiymati nima;
- manfiy qoldiqda FIFO va o'rtacha tannarx qanday ishlaydi (masalan, "partiyasiz kamomad" va keyingi kirim kelganda uni yopish);
- tannarx qiymati qanday aniqlanadi.

Qo'lda hisoblangan misollar bilan.

### d) Tartib va sinxron

O'rtacha tannarx va FIFO hodisalar tartibiga bog'liq. Boshqa qurilmadan kech kelgan harakat qayta qurishda natijani o'zgartirishi mumkin.

Rejada yoz:

- qayta qurish qaysi tartibda ketadi (HLC);
- allaqachon yozilgan savdo tannarxi snapshot'i o'zgarmaydi;
- proyeksiya qayta qurilganda farq qanday hisobga olinadi.

### e) Inventarizatsiya

- Sanoq hujjati boshlanganda kutilgan qoldiq yozib olinadi.
- Sanoq paytida bo'lgan savdolar ikki marta hisoblanmasin: tuzatish = sanalgan − sanoq boshlangandagi kutilgan qoldiq.
- Tuzatish harakatlari bitta UoW'da yoziladi.

Test bilan: sanoq davomida savdo bo'lganda yakuniy qoldiq to'g'ri chiqadi.

### f) Hub API va RBAC

- Qoldiqni ko'rish: `cashier` ham, lekin tannarxsiz.
- Kirim, tuzatish, hisobdan chiqarish va inventarizatsiya: `owner`/`manager`.
- Tannarx va foyda faqat `owner`/`manager` javobida bo'ladi. Kassir javobida bu maydonlar umuman yo'qligi test bilan tekshirilsin.
- Kirim hujjati va ta'minotchi T1.8'da bo'ladi. Bu yerda faqat partiya yaratadigan asosiy kirim harakati.

### g) Qayta qurish

- `rebuildStockProjections()` ledgerdan hamma proyeksiyani noldan quradi.
- **Property test:** tasodifiy harakatlar ketma-ketligidan keyin oddiy, sekin, lekin aniq model bilan solishtir:
  - qoldiq;
  - partiya qoldig'i;
  - qoldiq qiymati.
