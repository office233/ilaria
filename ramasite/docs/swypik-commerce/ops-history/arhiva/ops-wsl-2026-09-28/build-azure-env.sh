#!/usr/bin/env bash
# Construiește env-urile de producție pentru Azure în /root/azure-env (WSL, niciodată pe discul Windows).
# Idempotent: parolele nou-generate se păstrează între rulări (secrets.env).
set -euo pipefail
umask 077
OUT=/root/azure-env; mkdir -p "$OUT"
SRC=/opt/swypik/app/infra/hetzner/.env.production
MERP=/opt/multi-erp/.env
OPS=/mnt/e/Swypik/ops/env
DATA_IP=10.60.2.10

# curăță un fișier env: fără CR, fără BOM, fără comentarii/linii goale
clean() { sed -e 's/\x0d$//' -e '1s/^\xef\xbb\xbf//' "$1" | grep -vE '^[[:space:]]*(#|$)' || true; }
val() { clean "$1" | grep -E "^$2=" | head -1 | cut -d= -f2-; }

# 1. secrete noi, generate o singură dată
if [ ! -f "$OUT/secrets.env" ]; then
  {
    echo "PG_PASSWORD=$(openssl rand -hex 24)"
    echo "REDIS_PASSWORD=$(openssl rand -hex 24)"
    echo "MULTI_ERP_PG_PASSWORD=$(openssl rand -hex 24)"
    echo "APP_ENCRYPTION_KEY=$(openssl rand -hex 32)"
    echo "MEDIA_SIGNING_SECRET=$(openssl rand -hex 32)"
    echo "FEED_EVENT_IP_SALT=$(openssl rand -hex 32)"
    p=$(val "$MERP" SWYPIK_PARTNER_SECRET); echo "PARTNER_PROVISION_SECRET=${p:-$(openssl rand -hex 32)}"
  } > "$OUT/secrets.env"
fi
grep -q '^FEED_EVENT_IP_SALT=' "$OUT/secrets.env" || echo "FEED_EVENT_IP_SALT=$(openssl rand -hex 32)" >> "$OUT/secrets.env"
set -a; . "$OUT/secrets.env"; set +a
INTERNAL_SECRET=$(val "$MERP" INTERNAL_SECRET)

# 2. swypik.env = prod actual, fără cheile moarte / înlocuite
DROP='^(DATABASE_URL|AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY|GEMINI_API_KEY|MINIO_ROOT_USER|MINIO_ROOT_PASSWORD|POSTGRES_DB|POSTGRES_USER|POSTGRES_PASSWORD|PUBLIC_UPLOAD_BASE_URL|REDIS_URL|S3_[A-Z_]+|RATE_LIMIT_REDIS_REQUIRED|INTERNAL_SECRET|PARTNER_PROVISION_SECRET|APP_ENCRYPTION_KEY|MEDIA_[A-Z_]+|FEED_EVENT_IP_SALT)='
{
  echo "# Swypik producție pe Azure — generat $(date -u +%FT%TZ) de build-azure-env.sh"
  clean "$SRC" | grep -vE "$DROP"
  echo "DATABASE_URL=postgres://swypik:${PG_PASSWORD}@${DATA_IP}:5432/swypik_prod"
  echo "REDIS_URL=redis://:${REDIS_PASSWORD}@${DATA_IP}:6379/0"
  echo "APP_ENCRYPTION_KEY=${APP_ENCRYPTION_KEY}"
  echo "INTERNAL_SECRET=${INTERNAL_SECRET}"
  echo "PARTNER_PROVISION_SECRET=${PARTNER_PROVISION_SECRET}"
  echo "MEDIA_SIGNING_SECRET=${MEDIA_SIGNING_SECRET}"
  echo "FEED_EVENT_IP_SALT=${FEED_EVENT_IP_SALT}"
  clean "$OPS/r2.env" | grep -E '^S3_'
  echo "S3_PRESIGN_ENDPOINT=$(val "$OPS/r2.env" S3_ENDPOINT)"
  echo "S3_PUBLIC_URL=https://media.swypik.com"
  echo "MEDIA_PUBLIC_BASE_URL=https://media.swypik.com"
  echo "NEXT_PUBLIC_MEDIA_PUBLIC_BASE_URL=https://media.swypik.com"
  echo "AWS_REQUEST_CHECKSUM_CALCULATION=when_required"
  echo "AWS_RESPONSE_CHECKSUM_VALIDATION=when_required"
  clean "$OPS/azure-ai.env" | grep -E '^AZURE_'
  echo "VIDEO_QUEUE_BACKEND=postgres"
  echo "FEATURE_CARES=0"
  echo "NEXT_PUBLIC_FEATURE_CARES=0"
} > "$OUT/swypik.env"

# 3. data.env (doar nodul data)
cat > "$OUT/data.env" <<EOT
DATA_BIND_IP=${DATA_IP}
POSTGRES_DB=swypik_prod
POSTGRES_USER=swypik
POSTGRES_PASSWORD=${PG_PASSWORD}
REDIS_PASSWORD=${REDIS_PASSWORD}
MULTI_ERP_PG_DB=multi_erp
MULTI_ERP_PG_USER=multi
MULTI_ERP_PG_PASSWORD=${MULTI_ERP_PG_PASSWORD}
EOT

# 4. multi-erp.env (doar web-1)
{
  clean "$MERP" | grep -vE '^(PG_HOST|PG_PORT|PG_DATABASE|PG_USER|PG_PASSWORD|SWYPIK_API_URL|APP_PUBLIC_URL)='
  echo "PG_HOST=${DATA_IP}"; echo "PG_PORT=5434"; echo "PG_DATABASE=multi_erp"; echo "PG_USER=multi"
  echo "PG_PASSWORD=${MULTI_ERP_PG_PASSWORD}"
  echo "SWYPIK_API_URL=https://swypik.com"; echo "APP_PUBLIC_URL=https://erp.swypik.com"
} > "$OUT/multi-erp.env"

chmod 600 "$OUT"/*.env
for f in swypik data multi-erp; do
  printf '%s.env: %s chei, BOM=%s, CR=%s, DATABASE_URL=%s\n' "$f" \
    "$(grep -c '=' "$OUT/$f.env")" "$(grep -c $'\xef\xbb\xbf' "$OUT/$f.env" || true)" \
    "$(grep -c $'\r' "$OUT/$f.env" || true)" "$(grep -c '^DATABASE_URL=' "$OUT/$f.env" || true)"
done
