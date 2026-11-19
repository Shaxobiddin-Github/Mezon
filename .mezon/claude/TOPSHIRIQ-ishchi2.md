# [claude] v1: dasturni haqiqiy ishga tushirdim — "v1 bayroqlari" ga 3 ta qo'shimcha

Desktop dasturini (`pack:dir`, haqiqiy `app.asar`) Playwright bilan boshidan oxirigacha yurgizdim. Ketma-ketlik: birinchi sozlash → PIN bilan kirish → smena ochish → mahsulot → to'lov → **1-chek**. Hammasi ishladi.

Ko'rinishda v1 uchun tuzatish kerak bo'lgan narsalar (POS, sening "v1 bayroqlari" ishing bilan birga):

1. **Nom.** Sarlavha "Mezon Kassa" → **"Guzar Kassa"**. Kod nomi Mezon ichkarida qoladi, foydalanuvchi Guzar'ni ko'radi. Oyna sarlavhasi va o'rnatuvchi nomi ham shunday bo'lsin (`productName`).
2. **"SINOV — FISKAL EMAS".** v1 haqiqiy do'konda ishlatiladi. Yuqori paneldagi va chekdagi yozuv **"FISKAL EMAS"** bo'lsin, "SINOV" olib tashlansin. `isTestDriver` faqat haqiqiy test drayverida "SINOV" desin. v1 da fiskal rejim o'chiq.
3. **"Fiskallashmagan cheklar" tugmasi** v1 da yashirilsin: fiskal rejim o'chiq bo'lsa ko'rinmasin.

Avvalgilari ham o'z kuchida:
- naqdsiz ro'yxatdan `uzqr` olib tashlansin;
- fiskal rejim va markirovka sozlamalari ko'rinmasin;
- LAN ulanish ekrani bo'lsin.

---

# [claude] YANGI QAROR (egasi): v1 tezroq — qonuniy integratsiyalar v2 ga. Avval `.mezon/claude/V1-REJA.md` ni o'qi

Egasi: "To'lov va qonun-qoidalarga v2 da chuqur kiramiz. Ungacha v1 da ishlaydigan versiya qilaylik."

**Sening v1 ishlaring** (batafsil `V1-REJA.md` da):

1. **Merge navbati:** C2 (`fd1c89c`, tayyor) → P2 → P3 (bulut migratsiyasi `0009`) → C4 (T2.7b, P1 ustida; `main` ni men qabul qilaman).
2. **LAN terminal ulanish ekrani** (POS va hub):
   - terminal tomonda: manzil, kod, barmoq izi;
   - hub tomonda: "Kassa qo'shish", ro'yxat, bekor qilish.
3. **v1 bayroqlari:**
   - POS naqdsiz ro'yxatidan `uzqr` olib tashlansin. Hozir uni tanlasa chek `PAYMENT_NOT_CONFIRMED` bilan yopilmaydi, kassir uchun bu tuzoq;
   - fiskal rejim va markirovka sozlamalari v1 UI'da ko'rinmasin.

Haqiqiy drayverlar (fiskal, UzQR, Payme, Click, Uzum, Asl belgisi), T4.4 va F5–F9 hozircha yozilmaydi.

---

# [claude-tekshiruv] P3 (PR #33): QABUL (T4.1, T4.3, T2.8) — ikki test sharti; T4.2 B varianti qolgan

Tekshirilgan commit: `3fc7526`. Toza worktree va build. Natijalar:
- unit + sqlite-hub + pg-cloud: **130 fayl, 897 test, hammasi yashil**;
- keshsiz lint: yashil.

## T4.1 xavfsizligi (kod bo'yicha) — yaxshi

- Juftlash kodi tarmoqda yuborilmaydi. HMAC sertifikat barmoq iziga bog'langan, shuning uchun MITM sertifikati isbotni buzadi.
- 50 bitli kod, 5 daqiqa muddat, 5 ta xato urinish. Har xato **barcha** faol kodlardan urinish oladi.
- Terminal kalitidan faqat SHA-256 saqlanadi. Taqqoslash `timingSafeEqual` bilan. Bekor qilish darhol kuchga kiradi.
- `x-mezon-terminal-id` faqat jarayon-maxfiy proksi sarlavhasi bilan qabul qilinadi. Tashqaridan kelgani olib tashlanadi.
- Hub'da IP'ga asoslangan ishonch yo'q (grep bilan tekshirdim).
- LAN boshqaruvi faqat hub kompyuteridan.

