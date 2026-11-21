# Guzar Kassa v1 — o'rnatish yo'riqnomasi va reliz eslatmalari

Bu hujjat egasi va texnik yordam uchun. Kassir uchun yo'riqnoma: [../pilot/kassir-yoriqnomasi.md](../pilot/kassir-yoriqnomasi.md).

## 1. v1 da nima bor

| Bo'lim              | Imkoniyat                                                                                                                                 |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Kassa               | Savdo, skaner, chegirma, kechiktirilgan chek, qaytarish, bekor qilish, smena va naqd pul hisobi, chek printeri va pul yashigi             |
| Ombor               | Qoldiq, kirim, partiya va muddat, inventarizatsiya, kam qolgan tovar                                                                      |
| Mijoz va qarz       | Nasiya, to'lov, qarz daftari, ortiqcha to'lov                                                                                             |
| Internetsiz ishlash | Internet bo'lmasa ham kassa to'liq ishlaydi; internet qaytganda ma'lumotlar o'zi sinxronlanadi                                            |
| Bir nechta kassa    | Bir do'konda bir nechta kompyuter (LAN); har kassaning o'z smenasi, printeri va yashigi bor                                               |
| Bulut kabineti      | Telefondan: bugungi savdo, cheklar, mijozlar, kunlik hisobot, mahsulotlar va narxni o'zgartirish, kassalar va xodimlar, yangi kassa ulash |
| Telegram            | Egaga kunlik xulosa; mijozga qarz eslatmasi (mijoz rozilik bergandan keyin)                                                               |
| Tarif               | Start, Business, Pro; 14 kun bepul sinov. Muddat tugasa ham savdo to'xtamaydi, faqat yangi kassa yoki do'kon qo'shib bo'lmaydi            |
| Yangilanish         | Imzolangan avtomatik yangilanish. Kassir vaqtini tanlaydi; ochiq chek hech qachon buzilmaydi                                              |
| Zaxira              | Har kuni avtomatik; yangilanishdan oldin ham olinadi                                                                                      |
| Tillar              | O'zbek (lotin, kirill), rus                                                                                                               |

## 2. v2 ga qoladiganlar

> **Muhim (egasi qarori, 2026-11-20):** v1 do'konda **faqat ichki hisob uchun** ishlatiladi: savdo, ombor, qarz, smena, hisobot. Xaridorga **rasmiy (fiskal) chek do'konning hozirgi onlayn-kassasida** beriladi. Guzar Kassa chiqaradigan "FISKAL EMAS" cheki rasmiy chek o'rnini bosmaydi. Fiskal chek v2 da qo'shiladi.

Egasining qarori: qonuniy integratsiyalar v2 da qilinadi. Har bir kassaga alohida fiskal modul kerakmi, degan savol ham v2 ga qoldi: fiskal operator hujjatlari bilan birga aniqlanadi.

| Imkoniyat                                        | v1 dagi holati                                            |
| ------------------------------------------------ | --------------------------------------------------------- |
| Fiskal chek (soliq operatori)                    | Chek "FISKAL EMAS" deb chiqadi                            |
| UzQR, Payme, Click, Uzum bilan avtomatik ulanish | Naqdsiz to'lov kassada qo'lda yoziladi: usul, summa, izoh |
| Markirovka (Asl belgisi)                         | O'chiq                                                    |
| Android, planshet va web-kassa                   | Yo'q; ikkinchi kassa Windows kompyuter bo'ladi            |
| Guzar Market, kafe, bron, yetkazib berish        | Keyingi bosqichlar                                        |

## 3. Bulut serverini o'rnatish (bir marta, texnik yordam)

**Talablar:** Linux server, Docker, domen (masalan, `api.guzar.uz`) va unga yo'naltirilgan DNS.

1. Reponi serverga to'liq klon qiling (`git clone`). Faqat `deploy/` papkasi yetmaydi: image'lar butun repodan yig'iladi.
2. `deploy/.env` faylini yarating. Qiymatlarni o'zingiz o'ylab toping: uzun va tasodifiy bo'lsin. Bu fayl repoga **hech qachon** qo'shilmaydi.

   ```
   MEZON_POSTGRES_ADMIN_PASSWORD=...
   MEZON_APP_DB_PASSWORD=...
   JWT_SECRET=...              # kamida 32 belgi
   CLOUD_DOMAIN=api.guzar.uz   # kabinet ham shu manzilda ochiladi
   ACME_EMAIL=...
   TELEGRAM_BOT_TOKEN=...      # @BotFather dan; kerak bo'lmasa, bo'sh qoldiring
   TELEGRAM_WEBHOOK_SECRET=... # bot ishlatilsa
   TELEGRAM_BOT_USERNAME=...   # bot ishlatilsa
   ```

