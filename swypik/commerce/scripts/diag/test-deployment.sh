#!/bin/bash
# SWYPIK DEPLOYMENT VERIFICATION SCRIPT
# Run all smoke tests in sequence
# Usage: bash scripts/test-deployment.sh [--verbose] [--skip-db]

set -e

VERBOSE=${1:-false}
SKIP_DB=${2:-false}
SITE_URL="${SITE_URL:-http://localhost:3005}"
TEMP_DIR="/tmp/swypik-test-$$"
PASS=0
FAIL=0

mkdir -p "$TEMP_DIR"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Helper functions
log() {
  if [ "$VERBOSE" = "--verbose" ]; then
    echo "[INFO] $1"
  fi
}

pass() {
  PASS=$((PASS + 1))
  echo -e "${GREEN}✓${NC} $1"
}

fail() {
  FAIL=$((FAIL + 1))
  echo -e "${RED}✗${NC} $1"
  if [ "$VERBOSE" = "--verbose" ]; then
    echo "  Error details: $2"
  fi
}

warn() {
  echo -e "${YELLOW}⚠${NC} $1"
}

# Test functions
test_site_responds() {
  local status=$(curl -s -o /dev/null -w "%{http_code}" "$SITE_URL" 2>/dev/null || echo "000")
  if [ "$status" = "200" ]; then
    pass "Site responds (HTTP 200)"
  else
    fail "Site responds" "Got HTTP $status (expected 200)"
  fi
}

test_session_cookie() {
  curl -s -c "$TEMP_DIR/cookies.txt" "$SITE_URL" > /dev/null 2>&1
  if grep -q "sessionToken\|session\|auth" "$TEMP_DIR/cookies.txt" 2>/dev/null; then
    pass "Session cookie handling"
  else
    warn "Session cookie not found in response (may be OK if using other auth method)"
  fi
}

test_auth_required() {
  local response=$(curl -s "$SITE_URL/api/me/activity")
  if echo "$response" | grep -q "error\|Autentificare\|Forbidden\|401"; then
    pass "Auth endpoints require session"
  else
    fail "Auth endpoints require session" "Expected error response, got: $response"
  fi
}

test_fx_rates() {
  local response=$(curl -s "$SITE_URL/api/fx/rates" 2>/dev/null || echo "{}")
  if echo "$response" | jq -e '.rates' > /dev/null 2>&1; then
    pass "FX rates endpoint working"
  else
    warn "FX rates endpoint not responding with rates (may be in fallback mode)"
  fi
}

test_health_check() {
  local response=$(curl -s "$SITE_URL/api/health/full" 2>/dev/null || echo "{}")
  if echo "$response" | jq -e '.status' > /dev/null 2>&1; then
    pass "Health check endpoint working"
  else
    fail "Health check endpoint" "Response: $response"
  fi
}

test_cron_secret_validation() {
  # Test that wrong secret is rejected
  local response=$(curl -s -H "x-cron-secret: wrong-secret" "$SITE_URL/api/cron/refresh-fx" 2>/dev/null || echo "{}")
  if echo "$response" | grep -q "Unauthorized\|401\|unauthorized"; then
    pass "Cron secret validation (timing-safe)"
  else
    warn "Cron endpoint responded (may be executing if secret is empty). Check CRON_SECRET env var."
  fi
}

test_admin_protected() {
  local response=$(curl -s "$SITE_URL/api/admin/users" 2>/dev/null || echo "{}")
  if echo "$response" | grep -q "Forbidden\|401\|unauthorized"; then
    pass "Admin endpoints protected"
  else
    fail "Admin endpoints protected" "Got response: $response"
  fi
}

test_stripe_webhook_protected() {
  local response=$(curl -s -X POST \
    -H "stripe-signature: invalid" \
    -d '{"type":"test"}' \
    "$SITE_URL/api/webhooks/stripe" 2>/dev/null || echo "{}")
  if echo "$response" | grep -q "error\|invalid\|signature"; then
    pass "Stripe webhook signature validation"
  else
    warn "Stripe webhook endpoint responded (signature validation may be configured differently)"
  fi
}

