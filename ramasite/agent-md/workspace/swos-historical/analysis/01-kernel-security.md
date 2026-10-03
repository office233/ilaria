# SWOS / M0 Fresh Kernel & Security Audit — SwypikOS

**Role:** principal systems/security auditor  
**Audited checkout:** E:\nexus\swypik-os inside E:\nexus  
**HEAD observed:** 96290fa on main  
**Date:** 2026-09-28  
**Mode:** source repositories kept read-only. The only write performed by this audit is this report.

## Executive verdict

SwypikOS has a useful and unusually defensive **single-run agent runtime**, but it is not yet an autonomous kernel.

The production Windows path is concretely wired as:

cmd/swypik-os → core/agent + core/coder + core/ilaria + core/search + core/service + ui/desktop + ui/engine

Evidence: cmd/swypik-os/main_windows.go:25-33, 202-238.

The packages core/actiongraph, core/security and core/evidence are **not imported by cmd/swypik-os**. Repository-wide import search found no production import of core/actiongraph or core/security; core/evidence is used only by experimental autogenesis/cyber/hive paths. Therefore those packages must not be counted as enforcement in the live desktop.

The strongest current kernel-like property is crash-aware, approval-gated execution:
- a tool approval is durably converted to status=executing and AttemptedSteps is incremented before the tool is released;
- if a crash occurs after that durable point but before a result is recorded, recovery becomes uncertain and automatic replay is blocked;
- checkpoint persistence is atomic and fail-closed.

Evidence: core/agent/runtime.go:357-387, 411-422, 447-461, 592-619; core/agent/recovery_test.go:115-164; core/agent/store_windows.go:126-165.

That is good recovery engineering, but it is **not** a durable DAG, lease system, event source, capability broker, side-effect journal or exactly-once execution model.

A fresh P0 finding is stronger than the previous audit wording: process.run launches cmd.exe with the parent environment and full user authority. If ILARIA_API_TOKEN is present in the parent environment, an approved command can read it; command output is then stored as an Observation and is included in the next planner prompt. The architecture therefore does not enforce “secrets never enter prompts/logs”.

Evidence: config/settings.go:108-131; core/coder/shell_windows.go:35-39, 90-123; core/agent/workspace_tools.go:334-368; core/agent/runtime.go:608-619; core/agent/planner.go:22-38.

## Verification performed

Read-only source inspection was followed by fresh validation on the audited checkout.

- go test -count=1 -race ./core/agent ./core/actiongraph ./core/evidence ./core/security ./core/coder ./internal/safepath ./internal/storage ./cmd/swypik-os
  - result: 8 packages OK, 0 failed, exit 0
- go vet ./core/agent ./core/actiongraph ./core/evidence ./core/security ./core/coder ./internal/safepath ./internal/storage ./cmd/swypik-os
  - result: exit 0, no stdout/stderr

The green race suite proves only the paths covered by current tests. It does not prove that the unwired actiongraph API or external filesystem concurrency is race-safe.

---

# Top 10 findings

## 1. P0 — The live runtime is a single linear Run, not a durable task graph

CURRENT:
- Manager owns exactly one current execution via current *execution.
- Start rejects a second non-terminal run.
- NewPersistent loads only the last run.
- current-run.json is the persistence unit.

Evidence: core/agent/runtime.go:126-143, 185-218, 251-282; core/agent/store_windows.go:17-29.

GAP:
- no persisted Task/Node/Edge model;
- no dependencies, fan-out/fan-in, retries per node, priorities, deadlines per node, or durable scheduler queue;
- no multi-run history source of truth.

core/actiongraph is not a substitute:
- it stores nodes, mailboxes, state and checkpoints in memory;
- checkpoints are appended to an in-memory slice and truncated;
- it is not imported by the live desktop.

Evidence: core/actiongraph/graph.go:67-78, 80-95, 276-292; cmd/swypik-os/main_windows.go:25-33.

RISK:
- a future multi-agent orchestration layer built on the current Manager would serialize work and have no durable dependency semantics;
- using core/actiongraph directly would lose graph state on process crash.

IMPLEMENTATION PLAN:
- introduce core/kernel/model and core/kernel/taskgraph;
- represent every user goal as Task and every executable unit as Node;
- make graph transitions event-sourced and transactionally projected;
- keep agent.Manager temporarily as a compatibility façade over a one-node task.

## 2. P0 — No leases, fencing or durable idempotency

CURRENT:
- Manager mutex prevents concurrent mutation inside one process.
- Windows agent state has a single-writer LockFileEx on writer.lock.
- tool approvals are unique random IDs and concurrent approval is at-most-once in the current process.
- file edits use an expected SHA-256 check before replacement.

Evidence: core/agent/runtime.go:133-143, 357-387; core/agent/runtime_test.go:86-107; core/agent/store_windows.go:38-62; core/agent/workspace_tools.go:229-274, 277-331.

GAP:
- no lease owner, lease expiry, renewal, fencing token or worker epoch;
- no durable idempotency key per side effect;
- no deduplication table across restarts/workers;
- writer.lock is process exclusion, not a task lease.

Repository-wide search found no lease implementation and no fencing implementation in the kernel/runtime path.

RISK:
- once execution is distributed across workers, stale workers can commit after reassignment;
- external APIs or commands can be executed twice after retry/reconciliation unless each tool has explicit idempotency semantics.

