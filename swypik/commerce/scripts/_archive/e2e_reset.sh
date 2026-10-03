#!/usr/bin/env bash
# Reset complet date de test pentru re-rulare E2E.
#
# ATENȚIE: atinge DOUĂ baze de PRODUCȚIE (`multi-erp-postgres` și
# `swypik-prod-postgres-1`) și rescrie secvențele de ID. Implicit face
# DRY-RUN — nu execută nimic fără confirmare explicită.
#
#   ./e2e_reset.sh                          → arată ce s-ar șterge
#   CONFIRM_DESTRUCTIVE=yes ./e2e_reset.sh  → execută efectiv

source "$(dirname "${BASH_SOURCE[0]}")/../lib/guard-destructive.sh"
guard_destructive "e2e_reset"

P="docker exec multi-erp-postgres psql -U multi -d multi_erp"
S="docker exec swypik-prod-postgres-1 psql -U swypik -d swypik_prod"

run_sql "$P" "DELETE FROM tenant_users WHERE user_id IN (SELECT id FROM users WHERE username LIKE 'e2e-test-%')"
run_sql "$P" "DELETE FROM users WHERE username LIKE 'e2e-test-%'"
run_sql "$P" "DELETE FROM products WHERE tenant_id IN (SELECT id FROM tenants WHERE slug LIKE 'test-business%')"
run_sql "$P" "DELETE FROM tenants WHERE slug LIKE 'test-business%'"
run_sql "$P" "SELECT setval('tenants_id_seq',(SELECT MAX(id) FROM tenants)); SELECT setval('users_id_seq',(SELECT MAX(id) FROM users))"
run_sql "$S" "DELETE FROM marketplace_products WHERE seller_id IN (SELECT id FROM sellers WHERE name='Test Business E2E SRL')"
run_sql "$S" "DELETE FROM sellers WHERE name='Test Business E2E SRL'"

echo RESET_DONE
