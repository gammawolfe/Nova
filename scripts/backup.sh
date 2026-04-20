#!/bin/bash
set -euo pipefail

BACKUP_DIR="data/backups"
TIMESTAMP=$(date +%Y%m%d-%H%M%S)
BACKUP_NAME="nova-${TIMESTAMP}"
TEMP_DIR="${BACKUP_DIR}/${BACKUP_NAME}"

mkdir -p "${TEMP_DIR}"

echo "=== Nova Backup: ${BACKUP_NAME} ==="

# Keys (critical)
KEY_DIR="${NOVA_KEY_DIR:-data/keys}"
if [ -d "${KEY_DIR}" ]; then
  cp -r "${KEY_DIR}" "${TEMP_DIR}/keys"
  chmod 600 "${TEMP_DIR}/keys/"*.pem 2>/dev/null || true
  echo "  Keys backed up"
fi

# Tenant data (exclude quarantine and dead-letter — transient data)
if [ -d "data/tenants" ]; then
  rsync -a --exclude='quarantine/' --exclude='dead-letter/' data/tenants/ "${TEMP_DIR}/tenants/"
  echo "  Tenant configs backed up"
fi

# Audit logs
if [ -d "data/audit" ]; then
  cp -r data/audit/ "${TEMP_DIR}/audit/"
  echo "  Audit logs backed up"
fi

# UCAN issued metadata
if [ -d "data/ucans" ]; then
  cp -r data/ucans/ "${TEMP_DIR}/ucans/"
  echo "  UCAN metadata backed up"
fi

# Redis AOF (if running in Docker)
if docker ps --format '{{.Names}}' 2>/dev/null | grep -q redis; then
  echo "  Triggering Redis BGSAVE..."
  docker exec "$(docker ps --format '{{.Names}}' | grep redis | head -1)" redis-cli BGSAVE >/dev/null 2>&1 || true
  sleep 3
  docker cp "$(docker ps --format '{{.Names}}' | grep redis | head -1):/data/appendonly.aof" "${TEMP_DIR}/redis.aof" 2>/dev/null || echo "  Warning: Could not copy Redis AOF"
fi

# Compress
tar -czf "${BACKUP_DIR}/${BACKUP_NAME}.tar.gz" -C "${BACKUP_DIR}" "${BACKUP_NAME}"
rm -rf "${TEMP_DIR}"

echo "  Backup: ${BACKUP_DIR}/${BACKUP_NAME}.tar.gz"

# Retention: remove backups older than 30 days
find "${BACKUP_DIR}" -name "nova-*.tar.gz" -mtime +30 -delete 2>/dev/null || true

echo "=== Backup complete ==="
