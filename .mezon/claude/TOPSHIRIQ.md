# Claude topshirig'i: T1.5 — QAYTA ISHLASH (R1)

Kod `51070e9` tekshirildi.

**Yaxshi tomonlari:**

- Toza nusxada `pnpm verify` yashil: 190 test.
- T1.4 test qarzi yopildi.
- **To'lov modeli, 400 ta tasodifiy kombinatsiya** (aralash turlar, ikki naqd qatori, nol va manfiy summalar, naqdsiz ortiqcha to'lov, `amount` bilan va `amount` siz naqd, 0 jamili savdo): har bir natija mustaqil model bilan mos. 100 tasi o'tdi, 300 tasi `VALIDATION_ERROR` bilan rad etildi. Rad etilganda bazaga hech narsa yozilmadi. Kassa qoldig'i aynan naqd summaga o'zgaradi.
- `request_hash`: bir xil so'rov eski chekni qaytaradi, farqli to'lov `IDEMPOTENCY_CONFLICT` qaytaradi.
- **Mutatsiya:** 13 tadan 10 tasi ushlandi. Tirik qolganlardan ikkitasi ekvivalent (boshqa tekshiruv baribir ushlaydi).

**Lekin bitta jiddiy regressiya bor.**

## B1. `completeSale` ombor hisobini buzadi (regressiya)

`sale-repo.ts` dagi pool prefetch'da T1.4 da oltita maydon yuklanar edi. `9f218d9` da faqat ikkitasi qoldi:

```ts
state.qtyOnHand = p.qtyOnHand;
state.totalValue = p.totalValue;
// tushib qolgan: deficitQty, provisionalDeficitValue, costVarianceValue, lastUnitCost
```

Natijada kassadan sotuvda pool holati noto'g'ri boshlanadi.

**Isbot (Claude differensial testi).**

- Ikkita bir xil tovar olinadi. Bir xil kirimlar beriladi.
- Biri `completeSale` orqali sotiladi, ikkinchisi xuddi shu miqdorda `recordOutboundMove` orqali (T1.2 yo'li). `warn` rejimi.
- 2-qadamdayoq `local_stock_balances` farq qiladi:

```
last_unit_cost: kutilgan 1707n, completeSale dan keyin null
```

**Oqibat:**

- `last_unit_cost` o'chadi. Keyingi kamomadli sotuvda tannarx 0 bo'ladi va foyda oshib ko'rinadi.
- Mavjud `deficit_qty`, `provisional_deficit_value` va `cost_variance_value` qayta yoziladi va yo'qoladi.

Oltita maydon qaytarilganda xuddi shu test o'tdi.

**Talab:**

1. Pool holatini qo'lda maydonma-maydon nusxalama. Yuklashni stock-repo'dagi yagona funksiya qilsin: mavjud `loadMutablePoolStateSync` ni batch varianti bilan kengaytir yoki shunga o'xshash yo'l tut. Shunda kelajakda yangi maydon qo'shilsa, nusxa yana eskirmaydi.
2. **Differensial regressiya testi** (`packages/db-local/src/sale.test.ts`):
   - o'rtacha va partiyali (FIFO) tovar;
   - `warn` rejimi, kamomadga tushish va qayta kirim;
   - kamida 30 tasodifiy qadam (seed'li);
   - har qadamdan keyin ikkala tovarning `local_stock_balances` qatori (6 ta maydon) va chiqim `stock_moves.cost_value_delta` lari to'liq teng.
   - **Mutatsiya dalili:** `lastUnitCost` yuklanishi olib tashlansa, test yiqiladi. `deficitQty` uchun ham alohida isbotla.
3. `completeSale` dan keyin `rebuildProjections()` natijasi joriy balanslar bilan bir xil ekanini ham tekshir.

## B2. Test qarzi (kichik)

`validateSalePaymentsInvariant` dagi naqdsiz qator uchun `tenderedAmount !== null` tekshiruvi olib tashlanganda testlar yiqilmadi.

**Talab:** domen unit testi qo'sh. Tekshiruv uchun `{ method: 'card', tenderedAmount: X, changeAmount: 0 }` qatori invariantga to'g'ridan-to'g'ri berilganda `VALIDATION_ERROR` qaytsin.

## Ma'lumot uchun (o'zgartirish shart emas)

Quyidagi ikki mutatsiya ekvivalent. Ularni olib tashlama, himoya qatlami sifatida qolsin:

- `nonCash + debt > total` sharti: buni `SUM + debt = total` ham ushlaydi.
- `sale-repo.ts` dagi `debt > 0` darvozasi: domen `CUSTOMER_REQUIRED` va `customerId` darvozasi ushlaydi.

## Bajarish tartibi

1. B1 va B2 ni tuzat. Yangi commit qil, amend qilma.
2. `pnpm verify` yashil.
3. Push qil, to'rtala CI job yashil bo'lsin.
4. Hisobot: B1 differensial testi va ikki mutatsiya dalili, B2. `[gemini-hisobot] T1.5 R1` bilan commit qil va push qil.
5. `node .mezon/kutish.mjs` ni ishga tushir. Merge qilma.
