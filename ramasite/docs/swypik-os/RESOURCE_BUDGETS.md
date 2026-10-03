# SwypikOS resource budgets

SwypikOS treats foreground responsiveness, thermal headroom and battery life as hard platform concerns. Background work must be bounded and optional.

The active profile is selected automatically from coarse host capacity unless `SWYPIK_RESOURCE_PROFILE=phone|balanced|performance` explicitly overrides it. `auto` is equivalent to leaving the variable unset. Unknown explicit values fail closed to `balanced`.

| Budget | phone | balanced | performance |
| --- | ---: | ---: | ---: |
| Background CPU | 3% | 8% | 25% |
| Background GPU | 8% | 20% | 50% |
| Background graph workers | 1 | 2 | 4 |
| Base status poll | 30s | 10s | 2s |
| Search files per index pass | 1,000 | 5,000 | 20,000 |
| Search documents in active index | 1,000 | 5,000 | 20,000 |
| Search text per document | 4 KiB | 8 KiB | 16 KiB |
| ActionGraph checkpoints | 4 | 8 | 32 |
| Go control-plane memory limit | 128 MiB | 192 MiB | 512 MiB |
| Go GC percent | 50 | 75 | 125 |

These are control-plane budgets, not Ilaria model budgets. The model runtime has its own memory/accelerator governance.

## Automatic base profile

- Android and clearly constrained machines use `phone`.
- Battery-powered machines default to `balanced`, or `phone` when CPU/RAM is constrained.
- General desktops use `balanced`.
- `performance` is selected automatically only for battery-less workstations with at least 16 logical CPUs and 24 GiB RAM.
- An explicit profile remains authoritative as the maximum envelope.

The base profile is stable for the process. Runtime signals do not silently upgrade it.

## Hardware Manifest device class

When a validated native `HardwareManifest` is available, its coarse `device_class`
adds a second, one-way policy layer. The selected `phone / balanced / performance`
profile remains the maximum envelope; device class may only tighten it and can
never raise CPU, GPU, worker, memory or training limits above that profile.

| Device class | Background CPU ceiling | Background GPU ceiling | Workers | Notes |
| --- | ---: | ---: | ---: | --- |
| `workstation` | base profile | base profile | base profile | Capacity/pressure policy remains authoritative. |
| `mobile` | 3% | 8% | 1 | Also uses conservative memory/training ceilings and slower idle polling. |
| `automotive` | 2% | 5% | 1 | Infotainment/compute-domain work only; this path grants no actuator authority. |
| `robot` | 3% | 8% | 1 | Background cognition/mesh compute only; physical safety remains separately governed. |
| `appliance` | 2% | 5% | 1 | Conservative edge/background envelope. |
| `embedded` | 2% | 5% | 1 | Conservative edge/background envelope. |

The universal installer now converts its observed HAL profile into the canonical
Hardware Manifest without copying hostnames, raw serials, VINs, friendly device
names or arbitrary metadata. The manifest carries only privacy-safe stable IDs,
coarse device/bus classes and bounded protocol/status properties. Unsupported
architectures fail instead of receiving an invented ABI.

`ResourcePolicy` and durable `ResourceState` both carry `device_class`, so
Control Kernel evidence identifies which class envelope governed a transition.
Older journals that predate this field replay as the legacy/unknown class; they
are not upgraded to a more permissive class during replay.

## Adaptive background compute

Compute contribution is governed separately from resident-state limits. The adaptive governor samples native system pressure and can only tighten the base envelope:

- foreground user activity cancels active cooperative work and throttles subsequent background admission to a single low-duty worker;
- battery operation reduces CPU/GPU duty cycle and worker count; battery at or below 20% pauses compute;
- high memory pressure throttles background work and critical memory pressure pauses it;
- thermal pressure throttles where platform telemetry is available and critical temperature pauses it;
- clearing pressure resumes admission under the original base profile, never above it.

Windows uses `GetLastInputInfo`, `GetSystemPowerStatus`, and `GlobalMemoryStatusEx`; when an NVIDIA GPU is already eligible for contributed compute, the Swarm signal source also consumes its existing CUDA/NVML temperature telemetry. Linux uses `/proc/meminfo`, power-supply sysfs, and thermal sysfs when exposed by the platform. Missing telemetry remains unknown rather than being fabricated.

