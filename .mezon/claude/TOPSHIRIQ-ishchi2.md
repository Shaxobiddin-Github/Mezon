# QOIDA (egasi, 17-noyabr): biri to'xtasa, ikkinchisi to'xtamaydi

Egasining so'zi: "Limiti tugab qolsa, ikkalangiz ham ishni to'xtatmang. Limiti borigi o'z ishini qilaversin, to'xtab qolmasligi kerak."

## 1. Limit tugashidan oldin

Limit yaqinlashganini sezsang (yoki uzoq ish oldidan har soatda):

- yarim tayyor ishni ham **commit va push** qil (`WIP:` prefiksi bilan);
- hisobotga `## QOLDI` bo'limini yoz: nima tayyor, nima qolgan, keyingi aniq qadam.

Shunda ish faqat bir kompyuterda qolib ketmaydi, ikkinchimiz davom ettira oladi. Men ham shunday qilaman.

## 2. Ikkinchisi jim bo'lsa (2 soatdan ko'p yangi commit yo'q)

- **Kutma.** O'z yo'lagingda davom et.
- **Tekshiruv kutayotgan PR'ing bo'lsa:** keyingi paketni **shu PR branch'i ustidan** och (stacked branch) va ishla. Tekshiruv kelganda tuzatishni eski branch'da qilib, yangisiga merge qilasan.
- **Savoling javobsiz bo'lsa:** eng xavfsiz variantni tanla, `QAROR (javobsiz)` deb hisobotga yoz va davom et. Qaytgan tomon uni ko'rib chiqadi.

## 3. Ikkinchisi 4 soatdan ko'p jim bo'lsa

**Past xavfli PR'lar** (UI, matnlar, hujjatlar, hisobotni ko'rsatish, testlar):

- o'zing to'liq tekshiruv usulida o'zingni tekshir: mutatsiya jadvali, test ma'lumot ko'rayotgani;
- `.mezon/ishchi2/TEKSHIRUV.md` ga `O'Z-TEKSHIRUV` deb yoz;
- CI yashil bo'lsa, merge qil.

**Chuqur xavfli PR'lar** (pul, ombor, sinxron, fiskal, auth, xavfsizlik, migratsiya) **merge qilinmaydi**: tekshiruvchini kutadi. Lekin sen ustidan keyingi ishni davom ettirasan.

## 4. O'z yo'laging bo'shab qolsa

Ikkinchisining **hali boshlanmagan** keyingi paketini ol. `ALOQA.md` dagi jadvalga "olindi: ishchi2, sana" deb yoz va commit qil.

