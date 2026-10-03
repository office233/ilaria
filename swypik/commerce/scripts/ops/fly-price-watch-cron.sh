#!/bin/bash
# Rulat zilnic din crontab: scan preturi competitori Swypik Fly.
SECRET=$(grep '^CRON_SECRET=' /opt/swypik/app/infra/hetzner/.env.production | cut -d= -f2)
curl -s -H "x-cron-secret: $SECRET" http://localhost:3005/api/cron/fly-price-watch
