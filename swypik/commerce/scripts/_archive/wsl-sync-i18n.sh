#!/bin/bash
# Sincronizeaza fixurile i18n in /opt si valideaza JSON.
set -e
SRC=/mnt/e/Meister/swypik/app
DST=/opt/swypik/app
FILES="messages/ro.json messages/en.json messages/es.json messages/fr.json messages/de.json messages/pt.json messages/it.json app/[locale]/live/page.tsx"
for f in $FILES; do
  sed 's/\r$//' "$SRC/$f" > "$DST/$f"
done
cd "$DST"
python3 - <<'EOF'
import json
for l in ["ro","en","es","fr","de","pt","it"]:
    d = json.load(open(f"messages/{l}.json", encoding="utf-8"))
    assert "livePage" in d, l
print("JSON OK, livePage in toate cele 7 locale")
EOF
