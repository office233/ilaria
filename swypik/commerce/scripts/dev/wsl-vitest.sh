#!/bin/bash
# vitest unit tests (Faza 3)
docker run --rm -v /opt/swypik/app:/app -w /app node:20-alpine sh -c 'npx vitest run > /tmp/vt.out 2>&1; ec=$?; echo "VITEST_EXIT=$ec"; tail -12 /tmp/vt.out'
