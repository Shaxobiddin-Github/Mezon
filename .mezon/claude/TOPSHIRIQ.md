# Claude topshirig'i: T1.10 QABUL → T1.11 rejasi

## 0. Ish tartibidagi o'zgarish (egasining qarori, 2026-11-11)

- **Repo public qilindi.** GitHub Actions yana bepul ishlaydi. "To'rtala CI job yashil" sharti **qayta kuchga kirdi**. Vaqtinchalik CI'siz qoida bekor qilindi.
- **Docker o'rnatildi.** Claude endi `pg-rls` testlarini ham lokal o'tkazadi.
- **Tekshiruv tartibi:** har vazifada Claude toza nusxada verify va xavfli joylarga nishonli mutatsiya o'tkazadi. Chuqur audit (mustaqil model va keng mutatsiya) har **bosqich oxirida**: F1 yakunida, T1.13 dan keyin.
- **Public repo:** maxfiy kalit, token, `.env` yoki shaxsiy ma'lumot hech qachon commit qilinmasin. GEMINI.md 3-bo'lim baribir taqiqlaydi, endi bu yanada muhim.

## 1. T1.10 xulosasi: QABUL (kod `9152a74`)

- **Toza nusxada `pnpm verify` yashil:** 278 + 12 perf test. Docker bilan `pg-rls` ham o'tdi, birorta test skip qilinmadi.
- **GitHub CI yashil:** `Verify` (ubuntu, windows), `Verify PostgreSQL RLS`; desktop job reja bo'yicha skip.
- **Nishonli mutatsiya:** 3 tadan 3 tasi ushlandi:
  - `'advance'` to'lovi `cash_moves` ga tushsa, ya'ni kassa ikki marta sanalsa;
  - avans chegarasi `netAdvance <= total`;
  - oddiy POS savdosida `'advance'` usuli ruxsatsiz.
- O1–O4 va 225 qadamli model testi hisobotdagidek.

Test qarzi yo'q.

## 2. Merge

1. `git pull --ff-only`.
2. PR boshi Claude'ning shu topshiriq commit'i bo'lsin, CI yashil bo'lsin.
3. `T1.10: Buyurtma va avans` nomi bilan Squash and merge qil, SHA'ni yoz, branch'ni o'chir.
4. `main`dan `gemini/T1.11-pos-ui` branch'ini och.

## 3. T1.11 — Kassa UI: avval REJA

Kod yozma. Rejani `.mezon/gemini/HISOBOT.md` ga yoz, `[gemini-reja] T1.11` bilan commit qil va push qil, so'ng `node .mezon/kutish.mjs` bilan kut.

GEMINI.md T1.11 talablari:

- teginish va klaviatura bilan ishlash;
- USB skanerni aniqlash: belgilar tezligi, Enter va forma; DataMatrix va GS belgisi buzilmasin;
- mahsulot qidiruvi;
- to'lov ekrani;
- kechiktirilgan chek;
- tungi va kunduzgi mavzu.

Mezonlar (Playwright E2E):

- skan → to'lov → chek;
- sichqonsiz savdo;
- tez yozgan odam skaner deb qabul qilinmaydi.

Rejada quyidagilar aniq bo'lsin:

### a) Tuzilma

- **Joyi:** `apps/pos` (React 19 + Vite).
- **Hub bilan aloqa:** tiplangan API mijozi. Tiplar `@mezon/contracts` Zod sxemalaridan olinsin, qo'lda nusxalanmasin. Javoblar ham Zod bilan tekshiriladi.
- **Electron'da yuklanish:** `app://mezon` protokoli, CSP. Brauzerda dev rejim.
- **Matnlar:** hammasi bitta `i18n` lug'atidan (T4.6 ga tayyor). Hozir o'zbek lotin.
- **Holat boshqaruvi:** tanlangan kutubxona va sababi.

### b) Ekranlar

- PIN bilan kirish.
- Smenani ochish (ochiq smena bo'lmasa).
- **Savdo:** savat, qidiruv, skan, miqdor, chegirma, supervisor PIN oynasi.
- **To'lov:** aralash to'lov, berilgan naqd va qaytim; qarz bo'lsa mijoz tanlash.
- **Kechiktirilgan cheklar:** park va resume.
- **Chek ko'rinishi:** chop etish T1.12 da.
- **Kassa harakatlari va smenani yopish ekrani:** naqdsiz summa maydoni bo'lmaydi.

### c) Skaner aniqlash (eng nozik qism)

- **Algoritm:** belgilar orasidagi vaqt (masalan ≤ 30 ms), minimal uzunlik, tugatuvchi Enter (yoki Tab). Kursor qaysi maydonda bo'lishidan qat'i nazar, skan savatga tushadi va yozilayotgan matnni buzmaydi.
- **GS (`\x1D`) va DataMatrix:** belgilar o'chirilmaydi va almashtirilmaydi. Marking kodi butunligicha hub'ga yetadi. Ba'zi skanerlar GS ni `Ctrl+]` yoki boshqa kod bilan yuboradi: qanday ishlanishini yoz.
- **Sof funksiya:** algoritm sof funksiya bo'lsin, vaqt belgilari kirish sifatida beriladi.
- **Unit testlar:** tez yozuvchi (masalan 80–120 ms oraliq) skaner deb qabul qilinmaydi; skaner (5–15 ms) qabul qilinadi; GS saqlanadi; aralash holatlar.

### d) Pul xavfsizligi UI'da

- **Bitta to'lov urinishi uchun bitta `clientRequestId`.** Tarmoq xatosi va qayta urinishda **o'sha ID** qayta yuboriladi. Muvaffaqiyatdan keyin yangisi. Ikki marta bosish va tarmoq uzilishi bitta chek beradi: E2E bilan isbotla.
- **`409 SALE_TOTAL_CHANGED`:** yangi summani ko'rsatish va kassirdan tasdiq olish.
- **Boshqa xatolar:** `INSUFFICIENT_STOCK` (qaysi qatorlar), `SHIFT_NOT_OPEN`, `CASHIER_SESSION_MISMATCH` tushunarli o'zbekcha xabar bilan.
- **Tannarx va foyda:** kassir UI'sida umuman yo'q. Javoblarda ham kelmaydi.

### e) Klaviatura va unumdorlik

- **Tugmalar xaritasi:** sichqonsiz to'liq savdo, masalan F-tugmalar. Ro'yxatini yoz.
- **Teginish:** katta tugmalar, minimal o'lcham.
- **Tezlik:** skan → qator ko'rinishi ≤ 100 ms; 50 000 tovarli katalogda qidiruv natijasi ≤ 150 ms (hub bilan birga).

### f) E2E (Playwright)

Hub test rejimida, haqiqiy SQLite bilan:

- skan → to'lov → chek;
- sichqonsiz savdo;
- tez yozuvchi;
- ikki marta bosish va tarmoq uzilishi;
- park/resume;
- smena ochish va yopish.

Windows CI'da ham ishlasin.

### g) Doiradan tashqari

- Printer (T1.12).
- Hisobotlar va Excel (T1.13).
- Android (T4.4).
- Ko'p til (T4.6).
