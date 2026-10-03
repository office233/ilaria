# Qualified code-only IMC pilot adapter

Scope: four claims in `codex/qualified-code-pilot-adapter-20261002` at
`C:\Users\abel\.codex\worktrees\qualified-code-pilot-adapter-20261002\nexus`.
Only `ilaria/forge/train_ilaria.py`, new `qualified_pilot.py`, new
`test_qualified_pilot.py`, and this handoff are releasable. Public dependency
snapshots are read-only baseline inputs; unrelated worktree differences are not
part of this change. Main, its index/history, frozen acquisition, rights and
previous receipts remain outside these claims.

The preserved current trainer baseline is
`476064e8b0b3d817701217cd56741b835f0ee2741957ad6d766d450c560ae4c5`.
Integrated launch gate baseline is
`01434f237459fddc0babf2da0cc0e69f5ddfcb4fb8541bd4082b148ae4c9da00`.
Evidence is external at
`E:\nexus-training\evidence\qualified-pilot-adapter-20261002`.
The explicit 28-public-input baseline is `baseline.json`; `trainer.before.py`
preserves the actual predecessor for the narrow diff and RED reproduction.

## Admission contract

`--qualified-pilot <launch.json>` selects
`ilaria-qualified-code-pilot-launch-v1`, with canonical `launch_sha256`, and
explicit paths for dataset, qualification, decision, assignment, validation
receipt, registry, rights evidence, HF/Git source locks, and the three stream
metadata files. Paths alone confer no approval.

The existing versioned launch gate validates all reviewed rights/provenance,
source revisions, producer, group separation, validation receipt, split
identities, explicit pilot decision and positive bounds. Only its known
obsolete-adapter placeholder is resolved by this adapter; other blockers fail
closed. Qualification additionally binds:

- `trainer_adapter = {format: ilaria-qualified-code-pilot-adapter-v1,
  source_sha256: <actual qualified_pilot.py bytes>}`;
- `tokenizer_freeze_sha256` and `tokenizer_freeze_file_sha256`;
- `tokenizer_sample_groups`, nonempty unique reviewed train-only groups.

No template, approval, registry, frozen package or acquisition is rewritten.
PENDING decisions, absent actual byte/provenance validation, missing groups,
rights review gaps, rehashed overlap and obsolete adapter attempts reject before
opening token streams or acquiring CUDA/DDP/model/optimizer resources.

The CLI train/validation prefixes must match their distinct approved metadata;
resolved binary aliases to sealed data reject. Sealed bytes are never loaded.
The tokenizer sample is inspected as metadata first; references matching sealed
hashes reject before sample text validation. Canonical `load_stream`, tokenizer
identity and freeze validators then validate actual train/validation/tokenizer
bytes and the same source locks. Synthetic fixtures contain no sealed binary.

This version deliberately supports only tokenizer sample groups within the
qualified package's reviewed train groups and matching package source locks.
An independently frozen universal tokenizer trained on separately approved
sources is currently unsupported and rejects. Missing real sample-group/source
lineage cannot be inferred from a tokenizer hash or approved by a boolean. The
actual frozen package may require a separate reviewed contract/version for
independent tokenizer provenance; this change supplies no such approval.

Pilot mode cannot combine production manifest, unmanifested smoke, internal
validation split or warm start. Production and smoke admission keep their
existing validators. The canonical IMC architecture, sampling, optimizer,
schedule, DDP, evaluation and training loop remain authoritative.

## Bounds and supervision

Resolved global tokens per step are `world * ctx * batch * accum`. The full
horizon must fit reviewed maximum steps and tokens before allocation; each
microbatch and optimizer/evaluation/publication boundary has cooperative wall
and token checks. These checks do not guarantee interruption of a stalled
native call. Post-run sampling is disabled for the bounded pilot.

`supervise_canonical(canonical_args, world_size=..., deadline=..., log_path=...)`
constructs only the exact canonical `torch.distributed.run` invocation and
reuses the shared bootstrap supervisor. It binds launch identity, actual
canonical worker source/path, and exact rank argv SHA. The child requires the
shared live-owned-scope assertion before allocation; caller booleans and old
process-group-only receipts cannot grant admission. Reviewed shared source pins
are an explicit source release, not environment or launch metadata. Root
reviewed the shared Linux control/cleanup release after its corrected native
eight-case suite passed in Main (10.40 s). The only accepted dependencies are
`probe.py` SHA `b4a8b09d36d45449b440dfc393f1ae20f9ab204747a705d98f961e83e3cdc704`
and `containment.py` SHA
`2f211d79b9e92c6e32f864e4d37d1e8bf7568c38fb2f0a0ad41d25278cfd7894`.
They are copied here solely as read-only public dependency snapshots, not this
owner's release claims. Unowned/raw calls, wrong source pins, caller-ready
flags and Windows supervised entry refuse. No duplicate process-tree or Job
implementation is introduced. This is an owned-scope capability release, not a
live Linux canonical training, NCCL or eight-GPU qualification receipt.

Qualified pilot resume is deliberately rejected before streams/resources:
checkpoint pre-serialization elapsed is not cumulative hard-wall authority.
Enabling it requires a completed prior owned-scope receipt binding exact
checkpoint/qualification/config/source identities, total invocation time
including cleanup, verified closed scope and positive remaining allowance.
Production checkpoint/resume validation remains strict and unchanged.

The existing checkpoint signature adds the pilot binding; top-level checkpoint
and `qualified-pilot-run.json` explicitly carry
`NON_PROMOTABLE_CODE_ONLY_SCALE_VALIDATION` and `promotable: false`. The run file
also records `allocation_authorized: false`. Existing trainer-source signature
checking continues to reject incompatible older checkpoints; no silent legacy
conversion or weights import is added.

## Validation and limits

The preserved predecessor fails the positive owned tiny canonical-loop
regression because it rejects `--qualified-pilot` (one discriminating RED).
Candidate validation used only new synthetic metadata, tiny owned uint16
streams, and a tiny CPU IMC fixture. The tiny loop test injects supervision and
is explicitly not hard-wall/GPU/DDP/actual-package proof.
WSL Python has no Torch runtime; no live Linux canonical pilot was verified.
The separate shared helper's synthetic Linux control/cleanup proof cannot turn
the injected Windows CPU fixture into that missing integration receipt.

Affected Python suite: 296 PASS in 54.61 s. Latest focused adapter checks and
source hashes are recorded in the final external owner receipt. Required
`py_compile`, Ilaria Go tests (12 packages), vet and `git diff --check` passed.
The narrow trainer diff is against `trainer.before.py`, since Git HEAD predates
already accepted current Main changes.

Actual frozen code-only package, independent artifact-byte/provenance review,
explicit decision, bounds, live Linux canonical proof, eight-GPU/NCCL
qualification and allocation remain separate gates. Recovered expected group
lists do not prove corpus membership. No full corpus, GPU, paid job, cloud,
Bridge, data download, private key, user weight or actual launch was used here.
Remote export/deletion/window and Brev terms remain allocation gates; the
100 USD / 38.4 USD per hour / two-hour plan is not approved by this adapter.
Root must review the four claims and their final hashes before selective Main
integration. Final source/review state is in `owner-receipt.json`.
