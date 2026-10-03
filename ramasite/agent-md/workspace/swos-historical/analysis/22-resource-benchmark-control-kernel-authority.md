# SwypikOS — reproducible resource benchmark + durable resource authority

Date: 2026-09-30  
Workspace: `E:\nexus\swypik-os`  
Branch/HEAD observed during this pass: `agent/nexus-clean-swyp-fast` / `a5a8175`  
Repository state: intentionally dirty from the ongoing root/Ilaria/Swyp/SwypikOS migration. No reset, clean, stash, commit or push was performed.

## 1. Milestone completed

This pass completed the next block from handoff 21:

1. automated the Windows low-resource benchmark with startup-peak and steady-idle phases;
2. corrected the benchmark so steady state is lifecycle/quiescence based instead of a guessed fixed delay;
3. made adaptive Resource Governor transitions observable through an explicit sink;
4. persisted resource authority in the Control Kernel append-only journal;
5. made the durable resource snapshot available to a valid Compute Fabric lease fence;
6. exposed optional Swarm authority injection without giving Swarm ownership of the Control Kernel journal.

## 2. Reproducible benchmark harness

New:
- `scripts/benchmark-resources.ps1`

Behavior:
- Windows-only and fail-closed;
- builds a dedicated optimized Win32 GUI binary unless `-Executable` is supplied;
- refuses a non-empty output directory rather than contaminating a run;
- creates fresh data/workspace directories per run;
- samples only the PID it created;
- never kills unrelated SwypikOS processes;
- records raw startup and idle samples per run;
- records Working Set, private commit, process CPU, thread count and handle count;
- records window-ready, font-warm and steady-start timestamps;
- asks the benchmark window to close cleanly and only force-stops its own PID on failure.

Important correction discovered during v6:
- `ui/engine/native_window_windows.go` performs asynchronous font raster warm-up;
- a fixed 4-second delay could classify remaining startup work as "steady idle" on a busy host;
- the benchmark now waits for the native lifecycle log marker `Fonts warmed`, then requires a 3-second post-warm quiescence window before measuring steady idle;
- this also covers the existing 2-second idle-backbuffer release timer.

The lifecycle correction is in the benchmark harness only; the UI warm-up cleanup itself was inspected and is deterministic.

## 3. Authoritative final resource measurement

Use **v7** as the current measurement. v5/v6 were useful exploratory runs, but v7 is the first report with explicit lifecycle/quiescence separation.

Report:
- `E:\CEO\swypik-resource-bench-v7\resource-results.json`
- benchmark executable SHA-256: `754214C0B1F9F16FB61F4BA05F77C5C21F066A212F4BECEF5A5809BA3606F81B`
- 8 logical processors
- 3 runs/profile
- startup minimum: 4 s
- post-font quiescence: 3 s
- steady idle window: 5 s
- sampling interval: 100 ms

### balanced

Median:
- startup peak Working Set: **31.852 MiB**
- maximum startup peak Working Set: **63.500 MiB**
- startup peak private commit: **56.582 MiB**
- window ready: **116 ms**
- steady Working Set: **29.322 MiB**
- steady private commit: **52.106 MiB**
- idle CPU: **0%**
- threads: **12**
- handles: **198**

Runs:
- run 1 steady WS: 64.549 MiB, private: 52.106 MiB, CPU: 0%
- run 2 steady WS: 29.322 MiB, private: 54.114 MiB, CPU: 0.1165%
- run 3 steady WS: 26.304 MiB, private: 50.983 MiB, CPU: 0%

The first balanced run remains a reproducible Working-Set outlier while private commit stays near the other runs. Treat it as a resident/shared-page/cold-system effect until deeper Windows page attribution proves otherwise; do not label it a private-memory leak.

### phone

Median:
- startup peak Working Set: **31.992 MiB**
- maximum startup peak Working Set: **32.059 MiB**
- startup peak private commit: **56.406 MiB**
- window ready: **125 ms**
- steady Working Set: **26.445 MiB**
- steady private commit: **50.853 MiB**
- idle CPU: **0%**
- threads: **10**
- handles: **184**

No benchmark process remained after the final run.

## 4. Resource authority contract

Updated source of truth:
- `specs/control-kernel.swyp`

Added generated `ResourceState` containing:
- selected profile;
- base CPU/GPU/worker envelope;
- effective CPU/GPU/worker envelope;
- pause/preempt flags;
- coarse pressure reasons;
- authority revision;
- kernel observation timestamp.

`ResourceGovernor` now declares both policy and runtime state, with the invariant that runtime state cannot exceed the selected base envelope.

Generated artifacts were regenerated from the `.swyp` source, not hand-edited:
- `specs/control-kernel.manifest.json`
- `generated/controlkernel/types_gen.go`

Codegen verification regenerated both artifacts to temporary files and compared SHA-256 exactly:
- manifest: `49661B07F2E2F0D22689A3E30ED3F2045E57F93717E8AAEAFF37AD020C142184`
- Go DTOs: `56E404835A0D6D4888E41B44888FC8771CA924B01F243E2023179A4CB577352A`

## 5. Governor transition semantics

Updated:
- `core/resource/governor.go`
- `core/resource/governor_test.go`

Added:
- `Transition`
- `TransitionSink`
- `SetTransitionSink`
- `AuditError`

