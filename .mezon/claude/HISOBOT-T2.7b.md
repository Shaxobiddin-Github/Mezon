# Hisobot: T2.7b (1-qism) — kabinetdan narx o'zgartirish (Claude)

Branch: `claude/C4-cabinet-writes`. U **P1 ustida** (stacked) ochilgan, chunki `CloudEventWriter` P1 da. Merge tartibi: P1 → C2 → bu.

## Qanday ishlaydi

Kabinet bulut jadvallariga **to'g'ridan-to'g'ri yozmaydi**. Har o'zgarish oddiy sinxron hodisa bo'lib, ishchi2 ning `CloudEventWriter` i orqali o'tadi:
- tekshiruv hub push'i bilan bir xil;
- tashkilot oqimiga (`store_id = organization_id`) yoziladi;
- hamma kassalar uni oddiy pull bilan oladi;
- LWW hamma joyda bir xil ishlaydi.

**`POST /api/v1/admin/products/:id/price`** `{ newPrice: tiyin, reason? }` uchta hodisa yozadi:
1. Kerak bo'lsa (faqat bir marta) "kim" uchun foydalanuvchi qatori.
2. `product.updated`: to'liq qator, yangi `salePrice` bilan.
3. `price_change.recorded`: eski va yangi narx, kim, sabab.

**Kim o'zgartirdi.**
- Kabinet logini hub foydalanuvchisiga bog'langan bo'lsa (`cloud_users.hub_user_id`), o'sha foydalanuvchi yoziladi.
- Bog'lanmagan bo'lsa, bir marta `users` qatori yaratiladi: `Kabinet: <login>`, `is_active = false`.
- Bu qatorning PIN'i yo'q (PIN faqat hub'da saqlanadi), shuning uchun kassaga **hech qachon kira olmaydi**. U faqat yozuvni nomlash uchun.

**Ruxsat.**
- Bearer access token kerak (boshqa admin route'lar kabi).
- Har yozishda rol va holat **bazadan qayta o'qiladi**. Token hali amal qilsa ham, bloklangan menejer → 403.
- Boshqa tashkilot mahsuloti → 404 (RLS).
- Varianti bor mahsulot → 400: variant narxi kassada o'zgartiriladi, buni keyingi qismda qo'shaman.
- Narx chegarasi: 0 dan 10 mlrd so'mgacha (xato terishdan himoya).

**`GET /api/v1/admin/products/:id/price-changes`**: narx tarixi, kim o'zgartirgani bilan.

**Kabinet UI.** "Mahsulotlar" bo'limi:
- qidiruv;
- narx va qoldiq;
- "Narxni o'zgartirish" (so'mda kiritiladi, tiyin aniq: `parseSomToTiyin`);
- narx tarixi.

Matnlar uz-Latn va ru da.

## Testlar

| Fayl | Nima |
|---|---|
| `apps/cloud/src/cabinet.test.ts` (PG, 4 ta) | (1) Ega narxni o'zgartiradi: mahsulot, `price_changes` (kim = ega), faol bo'lmagan kabinet foydalanuvchisi, tashkilot oqimida `users` → `products` → `price_changes` tartibi, tarix endpoint'i. (2) O'sha narx yana → o'zgarish yo'q. Ikkinchi o'zgarishda foydalanuvchi qayta yozilmaydi (`users` hodisasi = 1). (3) Hub foydalanuvchisiga bog'langan login o'sha foydalanuvchi nomidan yozadi, yangi qator yaratilmaydi. (4) Rad etiladi: boshqa tashkilot, noto'g'ri narx (5 xil), variantli mahsulot, token amaldagi bloklangan menejer; mahsulotlar o'zgarmaydi. |
| `apps/hub/src/hub-cloud-sync.integration.test.ts` (+1) | **Kassagacha:** kabinet hodisalari → hub `pullBatch` → hub SQLite'da yangi narx, `price_changes` (kim, sabab) va `is_active = 0` kabinet foydalanuvchisi. Park yoki ochiq konflikt yo'q. |
| `apps/admin/src/i18n-ui.test.ts` (+1) | `parseSomToTiyin`: `12 500`, `12500,05` va hokazo; manfiy, 3 xonali tiyin, `1e5` rad etiladi. Barcha UI matnlari `t()` dan (mavjud skaner testi). |

## Mutatsiyalar: 7/7 o'ldi

| # | Mutatsiya | Natija |
|---|---|---|
| K1 | bloklangan foydalanuvchi yoza oladi | o'ldi |
| K2 | hub foydalanuvchisiga bog'lanish e'tiborsiz | o'ldi |
| K3 | kabinet foydalanuvchisi faol | o'ldi |
| K4 | o'sha narx ham o'zgarish deb yoziladi | o'ldi |
| K5 | yuqori chegara yo'q | o'ldi |
| K6 | variantli mahsulot ruxsat | o'ldi |
| K7 | kabinet foydalanuvchisi har safar qayta yoziladi | birinchi variantda **omon qolgan**, test kuchaytirildi → o'ldi |

## Tekshirilmagan qism

Kabinet UI brauzerda ko'z bilan ko'rilmagan, chunki kabinetni bulut serveri bilan ishga tushirish kerak. Typecheck, lint va i18n skaneri yashil.

## Keyingi qismlar (T2.7b davomi)

- variant narxi;
- xodimlar va ruxsatlar;
- qurilmalar (bekor qilish);
- bulutdagi kutayotgan hodisalar (konfliktlar) kabinetda;
- ombor ko'rinishi.

## Tekshiruv

`pnpm verify` (`MEZON_REQUIRE_PG_TESTS=1`): yashil — format, build, keshsiz lint, typecheck, `db:check`, 122 fayl / 838 test, perf 17, POS E2E, depcruise (569 modul).

## QOLDI (WIP, limit tugadi)

- v1: `deploy/Dockerfile` butun workspace'ni yig'adi (avval `sync`, `i18n`, `ui` yo'q edi, server yig'ilmas edi); Caddy kabinetni va API'ni bitta domenda xizmat qiladi; compose Telegram va domenni uzatadi; `org:create` endi standart parolsiz.
- **Tekshirilmagan:** `docker build` (runner va web) qayta yugurtirilmoqda edi. Birinchi urinish tarmoq timeout'i bilan yiqildi (pnpm yuklab olish). Keyingi qadam: ikkala target'ni yig'ish, `docker compose up`, `/health/ready` va kabinet sahifasi.
- `docs/v1/README.md` — o'rnatish yo'riqnomasi va reliz eslatmalari.
