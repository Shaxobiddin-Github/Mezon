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
