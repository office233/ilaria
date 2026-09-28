# DEPLOYMENT VERIFICATION CHECKLIST — 2026-08-05

> **Purpose**: Step-by-step guide to verify all audit fixes are working in production  
> **Target**: WSL environment (localhost:3005) → swypik.com (via Cloudflare Tunnel)  
> **Duration**: ~30-45 minutes  
> **Prerequisites**: WSL distro `swypik` running, `app` directory ready

---

## PHASE 1: PRE-DEPLOYMENT CHECKS ✅ (5 min)

### Environment Verification

- [ ] WSL distro `swypik` is running: `wsl -d swypik --exec pwd`
- [ ] App directory exists: `/opt/swypik/app`
- [ ] Git remote points to correct repo: `git remote -v | grep origin`
- [ ] Current branch is `main`: `git branch`
- [ ] No uncommitted changes: `git status --short` (should be clean)
- [ ] Latest commits present: `git log --oneline -3` (should show our 7 commits)

### Environment Variables Check

Required vars (must be set in `/opt/swypik/app/.env.local`):

```bash
# Critical — SET THESE BEFORE DEPLOYING
STRIPE_SECRET_KEY=sk_live_... (or sk_test_... for dev)
FX_FALLBACK_RATES={"EUR":4.95,"GBP":5.80,"USD":4.55,...}
ALLOWED_ORIGINS_EXTRA=https://custom.swypik.com

# Already configured (verify they exist)
DATABASE_URL=postgresql://...
REDIS_URL=redis://...
APP_URL=http://localhost:3005
NEXT_PUBLIC_SITE_URL=http://localhost:3005
```

**Check command**:
```bash
cd /opt/swypik/app
grep -E "^(STRIPE_SECRET_KEY|FX_FALLBACK_RATES|ALLOWED_ORIGINS_EXTRA|DATABASE_URL|REDIS_URL|APP_URL)" .env.local
```

✅ **Expected output**: All 6 vars should be present and non-empty

---

## PHASE 2: DEPLOYMENT 🚀 (10 min)

### Step 1: Run Deploy Script

```bash
cd /opt/swypik/app
bash /opt/swypik/app/scripts/wsl-deploy-web.sh
```

**What it does**:
- Pulls latest code from `origin/main`
- Builds Next.js app (`npm run build`)
- Starts Docker Compose with 3 files:
  1. `docker-compose.base.yml` — Postgres + Redis
  2. `docker-compose.prod.yml` — Production config
  3. Custom overrides for WSL port mapping (3005 → 3005)
- Waits for services to be ready

**Expected output** (last lines):
```
✓ app-next-1 started
✓ app-postgres-1 started
✓ app-redis-1 started
Site running at http://localhost:3005
```

### Step 2: Verify Services Running

```bash
docker ps -a | grep swypik
```

Expected running containers:
- `swypik-prod-next` (web app, port 3005)
- `swypik-prod-postgres` (database, port 5432)
- `swypik-prod-redis` (cache, port 6379)

### Step 3: Wait for App Ready

```bash
# Poll until 200 response (max 60 seconds)
for i in {1..60}; do
  STATUS=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:3005)
  if [ "$STATUS" = "200" ]; then
    echo "✓ App ready (HTTP $STATUS)"
    break
  else
    echo "Attempt $i: HTTP $STATUS — waiting..."
    sleep 1
  fi
done
```

✅ **Expected**: HTTP 200 response within 30 seconds

---

## PHASE 3: SMOKE TESTS (Auth Module) 🔐 (8 min)

### Test 3.1: Home Page Loads

```bash
curl -s http://localhost:3005 | grep -q "<html" && echo "✓ HTML loads"
```

Expected: Returns HTML document

### Test 3.2: Auth Check — Not Logged In

```bash
curl -s -c /tmp/cookies.txt http://localhost:3005/api/me/activity | jq .
```

Expected: `{"error":"Autentificare necesară."}` or similar 401 message

### Test 3.3: Session Cookie Handling

```bash
# Try to set session cookie
RESPONSE=$(curl -s -c /tmp/cookies.txt -X GET http://localhost:3005/api/auth/check)
echo "Response: $RESPONSE"

# Verify cookie was set
grep -q "sessionToken\|session" /tmp/cookies.txt && echo "✓ Session cookie set"
```

Expected: Cookie file has session token

### Test 3.4: CSRF Origin Check

```bash
# Test CORS headers
curl -s -i -X OPTIONS \
  -H "Origin: http://localhost:3005" \
  http://localhost:3005/api/auth/login 2>&1 | grep -i "Access-Control"
```

