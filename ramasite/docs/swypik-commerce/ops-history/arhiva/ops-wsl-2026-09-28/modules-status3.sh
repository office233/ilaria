P="docker exec swypik-prod-postgres-1 psql -U swypik -d swypik_prod -tAc"
for q in "menu_items" "donation_causes" "host_applications" "stay_availability" "stay_hotel_bookings" "marketplace_products where metadata->>'vertical' is not null" ; do printf '%-50s %s\n' "$q" "$($P "select count(*) from $q" 2>&1 | head -1)"; done
echo "== produse pe verticală/tip =="
$P "select coalesce(metadata->>'vertical', metadata->>'source_type', 'shop') v, count(*) from marketplace_products group by 1 order by 2 desc limit 15" 2>&1
$P "select column_name from information_schema.columns where table_name='marketplace_products' and column_name in ('vertical','taxonomy_node_slug','source_type','listing_type')" 2>&1
