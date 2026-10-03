# Worker 5 — supervisor v3 integrator and independent end-to-end verification

State: RUNNING

## Workspace / branch

- MCP access verified for `E:\\nexus`.
- Branch observed at start: `codex/nexus-supervisor-v3`.
- Existing modified and untracked work is preserved. No branch/index/history operation, reset/clean, stage/commit, push, deploy or publication will be performed.
- Read before edits: root/product `AGENTS.md`, `docs/milestones/supervisor-v2.md`, coordination README, and current worker reports.
- Worker 1 and Worker 3 have since reached explicit `State: COMPLETE` and handed off their files. Worker 2 and Worker 4 remain `RUNNING`; their claimed files remain off-limits.

## Exact claimed files

Worker 5 exclusively claims only these files initially:

- `scripts/verify-supervisor-v3.py` (new)
- `scripts/verify-supervisor-v3.ps1` (new)
- `scripts/verify-supervisor-v3.sh` (new)
- `docs/milestones/supervisor-v3.md` (new)
- `docs/coordination/chrome-2026-10-01/worker-5.md`

No Worker 1–4 file, shared CLI/CI file, generated mirror, or existing common script is claimed yet. Any post-handoff takeover will be listed here before the first edit.

## Accepted handoffs / exact post-handoff takeover

### Worker 1 — COMPLETE

Worker 1 explicitly handed off its Swyp continuation implementation and public
wire. Worker 5 accepts the released Worker 1 files for integration/review:

- `swyp/internal/coreir/continuation.go`
- `swyp/internal/coreir/continuation_test.go`
- `swyp/internal/coreir/execute.go`
- `swyp/internal/coreir/execute_effects.go`
- `swyp/cmd/swyp/core_broker.go`
- `swyp/cmd/swyp/core_broker_test.go`
- `swyp/protocol/continuation/protocol.go`
- `swyp/protocol/continuation/protocol_test.go`
- `swyp/specs/continuation-v1.schema.json`

No edit to those released source files is planned unless independent integration
evidence finds a defect. For the public cross-product contract integration,
Worker 5 additionally claims these exact files before editing/creating them:

- `swypik-os/generated/swypcontinuation/protocol.go` (new exact public helper mirror)
- `swypik-os/generated/swypcontinuation/continuation-v1.schema.json` (new exact schema mirror)
- `scripts/verify-contracts.ps1` (existing common drift gate)

Worker 1's final public v1 wire is authoritative. Worker 5 will not import
`swyp/internal/*` from SwypikOS.

### Worker 3 — COMPLETE

Worker 3 explicitly released the complete host-owned cache package. Worker 5
accepts takeover of these exact files for integration, independent verification
and any post-handoff fixes:

- `swypik-os/internal/plancache/identity.go`
- `swypik-os/internal/plancache/verify.go`
- `swypik-os/internal/plancache/cache.go`
- `swypik-os/internal/plancache/lock_windows.go`
- `swypik-os/internal/plancache/lock_unix.go`
- `swypik-os/internal/plancache/cache_test.go`
- `swypik-os/internal/plancache/benchmark_test.go`

The final eviction contract is deterministic oldest-publication first
(`PublishedUnixNS`, then key); successful reads do not update access order.
No cache file is being changed merely to restyle that final contract.

### Worker 4 — COMPLETE

Worker 4 explicitly handed off the optional real-counter energy sampler. Worker 5
accepts takeover of these exact files for integration, independent verification
and any post-handoff fixes:

- `swypik-os/core/resource/energy.go`
- `swypik-os/core/resource/energy_linux.go`
- `swypik-os/core/resource/energy_windows.go`
- `swypik-os/core/resource/energy_other.go`
- `swypik-os/core/resource/energy_test.go`
- `swypik-os/core/resource/energy_linux_test.go`
- `swypik-os/core/resource/energy_windows_test.go`

The measured scope remains the actual platform counter scope. The current
Windows host and WSL2 capability probes both reported
`unavailable/no_counter`; no joule value may be synthesized.

### Not released

No worker-owned v3 implementation file remains unreleased.

### Worker 2 — COMPLETE

Worker 2 explicitly released all of its claimed Supervisor/CLI files. Worker 5
accepts takeover of these exact files before any integration edit:

- `swypik-os/core/supervisor/continuation.go`
- `swypik-os/core/supervisor/continuation_test.go`
- `swypik-os/core/supervisor/ledger.go`
- `swypik-os/core/supervisor/model.go`
- `swypik-os/core/supervisor/policy.go`
- `swypik-os/core/supervisor/recovery.go`
- `swypik-os/core/supervisor/recovery_test.go`
- `swypik-os/core/supervisor/supervisor.go`
- `swypik-os/core/supervisor/supervisor_test.go`
- `swypik-os/cmd/plan-supervisor/config.go`
- `swypik-os/cmd/plan-supervisor/engine.go`
- `swypik-os/cmd/plan-supervisor/engine_test.go`
- `swypik-os/cmd/plan-supervisor/main.go`
- `swypik-os/cmd/plan-supervisor/wire.go`

