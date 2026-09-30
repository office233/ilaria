# AGENTS.md

## 1. Project identity

Ilaria contains one production model family: **IMC (Ilaria MicroCortex)**, trained from random initialization.

The canonical production target is **IMC-1B = 1,000,555,520 parameters**. Smaller IMC presets are scale-validation stages only.

Do not introduce external pretrained language-model checkpoints or a second language-model architecture into Ilaria.

## 2. Canonical surfaces

- `forge/imc_model.py` — IMC architecture.
- `forge/train_ilaria.py` — from-scratch pretraining.
- `forge/training_state.py` — checkpoint/resume contract.
- `forge/hf_tokenizer.py` — IlariaLex tokenizer pipeline.
- `forge/prepare_corpus.py`, `forge/concat_streams.py`, `forge/holdout.py` — corpus pipeline.
- `specs/myriad.swyp` — Myriad model/expert/protocol source of truth.
- `specs/myriad.manifest.json` — generated manifest; never hand-edit independently of the .swyp source.
- `generated/myriad/types_gen.go` — generated protocol DTOs.
- `internal/runtimeguard` — atomic/runtime safety utilities.
- `docs/plans/MASTER_PLAN.md` — canonical execution plan.
- `../swyp` — compiler/verifier and component DSL.
- `../swypik-os` — OS, device authority and Compute Fabric.

## 3. Architecture rules

- All model instances use the same IMC architecture and IlariaLex protocol.
- Experts are specialized IMC instances, not alternate model families.
- Personal memory remains local by default.
- Distributed candidate updates never directly mutate production weights.
- Every promoted checkpoint or expert requires reproducible lineage, provenance and frozen evaluation.
- Operational training parameters belong in manifests/configuration, not silent hardcodings.
- Protocol/file-format constants must be explicit and versioned.

## 4. Validation

For Ilaria changes:

```powershell
python -m py_compile forge\imc_model.py forge\train_ilaria.py forge\training_state.py
python -m pytest -q forge\test_imc_model.py
go test ./...
go vet ./...
```

For Myriad specification changes, from `../swyp`:

```powershell
go run ./cmd/swyp component check ..\ilaria\specs\myriad.swyp
go run ./cmd/swyp component compile -o <temporary-output> ..\ilaria\specs\myriad.swyp
go run ./cmd/swyp component go -package myriad -o <temporary-output> ..\ilaria\specs\myriad.swyp
```

Swyp intentionally refuses to overwrite outputs. Generate to a temporary path, verify success, then replace the checked-in generated artifact.

## 5. Safety and repository hygiene

- Do not read or commit secrets.
- Do not push, deploy, purchase compute or publish releases unless explicitly requested.
- Do not silently restore legacy cortex/BitNet/GPT compatibility.
- Keep generated artifacts reproducible from their source.
- Preserve an auditable dataset/model lineage for every training run.
