# Guzar Kassa — nosozliklar kitobi (pilot)

Har holat uchun: **belgi → sabab → nima qilish → kimga aytish.** Hech bir holatda savdo ma'lumoti yo'qolmaydi: hamma narsa avval kassa bazasiga yoziladi (WAL, `synchronous=FULL`).

## Internet va sinxron

| Belgi                                                    | Sabab                                          | Nima qilish                                                                                                                                                                              |
| -------------------------------------------------------- | ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Kabinetda "X do'kon ma'lumoti to'liq bo'lmasligi mumkin" | Kassa 10 daqiqadan ko'p bulutga ulanmagan      | Kassada internetni tekshiring. Savdo davom etadi. Internet qaytgach ma'lumot o'zi yuboriladi.                                                                                            |
| Kassada sinxron xatosi yoki konflikt                     | Ikki kassa bir yozuvni bir paytda o'zgartirgan | Menejer konfliktlar ro'yxatini ko'radi. Ma'lumotni qo'lda tahrirlamang.                                                                                                                  |
| Internet bir necha kun yo'q                              | —                                              | Savdo to'xtamaydi. Fiskal oflayn muddati yaqinlashsa, ogohlantirish chiqadi (egasi qarori: savdo bloklanmaydi). Internet qaytishi bilan cheklar navbat bilan yuboriladi, kassa qotmaydi. |

## Fiskal

| Belgi                                         | Sabab                                                      | Nima qilish                                                                                                    |
| --------------------------------------------- | ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| "FISKAL KUTILMOQDA"                           | Chek fiskal serverga hali yuborilmagan yoki javob kelmagan | Kutish kifoya. Dastur o'zi qayta urinadi, chek ikki marta fiskallashmaydi.                                     |
| "Fiskallashmagan cheklar" ro'yxatida `failed` | Server aniq rad etmagan, yuborilmagan                      | Menejer "Qayta yuborish"ni bosadi.                                                                             |
| `rejected`                                    | Operator chekni rad etgan                                  | Menejer: chekni qaytarish orqali hal qiladi. Sabab matnini saqlang.                                            |
| Smena fiskal serverda ochilmagan              | Internet yo'q                                              | Savdo ogohlantirish bilan davom etadi (egasi qarori). Internet qaytgach avval smena, keyin cheklar yuboriladi. |
| "FISKAL MA'LUMOT TO'LIQ EMAS"                 | Chek maydonlari konfiguratsiyasida yetishmovchilik         | Texnik yordamga ayting. Bu chek fiskal deb hisoblanmaydi.                                                      |

## Printer

| Belgi                 | Nima qilish                                                                                                      |
| --------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Chek chiqmadi         | Qog'oz, kabel va quvvatni tekshiring. Savdo saqlangan, chekni ro'yxatdan qayta chop eting (NUSXA belgisi bilan). |
| Harflar buzilgan      | Printer sozlamalarida kod sahifasi yoki transliteratsiya rejimini tanlang.                                       |
| Pul yashigi ochilmadi | Yashik kabeli printerga ulanganini tekshiring.                                                                   |

## Kassa dasturi

| Belgi                                             | Sabab                                       | Nima qilish                                                                                            |
| ------------------------------------------------- | ------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Dastur yopilib qayta ochildi                      | Ichki xizmat qayta ishga tushdi             | Ochiq savat saqlanadi. Oxirgi chekni ro'yxatdan tekshiring.                                            |
| "Qoidalar paketi muddati tugagan" yoki "buzilgan" | Imzolangan qonuniy qoidalar paketi eskirgan | Egasi yangi paketni import qiladi. Fiskal rejimda savdo bloklanadi, oddiy rejimda faqat ogohlantirish. |
| PIN qabul qilinmaydi                              | Noto'g'ri PIN yoki bloklangan xodim         | Menejer xodim holatini tekshiradi.                                                                     |

## Zaxira va tiklash

- Kassa har kuni zaxira nusxa oladi (T1.13). Disk buzilsa, texnik yordam oxirgi zaxiradan tiklaydi va bulutdan sinxron qiladi.
- **Bazani o'zingiz nusxalamang yoki o'chirmang.** Dastur ishlab turganda nusxalangan baza buzilgan bo'lishi mumkin.

## Telegram

| Belgi                       | Nima qilish                                                                                               |
| --------------------------- | --------------------------------------------------------------------------------------------------------- |
| Egaga kunlik xulosa kelmadi | Kabinetda "Telegram ulangan" holatini tekshiring. Botni bloklagan bo'lsangiz, havola bilan qayta ulaning. |
| Mijoz eslatmani olmayapti   | Mijoz rozilik bermagan yoki /stop yozgan. Bu mijozning huquqi.                                            |

## Kimga aytish

1. Kassir — menejerga.
2. Menejer — texnik yordamga (pilot muddatida loyiha jamoasi).
3. Fiskal xato yoki pul farqi — **o'sha kuni** egasiga.
