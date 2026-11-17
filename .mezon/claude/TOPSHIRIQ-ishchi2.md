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
