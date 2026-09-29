#!/bin/bash
# IMC 24-hour run on one Colab GPU (G4 / H100). Re-running the script after a
# disconnect resumes: finished stages are skipped, training resumes from its
# checkpoint, and the main run keeps the step count fixed in plan.json.
#
#   1. data   ~10B English tokens (forge/imc_data.py), built once, kept on Drive
#   2. e1     IMC-125M bf16 vs IMC-125M ternary, 1B tokens each (the control)
#   3. main   IMC-250M ternary, steps sized from measured speed to end by DEADLINE_HOURS
#
# Needs HF_TOKEN in the environment (Colab secret) and Drive mounted at /content/drive.
set -euo pipefail
D=${IMC_DRIVE:-/content/drive/MyDrive/ilaria/imc}
L=/content/imc-local
REPO=${IMC_REPO:-/content/ilaria}
TOKENS=${IMC_TOKENS:-10000000000}
DEADLINE_HOURS=${IMC_DEADLINE_HOURS:-23}
mkdir -p "$D" "$L"
[ -f "$D/started_at" ] || date +%s > "$D/started_at"
START=$(cat "$D/started_at")
cd "$REPO"
nvidia-smi --query-gpu=name,memory.total --format=csv
log() { echo "[imc-24h $(date +%H:%M:%S)] $*" | tee -a "$D/run.log"; }

# ---- 1. data ---------------------------------------------------------------
if [ ! -f "$D/data/stream.json" ]; then
  log "building ~$TOKENS tokens"
  rm -rf "$L/data"
  python -u -m forge.imc_data --out "$L/data" --tokens "$TOKENS" 2>&1 | tee -a "$D/run.log"
  mkdir -p "$D/data.partial"
  cp "$L/data/stream.bin" "$L/data/stream.json" "$L/data/tokenizer.json" "$D/data.partial/"
  mv "$D/data.partial" "$D/data"
  log "data saved to Drive"
fi
if [ ! -f "$L/data/stream.bin" ]; then
  log "copying data from Drive"
  mkdir -p "$L/data" && cp "$D/data/stream.bin" "$D/data/stream.json" "$D/data/tokenizer.json" "$L/data/"
fi
# The stream metadata must point at the local tokenizer copy.
python - "$L/data" <<'EOF'
import json, sys
d = sys.argv[1]
m = json.load(open(f"{d}/stream.json"))
m["tokenizer"] = f"{d}/tokenizer.json"
json.dump(m, open(f"{d}/stream.json", "w"), indent=2)
print("[imc-24h] stream tokens:", f"{m['tokens']:,}", m["tokens_by_source"])
EOF

# Every stage trains on 256 x 1024 = 262,144 tokens per step. IMC-125M fits
# 64 sequences per micro-batch on 96 GB; IMC-250M does not (its backward ran
# out of memory at 64), so it uses 32 x 8.
export PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True
COMMON=(--data "$L/data/stream" --arch imc --ctx 1024 --max-seq-len 1024 --dropout 0
        --wd 0.1 --precision bf16 --compile --eval-every 250 --eval-iters 20)
SMALL=(--batch 64 --accum 4)
LARGE=(--batch 32 --accum 8)
TOKENS_PER_STEP=$((256 * 1024))

train() {  # name, extra args...
  local name=$1; shift
  local out="$D/$name"
  if [ -f "$out/DONE" ]; then log "$name already done"; return; fi
  local resume=()
  [ -f "$out/checkpoint.pt" ] && resume=(--resume "$out/checkpoint.pt")
  log "training $name $*"
  python -u forge/train_ilaria.py "${COMMON[@]}" --out "$out" "$@" "${resume[@]}" 2>&1 | tee -a "$out.log"
  touch "$out/DONE"
}

# ---- 2. e1: the ternary-vs-bf16 control at 125M, 1B tokens each ------------
E1_STEPS=$((1000000000 / TOKENS_PER_STEP))
train e1-125m-bf16 "${SMALL[@]}" --preset imc-125m --steps "$E1_STEPS" --warmup 200 --lr 6e-4 --min-lr 6e-5
train e1-125m-ternary "${SMALL[@]}" --preset imc-125m --ternary --steps "$E1_STEPS" --warmup 200 --lr 1.5e-3 --min-lr 1.5e-4

# ---- 3. main: IMC-250M ternary until the deadline ---------------------------
if [ ! -f "$D/plan.json" ]; then
  log "measuring IMC-250M ternary speed"
  rm -rf "$L/speed"
  python -u forge/train_ilaria.py "${COMMON[@]}" --out "$L/speed" "${LARGE[@]}" --preset imc-250m --ternary \
      --steps 60 --warmup 10 --lr 1.5e-3 --min-lr 1.5e-4 --eval-every 1000 2>&1 | tee "$L/speed.log"
  python - "$L/speed.log" "$START" "$DEADLINE_HOURS" "$TOKENS_PER_STEP" "$D/plan.json" <<'EOF'
import json, re, sys, time
log, start, hours, per_step, plan = sys.argv[1], int(sys.argv[2]), float(sys.argv[3]), int(sys.argv[4]), sys.argv[5]
speeds = [float(m.replace(",", "")) for m in re.findall(r"\| ([\d,]+) tok/s", open(log).read())]
tok_s = speeds[-1]                      # cumulative average, compile warm-up included
left = start + hours * 3600 - time.time() - 1800   # 30 min margin for evals and saves
steps = max(500, int(left * tok_s * 0.9 / per_step))
json.dump({"tok_s": tok_s, "seconds_left": left, "steps": steps, "tokens": steps * per_step}, open(plan, "w"), indent=2)
print("[imc-24h] plan:", open(plan).read())
EOF
fi
MAIN_STEPS=$(python -c "import json;print(json.load(open('$D/plan.json'))['steps'])")
train main-250m-ternary "${LARGE[@]}" --preset imc-250m --ternary --steps "$MAIN_STEPS" --warmup 500 --lr 1.5e-3 --min-lr 1.5e-4
log "all stages done"
