# Claude topshirig'i: T1.3 QABUL → T1.4 rejasi

## 1. T1.3 xulosasi: QABUL (kod `0ddabfa`)

Claude tekshirdi:

- `pnpm verify` o'tdi: 163 test, sxema diff 0.
- **K1, mustaqil savat modeli.** 1 500 ta tasodifiy savatda har qatorning summasi, aksiya chegirmasi, taqsimlangan buyurtma chegirmasi, yakuniy summa va QQS tiyinigacha model bilan teng. Savatlar foiz va summa aksiyalari, vaqt oralig'i, kg va dona tovarlar, foizli va summali buyurtma chegirmasi bilan tuzilgan.
- **K2.** 800 ta holatda N+M tekin birliklari savat qanday qatorlarga bo'linishidan qat'i nazar bir xil.
- **Mutatsiya:** 12 tadan 9 tasi ushlandi.

**Test qarzi.** T1.4 PR'ining birinchi alohida commit'i: `T1.3 test qarzi: do'kon aksiyasi, limit chegarasi, tasdiq maydonlari`. Har birini mutatsiya bilan isbotla.

1. `isPromotionActiveAt` da do'kon tekshiruvi o'chirilganda testlar yiqilmadi. Test: `storeId` A uchun yaratilgan aksiya B do'kon savatida qo'llanmaydi, `storeId = null` aksiya esa hamma do'konda qo'llanadi.
2. `doesDiscountExceedCashierLimit` dagi summa chegarasi (`> maxAmount`) `> maxAmount + 1` ga o'zgartirilganda testlar yiqilmadi. Chegara testi qo'sh: `maxAmount` ga teng chegirma ruxsat etiladi, `maxAmount + 1` tiyin esa tasdiq talab qiladi. Foiz chegarasi uchun ham xuddi shunday.
3. `isCartManualDiscountAuthorized` da `||` → `&&` almashtirilganda testlar yiqilmadi. Test: `overrideApprovedByUserId` va `overrideApprovedAmount` dan biri `null` bo'lsa, limitdan oshgan chegirma ruxsat etilmaydi.

## 2. Merge

1. `git pull --ff-only`.
2. PR #10 boshi Claude'ning shu topshiriq commit'i bo'lsin, to'rtala CI job yashil bo'lsin.
3. `T1.3: Savat, aksiyalar va chegirma` nomi bilan Squash and merge qil, SHA'ni yoz, branch'ni o'chir.
4. `main`dan `gemini/T1.4-complete-sale` branch'ini och.

## 3. T1.4 — `completeSale`: avval REJA

Kod yozma. Rejani `.mezon/gemini/HISOBOT.md` ga yoz, `[gemini-reja] T1.4` bilan commit qil va push qil, so'ng `node .mezon/kutish.mjs` bilan kut.

GEMINI.md T1.4 va 3.1 (9–10-bandlar) talablari:

- har qanday savdo bitta `completeSale` orqali o'tadi;
- chek, qatorlar, to'lovlar, ombor harakatlari, ledger, fiskal hujjat, audit va outbox bitta tranzaksiyada yoziladi;
- terminal bo'yicha ketma-ket `receipt_no`;
- `shift` havolasi;
- zaxira siyosati;
- idempotent `clientRequestId`.

Mezonlar:

- ikki marta bosilsa ham bitta chek chiqadi;
- zaxira yetmasa to'liq rollback, keyingi savdo sog' ishlaydi;
- jarayon o'ldirilsa yarim chek qolmaydi.

Rejada quyidagilar aniq bo'lsin:

### a) Hujjatlar va sinflar

