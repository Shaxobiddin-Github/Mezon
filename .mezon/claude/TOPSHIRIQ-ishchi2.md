# Nazoratchi topshirig'i (ishchi2): T3.1 — MXIK va soliq sozlamalari, REJA

Xush kelibsan. Avval `GEMINI.md` ni (ayniqsa 3, 4, 5 va 10-bo'limlarni), `.mezon/ALOQA.md` ni va `.mezon/ISHCHI2.md` ni to'liq o'qi.

Branch: `ishchi2/T3.1-mxik` (`main` = `12072ea` dan ochilgan). Hozir **faqat reja** yoz, kod yozma.

## Vazifa (GEMINI.md 10-bo'lim, T3.1)

Mahsulot formasi, Excel, tashkilot STIR, manzil va QQS holati, MXIK'siz mahsulotlar ro'yxati.

**Mezonlar:**
- chek snapshot'i keyingi tahrirdan ta'sirlanmaydi;
- QQS yaxlitlash testlari.

## Hozirgi holat (nazoratchi tekshirdi)

- `products` jadvalida `mxik`, `package_code` va `vat_rate_bp` ustunlari bor. Contracts'da `MxikSchema`, `PackageCodeSchema` va `VatRateBpSchema` bor.
- Savatcha qatori, sotuv qatori, qaytarish va buyurtmada snapshot maydonlari bor.
- `local_hub_config` da `quick_sale_default_mxik` va `quick_sale_default_vat_rate_bp` bor.
- `apps/hub/src/excel-port.ts` va `catalog-import-routes.ts` da katalog Excel import va eksporti bor.
- POS yoki admin UI'da MXIK maydoni yo'q. Tashkilotning soliq rekvizitlari (STIR, yuridik nom, manzil, QQS to'lovchisi yoki yo'qligi) lokal bazada yo'q.

## Rejada bo'lishi kerak

1. **Tashkilot soliq sozlamalari.** Qaysi jadvalga yoziladi (yangi jadval yoki mavjud config), sinxron sinfi va tenant doirasi qanday. Maydonlar: STIR (9 raqam), yuridik nom, manzil, QQS to'lovchisi bayrog'i va standart stavka. API: kim o'qiydi va kim o'zgartiradi (RBAC). Faqat egasi yoki menejer o'zgartiradi.
2. **QQS to'lovchisi bo'lmagan tashkilot** uchun chek va hisobotdagi QQS qanday bo'ladi. Qaror `GEMINI.md` dagi QQS modeliga mos bo'lsin. Taxmin qilma, mos joyiga havola ber.
3. **Mahsulot formasi** (POS katalog yoki admin): MXIK, qadoq kodi, QQS stavkasi. Validatsiya mavjud contracts sxemalari orqali bo'ladi, takror kod yozilmaydi.
4. **Excel:** import va eksportga MXIK, qadoq kodi va QQS ustunlari. Noto'g'ri MXIK qator darajasidagi xato bo'lib, butun importni yiqitmasin.
5. **MXIK'siz mahsulotlar ro'yxati:** endpoint, filtr va UI. Fiskal rejim yoqilganda nima bo'lishi T3.2 ga qoladi, faqat ogohlantirishni ko'rsat.
6. **Snapshot mezoni:** chekdan keyin mahsulotning MXIK, QQS va nomi o'zgartiriladi. Sotuv, qaytarish va chek qayta chiqarishda eski qiymat qoladi. Hisobotlar ham snapshot'dan o'qiydi. Qaysi yo'llar tekshiriladi, ro'yxat qil.
7. **QQS yaxlitlash testlari:** chegara qiymatlari, ko'p qatorli chek, chegirma bilan, 0%/12% stavkalar. Property testi bo'lsin.
8. **Migratsiya va sxema registri:** yangi ustunlar va jadvallar ro'yxati, sinxron sinfi. `.mezon/ISHCHI2.md` dagi migratsiya raqami qoidasiga e'tibor ber: Gemini T2.3 da `0015_sync_conflicts` qo'shyapti.
9. **Test rejasi va mutatsiya** qilinadigan joylar (snapshot o'qish, RBAC, STIR validatsiyasi).
10. **i18n:** barcha yangi matnlar `i18n` orqali bo'lsin.

## Bajarish tartibi

1. Rejani `.mezon/ishchi2/HISOBOT.md` ga yoz, `[ishchi2-reja] T3.1` bilan commit qil va push qil.
2. `node .mezon/kutish.mjs 120 .mezon/claude/TOPSHIRIQ-ishchi2.md` ni ishga tushir va tasdiqni kut.
