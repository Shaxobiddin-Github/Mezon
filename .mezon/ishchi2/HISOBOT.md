# Hisobot: T3.3 + T3.4 — Fiskal yadro va fiskal chek

Branch: `ishchi2/T3.3-fiscal`. PR: [#27](https://github.com/Shaxobiddin-Github/Mezon/pull/27) (base `main`, `18d4a41`).
Bajaruvchi: ishchi2.
Holat: **HISOBOT**. Kod tayyor, ko'rib chiqish kutilyapti.

Reja nazoratchining `545ea27` dagi tuzatishlari bilan bajarildi (F-A, S2/S3/S5 javoblari, 1–5 tuzatishlar, migratsiya `0019`). Haqiqiy fiskal API o'ylab topilmagan: hamma narsa `FiscalDriver` porti va `FakeFiscalDriver` orqali ishlaydi (§3.3).

## Commit'lar

| Commit | Mazmun |
|---|---|
| `b4cdd4b` | **C3/C4 test qarzi** (birinchi commit) |
| `98da0f6` | domain holatlar jadvali, `fiscal_docs` (lokal `0019`), trigger'lar, drayver porti va Fake drayver |
| `59def3d` | fiskal navbat ombori; savdo, void, qaytarish va smena gate'lari; contracts; bulut jadvali (`0005`); parity |
| `db738bf` | hub worker, servis, route'lar; integratsiya va qulash testlari |
| `205ce35` | T3.4 fiskal chek: konfiguratsiyadagi maydonlar, `GS ( k` QR, bayt snapshot'lar |
| `33908a0` | POS UI |
| `4b3871a` | F7 testi (DB CHECK) |
| `cb2b93c` | prettier |

## Dalillar

- **`pnpm verify`** (lokal, Docker/PG yoqiq): format, build, lint, typecheck, `db:check` (lokal va bulut, 0 diff), test **97 fayl / 578 test, hammasi o'tdi** (PG RLS testlari ham), perf 12/12, E2E 1/1, depcruise 0 buzilish.
- **CI:** PR #27 — natija pastda (oxirgi bo'lim).
- **Mutatsiyalar: 17/17 o'ldirildi** (har biri: kod o'zgartiriladi → qayta build → tegishli testlar → yiqilishi kutiladi → tiklanadi; oxirida `git status` toza).

| # | Mutatsiya | Uni o'ldirgan test |
|---|---|---|
| C3 | kesh versiya ustunini tekshirmaydi | `rules.test` C3 (issiq kesh) |
| C4 | kesh envelope'ni tekshirmaydi | `rules.test` C4 |
| F1 | `sent` commit qilinmasdan driver chaqiriladi | worker testlari, qulash (a) |
| F2 | `sent` hujjat `status()` siz qayta yuboriladi | `throw-after-accept`, qulash (b): `submitCount = 2` |
| F12 | timeout/noma'lum natija `failed` ga o'tadi va qayta yuboriladi | `throw-after-accept`: `submitCount = 2` |
| F3 | domain'da `confirmed → pending` ruxsat | domain jadval testi, parity |
| F3b | migratsiyadan terminal trigger olib tashlanadi | parity (36 juftlik) |
| F4 | fiskal chekni void qilish mumkin | domain void jadvali, hub void testi |
| F5 | maydon yetishmasa ham "FISKAL CHEK" | bayt snapshot'lar, F5 testi |
| F6 | fiskal rejimda MXIK'siz qator o'tadi | rules testi, hub 422 testi |
| F7 | `confirmed` CHECK olib tashlanadi | F7 DB testi |
| F8 | Fake drayver takroriy submit'da yangi belgi beradi | idempotentlik testi (100 submit → 1 belgi) |
| F9 | savdo hujjati savdo tranzaksiyasida yozilmaydi | hub savdo testi |
| F10 | manager fiskal rejimni yoqa oladi | RBAC testi (403) |
| F11 | oflayn ogohlantirish o'chiriladi | muddat testi |
| F13 | ogohlantirish eng **yangi** hujjat bo'yicha (tuzatish #2) | "bitta eski + ko'p yangi" testi |
| F14 | "qayta yuborish" driver'ni to'g'ridan-to'g'ri chaqiradi (tuzatish #3) | ikki marta bosish testi: `submitCount = 1` |
| F15 | refund savdo hujjati tasdiqlanmasdan yuboriladi (S3) | tartib testi: avval savdo, keyin refund |
| F16 | bulut qoidasi belgisiz `confirmed` ni qabul qiladi | parity testi |