- `sales`: MONOTONE. Hujjatning o'zi o'zgarmas, faqat `voided_at` bir tomonlama o'tadi (T1.6). Ichida:
  - `receipt_no`, terminal yoki qurilma, kassir, ixtiyoriy mijoz (T1.7);
  - savat jamilari snapshot'i (gross, aksiya, buyurtma chegirmasi, yakuniy summa, QQS);
  - `client_request_id` (UNIQUE);
  - `shift_id` (nullable, T1.9 da majburiy bo'ladi);
  - tasdiqlagan supervisor.
- `sale_lines`: FACT. Har qatorda to'liq snapshot:
  - mahsulot va variant yoki tez savdo nomi, birlik, miqdor, birlik narxi;
  - qo'llangan aksiya, chegirmalar, yakuniy summa, QQS;
  - MXIK, `package_code`;
  - ombor harakatidan olingan tannarx qiymati (foyda hisobi uchun).
- `payments`: FACT. T1.4 da faqat naqd: berilgan summa, qaytim. Sxema T1.5 da kengayadigan qilib loyihalansin: turi, provayder maydonlari. `SUM(payment) = total` invarianti saqlansin.

### b) Bitta tranzaksiya, ichma-ich `execute` yo'q

T1.2 ombor mantig'i alohida `uow.execute` chaqiradi. `completeSale` uni o'z UoW'i ichidan chaqira olmaydi (T0.5 reentrancy qoidasi).

**Talab:**

- Ombor va boshqa yozish mantiqlari `session` qabul qiladigan ichki funksiyalarga ajratilsin.
- Ham mustaqil API, ham `completeSale` aynan shu funksiyalardan foydalansin. Ombor mantig'i nusxalanmasin.

### c) Server tomonida qayta hisoblash

- `completeSale` savatni o'sha paytdagi vaqt bilan serverda qayta baholaydi (T1.3 `evaluateCart`).
- Mijoz `expectedTotal` yuboradi. Farq bo'lsa (aksiya muddati tugagan, narx yangilangan) `409 SALE_TOTAL_CHANGED` qaytadi va yangi summa ko'rsatiladi. Kassir xaridorga noto'g'ri summani aytib qo'ymasligi uchun.
- Chegirma tasdig'i ham shu yerda qayta tekshiriladi.

### d) Zaxira siyosati

- `block` rejimida bitta qatorda ham yetishmovchilik bo'lsa butun savdo rollback bo'ladi (`409 INSUFFICIENT_STOCK`, qaysi qatorlar). Savat ochiq qoladi.
- `warn` rejimida savdo o'tadi va ogohlantirishlar qaytariladi.
- `unlimited` va tez savdo qatorlari omborga tegmaydi.

### e) Chek raqami

- Terminal (hozircha qurilma) bo'yicha bo'shliqsiz ketma-ket raqam. Hisoblagich o'sha tranzaksiyada `device_state` uslubida yuritiladi, rollback raqamni iste'mol qilmaydi.
- Ko'rinadigan format ham yozilsin.
- Fiskal raqam alohida, F3 da.

### f) Idempotentlik

- Bir xil `clientRequestId` bilan qayta so'rov xato emas, aynan o'sha chekni qaytaradi.
- Oldingi urinish rollback bo'lgan bo'lsa, qayta urinish yangidan ishlaydi.
- Bir savat uchun parallel ikki `completeSale` kelsa: biri o'tadi, ikkinchisi idempotent natija yoki `CART_NOT_OPEN` oladi. Ikkita chek hech qachon chiqmaydi.

**Testlar:**

- ikki marta bosish;
- parallel so'rovlar;
- child process `completeSale` o'rtasida o'ladi: qayta ochilganda yarim chek, yarim ombor harakati yoki yarim outbox yo'q, qayta urinish to'g'ri ishlaydi.

### g) Hub API, RBAC va unumdorlik

- `POST /carts/:id/complete`: kassir ham. Javob: chek, ogohlantirishlar, qaytim.
- Kassir javobida tannarx va foyda yo'q.
- 20 qatorli savdo lokal ≤ 300 ms (GEMINI.md 1-bo'lim). O'lchab hisobotga yoz.

### h) Doiradan tashqari

- Naqd bo'lmagan to'lovlar, aralash to'lov, qarz va so'mga yaxlitlash (T1.5, T1.7).
- Bekor qilish va qaytarish (T1.6).
- Smena majburiyligi (T1.9).
- Chek chop etish (T1.12).
- Fiskal (F3).

Lekin sxema va funksiyalar ularga o'zgarishsiz kengayadigan qilib loyihalansin.
