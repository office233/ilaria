#!/bin/bash
# arena_t4.sh — the English arena on a FREE-TIER T4 (16 GB, no bf16): Ilaria-130M first
# (fp32, small), then BitNet 2B in float16, log-likelihood tasks before the slow generative
# ones so partial results survive a free-session disconnect. Everything is tee'd to Drive.
# Colab: from google.colab import drive; drive.mount('/content/drive'); get_ipython().system('bash /content/drive/MyDrive/ilaria/arena_t4.sh')
set -u
D=/content/drive/MyDrive/ilaria
mkdir -p "$D/arena"
cd /content || exit 1
nvidia-smi --query-gpu=name,memory.total --format=csv
[ -d /content/nexus ] || { echo "cloning repo ($(date +%H:%M:%S))"; git clone --depth 1 https://github.com/office233/ilaria /content/nexus || exit 1; }
cd /content/nexus || exit 1
git log --oneline -1
pip install -q -U lm_eval "huggingface_hub[cli]" 2>&1 | tail -1
mkdir -p data/pretrained/bitnet-b1.58-2B-4T data/forge/brain-a results docs/benchmarks
[ -s "$D/brain-a/transformer.nxtf" ] && [ -s "$D/brain-a/tokenizer.json" ] || { echo "missing $D/brain-a/{transformer.nxtf,tokenizer.json}"; exit 1; }
cp "$D/brain-a/transformer.nxtf" "$D/brain-a/tokenizer.json" data/forge/brain-a/

run() { # name, then arena args
  local name=$1; shift
  echo "=== $name ($(date +%H:%M:%S)) ==="
  python -u forge/eval/arena_en.py "$@" --out "results/$name.json" 2>&1 | tee "$D/arena/$name.log"
  cp "results/$name.json" "$D/arena/" 2>/dev/null; cp docs/benchmarks/arena_en.md "$D/arena/" 2>/dev/null
}
run ilaria130m_ll  --system ilaria130m --tasks arc_challenge,arc_easy,hellaswag,winogrande,piqa,mmlu
run ilaria130m_gen --system ilaria130m --tasks gsm8k,ifeval
if [ ! -f data/pretrained/bitnet-b1.58-2B-4T/model.safetensors ]; then
  echo "downloading microsoft/bitnet-b1.58-2B-4T ($(date +%H:%M:%S))"
  python -c "from huggingface_hub import snapshot_download; snapshot_download('microsoft/bitnet-b1.58-2B-4T', local_dir='data/pretrained/bitnet-b1.58-2B-4T')" || exit 1
fi
run bitnet2b_ll  --system bitnet2b --dtype float16 --tasks arc_challenge,arc_easy,hellaswag,winogrande,piqa,mmlu
run bitnet2b_gen --system bitnet2b --dtype float16 --tasks gsm8k,ifeval
echo "done ($(date +%H:%M:%S))"
ls -la "$D/arena"