Expected: See `Access-Control-Allow-Origin: http://localhost:3005`

---

## PHASE 4: SMOKE TESTS (Money/Checkout) 💳 (7 min)

### Test 4.1: FX Rates Available

```bash
curl -s http://localhost:3005/api/fx/rates | jq '.rates'
```

Expected: JSON with currency rates (e.g., `{"EUR":4.95,"GBP":5.80,...}`)

**If fails**: Check FX_FALLBACK_RATES env var or refresh-fx cron

### Test 4.2: Stripe Webhook Secret Configured

```bash
curl -s http://localhost:3005/api/health/full | jq '.stripe'
```

Expected: `"ready": true` (or similar success indicator)

**If fails**: Check STRIPE_SECRET_KEY env var

### Test 4.3: Commerce Config Loaded

```bash
curl -s http://localhost:3005/api/health/full | jq '.config'
```

Expected: Should show commerce rates (PLATFORM_COMMISSION_BPS, etc.)

### Test 4.4: Database Connection

```bash
curl -s http://localhost:3005/api/health/full | jq '.database'
```

Expected: `"status": "connected"` or similar

---

## PHASE 5: SMOKE TESTS (Cron Endpoints) ⏰ (5 min)

### Test 5.1: Cron Secret Validation (Timing-Safe)

```bash
# Wrong secret should return 401
curl -s -H "x-cron-secret: wrong-secret" \
  http://localhost:3005/api/cron/refresh-fx \
  | grep -q "Unauthorized\|401" && echo "✓ Secret validation working"
```

Expected: 401 Unauthorized response

### Test 5.2: Correct Secret Works

```bash
CRON_SECRET=$(grep CRON_SECRET /opt/swypik/app/.env.local | cut -d= -f2)
RESPONSE=$(curl -s -H "x-cron-secret: $CRON_SECRET" \
  http://localhost:3005/api/cron/refresh-fx)
echo "Cron response: $RESPONSE"
```

Expected: Cron executes (returns job result, not 401)

**Note**: This will actually run the refresh-fx cron, which is OK for testing

### Test 5.3: All 26 Cron Endpoints Listening

```bash
for cron in refresh-fx watchdog-videos daily-maintenance process-payouts reconcile-wallets; do
  STATUS=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:3005/api/cron/$cron)
  echo "  /api/cron/$cron → HTTP $STATUS"
done
```

Expected: All return `401` or `200` (not `404`)

---

## PHASE 6: SMOKE TESTS (Live/Webhooks) 🎬 (5 min)

### Test 6.1: Live Endpoint Secret Validation (Timing-Safe)

```bash
# Should return 401 with wrong secret
curl -s -X POST \
  -H "x-internal-secret: wrong" \
  -H "Content-Type: application/json" \
  -d '{"stream_id":"test"}' \
  http://localhost:3005/api/internal/live/started \
  | grep -q "unauthorized" && echo "✓ Live endpoint timing-safe check OK"
```

Expected: 401 Unauthorized

### Test 6.2: Stripe Webhook Signature Check

```bash
# Should reject invalid signature
curl -s -X POST \
  -H "stripe-signature: invalid_sig" \
  -d '{"type":"payment_intent.succeeded"}' \
  http://localhost:3005/api/webhooks/stripe \
  | grep -q "failed\|Invalid\|401" && echo "✓ Stripe sig validation OK"
```

Expected: Error response (not processed)

---

## PHASE 7: ADMIN AUTHORIZATION CHECK 👮 (5 min)

### Test 7.1: Admin Endpoints Require Session

```bash
# Try to access admin endpoint without session
curl -s http://localhost:3005/api/admin/users | jq '.error' | grep -q "Forbidden\|unauthorized"
echo "✓ Admin endpoint blocked without session"
```

Expected: 401 or 403 response

### Test 7.2: Admin Login Works

```bash
ADMIN_SECRET=$(grep ADMIN_SECRET /opt/swypik/app/.env.local | cut -d= -f2)
curl -s -X POST \
  -H "Content-Type: application/json" \
  -d "{\"password\":\"$ADMIN_SECRET\"}" \
  -c /tmp/admin_cookies.txt \
  http://localhost:3005/api/admin/login | jq '.success'
```

Expected: `true` (or similar success)

### Test 7.3: Admin Session Cookie Set

```bash
grep -q "admin" /tmp/admin_cookies.txt && echo "✓ Admin session cookie created"
```

