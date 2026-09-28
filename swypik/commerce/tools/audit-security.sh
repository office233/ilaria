#!/usr/bin/env bash
cd /mnt/e/Meister/swypik/app || exit 1

echo '=== 1. SQL injection: template literals in dbQuery/query ==='
grep -rn 'dbQuery(`\|query(`\|\.query(`' app lib --include='*.ts' | grep '\${' | grep -v '\.test\.' | head -20

echo '=== 2. comparatii == pe secrete (non timing-safe) ==='
grep -rn 'secret\b.*[!=]==\|[!=]== *secret\b\|CRON_SECRET\|INTERNAL_SECRET' app/api --include='*.ts' -l | while read f; do
  if grep -q 'CRON_SECRET\|INTERNAL_SECRET\|WEBHOOK_SECRET' "$f" && ! grep -q 'timingSafeEqual\|constructEvent\|verifySignature\|assertInternal\|requireCron' "$f"; then
    echo "SUSPECT: $f"; grep -n 'SECRET' "$f" | head -3
  fi
done

echo '=== 3. cron routes vs crontab ==='
ls app/api/cron/ | sort > /tmp/cron_routes.txt
cat /tmp/cron_routes.txt | wc -l
echo '--- crontab WSL ---'
crontab -l 2>/dev/null | grep -o 'cron/[a-z-]*' | sort -u > /tmp/cron_sched.txt
cat /tmp/cron_sched.txt | wc -l
echo '--- rute FARA schedule in crontab ---'
for r in $(cat /tmp/cron_routes.txt); do grep -q "cron/$r" /tmp/cron_sched.txt || echo "NO-SCHEDULE: $r"; done
echo '--- run.sh / scripts care apeleaza cron ---'
grep -rl 'api/cron' scripts/*.sh 2>/dev/null | head

echo '=== 4. mutatii fara sesiune (POST fara auth check) — sample scan ==='
for f in $(grep -rln 'export async function POST\|export async function DELETE\|export async function PUT\|export async function PATCH' app/api --include='route.ts' | grep -v 'webhooks\|internal\|cron\|auth/'); do
  if ! grep -qE 'session|Session|auth|Auth|requireUser|getUser|hasAdmin|verify|secret|Secret|token|Token' "$f"; then
    echo "NO-AUTH?: $f"
  fi
done | head -20

echo '=== DONE ==='
