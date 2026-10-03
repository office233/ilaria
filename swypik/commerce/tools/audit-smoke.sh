#!/usr/bin/env bash
cd /mnt/e/Meister/swypik/app || exit 1
echo '=== smoke live 3005 ==='
for p in /ro /en /ro/shop /ro/about /api/health; do
  printf '%s -> ' "$p"
  curl -s -o /dev/null -w '%{http_code}\n' "http://localhost:3005$p"
done
echo '=== i18n baseline ==='
cat .i18n-baseline.json; echo
echo '=== JSON messages valide ==='
bad=0
for f in messages/*.json; do
  python3 -c "import json;json.load(open('$f'))" 2>/dev/null || { echo "INVALID: $f"; bad=1; }
done
[ $bad -eq 0 ] && echo toate-valide
echo '=== chei sincronizate intre limbi ==='
python3 - << 'PYEOF'
import json, glob
files = sorted(glob.glob('messages/*.json'))
def keys(d, p=''):
    out=set()
    for k,v in d.items():
        kk=f'{p}.{k}' if p else k
        if isinstance(v,dict): out|=keys(v,kk)
        else: out.add(kk)
    return out
base = keys(json.load(open('messages/en.json')))
for f in files:
    k = keys(json.load(open(f)))
    miss = base-k; extra = k-base
    if miss or extra:
        print(f, 'missing:', len(miss), sorted(miss)[:5], 'extra:', len(extra), sorted(extra)[:5])
    else:
        print(f, 'OK', len(k))
PYEOF
