# Trainer data admission before resource setup

State: SOURCE FROZEN / LOCAL GATES PASS / NOT YET INTEGRATED. 2026-10-02.
Owner: root, worktree `codex/trainer-preflight-20261002`.

The canonical trainer previously selected CUDA and initialized distributed workers
before checking streams, then constructed the model/optimizer before validating
the tokenizer and production dataset/freeze manifests. Rejected inputs could
therefore reserve accelerator resources or wait in distributed setup first.

This change moves the existing stream, tokenizer, dataset and freeze checks before
`set_device`, `init_process_group`, model and optimizer construction. Training
stream I/O/validation errors become argparse errors. Admission rules, CLI flags,
model architecture, optimizer, seeds and training/checkpoint loops are preserved.
CPU stream hashing/mapping still consumes resources; this is no cloud allocation
guard and does not supply a qualified production dataset or bounded-pilot adapter.
Checkpoint signatures include trainer-source hashes, so old signatures retain
their existing strict source-compatibility requirements.

Exactly three claims: `ilaria/forge/train_ilaria.py`, NEW
`ilaria/forge/test_training_admission_order.py`, and this NEW handoff.
All other files in this WT are read-only explicit public dependency/test snapshots.
They must not be copied into Main as an overlay.

Evidence: `E:/nexus-training/evidence/trainer-preflight-20261002`.
`baseline.json` pins the exact 25 copied public source/AGENTS files, SHA256
`c44619c70a0bc26373734acd77a5ead232cf4e8f28b3fd407171d0223a15a794`.
`trainer.before.py` preserves the actual current Main baseline, distinct from HEAD.
The focused test produces 15 genuine failures on that baseline and 15 passes after
the reorder. Fourteen cases cover CPU/CUDA paths with corrupt streams, incompatible
validation metadata, wrong tokenizer hashes, rejected manifests, mismatched stream
bindings and invalid/missing freeze source locks. They require CLI rejection and
no device/DDP/model/optimizer setup or output directory. The positive smoke case
checks that both streams and tokenizer were checked before resource setup.
Manifest/freeze rejection injections model errors from the existing validators;
the broader validator suites test their actual metadata contracts separately.

Affected Python gates: 243 passed in 56.23 seconds, including model tests,
actual CPU training/checkpoint/resume, two-process Gloo continuity, dataset
manifest and tokenizer-freeze tests. Syntax checks passed for trainer/model/state
and the new test. Current Main Ilaria Go tests passed in all 12 test-bearing
packages; `go vet ./...` passed. Worktree and new-file whitespace checks pass.
The foreground test sessions returned normally; no GPU, real corpus/pilot,
existing model checkpoint, cloud allocation, credentials or Bridge was used.

STOP: only the three claims above are released for independent review and strict
integration against current Main pins. Source/evidence hashes are recorded in the
external handoff receipt to avoid a circular self-hash. Main/index/history unchanged.
