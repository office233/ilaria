# SWOS M1 — Control Kernel Repair Round 2 QA

**Date:** 2026-09-28  
**Role:** Independent principal verifier  
**Source policy:** READ-ONLY. No source repair, commit, push or deploy performed.  
**Worktree:** `E:\CEO\wt\swos-control-kernel-m1\swypik-os`  
**Only QA write:** `E:\CEO\projects\swos\analysis\12-control-kernel-r2-qa.md`

## Verdict: VERIFIED

Repair Round 2 closes the remaining A-1 authority-plane blocker identified in `09-control-kernel-reqa.md`.

Lease execution identity is now authenticated independently of the caller-controlled display alias, persisted as `Lease.ExecutorID`, enforced against the authenticated verifier principal, and required during replay. The exact alias-confusion negative case passes. Spot-checks of A-2 through A-5 show no regression, and all mandated gates pass.

---

## 1. Mandatory gates

Executed from:

`E:\CEO\wt\swos-control-kernel-m1\swypik-os`

### Targeted A-1 / verifier tests

Command:

`go test -count=1 -v ./core/controlkernel -run 'TestQAA1|TestVerifier'`

Result: **PASS**, exit 0.

Exact tests:

- `TestQAA1VerificationIsBoundToAuthenticatedCurrentEpoch` — PASS
- `TestVerifierFailsClosedWithoutAuthenticator` — PASS
- `TestQAA1ExecutorAliasCannotConfuseVerifierIdentity` — PASS

Package result:

`ok swypik-os/core/controlkernel 0.454s`

### Race gate

Command:

`go test -count=1 -race ./core/controlkernel`

Result: **PASS**, exit 0.

`ok swypik-os/core/controlkernel 1.869s`

Race detector reported no failure.

### Vet gate

Command:

`go vet ./...`

Result: **PASS**, exit 0, no output.

### Full repository test gate

Command:

`go test -count=1 -timeout 180s ./...`

Result: **PASS**, exit 0.

Observed totals:

- **43 packages:** `ok`
- **2 packages:** `[no test files]`
- **0 failures**

`core/controlkernel` result in the full suite:

`ok swypik-os/core/controlkernel 1.067s`

The first foreground invocation was refused by bridge resource admission because host free memory was below the bridge's heavy-command threshold; the exact required command was then executed unchanged through the bridge process runner and completed successfully with exit 0. This was infrastructure admission control, not a test failure.

### Diff hygiene gate

Command:

`git diff --check`

Result: **PASS**, exit 0, no output.

---

## 2. Remaining A-1 blocker — authenticated executor identity

### 2.1 ClaimLease authenticates an executor principal: VERIFIED

The former defect was that `owner` was caller-controlled text and doubled as the security identity.

Current source establishes a distinct executor authentication boundary:

- `core/controlkernel/verifier.go:8-18` defines `ExecutorPrincipal{ID}` and `ExecutorAuthenticator.AuthenticateExecutor(credential)`.
- `core/controlkernel/kernel.go:34-39` installs that authority through `WithExecutorAuthenticator`.
- `core/controlkernel/kernel.go:348-355` requires both executor credential and owner/display label.
- `core/controlkernel/kernel.go:357-363` fails closed if no executor authenticator is configured or the credential does not authenticate to a non-empty principal ID.
- `core/controlkernel/kernel.go:393-403` persists `Owner: owner` separately from `ExecutorID: principal.ID`.

Therefore the caller may choose a display alias, but cannot choose the security principal stored in the lease.

### 2.2 Lease persists authenticated ExecutorID: VERIFIED

Exact model/source evidence:

- `core/controlkernel/model.go:84-94` adds durable `Lease.ExecutorID string`.
- `core/controlkernel/kernel.go:393-403` constructs the durable lease with `ExecutorID: principal.ID` after successful executor authentication.
- The opaque credential itself is not persisted; `core/controlkernel/verifier.go:14-18` and `kernel.go:34-39` make the authenticated principal ID the durable identity.

This cleanly separates display metadata (`Owner`) from authority identity (`ExecutorID`).

### 2.3 Verifier self-check uses authenticated ExecutorID: VERIFIED

Current verification path:

