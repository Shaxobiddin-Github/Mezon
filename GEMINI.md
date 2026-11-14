# Guzar platformasi (kod nomi: Mezon) — to'liq topshiriq

> **Bajaruvchi:** Gemini yoki Claude (vazifa boshida belgilanadi).
> **Ish boshqaruvchi va tekshiruvchi:** Claude.
> **Qaror egasi:** loyiha egasi (Shaxobiddin).
> **Mahsulot:** Guzar — Kattaqo'rg'ondan boshlanadigan shahar savdo va xizmatlar platformasi. Ikki brend: **Guzar Kassa** (biznes uchun kassa va boshqaruv) va **Guzar Market** (aholi uchun buyurtma va band qilish).
> **Kod nomi:** Mezon. Repozitoriya `mezon`, paketlar `@mezon/domain`, `@mezon/rules` va h.k. Kod nomi o'zgarmaydi, foydalanuvchiga faqat "Guzar" ko'rinadi.
> **Asosiy manba:** "Guzar — Loyiha konsepsiyasi" (ishchi versiya 1.1, 2026-yil noyabr). Bu hujjat uni texnik vazifalarga aylantiradi. Konsepsiyada Django yozilgan; egasi 2026-11-11 da **TypeScript'da qolishga** qaror qildi (2.4-bo'lim).

---

## 0. Eng avval o'qing

1. Bu **yangi loyiha**. Hamma narsa noldan yoziladi.
2. **MiniERP'ga tegilmaydi:** uning repozitoriyasiga push, PR, issue yoki fayl o'zgarishi qilinmaydi, kodi ko'chirilmaydi, unga bog'liqlik qo'shilmaydi. Undan olingan saboqlar 3-bo'limda talab sifatida yozilgan, MiniERP'ni ochish shart emas.
3. Har safar **faqat bitta vazifa** bajaring (masalan `T0.2`).
4. Vazifa tugagach **to'xtang** va 5-bo'limdagi hisobotni yozing.
5. Claude `QABUL` demaguncha keyingi vazifani boshlamang.
6. Hujjatda yo'q funksiyani qo'shmang. Fikringizni hisobotning "Takliflar" qismiga yozing.

---

## 1. Mahsulot

Guzar — do'kon, kafe, restoran, fitnes zali, bilyard klubi va boshqa xizmat nuqtalarini bitta tizimda boshqarish hamda aholiga ulardan bitta ilova orqali foydalanish imkonini beradigan platforma. Asosiy g'oya: **bir marta kiritiladi — hamma joyda ko'rinadi.** Kassaga kiritilgan mahsulot, menyu, jadval yoki bo'sh vaqt avtomatik ravishda mijoz ilovasida ham paydo bo'ladi.

**Interfeyslar:**

| Interfeys | Kim foydalanadi | Asosiy vazifasi |
|---|---|---|
| Guzar Kassa (POS) | Do'kon va savdo nuqtasi | Sotuv, chek, mahsulot, kirim, ombor, qarzlar |
| Biznes kabineti | Biznes egasi, menejer | Sozlash, xodimlar, buyurtmalar, bronlar, hisobotlar |
| Guzar Market (mijoz ilovasi) | Aholi | Qidirish, buyurtma, bron, bonus |
| Onlayn vitrina | Mijozlar | Har bir biznesning havola va QR orqali ochiladigan sahifasi |
| Ovqatlanish moduli | Kafe, restoran | Menyu, stollar, QR buyurtma, oshxona ekrani |
| Bron moduli | Fitnes, bilyard, xizmatlar | Vaqt, stol, zal yoki mutaxassisni band qilish |
| Haydovchi ilovasi | Haydovchi va kuryerlar | Buyurtmani qabul qilish va yetkazish |
| Platforma boshqaruvi | Loyiha jamoasi | Bizneslarni ulash, nazorat, yordam, tahlil |

**Yo'nalishlar:** do'kon (tovar), kafe va restoran (taom va stol), fitnes (dars va abonement), bilyard (stol vaqti), xizmatlar — salon, avtoservis, o'quv markazi, sport maydoni (mutaxassis vaqti). Barchasi bitta yagona API va bitta domen ustida; farq faqat nima sotilishida: tovar, taom yoki vaqt.

**Bozorga chiqish qoidasi:** hammasi rejada va arxitekturada bor, lekin bosqichma-bosqich chiqariladi. Keyingi bosqich oldingisi haqiqiy bizneslarda ishlagach boshlanadi. Birinchi 5 ta har kuni ishlaydigan biznes ro'yxatdagi 50 tadan muhimroq.

**Sifat maqsadlari:**

| Ko'rsatkich | Maqsad |
|---|---|
| Skanerdan savatdagi qatorgacha | ≤ 150 ms (50 000 mahsulotli hub) |
| Savdoni yakunlash (lokal) | ≤ 300 ms |
| Internet uzilishi | Savdo to'xtamaydi (markirovkali tovar bundan mustasno, 3.3 ga qarang) |
| Yiqilishdan keyin | Yakunlangan savdo yo'qolmaydi |
| Kassirni o'rgatish | 15 daqiqa ichida birinchi savdo |
| Past quvvatli monoblok | 4 GB RAM, Windows 10 22H2+ da silliq |
| Mijoz ilovasi | Bir necha soniyada kerakli joyni topish, 3–4 bosishda buyurtma yoki bron |
| Elektr uzilishi | Tugallanmagan sotuv saqlanadi; planshet yoki telefondagi web-kassa zaxira |

**Doiradan tashqari:** buxgalteriya bosh kitobi, HR/maosh, MiniERP bilan integratsiya.

---

## 2. Arxitektura

```text
Guzar Kassa terminallari: Windows (Electron), Android/planshet (Capacitor), web-kassa — bitta React UI
        │  do'kon ichki tarmog'i, juftlangan qurilmalar
Do'kon hub'i: Fastify + SQLite, domen, qoidalar, fiskal/to'lov navbati (internetsiz ishlaydi)
        │  internet bo'lganda: outbox → sinxron
Bulut (O'zbekistonda): Fastify + PostgreSQL — yagona API qatlami
   ├─ Biznes kabineti, Platforma boshqaruvi (apps/admin)
   ├─ Guzar Market: web, QR vitrina, Telegram mini-ilova (apps/market)
   ├─ Haydovchi ilovasi (apps/driver), oshxona ekrani (apps/pos ichida)
   └─ Python xizmatlari (ixtiyoriy, 2.4): tahlil, prognoz, AI — faqat API orqali
        │
Soliq/OFD · UzQR · Payme/Click/Uzum · Asl belgisi · xarita · SMS/Telegram bildirishnomalar
```

- **Yagona kassa:** hub va terminal bitta Electron ilovasida.
- **Ko'p kassa:** bitta kompyuter hub, qolganlari unga ulanadi.
- **Haqiqat manbai:** savdo paytida hub; onlayn buyurtma, bron, yetkazish va do'konlararo ko'rinish uchun bulut.
- **Ko'p biznesli tuzilma:** har bir yozuv qaysi tashkilotga tegishli ekanini biladi (`organization_id` + RLS). A do'kon B restoranning ma'lumotini hech qachon ko'rmaydi. Guzar Market faqat biznes **ochiq e'lon qilgan** ma'lumotni ko'radi (2.5).

### 2.1. Texnologiyalar

