#!/usr/bin/env bash
# Ce migrari 20260730_* sunt aplicate + ce randuri incalca constraint-ul feed_events?
set -uo pipefail
PSQL="docker exec swypik-prod-postgres-1 psql -U swypik -d swypik_prod -tAc"

echo "== migrari aplicate azi =="
$PSQL "select name from schema_migrations where name like '20260730%' order by name" 2>&1

echo "== tabele noi exista? =="
for t in developer_accounts apps app_installs video_product_tags booking_slots donation_causes video_attributions; do
    echo -n "$t: "
    $PSQL "select to_regclass('public.$t') is not null" 2>&1
done

echo "== event_type-uri care incalca check-ul vechi =="
$PSQL "select event_type, count(*) from feed_events where event_type not in ('video_published','video_viewed','video_liked','video_saved','video_shared','comment_created','creator_followed','more_like_this','not_interested','video_hidden','creator_unfollowed') group by 1 order by 2 desc limit 10" 2>&1
