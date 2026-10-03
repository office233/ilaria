# Ilaria

Ilaria is the native AI model and distributed cognitive system for SwypikOS.

## Canonical model

There is one model family: **IMC (Ilaria MicroCortex)**, trained from scratch.
The deployment target is **IMC-1B** (**1,000,555,520 parameters**), native ternary 1.58-bit.
No external pretrained language model is part of the Ilaria architecture.

Scale ladder used only to validate the same architecture before the 1B run:
`IMC-125M -> IMC-250M -> IMC-500M -> IMC-1B`.

Canonical specification: `specs/myriad.swyp`.
Canonical architecture/trainer: `forge/imc_model.py`, `forge/train_ilaria.py`.
Canonical execution plan: `docs/plans/MASTER_PLAN.md`.

## Myriad

Every participating SwypikOS device hosts an IMC instance. Instances may specialize as experts while preserving the same IMC architecture and protocol. `CorticalConnectome` defines verified inter-cortex relationships; SwypikOS Compute Fabric supplies signed distributed training jobs and candidate deltas. Personal hippocampal memory remains local by default.

## Verified effect evidence

`runtime/evidence` and `cmd/evidence-check` verify SwypikOS effect receipts against
explicit executor-bound public keys and independently supplied task/lease/fence
context. The observer accepts successful signed `fs.read` and `clock.read`
outcomes, exposes no OS authority, omits private payloads from observations and
keeps `training_eligible=false`.

The CLI also supports `--stream --keys FILE` for a persistent supervisor
connection with bounded JSONL envelopes and correlated verification responses.
Its explicit trust snapshot is loaded once per process.

See the [Ilaria consumer guide](runtime/evidence/README.md) and the
[cross-product effects v1 milestone](../ramasite/docs/workspace/milestones/effects-v1.md) for the
wire contract, integration gate and remaining construction work.

## Model architecture

- decoder-only transformer
- grouped-query attention
- RMSNorm pre-norm + sub-norms
- RoPE
- gated FFN (SwiGLU or squared-ReLU)
- tied token embedding / LM head
- ternary {-1,0,+1} block weights with straight-through training
- 8-bit activation quantization on the ternary path
- 65,536-token Ilaria tokenizer target
- TritPack20 deployment storage and RGBA32 compute are declared by the Myriad spec

## Training

```powershell
python forge/train_ilaria.py --data <train-prefix> --val-data <validation-prefix> --out <run-dir> --dataset-manifest <dataset-manifest.json> --tokenizer-freeze <ilarialex.freeze.json> --preset imc-125m --ternary --chunked-loss --grad-checkpoint --target-tokens 1000000000
```

The trainer supports deterministic checkpoints, exact resume, gradient accumulation, chunked cross-entropy, gradient checkpointing, a global target-token horizon and torch distributed execution. Production training fails closed unless the dataset manifest and IlariaLex freeze agree on tokenizer identity and the tokenizer freeze contains a pinned corpus source lock.

### Production data chain

Resolve upstream dataset repository heads once and freeze them before acquisition:

```powershell
python forge/corpus_source_lock.py resolve --out forge/config/corpus_sources.lock.json
python forge/rights_evidence.py --evidence forge/config/data_rights_evidence.json --source-lock forge/config/corpus_sources.lock.json --rights forge/config/data_rights.json
```

`data_rights.json` intentionally remains `REVIEW_REQUIRED` until the recorded obligations are manually approved. Do not bypass that gate. After approval, corpus acquisition must use `--source-lock forge/config/corpus_sources.lock.json`.

The first serious scale gate is IMC-125M. Validate the locked recipe and hardware batch decomposition with:

```powershell
python forge/imc_125m_recipe.py --world-size 1 --micro-batch 4
python forge/imc_125m_preflight.py --freeze <ilarialex.freeze.json> --dataset-manifest <dataset-manifest.json> --rights <rights.json>
```

The bootstrap recipe is fixed at 125,882,112 parameters, context 2048, 1B target tokens and 262,144 global batch tokens, with ternary and full-precision controls over the same three seeds. It is explicitly `BOOTSTRAP_NOT_PROMOTED` until the required evaluation suite passes.

## Repository rule

Code in this repository must directly serve IMC/Myriad: model architecture, from-scratch training, tokenizer/data pipeline, evaluation, verified tools/agent learning, memory/cortex integration, ternary deployment runtime, or distributed Myriad training. Legacy external-model compatibility does not belong here.
