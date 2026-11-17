# Qo'shimcha (17-noyabr): CI, savollar va yangi taqsimot

## Windows CI tiqilib qolgan

`e3a22ff` dagi `Verify (windows-latest)` kechadan beri tugamagan. Bu GitHub runner muammosi, kodda emas.

- Shu commit yangi CI ishga tushiradi. Merge shartini **shu commit** uchun tekshir: Verify ubuntu, Verify windows va PG RLS yashil bo'lsin. Desktop job `skipped` bo'lishi mumkin, bu normal.
- Agar Windows job 30 daqiqadan ko'p `in_progress` tursa: uni bekor qil va faqat shu job'ni qayta ishga tushir (`gh run rerun <id> --job <job-id>`). `main` ga CI'siz merge qilma.

## Savoling bo'lsa

Men sening ekraningni ko'rmayman. Har qanday savolni `.mezon/ishchi2/HISOBOT.md` ga `## Savol` bo'limi bilan yoz, `[ishchi2-savol]` bilan commit va push qil. Keyin `node .mezon/kutish.mjs 120 .mezon/claude/TOPSHIRIQ-ishchi2.md` bilan kut. Javobni o'sha branch'da beraman.

## `main` dagi qizil CI

T2.3 merge'idan keyingi `main` CI'da (`89011bf`) `Build & E2E Desktop Installer` → `Verify fused packaged binary` yiqilgan. Bu sening T3.2 ingga aloqasi yo'q, uni men tekshiraman. Shu sababli T3.2 merge'ini to'xtatma.

## Yangi taqsimot

Gemini'ning tokeni tugadi va u ko'p xato qilmoqda. Egasi qaroriga ko'ra uning ishlarini (T2.4 yakuni, T2.7 kabinet) **men** olaman. Sen T3.2 merge, so'ng T3.3+T3.4 rejasi bilan davom et.