Worker 2's explicit end-to-end transport cap is preserved: current
`planprocess.MaxLineBytes` limits CLI continuation frames to 2 MiB even though
the public Swyp protocol supports 9 MiB. Worker 5 will not widen that transport
without an independently verified bounded-transport change.

With every v3 owner now COMPLETE, Worker 5 also claims these common integration
files before editing them:

- `.github/workflows/ci.yml`
- `scripts/verify-workspace.ps1`
- `scripts/verify-contracts.ps1` (already claimed above after Worker 1 handoff)

Worker 5 additionally claims these exact integration files before their first
edit/create:

- `swypik-os/cmd/plan-supervisor/plan_cache.go` (new)
- `swypik-os/cmd/plan-supervisor/plan_cache_test.go` (new)
- `swypik-os/cmd/plan-supervisor/energy_metrics.go` (new)
- `ilaria/generated/swypeffects/protocol.go` (existing stale helper mirror)
- `swypik-os/generated/swypeffects/protocol.go` (existing stale helper mirror)

The effects DTO/schema source is not being changed: its generated DTOs already
contain the legacy records and the drift gate shows only the public helper
mirrors are stale. The two helper mirrors will be synchronized byte-for-byte
from canonical `swyp/protocol/effects/protocol.go`.

## Integration harness contract published early

The v3 harness will be a black-box three-product integration gate. It will build/use worker-specific temporary outputs and invoke public executables/protocols only:

1. Swyp public executables required by the supervisor path (three executable invocations as established by the integrated public CLI contract);
2. SwypikOS `plan-supervisor`;
3. Ilaria `evidence-check`.

The Python harness is the portable orchestrator. PowerShell and shell wrappers provide platform setup only; they must not mutate global PATH/environment or system configuration.

Planned report format is JSON to stdout with a stable top-level shape:

```json
{
  "version": 3,
  "platform": "...",
  "artifacts_dir": "...",
  "checks": [
    {
      "name": "...",
      "status": "PASS|FAIL|SKIP",
      "reason": "...",
      "evidence": {}
    }
  ],
  "resources": {
    "containment": "...",
    "energy": {
      "status": "available|unavailable",
      "scope": "...",
      "value": null
    }
  }
}
```

A scenario is never reported `PASS` from another worker's assertion alone. Required observable evidence includes exit status plus durable/public output proving the claimed invariant. Unsupported Linux delegation or energy measurement is reported `SKIP`/unavailable with the concrete reason, never synthesized.

## Required adversarial matrix

The harness/milestone will cover, once the owners hand off stable APIs:

- suspend/crash/resume equals uninterrupted execution;
- resolved effect provider is not replayed;
- altered continuation and changed module/run/policy/fence fail closed;
- missing result/payload/evidence fails closed;
- cache hit plus source/dependency/compiler/protocol/policy invalidation and hostile/corrupt cache entry;
- cache quota/eviction bounds;
- strict Job/cgroup containment remains active;
- cancellation kills/contains descendants;
- persistent verifier reuse;
- bounded idle resource use;
- optional real energy counter with truthful scope or explicit unavailable state.

## Current coordination status

- Worker 1: `COMPLETE`; continuation v1 + broker transport handed off and released.
- Worker 2: `COMPLETE`; authenticated persistence/resume + CLI transport handed off and released.
- Worker 3: `COMPLETE`; immutable host snapshot cache handed off and released.
- Worker 4: `COMPLETE`; optional real-counter energy API handed off and released.

### Active integration request / blocker

Worker 1's currently published strict checkpoint contains the required fields
`type`, `state_version`, `fuel_limit`, `steps_used`, `max_effect_bytes`,
`effect_bytes`, `effect_request_hash` and `effect_result_hash` in addition
to run/module/entry/cursor/state identity. The currently visible Worker 2
`ContinuationEnvelope` still models only the older subset. Because Worker 2
uses strict JSON decoding, those two current shapes are incompatible.

Worker 5 will not edit Worker 2's active files. Worker 2 should reconcile its
public envelope mirror with Worker 1's final v1 contract before handoff, without
importing `swyp/internal/*`.

Worker 3's report currently promises deterministic
`oldest-access-record first` eviction. The visible implementation in
`internal/plancache/cache.go` currently records `PublishedUnixNS` and chooses
the minimum publication timestamp/key; successful `Get` does not update an
access record. Worker 3 should either implement the published access-order
contract or narrow the handoff documentation/tests to the actual deterministic
publication-order policy. Worker 5 will not modify the active cache files.

Worker 4's current in-progress Windows source contains compile-time name drift:
`windowsReadEMIMeasurements` returns `errWindowsEMIOutputSize` although the
declared measurement-size sentinel is currently
`errWindowsEMIMeasurementSize`, and the v2 metadata parser calls
`windowsValidEMIChannelHeader` while the visible helpers are
`windowsValidEMIChannelLayout` / `windowsValidSupportedEMIChannelHeader`.
This is only an observation of a `RUNNING` file; Worker 4 owns the fix and its
final compile/test evidence before handoff.

