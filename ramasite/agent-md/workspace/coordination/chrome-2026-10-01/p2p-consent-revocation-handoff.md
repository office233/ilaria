# Synthetic canonical IMC consent-revocation runner

Source STOP: seven claims in branch `codex/imc-consent-revocation`, worktree
`C:\Users\abel\.codex\worktrees\imc-consent-revocation\nexus`.
Root owns selective Main integration and one separately approved actual run.
The source owner has not run this model/TCP operation. Ordinary tests below
are not an actual cancellation receipt.

## Exact claims and baseline

- NEW `scripts/verify-imc-consent-revocation.py`
- NEW `scripts/test_verify_imc_consent_revocation.py`
- NEW this handoff
- `ilaria/runtime/isxprobe/peer.py`
- NEW `ilaria/runtime/isxprobe/test_synthetic_phase_probe.py`
- `swypik-os/core/imcnetwork/adapter.go`
- NEW `swypik-os/core/imcnetwork/synthetic_phase_probe_test.go`

Original Main adapter SHA256:
`b09170b0385c0d6c2881728a2d939d4ae5e2809a5df909ba2d822528f46da4d8`.
Original Main peer SHA256:
`0b61c932b0502e017303d9243f47c8c179d106493a061c86b1d90fb378d1067c`.
The canonical IMC architecture stays unchanged:
`650f4cad06d80760a03fa4396bb2cce27364bd596b8002f39ec02d595205274c`.

The new worktree contains an explicit 114-file public dependency/test snapshot,
listed in external `public-baseline.json`, rather than a Main overlay. Its hash
is `79ed63a660becfe00cd3767f5411d0aba3f960b7675083a137433eae0ecf64b6`.
Final seven-claim hashes and readback checks are in external `receipt.json`.
The prior consent implementation and old network runner/test claims remain
unchanged on Main; no stage, commit, push or deployment was performed.

## Disabled-by-default diagnostic

Node config optionally accepts `synthetic_phase_probe=true` and
`synthetic_phase_hold_ms=0..1000`. A hold without opt-in is invalid. Admission
requires a fresh proposer role, resume=false, existing strict synthetic consent,
absolute own state without symlink/alias ancestors, and an absent marker. It
runs before worker/socket allocation. No arbitrary destination is accepted.

The adapter replaces any remotely supplied diagnostic field with its own
configuration and attaches the fixed path `state/synthetic-phase.json` only to
the first fresh proposal. The worker validates the exact own working-directory
path, synthetic purpose/scope, proposer identity, first round, consent epoch,
signed deadline and hold bound before model allocation.

After a genuine first `loss.backward`, gradient clip and `optimizer.step`, the
worker writes one canonical ASCII record of at most 4096 bytes. The record has
version=1, phase=`after-first-optimizer-step`, step=1, worker PID, monotonic/UTC
times, hold bound, current parent, issued-job hash and public signed-job plus
issuer signature. It contains no tensors, corpus/conversation text, private
keys or user profiles. A temporary file plus non-replacing hard link publishes
the complete record atomically; existing files or symlinks cannot be replaced.
The optional hold stops at the signed job deadline and never exceeds 1000 ms.
The architecture and signed training recipe do not change. Default-off and
zero-hold enabled output/actual delta parity are tested.

## One root-owned actual operation

After integration, invoke the new runner with exact reviewed adapter/peer hashes,
`--checkout E:\nexus`, explicit existing Python and public cryptography library
paths, a fresh external evidence parent, an absolute UTC deadline no later than
115 seconds after launch, and `--enable-synthetic-training`. No overlay, runtime
source mutation or automatic retry is used. Root chooses the concrete command.

The runner reserves 10 seconds for cleanup within the same absolute UTC and
monotonic 115-second budget, including public closure discovery, build and setup.
It pins selected platform Go files in the real CLI dependency graph, go.mod/sum,
the frozen helper and canonical Python closure before compilation and after
cleanup. It refuses drift and a changed canonical model.

