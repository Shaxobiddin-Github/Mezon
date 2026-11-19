# C6: v1 ulanish ekranlari (bulut + ikkinchi kassa) va ikkita yashirin xato

Branch `claude/C6-connect-screens`, C5 (`7fe7bd0`) ustida. ishchi2 limiti tugadi; egasi uning ishlarini menga berdi.

## Nima qilindi

### 1. Kassada "Ulanishlar" oynasi (ega va menejer)
- **Bulut kabineti** (faqat ega): holat (ulangan / yo'q, oxirgi sinxron), manzil va 8 belgili kod bilan ulash, uzish. Hub'dagi mavjud `/cloud/status`, `/cloud/pair`, `/cloud/unpair` ishlatiladi.
- **Do'kondagi boshqa kassalar (LAN):** "Kassa qo'shish" tugmasi kod, kompyuterning IP manzillari va porti, hamda barmoq izini ko'rsatadi. Ulangan kassalar ro'yxati va bekor qilish ham shu yerda.

### 2. "Ikkinchi kassa sifatida ulanish" (yangi o'rnatilgan kompyuter)
Sozlash ekranidagi tugma bosilganda manzil, port (47821), kod va kassa nomi so'raladi. Keyin "Ulandi" ekranida barmoq izi chiqadi va "Qayta ishga tushirish" tugmasi bor. Qayta ishga tushgan dastur asosiy kassa bilan ishlaydi: asosiy kassadagi foydalanuvchilar, smena va cheklar.

Ulanish faqat bo'sh o'rnatishda mumkin: o'z ma'lumoti bor kassa terminalga aylanmaydi (`LOCAL_DATA_EXISTS`). Ikkinchi kassaning kirish ekranida "Asosiy kassadan uzish" tugmasi bor. U bekor qilingan yoki ko'chirilgan kassani tiklash uchun.

### 3. Texnik tomoni
- **Hub (`server.ts`, `lan-server.ts`):** LAN tinglovchisi desktop'da avval **umuman ishga tushmas edi**, chunki `listenLan` faqat testlardan chaqirilardi. Endi u `lanPort` (47821) bilan ikki holatda ochiladi:
  - ega kod so'raganda;
  - hub ishga tushganda, agar faol terminal bo'lsa.
  
  Port band bo'lsa, xato logga yoziladi va hub ishlashda davom etadi. Shuningdek:
  - `/lan/status` va kod javobiga `port` va `addresses` qo'shildi;
  - LAN proksi `OPTIONS` ni ham uzatadi, ya'ni terminaldagi POS'ning CORS preflight so'rovi asosiy ilovaning xavfsizlik hook'i orqali o'tadi.
- **Desktop terminal rejimi (`apps/desktop/src/terminal/`):**
  - `terminal.json` faylida terminal kaliti OS bilan o'ralgan (safeStorage), sertifikat ochiq saqlanadi.
  - `terminal-proxy.ts` — loopback HTTP proksi (`127.0.0.1:<tasodifiy port>`). Har so'rovni pinned TLS orqali hub'ga uzatadi va `x-mezon-terminal` kalitini qo'shadi. Kalit renderer'ga **hech qachon** chiqmaydi. POS avvalgidek faqat `http://127.0.0.1:<port>` ni ko'radi, shuning uchun CSP va loopback tekshiruvlari o'zgarmadi.
  - Begona `Host` sarlavhasi rad etiladi (421, DNS rebinding). Tashqaridan kelgan `x-mezon-*` sarlavhalari olib tashlanadi.
  - Boshqa sertifikat (MITM yoki qayta o'rnatilgan hub) `LAN_PIN_MISMATCH` beradi va hech qanday bayt yuborilmaydi.
  - Terminal rejimida lokal hub ishga tushmaydi.
  - Yangi IPC: `getTerminalInfo`, `pairAsTerminal`, `leaveTerminal`, `relaunchApp`. Desktop E2E ro'yxati yangilandi.

## Topilgan va tuzatilgan 2 ta jiddiy xato

### X1. Hub maxfiylari qayta ishga tushgandan keyin o'qilmay qolardi (v1 blokeri)
Electron worker `createHubServer` ga `safeStorage` bermas edi. Shu sababli hub har ishga tushganda **yangi tasodifiy** AES kalit oldi. Natijada dastur birinchi qayta ochilgandan keyin:
- bulut qurilma tokeni o'qilmaydi va bulut sinxroni to'xtaydi;
- LAN TLS kaliti o'qilmaydi va barcha terminallar uziladi.

**Tuzatish:** `apps/desktop/src/data-key.ts`. 32 baytli kalit bir marta yaratiladi va `userData/hub-data-key.json` da OS bilan o'ralgan holda (DPAPI) saqlanadi. U worker'ga `dataKeyB64` orqali uzatiladi. Kalit fayli buzilgan bo'lsa, start to'xtaydi; yangi kalit jimgina yaratilmaydi. Testlar:
- `data-key.test.ts`;
- `electron-worker.test.ts`: oldingi jarayon shifrlagan qiymat yangi jarayonda o'qiladi, noto'g'ri kalit `error` beradi;
- `lan-on-demand.test.ts`: qayta ishga tushgandan keyin terminal ishlaydi.

### X2. Ikkinchi kassa asosiy kassaning ochiq chekini olib ketardi (P3 / T4.2)
`GET /carts` do'kondagi **barcha** kassalarning ochiq va kechiktirilgan cheklarini qaytarardi. POS birinchi ochiq chekni davom ettiradi. Shuning uchun ikkinchi kassa asosiy kassadagi chekni olib, o'zida yopdi va savdo asosiy kassaga yozildi. Buni ikki nusxali haqiqiy sinov ko'rsatdi.

**Tuzatish:** ro'yxat endi faqat so'ragan kassaning cheklarini qaytaradi (`terminal_id` bo'yicha; hub uchun `NULL`). Yangi test `multi-register.test.ts`: uch kassaning har biri faqat o'z chekini ko'radi. Tuzatishsiz bu test yiqiladi (3 ta chek ko'rinadi). Tekshirildi.

**Qolgan cheklov (v2):** chekni `id` bo'yicha o'zgartiradigan route'lar (`/carts/:id/...`) boshqa kassaning chekiga qarshi tekshirilmaydi. UI'dan bunga yo'l yo'q, chunki ro'yxat endi filtrlangan.

## Tekshiruv
- Typecheck, lint, depcruise, prettier: yashil.
- unit + sqlite-hub: 933 test. To'liq yugurishda bitta property test (`uow.test.ts`, `device_seq`) og'ir yuklamada yiqildi. Alohida ishga tushirilganda 14/14 o'tadi, oldingi to'liq yugurishda ham o'tgan. Bu o'zgarish UoW'ga tegmaydi.
- POS E2E: yashil.
- **Desktop `pack:dir` + `test:e2e`: yashil.**
- **Ikki nusxali haqiqiy sinov** (yig'ilgan `app.asar`, ikkita alohida ma'lumot papkasi):
  1. A: sozlash → smena → "Ulanishlar" → "Kassa qo'shish" (kod va manzil chiqdi).
  2. B: "Ikkinchi kassa sifatida ulanish" → ulandi, barmoq izlari bir xil.
  3. B qayta ishga tushirildi: A ning kirish ekrani chiqdi.
  4. B da o'z smenasi ochildi, sotuv qilindi, 1-chek chiqdi.
  5. A dagi hisobot: `Kassa 2: 1 savdo, 5 000 so'm`.

## Integratsiya eslatmasi (C2 bilan)
C2 dagi `UpdateManager` hub supervisor'ga bog'langan (`prepareUpdate`). C2 va C6 birlashtirilganda terminal rejimida yangilanish hub tayyorgarligisiz o'tishi kerak, chunki terminalda lokal hub yo'q. `main.ts` da `supervisor === null` holati shuni hisobga olishi kerak. Bu merge paytida qilinadi.

## Windows xavfsizlik devori
Ega birinchi marta "Kassa qo'shish" ni bosganda Windows ruxsat so'rashi mumkin. Ekranda "Ruxsat berish (xususiy tarmoq)" degan maslahat bor. Kelajakda o'rnatuvchi qoidani o'zi qo'shishi mumkin.