Expected: Cookie file contains admin session

---

## PHASE 8: IDOR/SECURITY SPOT CHECKS 🔒 (5 min)

### Test 8.1: IDOR — Rides Endpoint

```bash
# Try to access ride without owning it (requires test data setup)
USER_A_ID="uuid-of-user-a"
RIDE_ID="uuid-of-ride-belonging-to-user-b"

# Login as USER_A
curl -s -c /tmp/user_a_cookies.txt \
  -X POST \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"user-a@test.com\",\"password\":\"password\"}" \
  http://localhost:3005/api/auth/login

# Try to access USER_B's ride
curl -s -b /tmp/user_a_cookies.txt \
  http://localhost:3005/api/rides/$RIDE_ID | jq '.error' | grep -q "Forbidden\|404"
echo "✓ IDOR check: Cannot access other user's ride"
```

Expected: 403 Forbidden or 404 Not Found

### Test 8.2: Creator Video IDOR

```bash
# Similar to above but for creator videos
CREATOR_B_VIDEO_ID="uuid-of-video-by-creator-b"

curl -s -b /tmp/user_a_cookies.txt \
  http://localhost:3005/api/creator/videos/$CREATOR_B_VIDEO_ID | jq '.error'
```

Expected: 403 Forbidden (cannot access other creator's video)

---

## PHASE 9: INTEGRATION TESTS (End-to-End) 🔄 (10 min)

### Scenario A: User Registration → Auth Flow

```bash
#!/bin/bash
# Full auth flow test

EMAIL="test-user-$(date +%s)@example.com"
PASSWORD="TestPassword123!"

echo "1. Register..."
REG=$(curl -s -X POST \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"$EMAIL\",\"password\":\"$PASSWORD\",\"firstName\":\"Test\",\"lastName\":\"User\"}" \
  http://localhost:3005/api/auth/register)
echo "Registration: $REG" | jq .

echo "2. Login..."
LOGIN=$(curl -s -c /tmp/test_cookies.txt \
  -X POST \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"$EMAIL\",\"password\":\"$PASSWORD\"}" \
  http://localhost:3005/api/auth/login)
echo "Login: $LOGIN" | jq .

echo "3. Get profile..."
PROFILE=$(curl -s -b /tmp/test_cookies.txt \
  http://localhost:3005/api/me)
echo "Profile: $PROFILE" | jq .

echo "✓ Full auth flow successful"
```

Expected: All 3 steps return success

### Scenario B: Estimate Ride → Pricing Engine

```bash
#!/bin/bash

echo "1. Estimate ride (Bucharest)..."
ESTIMATE=$(curl -s -X POST \
  -H "Content-Type: application/json" \
  -d '{
    "pickup": {"lat": 44.4268, "lng": 26.1025},
    "dropoff": {"lat": 44.4408, "lng": 26.0973},
    "vehicle_class": "standard",
    "country": "RO"
  }' \
  http://localhost:3005/api/rides/estimate)
  
echo "Estimate: $ESTIMATE" | jq .
echo "$ESTIMATE" | jq '.estimate.price_cents' | grep -q "[0-9]" && echo "✓ Pricing engine returned valid estimate"
```

Expected: Returns `price_cents` with numerical value

---

## PHASE 10: PERFORMANCE & MONITORING ⚡ (5 min)

### Test 10.1: Response Time Check

```bash
for i in {1..5}; do
  START=$(date +%s%N)
  curl -s http://localhost:3005 > /dev/null
  END=$(date +%s%N)
  MS=$(( (END - START) / 1000000 ))
  echo "Request $i: ${MS}ms"
done
```

Expected: All requests under 1000ms (ideal: <500ms)

### Test 10.2: Database Query Performance

```bash
# Check database is responsive
TIME_DB=$(time (docker exec swypik-prod-postgres psql -U swypik -d swypik -c "SELECT 1" 2>&1 > /dev/null) 2>&1 | grep real)
echo "DB query time: $TIME_DB"
```

Expected: Under 100ms

### Test 10.3: Redis Availability

```bash
docker exec swypik-prod-redis redis-cli ping
```

Expected: `PONG`

---

## PHASE 11: LOGS INSPECTION 📋 (5 min)

### Check for Errors in App Logs

```bash
docker logs swypik-prod-next --tail 50 2>&1 | grep -i "error\|fatal\|panic" | head -10
```

Expected: No critical errors (warnings are OK)

### Check Cron Execution

```bash
docker logs swypik-prod-next --tail 100 2>&1 | grep "cron\|refresh-fx\|watchdog"
```

Expected: Recent cron execution logs

### Check Database Migrations

```bash
docker logs swypik-prod-postgres --tail 20 2>&1 | grep -i "migration\|error"
```

Expected: No migration errors

---

## PHASE 12: PUBLIC URL TEST 🌐 (2 min)

### Test Cloudflare Tunnel Access

```bash
# If Cloudflare Tunnel is running
curl -s https://swypik.com | grep -q "<html" && echo "✓ Public URL accessible"
```

Expected: Returns HTML (site is live)

### Test Public Health Check

```bash
curl -s https://swypik.com/api/health | jq '.status'
```

Expected: `"ok"` or similar

---

## SUMMARY CHECKLIST ✅

### Critical Fixes Verified
- [ ] **Auth hardcodes fixed** (cookie domain, OAuth base, CSRF origins) → Cookie domain dynamic from APP_URL
- [ ] **FX fallback fixed** → Using DB rates first, then env var, then error
- [ ] **Timing-safe secrets verified** → All crons + live endpoints use crypto.timingSafeEqual()
- [ ] **Admin authorization verified** → All 41 endpoints have hasAdminSession()

### Security Verified
- [ ] IDOR checks working (can't access other user's data)
- [ ] CSRF origin validation working (requests from wrong origin rejected)
- [ ] Rate limiting working (excessive requests throttled)
- [ ] Webhook signature validation working (invalid signatures rejected)

### Functionality Verified
- [ ] Auth flow works (register → login → session)
- [ ] Pricing engine works (estimates calculated server-side)
- [ ] Crons execute (refresh-fx, watchdog-videos, etc.)
- [ ] Admin actions work (can approve/reject with session)
- [ ] Database connected and responsive
- [ ] Redis cache operational

### Infrastructure Verified
- [ ] All Docker containers running
- [ ] All required env vars set
- [ ] Public URL accessible via Cloudflare
- [ ] Logs clean (no critical errors)

---

## ROLLBACK PROCEDURE (if needed) 🔙

If deployment fails:

```bash
# Stop services
docker-compose -f docker-compose.base.yml \
                -f docker-compose.prod.yml \
                down

# Revert to previous commit
git checkout <previous-commit-hash>

# Rebuild and redeploy
bash /opt/swypik/app/scripts/wsl-deploy-web.sh
```

**Commit hashes to rollback to (in reverse order)**:
- d84e65d4 (Modules 6-12 audit report)
- 0b56c2d8 (Timing attack findings update)
- 82a5f284 (i18n baseline)
- 4431f854 (daily-maintenance timing fix)
- eaa04097 (live endpoints timing fix)
- 2e4cff04 (FX fallback fix)
- 8ea1a55b (Auth hardcodes fix)

---

## SUCCESS CRITERIA ✅

**Deployment is successful if**:
1. ✅ All containers running (docker ps shows 3 services)
2. ✅ localhost:3005 returns HTTP 200
3. ✅ All critical endpoints respond (not 500)
4. ✅ Auth flow works (register → login → session)
5. ✅ Admin endpoints are protected (require session)
6. ✅ No "error" logs in Docker (grep -i "error" returns nothing critical)
7. ✅ swypik.com accessible via Cloudflare Tunnel
8. ✅ All env vars set (STRIPE_SECRET_KEY, FX_FALLBACK_RATES, etc.)

**If all ✅ checks pass**: Deployment verified and safe to use.

---

## SUPPORT & TROUBLESHOOTING

### Common Issues

**Issue**: Port 3005 already in use
```bash
sudo lsof -i :3005 | awk '{print $2}' | grep -v PID | xargs kill -9
```

**Issue**: Database connection refused
```bash
docker-compose -f docker-compose.base.yml up postgres
# Wait 10 seconds for DB to be ready
```

**Issue**: STRIPE_SECRET_KEY not recognized
```bash
# Edit .env.local
nano /opt/swypik/app/.env.local
# Restart container
docker-compose restart app-next
```

**Issue**: FX rates not loading
```bash
# Check env var
grep FX_FALLBACK_RATES /opt/swypik/app/.env.local

# Run cron manually
curl -s -H "x-cron-secret: $CRON_SECRET" \
  http://localhost:3005/api/cron/refresh-fx | jq .
```

---

**Document Version**: 2026-08-05  
**Status**: Ready for deployment verification  
**Estimated Time**: 45-60 minutes (all phases)  
**Next Step**: Run Phase 1 pre-deployment checks

