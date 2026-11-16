# Reja: T3.2 — Qoidalar dvigateli

Branch: `ishchi2/T3.2-rules`. `main` dan ochilgan, T3.1 squash merge'idan keyin (`19118df`).
Bajaruvchi: ishchi2.
Holat: **REJA**. Kod yozilmagan, tasdiq kutilyapti.

## T3.1 merge holati

- PR #24 ning oxirgi commit'i `5704ed0` da to'rtala job yashil: Verify ubuntu, Verify windows, PostgreSQL RLS va Detect Desktop Changes. Desktop installer skip bo'ldi.
- Merge: `19118df` (squash, "T3.1: MXIK va soliq sozlamalari"). Uni 2026-11-16 07:23 UTC da `Shaxobiddin-Github` akkaunti qilgan. Men `gh pr merge` ni ishga tushirganimda PR allaqachon merge qilingan edi, shuning uchun o'zim merge qilmadim.
- Tekshiruv: `git diff 5704ed0 main --stat` bo'sh chiqdi, ya'ni `main` daraxti PR'ning oxirgi commit'iga teng.
- `origin/ishchi2/T3.1-mxik` branch'i hali turibdi. GEMINI.md §3.6 ga ko'ra uni o'chirish kerak, lekin merge ko'rsatmasida bu qadam yo'q edi, shuning uchun tegmadim. Ruxsat bersangiz, o'chiraman.

