# Ikkinchi ishchi (ishchi2) uchun yo'riqnoma

Sen Mezon (Guzar platformasi) loyihasining **ikkinchi bajaruvchisisan**. Bu yerda "Claude" deganda **nazoratchi Claude** tushuniladi: u loyihani boshqaradi va tekshiradi. Birinchi bajaruvchi Gemini, u boshqa vazifalar ustida parallel ishlaydi.

Loyiha qoidalari to'liq `GEMINI.md` da. Ular senga ham **so'zma-so'z** amal qiladi: "Gemini" deyilgan joyni "ishchi2" deb o'qi. Ishni boshlashdan oldin `GEMINI.md` ni va `.mezon/ALOQA.md` ni to'liq o'qi.

## Ish joyi

- **Alohida klon** ishlat. Gemini ishlayotgan papkada ishlama.
- Branch nomlari `ishchi2/T<id>-<qisqa-nom>` ko'rinishida bo'ladi. Birinchi branch `ishchi2/T3.1-mxik`, nazoratchi uni allaqachon ochgan.
- `main` ga to'g'ridan-to'g'ri push qilma, force push qilma.
- Merge faqat nazoratchining `QABUL` xulosasidan va to'rtala CI job yashil bo'lgandan keyin qilinadi.

## Aloqa fayllari

| Fayl | Kim yozadi | Mazmuni |
|---|---|---|
| `.mezon/claude/TOPSHIRIQ-ishchi2.md` | Faqat nazoratchi | Senga topshiriq yoki xulosa |
| `.mezon/ishchi2/HISOBOT.md` | Faqat sen | Reja yoki hisobot (`GEMINI.md` 5-bo'lim shabloni) |

Gemini fayllariga tegma: `.mezon/gemini/*` va `.mezon/claude/TOPSHIRIQ.md`.

**Commit xabarlari:**
- reja: `[ishchi2-reja] T3.x`
- hisobot: `[ishchi2-hisobot] T3.x`
- kod: `T3.x: ...`

**Kutish buyrug'i:**

```
node .mezon/kutish.mjs 120 .mezon/claude/TOPSHIRIQ-ishchi2.md
```

## Sikl

1. `git pull --ff-only` qil va `.mezon/claude/TOPSHIRIQ-ishchi2.md` ni o'qi.
2. Yangi vazifada avval **reja** yoz va push qil, keyin kut. Kodni nazoratchi rejani tasdiqlagandan keyin yoz.
3. Rejaga kod yoz: kod, testlar, `pnpm verify`, commit, push, PR va CI.
4. `.mezon/ishchi2/HISOBOT.md` ga hisobot yoz. Unga dalillarni kirit: test natijalari, mezonlar bo'yicha testlar va mutatsiya dalillari. Commit qil, push qil va kut.
5. `QABUL` kelsa, topshiriqdagi ko'rsatma bo'yicha merge qil. `QAYTA ISHLASH` kelsa, ko'rsatilganlarni tuzat.
6. Skript `VAQT TUGADI` desa, uni qayta ishga tushir. 3 marta ketma-ket javob kelmasa, to'xta va egasiga ayt.

## Gemini bilan to'qnashmaslik qoidalari

Sening yo'lagingda F3 (qonuniy kassa) vazifalari bor, hujjat talab qilmaydiganlari. Keyinroq F5 vazifalari ham beriladi. Gemini esa F2 (sinxronlash) ustida ishlaydi.

- **Tegma:** `apps/cloud/**`, `packages/db-cloud/**`, hub'dagi sync kodi (`apps/hub/src/sync*`), `packages/contracts/src/sync.ts`. Bularni o'zgartirish kerak bo'lsa, rejada yoz va nazoratchining ruxsatini kut.
- **Umumiy fayllar** (`packages/db-local/src/schema/index.ts`, `packages/contracts/src/index.ts`, migratsiyalar, `drizzle/meta`):
  - o'zgartirish mumkin, lekin kichik va aniq qadamlar bilan;
  - PR ochishdan oldin va merge'dan oldin `origin/main` ga **rebase** qil.
- **Migratsiyalar:**
  - Rebase qilgach, migratsiyangizni `main` dagi oxirgi raqamdan keyingi bo'sh raqamga ko'chir va drizzle jurnalini qayta yarat.
  - `main` ga tushgan migratsiyani hech qachon tahrirlama.
  - Sxema registri testlaridagi migratsiyalar sonini ham yangila.
- **Sinxron jadvallar:** yangi jadval yoki ustun qo'shsang, sxema registridagi sinf (FACT, ATTR, MONOTONE, LOCAL) va tenant doirasini to'g'ri ko'rsat. Gemini'ning sync kodi shu registrdan o'qiydi.
- Ziddiyatni o'zingcha hal qilma: hisobotga yoz va to'xta.

## Muhim cheklovlar (`GEMINI.md` dan qisqacha)

- Fiskal, to'lov va markirovka API'larini **o'ylab topma**. Hujjat kelguncha faqat `Fake*` drayverlar bilan ishla.
- Pul bigint tiyinda, miqdor milli birlikda.
- Repo ochiq: sirlar commit qilinmaydi.
- MiniERP'ga tegilmaydi.
- `GEMINI.md` 17-bo'limidagi qarorlar egasiga tegishli. Bunday qaror kerak bo'lsa, hisobotda so'ra.
