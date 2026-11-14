#!/bin/sh
set -eu

BACKUP_DIR="${BACKUP_DIR:-/backups}"
POSTGRES_HOST="${POSTGRES_HOST:-postgres}"
POSTGRES_USER="${POSTGRES_USER:-mezon_admin}"
POSTGRES_DB="${POSTGRES_DB:-mezon_cloud}"
RETENTION_DAYS="${RETENTION_DAYS:-7}"

mkdir -p "$BACKUP_DIR"

TIMESTAMP=$(date -u +"%Y%m%d_%H%M%SZ")
BACKUP_FILE="${BACKUP_DIR}/mezon_cloud_${TIMESTAMP}.dump"
META_FILE="${BACKUP_DIR}/mezon_cloud_${TIMESTAMP}.meta.json"

echo "[$(date -u +"%Y-%m-%dT%H:%M:%SZ")] Starting PostgreSQL backup: $BACKUP_FILE"

# Run pg_dump in custom compressed format (-Fc)
PGPASSWORD="${MEZON_POSTGRES_ADMIN_PASSWORD}" pg_dump \
  -h "$POSTGRES_HOST" \
  -U "$POSTGRES_USER" \
  -d "$POSTGRES_DB" \
  -Fc \
  -f "$BACKUP_FILE"

# Calculate SHA256 checksum
SHA256=$(sha256sum "$BACKUP_FILE" | awk '{print $1}')
FILE_SIZE=$(wc -c < "$BACKUP_FILE" | tr -d ' ')

# Write metadata JSON
cat <<EOF > "$META_FILE"
{
  "backupFile": "$(basename "$BACKUP_FILE")",
  "database": "$POSTGRES_DB",
  "timestamp": "$TIMESTAMP",
  "sha256": "$SHA256",
  "sizeBytes": $FILE_SIZE
}
EOF

echo "[$(date -u +"%Y-%m-%dT%H:%M:%SZ")] Backup completed successfully. SHA256: $SHA256"

# Cleanup old backups older than RETENTION_DAYS
echo "[$(date -u +"%Y-%m-%dT%H:%M:%SZ")] Cleaning up backups older than $RETENTION_DAYS days..."
find "$BACKUP_DIR" -type f \( -name "*.dump" -o -name "*.meta.json" \) -mtime +"$RETENTION_DAYS" -exec rm -f {} +
echo "[$(date -u +"%Y-%m-%dT%H:%M:%SZ")] Cleanup finished."