| Soha | Tanlov |
|---|---|
| Til | TypeScript 6.0.3 (`strict`, `skipLibCheck: true`) |
| Linter | ESLint 10.14, typescript-eslint 8.72 (tipga asoslangan qoidalar bilan) |
| Runtime | Node.js 24 LTS |
| Monorepo | pnpm 12 + Turborepo 2 |
| Validatsiya va kontrakt | Zod 4 |
| API (hub va bulut) | Fastify 5, Pino 10 |
| Lokal baza | SQLite, better-sqlite3 13, WAL rejimi |
| Bulut bazasi | PostgreSQL 18, RLS, `pg` 8 |
| ORM va migratsiya | Drizzle 0.45 (aniq versiya), SQL migratsiyalar repoda |
| Fon vazifalari | pg-boss 12 (bulut), lokal navbat SQLite'da (hub) |
| UI | React 19, Vite 8, React Router 8, Tailwind 4 |
| UI holati | TanStack Query 5, Zustand 5, TanStack Virtual 3 |
| Tillar | i18next 27 |
| Windows | Electron 45, electron-builder 26, electron-updater 6 |
| Android | Capacitor 8, `@capacitor-community/sqlite` 8 |
| Windows printer | koffi 3 orqali `winspool.drv` RAW |
| Tarmoq printer | TCP 9100, Node `net` |
| ESC/POS va GS1 | O'zimizning kichik kodlovchi va parser, `packages/drivers` ichida |
| Parol va PIN | `@node-rs/argon2` 2 |
| Token | jose 6 (qisqa access, aylanadigan refresh) |
| Imzo | Node `crypto`, Ed25519 |
| ID | `uuid` 14 (UUIDv7) |
| Excel | exceljs 4.4, faqat port orqali |
| Bot | grammY 1 |
| Test | Vitest 5, Playwright 1.65, fast-check 4, Testcontainers 12 |
| Import chegaralari | dependency-cruiser 18 |
| Deploy | Docker Compose, Caddy, O'zbekistondagi VPS |

Aniq versiyalar `pnpm-lock.yaml` bilan mahkamlanadi. Almashtirish faqat Claude tasdig'i bilan. Yuqori versiya bir-biriga mos kelmasa, jimgina pasaytirmang: to'xtab xabar bering.

**Muhim tekshiruvlar (`T0.1`):** Electron ichidagi Node major versiyasi; better-sqlite3 va koffi Electron bilan yig'ilishi; TypeScript 6.0.3 bilan Drizzle, Zod va ESLint mosligi.

**TypeScript 7:** hozircha ishlatilmaydi, chunki typescript-eslint 8.72 faqat `<6.1.0` ni qo'llab-quvvatlaydi va TS 7.0.2 bilan ishdan chiqadi. typescript-eslint rasmiy qo'llab-quvvatlashni e'lon qilgach, o'tish alohida vazifa bo'ladi.

**Yangilash siyosati:** Electron har chorakda qo'llab-quvvatlanadigan versiyaga ko'tariladi. Drizzle `0.x`, shuning uchun yangilash faqat alohida vazifa bilan. exceljs kam yangilanadi, shuning uchun port orqasida turadi va faqat hub ichida ishlaydi.

**Qo'llab-quvvatlanadigan tizimlar:** Windows 10 22H2+ (64-bit), Android 8+. Windows 7/8 qo'llab-quvvatlanmaydi, chunki Electron ularda ishlamaydi.

**Nega TypeScript:** hisob va qonuniy qoidalar terminal, hub, Android va bulutda bir xil kod bilan ishlaydi, nusxalar orasida farq chiqmaydi.

### 2.2. Monorepo

```text
apps/
  desktop/      Electron qobig'i (hub + UI)
  hub/          do'kon serveri
  pos/          kassa va do'kon UI
  android/      Capacitor qobig'i
  cloud/        bulut API va sinxron
  admin/        biznes kabineti va platforma boshqaruvi
  market/       Guzar Market: mijoz ilovasi, QR vitrina, Telegram mini-ilova
  driver/       haydovchi ilovasi
  bot/          Telegram bot
packages/
  domain/       sof biznes mantiq, IO yo'q
  contracts/    API va hodisa sxemalari
  rules/        qonuniy qoidalar dvigateli
  sync/         sinxron yadrosi
  db-local/     SQLite sxema
  db-cloud/     PostgreSQL sxema
  drivers/      fiskal, to'lov, printer, markirovka
  ui/  i18n/  test-utils/
services/       ixtiyoriy Python xizmatlari (2.4): tahlil, prognoz, AI
```

Qat'iy chegara: `domain` va `rules` hech narsaga bog'lanmaydi (baza, tarmoq, soat va tasodif tashqaridan beriladi). CI import qoidalari bilan tekshiradi.

### 2.3. Nomlash lug'ati

Kod identifikatorlari inglizcha. UI matnlari `i18n`da.

| Kod | Ma'no |
|---|---|
| `organization` | Tashkilot (tenant) |
| `store` | Do'kon/filial |
| `warehouse` | Ombor |
| `terminal` | Kassa qurilmasi |
| `product`, `variant`, `batch` | Mahsulot, variant, partiya |
| `stock_move` | Ombor harakati |
| `sale`, `sale_line`, `payment` | Chek, qator, to'lov |
| `customer_ledger` | Mijoz qarz daftari |
| `supplier_ledger` | Ta'minotchi qarz daftari |
| `shift`, `day_close` | Smena, kun yakuni |
| `cash_move` | Kassa pul harakati |
| `fiscal_doc` | Fiskal hujjat |
| `order`, `order_payment` | Buyurtma, avans |
| `session` | Vaqtli xizmat seansi (zal) |
| `resource`, `booking`, `booking_hold` | Bron resursi (stol, zal, usta), bron, vaqtinchalik band |
| `membership` | Abonement |
| `reservation` | Onlayn buyurtma uchun qoldiqni vaqtincha band qilish |
| `public_listing` | Guzar Market ochiq proyeksiyasi |
| `delivery_job`, `driver` | Yetkazish topshirig'i, haydovchi |

### 2.4. TypeScript asosiy til, Python — chegaralangan xizmatlar

**Qaror (egasi, 2026-11-11):** asosiy tizim TypeScript'da qoladi. Sabab: kassa (Electron, Android, web) va server bir xil hisob kodini ishlatadi — pul, QQS, aksiya, ombor tannarxi, sinxron. Ikki tilda yozilsa, oflayn sinxronda tiyin va qoldiq farqlari chiqadi.

**Python qayerda ishlatilishi mumkin** (AI rivojlangani sari kengayadi):

| Soha | Misol |
|---|---|
| Tahlil va hisobot | Kogorta, saqlanish, ABC tahlili, biznes kabinetidagi kengaytirilgan tahlil (pullik) |
| Prognoz | Buyurtma tavsiyasi, talab prognozi, bron bandligi prognozi |
| AI yordamchi | O'zbekcha savol-javob, ovoz, anomaliya qidirish |
| Hujjat bilan ishlash | Ta'minotchi fakturasini rasmdan o'qish (OCR), Excel tozalash |
| Tavsiya | Mijozga yaqin joylar va mahsulot tavsiyasi, reklama joylashuvi |

**Python uchun qat'iy chegaralar:**

