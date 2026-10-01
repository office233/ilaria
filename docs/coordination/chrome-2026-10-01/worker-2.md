# Worker 2 — SwypikOS authenticated continuation persistence and safe resume

State: COMPLETE

## Workspace / branch / boundaries

- MCP access was verified for `E:\nexus`.
- Branch observed at start and preserved: `codex/nexus-supervisor-v3`.
- Existing modified/untracked work was preserved. No branch switch, reset/clean, stage/commit, push, deploy or publication was performed.
- Read before edits: root `AGENTS.md`, `swypik-os/AGENTS.md`, `docs/milestones/supervisor-v2.md`, coordination README, and active worker reports.
- SwypikOS remains the only OS-authority layer. No Swyp internal package is imported; no Control Kernel/process-group/cache/energy/other-product file was modified.
- Worker 1 and Worker 3 are now `COMPLETE`; their final public contracts were re-read before final integration.

## Exact claimed files

Worker 2 claimed these paths while RUNNING:

- `swypik-os/core/supervisor/continuation.go` (new)
- `swypik-os/core/supervisor/continuation_test.go` (new)
- `swypik-os/core/supervisor/ledger.go`
- `swypik-os/core/supervisor/model.go`
- `swypik-os/core/supervisor/policy.go`
- `swypik-os/core/supervisor/recovery.go`
- `swypik-os/core/supervisor/recovery_test.go` (claimed, read/tested, not modified by Worker 2)
- `swypik-os/core/supervisor/supervisor.go`
- `swypik-os/core/supervisor/supervisor_test.go` (claimed, read/tested, not modified by Worker 2)
- `swypik-os/cmd/plan-supervisor/config.go`
- `swypik-os/cmd/plan-supervisor/engine.go`
- `swypik-os/cmd/plan-supervisor/engine_test.go`
- `swypik-os/cmd/plan-supervisor/main.go` (claimed, read/tested, not modified by Worker 2)
- `swypik-os/cmd/plan-supervisor/wire.go`
- `docs/coordination/chrome-2026-10-01/worker-2.md`

## Final Worker 1 protocol consumed

Worker 2 now mirrors the final authority-free Swyp continuation v1 checkpoint exactly:

`protocol_version`, `type`, `state_version`, `run_id`, `module_hash`, `entry`,
`fuel_limit`, `steps_used`, `max_effect_bytes`, `effect_bytes`,
`effect_cursor`, `effect_request_hash`, `effect_result_hash`, `state_hash`, `state`.

- `type="continuation"`, protocol/state version 1.
- Cursor is post-effect: it is the count/sequence already resolved; the next provider effect must be cursor + 1.
- Request/result hashes bind the exact validated exchange that produced the checkpoint.
- Worker 2 locally mirrors only this public wire shape and public `BindingBytes/EnvelopeHash` domain contract; no `swyp/internal/*` import exists.
- ACK shape emitted by the host is the final public v1 shape: `continuation_ack` with exact run/module/entry/cursor/state identity and accepted/rejected status.

A cross-product public vector was generated directly by `swyp-lang/protocol/continuation.EnvelopeHash` and is pinned in Worker 2 tests:
- state hash: `b165836b8f85f1bb45ce98f258ccdeceda792770c482b6396d1ba3f84f6dbb59`
- envelope hash: `97d41556bc3d9db077970070d027a804468c16944f1be7790bac542d39ffe9a6`

## Delivered Supervisor API / storage contract

New public OS-side surface:

- `ContinuationPolicy`: explicit host authority; zero value disables persistence.
- `ContinuationEnvelope`: exact public Swyp v1 checkpoint mirror.
- `ContinuationBinding`: trusted host metadata bound to the checkpoint.
- `ResumeState`: validated binding + in-memory plaintext checkpoint; plaintext is never JSON-serialized.
- `DecodeContinuationEnvelope(raw, maxBytes)`: strict host-side public-wire validation.
- `(*Supervisor).StoreContinuation(ctx, raw)`: validates the exact post-effect checkpoint, durable verified result identity and current execution epoch, seals it, then appends only non-sensitive metadata/hash references to the ledger.
- `(*Supervisor).BeginResume(ctx)`: revalidates ledger + CK + verifier evidence + sealed record + budgets/identity before allowing a reopened Supervisor to admit the next effect.
- `(*Supervisor).ForgetResumeAuthorization()`: drops only in-memory resume authorization when Swyp rejects/transport fails before a new unresolved effect.
- Recovery outcome `authenticated_continuation_available` leaves the durable plan RUNNING so an integrator can launch exact resume. Invalid/missing continuation never causes blind replay.

