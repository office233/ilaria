# Verified plan approval: bounded F-2 backend preparation

`swypik-os/core/planapproval` is a reusable host-side coordinator for manual or
future provider proposals. It is **not connected F-2**, a compiler, a VM, a
broker, another supervisor, or a claim that a model emits usable plans.

## API and authority

`Open(Config)` requires an absolute metadata journal, distinct configured
approver/verifier IDs, a trusted `ApproverAuthenticator`, and a trusted
`PlanVerifier`. `Executor` is optional: boundary-only hosts get an explicit
`ErrExecutionUnavailable`, with no fictitious launch reservation.

The coordinator exposes:

| Method | Input | Result |
| --- | --- | --- |
| `Propose(ctx, id, Proposal)` | Opaque source/module bytes and generated `swypeffects.EffectPlan` | Immutable revision in `PROPOSED` |
| `Verify(ctx, Revision)` | Exact current revision | `VERIFIED`, `REJECTED`, or operational `FAILED`, with evidence |
| `Accept(ctx, Revision, expectedActor, credential)` | Authenticated trusted host decision | `APPROVED`; does not execute or mint a grant |
| `Execute(ctx, Revision)` | Exact verified and host-approved revision | One reserved execution and canonical supervisor outcome |
| `Correct(ctx, Revision, Proposal)` | Exact current, never-executed revision | New `PROPOSED` revision; clears verification and approval |
| `Cancel(ctx, Revision, expectedActor, credential)` | Authenticated host action | Idempotent cancellation; signals owned active work |
| `Status(id)` / `Close()` | Host inspection/lifecycle | Detached snapshot / cancellation and durable shutdown |

All action methods except `Close` and `Status` return `(Snapshot, error)`.
`Close` returns an error; `Status` returns `(Snapshot, error)`.
Errors remain explicit, including rejected evidence, unavailable adapters,
wrong revisions, unauthorized actors, storage failures and uncertainty.

`Revision` pins proposal ID, monotonically increasing revision number,
SHA-256 of canonical generated plan JSON, exact source bytes, and exact module
bytes. The module digest must match the generated plan. The package delegates
plan shape validation to `swypeffects.ValidatePlan`, and semantic verification
to the injected host verifier; it does not interpret or independently certify
Core IR. Callers decoding untrusted plan JSON should use the existing strict
`swypeffects.DecodePlan`, not ordinary `json.Unmarshal`.

`PlanVerifier.VerifyPlan(ctx, revision, proposal)` receives detached artifacts
and returns `Verdict`: the exact revision, canonical
`controlkernel.VerificationDecision`, evidence digest, and a bounded rejection
code. The verifier must actually establish the source/module/plan relationship
under host compiler/provenance/trust policy. The coordinator records the
configured verifier identity, never a proposal-supplied identity. Its review
record is not a forged execution-epoch `controlkernel.Verification`, and not a
replacement for the supervisor's independent signed effect verification.

Proposal data has no actor, approval, credential, scope, root, grant, budget,
signing key, executable path or OS authority field. The expected actor label
cannot choose the authenticated principal. Host credentials are never retained
or persisted. Keep the authenticator, verifier, policy factory and executor on
the trusted host side; exposing these host objects directly to a provider defeats
the boundary. Concurrent mutation of inputs *during* an API call is not supported;
after a call, input, callback and snapshot copies cannot mutate owned artifacts.

## Durable execution adapter

`NewSupervisorExecutor(SupervisorPolicy, GuestRunner)` requires **both** explicit
trusted host policy and an existing host guest runner. The adapter checks the
host's configured module/entry/effects/bindings against the reviewed canonical
plan, requires an explicit execution-policy hash and bounded budgets, then
delegates to the existing public supervisor:

```text
supervisor.Open -> Start -> GuestRunner.Run(..., supervisor.Handle)
                -> Finish, or Abort on guest/cancellation/terminal failure
                -> Close
```

The host policy supplies kernel, ledger/task/run identities, scopes, roots,
credentials, signing identity, budgets and independent effect verifier. Approval
itself is not a capability grant. The existing supervisor/kernel/broker retain
ownership of durable launch reservation, scoped grants, leases/fences, signed
receipt verification and commit. Host policy must never recycle a ledger/task/run
to replay an earlier guest.

`GuestRunner.Run` must launch the exact verified module, enforce existing OS
process limits, validate the full terminal frame and process exit before
returning its final hash, and stop its owned process tree on context cancellation.
This package cannot turn an arbitrary uncooperative Go callback into a sandbox.
The CLI's runner is not exported; no compiler, guest process engine or fake
production runner has been added here. A production host still needs that
runner/verification integration before it can execute real proposals safely.
Authenticated continuation checkpoints/resumption are not transported through
this bounded runner seam; an enabled continuation policy is explicitly rejected
as unavailable rather than silently discarding the existing supervisor policy.

