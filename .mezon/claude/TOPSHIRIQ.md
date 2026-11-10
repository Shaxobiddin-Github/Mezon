# Claude topshirig'i: T1.2 QABUL → T1.3 rejasi

## 1. T1.2 xulosasi: QABUL (kod `facc046`)

Claude tekshirdi:

- `pnpm verify`: 150 test o'tdi, sxema diff 0. Pragma o'zgarishi xavfsiz, `synchronous = FULL` saqlangan.
- **Mustaqil model O1:** 3 ta seed × 120 tasodifiy kirim/chiqim. FIFO va o'rtacha tannarx har chiqimda tiyinigacha model bilan teng. Qayta qurishdan keyin natija o'zgarmadi.
- **O2:** 200 ta amal manfiy qoldiq bilan. Qiymat tenglamasi tiyinigacha saqlandi, qayta qurish natijasi bir xil.
- **O3:** inventarizatsiya S1 stsenariylari to'g'ri (8, 7, sanalmagan 10).
- **O4:** sanoqda 0 qabul qilinadi.
- Katalog qidiruvi modeli o'zgarishlardan keyin ham to'g'ri.
- **Mutatsiya:** 10 tadan 7 tasi ushlandi.

**Test qarzi.** T1.3 PR'ining birinchi alohida commit'i: `T1.2 test qarzi: yaxlitlash va partiyani aniq tugatish`. Har birini mutatsiya bilan isbotla.

1. `computeProportionalCost` da `divideRoundHalfAwayFromZero` oddiy butun bo'lishga (kesish) almashtirilganda testlar yiqilmadi. Sabab: 2-misolda `3333.33` ikkala usulda ham `3333` chiqadi. Yuqoriga yaxlitlanadigan holat qo'sh: `10 000` tiyin / `3 kg` dan `2 kg` chiqim → `6 667`. Domen va ombor darajasida ham bo'lsin.
2. `applyReplayStockMove` da `remBatchMilli >= needMilli` sharti `>` ga almashtirilganda testlar yiqilmadi. Partiya aynan to'liq ishlatilgan holatda qayta qurish `local_stock_conflicts` ga soxta konflikt yozmasligini va qiymatlar o'zgarmasligini tekshiradigan test qo'sh.

## 2. Merge

1. `git pull --ff-only`.
2. PR #9 boshi Claude'ning shu topshiriq commit'i bo'lsin. To'rtala CI job yashil bo'lsin.
3. `T1.2: Ombor, partiya va inventarizatsiya` nomi bilan Squash and merge qil, SHA'ni yoz va branch'ni o'chir.
4. `main`dan `gemini/T1.3-cart-pricing` branch'ini och.

## 3. T1.3 — Savat va narx: avval REJA

Kod yozma. Rejani `.mezon/gemini/HISOBOT.md` ga yoz, `[gemini-reja] T1.3` bilan commit qil va push qil, so'ng `node .mezon/kutish.mjs` bilan kut.

GEMINI.md T1.3:

- savat holati;
- aksiyalar (foiz, summa, N+M, muddat, qamrov);
- savdolashuv chegirmasi (ruxsat va limit);
- tez savdo qatori (katalogda yo'q tovar, nomi saqlanadi).

Mezonlar:

- chegirma qatorlarga aniq taqsimlanadi, jami tiyinigacha teng;
- kassir limitdan oshira olmaydi.

Rejada quyidagilar aniq bo'lsin:

### a) Savat qayerda yashaydi

- Savat hisob-kitobi `packages/domain`da sof funksiya bo'lsin.
- Ochiq savat LOCAL jadvalda saqlansin (sinxronlanmaydi), shunda ilova yiqilsa ham kassirning savati yo'qolmaydi.
- Kechiktirilgan chek (park/resume) shu jadvaldan foydalanadi.
- Savat chek bo'lmaguncha ombor va outbox'ga hech narsa yozilmaydi. Bular T1.4 `completeSale` da bo'ladi.

### b) Narx snapshot'i

- Qator qo'shilganda narx yozib olinadi.
- Savat ochiq turganda katalogdagi narx o'zgarsa nima bo'ladi? Tanlovingni asosla, masalan kassirga ogohlantirish bilan qayta narxlash.

### c) Aksiyalar

- `promotions` jadvali: ATTR. Turi: foiz, summa, N+M. Qamrovi: mahsulot, kategoriya yoki hammasi. Amal qilish oralig'i ms'da: boshlanishi kiradi, tugashi kirmaydi.
- **Kunlik vaqt:** "dushanbadan jumagacha 18:00 gacha" kabi qoidalar keyinroq qo'shiladi. Lekin vaqt mintaqasi siyosatini hozir yoz (Asia/Tashkent, UTC+5, yozgi vaqt yo'q).
- **Ustma-ust qo'llash:** bitta qatorga ko'pi bilan bitta aksiya, xaridor uchun eng foydalisi. Tenglikda deterministik tanlov (masalan `id`). Buyurtma darajasidagi qo'lda chegirma aksiyalardan keyin qo'llanadi. Boshqa variant taklif qilsang, asosla.
- **N+M:** faqat butun birlikli tovarlar uchun (`dona`/`qadoq`). Tekin birliklar soni `floor(qty / (N+M)) × M`. Misollar bilan.
- **Qiymat chegarasi:** chegirma qator summasidan oshmaydi, narx manfiy bo'lmaydi.

### d) Qo'lda chegirma va ruxsat

- Kassir uchun limit: foiz va/yoki summa. Egasi sozlaydi.
- Limitdan oshsa, menejer yoki ega PIN'i bilan tasdiqlanadi. Tasdiqlagan foydalanuvchi savatda yozib qo'yiladi (audit T3.8 da).
- Tekshiruv backendda bo'lsin, UI'da emas.
- **Test:** kassir limitdan oshira olmaydi, to'g'ri PIN bilan menejer tasdig'i ishlaydi, noto'g'ri PIN ishlamaydi. T0.6 dagi PIN blok qoidalari bu yerda ham amal qiladi.

### e) Taqsimlash va yaxlitlash

- Qator summasi `multiply(narx, miqdor)` bilan hisoblanadi.
- Buyurtma darajasidagi chegirma qatorlarga T0.2 `allocate` bilan, qator sof summasiga mutanosib taqsimlanadi.
- QQS keyin har qator bo'yicha hisoblanadi.

**Property test:**

- `Σ qator sof summasi = savat jami`;
- `Σ taqsimlangan chegirma = chegirma`;
- hech bir qator manfiy emas.

### f) Tez savdo qatori

- Erkin nom, narx, miqdor va birlik.
- Fiskal chek uchun MXIK va QQS kerak bo'ladi (F3). Hozirdan tez savdo uchun standart MXIK va QQS sozlamasi joyi ko'rsatilsin, ular nullable bo'lishi mumkin. Tez savdo qatori qanday qilib F3 ga to'sqinlik qilmasligini yoz.

### g) Hub API va RBAC

- Savat endpointlari kassirga ochiq: ochish, skaner yoki ID orqali qator qo'shish, miqdorni o'zgartirish, o'chirish, chegirma, park, resume.
- Aksiya CRUD: `owner`/`manager`.
- Kassir javobida tannarx va foyda yo'q.

### h) Doiradan tashqari

`completeSale`, to'lov va ombordan chiqim (T1.4/T1.5), naqd pulni so'mga yaxlitlash (T1.5), UI (T1.11).