IMPLEMENTATION PLAN:
- core/kernel/lease with monotonically increasing fencing tokens;
- unique (node_id, attempt) and (idempotency_key) constraints in durable storage;
- every executor result must carry lease_id + fence and commits must reject stale fences;
- define tool semantics as PURE, IDEMPOTENT, PREPARE_COMMIT, or IRREVERSIBLE.

## 3. P0 — Events exist, but the runtime is not event-sourced

CURRENT:
- Run contains []Event with sequence/kind/message/time.
- events are appended in memory as state transitions happen.
- the entire Run is then serialized to current-run.json.

Evidence: core/agent/runtime.go:84-107, 443-461; core/agent/store_windows.go:126-165.

GAP:
- events are not an append-only source of truth;
- there is no immutable multi-run history;
- there is no expected-version append/CAS;
- no hash chain, signed checkpoint root, actor identity, capability reference or artifact provenance.

RISK:
- valid-looking checkpoint tampering is not cryptographically detectable;
- audit history can be rewritten together with current state;
- forensic reconstruction is limited to the latest run snapshot.

IMPLEMENTATION PLAN:
- core/kernel/eventstore with Append(stream, expectedSeq, events...);
- SQLite/WAL transactionally appends events and updates projections;
- each event stores prev_hash, payload_sha256 and event_hash;
- periodically sign stream roots using core/kernel/trust;
- snapshots are rebuild accelerators only, never authority.

## 4. P0 — Crash recovery is real and good, but stops at “uncertain”

CURRENT:
- pending approvals are invalidated after restart;
- a restart never automatically invokes inference or tools;
- interrupted work with no unrecorded attempt can be explicitly resumed and replanned;
- if status was executing or AttemptedSteps != len(Observations), recovery is uncertain and cannot resume;
- storage failure latches the runtime closed before work proceeds.

Evidence: core/agent/runtime.go:185-228, 285-326, 411-422, 447-461; core/agent/recovery_test.go:67-164.

Windows checkpoint durability:
- temp file;
- fsync;
- MoveFileExW with REPLACE_EXISTING | WRITE_THROUGH.

Evidence: core/agent/store_windows.go:109-165.

Linux store is stronger against pathname races:
- directory fd;
- openat with O_NOFOLLOW;
- owner/mode checks;
- fsync file, renameat, fsync directory.

Evidence: core/agent/store_linux.go:30-86, 127-173.

GAP:
- no reconciliation protocol for uncertain external effects;
- recovery scope is one Run only, not DAG-wide;
- no durable attempt journal with prepare/start/result/verify/commit phases.

RISK:
- after a crash in an external side effect, the safe behavior is currently to stop forever rather than determine outcome.

IMPLEMENTATION PLAN:
- preserve the current “never blind replay” invariant;
- add Reconciler per tool class;
- persist side-effect intent and external idempotency key before execution;
- on restart: reacquire lease → reconcile effect → either record committed result or require explicit operator resolution.

## 5. P0 — No capability broker in the live kernel

CURRENT:
- tools are statically registered by name;
- every tool invocation requires a user approval;
- file tools perform path validation;
- core/chameleon contains an HMAC capability-token prototype for virtual MMIO registers.

Evidence: core/agent/runtime.go:163-181, 557-587; core/agent/workspace_tools.go:166-170; core/chameleon/chameleon.go:36-43, 137-190.

GAP:
- approval does not mint a scoped, revocable kernel capability;
- no grant object binds subject/task/node, resource, rights, expiry, fence and approval provenance;
- chameleon tokens are not imported by cmd/swypik-os and apply only to that controller’s register model.

Evidence: cmd/swypik-os/main_windows.go:25-33.

RISK:
- once process.run is approved, authority expands to the whole user account instead of the specific requested resource/action;
- future plugins can become confused deputies.

IMPLEMENTATION PLAN:
- core/kernel/capability Broker as the only authority mint;
- approvals create short-lived grants, not direct execution permission;
- workers receive opaque capability IDs and brokered handles, never ambient authority;
- revocation on cancel, lease loss, deadline or policy change.

## 6. P0 — process/filesystem/network sandboxing is not a security boundary

CURRENT:
- process.run explicitly declares it runs with the user’s permissions.
- coder creates a Windows Job Object, starts the shell suspended, limits handle inheritance and assigns the process before resuming.
- Job Object currently uses KILL_ON_JOB_CLOSE only.

Evidence: core/agent/workspace_tools.go:334-368; core/coder/shell_windows.go:35-39, 53-63, 90-143.

Good hardening:
- inherited handles are restricted to stdin/stdout;
- cancellation/normal completion kills descendant processes.
- dedicated tests verify descendant reaping and unrelated-handle non-inheritance.

Evidence: core/coder/shell_windows.go:92-123, 132-163; core/coder/shell_windows_test.go:57-112, 161-181.

GAP:
- no restricted token;
- no AppContainer;
- no filesystem ACL sandbox;
- no network default-deny policy;
- no per-task process identity;
- no syscall policy equivalent on Linux.

Repository-wide search found no AppContainer/CreateRestrictedToken/seccomp/cgroup implementation in this runtime.

Filesystem-only tools are also hardening, not confinement:
- safepath explicitly states hostile concurrent mutation still requires handle-relative OS operations and that it is not an OS sandbox.