- `core/controlkernel/kernel.go:1053-1059` requires a verifier authenticator and authenticates the verifier credential to a non-empty principal ID.
- `core/controlkernel/kernel.go:1073-1076` requires a current live lease.
- `core/controlkernel/kernel.go:1077-1079` rejects verification when `lease.ExecutorID == principal.ID`.
- `core/controlkernel/kernel.go:1080-1099` binds the verdict to the current attempt/lease/fence and persists the authenticated `VerifierID`.

The security comparison no longer uses `Lease.Owner`.

### 2.4 Forged executor credential fails: VERIFIED

Exact negative test:

- `core/controlkernel/repair_test.go:436-437` calls `ClaimLease` with `"forged-executor-credential"` and requires `ErrExecutorUnauthorized`.

The targeted test command passed this case as part of `TestQAA1ExecutorAliasCannotConfuseVerifierIdentity`.

### 2.5 Same executor principal under a different alias cannot self-verify: VERIFIED

The exact alias-confusion regression test requested by the prior QA is present:

- `core/controlkernel/repair_test.go:440-445` claims the lease using authenticated executor credential `"executor-credential"` while supplying display alias `"executor-alias"`, then asserts:
  - `lease.Owner == "executor-alias"`
  - `lease.ExecutorID == "executor"`
- `core/controlkernel/repair_test.go:450-455` then attempts verification using the same executor credential and requires `ErrConflict`.
- `core/controlkernel/repair_test.go:457-462` proves a distinct authenticated verifier remains accepted.

This directly reproduces and closes the exact residual from `09-control-kernel-reqa.md`.

### 2.6 Historical PASS remains epoch-bound: VERIFIED

No regression in the earlier A-1 epoch binding:

- `core/controlkernel/kernel.go:311-312` gates VERIFYING → COMMITTING on a PASS for the current execution epoch.
- `core/controlkernel/kernel.go:1110-1129` matches PASS by exact node + attempt + lease + fence and requires evidence.
- `core/controlkernel/repair_test.go:37-105` proves a PASS from the first lease/fence does not authorize a retry and that the second epoch needs its own PASS.

### 2.7 Replay fails closed without executor identity binding: VERIFIED

Replay now requires the durable authenticated executor identity:

- `core/controlkernel/projection.go:233-244` decodes every `LeaseGranted` event and rejects the lease unless:
  - lease ID is present,
  - task/node binding is valid,
  - attempt ID exists,
  - **`lease.ExecutorID != ""`**,
  - attempt ↔ node/lease/fence binding is valid,
  - fence is non-zero and monotonic.

An old pre-repair lease event with no `executor_id` decodes to an empty field and is therefore rejected at `projection.go:240-241`.

Replay also keeps verification tied to the exact durable execution epoch:

- `core/controlkernel/projection.go:337-354` requires verification node/task/attempt/lease/fence and evidence bindings to match the currently replayed lease and attempt.

Because the credential is intentionally not persisted, replay validates the durable authenticated principal binding (`ExecutorID`) rather than re-authenticating the original opaque credential.

---

## 3. A-2 crash-window liveness / no blind replay: NO REGRESSION

Source spot-check:

- `core/controlkernel/kernel.go:527-574` maps STARTED → UNCERTAIN and RESULT/UNCERTAIN → RECONCILING during recovery.
- `core/controlkernel/kernel.go:577-693` implements the expired-lease recovery table across LEASED/PREPARING/EXECUTING/VERIFYING/COMMITTING/UNCERTAIN/RECONCILING.
- `core/controlkernel/kernel.go:667-676` finalizes COMMITTING only when epoch intents are committed and the exact epoch has PASS; otherwise it reconciles.
- `core/controlkernel/kernel.go:733-762` permits safe rebind only for PREPARED/ABANDONED intent state and rejects later states with “requires reconciliation, not replay”.

Test evidence:

- `core/controlkernel/repair_test.go:108-156` verifies PREPARED rebind after crash.
- `core/controlkernel/repair_test.go:158-209` verifies committed COMMITTING recovery reaches SUCCEEDED.
- `core/controlkernel/repair_test.go:211-269` verifies an uncommitted RESULT crash enters reconciliation, rejects conflicting evidence, and finalizes the preserved recorded result exactly once.

