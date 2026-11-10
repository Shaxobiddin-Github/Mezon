# Mezon: noldan qurish bo'yicha to'liq topshiriq

> **Bajaruvchi:** Gemini.
> **Ish boshqaruvchi va tekshiruvchi:** Claude.
> **Qaror egasi:** loyiha egasi (Shaxobiddin).
> **Mahsulot:** Mezon (to'liq nomi: Mezon Kassa).
> **Loyiha:** yangi, bo'sh repozitoriya: `mezon`. Paketlar nomi: `@mezon/domain`, `@mezon/rules` va h.k.

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

O'zbekiston qonunlariga mos, internetsiz ishlaydigan, turli sohalarga moslanadigan POS tizimi.

**Foydalanuvchilar:** kassir, do'kon egasi, tarmoq menejeri, buxgalter.

**Sifat maqsadlari:**

| Ko'rsatkich | Maqsad |
|---|---|
| Skanerdan savatdagi qatorgacha | ≤ 150 ms (50 000 mahsulotli hub) |
| Savdoni yakunlash (lokal) | ≤ 300 ms |
| Internet uzilishi | Savdo to'xtamaydi |
| Yiqilishdan keyin | Yakunlangan savdo yo'qolmaydi |
| Kassirni o'rgatish | 15 daqiqa ichida birinchi savdo |
| Past quvvatli monoblok | 4 GB RAM, Windows 10 22H2+ da silliq |

**Doiradan tashqari:** buxgalteriya bosh kitobi, HR/maosh, AI agent savdo protokollari, MiniERP bilan integratsiya.

---

## 2. Arxitektura

```text
Terminallar: Windows (Electron), Android (Capacitor) — bitta React UI
        │  do'kon ichki tarmog'i, juftlangan qurilmalar
Do'kon hub'i: Fastify + SQLite, domen, qoidalar, fiskal/to'lov navbati
        │  internet bo'lganda
Bulut (O'zbekistonda): Fastify + PostgreSQL, egasi paneli, bot, AI
        │
Soliq/OFD · UzQR · Payme/Click/Uzum · Asl belgisi · yetkazib berish
```

- **Yagona kassa:** hub va terminal bitta Electron ilovasida.
- **Ko'p kassa:** bitta kompyuter hub, qolganlari unga ulanadi.
- **Haqiqat manbai:** savdo paytida hub, do'konlararo ko'rinish uchun bulut.

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
  admin/        egasi va tarmoq paneli
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

| Bosqich | Natija | Vazifalar | Taxminiy muddat |
|---|---|---|---|
| F0. Poydevor | Monorepo, domen asoslari, CI | T0.1–T0.7 | 3–4 hafta |
| F1. Oflayn kassa | Bitta kompyuterda to'liq do'kon | T1.1–T1.13 | 8–10 hafta |
| F2. Bulut va sinxron | Egasi telefondan ko'radi | T2.1–T2.8 | 6–8 hafta |
| F3. Qonuniy kassa | Pilotga tayyor | T3.0–T3.9 | 8–10 hafta |
| F4. Ko'p kassa va tijorat | Keng sotuvga tayyor | T4.1–T4.8 | 6–8 hafta |
| F5. Soha va filial | Universal | T5.1–T5.8 | 8–10 hafta |
| F6. Omnikanal va API | Tashqi ulanishlar | T6.1–T6.5 | 6–8 hafta |
| F7. AI | Yordamchi | T7.1–T7.5 | doimiy |

Bosqich mezoni bajarilmaguncha keyingisi boshlanmaydi.

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

## 9. F2 — Bulut va sinxron

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

### T2.7. Egasi paneli
`apps/admin`: dashboard, hisobot, mahsulot, konfliktlar, qurilmalar. Mobil moslashuv.

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

## 11. F4 — Ko'p kassa va tijorat

| ID | Vazifa | Asosiy qabul mezoni |
|---|---|---|
| T4.1 | Ichki tarmoq hub'i, juftlangan terminallar, pinned TLS | Ruxsatsiz qurilma kira olmaydi |
| T4.2 | Ko'p kassa va parallel savdo | 3 terminalda zaxira va chek raqami to'g'ri |
| T4.3 | Terminalga bog'langan printer, yashik | Har terminal o'z printeriga chiqaradi |
| T4.4 | Android qobig'i, yolg'iz va terminal rejimi | Printer va kamera skaneri ishlaydi |
| T4.5 | Payme, Click, Uzum drayverlari (hujjat bilan) | T3.6 mezonlari har provayderda |
| T4.6 | Tillar: o'zbek lotin, kirill, rus | Barcha matn `i18n`dan |
| T4.7 | Litsenziya va tariflar (Start, Biznes, Tarmoq), oflayn imzo | Muddat tugashi savdoni to'xtatmaydi |
| T4.8 | Imzolangan avtomatik yangilanish, hub tiklash yo'riqnomasi | Yangilanish ochiq chekni buzmaydi, kassir vaqtini tanlaydi |

## 12. F5 — Soha va filial

| ID | Vazifa | Asosiy qabul mezoni |
|---|---|---|
| T5.1 | Tashkilot → filial → ombor, filial hisobotlari | Filial foydalanuvchisi boshqasini ko'rmaydi |
| T5.2 | Filiallararo ko'chirish | Yo'ldagi tovar ikki marta hisoblanmaydi |
| T5.3 | Kengaytirilgan rollar | Backendda tekshiriladi |
| T5.4 | Modul bayroqlari va soha paketlari | O'chiq modul API'da ham yopiq |
| T5.5 | Telefon: IMEI/seriya | Bitta IMEI ikki marta sotilmaydi |
| T5.6 | Dorixona: retsept, partiya, markirovka | F3 qoidalari bilan to'liq oqim |
| T5.7 | Kafe: stol, oshxona ekrani, modifikator, BOM, chek bo'lish | Xomashyo to'g'ri kamayadi |
| T5.8 | Vaqtli xizmat (bilyard, klub), tarozi, kiyim, ulgurji | Har biri `completeSale` orqali |

## 13. F6 — Omnikanal va API

| ID | Vazifa | Asosiy qabul mezoni |
|---|---|---|
| T6.1 | Ochiq API, kalitlar, webhook imzosi, OpenAPI | Kalit faqat o'z tashkilotiga kiradi |
| T6.2 | Telegram do'kon | Onlayn buyurtma qoldiqni band qiladi |
| T6.3 | Yetkazib berish (hujjat bilan) | Takror buyurtma yaratilmaydi |
| T6.4 | Sodiqlik: ball, kupon | Ball FACT, sinxronda yo'qolmaydi |
| T6.5 | Buxgalteriya eksporti | Summalar hisobot bilan teng |

## 14. F7 — AI

**Chegaralar:** AI pul yoki omborni tasdiqsiz o'zgartirmaydi. Tashqi modelga shaxsiy ma'lumot yuborilmaydi. Provayder almashtiriladi. Internetsiz qoidaviy yordamchi ishlaydi. Har chaqiruv xarajati yoziladi.

| ID | Vazifa | Asosiy qabul mezoni |
|---|---|---|
| T7.1 | Provayder qatlami, shaxsiy ma'lumot filtri | So'rovda PII yo'qligi testlangan |
| T7.2 | O'zbekcha savol-javob, ovoz | Sonlar modeldan emas, hisobotdan |
| T7.3 | Buyurtma tavsiyasi | Oddiy o'rtachadan yaxshiligi o'lchangan |
| T7.4 | Anomaliya: ko'p bekor, chegirma, kassa farqi | Soxta signal darajasi o'lchangan |
| T7.5 | Tasdiq bilan bajariladigan amallar | Domen komandalari, tasdiq va audit bilan |

---

## 15. Egasi qarorlari

| Qaror | Qachon kerak |
|---|---|
| Yangi `mezon` repozitoriyasini ochish | T0.1 |
| Domen va "Mezon" savdo belgisini rasmiylashtirish | F3 yakunidan oldin |
| Server joyi va 27-1-modda bo'yicha huquqshunos fikri | T2.1 |
| Virtual kassa hamkori va API hujjatlari | T3.0 |
| UzQR va Asl belgisi hujjatlari | T3.6, T3.7 |
| Pilot do'kon | F3 yakuni |
| Tarif narxlari | T4.7 |

---

## 16. Birinchi qadam

1. Repozitoriya bo'sh ekanini tasdiqlang. Unda MiniERP kodi bo'lmasligi kerak.
2. Hujjatdagi noaniq joylarni ro'yxat qiling.
3. `T0.1` uchun reja bering va kod yozishdan oldin tasdiq kuting.