## State, cancellation and recovery

```text
PROPOSED -> VERIFYING -> VERIFIED -> APPROVED -> RUNNING -> SUCCEEDED
                     -> REJECTED                         -> FAILED
                     -> FAILED                           -> CANCELLED
                                                        -> UNCERTAIN
```

Corrections, including byte-identical corrections, increment the revision and
invalidate all previous decisions. A correction may cancel an in-flight
verification; late results cannot publish into the new revision. After any
execution reservation, correction and another execution are forbidden.

Cancellation before execution is immediately `CANCELLED`. During execution it
records `CancelRequested` and cancels the owned context, but remains `RUNNING`
until the adapter supplies terminal evidence within the original bounded
execution window. A proven stopped/aborted execution becomes `CANCELLED`; this
does not roll back already committed effects. Cancellation without stop proof,
timeouts without terminal evidence, mismatched/missing evidence, or interrupted
host execution become `UNCERTAIN`. A cancellation that wins the coordinator race
against late successful evidence also becomes `UNCERTAIN`, retaining the
supervisor's evidence rather than publishing stale success or inventing rollback.
Cancellation after an already recorded terminal outcome is an idempotent no-op.

Every launch is durably reserved before invoking the adapter, and callbacks run
outside the state mutex. A hung verifier/executor remains counted against the
concurrency bound until it actually returns, even after timeout. Late completion
never changes a terminal uncertain record. There is no retry/replay or automatic
reconciliation API: use the existing supervisor's status/recovery mechanism and
an explicit future host reconciliation handoff, not a new guest launch.

Metadata uses the existing single-writer, tamper-evident
`controlkernel.EventStore`. Reopening interrupted `RUNNING` becomes durable
`UNCERTAIN`; interrupted verification becomes `FAILED`. Source/module bytes,
credentials, keys and grants are not journaled. All reopened revisions are
**status-only**: even a restored approval cannot execute. A never-executed
revision must be corrected/reverified/reapproved with freshly supplied artifacts.
The original coordinator policy and bounds must match on reopen.

## Bounds

| Resource | Default | Ceiling |
| --- | --- | --- |
| Source / module bytes | 1 MiB each | 1 MiB each |
| Combined source + module + canonical plan bytes | 2 MiB | Existing effect message bound, 2 MiB |
| Proposal IDs, including terminal tombstones | 64 | 64; no eviction or ID recycling |
| Revisions per ID | 16 | 16 |
| Metadata history records per ID | 128 | 128; at least `4 * MaxRevisions + 3` |
| In-flight verifier/executor callbacks together | 1 | 8, matching the existing control-channel queue bound |
| Verification / execution proof window | 30 seconds each | 60 seconds each |
| Durable record payload | 8 KiB | 8 KiB |
| Approval credential input | 4 KiB | 4 KiB; never persisted |

Zero `Limits` uses these defaults; incomplete or oversized configurations fail.
History reserves mandatory cancellation/terminal records before accepting any
revision. Each ID retains only its current artifacts; corrections replace them,
and terminal executions/cancellations release them. The journal size is bounded
on reopen by configured proposal/history limits and record/frame overhead.

## Evidence and remaining integration blockers

Tests use explicitly labeled public synthetic source/module/review fixtures and
deterministic adapters. They cover immutable copies and internal tampering,
wrong actor/revision, missing verification, rejection versus verifier failure,
correction/cancellation races, duplicate execution, bounded callbacks/history,
timeouts, late results, storage failure and restart replay refusal.

The local adapter smoke invokes a **real** supervisor, control kernel and clock
broker: it checks signed receipt creation, independent-verification plumbing,
durable intent commit, cancellation/abort and durable duplicate-launch refusal.
Its guest and independent verifier are still synthetic public fixtures. It does
not prove real model inference, real Swyp preflight/semantic verification, or
mobile end-to-end behavior.

These three reserved live-path gates remain intentionally untouched:

- `ilaria/runtime/mobileprovider/provider.py`: empty proposed Swyp plan output.
- `swypik-os/internal/mobilegateway/gateway.go`: rejects nonempty proposals.
- Mobile `ilaria-wire.ts`: refuses proposed plans.

Provider, verifier/compiler and mobile-owner handoffs are still required for
connected F-2. No provider/model, compiler, kernel, shared documentation, mobile,
cloud, deployment or publication work is part of this package.

Validation from `swypik-os`:

```powershell
go vet ./core/planapproval
go test -count=1 -timeout 180s ./core/planapproval
go vet ./...
go test -count=1 -timeout 180s ./...
# When a CGO C toolchain is available:
go test -race -count=1 -timeout 180s ./...
git diff --check
```