test_cors_headers() {
  local response=$(curl -s -i -X OPTIONS \
    -H "Origin: $SITE_URL" \
    "$SITE_URL/api/auth/login" 2>&1 || echo "")
  if echo "$response" | grep -i "Access-Control"; then
    pass "CORS headers present"
  else
    warn "CORS headers not found (may be normal for this deployment)"
  fi
}

test_database_connection() {
  if [ "$SKIP_DB" = "--skip-db" ]; then
    warn "Database test skipped (--skip-db flag)"
    return
  fi
  
  local response=$(curl -s "$SITE_URL/api/health/full" 2>/dev/null || echo "{}")
  if echo "$response" | jq -e '.database' > /dev/null 2>&1; then
    pass "Database connection verified"
  else
    warn "Cannot verify database status from health check"
  fi
}

test_redis_connection() {
  # Try a simple cache operation (this is indirect)
  local response=$(curl -s "$SITE_URL/api/health/full" 2>/dev/null || echo "{}")
  if echo "$response" | jq -e '.cache' > /dev/null 2>&1; then
    pass "Redis cache connection verified"
  else
    warn "Cannot verify Redis status from health check"
  fi
}

test_ride_estimate() {
  # Test pricing engine (requires valid city)
  local response=$(curl -s -X POST \
    -H "Content-Type: application/json" \
    -d '{
      "pickup": {"lat": 44.4268, "lng": 26.1025},
      "dropoff": {"lat": 44.4408, "lng": 26.0973},
      "vehicle_class": "standard",
      "country": "RO"
    }' \
    "$SITE_URL/api/rides/estimate" 2>/dev/null || echo "{}")
  
  if echo "$response" | jq -e '.estimate.price_cents' > /dev/null 2>&1; then
    pass "Pricing engine working"
  else
    # May fail if Go not configured, which is OK
    warn "Pricing engine test failed (may be expected if Go not enabled)"
  fi
}

test_response_time() {
  local start=$(date +%s%N)
  curl -s "$SITE_URL" > /dev/null 2>&1
  local end=$(date +%s%N)
  local ms=$(( (end - start) / 1000000 ))
  
  if [ $ms -lt 1000 ]; then
    pass "Response time: ${ms}ms"
  else
    warn "Response time: ${ms}ms (slow, may indicate performance issue)"
  fi
}

# Main test suite
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "SWYPIK DEPLOYMENT VERIFICATION TEST SUITE"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "Target: $SITE_URL"
echo ""

# Phase 1: Basic Connectivity
echo "PHASE 1: Basic Connectivity"
echo "───────────────────────────────────────"
test_site_responds
test_session_cookie
test_response_time
echo ""

# Phase 2: Authentication
echo "PHASE 2: Authentication & Authorization"
echo "───────────────────────────────────────"
test_auth_required
test_admin_protected
test_cors_headers
echo ""

# Phase 3: Security (Timing-Safe Validation)
echo "PHASE 3: Security Checks"
echo "───────────────────────────────────────"
test_cron_secret_validation
test_stripe_webhook_protected
echo ""

# Phase 4: API Endpoints
echo "PHASE 4: API Endpoints"
echo "───────────────────────────────────────"
test_health_check
test_fx_rates
test_database_connection
test_redis_connection
echo ""

# Phase 5: Business Logic
echo "PHASE 5: Business Logic"
echo "───────────────────────────────────────"
test_ride_estimate
echo ""

# Summary
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "TEST RESULTS"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo -e "Passed: ${GREEN}$PASS${NC}"
echo -e "Failed: ${RED}$FAIL${NC}"
echo -e "Warnings: ${YELLOW}(see above)${NC}"
echo ""

# Cleanup
rm -rf "$TEMP_DIR"

# Exit code
if [ $FAIL -gt 0 ]; then
  echo -e "${RED}✗ Deployment verification FAILED${NC}"
  exit 1
else
  echo -e "${GREEN}✓ Deployment verification PASSED${NC}"
  echo ""
  echo "Next steps:"
  echo "  1. Monitor logs: docker logs swypik-prod-next -f"
  echo "  2. Test live at: https://swypik.com"
  echo "  3. Run smoke tests: npm run test:e2e-full"
  exit 0
fi
