# SWOS M1 — Control Kernel Repair Re-QA

**Date:** 2026-09-28  
**Role:** Independent principal verifier  
**Source policy:** READ-ONLY. No source repair, commit, push or deploy performed.  
**Worktree:** `E:\CEO\wt\swos-control-kernel-m1\swypik-os`  
**Only QA write:** `E:\CEO\projects\swos\analysis\09-control-kernel-reqa.md`

## Verdict: REJECTED

The repair closes the historical-verification epoch bug, crash-window liveness gaps, blind replay path, unresolved-side-effect terminalization, retroactive DAG mutation, attempt-epoch caller authority, and preserves event-store integrity/CAS behavior.

One authority defect remains in the A-1 verifier/executor separation boundary:

> **A-1 residual — executor/verifier independence is still compared against a caller-controlled lease-owner string rather than an authenticated executor principal.**

This is integration-blocking for the control kernel authority plane. All mandated test/vet/diff gates pass; the rejection is semantic, not a test-suite failure.

---

## 1. Mandatory gates

Executed from `E:\CEO\wt\swos-control-kernel-m1\swypik-os`.

- `go test -count=1 -race ./core/controlkernel` → **PASS**, exit 0; `ok swypik-os/core/controlkernel 1.805s`; race detector clean.
- `go vet ./...` → **PASS**, exit 0, no output.
- `go test -count=1 -timeout 180s ./...` → **PASS**, exit 0; **43 ok, 0 failed**.
- `git diff --check` → **PASS**, exit 0, no output.

Additional targeted reproductions:

- `go test -count=1 -v ./core/controlkernel -run 'TestQAA|TestVerifierFailsClosedWithoutAuthenticator'` → **PASS**, including:
  - `TestQAA1VerificationIsBoundToAuthenticatedCurrentEpoch`
  - `TestQAA2PreparedIntentRebindsSafelyAfterCrash`
  - `TestQAA2CommittingCrashRecoveryIsTotal`
  - `TestQAA3UnresolvedExternalRealityCannotTerminalize`
  - `TestQAA4TopologyFreezesBeforeScheduling`
  - `TestQAA5AttemptEpochIsKernelOwnedUniqueAndValidated`
  - `TestVerifierFailsClosedWithoutAuthenticator`

- `go test -count=1 -v ./core/controlkernel -run 'TestUncertainIntentCannotBlindReplay|TestResultUnderDeadFenceRequiresReconciliation|TestEventStoreConcurrentCAS|TestEventStoreRepairsOnlyTornTail|TestEventStoreMiddleCorruptionFailsClosed|TestEventStoreMiddleLengthHeaderCorruptionFailsClosed|TestEventStoreHashChainSurvivesReplay'` → **PASS**.

Observed source worktree state after QA:
- `?? swypik-os/core/controlkernel/`
- `?? swypik-os/docs/ADR_CONTROL_KERNEL_EVENT_STORE.md`

No QA source modification was introduced.

---

## 2. Former blocker A-1 — historical PASS binding

### Historical PASS cannot cross attempt/fence: VERIFIED

Evidence:

- `core/controlkernel/kernel.go:302-304` gates `VERIFYING -> COMMITTING` on `hasPassedVerificationForCurrentAttemptLocked`.
- `core/controlkernel/kernel.go:1030-1090` authenticates a verifier, requires a live current lease, requires evidence, derives the current attempt from the lease, and persists `AttemptID + LeaseID + Fence`.
- `core/controlkernel/kernel.go:1093-1112` matches PASS on exact `NodeID + AttemptID + LeaseID + Fence`, and requires non-empty evidence.
- `core/controlkernel/projection.go:337-354` replay-validates verification binding to the matching attempt and then-current lease.
- `core/controlkernel/repair_test.go:35-104` reproduces old-pass reuse across lease expiry/retry and proves it is rejected until the second epoch receives its own PASS.

This part of A-1 is repaired.

### Verifier cannot be self-authorized by executor identity confusion: REJECTED

#### Exact source evidence

1. Lease owner identity is still untrusted caller payload:
   - `core/controlkernel/kernel.go:339` exposes `ClaimLease(nodeID, owner string, ttl ...)`.
   - `core/controlkernel/kernel.go:345-346` validates only non-empty owner/TTL.
   - `core/controlkernel/kernel.go:377-385` persists `Lease.Owner = owner` verbatim.
   - There is no executor authenticator/principal binding on lease claim.

2. Verification authenticates a verifier principal, but independence is checked only by string equality against that caller-chosen owner:
   - `core/controlkernel/kernel.go:1036-1042` invokes `VerifierAuthenticator.AuthenticateVerifier`.
   - `core/controlkernel/kernel.go:1060-1061` rejects self-verification only when `lease.Owner == principal.ID`.
   - `core/controlkernel/verifier.go:7-19` defines verifier identity, but there is no corresponding authenticated executor principal carried by the lease.