Subsequent owner-side job evidence changed the picture:

- Worker 1's latest visible Windows `go vet` and full `go test` jobs both
  exited 0. A Windows `go test -race` attempt exited before tests because CGO
  was disabled; this is a host/toolchain limitation, and Worker 5 has already
  proven WSL Linux is available for the required race gate.
- A later SwypikOS full gate compiled `core/resource` successfully, so the
  transient Worker 4 symbol drift above was fixed before that build. The same
  gate passed `internal/plancache`.
- That SwypikOS gate still failed in Worker 2-owned
  `core/supervisor/continuation_test.go`: crash/resume and adversarial
  continuation tests all stopped at `invalid explicit authenticated continuation policy`.
  Independent read-only root-cause review found the current validator uses
  `strings.ContainsAny(policy.KeyID, `/\\\\\\x00`)` as a raw string.
  That character set includes literal `x` and `0`; therefore the fixture key
  `fixture-continuation-key` is rejected solely because it contains `x`.
  The owner should test slash/backslash/NUL explicitly rather than treating the
  textual escape sequence as the character set.

These are observations of owner-side jobs while reports remain `RUNNING`;
they are not handoff acceptance and Worker 5 does not edit those files yet.

Post-handoff independent review found one pre-existing common-contract blocker:

- `scripts/verify-contracts.ps1` currently fails before the newly added
  continuation mirror check because canonical
  `swyp/protocol/effects/protocol.go` contains a legacy
  `ContinuationCheckpoint/ContinuationAck` helper implementation that is not
  mirrored in `ilaria/generated/swypeffects/protocol.go` or
  `swypik-os/generated/swypeffects/protocol.go`.
- Repository-wide symbol search found no production consumer of that legacy
  effects continuation API; only its own Swyp protocol tests reference it.
  Supervisor v3 uses Worker 1's dedicated
  `swyp/protocol/continuation` contract instead.
- This common/generated cleanup is not applied while Worker 2 is still
  `RUNNING`, because its CLI is actively integrating continuation transport.

## Checks

Pre-handoff harness checks:

- `python -m py_compile scripts\\verify-supervisor-v3.py` — PASS.
- PowerShell parser over `scripts\\verify-supervisor-v3.ps1` — PASS.
- `bash -n scripts/verify-supervisor-v3.sh` — PASS.
- `powershell -NoProfile -ExecutionPolicy Bypass -File .\\scripts\\verify-supervisor-v3.ps1 -AllowSkips` — exit 0.
  - fresh worker-local temp builds of `swyp.exe`, `plan-supervisor.exe`, `evidence-check.exe`;
  - established three-product v2 integration — PASS;
  - Windows containment reported `windows_job_object`;
  - persistent verifier service gate — PASS;
  - observed two-second idle CPU counter deltas: supervisor 0 ns, verifier 0 ns;
  - v3 continuation/cache/energy probes — SKIP because their owners remain `RUNNING`.

This is a harness/baseline result, not a v3 completion claim.

Independent handoff verification:

- Worker 1: `go test -count=1 ./internal/coreir ./protocol/continuation ./cmd/swyp` — PASS
  (`coreir 0.757s`, `protocol/continuation 0.368s`, `cmd/swyp 13.882s`).
- Worker 1 public mirror: canonical continuation Go helper and JSON schema were
  copied byte-for-byte into `swypik-os/generated/swypcontinuation`;
  independent Python byte comparison — PASS.
- Generated continuation package: `go test -count=1 ./generated/swypcontinuation`
  — PASS/compiles, no test files.
- Worker 3: `go test -count=1 ./internal/plancache` — PASS, `1.490s`.
- Worker 4: `go test -count=1 ./core/resource` — PASS, `0.348s`.
- Common contract gate: FAIL at the pre-existing legacy effects helper drift
  described above. The continuation mirror itself is byte-identical; milestone
  completion remains blocked until the common drift gate is repaired and rerun.

Worker 2 owner-side latest visible jobs now show `go vet` and full SwypikOS
`go test` exit 0, but the report has not yet transitioned from `RUNNING`.
Those successful jobs do not release Worker 2's files.

Environment capability probe:

- WSL2 Ubuntu is present, kernel `6.18.40.1-microsoft-standard-WSL2`.
- `/sys/fs/cgroup` reports `cgroup2fs`.
- `systemd --user` is running and `systemd-run` is available.
- `scripts/with-delegated-cgroup.sh env` successfully created a user-owned
  delegated scope and exported a writable `NEXUS_TEST_CGROUP_ROOT`, without
  sudo/admin or global cgroup changes.

Therefore real Linux cgroup/race gates are locally available after the v3
handoffs stabilize.

## Handoff / takeover rule

Before editing any file released by Worker 1–4, this report will first record:
- the worker's `State: COMPLETE`;
- the explicit handed-off files/API;
- the exact files Worker 5 is taking over.

Worker 5 will not modify another worker report.
