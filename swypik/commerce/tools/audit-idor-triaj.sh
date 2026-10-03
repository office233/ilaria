#!/usr/bin/env bash
cd /mnt/e/Meister/swypik/app || exit 1
for f in \
  'app/api/admin/fleet/[id]/route.ts' \
  'app/api/admin/fleet-partners/[id]/route.ts' \
  'app/api/orders/[id]/route.ts' \
  'app/api/orders/[id]/return/route.ts' \
  'app/api/orders/[id]/return/photos/route.ts' \
  'app/api/seller/orders/[id]/refund/route.ts' \
  'app/api/seller/orders/[id]/return/accept/route.ts' \
  'app/api/developers/apps/[id]/rotate-secret/route.ts' \
  'app/api/developers/apps/[id]/route.ts' \
  'app/api/merchants/[id]/menu/route.ts' \
; do
  echo "═════ $f"
  head -40 "$f"
  echo
done
