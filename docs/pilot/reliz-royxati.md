# Guzar Kassa — reliz ro'yxati (pilot)

Pilot do'konga har yangi versiya o'rnatishdan oldin. Har band belgilanmaguncha reliz qilinmaydi.

## A. Kod va tekshiruv

- [ ] `main` ga barcha PR'lar QABUL va yashil CI bilan tushgan (5 job, Desktop Installer ham).
- [ ] Toza klonda `MEZON_REQUIRE_PG_TESTS=1 pnpm verify` yashil.
- [ ] Mutatsiya tekshiruvi: oxirgi relizdan keyingi pul, ombor, sinxron, fiskal va auth o'zgarishlarida tirik mutatsiya yo'q.
- [ ] Migratsiyalar: `db:check` lokal va bulutda 0 farq; yangi migratsiya oldingi versiyadagi haqiqiy bazada sinab ko'rilgan (zaxira nusxadan).

## B. O'rnatish paketi

- [ ] `pnpm --filter @mezon/desktop run pack:win` va `verify:fuses` (smoke launch: Hub ishga tushadi, baza ochiladi).
- [ ] O'rnatuvchi imzolangan (T4.8 dan keyin), versiya raqami oshirilgan.
- [ ] Eski versiya ustiga o'rnatilganda ochiq savat va kechiktirilgan cheklar saqlanadi.

## C. Konfiguratsiya (egasi bilan)

- [ ] Fiskal rejim: pilotda **Fake drayver**, chekda "SINOV — FISKAL EMAS". Haqiqiy fiskal faqat egasining yozma tasdig'i bilan (§F3).
- [ ] Oflayn muddat va bayroqlar: `fiscal_offline_expired_action = warn`, `fiscal_shift_not_open_action = warn` (egasi qarori, 17-noyabr).
- [ ] Imzolangan qoidalar paketi: muddati amalda, imzo kaliti egasida (repoda emas).
- [ ] Bulut: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`, `JWT_SECRET` faqat serverdagi muhitda; repoda yo'qligi tekshirilgan.
- [ ] Telegram webhook `secret_token` bilan ro'yxatdan o'tgan.

## D. Do'konda tekshirish (reliz kuni)

- [ ] Smena ochish, 3 ta savdo (naqd, karta, aralash), nasiya, qaytarish, bekor qilish.
- [ ] Printer: savdo cheki, qaytarish cheki, smena hisoboti, NUSXA.
- [ ] Internetni 10 daqiqa uzib savdo qilish, ulangach kabinetda raqamlar kassa hisobotiga **tiyinigacha** teng.
- [ ] Kabinetda kunlik hisobot = kassadagi kunlik hisobot (tushum, QQS, naqd/naqdsiz, foyda).
- [ ] Egaga Telegram xulosasi keldi; raqamlar kabinet bilan bir xil.
- [ ] Smenani yopish: kutilgan naqd = sanalgan naqd (yoki farq sababi bilan).

## E. Orqaga qaytish rejasi

- [ ] Oldingi o'rnatuvchi va o'rnatishdan oldingi baza zaxirasi saqlangan.
- [ ] Qaytish tartibi: dasturni yopish → zaxirani tiklash → oldingi versiyani o'rnatish → sinxron.
- [ ] Qaytish faqat smena yopilgandan keyin; ochiq smenada reliz qilinmaydi.

## F. Pilot mezonlari (F3 yakuni)

- Pilot do'konda **2 hafta fiskal xatosiz**.
- Har kuni: kabinet va kassa hisobotlari teng, sinxron konfliktlari hal qilingan, nosozliklar kitobiga yangi holatlar yozilgan.
