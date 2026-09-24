#!/bin/bash
# arena_en.sh — clone the public repo, install lm_eval, pull BitNet b1.58
# 2B4T from HF, copy Ilaria-130M off Drive, run forge/eval/arena_en.py for
# both systems, and stash results + logs back on Drive.
# Colab: !bash /content/drive/MyDrive/ilaria/arena_en.sh
# (No Go toolchain needed here — same "Python-only on Colab" split as
# forge/colab/train_a.sh; only forge/eval/*.py and lm_eval run.)
set -u
D=/content/drive/MyDrive/ilaria
mkdir -p "$D/arena"
cd /content || exit 1
nvidia-smi --query-gpu=name,memory.total --format=csv

[ -d /content/nexus ] || { echo "cloning repo ($(date +%H:%M:%S))"; git clone --depth 1 https://github.com/office233/ilaria /content/nexus || exit 1; }
cd /content/nexus || exit 1

pip install -q -U lm_eval "huggingface_hub[cli]"

mkdir -p data/pretrained/bitnet-b1.58-2B-4T data/forge/brain-a results docs/benchmarks
if [ ! -f data/pretrained/bitnet-b1.58-2B-4T/model.safetensors ]; then
  echo "downloading microsoft/bitnet-b1.58-2B-4T ($(date +%H:%M:%S))"
  python -c "from huggingface_hub import snapshot_download; snapshot_download('microsoft/bitnet-b1.58-2B-4T', local_dir='data/pretrained/bitnet-b1.58-2B-4T')" || exit 1
fi

[ -s "$D/brain-a/transformer.nxtf" ] && [ -s "$D/brain-a/tokenizer.json" ] || { echo "missing $D/brain-a/{transformer.nxtf,tokenizer.json} — run train_a.sh (+ nxtf export) first"; exit 1; }
cp "$D/brain-a/transformer.nxtf" "$D/brain-a/tokenizer.json" data/forge/brain-a/

echo "=== bitnet2b ($(date +%H:%M:%S)) ==="
python forge/eval/arena_en.py --system bitnet2b --out results/bitnet2b.json 2>&1 | tee "$D/arena/bitnet2b.log"

echo "=== ilaria130m ($(date +%H:%M:%S)) ==="
python forge/eval/arena_en.py --system ilaria130m --out results/ilaria130m.json 2>&1 | tee "$D/arena/ilaria130m.log"

cp results/bitnet2b.json results/ilaria130m.json docs/benchmarks/arena_en.md "$D/arena/"
echo "done ($(date +%H:%M:%S))"
ls -la "$D/arena"
