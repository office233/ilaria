# Durable plan supervisor v1

This stage connects a complete Swyp program to SwypikOS authority and an
independent persistent Ilaria verifier. It runs without a model, network or
training dataset. Host configuration supplies every executable, identity,
read root, scope, deadline and budget.

## Execution

1. `swyp core-preflight --entry main -o snapshot.core.json program.swyp`
   compiles once, validates all reachable broker effects, exports an
   authority-free `EffectPlan` and writes an exclusive canonical IR snapshot.
2. The supervisor verifies the snapshot SHA256 and pins its module identity,
   actual function/effect bindings, scopes and all configured execution limits.
3. Before launching a guest, it persists a launch reservation in its ledger.
   Before each effect it persists a count and the full maximum read reservation.
   The ledger uses the existing Control Kernel event store and its durability
   rules; it does not replace kernel authority.
4. The existing kernel leases, fences and scoped broker execute only authorized
   `fs.read` or `clock.read`. The guest receives no signing key, host credential,
   root path or independent-verifier control channel.
5. `evidence-check --stream --keys HOST_REGISTRY` checks signatures and exact
   expected execution bindings. One verifier process serves successive effects
   and plans; it loads explicit trust once and sleeps between requests.
6. The supervisor correlates request/result/receipt hashes and the expected
   lease epoch, records an independent verifier decision, commits the kernel
   intent and marks the effect node `SUCCEEDED` before returning its value.
7. A plan succeeds only after all issued effects commit, a typed final value is
   valid, the guest emits no trailing frame and its process exits successfully.
   An optional host `expected_value_hash` pins SHA256 of the canonical typed
   result JSON. The ledger pins the canonical complete terminal frame, including
   run, module, value and step count. Without a value expectation, successful execution is not a proof
   that the program solves its intended task.

The frozen kernel topology has at most 64 preallocated effect nodes; unused
nodes are cancelled at completion. Reads reserve their configured maximum,
even when the actual file is shorter. Reservations are never refunded after
uncertainty. This conservative rule makes the cumulative byte/effect limits
survive restart without another execution.

## Resource behavior

The supervisor applies the existing phone/balanced/performance profile and the
device class ceiling. Go runtime limits also reach its explicitly trusted
children through a small environment allowlist; parent credentials and other
environment values are not inherited. A phone profile uses one Go execution
thread, a 128 MiB soft Go memory ceiling and a cooperative 3% background duty
target. Embedded/appliance profiles tighten the duty target to 2%.

Plan budgets independently bound fuel, returned bytes, read reservations,
effect count, execution wall time and aggregate measured CPU. Per-child active
monitors sample RSS and CPU; host CPU/RSS are checked at preflight, verification
and completion boundaries. These are sampled/cooperative bounds and a Go soft
heap limit, with possible sampling/startup overshoot. They are not hard kernel
quotas or a general filesystem/network sandbox. Only explicitly trusted Swyp
and Ilaria executables belong on this reference path.

