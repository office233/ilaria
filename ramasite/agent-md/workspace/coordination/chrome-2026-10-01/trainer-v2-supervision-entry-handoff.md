# Clean code pilot v2 — Linux supervisor entry

State: **STOP/FROZEN — LOCAL GATES PASS, READY FOR SELECTIVE INTEGRATION**.

Owner: current ChatGPT session, branch `codex/trainer-v2-supervision-entry-20261002`,
worktree `E:\nexus-worktrees\trainer-v2-supervision-entry-20261002`.

Claims are limited to:

- `ilaria/forge/qualified_pilot_v2.py`
- `ilaria/forge/test_qualified_pilot_v2.py`
- this handoff

All other seeded Forge and `imc_nccl_bootstrap` files are read-only snapshots
of the current public Main working tree, pinned in
`E:\nexus-training\evidence\trainer-v2-supervision-entry-20261002\baseline.json`.

## Implemented

The v2 adapter now exposes `supervise_canonical(...)` for the clean
split-before-tokenizer route. It reuses the existing reviewed
`qualified_pilot` supervisor primitives and the exact pinned
`imc_nccl_bootstrap/probe.py` + `containment.py` sources; it does not
introduce another process-tree/sandbox implementation.

The wrapper:

- requires reviewed POSIX/Linux containment and a bounded world size;
- parses the exact `--qualified-pilot-v2` canonical trainer invocation;
- performs clean-v2 metadata/artifact admission before creating the supervisor;
- binds the launch identity, exact `train_ilaria.py` path/hash and worker argv;
- verifies the live supervisor capability/source pins;
- launches only the canonical `torch.distributed.run` child;
- leaves the child-side `CleanV2Admission.require_supervision()` check intact.

This remains NON_PROMOTABLE. It grants no rights approval, production
qualification, cloud/GPU allocation authority, Brev approval or model promotion.

## Verification

- Windows v2 targeted suite after the new wrapper: **14 passed**.
- LSP diagnostics on the two changed Python sources: **0 errors / 0 other**.
- `py_compile` for v2, v1 adapter, canonical trainer and training state: PASS.
- Live Linux CPU/Gloo supervised proof using the already prepared pinned CPU
  runtime: **PASS**, world-size 2, 2 optimizer steps, 16 global tokens,
  admission not injected, cleanup/no-children verified, paid compute false.
- Final affected Python suite
  (`test_qualified_pilot_v2.py`, v1 adapter, tokenizer contract,
  admission-order regressions, `test_imc_model.py`): **303 passed in 79.55 s**.
- `GOWORK=off go test -count=1 -timeout 180s ./...`: **8 test-bearing packages
  passed, 0 failed**.
- `GOWORK=off go vet ./...`: PASS.

Linux proof:
`E:\nexus-training\evidence\trainer-v2-supervision-entry-20261002\synthetic-supervised-proof.json`.

The proof is deliberately synthetic and tiny. It proves the v2 route can enter
and complete the reviewed canonical Linux supervisor path; it does **not** prove
the real clean-v2 launch decision, full real-data training, NCCL/8×H200,
throughput at 125M/1B scale, export/deletion, billing shutdown or promotion.

No stage, commit, push, deploy, cloud allocation, Colab mutation, Bridge/config
mutation, secret read, external model call or production checkpoint read
occurred in this lot.
