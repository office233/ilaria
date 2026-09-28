#!/bin/bash
set -e
cd /opt/swypik/app
git pull -q origin main
for f in favicon.ico favicon.svg favicon-32.png icon-192.png icon-512.png icon-maskable-192.png icon-maskable-512.png apple-touch-icon.png; do
  docker cp "public/$f" "swypik-prod-web-next-1:/app/public/$f"
done
md5sum public/favicon.ico
echo "ICONS DEPLOYED"
