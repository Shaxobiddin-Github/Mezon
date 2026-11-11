# Claude topshirig'i: T1.9 — QAYTA ISHLASH (R1)

Kod `9ac15e7` tekshirildi.

**Yaxshi tomonlari:**

- **Mustaqil model, 260 qadam:**
  - amallar: 33 smena, 17 kassir almashuvi, 63 savdo (qaytimli naqd va aralash), 25 qaytarish, void, `cash_in`/`cash_out`/inkassatsiya, 11 qayta yopish;
  - har yopilishda usullar bo'yicha savdo va qaytarish summalari, oxirgi sessiyaning kutilgan naqdi, `expectedCash` va `discrepancy` model bilan tiyinigacha teng;
  - `CASHIER_SESSION_MISMATCH` (6), yopiq smena chekini void qilish (`SHIFT_ALREADY_CLOSED`, 12), yopiq smenaga yozish va smenasiz savdo (`SHIFT_NOT_OPEN`) to'g'ri rad etiladi;
  - X3 to'g'ri: qaytim ikki marta ayirilmaydi.
- **Bitta pul xatosi bor.**

## B1. Kassir almashgandan keyin kassada haqiqatda bor pul noto'g'ri hisoblanadi

**Holat:**

- Kassir A almashishda `countedCash = 8 473` kiritdi, kutilgan summa `8 573` edi (kamomad −100).
- Qutida jismonan 8 473 qoldi. B sessiyasining `openingFloat` i ham 8 473.
- Lekin `getCurrentShift().drawerCashBalance` va `getTerminalCashBalance()` **8 573** qaytaradi (`opening + SUM(cash_moves)`).
- Naqd yetarliligi tekshiruvlari ham shu sonni ishlatadi. Natijada qutida yo'q 100 tiyinni qaytarish yoki inkassatsiya qilishga ruxsat beriladi. X1 maqsadi aynan shuni oldini olish edi.

**Talab:**

1. **Mavjud naqd** (barcha chiqim tekshiruvlari, `drawerCashBalance`, `getTerminalCashBalance()`) = **aktiv sessiyaning `openingFloat` i + shu sessiyadagi `cash_moves` yig'indisi** (`shift_cashier_session_id` bo'yicha).
2. **Smena darajasidagi `expectedCash`** (yopilish snapshot'i) `opening + SUM(cash_moves)` bo'lib qolishi mumkin. Shunda smena farqi = barcha sessiya farqlari yig'indisi. Bu munosabatni izohda yoz va testla.
3. **Test:**
   - almashishda −100 kamomad → B sessiyasida `drawerCashBalance` = 8 473 + B harakatlari;
   - 8 474 naqd qaytarish yoki inkassatsiya `INSUFFICIENT_CASH_IN_DRAWER`, 8 473 esa o'tadi;
   - smena yopilganda smena farqi = sessiya farqlari yig'indisi.
4. **Mutatsiya dalili:** eski formula qaytarilsa, test yiqiladi.

## B2. Unumdorlik testlari parallel yuklamada beqaror

Claude'ning toza nusxasida to'liq `pnpm verify` ikki test bilan yiqildi:

- `catalog.test.ts` skan/FTS: 56 ms > 50;
- `supplier.test.ts` 100 qatorli kirim: 544 ms > 500.

Alohida ishga tushirilganda ikkalasi ham o'tadi. Sabab: boshqa test fayllari bilan parallel yuklama.

**Talab:**

- Barcha `PERF` testlarini alohida vitest loyihasiga ajrat (`fileParallelism: false`, ketma-ket).
- `pnpm verify` ularni boshqa testlardan keyin, yolg'iz ishga tushirsin.
- Chegaralar (50 ms, 300 ms, 500 ms) **o'zgarmaydi**.

## Bajarish tartibi

1. B1 va B2 ni tuzat. Yangi commit qil, amend qilma.
2. Lokal `pnpm verify` yashil.
3. Push qil.
4. Hisobot: B1 testi va mutatsiya dalili, B2 tuzilmasi. `[gemini-hisobot] T1.9 R1` bilan commit qil va push qil.
5. `node .mezon/kutish.mjs` ni ishga tushir. Merge qilma.
