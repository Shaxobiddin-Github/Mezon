# Reja: T2.7 — Biznes Kabineti (apps/admin)

**Branch:** `gemini/T2.7-cabinet`  
**Bajaruvchi:** Gemini  
**Tekshiruvchi:** Claude  
**Asosiy manba:** `GEMINI.md` (T2.7, 1-bo'lim, 2.5-bo'lim) va `TOPSHIRIQ.md`  

---

## 0. Kirish va Maqsad

Biznes kabineti (`apps/admin`) — biznes egasi va menejeri uchun do'konlarni masofadan turib telefon yoki kompyuter orqali nazorat qilish, savdo va moliyaviy hisobotlarni real vaqtda ko'rish, xodimlar, narxlar va sozlamalarni boshqarish hamda sinxronizatsiya holatini kuzatish platformasi.

Kabinet **faqat bulut PostgreSQL API'si (`apps/cloud`) orqali** ishlaydi. Do'kon hub'iga to'g'ridan-to'g'ri hech qanday tarmoq ulanishi bo'lmaydi.

---

## 1. Ma'lumot Manbai, RLS va Xavfsizlik

### 1.1. Arxitektura va Kirish Chegarasi
- Frontend: `apps/admin` (React 19, Vite 8, Tailwind 4, Zustand 5, TanStack Query 5).
- Backend: `apps/cloud` (Fastify 5).
- Aloqa: Faqat `/api/v1/admin/*` REST endpointlari orqali.
- Tenant konteksti: Har bir so'rov JWT access token orqali tekshiriladi va ma'lumotlar bazasi so'rovi `withPgTenantContext(pool, { organizationId, role }, callback)` ichida bajariladi.

### 1.2. RLS va RBAC (Rollar)
- **RLS Kafolati:** PostgreSQL RLS (`mezon_current_organization_id() = organization_id`) yoqilgan. Boshqa tashkilot ma'lumoti SQL darajasida mutlaqo ko'rinmaydi.
- **Rollar siyosati:**
  - `owner`: barcha bo'limlar, sozlamalar, narxlar, xodimlar, konfliktlarni hal qilish, hisobotlar.
  - `manager`: savdo, ombor, mijozlar, hisobotlar, narx o'zgartirish (agar ruxsat berilgan bo'lsa), xodimlarni boshqarish cheklangan.
  - `cashier`: Biznes kabinetiga kirish taqiqlangan (`403 Forbidden`).
- **Testlar:**
  - `test-cross-tenant-isolation`: Org A egasi Org B ma'lumotlarini (savdolar, mijozlar, qoldiqlar) ID orqali ham, ro'yxat orqali ham ololmaydi (bo'sh ro'yxat yoki 404).
  - `test-role-authorization`: `cashier` tokeni bilan kelgan har qanday admin so'roviga `403 FORBIDDEN` qaytadi.

---

## 2. Yozish Amallari va Kassalarga Tarqatish (Sync Event Generation)

Biznes kabinetidan kiritilgan o'zgarishlar (tovar narxi, yangi xodim, kategoriya, soliq sozlamasi) do'kon kassalariga qanday yetib boradi?

### 2.1. Yechim: Bulut Sinxron Hodisalari Generator (Cloud Sync Event Writer)
1. **Virtual Bulut Qurilmasi (`device_id`):**
   - Har bir tashkilot yaratilganda yoki birinchi bulut yozuvida maxsus virtual boshqaruv qurilmasi ajratiladi (`cloud_devices` jadvalida `device_name: 'Guzar Cloud Cabinet'`, platform: `web`).