Evidence: internal/safepath/path.go:1-2, 34-50.

RISK:
- an approved command can read/write outside workspace, access registry/user profile, spawn allowed system tools and use the network;
- path validation does not protect against commands because process.run bypasses it.

IMPLEMENTATION PLAN:
- cmd/swypik-worker as a separate executor process;
- Windows: restricted token/AppContainer + Job limits + allowlisted environment + brokered file handles + network capability policy;
- Linux: user/mount/pid/net namespaces + seccomp + cgroups v2 + brokered FDs;
- default: no filesystem except granted handles, no network, no inherited environment secrets.

## 7. P0 — Secret containment is not end-to-end; environment → process output → prompt is a real path

CURRENT:
- settings.json intentionally excludes the Ilaria token;
- token comes from ILARIA_API_TOKEN or the first line of a token file;
- remote Ilaria is allowed only over authenticated HTTPS; token is not sent to local loopback HTTP;
- planner labels tool observations untrusted data.

Evidence: config/settings.go:14-25, 108-131; core/ilaria/backend.go:41-52, 94-101; core/agent/planner.go:22-38.

Freshly verified leak path:
1. process.run is wired into the live desktop.
   - cmd/swypik-os/main_windows.go:208-215.
2. Windows CreateProcess is called with a nil environment block, so the child inherits the parent process environment.
   - core/coder/shell_windows.go:112-124.
3. process.run returns command output.
   - core/agent/workspace_tools.go:350-368.
4. output is stored verbatim in Observation.
   - core/agent/runtime.go:603-619.
5. all observations are JSON-marshaled into the next planner prompt.
   - core/agent/planner.go:22-38.

Additionally, because process.run has the user’s authority, a command can read the configured token file regardless of workspace path checks.

core/security does not solve this:
- it exposes debugger detection and AES-GCM helper functions;
- no live desktop import exists;
- it has no secret reference, taint tracking, redaction or credential broker.

Evidence: core/security/guard.go:14-30, 51-76; cmd/swypik-os/main_windows.go:25-33.

RISK:
- prompt injection can try to induce an approved command that prints or exfiltrates credentials;
- once printed, the token can enter checkpoint state and model context.

IMPLEMENTATION PLAN:
- core/kernel/secrets stores SecretRef only;
- workers get an allowlisted environment built from scratch;
- secret use occurs through brokered operations, not plaintext env where possible;
- output passes through deterministic redaction/taint policy before event storage or planner context;
- event schema rejects fields marked Secret;
- credential material is backed by DPAPI/CNG/TPM on Windows and OS keyring/TPM on Linux.

## 8. P0 — No independent verifier; “evidence” is a label, not an enforcement plane

CURRENT:
- JSONPlanner both proposes tool calls and produces the final summary.
- completion records only that Ilaria returned a summary and tells the user to inspect recorded evidence.
- core/evidence defines levels such as SIMULATED, VERIFIED and ACTUATED.
- core/actiongraph has a test node named verifier.

Evidence: core/agent/planner.go:18-59; core/agent/runtime.go:518-533; core/evidence/evidence.go:6-27; core/actiongraph/graph_test.go:20-28.

GAP:
- no separate verifier process/role in cmd/swypik-os;
- no EvidenceBundle contract with input/output/artifact digests;
- no policy gate between execution and promotion/commit;
- evidence.Level does not independently prove anything.

RISK:
- the same model path that planned work can accept its own result;
- model-generated summaries can be wrong even when tool evidence exists.

IMPLEMENTATION PLAN:
- cmd/swypik-verifier as a separate low-authority process;
- core/kernel/verifier combines deterministic policy checks and an optional independent model verifier;
- verifier receives immutable evidence references, never executor capabilities;
- PREPARE_COMMIT actions cannot commit until deterministic policy passes;
- model verifier may advise; deterministic policy remains authoritative for security invariants.

## 9. P1 — Deterministic replay is intentionally absent, not partially implemented

CURRENT:
- uncertain executions explicitly block automatic replay.
- completed runs are not replayed on restart.
- this is the correct current safety policy.

Evidence: core/agent/runtime.go:25-27, 99-104, 411-422; core/agent/recovery_test.go:106-140.

GAP:
- no replay log of planner inputs/model identity/tool versions/random seeds;
- no pure-node replay engine;
- no recorded virtual clock;
- no deterministic serialization contract.

RISK:
- debugging scheduler failures and reproducing agent decisions will become difficult as orchestration becomes concurrent.

IMPLEMENTATION PLAN:
- core/kernel/replay;
- classify each node/tool by ReplayClass;
- PURE nodes replay from exact inputs and tool version digest;
- external side effects never replay blindly: use recorded result or Reconciler;
- persist model/provider/version, prompt digest, tool schema digest, environment policy digest and random seed where applicable.

## 10. P1 — Artifact integrity exists; artifact authenticity and safe update do not

CURRENT:
- build.ps1 computes SHA-256 for binaries;
- writes build-manifest.json and SHA256SUMS;
- packages them into the archive.

Evidence: scripts/build.ps1:75-95.

GAP:
- no code signing in the audited build path;
- hash file and binaries can be replaced together by an attacker;
- repository-wide Go search found no updater/canary/self-update implementation in the runtime;
- no signed update manifest, trust root, release channel state, staged health gate or rollback controller.