Qayta o'qildi: `GEMINI.md` 10-bo'lim (talablar jadvali, T3.2), §3.1 (9–10-bandlar: yagona `completeSale`, atomiklik), §3.2 (uzluksizlik), §3.3 (API o'ylab topilmaydi), §3.4 (xavfsizlik), §3.5. Ko'rib chiqilgan kod: `packages/rules` (hozir faqat skelet), `.dependency-cruiser.cjs`, `sale-repo.ts` (`completeSaleCoreInTxSync`), `order-repo.ts` (`deliver` → `completeSaleCoreInTxSync`), `domain/src/sale.ts` (`PAYMENT_METHODS`, `social_card`), partiyalardagi `expiry_date_ms`, `apps/hub/src/logger.ts` (pino `redact`), `apps/bot` (hozircha faqat skelet).

---

## 0. Asosiy tamoyillar

1. **Qoidaning haqiqiy ma'lumoti o'ylab topilmaydi.** Qaysi MXIK naqdga taqiqlangan, qaysisi retseptli, 25 mln limitdan qaysi MXIK istisno, bular hammasi faqat **imzolangan paket** ichida keladi. Kodda va testlarda faqat sintetik qiymatlar ishlatiladi (masalan `99900000000000001`). 25 mln qiymati ham kodda qattiq yozilmaydi: u paketdagi `limitTiyin`. Testlarda 25 000 000,00 so'm sintetik qiymat sifatida beriladi.
2. **Bitta tekshiruv nuqtasi.** `@mezon/rules` dagi toza `evaluate()` ishlatiladi. Hub'da yakuniy tekshiruv `completeSaleCoreInTxSync` ichida, ya'ni har qanday savdo yo'lida (§3.1.9). UI ham aynan shu funksiyani chaqiradi.
3. **`packages/rules` toza bo'lib qoladi.** depcruise qoidasiga ko'ra u faqat `@mezon/domain` ni import qiladi. Shuning uchun:
   - **Imzo tekshiruvi port orqali** bo'ladi. Rules'da `RulesSignatureVerifier` interfeysi, Ed25519 implementatsiyasi esa hub'da (`node:crypto`).
   - **Zod rules'da ishlatilmaydi.** Paket sxemasi `packages/contracts` da bo'ladi. Rules ichida qo'lda yozilgan qat'iy tekshiruv bor, ikkalasi bir xil fixture'lar bilan sinaladi.

---

## 1. Paket formati

### Konvert

`packages/contracts/src/rules-package.ts` (Zod) va rules'dagi TS tiplari.

```ts
RulesPackageEnvelope = {
  format: 'mezon-rules',
  formatVersion: 1,
  keyId: string,            // ishonchli kalitlar ro'yxatidagi id
  payload: RulesPayload,
  signature: string,        // base64, Ed25519, 64 bayt
}

RulesPayload = {
  packageVersion: string,   // musbat butun son (bigint satri), monoton
  issuedAtMs: string,       // unix ms (bigint satri)
  validUntilMs: string,     // undan keyin paket "eskirgan"
  sourceRefs: string[],     // hujjat havolalari, masalan "PF-246" (ma'lumot uchun)
  cashForbidden:  { exact: string[], prefixes: string[] },   // MXIK
  prescriptionRequired: { exact: string[], prefixes: string[] },
  perMxikCashLimit: { limitTiyin: string, exempt: { exact: string[], prefixes: string[] } } | null,
  socialCard: { enabled: boolean } ,
  expiredGoods: { enabled: boolean },
}
```

- Pul qiymatlari JSON'da satr ko'rinishida (§3.1.1). `number` faqat `formatVersion` da ishlatiladi.
- Noma'lum maydon kelsa, paket rad etiladi (strict).
- MXIK ro'yxatlari T3.1 dagi `normalizeFiscalCode` bilan bir xil qoidaga bo'ysunadi.

### Kanonik serializatsiya (rules ichida, toza)

- Obyekt kalitlari leksikografik tartibda saralanadi (UTF-16 kod birligi bo'yicha). Massiv tartibi saqlanadi.
- Ruxsat etilgan qiymatlar: satr, xavfsiz butun son, boolean, `null`, massiv, obyekt. Float, `NaN` yoki `undefined` kelsa, xato.
- Bo'shliq ishlatilmaydi. Satrlar `JSON.stringify` qoidasi bo'yicha escape qilinadi.
- **Imzolanadigan matn:**
  ```
  "mezon-rules/v1\n" + canonical({ keyId, formatVersion, payload })
  ```
  `keyId` imzo ichida, shuning uchun bir kalit uchun yaratilgan imzoni boshqa kalit bilan almashtirib bo'lmaydi.
- Matn UTF-8 baytlari sifatida verifier'ga beriladi. Kodlash verifier implementatsiyasida bo'ladi, rules'da `TextEncoder` kerak emas.
- **Determinizm testi:** kalitlar tartibi boshqacha bo'lgan bir xil obyekt bir xil satrni beradi (property test). Oltin fixture satri ham bor.

---

## 2. Imzo va kalitlar

- **Algoritm:** Ed25519 `node:crypto` orqali (`generateKeyPairSync('ed25519')`, `sign(null, …)`, `verify(null, …)`). Yangi kutubxona kerak emas.
- **Ishonchli ochiq kalitlar:** `packages/rules/src/trusted-keys.ts`.
  ```ts
  { keyId, publicKeyB64 /* raw 32 bayt */, env: 'prod', validFromMs, validUntilMs | null }[]
  ```
  - Bir nechta kalit bo'lishi mumkin, rotatsiya `validFrom` va `validUntil` bilan boshqariladi.
  - **Hozir prod ro'yxati bo'sh.** Ochiq kalitni egasi beradi (S2). Kalit kelguncha prod rejimda hech qanday paket o'rnatilmaydi va 8-bo'limdagi "paket yo'q" holati ishlaydi.
- **Test kalitlari:**
  - Repoda hech qanday maxfiy kalit, test kaliti ham bo'lmaydi.
  - Testlar kalit juftini **ishga tushish vaqtida** yaratadi va hub'ga `trustedRuleKeys` opsiyasi orqali beradi.
  - Prod build `trustedRuleKeys` ni faqat o'rnatilgan ro'yxatdan oladi. Bu opsiya `createHubServer` options'da, xuddi `printerDriverFactory` kabi faqat test va DI uchun. Electron worker uni bermaydi.
- **Imzolash CLI'si** `scripts/rules-sign.mjs`:
  - `keygen --out <dir>`: kalit juftini repodan **tashqaridagi** papkaga yozadi. Repo ichidagi yo'l rad etiladi.
  - `sign --key <path> --in payload.json --key-id <id> --out package.json`.
  - `verify --pub <b64> --in package.json`.
  - `.gitignore` ga `*.key` va `*.pem` qo'shiladi.
- **Prod maxfiy kaliti** repoga hech qachon kirmaydi. Kim imzolaydi (bulut xizmatimi yoki egasining CLI'simi), bu S2 savoli.
- **Brauzer (POS UI):** UI imzoni **tekshirmaydi**. U paketni hub'dan oladi (`GET /rules/package/active`), hub esa paketni import paytida va har yuklashda tekshiradi. Ishonch chegarasi lokal hub. Yakuniy qaror baribir `completeSale` da qabul qilinadi. Shuning uchun brauzerga WebCrypto Ed25519 kerak emas. Kelajakda kerak bo'lsa, verifier porti WebCrypto bilan ham implement qilinadi, rules ichida o'zgarish talab qilinmaydi.

---

## 3. Paketni yetkazish va saqlash

T2.4 (pull) hali yo'q, shuning uchun hozircha import qo'lda bo'ladi.

- **API:**
  - `POST /rules/package` (yangi ruxsat `rules:import`, faqat owner va manager): JSON konvert yoki fayl (base64).
  - `GET /rules/package/active` (`catalog:read` yoki `cart:write`): faol paket va uning holati. Kassa UI'si buni chaqiradi.
- **Import ketma-ketligi:**
  1. Zod bilan tekshiriladi.
  2. `keyId` ishonchli va `issuedAt` vaqtida amal qilgan bo'lishi kerak.
  3. Imzo tekshiriladi.
  4. `packageVersion > max_imported_version` bo'lishi kerak (**rollback himoyasi**). Teng versiya qayta yuborilsa va baytlari ham bir xil bo'lsa, natija idempotent. Teng versiya, lekin boshqa bayt bo'lsa, rad etiladi.
  5. Saqlanadi.
- **Saqlash:** yangi `LOCAL` jadval `local_rule_packages`. Ustunlar:
  - `package_version`, `key_id`, `issued_at_ms`, `valid_until_ms`;
  - `envelope_json` (asl baytlar);
  - `imported_at_ms`, `imported_by_user_id`;
  - `is_active`. UNIQUE partial indeks bilan bir vaqtda faqat bitta faol paket bo'ladi.
  - `local_hub_config` (yoki alohida singleton) da `max_rule_package_version`.
- **Har yuklashda qayta tekshiruv:** hub paketni xotiraga yuklashda imzoni qayta tekshiradi. Bazada qo'lda o'zgartirilgan paket "buzilgan" holatiga o'tadi va paket yo'q deb hisoblanadi (8-bo'lim). Log'ga xato yoziladi.
- **Sinf `LOCAL`:** paket imzoli artefakt va har hub uni o'zi import qiladi. Bulut orqali tarqatish T2.4 yoki keyingi bosqichda bo'ladi. Sinxron kodiga tegilmaydi.

---

## 4. `evaluate` API

`@mezon/rules`, toza funksiya:

```ts
evaluate(cart: RulesCartInput, payments: RulesPaymentInput[], context: RulesContext): RulesResult

RulesCartInput = { lines: Array<{
  lineId, lineKind, mxik: string | null,          // T3.1 snapshot
  qtyMilli: bigint, finalTotalTiyin: bigint,      // chegirmadan keyingi summa
  batchExpiries: Array<{ expiryDateMs: bigint | null, qtyMilli: bigint }>,  // FIFO legs (hub), UI'da bo'sh
  prescription: PrescriptionInput | null,
}> }

RulesPaymentInput = { method: SalePaymentMethod, amountTiyin: bigint,
                      socialCard?: SocialCardInput | null }

RulesContext = { nowMs: bigint, storeTimezone: string,
                 pkg: VerifiedRulesPackage | null, pkgState: 'ok'|'missing'|'expired'|'invalid',
                 fiscalMode: boolean, phase: 'preview' | 'final' }

RulesResult = { block: RuleFinding[], warn: RuleFinding[], packageVersion: string | null }
RuleFinding = { code: RuleCode, i18nKey: `rules.${code}`, lineIds: string[],
                mxik?: string, details?: Record<string, string> }
```

- Vaqt va soat faqat `context` orqali kiradi. `Date.now()` ishlatilmaydi.
- Natija deterministik: qatorlar tartibi saqlanadi, kodlar barqaror tartibda.
- Hub'da `block` bo'sh bo'lmasa, `DomainError('RULES_BLOCKED')` (HTTP 422) tashlanadi. Uning `details` qismida topilmalar bo'ladi. UI ularni i18n orqali ko'rsatadi.

---

## 5. Har qoida semantikasi (taklif va savollar)

| Kod | Qoida | Taklif qilingan semantika | Noaniq (S-savol) |
|---|---|---|---|
| `CASH_FORBIDDEN_MXIK` | Taqiqlangan MXIK uchun naqd chek rad etiladi | Qatordagi MXIK `cashForbidden` ga to'g'ri kelsa (aniq yoki prefiks) va to'lovlarda `cash` > 0 bo'lsa, block | S3: `advance` (avval naqd olingan avans) va nasiya (qarz) naqd hisoblanadimi? |
| `MIXED_RECEIPT_CASHLESS` | Aralash chekda bitta taqiqlangan tovar bo'lsa, butun chek naqdsiz | Yuqoridagining chek darajasidagi ko'rinishi: bitta taqiqlangan qator bo'lsa, **butun chekda** naqd ishlatib bo'lmaydi. Qisman naqd ham block. Taqiqlangan qatorlar va naqd summa ko'rsatiladi | S3 bilan bir xil |
| `MXIK_CASH_LIMIT` | 25 mln limiti bitta chekdagi bitta MXIK bo'yicha | Chekdagi qatorlar MXIK bo'yicha guruhlanadi (`finalTotal` yig'indisi). `exempt` dagi MXIK'lar o'tkazib yuboriladi. **Faqat naqd to'lov bo'lsa** va guruh summasi `> limitTiyin` bo'lsa, block. Chegara: `limit` ga teng summa ruxsat etiladi | S4: limit naqd to'lovgami yoki umumiy summagami? Aralash to'lovda naqd ulushi MXIK'larga qanday taqsimlanadi (proporsional `allocate` yoki konservativ)? `>` mi yoki `≥` mi? |
| `PRESCRIPTION_REQUIRED` | Retsept dorisi retsept ma'lumotisiz rad etiladi | MXIK `prescriptionRequired` ga to'g'ri kelsa va qatorda `prescription` yo'q yoki to'liq bo'lmasa, block | S5: retseptning majburiy maydonlari qaysilar? |
| `SOCIAL_CARD_DATA_REQUIRED` | Ijtimoiy karta: karta turi, raqami, tranzaksiya raqami | `social_card` to'lovida uchala maydon bo'lmasa, block. Format faqat bo'sh emaslik va uzunlik bo'yicha tekshiriladi, karta raqami formatini o'ylab topmayman | S6: karta turlari ro'yxati va raqam formati; to'liq raqam saqlanadimi? |
| `EXPIRED_GOODS` | Muddati o'tgan tovar cheki rad etiladi | Qatorning FIFO bo'yicha ajratilgan partiyalaridan birortasining `expiryDateMs` mahalliy sanasi **bugundan oldin** bo'lsa (do'kon vaqt zonasida), block. Aynan bugun tugaydigan partiya ruxsat etiladi | S7: "bugun tugaydi" ruxsatmi? Partiyasiz tovarda muddat yo'q, tekshirilmaydi |
| `MXIK_MISSING` | (T3.1 dan) | MXIK'siz qator: warn. Fiskal rejimda nima bo'lishi 8-bo'limda | — |
| `PACKAGE_EXPIRED` / `PACKAGE_MISSING` / `PACKAGE_INVALID` | Eskirgan paket: ogohlantirish | 8-bo'limga qarang | — |

**Qaytarish va bekor qilish (S8):**

- Bekor qilish (`void`) yangi to'lov olmaydi, shuning uchun qoidalar qo'llanmaydi.
- Qaytarish: taklifim shuki, cheki naqdsiz bo'lgan taqiqlangan-MXIK qatorni naqd pulda qaytarish **taqiqlanadi**. Aks holda bu qoidani chetlab o'tish yo'li bo'ladi. Bu qonuniy masala, shuning uchun savol sifatida qoldiraman.
- Qaytarish yo'liga kod yozilmaydi, faqat S8 javobidan keyin.

---

## 6. Retsept va ijtimoiy karta ma'lumotlari

- **Retsept:** hozircha struktura umumiy: `PrescriptionInput = { reference: string, issuedAtMs?: string }`. Majburiy maydonlar S5 javobiga ko'ra belgilanadi.
- **Ijtimoiy karta:** `SocialCardInput = { cardType: string, cardNumber: string, transactionId: string }`.
- **Saqlash va sinxron:** ikkalasi ham chek bilan bitta tranzaksiyada saqlanishi kerak. Bu **sinxron FACT jadvallar**ga yangi ustun yoki jadval demak (`payments` ga ustunlar yoki `payment_social_card_details`, `sale_line_prescriptions`). Gemini'ning sxema mosligi testi bulut juftini talab qiladi. Shuning uchun **S9:** T3.1 dagi kabi bulut juftini Gemini qo'shadimi?
- **PII himoyasi:**
  - Karta raqami bazada **faqat maskalangan** holda (oxirgi 4 raqam) saqlanadi, to'liq raqam yozilmaydi. Agar fiskal hamkor to'liq raqamni talab qilsa, bu T3.0 va S6 masalasi.
  - Hub log'larida pino `redact` yo'llariga `*.cardNumber`, `*.socialCard.*` va `*.prescription.*` qo'shiladi.
  - Hisobot va Excel eksportlariga bu maydonlar umuman chiqmaydi (API testi bilan).
  - Kassir javobida faqat maskalangan raqam bo'ladi.
- **Kassa UI:**
  - To'lov ekranida `social_card` tanlanganda uchta maydonli forma chiqadi.
  - Retseptli MXIK qatorida "Retsept" tugmasi va forma bo'ladi.
  - Savatdagi ogohlantirish va bloklar paneli.
  - Naqd tugmasi bloklangan bo'lsa, sababi ko'rsatiladi.
  - Barcha matnlar i18n orqali.

---

## 7. Integratsiya nuqtalari

| Yo'l | Qayerda | Rejim |
|---|---|---|
| Savat (UI) | POS `@mezon/rules` dan `evaluate(…, phase: 'preview')` ni chaqiradi. Paket `GET /rules/package/active` dan olinadi. Muddat ma'lumotlari bo'sh, chunki partiya hali ajratilmagan | ogohlantirish va bloklarni oldindan ko'rsatadi |
| Savat (hub) | `GET /carts/:id/rules-check`, xuddi shu `evaluate` bilan | preview |
| Savdoni yakunlash (`POST /carts/:id/complete`) | `completeSaleCoreInTxSync` ichida, FIFO partiyalari ajratilgandan **keyin**, yozuvlardan **oldin** | final, block bo'lsa butun tranzaksiya rollback |
| Buyurtmani `deliver` qilish | O'sha `completeSaleCoreInTxSync` | final |
| API va bot | Ikkalasi ham faqat `completeSale` orqali savdo qiladi (§3.1.9). Bot hali skelet | final (shu nuqta orqali) |
| Buyurtma yaratish | To'lov noma'lum, shuning uchun faqat preview ogohlantirishi; avans to'lovida S3 | warn |

**"Bir xil kod" isboti:**

1. Hub'da `evaluate` faqat bitta joydan, `completeSaleCoreInTxSync` dan chaqiriladi. Grep testi buni tekshiradi: rules chaqiruvi boshqa repo fayllarida yo'qligi.
2. Integratsion test: bitta savat uchun `GET /carts/:id/rules-check` block qaytarsa, `complete` ham aynan shu kodlar bilan 422 qaytaradi. Buyurtma `deliver` yo'li ham, to'g'ridan-to'g'ri API ham xuddi shunday.
3. Property testi: tasodifiy savat va to'lovlar uchun preview'dagi `block` kodlari (muddatdan tashqari) final'dagi kodlarga teng.
4. depcruise: `apps/hub` va `apps/pos` ning ruxsat ro'yxatiga `packages/rules` qo'shiladi. Rules'ning faqat `domain` ni import qilish qoidasi o'zgarmaydi.

---

## 8. Paket holatlari

| Holat | Qachon | Hozir (`fiscalMode = false`) | `fiscalMode = true` (T3.3 da yoqiladi) |
|---|---|---|---|
| `ok` | Imzo to'g'ri, `now ≤ validUntil` | qoidalar to'liq ishlaydi | xuddi shunday |
| `expired` | `now > validUntil` | **warn** (`PACKAGE_EXPIRED`), eski paketning qoidalari baribir qo'llanadi (spetsifikatsiyada "eskirgan paket: ogohlantirish") | warn va qoidalar qo'llanadi |
| `missing` | Paket hali import qilinmagan, yoki prod kaliti yo'q | **warn** (`PACKAGE_MISSING`), qonuniy qoidalar baholanmaydi, faqat `SOCIAL_CARD_DATA_REQUIRED` va `EXPIRED_GOODS` ishlaydi, chunki ular paket ma'lumotiga bog'liq emas | **taklif: block**. S10 ga qarang |
| `invalid` | Bazadagi paketning imzosi buzilgan | `missing` kabi va log'ga xato | `missing` kabi |
| eskiroq versiya | Import paytida | import rad etiladi (`RULES_PACKAGE_ROLLBACK`), faol paket o'zgarmaydi | xuddi shunday |

**Asos:** §3.2 ga ko'ra savdoni faqat qonuniy qoida to'xtatadi, internet yoki texnik muammo to'xtatmaydi. Fiskal rejim hali yoqilmagan. Shu sababli paket yo'qligi hozir savdoni to'xtatmaydi. Fiskal rejimda qonuniy qoidalarni baholamasdan chek berish xavfli, shuning uchun u yerda block taklif qilyapman.

Fiskal rejim bayrog'i `local_hub_config.fiscal_mode_enabled` (standart `false`). U API orqali o'zgarmaydi: T3.3 gacha faqat testlarda yoqiladi.

---

## 9. Testlar

### Rules (unit, toza)

- **Chegara jadvali:**
  - limit: `limit − 1` / `limit` / `limit + 1` tiyin, faqat naqd, faqat karta, aralash;
  - istisno MXIK;
  - ikki MXIK, har biri limitdan past, lekin yig'indisi yuqori → ruxsat;
  - bitta MXIK ikki qatorga bo'lingan → yig'indi bo'yicha hisoblanadi.
- **Naqd taqiqi:** aniq va prefiks moslik, prefiks chegarasi (`9990` va `999` farqi), naqd 1 tiyin (aralash) → block, naqdsiz → o'tadi.
- **Retsept:** ma'lumot bor yoki yo'q, bo'sh `reference`.
- **Ijtimoiy karta:** har bir maydon bo'sh bo'lgan holat.
- **Muddat:** kecha → block, bugun → o'tadi (S7), ertaga → o'tadi. `Asia/Tashkent` da 23:59 va 00:00 chegaralari. Bir qatorda ikki partiya, biri muddati o'tgan.
- **Paket holatlari:** 8-bo'limdagi jadvaldagi har bir katak uchun.
- **Property testlari:**
  - qatorlar tartibini aralashtirish natijani o'zgartirmaydi;
  - naqdsiz chek hech qachon `CASH_*` block olmaydi;
  - `block` bo'sh bo'lsa, bloklangan to'lov naqd bo'lmaydi;
  - kanonik serializatsiya kalit tartibiga bog'liq emas.

### Imzo (hub darajasi, `node:crypto`)

- Imzosiz paket → rad.
- Payload'da **bitta bayt** o'zgartirilgan (property: tasodifiy bayt) → rad.
- Imzoda bitta bit o'zgartirilgan → rad.
- Boshqa kalit bilan imzolangan, `keyId` ishonchli → rad.
- Ishonchsiz `keyId` → rad.
- `keyId` imzoli konvertda almashtirilgan → rad.
- Eski versiya → rad (rollback).
- Teng versiya, bir xil baytlar → idempotent.
- Bazada qo'lda o'zgartirilgan paket → `invalid`.
- Kalitning `validFrom` / `validUntil` oralig'i.

### Integratsiya (hub)

- `complete` → 422 `RULES_BLOCKED` va to'liq rollback: chek, outbox va zaxira harakatlari yozilmaydi. Keyingi savdo sog' o'tadi.
- Buyurtma `deliver` block bo'ladi.
- Preview va final bir xil kodlarni beradi.
- RBAC: import faqat owner va manager uchun.
- PII: log, hisobot va eksportlarda to'liq karta raqami yo'q.
- Perf: 50 qatorli chek va 10 000 MXIK'li paket bilan `evaluate` ≤ 5 ms (`completeSale` ning 300 ms byudjeti ichida).

### Mutatsiya rejasi

- `>` ↔ `≥` limitda;
- istisno tekshiruvi o'chiriladi;
- prefiks moslik o'rniga `includes`;
- aralash chekda faqat taqiqlangan qator tekshiriladi;
- muddat taqqoslashi `<` → `<=` va UTC bilan;
- imzo tekshiruvi har doim `true` qaytaradi;
- `keyId` imzolanmaydi;
- rollback tekshiruvi o'chiriladi;
- `completeSale` da `evaluate` chaqiruvi olib tashlanadi;
- `deliver` yo'li o'tkazib yuboriladi;
- PII redaksiyasi o'chiriladi.

---

## 10. Bog'liqliklar va fayllar

- **`packages/rules`:** faqat `@mezon/domain`. Fayllar:
  - `package.ts`: tiplar va qo'lda yozilgan tekshiruv;
  - `canonical.ts`;
  - `verify.ts`: port, ishonchli kalitlar, holat aniqlash;
  - `evaluate.ts`;
  - `rules/*.ts`: har qoida alohida;
  - `trusted-keys.ts`.
  - Lint qoidasi (domen va rules'da `Number` taqiqlangan) saqlanadi: hamma narsa `bigint` bilan.
- **`packages/contracts/src/rules-package.ts`:** Zod konvert va API DTO'lari.
- **`packages/db-local`:**
  - migratsiya `0016`: `local_rule_packages`, `local_hub_config` ga `max_rule_package_version` va `fiscal_mode_enabled`;
  - repo;
  - `sale-repo.ts` dagi integratsiya.
  - `db-local` faqat `domain` ni import qila oladi. Shuning uchun `evaluate` `completeSaleCoreInTxSync` ga **port sifatida** uzatiladi (`rulesEvaluator` parametri, hub beradi), yoki depcruise'ga `db-local → rules` ruxsati qo'shiladi. **Taklifim: port.** Shunda `db-local` qoidalar haqida bilmaydi, hub esa ikkala yo'l (`complete` va `deliver`) uchun bitta evaluator beradi. Bu S11.
- **`apps/hub`:**
  - `rules-routes.ts` (import, faol paket, `rules-check`);
  - `node:crypto` Ed25519 verifier;
  - `server.ts` dagi ulanishlar;
  - logger `redact` yo'llari.
- **`apps/pos`:** savat va to'lov ekranidagi panel, ijtimoiy karta va retsept formalari.
- **`scripts/rules-sign.mjs`**, `.gitignore`.
- **`.dependency-cruiser.cjs`:** `hub` va `pos` ruxsat ro'yxatiga `packages/rules`.
- **Tegilmaydi:** `apps/cloud/**`, `packages/db-cloud/**`, `apps/hub/src/sync*`, `packages/contracts/src/sync.ts`.

**Hajm:** vazifa katta. Agar nazoratchi ma'qul ko'rsa, ikki PR'ga bo'lishni taklif qilaman:

- **T3.2a:** paket formati, imzo, import, `evaluate` va paketga bog'liq bo'lmagan qoidalar (muddat, ijtimoiy karta), `completeSale` va `deliver` integratsiyasi, UI paneli.
- **T3.2b:** egasining S3–S8 javoblaridan keyin naqd taqiqi, aralash chek, limit va retsept qoidalarining aniq semantikasi.

---

## Egasi yoki nazoratchi qarori kerak bo'lgan savollar

Egasi ko'rsatmasi bilan barcha savollar nazoratchi orqali yuboriladi: nazoratchi egasidan so'rab, javobni topshiriqda beradi. "(egasi)" belgisi savolning javobi egasidan kelishi kerakligini bildiradi.

- **S1 (egasi):** taqiqlangan MXIK, retseptli MXIK va limit istisnolarining **rasmiy manbasi** qayer (PF-246 ilovasimi, soliq qo'mitasi ro'yxatimi)? Ro'yxatni kim tayyorlaydi va qanchalik tez-tez yangilanadi?
- **S2 (egasi):** prod imzolash kalitini kim saqlaydi va paketni kim imzolaydi: bulut xizmatimi yoki egasining CLI'simi? Prod ochiq kaliti va `keyId` ni kim beradi?
- **S3 (egasi):** naqd taqiqi va aralash chek qoidasida avans (`advance`) va nasiya (qarz) naqd hisoblanadimi?
- **S4 (egasi):** 25 mln limiti naqd to'lovgami yoki chekdagi MXIK'ning umumiy summasigami? Aralash to'lovda naqd ulush qanday taqsimlanadi? Chegara `>` mi yoki `≥` mi?
- **S5 (egasi):** retseptning majburiy maydonlari qaysilar?
- **S6 (egasi):** ijtimoiy karta turlari va raqam formati qanday? To'liq raqamni saqlash talab qilinadimi?
- **S7 (egasi):** "aynan bugun tugaydigan" partiyani sotish ruxsatmi?
- **S8 (egasi):** taqiqlangan MXIK'li naqdsiz chekni naqd pulda qaytarish ruxsatmi?
- **S9 (nazoratchi):** ijtimoiy karta va retsept ma'lumotlari uchun sinxron FACT ustunlar yoki jadvallarning bulut jufti, T3.1 dagi kabi Gemini tomonida qo'shiladimi?
- **S10 (nazoratchi yoki egasi):** fiskal rejimda paket yo'q bo'lsa, savdo bloklanadimi (mening taklifim) yoki faqat ogohlantirish chiqadimi?
- **S11 (nazoratchi):** `completeSale` ga evaluator'ni port sifatida uzatish (taklif) yoki depcruise'da `db-local → rules` ruxsati, qaysi biri?
- **S12 (nazoratchi):** T3.2a va T3.2b ga bo'lish ma'qulmi?
