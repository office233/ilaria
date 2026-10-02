# Qualified pre-existing tokenizer contract owner handoff — 2026-10-02

Owner state: **STOP/FROZEN for root review and selective integration**. Worktree:
`C:\Users\abel\.codex\worktrees\qualified-tokenizer-contract\nexus`, branch
`codex/qualified-tokenizer-contract-20261002`. No staging, commits, pushes, Main
edits, real corpus/tokenizer payload reads, compute allocation, or goal changes.

The canonical IMC architecture/trainer remains from scratch. This change only
admits an explicitly reviewed pre-existing immutable IlariaLex freeze into the
existing NON_PROMOTABLE code-only scale-validation pilot. The 125M validation
stage and IMC-1B goal, rights approvals, data decision/qualification/validation,
assignment, bounds, admission before compute, supervised entry, and resume
refusal remain intact. It creates no training loop or approval authority.

## Claimed files

- `ilaria/forge/qualified_pilot.py`: retain the existing adapter v1 identity and
  exact default train-only `tokenizer_sample_groups` path; add explicit contract
  selection and persist its pins in the existing checkpoint/signature binding.
- `ilaria/forge/qualified_tokenizer_contract.py`: new versioned cross-binding
  admission; canonical freeze and first-party validators remain authoritative.
- `ilaria/forge/test_qualified_tokenizer_contract.py`: owned synthetic fixtures
  and meaningful admission, exclusions, source drift, rights and CPU regressions.
- This handoff. No `training_launch_gate.py` or other protected source changed.

Exact before/after SHA-256, byte counts, new source pins and protected baseline
comparison are in external `owner/source-pins.json`. The baseline is the root's
`qualified-tokenizer-contract-20261002/baseline.json`; seeded files are untracked
in this worktree. Diff checking therefore includes both ordinary `git diff
--check` and `git diff --no-index --check` against an explicit empty fixture.

## Explicit v1 schema

Qualification and launch must carry the same `pre_existing_tokenizer` object:
`format=ilaria-qualified-pre-existing-tokenizer-v1`, `source_sha256` of the new
validator, `path`, `file_sha256`, and `contract_sha256`. Omission on both sides
retains the old train-only contract; partial, null, unknown or obsolete bindings
fail closed. The pre-existing path rejects `tokenizer_sample_groups` entirely.
The existing `trainer_adapter` source pin is still required.

The separately sealed contract has `scope=code-only-pilot`, `promotable=false`,
`state=ACCEPT_PRE_EXISTING_TOKENIZER`, `reviewed_by`, `review_ref`, and exact
`pilot` bindings to dataset identity/file, tokenizer, source provenance, rights,
producer, assignment, independent pilot validation, bounds and actual groups.
Its `freeze`, `sample`, `coverage` records bind explicit paths, file hashes and
canonical identities. `sources` and `inputs` equal the sample's exact records.
`rights` pins existing registry/evidence/HF lock/Git lock metadata independently
of the pilot's source set. Existing source approvals and unresolved conditions
remain authoritative through their existing validators; no new legal, region,
recipient or source-approval fields are required.

`first_party_attestations` is an explicit source-to-pinned-packet map containing
`path`, `file_sha256`, `attestation_sha256`, `attestation_scope_sha256`.
`first_party_root` names the reviewed immutable source root, or is `null` when
the map is empty. Exact sample/coverage packet identities are checked before
source/sample payload reads. Canonical `validate_attestation` rejects missing or
mutated source files, then `validate_freeze_manifest` receives this exact map
and root explicitly. No current checkout, environment value or caller readiness
flag supplies a substitute root or attestation.

The contract also pins a separately sealed
`ilaria-qualified-tokenizer-exclusion-receipt-v1` by path/file/identity. It must
have `state=VERIFIED_INDEPENDENT`, `validation_level=tokenizer-inputs-and-heldout-provenance-v1`,
review identity/reference, and exact pilot/lineage bindings. `input_provenance`
contains every unique sample/coverage input, its resolved path, complete input
record and reviewed group identities. `excluded_groups` contains exact pilot
validation/sealed groups plus the complete benchmark group inventory.
`heldout_artifacts` explicitly pins JSONL, stream and metadata paths/hashes for
both heldout splits; stream/metadata paths must match the launch. Raw JSONL may
live elsewhere. `benchmark_artifacts` explicitly lists benchmark paths/hashes,
including an explicit empty list only when that is the reviewed complete scope.
Known heldout hashes, resolved paths and existing hard-link aliases are excluded
before payload reads. Attested source paths receive the same exclusion check.
The tokenizer payload and its implicit companion are also checked against this
full inventory by resolved path, hard-link identity and pinned hash before any
attested source/sample bytes are read. Companion derivation matches canonical
`build_freeze_manifest`: apply `.with_suffix(".hf.json")` to the unresolved
tokenizer path, verify its `hf_filename` pin, then resolve aliases. Resolving the
tokenizer first could select a different companion for a symlinked tokenizer.

## Trust and limits

These are content-addressed review receipts, using the existing review model;
there is no cryptographic reviewer authentication or automatic semantic
independence proof. A trusted independent reviewer must actually validate the
complete tokenizer/sample/coverage lineage, derive genuine provenance group
identities using the pilot assignment scheme, and audit all heldout/benchmark
artifacts and the completeness of the benchmark inventory. Hashes alone prove
neither rights nor independence. Rehashing fabricated review assertions cannot
make them trustworthy. Receipt creation/approval is outside this implementation.
Frozen inputs and source roots must remain immutable between checks. Canonical
validation and contract pin comparison run again before compute, but this does
not create a transactional filesystem or new resume/allocation authority.

