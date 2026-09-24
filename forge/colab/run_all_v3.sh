#!/bin/bash
# run_all_v3.sh — run_all.sh after clearing the checkout dirs a failed anonymous git clone may have
# left behind, and after checking that github.com/office233/ilaria is reachable without credentials
# (the runners clone it anonymously). Colab: !bash /content/drive/MyDrive/ilaria/run_all_v3.sh
set -u
D=/content/drive/MyDrive/ilaria
code=$(curl -s -o /dev/null -w '%{http_code}' https://github.com/office233/ilaria)
echo "github.com/office233/ilaria -> HTTP $code"
[ "$code" = "200" ] || { echo "repo not reachable anonymously (private or restricted) — make it public, then re-run"; exit 1; }
rm -rf /content/nexus /content/ilaria
exec bash "$D/run_all.sh"
