#!/bin/bash
# Playwright E2E contra prod local (Faza 3). Ruleaza in imaginea oficiala playwright, retea host.
docker run --rm --network host -v /opt/swypik/app:/app -w /app \
  -e PLAYWRIGHT_BASE_URL=http://127.0.0.1:3005 \
  mcr.microsoft.com/playwright:v1.60.0-noble \
  sh -c 'npx playwright test --reporter=line > /tmp/e2e.out 2>&1; ec=$?; echo "E2E_EXIT=$ec"; tail -25 /tmp/e2e.out'
