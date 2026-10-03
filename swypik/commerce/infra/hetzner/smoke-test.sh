#!/usr/bin/env bash
# Swypik launch smoke test for the Hetzner production stack.
# It only performs safe reads and negative-path writes; it does not create real payments.
set -uo pipefail

WEB_BASE_URL="${WEB_BASE_URL:-https://swypik.com}"
API_BASE_URL="${API_BASE_URL:-https://api.swypik.com}"
SMOKE_TIMEOUT="${SMOKE_TIMEOUT:-10}"
SMOKE_PRODUCT_ID="${SMOKE_PRODUCT_ID:-}"
SMOKE_REQUIRE_PRODUCT="${SMOKE_REQUIRE_PRODUCT:-true}"

WEB_BASE_URL="${WEB_BASE_URL%/}"
API_BASE_URL="${API_BASE_URL%/}"

TMP_DIR="$(mktemp -d)"
LAST_BODY_FILE="${TMP_DIR}/body.txt"
LAST_ERR_FILE="${TMP_DIR}/curl.err"
LAST_STATUS=""
PASS_COUNT=0
FAIL_COUNT=0
WARN_COUNT=0

cleanup() {
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

usage() {
  cat <<EOF
Usage:
  WEB_BASE_URL=https://swypik.com API_BASE_URL=https://api.swypik.com ./infra/hetzner/smoke-test.sh

Optional env:
  SMOKE_PRODUCT_ID=<product-id>     Use a known product id instead of discovery.
  SMOKE_REQUIRE_PRODUCT=false       Warn instead of fail if no product can be discovered.
  SMOKE_TIMEOUT=10                  Per-request timeout in seconds.
EOF
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

log() {
  printf '%s\n' "$*"
}

pass() {
  PASS_COUNT=$((PASS_COUNT + 1))
  printf 'PASS %-34s %s\n' "$1" "$2"
}

fail() {
  FAIL_COUNT=$((FAIL_COUNT + 1))
  printf 'FAIL %-34s %s\n' "$1" "$2"
}

warn() {
  WARN_COUNT=$((WARN_COUNT + 1))
  printf 'WARN %-34s %s\n' "$1" "$2"
}

status_allowed() {
  local expected="$1"
  local actual="$2"
  local status
  IFS=',' read -ra statuses <<< "$expected"
  for status in "${statuses[@]}"; do
    status="${status//[[:space:]]/}"
    if [[ "$actual" == "$status" ]]; then
      return 0
    fi
  done
  return 1
}

body_snippet() {
  tr '\n' ' ' < "$LAST_BODY_FILE" | cut -c1-180
}

request() {
  local name="$1"
  local method="$2"
  local url="$3"
  local expected="$4"
  local json_body="${5:-}"
  local curl_exit
  local curl_args=(
    -sS
    -L
    --max-time "$SMOKE_TIMEOUT"
    -o "$LAST_BODY_FILE"
    -w "%{http_code}"
    -H "User-Agent: swypik-smoke-test/1.0"
    -X "$method"
  )

  : > "$LAST_BODY_FILE"
  : > "$LAST_ERR_FILE"

  if [[ -n "$json_body" ]]; then
    curl_args+=(-H "Content-Type: application/json" --data "$json_body")
  fi

  curl_args+=("$url")
  LAST_STATUS="$(curl "${curl_args[@]}" 2>"$LAST_ERR_FILE")"
  curl_exit=$?

  if [[ "$curl_exit" -ne 0 ]]; then
    fail "$name" "curl failed: $(tr '\n' ' ' < "$LAST_ERR_FILE" | cut -c1-180)"
    return 1
  fi

  if status_allowed "$expected" "$LAST_STATUS"; then
    pass "$name" "HTTP ${LAST_STATUS}"
    return 0
  fi

  fail "$name" "expected status ${expected}, got ${LAST_STATUS}; body: $(body_snippet)"
  return 1
}

require_body() {
  local name="$1"
  local pattern="$2"
  if grep -q "$pattern" "$LAST_BODY_FILE"; then
    pass "$name body" "contains ${pattern}"
  else
    fail "$name body" "missing ${pattern}; body: $(body_snippet)"
  fi
}

discover_product_id() {
  if [[ -n "$SMOKE_PRODUCT_ID" ]]; then
    printf '%s' "$SMOKE_PRODUCT_ID"
    return 0
  fi

  local body_file="${TMP_DIR}/products.json"
  local status
  status="$(curl -sS -L --max-time "$SMOKE_TIMEOUT" -o "$body_file" -w "%{http_code}" \
    -H "User-Agent: swypik-smoke-test/1.0" \
    "${WEB_BASE_URL}/api/products?limit=1" 2>"$LAST_ERR_FILE")"

  if [[ "$status" != "200" ]]; then
    printf ''
    return 1
  fi

  sed -n 's/.*"id"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$body_file" | head -n 1
}

log "Swypik launch smoke test"
log "  web: ${WEB_BASE_URL}"
log "  api: ${API_BASE_URL}"
log "  timeout: ${SMOKE_TIMEOUT}s"
log ""

request "web health" "GET" "${WEB_BASE_URL}/api/health" "200"
require_body "web health" '"status"'

request "platform healthz" "GET" "${API_BASE_URL}/healthz" "200"
require_body "platform healthz" '"status"'

request "platform readyz" "GET" "${API_BASE_URL}/readyz" "200"
require_body "platform readyz" '"status"'

log ""
log "Pages"
request "homepage" "GET" "${WEB_BASE_URL}/" "200"
request "explore page" "GET" "${WEB_BASE_URL}/explore" "200"
request "account page" "GET" "${WEB_BASE_URL}/account" "200"
request "creator upload page" "GET" "${WEB_BASE_URL}/creator/upload" "200"
request "seller page" "GET" "${WEB_BASE_URL}/seller" "200"
request "admin page" "GET" "${WEB_BASE_URL}/admin" "200"

PRODUCT_ID="$(discover_product_id || true)"
if [[ -n "$PRODUCT_ID" ]]; then
  pass "product discovery" "$PRODUCT_ID"
  request "product page" "GET" "${WEB_BASE_URL}/product/${PRODUCT_ID}" "200"
else
  if [[ "$SMOKE_REQUIRE_PRODUCT" == "true" ]]; then
    fail "product discovery" "no product id found; set SMOKE_PRODUCT_ID to a known active product"
  else
    warn "product discovery" "no product id found; product page check skipped"
  fi
fi

log ""
log "Next.js API"
request "products api" "GET" "${WEB_BASE_URL}/api/products?limit=1" "200"
if [[ -n "$PRODUCT_ID" ]]; then
  request "product detail api" "GET" "${WEB_BASE_URL}/api/products/${PRODUCT_ID}" "200"
fi
request "explore feed api" "GET" "${WEB_BASE_URL}/api/explore/feed?limit=1" "200"
request "account auth api" "GET" "${WEB_BASE_URL}/api/auth" "200"
request "creator upload unauth" "POST" "${WEB_BASE_URL}/api/creator/upload-session" "401" '{"filename":"smoke.mp4","contentType":"video/mp4","sizeBytes":1024}'
request "seller dashboard unauth" "GET" "${WEB_BASE_URL}/api/seller/dashboard" "401"
request "admin marketplace unauth" "GET" "${WEB_BASE_URL}/api/admin/marketplace" "401"
request "checkout empty cart" "POST" "${WEB_BASE_URL}/api/checkout" "400" '{"products":[]}'
request "payment intent empty cart" "POST" "${WEB_BASE_URL}/api/checkout/create-intent" "400" '{"products":[]}'
request "Stripe webhook bad signature" "POST" "${WEB_BASE_URL}/api/webhooks/stripe" "400" '{}'

log ""
log "Platform API hardening"
request "platform upload unauth" "POST" "${API_BASE_URL}/v1/videos/uploads/init" "401" '{"creator_id":"smoke","filename":"smoke.mp4","content_type":"video/mp4","size_bytes":1024}'
request "platform events unauth" "POST" "${API_BASE_URL}/v1/events/batch" "401" '{"events":[]}'

log ""
log "Summary: ${PASS_COUNT} passed, ${WARN_COUNT} warnings, ${FAIL_COUNT} failed"

if [[ "$FAIL_COUNT" -gt 0 ]]; then
  exit 1
fi