RISK:
- supply-chain authenticity is not established;
- future self-update could become a privileged arbitrary-code path.

IMPLEMENTATION PLAN:
- core/kernel/artifact for signed manifests and provenance;
- core/kernel/update for staged versions and channel policy;
- never update in place;
- install versioned directories, verify signature + hash before activation, launch canary, require health/verifier gate, atomically switch active version, auto-rollback on failure.

---

# Capability-by-capability audit

## P0 — Durable DAG / task graph

CURRENT:
Single persisted Run; in-memory experimental actiongraph.

Evidence:
- core/agent/runtime.go:90-107, 126-143, 251-282.
- core/actiongraph/graph.go:67-78, 276-292.
- cmd/swypik-os/main_windows.go:25-33, 208-215.

GAP:
No durable Task/Node/Edge entities or scheduler queue.

RISK:
Cannot support multi-agent dependency execution or graph crash recovery.

IMPLEMENTATION PLAN:
Use event-sourced task/node state with durable dependency counters and ready queue projection.

## P0 — Leases / idempotency

CURRENT:
Process-local mutex, one writer lock, one-use approval IDs, SHA precondition on workspace mutation.

Evidence:
- core/agent/runtime.go:133-143, 357-387.
- core/agent/store_windows.go:38-62.
- core/agent/workspace_tools.go:253-266, 298-324.

GAP:
No TTL lease, renewal, fencing, durable idempotency key, dedupe index.

RISK:
Stale worker commits and duplicate external side effects once concurrency/distribution is introduced.

IMPLEMENTATION PLAN:
LeaseStore with monotonic fence; side-effect idempotency keys unique in storage; commits reject stale fences.

## P0 — Event sourcing

CURRENT:
Events are embedded in mutable Run snapshots.

Evidence:
- core/agent/runtime.go:84-107, 443-461.
- core/agent/store_windows.go:137-165.

GAP:
No append-only event store, stream versioning, hash chain, signed root or historical stream.

RISK:
Weak forensic provenance and no authoritative replayable state history.

IMPLEMENTATION PLAN:
Append-only EventStore + derived projections + signed hash-chain roots.

## P0 — Verifier

CURRENT:
Planner instruction requests evidence; core/evidence is a vocabulary only.

Evidence:
- core/agent/planner.go:30-38.
- core/evidence/evidence.go:6-27.

GAP:
No independent executor/verifier authority separation.

RISK:
Planner can self-certify conclusions.

IMPLEMENTATION PLAN:
Dedicated verifier process with read-only evidence access and no execution capabilities.

## P0 — Crash recovery

CURRENT:
Strong single-run checkpoint semantics; uncertain side effects block replay; storage failure fails closed.

Evidence:
- core/agent/runtime.go:185-228, 285-326, 357-422, 447-461.
- core/agent/recovery_test.go:67-164.
- core/agent/store_windows.go:109-165.

GAP:
No graph-wide recovery or reconciliation of external effects.

RISK:
Uncertain run can require manual abandonment rather than safe outcome discovery.

IMPLEMENTATION PLAN:
Journal + Reconciler + lease reacquisition + node-level recovery state machine.

## P1 — Deterministic replay

CURRENT:
Safety is “do not replay uncertain work”.

Evidence:
- core/agent/runtime.go:26-27, 99-104, 411-422.

GAP:
No deterministic replay engine for pure operations.

RISK:
Poor reproducibility at M1 scale.

IMPLEMENTATION PLAN:
ReplayClass plus exact input/tool/model/version digests; pure-only replay.

## P0 — Capability broker

CURRENT:
Approval-gated tool registry; isolated chameleon token prototype.

Evidence:
- core/agent/runtime.go:163-181, 557-587.
- core/chameleon/chameleon.go:36-43, 137-190.

GAP:
No kernel grant lifecycle across filesystem/process/network/device.

RISK:
Approval expands to ambient user authority.

IMPLEMENTATION PLAN:
Broker-minted short-lived grants bound to task/node/lease/resource/rights.

## P0 — Process/filesystem/network sandbox

CURRENT:
File tool path validation; process Job Object lifecycle; restricted handle inheritance.

Evidence:
- internal/safepath/path.go:1-2, 34-50.
- core/coder/shell_windows.go:35-39, 53-63, 92-143.
- core/agent/workspace_tools.go:334-368.

GAP:
No OS identity sandbox or network policy.

RISK:
Approved shell has user-level global filesystem/network authority.

IMPLEMENTATION PLAN:
Separate sandbox worker per isolation domain, default deny, brokered handles, restricted identity.

## P0 — Secrets handling

CURRENT:
Token separated from settings; HTTPS/loopback transport validation.

Evidence:
- config/settings.go:14-25, 95-131.
- core/ilaria/backend.go:41-52, 94-101.

GAP:
No environment scrubbing, secret refs, taint/redaction or output gate.

RISK:
Secret can transit command output → observation → prompt/checkpoint.

IMPLEMENTATION PLAN:
Secret broker + explicit environment allowlist + taint/redaction + no-secret event schema.

## P0 — Side-effect journal

CURRENT:
AttemptedSteps is durably incremented before approved execution; completion observation is written afterward.

Evidence:
- core/agent/runtime.go:357-387, 592-619.

GAP:
No per-action intent/start/result/commit/reconcile record, external correlation ID or compensation record.