1. Python xizmati **pul, ombor, chek, qarz, bron yoki sinxron mantig'ini o'zi hisoblamaydi** va FACT/MONOTONE jadvallarga to'g'ridan-to'g'ri yozmaydi. U faqat o'qiydi (alohida faqat-o'qish roli yoki replika) yoki TypeScript API'dagi domen komandasini chaqiradi (tasdiq va audit bilan, 16-bo'lim AI qoidalari).
2. Aloqa faqat hujjatlashtirilgan API yoki navbat orqali. Kontraktlar Zod'dan **JSON Schema / OpenAPI** sifatida eksport qilinadi (`packages/contracts`), Python tomonda Pydantic modellar shundan generatsiya qilinadi. Qo'lda nusxalash taqiqlangan.
3. Python xizmati alohida konteyner (`services/<nom>`), o'z testlari, CI'da alohida job. Ishlamay qolsa, kassa va savdo to'xtamaydi.
4. Shaxsiy ma'lumot tashqi AI modelga yuborilmaydi (16-bo'lim).

**Kelajakda Python'ga o'tish imkoni:** chegaralar shunday qurilsinki, istalgan bulut moduli (masalan tahlil yoki tavsiya) keyinchalik Python'da qayta yozilishi mumkin bo'lsin: modul faqat kontrakt orqali gaplashadi, ichki tuzilishi tashqariga chiqmaydi. Kassa va hub yadrosi (domen, sinxron) TypeScript'da qoladi.

### 2.5. Ochiq katalog (Guzar Market uchun)

RLS tenantlarni qat'iy ajratadi. Mijoz ilovasi esa ko'p bizneslarni birga ko'rsatadi. Shuning uchun:

- Biznes nimani ochiq qilishini o'zi belgilaydi: profil (nom, manzil, xaritadagi nuqta, ish vaqti, yo'nalish, rasmlar), mahsulot/menyu/xizmat, narx, mavjudlik (qoldiq son yoki faqat "bor/yo'q"), bo'sh vaqtlar.
- Bulutda alohida **ochiq proyeksiya** (`public_*` jadvallar yoki ko'rinishlar) faqat shu maydonlarni saqlaydi va hodisalardan yangilanadi. Tannarx, qarz, xodim, mijoz ma'lumoti u yerga hech qachon tushmaydi (test bilan).
- Market API faqat ochiq proyeksiyani o'qiydi. Buyurtma va bron esa biznesning tenant kontekstida domen komandasi orqali yaratiladi.

---

## 3. O'zgarmas qoidalar

Bularni buzgan o'zgarish avtomatik rad etiladi. Bular MiniERP'da amalda sinalgan saboqlardan olingan.

### 3.1. Ma'lumot

1. **Pul:** `bigint`, tiyinda. **Miqdor:** `bigint`, mingdan birda (0.001). `number` va `float` hisobda ishlatilmaydi. JSON'da satr.
2. **ID:** klientda yaratiladigan UUIDv7.
3. **Tenant:** har jadvalda, bola jadvallarda ham, `organization_id` va kerak bo'lsa `store_id` ustuni bo'ladi. Bulutda PostgreSQL RLS yoqiladi.
4. **Ledger:** zaxira faqat `stock_move`, qarz faqat `customer_ledger`/`supplier_ledger`, kassa puli faqat `cash_move` orqali o'zgaradi.
5. **Proyeksiya:** qoldiq va qarz balansi — kesh. U ledgerdan qayta quriladi, sinxronlanmaydi. Qayta qurish buyrug'i bo'ladi va test natijani tekshiradi.
6. **Yozuv sinflari:**
   - `FACT`: o'zgarmas, faqat qo'shiladi. Savdo, qator, to'lov, harakatlar.
   - `ATTR`: tahrirlanadi. Mahsulot, mijoz va h.k. Oxirgi yozgan yutadi (HLC bo'yicha).
   - `MONOTONE`: FACT ichidagi ruxsat etilgan bir tomonlama o'tish (`voided_at`). Ro'yxat aniq va qaytmaydi.
7. **O'chirish:** sinxron jadvallarda faqat tombstone.
8. **Snapshot:** chek qatorida narx, tannarx, MXIK, QQS va mahsulot nomi o'sha paytdagi qiymatda saqlanadi.
9. **Yagona yo'l:** har qanday savdo (UI, bot, buyurtma, zal) bitta `completeSale` komandasi orqali o'tadi.
10. **Atomiklik:** chek, qatorlar, to'lovlar, harakatlar, ledger, fiskal hujjat, audit va outbox **bitta tranzaksiyada** yoziladi.
11. **Outbox** repozitoriy qatlamida, o'sha tranzaksiya ichida yoziladi. ORM hook, global holat yoki `afterCommit` bufer ishlatilmaydi.

### 3.2. Uzluksizlik

- Internet, sinxron, AI yoki litsenziya muammosi savdoni to'xtatmaydi.
- Savdoni faqat qonuniy qoida, zaxira siyosati yoki kassir ruxsati to'xtata oladi.
- Printer yo'qligi savdoni buzmaydi, chek keyin chop etiladi.

### 3.3. Tashqi tizimlar

- OFD, virtual kassa, UzQR, Payme, Click, Uzum, Asl belgisi uchun **endpoint, maydon, imzo yoki sertifikat jarayonini o'ylab topmang**.
- Hujjat berilmaguncha faqat interfeys va `Fake...Driver` yoziladi.
- Fake rejimda chek va UI'da "SINOV — FISKAL EMAS" chiqadi.
- Fiskal belgi driver javobisiz yozilmaydi.
- Markirovkalangan tovar cheki onlayn tekshiruv talab qiladi (VMQ-23): bunday tovar uchun oflayn rejim zaxira hisoblanadi, asosiy ish tartibi emas. Internet yo'qligida qanday ishlash F3 da hamkor hujjati bo'yicha belgilanadi.
- `[TASDIQLANSIN]` belgili qiymatlar konfiguratsiyada turadi.

### 3.4. Xavfsizlik

- Maxfiy kalit, token va haqiqiy mijoz ma'lumoti repoga tushmaydi.
- Parol va PIN: argon2id. Parol xeshlari qurilmalarga tarqatilmaydi.
- Ruxsat backendda tekshiriladi. Tannarx va foyda kassir javobiga umuman kiritilmaydi.
- Har API va har sinxron hodisa tenant, qurilma va rol bo'yicha tekshiriladi.
- Haqiqiy pul yoki fiskal chek testda yuborilmaydi.

### 3.5. Kod va testlar

- `strict` TypeScript, `any` faqat izoh bilan. ESLint, Prettier.
- Tashqi kirish Zod bilan tekshiriladi.
- Har biznes qoidaga test. Har xato tuzatishda avval xatoni ko'rsatuvchi test.
- `domain` va `rules`da property-based test (fast-check) pul taqsimoti uchun.
- Testni o'tkazish uchun testni o'chirmang, zaiflashtirmang yoki `skip` qilmang.
- Test natijasini o'ylab topmang. Ishga tushira olmaganingizni "tekshirilmadi" deb yozing.
- Yangi kutubxona hisobotda sababi bilan qo'shiladi.

### 3.6. Git

- Har vazifa alohida branch: `gemini/T0.2-money-types`.
- `main`ga to'g'ridan-to'g'ri push va force push qilinmaydi.
- PR faqat ikki shart birga bajarilganda Squash and merge qilinadi: shu PR'ning oxirgi commit'i uchun Claude `QABUL` bergan va CI Ubuntu hamda Windows'da yashil. `QABUL`dan keyin yangi commit qo'shilsa, qayta tekshiruv kerak.
- Merge'dan keyin merge commit SHA'sini hisobotga yoz va vazifa branch'ini o'chir.
- Commit: `T0.2: qisqa mazmun`. Bitta PR — bitta vazifa.

---

## 4. Sinxron spetsifikatsiyasi

Bu loyihaning eng xavfli qismi. Spetsifikatsiyadan chetlanish faqat Claude tasdig'i bilan.

**Hodisa konverti:**

```ts
{ eventId: UUIDv7, organizationId, storeId, deviceId,
  deviceSeq: bigint, hlc: string, type: string, entity: string,
  entityId: UUIDv7, class: 'FACT'|'ATTR'|'MONOTONE',
  schemaVersion: number, payload: object }
```

**Push (`POST /sync/push`)** har hodisa uchun holat qaytaradi:

| Holat | Ma'no | Klient |
|---|---|---|
| `accepted` | Qo'llandi | Tasdiqlaydi |
| `duplicate` | Oldin qabul qilingan | Tasdiqlaydi |
| `rejected` | Doimiy xato, sababi bilan | Chetga chiqaradi, `Conflict` yozadi, navbatni to'smaydi |
| `retry` | Vaqtinchalik | Qayta yuboradi |

- Muvaffaqiyatsiz hodisa hech qachon `accepted` deb qaytarilmaydi va boshqa qurilmalarga tarqalmaydi.
- Takror nazorati: `UNIQUE(organization_id, event_id)` ustuni, JSON ichida qidirilmaydi.
- Tenant tekshiruvi umumiy sxema metama'lumoti asosida: mavjud yozuv egasi va payload'dagi barcha havolalar. Metama'lumotsiz jadval CI'ni yiqitadi.

**Pull (`GET /sync/pull?after=`):**
- Har do'kon uchun bo'shliqsiz `position`. Yozishda do'kon bo'yicha `pg_advisory_xact_lock` olinadi va hisoblagich oshiriladi. Oddiy sequence ishlatilmaydi, chunki parallel commit tartibi hodisani o'tkazib yuborishga olib keladi.
- Qo'llanmagan hodisa `sync_parked` jadvaliga tushadi, pozitsiya siljiydi, har siklda qayta uriniladi. N=20 urinishdan keyin `Conflict` bo'ladi.

**Vaqt:**
- ATTR tartibi uchun HLC.
- Server `MAX_SKEW` (5 daqiqa) dan oldindagi hodisani server vaqtiga tushiradi va qayd etadi.
- Soati noto'g'ri qurilmaning tahriri to'g'ri ma'lumotni bosib keta olmaydi.

**Konfliktlar:** manfiy qoldiq, rad etilgan hodisa, partiyadan ortiqcha chiqim. Savdo bekor qilinmaydi, egasi panelida ko'rsatiladi.
- **Yagona yozuvchi qoidasi (`stock_moves`, `batches`):** zaxira harakatlari va partiyalar faqat o'sha do'kon hub'ida yaratiladi (bitta do'kon — bitta yozuvchi); bulut tomonida majburlash F2 da qo'llanadi.
- **Yopiq smenaga sinxron INSERT (`sales`, `returns`, `cash_moves`):** lokal `BEFORE INSERT` triggerlar yopiq smenaga yangi mahalliy yozuvni bloklaydi, lekin F2 da boshqa qurilmadan yoki kechikib sinxron bilan kelgan qatorlarni bloklamasligi kerak (triggerlar F2 sinxron rejimini o'tkazib yuboradi, yopilgan smena/`day_close` eskirgan deb belgilanadi va ziddiyat ko'rsatiladi).

**Bootstrap:** snapshot va `position`. Tenant filtri majburiy. Filtri yo'q jadval xato beradi.

**Boshqa:** rasmlar sinxron oqimidan tashqarida. `minClientVersion` va `schemaVersion` tekshiruvi bor.

---

## 5. Ish jarayoni va hisobot

```text
Gemini vazifani bajaradi → PR + hisobot → Egasi Claude'ga beradi
Claude tekshiradi → QABUL / QAYTA ISHLASH / TO'XTATILDI → QABUL bo'lsa Gemini merge qiladi
```

Kod yozishdan oldin qisqa reja bering: fayllar, yondashuv, testlar.

**Hisobot shabloni:**

```markdown
## Hisobot: T0.2
Branch / PR:
Commit:

### Nima qilindi
### O'zgargan fayllar (fayl — sabab)
### Migratsiyalar

### Qabul mezonlari
- [x] 1-mezon — dalil (test nomi yoki buyruq)
- [ ] 2-mezon — nega bajarilmagan

### Test natijasi (buyruq va haqiqiy chiqish)
### Tekshirilmagan narsalar
### Qilingan taxminlar
### Takliflar
### Egasi yoki Claude qarori kerak bo'lgan savollar
```

**Claude tekshiradi:** mezonlar, testlarning haqiqiy kuchi, 3–4-bo'limlar, chegaraviy holatlar (rollback, takror so'rov, uzilish, ikki tenant, kassir roli, kasr miqdor, yaxlitlash) va vazifadan tashqari o'zgarishlar.

