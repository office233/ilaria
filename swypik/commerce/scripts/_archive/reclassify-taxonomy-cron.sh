#!/bin/bash
# Cron: refresh i18n labels every run + LLM reclassify max once/day
set -e
cd /opt/swypik/app
set -a
. infra/hetzner/.env.production
set +a
export DATABASE_URL=$(echo "$DATABASE_URL" | sed 's|@postgres:|@127.0.0.1:|')

LOG_DIR=/opt/swypik/logs
mkdir -p "$LOG_DIR"

# 1) i18n labels (cheap, every run)
node scripts/seed-taxonomy-i18n.mjs >> "$LOG_DIR/reclassify-taxonomy.log" 2>&1

# 2) LLM reclassify only once per UTC day (rate-limited)
STAMP_FILE=/var/lib/swypik/last-llm-reclassify.date
mkdir -p /var/lib/swypik
TODAY=$(date -u +%Y-%m-%d)
LAST=$(cat "$STAMP_FILE" 2>/dev/null || echo "")

if [ "$LAST" != "$TODAY" ]; then
  echo "[$(date -u +%FT%TZ)] LLM reclassify start (last=$LAST today=$TODAY)" >> "$LOG_DIR/reclassify-taxonomy.log"
  export BATCH_SIZE=20
  export MIN_CONFIDENCE=0.5
  export INTER_BATCH_MS=200
  export STATUS_FILTER=all
  export OUT_FILE="$LOG_DIR/reclass-cron-$(date -u +%Y%m%d).json"
  if node scripts/reclassify-unresolved-studiai.mjs --apply >> "$LOG_DIR/reclassify-taxonomy.log" 2>&1; then
    echo "$TODAY" > "$STAMP_FILE"
    echo "[$(date -u +%FT%TZ)] LLM reclassify OK" >> "$LOG_DIR/reclassify-taxonomy.log"
  else
    echo "[$(date -u +%FT%TZ)] LLM reclassify FAILED" >> "$LOG_DIR/reclassify-taxonomy.log"
  fi
else
  echo "[$(date -u +%FT%TZ)] LLM reclassify skipped (already ran today)" >> "$LOG_DIR/reclassify-taxonomy.log"
fi
