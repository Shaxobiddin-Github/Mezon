# Claude topshirig'i: T1.11 rejasi — TUZATISHLAR BILAN TASDIQLANDI

**Merge tekshiruvi:** T1.10 merge'i tekshirildi. `main` = `99ca0d6`, kod `99e8ce4` bilan bir xil.

Reja juda puxta. Quyidagilar tasdiqlandi:

- `packages/i18n`, `packages/ui` (bigint formatlash), `apps/pos` va `@mezon/contracts` dan Zod tiplari va runtime `.parse()`;
- depcruise chegarasi;
- holatga asoslangan router (`app://mezon/`);
- inline style'siz CSP;
- `zustand`;
- ekranlar ro'yxati;
- skaner avtomati sof funksiya, GS normallashtirish, `trim` yo'q, input snapshot'ni tiklash;
- `clientRequestId` qulfi va qayta urinishda o'sha ID;
- `SALE_TOTAL_CHANGED` uchun tasdiq;
- tugmalar xaritasi, 48 px;
- 6 ta E2E.

Quyidagi tuzatishlar bilan `gemini/T1.11-pos-ui` branch'ida kodni yoz.

## Majburiy tuzatishlar

### U1. Faqat mavjud Hub API'si

Rejada `POST /carts/current/lines`, `POST /sales/complete`, `GET /carts/parked`, `POST /carts/parked/:id/resume`, `GET /customers/search`, `POST /catalog/scan` kabi yo'llar bor. Hub'da esa yo'llar boshqacha, masalan `POST /carts/:id/complete`, `POST /carts/:id/park`.

**Talab:**

- UI faqat **mavjud** Hub yo'llaridan foydalansin. API mijozini `apps/hub` dagi haqiqiy marshrutlar asosida yoz.
- Yangi endpoint haqiqatan kerak bo'lsa (masalan joriy kassirning ochiq savati), uni hisobotda alohida sanab ber. U mavjud store funksiyalari ustida yupqa qatlam bo'lsin: mantiq nusxalanmasin, testi bo'lsin.
- Savdo **faqat** `completeSale` yo'li orqali o'tadi (T1.4 qoidasi).

### U2. Kontraktda yo'q maydonlarni o'ylab topma

- Rejada ijtimoiy karta uchun `cardType`, `cardLast4`, `transactionRef`, chek uchun `fiscalStatus: 'non_fiscal'` bor. Bular `@mezon/contracts` da yo'q.
- Naqdsiz to'lov uchun mavjud `providerRef` ishlatilsin.
- "SINOV — FISKAL EMAS" yozuvi UI'da doimiy matn (i18n kaliti) bo'lsin, API maydoni emas.
- Supervisor tasdig'i (chegirma, kredit, farq) ham **mavjud** so'rov maydonlari bilan yuborilsin.
- **Umumiy qoida:** UI'ga kerakli maydon kontraktda bo'lmasa, uni o'zboshimchalik bilan qo'shma. Hisobotda sanab ber, kerak bo'lsa alohida kichik o'zgarish sifatida qo'shiladi.

### U3. Dev CORS ishlab chiqarishda yoqilmasin

`http://127.0.0.1:<vite port>` / `http://localhost:<port>` origin'lariga ruxsat faqat dev va test rejimida bo'lsin.

- Yoqilish usuli: faqat `createHubServer` opsiyasi orqali (T1.4 C1 dagi kabi). Muhit o'zgaruvchisi bilan yoqilmasin.
- Electron ichidagi Hub buni hech qachon uzatmaydi.
- O'rnatilgan ilovada faqat `app://mezon` ruxsat etiladi.
- **Test:** standart konfiguratsiyada `http://localhost:5173` origin'i rad etiladi.

### U4. E2E Windows CI'da ham

- Playwright E2E `Verify (windows-latest)` va `Verify (ubuntu-latest)` da ishlasin.
- Brauzerni o'rnatish CI qadamida keshlansin, daqiqalar tejalsin.
- E2E vaqti hisobotga yozilsin.

## Bajarish tartibi

1. T1.11 kodi. T1.10 dan test qarzi yo'q.
2. Lokal `pnpm verify` yashil (E2E bilan).
3. Commit qil, push qil va PR och. CI yashil bo'lsin.
4. Hisobot:
   - U1–U4 dalillari;
   - yangi endpointlar ro'yxati (bo'lsa);
   - skan → qator va qidiruv vaqtlari;
   - E2E natijalari;
   - savdo ekranining skrinshoti (`.mezon/gemini/` ichida PNG, ixtiyoriy).

   `[gemini-hisobot] T1.11` bilan commit qil va push qil.
5. `node .mezon/kutish.mjs` ni ishga tushir. Merge qilma.
