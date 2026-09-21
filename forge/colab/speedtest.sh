#!/bin/bash
# 100-step speed test of recipe A on the GPU; the stream is read from local disk.
# Colab: !bash /content/drive/MyDrive/ilaria/speedtest.sh
# Measured 2026-09-21, Colab GPU runtime (NVIDIA RTX PRO 6000 Blackwell 96 GB, 48 vCPU): 128.1M params, bf16 + torch.compile, ~183k tok/s cumulative at step 80.
set -u
D=/content/drive/MyDrive/ilaria
L=/content/ilaria
cd /content/nexus || exit 1
mkdir -p "$L"
nvidia-smi --query-gpu=name,memory.total --format=csv
echo "cpus=$(nproc)"; free -g | head -2
[ -s "$L/train_stream.bin" ] || { echo "copying stream from Drive ($(date +%H:%M:%S))"; cp "$D/train_stream.json" "$L/" && cp "$D/train_stream.bin" "$L/" || exit 1; }
cat "$L/train_stream.json"; echo
python -u forge/train_ilaria.py --data "$L/train_stream" --out /content/speedtest \
  --embed-dim 768 --heads 12 --layers 12 --ffn-dim 2688 --ctx 1024 --max-seq-len 1024 --rope --swiglu --dropout 0 \
  --batch 64 --accum 4 --steps 100 --warmup 20 --lr 6e-4 --min-lr 6e-5 --wd 0.1 --precision bf16 --compile --eval-every 100 2>&1
