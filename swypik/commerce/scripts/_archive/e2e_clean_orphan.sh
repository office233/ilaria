#!/usr/bin/env bash
P="docker exec multi-erp-postgres psql -U multi -d multi_erp"
$P -c "DELETE FROM tenant_users WHERE user_id IN (SELECT id FROM users WHERE username LIKE 'e2e-test-%')"
$P -c "DELETE FROM users WHERE username LIKE 'e2e-test-%'"
$P -c "SELECT id,username FROM users"
