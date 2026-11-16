# Claude xulosasi: T2.4 qayta ishlash — SHARTLI QABUL (kichik test va PR)

Tekshirildi: `807b416` (kod `60f77df`). Toza klonda, toza build bilan, PG testlari Docker'da.

**Natija:**

- T2.4 testlari: 32/32 o'tdi (PG bilan).
- X1–X5 haqiqatan tuzatilgan:
  - ORACLE-P1 va 3 qurilma, 2 do'kondagi parallel test;
  - SQLite cheklovlarini tasniflash;
  - proyeksiyalar `rebuildProjections` oracle'iga teng;
  - haqiqiy bulut orqali ikki hub;
  - PG testlari ketma-ket.

**Mustaqil mutatsiyalarim** (8 ta):

| # | Mutatsiya | Natija |
|---|---|---|
| G1 | Tartib `received_at_ms` bo'yicha | aniqlandi |
| G2 | Cheklov xatosi vaqtinchalik deb tasniflanadi | aniqlandi |
| G3 | FK xatosi doimiy deb tasniflanadi | aniqlandi |
| G4 | Ombor proyeksiyasi yangilanmaydi | aniqlandi |
| G5 | Yetkazib beruvchi proyeksiyasi yangilanmaydi | aniqlandi |
| G6 | Echo faqat `deviceId` bo'yicha bostiriladi | aniqlandi |
| G8 | Ledger'lar tashkilot bo'yicha pull qilinmaydi | aniqlandi |
| **G7** | **Barcha jadvallar tashkilot bo'yicha pull qilinadi** (`.filter(() => true)`) | **OMON QOLDI** |

## Qolgan ishlar

### Y1. Do'kon izolyatsiyasi testi (G7)

Boshqa do'konning **do'kon doirasidagi** hodisasi (`sales`, `stock_moves`, `cash_moves`, `shifts`) boshqa do'kon hub'iga tushsa, hech bir test yiqilmaydi. "enforces pullScope" testi faqat tashkilot doirasidagi kategoriyani va boshqa tenantni tekshiradi.

Bu tushib qolsa, boshqa filialning savdo va ombor harakatlari kassaga kirib, qoldiqni buzadi.

**Test:**

1. `storeA1` qurilmasi do'kon doirasidagi hodisa push qiladi (kamida `stock_moves` va `sales`).
2. `storeA2` qurilmasi pull qiladi → bu hodisalar **kelmaydi**.
3. `storeA1` ning o'zi pull qilganda keladi.
4. Bir vaqtda ledger (`customer_ledger`) A2 ga keladi.

G7 mutatsiyasi endi yiqilishi kerak.

### Y2. PR va CI

PR hali ham ochilmagan. Hisobotda CI natijasi yo'q.

- `gemini/T2.4-sync-pull` dan `main` ga PR och.
- To'rtala job yashil bo'lsin, yangi `pg-cloud` loyihasi ham CI'da ishlasin.
- Hisobotga PR raqami va CI natijasini yoz.

### Y3. Migratsiya raqami

ishchi2'ning T3.2 (PR #25) qabul qilingan va undan oldin merge bo'ladi. U ham lokal `0017` (`0017_rules_packages`) ishlatadi.

- PR #25 `main` ga tushgach, `main` ni o'z branch'ingga **merge** qil (rebase emas).
- `0017_sync_pull` ni **`0018`** ga ko'chir, jurnal va snapshot'ni qayta yarat, migratsiya sonlari testlarini yangila.
- Agar sen birinchi tayyor bo'lsang ham, PR #25 ni kut.

### Y4. T2.6 uchun qayd (hozir tuzatish shart emas)

Pull partiyasida bitta `stock_moves` yoki ledger hodisasi bo'lsa ham **to'liq** qayta qurish ishga tushadi, va bu yozish tranzaksiyasi ichida bo'ladi. 50 ming mahsulotli do'konda bu kassa savdosini bloklashi mumkin. T2.6 ("faqat tegilgan yozuvlar") buni tuzatadi.

**Qo'shimcha so'rov:** hisobotda 50 ming mahsulot va 100 ming ledger qatorida bitta pull partiyasining vaqtini o'lchab yoz.

## Vazifalar taqsimoti o'zgarmoqda

Egasi qaroriga ko'ra **T2.4 merge qilingach** vazifalar almashtiriladi:

- **ishchi2:** T2.5, T2.6, T2.8 integratsion testi, fiskal va to'lov yadrosi, T4.1, T4.7.
- **Gemini:** T2.7 biznes kabineti, T2.8 Telegram bot qismi, T4.4 web-kassa UI, F5 Guzar Market UI, Cafe va bron UI.

Keyingi topshirig'ing T2.7 bo'ladi, merge'dan keyin shu faylda.

**Bitta qo'shimcha ish.** `claude/T4.6-i18n` branch'i (T4.6 tillar, men yozdim) uchun ham PR och: `T4.6: Tillar — o'zbek lotin, kirill va rus`. U PR #25 dan keyin merge bo'ladi, men uni avval o'sha holatga moslab yangilayman. PR'ni ochib qo'yishing kifoya, kodga tegma.

## Bajarish tartibi

1. Y1 testi. G7 mutatsiyasi yiqilishini hisobotda ko'rsat.
2. PR'larni och: T2.4 va `claude/T4.6-i18n`.
3. PR #25 merge bo'lishini kut, keyin Y3.
4. `MEZON_REQUIRE_PG_TESTS=1 pnpm verify` va CI yashil.
5. Hisobot `[gemini-hisobot] T2.4`, so'ng `node .mezon/kutish.mjs`. Merge qilma.
