# Claude topshirig'i: Guzar rejasi va T1.12 merge → T1.13 rejasi

## 0. Nima bo'ldi (Gemini limiti tugagan paytda)

- **T1.12 ni Claude tugatdi.** Sening chala ishing saqlandi va `claude/T1.12-printer` branch'ida davom ettirildi (commit `3c73e59`). Sening T1.11 test qarzi commit'ing ham shu yerda (`5c0109e`).
  - ESC/POS kodlovchi, drayverlar, migratsiya va kontraktlar seniki.
  - Hub'dagi printer xizmati 73 ta tip xatosi bilan yig'ilmayotgan edi. U qayta yozildi: persistensiya `db-local` dagi `SqlitePrinterStore` ga ko'chdi (hub `drizzle-orm` ni to'g'ridan-to'g'ri ishlatmaydi).
  - P1 (bitta `clientRequestId` = bitta chop, parallel so'rovda ham), P2 va P3 bajarildi. POS chek oynasida avtomatik chop etish va "Qayta chop etish (nusxa)" bor.
  - Lokal `pnpm verify` yashil: 295 + 12 perf test, E2E, PG RLS, depcruise.
- **`GEMINI.md` Guzar konsepsiyasiga moslandi** (branch `docs/guzar-roadmap`, commit `591085c`).
  - Mahsulot endi **Guzar** (Guzar Kassa + Guzar Market). Kod nomi Mezon qoladi.
  - Yangi bosqichlar F4–F9.
  - TypeScript asosiy til, Python faqat 2.4-bo'limdagi chegaralangan xizmatlar uchun.
  - **Bundan keyingi barcha ishlar shu yangi `GEMINI.md` bo'yicha.** Avval uni to'liq o'qib chiq.
- Claude'ning tekshiruv nusxasi endi loyiha papkasida. Sen ham shu papkada ishlaysan. Har vazifa oxirida ishchi daraxt toza bo'lsin: commit qilinmagan fayl qolmasin.

## 1. Merge'lar (shu tartibda)

1. **`docs/guzar-roadmap` uchun PR och.** Faqat `GEMINI.md` o'zgargan, shuning uchun CI `paths-ignore` sababli ishlamaydi. Bu normal, Claude tasdiqlaydi. `docs: GEMINI.md ni Guzar konsepsiyasiga moslash` nomi bilan Squash and merge qil.
2. **`claude/T1.12-printer` uchun PR och** (`main` ga). Merge'dan oldin, qo'shimcha juft ko'z sifatida, diff'ni o'qib chiq va kamida 3 ta xavfli joyni tekshir:
   - printer xatosi savdoni buzmasligi;
   - P1 idempotentlik;
   - kassir pul yashigini ochishi.

   Muammo topsang, PR'ga yozma: hisobotga yoz va kut. Muammo bo'lmasa va to'rtala CI job yashil bo'lsa (`packages/drivers` o'zgargani uchun desktop installer job ham ishlaydi), `T1.12: Printer va chek` nomi bilan Squash and merge qil.
3. Eski `gemini/T1.12-printer` branch'ini (lokal va remote) o'chir, chunki uning o'rnini `claude/T1.12-printer` egalladi.
4. SHA'larni hisobotga yoz.

## 2. T1.13 — Hisobot, Excel, zaxira: avval REJA

`main`dan `gemini/T1.13-reports-backup` branch'ini och. Kod yozma. Rejani `.mezon/gemini/HISOBOT.md` ga yoz, `[gemini-reja] T1.13` bilan commit qil va push qil, so'ng `node .mezon/kutish.mjs` bilan kut.

GEMINI.md T1.13 talablari:

- kunlik va oylik savdo;
- foyda (faqat egasi);
- qarzlar;
- kam qoldiq;
- muddati yaqin tovarlar;
- Excel import (avval sinov, keyin tasdiq; shtrix-kod va nom bo'yicha moslash) va eksport;
- avtomatik zaxira nusxa, tiklash va yaxlitlik tekshiruvi.

Mezonlar:

- sotuvchi javobida tannarx yo'q (API test);
- zaxiradan tiklanganda summalar teng.

Rejada quyidagilar aniq bo'lsin:

### a) Hisobotlar

- **Manba:** `v_sales_lines`, `customer_ledger`, `supplier_ledger`, `local_stock_balances` va partiyalar. Hisobotda yangi hisob-kitob mantiqi yo'q, faqat mavjud proyeksiya va ledger'lar.
- **Vaqt:** `store_timezone`, kun chegarasi, oylik jamlanma.
- **Rollar:** foyda va tannarx faqat `owner`. API testi kassir va menejer javobida tannarx yo'qligini isbotlasin.
- **Guzar biznes kabineti (F2, T2.7) shu hisobotlarni bulutda ham ko'rsatadi.** Shuning uchun hisobot funksiyalari sof domen yoki SQL qatlamida bo'lsin, UI'ga bog'lanmasin, bulutda qayta ishlatilsin.
- **Python uchun (2.4):** hisobot natijalari aniq kontrakt (Zod → JSON Schema) bilan chiqsin, keyin tahlil xizmati shu kontraktni o'qiy olsin.

### b) Excel

- **Import:** mahsulotlar va narxlar, ixtiyoriy boshlang'ich qoldiq. Ikki bosqich:
  1. sinov — xatolar, ogohlantirishlar va mos kelishlar ro'yxati, bazaga hech narsa yozilmaydi;
  2. tasdiq — bitta tranzaksiyada.
- **Moslash:** shtrix-kod (UPC-A → EAN-13 kanonik, T1.1), keyin normallashtirilgan nom. Dublikatlar va ziddiyatlar aniq ko'rsatilsin.
- **Kutubxona:** `exceljs` faqat port orqasida va faqat hub ichida (GEMINI.md 2.1).
- **Xavfsizlik:** fayl hajmi va qator soni chegarasi, formula va makroslar e'tiborsiz qoldiriladi.
- **Eksport:** hisobotlar va katalog. Kassir eksportida tannarx yo'q.

### c) Zaxira nusxa

- **Avtomatik zaxira:** SQLite online backup API, WAL bilan to'g'ri. Jadval (masalan, har kuni va smena yopilganda), aylanish (nechta nusxa saqlanadi), joy.
- **Yaxlitlik:** `PRAGMA integrity_check`, xesh, va tiklashdan oldin tekshiruv.
- **Tiklash:** mavjud bazani almashtirishdan oldin uning ham nusxasi olinadi. Tiklashdan keyin ledger va proyeksiya rebuild teng bo'lishi shart (mezon: summalar teng).
- **Model testi:** savdo, qaytarish, qarz va kirimlardan keyin zaxira olinadi va tiklanadi. Tushum, qarz, qoldiq va kassa tiyinigacha teng.

### d) Doiradan tashqari

- Bulutga zaxira (F2).
- Kengaytirilgan tahlil (F9).

## 3. Eslatmalar

- T1.12 dan test qarzi yo'q.
- T1.13 F1 ning oxirgi vazifasi. Undan keyin Claude F1 bo'yicha chuqur yakuniy audit o'tkazadi.
