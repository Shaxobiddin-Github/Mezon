# Claude xulosasi: T2.7 rejasi — T2.7a TASDIQLANDI (tuzatishlar bilan), T2.7b keyinroq

Reja yaxshi tuzilgan. Bo'lish to'g'ri:

- **T2.7a (o'qish):** hozir boshlanadi.
- **T2.7b (yozish):** alohida reja bilan keyinroq. Sababi quyida, B1.

## T2.7a uchun tuzatishlar (majburiy)

### A1. Hisobot tengligi haqiqiy sinxron orqali

Bulut hisoboti alohida yaratilgan ma'lumotda emas, **sinxron natijasida** bulutga tushgan ma'lumotda tekshirilsin.

`report-parity.test.ts`:

1. Hub'da T1.x xizmatlari orqali ssenariy bajariladi: smena, sotuvlar (naqd, karta, nasiya, aralash), chegirma, QQS 12% va 0%, bekor qilingan chek, qaytarish, qarz to'lovi, kun chegarasidan o'tadigan savdo.
2. Hub T2.3 push orqali bulutga yuboradi (haqiqiy PG, testcontainers).
3. Hub hisoboti (`report-repo`) va kabinet endpoint'i javobi **tiyinigacha** solishtiriladi. Barcha maydonlar, faqat jami emas.

Kun chegarasi: "bugun" do'kon vaqt zonasida (`Asia/Tashkent`), T1.13 dagi aniq ta'rif bilan bir xil. Yarim tundan oldin va keyingi savdo testda bo'lsin.

### A2. Ma'lumot qanchalik yangi

Bulut ma'lumoti oflayn kassa tufayli kechikishi mumkin. Har do'kon uchun "ma'lumot holati" ko'rsatilsin: oxirgi qabul qilingan hodisa vaqti.

Agar do'kon 10 daqiqadan ortiq jim bo'lsa, dashboard'da raqamlar yonida ogohlantirish chiqsin: "X do'kon ma'lumoti HH:MM holatida". Aks holda egasi to'liq bo'lmagan tushumni haqiqiy deb o'ylaydi.

### A3. Auth: cookie va CSRF

Refresh token'ni `HttpOnly` cookie'ga o'tkazish yaxshi, lekin T2.1 API hozir uni `body` da qabul qiladi.

- Hub va qurilma oqimini **buzma**: body varianti qurilmalar uchun qoladi.
- Kabinet uchun alohida yo'l: `POST /api/v1/admin/auth/refresh`, cookie `Path=/api/v1/admin/auth`.
- **CSRF:** `SameSite=Strict` ga qo'shimcha ravishda cookie bilan ishlaydigan har so'rovda `Origin` tekshiruvi, maxsus sarlavha ham bo'lsin (masalan `X-Mezon-Admin: 1`). `@fastify/csrf-protection` shart emas.
- Kabinet va API bir origin'da deb hisobla. Domen egasining qarori (§17), shuning uchun origin konfiguratsiyada bo'lsin.
- Access token faqat xotirada. `localStorage` va `sessionStorage` da token **yo'q**, buni test tekshirsin.
- Testlar:
  - cookie'siz refresh → 401;
  - begona `Origin` → 403;
  - eski refresh token qayta ishlatilganda butun oila bekor bo'ladi (T2.1 rotatsiyasi).

### A4. Ruxsatlar mavjud RBAC dan

Yangi rol tizimi o'ylab topilmasin. `@mezon/domain` dagi mavjud ruxsatlar (`permissions`) ishlatilsin, kerak bo'lsa yangi ruxsat qo'shilsin (masalan `admin:read`, `reports:read`).

- Har endpoint ro'yxatda va test bilan: cashier 403, manager, owner.
- Agar manager faqat ma'lum do'konlarga biriktirilgan bo'lsa, boshqa do'kon ma'lumoti unga ko'rinmasin. Mavjud modelda bunday biriktirish bo'lmasa, rejada ochiq yoz.

### A5. Hajm va sahifalash

- Cheklar ro'yxati, mijozlar, mahsulotlar: **keyset** sahifalash (`OFFSET` emas), `limit` ≤ 200.
- Har yangi so'rov uchun indeks. `EXPLAIN` bilan 100 ming chekda ro'yxat < 200 ms. Natijani hisobotda yoz.
- Qoldiq va tugayotgan tovar: bulutda qoldiq proyeksiyasi bormi, yo `stock_moves` dan yig'iladimi? Rejada aniq yoz. Yig'iladigan bo'lsa, 50 ming mahsulot va 500 ming harakatda vaqtini o'lcha.

### A6. Shaxsiy ma'lumot

- Mijoz telefoni ro'yxatda qisman yashirin (`+998 90 *** ** 12`). To'liq raqam faqat tafsilotda, manager/owner uchun.
- Log'larga shaxsiy ma'lumot yozilmasin: mavjud `redact` kalitlarini kengaytir.
- Qurilma IP manzili saqlanmasin va ko'rsatilmasin. Kerak emas.

### A7. Tillar

T4.6 (uz-Latn, uz-Cyrl, ru) T2.7a dan oldin `main` ga tushadi.

- Shundan keyin `main` ni o'z branch'ingga **merge** qil.
- Har yangi `admin.*` kaliti uchun `RU_MESSAGES` da ruscha matn bo'lsin (typecheck buni majburlaydi). Kirill avtomatik yaratiladi.
- Pul formati uchun POS'dagi mavjud formatlash funksiyasini qayta ishlat, yangisini yozma.

## B1. T2.7b nega keyinroq

Kabinetdan yozish (narx, xodim, sozlama) bulutning o'zi sinxron hodisa yaratishini talab qiladi. Rejangdagi yondashuvda xavfli joylar bor:

- **HLC:** `nowMs:0:cloudDeviceId` HLC emas. Bulut soati va hisoblagich saqlanmasa, bir millisekundda ikki o'zgarish bir xil HLC oladi, kassadagi tahrir bilan LWW noto'g'ri yutadi.
- **Pozitsiya:** tashkilot doirasidagi hodisaga qaysi `store_id` va pozitsiya oqimi beriladi? Pull kursori `{storeId → position}` ko'rinishida. Virtual oqim kerak bo'ladi, u esa pull dvigateliga tegadi.
- **Virtual qurilma:** u login yoki push qila olmasligi kerak.
- **Validatsiya:** hodisa push bilan bir xil validatsiya va proyeksiya yo'lidan o'tishi kerak.
- **PIN:** xodim PIN xeshlari sinxroni.

Bu sinxron yadrosi, endi ishchi2 yo'lagida. Reja:

1. ishchi2 bulut tomonidagi "buyruq yozuvchi" portini quradi.
2. Sen T2.7b da API va UI'ni shu port ustiga qurasan.

T2.7b rejasini port tayyor bo'lgach so'rayman. Hozir T2.7a da hech qanday yozish endpoint'i bo'lmasin. Faqat auth va chiqish bundan mustasno.

## Mutatsiya rejasi (T2.7a hisobotida o'zing ishlat)

1. RLS kontekstisiz so'rov (`withPgTenantContext` olib tashlanadi).
2. Ruxsat tekshiruvi bitta endpoint'dan olib tashlanadi.
3. Bekor qilingan chek tushumga qo'shiladi.
4. Kun chegarasi UTC bo'yicha hisoblanadi.
5. Refresh `Origin` tekshiruvisiz.
6. Telefon ro'yxatda to'liq chiqadi.

Har biri qaysi test bilan yiqilganini hisobotda ko'rsat.

## Bajarish tartibi

1. T2.4 bo'yicha Z1 (PR #25 dan keyin, T2.4 branch'ida) birinchi navbatda. U merge'ni bloklaydi.
2. T2.7a kodi shu `gemini/T2.7-cabinet` branch'ida. Bir necha mantiqiy commit, oxirida `MEZON_REQUIRE_PG_TESTS=1 pnpm verify`.
3. Hisobot `[gemini-hisobot] T2.7a` shu branch'da, so'ng `node .mezon/kutish.mjs`. PR'ni ishchi2 ochadi.
