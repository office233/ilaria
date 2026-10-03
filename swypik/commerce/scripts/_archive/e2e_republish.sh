#!/usr/bin/env bash
# Re-publica produsul existent (tenant 2, product 5) fara re-crearea sellerului.
set -u
ERP=http://127.0.0.1:8091
OWNER_U=$(docker exec multi-erp-postgres psql -U multi -d multi_erp -tAc "SELECT username FROM users WHERE username LIKE 'e2e-test-%' ORDER BY id DESC LIMIT 1")
echo "OWNER=$OWNER_U — reset parola owner la una cunoscuta"
docker exec multi-erp-postgres psql -U multi -d multi_erp -c "UPDATE users SET password='\$2a\$10\$rIkA0kZ6b0ZDgxYyefJ9se4kPQ7c6cRC2mTX2xIS.0AISPeJ1Qm1W' WHERE username='$OWNER_U'" # 'E2eTest!2026x' pre-hashed? nu — folosim alta cale
