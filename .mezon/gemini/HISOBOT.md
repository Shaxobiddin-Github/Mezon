# Hisobot: T2.3 — Sinxron Push Yadrosi (Outbox Push Engine)

**Branch:** `gemini/T2.3-sync-push`  
**Kod commit:** `e372798`  

---

## 1. Nima qilindi

`GEMINI.md` 4-bo'limi ("Sinxron spetsifikatsiyasi") va `.mezon/claude/TOPSHIRIQ.md` dagi **P1–P5** majburiy talablari asosida to'liq Sinxron Push dvigateli yaratildi:

1. **Hub Yuboruvchi (`HubSyncPushWorker` — `apps/hub`):**
   - `local_outbox` dan `deviceSeq ASC` tartibida navbatma-navbat 100 tagacha hodisa (yoki 1 MB) paketlanadi (`sliceOutboxBatch`).
   - Muvaffaqiyatli (`accepted` va `duplicate`) hodisalar `local_outbox` da `status = 'acked'` deb belgilanadi.
   - Rad etilgan (`rejected`) hodisalar `local_outbox` da `status = 'rejected'` qilinadi va `local_sync_conflicts` jadvaliga chetlatiladi; navbat to'xtab qolmaydi.
   - P5: 401 javobi kelganda `DEVICE_REVOKED` / `DEVICE_BLOCKED` holatida ish darhol to'xtatilib, hub holati `revoked` ga o'tkaziladi. `TOKEN_EXPIRED` kelganda T2.2 rotatsiyasi orqali yangi token olinadi va push uzluksiz davom etadi. Tarmoq/5xx xatolarida eksponensial backoff (`1s -> 2s -> 4s -> ...`) ishlaydi.

2. **Bulut Qabul Qiluvchi (`CloudSyncPushStore` — `packages/db-cloud` & `apps/cloud`):**
   - `POST /api/v1/sync/push` endpointi: `Bearer <deviceToken>` orqali tenant va do'kon aniqlanadi, RLS kontekstida `withPgTenantContext` ochiladi.
   - Do'kon bo'yicha `pg_advisory_xact_lock(hashtext('store_sync:' || storeId))` olinib, har bir do'kon uchun qat'iy bo'shliqsiz `1..N` pozitsiyalar ta'minlanadi.
   - **P1: Har hodisa alohida `SAVEPOINT sp_event` ichida:** SQL darajasidagi xatolar (masalan FK yoki CHECK buzilishi) faqat shu savepoint'ni rollback qiladi, pozitsiya oshirilmaydi, qolgan yaxshi hodisalar to'xtovsiz qabul qilinadi.
   - **P2: Havolalar tekshiruvi va parking:** Begona tashkilotga havola aniqlanganda (`sync_check_cross_tenant_entity` orqali RLS chegarasini buzmagan holda tekshiriladi) darhol `rejected` bo'ladi. Shu tenant ichidagi hali kelib ulgurmagan ota yozuvga havola bo'lsa, `retry` qaytariladi va hodisa `cloud_sync_parked` ga joylanadi. Ota yozuv kelgach, keyingi urinishda muvaffaqiyatli qabul qilinadi.
   - **P3: MONOTONE holat o'tishlari:** `@mezon/contracts` dagi yagona `MONOTONE_TRANSITION_RULES` metadata'si orqali boshqariladi. Ruxsat etilgan o'tishlar `accepted`, qayta takrorlangan o'tishlar `duplicate`, taqiqlangan o'tishlar `rejected` (`INVALID_MONOTONE_TRANSITION`).
   - **P4: Qat'iy payload validatsiyasi:** Barcha 36 ta sinxronlanadigan jadvallar uchun `.strict()` Zod sxemalari orqali begona/ruxsatsiz maydonlar (masalan `users` ichida `pin_hash`) filtrlanadi va `VALIDATION_ERROR` bilan rad etiladi. `clientVersion < '1.0.0'` bo'lsa HTTP 426 Upgrade Required qaytariladi.
   - LOCAL jadvallar (18 ta lokal jadval) sinxron tizimiga kiritilmaydi, ularni yuborish urinishi `FORBIDDEN_TABLE_CLASS` bilan rad etiladi.

---

## 2. O'zgargan va yangi fayllar

