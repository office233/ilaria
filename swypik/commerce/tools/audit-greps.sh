#!/usr/bin/env bash
# Audit greps — vânătoare hardcodări (rulat din rădăcina repo)
cd "$(dirname "$0")/.." || exit 1

echo '=== 1. emailuri/telefoane hardcodate ==='
grep -rn 'hello@\|suport@\|support@swypik\|contact@\|07[0-9]\{8\}' app lib components --include='*.ts' --include='*.tsx' 2>/dev/null | grep -v 'lib/contact\|process\.env\|\.test\.' | head -15

echo '=== 2. secrete suspecte ==='
grep -rniE "(api_?key|secret|password|token)[\"']?\s*[:=]\s*[\"'][A-Za-z0-9_/+-]{20,}[\"']" app lib workers services --include='*.ts' --include='*.tsx' 2>/dev/null | grep -viv 'process\.env\|test\|placeholder\|example\|your_\|xxx\|type \|interface ' | head -15

echo '=== 3. dead refs package.json ==='
node -e '
const p=require("./package.json");const fs=require("fs");
for(const [k,v] of Object.entries(p.scripts||{})){
  const m=v.match(/(?:node|bash|sh|tsx|python3?)\s+([^\s&|;]+\.(?:mjs|js|ts|sh|py))/g)||[];
  for(const cmd of m){const f=cmd.split(/\s+/).pop();if(!fs.existsSync(f))console.log("MISSING:",k,"->",f);}
}'

echo '=== 4. texte RO hardcodate in API errors ==='
grep -rn 'error:.*[ăâîșț]\|reason:.*[ăâîșț]' app/api --include='*.ts' | head -15

echo '=== 5. env vars folosite dar nedocumentate in .env.example ==='
grep -rhoE 'process\.env\.[A-Z0-9_]+' app lib workers scripts middleware.ts --include='*.ts' --include='*.tsx' --include='*.mjs' 2>/dev/null | sed 's/process\.env\.//' | sort -u > /tmp/env_used.txt
grep -oE '^[A-Z0-9_]+' .env.example 2>/dev/null | sort -u > /tmp/env_doc.txt
comm -23 /tmp/env_used.txt /tmp/env_doc.txt | grep -v '^NODE_ENV$\|^NEXT_RUNTIME$\|^CI$\|^HOME$\|^PATH$\|^HOSTNAME$\|^VERCEL' | head -40

echo '=== 6. i18n baseline ==='
cat .i18n-baseline.json

echo '=== 7. stringuri user-facing in JSX fara t() (sample) ==='
grep -rn '>[A-ZĂÂÎȘȚ][a-zăâîșț]\+ [a-zăâîșț]' app/\[locale\] components --include='*.tsx' 2>/dev/null | grep -v 't(\|Trans\|className\|//' | head -10

echo '=== DONE ==='
