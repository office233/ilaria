#!/bin/bash
# Import video-uri royalty-free (Pexels, licență liberă) pe profilul oficial Swypik,
# legate de destinații Swypik Fly prin metadata {vertical:"fly", iata}.
# Rulează PE VPS. Creează sesiune admin temporară pentru API.
set -e
PSQL="docker exec swypik-prod-postgres-1 psql -U swypik -d swypik_prod -tAc"

OFFICIAL_ID=$($PSQL "SELECT id FROM users WHERE username='swypik' LIMIT 1;")
echo "official: $OFFICIAL_ID"
[ -z "$OFFICIAL_ID" ] && echo "FARA PROFIL OFICIAL - STOP" && exit 1

# Auth admin cu ADMIN_SECRET din env-ul containerului (Bearer)
ADMIN_SECRET=$(docker exec swypik-prod-web-next-1 printenv ADMIN_SECRET)
[ -z "$ADMIN_SECRET" ] && echo "FARA ADMIN_SECRET - STOP" && exit 1

import_one() {
  local url="$1" title="$2" desc="$3" iata="$4" city="$5"
  echo "--- $title ($iata)"
  curl -s -X POST https://swypik.com/api/admin/videos \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer $ADMIN_SECRET" \
    -d "{\"action\":\"import_url\",\"sourceUrl\":\"$url\",\"title\":\"$title\",\"description\":\"$desc\",\"creatorId\":\"$OFFICIAL_ID\",\"tags\":[\"travel\",\"fly\",\"$iata\"],\"metadata\":{\"vertical\":\"fly\",\"iata\":\"$iata\",\"city\":\"$city\",\"source\":\"pexels\",\"license\":\"pexels-free\"}}" | head -c 300
  echo ""
}

# Video-uri verticale Pexels (licență Pexels — utilizare comercială permisă, fără atribuire)
import_one "https://www.pexels.com/download/video/1739010/" "Santorini, magia Cicladelor 🇬🇷" "Apusuri ireale peste Marea Egee. Zboruri spre Atena direct pe Swypik Fly ✈️ swypik.com/fly" "ATH" "Atena"
import_one "https://www.pexels.com/download/video/3015510/" "Barcelona vibes 🇪🇸" "Gaudí, plajă și tapas. Rezervă zborul spre Barcelona pe Swypik Fly ✈️ swypik.com/fly" "BCN" "Barcelona"
import_one "https://www.pexels.com/download/video/2169880/" "Paris, orașul luminilor 🇫🇷" "Turnul Eiffel te așteaptă. Zboruri spre Paris pe Swypik Fly ✈️ swypik.com/fly" "CDG" "Paris"
import_one "https://www.pexels.com/download/video/1580455/" "Roma eternă 🇮🇹" "Colosseum, Fontana di Trevi și cea mai bună pizza. Zboruri spre Roma pe Swypik Fly ✈️ swypik.com/fly" "FCO" "Roma"
import_one "https://www.pexels.com/download/video/1721294/" "Londra, mereu surprinzătoare 🇬🇧" "Big Ben, Camden și muzee gratuite. Zboruri spre Londra pe Swypik Fly ✈️ swypik.com/fly" "LHR" "Londra"
import_one "https://www.pexels.com/download/video/2867873/" "Amsterdam pe canale 🇳🇱" "Biciclete, canale și lalele. Zboruri spre Amsterdam pe Swypik Fly ✈️ swypik.com/fly" "AMS" "Amsterdam"

echo "=== stare joburi ==="
sleep 5
$PSQL "SELECT v.title, v.status, j.status AS job FROM videos v LEFT JOIN video_processing_jobs j ON j.video_id=v.id WHERE v.creator_id='$OFFICIAL_ID' ORDER BY v.created_at DESC LIMIT 10;"

echo "DONE"
