# Mezon (Mezon Kassa)

O'zbekiston qonunlariga mos, internetsiz ishlaydigan, turli sohalarga moslanadigan zamonaviy POS tizimi.

---

## 1. Talablar

- **Node.js:** `>=24.21.0 <25` (tavsiya: `.nvmrc` da ko'rsatilgan `24.22.2`)
- **pnpm:** `12.18.0` (`packageManager` orqali boshqariladi)
- **Operatsion tizim:** Windows 10 22H2+ (64-bit), Linux / macOS (ishlab chiqish uchun)

---

## 2. Ishga tushirish (Bir buyruq bilan)

Toza klondan o'rnatish va barcha tekshiruvlarni ishga tushirish:

```bash
pnpm install --frozen-lockfile && pnpm verify
```

`pnpm verify` buyrug'i quyidagi tekshiruvlarni ketma-ket bajaradi:

1. **Format check:** `pnpm run format:check` (`prettier --check .`)
2. **Build:** `pnpm run build` (`turbo run build` — workspace `dist` artefaktlarini tayyorlaydi)
3. **Lint:** `pnpm run lint` (`eslint .` — tipga asoslangan qoidalar bilan)
4. **Typecheck:** `pnpm run typecheck` (`turbo run typecheck`)
5. **Test:** `pnpm run test` (`vitest run`)
6. **Dependency boundaries:** `pnpm run depcruise` (`dependency-cruiser` qat'iy chegaralari)

---

## 3. Monorepo tuzilmasi

```text
apps/
  desktop/      Electron qobig'i (hub + UI)
  hub/          Do'kon serveri (Fastify + SQLite)
  pos/          Kassa va do'kon UI (React 19 + Tailwind 4)
  android/      Capacitor qobig'i
  cloud/        Bulut API va sinxron (Fastify + PostgreSQL)
  admin/        Egasi va tarmoq paneli
  bot/          Telegram bot (grammY)
packages/
  domain/       Sof biznes mantiq, mutlaqo I/O yo'q
  contracts/    API va hodisa sxemalari (Zod)
  rules/        Qonuniy qoidalar dvigateli (faqat domain'ga bog'lanadi)
  sync/         Sinxronizatsiya yadrosi
  db-local/     SQLite sxemasi
  db-cloud/     PostgreSQL sxemasi
  drivers/      Fiskal, to'lov, printer, markirovka drayverlari
  ui/           Umumiy UI komponentlar
  i18n/         Ko'p tillilik resurslari
  test-utils/   Test yordamchilari va fixture'lar
```

---

## 4. Arxitektura va texnik eslatmalar

- **TypeScript versiyasi:** `6.0.3` (`strict: true`, `skipLibCheck: true`).
  > **Eslatma:** `skipLibCheck: true` talab etiladi, chunki tashqi paketlar (xususan Drizzle ORM generics va uning `.d.ts` fayllari) TS 6+ da qat'iy kutubxona tekshiruvida xatolik bermasligi uchun zarur.
- **Linter:** ESLint 10.14 va `typescript-eslint` 8.72 tipga asoslangan `recommendedTypeChecked` qoidalari bilan.
- **Import chegaralari (`dependency-cruiser`):**
  - `packages/domain` hech narsani (na Node ichki modullari, na npm paketlari) import qilmaydi.
  - `packages/rules` faqat `packages/domain`ni import qila oladi.
  - `apps/*` ilovalari bir-birini import qila olmaydi.
  - `packages/*` paketlari `apps/*` ilovalarini import qila olmaydi.
  - `domain` va `rules` ichida `Date.now()`, `new Date()`, `Math.random()`, `crypto` va `process` global ob'ektlari ESLint orqali taqiqlangan.