RISK:
Crash window is detected but not reconciled.

IMPLEMENTATION PLAN:
SideEffectRecord keyed by intent_id and idempotency_key with explicit phases.

## P1 — Artifact signing

CURRENT:
SHA-256 manifests/checksums only.

Evidence:
- scripts/build.ps1:75-95.

GAP:
No authenticity signature, trust root or provenance signature.

RISK:
Hashes can be maliciously replaced with the artifact.

IMPLEMENTATION PLAN:
Signed artifact manifest; signer key ID; verification before install/execute; explicit degraded mode if hardware-backed key unavailable.

## P1 — Updater / canary

CURRENT:
No updater wired in cmd/swypik-os; build pipeline only stages/moves artifacts.

Evidence:
- cmd/swypik-os/main_windows.go:25-33.
- scripts/build.ps1:75-99.

GAP:
No channel, staged rollout, health gate, activation pointer or rollback.

RISK:
Adding self-update later without a trust design would create a P0 supply-chain surface.

IMPLEMENTATION PLAN:
Versioned install slots, signed manifest, canary launch, verifier/health threshold, atomic activate, automatic rollback.

## P0 — Resource budgets

CURRENT:
Per-run MaxSteps, Duration, ToolTimeout and MaxOutputBytes.
Desktop also sets a process-wide Go soft memory limit.
Windows command Job Object only enables KILL_ON_JOB_CLOSE.

Evidence:
- core/agent/runtime.go:108-113, 145-161, 540-604.
- cmd/swypik-os/main_windows.go:118-120, 249-253.
- core/coder/shell_windows.go:53-63.

GAP:
No hard per-task CPU, RAM, process-count, IO, GPU or network limits/accounting.

RISK:
One approved tool can consume host resources until timeout or OS pressure intervenes.

IMPLEMENTATION PLAN:
Budget object persisted per node; worker enforces OS hard limits and reports measured usage.

## P1 — Concurrency / races

CURRENT:
- Manager state is mutex-protected.
- approval concurrency has an explicit at-most-once test.
- shell handle-inheritance setup is serialized.
- fresh race suite is green.

Evidence:
- core/agent/runtime.go:133-143, 357-387.
- core/agent/runtime_test.go:86-107.
- core/coder/shell_windows.go:26-28, 113-124.

Fresh race command result:
8 packages OK, 0 failed.

GAPS / RISKS:
1. Workspace write “CAS” is not atomic against another process:
   - read target;
   - compare hash;
   - later rename replacement.
   A concurrent external editor can change the file between check and replace.
   Evidence: core/agent/workspace_tools.go:249-266, 298-324.

2. safepath explicitly acknowledges pathname TOCTOU under hostile concurrent mutation.
   Evidence: internal/safepath/path.go:1-2.

3. core/actiongraph exposes GraphContext.SharedState directly while executing active nodes concurrently. SetState/GetState are locked, but callers can and tests do access the map directly. This API can race if promoted to real concurrent use.
   Evidence: core/actiongraph/graph.go:35-56, 151-184; core/actiongraph/graph_test.go:13-24.

4. Checkpoints in actiongraph shallow-copy interface{} values; mutable nested state can alias snapshots.
   Evidence: core/actiongraph/graph.go:276-287.

IMPLEMENTATION PLAN:
- do not promote current actiongraph as the M1 authority;
- immutable typed node inputs/results;
- handle-relative file broker with file identity/version checks;
- kernel transitions through transactional event store, not shared mutable maps;
- add adversarial race/fault tests with external file mutation and stale worker commits.

---

# M1 concrete Go architecture

## Package layout

Recommended canonical packages:

    core/kernel/model
    core/kernel/eventstore
    core/kernel/taskgraph
    core/kernel/scheduler
    core/kernel/lease
    core/kernel/journal
    core/kernel/capability
    core/kernel/secrets
    core/kernel/budget
    core/kernel/replay
    core/kernel/verifier
    core/kernel/evidence
    core/kernel/artifact
    core/kernel/update
    core/kernel/trust
    core/kernel/executor
    core/kernel/executor/windows
    core/kernel/executor/linux

Executables:

    cmd/swypik-worker
    cmd/swypik-verifier

Compatibility adapter during migration:

    core/agent/kernel_adapter.go

The existing core/actiongraph should either be retired or reduced to a planning/front-end abstraction that emits durable TaskGraph specifications into core/kernel/taskgraph. It must not own authoritative execution state.

## Core interfaces

### Event store

    type EventStore interface {
        Append(ctx context.Context, streamID string, expectedSeq uint64, events ...Event) (newSeq uint64, err error)
        Load(ctx context.Context, streamID string, afterSeq uint64, limit int) ([]Event, error)
        LoadSnapshot(ctx context.Context, streamID string) (Snapshot, error)
        SaveSnapshot(ctx context.Context, snapshot Snapshot) error
        InTx(ctx context.Context, fn func(Tx) error) error
    }

Invariant:
Append is compare-and-swap on expectedSeq. A stale scheduler cannot silently overwrite state.

### Lease store

    type LeaseStore interface {
        Acquire(ctx context.Context, nodeID, owner string, ttl time.Duration) (Lease, error)
        Renew(ctx context.Context, leaseID string, fence uint64, ttl time.Duration) (Lease, error)
        Release(ctx context.Context, leaseID string, fence uint64) error
        Current(ctx context.Context, nodeID string) (Lease, error)
    }

