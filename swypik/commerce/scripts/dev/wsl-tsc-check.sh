#!/bin/bash
# tsc --noEmit în container node (Faza 2)
docker run --rm -v /opt/swypik/app:/app -w /app node:20-alpine sh -c 'npx tsc --noEmit > /tmp/tsc.out 2>&1; ec=$?; echo "EXITCODE=$ec"; grep -c "error TS" /tmp/tsc.out; tail -12 /tmp/tsc.out'
