# IMC-125M candidate data inventory

Snapshot: 2026-09-30 10:29 +03:00

This report is planning evidence only. It does not approve any source for
production training and it is not a dataset manifest.

## Command

```powershell
python forge/corpus_inventory.py `
  --source-manifest data/candidate-corpus/freertos_kernel/freertos_kernel.manifest.json `
  --source-manifest data/candidate-corpus/golang_go/golang_go.manifest.json `
  --source-manifest data/candidate-corpus/python_cpython/python_cpython.manifest.json `
  --source-manifest data/candidate-corpus/rust_lang/rust_lang.manifest.json `
  --source-manifest E:/nexus-sources/staging/zephyr-corpus/zephyr.manifest.json `
  --curriculum forge/config/imc_125m_curriculum.json `
  --lane-rules forge/config/imc_125m_inventory_lanes.json `
  --rights forge/config/data_rights.json `
  --target-tokens 1000000000 `
  --out bench/imc_125m_data_inventory/candidate-inventory.json
```

Inventory identity:
`da52a2e61856387f75ba934d2fab0fca3a323516bc7016b46e556cf7a343c73f`

Curriculum identity:
`3ac9c6e0a36e85151e543dfbff09c8ea319b1566b6dd77d981cab8c8f34a4432`

## What is measured

- every source/shard size and SHA-256 is verified before scanning;
- documents are assigned to exactly one curriculum lane;
- exact-normalized duplicates use the existing
  `data_audit.document_sha256` identity globally across sources;
- source rights status is reported but never promoted by the inventory;
- until production IlariaLex is frozen, token counts are estimates using
  UTF-8 bytes / 4.0 .. bytes / 3.2 plus one EOS per document;
- once a canonical tokenizer is supplied with `--tokenizer`, the same tool
  counts the exact encoded tokens plus the canonical EOS per document.

## Current candidate capacity

| Lane / source | Documents | Text bytes | Estimated tokens |
|---|---:|---:|---:|
| Zephyr total | 13,417 | 104,931,325 | 26.246M–32.804M |
| FreeRTOS Kernel total | 636 | 14,197,769 | 3.550M–4.437M |
| Go total | 10,059 | 57,658,690 | 14.425M–18.028M |
| CPython total | 5,393 | 103,089,903 | 25.778M–32.221M |
| Rust total | 40,798 | 168,080,366 | 42.061M–52.566M |
| **All candidate data** | **70,303** | **447,958,053** | **112.060M–140.057M** |
| code | 56,305 | 329,481,830 | 82.427M–103.019M |
| OS / hardware / drivers / standards | 13,998 | 118,476,223 | 29.633M–37.038M |

Global normalized duplicates observed between these inputs: **0**.

All current source rights remain `REVIEW_REQUIRED`, therefore the approved
production capacity remains **0 tokens**. Candidate volume must not be treated
as training eligibility.

## Deficits exposed by exclusive lane assignment

- general knowledge: 300M candidate deficit;
- code: at least 116.981M deficit even under the high-token estimate;
- mathematics: 145M deficit;
- science / technical reasoning: 105M deficit;
- OS / hardware / drivers / standards: at least 62.962M deficit;
- agent/tool trajectories: 80M deficit;
- world/device trajectories: 50M deficit.

The earlier ~37M Zephyr+FreeRTOS number was a shared pool. The inventory now
also includes pinned Go, CPython and Rust candidate corpora and still assigns
every document to exactly one lane, so the same bytes cannot satisfy two quotas.

## Verification

- `python -m pytest -q forge/test_corpus_inventory.py` -> **5 passed**
- `python -m pytest -q forge/` -> **207 passed**
- `python forge/production_readiness.py` -> **ready: false**, as expected:
  rights review, first-party attestation, tokenizer artifacts and the immutable
  dataset manifest are still missing.