Lease fields:
- lease_id
- node_id
- owner
- fence uint64
- acquired_at
- expires_at

Fence must monotonically increase on every new ownership epoch.

### Capability broker

    type Broker interface {
        Grant(ctx context.Context, req GrantRequest) (Grant, error)
        Authorize(ctx context.Context, grantID string, action ActionDescriptor) error
        Revoke(ctx context.Context, grantID string, reason string) error
    }

GrantRequest binds:
- task_id/node_id
- lease fence
- approval/event reference
- resource identity
- rights
- expiry
- budget reference

No raw secret goes into Grant.

### Side-effect journal

    type Journal interface {
        Prepare(ctx context.Context, intent Intent) (IntentRecord, error)
        MarkStarted(ctx context.Context, intentID string, fence uint64) error
        RecordResult(ctx context.Context, intentID string, result ResultRef) error
        Commit(ctx context.Context, intentID string, verification VerificationRef) error
        MarkUncertain(ctx context.Context, intentID string, reason string) error
        Reconcile(ctx context.Context, intentID string) (ReconcileResult, error)
    }

Every external effect has:
- intent_id
- node_id / attempt
- idempotency_key
- tool + tool_version_digest
- input_digest
- grant_id
- lease fence
- phase
- external correlation ID when available

### Executor

    type Executor interface {
        Execute(ctx context.Context, req ExecuteRequest) (ExecuteResult, error)
    }

ExecuteRequest contains references/digests and opaque grants, not ambient credentials.

### Verifier

    type Verifier interface {
        Verify(ctx context.Context, input VerificationInput) (Verdict, error)
    }

Verifier runs in a separate process and has no filesystem/process/network write capabilities.

### Reconciler

    type Reconciler interface {
        Reconcile(ctx context.Context, intent IntentRecord) (Outcome, error)
    }

Mandatory for IRREVERSIBLE/EXTERNAL tools before automatic retry.

---

# M1 node state machine

Canonical node states:

    PENDING
      -> READY
      -> LEASED
      -> PREPARING
      -> EXECUTING
      -> VERIFYING
      -> COMMITTING
      -> SUCCEEDED

Retry path:

    EXECUTING/VERIFYING
      -> RETRY_WAIT
      -> READY

Crash/ambiguity path:

    EXECUTING
      -> UNCERTAIN
      -> RECONCILING
      -> SUCCEEDED | RETRY_WAIT | OPERATOR_REQUIRED | FAILED

Other terminal states:

    FAILED
    CANCELLED
    BLOCKED

Critical invariants:
1. A node may execute only with a live lease and matching fence.
2. Capability grant is bound to that fence.
3. PREPARING must durably create the side-effect Intent before the worker starts.
4. COMMITTING rejects stale fences.
5. IRREVERSIBLE tools are never automatically re-executed from UNCERTAIN.
6. READY is derived only when all dependency predicates are satisfied.
7. A verifier cannot mint or use executor capabilities.

---

# Storage format

Recommended source of truth: one local kernel SQLite database using WAL, synchronous durability and explicit schema migrations. The release build currently has CGO disabled, so the chosen SQLite driver must satisfy the CGO-free release constraint or the build policy must be intentionally changed by ADR.

File:

    <data-dir>/kernel/kernel.db

Core tables:

    schema_migrations(
        version INTEGER PRIMARY KEY,
        applied_at_ns INTEGER NOT NULL,
        checksum BLOB NOT NULL
    )

    streams(
        stream_id TEXT PRIMARY KEY,
        seq INTEGER NOT NULL,
        head_hash BLOB NOT NULL
    )

    events(
        event_id INTEGER PRIMARY KEY AUTOINCREMENT,
        stream_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        task_id TEXT NOT NULL,
        node_id TEXT,
        event_type TEXT NOT NULL,
        actor_type TEXT NOT NULL,
        actor_id TEXT NOT NULL,
        created_at_ns INTEGER NOT NULL,
        payload BLOB NOT NULL,
        payload_sha256 BLOB NOT NULL,
        prev_hash BLOB NOT NULL,
        event_hash BLOB NOT NULL,
        UNIQUE(stream_id, seq)
    )

    tasks(
        task_id TEXT PRIMARY KEY,
        state TEXT NOT NULL,
        version INTEGER NOT NULL,
        goal_digest BLOB NOT NULL,
        policy_digest BLOB NOT NULL,
        deadline_ns INTEGER,
        created_at_ns INTEGER NOT NULL,
        updated_at_ns INTEGER NOT NULL
    )

    nodes(
        node_id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        state TEXT NOT NULL,
        version INTEGER NOT NULL,
        attempt INTEGER NOT NULL,
        replay_class TEXT NOT NULL,
        input_digest BLOB,
        output_digest BLOB,
        deadline_ns INTEGER
    )

    edges(
        task_id TEXT NOT NULL,
        from_node TEXT NOT NULL,
        to_node TEXT NOT NULL,
        predicate TEXT NOT NULL,
        PRIMARY KEY(task_id, from_node, to_node)
    )

    leases(
        node_id TEXT PRIMARY KEY,
        lease_id TEXT NOT NULL,
        owner TEXT NOT NULL,
        fence INTEGER NOT NULL,
        expires_at_ns INTEGER NOT NULL
    )

    intents(
        intent_id TEXT PRIMARY KEY,
        node_id TEXT NOT NULL,
        attempt INTEGER NOT NULL,
        idempotency_key TEXT NOT NULL UNIQUE,
        phase TEXT NOT NULL,
        lease_fence INTEGER NOT NULL,
        tool TEXT NOT NULL,
        tool_version_digest BLOB NOT NULL,
        input_digest BLOB NOT NULL,
        external_ref TEXT,
        result_digest BLOB
    )

    capability_grants(
        grant_id TEXT PRIMARY KEY,
        node_id TEXT NOT NULL,
        lease_fence INTEGER NOT NULL,
        resource_type TEXT NOT NULL,
        resource_id TEXT NOT NULL,
        rights BLOB NOT NULL,
        expires_at_ns INTEGER NOT NULL,
        revoked_at_ns INTEGER
    )

    artifacts(
        artifact_id TEXT PRIMARY KEY,
        sha256 BLOB NOT NULL,
        size INTEGER NOT NULL,
        media_type TEXT NOT NULL,
        producer_node TEXT NOT NULL,
        manifest BLOB NOT NULL,
        signer_key_id TEXT,
        signature BLOB
    )

    snapshots(
        stream_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        state BLOB NOT NULL,
        state_sha256 BLOB NOT NULL,
        PRIMARY KEY(stream_id, seq)
    )

