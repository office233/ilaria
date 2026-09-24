#!/bin/bash
# Ilaria "ears", stage 1: projector-only alignment (Whisper-small encoder -> stack-and-project ->
# MLP) on LibriSpeech + AudioCaps. Only the projector trains; encoder and LLM stay frozen.
# Resumes from $D/stage1_audio/checkpoint.pt. Colab (GPU runtime):
#   !bash /content/drive/MyDrive/ilaria/ears_stage1.sh
set -u
D=/content/drive/MyDrive/ilaria
cd /content || exit 1
if [ -d ilaria/.git ]; then (cd ilaria && git pull --ff-only 2>&1 | tail -1); else git clone --depth 1 https://github.com/office233/ilaria.git ilaria || exit 1; fi
cd /content/ilaria || exit 1
git log --oneline -1
[ -f forge/multimodal/train_stage1_audio.py ] || { echo "forge/multimodal/train_stage1_audio.py missing on GitHub -- push the repo first"; exit 1; }
pip -q install -U datasets tokenizers safetensors huggingface_hub torchaudio soundfile 2>&1 | tail -1
python -c "import torch, transformers; print('torch', torch.__version__, '| transformers', transformers.__version__, '| cuda', torch.cuda.is_available())"
nvidia-smi --query-gpu=name,memory.total --format=csv
[ -s /content/bitnet-b1.58-2B-4T/model.safetensors ] || python - <<'EOF'
from huggingface_hub import snapshot_download
print("bitnet checkpoint:", snapshot_download("microsoft/bitnet-b1.58-2B-4T", local_dir="/content/bitnet-b1.58-2B-4T"))
EOF
[ -s /content/whisper-small/model.safetensors ] || python - <<'EOF'
from huggingface_hub import snapshot_download
print("whisper-small checkpoint:", snapshot_download("openai/whisper-small", local_dir="/content/whisper-small"))
EOF
mkdir -p "$D/stage1_audio"
RESUME=""; [ -f "$D/stage1_audio/checkpoint.pt" ] && RESUME="--resume $D/stage1_audio/checkpoint.pt" && echo "resuming from $D/stage1_audio/checkpoint.pt"
echo "start $(date +%H:%M:%S)"
python -u forge/multimodal/train_stage1_audio.py \
  --llm-dir /content/bitnet-b1.58-2B-4T --encoder /content/whisper-small --stack 8 \
  --batch 16 --accum 4 --steps 2000 --warmup 100 --lr 3e-4 --min-lr 3e-5 \
  --ckpt-every 250 --eval-every 250 --eval-samples 4 --log-every 20 \
  --out "$D/stage1_audio" $RESUME 2>&1
echo "end $(date +%H:%M:%S)"
if [ -f "$D/stage1_audio/checkpoint.pt" ]; then
  python forge/multimodal/export_audio_adapter.py --checkpoint "$D/stage1_audio/checkpoint.pt" --out-prefix "$D/stage1_audio/adapter_export" 2>&1 | tail -3
fi
ls -la "$D/stage1_audio"
