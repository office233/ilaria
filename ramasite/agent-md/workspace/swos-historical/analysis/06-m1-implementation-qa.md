# SWOS M1 — Independent QA Implementation Audit

**Date:** 2026-09-28  
**Role:** Independent principal verifier  
**Baseline/current main:** `E:\nexus` @ `f0b244a1fc3e4325a6f3f2bdd3235d52ac4bb319` (`main`)  
**Candidate base:** `cc688dd`  
**Source policy:** read-only. No source repair, commit, push or deploy was performed.

## Executive verdict

| Candidate | Verdict | Integration to current main |
|---|---|---|
| A — Control Kernel foundation | **REJECTED** | **BLOCKS integration**. Durable journal mechanics are strong, but verifier binding, crash recovery and DAG mutation invariants are not safe enough to become the authority plane. |
| B — P0 secret/process hardening | **VERIFIED** | No blocker found. Current implementation satisfies the audited Windows environment/handle/job-object scope and explicitly does not claim a full sandbox. |
| C — Swyp Effect/Capability ABI | **VERIFIED** | No blocker found for this M1 ABI slice. Effect metadata is declarative only; Core refuses host execution and verification does not claim effect execution/proof. |

The three candidates are not all merge-ready because Candidate A has multiple authority/recovery defects that remain reachable through its public API even though its authored tests, race run, vet and full suite all pass.

---

# 1. Test and repository evidence

## Repository state observed before/after QA

### A — `E:\CEO\wt\swos-control-kernel-m1`
Branch `chatgpt/swos/control-kernel-m1`, HEAD/base `cc688dd`.

Observed candidate files:
- `?? swypik-os/core/controlkernel/`
- `?? swypik-os/docs/ADR_CONTROL_KERNEL_EVENT_STORE.md`

No QA source modification was introduced.

### B — `E:\CEO\wt\swos-security-p0`
Branch `chatgpt/swos/security-p0`, HEAD/base `cc688dd`.

Observed candidate changes:
- `M swypik-os/core/agent/workspace_tools.go`
- `M swypik-os/core/coder/shell_windows.go`
- `M swypik-os/core/coder/shell_windows_test.go`
- `M swypik-os/docs/COMMAND_LIFECYCLE.md`
- `?? swypik-os/core/agent/process_run_windows_test.go`

No QA source modification was introduced.

### C — `E:\CEO\wt\swos-swyp-effects-m1`
Branch `chatgpt/swos/swyp-effects-m1`, HEAD/base `cc688dd`.

Observed candidate changes:
- `M swyp/docs/ARCHITECTURE.md`
- `M swyp/docs/SEMANTIC_CORE.md`
- `M swyp/internal/coreir/contract.go`
- `M swyp/internal/coreir/execute.go`
- `M swyp/internal/coreir/ir.go`
- `M swyp/internal/coreir/verify.go`
- `?? swyp/docs/EFFECTS_CAPABILITIES.md`
- `?? swyp/internal/coreir/effects.go`
- `?? swyp/internal/coreir/effects_test.go`

No QA source modification was introduced.

## Independent commands

### Candidate A
From `E:\CEO\wt\swos-control-kernel-m1\swypik-os`:

- `go test -count=1 -race ./core/controlkernel` → **PASS**, 1 package, race detector clean.
- `go vet ./...` → **PASS**.
- `go test -count=1 -timeout 180s ./...` → **PASS**, 43 tested packages reported `ok`, no failed package.
- `git diff --check` at worktree root → **PASS**.
- Read-only `gofmt -d` over `core/controlkernel/*.go` → no diff.

Important: `git diff --check` does not include untracked files; the untracked A Go files were therefore additionally inspected by `gofmt -d`.

### Candidate B
From `E:\CEO\wt\swos-security-p0\swypik-os`:

- `go test -count=1 ./core/coder ./core/agent -run 'TestShellScrubsParentEnvironment|TestProcessRunDoesNotExposeParentSecrets'` → **PASS**, both packages.
- `go vet ./...` → **PASS**.
- `go test -count=1 -timeout 180s ./...`:
  - first background-job wrapper returned exit 1 while its full captured log contained only 38 `ok` package lines and no failure text;
  - immediate direct rerun of the exact command → **PASS**, exit 0, all 43 package/test targets completed, no failures.
  - This is treated as a transient runner/harness anomaly, not a source failure.
- `git diff --check` → **PASS**.
- Read-only `gofmt -d` over changed/new Go files → no diff.

### Candidate C
From `E:\CEO\wt\swos-swyp-effects-m1\swyp`:

