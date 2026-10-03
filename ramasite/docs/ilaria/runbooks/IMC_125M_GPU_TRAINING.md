# IMC-125M GPU training runbook

This runbook is for the first serious IMC-125M bootstrap only after the
production data gates are green. It must not be used to bypass rights,
tokenizer-freeze, dataset-manifest or curriculum validation.

## 1. Hardware preflight

Canonical Colab target for the IMC-125M Genesis run is **G4 High-RAM**.
Do not silently fall back to L4/T4/A100/H100 if G4 allocation is unavailable.
The previously verified Colab G4 maps to an NVIDIA RTX PRO 6000 Blackwell
Server Edition with about 95 GiB VRAM and native BF16.

Run this inside the allocated G4 runtime:

    python forge/gpu_preflight.py \
      --world-size 1 \
      --min-vram-gib 90 \
      --min-compute-major 12 \
      --require-bf16 \
      --require-name-contains "RTX PRO 6000 Blackwell"

Do not launch if the report is not `ready: true`.

Before the production launch, benchmark exact-context micro-batches
`4, 8, 16, 32`. Each is compatible with the locked 262,144-token global
batch on one GPU:

- micro-batch 4 -> accumulation 32
- micro-batch 8 -> accumulation 16
- micro-batch 16 -> accumulation 8
- micro-batch 32 -> accumulation 4

Select the largest stable candidate that retains adequate VRAM headroom;
do not change `global_batch_tokens` to fit the device.

## 2. Production readiness

    python forge/production_readiness.py

This must be green before corpus/tokenizer artifacts are promoted.

## 3. IMC-125M data/model preflight

    python forge/imc_125m_preflight.py \
      --freeze <production/ilarialex.freeze.json> \
      --dataset-manifest <production/dataset.manifest.json> \
      --rights forge/config/data_rights.json

The gate checks tokenizer/dataset/rights/curriculum identities, canonical
EOS/protocol IDs, the exact 125,882,112-parameter shape and the locked training
token budget.

## 4. Build a content-addressed launch manifest

Example single-GPU ternary seed 7:

    python forge/imc_125m_launch.py \
      --freeze <production/ilarialex.freeze.json> \
      --dataset-manifest <production/dataset.manifest.json> \
      --rights forge/config/data_rights.json \
      --train-data <production/train-stream-prefix> \
      --validation-data <production/validation-stream-prefix> \
      --tokenizer <production/ilarialex.json> \
      --output-dir <runs/imc125-ternary-seed7> \
      --experiment ternary_candidate \
      --seed 7 \
      --world-size 1 \
      --micro-batch 4 \
      --out <runs/imc125-ternary-seed7.launch.json>

The launch manifest pins the recipe, tokenizer, dataset, curriculum and command
arguments. For multi-GPU launches it emits a `torchrun --standalone` command.

## 5. Controlled pauses and exact resume

To deliberately pause a launch without changing the global 1B-token LR
horizon, add `--stop-after <optimizer-steps>` when building the launch manifest.

For resume, build a **new** launch manifest with:

    --resume <runs/.../checkpoint.pt>

The launcher hashes the checkpoint and pins that SHA256 in the resume launch
manifest. `train_ilaria.py` independently verifies checkpoint schema, model
configuration, optimizer/RNG state, data/tokenizer hashes, schedule and runtime
signature before restoring it.

For smoke/CI only, `--sample-tokens 0` avoids post-run greedy generation; this
does not alter the training signature.

## 6. Locked experiment matrix

The canonical recipe requires both:

- `ternary_candidate`: seeds 7, 11, 19;
- `full_precision_control`: seeds 7, 11, 19.

Do not promote from a single seed. Required evaluations (English-first Genesis
v1, per `forge/config/imc_125m_recipe.json`) are frozen validation, general,
code, math/science, calibration, PCE transfer and continual-learning
regression. Romanian evaluation is not a Genesis v1 promotion requirement.

## 7. Current verified smoke evidence

`bench/imc_125m_smoke/RESULTS.md` proves the exact 125M model can execute both
ternary and full-precision paths and that schema-v3 pause/resume plus best-export
hash verification work. That smoke used synthetic data and is explicitly
non-promotable.
