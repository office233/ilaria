# Licensed OS code scale-validation package

This adapter freezes only the newly acquired, source-qualified FreeRTOS and Zephyr exact-body candidate. It preserves source, locked revision, path, SPDX identifier, file hash, raw shard hash and physical raw line for every retained body and exact-body alias. It verifies those bindings against current approved rights evidence, the source lock, canonical licensed-tree manifests, and the corresponding raw JSONL rows. It does not read or import the older G4 pilot corpus or model weights.

The split is deterministic from the recorded seed. The grouping key starts with repository, locked revision and the first two path components (or the file stem for root files). Exact-body aliases connect their module families transitively. Therefore a file family or duplicate body cannot cross train, validation and sealed splits. Frozen evaluation files from the canonical exclusion plan are filtered using Ilaria's `data_audit.benchmark_shingles` at width 12. This is a conservative lexical check, not a semantic proof of benchmark independence.

The package emits `train.jsonl`, `validation.jsonl`, `sealed.jsonl`, canonical IlariaLex EOS token streams and a content-addressed `code-only-pilot-package.json`. It enforces a 10M/1M/1M token minimum, a 1 GiB output/RSS cap, two-thread tokenizer settings and a 15-minute wall limit. Text is retained verbatim, including source headers, case and indentation; no truncation occurs.

Example from the dedicated worktree; provide the workspace and evidence roots, and choose a new output directory for each run because publication is no-clobber:

```powershell
$NEXUS_WT = (Get-Location).Path
$NEXUS_ROOT = 'E:\nexus'
$NEXUS_TRAINING = 'E:\nexus-training'
python "$NEXUS_WT\ilaria\bench\licensed_code_pilot_package\package.py" `
  --input-root "$NEXUS_TRAINING\new-public-20261001\licensed-os-code" `
  --output "$NEXUS_TRAINING\evidence\licensed-code-pilot-fresh-run" `
  --forge-root "$NEXUS_WT\ilaria\forge" `
  --tokenizer "$NEXUS_ROOT\ilaria\data\production\ilarialex.json" `
  --benchmark-plan "$NEXUS_WT\ilaria\forge\config\imc_125m_benchmark_exclusions.json" `
  --benchmark-root "$NEXUS_ROOT\ilaria" `
  --config "$NEXUS_WT\ilaria\bench\licensed_code_pilot_package\pilot_config.json" `
  --seed 'licensed-os-code-scale-20261002-v1'
```

Validate a completed package without rewriting it:

```powershell
python -c "import sys; from pathlib import Path; sys.path.insert(0, r'ilaria\bench\licensed_code_pilot_package'); from package import validate_package_manifest; print(validate_package_manifest(Path(r'E:\nexus-training\evidence\licensed-code-pilot-20261002-seed1'))['package_sha256'])"
```

The `NON_PROMOTABLE_CODE_ONLY_SCALE_VALIDATION` label is intentional. This two-source package does not satisfy the eight-lane Genesis mixture or the 100M OS lane quota plus headroom, and it is not a canonical production `dataset.manifest.json`. A separate full-mixture and promotion review remains necessary before any production run. This package does not perform training.
