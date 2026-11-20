# Yangilash va kassani tiklash yo'riqnomasi (T4.8)

Bu hujjat ikki narsani tushuntiradi:

1. Kassa dasturi qanday yangilanadi: kassir nimani ko'radi, ega nima qiladi.
2. Kassa kompyuteri buzilsa yoki almashtirilsa, ma'lumotlar qanday tiklanadi.

## 1. Kassir uchun: yangilanish

Yangi versiya chiqsa, dastur uni o'zi yuklab oladi va tekshiradi. Savdo ekranining yuqorisida xabar chiqadi:

> Yangi versiya 1.3.0 yuklab olindi. Qachon o'rnatilsin?
> [Hozir] [Smena yopilganda] [Soat 22:00 da]

| Tugma                | Nima bo'ladi                                                                      |
| -------------------- | --------------------------------------------------------------------------------- |
| **Hozir**            | Ochiq chek bo'lmasa, darhol o'rnatiladi. Chek ochiq bo'lsa, u yopilishi kutiladi. |
| **Smena yopilganda** | Barcha smenalar yopilgandan keyin o'rnatiladi.                                    |
| **Soat 22:00 da**    | Bugun 22:00 da o'rnatiladi; agar 22:00 o'tgan bo'lsa, ertaga 22:00 da.            |

Muhim qoidalar:

- **Ochiq chek hech qachon buzilmaydi.** Chekda kamida bitta mahsulot bo'lsa, yangilanish kutadi. Xabar shunday bo'ladi: "ochiq chek yopilishi kutilmoqda".
- Kechiktirilgan (park qilingan) cheklar bazada saqlanadi. Yangilanishdan keyin ham joyida qoladi.
- O'rnatishdan oldin dastur bazaning zaxira nusxasini avtomatik oladi ("Yangilanishdan oldin" degan izoh bilan).
- O'rnatish bir necha daqiqa davom etadi, keyin dastur o'zi qayta ochiladi.
- Yuborilmagan fiskal cheklar yo'qolmaydi: navbat bazada saqlanadi va qayta ochilgandan keyin davom etadi.
- Tanlovni "Bekor qilish" tugmasi bilan o'zgartirish mumkin.

## 2. Ega uchun: yangi versiyani chiqarish

Yangilanish faqat **egasining imzosi** bo'lsa qabul qilinadi. Imzo bo'lmasa yoki fayl o'zgartirilgan bo'lsa, kassa uni o'rnatmaydi.

### Bir martalik sozlash

1. Kalit juftini **repodan tashqarida** yarating (masalan, shifrlangan fleshkada):

   ```
   node scripts/update-sign.mjs keygen --out D:\mezon-kalitlar
   ```

   - `update-signing.key` — maxfiy kalit. Hech kimga bermang, repoga qo'shmang.
   - `update-signing.pub.b64` — ochiq kalit.

2. Ochiq kalitni va kalit nomini (`keyId`, masalan `ega-2026`) dasturchiga bering. U ularni `apps/desktop/src/update/update-manifest.ts` dagi `PRODUCTION_TRUSTED_UPDATE_KEYS` ga yozadi.
3. Yangilanishlar turadigan HTTPS manzilni tanlang. U `DEFAULT_UPDATE_MANIFEST_URL` ga yoziladi (masalan, `https://.../mezon/update.json`).

Bu ikki qiymat yozilmaguncha avtomatik yangilanish **o'chiq** turadi.

### Har bir versiyada

1. O'rnatuvchini yig'ing (`pnpm --filter @mezon/desktop pack:win`). `package.json` dagi versiya oldingisidan katta bo'lishi kerak.
2. O'rnatuvchini imzolang:

   ```
   node scripts/update-sign.mjs sign --key D:\mezon-kalitlar\update-signing.key --key-id ega-2026 ^
     --installer Guzar-Setup-1.3.0.exe --version 1.3.0 ^
     --url https://.../mezon/Guzar-Setup-1.3.0.exe --notes "Tuzatishlar" --out update.json
   ```

3. Imzoni tekshiring:

   ```
   node scripts/update-sign.mjs verify --pub D:\mezon-kalitlar\update-signing.pub.b64 --current 1.2.0 --in update.json
   ```

