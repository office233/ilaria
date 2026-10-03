# Durable plan supervisor v2

Supervisor v2 makes recovery explicit, moves child CPU/RAM enforcement into OS
process-group mechanisms, and adds repeatable performance measurements. It
preserves the product boundary established by v1:

- **Ilaria** remains an independent evidence verifier. It supplies no OS
  authority and is kept as a persistent process between requests.
- **Swyp** remains language/Core IR/contracts/verifier logic and is usable
  without a model. No OS resource primitives were added to Swyp.
- **SwypikOS** owns capabilities, execution, resource enforcement and recovery.

The effect wire protocol remains version 1. The supervisor host configuration
is version 2 because strict process-group limits are now mandatory and explicit.
This milestone does not add write/network effects, P2P training, universal
installation, deployment or publication.

## 1. Explicit recovery

### Durable identity

The supervisor creation event now stores the normalized program identity needed
for recovery: task ID, run ID, module hash, entry, declared effects, capability
bindings, deadline, maximum effect count and maximum read budget. Credentials,
private keys and provider data are not persisted there.

`OpenRecovery` opens an existing supervisor ledger and reconstructs that program
identity from the durable v2 creation event. Current scopes, roots, identities,
signer ID and execution/resource policy are still supplied by trusted host
configuration and are rehashed against the persisted policy. A changed scope,
budget or execution policy is refused as `policy_changed`.

Recovery does **not** compile the source and does not require the source file to
still exist. It does not open filesystem read roots, launch Swyp, start or query
Ilaria, or execute an effect provider.

### Reconciliation algorithm

`Recover(ctx)` combines three durable sources:

1. the supervisor ledger (`started`, exact issued request, reserved bytes and
   committed accounting);
2. the Control Kernel node/lease/fence/intent state;
3. an already durable independent verifier verdict tied to the same
   attempt/lease/fence.

The algorithm is deliberately conservative:

| Observed state | v2 action |
| --- | --- |
| Plan already `SUCCEEDED`, `FAILED` or `UNCERTAIN` | report terminal; never rerun |
| Started plan, no unresolved effect | stop `UNCERTAIN`; no serialized continuation exists |
| Unresolved effect with a live original lease | report `waiting_for_lease_expiry`; do not steal/re-fence |
| Prepared/abandoned effect, or no intent | do not execute it; stop uncertain |
| `STARTED` intent after lease expiry | use Control Kernel recovery to mark execution uncertain; never invoke provider again |
| Result/uncertain intent without matching independent `PASSED` evidence | keep result untrusted; stop uncertain |
| Result/uncertain/reconciling intent with matching independent evidence | reconcile/commit the existing result, then account that effect in the supervisor ledger |
| Intent already committed and node already succeeded, but supervisor accounting missing | account the already committed effect from durable evidence |

After safe effect reconciliation the plan is still stopped `UNCERTAIN` with
`reconciled_no_serialized_continuation`. Supervisor v2 does not serialize Swyp
PC/stack/locals, so it does not claim exact program resume. A new guest is never
started under the old run identity.

The explicit interfaces are:

```text
plan-supervisor --config HOST.json --plan-id PLAN --recover
{"op":"recover","plan_id":"PLAN"}
```

Normal `run` retains the v1 no-replay rule. `status` remains read-only and does
not start compiler/guest/verifier children.

### Fault coverage

Tests inject a crash at every relevant durable boundary without adding a
production crash hook:

1. plan launch persisted;
2. request issue/budget reservation persisted;
3. lease claimed;
4. intent prepared;
5. intent started;
6. result recorded;
7. independent verification recorded;
8. node entered committing;
9. intent committed;
10. node succeeded;
11. supervisor effect accounting committed;
12. plan terminal frame committed.

The matrix additionally covers restart, a live then expired lease, invalid
independent evidence, changed host policy, and a damaged ledger. Fixtures count
provider/verifier callbacks so recovery tests prove that no effect or evidence
verification is reexecuted.

## 2. Strict process-tree CPU/RAM limits

Supervisor startup now creates the required kernel containment group **before**
opening the Control Kernel. Failure to establish the requested mechanism is a
startup refusal; no capability can be granted first and no sampled/Go limit is
used as a substitute.

Version 2 host configuration adds:

```json
{
  "version": 2,
  "kernel_cpu_percent": 8,
  "kernel_memory_limit_bytes": 201326592,
  "kernel_max_processes": 16,
  "linux_cgroup_root": "/explicit/delegated/cgroup/on/linux"
}
```

