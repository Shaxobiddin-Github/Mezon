# Guzar Cloud PostgreSQL Zaxiralash va Qayta Tiklash Qo‘llanmasi

Ushbu qo‘llanma Guzar bulut serveridagi PostgreSQL 18 ma’lumotlar bazasini avtomatik zaxiralash, yaxlitlikni tekshirish va favqulodda vaziyatda qayta tiklash tartibini belgilaydi.

---

## 1. Zaxiralash (Backup)

Zaxiralash skripti: `deploy/scripts/backup-pg.sh`.

### Asosiy xususiyatlari:

1. `pg_dump -Fc`: PostgreSQL siqilgan custom formatida to‘liq nusxa olinadi.
2. **SHA256 tekshiruv yig‘indisi**: Har bir nusxa uchun alohida `.meta.json` fayl yaratilib, fayl nomi, sanasi, hajmi va SHA256 xeshi saqlanadi.
3. **Avtomatik rotatsiya**: Belgilangan saqlash muddatidan (`RETENTION_DAYS`, standart: 7 kun) eski zaxira fayllari avtomatik tozalanadi.

Zaxira compose'dagi `backup` xizmati bilan olinadi. Bu bir martalik konteyner: u ishlayotgan bazaga ulanadi va `up` bilan ishga tushmaydi. Nusxalar `deploy/backups/` papkasiga tushadi (u gitignore'da; boshqa joy kerak bo'lsa, `.env` da `MEZON_BACKUP_DIR` ni o'zgartiring). Standart holatda oxirgi 14 kunlik nusxa saqlanadi (`MEZON_BACKUP_RETENTION_DAYS=13`).

Quyidagi buyruqlar `deploy/` papkasida bajariladi. Cloudflare Tunnel variantida har bir `docker compose` dan keyin `-f docker-compose.yml -f docker-compose.tunnel.yml` ni yozing.

### Qo‘lda ishga tushirish:

```bash
docker compose run --rm backup
```

### Cron orqali har kuni avtomatik ishga tushirish (Toshkent vaqti bilan 03:00, server UTC bo'lsa):

```crontab
0 22 * * * cd /home/<user>/guzar/deploy && docker compose run --rm -T backup >> /home/<user>/mezon-backup.log 2>&1
```

---

## 2. Qayta tiklash (Restore)

Qayta tiklash skripti: `deploy/scripts/restore-pg.sh`.

### Asosiy xususiyatlari:

1. **Yaxlitlik kafolati**: Faylni tiklashdan oldin `.meta.json` ichidagi SHA256 bilan faylning haqiqiy xeshi solishtiriladi. Agar fayl shikastlangan yoki o‘zgartirilgan bo‘lsa, tiklash darhol to‘xtatiladi.
2. `--clean --if-exists`: Mavjud jadvallarni xavfsiz tozalab, zaxiradagi holatga to‘liq qaytaradi.

### Muhim: rollar zaxirada bo'lmaydi

`pg_dump` faqat bazani saqlaydi. Rollar (`mezon_app`, `mezon_auth_owner` va boshqalar) server darajasida turadi va nusxaga kirmaydi. Ularni `init-db/01-init-roles.sh` PostgreSQL **birinchi marta** ishga tushganda yaratadi. Shuning uchun yangi serverda tartib quyidagicha:

```bash
docker compose up -d --wait postgres     # 1. rollar yaratiladi
docker compose run --rm --entrypoint /bin/sh backup /scripts/restore-pg.sh /backups/mezon_cloud_20261114_030000Z.dump   # 2. tiklash
docker compose up -d                     # 3. qolgan xizmatlar (migrate bo'sh o'tadi)
```

Ishlab turgan serverda tiklash uchun faqat 2-qadam bajariladi, keyin `docker compose restart cloud`.

Bu tartibni CI har PR'da tekshiradi (`deploy-images.yml`). U migratsiya qilingan bazadan zaxira oladi, yangi serverga tiklaydi va jadvallar hamda RLS policy'lar soni o'zgarmaganini, API qayta ishga tushishini tasdiqlaydi.

---

## 3. Xavfsizlik qoidalari

- Parollar va maxfiy kalitlar skriptlarga qattiq yozilmaydi, faqat muhit o‘zgaruvchilaridan (`MEZON_POSTGRES_ADMIN_PASSWORD`) olinadi.
- Zaxira nusxalari serverdan tashqaridagi alohida xavfsiz xotiraga (masalan, S3 yoki rsync orqali) muntazam ko'chirilishi **kerak**: server diski buzilsa, shu serverdagi nusxalar ham yo'qoladi.

---

## 4. Migratsiyalarni qo‘llash (Database Migrations)

- Migratsiyalar ilova runtime konteynerida (`cloud`) EMAS, bir martalik alohida `migrate` konteynerida `DATABASE_ADMIN_URL` orqali bajariladi:
  ```bash
  docker compose run --rm migrate
  ```
  yoki ishlab chiqish/avtonom muhitda:
  ```bash
  pnpm --filter @mezon/cloud db:migrate
  ```
- `cloud` servisi runtime'da faqat cheklangan huquqli `mezon_app` (`DATABASE_URL`) roli bilan ulanadi va unga hech qachon superuser/admin URL berilmaydi.
