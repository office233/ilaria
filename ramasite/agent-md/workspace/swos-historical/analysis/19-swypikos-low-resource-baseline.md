# SwypikOS Low-Resource Baseline — 2026-09-29

Workspace: E:\nexus\swypik-os
Status: full regression green; measured on Windows x64 workstation.

## Engineering changes

### Runtime governance
- ApplyRuntime never relaxes a stricter process-local Go memory limit.
- ApplyRuntime never relaxes a stricter GOGC setting.
- Go scheduler caps:
  - phone: max 1 P
  - balanced: max 2 P
  - performance: all logical CPUs
- background Resource Governor:
  - fixed worker slots
  - cooperative CPU duty-cycle cooldown
  - context cancellation/preemption
- Swarm training uses context-aware governor.

### Resource profiles
Phone:
- background CPU 3%
- background GPU 8%
- 1 background worker
- status poll 30s
- memory policy 128 MB
- GOGC 50
- search docs/files 1000/1000
- pending deltas 16
- resident peers 16
- hive tasks 16
- P2P inspection queue 4
- chat history 20
- wallet history 128
- document max 128 KiB

Balanced:
- background CPU 8%
- background GPU 20%
- 2 background workers
- status poll 10s
- memory policy 192 MB
- GOGC 75
- pending deltas 64
- resident peers 128
- hive tasks 128
- chat history 60

Performance remains intentionally larger but is still bounded.

### UI
- full-screen 32-bit backbuffer is released after ~2 seconds idle on phone/balanced.
- performance profile keeps backbuffer warm.
- static wallpaper already quarter-resolution (1/16 full bitmap memory).
- text measurement cache: 20,000 -> 2,048 entries.
- height cache: 4,000 -> 512 entries.
- desktop command history/log blocks are profile-aware.
- notification queues are profile-aware.
- existing Win32 message loop remains event-driven:
  - live/approval timer 250ms
  - idle timer approximately once/minute.

### Long-running state
- Control Kernel no longer keeps the entire durable EventStore journal duplicated in RAM after replay.
  Projection is the active in-memory state; append-only journal stays on disk.
- Hive resident task history drops large payload bytes after routing.
- Cyber history is bounded/profile-aware without reslice backing-array retention.
- ActionGraph uses a fixed worker pool instead of goroutine-per-node + semaphore.
- Docs word count update is incremental rather than rescanning the whole document on append.
- Ilaria chat/wallet/federated/hive/P2P caps aligned to resource policy.

## Validation

Targeted optimized regression:
- 12 packages OK
- 0 failed

Full regression after all major resource changes:
go vet ./...
go test -count=1 -timeout 180s ./...

Result:
- 45 packages OK
- 0 failed

## Real idle measurements

Binary:
- optimized Windows GUI build
- -trimpath
- -ldflags "-H=windowsgui -s -w"

Measurement method:
- fresh isolated data/workspace per process
- 4s startup stabilization
- 5s CPU idle sample
- PID created by benchmark only, then force-stopped
- no existing user processes terminated.

### v2 before Go scheduler caps
Median over 3 runs/profile:
balanced:
- Working Set: 20.71 MB median (one first-run outlier ~57.7 MB)
- Private: 50.42 MB
- CPU: 0.000%
- threads: 14 median
- handles: 213 median

phone:
- Working Set: 20.66 MB
- Private: 49.79 MB
- CPU: 0.000%
- threads: 13 median
- handles: 207 median

### v4 after adaptive backbuffer + scheduler caps
Repeated samples:
balanced:
- steady run Working Set: ~19.96 MB (first-run outlier ~57.8 MB)
- average Private: 49.42 MB
- average CPU over sample: 0.078%
- average threads: 11
- average handles: 198

phone:
- Working Set: ~20.17–20.28 MB
- average Private: 49.04 MB
- average CPU: 0.000%
- threads: 10
- handles: 187

Evidence:
- E:\CEO\swypik-resource-bench-v2\resource-results-v2.json
- E:\CEO\swypik-resource-bench-v4\resource-results-v4.json

## Interpretation

- Idle CPU is effectively zero in measured phone runs and near zero in balanced.
- Steady Working Set is ~20 MB and therefore below the project's 30 MB resident-memory target in these measurements.
- Private commit remains ~49 MB. This includes Go runtime, thread stacks, Win32/GDI/GDI+ and other committed process memory; GOMEMLIMIT only governs Go heap and should not be confused with total private commit.
- Do not use EmptyWorkingSet or similar cosmetic trimming to claim lower memory.
- First-run balanced Working Set sometimes spikes to ~58 MB and then settles; this should be investigated separately if startup peak becomes a product requirement.
- Further sub-49MB private-commit reductions likely require deeper runtime/UI/native loading changes rather than smaller Go caches.

## Next resource milestones

1. Add automated resource smoke benchmark to non-CI/manual benchmark suite.
2. Measure startup peak Working Set/private commit separately from steady idle.
3. Measure a loaded search index / active agent / P2P training state, not only empty idle.
4. Make background GPU kernels context-preemptible when real training replaces simulator.
5. Device installer should select resource profile from hardware/device class rather than rely only on environment/config.