Root's independent readback found two source drifts in the current Ilaria root
and constructed an external immutable source root from the already approved
versions. This implementation can bind such a root without changing its packet;
it does not hardcode that operational path or re-attest anything. The actual
tokenizer bytes, exclusions and real pilot admission remain unproven here.

## Validation receipts

External logs: `E:\nexus-training\evidence\qualified-tokenizer-contract-20261002\owner`.
CPU runtime: WSL Python 3.14.4, Torch 2.14.0+cpu, pytest 9.1.1, NumPy 2.5.3,
tokenizers 0.23.2; no installation or GPU/cloud jobs. Windows Python 3.12.10 was
used for syntax checks. Commands, exit codes and counts are in `checks.json`.

- Initial targeted run: 105 passed, one Windows-only skip, one synthetic test
  dispatch failure; preserved in `targeted-attempt-1.log` (exit 1), then fixed.
- Targeted admission/freeze/attestation/launch regressions: 112 passed, one
  Windows-only skip in `targeted-attempt-2.log` (exit 0).
- Final new contract tests after heldout inventory and canonical-result drift
  checks: 47 passed in `final-contract-attempt-2.log` (exit 0).
- Review repair RED: seven new payload/companion exclusion regressions failed
  before repair, preserved in `repair-tokenizer-alias-red.log` (exit 1).
- Repaired contract and unchanged adapter v1 regressions: 78 passed, one
  Windows-only skip in `repair-tokenizer-alias-pass.log` (exit 0). Guards trap
  both `Path.open` and built-in file opens/hash reads; the tests cover valid
  benchmark hard-links, independent matching hashes, heldout aliases and a
  tokenizer symlink whose canonical implicit companion has a different stem.
- `forge/test_imc_model.py`: 195 passed in `imc-model.log` (exit 0).
- Syntax and ordinary `git diff --check`: exit 0. Each untracked-file
  `git diff --no-index --check` reports only exit 1 for the expected file
  difference and no whitespace diagnostics. Exact protected source comparison:
  no drift outside the claimed adapter.
  Repair syntax remains exit 0; repair whitespace receipts are preserved in
  `repair-syntax.log` and `repair-diff-check.log`.

Synthetic positives use tokenizer sources distinct from pilot sources and pass
the canonical freeze validator with an explicit first-party map/root. Negatives
cover omission/pending/unreviewed receipts, identities, heldout/benchmark overlap,
sealed/validation aliases, unknown sources, wrong roots/packets, source/payload
drift, stale validator pins and caller readiness flags. A canonical trainer-entry
test proves rejection before stream open, CUDA, DDP, model or output allocation.
The CPU checkpoint test injects supervision solely to verify existing-loop pin
propagation; it is not a supervision/GPU/real-data qualification receipt.

Mandatory Main Go tests/vet remain root's responsibility after selective
integration because this seeded worktree lacks current untracked protocol code.
No owner work remains except root-requested review repairs.
The previous owner pins/checks were preserved as `source-pins-before-repair.json`
and `checks-before-repair.json`. Root's earlier integration plan and reviewed
snapshot remain rejected-before-integration evidence; root must bind a new plan
to the repaired source pins.

## Root-only synthetic Supervisor recipe

The synthetic builder is `test_qualified_tokenizer_contract.fixture`, with
`save` to seal the contract/receipt/qualification/launch after operational bounds
change. The new route uses the explicit pre-existing protocol v1, distinct from
the unchanged legacy adapter v1. This is a construction recipe for root's next
proof; the owner did not execute it. Run with the prepared CPU Python on Linux,
passing the integrated Forge path and a new exclusive synthetic fixture path.
It invokes only the canonical trainer through the reviewed Supervisor, without
mocking or injecting admission/supervision. World 2, two steps, context 4,
batch/accumulation 1 yields 16 global train tokens.

```python
import copy, json, sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

forge, root = Path(sys.argv[1]).resolve(), Path(sys.argv[2]).resolve()
sys.path.insert(0, str(forge))
from qualified_pilot import supervise_canonical
from qualified_tokenizer_contract import pilot_scope
from test_qualified_pilot import cli
from test_qualified_tokenizer_contract import fixture, save
from test_training_launch_gate import refresh

root.mkdir(parents=False, exist_ok=False)
f = fixture(root)  # exclusively newly generated, owned synthetic data
f["value"]["qualification"]["bounds"]["max_train_tokens"] = 16
refresh(f["value"])
scope = pilot_scope(f["value"]["qualification"], f["value"]["assignment"])
f["contract"]["pilot"], f["receipt"]["pilot"] = scope, copy.deepcopy(scope)
save(root, f)
argv = cli(f["launch"], f["args"], root / "out")[1:]
receipt = supervise_canonical(
    argv, world_size=2,
    deadline=datetime.now(timezone.utc) + timedelta(seconds=30),
    log_path=str(root / "supervised-canonical.log"),
)
(root / "supervised-receipt.json").write_text(
    json.dumps(receipt, sort_keys=True, indent=2) + "\n", encoding="utf-8")
```

Root must inspect the full owned-scope cleanup receipt and resulting canonical
checkpoint/signature before claiming this proof. The recipe grants no authority
for actual tokenizer/corpus/Brev data, GPU allocation, production or resume;
all real-data qualification flags remain false until the required evidence.
