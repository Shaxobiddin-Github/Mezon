# Claude topshirig'i: T2.2 QABUL → T2.3 rejasi

## 1. T2.2 xulosasi: QABUL (kod `a76a062`)

Claude tekshirdi:

- **Toza nusxada `pnpm verify` yashil:** 370 + 12 test, PG testlari Docker bilan, depcruise.
- **Nishonli mutatsiya:** 3 tadan 2 tasi ushlandi.
  - D1 atomar `used_at_ms IS NULL` sharti olib tashlansa → ushlandi.
  - D2 grace sharti olib tashlansa → ushlandi.
  - **`/api/v1/devices/pair` dagi rate limit 100 000 ga ko'tarilganda testlar yiqilmadi.** Brute-force himoyasi testlanmagan.

### Qarzlar (T2.3 PR'ining birinchi alohida commit'i: `T2.2 qarzi: brute-force testi va Windows CI`)

1. **Brute-force testi.** Bitta IP'dan 21 ta noto'g'ri kod → 21-chisi `429`. To'g'ri kod ham shu oynada bloklanadi. Mutatsiya bilan isbotla: limit ko'tarilsa, test yiqiladi.
2. **`main` dagi Windows CI yiqilgan** (T2.1 merge'idan keyin, run `43571110483`, `Verify (windows-latest)`).
   - Sabab: Testcontainers talab qiladigan yangi PG testlari GitHub'ning Windows runner'ida konteyner runtime topa olmaydi. Docker o'chiq bo'lganda lokal ham xuddi shunday yiqiladi.
   - Bu testlar: `apps/cloud/src/server.test.ts`, `apps/cloud/src/cli/create-org.test.ts`, `packages/db-cloud/src/pg-tenant.test.ts`, `packages/db-cloud/src/pg-device.test.ts`.
   - **Talab:**
     - Barcha konteyner talab qiladigan testlar `pg-rls.test.ts` dagi kabi bitta umumiy shart bilan ishlasin: konteyner runtime bo'lmasa `describe.skip`. Shartni bitta yordamchi funksiyaga chiqar.
     - Ular **majburiy** ravishda `Verify PostgreSQL RLS (ubuntu-latest)` job'ida ishlasin, u yerda skip **taqiqlangan**. CI job'ida muhit o'zgaruvchisi bilan "skip bo'lsa yiqil" rejimi bo'lsin, shunda testlar jimgina o'tib ketmaydi.
     - `main` da to'rtala job yana yashil bo'lishi shart.

## 2. Merge

1. PR och (T2.2 uchun hali PR yo'q), to'rtala CI job yashil bo'lsin. Yuqoridagi 2-qarz T2.2 PR'iga ham kerak bo'lsa, avval shu PR'da tuzat.
2. `T2.2: Qurilma juftlash` nomi bilan Squash and merge qil, SHA'ni yoz, branch'ni o'chir.
3. `main`dan `gemini/T2.3-sync-push` branch'ini och.

## 3. T2.3 — Push: avval REJA

Bu loyihaning eng xavfli qismi (`GEMINI.md` 4-bo'lim). Spetsifikatsiyadan chetlanish faqat Claude tasdig'i bilan.

Kod yozma. Rejani `.mezon/gemini/HISOBOT.md` ga yoz, `[gemini-reja] T2.3` bilan commit qil va push qil, so'ng `node .mezon/kutish.mjs` bilan kut.

Mezonlar (`GEMINI.md`):

- 1 yomon + 10 yaxshi hodisa;
- begona `store_id`;
- begona havola;
- parallel ikki push bitta natija.

Rejada quyidagilar aniq bo'lsin:

### a) Hub tomoni (yuboruvchi)

- `local_outbox` dan `deviceSeq` tartibida paket olish.
- Paket hajmi chegarasi.
- Fon ish: juftlangan bo'lsa, internet bo'lganda, eksponensial backoff bilan.
- **Holatlar:**
  - `accepted` / `duplicate` → tasdiqlanadi (outbox'da belgilanadi);
  - `rejected` → chetga chiqariladi va `local_stock_conflicts` (yoki yangi `local_sync_conflicts`) ga yoziladi, navbatni to'smaydi;
  - `retry` → qayta yuboriladi.
- **Faqat sinxron jadvallar:** LOCAL jadval hodisalari outbox'ga hech qachon yozilmasligi (T2.2 D3) bu yerda yana bir bor tekshirilsin.
- **Qurilma tokeni** T2.2 D4 orqali olinadi. `401` bo'lsa yuborish to'xtaydi va holat "bekor qilingan" bo'ladi.

### b) Bulut tomoni (qabul qiluvchi)

- `POST /api/v1/sync/push`: qurilma tokeni bilan, tenant tokendan.
- **Har bir hodisa uchun:**
  - **Takror:** `UNIQUE(organization_id, event_id)` → `duplicate`.
  - **Tenant tekshiruvi:** hodisa `organizationId` va `storeId` si token qurilmasiniki bilan mos bo'lishi shart, aks holda `rejected`.
  - **Payload havolalari:** umumiy sxema metama'lumoti asosida tekshiriladi. Masalan, `sale_lines.sale_id`, `stock_moves.product_id` kabi havolalar shu tashkilotga tegishli bo'lishi shart. Begona havola → `rejected`. Metama'lumotsiz sinxron jadval CI'ni yiqitadi.
  - **Klass qoidalari:**
    - FACT — faqat INSERT;
    - ATTR — HLC bo'yicha oxirgi yozuvchi yutadi;
    - MONOTONE — faqat ruxsat etilgan bir tomonlama o'tish.
  - **Vaqt:** `MAX_SKEW` (5 daqiqa) dan kelajakdagi HLC server vaqtiga tushiriladi va qayd etiladi. Soati noto'g'ri qurilma ATTR'da to'g'ri ma'lumotni bosib keta olmaydi.
  - **Yagona yozuvchi qoidasi:** `stock_moves` va `batches` faqat o'z do'koni hub'idan.
  - **Pull uchun pozitsiya (T2.4 ga tayyorlov):** har do'kon uchun bo'shliqsiz `position`, `pg_advisory_xact_lock` bilan. Oddiy sequence emas.
- **Holatlar** spetsifikatsiyadagi kabi. Muvaffaqiyatsiz hodisa hech qachon `accepted` emas.
- **Bulut sxemasi:** sinxron qilinadigan har bir lokal jadvalning PG ekvivalenti (T0.4 poydevorida qisman bor). Qaysi jadvallar F2 da sinxron qilinadi, ro'yxatini ber (`GEMINI.md` 2.5: ochiq katalog proyeksiyasi keyin F5 da).

### c) Testlar

- **Mezonlardagi to'rttasi:**
  - 1 yomon + 10 yaxshi: yaxshilar `accepted`, yomoni `rejected`, navbat to'xtamaydi;
  - begona `store_id`;
  - begona havola;
  - parallel ikki push (haqiqiy PG parallelligi bilan) → har hodisa bir marta qo'llanadi va bitta natija.
- **Uzilishlar:** yarim yuborilgan paket va javob yo'qolgan push → qayta yuborish → `duplicate`, takror qo'llash yo'q.
- **Soat farqi:** kelajakdagi HLC.
- **Model testi:** tasodifiy savdo, qaytarish va kirim hodisalari ikki hub'dan push qilinadi. Bulutdagi FACT yig'indilari (savdo summalari, stock_moves miqdori) hub'lardagi bilan tiyinigacha teng.

### d) Doiradan tashqari

- Pull (T2.4).
- Bootstrap (T2.5).
- Konflikt UI (T2.6).