Mening C2 dagi yangilash darvozam asosiy ilovaning `onRequest` hook'ida ishlaydi. LAN so'rovlari `inject` orqali o'sha ilovaga keladi, shuning uchun darvoza ularni ham yopadi.

## Mustaqil mutatsiyalar

| # | Mutatsiya | Natija |
|---|---|---|
| N1 | bekor qilingan terminal o'tadi | o'ldi |
| N2 | proksi sarlavhasi maxfiysiz ishonchli | o'ldi |
| N3 | xato urinish sanalmaydi | o'ldi |
| N4 | LAN boshqaruvi terminaldan ochiq | o'ldi |
| N5 | pin (barmoq izi) tekshirilmaydi | o'ldi |
| N6 | terminal `hubProof` ni tekshirmaydi | **omon qoldi** |
| N7 | `consume` dagi `used_at_ms IS NULL` guard'i olib tashlandi | **omon qoldi** |

## Shartlar (merge'ni to'xtatmaydi, P3 ning keyingi commit'iga)

- **S9 (N6).** Test: `pairWithLanHub` noto'g'ri `hubProof` qaytargan soxta hubni rad etsin (`LanPairingRejectedError`). Bu protokolning ikkinchi yarmi, hozir himoyasiz.
- **S10 (N7).** Test: bitta kod bilan ikki parallel `POST /lan/pair` bo'lsa, aniq bitta terminal qo'shilishi kerak. `pair()` ichida `await` lar bor (`tlsMaterial`, `decrypt`), shuning uchun ikkalasi ham kodni ko'radi. Ularni faqat guard ajratadi.

## Ma'lumot uchun

- PIN qulfi va qurilma bo'yicha sekinlashtirish hub darajasida. Bitta terminalda PIN noto'g'ri terilsa, hamma kassalarni sekinlashtiradi. Juftlangan terminal egasining akkauntini 5 urinishda qulflashi ham mumkin. Pilot uchun maqbul, lekin hisobotga yozib qo'y.
- `authenticateTerminal` har so'rovda `last_seen` ga yozadi. Ko'p kassada bu ortiqcha yozuv: daqiqasiga bir marta yozish yetadi. Shoshilinch emas.

## Holat

- T4.1, T4.3 va T2.8: **QABUL**.
- T4.2: B varianti (javob berilgan) shu PR'ga commit'lar bilan qo'shilganda qayta ko'raman.
- Merge tartibi: P1 → C2 → P2 → P3.
# [claude-tekshiruv] P2 (PR #32): QAYTARILDI — bitta jiddiy pul xatosi (K1), bitta pul bo'shlig'i (K2)

Tekshirilgan commit: `861945d`. Toza worktree, build. Natijalar:
- unit + sqlite-hub + pg-cloud: **126 fayl, 875 test, hammasi yashil**;
- keshsiz lint: yashil.

Audit zanjiri (T3.8) va markirovka (T3.7) asosan yaxshi. Ruxsatlar ham to'g'ri: `payments:confirm` faqat owner/manager.

## K1 (JIDDIY, pul) — pul qaytarish va chek yopish poygasi. **Isbotlangan.**

`HubPaymentService.refund()` ishlash tartibi:
1. holatni tekshiradi (`paid`, ishlatilmagan);
2. **provayderda pulni qaytaradi** (`await driver.refund`);
3. faqat shundan keyin lokal `paid → refunded` qiladi.

2-qadamdagi `await` paytida kassir o'sha QR bilan chekni yopishi mumkin, chunki intent hali `paid`.

Natija:
- chek yopiladi (200);
- 3-qadam `consumed_by_sale_id IS NULL` sharti tufayli rad etiladi (409 "used by a sale meanwhile");
- lekin provayder pulni **allaqachon qaytargan**. Xaridor ham tovarni, ham pulni oladi.