Authenticated host binding includes:

- task ID, run ID, module hash, entry, plan hash and host execution-policy hash;
- original max effects/read bytes, original Swyp fuel/effect-byte budgets, and exact deadline;
- exact committed effect cursor;
- node, attempt, lease and fence;
- request hash, result hash, independent verifier evidence/receipt hash and intent ID;
- raw-checkpoint SHA-256, public Swyp envelope hash and state hash.

## Cryptographic / sensitive-data policy

- v3 host configuration requires an explicit `continuation` policy. Mode is either `disabled` or `aes-256-gcm`.
- No production/default key exists. Enabled persistence requires an explicit absolute host key-file path, key ID, data directory and envelope bound.
- Key file must be a regular non-symlink file containing exactly 32 raw bytes. On Unix group/other permission bits are rejected. On Windows this implementation does not claim independent ACL/keystore verification; the operator-supplied key-file ACL remains part of host policy.
- The key is loaded only into process memory, never put in ledger/report/log output, and copies held by Engine/Supervisor are zeroed on close.
- The supervisor plan hash commits to continuation mode/data path/key ID/key fingerprint/max bound, so silent key/policy rotation without a migration is rejected as `ErrPolicyChanged`.
- Checkpoint plaintext (including guest locals/payload arena) is AES-256-GCM sealed with a fresh random nonce. AAD contains the complete trusted `ContinuationBinding`.
- Sidecar records are immutable create-only files. Ledger event `continuation.sealed` contains only hashes/IDs/epoch/evidence metadata, never checkpoint state or raw key.
- A sidecar is accepted only if its exact record hash is the ledger-referenced hash for the *latest* committed cursor. Older checkpoints are never fallback candidates, preventing rollback/replay to an earlier cursor.
- Missing/tampered records, changed key/policy/module/run/budgets/result hashes, stale epoch/fence or missing verified durable evidence fail closed.

## No-replay / v2 fallback invariants

- With continuation enabled, after any committed effect, `Handle` refuses the next effect and `Finish` refuses terminal completion until the matching authenticated continuation is durable.
- If execution fails after an effect but before its checkpoint becomes durable, `Abort` records `UNCERTAIN`, preserving v2 no-blind-reexecution semantics.
- `Recover` only advertises exact resume when the latest cursor has an authenticated continuation whose durable effect/result/evidence identity still matches CK.
- An unresolved v2 effect is still reconciled only from matching durable independent evidence and then stops `UNCERTAIN`; it is never converted into a synthesized continuation.
- If no continuation exists, v2 `no_serialized_continuation` behavior remains.
- Windows Job Object / Linux cgroup v2 containment and the independent verifier are unchanged and remain mandatory.

## CLI/service integration delivered

Normal v3 execution:

1. starts `swyp core-broker --continuations ...`;
2. executes/verifies/commits an effect through existing Supervisor v2 authority;
3. receives a Swyp checkpoint;
4. strictly validates and authenticated-encrypts it;
5. durably appends its hash/epoch binding to the ledger;
6. sends `continuation_ack: accepted` only after persistence succeeds;
7. only then can the broker emit/execute the next instruction/effect.

On persistence rejection the CLI attempts a correlated `rejected` ACK and fails closed.

Resume seam for Worker 5:

`engine.resumeWithSnapshot(ctx, configuredPlan, snapshotPath, supervisor, metrics)`

- calls `BeginResume`;
- rechecks run/entry/original Swyp budgets;
- recomputes SHA-256 of the supplied canonical IR snapshot and requires the exact continuation module hash **before launching a child**;
- starts `swyp core-broker --resume ...` with no typed entry arguments;
- sends the validated checkpoint as the first stdin frame;
- reuses the same checkpoint/ACK barrier for every subsequent effect.

Worker 3's cache is intentionally not imported here. Worker 5 should obtain the freshly verified immutable cache snapshot and materialize/pass that exact canonical IR snapshot to `resumeWithSnapshot`; this preserves ownership and keeps cache trust verification outside Supervisor internals.

## Explicit current transport limitation

Swyp continuation v1 permits a 9 MiB checkpoint, but current `internal/planprocess` JSONL transport caps a line at 2 MiB. Worker 2 did not edit process-group/transport ownership.

