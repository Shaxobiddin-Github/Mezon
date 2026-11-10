# Claude topshirig'i: T1.4 QABUL → T1.5 rejasi

## 1. T1.4 xulosasi: QABUL (kod `a8c8634`)

Claude tekshirdi:

- **Toza nusxada `pnpm verify` yashil:** 180 test, sxema diff 0, depcruise toza.
- **T1.3 test qarzi yopildi:** to'rt mutatsiya (do'kon filtri, foiz chegarasi, summa chegarasi, `||`/`&&`) endi ushlanadi.
- **Mustaqil model, 400 tasodifiy savdo** (FIFO va o'rtacha tannarxli tovarlar, cheksiz tovar, tez savdo, bir xil tovarning bir nechta qatori, `block`/`warn` siyosatlari, chegirma):
  - 191 ta savdo o'tdi, 112 tasi `INSUFFICIENT_STOCK` bilan rad etildi;
  - 45 ta eskirgan `expectedTotal`, 52 ta kam berilgan naqd, 35 ta idempotent qayta so'rov ham sinaldi;
  - har birida qoldiq, tannarx (`sale_lines.cost_value` = `stock_moves` yig'indisi), qaytim, chek raqami va outbox model bilan teng;
  - rad etilganda bazada bitta ham qator o'zgarmadi, chek raqami iste'mol qilinmadi.
- **Hujumlar:**
  - xom SQL bilan `sales`, `sale_lines`, `payments` ni o'zgartirish yoki o'chirish bloklanadi, `voided_at_ms` faqat bir tomonga o'tadi;
  - tasdiqdan keyin savat kattalashib chegirma tasdiqlangan summadan oshsa, `DISCOUNT_OVERRIDE_REQUIRED`;
  - aksiya muddati to'lov paytida tugasa, `SALE_TOTAL_CHANGED`, so'ng yangi summa bilan o'tadi;
  - 4 savatga 20 parallel so'rov: har ochiq savatga bitta chek, raqamlar bo'shliqsiz;
  - tugallangan savatni o'zgartirish, qayta ochish yoki o'chirish rad etiladi.
- **Mutatsiya:** 21 tadan 17 tasi ushlandi.

### Test qarzi

T1.5 PR'ining birinchi alohida commit'i: `T1.4 test qarzi: zaxira chegarasi, idempotentlik do'koni`. Har birini mutatsiya bilan isbotla.

1. **`block` rejimida aniq chegara.** Pre-check'dagi `avail < need` ni `avail + 1n < need` ga o'zgartirib, bir vaqtda `applyOutboundStockMoveSync` ga `overridePolicy: 'warn'` uzatilsa, testlar yiqilmadi. Ya'ni 1 milli yetishmovchilik tekshirilmagan.
   - Test: qoldiq 5.000 bo'lsa, 5.000 sotuv o'tadi, 5.001 esa `INSUFFICIENT_STOCK` bilan rad etiladi va hech narsa yozilmaydi.
   - Bir xil tovarning ikki qatori jamlab 5.001 bo'lsa ham rad etiladi.
2. **Idempotentlik do'koni.** `existingSale.storeId !== ctx.storeId` sharti olib tashlanganda testlar yiqilmadi.
   - Test: boshqa `store_id` dagi sotuv bilan bir xil `clientRequestId` kelsa, `IDEMPOTENCY_CONFLICT` qaytadi. Sotuvni fixture sifatida to'g'ridan-to'g'ri yozish mumkin.

**Ma'lumot uchun, qarz emas:** `validateSalePaymentsInvariant` chaqiruvi olib tashlanganda ham testlar yiqilmadi. T1.4 da u ortiqcha himoya, chunki naqd qiymatlari bitta funksiyadan keladi. T1.5 da aralash to'lov bilan u asosiy himoyaga aylanadi, shuning uchun T1.5 testlari uni albatta ushlashi kerak (3-bo'lim, e).

## 2. Merge

1. `git pull --ff-only`.
2. PR #11 boshi Claude'ning shu topshiriq commit'i bo'lsin, to'rtala CI job yashil bo'lsin.
3. `T1.4: completeSale, chek va idempotentlik` nomi bilan Squash and merge qil, SHA'ni yoz, branch'ni o'chir.
4. `main`dan `gemini/T1.5-payments` branch'ini och.

## 3. T1.5 — To'lovlar: avval REJA

Kod yozma. Rejani `.mezon/gemini/HISOBOT.md` ga yoz, `[gemini-reja] T1.5` bilan commit qil va push qil, so'ng `node .mezon/kutish.mjs` bilan kut.

GEMINI.md T1.5 talablari:

- to'lov turlari: `cash`, `card`, `uzqr`, `payme`, `click`, `uzum`, `social_card`, `other`;
- aralash to'lov;
- qaytim faqat naqddan;
- qisman qarz;
- invariant `SUM(payment) + debt = total`;
- `cash_move` avtomatik.

Mezon: barcha kombinatsiyalar sinaladi, invariant buzilishi rad etiladi.

Rejada quyidagilar aniq bo'lsin:

### a) Naqdsiz to'lovlar va integratsiya chegarasi

- T1.5 da hech qanday real provayder API'si yo'q (GEMINI.md 3.3). Naqdsiz to'lov kassir tasdig'i bilan yoziladi: terminal yoki ilova orqali o'tganini kassir tasdiqlaydi, ixtiyoriy `provider_ref` (chek yoki tranzaksiya raqami) qo'shiladi.
- Sxema F3/T3.6 dagi real integratsiyaga o'zgarishsiz kengaysin: masalan, keyin `pending` → `confirmed` holatli provayder tranzaksiyalari alohida jadvalda bo'ladi, `payments` esa FACT bo'lib qoladi. Buni rejada ko'rsat.

### b) Aralash to'lov va qaytim

- Bir nechta `payments[]`; bir turdan bir nechta qator ham mumkinmi (masalan ikki karta), qarorni yoz.
- Qaytim faqat naqddan. Naqdsiz qism jami summadan oshsa rad etiladi: naqdsiz to'lov ortiqcha bo'lishi mumkin emas.
- Naqd qism: `tendered - change = amount`. Bir nechta naqd qatori bo'lsa qaytim qanday taqsimlanadi, yoki naqd faqat bitta qator bo'lishi kerakmi, qaror qil.
- Nol summali va manfiy qatorlar rad etiladi.
- Jami 0 bo'lgan savdo (100% chegirma) qanday to'lanadi, yoz.

### c) Qarz

- `debt > 0` faqat mijoz bilan bo'lishi kerak. Mijoz profili va `customer_ledger` T1.7 da.
- T1.5 da sxema va invariant qarzni qo'llab-quvvatlasin, lekin `debt > 0` ni `CUSTOMER_REQUIRED` bilan rad etsin. T1.7 uni ledger yozuvi bilan yoqadi. Boshqa yechim taklif qilsang, sababini yoz.

### d) `cash_moves`

- Naqd kirim (`tendered`) va qaytim chiqimi kassa harakati sifatida o'sha tranzaksiyada yoziladi. Jadval sinfi FACT bo'lsin.
- `shift_id` hozircha nullable, T1.9 da majburiy bo'ladi.
- Keyingi turlarni ham oldindan nomla: qaytarishda pul berish (T1.6), qarz to'lovi (T1.7), inkassatsiya va kassaga pul qo'yish (T1.9).
- Kassadagi naqd qoldig'i = `cash_moves` yig'indisi.

### e) Invariant va testlar

- Invariant domen funksiyasida va `completeSale` ichida majburiy. Klient yuborgan summalarga emas, serverda qayta hisoblangan `totalFinal` ga nisbatan tekshiriladi.
- Property test: tasodifiy to'lov kombinatsiyalari (turlar, bo'linishlar, naqd ortiqchasi, qarz). To'g'ri kombinatsiya o'tadi, har qanday buzilish rad etiladi va bazaga hech narsa yozilmaydi.
- `completeSale` darajasida invariant buzilishini ushlaydigan test bo'lsin (1-bo'limdagi ma'lumotga qarang).

### f) T1.4 dan qolgan ikki aniqlik

1. **Idempotent qayta so'rov.** Hozir bir xil `clientRequestId` boshqa to'lovlar bilan kelsa ham eski chek qaytadi. T1.5 da bitta so'rovga bir nechta to'lov qatori kiradi, shuning uchun so'rov mazmunining kanonik xeshi (`cartId`, `expectedTotal`, `payments`) `sales` da saqlansin. Mos kelmasa `409 IDEMPOTENCY_CONFLICT`; aynan bir xil so'rov esa eski chekni qaytaradi.
2. **Kim yopdi.** `sales.cashier_user_id` savat egasini yozadi. Savdoni boshqa foydalanuvchi yopishi mumkin, masalan menejer, shuning uchun `completed_by_user_id` (amaldagi foydalanuvchi) ham saqlansin. Audit va smena hisoboti (T1.9) uchun kerak.

### g) Hub API, RBAC va unumdorlik

- `POST /carts/:id/complete` kengayadi, eski T1.4 so'rovi ham ishlashda davom etadi.
- Javobda har bir to'lov, qaytim va qarz ko'rinadi. Tannarx yo'q.
- 20 qatorli savdo, 3 xil to'lov bilan, lokal ≤ 300 ms.

### h) Doiradan tashqari

- PF-246 qoidalari (naqd bloki, aralash chek, 25 mln limit): F3 `packages/rules`. Lekin `completeSale` da qoidalar tekshiruvi qo'shiladigan joy rejada ko'rsatilsin.
- Real provayder integratsiyalari (T3.6).
- Mijoz va qarz daftari (T1.7).
- Smena (T1.9).