## Mezonlar bo'yicha testlar

### Model va holat mashinasi
- `FISCAL_DOC_TRANSITIONS` (`packages/domain/src/fiscal.ts`) yagona manba:

  | Holat | Ruxsat etilgan o'tishlar |
  |---|---|
  | `pending` | `sent`, `cancelled` |
  | `sent` | `confirmed`, `rejected`, `failed` |
  | `failed` | `sent`, `cancelled` |
  | `rejected` | `cancelled` |
  | `confirmed`, `cancelled` | terminal |

  `sent → cancelled` yo'q (S5).
- SQLite trigger'lari shu jadvaldan **generatsiya qilinadi** (`buildFiscalDocsTriggersSql`). `db:check` migratsiyada joriy trigger'lar aynan borligini tekshiradi (`assertFiscalMigrationsComplete`), shuning uchun jadvalni migratsiyasiz o'zgartirib bo'lmaydi.
- **Parity, 7-jadval** (`monotone-parity.test.ts`): 6×6 = 36 juftlikning har biri uchun SQLite trigger'i, bulut `checkTransition` va domain bir xil natija beradi. Rad etilgan holatlar CHECK emas, aynan trigger tomonidan rad etilishi tekshiriladi. Qo'shimcha:
  - shaffof maydonlarsiz `confirmed` rad etiladi;
  - `confirmed` dan boshqa holatda shaffof maydon bo'lsa rad etiladi;
  - `attempts` kamaya olmaydi;
  - o'zgarmas ustunlar o'zgartirilmaydi;
  - jismoniy DELETE taqiqlangan.