Bu holat kech tasdiqlangan intent'da real: u ham qaytariladigan, ham chekda ishlatiladigan bo'ladi. Menejer qaytarayotganda kassir ham shu QR'ni ishlatsa, xato yuz beradi.

**Isbot testi:** `.mezon/claude/isbot/p2-k1-refund-race.test.ts.txt`. Uni `apps/hub/src/` ga `.test.ts` qilib ko'chir. Hozir yiqiladi:

```
expected { sale: 200, refund: 409, moneyBack: true } to not match { sale: 200, moneyBack: true }
```

**Tuzatish (taklif):** avval lokal da'vo, keyin provayder.
1. Yangi holat `refunding`. Bitta himoyalangan UPDATE: `paid → refunding WHERE consumed_by_sale_id IS NULL`. `consumeUzqrPaymentInTxSync` faqat `status='paid'` ni oladi, shuning uchun chek endi yopilmaydi.
2. Provayder `refund`:
   - `refunded` bo'lsa → `refunding → refunded`;
   - aniq rad (`failed`) bo'lsa → `refunding → paid`;
   - oflayn yoki timeout bo'lsa → `refunding` da qoladi (pul taqdiri noma'lum). Uni `refresh` provayder holati bo'yicha yakunlaydi, hech qachon taxmin qilmaydi.
3. Mutatsiya: da'voni provayderdan keyinga ko'chirish → isbot testi yiqilishi kerak.

## K2 (pul) — summa mos kelmagan to'lov jim yo'qoladi

`refresh()` da `st.state === 'paid' && st.amountTiyin !== r.amountTiyin` holati hech narsa qilmaydi:
- intent `pending` qoladi, keyin `expired` bo'ladi;
- mijozdan pul yechilgan, lekin kassa ham, menejer ham buni bilmaydi.

**Tuzatish:**
- holat yoki konflikt qo'sh (masalan, `amount_mismatch`, chekni yopmaydi);
- POS'da menejerga ko'rinsin;
- `payment.amount_mismatch` audit yozuvi bo'lsin;
- test: Fake driver'ga `pay(ref, amount)` qo'sh.

## K3 (kichik) — markirovka kodi poygasi

`insertCartMarkSync` qatorni tranzaksiyasiz INSERT qiladi, keyin "sotilganmi" deb tekshiradi va xato tashlaydi. Xato bo'lsa qator **qolib ketadi**:
- mavjud qatorga qo'shish yo'lida ham;
- yangi qator yo'lida ham: savat qatori o'chiriladi, lekin mark qolib ketadi.

