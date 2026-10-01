# Durable plan supervisor v3

Status: integration in progress; this document is not a completion claim.

Supervisor v3 extends v2 without changing product authority boundaries:

- **Ilaria** remains cognition/training plus independent evidence verification;
- **Swyp** owns deterministic language/Core IR semantics, versioned continuation state and verification without requiring a model;
- **SwypikOS** owns persistence authentication, execution authority, resource containment, recovery, cache policy and platform resource telemetry.

V3 must not weaken the v2 Windows Job Object / Linux cgroup v2 containment or the independent evidence requirement. It does not claim universal-device installation, P2P training, deployment or publication.

## Acceptance contract

The integration gate is `scripts/verify-supervisor-v3.{ps1,sh}` with the portable black-box orchestrator `scripts/verify-supervisor-v3.py`. Every invocation builds fresh worker-local temporary copies of:

1. `swyp`;
2. `plan-supervisor`;
3. `evidence-check`.

No global PATH/environment/system configuration is modified. Linux requires an explicit pre-existing delegated cgroup v2 root and never obtains privilege with sudo/admin.

The gate emits a version-3 JSON report containing per-scenario `PASS`, `FAIL` or `SKIP`, concrete evidence, the real containment mechanism, and energy availability/scope. `SKIP` is not accepted by the final v3 gate; it exists only so integration can be developed honestly while an external platform facility or worker handoff is unavailable.

Required final scenarios:

- uninterrupted execution vs suspend/crash/resume with identical final result;
- no provider replay for an already resolved effect;
- continuation mutation plus module/run/policy/fence mismatch rejection;
- missing durable result/payload/independent evidence rejection;
- explicit immutable snapshot-cache hit;
- source/dependency/compiler/protocol/policy cache invalidation;
- corrupt/truncated/hostile cache rejection and quota enforcement;
- strict CPU/RAM/process containment remains kernel-enforced;
- cancellation contains descendants;
- persistent evidence verifier reuse and bounded idle resource use;
- optional platform energy measurement with the real measurement scope, otherwise explicit `unavailable`.

### Independent acceptance matrix

| Area | Required black-box observation |
| --- | --- |
| Resume equivalence | A deliberately interrupted execution resumes from the durable checkpoint and produces exactly the same final completion/result hash as an uninterrupted execution of the same plan. |
| No replay | The provider-side observation count for the already committed effect does not increase during resume; the next effect sequence is exactly checkpoint cursor + 1. |
| Continuation tamper | Mutated state/payload, run, module, execution policy or fence/epoch is refused before guest instructions or provider effects can advance. |
| Missing durable evidence | Removal of the committed result, payload/continuation record or independent verification evidence makes exact resume fail closed. |
| Cache hit | A second identical compile request uses the explicit verified cache and avoids a new preflight compiler process while yielding byte-identical canonical IR. |
| Cache identity | Source, dependency, compiler, protocol and compile-policy mutations each derive a miss/new identity; runtime-only identity must not be smuggled into compile-cache trust. |
| Cache hostile disk | Corrupt, truncated, oversized, unexpected-path and unverifiable entries are rejected/removed according to the cache contract and never executed. |
| Cache quota | Published entries remain within configured entry/byte limits under repeated inserts and deterministic eviction. |
| Containment | The integrated v3 path still reports the native Job Object or delegated cgroup v2 mechanism and enforces CPU/RAM/process ceilings. |
| Cancellation | Cancelling a running plan terminates or contains all guest/verifier descendants with no survivor outside the process group. |
| Verifier lifecycle | Multiple plans reuse the persistent independent verifier; no verification authority is moved into Swyp or the guest. |
| Idle | A quiescent service performs no background cache/energy polling; CPU delta remains bounded by the existing idle gate. |
| Energy | Each available counter carries source/scope/domain/unit and only real measured deltas; unsupported hardware/permission/platform is explicitly `unavailable`, never estimated. |

Final milestone status requires every non-energy row to pass on the supported host
path. Energy is allowed to be `unavailable` only when the sampler returns a
concrete platform reason and no fabricated value.

## Coordination state at integration start

Worker 1, Worker 2 and Worker 3 were still `RUNNING` when Worker 5 started. Worker 4 had not yet published a report. Their owned files are not modified before `State: COMPLETE` plus explicit handoff. Until then the v3-only harness probes report `SKIP` with the missing contract rather than assuming an API.

## Evidence

Pre-handoff Windows harness smoke:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\verify-supervisor-v3.ps1 -AllowSkips
```

Observed on Windows Server 2022, 8 logical CPUs, Python 3.12.10:

- fresh temporary builds of `swyp.exe`, `plan-supervisor.exe` and `evidence-check.exe`;
- v2 three-product black-box gate: PASS;
- kernel limit mechanism: `windows_job_object`;
- persistent verifier service gate: PASS;
- two-second idle CPU counter deltas: supervisor 0 ns, verifier 0 ns.

The continuation, cache and energy scenarios were intentionally `SKIP` because their owners had not completed handoff. These observations are therefore only baseline/harness evidence, not final supervisor v3 measurements or completion.

The same workstation also exposes Ubuntu WSL2 with kernel
`6.18.40.1-microsoft-standard-WSL2`, cgroup v2 and a running user systemd
instance. The existing no-sudo `with-delegated-cgroup.sh` wrapper successfully
created a user-owned delegated scope, so Linux v3 integration/race verification
is expected to be runnable locally once the owner handoffs are complete.

## Non-goals / later milestones

- universal installation on arbitrary devices;
- P2P/distributed training;
- broad new side effects;
- claims of energy savings without a platform counter with known scope;
- replacing the native SwypikOS kernel direction with the Linux reference path.