- `go test -count=1 ./internal/coreir -run 'Effect|Capability'` → **PASS**.
- `go vet ./...` → **PASS**.
- `go test -count=1 -timeout 180s ./...` → **PASS**, 7 packages `ok`, one package with no test files, no failures.
- `git diff --check` → **PASS**.
- Read-only `gofmt -d` over changed/new Core IR Go files → no diff.

## Drift against current main

Current main was verified as `E:\nexus` branch `main` @ `f0b244a1fc3e4325a6f3f2bdd3235d52ac4bb319`.

For every path modified/added by A, B and C, both:
- `git diff --stat cc688dd..f0b244a -- <candidate paths>`
- `git log cc688dd..f0b244a -- <candidate paths>`

returned no path-level changes.

Therefore there is **no observed textual drift on the candidate-owned paths between their base and current main**. No rebase/merge was performed because this QA run is read-only. Candidate A is nevertheless integration-blocked on semantics, not on textual conflict.

---

# 2. Candidate A — Control Kernel foundation

## Verdict: REJECTED

### What is verified

The storage layer is materially stronger than the prior baseline:

- expected-sequence CAS is serialized in-process and a cooperating-process lock is held for the event store lifetime;
- append frames contain redundant length metadata and a SHA-256 body checksum;
- replay validates stream sequence, journal sequence, `PrevHash` and event hash;
- complete-frame corruption fails closed;
- only a physically incomplete final frame is truncated and the truncation is synced;
- append writes and `fsync` complete before the in-memory projection advances;
- authored tests cover concurrent CAS, torn tail, middle body corruption, corrupted length header and hash-chain replay;
- lease IDs/fences and stale worker mutation checks are implemented;
- idempotency keys survive restart;
- a started effect can move through UNCERTAIN/RECONCILING rather than being blindly replayed.

Those are real improvements. They are not sufficient for acceptance because the following state-machine/authority defects remain.

## A-1 — CRITICAL — Passing verification is not bound to the current attempt/lease fence and verifier identity is self-asserted

**Files/lines**
- `swypik-os/core/controlkernel/kernel.go:282-283` — COMMITTING gate asks only whether the node has any passing verification.
- `swypik-os/core/controlkernel/kernel.go:723-761` — `RecordVerification` accepts caller-supplied `VerifierID`; `AttemptID` is not validated or required; evidence hash is not required.
- `swypik-os/core/controlkernel/kernel.go:739-740` — “independence” is only the string comparison `lease.Owner == verification.VerifierID`.
- `swypik-os/core/controlkernel/kernel.go:764-770` — `hasPassedVerificationLocked` accepts any historical PASS for the node, regardless of attempt, lease or fence.

**Reproduction**
1. Create/ready a node and claim lease/fence 1 as `worker-a`.
2. Advance to VERIFYING.
3. Call `RecordVerification` with `VerifierID="verifier-x"`, PASS.
4. Let lease 1 expire; `RequeueExpiredLease` from VERIFYING sends the node through RETRY_WAIT to READY.
5. Claim lease/fence 2, advance the retry to VERIFYING.
6. Do **not** record a verification for attempt/fence 2.
7. Call `TransitionNode(node, COMMITTING, tokenFence2)`.
8. The transition is accepted because the PASS from the earlier execution epoch is found by node ID alone.

A worker/executor process can also submit a PASS itself by choosing any `VerifierID` string different from its lease-owner string; the API has no authenticated verifier principal or authority boundary.

**Why it matters**
A verification result for one execution epoch can authorize a different retry. The stated independent verifier gate is therefore not an enforcement boundary.

**Minimal repair**
- Bind every verification to a concrete `AttemptID`, lease ID and fence.
- Validate that the attempt exists and belongs to the current node/current execution epoch.
- Make the commit gate require a PASS for the current attempt/fence only.
- Do not accept verifier identity as payload data. Supply an authenticated verifier principal/authority from the caller context or a dedicated low-authority verifier interface/process.
- Require immutable evidence references/hash for PASS if PASS is security-authoritative.

**Integration blocker:** **YES**.

## A-2 — CRITICAL — Lease-expiry recovery is not total; COMMITTING and old-fence PREPARED/RESULT intents can become permanently stuck

