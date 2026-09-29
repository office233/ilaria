#!/bin/bash
# Extend the IMC English stream to ~20B tokens on a CPU-only Colab runtime.
# Reuses the tokenizer of the first build and skips every document it already
# used, then writes one concatenated stream to Drive:
#   MyDrive/ilaria/imc/data      9.1B tokens (first build, 2026-09-28)
#   MyDrive/ilaria/imc/data-ext  ~11B new tokens
#   MyDrive/ilaria/imc/data-20b  both, ready for forge/train_ilaria.py --data .../data-20b/stream
# Needs HF_TOKEN in the environment (Colab secret) and Drive mounted at /content/drive.
set -euo pipefail
D=${IMC_DRIVE:-/content/drive/MyDrive/ilaria/imc}
L=/content/imc-ext-local
REPO=${IMC_REPO:-/content/ilaria}
TOKENS=${IMC_EXT_TOKENS:-11000000000}
cd "$REPO"
log() { echo "[imc-ext $(date +%H:%M:%S)] $*" | tee -a "$D/extend.log"; }

# Documents consumed per source by the first build, from its run.log
# ("[imc-data] <source>: N documents"); the first stream.json predates
# documents_by_source.
SKIP='{"dclm": 3056820, "fineweb-edu": 3530032, "code-algorithmic": 2625301, "code-snippets": 637772,
       "code-web": 477635, "math-nemotron": 417046, "math-finemath": 270297}'

if [ ! -f "$D/data-ext/stream.json" ]; then
  log "building ~$TOKENS new tokens with the first build's tokenizer"
  rm -rf "$L"
  python -u -m forge.imc_data --out "$L" --tokens "$TOKENS" \
      --tokenizer "$D/data/tokenizer.json" --skip "$SKIP" 2>&1 | tee -a "$D/extend.log"
  mkdir -p "$D/data-ext.partial"
  cp "$L/stream.bin" "$L/stream.json" "$L/tokenizer.json" "$D/data-ext.partial/"
  mv "$D/data-ext.partial" "$D/data-ext"
  rm -rf "$L"
  log "extension saved to Drive"
fi

if [ ! -f "$D/data-20b/stream.json" ]; then
  log "concatenating data + data-ext"
  mkdir -p "$D/data-20b.partial"
  python -u forge/concat_streams.py --out "$D/data-20b.partial/stream" \
      --prefix all="$D/data/stream" --prefix all="$D/data-ext/stream" 2>&1 | tee -a "$D/extend.log"
  cp "$D/data/tokenizer.json" "$D/data-20b.partial/"
  mv "$D/data-20b.partial" "$D/data-20b"
  log "data-20b ready"
fi
python - "$D/data-20b/stream.json" <<'EOF'
import json, sys
m = json.load(open(sys.argv[1]))
print("[imc-ext] data-20b tokens:", f"{m['tokens']:,}")
EOF