4. Avval `Guzar-Setup-1.3.0.exe` ni, keyin `update.json` ni HTTPS manzilga yuklang. Tartib muhim: manifest faylidan oldin chiqmasligi kerak.
5. Kassalar har 6 soatda manifestni tekshiradi va yangi versiyani yuklab oladi.

### Himoya nimadan iborat

| Xavf                                                     | Himoya                                                                                    |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Serverdagi fayl almashtirildi                            | Manifestda faylning SHA-256 va hajmi imzolangan. Mos kelmasa, yuklangan fayl o'chiriladi. |
| Manifest o'zgartirildi                                   | Imzo tekshiruvi rad etadi.                                                                |
| Eski versiyaga qaytarish (eski manifest qayta yuborildi) | Faqat joriydan **katta** versiya qabul qilinadi.                                          |
| Yuklab olingandan keyin diskdagi fayl almashtirildi      | O'rnatishdan oldin xesh qayta tekshiriladi. Mos kelmasa, fayl o'chiriladi.                |
| `update-state.json` qo'lda tahrirlandi                   | Dastur har ishga tushganda imzoni qayta tekshiradi. Buzilgan holat o'chiriladi.           |
| Boshqa platforma yoki kanal                              | Rad etiladi.                                                                              |

**Tekshirilmagan qism.** Haqiqiy NSIS o'rnatuvchini jim rejimda (`--updated /S --force-run`) ishga tushirish avtomatik testda tekshirilmagan: testlarda o'rnatuvchi soxta (Fake). Birinchi imzolangan versiyani pilot kompyuterida qo'lda sinash kerak. Bu [reliz ro'yxati](reliz-royxati.md)da bor.

## 3. Kassani tiklash (hub)

Kassa ma'lumotlari Windows'da `%LOCALAPPDATA%\Mezon` papkasida turadi:

| Papka           | Ichida                                            |
| --------------- | ------------------------------------------------- |
| `data\mezon.db` | baza                                              |
| `data\backups\` | zaxira nusxalar va ularning `.meta.json` fayllari |
| `logs\`         | jurnallar                                         |

### A. Dastur buzildi, baza joyida

O'rnatuvchini qayta ishga tushiring. Baza va zaxiralar `%LOCALAPPDATA%\Mezon` da qoladi, chunki o'rnatuvchi ularga tegmaydi.

### B. Baza buzildi yoki noto'g'ri o'zgardi

1. Ega kassaga kiradi. Texnik yordam zaxiralar ro'yxatidan (`GET /backups`) kerakli nusxani tanlaydi. Odatda bu oxirgi yoki "Yangilanishdan oldin" degan nusxa bo'ladi.
2. `POST /backups/<id>/restore` bilan tiklash rejalashtiriladi. Bu amal faqat egaga ruxsat etilgan.
3. Dastur qayta ochiladi. Tiklash ishga tushishda bajariladi, keyin proyeksiyalar qayta quriladi va tekshiriladi.
4. Bulut ulangan bo'lsa, kassa zaxiradan keyingi hodisalarni bulutdan avtomatik oladi.

### C. Kompyuter almashtirildi

1. Yangi kompyuterga dasturni o'rnating, **lekin hali ochmang**.
2. Eski kompyuterdagi `%LOCALAPPDATA%\Mezon\data` papkasini to'liq ko'chiring: `mezon.db` va `backups\`. Eski kompyuter ishlamasa, zaxira nusxasidan foydalaning.
3. Dasturni oching.

Natija:

- Kassa o'sha qurilma bo'lib qoladi: `device_id` bazada saqlanadi.
- Yuborilgan, lekin tasdiqlanmagan fiskal cheklar tasdiqlashda davom etadi.
- Bulutdan zaxiradan keyingi hodisalar keladi.

### Bilish kerak bo'lgan cheklovlar

- **Zaxiradan keyin yaratilib, bulutga yuborilmagan cheklar yo'qoladi.** Bu zaxira nusxaning tabiati. Shuning uchun yangilanishdan oldin avtomatik zaxira olinadi, kundalik zaxira ham bor.
- Zaxira olingandan keyin qurilma bulutdan **qayta ulangan** bo'lsa, tiklangan kassaning tokeni eskirgan bo'ladi. Bulut 401 qaytaradi. Bunda kassani bulutga qayta ulash kerak: ega kabinetdan yangi ulanish kodi beradi.
- Litsenziya kassada keshda saqlanadi. Tiklangandan keyin u bulutdan avtomatik yangilanadi.
