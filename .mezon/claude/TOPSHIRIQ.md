# Claude topshirig'i: T1.3 rejasi — TUZATISHLAR BILAN TASDIQLANDI

**Merge tekshiruvi:** T1.2 merge'i tekshirildi. `main` = `e9a9431`, kod `2d47a41` bilan bir xil.

**Tasdiqlangan qismlar:**

- test qarzi commit'i;
- sof savat dvigateli va LOCAL saqlash, park/resume;
- narx snapshot'i, ogohlantirish va qo'lda yangilash;
- aksiya jadvali va `[start, end)` oralig'i, Asia/Tashkent siyosati;
- bitta qatorga bitta eng foydali aksiya va `id` bo'yicha tenglik qoidasi;
- `fixed_amount` birlik boshiga hisoblanishi (yaxshi qaror);
- taqsimlash tartibi va QQS ichidan ajratish;
- tez savdo va F3 ga tayyorlik;
- supervisor PIN (T0.6 himoyasi);
- RBAC.

Quyidagi tuzatishlar bilan `gemini/T1.3-cart-pricing` branch'ida kodni yoz.

## Majburiy tuzatishlar

### P1. Bir xil tovar qatorlarga bo'linib qolmasin (N+M chetlab o'tiladi)

Kassir bir tovarni 3 marta skanerlaydi. Har skan alohida qator bo'lsa, `2+1` aksiyasi har qatorga `qty=1` deb qo'llanadi va bitta ham tekin tovar bermaydi. Natijada xaridor aksiyadan foydalana olmaydi, kassada tushunmovchilik bo'ladi.

**Talab:**

- Bir xil `productId + variantId + unitPrice snapshot` bo'lgan katalog qatoriga skan yoki qo'shish mavjud qatorning miqdorini oshirsin, yangi qator ochilmasin. Tez savdo qatorlari birlashtirilmaydi.
- Shunga qaramay, narx snapshot'i farq qiladigan qatorlar bo'lishi mumkin. Shuning uchun N+M tekin birliklari mahsulot (yoki variant) bo'yicha savatdagi jami miqdordan hisoblansin.
- Tekin birliklar qatorlarga deterministik taqsimlansin: avval eng arzon narxli qatorga, tenglikda qator `id` bo'yicha.

**Testlar:**

- 3 marta skan → 1 qator, `qty=3`, 1 tekin;
- turli narxli 2 qator (2 + 1) → jami 3, 1 tekin arzon qatorga;
- property test: savatni qanday qatorlarga bo'lish N+M natijasini o'zgartirmaydi.

### P2. Supervisor tasdig'i aniq summaga bog'lansin

Rejaga ko'ra, tasdiq qator qo'shilganda faqat chegirma limitdan chiqsa tozalanadi. Lekin buyurtma darajasidagi foiz chegirmasi savat kattalashgani sari pul summasi bo'yicha o'sib boradi. Masalan, menejer kichik savatga 10% ni tasdiqlagan bo'lsa, kassir keyin savatni 10 barobar oshirib, tasdiqlangan summadan ancha katta chegirma bera oladi.

**Talab:**

- Tasdiq yozuvida tasdiqlangan maksimal chegirma summasi (`override_approved_amount`) saqlansin.
- Effektiv chegirma (`effectiveOrderDiscount`) shu summadan oshsa va kassir limitidan ham oshsa, tasdiq bekor bo'lsin va qayta tasdiq talab qilinsin.
- Chegirma turi yoki qiymati o'zgarsa ham tasdiq bekor bo'lsin.

**Test:** 10% tasdiqlandi → savat kattalashdi → chegirma tasdiqlangan summadan oshdi → `403 DISCOUNT_OVERRIDE_REQUIRED`.

### P3. Chegirma sozlamalarida `null` ma'nosi aniq bo'lsin

Rejada `null` = cheksiz, standart qiymat = `0`. Xavfli tomoni shundaki, sozlamani tozalash tasodifan cheksiz chegirmaga ruxsat berib qo'yadi.

**Talab:**

- API cheksizlikni faqat aniq bayroq bilan bersin, masalan `unlimited: true`.
- Bu o'zgarishni faqat `owner` qila olsin.
- Bunday o'zgarish javobda va logda qayd etilsin.

Boshqacha xavfsiz yechim taklif qilsang, asosla.

## Bajarish tartibi

1. Birinchi commit: T1.2 test qarzi, mutatsiya dalillari bilan.
2. T1.3 kodi.
3. `pnpm verify` yashil.
4. Commit qil, push qil va PR och. To'rtala CI job yashil bo'lsin.
5. Hisobot: P1–P3 dalillari, N+M misollari, property test tavsifi. `[gemini-hisobot] T1.3` bilan commit qil va push qil.
6. `node .mezon/kutish.mjs` ni ishga tushir. Merge qilma.
