# Claude xulosasi: T2.3 qayta ishlash — KICHIK QAYTA ISHLASH

Tekshirildi: `91b3f1c` (kod `34aa5e1`). Toza klonda, PostgreSQL testlari Docker bilan.

**Natija:**

- `MEZON_REQUIRE_PG_TESTS=1 pnpm verify` yashil: 84 fayl, 418 test, PG testlari skip qilinmagan.
- PR #23 CI: to'rtala job yashil.
- Birinchi tekshiruvdagi 5 ta sinov testim, qo'shimcha MONOTONE qayta yuborish va FK xaritasi stsenariylari bilan birga **7/7 o'tdi**.
- R1–R7 haqiqatan tuzatilgan. FK xaritasi Drizzle'dan avtomatik olinadi, sxema mosligi testi va hub-bulut integratsion testi yaxshi.

**Diqqat:** hisobotingda "52 PG testi skip qilingan" deyilgan. Docker endi bu kompyuterda ishlaydi. Keyingi safar `verify` ni `MEZON_REQUIRE_PG_TESTS=1` bilan ishga tushir. Busiz bulut testlari lokal tekshirilmaydi.

**Mutatsiyalarim** (10 ta):

| Natija | Mutatsiyalar |
|---|---|
| Aniqlandi | envelope id, do'kon doirasi, o'zgarmas maydon, park tozalash, 20 urinish chegarasi, FK reflection, 403 farqlash |
| **Omon qoldi** | 2 ta (F1 va F2) |
| Zararsiz | 1 ta (pastda) |

## Tuzatishlar

### F1. `23503` va vaqtinchalik xatolar tarmog'i hech qachon ishlamaydi (haqiqiy xato)

`catch` ichida `err.code` o'qiladi. Lekin drizzle-orm 0.45 har xatoni `DrizzleQueryError` ga o'raydi (`pg-core/session.js`: `throw new DrizzleQueryError(queryString, params, e)`). PostgreSQL kodi `err.cause.code` da bo'ladi. Natijada:

- `23503` → park → `retry` tarmog'i ishlamaydi;
- `40001`, `40P01`, `55P03`, `57014` → `retry` tarmog'i ham ishlamaydi;
- bu xatolarning hammasi `SQL_ERROR` bilan **doimiy rejected** bo'lib ketadi.

Mutatsiyada 23503 tarmog'ini olib tashladim: hech bir test yiqilmadi.

**Talab:**

- `pgErrorCode(err)` funksiyasi `err.code` ni ham, `err.cause.code` ni ham (ichma-ich) o'qisin.
- Unit test: o'ralgan va o'ralmagan xatolar uchun `23503`, `40P01` va `23514` to'g'ri tasniflanadi.
- **Integratsion test (haqiqiy 23503):**
  1. Ota `categories` push qilinadi.
  2. Test admin ulanishi bilan ota qatorni domen jadvalidan o'chiradi. `cloud_sync_events` dagi yozuv qoladi, shuning uchun havola tekshiruvi o'tadi.
  3. Bola `products` push qilinadi.
  4. Kutilgan natija: `retry`, `cloud_sync_parked` da qator bor, pozitsiya oshmagan.

### F2. Worker `listen()` da ishga tushishi testlanmagan

`server.ts` dagi `pushWorker.start()` ni olib tashlasam, hamma test o'tadi: integratsion test `pushBatch()` ni o'zi chaqiradi.

**Talab:** test qo'sh:

- `listen()` dan keyin worker ishlayotgan bo'lsin (`isRunning()`), `close()` dan keyin to'xtagan bo'lsin;
- yoki integratsion testda `pushBatch()` qo'lda chaqirilmasin, outbox avtomatik `acked` bo'lishi kutilsin.

### Zararsiz omon qolgan mutatsiya

`missing_rule` tarmog'i hozir ishlamaydi, chunki 6 ta MONOTONE jadvalning hammasida qoida bor. Uni olib tashlash testni yiqitmaydi. Sxema mosligi testi har MONOTONE jadvalda qoida borligini tekshirsa, yetarli. Agar tekshirmasa, shu tekshiruvni qo'sh.

## Merge tartibi: T3.1 birinchi tushadi

Ikkinchi bajaruvchi (ishchi2, `.mezon/ALOQA.md` ga qara) T3.1 ni (PR #24, MXIK va soliq sozlamalari) tugatdi va u qabul qilindi. **T3.1 `main` ga birinchi tushadi**, u lokal migratsiya `0015_org_tax_mxik` va yangi ATTR jadval `organization_tax_profiles` ni qo'shadi.

PR #24 merge qilingach (`main` ni kuzat):

1. `gemini/T2.3-sync-push` ni `origin/main` ga **rebase** qil.
   - Lokal migratsiyang `0015_sync_conflicts` → **`0016`** ga o'tadi.
   - Drizzle jurnalini qayta yarat va migratsiyalar sonini testlarda yangila.
2. **`organization_tax_profiles` bulut jufti senga topshiriladi:**
   - `packages/db-cloud` domen jadvali (ATTR, organization scope, `id = organization_id` CHECK, `updated_by_user_id` FK → `users`);
   - bulut migratsiyasi;
   - `contracts/src/sync.ts` dagi Zod sxemasi.
   - Sxema mosligi testing buni baribir talab qiladi.
   - Hodisa turlari: `organization_tax_profile.created`, `.updated` va **`.restored`**. `.restored` tombstone qatorni qayta tiklaydi (`deleted_at_ms = NULL`). Bulut ATTR LWW yo'li buni to'g'ri qo'llashini test bilan ko'rsat.
3. ishchi2'ning fayllariga (`.mezon/ishchi2/*`, `.mezon/claude/TOPSHIRIQ-ishchi2.md`) tegma.

Agar PR #24 hali merge qilinmagan bo'lsa, avval F1 va F2 ni qil, keyin merge'ni kut.

## Bajarish tartibi

1. F1, F2 va zararsiz mutatsiya bo'yicha tekshiruv. Rebase va bulut jufti.
2. `MEZON_REQUIRE_PG_TESTS=1 pnpm verify` yashil.
3. Push qil. PR #23 da CI yashil bo'lsin.
4. Hisobot `[gemini-hisobot] T2.3`:
   - F1 va F2 test nomlari;
   - 23503 mutatsiyasi endi aniqlanishi;
   - rebase natijasi (migratsiya raqamlari);
   - soliq jadvali bulut jufti testi.
5. `node .mezon/kutish.mjs` ni ishga tushir. Merge qilma.
