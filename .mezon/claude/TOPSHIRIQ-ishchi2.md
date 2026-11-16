# Nazoratchi xulosasi (ishchi2): T3.2 rejasi — T3.2a TASDIQLANDI (tuzatishlar bilan)

**T3.1 merge tekshiruvi:**

- `main` = `19118df`, daraxt `5704ed0` ga teng.
- `main` dagi CI yashil.
- `ishchi2/T3.1-mxik` branch'ini **o'chirishga ruxsat**: `git push origin --delete ishchi2/T3.1-mxik`. Bundan keyin merge qilingan branch'larni o'zing o'chirasan (§3.6).

Reja juda kuchli:

- haqiqiy qoida ma'lumoti paketda, kodda faqat sintetik qiymatlar;
- `keyId` imzo ichida;
- rollback himoyasi;
- har yuklashda qayta tekshiruv;
- UI'da imzo tekshiruvi yo'q, ishonch chegarasi hub;
- bitta `completeSaleCoreInTxSync` nuqtasi;
- PII maskalash.

## Nazoratchi qarorlari

- **S12: ha, ikkiga bo'lamiz.**
  - **T3.2a hozir:** paket formati, kanonik serializatsiya, imzo, import va saqlash, holatlar (8-bo'lim), `evaluate` karkasi, paketsiz qoidalar (`EXPIRED_GOODS`, `SOCIAL_CARD_DATA_REQUIRED`), `completeSale` va `deliver` integratsiyasi, `rules-check`, UI paneli, imzolash CLI'si.
  - **T3.2b:** `CASH_FORBIDDEN_MXIK`, `MIXED_RECEIPT_CASHLESS`, `MXIK_CASH_LIMIT`, `PRESCRIPTION_REQUIRED`. Egasining S1, S3–S5, S7 va S8 javoblaridan keyin bajariladi. Paket formatidagi maydonlar T3.2a dayoq bo'lsin, lekin ularning semantikasi T3.2b ga qoladi.
- **S11: port.** `db-local` qoidalarni bilmaydi. `completeSaleCoreInTxSync` `rulesEvaluator` portini oladi. Hub ikkala yo'l uchun bitta evaluator beradi.
  - Port **majburiy** parametr bo'lsin, ixtiyoriy emas. Shunda yangi savdo yo'li qo'shilsa, evaluator'siz kompilyatsiya bo'lmaydi.
  - Mutatsiya: evaluator `noop` ga almashtirilsa, testlar yiqiladi.
- **S10: ha.** Fiskal rejimda paket `missing` yoki `invalid` bo'lsa → block. Fiskal rejim T3.3 gacha faqat testlarda yoqiladi.
- **S9: o'zing qo'shasan, lekin T2.3 `main` ga tushgandan keyin.**
  - T2.3 (Gemini, PR #23) deyarli tayyor, tez orada merge bo'ladi. Shundan keyin `main` da sxema mosligi testi va namunalar bo'ladi.
  - Ruxsat faqat **o'z yangi sinxron ustunlaring yoki jadvallaring uchun**:
    - `packages/db-cloud/src/schema/domain-tables.ts` ga ustun yoki jadval;
    - bulut migratsiyasi;
    - `packages/contracts/src/sync.ts` dagi payload sxemasi.
  - `sync-push-store.ts`, worker va sinxron mantig'iga tegilmaydi.
  - T2.3 merge bo'lguncha lokal qism ustida ishla. Rebase'dan keyin bulut juftini qo'sh.
- **Rollback himoyasi va zaxira nusxa:** `max_rule_package_version` `local_hub_config` da. T1.13 dagi zaxiradan tiklashda u ham eskirib qolishi mumkin. Tiklashdan keyin import qilingan paketlar (`local_rule_packages`) dan maksimal versiyani qayta hisobla. Test bilan ko'rsat: tiklashdan keyin ham eski versiya rad etiladi.

## Qo'shimcha talablar

1. **Migratsiya raqami.** Gemini T2.3 da lokal migratsiyani `0016` ga ko'chiryapti. Sen PR ochishdan oldin `origin/main` ga rebase qil va **keyingi bo'sh raqamni** ol (ehtimol `0017`).
2. **`trustedRuleKeys` faqat test va DI uchun.**
   - Prod kodida (Electron worker) bu opsiya hech qachon berilmasligini test yoki depcruise bilan ko'rsat.
   - `NODE_ENV=production` da opsiya berilsa, `createHubServer` xato tashlasin.
3. **Faol paket o'zgarishi.** Import tranzaksiyasi: eski paketni nofaol qilish va yangisini faol qilish bitta tranzaksiyada bo'lsin. Parallel ikki import testi.
4. **CLI.** `rules-sign.mjs keygen` repo ichidagi yo'lni rad etadi, testi bilan. Yangi kalitning fayl ruxsati iloji boricha cheklangan bo'lsin.
5. **UI paneli.** Block bo'lsa, "Yakunlash" tugmasi o'chadi va sabab i18n orqali ko'rsatiladi. Final tekshiruv baribir hub'da: UI'ni chetlab o'tgan to'g'ridan-to'g'ri API so'rovi ham 422 oladi. Bu integratsion testda bo'lsin.

## Egasiga yuborilgan savollar

S1–S8 egasiga yuborildi. Javoblar kelganda T3.2b topshirig'ida beraman. T3.2a ularni kutmaydi.

S6 (ijtimoiy karta formati) T3.2a ga ta'sir qiladi. Javob kelguncha:

- uchala maydon majburiy, faqat bo'sh emasligi va uzunligi tekshiriladi;
- raqam faqat maskalangan holda saqlanadi (oxirgi 4 raqam).

S2 (prod kalit) kelguncha prod ro'yxati bo'sh qoladi, ya'ni `missing` holati. Rejadagidek.

## Bajarish tartibi

1. T3.2a kodi va testlari. Mutatsiya rejasidagi, T3.2a ga tegishli bandlar.
2. `pnpm verify` yashil.
3. Push qil, PR och va CI yashil bo'lsin.
4. Hisobot `[ishchi2-hisobot] T3.2a`.
5. `node .mezon/kutish.mjs 120 .mezon/claude/TOPSHIRIQ-ishchi2.md`. Merge qilma.