Event hash:

    SHA256(
        prev_hash ||
        stream_id ||
        seq ||
        event_type ||
        actor_type ||
        actor_id ||
        created_at_ns ||
        payload_sha256
    )

The payload’s exact stored bytes are hashed separately. This avoids relying on JSON canonicalization for the chain.

Signed audit:
- sign periodic stream head hashes, not necessarily every row;
- signature metadata contains key_id, algorithm, signed_at;
- old unsigned imported records are explicitly marked legacy_unsigned.

---

# Sandbox design

## Windows

Worker creation must add to the good lifecycle controls already in core/coder:

1. create restricted token or AppContainer identity;
2. create process suspended;
3. construct environment from an allowlist, never inherit parent environment;
4. pass only explicitly brokered handles using PROC_THREAD_ATTRIBUTE_HANDLE_LIST;
5. assign Job Object before resume;
6. enforce:
   - process count;
   - memory cap;
   - CPU cap;
   - wall deadline;
7. filesystem access through brokered handles / explicit ACL grant;
8. network denied by default; only explicit network grant enables outbound scope;
9. worker has no access to kernel database or secret store.

The existing handle-list and suspended-start logic in core/coder/shell_windows.go:90-143 is reusable.

## Linux

Per isolation domain:
- user namespace;
- mount namespace;
- pid namespace;
- network namespace;
- seccomp allowlist;
- cgroups v2 cpu.max, memory.max, pids.max, io.max;
- bind mounts or brokered FDs for granted files;
- no inherited secret environment.

---

# Secret architecture

Secret values never appear in:
- Task Goal;
- Event payload;
- Observation;
- model prompt;
- application log;
- artifact manifest.

Use:

    type SecretRef struct {
        ID      string
        Purpose string
    }

Tools that need a secret receive SecretRef. The broker performs the authenticated action or injects the secret only into a narrowly scoped child channel that is excluded from stdout/stderr and event serialization.

Add a deterministic output gate before persistence:
- exact known-secret redaction;
- structured secret-field stripping;
- entropy/pattern detectors as defense in depth;
- policy violation event containing only metadata, never the secret.

---

# Artifact signing and update/canary

## Artifact manifest

Each releasable artifact gets:

- artifact name/version/platform;
- SHA-256;
- byte size;
- build commit;
- build toolchain digest;
- dependency/SBOM reference;
- build policy digest;
- signer key ID;
- signature.

Build script may still generate SHA256SUMS, but release acceptance requires signature verification against a pinned trust root.

## Safe updater

Recommended layout:

    <install>/versions/<version>/...
    <install>/state/active.json
    <install>/state/previous.json

Flow:
1. download candidate into staging;
2. verify signed manifest and every artifact hash;
3. never execute from download directory;
4. install into immutable version directory;
5. launch candidate as canary with restricted privileges;
6. perform health + verifier checks;
7. atomically switch active version pointer;
8. monitor startup contract;
9. rollback to previous on failure;
10. record update events in kernel audit stream.

No in-place binary replacement.

---

# Resource governance

Persist Budget with each node:

    type Budget struct {
        WallTime       time.Duration
        CPUTime        time.Duration
        MemoryBytes    uint64
        ProcessCount   uint32
        ReadBytes      uint64
        WriteBytes     uint64
        NetworkTxBytes uint64
        NetworkRxBytes uint64
        GPUTime        time.Duration
        MaxOutputBytes uint64
    }

Current Limits can map directly into the first migration:
- Duration -> WallTime
- ToolTimeout -> per-action WallTime
- MaxOutputBytes -> MaxOutputBytes
- MaxSteps remains scheduler policy, not OS budget

Enforcement must be external to the worker where possible so a compromised worker cannot raise its own limits.

---

# Migration path from current runtime

## Phase 0 — Preserve current safety invariants

Do not remove:
- explicit per-tool approval;
- consumed-approval-before-execute checkpoint;
- uncertain => no automatic replay;
- fail-closed checkpoint errors;
- output limits.

