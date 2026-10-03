#!/bin/bash
#
# north-star.sh — răspunde la singura întrebare care validează produsul:
# **comenzile reușite vin din clipuri sau din catalog?**
#
# DE CE EXISTĂ
# Teza Swypik e „cumperi prin video". Legătura e implementată
# (`commerce_order_items.video_id`), dar pe 19 august măsurătoarea era:
#     comenzi cu video_id: 0 / 13
# Toate cele 13 erau `failed` — Stripe rula cu chei placeholder. Deci teza nu e
# infirmată, e NETESTATĂ. Nu poate fi testată până nu există plăți reușite.
#
# Din prima comandă reușită, rulează asta săptămânal. Dacă `din_video` e
# adevărat la o parte din comenzi → direcția „marketplace video + creatori" e
# confirmată de date. Dacă e fals la toate → ai un marketplace obișnuit cu video
# decorativ. Ambele răspunsuri sunt utile; lipsa lor nu e.
#
# Rulare:  bash scripts/diag/north-star.sh
set -uo pipefail

PSQL=(docker exec -i "${PG_CONTAINER:-swypik-prod-postgres-1}" psql
      -U "${POSTGRES_USER:-swypik}" -d "${POSTGRES_DB:-swypik_prod}" -X)

echo "=== 1. Câte comenzi au reușit? ==="
"${PSQL[@]}" -c "SELECT status, count(*) FROM commerce_orders GROUP BY status ORDER BY status;"

echo
echo "=== 2. METRICA NORDICĂ: din câte comenzi reușite s-a pornit de la un clip? ==="
"${PSQL[@]}" -c "
SELECT count(DISTINCT o.id)                                   AS comenzi_reusite,
       count(DISTINCT o.id) FILTER (WHERE i.video_id IS NOT NULL) AS din_video,
       ROUND(100.0 * count(DISTINCT o.id) FILTER (WHERE i.video_id IS NOT NULL)
             / NULLIF(count(DISTINCT o.id), 0), 1)            AS procent
  FROM commerce_orders o
  JOIN commerce_order_items i ON i.order_id = o.id
 WHERE o.status IN ('paid','fulfilled','delivered');"

echo
echo "=== 3. Ultimele 20, una câte una ==="
"${PSQL[@]}" -c "
SELECT o.created_at::date AS zi, o.status,
       bool_or(i.video_id IS NOT NULL) AS din_video,
       bool_or(o.swyp_paid_cents > 0)  AS a_folosit_swyp
  FROM commerce_orders o
  JOIN commerce_order_items i ON i.order_id = o.id
 WHERE o.status IN ('paid','fulfilled','delivered')
 GROUP BY o.id, o.created_at, o.status
 ORDER BY o.created_at DESC
 LIMIT 20;"

echo
echo "=== 4. Context: câte clipuri au produse atașate ==="
"${PSQL[@]}" -t -A -c "
SELECT 'clipuri cu produse: '
     || count(*) FILTER (WHERE product_refs IS NOT NULL
                          AND product_refs::text NOT IN ('null','[]','{}'))
     || ' / ' || count(*) FROM videos;"

echo
echo "Interpretare:"
echo "  procent > 0  → teza 'cumperi prin video' începe să se valideze"
echo "  procent = 0 după 20+ comenzi → marketplace clasic, video decorativ"
echo "  0 comenzi reușite → încă nu ai ce măsura (verifică cheile Stripe)"