- **Bulut** (tuzatish #5): `allowableUpdateColumns` aniq ro'yxat. Shaffof maydonlar faqat `→ confirmed` o'tishda qabul qilinadi, terminal holatda ular muzlatiladi.

### Ikki marta fiskallashtirmaslik (F-A)
- **Worker:**
  - `pending|failed → sent` alohida tranzaksiyada commit qilinadi, faqat shundan keyin `submit` chaqiriladi;
  - `sent` hujjat faqat `status()` orqali davom etadi;
  - `outcomeUnknown` (timeout, 5xx, javob yo'qolgan) bo'lsa hujjat `sent` da qoladi va backoff qilinadi;
  - `failed` faqat ikki holatda: `definitelyNotSent`, yoki `status()` = `notFound`.
- **Hub testlari** (`apps/hub/src/fiscal.test.ts`):
  - `ok`;
  - `reject`;
  - `definitelyNotSent` → `failed` → qayta → `confirmed`;
  - `throw-after-accept` → `sent` → `status()` → `confirmed`, `submitCount = 1`;
  - `timeout` → `sent` → `notFound` → `failed` → bitta submit;
  - `status()` ishlamasa hujjat `sent` da qoladi va qayta yuborilmaydi.
- **Qulash testlari** (`fiscal-crash.test.ts`, child process, Fake drayver daftari faylda):
  - (a) qulash `sent` commit qilingandan keyin, driver chaqirilishidan oldin: restart → `status()` = `notFound` → bitta submit;
  - (b) qulash driver qabul qilgandan keyin, javob yozilishidan oldin: restart → `status()` = `confirmed`, qayta yuborilmaydi.
  - Ikkala holatda `submitCount ≤ 1`.

### Savdo oqimi va gate'lar
- **Variant A:** savdo vaqtida driver chaqirilmaydi (`totalSubmitAttempts` o'zgarmaydi). `pending` hujjat savdo tranzaksiyasida yoziladi. Rules block bo'lsa hujjat ham yozilmaydi (to'liq rollback testi).
- **Void jadvali (S2/S5):**
  - `pending`, `failed`, `rejected` → void mumkin, hujjat o'sha tranzaksiyada `cancelled` bo'ladi;
  - `sent`, `confirmed` → 409 `FISCALIZED_SALE_CANNOT_VOID`;
  - bekor qilingan hujjat hech qachon yuborilmaydi.
- **Qaytarish (S3, navbat):**
  - qaytarish bloklanmaydi;
  - refund `pending` bo'lib yoziladi, `depends_on` = savdo hujjati;
  - drayverga avval savdo, keyin refund yuboriladi (daftar tartibi tekshiriladi);
  - savdo hujjati `rejected` bo'lsa refund `cancelled` bo'ladi va yuborilmaydi.
- **Smena (tuzatish #4):** smena ochish va yopish (Z) ham shu navbat orqali o'tadi, kalit `shift.id:open|close`. Driver ishlamasa ham smena bloklanmaydi. `throw-after-accept` bilan Z-hisobotning `submitCount = 1`.
- **Fiskal rejimda MXIK'siz qator** → 422 `RULES_BLOCKED` / `MXIK_MISSING`.

### Oflayn muddat va bayroqlar (S1/S4, tuzatish #2)
- Ogohlantirish `min(offline_deadline_ms)` bo'yicha hisoblanadi: barcha `pending`, `sent` va `failed` hujjatlar orasidan eng eskisi. Bosqichlar:
  - muddatning 75 % o'tganda — `approaching`;
  - muddat o'tgach — `expired`.
- Test stsenariysi: bitta eski hujjat, 19 soatdan keyin 3 ta yangi hujjat. Natija: `approaching`, keyin `expired`.
- **S1** (`fiscal_block_on_offline_expired`) va **S4** (`fiscal_require_open_shift`) konfiguratsiya bayroqlari, standart qiymati `0`. Ya'ni muddat o'tsa ham faqat ogohlantirish chiqadi, ochilmagan smena savdoni bloklamaydi. Testda ularni yoqib ko'rildi: savdo 422 `FISCAL_BLOCKED` beradi. Navbat bo'shatilgach blok yechiladi.
- **Oflayn oyna** `fiscal_offline_window_ms`, standart 24 soat `[TASDIQLANSIN]`. Faqat konfiguratsiyadan o'zgaradi.

### Fiskal rejim
- `PUT /fiscal/mode` faqat owner uchun (`fiscal:mode`); manager va kassir 403 oladi.
- Rejimni yoqish shartlari:
  - rules paketi `ok` holatda;
  - driver `ping` ga javob beradi;
  - MXIK'siz faol mahsulot yo'q;
  - chek maydonlari konfiguratsiyasi to'g'ri va bo'sh emas.
- Har bir shart buzilgani alohida kod bilan qaytariladi.

### T3.4 fiskal chek
- **Maydonlar** `fiscal_receipt_fields_json` konfiguratsiyasidan olinadi `[TASDIQLANSIN]`; kodda ro'yxat yo'q. Ruxsat etilgan kalitlar: `fiscalSign`, `fiscalNumber`, `confirmedAt`, `driverId`, `organizationTin`.
- **Belgi qoidasi** — `resolveReceiptFiscalBlock` (domain):

  | Holat | Chekdagi belgi |
  |---|---|
  | `confirmed` + barcha maydonlar + QR | "FISKAL CHEK" |
  | `confirmed`, lekin biror maydon yoki QR yo'q | "FISKAL MA'LUMOT TO'LIQ EMAS" |
  | `pending`, `sent`, `failed` | "FISKAL KUTILMOQDA" |
  | fiskal hujjat yo'q, `rejected`, `cancelled` | "FISKAL EMAS" |

  Bo'sh konfiguratsiya hech qachon "FISKAL CHEK" bermaydi. Test drayverida "SINOV — FISKAL EMAS" banneri doim saqlanadi.
- **QR:** printerning o'z `GS ( k` buyrug'i (model 2, xato tuzatish M). Payload UTF-8 baytlar sifatida aynan joylanadi. Chegara testlari: 0 bayt va 7090 bayt rad etiladi, 7089 bayt qabul qilinadi; uzunlik baytlari tekshiriladi; kirill harflarida bayt soni (belgi soni emas) hisoblanadi.
- **Bayt snapshot'lar:** 14 ta (58 va 80 mm × 7 holat).
- **Hub orqali chop etish testi:**
  - `pending` → "KUTILMOQDA";
  - tasdiqdan keyingi qayta chop etish → "FISKAL CHEK", maydonlar, NUSXA belgisi va QR baytlari;
  - konfiguratsiya bo'shatilsa → "TO'LIQ EMAS".
- Fiskal hujjat bo'lmasa chek baytlari **o'zgarmaydi** (eski printer testlari o'tadi).

### UI
- **Chek ekrani:** fiskal holat belgisi, hujjat yakunlanguncha qisqa so'rov bilan yangilanadi.
- **Sarlavha ostida:** oflayn muddat ogohlantirishi.
- **"Fiskallashmagan cheklar"** (manager va owner):
  - holat va muddatgacha qolgan vaqt;
  - `failed` uchun "Qayta yuborish" — faqat navbatga qo'yadi;
  - `rejected` uchun "qaytarish orqali hal qilish" ko'rsatmasi.
- Matnlar `uz-Latn` i18n'da. T4.6 `main` ga birinchi tushsa, `RU_MESSAGES` ga ruscha tarjimalarni merge paytida qo'shaman.

## Rejadan farqlar (ochiq aytaman)

1. **Fiskal rejim auditi** outbox hodisasi emas, tuzilgan log yozuvi (`fiscal.mode_changed`, `actorUserId` bilan). `local_hub_config` LOCAL jadval; uni sinxronlash bulutda yangi entity talab qiladi. Bu T3.8 dagi to'liq audit jurnaliga ulanadi.
2. **Rejimni yoqish shartiga** to'rtinchi shart qo'shildi: chek maydonlari konfiguratsiyasi bo'sh bo'lmasligi kerak. Busiz fiskal chek chiqmaydi.
3. **`local_hub_config.fiscal_driver_id`** (standart `'fake'`) qo'shildi. Drayver id kodda qattiq yozilmaydi.
4. **Fake drayver daftari** hub ma'lumotlar papkasidagi faylda saqlanadi (`fake-fiscal-ledger.json`), shuning uchun restartdan keyin ham ko'rinadi. Faqat sinov drayveri.
5. **Bulut migratsiyasi `0005`:** `gemini/T2.4-sync-pull` da hozircha bulut migratsiyasi yo'q. T2.4 birinchi tushsa, merge oldidan raqamni qayta tekshiraman. Lokal `0019` (jurnal idx 18) ham T2.4 dagi `0018` tushgach qayta tartiblanadi; `main` ga **merge** qilinadi, rebase emas.

## Merge oldidan

- `main` ga T2.4 yoki T4.6 tushsa, `main` ni **merge** qilaman, migratsiya raqamlari va RU tarjimalarni tekshiraman, keyin `pnpm verify` va CI.
- Ochiq savollar yo'q. S1 va S4 egasining javobini kutadi; ular konfiguratsiya bayrog'i bilan tayyor.

## CI (PR #27)

Kod commit'i `cb2b93c` (run `44021760453`):

| Job | Natija |
|---|---|
| Verify (ubuntu-latest) | pass |
| Verify (windows-latest) | pass |
| Verify PostgreSQL RLS (ubuntu-latest) | pass |
| Detect Desktop Changes | pass |
| Build & E2E Desktop Installer (windows-latest) | **fail** |

Desktop installer bu safar ishga tushdi, chunki `apps/pos` o'zgardi. U `Verify fused packaged binary (fuses, RunAsNode/--inspect block, smoke launch, T5)` qadamida `Timed out after 15000ms waiting for fused packaged Hub ready` xatosi bilan yiqildi. `main` da aynan shu qadam aynan shu xato bilan yiqilgan: `89011bf` (T2.3, run `43829952300`) va `18d4a41` (T3.2, run `44015781009`). Siz buni o'zim tekshiraman degan edingiz (17-noyabr qo'shimchasi). Men bu job'ga va `apps/desktop` ga tegmadim.

**Savol:** `main` dagi installer tuzatilgach, `main` ni merge qilib CI'ni qayta ishga tushiraymi, yoki bu PR'ni installer'siz qabul qilasizmi? Ko'rsatmangizsiz merge qilmayman.