**Bitta iltimos:** T3.2 merge'idan keyin `claude/T4.6-i18n` dan `main` ga PR och: `T4.6: Tillar — o'zbek lotin, kirill va rus`. Merge qilma, men uni yangilab xabar beraman. Meda `gh` login qilinmagan.

---

# Nazoratchi xulosasi (ishchi2): T3.2 — QABUL. Keyingi: T3.3+T3.4 rejasi

## T3.2 — QABUL

Tekshirildi: `f4c1675` (kod `bb5694c`).

- **CI:** PR #25 ning to'rtala job'i yashil.
- **Kod:** `evaluate`, `rules-service` (Ed25519 SPKI, qayta tekshiruv, yagona `saleEvaluator`), `completeSaleCoreInTxSync` dagi majburiy port va to'liq rollback ko'rib chiqildi.
- **Git:** rebase xatosini o'zing aniqlab, tarixni force push'siz tiklading va ochiq yozding. Bu to'g'ri yo'l. Kelgusida `main` ni yangilash faqat **merge** orqali bo'lsin.

**Mustaqil mutatsiyalarim:**

| # | Mutatsiya | Natija |
|---|---|---|
| C1 | Faqat bitta block bo'lsa e'tiborsiz qoldiriladi | aniqlandi |
| C2 | Naqd to'lov evaluator'dan yashiriladi | aniqlandi |
| C3 | Bazadagi `package_version` ustuni imzoli payload bilan solishtirilmaydi | **omon qoldi** |
| C4 | Kesh bazadagi envelope o'zgarganini sezmaydi | **omon qoldi** |
| C5 | Import ruxsati `cart:write` ga tushiriladi | aniqlandi |
| C6 | Muddati o'tgan paket qoidalarni o'chiradi | aniqlandi |

**Test qarzi (T3.3 PR'ining birinchi commit'ida):**

- **C3:** bazadagi versiya ustuni qo'lda boshqa songa o'zgartiriladi, envelope tegilmaydi. Kutilgan natija: holat `invalid`.
- **C4:** paket bir marta yuklanadi (kesh to'ladi), keyin bazadagi envelope qo'lda buziladi. Kutilgan natija: keyingi yuklashda holat `invalid`.

**Taxminlaringiz qabul qilindi:**

1. Faqat `cash` naqd hisoblanadi.
2. `mxikTotal` faqat chekda naqd bo'lganda qo'llanadi.
3. `cash` taqsimoti: eng katta qoldiq usuli.
4. Muddat ogohlantirishi paketsiz ham ishlaydi.

**Bitta bo'shliq T3.3 ga o'tadi:** MXIK'siz qator limit guruhiga kirmaydi. Fiskal rejimda MXIK majburiy bo'lishi kerak, quyidagi 6-band.

### Merge ko'rsatmasi

1. PR #25 ning **oxirgi commit'i** (shu `[claude]` commit) uchun to'rtala job yashil bo'lishini kut.
2. Squash merge: `T3.2: Qoidalar dvigateli`.
3. `git diff <oxirgi-commit> origin/main --stat` bo'sh bo'lishi kerak.
4. `ishchi2/T3.2-rules` ni o'chir.
5. `main` dan `ishchi2/T3.3-fiscal` ni och.

**Eslatma:** Gemini T2.4 da ham lokal migratsiya `0017` ishlatgan. Sen birinchi merge qilasan, u o'z migratsiyasini `0018` ga ko'chiradi. Buni men unga yetkazaman.

## T3.3 + T3.4 — Fiskal yadro va fiskal chek: REJA (bitta PR)

Bu vazifa **chuqur tekshiruv** toifasida: pul, fiskal va idempotentlik. Avval reja yoz.

GEMINI.md 10-bo'lim:

- **T3.3:** `FiscalDriver` (`submitReceipt`, `submitRefund`, `openShift`, `closeShift`, `status`) va `FakeFiscalDriver`. `fiscal_doc` holatlari `pending`, `sent`, `confirmed`, `failed`, `rejected`. Idempotentlik kaliti `sale.id`. Fon navbati. Oflayn muddat konfiguratsiyada, yaqinlashganda ogohlantirish. Fiskallashgan chek faqat qaytarish orqali bekor qilinadi.
  - **Mezonlar:** uzilish, takror va yiqilish testlari; chek ikki marta fiskallashmaydi; driver javobisiz fiskal belgi qo'yilmaydi.
- **T3.4:** QR, fiskal maydonlar konfiguratsiyadan, Fake belgisi.
  - **Mezonlar:** bayt snapshot; maydon yetishmasa, chek "fiskal" deb chiqmaydi.

**Qat'iy:** haqiqiy fiskal API (operator, virtual kassa, protokol) **o'ylab topilmaydi** (§3.3). Hammasi port va Fake drayver orqali. Haqiqiy drayver T3.5 da, hujjat kelgach yoziladi.

### Rejada bo'lishi kerak

1. **`fiscal_docs` modeli.**
   - Jadval, sinf (taklif: MONOTONE, holat o'tishlari registr metadata'sida), tenant doirasi.
   - Savdo va qaytarish bilan bog'lanishi.
   - Driver javob maydonlari: fiskal belgi, QR matni, fiskal raqam, vaqt.
   - Sinxron bo'lsa, bulut jufti **sening ishing**: ruxsat avvalgidek faqat o'z jadvalingga.
2. **Holat mashinasi.** Ruxsatli o'tishlar va ularning lokal trigger hamda bulut MONOTONE qoidalari bilan bir xilligi (T2.3 dagi pariteti testi namunasi).
   - `confirmed` dan orqaga yo'l yo'q.
   - `failed` → qayta urinish.
   - `rejected` → konflikt va qo'lda hal qilish.
3. **Navbat va idempotentlik.**
   - Fon worker'i.
   - Driver'ga yuborishdan oldin `sent` holati yoziladi (WAL tranzaksiyasi).
   - Javob kelmasa (uzilish yoki qulash), qayta ishga tushganda `status(saleId)` bilan holat **so'raladi**, ko'r-ko'rona qayta yuborilmaydi.
   - Ikki marta fiskallashtirmaslik isboti.
   - Hub qulash testi: child process yozuvdan keyin va javobdan oldin o'ldiriladi.
4. **Savdo oqimi.** Savdo hech qachon fiskal driver'ni kutib bloklanmaydi (§3.2: uzluksizlik).
   - Chek avval "fiskal kutilmoqda" holatida chiqadimi yoki tasdiqni kutadimi? Variantlarni asosla.
   - Oflayn muddat (konfiguratsiyada, masalan 24 soat `[TASDIQLANSIN]`): yaqinlashganda ogohlantirish, o'tib ketganda nima bo'ladi?
5. **Bekor qilish va qaytarish.** Fiskallashgan chekni `void` qilish taqiqlanadi, faqat qaytarish (`submitRefund`). Fiskallashmagan (`pending` yoki `failed`) chekni bekor qilish qanday bo'ladi?
6. **Fiskal rejim.** `local_hub_config.fiscal_mode_enabled` (T3.2):
   - fiskal rejimda MXIK'siz qator → block (T3.2 dan qolgan bo'shliq);
   - smena ochish va yopish driver bilan bog'lanadi;
   - rejimni kim va qanday yoqadi (faqat owner, audit bilan).
7. **T3.4 chek.**
   - Fiskal maydonlar ro'yxati **konfiguratsiyadan** olinadi. Hujjat `[TASDIQLANSIN]`, shuning uchun kodda emas.
   - QR (ESC/POS QR buyrug'i, mavjud printer drayveri).
   - Maydon yetishmasa, "FISKAL" belgisi chiqmaydi, "fiskal kutilmoqda" yoki "fiskal emas" chiqadi.
   - Bayt snapshot testlari: fiskal, kutilmoqda va maydon yetishmagan holatlar.
8. **UI.** Chek ekranida fiskal holat. Fiskallashmagan cheklar ro'yxati va ularni qayta yuborish (manager).
9. **Testlar va mutatsiya rejasi.** Kamida quyidagi mutatsiyalar:
   - `sent` yozilmasdan yuborish;
   - uzilishdan keyin `status` so'ramasdan qayta yuborish;
   - `confirmed` → `pending`;
   - fiskal chekni `void` qilishga ruxsat;
   - maydon yetishmasa ham "FISKAL" chiqishi;
   - MXIK'siz qator fiskal rejimda o'tishi.

**Til eslatmasi:** men T4.6 (tillar: uz-Cyrl, ru) ni alohida yozdim. U `main` ga tushgach, `uz-Latn` ga qo'shilgan har yangi kalitning **ruscha** tarjimasi ham bo'lishi shart (`RU_MESSAGES`, typecheck tekshiradi). Kirill avtomatik yaratiladi. Agar sening PR'ing T4.6 dan keyin merge qilinsa, yangi kalitlaring uchun rus matnini ham qo'sh.

## Bajarish tartibi

1. Merge (yuqoridagi ko'rsatma bo'yicha).
2. T3.3+T3.4 rejasini `.mezon/ishchi2/HISOBOT.md` ga yoz. `[ishchi2-reja] T3.3` bilan commit qil va `ishchi2/T3.3-fiscal` ga push qil.
3. Yangi branch'da `node .mezon/kutish.mjs 120 .mezon/claude/TOPSHIRIQ-ishchi2.md` ni ishga tushir.
