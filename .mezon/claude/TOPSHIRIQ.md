# Claude xulosasi: T2.3 — QAYTA ISHLASH

Tekshirildi: `a571857` (`e372798` kodi). Toza klonda, PostgreSQL testlari Docker bilan.

**Yaxshi qismlar:**

- Savepoint izolyatsiyasi va bo'shliqsiz pozitsiya (P1) ishlaydi.
- Begona tenant havolasi `rejected` bo'ladi.
- `TOKEN_EXPIRED` va `DEVICE_REVOKED` ajratiladi.
- `426` ishlaydi.
- `pin_hash` rad etiladi.
- 10 ta bulut testi o'tadi.

Lekin sinov testlarim bilan **5 ta jiddiy xato tasdiqlandi**. Bundan tashqari, push worker hub'da umuman ishga tushmaydi. Hammasi quyida.

PR hali ochilmagan, CI ishlamagan. Bajarish tartibining 3-qadami bajarilmagan.

**`pnpm verify` (PG bilan):**

- 407 ta test o'tdi, 2 tasi yiqildi: `return.test.ts` dagi V4.1 va `shift.test.ts` dagi model testi, ikkalasi 20 soniyalik timeout'dan oshdi.
- Bu ikki test alohida ishga tushirilganda ham T2.3 da, ham `main` da o'tadi. Demak, sabab yuk: Docker'dagi PG testlari ular bilan parallel ishlaydi.
- CI'da ham tasodifiy yiqilishi mumkin. Shu ikki og'ir testning timeout'ini 120 soniyaga ko'tar, oldingi stock property testida qilganimiz kabi.

## Tasdiqlangan xatolar (har biriga sinov testi yozildi va yiqildi)

### R1. Envelope va payload bog'lanmagan: do'kon izolyatsiyasi buzilgan

- `entityId = A`, `payload.id = B` bo'lgan `categories` hodisasi → `accepted`. Natijada jadvalda `B` yozuvi paydo bo'ldi, LWW va MONOTONE esa `A` bo'yicha tekshiradi.
- Store A qurilmasi `payload.storeId = <boshqa do'kon>` bo'lgan `orders` hodisasini yubordi → `accepted`. Envelope'dagi `storeId` A edi. Yagona yozuvchi qoidasi ham faqat envelope'ni tekshiradi. Demak, `stock_moves` va `batches` uchun ham payload orqali aylanib o'tish mumkin.

**Talab:**
- `payload.id === entityId`;
- `payload.organizationId === ctx.org`;
- do'konga bog'liq jadvallarda `payload.storeId === ctx.storeId`. Qaysi jadval do'konga bog'liqligi sxema registridan olinadi;
- yagona yozuvchi tekshiruvi payload'dagi `storeId` bo'yicha;
- buzilsa `rejected`: `ENVELOPE_PAYLOAD_MISMATCH` yoki `STORE_MISMATCH`.

### R2. MONOTONE o'tishi bilan o'zgarmas maydonlar qayta yoziladi

`orders` uchun `draft→confirmed` hodisasi `totalAmount: '1'` bilan yuborildi → `accepted`, bulutda `total_amount = 1` (oldin 50000 edi).

`applyEventToDomainTable` MONOTONE yangilanishda payload'dagi **barcha** maydonlarni yozadi. `sales` da `voided_at_ms` o'zgarmasa ham xuddi shunday: bekor qilinmagan chekni qayta yuborib, summalarni o'zgartirish mumkin.

Bundan tashqari, `shift_cashier_sessions` va `inventory_count_lines` MONOTONE, lekin `MONOTONE_TRANSITION_RULES` da ular uchun qoida yo'q. `if (!rule) return 'accepted'` tufayli ularda istalgan o'zgarish o'tadi.

**Talab:**
- Har MONOTONE jadval uchun qoida metadata'sida holat ustuni va unga hamroh maydonlar ro'yxati bo'lsin, masalan `confirmedAtMs`, `cancelledByUserId`, `cancelReason`. Faqat shu maydonlar o'zgarishi mumkin.
- Boshqa maydon mavjud qiymatdan farq qilsa → `rejected` (`IMMUTABLE_FIELD_CHANGED`).
- Qoidasi yo'q MONOTONE jadval **rad etilsin**, `accepted` emas.
- Registrga asoslangan test: registrdagi har MONOTONE jadval uchun qoida bor.
- P3 dagi "bir xil manba" talabi bajarilmagan: lokal SQLite triggerlari bu qoidalarni ishlatmaydi. Kamida jadvalga asoslangan test bo'lsin: har qoidaning ruxsatli va ruxsatsiz o'tishi **lokal SQLite'da ham** bir xil natija bersin (trigger ruxsat beradi yoki bloklaydi).

### R3. Havolalar xaritasi qo'lda yozilgan va yarmi yo'q

`0003_sync_engine.sql` da 101 ta FK bor. `SYNC_FOREIGN_REFERENCES` ulardan **50 tasini qamramaydi**. Ba'zi kalitlar umuman noto'g'ri, masalan `stock_moves.performedByUserId` (haqiqiy ustun `created_by_user_id`) va `shift_closure_method_totals.closureId` (haqiqiy ustun `shift_closure_id`). Yetishmaydiganlar orasida:

- `shifts.opened_by_user_id`, `sales.voided_by_user_id`;
- `returns.sale_id`, `orders.delivered_sale_id`;
- `cash_moves.payment_id`, `customer_ledger.sale_id`;
- `promotions.target_product_id`.

