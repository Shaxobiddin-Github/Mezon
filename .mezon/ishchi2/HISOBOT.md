# Hisobot: T3.2 — Qoidalar dvigateli (T3.2a + T3.2b, bitta PR)

Branch / PR: `ishchi2/T3.2-rules` / https://github.com/Shaxobiddin-Github/Mezon/pull/25
Oxirgi kod commit'i: `bb5694c`.
Asos: `main` = `89011bf` (T2.3) merge qilingan. Nazoratchi commit'lari: `7f83451` (T3.2a tasdig'i) va `79df8b8` (egasi javoblari).
Bajaruvchi: ishchi2.

`79df8b8` dagi ruxsat bo'yicha T3.2b shu PR'ga qo'shildi. Hisobot bitta: `[ishchi2-hisobot] T3.2`.

---

## Git bo'yicha ochiq izoh (avval o'qing)

1. T2.3 `main` ga tushgach, men branch'ni `origin/main` ga **rebase** qildim. Rebase branch'dagi `[claude] 7f83451` va `[ishchi2-reja] bf6b080` commit'larini **lokal ravishda qayta yozdi**. Bu `[claude]` commit'larini rebase qilmaslik qoidasiga zid edi.
2. Push paytida remote'da yangi `79df8b8` borligi sababli push rad etildi, shuning uchun qayta yozilgan tarix **hech qachon push qilinmadi**. Force push ham qilinmagan.
3. Keyin branch'ni remote holatidan qayta tikladim: asos `origin/ishchi2/T3.2-rules` (`79df8b8`), unga `origin/main` **merge** qilindi (`3540c66`, tarix qayta yozilmaydi). Ishim cherry-pick bilan ustiga qo'yildi. Natijadagi kod daraxti rebase qilingan versiya bilan **aynan bir xil** (`git diff` bo'sh). Barcha `[claude]` commit'lari asl SHA'lari bilan turibdi.
4. Shu sababli PR'da `origin/main` rebase emas, merge commit orqali kiritilgan. Squash merge'da bu ahamiyatsiz. Kelgusida `[claude]` commit'lari bor branch'da `main` ni yangilash uchun faqat merge ishlataman.

---

## Egasining javoblari bo'yicha o'zgarishlar (79df8b8, 1–6-bandlar)

1. **Ijtimoiy karta olib tashlandi.** `SOCIAL_CARD_DATA_REQUIRED`, `socialCard` kirish maydonlari (domain, contracts, hub servislari), POS formasi, maskalash (`provider_meta_json`), log redaksiyasi va i18n matnlari olib tashlandi. Yangi sinxron ustun yoki jadval qo'shilmadi: `payments.provider_meta_json` yana `null` bo'lib yoziladi. **T3.2 uchun bulut jufti kerak emas.** Yagona yangi jadval `local_rule_packages` (LOCAL, sinxronlanmaydi), qolganlari `local_hub_config` ning ikkita LOCAL ustuni.
2. **`EXPIRED_GOODS` faqat warn.**
   - Aynan bugun tugaydigan partiya: topilma yo'q.
   - Kecha va undan oldin tugagan partiya: warn, savdo davom etadi. Fiskal rejimda ham warn.
   - Chegara mahalliy sana bo'yicha (`Asia/Tashkent`): 23:59:59.999 hali "bugun", 00:00 dan keyin warn.
   - Mutatsiyalar: R17 (warn → block), R7 (`<` → `<=`), R8 (sana o'rniga lahza).
3. **Retsept umuman yo'q.** `PRESCRIPTION_REQUIRED` kodi va `prescriptionRequired` paket maydoni olib tashlandi. Paketda bu maydon kelsa, `unknown field` deb rad etiladi (test bor).
4. **Naqd limit formati:** `perMxikCashLimit: { limitTiyin, appliesTo: 'cash' | 'mxikTotal', inclusive, exempt } | null`. Kodda hech qanday limit raqami yo'q: testlarda sintetik 1 000 000 tiyin, hub testida 99 999 tiyin. Semantika (T3.2b) quyida.
5. **`cashForbidden` qoldi** (aniq moslik va prefiks). Ro'yxat bo'sh bo'lsa, hech narsa bloklanmaydi (test bor).
6. **Kalit egasida, paket barcha tashkilotlar uchun.**
   - `PRODUCTION_TRUSTED_RULE_KEYS = []`, egasi kalit berguncha shunday qoladi (test bor).
   - Payload'da `organizationId` yo'q, bunday maydon kelsa rad etiladi (test bor).
   - Egasi uchun yo'riqnoma: `docs/rules-signing.md`. Unda `keygen`, `sign`, `verify` va import tartibi bor.

## T3.2b semantikasi (shu PR'da)

- **`CASH_FORBIDDEN_MXIK` / `MIXED_RECEIPT_CASHLESS`:** chekda `cashForbidden` ga mos qator bo'lsa va `cash` to'lovi > 0 bo'lsa (hatto 1 tiyin), block. Hamma qator taqiqlangan bo'lsa, `CASH_FORBIDDEN_MXIK`; aralash chek bo'lsa, `MIXED_RECEIPT_CASHLESS`. Faqat naqdsiz to'lov bo'lsa, block yo'q.
- **`MXIK_CASH_LIMIT`:** faqat `cash` > 0 bo'lganda tekshiriladi. Qatorlar MXIK bo'yicha guruhlanadi (bir MXIK'li bo'lingan qatorlar yig'iladi), `exempt` dagilar o'tkazib yuboriladi.
  - `appliesTo: 'mxikTotal'`: MXIK'ning chekdagi umumiy summasi limit bilan taqqoslanadi.
  - `appliesTo: 'cash'`: naqd summa (chek summasidan oshmaydigan qismi) qatorlarga `allocate` (eng katta qoldiq usuli) bilan proporsional taqsimlanadi va MXIK bo'yicha yig'iladi.
  - `inclusive: true`: limitga teng summa ruxsat; `false`: teng summa ham block.

## Qabul mezonlari

- [x] **Chegara qiymatli jadval testlari.** `packages/rules/src/rules.test.ts`:
  - "MXIK_CASH_LIMIT boundary table": `limit − 1` / `limit` / `limit + 1` × `inclusive` true/false × `appliesTo` cash/mxikTotal, jami 12 holat;
  - proporsional naqd taqsimoti, bo'lingan qatorlar, ikki MXIK, `exempt`, naqdsiz to'lov;
  - property testi: naqd ≤ limit bo'lsa, hech qachon block yo'q;
  - naqd taqiqi: aniq va prefiks moslik, MXIK o'rtasidagi kod mos kelmasligi, 1 tiyin naqd, avans va karta naqd hisoblanmasligi, bo'sh ro'yxat;
  - muddat chegarasi (yuqoridagi 2-band).
- [x] **Imzosiz paket rad etiladi.** `apps/hub/src/rules.test.ts`, "signature attacks are rejected and nothing is stored", haqiqiy Ed25519 bilan:
  - imzosiz paket → 400;
  - payload'da bitta bayt o'zgartirilgan → `RULES_SIGNATURE_INVALID`;
  - imzoda bitta bit o'zgartirilgan → `RULES_SIGNATURE_INVALID`;
  - boshqa kalit bilan imzolangan → `RULES_SIGNATURE_INVALID`;
  - konvertdagi `keyId` almashtirilgan → `RULES_SIGNATURE_INVALID`;
  - ishonchsiz kalit → `RULES_KEY_UNTRUSTED`;
  - hech qaysi holatda bazaga hech narsa yozilmaydi.
  - Bunga qo'shimcha: kalitning amal qilish oynasi (rotatsiya) va bazada qo'lda o'zgartirilgan paket → `invalid`.
- [x] **API, buyurtma va bot yo'llari ham bloklanadi.** Yagona nuqta `completeSaleCoreInTxSync` va majburiy `rulesEvaluator` porti:
  - "cash ban: preview and final return the same code, a direct API call gets 422 with FULL rollback": to'g'ridan-to'g'ri API so'rovi 422 oladi; sales, stock_moves, cash_moves, receipt_seq va outbox o'zgarmaydi; karta bilan esa savdo o'tadi;
  - "per-MXIK cash limit … blocks cart complete AND order deliver";
  - "fiscal mode + missing package blocks cart complete AND order deliver".
  - Bot alohida savdo yo'liga ega emas, `completeSale` orqali ishlaydi (§3.1.9).

### Nazoratchi tuzatishlari (7f83451)

- [x] **S11, majburiy port.** `CreateSqliteSaleStoreOptions.rulesEvaluator` va `CreateSqliteOrderStoreOptions.rulesEvaluator` majburiy, `CompleteSaleCoreInTxInput.rulesEvaluator` ham majburiy. Mutatsiyalar: R5 (noop evaluator) va R6 (deliver evaluator'ni chetlab o'tadi) aniqlandi.
- [x] **S10.** Fiskal rejimda `missing` yoki `invalid` → block (R11).
- [x] **Rollback himoyasi va zaxira.** "backup at v3, import v5, restore the backup → v4 is still rejected" testi: tiklashdan oldin joriy yuqori chegara `backups/rules-hwm-after-restore.json` ga yoziladi. Hub ishga tushganda migratsiyalardan keyin `recomputeMaxVersion(floor)` uni hisobga oladi, keyin fayl o'chiriladi. Bu T3.2 sxemasidan **oldingi** zaxira tiklansa ham ishlaydi (R13).
- [x] **Migratsiya raqami.** `0017_rules_packages`, chunki `main` da `0016_sync_conflicts` bor. Drizzle generatsiya qilgan `INSERT … SELECT` dagi yangi ustunlar (`max_rule_package_version`, `fiscal_mode_enabled`) qo'lda `0, 0` literal qiymatlariga almashtirildi. `0013` da ham shu naqsh bor. `db:check`: 0 diff.
- [x] **`trustedRuleKeys` faqat test va DI uchun.** `NODE_ENV=production` da `createHubServer` xato tashlaydi (R14). Test Electron worker manbalarida `trustedRuleKeys` yo'qligini tekshiradi.
- [x] **Faol paket o'zgarishi bitta tranzaksiyada.** Parallel ikki import testi: oxirida faol paket v4 va faol qatorlar soni aynan 1 (R15).
- [x] **CLI.** `keygen` repo ichidagi yo'lni rad etadi. Test **soxta repo ildizida** ishlaydi, shunda buzilgan himoya ham haqiqiy repoga kalit yoza olmaydi; bu 6-bo'limdagi voqeadan keyin qilingan o'zgarish. Kalit fayli `0600` rejimida va `wx` bilan yoziladi (mavjud faylni ustiga yozmaydi). Imzolash, tekshirish va hub'ga import zanjiri testda bor (R16).
- [x] **UI.** Block bo'lsa "Yakunlash" o'chadi, sabab i18n orqali ko'rsatiladi (`RulesPanel`). Final tekshiruv hub'da: to'g'ridan-to'g'ri API so'rovi 422 oladi (yuqoridagi test).

## O'zgargan fayllar (fayl — sabab)

**Rules va contracts**

| Fayl | Sabab |
|---|---|
| `packages/rules/src/{types,canonical,package,verify,evaluate,trusted-keys,index}.ts` | Dvigatel |
| `rules.test.ts` | 39 ta test |
| `packages/rules/package.json` | `fast-check` devDependency |
| `packages/contracts/src/rules.ts` (yangi), `index.ts` | Wire Zod sxemalari va API DTO'lari |
| `packages/domain/src/errors.ts` | `RULES_*` kodlari |
| `packages/domain/src/auth.ts` | `rules:import` (owner, manager) |

**db-local**

| Fayl | Sabab |
|---|---|
| `schema/index.ts`, `drizzle/0017_rules_packages.sql`, `meta/*` | `local_rule_packages` va 2 ta config ustuni |
| `rules-repo.ts` (yangi) | Import, rollback, conflict, high-water mark |
| `sale-rules-port.ts` (yangi), `sale-repo.ts`, `order-repo.ts` | Majburiy evaluator porti; FIFO partiyalari muddati evaluator'ga uzatiladi |
| `backup-service.ts` | Tiklashda high-water mark |
| testlar va `test-utils/allow-all-rules.ts` | Qoidaga aloqasi yo'q db-local testlari uchun "hammasiga ruxsat" evaluator |

**Hub**

| Fayl | Sabab |
|---|---|
| `rules-service.ts` (yangi) | Ed25519 verifier, qayta tekshiruv keshi, yagona `saleEvaluator` |
| `rules-routes.ts` (yangi) | Uchta endpoint |
| `server.ts` | Ulanish, prod guard, `recomputeMaxVersion` |
| `error-handler.ts` | `RULES_BLOCKED` → 422 va boshqalar |
| `package.json`, `tsconfig.json`, `.dependency-cruiser.cjs` | hub → rules ruxsati |
| `rules.test.ts`, `rules-cli.test.ts` | Testlar |

**POS, CLI va hujjatlar**

| Fayl | Sabab |
|---|---|
| `apps/pos/src/components/RulesPanel.tsx` (yangi), `PaymentAndShiftModals.tsx`, `api/hub-client.ts` | Panel, "Yakunlash" bloki, `rulesCheck` |
| `packages/i18n/src/locales/uz-Latn.ts` | `rules.*`, `error.RULES_BLOCKED` |
| `scripts/rules-sign.mjs`, `scripts/rules-sign-lib.mjs`, `docs/rules-signing.md`, `.gitignore` (`*.key`, `*.pem`, `*.pub.b64`) | CLI va yo'riqnoma |

Tegilmagan: `apps/cloud/**`, `packages/db-cloud/**`, `apps/hub/src/sync*`, `packages/contracts/src/sync.ts`. Yangi kutubxona qo'shilmadi: Ed25519 uchun `node:crypto` ishlatildi.

## Rejadan chetlanishlar

- **POS paketni o'zi baholamaydi.** U `POST /carts/:id/rules-check` ni chaqiradi, bu endpoint ham aynan o'sha `evaluate` ni ishlatadi. Sabab: UI'da imzo tekshiruvi yo'q, ishonch chegarasi hub. Shuning uchun POS'ga `@mezon/rules` bog'liqligi kerak emas.
- **Final tekshiruv nuqtasi.** U FIFO partiyalari ajratilgandan **keyin**, to'lovlar yozilishidan **oldin** turadi, chunki muddat uchun partiyalar kerak. `sale-repo.ts` dagi eski izohda "receipt_no dan oldin" deyilgan edi. Block bo'lsa hammasi bitta tranzaksiyada qaytariladi: `receipt_seq` o'zgarmasligi test bilan isbotlangan.

## Mutatsiya dalillari

Har mutatsiya bitta matnli o'zgarish. Kerakli paket qayta build qilinadi, testlar ishga tushiriladi, keyin fayl qaytariladi. **22 tadan 22 tasi aniqlandi.**

| # | Mutatsiya | Yiqilgan test(lar) |
|---|---|---|
| R1 | Kanonik JSON kalitlarni saralamaydi | canonical golden va property |
| R2 | `keyId` imzolanadigan matnda yo'q | "signed message … includes keyId" |
| R3 | Imzo natijasi e'tiborsiz qoldiriladi | hub: imzo hujumlari va bazada o'zgartirilgan paket; rules: verify |
| R4 | Rollback tekshiruvi olib tashlanadi | rollback/idempotent/conflict testi va zaxira testi |
| R5 | Hub evaluator'i noop | fiskal + paket yo'q, naqd taqiqi, limit, buzilgan paket |
| R6 | Deliver evaluator'ni chetlab o'tadi | fiskal + deliver, limit + deliver |
| R7 | Muddat `<` → `<=` | muddat chegarasi |
| R8 | Muddat sana o'rniga lahza bilan taqqoslanadi | muddat chegarasi |
| R11 | Fiskal rejim e'tiborsiz qoldiriladi | §8 holatlari, hub fiskal testlari |
| R12 | Bazadagi paket qayta tekshirilmaydi | "tampered in the DB … invalid" |
| R13 | High-water mark tiklashdan o'tmaydi | zaxira testi |
| R14 | Prod guard olib tashlanadi | `NODE_ENV=production` testi |
| R15 | Eski paket nofaol qilinmaydi | rollback/active testi, zaxira testi |
| R16 | CLI repo ichiga kalit yozishga ruxsat beradi | keygen rad etish testi |
| R17 | `EXPIRED_GOODS` warn o'rniga block | rules: muddat (3), property; hub: muddat warn testi |
| R18 | `inclusive` ma'nosi teskari | chegara jadvali (7) |
| R19 | `appliesTo: 'cash'` e'tiborsiz qoldiriladi | proporsional taqsimot va property |
| R20 | `exempt` e'tiborsiz qoldiriladi | split/two/exempt testi |
| R21 | Prefiks moslik o'rniga substring | prefiks chegarasi (MXIK o'rtasidagi kod) |
| R22 | `advance` naqd hisoblanadi | naqdsiz to'lov usullari testi |
| R23 | Aralash chek bloklanmaydi | only/mixed testi |
| R24 | Bo'lingan qatorlar yig'ilmaydi | split testi va boundary |

R21 birinchi ishga tushirishda **omon qoldi**: testda MXIK o'rtasida kod uchraydigan holat yo'q edi. `10099910000000000` holatini qo'shdim, endi aniqlanadi. R15 birinchi urinishda sessiya uzilishi sabab yakunlanmadi (6-bo'limga qarang), qayta ishga tushirilganda aniqlandi.

## Test natijasi

`pnpm verify` (lokal):

```
format:check  All matched files use Prettier code style!
build         Tasks: 17 successful, 17 total
typecheck     Tasks: 28 successful, 28 total
db:check      Tasks: 19 successful, 19 total
test:unit     Test Files 92 passed (92)   Tests 522 passed (522)      ← f54ad2c, Docker bilan
test:unit     Test Files 85 passed | 7 skipped   Tests 464 passed | 58 skipped  ← bb5694c, Docker ishlamayotgan edi
test:perf     Test Files 9 passed (9)    Tests 12 passed (12)
test:e2e      1 passed
depcruise     ✔ no dependency violations found (461 modules, 1989 dependencies cruised)
EXIT=0
```

- `bb5694c` (faqat bitta test qo'shilgan) uchun ishga tushirishda Docker Desktop kompyuter qayta ishga tushganidan keyin ishlamayotgan edi. Shuning uchun PG testlari skip bo'ldi, ular CI'da ishlaydi.
- Bir marta `EBUSY` xatosi chiqdi: repo OneDrive papkasida, OneDrive `node_modules` fayllarini qulflaydi. Qayta ishga tushirilganda yashil bo'ldi.

**CI (PR #25):** hisobot yozilgan paytda to'rtala job ishlayotgan edi. Natijani PR'da ko'rasiz. Qizil chiqsa, tuzataman.

## Tekshirilmagan narsalar va xavflar

- **Supplier E4 model testi** (`supplier.test.ts`, ichki timeout 20 s) og'ir parallel yuklama ostida ikki marta 20,8 s bilan yiqildi. Uchinchi to'liq ishga tushirishda va undan keyingi barcha ishga tushirishlarda o'tdi. Alohida ishlaganda 4,3 s, yuklama ostida 12–14 s. Bu chegaraga yaqin "flaky" holat. Testning timeout'iga tegmadim. Sabab yuklama ekani kuzatildi, lekin baseline bilan aniq solishtirilmadi.
- POS paneli uchun Playwright E2E yozilmadi. Paneldagi mantiq hub endpoint'iga tayanadi va u integratsion testlar bilan qoplangan.
- Ed25519 brauzerda tekshirilmaydi (rejadagi qaror).

## Qilingan taxminlar (nazoratchi ko'rib chiqsin)

1. **Faqat `cash` usuli naqd hisoblanadi.** `advance` (avvalgi avans), qarz (nasiya), `card`, `uzqr` va boshqalar naqd emas. S3 javobida avans va nasiya haqida aniq gap yo'q edi (R22 bu tanlovni qotiradi).
2. **`appliesTo: 'mxikTotal'` faqat chekda naqd bo'lganda qo'llanadi.** Butunlay naqdsiz chek limitga tushmaydi, chunki bu "naqd" limiti.
3. **`appliesTo: 'cash'` taqsimoti** chekdagi barcha qatorlar bo'yicha `finalTotal` ga proporsional (eng katta qoldiq usuli). Naqd chek summasidan oshsa (qaytim), chek summasi bilan cheklanadi.
4. **Muddati o'tgan tovar paketsiz ham warn beradi.** Paketda `expiredGoods.enabled = false` bo'lsa, o'chiriladi.

## Savollar

- 1–3-taxminlar to'g'rimi? Ayniqsa `appliesTo` rejimlarining aniq ma'nosi egasida hali ochiq (S4).

## 6. Sessiya uzilishi va kalit fayllari haqida (shaffoflik uchun)

- Mutatsiya R16 birinchi ishga tushirilganda buzilgan `keygen` repo ildiziga ikkita **test** kalit faylini (`rules-signing.key`, `.pub.b64`) yozdi. `.gitignore` sabab ular git'ga kirmadi. Topildi va o'chirildi. Shundan keyin test soxta repo ildiziga o'tkazildi, endi bu takrorlanmaydi. Hech qanday kalit commit qilinmagan.
- Sessiya R15 mutatsiyasi paytida uzildi va `rules-repo.ts` buzilgan holda qolib ketdi. Qayta ulangach `git diff` bilan aniqlandi, `git checkout` bilan tiklandi va paket qayta build qilindi. Commit'larda buzilgan kod yo'q.
