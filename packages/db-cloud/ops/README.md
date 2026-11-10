# PostgreSQL Operational Provisioning (`packages/db-cloud/ops`)

`mezon_app` ilova roli (`NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS`) Drizzle migratsiyalaridan tashqarida [`provision-app-role.mjs`](./provision-app-role.mjs) skripti orqali yaratiladi va paroli alohida boshqariladi. Bu yondashuv ishlab chiqarish migratsiya rolida `CREATEROLE` huquqini talab qilmaslik hamda parollarni repozitoriya va SQL fayllarga kiritmaslik uchun tanlangan.

## Ishga tushirish

```bash
MEZON_PG_ADMIN_URL="postgres://admin:...@host:5432/mezon" \
MEZON_APP_DB_PASSWORD="..." \
node packages/db-cloud/ops/provision-app-role.mjs
```

Ixtiyoriy ravishda `MEZON_APP_ROLE_NAME` (standart qiymati: `mezon_app`) berilishi mumkin.

## Ogohlantirish: Server loglarida parol xavfsizligi

Skript tranzaksiya boshida server loglariga bog'langan parametrlar yozilmasligi uchun quyidagilarni o'rnatadi:

```sql
SET LOCAL log_statement = 'none';
SET LOCAL log_min_duration_statement = -1;
```

> **OGOHLANTIRISH:** Agar `MEZON_PG_ADMIN_URL` da ishlatilayotgan admin roli PostgreSQL `SUPERUSER` bo'lmasa (masalan, AWS RDS `rds_superuser`, Yandex Managed PostgreSQL yoki boshqa boshqariladigan bulut provayderlarida faqat `CREATEROLE` huquqiga ega admin), PostgreSQL `SET LOCAL log_statement` va `SET LOCAL log_min_duration_statement` uchun `insufficient_privilege` (`42501`) beradi. Skript bu holatda to'xtamasdan tranzaksiyani davom ettiradi va ogohlantirish chiqaradi.
>
> Bunday boshqariladigan serverda `log_statement = 'all'` (yoki `log_statement = 'mod'` / past `log_min_duration_statement`) yoqilgan bo'lsa, `set_config('mezon.prov_pwd', $2, true)` chaqiruvining `$2` bind parametri PostgreSQL server logiga tushishi mumkin. Shu sababli boshqariladigan serverlarda provisioning yoki parol aylantirish paytida statement loglashni vaqtincha o'chiring yoxud operatsiya loglarini xavfsiz tozalash/aylantirish siyosatini qo'llang.
