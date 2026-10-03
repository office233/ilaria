#!/usr/bin/env bash
# Enumerare rute cu parametri dinamici + verificare statică ownership/auth
cd /mnt/e/Meister/swypik/app || exit 1

echo '=== TOATE rutele API cu parametri dinamici ==='
find app/api -type f -name 'route.ts' | grep '\[' | sort

echo
echo '=== Rute [param] FARA nicio referinta la sesiune/auth/ownership (candidati IDOR) ==='
for f in $(find app/api -type f -name 'route.ts' | grep '\['); do
  # sarim rutele publice by design si cele protejate cu secret
  case "$f" in
    *webhooks*|*internal/*|*cron/*) continue;;
  esac
  if ! grep -qE 'getAuthUser|resolveUserSession|loadUserBySession|hasAdminSession|requireUser|getSession|verifySession|auth\(\)|session' "$f"; then
    echo "NO-SESSION: $f"
  fi
done

echo
echo '=== Rute [param] cu sesiune dar FARA filtrare pe user (posibil lipseste ownership) ==='
for f in $(find app/api -type f -name 'route.ts' | grep '\['); do
  case "$f" in
    *webhooks*|*internal/*|*cron/*|*admin/*) continue;;
  esac
  if grep -qE 'export async function (POST|PUT|PATCH|DELETE)' "$f"; then
    if grep -qE 'session|getAuthUser' "$f" && ! grep -qE 'user_id|userId|owner|creator_id|creatorId|rider_user_id|seller_id|sellerId|merchant|\.uid|is_admin|forbidden|403' "$f"; then
      echo "NO-OWNERSHIP?: $f"
    fi
  fi
done
echo '=== DONE ==='