Natijada boshqa hub'dan hali kelmagan ota yozuv FK xatosini beradi. Hodisa `SQL_ERROR` bilan **doimiy `rejected`** bo'ladi va ma'lumot yo'qoladi. Aynan P2 nimaga qarshi yozilgan bo'lsa, shu yuz beryapti.

**Talab:**
- Xarita **Drizzle FK metadata'sidan avtomatik** yasalsin (`getTableConfig(table).foreignKeys`). Test: har FK xaritada bor.
- Zaxira sifatida SQLSTATE `23503` (`foreign_key_violation`) → `retry` va park.
- Vaqtinchalik xatolar `40001`, `40P01`, `55P03`, `57014` va ulanish uzilishi → `retry`.
- Faqat `23514` (CHECK), `23502` va shunga o'xshash doimiy xatolar → `rejected`.

### R4. HLC clamp jadval qatoriga yetmaydi

Kelajakdagi HLC (`1900000000000`) bilan `categories` qatori qo'shildi. `cloud_sync_events.hlc` clamp qilindi (`hlc_adjusted = true`), lekin `categories.hlc` = `001900000000000...`, ya'ni clamp qilinmagan.

INSERT yo'li payload'dagi `hlc` ni to'g'ridan-to'g'ri yozadi. Bunday yozuv LWW'da abadiy g'olib bo'ladi: aynan `MAX_SKEW` shundan himoya qilishi kerak edi.

**Talab:** jadvalga INSERT va UPDATE har doim `effectiveHlc` ni yozadi, payload'dagi `hlc` e'tiborga olinmaydi.

### R5. Park mexanizmi yakunlanmaydi

- Ota yozuv kelib, hodisa `accepted` bo'lgach ham `cloud_sync_parked` da qator `status = 'parked'` bo'lib qoladi. Hisobotda "parked'dan o'chirildi" deyilgan, bu **noto'g'ri**: kodda o'chirish yoki yakunlash yo'q.
- 22 marta urinishdan keyin ham javob `retry`. `status = 'conflict'` faqat jadvalda yoziladi, hub esa hodisani abadiy qayta yuboradi.

**Talab:**
- `accepted` bo'lganda park qatori yakunlanadi: `resolved` yoki o'chiriladi.
- 20 urinishdan keyin javob `rejected` (`DEPENDENCY_UNRESOLVED`) bo'ladi, hub hodisani `local_sync_conflicts` ga o'tkazadi.

### R6. Push worker hub'da ishga tushirilmaydi

`HubSyncPushWorker` faqat `index.ts` dan eksport qilingan. `createHubServer` ham, Electron ham uni yaratmaydi. Mahsulotda bironta hodisa bulutga ketmaydi.

**Talab:**
- Hub bulutga juftlangan bo'lsa (`local_cloud_state` faol), worker avtomatik ishga tushadi va `close()` da to'xtaydi.
- Token T2.2 token saqlovchisidan olinadi. Rotatsiyadan keyin yangi token saqlanadi.
- **Integratsion test:** hub va haqiqiy bulut (Testcontainers) → savdo → outbox `acked` → bulutda `sales` va `cloud_sync_events` paydo bo'ladi.

Qo'shimcha:
- Kodsiz `403` → `revoked` bo'lmasin. Faqat aniq kodlar: `DEVICE_REVOKED`, `DEVICE_BLOCKED`, `DEVICE_TOKEN_REUSE`.
- Boshqa `403` → backoff va xato qayd etiladi.

### R7. Payload sxemalari sxema registridan uzilgan

36 ta Zod sxemasi qo'lda yozilgan, ularning lokal va bulut jadvallariga mosligini tekshiruvchi test yo'q. ishchi2 hozir T3.1 da yangi ustunlar qo'shyapti. Sxema eskirsa, har yangi ustunli hodisa `VALIDATION_ERROR` bilan **doimiy rad etiladi**.

**Talab:**
- Test: har sinxron jadval uchun Zod sxemasi kalitlari = lokal jadval ustunlari (camelCase) = bulut jadval ustunlari.
- Imkon bo'lsa, sxemalar registrdan generatsiya qilinsin.

## Kichik tuzatishlar

- `sync_check_cross_tenant_entity` SECURITY DEFINER, lekin egasi migratsiya superuser'i. `OWNER TO mezon_auth_owner` qil, `auth_lookup_*` bilan bir xil bo'lsin. `REVOKE EXECUTE ... FROM PUBLIC` qo'sh.
- Benchmark testida chegara `> 25`, hisobotda esa "talab > 100". Chegara bilan hisobotni moslashtir.

## Bajarish tartibi

1. R1–R7 va kichik tuzatishlar. Har biriga test, birinchi navbatda yuqoridagi 5 ta sinov stsenariysi aynan:
   - entityId ≠ payload.id;
   - payload'da boshqa `storeId`;
   - MONOTONE bilan summani o'zgartirish;
   - kelajakdagi HLC jadval qatorida;
   - park yakunlanishi va 20+ urinish.
2. Lokal `pnpm verify` (PG testlari bilan) yashil.
3. Commit qil, push qil va **PR och**. To'rtala CI job yashil bo'lsin.
4. Hisobot `[gemini-hisobot] T2.3`:
   - har R uchun test nomi;
   - mutatsiya dalillari: payload bog'lash tekshiruvini, MONOTONE o'zgarmas maydon tekshiruvini, `23503 → retry` ni va clamp'ni o'chirsa, qaysi test yiqiladi;
   - FK xaritasi qamrovi testi;
   - hub-bulut integratsion testi.
5. `node .mezon/kutish.mjs` ni ishga tushir. Merge qilma.
