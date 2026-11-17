# Qonuniy qoidalar paketini imzolash (egasi uchun)

Qoidalar paketi barcha tashkilotlar uchun bitta. Unda naqd pulga taqiqlangan MXIK'lar va naqd limit bo'ladi. Paketni faqat egasi imzolaydi. Maxfiy kalit **hech qachon** repoga, serverga yoki chatga tushmaydi.

Buyruqlardan oldin bir marta: `pnpm --filter @mezon/rules build`.

## 1. Kalit yaratish (bir marta)

Kalit faqat repodan **tashqaridagi** papkaga yoziladi. Repo ichidagi yo'l berilsa, buyruq rad etadi.

```bash
node scripts/rules-sign.mjs keygen --out D:/guzar-keys
```

Natija:

- `rules-signing.key`: **maxfiy** kalit. Uni oflayn saqlang (masalan, shifrlangan USB) va hech kimga bermang.
- Ekranda `public key (raw, base64)` chiqadi. Shu ochiq kalitni va o'zingiz tanlagan `keyId` ni (masalan `owner-2026`) dasturchiga bering. U ikkalasini `packages/rules/src/trusted-keys.ts` ga kiritadi.

## 2. Paketni imzolash (har yangilanishda)

`payload.json`:

```json
{
  "packageVersion": "1",
  "issuedAtMs": "1767225600000",
  "validUntilMs": "1798761600000",
  "sourceRefs": ["Soliq qo'mitasi ro'yxati, sana"],
  "cashForbidden": { "exact": [], "prefixes": [] },
  "perMxikCashLimit": {
    "limitTiyin": "<limit tiyinda>",
    "appliesTo": "cash",
    "inclusive": true,
    "exempt": { "exact": [], "prefixes": [] }
  },
  "expiredGoods": { "enabled": true }
}
```

Maydonlar:

- `packageVersion`: har safar oldingisidan katta bo'lishi kerak. Eskiroq versiya rad etiladi.
- Vaqtlar unix millisekundda, satr ko'rinishida yoziladi.
- `appliesTo`: `"cash"` bo'lsa, limit naqd qismiga qo'llanadi; `"mxikTotal"` bo'lsa, MXIK umumiy summasiga.
- `inclusive: true`: limitga teng summa ruxsat etiladi.

```bash
node scripts/rules-sign.mjs sign --key D:/guzar-keys/rules-signing.key --key-id owner-2026 --in payload.json --out package.json
```

```bash
node scripts/rules-sign.mjs verify --pub <ochiq kalit base64> --in package.json
```

## 3. O'rnatish

Owner yoki manager `package.json` ni kassaga import qiladi: `POST /rules/package`. Hub imzo, kalit va versiyani tekshiradi. Bir vaqtda faqat bitta faol paket bo'ladi.