2. **Tranzaksiya va Outbox hodisasi:**
   - Masalan, tovar narxi o'zgarganda (`POST /api/v1/admin/products/:id/price`):
     1. Bulutdagi `products` jadvali yangilanadi (LWW qoidasi bo'yicha).
     2. O'sha tranzaksiya ichida `cloud_sync_events` jadvaliga `products.updated` hodisasi (ATTR sinfi, `schemaVersion: 1`, HLC: `nowMs:0:cloudDeviceId`) yoziladi.
     3. Tashkilotdagi barcha do'konlar uchun `cloud_store_sync_positions` olinadi va gapless `position` beriladi.
3. **Kassaga yetkazish:**
   - Kassa hub'lari T2.4 bo'yicha har 5 soniyada `GET /api/v1/sync/pull` qiladi.
   - `products` va `users` jadvallari `pullScope: 'organization'` bo'lgani uchun, bulut kiritgan bu hodisalar avtomatik tarzda barcha filial hub'lariga tushadi va ularning lokal SQLite bazasida yangilanadi.

### 2.2. Qat'iy Taqiqlar (Domen Invariantlari)
- Pul balansi (`cash_moves`) va ombor qoldig'i (`stock_moves`) kabinetdan **to'g'ridan-to'g'ri son kiritib o'zgartirilmaydi**.
- Qoldiqni to'g'rilash faqat hujjat asosida bo'ladi:
  - Masalan, inventarizatsiya yoki qoldiq tuzatish hujjati (`stock_moves` — reason: `'adjustment'`, `qtyDelta`, `costValueDelta`, `createdByUserId`).
- Kassa puli faqat rasmiy pul kiritish/chiqarish hujjati (`cash_moves`) orqali harakatlanadi.

---

## 3. Hisobotlar va Kassa T1.13 Bilan 100% Tenglik

### 3.1. Hisobotlar Ro'yxati
1. **Bugungi Savdo Dashboard:** Kunlik tushum, cheklar soni, o'rtacha chek, naqd / karta / uzqr / nasiya nisbati, soatbay tushum grafigi.
2. **Cheklar Tarixi:** Chek raqami, vaqti, kassir, to'lov turlari, chegirmalar, QQS, mahsulotlar ro'yxati, bekor qilinganlik holati.
3. **Qarz Daftari va Mijozlar:** Umumiy nasiya balansi, muddati o'tgan qarzlar, mijozlar kesimida qarzlar va to'lovlar tarixi.
4. **Ombor va Qoldiqlar:** Qoldiqlar qiymati (tannarx va sotuv narxida), tugayotgan tovarlar ro'yxati, minimal qoldiqdan kam qolgan tovarlar.
5. **Davriy Moliya va Soliq Hisoboti (T1.13 analogi):** Jami savdo, qaytarishlar, sof tushum, hisoblangan QQS (stavkalar kesimida: 12%, 0%), to'lov usullari jami.

### 3.2. Matematik Tenglik va Parity Test
- Barcha hisob-kitoblar faqat `bigint` tiyinda (hech qanday float yo'q).
- Chek bekor qilingan bo'lsa (`voided_at_ms IS NOT NULL`), asosiy sotuv ko'rsatkichlariga qo'shilmaydi, alohida "Bekor qilinganlar" bo'limida ko'rsatiladi.
- **Oracle Parity Testi (`report-parity.test.ts`):**
  - Test ssenariysi: Bir xil savdo, qaytarish, to'lov va qarz hodisalari to'plami yaratiladi.
  - Hub tomonida T1.13 hisobot servisi chaqiriladi (`dailySalesSummary`, `paymentMethodsSummary`, `taxSummary`).
  - Cloud tomonida T2.7 admin hisobot endpointlari chaqiriladi.
  - Ikkala hisobot natijasi tiyinigacha solishtiriladi:
    `expect(cloudReport.totalGrossTiyin).toBe(hubReport.totalGrossTiyin)`.

---

## 4. Sinxronizatsiya Holati va Konfliktlar Ekrani

Biznes egasi tizim qanday ishlayotganini ko'rishi shart:
1. **Qurilmalar va Terminallar:**
   - Har bir kassa qurilmasi nomi, do'koni, oxirgi marta qachon aloqaga chiqqani (`last_seen_at_ms`), IP/platformasi, joriy kursor pozitsiyasi.
   - Agar kassa 10 daqiqadan ortiq aloqaga chiqmagan bo'lsa: "Oflayn" ogohlantirishi.
2. **To'xtatilgan va Ziddiyatli Hodisalar (`cloud_sync_parked` va `conflicts`):**
   - Bog'liqligi kechikkan hodisalar (`unresolved_fk`): qaysi yozuvni kutayotgani.
   - Konfliktlar: manfiy qoldiq signallari, partiyadan ortiqcha chiqim, cheklov xatolari.
3. **Boshqaruv (Faqat Owner):**
   - Qayta urinish buyrug'i (`retry`), konfliktni o'rganilgan deb belgilash (`acknowledge`), har bir harakat uchun majburiy audit jurnali.

---

## 5. Autentifikatsiya, Sessiya va Xavfsizlik

- **Tokenlar:**
  - Qisqa muddatli Access Token: 15 daqiqa (in-memory Zustand store).
  - Aylanuvchi (Rotating) Refresh Token: 30 kun, faqat `HttpOnly, Secure, SameSite=Strict` cookie orqali saqlanadi (brauzer JS kodi tokenni o'qiy olmaydi, XSS xavfidan himoyalangan).
- **CSRF Himoyasi:** Fastify `@fastify/csrf-protection` yoki `SameSite=Strict` cookie siyosati.
- **Chiqish (Logout):** Refresh token bazada `revoked_at_ms` bilan bekor qilinadi, brauzer cookie'si tozalanadi.

---

## 6. Foydalanuvchi Interfeysi (UI), Mobil Moslashuv va Tillar

- **Guzar Dizayn Tizimi:** `@mezon/ui` komponentlari (Tailwind CSS 4, toza, zamonaviy, tezkor).
- **Mobil Moslashuv (Mobile-First):**
  - Biznes egasi kabinetni asosan smartfondan (Telegram yoki brauzer orqali) ochadi.
  - Responsive layout: pastki navigatsiya paneli (Bottom Navigation), ixcham kartalar, qulay jadvallar (kartochka ko'rinishiga o'tuvchi).
- **Tillar (`@mezon/i18n`):**
  - O'zbekcha lotin (`uz-Latn`), O'zbekcha kirill (`uz-Cyrl`), Ruscha (`ru`).
  - Har qanday matn faqat `t('admin...')` orqali chiqariladi. Hardcoded so'zlar bo'lmaydi.
  - Raqamlar va valyuta: O'zbekiston standarti (masalan: `1 250 000 tiyin` -> `12 500,00 so'm`).

---

## 7. Audit Log Jurnali

Har bir muhim amal tizimda iz qoldiradi (`cloud_audit_logs`):
- Kim bajardi (`user_id`, username, rol);
- Qachon bajardi (`created_at_ms`);
- Qaysi qurilma/IP dan;
- Amal turi (`action`: narx o'zgarishi, chek bekor qilish, xodim o'chirish/bloklash, sozlama o'zgarishi);
- O'zgargan parametrlar (oldingi qiymat va yangi qiymat JSON ko'rinishida).

---

## 8. Vazifani Bosqichlarga Bo'lish (T2.7a va T2.7b)

Kod hajmi va xavfsizlik nazoratini yuqori ushlab turish uchun T2.7 ikki mantiqiy bosqichga ajratiladi:

### 1-bosqich: T2.7a — O'qish, Monitoring va Hisobotlar
1. `apps/admin` UI poydevori (Vite, React 19, Tailwind 4, Router, Zustand, i18n, Mobil layout).
2. Auth va sessiya boshqaruvi (Login, Refresh, Logout, Route Guards).
3. Dashboard: Bugungi savdo va moliyaviy ko'rsatkichlar.
4. Cheklar jurnali va chek tafsiloti.
5. Qarzlar va mijozlar balansi.
6. Ombor va qoldiqlar holati (tugayotgan tovarlar).
7. Moliya va Soliq hisobotlari (T1.13 bilan 100% parity).
8. Qurilmalar monitoringi (onlayn/oflayn statusi).

### 2-bosqich: T2.7b — Boshqaruv, Yozish, Konfliktlar va Audit
1. Mahsulot va narxlarni tahrirlash (bulutda sinxron hodisasi yaratib, kassalarga tarqatish).
2. Xodimlar va ruxsatlar boshqaruvi (yangi foydalanuvchi qo'shish, PIN berish, bloklash).
3. Tashkilot va do'kon sozlamalari (rekvizitlar, ish vaqti, soliq rejimi).
4. Sinxronizatsiya konfliktlari va to'xtatilgan hodisalarni boshqarish ekrani.
5. Audit jurnali (kim, qachon, nima o'zgartirdi).

---

## 9. Testlash Rejasi

1. **Backend Integratsion Testlari (PG Testcontainers bilan):**
   - RLS Multi-tenant ajratilishi (Org A egasi Org B ma'lumotlarini mutlaqo ko'ra olmasligi);
   - RBAC testlari (kassir tokeni bilan 403, menejer ruxsati, egasi to'liq ruxsati);
   - Hisobot parity testi (Hub SQLite hisoboti === Cloud PG hisoboti tiyinigacha tengligi);
   - Cloud Sync Event generation testi (admin narx o'zgartirganda `cloud_sync_events` ga tushishi va kassaga pull bo'lishi).
2. **E2E Testlari (Playwright):**
   - Desktop (`1280x800`) va Mobile (`390x844`) o'lchamlarida login qilish, dashboard ko'rish, chek tafsilotini ko'rish;
   - Sessiya tugashi va avtomatik refresh qilish ssenariylari;
   - Tillar almashinuvi (`uz-Latn` <-> `ru`).
