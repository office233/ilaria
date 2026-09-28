#!/usr/bin/env bash
P="docker exec multi-erp-postgres psql -U multi -d multi_erp"
$P -c "SELECT id,slug FROM tenants ORDER BY id"
$P -c "SELECT last_value FROM tenants_id_seq"
$P -c "SELECT setval('tenants_id_seq', (SELECT MAX(id) FROM tenants))"
$P -c "SELECT setval('users_id_seq', (SELECT MAX(id) FROM users))"
$P -c "SELECT setval(pg_get_serial_sequence('tenant_users','id'), COALESCE((SELECT MAX(id) FROM tenant_users),1))" 2>/dev/null || true
