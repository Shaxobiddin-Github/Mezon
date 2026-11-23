# v2 — egadan kerak bo'ladigan ishlar (2026-11-22)

Bularsiz ham hamma narsa **sinov (demo) rejimida** ishlaydi:
- kassa: Sozlamalar → Ulanishlar holati → «Sinov rejimini yoqish»;
- kabinet: «Onlayn do'kon» bo'limi.

Quyidagilar kelgach, sinov drayveri haqiqiysiga almashtiriladi. Kod shu joylarga tayyor: port/interfeys yozilgan, faqat provayderning rasmiy hujjati bo'yicha drayver qo'shiladi.

| # | Nima kerak | Kimdan | Nima uchun | Qanchalik shoshilinch |
|---|---|---|---|---|
| 1 | **Fiskal modul / virtual kassa provayderi**: shartnoma + API hujjati + sinov (sandbox) kaliti | Tanlangan provayder (masalan, virtual kassa operatori) | Rasmiy fiskal chek. Usiz Guzar faqat ichki hisob uchun ishlaydi | Eng muhim |
| 2 | **UzQR / to'lov provayderi**: shartnoma + API kalitlari (sandbox va prod) | Bank yoki to'lov provayderi | QR to'lovni avtomatik tasdiqlash | Muhim (1-iyuldan majburiy) |
| 3 | **Asl Belgisi**: tashkilot kabineti + API ruxsati | CRPT Turon / Asl Belgisi | Markirovka kodini haqiqiy tekshirish, sotuvni operatorga bildirish | Markirovkali tovar sotilsa |
| 4 | **Soliq qo'mitasining naqdsiz MXIK ro'yxati** (fayl yoki havola) | Soliq qo'mitasi | Qaysi tovar faqat naqdsiz sotilishini kassa bilsin | Muhim |
| 5 | **Qoidalar paketi imzo kaliti**: `node scripts/rules-sign.mjs keygen --out <repo tashqarisidagi papka>` → ochiq kalit + `keyId` (buni birga qilamiz) | O'zingiz (kalit kompyuteringizda qoladi) | Rasmiy qoidalar paketini imzolash | 4-band bilan birga |
| 6 | **Telegram bot tokeni** (@BotFather) | O'zingiz | Kunlik hisobot, nasiya eslatmasi, yangi onlayn buyurtma xabari | Tez (5 daqiqa) |
| 7 | **Server yangilash**: PR #42 → … → #48 merge, keyin server agentiga «yangilang» deyish | O'zingiz + server agenti | Kabinet dizayni va onlayn do'kon `guzar.shaxalab.uz`da chiqishi uchun | Merge'dan keyin |

## Muhim

- Hech qanday token, parol yoki kalitni chatga yoki repoga yozmang (repo ochiq). Ularni faqat serverdagi `.env` ga server agenti orqali qo'yamiz.
- Provayder tanlashda ham hujjat, ham sandbox kalit so'rang. Hujjatsiz API'ni taxmin qilib yozmaymiz.
