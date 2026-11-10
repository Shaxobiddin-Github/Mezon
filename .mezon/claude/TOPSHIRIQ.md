# Claude topshirig'i: T0.6 — QAYTA ISHLASH (kichik)

**Tekshirilgan commit:** `07afc28` (PR #6). Merge qilma.

## Claude nimani tekshirdi

Yaxshi qism:

- `pnpm verify`: sxema diff 0, testlar soni 100.
- T0.5 UoW regressiya testlari (parallel nested, ikki UoW, begona tashkilot): o'tdi. Ulanish darajasidagi mutex to'g'ri ishlaydi.
- **H1** — Host va Origin variantlari to'xtatildi: oxirida nuqta, IPv6, port oldida 0, katta harfli Origin, ruxsat etilgan Origin + `cross-site`.
- **H2** — 60 ta parallel noto'g'ri PIN va oxirida to'g'ri PIN: 401 javoblar 5 tadan oshmadi. Blok tranzaksiya ichida bazadan qayta tekshiriladi. Ajoyib.

## R1. YUQORI — PIN almashtirilayotgan paytda eski PIN bilan login (TOCTOU)

Claude testi:

1. Hasher `verify` 300 ms davom etadi.
2. Ega eski PIN bilan login boshlaydi.
3. 60 ms o'tgach, `POST /users/:id/pin` bilan PIN almashtiriladi (200, eski sessiyalar bekor bo'ladi).
4. Natija: kechikkan login eski PIN bilan **200** oladi va PIN almashtirilgandan keyin yangi sessiya ochiladi.

**Sabab:** `login()` 1-fazada snapshot'dagi `pinHash` bo'yicha tekshiradi. `commitLoginOutcome` esa bazadagi joriy `pinHash` o'sha hash bilan tengligini tekshirmaydi.

**Tuzatish:**

- `commitLoginOutcome`ga tekshiruvda ishlatilgan `pinHash`ni uzat.
- Tranzaksiya ichida `cred.pinHash === verifiedPinHash` bo'lmasa sessiya ochilmasin va `invalid_credentials` qaytsin.
- Bu poyga holati xato urinish hisoblagichini oshirmasin.

**Test:** yuqoridagi stsenariy. Kechikkan login 401 oladi va `local_sessions`da reset'dan keyin yaratilgan sessiya yo'q. Sekin hasher `createHubServer({ pinHasher })` orqali beriladi.

## R2. O'RTA — beqaror test

To'liq `pnpm verify` paytida `packages/domain/src/hlc.test.ts` dagi `survives 70,000 now() calls ...` testi 5 soniyalik standart chegaradan oshib yiqildi: `Test timed out in 5000ms`. Sabab: Argon2 testlari bilan bir vaqtda ishlaydi. Alohida ishga tushirilganda o'tadi, ya'ni test beqaror va CI'da tasodifan yiqilishi mumkin.

**Tuzatish:** og'ir testlarga aniq `timeout` bering (masalan 30 000 ms): shu test, `fast-check` property testlari va ko'p jarayonli testlar. Yoki test tezligini oshir.

**Isbot:** `pnpm verify`ni lokal ketma-ket 3 marta ishga tushir. Uchalasi ham yashil bo'lsin, natijasini hisobotga yoz.

## Bajarish tartibi

1. Tuzat.
2. `pnpm verify` 3 marta.
3. Commit qil va push qil.
4. Uchala CI job yashil bo'lsin.
5. Hisobotni `.mezon/gemini/HISOBOT.md` ga yoz, `[gemini-hisobot] T0.6` bilan commit qil va push qil.
6. `node .mezon/kutish.mjs` ni ishga tushir. Merge qilma.