**Files/lines**
- `swypik-os/core/controlkernel/kernel.go:395-434` — `RequeueExpiredLease` handles LEASED/PREPARING/VERIFYING and EXECUTING, but rejects every other state, including COMMITTING.
- `swypik-os/core/controlkernel/kernel.go:247-253,277-280` — transitions out of COMMITTING require a live matching lease.
- `swypik-os/core/controlkernel/kernel.go:441-469` — same idempotency key/operation returns the existing intent unchanged.
- `swypik-os/core/controlkernel/kernel.go:523-543` — `StartIntent` requires the intent lease/fence to equal the current token.
- `swypik-os/core/controlkernel/kernel.go:587-609` — RESULT commit also requires the original intent lease/fence.
- `swypik-os/core/controlkernel/kernel.go:615-631` — recovery authority exists only for STARTED intents.

**Reproduction A — COMMITTING crash**
1. Run a node through verification to COMMITTING with a valid lease.
2. Crash/stop the worker before `NodeSucceeded`.
3. Let the lease expire.
4. `RequeueExpiredLease(node)` returns conflict because COMMITTING is not handled.
5. A normal worker cannot transition because the lease is expired; a new lease cannot be claimed because the node is not READY.
6. The node has no recovery path.

**Reproduction B — PREPARED intent before execution**
1. Claim lease 1, enter PREPARING, persist a PREPARED intent with idempotency key K.
2. Lease 1 expires before `StartIntent`; recovery requeues node to READY.
3. Claim lease 2 and re-enter PREPARING.
4. `PrepareIntent` with the same logical operation/K returns the old PREPARED record still bound to lease/fence 1.
5. After entering EXECUTING, `StartIntent(oldIntent, tokenFence2)` returns `ErrStaleLease`.
6. There is no PREPARED abandon/rebind/reconcile transition, so the durable idempotency record blocks progress.

**Reproduction C — RESULT before commit**
A RESULT associated with an expired old fence similarly cannot be directly committed by the new lease, while `RecoverStartedIntent` does not accept RESULT. The authored stale-fence test correctly proves rejection but does not establish a liveness/recovery path.

**Why it matters**
The kernel can preserve safety by refusing stale work but still violate the required crash/restart liveness invariant. A durable control kernel must define recovery for every crash window it makes durable.

**Minimal repair**
Define an explicit recovery table for every node phase and intent phase:
- COMMITTING expiry must enter a durable recovery/reconciliation state and decide from committed intent/evidence whether to finalize or require operator action.
- PREPARED under a dead fence needs a safe abandon/rebind/new-attempt rule.
- RESULT under a dead fence needs control-plane reconciliation/finalization, never a blind external replay.
Add fault-injection tests for crash after PREPARED, STARTED, RESULT, verification, intent commit and before/after node success.

**Integration blocker:** **YES**.

## A-3 — HIGH — An unresolved external effect can be terminalized, after which reconciliation is impossible

**Files/lines**
- `swypik-os/core/controlkernel/state.go:80-92` — FAILED/CANCELLED/BLOCKED are allowed from every non-terminal state.
- `swypik-os/core/controlkernel/kernel.go:285-289` — ambiguous intents are blocked only for EXECUTING→VERIFYING/RETRY_WAIT; terminal exits are not blocked.
- `swypik-os/core/controlkernel/kernel.go:634-647` — intent reconciliation requires the node to be RECONCILING.
- Terminal nodes cannot transition again by `CanTransition`.

**Reproduction**
1. Prepare and START an external-effect intent while node is EXECUTING.
2. With the live worker lease, call `TransitionNode(node, FAILED, token)` or CANCELLED/BLOCKED.
3. The terminal transition is accepted while the intent is still STARTED.
4. After lease loss, `RecoverStartedIntent` may mark the intent UNCERTAIN, but the node can no longer become RECONCILING because it is terminal.
5. `BeginReconciliation` therefore cannot proceed.

**Why it matters**
A terminal node can retain unresolved external reality. This breaks the invariant “uncertain effects are reconciled, never abandoned/blind-retried.”

**Minimal repair**
Terminalization must be state/intent-aware. If any side-effect intent is STARTED/UNCERTAIN/RECONCILING, force the node through UNCERTAIN→RECONCILING and only allow FAILED/CANCELLED/BLOCKED/OPERATOR_REQUIRED after the external outcome has been resolved or explicitly escalated.

**Integration blocker:** **YES**.

## A-4 — HIGH — DAG topology can be changed after scheduling has started, creating retroactive unsatisfied dependencies

**Files/lines**
- `swypik-os/core/controlkernel/kernel.go:172-209` — `AddEdge` checks endpoints/task/cycle but does not require a frozen graph or PENDING topology.
- `swypik-os/core/controlkernel/kernel.go:238-245` — dependency state is queried from the current graph.
- `swypik-os/core/controlkernel/kernel.go:311-312` — dependencies are enforced at lease claim time only.

