#!/bin/bash
for p in / /explore /feed /food /stays; do
  code=$(curl -s -o /dev/null -w '%{http_code}' -m 30 -L "http://localhost:3005$p")
  echo "$p: $code"
done
