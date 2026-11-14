#!/bin/sh
set -eu

if [ "$#" -lt 1 ]; then
  echo "Usage: $0 <path-to-backup-dump-file>"
  exit 1
fi

BACKUP_FILE="$1"
META_FILE="${BACKUP_FILE%.dump}.meta.json"
POSTGRES_HOST="${POSTGRES_HOST:-postgres}"
POSTGRES_USER="${POSTGRES_USER:-mezon_admin}"
POSTGRES_DB="${POSTGRES_DB:-mezon_cloud}"

if [ ! -f "$BACKUP_FILE" ]; then
  echo "Error: Backup file '$BACKUP_FILE' does not exist."
  exit 1
fi

echo "[$(date -u +"%Y-%m-%dT%H:%M:%SZ")] Verifying backup integrity..."

# Verify SHA256 checksum if metadata exists
if [ -f "$META_FILE" ]; then
  EXPECTED_SHA=$(grep '"sha256"' "$META_FILE" | head -n1 | sed -E 's/.*"sha256": *"([^"]+)".*/\1/')
  ACTUAL_SHA=$(sha256sum "$BACKUP_FILE" | awk '{print $1}')

  if [ "$EXPECTED_SHA" != "$ACTUAL_SHA" ]; then
    echo "FATAL: Checksum mismatch for $BACKUP_FILE!"
    echo "  Expected: $EXPECTED_SHA"
    echo "  Actual  : $ACTUAL_SHA"
    exit 2
  fi
  echo "Checksum verified: $ACTUAL_SHA (matches metadata)"
else
  echo "Warning: Metadata file '$META_FILE' not found. Skipping SHA256 verification."
fi

echo "[$(date -u +"%Y-%m-%dT%H:%M:%SZ")] Restoring PostgreSQL database: $POSTGRES_DB from $BACKUP_FILE..."

PGPASSWORD="${MEZON_POSTGRES_ADMIN_PASSWORD}" pg_restore \
  -h "$POSTGRES_HOST" \
  -U "$POSTGRES_USER" \
  -d "$POSTGRES_DB" \
  --clean \
  --if-exists \
  --no-owner \
  "$BACKUP_FILE"

echo "[$(date -u +"%Y-%m-%dT%H:%M:%SZ")] Restore completed successfully."
