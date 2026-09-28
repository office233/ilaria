#!/usr/bin/env bash
cd /mnt/e/Meister/swypik/app || exit 1

echo '=== 1. Floating promises pe operatii critice (void fara await pe email/notif/payout) ==='
grep -rnE 'void (send|notify|enqueue|dispatch|process|payout|refund|charge|transfer)[A-Za-z]*\(' app lib --include='*.ts' | grep -v '\.test\.' | head -20

echo
echo '=== 2. .catch(() => {}) — erori inghitite silentios pe cai critice ==='
grep -rnE '\.catch\(\(\) ?=> ?\{\}\)|\.catch\(\(\) ?=> ?null\)|\.catch\(\(\) ?=> ?undefined\)' app/api lib --include='*.ts' | grep -iE 'payout|refund|charge|transfer|email|webhook|ledger|wallet|swyp' | head -15

echo
echo '=== 3. Componente/rute mamut (>500 linii) ==='
find app lib components -name '*.tsx' -o -name '*.ts' | while read f; do
  n=$(wc -l < "$f")
  [ "$n" -gt 500 ] && echo "$n $f"
done | sort -rn | head -20

echo
echo '=== 4. Rute API care arunca 500 pe req.json() fara catch ==='
for f in $(grep -rln 'await req.json()' app/api --include='route.ts'); do
  if ! grep -q 'req.json().catch\|catch' "$f"; then echo "NO-CATCH-JSON: $f"; fi
done | head -20

echo '=== DONE ==='
