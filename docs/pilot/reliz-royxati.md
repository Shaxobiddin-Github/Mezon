# Guzar Kassa — reliz ro'yxati (v1)

Pilot do'konga har yangi versiya o'rnatishdan oldin. Har band belgilanmaguncha reliz qilinmaydi.

**v1 doirasi (egasi qarori, 2026-11-19):** fiskal chek, UzQR/Payme/Click/Uzum bilan avtomatik ulanish va markirovka v2 ga qoldi. v1 da chek "FISKAL EMAS", naqdsiz to'lov qo'lda yoziladi. To'liq ro'yxat: [../v1/README.md](../v1/README.md).

## A. Kod va tekshiruv

- [ ] `main` ga barcha PR'lar QABUL va yashil CI bilan tushgan (Desktop Installer va Deploy images job'lari ham).
- [ ] Toza klonda `MEZON_REQUIRE_PG_TESTS=1 pnpm verify` yashil.
- [ ] Mutatsiya tekshiruvi: oxirgi relizdan keyingi pul, ombor, sinxron, fiskal va auth o'zgarishlarida tirik mutatsiya yo'q.
- [ ] Migratsiyalar: `db:check` lokal va bulutda 0 farq; yangi migratsiya oldingi versiyadagi haqiqiy bazada sinab ko'rilgan (zaxira nusxadan).

## B. O'rnatish paketi

- [ ] `pnpm --filter @mezon/desktop run pack:win` va `verify:fuses` (smoke launch: Hub ishga tushadi, baza ochiladi).
- [ ] Versiya raqami oshirilgan (`apps/desktop/package.json` va `apps/hub/src/version.ts` bir xil; test tekshiradi). O'rnatuvchi nomi `Guzar-Setup-<versiya>-x64.exe`.
- [ ] Yangilanish kaliti egasida yaratilgan va `PRODUCTION_TRUSTED_UPDATE_KEYS` ga qo'shilgan, aks holda avtomatik yangilanish o'chiq qoladi (v1 da birinchi o'rnatish qo'lda).
- [ ] **Qayta ishga tushirish sinovi:** kassani bulutga va ikkinchi kassani LAN orqali ulab, ikkala dasturni yopib-ochish. Bulut sinxroni va ikkinchi kassa ishlashda davom etadi (maxfiy kalit `hub-data-key.json` saqlanadi).
- [ ] Eski versiya ustiga o'rnatilganda ochiq savat va kechiktirilgan cheklar saqlanadi.

## C. Konfiguratsiya (egasi bilan)

- [ ] Fiskal rejim **o'chiq**: chekda va ekranda "FISKAL EMAS", "Fiskallashmagan cheklar" tugmasi ko'rinmaydi. Haqiqiy fiskal v2 da, egasining yozma tasdig'i bilan.
- [ ] To'lov usullari ro'yxatida UzQR yo'q; karta, Payme, Click, Uzum qo'lda yoziladi.
- [ ] Imzolangan qoidalar paketi (bo'lsa): muddati amalda, imzo kaliti egasida (repoda emas).
- [ ] Tarif litsenziyasi (`scripts/licence-sign.mjs`) yoki 14 kunlik sinov; kalit faqat egada.
- [ ] Bulut: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`, `JWT_SECRET` faqat serverdagi muhitda; repoda yo'qligi tekshirilgan.
- [ ] Telegram webhook `secret_token` bilan ro'yxatdan o'tgan.

## D. Do'konda tekshirish (reliz kuni)

- [ ] Smena ochish, 3 ta savdo (naqd, karta, aralash), nasiya, qaytarish, bekor qilish.
- [ ] Bulutga ulash: kabinetda kod → kassada "Ulanishlar" → "Bulutga ulash". Kabinetda kassa ko'rinadi, versiyasi to'g'ri.
- [ ] Ikkinchi kassa (bo'lsa): asosiy kassada "Kassa qo'shish" → ikkinchi kompyuterda "Ikkinchi kassa sifatida ulanish". Barmoq izlari bir xil; ikkinchi kassada o'z smenasi, savdo va chek; asosiy kassada "Kassa 2" savdosi ko'rinadi. Windows ruxsat so'rasa, xususiy tarmoqqa ruxsat beriladi.
- [ ] Printer: savdo cheki, qaytarish cheki, smena hisoboti, NUSXA.
- [ ] Internetni 10 daqiqa uzib savdo qilish, ulangach kabinetda raqamlar kassa hisobotiga **tiyinigacha** teng.
- [ ] Kabinetda kunlik hisobot = kassadagi kunlik hisobot (tushum, QQS, naqd/naqdsiz, foyda).
- [ ] Egaga Telegram xulosasi keldi; raqamlar kabinet bilan bir xil.
- [ ] Smenani yopish: kutilgan naqd = sanalgan naqd (yoki farq sababi bilan).

## E. Orqaga qaytish rejasi

- [ ] Oldingi o'rnatuvchi va o'rnatishdan oldingi baza zaxirasi saqlangan.
- [ ] Qaytish tartibi: dasturni yopish → zaxirani tiklash → oldingi versiyani o'rnatish → sinxron.
- [ ] Qaytish faqat smena yopilgandan keyin; ochiq smenada reliz qilinmaydi.
- [ ] Avtomatik yangilanish faqat **oldinga** ishlaydi (eski manifest rad etiladi): qaytishda oldingi o'rnatuvchi qo'lda o'rnatiladi.
- [ ] Birinchi imzolangan yangilanish pilot kompyuterida qo'lda sinaldi: "Hozir" (ochiq chek bilan kutadi, chek yopilgach o'rnatadi), dastur o'zi qayta ochildi, "Yangilanishdan oldin" zaxirasi bor ([yo'riqnoma](yangilash-va-tiklash.md)).

## F. Pilot mezonlari (v1)

- Pilot do'konda **2 hafta** ma'lumot yo'qotishsiz va sinxron farqisiz (v1 da fiskal yo'q).
- Har kuni: kabinet va kassa hisobotlari teng, sinxron konfliktlari hal qilingan, nosozliklar kitobiga yangi holatlar yozilgan.
