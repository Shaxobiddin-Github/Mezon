# Guzar Cloud PostgreSQL Zaxiralash va Qayta Tiklash Qo‘llanmasi

Ushbu qo‘llanma Guzar bulut serveridagi PostgreSQL 18 ma’lumotlar bazasini avtomatik zaxiralash, yaxlitlikni tekshirish va favqulodda vaziyatda qayta tiklash tartibini belgilaydi.

---

## 1. Zaxiralash (Backup)

Zaxiralash skripti: `deploy/scripts/backup-pg.sh`.

### Asosiy xususiyatlari:

1. `pg_dump -Fc`: PostgreSQL siqilgan custom formatida to‘liq nusxa olinadi.
2. **SHA256 tekshiruv yig‘indisi**: Har bir nusxa uchun alohida `.meta.json` fayl yaratilib, fayl nomi, sanasi, hajmi va SHA256 xeshi saqlanadi.
3. **Avtomatik rotatsiya**: Belgilangan saqlash muddatidan (`RETENTION_DAYS`, standart: 7 kun) eski zaxira fayllari avtomatik tozalanadi.

### Qo‘lda ishga tushirish:

```bash
docker compose exec postgres /bin/sh /scripts/backup-pg.sh
```

### Cron orqali har kuni avtomatik ishga tushirish (tungi soat 03:00 da):

```crontab
0 3 * * * cd /opt/guzar/deploy && docker compose exec -T postgres /bin/sh /scripts/backup-pg.sh >> /var/log/mezon-backup.log 2>&1
```

---

## 2. Qayta tiklash (Restore)

Qayta tiklash skripti: `deploy/scripts/restore-pg.sh`.

### Asosiy xususiyatlari:

1. **Yaxlitlik kafolati**: Faylni tiklashdan oldin `.meta.json` ichidagi SHA256 bilan faylning haqiqiy xeshi solishtiriladi. Agar fayl shikastlangan yoki o‘zgartirilgan bo‘lsa, tiklash darhol to‘xtatiladi.
2. `--clean --if-exists`: Mavjud jadvallarni xavfsiz tozalab, zaxiradagi holatga to‘liq qaytaradi.

### Qayta tiklash buyrug‘i:

```bash
docker compose exec -T postgres /bin/sh /scripts/restore-pg.sh /backups/mezon_cloud_20261114_030000Z.dump
```

---

## 3. Xavfsizlik qoidalari

- Parollar va maxfiy kalitlar skriptlarga qattiq yozilmaydi, faqat muhit o‘zgaruvchilaridan (`MEZON_POSTGRES_ADMIN_PASSWORD`) olinadi.
- Zaxira nusxalari serverdan tashqaridagi alohida xavfsiz xotiraga (masalan S3 / rsync orqali) muntazam sinxronlanishi tavsiya etiladi.