- `packages/contracts/src/sync.ts` — 36 ta sinxronlanadigan jadvalning `.strict()` Zod sxemalari, `SYNC_FOREIGN_REFERENCES` va `MONOTONE_TRANSITION_RULES` metama'lumotlari, DTO'lar.
- `packages/contracts/src/sync.test.ts` — Sxemalar, strict validatsiya va monotoniya qoidalari uchun testlar.
- `packages/sync/src/index.ts` — `sliceOutboxBatch` (100 ta yoki 1 MB), HLC clamp va sinxron yordamchilari.
- `packages/sync/src/index.test.ts` — Batch kesish va HLC chegaralash testlari.
- `packages/db-local/src/outbox.ts` — `appendOutboxEventSync`, `listPendingOutboxBatch`, `markOutboxBatchResult`, `listConflicts`.
- `packages/db-local/src/schema/index.ts` & `drizzle/0015_sync_conflicts.sql` — `local_sync_conflicts` jadvali.
- `packages/db-cloud/src/sync-push-store.ts` — Advisory lock, savepoint'lar, RLS, havola tekshiruvi, LWW ATTR va gapless position dvigateli.
- `packages/db-cloud/drizzle/0003_sync_engine.sql` — `cloud_sync_events`, `cloud_store_sync_positions`, `cloud_sync_parked`, 36 ta domen jadvali va `sync_check_cross_tenant_entity` PostgreSQL funksiyasi.
- `apps/hub/src/sync-push-worker.ts` — Hub push worker, 401 ajratish, token rotatsiyasi va eksponensial backoff.
- `apps/hub/src/sync-push-worker.test.ts` — Hub worker unit testlari (5 ta test: acked, rejected conflict, 401 revoke, 401 token rotate, backoff).
- `apps/cloud/src/server.ts` — `POST /api/v1/sync/push` marshruti va minClientVersion (426) tekshiruvi.
- `apps/cloud/src/sync-push.test.ts` — Bulut dvigatelining 10 ta integratsiya testi (P1–P5, throughput benchmark).
- `.dependency-cruiser.cjs` — `@mezon/sync` bog'liqlik chegaralari yangilandi.

---

## 3. Qabul mezonlari va P1–P5 dalillari

### P1. Har hodisa alohida SAVEPOINT ichida
- **Dalil (`apps/cloud/src/sync-push.test.ts` - Test 3):**
  11 ta hodisali paket yuborildi. 6-hodisa SQL darajasida noto'g'ri (FK buzilishi: mavjud bo'lmagan foydalanuvchiga bog'langan).
  - 1..5 va 7..11 hodisalar: `status = 'accepted'`.
  - 6-hodisa: `status = 'rejected'`, `reason = 'SQL_ERROR'`.
  - `lastPosition` qat'iy ravishda 10 ga teng bo'ldi, `cloud_sync_events` dagi pozitsiyalar 1 dan 10 gacha **hech qanday bo'shliqsiz (gapless 1..10)** yozildi.
- **Mutatsiya dalili:** Agar `SAVEPOINT sp_event` va `ROLLBACK TO SAVEPOINT sp_event` olib tashlansa, 6-hodisadagi SQL xatosi butun PostgreSQL tranzaksiyasini yiqitadi va dastlabki 5 ta qabul qilingan hodisa ham bekor bo'ladi.

### P2. Noma'lum havola: begona tenant -> `rejected`, in-tenant yetib kelmagan -> `retry` va park
- **Dalil (`apps/cloud/src/sync-push.test.ts` - Test 4 & 5):**
  - Begona tenant IDsi ko'rsatilgan mahsulot kategoriyasi yuborilganda: `status = 'rejected'`, `reason = 'FOREIGN_ENTITY_MISMATCH'` qaytdi.
  - O'z tenantidagi hali push qilinmagan ota kategoriyaga (`parentId`) havola qiluvchi bola kategoriya push qilinganda: `status = 'retry'`, `reason = 'DEPENDENCY_MISSING'` qaytdi va hodisa `cloud_sync_parked` jadvaliga saqlandi.
  - Hub A ota kategoriyani push qilgach, Hub B qayta yuborganda: bola kategoriya muvaffaqiyatli `accepted` bo'ldi va `cloud_sync_parked` dan o'chirildi.
- **Mutatsiya dalili:** Agar `sync_check_cross_tenant_entity` tekshiruvi bo'lmasa, RLS boshqa tenant qatorlarini ko'rsatmagani sababli begona tenant qatori shunchaki "topilmadi" deb qabul qilinib, cheksiz `retry` navbatini hosil qilgan bo'lar edi.