3. The current test authenticator explicitly demonstrates a credential domain in which an executor credential is accepted by the verifier authenticator:
   - `core/controlkernel/kernel_test.go:11-19` maps credential → principal ID.
   - `core/controlkernel/kernel_test.go:36-41` configures both:
     - `"verifier-credential" -> "verifier-independent"`
     - `"executor-credential" -> "executor"`

#### Reproduction

Using the package's current public API and the current test authenticator semantics:

1. Configure the same authenticator shown in `kernel_test.go:36-41`, so `"executor-credential"` authenticates as principal `"executor"`.
2. The executor calls:
   - `ClaimLease(node, "executor-alias", ttl)`
   - this is accepted because `owner` is caller-controlled and only required to be non-empty (`kernel.go:339-346`).
3. Advance the node under that lease to `VERIFYING`.
4. The same executor calls:
   - `RecordVerification("executor-credential", PASS + EvidenceHash)`.
5. Authentication returns principal ID `"executor"`.
6. The only self-verification guard evaluates:
   - `lease.Owner == principal.ID`
   - i.e. `"executor-alias" == "executor"` → false.
7. The verification is therefore accepted and persisted for the current attempt/fence (`kernel.go:1063-1090`), after which it satisfies the commit gate (`kernel.go:302-304,1093-1112`).

The repair therefore prevents arbitrary *verifier payload strings*, but it does **not** establish an enforceable executor-vs-verifier identity boundary because the executor side of the comparison is not authenticated.

#### Required repair

Bind lease ownership to an authenticated executor principal rather than caller text. For example:

- introduce an executor authenticator/authority at `ClaimLease`, or have the scheduler supply a trusted `ExecutorPrincipal`;
- persist the authenticated executor principal ID in the lease;
- compare verifier principal vs authenticated executor principal, not vs a free-form `owner` label;
- keep display/worker labels separate from security identity;
- add a negative test where the same executor principal claims the lease under a different display alias and must still be rejected from verifying its own attempt.

**Integration blocker: YES.**

---

## 3. Former blocker A-2 — crash-window liveness

### PREPARED crash window: VERIFIED

- `core/controlkernel/kernel.go:564-676` provides an expired-lease recovery table.
- `core/controlkernel/kernel.go:629-641` requeues LEASED/PREPARING/EXECUTING work with no external reality.
- `core/controlkernel/kernel.go:686-745` permits the same durable PREPARED/ABANDONED intent to rebind to the new kernel-owned attempt/lease/fence, while refusing replay for later external states.
- `core/controlkernel/projection.go:293-312` replay-validates the rebound attempt/lease/fence.
- `core/controlkernel/repair_test.go:106-154` closes the old dead-fence PREPARED liveness failure.

### STARTED crash window: VERIFIED

- `core/controlkernel/kernel.go:510-557` converts STARTED → UNCERTAIN → RECONCILING during recovery.
- `core/controlkernel/kernel.go:634-648` sends EXECUTING/VERIFYING nodes with external reality into reconciliation.
- `core/controlkernel/kernel_test.go:244-294` proves an expired STARTED effect reaches RECONCILING and cannot be restarted blindly.

### RESULT crash window: VERIFIED

- `core/controlkernel/kernel.go:537-544` moves RESULT → RECONCILING.
- `core/controlkernel/kernel.go:957-991` finalizes only through reconciliation and rejects conflicting recorded outcome evidence.
- `core/controlkernel/kernel_test.go:136-192` proves stale RESULT cannot direct-commit and is reconciled from preserved evidence.
- `core/controlkernel/repair_test.go:209-267` independently covers the COMMITTING+RESULT crash path.

### COMMITTING crash window: VERIFIED

- `core/controlkernel/kernel.go:650-658`:
  - finalizes SUCCEEDED only when all epoch intents are committed and the exact epoch has PASS;
  - otherwise enters reconciliation.
- `core/controlkernel/repair_test.go:156-267` covers both committed-finalize and uncommitted-result reconciliation.

No stranded durable phase was found in the audited PREPARED/STARTED/RESULT/COMMITTING paths.

---

## 4. No blind replay: VERIFIED

- `core/controlkernel/kernel.go:724-745` returns existing COMMITTED work, safely rebinds only PREPARED/ABANDONED work, and rejects STARTED/RESULT/UNCERTAIN/RECONCILING work with “requires reconciliation, not replay”.
- `core/controlkernel/state.go:113-127` has no transition from UNCERTAIN/RECONCILING back to STARTED.
- `core/controlkernel/kernel_test.go:244-294` proves a recovered external effect cannot be restarted.