**Reproduction**
1. Create nodes A and B in one task.
2. Move B to READY and claim B’s lease; B is now LEASED.
3. While A is still unsucceeded, call `AddEdge(A -> B)`.
4. The edge is accepted because it is acyclic and same-task.
5. B continues under an already-issued lease even though the graph now says A must succeed before B is runnable.

**Why it matters**
Dependency semantics are time-of-check dependent. A durable DAG needs either immutable topology once scheduling begins or a version/fence that invalidates leases when topology changes.

**Minimal repair**
Freeze task topology before any node becomes READY/leased, or version the graph and bind scheduling leases to that graph version. Replay must enforce the same invariant.

**Integration blocker:** **YES**.

## A-5 — MEDIUM — Attempt number uniqueness/status validity is not enforced

**Files/lines**
- `swypik-os/core/controlkernel/kernel.go:672-720`.
- In particular, lines 695-703 auto-allocate a number only when `Number <= 0`; caller-supplied positive duplicate numbers are accepted.
- Replay validates attempt ID/node/task/lease/fence but not a unique `(node, attempt number)` invariant.

**Reproduction**
Under one live lease, call `RecordAttempt` twice with distinct attempt IDs and the same positive `Number`. Both can be persisted.

**Minimal repair**
Enforce a durable unique attempt epoch per node (preferably derive it from the lease/fence rather than accept it as caller-authoritative), validate allowed AttemptStatus values and bind verification/result records to that attempt.

**Integration blocker:** not independently blocking, but should be fixed with A-1.

### A conclusion

The journal/frame/CAS mechanics are **verified**, but the control-kernel authority semantics are **rejected**. The important distinction is that “fails stale commits” is not equivalent to “recovers safely and makes forward progress after every crash window.”

---

# 3. Candidate B — P0 secret/process hardening

## Verdict: VERIFIED

### Source findings

**Windows Unicode environment block**
- `swypik-os/core/coder/shell_windows.go:64-90` builds a new environment block rather than copying `os.Environ`.
- Every entry is encoded through `UTF16FromString`, which includes its NUL terminator, and one additional NUL is appended for the required double-NUL block terminator.
- `CreateProcess` uses `CREATE_UNICODE_ENVIRONMENT` at line 191.

**PATH/SystemRoot/ComSpec viability**
- `SystemRoot` is required at lines 135-139 and is used to resolve the canonical `System32\cmd.exe`.
- `PATH` is in the explicit allowlist.
- `ComSpec` is injected explicitly as the resolved shell at lines 64-67.
- `PATHEXT`, standard program directories, temp directories and user config/cache locations needed by common Windows tooling are preserved.

**Secret inheritance**
- The child environment is name-allowlisted; unknown/token-like parent variables are not copied.
- Focused tests prove `ILARIA_API_TOKEN`, `SWYPIK_SENTINEL_SECRET` and an unknown parent variable do not reach the child.
- The integrated `process.run` route independently tests the sentinel/API-token case.

**Handle/process lifecycle**
- A PROC_THREAD_ATTRIBUTE_HANDLE_LIST restricts inheritance to command stdin/stdout.
- The shell is created suspended, assigned to a KILL_ON_JOB_CLOSE job, then resumed.
- Both cancellation and normal shell completion close the job so ordinary descendants do not remain alive.
- Tests cover unrelated inheritable handle rejection, cancellation, normal parent exit, concurrent output isolation, quoting/working directory and nonzero exit code.

**Claims/docs**
- `docs/COMMAND_LIFECYCLE.md:29-37` explicitly says this is secret/process hardening, **not** AppContainer/restricted-token/full sandbox.
- It correctly states the child still has the user account’s filesystem/registry/network permissions and identifies service-launched process escape as a remaining limitation.
- `process.run` description says the same.

### Residual compatibility note

The allowlist intentionally drops arbitrary environment customization (`JAVA_HOME`, proxies, SDK-specific variables, custom compiler variables, etc.). That can change behavior for workloads that relied on ambient configuration, but it is the explicit security policy of this patch, not a hidden propagation bug. Current repository tests and the focused real-child path pass. Any future addition to the allowlist must be reviewed as an authority/secret-surface change.

### B integration conclusion

No source-level blocker found. The affected paths did not change between `cc688dd` and current main `f0b244a`. **VERIFIED for integration**, subject to the normal merge/test run on the integrated tree.

---

# 4. Candidate C — Swyp Effect/Capability ABI

## Verdict: VERIFIED

### Source findings

