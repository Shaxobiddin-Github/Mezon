# Claude topshirig'i: T1.4 rejasi — TUZATISHLAR BILAN TASDIQLANDI

**Merge tekshiruvi:** T1.3 merge'i tekshirildi. `main` = `462cac7`, kod `9a8633b` bilan bir xil.

Reja juda puxta. Quyidagilar tasdiqlandi:

- test qarzi commit'i;
- `sales` (MONOTONE), `sale_lines` va `payments` (FACT);
- `applyOutboundStockMoveSync` ajratilishi;
- server tomonida qayta hisoblash va `SALE_TOTAL_CHANGED`;
- zaxira siyosati va bir xil mahsulotning bir nechta qatorini jamlab tekshirish;
- `last_receipt_seq`;
- idempotentlik va parallellik qoidalari, chidamlilik testlari;
- RBAC va tannarxni yashirish;
- batch prefetch.

Quyidagi qarorlar va tuzatishlar bilan `gemini/T1.4-complete-sale` branch'ida kodni yoz.

## Ochiq savollarga javob

1. **`receipt_code` formati:** `<deviceId oxirgi 4 hex>-<6 xonali receipt_no>` tasdiqlandi. Bu faqat ko'rinish uchun. Noyoblikni `UNIQUE(organization_id, device_id, receipt_no)` kafolatlaydi. F4'da terminal juftlanganda qisqa terminal kodi beriladi va format shunga o'tadi. Buni izohda yoz.
2. **Park qilingan savat:** avval `resume`, so'ng `completeSale` faqat `open` holatda. Tasdiqlandi.
3. **Fiskal holat:** `sales` jadvalidan `fiscal_status` va `fiscal_receipt_no` ustunlarini **olib tashla**.
   - **Sabab:** `sales` MONOTONE. Uning trigger'i faqat `voided_at_ms` o'tishiga ruxsat beradi. Fiskal holat esa bir necha marta o'zgaradi (`pending` → `sent` → `confirmed`/`failed`, qayta yuborish). Uni `sales` ichida saqlash yoki MONOTONE kafolatini yumshatadi, yoki sinxronda ziddiyat keltiradi.
   - **Yechim:** fiskal holat F3 da alohida `fiscal_docs` jadvalida, `sale_id` havolasi bilan bo'ladi. T1.4 da hech qanday fiskal ustun yo'q.
4. **`payments[]`:** massiv (T1.4 da `length(1)`, faqat `cash`) tasdiqlandi.

## Majburiy aniqlik

### C1. Test uchun yiqilish ilgagi ishlab chiqarishga tushmasin

Child process testida `COMMIT` dan oldin `process.exit` chaqiradigan ilgak faqat test orqali in'ektsiya qilinadigan opsiya bo'lsin (masalan `createSqliteSaleStore({ __testHooks })`).

- Muhit o'zgaruvchisi yoki global flag bilan yoqilmasin.
- O'rnatilgan ilovada umuman ishlay olmasin.
- Hub va Electron uni hech qachon uzatmaydi.

Buni kod izohida va testda ko'rsat.

### C2. Audit logi

`sale.completed` Pino logida PIN, token, tannarx va foyda bo'lmasin. Mavjud `redact` qoidalari qamrab olishini test bilan isbotla.

## Bajarish tartibi

1. Birinchi commit: T1.3 test qarzi, mutatsiya dalillari bilan.
2. T1.4 kodi.
3. `pnpm verify` yashil.
4. Commit qil, push qil va PR och. To'rtala CI job yashil bo'lsin.
5. Hisobot: 20 qatorli savdo vaqti, chidamlilik testlari natijalari, C1–C2 dalillari. `[gemini-hisobot] T1.4` bilan commit qil va push qil.
6. `node .mezon/kutish.mjs` ni ishga tushir. Merge qilma.