`rss_limit_bytes`, `cpu_time_ms` and `sample_interval_ms` remain accounting and
secondary fail-closed checks. `GOMEMLIMIT`/`GOMAXPROCS` remain runtime tuning.
They are not kernel quotas.

`kernel_cpu_percent` is a hard ceiling on the fraction of CPU capacity available
to the supervisor host. It may only tighten the selected resource profile/device
class; for example `balanced/workstation` permits at most 8%. Windows applies the
percentage directly through Job Object CPU-rate control. Linux scales
`cpu.max` by the logical CPUs available to the supervisor, so the percentage
has the same host-capacity meaning instead of treating 100% as one CPU.

### Windows

Every Swyp compiler/guest process and the persistent Ilaria verifier is placed
in one Windows Job Object. The Job configures:

- aggregate `JOB_OBJECT_LIMIT_JOB_MEMORY`;
- `JOB_OBJECT_LIMIT_ACTIVE_PROCESS`;
- `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`;
- hard CPU-rate control through `JobObjectCpuRateControlInformation`.

Strict children are created suspended, assigned to the Job, and only then
resumed. This closes the process-start escape window. Tests query the Job Object
back from the kernel, force a memory overrun, and prove that closing the Job
terminates a spawned descendant process as well as its parent.

### Linux

Linux requires cgroup v2 and an explicitly delegated writable subtree. The
global `/sys/fs/cgroup` root is rejected. The supervisor uses only `cpu`,
`memory` and `pids` controllers in that subtree and creates one ephemeral child
cgroup for its trusted process group. Before changing a control file it verifies
with `statfs` that the configured root is an actual cgroup2 filesystem; a
writable ordinary directory containing look-alike control files is rejected
before Control Kernel authority is opened. `cpu.max`, `memory.max` and
`pids.max` carry the strict settings.

Go's `SysProcAttr.UseCgroupFD` uses `clone3(CLONE_INTO_CGROUP)`, so a child is
born inside the target cgroup rather than being attached after it starts.
Cleanup uses `cgroup.kill` and verifies the cgroup becomes empty before removal;
a bounded repeated PID-kill fallback re-reads `cgroup.procs` for kernels that do
not expose `cgroup.kill`, so descendants racing a one-shot PID snapshot cannot
silently survive cleanup.

`scripts/with-delegated-cgroup.sh` obtains a user-owned delegation with
`systemd-run --user --scope -p Delegate=yes`. It moves the wrapper into a
private `.host` leaf before enabling subtree controllers, satisfying cgroup
v2's no-internal-process rule. The script never uses `sudo` and never modifies
global cgroups.

Real Linux tests verify exact controller values, `memory.max` termination and
cleanup of a spawned descendant process.

## 3. Idle behavior and verifier lifetime

The Ilaria verifier remains persistent. A successful verifier response does not
restart it for the next effect or plan. The service has no periodic idle poller
or resource-sampling ticker: stdin and verifier pipes block on events; active
sampling exists only while a process operation is in progress.

The real integration gate samples OS CPU counters during a two-second idle
window. On the final local runs used for this milestone:

- Windows: supervisor **0 ns**, persistent verifier **0 ns** additional CPU;
- Linux/WSL2: supervisor **0 ns**, persistent verifier **0 ns** additional CPU.

These are observed counter samples, not claims of zero wakeups or zero energy.

## 4. Reproducible benchmark

`ramasite/benchmarks/workspace/benchmark-supervisor.ps1 -Samples N` on Windows and
`ramasite/benchmarks/workspace/benchmark-supervisor.sh N` on Linux build fresh native Swyp,
`plan-supervisor` and `evidence-check` binaries with `GOWORK=off`, then invoke
`ramasite/benchmarks/workspace/benchmark-supervisor.py`. Linux requires the explicit delegated cgroup
root and is run through `with-delegated-cgroup.sh`; it has no PowerShell
dependency.

Each benchmark run records its platform, exact resource configuration and sample
count. For each of N cold plans it records wall latency, summed host/Swyp/
verifier CPU counters, maximum of the three per-process peak RSS observations,
and process-start count. A second N-sample phase starts the service, completes a
plan so the persistent verifier exists, then measures trusted shutdown through
process exit and owned-child cleanup. A third N-sample phase compiles a bounded
infinite-loop plan, waits until the durable plan ledger exists and an actual
guest child is running, sends the trusted shutdown command, and measures active
cancellation through supervisor exit/containment cleanup. Any successful plan
report during that cancellation phase is rejected by the harness. Percentiles
use nearest-rank p50/p95. The benchmark does not compare Windows against Linux
as if they were equivalent environments.

