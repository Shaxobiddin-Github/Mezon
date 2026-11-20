# Guzar Kassa v1 — reja (egasi qarori, 2026-11-19)

Egasining so'zi: "To'lov qismlari va hokazolarga v2 versiyada chuqur kiramiz, ya'ni qonun-qoidalarga. Ungacha v1 da ishlaydigan versiya qilaylik, ishimiz juda cho'zilib ketdi."

**Maqsad:** do'konga o'rnatib, har kuni ishlatsa bo'ladigan versiya: kassa, ombor, qarz, bir nechta kassa, bulut kabineti, Telegram, tarif, yangilanish. Qonuniy integratsiyalar (fiskal operator, UzQR, Payme, Click, Uzum, Asl belgisi) **v2** da qilinadi.

## v1 ichida

| Qism | Holat |
|---|---|
| F1 oflayn kassa: savdo, qaytarish, smena, ombor, qarz, printer, zaxira | `main` da |
| F2 sinxron, konfliktlar, tiklash, bulut kabineti (o'qish), Telegram | `main` da |
| T3.1 MXIK/QQS sozlamalari, T3.2 qoidalar dvigateli | `main` da (lokal mantiq, qoladi) |
| T3.8 audit zanjiri | P2 da |
| T4.1–T4.3 LAN ko'p kassa, har kassa o'z smenasi, printeri, yashigi | P3 da |
| T4.6 tillar | `main` da |
| T4.7 tarif va litsenziya, T4.8 imzolangan yangilanish | C2 da |
| T2.7b kabinetdan narx o'zgartirish | C4 da |

## v2 ga o'tadi (v1 da o'chiq yoki yashirin)

| Qism | v1 dagi holati |
|---|---|
| T3.5 haqiqiy fiskal drayver | Fiskal rejim sukut bo'yicha **o'chiq** (`fiscal_mode_enabled = false`). Chek "fiskal emas" bo'lib chiqadi. Rejimni yoqish v1 UI'da ko'rsatilmaydi. |
| T3.6 / T4.5 UzQR, Payme, Click, Uzum drayverlari | POS'da naqdsiz to'lov **qo'lda** yoziladi (karta, Payme, Click, Uzum, boshqa: summa va izoh). **UzQR usuli v1 POS ro'yxatidan olib tashlanadi**, chunki P2 dan keyin u tasdiqlangan QR talab qiladi. To'lov yadrosi kodda qoladi. |
| T3.7 haqiqiy markirovka drayveri | Markirovka talab qilinadigan MXIK ro'yxati **bo'sh**, shuning uchun hech qaysi tovar kod so'ramaydi. Kod qoladi. |
| T4.4 Android/planshet, web-kassa | v2. v1 da ikkinchi kassa = LAN'dagi ikkinchi Windows kompyuter. |
| F5–F9 (Market, kafe, bron, yetkazish, o'sish) | v2 va keyin |

## v1 gacha qolgan ishlar

### ishchi2

1. **Merge navbati** (har biri CI yashil va QABUL bilan): C2 → P2 → P3 (bulut migratsiyasi `0009`) → C4. C4 ham P1 ustida, `main` ni qabul qilaman.
2. **LAN terminal ulanish ekrani.** Desktop POS'da "Ikkinchi kassa sifatida ulanish":
   - hub manzili;
   - kod;
   - barmoq izini ko'rsatish;
   - pin saqlash.

   Hub'da esa "Kassa qo'shish" (kod berish, ro'yxat, bekor qilish). Busiz ko'p kassa amalda ishlamaydi.
3. **v1 bayroqlari:**
   - POS naqdsiz ro'yxatidan `uzqr` olib tashlanadi;
   - fiskal rejim tugmasi va markirovka sozlamasi v1 UI'da ko'rinmaydi;
   - test: v1 rejimida UzQR tanlab bo'lmaydi; savdo naqd, karta va qarz bilan ishlaydi.

### Claude

1. **Kabinet (minimal):**
   - qurilmalar ro'yxati va bekor qilish;
   - xodimlar ro'yxati (o'qish).
2. **Reliz tayyorlash:**
   - versiya `1.0.0`;
   - o'rnatuvchini yig'ish;
   - **dasturni shu kompyuterda ishga tushirib to'liq sinash:** o'rnatish, birinchi sozlash, savdo, smena, zaxira, bulutga ulash, kabinetda ko'rish;
   - reliz eslatmalari va egasi uchun o'rnatish yo'riqnomasi (o'zbekcha).
3. **v1 reliz ro'yxati.** `docs/pilot/reliz-royxati.md` ni v1 ga moslash: fiskal va QR bandlari "v2" ga ko'chadi.

### Egasi (v1 ishga tushishi uchun)

- bulut server va domen (HTTPS);
- Telegram bot tokeni;
- litsenziya va yangilanish imzo kalitlari (yo'riqnoma bor);
- pilot do'kon.

## Taxminiy muddat

Kod: **2–3 kun.** Keyin pilot do'konda sinov.
