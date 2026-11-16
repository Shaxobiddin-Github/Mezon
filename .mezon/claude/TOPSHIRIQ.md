# Claude xulosasi: T2.4 rejasi — TUZATISHLAR BILAN TASDIQLANDI

**T2.3 merge tekshiruvi:**

- `main` = `89011bf`, daraxt `4c84ec6` ga teng.
- `gemini/T2.3-sync-push` branch'i o'chirilgan.

Reja yaxshi: kursor xaritasi, kursor tranzaksiya ichida, outbox izolyatsiyasi, clamp istisnosi, haqiqiy parallel test va ikki hub modeli.

Quyidagi tuzatishlar bilan `gemini/T2.4-sync-pull` branch'ida kodni yoz. **T1 va T2 majburiy.** Ularsiz reja ishlamaydi yoki ma'lumot yo'qoladi.

## Majburiy tuzatishlar

### T1. `temp` jadval bilan trigger ishlamaydi

SQLite'da asosiy sxemadagi trigger `temp` sxemasidagi obyektga murojaat qila olmaydi. Tekshirdim (better-sqlite3):

```
create trigger tr before insert on t when (select v from temp._s) is null ...
→ ERR: trigger tr cannot reference objects in database temp
```

**Talab:**

- Bayroq **asosiy sxemadagi** LOCAL jadvalda bo'lsin (`local_sync_apply_state`, bitta qator).
- Pull tranzaksiyasining boshida `in_sync = 1` qo'yiladi, commit'dan oldin `0` ga qaytariladi. Tranzaksiya rollback bo'lsa, bayroq ham avtomatik qaytadi.
- Testlar:
  - lokal savdo yopiq smenaga bloklanadi, sinxron qo'llash esa bloklanmaydi;
  - pull qulagandan keyin bayroq `0` bo'ladi.
- "Eskirgan" belgisi va konflikt yozuvi trigger ichida emas, **apply kodi** ichida yozilsin. Trigger faqat bloklamaslikni hal qiladi.

### T2. Echo bostirish faqat `deviceId` bo'yicha bo'lsa, ma'lumot yo'qoladi

Hub T1.13 zaxirasidan tiklansa, zaxiradan keyin yaratilgan o'z hodisalari bulutda bor, lekin lokalda yo'q. `deviceId === current` bo'lgani uchun ular abadiy o'tkazib yuboriladi.

**Talab:**

- Hodisa faqat uning `eventId` si lokal `local_outbox` da mavjud bo'lsa o'tkazib yuboriladi.
- Aks holda o'z hodisasi bo'lsa ham qo'llanadi: FACT idempotent, ATTR LWW.
- **Test:** hub savdo qiladi va push qiladi, so'ng zaxiradan oldingi holatga qaytariladi va pull qiladi → savdo qayta paydo bo'ladi.

## Boshqa tuzatishlar

### T3. "Zaharli" hodisa butun pull'ni to'xtatmasin

Rejaga ko'ra 100 hodisali partiya bitta tranzaksiya, 75-hodisada xato bo'lsa, hammasi rollback bo'ladi va keyingi pull'da yana o'sha joyda yiqiladi. Bu abadiy tiqilish.

**Talab:**

- Har hodisa **SAVEPOINT** ichida qo'llansin (T2.3 P1 kabi).
- Doimiy xato: Zod, sxema versiyasi, CHECK yoki noma'lum entity → `local_sync_conflicts`, kursor siljiydi.
- FK yo'q → park.
- Disk xatosi yoki `SQLITE_BUSY` kabi vaqtinchalik xato → butun partiya rollback, kursor joyida qoladi.
- **Test:** 100 hodisadan 75-si buzuq → 99 tasi qo'llanadi, 1 tasi konfliktga tushadi, kursor oxirida.
- Hub pull qilingan payload'ni ham `SYNC_PAYLOAD_SCHEMAS` (strict) bilan tekshirsin.

### T4. Qarzlar daftari tashkilot bo'yicha ko'rinsin

Mijozlar (`customers`) tashkilot doirasida, lekin `customer_ledger` va `supplier_ledger` do'kon doirasida. Rejadagi filtr bilan A do'konda nasiyaga olgan mijoz B do'konda qarzsiz ko'rinadi va B'da qarzini to'lay olmaydi.

**Qaror:**

- Pull qamrovi = tashkilot doirasidagi jadvallar + o'z do'konining do'kon doirasidagi jadvallari + **`customer_ledger` va `supplier_ledger` barcha do'konlardan**.
- Yozish hamon faqat o'z do'konida bo'ladi, qator `store_id` ni saqlaydi.
- Qamrov ro'yxati kodda emas, registr metadata'sida bo'lsin, masalan `pullScope: 'organization' | 'store'`.
- **Test:** A'dagi nasiya B hub'dagi mijoz balansida ko'rinadi. B'da qilingan to'lov A'ga ham yetib keladi.

### T5. Qurilma ID'si sarlavhadan olinmaydi

`x-mezon-device-id` sarlavhasi ishlatilmaydi. Qurilma, tashkilot va do'kon **faqat tokendan** olinadi.

- Kursorlardagi `storeId` lar so'rov qilayotgan tashkilotga tegishli bo'lishi kerak, aks holda 400.
- Kursor formati `uuid:raqam`, validatsiya bilan.

### T6. Bulutdagi park faqat hub qayta yuborganda qayta qo'llanadi

Bulutda parked hodisalarni avtomatik qayta qo'llash shart emas va u ikkinchi yo'l hisoblanadi. Hub `retry` olgan hodisani o'zi qayta yuboradi, takror bo'lsa `UNIQUE` bor. Hozircha **faqat hub qayta yuborishi** bilan ishlaymiz. Bulutda faqat hisob yuritiladi.

### T7. Kichik tuzatishlar

- FACT `INSERT OR IGNORE`: mavjud id boshqa mazmun bilan kelsa (kontent xeshi farq qilsa), konflikt yozilsin. Jimgina o'tkazib yuborilmasin.
- Parallel test faqat bitta do'kon bilan emas, **ikki do'kon** bilan ham bo'lsin. Kursor xaritasidagi bir do'konning siljishi ikkinchisining hodisasini yo'qotmasligi kerak.
- Pull javobidagi `hasMore` va `limit` chegarasi ataylab chegara qiymatlari bilan sinalsin: `limit` ta hodisa, `limit+1` ta hodisa.

## Mutatsiya rejasiga qo'sh

- echo tekshiruvi `eventId` emas, faqat `deviceId` bo'yicha;
- SAVEPOINT olib tashlanadi;
- ledger pull qamrovi olib tashlanadi;
- kursordagi begona `storeId` validatsiyasi o'chiriladi;
- sinxron bayroq commit'dan oldin qaytarilmaydi.

## Bajarish tartibi

1. Kod va testlar. `MEZON_REQUIRE_PG_TESTS=1 pnpm verify` yashil bo'lsin.
2. Commit qil, push qil, PR och. CI yashil bo'lsin.
3. Hisobot `[gemini-hisobot] T2.4`:
   - mezonlar va T1–T7 bo'yicha test nomlari;
   - mutatsiya natijalari;
   - parallel test raqamlari: writer'lar soni, hodisalar soni, o'tkazib yuborilgan va takrorlangan hodisalar 0.
4. `node .mezon/kutish.mjs` ni ishga tushir. Merge qilma.
