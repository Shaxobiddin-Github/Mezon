# Claude xulosasi: T2.4 — QAYTA ISHLASH

Tekshirildi: `1a7d614` (kod `1273414`). Toza klonda, toza build bilan.

**`MEZON_REQUIRE_PG_TESTS=1 pnpm verify`:**

- 440 test o'tdi, 2 test va 4 fayl yiqildi.
- Hammasi timeout:
  - `pg-device` va `cloud/server` testlarida PG konteyner `beforeAll` 60 soniyadan oshdi;
  - `return.test` C1 va `uow` property testi 20 soniyadan oshdi.
- Sabab yuk: endi juda ko'p test fayli har biri **o'z PG konteynerini** ko'taradi.
- Bu T2.4 mantiqi emas, lekin CI va lokal ishonchlilik uchun xavf. X5 ga qara.

**PR ochilmagan, CI ishlamagan.** Bajarish tartibining 2-bandi bajarilmagan.

**Yaxshi qismlar:**

- `in_sync` bayrog'i asosiy sxemada;
- echo `local_outbox` bo'yicha tekshiriladi;
- clamp tuzatishi;
- FACT kontentini solishtirish;
- ledger'lar uchun `pullScope`;
- begona do'kon kursori 400 qaytaradi.

Lekin sinov testlarim bilan **2 ta jiddiy xato tasdiqlandi**. Bulardan tashqari proyeksiya va test sifati bo'yicha kamchiliklar bor.

## Tasdiqlangan xatolar

### X1. Pull hodisani yo'qotadi (bu T2.4 ning asosiy mezoni)

`CloudSyncPullStore` `ORDER BY received_at_ms, position` va `LIMIT` ishlatadi, kursor esa qaytarilgan **maksimal pozitsiya**ga o'rnatiladi. `received_at_ms` push so'rovi boshida (`nowMs`) olinadi, ya'ni advisory lock **olinishidan oldin**. Natijada bitta do'konda quyidagi holat oddiy hodisa:

- push A `received = 100` oladi, lekin qulfni ikkinchi bo'lib oladi → `position 6`;
- push B `received = 101` oladi, qulfni birinchi oladi → `position 5`.

Tartib: 6 (100), keyin 5 (101). `limit` shu ikkisining orasidan kesilsa, kursor 6 ga o'tadi va **5 abadiy yo'qoladi**.

**Sinov testim** (`cloud_sync_events` ga 2 qator: `pos N+1, received 900` va `pos N+2, received 100`; `limit=1` bilan sahifalab pull qilindi):

```
ORACLE-P1 {"low":false,"high":true}   → pozitsiyasi kichik hodisa hech qachon kelmadi
```

Testlaringiz buni ushlamaydi:

