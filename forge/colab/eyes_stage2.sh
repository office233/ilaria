#!/bin/bash
# Ilaria "eyes", stage 2: LoRA instruction tuning (VQA/OCR/docs/charts) on the frozen ternary cortex,
# projector initialised from the stage-1 export. Resumes from $D/stage2_instruct/checkpoint.pt.
# Colab (GPU runtime): !bash /content/drive/MyDrive/ilaria/eyes_stage2.sh
set -u
D=/content/drive/MyDrive/ilaria
cd /content || exit 1
if [ -d ilaria/.git ]; then (cd ilaria && git pull --ff-only 2>&1 | tail -1); else git clone --depth 1 https://github.com/office233/ilaria.git ilaria || exit 1; fi
cd /content/ilaria || exit 1
git log --oneline -1
[ -f forge/multimodal/train_stage2.py ] || { echo "forge/multimodal/train_stage2.py missing on GitHub — push the repo first"; exit 1; }
pip -q install -U datasets tokenizers safetensors "huggingface_hub>=1.5,<2" 2>&1 | tail -1  # hub 2.x breaks the preinstalled transformers
python -c "import torch, transformers; print('torch', torch.__version__, '| transformers', transformers.__version__, '| cuda', torch.cuda.is_available())"
nvidia-smi --query-gpu=name,memory.total --format=csv
[ -s /content/bitnet-b1.58-2B-4T/model.safetensors ] || python - <<'EOF'
from huggingface_hub import snapshot_download
print("bitnet checkpoint:", snapshot_download("microsoft/bitnet-b1.58-2B-4T", local_dir="/content/bitnet-b1.58-2B-4T"))
EOF
[ -s "$D/stage1_projector/adapter_export.safetensors" ] || { echo "missing $D/stage1_projector/adapter_export.safetensors (stage 1 export)"; exit 1; }
mkdir -p "$D/stage2_instruct"
RESUME=""; [ -f "$D/stage2_instruct/checkpoint.pt" ] && RESUME="--resume $D/stage2_instruct/checkpoint.pt" && echo "resuming from $D/stage2_instruct/checkpoint.pt"
echo "start $(date +%H:%M:%S)"
python -u forge/multimodal/train_stage2.py \
  --llm-dir /content/bitnet-b1.58-2B-4T --base offline \
  --adapter-init "$D/stage1_projector/adapter_export" \
  --source finevision --datasets "vqav2,textvqa,docvqa,chartqa,sharegpt4v(llava),ai2d_merged" \
  --text-ratio 0.1 --max-images 2 --max-turns 4 \
  --lora-targets q_proj,k_proj,v_proj,o_proj,gate_proj,up_proj,down_proj --lora-r 16 --lora-alpha 32 --lora-dropout 0.05 \
  --batch 16 --accum 4 --steps 6000 --warmup 200 \
  --lr-projector 5e-5 --min-lr-projector 5e-6 --lr-lora 1e-4 --min-lr-lora 1e-5 \
  --grad-checkpoint --ckpt-every 500 --eval-every 250 --eval-samples 4 --log-every 20 \
  --out "$D/stage2_instruct" $RESUME 2>&1
echo "end $(date +%H:%M:%S)"
if [ -f "$D/stage2_instruct/checkpoint.pt" ]; then
  python forge/multimodal/export_stage2.py --checkpoint "$D/stage2_instruct/checkpoint.pt" --out-prefix "$D/stage2_instruct/stage2_export" 2>&1 | tail -3
fi
ls -la "$D/stage2_instruct"
