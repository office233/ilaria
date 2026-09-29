#!/usr/bin/env bash
set -u
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT" || exit 1

echo '=== 1. SQL injection: template literals in dbQuery/query ==='
grep -rn 'dbQuery(`\|query(`\|\.query(`' app lib --include='*.ts' | grep '\${' | grep -v '\.test\.' | head -20

echo '=== 2. comparatii == pe secrete (non timing-safe) ==='
grep -rn 'secret\b.*[!=]==\|[!=]== *secret\b\|CRON_SECRET\|INTERNAL_SECRET' app/api --include='*.ts' -l | while read f; do
  if grep -q 'CRON_SECRET\|INTERNAL_SECRET\|WEBHOOK_SECRET' "$f" \
    && grep -qE '\bsecret\b[[:space:]]*(==|===|!=|!==)|((==|===|!=|!==)[[:space:]]*\bsecret\b)' "$f" \
    && ! grep -q 'timingSafeEqual\|constructEvent\|verifySignature\|assertInternal\|requireCron\|isCronAuthorized' "$f"; then
    echo "SUSPECT: $f"; grep -n 'SECRET' "$f" | head -3
  fi
done

echo '=== 3. cron routes vs scheduler Azure ==='
for d in app/api/cron/*/; do basename "$d"; done | sort -u > /tmp/cron_routes.txt
grep -E '^[[:space:]]*[a-z0-9-]+\|(GET|POST)\|' infra/hetzner/cron-worker/run.sh \
  | sed -E 's/^[[:space:]]*([^|]+)\|.*/\1/' | sort -u > /tmp/cron_sched.txt
echo "routes=$(wc -l < /tmp/cron_routes.txt) scheduled=$(wc -l < /tmp/cron_sched.txt)"
echo '--- rute FARA schedule explicit in cron-worker ---'
comm -23 /tmp/cron_routes.txt /tmp/cron_sched.txt | sed 's/^/NO-SCHEDULE: /'
echo '--- joburi programate FARA ruta app/api/cron ---'
comm -13 /tmp/cron_routes.txt /tmp/cron_sched.txt | sed 's/^/NO-ROUTE: /'

echo '=== 4. mutatii fara sesiune (POST fara auth check) — sample scan ==='
for f in $(grep -rln 'export async function POST\|export async function DELETE\|export async function PUT\|export async function PATCH' app/api --include='route.ts' | grep -v 'webhooks\|internal\|cron\|auth/'); do
  if ! grep -qE 'session|Session|auth|Auth|require[A-Z]|getUser|getAuthUser|hasAdmin|verify|secret|Secret|token|Token' "$f"; then
    echo "NO-AUTH?: $f"
  fi
done | head -20

echo '=== DONE ==='