These are good invariants and should become kernel rules.

## Phase 1 — Introduce event store under the existing UI/API

Keep desktop.Controller and the current agent.Manager surface.

Implement a kernel-backed adapter:
- Start creates a Task + one Node.
- Snapshot reads task projection.
- Decide writes ApprovalGranted event and mints a capability grant.
- Resume transitions INTERRUPTED/RECONCILABLE state under policy.

No multi-node concurrency yet.

## Phase 2 — Migrate current-run.json

On startup:
1. acquire the legacy store lock;
2. validate the legacy Run using current validation rules;
3. compute SHA-256 of exact legacy file bytes;
4. append LegacyRunImported with trust_level=legacy_unsigned;
5. create equivalent task/node projection;
6. commit database transaction;
7. preserve the old file as forensic legacy state; do not silently reinterpret it as signed history.

If no legacy file exists, start clean.

After one compatibility release, legacy store becomes read-only migration input only.

## Phase 3 — Side-effect journal + leases

Move all execution through:
- lease acquire;
- durable Intent prepare;
- capability grant;
- worker execution;
- result record;
- verifier;
- commit.

Keep a single local worker initially. Prove crash semantics before adding parallelism.

## Phase 4 — Sandbox process.run first

process.run is the highest-authority current tool, so move it to cmd/swypik-worker before file tools.

Environment must become explicit allowlist.

Then move workspace writes to handle-relative brokered operations so file modification can be staged/verified/committed.

## Phase 5 — Independent verifier

Add deterministic verifier first:
- hash/output schema;
- expected file diff;
- test command exit evidence;
- policy checks.

Then optionally add a separate model verifier.

## Phase 6 — Durable DAG scheduler

Only after leases/journal/sandbox/verifier are proven:
- enable multiple READY nodes;
- bounded worker pool;
- dependency fan-out/fan-in;
- retry policy;
- cancellation propagation;
- deadline inheritance.

## Phase 7 — Signed artifacts and canary updater

Do not allow autonomous self-update before artifact trust root and rollback are independently tested.

---

# P0 / P1 / P2

## P0 — required for M1 Autonomous Kernel

1. Durable event store + Task/Node/Edge state machine.
2. Side-effect journal with explicit execution semantics.
3. Lease manager + fencing + durable idempotency keys.
4. Capability broker.
5. Real sandbox worker, starting with process.run.
6. Secret broker + environment scrubbing + output redaction gate.
7. Independent verifier/evidence contract.
8. Per-task resource budgets and external enforcement.
9. Graph-aware crash recovery/reconciliation.
10. Fault-injection suite for every transition and crash window.

## P1 — hardening / trustworthy distribution

1. Deterministic replay for PURE operations.
2. Signed artifact manifests + trust root.
3. Safe updater/canary/rollback.
4. Handle-relative filesystem broker and atomic conflict semantics.
5. Hardened Windows checkpoint/store ACL model or replacement by kernel DB.
6. Actiongraph redesign/removal of shared mutable interface{} state.
7. Metrics: duplicate effect rate, stale-fence reject count, recovery latency, budget violations, verifier rejection rate.

## P2 — after local M1 is proven

1. Distributed/cloud scheduler and remote lease ownership.
2. Remote attestation for workers.
3. Multi-host artifact/cache replication.
4. More advanced deterministic simulation/time virtualization.
5. Self-improvement promotion only through signed candidate → benchmark → verifier → canary → rollback pipeline.

---

# Recommended implementation order

1. **Freeze the execution semantics ADR**: state machine, event types, replay classes, failure semantics. Do not claim exactly-once for arbitrary external effects.
2. **Build EventStore + projections** and put the existing one-run flow on top of it.
3. **Add side-effect Intent journal + Reconciler contract** while preserving current uncertain/no-replay behavior.
4. **Add leases/fencing/idempotency** even with one worker, then fault-test stale ownership.
5. **Add capability + secret broker** so approvals mint scoped authority.
6. **Move process.run into a sandbox worker** with clean environment and hard budgets.
7. **Add independent verifier** and staged commit for filesystem changes.
8. **Expand to durable DAG scheduling** with bounded concurrency only after the above invariants pass.
9. **Add signed artifacts and canary updater**; never give self-update an unsigned path.
10. **Enable deterministic replay for PURE nodes and later distributed execution**, backed by the same event/lease/journal contracts.

Fault-injection should run continuously from step 2 onward, not be deferred to the end.

---

# Final assessment

SwypikOS is not starting from zero. The current core/agent code has several valuable reliability properties that should be preserved:
- explicit approval;
- strict structured planner output;
- bounded execution;
- atomic checkpointing;
- fail-closed persistence;
- safe “uncertain” recovery semantics;
- descendant-process cleanup;
- handle-inheritance hardening;
- path filtering for direct file tools.

But the security model today is still **approval + path hardening around an ambient-authority process**, not an autonomous-kernel security boundary.

The M1 architecture should therefore avoid incrementally stretching core/agent into a distributed scheduler. The safer migration is:

**retain its good invariants → place them behind a durable event-sourced kernel → add journal/leases/capabilities/sandbox/verifier → only then introduce DAG concurrency and autonomous promotion.**

That ordering minimizes the chance that multi-agent parallelism amplifies today’s authority, secret-handling and recovery gaps.