3. Ishga tushiring:

   ```
   docker compose up -d
   ```

   Caddy HTTPS sertifikatni o'zi oladi. Kabinet `https://<CLOUD_DOMAIN>` da ochiladi, kassalar ham shu manzilga ulanadi.

   **Server NAT ortida bo'lsa (ochiq IP yoki 80/443 port yo'q): Cloudflare Tunnel.** Domen Cloudflare'da bo'lishi kerak.

   - Cloudflare → Zero Trust → Networks → Tunnels → **Create a tunnel** (Cloudflared). Tunnel tokenini oling.
   - Tunnelga **Public hostname** qo'shing: `CLOUD_DOMAIN` (masalan, `guzar.misol.uz`), Service: `HTTP`, URL: `caddy:80`.
   - `deploy/.env` ga qo'shing: `CLOUDFLARE_TUNNEL_TOKEN=...` (token faqat shu faylda turadi). `ACME_EMAIL` baribir to'ldiriladi, lekin ishlatilmaydi.
   - Docker Compose v2.24 yoki yangisi kerak. Ishga tushirish:

     ```
     docker compose -f docker-compose.yml -f docker-compose.tunnel.yml up -d --build
     ```

   Bu variantda serverda hech qanday port ochilmaydi. HTTPS sertifikatni Cloudflare beradi. Keyingi `docker compose exec ...` buyruqlarida ham ikkala `-f` ni yozing.

4. Birinchi tashkilot va ega akkauntini yarating. **Parol majburiy**, standart parol yo'q. Buyruq `migrate` konteynerida ishlaydi, chunki bazaning admin ulanishi faqat unda bor. Parol ekranda ko'rinmaydi va terminal tarixida qolmaydi:

   ```
   read -rsp "Parol (kamida 10 belgi): " P; echo
   docker compose run --rm migrate node /app/apps/cloud/dist/cli/create-org.js \
     --org-name "Do'kon nomi" --store-name "Bosh do'kon" --store-code main \
     --login ega@misol.uz --password "$P"
   unset P
   ```

5. Zaxira: [../../deploy/BACKUP-RESTORE.md](../../deploy/BACKUP-RESTORE.md) dagi cron qatorini qo'shing.
6. Tarif litsenziyasi: `scripts/licence-sign.mjs` (kalit faqat egada). Litsenziya bo'lmasa, 14 kunlik sinov ishlaydi.

## 4. Kassani o'rnatish (har bir do'kon)

1. `Guzar-Setup-1.0.0-x64.exe` ni kassa kompyuterida ishga tushiring.
2. **Birinchi ochilish:** ega ismi, login va 6 xonali PIN kiritiladi. Bu kassaning birinchi egasi bo'ladi.
3. **Bulutga ulash:**
   1. Kabinetga kiring: "Kassalar va xodimlar" → "Yangi kassa ulash" → do'konni tanlang → "Ulanish kodini olish".
   2. Kassada (ega bo'lib kiring): yuqoridagi "Ulanishlar" → "Bulut kabineti" → bulut manzili (`https://api.guzar.uz`) va kod → "Bulutga ulash".

   Kod bir marta ishlatiladi va qisqa muddat amal qiladi.

4. **Xodimlar:** kassada egasi kassir va menejerlarni qo'shadi (ism, login, PIN). Kabinetda ular faqat ko'rinadi.
5. **Printer:** Sozlamalar → Printer → test chek.
6. **Ikkinchi kassa (LAN):**
   1. Asosiy kassada: "Ulanishlar" → "Kassa qo'shish". Kod (5 daqiqa amal qiladi), kompyuter manzili (masalan `192.168.1.10:47821`) va barmoq izi chiqadi. Windows ruxsat so'rasa, "Ruxsat berish" (xususiy tarmoq).
   2. Ikkinchi kompyuterga dasturni o'rnating. Birinchi ekranda "Ikkinchi kassa sifatida ulanish" → manzil, port, kod va kassa nomi. Chiqqan barmoq izi asosiy kassadagi bilan bir xil bo'lishi kerak. "Qayta ishga tushirish" dan keyin ikkinchi kassa asosiy kassaning foydalanuvchilari bilan ishlaydi; har kassada o'z smenasi va pul yashigi.
   3. Kassani bekor qilish: asosiy kassada "Ulanishlar" → ro'yxatda "Bekor qilish". Ikkinchi kompyuterni qayta ulash uchun uning kirish ekranida "Asosiy kassadan uzish".
   4. v1 da ikkinchi kassa avtomatik yangilanmaydi: yangi versiya o'rnatuvchi bilan qo'lda o'rnatiladi.

## 5. Kundalik ish va nosozliklar

- Kassir yo'riqnomasi: [../pilot/kassir-yoriqnomasi.md](../pilot/kassir-yoriqnomasi.md).
- Nosozliklar kitobi: [../pilot/nosozliklar-kitobi.md](../pilot/nosozliklar-kitobi.md).
- Yangilash va tiklash: [../pilot/yangilash-va-tiklash.md](../pilot/yangilash-va-tiklash.md).
- Reliz oldidan tekshiruv ro'yxati: [../pilot/reliz-royxati.md](../pilot/reliz-royxati.md).

## 6. Reliz oldidan tekshirilgan

- Barcha avtomatik testlar (PostgreSQL bilan), sifat tekshiruvlari va arxitektura qoidalari yashil.
- **Dastur haqiqiy holatda ishga tushirildi** (yig'ilgan `app.asar`, 2026-11-19). Ketma-ketlik: birinchi sozlash → PIN bilan kirish → smena ochish → mahsulot → to'lov → 1-chek.
- Kabinetdan o'zgartirilgan narx kassaga yetib borishi test bilan isbotlangan.
