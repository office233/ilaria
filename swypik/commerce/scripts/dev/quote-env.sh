#!/usr/bin/env bash
# .env.production e citit cu `source` de deploy.sh, deci valorile cu spatii sau
# caractere speciale (< > & ; |) trebuie ghilimelate. Script idempotent:
# ghilimeleaza orice valoare neghilimelata care contine astfel de caractere.
set -euo pipefail
ENVF=/opt/swypik/app/infra/hetzner/.env.production
cp "$ENVF" "/opt/meister-backups/env.production.bak.$(date +%Y%m%d_%H%M%S)"

python3 - "$ENVF" <<'PY'
import re, sys
path = sys.argv[1]
needs_quote = re.compile(r'[ \t<>&;|()$`*?\[\]{}#!]')
out, changed = [], 0
for line in open(path, encoding='utf-8'):
    raw = line.rstrip('\n')
    m = re.match(r'^([A-Za-z_][A-Za-z0-9_]*)=(.*)$', raw)
    if not m or raw.lstrip().startswith('#'):
        out.append(raw); continue
    key, val = m.group(1), m.group(2)
    if val and not (val[0] in '"\'' and val[-1] == val[0]) and needs_quote.search(val):
        val = '"' + val.replace('\\', '\\\\').replace('"', '\\"') + '"'
        changed += 1
    out.append(f'{key}={val}')
open(path, 'w', encoding='utf-8').write('\n'.join(out) + '\n')
print(f'ghilimelate: {changed} valori')
PY

# Validare: env-ul trebuie sa poata fi sursat fara erori.
if ( set -a; . "$ENVF"; set +a ) 2>/dev/null; then
    echo "OK: env-ul se poate sursa"
else
    echo "EROARE: env-ul tot nu se poate sursa" >&2
    ( set -a; . "$ENVF"; set +a ) 2>&1 | head -5
    exit 1
fi