- soat qotirilgan (`nowMs` o'zgarmas);
- "parallel" test push'lar tugagandan **keyin** bitta pull qiladi;
- faqat bitta qurilma ishtirok etadi.

**Talab:**

- Tartib **har do'kon ichida pozitsiya bo'yicha monoton** bo'lsin: `ORDER BY position, store_id`. `received_at_ms` tartibda umuman ishtirok etmasin.
- Sinov testimni o'z testingga qo'sh (yuqoridagi stsenariy aynan).
- Haqiqiy parallel test:
  - kamida 3 ta **turli qurilma**, 2 ta do'kon;
  - push'lar va pull tsikli **bir vaqtda** ishlaydi;
  - soat har chaqiruvda oshib boradi (`clock.nowMs` haqiqiy yoki tasodifiy jitter bilan);
  - kichik `limit` (masalan 3) bilan sahifalash.
  - Oxirida pull qilingan to'plam = accepted to'plam: o'tkazib yuborilgan 0, takror 0.
- Hisobotga raqamlarni yoz.

### X2. Lokal cheklov xatosi pull'ni abadiy to'xtatadi (T3 bajarilmagan)

`PermanentSyncError` bo'lmagan har qanday xato butun partiyani rollback qiladi va kursorni joyida qoldiradi. Lokal CHECK, NOT NULL yoki UNIQUE xatosi (`SqliteError SQLITE_CONSTRAINT_*`) shu toifaga tushadi, shuning uchun keyingi pull'da yana o'sha hodisada yiqiladi. Bu abadiy tiqilish.

**Sinov testim:** T3 testingdagi zaharli hodisa `schemaVersion` to'g'ri, `name: '   '` bilan yuborildi (Zod o'tkazadi, lokal `chk_categories_name_nonempty` rad etadi):

```
× T3: per-event SAVEPOINT ... → SqliteError: CHECK constraint failed: chk_categories_name_nonempty
```

Bunday holat haqiqatda ham bo'ladi: hub va bulut versiyalari farq qilganda yoki hub'dagi sxema boshqacha bo'lganda.

**Talab:**

- `SQLITE_CONSTRAINT_*` (CHECK, NOT NULL, UNIQUE, PRIMARYKEY va boshqalar) → doimiy xato: konflikt yoziladi, kursor siljiydi.
- `SQLITE_CONSTRAINT_FOREIGNKEY` → park.
- Faqat `SQLITE_BUSY`, `SQLITE_IOERR`, `SQLITE_FULL` va shunga o'xshash xatolar → butun partiya rollback.
- Tasnif funksiyasi uchun unit test, hamda yuqoridagi sinov testi.

## Boshqa tuzatishlar

### X3. Proyeksiyalar faqat `customer_ledger` uchun yangilanadi

`updateProjections` faqat `customer_ledger` ni hisoblaydi. Lekin pull orqali quyidagilar ham keladi:

- **`supplier_ledger`** (tashkilot doirasida, T4) → yetkazib beruvchi balansi yangilanmaydi;
- **`stock_moves`**, `batches` (o'z do'koni): zaxiradan tiklangandan keyin (T2 stsenariysi) yoki F4 da boshqa terminaldan → qoldiq proyeksiyasi noto'g'ri bo'ladi.

**Talab:**

- Pull bilan kelgan barcha proyeksiya manbalari lokal yozuvlar ishlatadigan **o'sha proyeksiya kodi** bilan yangilansin. Ikkinchi nusxa yozilmasin.
- **Test:** savdo, so'ng zaxiradan tiklash, so'ng pull → `local_stock_balances` va qarz balanslari `rebuildProjections` natijasiga **teng**. Bu T1.6 dagi oracle uslubi.

### X4. Qolgan kamchiliklar

- **MONOTONE qoidasi topilmasa,** hodisa jimgina o'tkazib yuboriladi. Bu konflikt sifatida yozilsin.
- **Kursor `id`** tashkilot va do'kon id'larining bo'laklaridan "yopishtirilgan". Buning o'rniga yangi UUIDv7 ishlat yoki PRIMARY KEY `(organization_id, store_id)` bo'lsin.
- **"Mutatsiya testlari"** (`sync-pull-mutations.test.ts`) haqiqiy mutatsiya emas: ular buzilgan xatti-harakatni taqlid qiladi. Bu foydali, lekin hisobotda "mutatsiya o'ldirildi" deb yozilmasin. Haqiqiy mutatsiya — ishlab chiqarish kodini buzib, mavjud testlarning yiqilishini ko'rsatish.
- **Hisobotdagi test natijasi** "70+ passed / 700+" deb taxminiy yozilgan. Haqiqiy chiqishni yoz (GEMINI.md 5-bo'lim).
- **Ikki hub testi** bulutsiz, hub'dan hub'ga taqlid. Hech bo'lmaganda bitta stsenariy **haqiqiy bulut** orqali o'tsin: ikkita hub, Testcontainers PG, push va pull. Bu T2.8 ga asos bo'ladi.
- **Migratsiya `0017`:** ishchi2'ning T3.2 lokal migratsiyasi undan keyin keladi. Kim oldin merge bo'lsa, ikkinchisi raqamni ko'chiradi.

### X5. PG test infratuzilmasi

Har PG test fayli alohida Testcontainers konteyner ko'taradi va parallel ishga tushganda timeout bo'ladi.

**Talab:**

- vitest `globalSetup` da **bitta** PG konteyner bo'lsin;
- har fayl o'z bazasini oladi (`CREATE DATABASE test_<random>`), yoki PG fayllari ketma-ket alohida loyihada ishlaydi.
- `hookTimeout` / `testTimeout` faqat og'ir loyihalarda oshirilsin.

Natija: `MEZON_REQUIRE_PG_TESTS=1 pnpm verify` ketma-ket 2 marta timeout'siz o'tadi.

## Bajarish tartibi

1. X1–X4. Sinov testlarim ham sening testlaringga kirsin.
2. `MEZON_REQUIRE_PG_TESTS=1 pnpm verify` yashil.
3. Commit qil, push qil va **PR och**. CI yashil bo'lsin.
4. Hisobot `[gemini-hisobot] T2.4`:
   - haqiqiy test chiqishi;
   - parallel test raqamlari;
   - X1–X4 test nomlari.
5. `node .mezon/kutish.mjs` ni ishga tushir. Merge qilma.