### P3. MONOTONE o'tishlari umumiy metadata'dan
- **Dalil (`apps/cloud/src/sync-push.test.ts` - Test 6):**
  - Ruxsat etilgan o'tish (`orders`: `draft -> confirmed`) -> `status = 'accepted'`.
  - Takroriy o'tish (`orders`: `confirmed -> confirmed`) -> `status = 'duplicate'`.
  - Taqiqlangan o'tish (`orders`: `confirmed -> draft`) -> `status = 'rejected'`, `reason = 'INVALID_MONOTONE_TRANSITION'`.
  - Yopiq smena (`shifts`: `closed -> open`) -> `status = 'rejected'`, `reason = 'INVALID_MONOTONE_TRANSITION'`.
- **Mutatsiya dalili:** Agar `MONOTONE_TRANSITION_RULES` tekshiruvi bo'lmasa, soxta yoki kechikkan hodisa yopiq smenani qayta ochib yoki yetkazilgan buyurtmani bekor qilib yuborishi mumkin bo'lar edi.

### P4. Strict payload validatsiyasi va versiyalar
- **Dalil (`apps/cloud/src/sync-push.test.ts` - Test 7 & 9):**
  - Ortiqcha `pin_hash: 'evil_hash'` maydoni kiritilgan `users` hodisasi yuborildi -> Zod `.strict()` uni darhol aniqladi va `status = 'rejected'`, `reason = 'VALIDATION_ERROR'` qaytardi.
  - Noto'g'ri `schemaVersion: 999` bo'lgan hodisa -> `status = 'rejected'`, `reason = 'SCHEMA_VERSION_UNSUPPORTED'`.
  - `clientVersion: '0.9.0'` (eski versiya) bilan kelgan push so'rovi -> butun so'rov `HTTP 426 Upgrade Required` (`code: 'CLIENT_VERSION_UNSUPPORTED'`) bilan qaytarildi.

### P5. Hub'da 401 sabablarini ajratish
- **Dalil (`apps/hub/src/sync-push-worker.test.ts`):**
  - `401` + `code: 'DEVICE_REVOKED'` kelganda: Hub worker darhol to'xtadi (`isRunning() === false`), `local_cloud_state.status = 'revoked'` ga o'tdi.
  - `401` + `code: 'TOKEN_EXPIRED'` kelganda: Hub worker `/api/v1/devices/rotate-token` orqali yangi token oldi va navbatdagi push'ni uzluksiz muvaffaqiyatli yakunladi.
  - Tarmoq uzilishi (`ECONNREFUSED`): Eksponensial backoff `1000ms -> 2000ms -> 4000ms` bo'yicha oshib bordi.

---

## 4. O'tkazuvchanlik ko'rsatkichi (Throughput Benchmark)

`apps/cloud/src/sync-push.test.ts` dagi 10-test orqali 50 ta haqiqiy hodisadan iborat paket to'liq tranzaksiya, advisory lock, per-event savepoint, schema validatsiya va PostgreSQL yozuvlari bilan sinovdan o'tkazildi:

- **Benchmark natijasi:**  
  `Sync Push Throughput Benchmark: 50 events processed in 216.63ms (~231 events/sec)`
- **Talab:** `> 100 events/sec` (benchmark 231 events/sec bilan talabni 2.3 barobar ortig'i bilan bajardi).

---

## 5. To'liq verification natijalari

`pnpm verify` buyrug'ining barcha 7 bosqichi 100% yashil o'tdi:

```text
$ pnpm verify
1. prettier --check .          --> All matched files use Prettier code style!
2. turbo run build             --> 17 successful, 17 total (0 errors)
3. node scripts/lint-workspaces --> 0 errors, 0 warnings
4. turbo run typecheck         --> 17 successful, 17 total (0 errors)
5. turbo run db:check          --> SQLite schema matches (0 diff) & PostgreSQL schema matches (0 diff)
6. pnpm run test:
   - test:unit + sqlite-hub    --> 72 test files passed, 396 tests passed (100% green)
   - test:perf                 --> 9 test files passed, 12 tests passed (all <= 300ms SLA met)
   - test:e2e:pos (Playwright) --> 1 passed (13.4s)
7. depcruise                   --> no dependency violations found (420 modules, 1800 dependencies cruised)
```

---

## 6. Xulosa va keyingi qadam

T2.3 topshirig'i barcha mezonlar va P1–P5 talablari bilan to'liq yakunlandi.
Hech qanday tashqi kutubxona noqonuniy kiritilmadi, domen chegaralari buzilmadi.
Claude'ning tekshiruvi uchun topshirilmoqda. `QABUL` berilmaguncha merge qilinmaydi.
