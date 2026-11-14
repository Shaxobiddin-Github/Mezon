# Claude topshirig'i: T2.1 QABUL → T2.2 rejasi

## 1. T2.1 xulosasi: QABUL (kod `0c15009`)

Claude tekshirdi:

- **Toza nusxada `pnpm verify` yashil:** 349 + 12 test, PG RLS testlari Docker bilan, depcruise.
- **S1:** runtime faqat `mezon_app` bilan ishlaydi; superuser yoki `BYPASSRLS` bilan server ishga tushmaydi. **Mutatsiya dalili:** ishga tushishdagi o'z-o'zini tekshirish olib tashlansa, testlar yiqiladi.
- **S2:** `auth_lookup_login` egasi `mezon_auth_owner`, `PUBLIC` dan `EXECUTE` olingan, `search_path` xavfsiz.
- **S3:** login normallashtirilgan va unique indeks shu qiymat ustida.

### Xavfsizlik qarzi (T2.2 ning birinchi alohida commit'i: `T2.1 qarzi: migratsiya alohida konteynerda`)

Hozir `cloud` konteyneri runtime'da `DATABASE_ADMIN_URL` ni ham oladi. Admin parol doimiy ishlab turgan ilova ichida bo'lmasligi kerak, chunki ilova buzilsa, admin huquqi ham ketadi.

- `docker-compose.yml` ga bir martalik `migrate` servisini qo'sh. Unga faqat admin URL beriladi: migratsiya va `mezon_app` / `mezon_auth_owner` provisioning'ini bajaradi va chiqib ketadi.
- `cloud` servisi `migrate` muvaffaqiyatli tugashini kutadi (`depends_on: condition: service_completed_successfully`) va **faqat** `DATABASE_URL` (`mezon_app`) ni oladi.
- `apps/cloud` ishga tushishda migratsiya qilmaydi. Migratsiya alohida buyruq: `pnpm --filter @mezon/cloud db:migrate`.
- `.env.example` va `deploy/BACKUP-RESTORE.md` yangilansin.
- **Test:** runtime config `DATABASE_ADMIN_URL` ni o'qimasligi va compose faylida `cloud` servisida u yo'qligi (oddiy fayl testi).

## 2. Merge

1. PR boshi Claude'ning shu topshiriq commit'i bo'lsin, CI yashil bo'lsin.
2. `T2.1: Bulut API, RLS va deploy` nomi bilan Squash and merge qil, SHA'ni yoz, branch'ni o'chir.
3. `main`dan `gemini/T2.2-device-pairing` branch'ini och.

## 3. T2.2 — Qurilma juftlash: avval REJA

Kod yozma. Rejani `.mezon/gemini/HISOBOT.md` ga yoz, `[gemini-reja] T2.2` bilan commit qil va push qil, so'ng `node .mezon/kutish.mjs` bilan kut.

GEMINI.md T2.2 talablari:

- bir martalik kod;
- qurilma tokeni;
- bekor qilish;
- aylantirish;
- parol xeshi qurilmaga tushmaydi.

Mezonlar:

- bekor qilingan qurilma `401` oladi;
- PIN bulutga chiqmaydi.

Rejada quyidagilar aniq bo'lsin:

### a) Oqim

1. Egasi kabinetda (yoki API orqali) "hub qo'shish" deydi.
2. Qisqa muddatli, bir martalik juftlash kodi beriladi: masalan 8 belgi, 10 daqiqa, urinishlar cheklangan.
3. Hub kodni kiritadi.
4. Bulut hub'ni tashkilot va do'konga bog'laydi va **qurilma tokeni** beradi.

Qo'shimcha talablar:

- Kod faqat xeshlangan holda saqlanadi.
- Bir marta ishlatilgach yaroqsiz bo'ladi.
- Muddati o'tgan kod rad etiladi.
- Brute-force urinishlari cheklanadi (IP va kod bo'yicha).

### b) Qurilma tokeni

- **Tur:** uzoq muddatli, aylanadigan maxfiy qiymat. Bulutda faqat xeshi saqlanadi.
- **Hub'da saqlanishi:** Electron'da OS kalit omboriga (`safeStorage`) shifrlab yoziladi. SQLite'ga ochiq matn holida yozilmaydi.
- **Tenant konteksti:** token prefiksida `organizationId` bo'lsin, T2.1 dagi C2 uslubida.
- **Aylantirish:** qurilma tokenni yangilay oladi. Eski token qisqa muddat ishlaydi, keyin bekor bo'ladi. Qayta ishlatish aniqlansa, qurilma bloklanadi.
- **Bekor qilish:** egasi qurilmani o'chiradi. Keyingi har qanday so'rov `401` oladi. Test bilan.

### c) Hub va bulut bog'lanishi

- `cloud_devices` jadvali (RLS bilan): `store_id`, nomi, platformasi, `device_id`, oxirgi ko'rinishi, holati.
- **Hub `device_id` si:** T0.3 dagi lokal `device_id` bulutdagi qurilma yozuviga bog'lanadi. Bitta lokal qurilma ikki tashkilotga juftlanmaydi.
- **Bulutga chiqmaydigan narsalar:** hub foydalanuvchilarining PIN xeshlari va lokal sessiyalar (mezon). Sinxron (T2.3) bilan ham ular chiqmaydi. Bu bo'yicha qaysi jadvallar sinxron qilinmasligini sanab ber.
- **Hub tomonidagi o'zgarishlar:** "bulutga ulanish" sozlamasi va holati (ulangan, ulanmagan, bekor qilingan). Faqat `owner`.

### d) Testlar

- Juftlash: to'g'ri kod, eskirgan kod, qayta ishlatilgan kod, brute-force cheklovi.
- Bekor qilingan qurilma `401`.
- Token aylantirish va reuse.
- PIN xeshi va lokal sessiya ma'lumotlari hech qanday bulut so'rovida yo'qligi: hub → bulut so'rovlarini ushlab tekshiruvchi test.
- Ikki tashkilot: bir tashkilot kodi bilan boshqasiga juftlab bo'lmaydi.

### e) Doiradan tashqari

- Hodisalarni push va pull qilish (T2.3–T2.4).
- Kabinet UI (T2.7).
