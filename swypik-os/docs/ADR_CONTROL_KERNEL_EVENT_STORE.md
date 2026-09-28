# ADR: SwypikOS M1 Control Kernel Event Store

**Status:** accepted for M1 foundation
**Scope:** `core/controlkernel` only; no desktop/runtime rewiring
**Date:** 2026-09-28

## Context

The M1 control kernel needs a durable task graph, expected-sequence CAS,
monotonic lease fencing, a side-effect intent ledger, crash recovery, and a
tamper-evident event history. The current `swypik-os` module has no database
dependency and its live desktop runtime is still based on the existing
single-run agent checkpoint.

The architecture plan considered two persistence families:

1. pure-Go SQLite/WAL;
2. a custom append-only event journal plus rebuildable projections.

M1 must not rewire the desktop until compatibility is demonstrated.

## Decision

Use a **single-writer, framed append-only journal implemented with the Go
standard library** for the first M1 control-kernel foundation.

This is intentionally narrow rather than a general database implementation.
The journal is the source of truth; projections are rebuilt from it on open.
The control kernel currently uses one `control` event stream so graph/lease/
intent mutations that must become durable together are emitted in one frame.

### Durability and corruption contract

- every append is an expected-sequence compare-and-swap;
- one append call is serialized as one frame, so replay accepts the entire
  event batch or none of it;
- the frame header stores both body length and its bitwise complement, so a corrupted middle-frame length cannot masquerade as a torn final append;
- the frame body is protected by SHA-256;
- every event carries a global `JournalSeq`, `PrevHash`, and SHA-256 `Hash`,
  giving the journal a total-order hash chain in addition to per-stream `Seq`;
- the file is `fsync`'d before in-memory projections advance or success is
  returned;
- a write or sync error latches the open store fail-closed until close/reopen;
- a physically incomplete **final** frame is treated as a torn append and is
  truncated to the last verified frame, followed by `fsync`;
- a complete frame with invalid checksum, JSON, version, sequence, or hash
  chain fails open/replay with `ErrCorruptJournal`;
- corruption in the middle is never skipped and replay never applies records
  after a corrupt frame.

### Writer exclusion

The journal holds a cooperating-process writer lock for its full lifetime:

- Windows: `LockFileEx` exclusive, fail-immediately;
- non-Windows builds: advisory `flock` through the standard library syscall
  surface.

The lock is a writer-coordination mechanism, **not a sandbox/security boundary**.

### Lease and side-effect invariants

- lease IDs are random and fences increase monotonically per node;
- every lease atomically mints exactly one kernel-owned `Attempt` epoch; attempt
  numbers, lease IDs and fences are not caller-authoritative and replay rejects
  duplicate node/attempt numbers, duplicate fences and invalid attempt status;
- every worker mutation validates the current lease ID, fence and TTL;
- every task topology is durably frozen before its first node becomes `READY`;
  nodes/edges cannot be added after that point, so an issued lease can never gain
  a retroactive dependency;
- an expired executing lease transitions the node to `UNCERTAIN`, not back to
  executable work;
- a side-effect `Intent` must be durably `PREPARED` before it can become
  `STARTED`;
- every intent is bound to the current `AttemptID`, lease ID and fence;
- idempotency keys are durable and a key cannot be reused for a different
  logical request;
- `PREPARED` work whose fence dies may be rebound to a new attempt because no
  external effect has started; once an effect is `STARTED` or has `RESULT`, it
  is never rebound/replayed and must enter reconciliation;
- `STARTED -> UNCERTAIN -> RECONCILING` has no transition back to `STARTED`;
  ambiguous effects therefore cannot be blindly replayed;
- normal result/commit paths reject stale fences; reconciliation commit is a
  separate control-plane operation that requires explicit external outcome
  evidence.

### Verification authority and epoch binding

- `RecordVerification` accepts a verifier credential plus verdict/evidence only;
  verifier identity is supplied by a `VerifierAuthenticator` configured when
  the kernel is opened, never trusted from verdict payload text;
- the authenticator credential is not persisted;
- the immutable verification event records authenticated `VerifierID`, current
  `AttemptID`, `LeaseID`, `Fence` and mandatory `EvidenceHash`;
- the executor lease owner cannot verify its own epoch;
- `VERIFYING -> COMMITTING` requires a PASS matching the current attempt, lease
  and fence exactly; historical PASS records cannot authorize a retry.

### Expired-lease recovery table

Recovery is control-plane authority and releases the dead lease in the same
durable event batch as the recovery transition:

| Durable window | Recovery |
|---|---|
| `LEASED` / `PREPARING`, no external effect started | `RETRY_WAIT -> READY`; stale `PREPARED` intent may rebind to the next attempt |
| `EXECUTING` with only `PREPARED` work | `RETRY_WAIT -> READY`; no external replay occurred |
| `STARTED` / `UNCERTAIN` external effect | intent and node enter `RECONCILING`; never resend blindly |
| `RESULT` under a dead fence | preserve recorded external ref/result hash and enter `RECONCILING`; reconciliation may finalize only matching evidence |
| `VERIFYING` with no external reality | retry under a fresh attempt; old verification cannot carry over |
| `COMMITTING`, all intents committed + PASS for that exact epoch | finalize node `SUCCEEDED` without another external call |
| `COMMITTING` with uncommitted/result/ambiguous intent | enter `RECONCILING` |

`FAILED`, `CANCELLED` and `BLOCKED` are rejected while any intent is
`STARTED`, `RESULT`, `UNCERTAIN` or `RECONCILING`. `OPERATOR_REQUIRED` is the
explicit terminal escalation available from reconciliation when external reality
cannot be resolved automatically.

## Why not SQLite in this iteration

SQLite remains a valid candidate for later milestones. It was not selected for
this foundation because the module currently has no SQLite dependency and the
mandatory M1 invariants can be implemented and fault-tested without expanding
the dependency/build surface. Adding SQLite solely to obtain a database label
would be unnecessary infrastructure at this point.

This decision is not a claim that the custom journal is universally better.
Before higher concurrency, large histories, secondary indexes, online
migrations, or distributed serving are introduced, benchmark the journal
against a pure-Go SQLite/WAL implementation under **equivalent fsync and
durability guarantees**.

## Consequences / next integration

- Scheduler code can query durable tasks, nodes, edges, ready nodes, leases,
  intents and verifications without depending on the desktop.
- Snapshots/compaction are deliberately absent; they may be added only as
  verified replay accelerators and can never become the source of truth.
- Capability grants, process sandbox enforcement, resource enforcement,
  scheduler workers, and compatibility wiring over `core/agent` remain later
  integration work.
- The current desktop continues to use its existing runtime in this iteration.
