# Claude topshirig'i: T1.10 rejasi — TUZATISHLAR BILAN TASDIQLANDI

**Merge tekshiruvi:** T1.9 merge'i tekshirildi. `main` = `a2806d4`, kod `2ecd911` bilan bir xil.

Reja puxta. Quyidagilar tasdiqlandi:

- test qarzi commit'i;
- `orders` (MONOTONE, trigger bilan cheklangan o'tishlar), `order_lines` (FACT);
- narx buyurtmada qotiriladi;
- mijoz ixtiyoriy, qarz bo'lsa majburiy;
- `order_payments` (FACT), avans smena va sessiyaga yoziladi, `advance_cash_in` / `advance_change_out` / `advance_refund_out`;
- avans tushum emas, smena yopilishida alohida ustunlar;
- usul cheklovi bilan qaytarish;
- topshirish umumiy `completeSaleCoreInTxSync` orqali, `'advance'` to'lov usuli `cash_moves` ga qayta tushmaydi, oddiy POS'da taqiqlangan;
- rezerv yo'q;
- qaytarishda avans haqiqiy usullarga yoyiladi;
- RBAC va idempotentlik.

Quyidagi tuzatishlar bilan `gemini/T1.10-orders-advance` branch'ida kodni yoz.

## Majburiy tuzatishlar

### O1. Buyurtma chekini void qilish taqiqlansin, faqat qaytarish

Rejadagi void oqimi murakkab. `orders.status = 'delivered'` qaytmaydi (MONOTONE), lekin pul qaytariladi. Avans boshqa smenada olingan bo'lishi mumkin, shuning uchun "ikki smena 0 ga yopiladi" degan da'vo noto'g'ri: avans smenasi kirimni ko'radi, void smenasi esa chiqimni.

**Qaror:**

- `sales.source_order_id IS NOT NULL` bo'lgan chekni `voidSale` qilish `409 ORDER_SALE_USE_RETURN` bilan rad etiladi.
- Bunday chek faqat `createReturn` orqali, rejadagi usullarga yoyish bilan qaytariladi.
- Test va mutatsiya bilan isbotla.

### O2. Topshirishda qayta narxlash yo'q

Narx buyurtmada qotiriladi. Lekin `completeSaleCoreInTxSync` savatni `evaluateCart` bilan **topshirish paytidagi** aksiyalar bilan qayta baholasa, summa o'zgarib qoladi. Natijada avans va `totalFinal` mos kelmaydi; "ortiqcha avans" holati ham shundan kelib chiqadi.

**Talab:**

- Topshirishda chek qatorlari va summalari (`finalTotal`, aksiya, chegirma, QQS) **buyurtmaning snapshot'idan** olinadi. `totalFinal === order.totalAmount` doimo.
- Yadro funksiya hisoblangan qatorlarni kirish sifatida qabul qilsin. Savat yo'li esa o'z `evaluateCart` ini avvalgidek chaqiradi. Ikki yo'l bitta yozish yadrosidan foydalanadi.
- Shundan keyin `netAdvance <= totalAmount` bo'lgani uchun ortiqcha avans bo'lmaydi. `ORDER_EXCESS_ADVANCE` faqat himoya sifatida qolsin.
- **Test:** buyurtmadan keyin katalog narxi o'zgaradi va aksiya tugaydi. Topshirishda chek summasi buyurtma summasiga aynan teng bo'ladi.

### O3. Buyurtma narxi qanday hisoblanadi

- Buyurtma yaratilganda qatorlar T1.3 `evaluateCart` bilan **bir marta** baholansin: aksiyalar va qo'lda chegirma, T1.3 dagi kassir limiti va supervisor tasdig'i qoidalari bilan.
- Natija `order_lines` ga to'liq snapshot sifatida yozilsin: aksiya, taqsimlangan chegirma, `finalTotal`, QQS.
- Bu O2 dagi snapshot manbai.

### O4. Ochiq avanslar majburiyati

- Ochiq avanslar jami ko'rinsin: `getOpenAdvancesTotal()` (usullar bo'yicha), ya'ni topshirilmagan va bekor qilinmagan buyurtmalardagi sof avans.
- **Model testidagi invariant:** ochiq avanslar = olingan avanslar − qaytarilganlar − topshirishda qo'llanganlar. Har qadamda tekshirilsin.

## Bajarish tartibi (CI limiti tiklanguncha egasining qoidasi bilan)

1. Birinchi commit: T1.9 test qarzi, mutatsiya dalili bilan.
2. T1.10 kodi.
3. Lokal `pnpm verify` yashil.
4. Push qil va PR och. CI ishlamasa, kutma.
5. Hisobot: O1–O4 dalillari, model testi qadamlari soni, 20 qatorli topshirish vaqti, lokal `pnpm verify` chiqishi. `[gemini-hisobot] T1.10` bilan commit qil va push qil.
6. `node .mezon/kutish.mjs` ni ishga tushir. Merge qilma.