Each launched command starts suspended and enters an anonymous owned Windows
Job before resume. Outer limits are 25% CPU, 2 GiB and 16 accounted processes;
the production worker retains its nested OS Job limits of 25%, 1 GiB and one
worker. The public node config limits each peer to 4 MiB traffic and 256 KiB
frames, 64 training steps, 50 ms consent checks, and a 1000 ms diagnostic hold.
Logs are capped at 64 KiB each, phase metadata at 4 KiB and individual scalar
metadata at 16 KiB. These are configured bounds, not measured energy claims.

Only `QueryInformationJobObject` discovers identities. The runner retains
creation-time process handles and queries only those owned identities; it does
not enumerate unrelated processes or read command lines/memory/profiles.
Console auxiliary members can appear in a Job list. The expected public Python
executable name selects the worker, and the genuine record must name that exact
owned PID. Every discovered member remains covered by stop/readback checks.

Before revocation, require both fresh round-1/nonce durable reservations, initial
issuer progress/active at sequence0/genesis, no proposer progress, and increased
owned worker CPU across two observations spanning the genuine post-step marker.
Verify canonical signed-job hash/signature, issuer/proposer/evaluator pins,
session/genesis/parent/lineage, scope/purpose/epoch, recipe/config/fixture and exact
nonce reservation. CPU activity alone or missing/stale phase evidence is UNPROVED.

Atomically replace only the fresh proposer's own consent with opt_in=false.
Require the distinct `participation consent canceled: participation/data consent
revoked` cause, natural node/worker shutdown within 10 seconds, and worker exit
before the diagnostic hold ends. Forced outer cleanup cannot turn failure into
success. Final scalar active/progress/history/committed-version metadata and work
reservations must match the pre-revocation snapshot. Pending publication causes
UNPROVED; no journal outcome is inferred and no checkpoint payload is read.
Stop all owned Jobs, join drains, check retained identities are exited and source
pins unchanged, then save one immutable-purpose receipt. No second trial follows
automatically after a failure or UNPROVED observation.

## Ordinary gates and discriminating regressions

External evidence root:
`E:\nexus-training\evidence\p2p-consent-revocation-20261002\owner-gates`.

- Full affected worktree OS `go test -count=1 -timeout 180s ./...`: PASS,
  48 passing packages and 7 without tests, 49.816 seconds. `go vet ./...`: PASS,
  4.919 seconds. Existing consent, authority, rollback/replay tests stay intact.
- Current Main canonical architecture tests, isolated with current trainer
  imports: 195 PASS, 47.36 seconds. Peer/new phase/new runner/frozen helper tests:
  136 PASS, 5.87 seconds. This includes 19 phase and 39 new runner cases.
- Read-only Main Ilaria Go tests: 12 passing packages and 4 without tests,
  3.034 seconds; vet PASS, 0.772 seconds. Canonical-three/new Python compile PASS.
- Real owned non-model Windows root/descendant tests observe CPU increase and
  stop the complete owned tree while the test callback is still active. They
  join their bounded output drain and preserve exact retained identities.
- External-only premature-marker mutation is RED for both failed backward and
  failed optimizer completion. External-only removed issuer authentication is
  RED for the forged signature test. Shared source and actual runs use no overlay.
- The historical first combined Python run had seven import-contamination
  failures: current Main tests imported the old worktree trainer after peer
  collection changed sys.path. That log is preserved; isolated canonical and
  peer invocations above resolved the test setup without product changes.
- Final standard/no-index whitespace checks, baseline readbacks and all claim
  hashes are in the final receipt. No-index exit1 with empty diagnostics denotes
  new content, not a whitespace error.

## Limits and remaining milestone

This prepares a proof of cancellation during an ongoing canonical synthetic CPU
training task after one real update, with an explicit observation hold. It does
not prove interruption inside a hung CUDA/C instruction, hard real-time latency,
internet/two-machine behavior, production-data training, energy savings or power
loss durability. The record is trusted local diagnostic metadata from the pinned
worker; its public job authorization is independently authenticated. It is not
new model/promotion authority. The broader objective remains active, and paid
work, corpus/private files, ignored weights, G4/Brev/OpenCode and Bridge are outside
this operation. Source STOP does not claim the root-owned actual milestone passed.