**Natijalar:** `QABUL`, `QAYTA ISHLASH` (topilma raqamlari bilan), `TO'XTATILDI`.

**To'xtab so'rang, agar:** vazifa ziddiyatli bo'lsa; tashqi API hujjati kerak bo'lsa; qonuniy talab noaniq bo'lsa; bir vazifa boshqasini talab qilsa; bir xatoni 3 urinishda tuzata olmasangiz.

---

## 6. Bosqichlar

Konsepsiyadagi bozor bosqichlari (0–6) bilan moslik ustunda ko'rsatilgan.

| Bosqich | Natija | Vazifalar | Guzar bosqichi |
|---|---|---|---|
| F0. Poydevor | Monorepo, domen asoslari, CI | T0.1–T0.7 | 0 · Tayyorgarlik |
| F1. Oflayn kassa | Bitta kompyuterda to'liq do'kon | T1.1–T1.13 | 1 · Kassa va do'konlar |
| F2. Bulut, sinxron va biznes kabineti | Egasi telefondan ko'radi va boshqaradi | T2.1–T2.8 | 1 · Kassa va do'konlar |
| F3. Qonuniy kassa | Fiskal chek, UzQR, markirovka, pilot | T3.0–T3.9 | 1 · yakuni: 3–5 do'kon har kuni savdo qiladi |
| F4. Ko'p kassa, web-kassa va obuna | Keng sotuvga tayyor | T4.1–T4.8 | 1 → 2 o'tishi |
| F5. Guzar Market va onlayn vitrina | Mijoz havoladan buyurtma beradi | T5.1–T5.9 | 2 · Onlayn vitrina |
| F6. Kafe va restoran | 2–3 ovqatlanish nuqtasi ulangan | T6.1–T6.6 | 3 · Kafe va restoran |
| F7. Bron: fitnes, bilyard, xizmatlar | Fitnes zali va bilyard klubi ishlaydi | T7.1–T7.7 | 4 · Bron |
| F8. Yetkazib berish | Cheklangan hududda yetkazish sinovi | T8.1–T8.6 | 5 · Yetkazib berish |
| F9. O'sish | Bonus, tahlil, reklama, filial, sohalar, API, AI | T9.1–T9.12 | 6 · O'sish |