Semantics:
- only effective budget changes are published;
- repeated identical pressure samples do not create audit noise;
- transition publication is serialized;
- local budget tightening and cooperative cancellation happen before audit persistence;
- sink/audit failure never rolls back to a more permissive budget;
- the latest audit error is surfaced and clears after a later successful publication;
- attaching a sink immediately publishes the current authority state.

## 6. Durable Control Kernel state

Added:
- `core/controlkernel/resource_state.go`
- `core/controlkernel/resource_transition.go`
- `core/controlkernel/resource_state_test.go`

Updated:
- `core/controlkernel/projection.go`

New event:
- `resource.state_recorded`

Control Kernel owns:
- monotonically increasing resource revision;
- observation timestamp.

Replay validation rejects:
- unknown profiles;
- invalid base envelopes;
- effective CPU/GPU/workers above the base envelope;
- missing authority metadata;
- excessive/invalid pressure reason lists;
- non-monotonic resource revisions.

Reasons are cloned at API/projection boundaries to prevent slice aliasing.

## 7. Compute Fabric lease binding

New:
- `Kernel.ResourceStateForLease(nodeID, LeaseToken)`

Behavior:
- validates the current lease ID/fence using existing Control Kernel lease authority;
- returns the latest durable resource snapshot only for a current valid fence;
- stale/mismatched fences are rejected;
- it does **not** globally block all Control Kernel tasks when background compute is paused, because interactive/control-plane work must not be conflated with contributed background compute.

This makes local resource authority consumable by Compute Fabric workers without allowing a remote coordinator to relax local policy.

## 8. Swarm integration boundary

Updated:
- `core/swarm/swarm.go`
- `core/swarm/swarm_test.go`

Added:
- `Daemon.SetResourceTransitionSink`
- current `ResourceBudget` in status
- latest `ResourceAuditError` in status

Ownership rule:
- Swarm does **not** create, open or close a Control Kernel journal implicitly;
- the OS runtime that owns the journal injects, for example:
  `swarmDaemon.SetResourceTransitionSink(controlkernel.NewResourceTransitionSink(kernel))`

This avoids hidden file locks, competing journal ownership and lifecycle ambiguity.

## 9. Verification evidence

Targeted:
```powershell
go test -count=1 ./core/resource ./core/controlkernel ./core/swarm ./mobile/bridge
```
Result: **4 packages OK, 0 failed**.

Targeted vet:
```powershell
go vet ./core/resource ./core/controlkernel ./core/swarm ./mobile/bridge
```
PASS.

Race detector using the existing local MinGW toolchain:
```powershell
$env:PATH='E:\CEO\tools\mingw64\bin;' + $env:PATH
$env:CGO_ENABLED='1'
go test -race -count=1 ./core/resource ./core/controlkernel ./core/swarm
```
Result: **3 packages OK, no reported races**.

Required full SwypikOS gate after code changes:
```powershell
go vet ./...
go test -count=1 -timeout 180s ./...
```
Result: **45 packages OK, 0 failed**.

Scoped whitespace check:
```powershell
git diff --check -- <resource/controlkernel/swarm/spec/generated/docs/script scope>
```
PASS. Only existing LF->CRLF warnings were emitted for the Swyp contract/manifest.

`gopls` is not installed on this workstation, so LSP diagnostics were unavailable. Compiler, gofmt, go vet, targeted tests, full tests and race detection were used instead.

## 10. Important dirty-repo note

The scoped directories contain changes from earlier SwypikOS migration/resource work that predate this pass, including Control Kernel and the whole untracked `core/resource` directory. Do not use the current repository-wide diff as proof that every changed line belongs to this milestone. No pre-existing work was reset or rewritten intentionally.

Files directly created/modified in this pass:
- `scripts/benchmark-resources.ps1`
- `docs/RESOURCE_BUDGETS.md`
- `specs/control-kernel.swyp`
- `specs/control-kernel.manifest.json`
- `generated/controlkernel/types_gen.go`
- `core/resource/governor.go`
- `core/resource/governor_test.go`
- `core/controlkernel/projection.go`
- `core/controlkernel/resource_state.go`
- `core/controlkernel/resource_transition.go`
- `core/controlkernel/resource_state_test.go`
- `core/swarm/swarm.go`
- `core/swarm/swarm_test.go`

## 11. Recommended next engineering order

1. **Real GPU/NPU preemption** — make long CUDA/NPU kernels cooperatively yield/checkpoint/release device memory on governor cancellation; the current short simulator cannot prove device-level release latency.
2. **Device-class policy from native Hardware Manifest / Device Graph** — distinguish phone/tablet, workstation, automotive compute/infotainment, robot/appliance and embedded/edge. Keep safety-critical automotive actuation outside this path.
3. **Runtime ownership wiring** — when the real Compute Fabric device agent is instantiated, inject its Control Kernel resource sink explicitly into Swarm/background executors.
4. **Scenario benchmarks** — run the new harness/companion workloads with loaded search index, active agent, active P2P training, many peers and device synthesis.
5. **Generic thermal telemetry** — NVIDIA NVML is covered where GPU compute is eligible; CPU/platform thermals still need a native adapter.
6. Continue the first-party OS track: kernel/device ABI, real network/storage/input/display drivers, installer/recovery and hardware qualification.
