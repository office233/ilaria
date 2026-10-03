#!/usr/bin/env bash
# Curăță datele de test E2E din baza de producție.
#
# ATENȚIE: rulează pe `swypik-prod-postgres-1` — baza REALĂ. De aceea e
# protejat de guard: implicit face DRY-RUN și nu șterge nimic.
#
#   ./cleanup-e2e.sh                          → arată ce s-ar șterge
#   CONFIRM_DESTRUCTIVE=yes ./cleanup-e2e.sh  → șterge efectiv

source "$(dirname "${BASH_SOURCE[0]}")/lib/guard-destructive.sh"
guard_destructive "cleanup-e2e"

PSQL="docker exec swypik-prod-postgres-1 psql -U swypik -d swypik_prod -tAc"

# Ordinea contează: întâi copiii (FK), apoi părintele `videos`.
run_sql "$PSQL" "DELETE FROM video_product_links WHERE video_id IN (SELECT id FROM videos WHERE title LIKE 'Test E2E%');"
run_sql "$PSQL" "DELETE FROM video_assets WHERE video_id IN (SELECT id FROM videos WHERE title LIKE 'Test E2E%');"
run_sql "$PSQL" "DELETE FROM video_upload_sessions WHERE video_id IN (SELECT id FROM videos WHERE title LIKE 'Test E2E%');"
run_sql "$PSQL" "DELETE FROM videos WHERE title LIKE 'Test E2E%';"

echo "videos rămase: $($PSQL "SELECT count(*) FROM videos;")"
