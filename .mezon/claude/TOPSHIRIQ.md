# Claude topshirig'i: T2.2 rejasi — TUZATISHLAR BILAN TASDIQLANDI

**Merge tekshiruvi:** T2.1 merge'i tekshirildi. `main` = `2b8fbe7`, kod `2ea125d` bilan bir xil.

Reja puxta. Quyidagilar tasdiqlandi:

- xavfsizlik qarzi (`migrate` servisi);
- 8 belgili kod, faqat xeshi saqlanadi, 10 daqiqa, bir martalik;
- `cloud_devices`, `cloud_device_tokens`;
- `<org>.<device>.<secret>` formatidagi token;
- bekor qilingan qurilma `401`;
- boshqa tashkilotga bog'langan `deviceId` `409`;
- `safeStorage`;
- ikki tashkilot va nol oqish testlari.

Quyidagi tuzatishlar bilan `gemini/T2.2-device-pairing` branch'ida kodni yoz.

## Majburiy tuzatishlar

### D1. `POST /devices/pair` ham tenantdan oldin keladi (C1 bilan bir xil muammo)

`cloud_device_pairing_codes` fail-closed RLS ostida. Pre-auth so'rovda kodni xesh bo'yicha topib bo'lmaydi.

**Talab:**

- T2.1 C1 uslubida `SECURITY DEFINER` funksiya: `auth_lookup_pairing_code(code_hash)`. U faqat `organization_id`, `store_id`, `device_name`, `expires_at_ms`, `used_at_ms` va `attempts_left` ni qaytaradi. Egasi `mezon_auth_owner`, `PUBLIC` dan `EXECUTE` olingan.
- Shundan keyin kodni ishlatish va qurilma yaratish `withPgTenantContext(org)` ichida bitta tranzaksiyada bajariladi: `used_at_ms` belgilanadi, `cloud_devices` va token yoziladi.
- **Parallel holat:** bir kod bilan ikki parallel so'rov kelsa, faqat bittasi o'tadi (`UPDATE ... WHERE used_at_ms IS NULL RETURNING`). Test bilan.
- **Brute-force:** noto'g'ri kod hech qaysi qatorga mos kelmaydi, shuning uchun uning `attempts_left` ini kamaytirib bo'lmaydi.
  - Asosiy himoya: IP bo'yicha cheklov va global muvaffaqiyatsiz urinishlar oynasi.
  - `attempts_left` faqat mavjud kod uchun noto'g'ri `deviceId` yoki boshqa xato bo'lganda kamayadi.
  - Rejaga yoz va test qil: 20 noto'g'ri kod bitta IP'dan → `429`.

### D2. Token aylantirish tarmoq uzilishida qurilmani bloklamasin

Rejada eski token darhol bekor qilinadi, qayta ishlatish esa qurilmani bloklaydi. Agar aylantirish javobi tarmoqda yo'qolsa, hub eski tokenni qayta yuboradi. Natijada reuse deb hisoblanib, qurilma bloklanadi. Do'kon sababsiz bulutdan uziladi.

**Talab:**

- Aylantirish idempotent bo'lsin: hub `clientRequestId` yuboradi.
- Eski token **yangi token birinchi marta ishlatilguncha** (yoki qisqa grace, masalan 10 daqiqa) amal qiladi. Bu vaqtda eski token bilan qayta aylantirish so'rovi xuddi o'sha yangi tokenni qaytaradi.
- Faqat grace tugagandan keyin yoki yangi token ishlatilgandan keyin eski tokenning qayta ishlatilishi reuse hisoblanadi va qurilma bloklanadi.
- **Testlar:**
  - javob yo'qolgan aylantirish → qayta urinish → bitta yangi token, qurilma bloklanmaydi;
  - haqiqiy reuse (grace'dan keyin) → bloklash.
- **Token muddati:** masalan 90 kun, aylantirish bilan uzayadi. Yoz.

### D3. Bulutga nima chiqadi va nima chiqmaydi: aniqroq

Rejada `users` jadvali bulutga umuman chiqmaydi deyilgan. Lekin biznes kabineti (T2.7) va hisobotlar kassir ismi va rolini ko'rsatishi kerak. PIN esa allaqachon alohida jadvalda (`local_pin_credentials`).

**Qaror:**

- `users` (ATTR: ism, username, rol, faollik) sinxron qilinadi.
- **Hech qachon chiqmaydi:** `local_pin_credentials`, `local_sessions`, `local_device_auth_state`, `local_device_state`, `local_cloud_state` (shifrlangan token bilan), `local_receipt_prints`, `local_cash_drawer_events` va boshqa LOCAL jadvallar.
- Bu ro'yxat kodda bitta joyda bo'lsin (masalan sxema registridagi `tableClass: 'LOCAL'` = hech qachon sinxron emas).
- **Test:** LOCAL jadval hodisasi outbox'ga yozilmaydi. `users` hodisasi payload'ida PIN yoki xesh maydoni yo'q.

### D4. `safeStorage` faqat Electron main jarayonida ishlaydi

Hub `utilityProcess` ichida ishlaydi, `safeStorage` esa faqat main jarayonda mavjud.

- Shifrlash va ochish main jarayonda bo'lsin. Hub tokenni main'dan IPC orqali so'raydi (`SafeStoragePort`).
- Ochiq token diskka, loglarga yoki renderer'ga hech qachon tushmasin.
- Dev va test rejimida test adapteri ishlatiladi. U ishlab chiqarishda ishlamasligi T1.4 C1 uslubida kafolatlansin.
- **Test:** `local_cloud_state` da ochiq token yo'q (baytlarda token qatori uchramaydi).

### D5. Hub yo'llari mavjud uslubda

Hub marshrutlari `/api/v1` prefiksisiz: `/cloud/status`, `/cloud/pair`, `/cloud/unpair`. Bulut API'si `/api/v1/...` bo'lib qoladi.

## Bajarish tartibi

1. Birinchi commit: T2.1 xavfsizlik qarzi (`migrate` servisi).
2. T2.2 kodi.
3. Lokal `pnpm verify` yashil (PG testlari Docker bilan).
4. Commit qil, push qil va PR och. CI yashil bo'lsin. `apps/desktop` o'zgarsa, installer job ham yashil bo'lsin.
5. Hisobot: D1–D5 dalillari va mutatsiya dalillari (parallel juftlash, grace, LOCAL filtr). `[gemini-hisobot] T2.2` bilan commit qil va push qil.
6. `node .mezon/kutish.mjs` ni ishga tushir. Merge qilma.