CPU counters include user and kernel time, rather than elapsed wall time.
Windows measures working set/peak working set through
[GetProcessMemoryInfo](https://learn.microsoft.com/en-us/windows/win32/api/psapi/nf-psapi-getprocessmemoryinfo)
and CPU through
[GetProcessTimes](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-getprocesstimes).
Linux samples `/proc/PID/stat` and `/proc/PID/status`; its tick frequency comes
from the Linux `AT_CLKTCK` auxiliary-vector entry, not a guessed constant.
Windows and Linux resident-memory accounting differ; compare measurements on
the same platform. Reports distinguish host, Swyp and verifier CPU and peak
RSS. They set `energy_measured=false`; no joules or battery-life claim is
inferred from CPU/RAM.

Idle service operation has no periodic polling or sampler timer. Pipe reads,
queue admission and pause/resume wait on events. Active process monitors stop
after their request. The persistent verifier and supervisor are still resident
processes; their RAM is measured rather than described as zero.

The existing governor wraps the whole plan. After success, cooperative
cooldown delays the next admission; the report is emitted before that cooldown.
Execution timeout covers compilation and execution, while cooldown is separate.
The trusted host can supply battery/thermal/foreground snapshots with `signals`
to pause and preempt work. This reference headless service does not install an
OS-wide hardware signal subscription.

## Host interface

```powershell
go build ./cmd/plan-supervisor
plan-supervisor --config C:\host\plans.json --plan-id read-status
plan-supervisor --config C:\host\plans.json --serve
```

Configuration schema lives in `swypik-os/cmd/plan-supervisor/config.go`.
Version 1 requires absolute paths for `journal`, `ledger_directory`,
`swyp_executable`, `verifier_executable`, `trust_registry`, each read root and
each plan source. Executor and verifier have separate identities and opaque
credentials. `private_key` is an explicitly provisioned base64 Ed25519 private
key. There are no built-in production keys or ambient roots. Protect the host
configuration with host ACLs; do not store real keys in this repository.

`profile`, `device_class`, `cpu_time_ms`, `rss_limit_bytes` and
`sample_interval_ms` are explicit. Each configured plan supplies `id`, `task_id`,
`run_id`, `source`, `entry`, `arguments`, an absolute RFC3339 `deadline`,
`max_effects`, `max_read_bytes`, `fuel`, `max_returned_bytes`, `wall_time_ms`
and `scopes`. A scope names the exact function, effect, capability and relative
path; a read additionally names its configured root and per-read maximum.
`arguments` and `scopes` can be empty; zero read/return budgets provide no
additional read authority. `expected_value_hash` is optional. A deadline/run identity stays unchanged
when reopening a journal. New executions need new task and run identities.

Service stdin is a trusted control-plane JSONL pipe, separate from every guest:

```json
{"op":"run","plan_id":"read-status"}
{"op":"status","plan_id":"read-status"}
{"op":"signals","signals":{"user_active":true,"on_battery":true,"battery_percent":15,"memory_load_percent":40,"available_memory_bytes":1073741824,"thermal_celsius":35}}
{"op":"shutdown"}
```

One worker and a bounded eight-command queue keep process and memory growth
bounded. Signals are processed while a job waits for admission. EOF, shutdown
and interrupts cancel active work and close owned processes. Initial `ready`
and `budget` responses contain the current cooperative resource envelope.
Status commands run on the same worker and are serialized with executions;
status reads the existing durable ledger without compilation or a guest. It
works when the original source has changed or disappeared and reports
`not_started` when no ledger exists.

## Recovery and limits

Completed plans can be inspected, but are never rerun under the same run ID.
Any previously started nonterminal plan requires explicit recovery. Changed
source, scope, root, execution policy or budget is refused against persisted
policy. A missing ledger for an existing task is refused before fresh grants.
The service reports uncertainty and retains journal evidence. It does not
automatically reconcile or resume a partially executed program. Effects that
already committed remain committed; full-plan success is not an atomic
transaction over previously executed effects.

This stage supports read-only clock/filesystem effects. It neither trains a
model nor promotes observations to training: Ilaria observations remain
`local_private`, `execution_evidence_only`, `training_eligible=false`.
It does not establish native phone installation, production kernel/driver
readiness, WAN P2P training, model quality or an advantage over other systems.

## Validation and measured improvement

```powershell
./ramasite/scripts/verify-supervisor.ps1
./ramasite/scripts/verify-effects.ps1
./ramasite/scripts/verify-contracts.ps1
```

The new integration gate builds each product independently and uses only
temporary synthetic data and a publicly known RFC8032 test key. It exercises
the real compiler, supervisor, broker, verifier, journals, refusals and restart.
CI runs it on Windows and Linux alongside product tests and Linux race checks.

Final local gates passed on Windows (Go test/vet/build for all three products,
Swyp minimum Go 1.21, both real CLI integrations, generated contracts and
`git diff --check`) and Linux (full product race suites/vet/build and the real
supervisor integration). Ilaria's required Forge compilation checks and 47 IMC
tests passed without loading private model weights or user data. The supervisor
CLI adds seven principal behavioral tests with 51 subtests, including malformed
nested frames, process failure, budgets, verifier correlation/privacy and
prompt shutdown.

The Linux test host initially timed out in existing Go importer/fresh-build
tests while the toolchain and repository lived on mounted Windows storage.
Moving the public Go 1.26.2 runtime to Linux storage fixed the OS importer
gate. Swyp's full Linux race gate also used `GOFLAGS=-buildvcs=false` to avoid
VCS metadata traversal of the mounted aggregate checkout. Assertions and the
existing 60-second child/180-second package limits stayed unchanged. Failed
initial attempts and final Swyp results are recorded in the product's
`docs/audit/2026-09-30-supervisor-v1.md`.

The Ilaria in-process benchmark uses three samples of 32 tiny synthetic
receipts on this Windows host (Go 1.27.1, AMD EPYC 7763 VM): median file-mode
verification **1.318 ms/receipt**, persistent verification **0.340 ms/receipt**;
approximately **489 versus 332 allocations**, and **41,355 versus 28,011 bytes
allocated per receipt**. That is approximately 32% fewer allocated bytes and
allocations. This comparison excludes process startup, effect providers and
energy. It is evidence of lower verifier overhead, not an end-to-end latency
or device battery guarantee.

A complete synthetic Windows plan with two 20-byte reads and one clock effect
measured the following in one local run. Its wall time was **349.3 ms**, with
three child starts (preflight, guest, verifier); subsequent service plans reuse
the verifier and need two starts. The configured test profile was balanced.

| Process | Recorded CPU time | Peak resident memory |
| --- | ---: | ---: |
| Supervisor | 46.875 ms | 9,498,624 B (9.06 MiB) |
| Swyp compilation/execution | 31.250 ms | 7,749,632 B (7.39 MiB) |
| Persistent Ilaria verifier | 15.625 ms | 5,791,744 B (5.52 MiB) |

These are separate per-process peaks, not a simultaneous total or model memory
measurement. In a subsequent two-second service idle sample, both the supervisor
and persistent verifier recorded **0 ns additional CPU** in the OS counters.
That is a short observed counter sample, not a promise of zero wakeups or energy
usage. The integration gate prints fresh measurements instead of relying on
these baseline numbers.

The Linux synthetic run independently passed the same three-CLI chain:
**34.33 ms wall time**, host **10 ms CPU / 6.86 MiB peak RSS**, Swyp
**14.545 ms CPU / 9.50 MiB peak RSS**, verifier **3.25 MiB peak RSS**. The short
verifier operation was below Linux process-counter tick resolution and reported
0 recorded CPU; that is not zero computational work. Both idle processes also
recorded 0 additional CPU over a separate 2.002-second sample. These single-run
figures compare neither operating systems nor production workloads.

## Next engineering steps

1. Explicit recovery decisions based on kernel intent and verifier evidence,
   with fault injection at every durable boundary and no blind replay.
2. Hard process-tree CPU/RAM quotas and native sandboxing (Windows Job Objects,
   Linux cgroups and restricted process capabilities), plus a reusable compiler
   process or host-attested snapshot cache to remove the two Swyp starts/plan.
3. A native host signal subscription and hardware energy meters on real phones,
   embedded ARM boards and computers. Gate claims on idle wakeups, CPU/RSS,
   p50/p95 latency, cancellation and measured joules per useful operation.
4. Verified additional effects and a typed plan outcome contract before writes,
   external side effects or automated recovery are admitted.
5. Native device ports/drivers and separately evaluated IMC training quality;
   privacy-preserving P2P training needs its own explicit capability, scheduling,
   consensus and convergence gates.