Bosqich mezoni bajarilmaguncha keyingisi boshlanmaydi. Har bosqich oxirida Claude chuqur audit o'tkazadi (mustaqil model va mutatsiya).

---

## 7. F0 — Poydevor

### T0.1. Monorepo va CI

2.2-bo'limdagi tuzilma, TypeScript, ESLint, Prettier, Vitest, Turborepo. 2.1-bo'limdagi versiyalar mahkamlanadi va "Muhim tekshiruvlar" natijasi hisobotga yoziladi. `dependency-cruiser` bilan import chegaralari. GitHub Actions: lint, typecheck, test, build. README: ishga tushirish.

**Mezonlar:** toza klondan bir buyruq bilan o'rnatish va test; `domain` ichida `fs` import qilinsa CI yiqiladi.

### T0.2. Pul, miqdor va yaxlitlash

`Money`, `Quantity`, `multiply`, `allocate` (eng katta qoldiq usuli), QQS hisobi, satrga aylantirish.

**Mezonlar:** `allocate` yig'indisi har doim aniq teng (property test); 5.5 kg × narx kabi kasr holatlar; `number` aralashtirish tip xatosi beradi.

### T0.3. Identifikator, vaqt, HLC

UUIDv7, HLC, `Clock` va `IdGenerator` portlari, test uchun deterministik variantlar.

**Mezonlar:** HLC monotonligi, orqaga ketgan soatda ham o'sishi.

### T0.4. Ma'lumot sxemasi poydevori

`db-local` va `db-cloud`: umumiy ustunlar, sinf metama'lumoti (`FACT/ATTR/MONOTONE/LOCAL`), tenant metama'lumoti, migratsiya vositasi. RLS shabloni.

**Mezonlar:** metama'lumotsiz jadval testni yiqitadi; `organization_id`siz sinxron jadval testni yiqitadi; RLS boshqa tenant qatorini qaytarmaydi.

### T0.5. Tranzaksiya, repozitoriy, outbox

Asinxron `UnitOfWork` porti, chunki Android SQLite drayveri asinxron ishlaydi. Domen yozuvi va outbox bitta tranzaksiyada. `deviceSeq` tranzaksiya ichida.

**Mezonlar:** rollback'da outbox bo'sh; keyingi tranzaksiya normal ishlaydi; ichki savepoint rollback sizib chiqmaydi; bitta oqimda rollback → commit ketma-ketligi testlangan.

### T0.6. Hub skeleti va autentifikatsiya

