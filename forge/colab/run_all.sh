#!/bin/bash
# run_all.sh — English arena (1–2 h) then eyes stage 2 (LoRA, ~8–10 h), logs tee'd to Drive.
# Colab: !bash /content/drive/MyDrive/ilaria/run_all.sh
D=/content/drive/MyDrive/ilaria
mkdir -p "$D/arena" "$D/stage2_instruct"
echo "run_all start $(date -u +%Y-%m-%dT%H:%M:%SZ)" | tee -a "$D/run_all.log"
bash "$D/arena_en.sh" 2>&1 | tee "$D/arena/run.log"
echo "arena done $(date -u +%Y-%m-%dT%H:%M:%SZ) rc=${PIPESTATUS[0]}" | tee -a "$D/run_all.log"
bash "$D/eyes_stage2.sh" 2>&1 | tee "$D/stage2_instruct/run.log"
echo "stage2 done $(date -u +%Y-%m-%dT%H:%M:%SZ) rc=${PIPESTATUS[0]}" | tee -a "$D/run_all.log"