Therefore `plan-supervisor` v3 rejects host policies whose `max_envelope_bytes` exceeds `planprocess.MaxLineBytes` (2 MiB). A Swyp checkpoint that grows beyond the transport line bound fails closed and cannot be claimed resumable. Core Supervisor persistence itself supports the public 9 MiB protocol maximum. End-to-end 9 MiB support is **not** claimed until the process transport is deliberately widened and reverified.

## Verification evidence

Commands/results observed on this workstation:

1. Focused implementation gate, final:
   - `go test -count=1 ./core/supervisor ./cmd/plan-supervisor`
   - PASS: `core/supervisor` and `cmd/plan-supervisor`.

2. Cross-product public hash vector:
   - temporary standalone Go program executed from `E:\nexus\swyp` using only `swyp-lang/protocol/continuation`;
   - PASS, emitted the state/envelope hashes pinned above; temp source was deleted immediately.

3. Full SwypikOS vet:
   - `go vet ./...`
   - PASS, exit 0.

4. Full SwypikOS test gate:
   - `go test -count=1 -timeout 180s ./...`
   - PASS: **51 packages OK, 0 failed**.
   - Includes `core/supervisor`, `cmd/plan-supervisor`, `core/resource`, `internal/plancache`, `internal/planprocess` and generated continuation/effect packages.

5. Bridge `check_files` over all Worker 2 changed Go files:
   - PASS, no gofmt/go-vet problems.

6. LSP diagnostics:
   - unavailable because `gopls` is not installed.
   - No toolchain/connector installation was performed.

7. Root whitespace gate:
   - `git diff --check`
   - PASS, exit 0.
   - Git emitted only pre-existing CRLF→LF warnings for `swypik-os/README.md`, `swypik-os/docs/UNIVERSAL_NATIVE.md`, and `swypik-os/docs/WINDOWS_DESKTOP.md`; no whitespace error.

Tests specifically cover:

- crash/suspend after a durable checkpoint and exact resume;
- restart/suspend/restart with the same checkpoint;
- zero replay of the resolved provider effect;
- barrier preventing next effect or terminal completion before checkpoint durability;
- tampered sealed record;
- rollback attempt replacing latest record with an older record;
- module and run mismatch;
- fuel/effect-byte budget extension;
- request/result hash mismatch;
- continuation key/policy change;
- stale/tampered fence binding;
- missing sealed record;
- plaintext/key absence from ledger and sealed record;
- altered IR snapshot rejected before child launch;
- final Swyp public envelope-hash parity;
- existing v2 crash matrix for no result, unverified result, verified-but-no-continuation and terminal recovery, with no provider/verifier replay.

## Files actually changed by Worker 2

- `swypik-os/core/supervisor/continuation.go` (new)
- `swypik-os/core/supervisor/continuation_test.go` (new)
- `swypik-os/core/supervisor/ledger.go`
- `swypik-os/core/supervisor/model.go`
- `swypik-os/core/supervisor/policy.go`
- `swypik-os/core/supervisor/recovery.go`
- `swypik-os/core/supervisor/supervisor.go`
- `swypik-os/cmd/plan-supervisor/config.go`
- `swypik-os/cmd/plan-supervisor/engine.go`
- `swypik-os/cmd/plan-supervisor/engine_test.go`
- `swypik-os/cmd/plan-supervisor/wire.go`
- `docs/coordination/chrome-2026-10-01/worker-2.md`

## Handoff to Worker 5

Worker 5 may take over all Worker 2 claimed files after this report changes to `State: COMPLETE`.

Integration order:

1. use Worker 3 cache identity/verifier to obtain the exact immutable canonical IR snapshot;
2. call Supervisor `Recover`;
3. only when outcome is `authenticated_continuation_available`, materialize/pass the freshly verified snapshot to `resumeWithSnapshot`;
4. treat `RecoveryContinuationRejected`, `UNCERTAIN`, cache miss/corruption/trust failure, policy drift or transport-size failure as non-resumable; never compile current source as a recovery substitute;
5. keep Job/cgroup containment and persistent independent verifier enabled for the resumed broker;
6. black-box test real Swyp `--continuations` / `--resume` plus cache invalidation/tamper matrix before claiming v3 end-to-end completion.

No Control Kernel change is required by Worker 2's implementation.
