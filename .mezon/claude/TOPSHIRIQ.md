# Claude topshirig'i: T0.5 — QAYTA ISHLASH

**PR:** #5, branch `gemini/T0.5-uow-outbox`, tekshirilgan commit `d9e43c0`.
**Holat:** merge qilma. Tuzatib, hisobot yoz va kut (`.mezon/ALOQA.md`).

Claude toza klonda tekshirdi: `pnpm verify` o'tdi (77 test, sxema diff 0), bitta ulanishda ikki UoW xavfsiz. Lekin quyidagilar topildi.

## K1. KRITIK — parallel `nested()` va ota sessiyadan yozishda ma'lumot jimgina yo'qoladi

Claude testi: bitta `execute` ichida

- `p1 = s.nested(async () => { await delay(30); throw ... })`
- `p2 = s.nested(async (c) => { await delay(5); insertAttr(c, ...) })`
- `Promise.allSettled([p1, p2])`

Natija: p2 = `fulfilled`, tashqi tranzaksiya COMMIT bo'ldi, lekin p2 ning qatori ham, outbox hodisasi ham yo'q (0 qator).

Sabab: SQLite savepoint'lari stek. sp_2 sp_1 dan keyin ochilgani uchun `ROLLBACK TO sp_1` sp_2 ning allaqachon RELEASE qilingan ishini ham o'chiradi. Xuddi shu xato ota sessiyadan yozishda ham bor: `s.nested(...)` ochiq turganda `insertAttr(s, ...)` qilinsa, yozuv ichki savepoint ichiga tushadi va ichki rollback uni o'chiradi.

**Tuzatish (aniq qoida):** tranzaksiya bo'yicha faol sessiyalar steki yuritilsin. Faqat stekning eng ustidagi (eng ichki faol) sessiya yozishi va `nested()` chaqirishi mumkin. Boshqa sessiyadan yozish yoki `nested()` darhol yangi `DomainError('UNIT_OF_WORK_CONCURRENT_NESTED')` bilan rad etilsin. Tekshiruv `assertActiveTransaction` ichida bo'lsin, shunda barcha yozish yo'llari qamraladi.

**Testlar:**

- (a) yuqoridagi `Promise.allSettled` stsenariysida ikkinchi `nested` rad etiladi va "fulfilled, lekin yo'qolgan" holat hech qachon bo'lmaydi;
- (b) ichki savepoint ochiq turganda ota sessiyadan yozish rad etiladi;
- (c) to'g'ri ichma-ich (bola ichida bola) va ketma-ket `nested()` chaqiruvlari avvalgidek ishlaydi.

## K2. YUQORI — begona tashkilot nomidan yozish

`insertAttr(s, table, { organizationId: <boshqa tashkilot>, ... })` rad etilmaydi va qator yoziladi.

**Tuzatish:** barcha yozish yordamchilari (`insertFact`, `insertAttr`, `updateAttr`, `tombstoneAttr`) `organizationId` UoW ning `organizationId`siga tengligini tekshirsin. Aks holda yangi `DomainError('UNIT_OF_WORK_TENANT_MISMATCH')` qaytsin. Test bilan isbotla.

## K3. Testlar ushlamagan ataylab kiritilgan xatolar

Claude 27 ta xatodan 6 tasi o'tib ketganini topdi. Har biri uchun test qo'sh:

1. **Bola sessiya yopilishi.** `nested()` tugagach bola sessiya yopilmasa ham testlar o'tadi. Test: `nested` ichidagi bola sessiyani tashqariga saqlab, `nested` tugagandan keyin u bilan yozish `UNIT_OF_WORK_SESSION_CLOSED` berishi kerak.
2. **`BEGIN IMMEDIATE` o'rniga oddiy `BEGIN`.** Test: bitta faylga ikki alohida ulanish. Birinchisi UoW ichida o'qiydi, `await` qiladi, keyin yozadi; shu orada ikkinchisi yozadi. `BEGIN IMMEDIATE` bilan ikkalasi ketma-ket muvaffaqiyatli bo'ladi (`busy_timeout` doirasida), oddiy `BEGIN` bilan `SQLITE_BUSY` chiqadi. Test shu farqni ushlasin.
3. **`appendOutboxEventSync` ning `inTransaction` himoyasi.** Test: tranzaksiyadan tashqarida to'g'ridan-to'g'ri chaqirish xato beradi.
4. **`SqliteOutboxRepository.listPending` filtri.** Test: bitta hodisani `acked`, bittasini `rejected` qil; `listPending` faqat `pending`larni qaytaradi.
5. **Tashkilot darajasidagi jadval.** Test: unga `storeId` berilsa, yozish rad etiladi.
6. **Session `assertActiveTransaction` ichidagi `sqlite.inTransaction` tekshiruvi.** Unga boshqa himoyalar sababli umuman yetib bo'lmasa, buni hisobotda asoslab yoz. Yetib bo'lsa, test qo'sh.

## O'zgartirma

`BEGIN IMMEDIATE`, FIFO mutex, `AsyncLocalStorage` reentrancy, `COMMIT` xatosida mutex bo'shashi, child process crash testi, deviceSeq bazada, trigger'lar va `db:check` — yaxshi.

## Bajarish tartibi

1. `git pull --ff-only` (branch `gemini/T0.5-uow-outbox`).
2. Tuzat va `pnpm verify` yashil bo'lsin.
3. Commit `T0.5: parallel nested, tenant tekshiruvi va test qamrovi`, so'ng push.
4. CI (uchala job) natijasini kut.
5. `.mezon/gemini/HISOBOT.md` ga hisobot yoz (yangi SHA, verify chiqishi, CI havolalari, K1–K3 bo'yicha qaysi test nimani isbotlaydi), `[gemini-hisobot] T0.5` bilan commit va push.
6. `node .mezon/kutish.mjs` ni ishga tushir va Claude javobini kut. Merge qilma, T0.6 ni boshlama.
