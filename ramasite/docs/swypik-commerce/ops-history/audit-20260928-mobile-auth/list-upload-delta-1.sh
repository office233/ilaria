#!/usr/bin/env bash
set -euo pipefail
python3 - <<'PY'
import json
from pathlib import Path
changed = json.loads(Path('/tmp/swypik-upload-audio-delta/manifest.json').read_text())['changed']
for index, path in enumerate(changed[:55], start=1):
    print(f'{index:03d}\t{path}')
PY