---

## 5. Former blocker A-3 — unresolved external effect terminalization

### VERIFIED

- `core/controlkernel/kernel.go:314-315` rejects FAILED/CANCELLED/BLOCKED while unresolved external reality exists.
- `core/controlkernel/kernel.go:1128-1143` defines unresolved states as STARTED, RESULT, UNCERTAIN, RECONCILING.
- `core/controlkernel/state.go:60-65` keeps OPERATOR_REQUIRED as the explicit reconciliation escalation path.
- `core/controlkernel/repair_test.go:270-321` exercises STARTED, UNCERTAIN and RECONCILING terminal guards and proves OPERATOR_REQUIRED remains available.

The old unrecoverable terminalization path is closed.

---

## 6. Former blocker A-4 — retroactive DAG topology mutation

### VERIFIED

- `core/controlkernel/kernel.go:159-160` rejects new nodes once topology is frozen.
- `core/controlkernel/kernel.go:205-207` rejects new edges once topology is frozen.
- `core/controlkernel/kernel.go:320-336` atomically appends topology-freeze before the first node transition to READY in the same durable batch.
- `core/controlkernel/kernel.go:352-356` refuses lease issuance unless the task topology is frozen.
- `core/controlkernel/projection.go:142-188` rejects replayed node/edge additions after freeze.
- `core/controlkernel/projection.go:190-204` rejects replay where a node becomes READY before freeze.
- `core/controlkernel/repair_test.go:323-351` reproduces the old retroactive-edge scenario and proves the edge/node mutations are rejected after READY.

---

## 7. Former blocker A-5 — attempt epoch uniqueness / status validity

### VERIFIED

- `core/controlkernel/kernel.go:361-412` mints lease ID, AttemptID, monotonic Fence and next attempt Number inside `ClaimLease`; callers do not supply the epoch.
- `core/controlkernel/kernel.go:994-1027` makes `RecordAttempt` validation/query-only and rejects caller-forged ID/number/status.
- `core/controlkernel/state.go:104-110` rejects unknown AttemptStatus values.
- `core/controlkernel/projection.go:208-244` rejects invalid attempts, duplicate IDs, duplicate per-node attempt numbers, duplicate execution epochs, and non-monotonic lease fences during replay.
- `core/controlkernel/repair_test.go:353-400` proves caller forgery and invalid status are rejected and duplicate durable attempt epochs fail replay.

---

## 8. Event-store integrity / CAS / race behavior

### VERIFIED

- `core/controlkernel/event_store.go:258-273` serializes append under the store mutex and enforces expected-sequence CAS.
- `core/controlkernel/event_store.go:302-315` assigns stream/journal sequence and the hash-chain predecessor/hash.
- `core/controlkernel/event_store.go:330-345` writes the full frame, requires full write + fsync, fail-closes on storage errors, and only then advances in-memory state.
- `core/controlkernel/event_store.go:149-193` validates frame magic, redundant length header, frame bounds, checksum, and batch replay.
- `core/controlkernel/event_store.go:207-251` validates stream sequence, global journal sequence, PrevHash, event hash and JSON before accepting replay.
- `core/controlkernel/event_store_test.go:30-70` runs 32 concurrent CAS contenders and requires exactly one success.
- `core/controlkernel/event_store_test.go:72-120` verifies torn-tail repair.
- `core/controlkernel/event_store_test.go:122-199` verifies middle-body and length-header corruption fail closed.
- `core/controlkernel/event_store_test.go:201-230` verifies hash-chain replay stability.
- Mandatory `go test -count=1 -race ./core/controlkernel` passed.

No regression was found in the event-store mechanics.

---

## 9. Acceptance matrix

| Required invariant | Result |
|---|---|
| Historical PASS cannot cross attempt/fence | **VERIFIED** |
| Executor cannot self-authorize by verifier identity/credential confusion | **REJECTED** — lease executor identity is still caller-controlled text |
| PREPARED/STARTED/RESULT/COMMITTING crash windows have safe liveness | **VERIFIED** |
| No blind replay | **VERIFIED** |
| Unresolved side effects cannot become unrecoverable terminal states | **VERIFIED** |
| DAG topology cannot change retroactively after scheduling starts | **VERIFIED** |
| Attempt epochs unique/kernel-owned; invalid statuses fail | **VERIFIED** |
| Event-store integrity/CAS/race remains intact | **VERIFIED** |

## Final decision

**REJECTED for integration as the authority-plane control kernel until the executor identity used for verifier-independence checks is authenticated/bound to the lease.**

The implementation is otherwise materially repaired and all requested gates are green. No source was modified during this QA pass.