Fastify, xato formati, tuzilgan log, foydalanuvchi, rollar, PIN (argon2id, 5 xato → 5 daqiqa blok), sessiya, birinchi ishga tushirish sehrgari (foydalanuvchi bo'lsa yopiladi). Standart `admin/admin` yo'q.

**Mezonlar:** sehrgar ikkinchi marta ochilmaydi; rol testlari; hub faqat `127.0.0.1` da (F4 gacha).

### T0.7. Electron qobig'i

Electron hub'ni ishga tushiradi va UI ochadi. Ma'lumot `%LOCALAPPDATA%` da. O'chirishda baza saqlanadi. Admin parolisiz o'rnatish. `contextIsolation` yoqilgan. Bir nusxa rejimi. Nativ modul yig'ilishi.

**Mezonlar:** o'rnatuvchi toza Windows'da ishlaydi (qo'lda tekshiruv skrinshot bilan); o'chirib qayta o'rnatganda ma'lumot qoladi.

**F0 yakuni:** CI yashil, o'rnatiladigan bo'sh ilova, Claude'ning alohida tekshiruvi.

---

## 8. F1 — Oflayn kassa

Barcha jadvallarda fiskal uchun kerakli maydonlar **shu bosqichdan** bo'ladi (`mxik`, `package_code`, `vat_rate`, `receipt_no`, `fiscal_doc` holati), qoidalar F3'da ulanadi.

### T1.1. Katalog
Mahsulot, kategoriya, variant (JSON atributlar), ko'p shtrix-kod, birliklar (dona, kg, g, litr, metr, m², qadoq), `unlimited` (xizmat/cheksiz), `min_stock`, narx tarixi. Qidiruv va skan indekslari.
**Mezonlar:** 50 000 mahsulotda skan ≤ 20 ms (domen va baza qismi); bir shtrix-kod do'kon ichida bitta yozuvga bog'lanadi.

### T1.2. Ombor va partiya
`stock_move`, sabablar (boshlang'ich, kirim, savdo, qaytarish, inventarizatsiya, tuzatish, buzildi, sindi, shaxsiy, yo'qoldi). `batch` (muddat, tannarx). Partiyali tovarda FIFO, boshqasida o'rtacha tannarx. Qoldiq proyeksiyasi. Inventarizatsiya.
**Mezonlar:** proyeksiya = ledger yig'indisi; FIFO qo'lda hisoblangan misollar; qayta qurish natijasi teng.

### T1.3. Savat va narx
Savat holati, aksiyalar (foiz, summa, N+M, muddat, qamrov), savdolashuv chegirmasi (ruxsat va limit), tez savdo qatori (katalogda yo'q tovar, nomi saqlanadi).
**Mezonlar:** chegirma qatorlarga aniq taqsimlanadi, jami tiyinigacha teng; kassir limitdan oshira olmaydi.

### T1.4. `completeSale`
3.1-bo'lim, 9–10-bandlar. Terminal bo'yicha ketma-ket `receipt_no`, `shift` havolasi. Zaxira siyosati (rad / ogohlantirish). Idempotent `clientRequestId`.
**Mezonlar:** ikki marta bosish bitta chek; yetmagan zaxirada to'liq rollback va keyingi savdo sog'; jarayon o'ldirilgandan keyin yarim chek yo'q.

### T1.5. To'lovlar
`payment` qatorlari (`cash`, `card`, `uzqr`, `payme`, `click`, `uzum`, `social_card`, `other`), aralash to'lov, qaytim faqat naqddan, qisman qarz. Invariant: `SUM(payment) + debt = total`. `cash_move` avtomatik.
**Mezonlar:** barcha kombinatsiyalar; invariant buzilishi rad etiladi.

### T1.6. Bekor qilish va qaytarish
`voided_at` (MONOTONE), to'liq va qisman qaytarish. Narx asl chekdan. Bir tovar ortiqcha qaytmaydi. Qarzdan ayirish varianti. Hisobotlar yagona ishorali `v_sales_lines` ko'rinishidan.
**Mezonlar:** ikki marta qaytarish rad etiladi; qaytarilgan chekni bekor qilish rad etiladi; foyda va tushum hisobi to'g'ri.

### T1.7. Mijoz qarz daftari
Mijoz profili, `customer_ledger`, boshlang'ich qarz, to'lov turi bilan qarz to'lash, kechikish ko'rinishi, to'lov tarixi.
**Mezonlar:** balans = ledger; ortiqcha to'lov siyosati aniq va testlangan.

### T1.8. Ta'minotchi va kirim
Ta'minotchi, kirim hujjati, tannarx, muddat, `supplier_ledger`, to'lovlar.
**Mezonlar:** tannarx noma'lum bo'lsa qarz taxminan yozilmaydi.

### T1.9. Smena va kun yakuni
Smena ochish/yopish, kutilgan naqd `cash_move`dan, naqdsiz `payment`dan avtomatik, sanoq va farq, xarajatlar. Snapshot o'zgarmas.
**Mezonlar:** naqdsiz summa qo'lda kiritilmaydi; qayta yopish tarixni saqlaydi; ikki kassir farqi ajraladi.

### T1.10. Buyurtma va avans
Holatlar, avans `cash_move`ga tushadi, tushum faqat topshirilganda, katalogda yo'q tovar qatori.
**Mezonlar:** avans olingan va ishlatilgan kunlarda kassa to'g'ri, tushum bir marta.

### T1.11. Kassa UI
Teginish va klaviatura bilan ishlash, USB skaner aniqlash (belgilar tezligi + Enter + forma; DataMatrix va GS belgisini buzmaydigan qilib), mahsulot qidiruv, to'lov ekrani, kechiktirilgan chek, tungi/kunduzgi mavzu.
**Mezonlar:** Playwright E2E: skan → to'lov → chek; sichqonsiz savdo; tez yozgan odam skaner deb qabul qilinmaydi.

### T1.12. Printer va chek
`PrinterDriver`: Windows uchun koffi orqali `winspool.drv` RAW, tarmoq uchun TCP 9100. Real printerda sinov natijasini hisobotda bering. ESC/POS, 58/80 mm, pul yashigi, kod sahifasi yoki transliteratsiya siyosati, printersiz rejim.
**Mezonlar:** bayt snapshot testlari; printer xatosi savdoni buzmaydi; qayta chop etish belgilanadi.

### T1.13. Hisobot, Excel, zaxira
Kunlik va oylik savdo, foyda (faqat egasi), qarzlar, kam qoldiq, muddati yaqin. Excel import (avval sinov, keyin tasdiq, shtrix-kod va nom bo'yicha moslash), eksport. Avtomatik zaxira, tiklash va yaxlitlik tekshiruvi.
**Mezonlar:** sotuvchi javobida tannarx yo'q (API test); zaxiradan tiklash summalar teng.

**F1 yakuni:** real kompyuter, printer va skaner bilan bir kun simulyatsiyasi; proyeksiyalar ledgerga teng.

---

## 9. F2 — Bulut, sinxron va biznes kabineti

### T2.1. Bulut API
Fastify + PostgreSQL, RLS, tashkilot, do'kon, foydalanuvchi, deploy (Docker Compose, Caddy, PostgreSQL zaxirasi). Server O'zbekistonda bo'lishi egasi qarori.
**Mezonlar:** `tenant` kontekstsiz so'rov ishlamaydi; ikki tashkilot izolyatsiya testi.

### T2.2. Qurilma juftlash
Bir martalik kod, qurilma tokeni, bekor qilish, aylantirish. Parol xeshi qurilmaga tushmaydi.
**Mezonlar:** bekor qilingan qurilma 401; PIN bulutga chiqmaydi.

### T2.3. Push
4-bo'lim. **Mezonlar:** 1 yomon + 10 yaxshi; begona `store_id`; begona havola; parallel ikki push bitta natija.

### T2.4. Pull va pozitsiya
4-bo'lim. **Mezonlar:** parallel yozishda hodisa o'tkazib yuborilmaydi (PostgreSQL'da haqiqiy parallel test); parked qayta qo'llanadi.

### T2.5. Bootstrap va qayta tiklash
Yangi hub va mavjud hubni tiklash. **Mezonlar:** har jadval tenant bilan filtrlangan; yarim yuklashdan davom etadi.

### T2.6. Proyeksiya va konfliktlar
Faqat tegilgan yozuvlar qayta hisoblanadi, to'liq qayta qurish ham bor. Konflikt UI. **Mezonlar:** qisman = to'liq natija.

### T2.7. Biznes kabineti
`apps/admin`: bugungi savdo, cheklar, tugayotgan tovar, onlayn buyurtmalar (F5 dan keyin), mahsulotlar, ombor, mijozlar, qarzlar, hisobotlar, xodimlar va ruxsatlar, qurilmalar, konfliktlar, sozlamalar. Har muhim amal (narx o'zgarishi, chek bekor qilish, qoldiq tuzatish) kim va qachon qilgani bilan ko'rinadi. Mobil moslashuv. UI Guzar brend uslubida.

### T2.8. Telegram bot va yakuniy test
Egaga kunlik xulosa, mijozga qarz eslatmasi (rozilik bilan), hisobni bog'lash. Integratsion test: ikki baza, oflayn savdo, ikki tomon sinxron, bekor, qaytarish, uzilish, soat farqi.
**Mezonlar:** oxirida ikki tomonda qoldiq, qarz va tushum teng; test 10 marta barqaror.

---

## 10. F3 — Qonuniy kassa

| Talab | Holat |
|---|---|
| Taqiqlangan MXIK uchun naqd chek rad etiladi | PF-246, 2026-yil 1-aprel (ekspert sharhi) |
| Muddati o'tgan tovar cheki rad etiladi | shu manba |
| Retsept dorisi retsept ma'lumotisiz rad etiladi | shu manba |
| Ijtimoiy karta: karta turi, raqami, tranzaksiya raqami | shu manba |
| Aralash chekda bitta taqiqlangan tovar bo'lsa, butun chek naqdsiz | shu manba |
| 25 mln so'm limiti bitta chekdagi bitta MXIK bo'yicha | shu manba |
| UzQR qabul qilish, fiskal chek bilan | PF-246, 2026-yil 1-iyul |
| Markirovka kodi "Asl belgisi" va MXIK mosligi bo'yicha tekshiriladi | VMQ-23, 2026-yil 1-iyul |
| Kassa dasturi davlat reyestrida bo'lishi kerak | `[TASDIQLANSIN]` |
| Chek maydonlari ro'yxati | `[TASDIQLANSIN]` — 2019-yil loyihasi |
| Oflayn chek 24 soat ichida operatorga | `[TASDIQLANSIN]` — 2019-yil loyihasi |

### T3.0. Hamkor va hujjatlar — EGASI QARORI, kod yo'q
Reyestrdagi virtual kassa hamkori, API hujjati, test muhiti, chek maydonlari, oflayn qoidalari. UzQR va Asl belgisi kirish hujjatlari. Kelguncha Fake drayverlar bilan ishlanadi.

### T3.1. MXIK va soliq sozlamalari
Mahsulot formasi, Excel, tashkilot STIR/manzil/QQS holati, MXIK'siz mahsulotlar ro'yxati.
**Mezonlar:** chek snapshot'i keyingi tahrirdan ta'sirlanmaydi; QQS yaxlitlash testlari.

### T3.2. Qoidalar dvigateli
`packages/rules`: `evaluate(cart, payments, context) → {block[], warn[]}`. Imzolangan (Ed25519), versiyalangan oflayn paket. Qoidalar: naqd bloki, aralash chek, 25 mln limit va istisnolar, retsept, ijtimoiy karta, muddat. UI va hub bir xil kodni ishlatadi, yakuniy tekshiruv `completeSale` ichida. Eskirgan paket: ogohlantirish.
**Mezonlar:** chegara qiymatli jadval testlari; imzosiz paket rad etiladi; API, bot va buyurtma yo'llari ham bloklanadi.

### T3.3. Fiskal yadro
`FiscalDriver` (`submitReceipt`, `submitRefund`, `openShift`, `closeShift`, `status`), `FakeFiscalDriver`. `fiscal_doc` holatlari: `pending`, `sent`, `confirmed`, `failed`, `rejected`. Idempotentlik kaliti `sale.id`. Fon navbati. Oflayn muddat konfiguratsiyada, yaqinlashganda ogohlantirish. Fiskallashgan chek faqat qaytarish orqali.
**Mezonlar:** uzilish, takror, yiqilish testlari; ikki marta fiskallashmaydi; driver javobisiz belgi yo'q.

### T3.4. Fiskal chek
QR, fiskal maydonlar konfiguratsiyadan, Fake belgisi.
**Mezonlar:** bayt snapshot; maydon yetishmasa chek "fiskal" deb chiqmaydi.

### T3.5. Haqiqiy fiskal drayver
Hujjat bilan, hamkor test muhitida. **Mezonlar:** hamkor test rejimida barcha oqimlar.

### T3.6. UzQR va to'lov yadrosi
`PaymentDriver` (`createQr`, `status`, `refund`), Fake. Dinamik QR, statik QR uchun qo'lda tasdiq, vaqt tugashi, kech tasdiq. Haqiqiy drayver hujjat bilan.
**Mezonlar:** tasdiqsiz chek yopilmaydi; kech tasdiq ikki marta yozilmaydi.

### T3.7. Markirovka
GS1 DataMatrix tahlili, birlikka bitta kod, chekda takror rad etish, `MarkingDriver` + Fake.
**Mezonlar:** namunalar bilan tahlil; kod soni = miqdor; EAN skaneri buzilmaydi.

### T3.8. Audit jurnali
Faqat qo'shiladigan xesh zanjiri: kirish, bekor, qaytarish, narx, chegirma, kassa ochish, rol, kun yakuni. Tekshiruv buyrug'i.
**Mezonlar:** tahrirlangan yozuv aniqlanadi.

### T3.9. Pilot
Kassir yo'riqnomasi, nosozlik kitobi, reliz ro'yxati.

**F3 yakuni:** pilot do'konda 2 hafta fiskal xatosiz. Haqiqiy fiskal ishga tushirish faqat egasining yozma tasdig'i bilan.

---

## 11. F4 — Ko'p kassa, web-kassa va obuna

| ID | Vazifa | Asosiy qabul mezoni |
|---|---|---|
| T4.1 | Ichki tarmoq hub'i, juftlangan terminallar, pinned TLS | Ruxsatsiz qurilma kira olmaydi |
| T4.2 | Ko'p kassa va parallel savdo | 3 terminalda zaxira va chek raqami to'g'ri |
| T4.3 | Terminalga bog'langan printer, yashik | Har terminal o'z printeriga chiqaradi |
| T4.4 | Android/planshet qobig'i va **web-kassa** (hub'ga LAN orqali, elektr uzilganda zaxira) | Printer va kamera skaneri ishlaydi; kompyuter o'chsa planshetdan savdo davom etadi |
| T4.5 | Payme, Click, Uzum drayverlari (hujjat bilan) | T3.6 mezonlari har provayderda |
| T4.6 | Tillar: o'zbek lotin, kirill, rus | Barcha matn `i18n`dan |
| T4.7 | **Obuna va tariflar:** Start, Business, Pro; bepul sinov davri; oflayn imzolangan litsenziya; platforma hisob-fakturasi | Muddat tugashi savdoni to'xtatmaydi; tarif chegarasi API'da ham tekshiriladi |
| T4.8 | Imzolangan avtomatik yangilanish, hub tiklash yo'riqnomasi | Yangilanish ochiq chekni buzmaydi, kassir vaqtini tanlaydi |

## 12. F5 — Guzar Market va onlayn vitrina

| ID | Vazifa | Asosiy qabul mezoni |
|---|---|---|
| T5.1 | Biznes profili: nom, yo'nalish, manzil, xarita nuqtasi, ish vaqti, rasmlar, aloqa; mahsulot rasmlari | Rasm hajmi va turi cheklangan; profil faqat egasi/menejer tomonidan o'zgaradi |
| T5.2 | Ochiq proyeksiya (2.5): ochiq e'lon qilingan katalog, menyu, narx, mavjudlik | Tannarx, qarz, xodim, mijoz maydonlari proyeksiyada yo'qligi testlangan; o'zgarish ≤ 1 daqiqada ko'rinadi |
| T5.3 | Market API va qidiruv: yaqin joylar (masofa), yo'nalish, ochiq/yopiq, aksiyalar, matn qidiruv (lotin/kirill) | 1 000 biznes, 200 000 ochiq mahsulotda qidiruv ≤ 200 ms |
| T5.4 | Mijoz akkaunti: telefon + bir martalik kod, profil, sevimlilar, tarix; faqat zarur ma'lumot | Bir xil raqamdan takror akkaunt yo'q; kod urinishlari cheklangan |
| T5.5 | Onlayn buyurtma va **qoldiqni vaqtincha band qilish** (TTL bilan), tasdiq, olib ketish | Oxirgi 2 donani ikki mijoz parallel buyurtma qilsa, bittasi oladi; bekor yoki muddat o'tsa band bo'shaydi; topshirish yagona `completeSale` orqali |
| T5.6 | Mijoz ilovasi (web + QR vitrina) va Telegram mini-ilova: bosh sahifa, biznes sahifasi, savat, buyurtma holati | O'rnatishsiz QR orqali ochiladi; Playwright: QR → savat → buyurtma → kabinetda ko'rinadi |
| T5.7 | Onlayn to'lov (UzQR va provayderlar), "kutilmoqda" holati, takroriy yechishdan himoya | Tasdiqsiz to'lov buyurtmani yopmaydi; kech tasdiq ikki marta yozilmaydi |
| T5.8 | Platforma komissiyasi hisobi (kelishilgan foiz), biznes uchun oylik akt | Komissiya faqat platforma orqali kelgan buyurtmadan; summalar hisobot bilan teng |
| T5.9 | Bildirishnomalar: buyurtma holati mijoz va biznesga (Telegram, push, SMS — port orqasida) | Bildirishnoma xatosi buyurtmani buzmaydi; reklama xabari faqat rozilik bilan |

## 13. F6 — Kafe va restoran

| ID | Vazifa | Asosiy qabul mezoni |
|---|---|---|
| T6.1 | Menyu: kategoriya, taom rasmi, tarkib, qo'shimchalar (sous, garnir) va modifikatorlar | Modifikator narxi chekda to'g'ri; ochiq menyuga chiqadi |
| T6.2 | Stollar sxemasi, ochiq stol hisobi, ofitsiant, chekni bo'lish va birlashtirish | Bo'lingan cheklar yig'indisi asl hisobga teng |
| T6.3 | QR menyu va stoldan buyurtma (mijoz telefonidan) | Buyurtma oshxona ekranida paydo bo'ladi; noto'g'ri stol QR rad etiladi |
| T6.4 | Oshxona ekrani (KDS): holatlar, tayyor bo'lganda ofitsiantga bildirishnoma | Internet uzilsa ham lokal hub orqali ishlaydi |
| T6.5 | Retsept/BOM: taom sotilganda xomashyo kamayadi | Xomashyo to'g'ri kamayadi; proyeksiya ledgerga teng |
| T6.6 | Olib ketish va stol band qilish (F7 bron dvigatelidan) | Band qilingan stol ikki marta berilmaydi |

## 14. F7 — Bron: fitnes, bilyard, xizmatlar

| ID | Vazifa | Asosiy qabul mezoni |
|---|---|---|
| T7.1 | Umumiy bron dvigateli: resurs (stol, zal, usta, post), jadval, ish vaqti, slot, sig'im | Bitta vaqt ikki marta sotilmaydi (PostgreSQL'da haqiqiy parallel test) |
| T7.2 | Vaqtinchalik band (to'lov yoki tasdiq kutilayotganda bir necha daqiqa), muddat o'tsa bo'shatish | Band paytida boshqa mijozga taklif qilinmaydi; muddat o'tgach avtomatik bo'shaydi |
| T7.3 | Depozit va oldindan to'lov, bekor qilish qoidalari (oldindan ko'rsatiladi), kelmaganlar | Depozit `order_payments` kabi hisoblanadi; tushum faqat xizmat ko'rsatilganda |
| T7.4 | Bilyard va vaqtli xizmat: o'yin vaqtini avtomatik hisoblash, soatbay narx, savdo bilan birlashtirish | Har biri `completeSale` orqali; vaqt hisobi daqiqagacha to'g'ri |
| T7.5 | Fitnes: abonement turlari, muddati, muzlatish, tashriflar, murabbiylar, guruh darsiga yozilish va bo'sh joylar | Muzlatish muddatni to'g'ri suradi; sig'imdan ortiq yozilish yo'q |
| T7.6 | Xizmatlar: salon, avtoservis, o'quv markazi — usta va vaqt bo'yicha qabulga yozilish | Bir usta bir vaqtda bitta mijoz |
| T7.7 | Bron ziddiyati qoidasi: birinchi tasdiqlangan qoladi, ikkinchiga boshqa vaqt va bonus taklifi | Ziddiyat jurnalga tushadi va biznesga ko'rinadi |

## 15. F8 — Yetkazib berish

**Ishga tushirishdan oldin (egasi va huquqshunos):** haydovchilarni tekshirish, transport talablari, sug'urta, javobgarlik, yetkazish xizmati uchun fiskal chek tartibi. Avval kichik hududda sinov.

| ID | Vazifa | Asosiy qabul mezoni |
|---|---|---|
| T8.1 | Haydovchi ro'yxati: shaxsni tasdiqlash, transport, hujjatlar, "ishdaman" holati | Tasdiqlanmagan haydovchi buyurtma ololmaydi |
| T8.2 | Haydovchi ilovasi (`apps/driver`): taklif (masofa va to'lov), qabul, olib ketish va topshirishni tasdiqlash, daromad tarixi | Bitta buyurtmani ikki haydovchi bir vaqtda qabul qila olmaydi (server kafolati, parallel test) |
| T8.3 | Taqsimlash: joylashuv, biznesgacha masofa, transport, yuklama, sifat | Qayta taqsimlash haydovchi kelmasa avtomatik |
| T8.4 | Buyurtma yo'li va kuzatish: 8 holat, mijoz va biznesga bildirishnoma | Holatlar faqat oldinga o'tadi; har o'tish audit bilan |
| T8.5 | Yetkazish narxi va hisob-kitob: haydovchi ulushi, platforma ulushi, naqd puldagi farq | Naqd farqi alohida qayd etiladi; summalar teng |
| T8.6 | Qoidalar: haydovchi bekor qilsa, kechiksa, mijoz bo'lmasa, mahsulot shikastlansa, ob-havo | Har holat uchun yozilgan oqim va testi |

## 16. F9 — O'sish

**AI chegaralari:** AI pul yoki omborni tasdiqsiz o'zgartirmaydi. Tashqi modelga shaxsiy ma'lumot yuborilmaydi. Provayder almashtiriladi. Internetsiz qoidaviy yordamchi ishlaydi. Har chaqiruv xarajati yoziladi. AI va tahlil xizmatlari Python'da bo'lishi mumkin (2.4).

| ID | Vazifa | Asosiy qabul mezoni |
|---|---|---|
| T9.1 | Sodiqlik: ball, kupon, do'st taklifi (soxta akkauntlardan himoya), tug'ilgan kun aksiyasi | Ball FACT, sinxronda yo'qolmaydi |
| T9.2 | Reklama: kategoriyada yuqori o'rin, banner, hududiy aksiya; "reklama" belgisi doim ko'rinadi | Reklama belgisi testlangan; to'lov bilan bog'langan |
| T9.3 | Reyting va izohlar: faqat haqiqiy buyurtma yoki brondan keyin | Soxta izoh qo'shib bo'lmaydi |
| T9.4 | Kengaytirilgan tahlil (pullik): qaysi mahsulot sotilyapti, kim qaytib kelyapti, qaysi aksiya ishladi | Raqamlar hisobotdan, modeldan emas |
| T9.5 | Tashkilot → filial → ombor, filial hisobotlari, filiallararo ko'chirish | Yo'ldagi tovar ikki marta hisoblanmaydi |
| T9.6 | Kengaytirilgan rollar, modul bayroqlari va soha paketlari | O'chiq modul API'da ham yopiq |
| T9.7 | Telefon (IMEI/seriya), dorixona (retsept, markirovka), kiyim, tarozi, ulgurji | Har biri `completeSale` orqali |
| T9.8 | Ochiq API, kalitlar, webhook imzosi, OpenAPI | Kalit faqat o'z tashkilotiga kiradi |
| T9.9 | Buxgalteriya eksporti | Summalar hisobot bilan teng |
| T9.10 | AI provayder qatlami va PII filtri (Python mumkin) | So'rovda PII yo'qligi testlangan |
| T9.11 | O'zbekcha savol-javob, ovoz, buyurtma tavsiyasi, anomaliya (Python mumkin) | Sonlar hisobotdan; tavsiya oddiy o'rtachadan yaxshiligi o'lchangan |
| T9.12 | Platforma boshqaruvi: bizneslarni ulash, nazorat, yordam, yangi hududlar | Platforma xodimi biznes ma'lumotini faqat ruxsat va audit bilan ko'radi |

---

## 17. Egasi qarorlari

| Qaror | Holat / qachon kerak |
|---|---|
| Yangi `mezon` repozitoriyasini ochish | Bajarildi |
| Server tili | **TypeScript** (2026-11-11), Python chegaralangan xizmatlar uchun (2.4) |
| Brend: "Guzar" nomi, logotip, ranglar, shior; domen va savdo belgisini rasmiylashtirish | Brend uslubi F2 dagi kabinet UI'sidan oldin; rasmiylashtirish F3 yakunidan oldin |
| Server joyi va 27-1-modda bo'yicha huquqshunos fikri | T2.1 |
| Virtual kassa hamkori va API hujjatlari | T3.0 |
| UzQR va Asl belgisi hujjatlari | T3.6, T3.7 |
| Pilot bizneslar (konsepsiya: 5 do'kon, 3 kafe, 1 restoran, 1 fitnes, 1 bilyard) | F3 yakuni va har bosqich pilotida |
| Tariflar (gipoteza: Start 99–149 ming, Business 199–299 ming, Pro 399–599 ming so'm) va bepul sinov davri | T4.7 |
| Onlayn buyurtma komissiyasi (gipoteza 1,5–2%) | T5.8 |
| Yetkazish: huquqiy tartib, sug'urta, haydovchi talablari, fiskal chek | F8 boshlanishidan oldin |

---

## 18. Birinchi qadam

1. Repozitoriya bo'sh ekanini tasdiqlang. Unda MiniERP kodi bo'lmasligi kerak.
2. Hujjatdagi noaniq joylarni ro'yxat qiling.
3. `T0.1` uchun reja bering va kod yozishdan oldin tasdiq kuting.
