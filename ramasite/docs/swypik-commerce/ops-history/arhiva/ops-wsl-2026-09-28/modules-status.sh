P="docker exec swypik-prod-postgres-1 psql -U swypik -d swypik_prod -tAc"
c(){ printf '%-34s %s\n' "$1" "$($P "select count(*) from $2" 2>/dev/null || echo 'n/a')"; }
echo "== conținut în DB =="
c "produse marketplace" marketplace_products
c "videoclipuri" videos
c "utilizatori" users
c "selleri" sellers
c "comenzi shop" commerce_orders
c "Go: curse" rides
c "Go: zone de preț" pricing_zones
c "Go/Food: curieri/șoferi" couriers
c "Food: localuri" local_merchants
c "Food: produse meniu" local_menu_items
c "Food: comenzi" local_orders
c "Stays: rezervări" stay_bookings
c "Stays: anunțuri (listings)" listings
c "Fly: rezervări zboruri" flight_bookings
c "Movies: seriale" movie_series
c "Movies: episoade" movie_episodes
c "Music: artiști" music_artists
c "Music: piese" music_tracks
c "News: articole publicate" "news_articles where status='published'"
c "Gaming: jocuri active" "gaming_games where is_active"
c "Cares: campanii" causes
c "Missions: active" "creator_missions where status='active'"
c "Live: stream-uri" live_streams
c "Squad: grupuri" squad_groups
echo; echo "== chei externe setate (nume) =="
E=/opt/swypik/app/infra/hetzner/.env.production
for k in DUFFEL_API_KEY RATEHAWK_KEY_ID RATEHAWK_API_KEY TRAVELPAYOUTS_TOKEN STRIPE_SECRET_KEY GEMINI_API_KEY GITHUB_TOKEN RESEND_API_KEY SMTP_HOST MAPBOX_TOKEN NEXT_PUBLIC_MAPBOX_TOKEN LIVEKIT_API_KEY JAMENDO_CLIENT_ID R2_ACCESS_KEY_ID; do grep -qE "^$k=.+" $E && echo "set    $k" || echo "LIPSĂ  $k"; done
echo; echo "== flag-uri în env =="; grep -E '^(NEXT_PUBLIC_)?FEATURE_' $E
