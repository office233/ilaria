# SwypikOS — hardware-aware resource synthesis handoff — 2026-09-30

Workspace: `E:\nexus\swypik-os`  
Branch: `agent/nexus-clean-swyp-fast`  
HEAD observed: `a5a8175`  
Status: intentionally dirty from the ongoing root -> ilaria/swyp/swypik-os migration and concurrent work. No reset/clean/stash/commit/push was performed.

## Why this block was selected

The 2026-09-29 handoff identified the next high-value SwypikOS task as hardware-aware resource synthesis:

- choose `phone / balanced / performance` automatically from detected hardware;
- reduce contributed/background compute when foreground is active;
- react to battery, memory and thermal pressure;
- keep this inside the Resource Governor / Compute Fabric boundary instead of scattered feature flags.

## Fresh baseline before edits

From `E:\nexus\swypik-os`:

```powershell
go vet ./...
go test -count=1 -timeout 180s ./...
```

Result: **45 Go packages OK, 0 failed**.

## Implemented

### 1. Automatic base resource profile

Added `core/resource/adaptive.go` and platform signal implementations.

Rules:

- explicit `SWYPIK_RESOURCE_PROFILE=phone|balanced|performance` remains authoritative;
- `auto` or unset => hardware selection;
- invalid explicit value => fail-closed `balanced`;
- Android => `phone`;
- <=4 logical CPUs or <=4 GiB RAM => `phone`;
- battery-powered constrained hardware => `phone`;
- other portable hardware => `balanced`;
- battery-less workstation with >=16 logical CPUs and >=24 GiB RAM => `performance`;
- otherwise => `balanced`.

The selection uses only coarse, non-identifying facts: GOOS/GOARCH, logical CPU count, total RAM, battery presence.

### 2. Native runtime pressure telemetry

Windows:

- `GlobalMemoryStatusEx` for physical memory pressure;
- `GetSystemPowerStatus` for battery/AC;
- `GetLastInputInfo` + `GetTickCount` for foreground activity;
- when NVIDIA compute is already detected, existing CUDA/NVML telemetry supplies GPU temperature.

Linux:

- `/proc/meminfo`;
- `/sys/class/power_supply/*`;
- `/sys/class/thermal/thermal_zone*/temp`.

Missing telemetry remains unknown; no values are fabricated.

### 3. Dynamic Resource Governor

`core/resource/governor.go` now supports live budget changes.

Runtime policy only tightens the selected base envelope:

- foreground activity: preempt active cooperative work, then throttle to 1 worker / <=2% CPU / <=5% GPU;
- on battery: <=3% CPU / <=8% GPU / 1 worker;
- battery <=20%: pause background compute;
- memory >=80%: throttle;
- memory >=90% or available RAM <256 MiB: pause;
- thermal >=75 C: throttle;
- thermal >=85 C: pause.

Entering preempt/pause cancels active cooperative run contexts. Clearing pressure resumes under the original base profile, never above it.

### 4. Swarm / contributed-compute integration

`core/swarm/swarm.go` now:

- starts an adaptive signal monitor only when contribution + training are enabled;
- does not allocate that monitor for disabled compute;
- passes current adaptive GPU ceiling into `federated.LocalTrainer`;
- cancels monitor on disable / Stop;
- refuses training after terminal Stop;
- prevents `Toggle()` after Stop from resurrecting the monitor.

NVIDIA temperature is sampled through the already-existing CUDA/NVML HAL path when a real GPU was detected.

### 5. Federated trainer hook

The only new delta made in the already-dirty `core/federated/federated.go` during this pass is:

- `LocalTrainer.SetMaxGPUPercent(...)` for runtime tightening.

Other existing uncommitted changes in this file predate this pass and were preserved.

### 6. Startup visibility + docs

`cmd/swypik-os/main_windows.go` now reports selection provenance in `-check` output and lifecycle log:

- resource profile;
- selection source;
- selection reason.

`docs/RESOURCE_BUDGETS.md` was aligned with the actual current code budgets and documents automatic selection + adaptive behavior.

## Verification

Targeted:

```powershell
go test -count=1 ./core/resource ./core/federated ./core/swarm ./cmd/swypik-os
```

PASS.

Linux compile gate for the new resource package:

```powershell
$env:GOOS='linux'
$env:GOARCH='amd64'
go test -c ./core/resource
```

PASS.

Race detector using the local MinGW toolchain:

```powershell
$env:PATH='E:\CEO\tools\mingw64\bin;' + $env:PATH
$env:CGO_ENABLED='1'
go test -race -count=1 ./core/resource ./core/swarm
```

Result: **2 packages OK, 0 failed / no reported races**.

Final required gate:

```powershell
go vet ./...
go test -count=1 -timeout 180s ./...
git diff --check -- .
```

Result: **45 packages OK, 0 failed**.  
`git diff --check` passed. Git emitted only existing LF->CRLF warnings for `docs/CODE_AUDIT.md` and control-kernel spec/manifest.

## Files in this pass

New under the currently-untracked `core/resource/` area:

- `adaptive.go`
- `adaptive_test.go`
- `system_signals_windows.go`
- `system_signals_linux.go`
- `system_signals_other.go`

Modified while preserving pre-existing WIP:

- `core/resource/policy.go`
- `core/resource/governor.go`
- `core/federated/federated.go` — only runtime GPU setter added by this pass
- `core/swarm/swarm.go`
- `core/swarm/swarm_test.go`
- `cmd/swypik-os/main_windows.go`
- `docs/RESOURCE_BUDGETS.md`

## Remaining limitations / next engineering order

1. **Automate the real low-resource benchmark** currently kept manually under `E:\CEO\swypik-resource-bench-*`; capture steady idle plus startup peak after this change.
2. **Wire the Resource Governor into every real background compute path**, not only Swarm training.
3. **Real GPU kernel preemption**: long-running CUDA/NPU kernels must actually observe cancellation/preemption; the current simulator is too short to prove device-level preemption.
4. **Device-class policy from the native Hardware Manifest / Device Graph**:
   - phone/tablet;
   - workstation;
   - vehicle/robot safety/latency-specific envelope;
   - embedded/edge.
5. **Move dynamic resource decisions into Control Kernel evidence/state**, so profile/pressure transitions are auditable and available to Compute Fabric leases.
6. **Thermal coverage**: Windows currently has GPU temperature through NVIDIA NVML when available; generic CPU/platform thermal telemetry remains a separate hardware-adapter task.
7. Continue the native OS track after resource verification: first-party kernel/device ABI, real network/storage/input/display driver path, installer/recovery and hardware qualification.

## Git / integration note

Current exact scoped status after this pass:

```text
 M cmd/swypik-os/main_windows.go
 M core/federated/federated.go
 M core/swarm/swarm.go
 M core/swarm/swarm_test.go
?? core/resource/
?? docs/RESOURCE_BUDGETS.md
```

This does **not** mean all diffs in those modified files belong to this pass; several were already modified before the work started. No commit or push was made.
