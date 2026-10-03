# Production contamination clearance generator/verifier

State: STOP/FROZEN — LOCAL/LINUX + ACTIVE-GATE INTEROP PASS.

Branch:
codex/production-contamination-clearance-20261002

Worktree:
E:\nexus-worktrees\production-contamination-clearance-20261002

Exclusive claims:

- ilaria/bench/production_contamination_clearance/scan.py
- ilaria/bench/production_contamination_clearance/verify.py
- ilaria/bench/production_contamination_clearance/test_clearance.py
- ilaria/bench/production_contamination_clearance/README.md
- this handoff

Read-only dependencies copied from current Main for validation only:

- ilaria/forge/data_audit.py
- ilaria/forge/data_contract.py

The RUNNING owner claims on production_readiness.py/test_production_readiness.py
and nexus-takeover tokenizer files were not edited or integrated.

## Contract

scan.py emits only a content-addressed producer scan. verify.py is a distinct
source implementation and does not import scan.py. It reparses the package,
rehashes every split artifact and tokenizer selection artifact, verifies
selection-metadata identity, ledger/sample hashes and exact emitted byte ranges,
then independently recomputes the five counters.

Clearance requires exact integer zero for:

1. train_validation_exact_overlap
2. tokenizer_heldout_exact_overlap
3. tokenizer_heldout_normalized_overlap
4. dataset_benchmark_shingle_overlap
5. group_overlap

The output format is exactly:
ilaria-production-contamination-clearance-v1

with validation level:
dataset-tokenizer-heldout-benchmark-separation-v1

It binds the exact expected dataset/tokenizer/freeze/benchmark object supplied by
the readiness gate, the exact heldout inventory, producer and verifier source
hashes, explicit reviewer/reference metadata and the five zero counters.
allocation_authorized=false and promotion_authorized=false are invariant.

## Interoperability proof

A synthetic zero-overlap package was scanned and independently replayed. Generated:

- scan SHA:
  c3169183a912ca2fac78ea6a04b3b0961619b7ca7bf5dc2178c5f5d925e96091
- clearance SHA:
  5b240677b23aebcf94c67b64ac38912c6b5c338eccdb63cde4f9309ab266c32f
- all five checks: 0

The emitted clearance was then passed read-only to
assess_contamination_clearance() from the active owner's worktree
E:\nexus-worktrees\production-contamination-gate-20261002.

Result: valid=true, error=null, exact clearance SHA preserved.

Evidence:
E:\nexus-training\evidence\production-contamination-clearance-20261002\interop

## Verification

- targeted Windows: 11/11 PASS
- targeted pinned Linux runtime: 11/11 PASS
- py_compile: PASS
- LSP/Pyright on scan.py, verify.py, test_clearance.py: 0 diagnostics
- GOWORK=off go test -count=1 -timeout 180s ./...: PASS, 8 test-bearing packages
- go vet ./...: PASS

Adversarial tests prove refusal/counting for each relevant class:

- exact train/validation collision
- tokenizer exact heldout collision
- tokenizer normalized heldout collision
- cross-split group collision
- benchmark shingle collision
- tampered producer scan
- tampered tokenizer sample
- tampered tokenizer ledger fragment
- missing explicit group identity
- benchmark binding drift
- missing reviewer/reference metadata

## Production status

No real production clearance was generated. The old production manifest/tokenizer
is independently contaminated and the old dataset manifest no longer reconstructs
under the current validator. The clean full production manifest, tokenizer/freeze
and sealed artifacts are still pending active data/tokenizer owners.

No cloud/GPU job, training, tokenizer training, data acquisition, secret read,
Bridge/config mutation, stage, commit, push or deploy occurred.
