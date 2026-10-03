# Clean code pilot v2 trainer migration

State: STOP/FROZEN — LOCAL GATES PASS, READY FOR SELECTIVE INTEGRATION.

Owner: current ChatGPT session, branch `codex/trainer-v2-migration-20261002`,
worktree `E:\nexus-worktrees\trainer-v2-migration-20261002`.

Claims are limited to:

- `ilaria/forge/train_ilaria.py`
- `ilaria/forge/qualified_pilot_v2.py`
- `ilaria/forge/test_qualified_pilot_v2.py`
- this handoff

All other seeded Forge/bootstrap files are read-only snapshots of the current
public Main working tree, pinned in
`E:\nexus-training\evidence\trainer-v2-migration-20261002\baseline.json`.

The migration is a separate v2 route. It does not rewrite the accepted v1
adapter, does not substitute the historical tokenizer freeze, does not promote
the code-only dataset, and grants no cloud/GPU allocation authority.

## Implemented contract

`--qualified-pilot-v2` is mutually exclusive with v1. Admission revalidates
the clean-v2 package, split-before-tokenizer corpus identity, tokenizer binding,
current rights/evidence/source locks, train/validation stream bytes, sealed
path/inode separation, tokenizer bytes, and the pinned independent replay.
The training process does not hash/open the sealed token payload; exact sealed
bytes remain covered by the separately pinned replay receipt.

A separately content-addressed decision is required with state
`APPROVE_NONPROMOTABLE_LOCAL_SCALE_VALIDATION`, `promotable=false` and
`allocation_authorized=false`. No decision is inferred from hashes or from the
adapter. Legacy tokenizer freeze substitution and qualified-pilot resume are
rejected.

## Verification

- New v2 targeted suite: 12 passed.
- v1 adapter/tokenizer-contract/admission regressions: 94 passed.
- Final affected Python gate including `test_imc_model.py`: 301 passed in
  77.84 s.
- `python -m py_compile` for canonical model/trainer/training-state plus v2:
  pass.
- `GOWORK=off go test ./...`: 8 test-bearing packages passed, no failures.
- `GOWORK=off go vet ./...`: pass.
- LSP: zero diagnostics in both new v2 Python files. The 13 diagnostics in
  `train_ilaria.py` reproduce unchanged in the current Main baseline and were
  not introduced by this lot.
- Seed integrity: 151 public snapshot files checked; only the claimed
  `train_ilaria.py` differs from the recorded seed. No baseline file missing.
- `git diff --check` on the tracked trainer: pass. Each new claim also passes
  `git diff --no-index --check` (exit 1 only for the expected content
  difference, with empty whitespace diagnostics).

The real `clean-code-v2` artifacts were revalidated through the new adapter's
artifact validator: package
`030cf1ef1100e8ea97b0824b7567fc58883ba97c1fe72d16afe7183d1fa56c67`,
tokenizer
`886356ad480e727742822b3faf0517b76c5e957c0a92f955565bf4609bec29b5`,
17,971,937 train tokens, 7,362,097 validation tokens and 2,917,181 sealed
tokens. The pinned replay reports zero exact sample/heldout overlap and zero
normalized-body overlap, with promotion/allocation false.

This does **not** create the reviewed real-launch decision, qualify a production
mixture, prove semantic benchmark independence, prove NCCL/eight-H200 execution,
or authorize Brev allocation.

Evidence:
`E:\nexus-training\evidence\trainer-v2-migration-20261002`.

No stage, commit, push, deploy, cloud allocation, Colab mutation, Bridge/config
mutation, secret read or checkpoint/model-weight read occurred in this lot.