Oyna operator tekshiruvi davom etadigan vaqtga teng (LAN'da boshqa terminal sotsa). INSERT va tekshiruvni bitta tranzaksiyaga ol. Test: tekshiruv paytida shu kod sotiladi → savatda mark qolmasligi kerak.

## Merge tartibi

P1 → C2 → P2. P2 bulut migratsiyasiga tegmaydi, lokal migratsiyalari `0021`–`0023`.

K1 va K2 tuzatilgach, P2 ni qayta tekshiraman. K3 ni ham shu bilan qilsang yaxshi.
# [claude-tekshiruv] P1 (PR #31): QABUL

Tekshirilgan commit: `805403b` (kod). `02a0591` faqat `main` (C1) merge'i va migratsiya raqami: SQL `0006` → `0007` bilan bayt-ma-bayt bir xil (diff bilan tekshirdim).

**Merge sharti:** `02a0591` da CI yashil bo'lsin. Keyin sen merge qilasan. Tartib: P1 → C2. C2 o'z bulut migratsiyasini `0008` qilib qayta yaratadi. `0007` haqidagi QARORing to'g'ri: drizzle raqamni bo'shliqsiz beradi.

## Toza muhitda nima qildim

| Tekshiruv | Natija |
|---|---|
| Yangi worktree, `pnpm install --frozen-lockfile`, to'liq build | yashil |
| Keshsiz `pnpm lint`, `prettier --check` | yashil |
| `vitest run apps/hub apps/cloud packages`, `MEZON_REQUIRE_PG_TESTS=1` (Testcontainers PG) | **120 fayl, 954 test, hammasi o'tdi** (890 s; diff testi 200 seed bilan) |

## Mustaqil mutatsiyalar (seniki emas, o'zimniki)

| # | Mutatsiya | Natija |
|---|---|---|
| R1 | `CloudEventWriter` qatordagi HLC'ni hisobga olmaydi (hub soati oldinda) | o'ldi |
| R2 | yozuvchi store jadvallarini ham qabul qiladi | o'ldi |
| R3 | push konflikti retry'da outbox `pending` ga qaytarilmaydi | o'ldi |
| R4 | pull konflikti retry'da yana park bo'lsa, konflikt qayta ochilmaydi | **omon qoldi** (`sync-conflicts`, `sync-pull*`, `sync-two-hubs` testlarida) |
| R5 | "o'rganildi" qilingan `CUSTOMER_OVERPAID` bir xil summada qayta ochiladi | o'ldi |
| R6 | ko'p mahsulotli "birga" yo'lda stock umuman hisoblanmaydi | o'ldi (diff testi) |
| R7 | bootstrap `hasMore` dan qat'i nazar `done` bo'ladi | o'ldi |

## Kod bo'yicha xulosalar

1. **S8 (kichik, merge'ni to'xtatmaydi; P2 bilan birga yopilsin).** R4 uchun test qo'sh.
   - Ssenariy: pull konflikti → retry → hodisa endi park bo'ladi (ota-qator yo'q).
   - Kutilgan natija: konflikt ochiq qoladi va `applied = false`.
   - Hozir bu yo'l (`retryConflictEvent` ichidagi `if (parked)`) hech qanday test bilan himoyalanmagan, vaholanki izohda va'da qilingan.
2. **Ma'lumot uchun (T2.7b, menga tegishli).**
   - `CloudEventWriter` HLC'ni bitta tranzaksiyada ajratadi, push esa keyingi tranzaksiyada bo'ladi.
   - Shu oraliqda hub o'sha qatorga yuqoriroq HLC bilan yozsa, kabinet o'zgarishi LWW bo'yicha yutqazadi, lekin natija `accepted` bo'ladi.
   - Bu LWW semantikasiga to'g'ri keladi. Kabinetda saqlagandan keyin qatorni qayta o'qib ko'rsataman, port o'zgarmaydi.
3. **Ma'lumot uchun.**
   - Bulutdagi `resolve` da `userId` ni hub yuboradi: qurilma darajasidagi ishonch, faqat audit uchun. Hub proksisi uni sessiyadan oladi, body'dan emas (tekshirdim), shuning uchun yetarli.
   - Push retry'da outbox qatori `rejected` bo'lmasa (masalan, tozalangan), konflikt `retried` deb yopiladi, lekin hech narsa qayta yuborilmaydi. Amalda `in_outbox` sharti buni deyarli istisno qiladi; hozircha qoldirsa bo'ladi.
4. Konflikt API'sida tahrir yo'qligi, RBAC (kassir 403), tenant filtri, bootstrap'ni uzib davom ettirish va tiklashda `device_id` saqlanishi kod va testlarda tasdiqlandi.

**S7 (ortiqcha to'lovli mijozga nasiya):** sening variantingni (ruxsat) qabul qilaman. Egasiga savollar ro'yxatiga qo'shdim.

---

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

## 3. Merge baribir tekshiruvchini kutadi

**Tuzatish (avvalgi versiyada xato bor edi):** o'z PR'ingni o'zing tekshirib merge qilish **yo'q**. Barcha PR'lar, past xavflilari ham, ikkinchi tomonning QABULi va yashil CI'dan keyingina merge bo'ladi.

Ish esa to'xtamaydi:
- keyingi paketlarni oldingisi ustidan ochilgan branch'larda davom ettirasan;
- o'z ishingni o'zing oldindan tekshirib, mutatsiya jadvalini hisobotga yozasan. Shunda qaytgan tekshiruvchi tez QABUL qiladi.

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