**Strict JSON / no guest authority field**
- `internal/coreir/ir.go:62-129` performs a token scan that rejects nulls, duplicate object keys (including casing aliases), excessive nesting and trailing JSON, then decodes with `DisallowUnknownFields`.
- `CapabilityRequirement` contains only a logical `Name` and declared `Effect`; there is no token/ref/value authority field.
- Tests inject both a top-level `capability_refs` field and a nested `token` field and require `invalid_json`.

This establishes the important authority invariant for this ABI: guest metadata can name a requirement, but it cannot cause Core IR itself to treat bearer material as an authority object.

**Canonical effect/capability validation**
- `internal/coreir/effects.go:55-128` requires effect ABI v1 for effectful functions, a closed registry, canonical sorted effects, no duplicates, bounded effect/capability counts, validated logical capability names, declared-effect binding and coverage of every declared effect.
- Pure functions cannot require capabilities.
- Tests cover unknown effects, wrong version, duplicates, noncanonical order, malformed names, undeclared effects and missing capability coverage.

**Transitive propagation**
- `internal/coreir/effects.go:131-154` checks every call edge and requires the caller to contain the callee’s effects and exact logical capability requirements.
- Because `Module.Validate` checks every call instruction, missing propagation fails IR validation.

**Snapshot/backward compatibility**
- `Prepare` validates then JSON round-trips the module into an owned snapshot.
- `Semantics` returns copied effect/capability slices.
- Existing pure v1 IR with empty `effects` remains accepted and executes unchanged.
- The focused tests explicitly cover pure backward compatibility.

**Effectful executor boundary**
- `internal/coreir/execute.go:101-115` fetches the prepared semantics and rejects any effectful entry with `effectful_program` before machine execution.
- There are no host effect opcodes/syscalls added to Core.

**Verifier boundary**
- `internal/coreir/verify.go:59-82` validates the contract/profile, then for effectful semantics returns:
  - `status = "unknown"`
  - `method = "effect-contract-validation"`
  - `reason = "effectful_execution_not_supported"`
  - no execution cases.
- This does not claim a proof and does not claim to have executed the host effect.

**Contract mismatch handling**
- `internal/coreir/contract.go:46-55` requires the contract’s canonical effect set to exactly match the executable entry’s effect set.
- Pure/effectful mismatch is rejected.

### Non-blocking scope boundary: capability preconditions are not yet Contract v1

`Contract` currently contains `effect_version` and `effects`, but not `required_capabilities` (`internal/coreir/contract.go:10-19`). Therefore contract validation must **not** be interpreted as capability authorization or as an exact authority-profile contract.

This is acceptable for the present M1 slice because:
- effectful `Verify` always returns `unknown` and executes no host effect;
- the actual prepared `Semantics(entry)` includes `RequiredCapabilities`;
- the new documentation explicitly leaves capability minting/validation and the broker outside Swyp;
- the architecture plan already lists “capability preconditions” as a next contract layer.

Before a future broker allows a contract result to participate in authorization, add canonical capability preconditions/exact matching or keep authorization strictly derived from executable semantics + host policy. Do not let “effect-contract-validation” become an authorization decision.

### C integration conclusion

No unsafe host-execution path, capability-token authority path, verification overclaim or backward-compatibility regression was found in this candidate. The affected paths did not change between `cc688dd` and current main `f0b244a`. **VERIFIED for integration** as the declarative ABI/fail-closed foundation described above.

---

# 5. Integration decision

## May integrate
- **B — P0 secret/process hardening**
- **C — Swyp Effect/Capability ABI**

No path-level drift against `main@f0b244a` was observed for either candidate. An actual rebase/merge was deliberately not performed in this read-only QA run.

## Must not integrate yet
- **A — Control Kernel foundation**

Minimum acceptance bar before re-QA:
1. verifier verdicts bound to authenticated verifier authority + current attempt/lease/fence;
2. no historical PASS reuse across execution epochs;
3. total crash-recovery table for PREPARED/STARTED/RESULT/COMMITTING windows;
4. unresolved side effects cannot enter an unrecoverable terminal node;
5. DAG topology frozen/versioned before lease issuance;
6. attempt epochs uniquely enforced;
7. new negative/fault tests reproduce each finding above and then prove the repaired invariant under `-race` and full-suite execution.

---

# 6. QA integrity statement

This run inspected source, ADR/docs and live repository state; it did not rely only on author-provided green tests. No candidate source file was repaired or rewritten. No commit, push, deploy or source integration was performed. The only intended write from this QA execution is this report:
`E:\CEO\projects\swos\analysis\06-m1-implementation-qa.md`.