## Implemented rules

- Disabled Swarm compute performs no synthetic hashing and its worker remains parked until shutdown.
- GPU inventory/trainer allocation is deferred when compute contribution is disabled.
- ActionGraph parallelism is bounded by profile and mailbox buffers are reused between supersteps.
- ActionGraph checkpoint retention is bounded and reuses its backing slice.
- Linux session status polling backs off while idle and refreshes immediately after user-visible operations.
- Search indexing has profile-aware document/text caps and performs bounded replay of larger existing indexes without rewriting the original file.
- Local text indexing collapses UTF-8 whitespace in one pass instead of materializing `string -> Fields -> Join` copies.
- Agent polling uses a lightweight `RunStatus`; complete tool observations are not copied into `/v1/status`.
- Desktop chat/history/log buffers are bounded and reuse backing storage after warm-up.
- Notification and proactive histories reuse bounded storage rather than allocating a new retained slice on every overflow.
- SwypikOS processes apply a Go memory limit/GC policy at startup.
- Swarm training is admitted through an adaptive governor and receives cancellation when foreground/resource pressure requires immediate yield.
- The Resource Governor can publish only effective budget transitions through a `TransitionSink`; repeated identical pressure samples do not create audit noise.
- Control Kernel persists injected governor transitions as monotonic `ResourceState` events containing the selected base envelope, current effective envelope, pause/preempt flags and coarse pressure reasons. Replay rejects any state that exceeds its base envelope.
- A Compute Fabric worker holding the current lease fence can request that durable snapshot through `ResourceStateForLease`; stale/mismatched fences are rejected, and the remote coordinator still cannot relax local policy.
- Swarm exposes explicit authority-sink injection and reports its current effective budget plus the latest audit error. Swarm does not create or own a Control Kernel journal implicitly; the OS runtime that owns that journal must inject the sink.
- Universal installer planning derives its resource contract from a validated Hardware Manifest device class; manually constructed/invalid environments fall back to the smallest existing resource envelope rather than an all-zero or permissive contract.
- Audit persistence failure never relaxes the local safety posture: throttling/preemption is applied first and the audit failure is surfaced separately for recovery/observability.

## Reproducible Windows resource benchmark

The manual low-resource measurements are now reproducible from the repository:

```powershell
powershell -File ramasite\benchmarks\swypik-os\scripts\benchmark-resources.ps1
```

From the Nexus root, the harness builds a dedicated optimized Win32 GUI binary inside an isolated `ramasite/benchmarks/swypik-os/results/resource-bench-*` directory, then runs `balanced` and `phone` three times each. Every run gets a fresh data directory and workspace. The harness samples only the process it created and records startup peak working set/private commit/thread/handle counts. It does not classify a fixed delay as "steady": it waits for the native lifecycle log to report `Fonts warmed`, then requires a post-warm quiescence window (3 seconds by default) before starting the separate steady-idle CPU/memory window. It asks that process to close cleanly and only force-terminates its own PID on failure; unrelated SwypikOS sessions are never touched.

`resource-results.json` contains per-profile medians and every run result, including window-ready, font-warm and steady-start timestamps. Each run directory also contains `samples.json` with the raw startup and idle samples. Use `-Executable` to measure an existing build, or override `-Profiles`, `-RunsPerProfile`, `-StartupSeconds`, `-IdleSeconds`, `-QuiesceSeconds`, and `-SampleIntervalMs` when investigating a specific regression. Reusing a non-empty output directory is rejected rather than silently contaminating a run. This is a manual benchmark, not a CI pass/fail gate: host load, display state and driver activity can perturb process-level measurements.

## Rules for future services

1. No background busy loops.
2. Prefer blocking channels/events to polling.
3. Polling must back off while idle and be cancellable.
4. Every queue/cache/history must have an explicit upper bound.
5. Worker concurrency must come from the resource policy.
6. A disabled feature must not probe hardware or allocate its worker state.
7. Large user/model data must never be copied into periodic status snapshots.
8. New features must remain inside the selected profile envelope; automatic `performance` selection is limited to high-headroom battery-less workstations and may still be tightened at runtime.
