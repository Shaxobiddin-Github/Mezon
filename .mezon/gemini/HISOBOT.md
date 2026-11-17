# Hisobot: T2.7a — Biznes kabineti (o'qish qismi)

Branch: `gemini/T2.7-cabinet`. Gemini boshlagan, **Claude yakunlagan** (Gemini to'xtagach, egasi qarori bilan).
Holat: **TAYYOR**, PR kutilmoqda. `main` (T4.6, T2.4) merge qilingan.

## Gemini kodida topilgan va tuzatilgan xatolar

| # | Xato | Oqibati | Tuzatish |
|---|---|---|---|
| S1 | Ikkala refresh endpoint'i har doim `role: 'owner'` beradi (T2.1 dan beri `main` da) | kassir bitta so'rov bilan egaga aylanadi | rol, holat va ism har refresh'da bazadan o'qiladi |
| S2 | Refresh bloklangan foydalanuvchini tekshirmaydi | bloklangan xodim 30 kun ishlaydi | `status !== 'active'` → barcha tokenlar bekor |
| P1 | Parity testi 2024 yilgi ma'lumotni 2026 oralig'ida so'ragan | ikki **bo'sh** hisobot solishtirilgan, test hech narsani tekshirmagan | sanalar to'g'rilandi, ma'lumot borligi tekshiriladi |
| P2 | Bulut tushumi chegirmani hisobga olmaydi | tushum oshib ko'rsatiladi | kassa formulasi (`final_total`) |
| P3 | Foyda QQS bilan, qaytarilgan tannarx qaytmaydi | foyda noto'g'ri (585 714 o'rniga 800 000) | `net_ex_vat − cost`, qaytarish tannarxni qaytaradi |
| P4 | Chek summasi va tafsiloti chegirmadan oldingi raqam | egasi mijoz to'lagandan boshqa summani ko'radi | `total_final`, chegirma = jami − to'langan |
| E1 | `/admin/products` va `/admin/inventory/low-stock` doim 500 | sahifalar umuman ishlamaydi | mavjud ustunlar (`sale_price`, `min_stock`) |
| E2 | 500 javobida SQL xabari va PG kodi | ichki tuzilma oshkor | `cloudErrorHandler` |
| V1 | Dashboard va hisobot butun tarixni o'qiydi; har qatorga yangi `Intl` | 31 kunlik hisobot 15,7 s | oraliq bo'yicha so'rov, kun kaliti keshi (kassada ham) |
| U1 | UI matnlari kodda (86 ta), pul minus belgisini yo'qotadi, "bugun" UTC bo'yicha | | i18n (uz-Latn, uz-Cyrl, ru), `@mezon/ui` formatlash, Toshkent kuni |

## Mutatsiyalar (12/12 o'ldirildi)

M2 rol tekshiruvi, M3 bekor qilingan chek, M4 kun chegarasi UTC, M5 Origin tekshiruvi, M6 telefon maskasi, M7 refresh `owner`, M8 bloklangan foydalanuvchi, M9 kassir admin kanalida, M10 chegirma, M11 foyda QQS bilan, M12 qaytarish tannarxi, chek chegirmasi = 0.

## Hajm (A5, `admin-store.perf.test.ts`: 100k chek, 50k mahsulot, 500k harakat)

| So'rov | Natija |
|---|---|
| Cheklar ro'yxati (1-sahifa va 22-sahifa) | ~90–100 ms |
| Dashboard | ~140–390 ms |
| 31 kunlik hisobot (53 352 chek) | 0,7–1,2 s (oldin 15,7 s) |
| Kam qolgan tovar | ~0,5–0,7 s |
| Mahsulotlar sahifasi | ~30–40 ms |

## Tekshiruv

- build, lint, typecheck, `db:check` (lokal va bulut, 0 diff), depcruise, format — yashil.
- Bulut va `db-cloud` testlari ketma-ket: 105/106. Yagona yiqilish — tezlik testi kompyuter yuklangan paytda; yolg'iz ishga tushirilganda 3/3.
- To'liq `verify` da 3 ta PG testi container ishga tushishida (yuklanish) vaqt tugashidan yiqilgan; alohida ishga tushirilganda o'tadi.

## Keyingi

- PR: `T2.7a: Biznes kabineti (o'qish qismi)`, ochishni ishchi2 bajaradi.
- T2.7b (yozish) bulut "buyruq yozuvchi" porti tayyor bo'lgach (ishchi2, T2.6 bilan).
