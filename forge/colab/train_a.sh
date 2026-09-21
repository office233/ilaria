#!/bin/bash
# Recipe A (Ilaria-130M): stream from local disk, checkpoints + nxtf export on Drive, auto-resume.
# Colab: !bash /content/drive/MyDrive/ilaria/train_a.sh   (re-run after a session drop: resumes from checkpoint.pt)
set -u
D=/content/drive/MyDrive/ilaria
L=/content/ilaria
cd /content/nexus || exit 1
mkdir -p "$L" "$D/brain-a"
nvidia-smi --query-gpu=name,memory.total --format=csv
[ -s "$L/train_stream.bin" ] || { echo "copying stream from Drive ($(date +%H:%M:%S))"; cp "$D/train_stream.json" "$L/" && cp "$D/train_stream.bin" "$L/" || exit 1; }
TOK=$(python -c "import json;print(json.load(open('$L/train_stream.json'))['tokens'])")
STEPS=$(( TOK / 262144 )); [ "$STEPS" -gt 11500 ] && STEPS=11500
echo "tokens=$TOK steps=$STEPS ($(date +%H:%M:%S))"
RESUME=""; [ -f "$D/brain-a/checkpoint.pt" ] && RESUME="--resume $D/brain-a/checkpoint.pt" && echo "resuming from $D/brain-a/checkpoint.pt"
python -u forge/train_ilaria.py --data "$L/train_stream" --out "$D/brain-a" \
  --embed-dim 768 --heads 12 --layers 12 --ffn-dim 2688 --ctx 1024 --max-seq-len 1024 --rope --swiglu --dropout 0 \
  --batch 64 --accum 4 --steps "$STEPS" --warmup 500 --lr 6e-4 --min-lr 6e-5 --wd 0.1 --precision bf16 --compile --eval-every 500 $RESUME 2>&1
ls -la "$D/brain-a"