Final local measurements, **20 samples per phase**:

| Measurement | Windows Server 2022, 8 logical CPUs | Linux 6.18.40.1 WSL2, 8 logical CPUs |
| --- | ---: | ---: |
| Cold plan wall p50 | 242,491,800 ns | 19,432,328 ns |
| Cold plan wall p95 | 283,378,100 ns | 27,978,697 ns |
| Total recorded CPU p50 | 62,500,000 ns | 19,482,000 ns |
| Total recorded CPU p95 | 125,000,000 ns | 31,069,000 ns |
| Peak observed process RSS p50 | 9,596,928 B | 6,189,056 B |
| Peak observed process RSS p95 | 9,891,840 B | 6,348,800 B |
| Child starts / cold plan | 3 in every sample | 3 in every sample |
| Service shutdown p50 | 0 ns | 1,173,596 ns |
| Service shutdown p95 | 16,000,000 ns | 1,407,395 ns |
| Active plan cancellation p50 | 15,000,000 ns | 3,253,588 ns |
| Active plan cancellation p95 | 16,000,000 ns | 3,303,588 ns |

Windows CPU and very short shutdown observations are quantized by the available
OS/Python timing counters; a reported zero is below observed resolution, not
proof of zero work.

Benchmark configuration on both hosts: `balanced/workstation`,
`cpu_time_ms=5000`, sampled `rss_limit_bytes=134217728`, 20 ms sample interval,
strict CPU hard-cap 8% of host CPU capacity, strict group memory 201,326,592 B and maximum 16
processes. Windows used `windows_job_object`; Linux used `linux_cgroup_v2` in a
fresh user-delegated scope. The Windows run used Go 1.27.1/Python 3.12.10; the
Linux run used a checksum-verified temporary Go 1.26.2 toolchain/Python 3.14.4.

No real energy counter was configured on either host. The benchmark therefore
reports energy as **unavailable** and records no joules, watts or battery-life
estimate.

## 5. Validation and CI

The supervisor integration gate now verifies the strict kernel mechanism in the
run report, explicit terminal recovery with zero process starts, normal replay
refusal, recovery refusal after scope/budget/strict-resource policy changes,
status/recovery after source removal, persistent-verifier reuse and bounded idle
CPU. Linux unit coverage also proves that a fake cgroup-shaped directory is
rejected before the Control Kernel journal or supervisor ledger can be created.

CI keeps ordinary SwypikOS Go tests runnable without privileged setup. The
supervisor Linux job separately enters an explicitly delegated user cgroup and
runs the real three-product integration plus cgroup backend tests. Windows runs
the equivalent integration through Job Objects. Both platforms run a five-
sample benchmark smoke, including active cancellation. Linux race testing covers
Ilaria, Swyp and SwypikOS.

Primary local gates:

```powershell
./ramasite/scripts/verify-supervisor.ps1
./ramasite/benchmarks/workspace/benchmark-supervisor.ps1 -Samples 20
./ramasite/scripts/verify-contracts.ps1
git diff --check
```

Linux real integration can be invoked from a Linux host with:

```bash
bash ./ramasite/scripts/with-delegated-cgroup.sh bash ./ramasite/scripts/verify-supervisor.sh
bash ./ramasite/scripts/with-delegated-cgroup.sh bash ./ramasite/benchmarks/workspace/benchmark-supervisor.sh 20
```

## 6. Known limits and next priorities

1. There is no serialized Swyp continuation yet. v2 can reconcile an already
   observed effect, but it correctly refuses to pretend that the program itself
   resumed from its exact PC/stack/local state.
2. The Job/cgroup envelope is strict CPU/RAM/process containment, not a complete
   hostile-code sandbox. Filesystem/network authority still belongs to the
   existing capability/effect path; v2 intentionally adds no write/network
   effect.
3. Aggregate measured per-plan CPU and strict CPU-rate cap are different
   quantities. The rate cap constrains scheduling; `cpu_time_ms` constrains
   recorded total work at host boundaries.
4. Energy remains unmeasured until a real platform energy counter is integrated.
5. A future milestone can add a versioned, authenticated serialized continuation
   format and recovery proof, then consider continuation resume. It must retain
   the current no-replay rule for effects and lease/fence checks.
6. Compiler process reuse or an attested immutable snapshot cache can reduce the
   two Swyp starts on subsequent plans without weakening program identity.

P2P training, universal installation, native-device rollout and broader side
effects remain separate milestones.