No A-2 regression found.

---

## 4. A-3 unresolved external reality cannot terminalize: NO REGRESSION

Source:

- `core/controlkernel/kernel.go:320-324` rejects retry and FAILED/CANCELLED/BLOCKED while unresolved external reality exists.
- `core/controlkernel/state.go:82-101` keeps the transition policy centralized; the kernel's external-reality guard constrains otherwise generic terminal exits.

Test:

- `core/controlkernel/repair_test.go:272-323` proves STARTED, UNCERTAIN, and RECONCILING side effects cannot be terminalized as FAILED/CANCELLED/BLOCKED, while explicit OPERATOR_REQUIRED escalation remains available.

No A-3 regression found.

---

## 5. A-4 topology freeze before scheduling: NO REGRESSION

Source:

- `core/controlkernel/kernel.go:155-170` rejects node additions after topology freeze.
- `core/controlkernel/kernel.go:197-217` rejects edge additions after topology freeze.
- `core/controlkernel/kernel.go:329-345` emits topology-freeze before the transition to READY in the same durable append.
- `core/controlkernel/projection.go:200-203` rejects replay in which a node becomes READY before topology is frozen.
- `core/controlkernel/kernel.go:371-373` refuses lease issuance unless task topology is already frozen.

Test:

- `core/controlkernel/repair_test.go:325-353` proves freeze happens before READY, retroactive edges/nodes are rejected, and lease claim remains valid after the frozen topology is established.

No A-4 regression found.

---

## 6. A-5 kernel-owned attempt epoch / validation: NO REGRESSION

Source:

- `core/controlkernel/kernel.go:377-413` mints lease ID, attempt ID, monotonic fence, and attempt number inside `ClaimLease`.
- `core/controlkernel/kernel.go:1011-1044` makes `RecordAttempt` validation/query-only and rejects caller changes to ID, number, or status.
- `core/controlkernel/state.go:104-110` rejects unknown attempt statuses.
- `core/controlkernel/projection.go:208-231` rejects invalid attempts, duplicate IDs, duplicate attempt numbers, and duplicate execution epochs.

Test:

- `core/controlkernel/repair_test.go:355-402` proves caller-forged attempt epochs and invalid status are rejected and duplicate durable attempt epochs fail replay.

No A-5 regression found.

---

## 7. Source worktree integrity

Source worktree state before the QA report write:

```text
## chatgpt/swos/control-kernel-m1
?? core/controlkernel/
?? docs/ADR_CONTROL_KERNEL_EVENT_STORE.md
```

This matches the pre-existing candidate state observed before QA. No source file was edited by this verifier.

---

## Acceptance matrix

| Required invariant | Result |
|---|---|
| ClaimLease authenticates executor principal; alias cannot define security identity | **VERIFIED** |
| Lease persists authenticated ExecutorID | **VERIFIED** |
| Verifier self-check compares authenticated verifier principal to ExecutorID | **VERIFIED** |
| Forged executor credential fails | **VERIFIED** |
| Same executor principal under a different alias still cannot self-verify | **VERIFIED** |
| Historical PASS remains bound to exact attempt/lease/fence | **VERIFIED** |
| Replay fails closed when durable executor identity binding is absent/structurally invalid | **VERIFIED** |
| A-2 crash-window liveness and no-blind-replay | **VERIFIED / no regression** |
| A-3 unresolved external reality terminalization guard | **VERIFIED / no regression** |
| A-4 topology freeze | **VERIFIED / no regression** |
| A-5 kernel-owned attempt epoch and replay validation | **VERIFIED / no regression** |
| Targeted tests | **PASS** |
| Race gate | **PASS** |
| Vet gate | **PASS** |
| Full repository tests | **PASS** |
| git diff --check | **PASS** |

## Final decision

**VERIFIED for integration with respect to the Repair Round 2 control-kernel QA contract.**

The last A-1 integration blocker is closed: executor identity is authenticated and security-bound independently from the caller-controlled owner alias, the verifier independence check uses the authenticated executor principal, forged executor credentials fail, the exact alias-confusion case fails closed, replay requires the durable executor identity binding, and A-2 through A-5 remain intact.

No source repair, commit, push or deploy was performed.