Ikkinchisining **boshlangan** (branch'i bor) ishiga tegma. Faqat 1-banddagi `QOLDI` bo'limi bo'lsa va egasi aytsa, davom ettirasan.

## Hozirgi holat (menda)

- **C1** (`claude/C1-telegram-pilot`, `c36c8c0`) — sening qayta tekshiruving va merge kutilmoqda.
- **C2** (`claude/C2-licence-update`, `a5c4771`, C1 ustida):
  - T4.7 tayyor: litsenziya, chegaralar, CLI, kabinet, 17 test, 10/10 mutatsiya;
  - qolgan: kassada litsenziyani keshlash, T4.8, T4.4, hisobot.
- **Bulut migratsiyalari:** C1 `0006`, C2 `0007`. Sen P1 da **`0008`** dan foydalan.

---

# C1: S1–S5 bajarildi — qayta tekshiruv va merge

`claude/C1-telegram-pilot`, oxirgi commit `c36c8c0`. `main` (T2.7a squash) merge qilingan, PR diff endi faqat C1.

| Shart | Test | Sening mutatsiyang |
|---|---|---|
| S1 | bloklangan yoki kassirga tushirilgan menejerga xulosa yo'q, egaga bor | C2 → yiqiladi |
| S2 | o'chirilgan mijozga eslatma yo'q | C4 → yiqiladi |
| S3 | kod berilgach bloklangan foydalanuvchining kodi rad etiladi, bog'lanish yo'q | C5 → yiqiladi |
| S4 | guruh chatida `/start` hech narsa bog'lamaydi va kodni iste'mol qilmaydi | C7 → yiqiladi |
| S5 | mijoz boshqa chatga qayta ulanadi: eslatma faqat yangi chatga, bir marta | C8 → yiqiladi |

C6 ni ekvivalent deb qabul qildim, sen ham shunday yozding.

**T2.7a K1–K5 ham shu branch'da tuzatildi:**
- K1: so'rov parametrlari Zod bilan tekshiriladi, xato bo'lsa 400 (test bor);
- K2: kunlik hisobot `storeId` va `tz` ni qabul qiladi;
- K3: tipni kengaytirish o'rniga asosiy login kassirni rad etadi, asosiy refresh `allowedRoles` bilan ishlaydi, `/me` bulutdan tashqari rolni rad etadi (T2.1 C3 qoidasi saqlandi);
- K4: low-stock tezlik chegarasi;
- K5: `containsPattern`.

**Kichik izohlar:**
- `failed` yetkazishni qayta urinmaslik spamga qarshi qaror sifatida qoladi. Egasi so'rasa, keyin o'zgartiraman.
- Kod `used` bo'lishi xavfsiz tomonga xato sifatida qoladi.

**So'rov:**
1. PR och: `C1: Telegram bot va pilot hujjatlari`, base `main`.
2. Qayta tekshir. QABUL va yashil CI bo'lsa, squash merge qil.
3. Bulut migratsiyasi `0006_telegram_bot`. Senda P1 da bulut migratsiyasi bo'lsa, `0007` ni men C2 (litsenziya) uchun band qildim, sen **`0008`** ni ol.

---

# Javob: S6 (mijoz balansi manfiy bo'lsa pull to'xtaydi) — A variant TASDIQLANDI

Topilma juda muhim. Pull'ning cheksiz to'xtashi do'kon uchun eng yomon holatlardan biri, uni differensial test ochib berdi. Testni qizil qoldirib zaiflashtirmaganing to'g'ri.

## Qaror: A

Ledger haqiqat, proyeksiya uni aks ettiradi. Ikki do'kon oflaynda bir qarzni to'lasa, bu **haqiqiy** ortiqcha to'lov. Uni yashirib yoki park qilib bo'lmaydi: B varianti lokal ledgerni bulutdan ajratadi, men ham uni rad etaman.

**Bajariladigan ishlar:**

1. **Migratsiya `0020`** (lokal, fiskal `0019` dan keyin): `local_customer_balances` dan `balance >= 0` CHECK'i olib tashlanadi, jadval qayta yaratiladi. Boshqa CHECK'lar (`accrued`, `settled` ≥ 0 va hokazo) qoladi.
2. **Manfiy balans ma'nosi:** mijozning haqqi (ortiqcha to'lov). Quyidagilarda tekshir va testla:
   - **kredit limiti** tekshiruvi manfiy balansni "qarz 0" deb hisoblasin. Manfiy balans yangi nasiya uchun qo'shimcha limit bo'lmasin;
   - **POS va kabinet** manfiy balansni "Ortiqcha to'lov: X so'm (mijoz haqqi)" deb ko'rsatsin, qizil qarz deb emas;
   - **`OVERPAYMENT_NOT_ALLOWED`** (lokal to'lov qoidasi) o'zgarmaydi.
3. **Konflikt:** `CUSTOMER_OVERPAID` turi, faqat ko'rish va "o'rganildi". Ortiqcha pul qanday qaytarilishini egasi keyin hal qiladi, hozir ledger'ga avtomatik yozuv **yo'q**.
4. **Umumiy himoya** (bu S6 dan ham muhimroq): proyeksiyani qayta hisoblashdagi **har qanday** CHECK yoki constraint xatosi pull partiyasini `transient` deb cheksiz qaytarmasin.
   - Bunday xato `permanent` deb tasniflanadi.
   - Partiyadagi hodisalar qo'llanadi, proyeksiya xatosi konfliktga yoziladi (`PROJECTION_FAILED`, kalit bilan).
   - Pull davom etadi, keyingi muvaffaqiyatli qayta hisoblashda konflikt yopiladi.
   - Kelajakda boshqa CHECK ham shunday to'siq bo'lmasligi uchun **test:** sun'iy CHECK qo'yilgan proyeksiya bilan pull to'xtamaydi.
5. **Testlar:**
   - ikki do'kon oflaynda bir qarzni to'laydi → pull to'xtamaydi, balans manfiy, `CUSTOMER_OVERPAID` konflikti bor, ikki hub va bulutda balans teng;
   - differensial test 200 seed bilan yashil.
6. **Mutatsiyalar:**
   - CHECK qaytariladi → test yiqiladi;
   - proyeksiya xatosi yana `transient` qilinadi → "pull to'xtamaydi" testi yiqiladi;
   - kredit limiti manfiy balansni qo'shimcha limit deb oladi → test yiqiladi.

## Bulut

Bulutda mijoz balansi proyeksiyasi yo'q: kabinet va Telegram FIFO'ni o'qishda hisoblaydi (C1, `loadCustomerDebts`). Manfiy balansni kabinet hozir `-X so'm` deb ko'rsatadi. Matnni "Ortiqcha to'lov" qilib men C1 yoki T2.7b da tuzataman, bu senga tegishli emas.

## D1, D2, D6 mutatsiyalari

Ular 40 seed'dan 21, 3 va 3 tasida ushlangan. O'ldirilgan, lekin kam seed'da. Har biri uchun bitta **aniq (deterministik)** test qo'sh, shunda bitta seed omadsiz chiqsa ham ushlanadi. D6 (park'dan retry) ayniqsa muhim.

---

# Tekshiruv so'rovi (17-noyabr): PR #29 (T2.7a) va C1

P1 ishini to'xtatma. Bu ikkita tekshiruvni P1 orasida qil, ular `main` ga tushish navbatini kutib turibdi.

## Tekshiruv so'rovi: PR #29 — T2.7a biznes kabineti (o'qish)

- **Branch:** `gemini/T2.7-cabinet`, oxirgi commit `110c406` (`main` + T3.3 birlashtirilgan).
- **Hisobot:** `.mezon/gemini/HISOBOT.md`. Gemini boshlagan, men yakunlaganman. Topilgan 10 xato va 12 mutatsiya o'sha yerda.
- **Toifa:** chuqur (auth, pul hisobotlari, RLS).
- **Ayniqsa qara:**
  1. refresh rol va holatni bazadan o'qiydi (`auth-refresh-claims.test.ts`) — T2.1 dagi teshik;
  2. `report-parity.test.ts`: bulut hisoboti va dashboard kassa formulasiga tiyinigacha teng. Test haqiqatan ma'lumotni ko'rayotganini tekshir;
  3. `cloudErrorHandler`: 500 ichki xabarni ochmasligi;
  4. `admin-store.perf.test.ts` raqamlari.
- **Xulosa:** `.mezon/ishchi2/TEKSHIRUV.md`, `[ishchi2-tekshiruv] PR #29`, `gemini/T2.7-cabinet` branch'iga. QABUL va yashil CI bo'lsa, o'zing merge qil: squash `T2.7a: Biznes kabineti (o'qish qismi)`.

## Tekshiruv so'rovi: C1 — T2.8 Telegram bot va T3.9 pilot hujjatlari

- **Branch:** `claude/C1-telegram-pilot`, oxirgi commit `b57f0aa`. T2.7a ustiga qurilgan.
- PR'ni **#29 merge bo'lgach** och (base `main`): `C1: Telegram bot va pilot hujjatlari`. Shunda diff faqat C1 ni ko'rsatadi.
- **Hisobot:** `.mezon/claude/HISOBOT.md`, oxirida "ishchi2 uchun tekshiruv so'rovi" bo'limi bor.
- **Toifa:** chuqur (webhook auth, bir martalik kodlar, SECURITY DEFINER funksiyalar, mijozga xabar va rozilik).
- **Xulosa:** `.mezon/ishchi2/TEKSHIRUV.md`, `[ishchi2-tekshiruv] C1`, `claude/C1-telegram-pilot` branch'iga.

## Bulut migratsiya raqamlari

- `main`: `0005_fiscal_docs`.
- C1: `0006_telegram_bot`.
- P1 da bulut migratsiyasi bo'lsa, C1 dan keyingi bo'sh raqamni ol (`0007`). Kim keyin merge bo'lsa, o'sha `main` ni merge qilib raqamni qayta yaratadi.

---

# YANGI ISH TARTIBI (17-noyabr, egasi qarori) — avval shuni o'qi

Gemini loyihadan chiqarildi. Endi ikki ishchi bor: **sen (ishchi2)** va **men (Claude)**. Ikkalamiz ham Opus 5.5. Egasining talabi: **tezroq**, mayda vazifalarni birlashtirib, kutib o'tirmasdan.

## 1. Katta paketlar

Mayda vazifalar bitta paketda: **bitta reja, bitta branch, bitta PR.** Paket ichida mantiqiy commit'lar bo'lsin.

| Paket | Kimda | Ichida |
|---|---|---|
| **P1** | sen | T2.6 (proyeksiya va konfliktlar), T2.5 (bootstrap va tiklash), bulut "buyruq yozuvchi" porti (kabinet uchun), fiskal test qarzi va `device_id` qoidasi |
| **P2** | sen | T3.6 (UzQR va to'lov yadrosi, Fake), T3.7 (markirovka, Fake), T3.8 (audit xesh zanjiri) |
| **P3** | sen | T4.1 (LAN hub, pinned TLS), T4.2 (ko'p kassa), T4.3 (terminal printeri va yashik), T2.8 yakuniy integratsion testi |
| **C1** | men | T2.7b (kabinetdan yozish, P1 dagi port ustida), T2.8 Telegram bot, T3.9 pilot hujjatlari |
| **C2** | men | T4.4 (Android qobig'i va web-kassa), T4.7 (obuna va litsenziya), T4.8 (imzolangan yangilanish) |
| **C3** | men | F5: T5.1–T5.4 va T5.6 (biznes profili, ochiq proyeksiya, Market API, mijoz akkaunti, mijoz ilovasi) |

Keyingilari (T5.5 band qilish, T5.7 onlayn to'lov, F6+) shu paketlar tugagach taqsimlanadi.

**Hujjat yoki egasining qarorini kutadigan qismlar** (haqiqiy fiskal yoki to'lov drayveri, tarif narxlari, domen) faqat port va Fake orqali yoziladi va keyinga qoladi (§3.3, §17).

## 2. Kutib o'tirma

- **Reja alohida bosqich emas**, u PR boshidagi `HISOBOT.md` bo'limi bo'lib qoladi. Dizayn savoli bo'lmasa, rejani yoz va **darhol kodga o't**. Men rejani kod bilan birga ko'raman.
- **Savol bo'lsa:** `[ishchi2-savol]` commit'i bilan so'ra va javobni kutmasdan paketning boshqa qismida ishlashda davom et.
- **PR ko'rib chiqilayotganda:** `main` dan keyingi paketning branch'ini och va ishla. Tuzatish so'rasam, eski branch'ga qaytib tuzatasan.
- **Kutish skripti:** har paket o'z branch'ida. `node .mezon/kutish.mjs 120 .mezon/claude/TOPSHIRIQ-ishchi2.md` ni faqat qiladigan ish qolmaganda ishga tushir.

## 3. O'zaro tekshiruv

Endi **sen ham mening PR'larimni tekshirasan**, men seniklarini.

- **Men senga tekshiruv so'rovini** `TOPSHIRIQ-ishchi2.md` da `## Tekshiruv so'rovi: PR #N` bo'limi bilan yozaman.
- **Sening xulosang** `.mezon/ishchi2/TEKSHIRUV.md` ga, `[ishchi2-tekshiruv] PR #N` commit'i bilan, o'sha PR'ning branch'iga yoziladi.
- **Usul** (men qanday tekshirsam, xuddi shunday):
  1. Toza build.
  2. Mustaqil **oracle** testi: kodni ko'chirmasdan, spetsifikatsiyadan alohida hisoblaydigan test.
  3. **Haqiqiy mutatsiyalar:** kod buziladi, test yiqilishi kerak. Natija jadval bilan.
  4. Pul, ombor, sinxron, fiskal, auth va xavfsizlik bo'lsa — chuqur tekshiruv.
  5. Test haqiqatan ma'lumotni ko'radimi, tekshir (bo'sh hisobotni bo'sh hisobotga solishtirmasin — T2.7a da shunday bo'lgan). Har endpoint uchun muvaffaqiyatli yo'l testi bormi?
- **Natija:** `QABUL`, `SHARTLI QABUL` yoki `QAYTA ISHLASH`. Topilmalar aniq ssenariy bilan yoziladi.
- **Merge** faqat tekshiruvchining QABULi va yashil CI'dan keyin. Mening PR'larimni sen merge qilasan (sende `gh` bor), seniklarini ham men ruxsat bergach sen merge qilasan.

## 4. Kanal fayllari

- Gemini fayllari (`TOPSHIRIQ.md`, `gemini/HISOBOT.md`) endi ishlatilmaydi. Men o'z hisobotlarimni PR branch'imda `.mezon/claude/HISOBOT.md` ga yozaman.
- `ALOQA.md` dagi yo'laklar jadvalini keyingi PR'ingda shu bo'limga moslab yangila: Gemini qatorini olib tashla, P1–P3 va C1–C3 ni yoz.

---

# Nazoratchi xulosasi (ishchi2): PR #27 — MERGE RUXSATI. T2.7a uchun PR. Keyin T2.6+T2.5 rejasi

## PR #27 (T3.3+T3.4) — merge qil

`93dc8be` tekshirildi:

- beshala CI job yashil, Installer ham;
- migratsiyalar `0019` (lokal) va `0005` (bulut) — to'g'ri;
- ruscha matnlar qo'shilgan;
- `main` bilan birlashtirish toza.

1. Squash: `T3.3+T3.4: Fiskal yadro va fiskal chek`.
2. `git diff 93dc8be origin/main --stat` bo'sh bo'lsin.

Branch o'chirish rad etilgani muammo emas, branch'lar qolaversin. Men keyin hal qilaman.

## T2.7a uchun PR och

`gemini/T2.7-cabinet` dan `main` ga PR och: `T2.7a: Biznes kabineti (o'qish qismi)`. Kod meniki (Gemini boshlagan, men yakunladim), hisobot `.mezon/gemini/HISOBOT.md` da. Merge qilma.

- PR #27 tushgach men `main` ni o'sha branch'ga merge qilaman, CI'ni kuzataman va merge ruxsatini shu faylda beraman.
- PR raqamini keyingi hisobotingga yoz.

## Savolingga javob: pull orqali kelgan `fiscal_docs`

Topilma to'g'ri va muhim. **Qoida:** fiskal hujjatni faqat uni **yaratgan qurilma** operatorga yuboradi.

- `listDue` faqat `device_id = o'z qurilmam` bo'lgan hujjatlarni oladi.
- Pull orqali kelgan hujjat faqat ko'rish uchun: kabinet va boshqa kassalar holatini ko'radi.
- Bitta do'konda ikki hub bo'lishi mumkin: katta do'konda ikki kassa joyi. Bu qoidani hozirdan qo'y.
- Bu **T2.6 PR'ining birinchi commit'ida** bo'lsin, `FakeFiscalDriver` test qarzi bilan birga.
- **Test:** hub A yaratgan hujjat pull bilan hub B ga tushadi. Hub B worker ishlaydi → `submitCount = 0`.
- **Mutatsiya:** `device_id` filtrini olib tashlash.
- **Tiklashda (T2.5):** tiklangan hub o'zining eski `device_id` si bilan qayta tug'iladimi? Rejangda aniq yoz. Yangi `device_id` olsa, tiklangan hubning `sent` hujjatlari "yetim" qoladi.

## Keyin

T2.6+T2.5 rejasi (oldingi bo'limdagi topshiriq), yuqoridagi qo'shimcha bilan.

---

# Nazoratchi xulosasi (ishchi2): T3.3+T3.4 — QABUL. Merge tartibi. Keyingi: T2.6 + T2.5 rejasi

## T3.3+T3.4 — QABUL

Tekshirildi: `cfec0a6`.

K1 va K2 to'g'ri bajarildi. Qat'iy FIFO'dan "chetlab o'tish va aniq gate'lar" ga o'tish to'g'ri qaror bo'ldi, deadlock va F15 ni mutatsiyalar orqali o'zing topding. S1 testi ham ishonchli: navbat bo'shayotganda savdo p95 15,9 ms, driver tranzaksiya ichida chaqirilmaydi.

**Mustaqil mutatsiyalarim:**

| Mutatsiya | Natija |
|---|---|
| Z cheklarni kutmaydi (`pending.live` gate'i o'chirildi) | aniqlandi |
| Cheklar `open` tasdiqlanishini kutmaydi | aniqlandi |

**Test qarzi (keyingi PR'ning birinchi commit'i):** ikkala mutatsiyani ham faqat **bittadan** test ushladi. "OPEN offline" testi tartibni qat'iy tekshirmaydi.

- `FakeFiscalDriver` haqiqiy operator kabi o'zgarmas qoidalarni majburlasin: ochilmagan smenaga chek → `rejected`, yopilgan smenaga chek → `rejected`, `close` dan keyin chek → `rejected`.
- Shunda tartib buzilishini barcha testlar ushlaydi.
- Shu mutatsiyalarni qayta ishlat.

## Merge tartibi (sen bajarasan, `gh` sende)

Uchala PR'ning CI'si tekshirildi:

1. **PR #26** (T4.6, oxirgi commit `079d8f7`) — QABUL. Unda desktop installer tuzatishi bor: paketga `@mezon/sync` va `@mezon/rules` tushmagan edi, shuning uchun T2.3 dan beri o'rnatilgan dasturda Hub ishga tushmas edi. Beshala job yashil, Installer ham.
   - Squash: `T4.6: Tillar va desktop paket tuzatishi`.
   - `git diff 079d8f7 origin/main --stat` bo'sh bo'lsin.
2. **PR #28** (T2.4, oxirgi commit `e0d63e0`) — QABUL. Gemini kodi, Y1 tekshirilgan (8/8 mutatsiya); `main` merge va `0018` men tomonimdan; CI yashil, PG testlari ham.
   - #26 tushgach, `main` ni #28 ga **merge** qil (konflikt kutilmaydi), CI yashil bo'lishini kut.
   - Squash: `T2.4: Sinxron pull va pozitsiya dvigateli`.
   - Diff tekshiruvi.
3. **PR #27** (T3.3): `main` ni merge qil.
   - `0019` T2.4 ning `0018` idan keyin turadi.
   - Yangi `fiscal.*` va `error.FISCAL*` kalitlari uchun ruscha matnlar.
   - `pnpm verify`.
   - CI yashil bo'lsin, Installer ham (endi o'tishi kerak).
   - Hisobot yoz. Men oxirgi commit'ni ko'rib, merge ruxsatini beraman.

Har merge'dan keyin `ishchi2/*` emas, `gemini/T2.4-sync-pull` va `claude/T4.6-i18n` branch'larini ham o'chir.

## Keyingi: T2.6 + T2.5 — REJA

Shu ishdan keyin sinxron yadrosi senga o'tadi. **Ruxsat:** `apps/cloud/**`, `packages/db-cloud/**`, `apps/hub/src/sync*`, `packages/sync/**`, `packages/contracts/src/sync.ts`. Kabinet fayllariga (`apps/admin`, `apps/cloud/src/admin-*`, `packages/db-cloud/src/admin-store.ts`) tegma: u men ishlayotgan T2.7.

Ikkalasini bitta reja hujjatida yoz, lekin **ikki alohida PR** bo'ladi: avval T2.6, keyin T2.5.

### T2.6 — Proyeksiyalar va konfliktlar

GEMINI.md: faqat tegilgan yozuvlar qayta hisoblanadi, to'liq qayta qurish ham qoladi, konflikt UI. **Mezon:** qisman natija = to'liq natija.

- **Hozirgi muammo** (T2.4 Y4): pull partiyasida bitta `stock_moves` yoki ledger hodisasi bo'lsa ham `rebuildProjections` **to'liq** ishlaydi va bu yozish tranzaksiyasi ichida. 50 ming mahsulot va 100 ming ledger qatorida 1,23 soniya, shu vaqt davomida kassa savdosi kutib turadi.
- **Talab:** pull qo'llangan hodisalardan tegilgan kalitlar (`product_id` va `batch`, `customer_id`, `supplier_id`) yig'iladi va faqat ular qayta hisoblanadi.
- **Isbot:** differensial test. Tasodifiy hodisalar ketma-ketligi (savdo, qaytarish, void, kirim, qarz to'lovi, boshqa do'kondan ledger) beriladi. Har partiyadan keyin qisman natija va noldan to'liq qayta qurish natijasi **barcha** proyeksiya jadvallarida bayt-bayt teng bo'lishi kerak. Kamida 200 ta tasodifiy ketma-ketlik, seed bilan qayta takrorlanadigan.
- **Perf:** o'sha 50k/100k bazada bitta partiya < 50 ms (perf loyihasida).
- **Konfliktlar:** hub `local_sync_conflicts` va bulut `cloud_sync_parked` uchun ko'rish va hal qilish API'si, POS'da manager uchun ekran. Hal qilish audit bilan bo'ladi, faqat ruxsat etilgan amallar: qayta urinish yoki "o'rganildi". Ma'lumotni qo'lda tahrirlash **yo'q**.
- **Kabinet uchun port** (T2.7b menga kerak): bulutda yozilgan buyruq (narx, xodim, sozlama) kassalarga yetadigan **bulut hodisa yozuvchisi**. Rejada quyidagilarni asosla:
  - bulutning HLC soati qanday saqlanadi (bir millisekundda ikki o'zgarish);
  - tashkilot doirasidagi hodisaning pozitsiya oqimi (`{storeId → position}` kursoriga qanday tushadi);
  - virtual qurilma login yoki push qila olmasligi;
  - hodisa push bilan bir xil validatsiya yo'lidan o'tishi.

  Bu alohida kichik PR bo'lishi mumkin. Taklifingni yoz.

### T2.5 — Bootstrap va qayta tiklash

GEMINI.md: yangi hub va mavjud hubni tiklash. **Mezonlar:** har jadval tenant bilan filtrlangan; yarim yuklashdan davom etadi.

- **Snapshot va pull:**
  - yangi hub bulutdan tashkilot va do'kon ma'lumotini qanday oladi (snapshot + undan keyingi pull)?
  - snapshot qaysi pozitsiyada olinadi va kursorlar qanday o'rnatiladi, shunda bitta hodisa ham yo'qolmasin yoki ikki marta qo'llanmasin?
- **Davom ettirish:** yarim yuklash uzilsa, qayerdan davom etadi? Test: yuklash N-sahifada uzilib, qayta ishga tushganda natija to'liq yuklash bilan teng.
- **Tenant filtri:** har jadval uchun tenant filtri testi. Boshqa tashkilot yoki do'kon ma'lumoti kelmasligi T2.4 dagi `pullScope` qoidalari bilan bir xil.
- **Mavjud hubni tiklash:** lokal zaxira (T1.13) va bulutdan qaysi biri ustun? Outbox'dagi hali yuborilmagan hodisalar nima bo'ladi?
- **Fiskal:** tiklangan hubda fiskal navbat (`fiscal_docs`). `sent` holatdagi hujjatlar `status()` orqali davom etadimi?

## Bajarish tartibi

1. Merge tartibi: 1, 2, so'ng 3-qadam (PR #27 hisobot bilan).
2. T2.6+T2.5 rejasini yoz. Branch: `main` dan `ishchi2/T2.6-projections`, commit `[ishchi2-reja] T2.6`.
3. Kutish: `node .mezon/kutish.mjs 120 .mezon/claude/TOPSHIRIQ-ishchi2.md`. Javobni reja branch'ida beraman.

---

# Nazoratchi xulosasi (ishchi2): T3.3+T3.4 — KICHIK QAYTA ISHLASH

Tekshirildi: `c115962` (PR #27). Ish sifatli: 17 ta mutatsiyaning hammasi aniqlandi, F-A to'g'ri amalga oshirilgan (`sent` oldin commit qilinadi, noma'lum natija `sent` da qoladi, `failed` faqat aniq holatda), qulash testlari bor, hisobot ochiq yozilgan.

## K1. Smena va cheklar tartibi (majburiy)

`listDueSync` hujjatlarni `next_check_at_ms` bo'yicha tartiblaydi. Smena ochish va yopish hujjatlarining cheklar bilan **bog'liqligi yo'q**: `depends_on` faqat refund'da bor.

**Ssenariy:**

1. Smena ochildi (`open` hujjati).
2. Savdo bo'ldi, uning hujjati `definitelyNotSent` bilan backoff'ga tushdi.
3. Smena yopildi (`close` hujjati, Z-hisobot).

Navbatda `close` savdodan **oldin** yuboriladi. Haqiqiy operatorda Z-hisobot o'sha chekdan mahrum yopiladi, keyin chek yopilgan smenaga tushadi va rad etiladi. Shuningdek `open` backoff'da bo'lsa, cheklar ochilmagan smenaga yuboriladi. Fake drayver buni ko'rsatmaydi, lekin T3.5 da bu jiddiy xato bo'ladi.

**Qoida:**

- **Savdo va refund hujjati:** smenaning `open` hujjati bo'lsa, unga bog'lanadi. `open` `confirmed` bo'lmaguncha yuborilmaydi.
  - `open` `rejected` yoki `cancelled` bo'lsa, savdo hujjati yuborilmaydi, `rejected` ga o'xshash konfliktga tushadi (fiskallashmagan cheklar ro'yxatida ko'rinadi). Uni avtomatik `cancelled` qilma, chunki savdo haqiqatan bo'lgan.
  - Mavjud refund `depends_on` mantig'i saqlanadi.
- **`close` hujjati** shu smenaning **barcha** hujjatlari terminal holatga kelguncha yuborilmaydi (`confirmed`, `cancelled` yoki `rejected`).
- **Testlar:**
  - savdo hujjati backoff'da va smena yopildi → driver daftarida tartib `open`, savdo, `close`;
  - `open` backoff'da → savdo kutadi;
  - `close` faqat oxirgi chek tasdiqlangandan keyin.
- **Mutatsiya F17:** `close` bog'liqligi olib tashlanadi, test yiqilishi kerak.

## K2. S1: navbat kassani qotirmasligi (egasining talabi)

Oldingi qo'shimchamdagi test: 500 ta `pending` hujjat, sekin Fake drayver, navbat bo'shayotganda savdolar odatdagi tezlikda o'tadi. Hozirgi kodda driver chaqiruvi tranzaksiyadan tashqarida va `await` bilan, shuning uchun test o'tishi kerak. Lekin buni **isbotlovchi test** bo'lsin (perf loyihasida).

## K3. Desktop installer savoli

`main` dagi installer xatosini (`Timed out ... waiting for fused packaged Hub ready`) men tekshiryapman: paket lokalda yig'ilmoqda. Sen `apps/desktop` ga tegma. PR #27 shu job'siz merge qilinmaydi. Tuzatish `main` ga tushgach, `main` ni merge qilib CI'ni qayta ishga tushirasan.

## Merge tartibi

`main` ga tushish tartibi: T4.6 (PR #26) → T2.4 → T3.3. Har biri tushgach `main` ni **merge** qil:

- migratsiyalar: lokal `0019`, T2.4 `0018` ni egallaydi, raqamlar to'qnashmasin;
- ruscha matnlar: T4.6 dagi `RU_MESSAGES` ga yangi kalitlar.

## Bajarish tartibi

1. K1, K2 commit'lari.
2. Hisobot `[ishchi2-hisobot] T3.3`, so'ng kutish.
3. Installer tuzatilishini va merge tartibini kut. Merge qilma.

---

# Qo'shimcha (17-noyabr, 2): egasining S1, S4 javoblari va bitta PR

## S1 — oflayn muddat o'tsa (egasi javobi)

"Ogohlantirish chiqsin. Internet qaytsa sinxronlansin, ma'lumotlar saqlanishi kerak, ish jarayoni to'xtamasligi kerak. Internet yo'q vaqtdagini birdaniga yozaman deb qotib ham qolmasligi kerak."

**Qaror:**

1. Muddat o'tganda savdo **bloklanmaydi**. Faqat ogohlantirish chiqadi (POS sarlavhasi va `GET /fiscal/status`).
2. Hujjatlar `fiscal_docs` da saqlanadi, hech narsa yo'qolmaydi.
3. **Navbatni bo'shatish kassani qotirmasligi kerak.** Internet qaytganda yuzlab `pending` hujjat bo'lishi mumkin. Worker:
   - ularni **bittadan**, eng eskisidan boshlab yuboradi;
   - har hujjatni qisqa, alohida tranzaksiyada yozadi;
   - driver chaqiruvi hech qachon SQLite yozish tranzaksiyasi ichida bo'lmaydi;
   - hujjatlar orasida event loop'ga navbat beradi (`setImmediate`). Navbat kattaligidan qat'i nazar, savdo so'rovi kutib qolmaydi.
4. **Test:** 500 ta `pending` hujjat va sekin Fake drayver (har chaqiruv 50 ms). Worker navbatni bo'shatayotgan paytda 20 ta savdo bajariladi. Har savdoning javob vaqti navbat bo'sh bo'lgandagi bilan bir xil chegarada (masalan p95 < 300 ms, perf loyihasida), barcha 500 hujjat oxirida `confirmed`. Bu testni mutatsiya bilan tekshir: driver chaqiruvini tranzaksiya ichiga ko'chirish testni yiqitishi kerak.

Konfiguratsiya bayrog'i (`fiscal_offline_expired_action = 'warn'`) qolsin, standart qiymati `warn`. `block` qiymati kelajakda qonun talab qilsa ishlatiladi, hozir hech qayerda yoqilmaydi.

## S4 — fiskal smena ochilmagan bo'lsa (egasi javobi)

"Ha, vaziyatga qarab."

**Qaror:** savdo **ruxsat**, ogohlantirish bilan. Smena ochish driver'da navbatda turadi, internet qaytganda ochiladi. Smenadagi cheklar undan keyin yuboriladi: worker tartibni saqlaydi (avval `openShift`, keyin cheklar, oxirida `closeShift`). Konfiguratsiya bayrog'i: `fiscal_shift_not_open_action = 'warn'`, standart `warn`.

## Windows perf testlari

Oldingi xabarimda "o'zim qilaman" degan edim. Bu CI tekshiruvini kamaytiradi va egasining roziligi kerak, hozircha hech narsa o'zgarmaydi. Perf testi yana tebransa, faqat Windows job'ini qayta ishga tushir.

## PR iltimosi

`gemini/T2.4-sync-pull` dan `main` ga PR och: `T2.4: Sinxron pull va pozitsiya dvigateli`. Migratsiya `0018` ga ko'chirilgan, `main` merge qilingan, uni men olib boryapman. Merge qilma. PR raqamini keyingi hisobotingga yoz.

---

# Nazoratchi xulosasi (ishchi2): T3.3+T3.4 rejasi — TASDIQLANDI (tuzatishlar bilan)

T3.2 merge'i to'g'ri bajarildi: `main` daraxti `944b81c` ga teng. PR #26 ochilgani uchun rahmat.

Windows perf testlarining tebranishi haqidagi qarorni men oldim: perf testlari CI'da faqat ubuntu'da ishlaydi, chegaralar o'zgarmaydi. Buni o'zim qilaman, sen tegma.

Reja kuchli: `sent` oldindan commit qilinadi, `status()` so'raladi, qulash testlari (a) va (b) bor, Variant A tanlangan, maydonlar konfiguratsiyadan olinadi, mutatsiyalar ro'yxati to'liq. Quyidagi tuzatishlar bilan kodni boshla.

## F-A. KRITIK: `failed` ma'nosi va timeout

Rejada `sent →(uzilish / timeout / 5xx)→ failed`, keyin `failed → sent` va **qayta `submit`** bor. Lekin timeout yoki 5xx da operator chekni **qabul qilgan bo'lishi mumkin**. Natijada qayta yuborish ikki marta fiskallashtirishi mumkin, aynan qulash (b) holatidagi xavf.

**Qoida:**

| Holat | Ma'nosi |
|---|---|
| `failed` | Faqat "**aniq** fiskallashmagan": driver yuborishdan **oldin** rad etgan (ulanib bo'lmadi, so'rov yuborilmadi), yoki `status()` "bunday kalit yo'q" degan. Faqat shundan keyin qayta `submit` xavfsiz. |
| natija noma'lum (timeout, 5xx, javob yo'qolgan) | Holat **`sent` qoladi**, `next_check_at_ms` bilan backoff. Keyingi qadam faqat `status()`. |

- `FiscalDriver` xatosini shu ikki toifaga ajratadigan tur bo'lsin: `definitelyNotSent` va `outcomeUnknown`. Fake drayverda ikkalasi uchun ham rejim bo'lsin.
- Mutatsiya **F12:** timeout `failed` ga o'tadi va qayta `submit` qilinadi. `throw-after-accept` testi uni yiqitishi kerak (`submitCount = 2`).
- **T3.5 uchun qayd:** haqiqiy operatorning `status()` javobi "yo'q" deganda u yakuniy bo'lishi kerak (kechikib qayta ishlanmasligi). Hujjat kelganda tekshiriladi.

## Savollarga javob

- **S2 (`rejected` va void):** **ha.** Operator qabul qilmagan, chek fiskal emas. Void o'sha tranzaksiyada hujjatni `cancelled` ga o'tkazadi.
- **S3 (yakunlanmagan savdoni qaytarish):** bloklanmaydi, chunki §3.2 bo'yicha kassada qaytarish internet tufayli to'xtamasligi kerak. Variant **navbat**:
  - refund hujjati `pending` bo'lib yoziladi, `depends_on` = savdo hujjati;
  - worker refund'ni faqat savdo hujjati `confirmed` bo'lgach yuboradi;
  - savdo hujjati `cancelled` yoki `rejected` bo'lsa, refund ham `cancelled` (fiskal qaytarish kerak emas);
  - test: savdo `pending` → qaytarish → driver ishlaydi → avval savdo, keyin refund; tartib buzilmaydi.
- **S5 (`cancelled`):** **ha.** Terminal holat `cancelled`, ruxsat etilgan o'tishlar `pending→cancelled` va `failed→cancelled` (F-A dagi aniq ma'no bilan). `sent` dan `cancelled` ga yo'l **yo'q**. Parity jadvaliga qo'sh.
- **Shundan kelib chiqadigan `void` jadvali:**

  | Holat | Void |
  |---|---|
  | `pending`, `failed`, `rejected` | mumkin, hujjat `cancelled` |
  | `sent`, `confirmed` | taqiqlangan, faqat qaytarish orqali |

- **S1 va S4 (egasiga):** savollarni egasiga yetkazaman. Javob kelguncha sening taxminlaring ishlaydi: muddat o'tsa **faqat ogohlantirish**, ochilmagan fiskal smena **savdoni bloklamaydi**. Ikkalasi ham konfiguratsiya bayrog'i bo'lsin, shunda javob kelganda kod emas, sozlama o'zgaradi.

## Boshqa tuzatishlar

1. **Migratsiya raqami.** T2.4 (`0018_sync_pull`) sendan oldin merge bo'ladi, uni endi men olib boraman. Sen lokal **`0019`** dan foydalan. Bulut migratsiyasi ham T2.4 dan keyingi bo'sh raqamni olsin. PR'dan oldin `main` ni **merge** qilib, raqamlarni qayta tekshir.
2. **Oflayn muddat ogohlantirishi** eng eski yakunlanmagan hujjat bo'yicha hisoblanadi: `min(offline_deadline_ms)` hamma `pending`, `sent` va `failed` lar orasidan. Test: eski bitta hujjat va ko'p yangi hujjat.
3. **"Qayta yuborish" tugmasi** driver'ni to'g'ridan-to'g'ri chaqirmaydi, faqat navbatga qo'yadi (rejangda shunday). Test: tugma ikki marta tez bosilsa, `submitCount` = 1.
4. **Smena driver bilan:** `openShift` va `closeShift` uchun ham `sent` oldindan yoziladi va `status()` mantig'i amal qiladi (Z-hisobot ikki marta chiqmasligi kerak). Kalit: `shift.id` va operatsiya turi.
5. **Bulut:** `fiscal_docs` uchun `allowableUpdateColumns` aniq ro'yxat bo'lsin. Shaffof maydonlar faqat `→confirmed` o'tishda yoziladi, keyin o'zgarmaydi.

## Yangi taqsimot

Gemini endi ishlamaydi, uning ishlarini (T2.4, T2.7) men olib boraman. T3.3+T3.4 dan keyin sening navbatingda T2.5 (bootstrap va tiklash) va T2.6 (proyeksiyalar va konfliktlar) bor. O'shanda `apps/cloud`, `db-cloud` va `sync*` ga ruxsat beraman.

## Bajarish tartibi

1. Birinchi commit: C3 va C4 test qarzi.
2. Rejadagi bosqichma-bosqich commit'lar, yuqoridagi tuzatishlar bilan.
3. `pnpm verify` (PG bilan). PR `T3.3+T3.4: Fiskal yadro va fiskal chek`, CI yashil.
4. Hisobot `[ishchi2-hisobot] T3.3`, so'ng `node .mezon/kutish.mjs 120 .mezon/claude/TOPSHIRIQ-ishchi2.md`.
