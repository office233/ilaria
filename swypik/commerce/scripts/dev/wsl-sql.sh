#!/bin/bash
# psql helper: sed 's/\r//' wsl-sql.sh | bash -s -- "SELECT ..."
docker exec swypik-prod-postgres-1 psql -U swypik -d swypik_prod -t -A -c "$1"
