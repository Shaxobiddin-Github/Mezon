# Kassa dasturi: dizayn va imkoniyatlar bo'yicha ko'rib chiqish (2026-11-21)

Dastur boshidan oxirigacha ishlatib ko'rildi: birinchi sozlash, kirish, smena, sotuv ekrani, mahsulotlar.

## A. Dizayn kamchiliklari

1. **Tepada texnik ma'lumot chiqib turibdi.** U kassir uchun emas, dasturchi uchun: "Hub holati: ready", ichki manzillar, "Qayta ishga tushishlar: 0", "Sozlash kerakmi: false". Bu qism yashirinadi, faqat "Diagnostika" oynasida qoladi.
2. **Sarlavha va menyu oddiy.** Logotip yo'q, barcha tugmalar bir xil kulrang. Muhim tugmalar ham, kam ishlatiladiganlari ham bir qatorga tiqilgan.
3. **Sotuv ekranida mahsulot plitkalari yo'q.** O'ng panelda faqat qidiruv va "Tovar topilmadi" turibdi. Ko'p ishlatiladigan tovarlar katta, bosiladigan plitkalar ko'rinishida bo'lishi kerak.
4. **Savat (chek) qismi bo'sh va zerikarli.** Jami summa yetarlicha ajralib turmaydi. "-0 so'm" kabi ortiqcha minus belgisi chiqadi.
5. **Kirish ekrani.** Rol inglizcha chiqadi: "(owner)". PIN tugmalari sahifaga sig'maydi, pastga aylantirish kerak bo'ladi.
6. **Oynalar (modal) turlicha bezatilgan.** Shrift, tugma va oraliqlar bir xil tizimda emas.
7. **Mahsulot formasida fiskal maydonlar oldinda turibdi.** MXIK, qadoq kodi, QQS v1 da kerak emas, lekin forma boshida joylashgan.

## B. Yetishmayotgan imkoniyatlar

Bularning **backend qismi tayyor**, faqat kassa ekranida yo'q:

1. **Mahsulotga shtrix-kod, artikul (SKU) va kategoriya biriktirish.** Hozir yangi tovarga shtrix-kod qo'shib bo'lmaydi, skaner esa tovarni shtrix-kod bo'yicha qidiradi. Bu eng muhim kamchilik.
2. **Qaytarish (vozvrat).** Sotilgan chekni qaytarish ekrani yo'q.
3. **Cheklar tarixi.** Bugungi va oldingi cheklar ro'yxati, ularni qayta chop etish va qaytarish.
4. **Tovar kirimi (prixod).** Yetkazib beruvchidan kelgan tovarni, soni va tannarxi bilan kiritish. Hozir ombordagi qoldiqni to'ldirib bo'lmaydi.
5. **Ombor qoldig'i.** Qaysi tovardan qancha qolgani, kam qolganlar ro'yxati.
6. **Xodimlar.** Kassir qo'shish, PIN almashtirish, bloklangan xodimni ochish.
7. **Qarz to'lovi.** Mijoz qarzini qisman yoki to'liq qabul qilish.
8. **Hisobotlar ekrani.** Kunlik va oylik savdo, foyda, qarzdorlar.

## C. Bajarish tartibi

| Bosqich | Nima                                                                      |
| ------- | ------------------------------------------------------------------------- |
| C10     | Yangi dizayn: sarlavha, sotuv ekrani, mahsulot plitkalari, kirish, oynalar |
| C11     | Mahsulot formasi: shtrix-kod, artikul, kategoriya, qoldiq sozlamalari      |
| C12     | Cheklar tarixi va qaytarish                                               |
| C13     | Tovar kirimi va ombor qoldig'i                                            |
| C14     | Xodimlar va qarz to'lovi                                                  |
| C15     | Hisobotlar ekrani                                                         |

Har bir bosqich alohida PR sifatida tayyorlanadi: avval testdan va brauzerda tekshiruvdan o'tadi, keyin merge qilinadi.
