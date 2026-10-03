echo "== chei în containerul web-next (nume) =="
docker exec swypik-prod-web-next-1 sh -c 'env | cut -d= -f1' | grep -iE 'DUFFEL|RATEHAWK|TRAVELPAYOUTS|AMADEUS|KIWI|MAPBOX|GOOGLE_MAPS|NOMINATIM|R2_|S3_|MINIO|SMTP|RESEND|GITHUB_TOKEN|OPENROUTER|LIVEKIT|JAMENDO|AUDIUS|HOTELBEDS|BOOKING|EXPEDIA|STRIPE' | sort
echo; echo "== tabele (stays/menu/causes/listings) =="
docker exec swypik-prod-postgres-1 psql -U swypik -d swypik_prod -tAc "select table_name from information_schema.tables where table_schema='public' and (table_name like '%stay%' or table_name like '%menu%' or table_name like '%cause%' or table_name like '%listing%' or table_name like '%hotel%' or table_name like '%host%') order by 1"
