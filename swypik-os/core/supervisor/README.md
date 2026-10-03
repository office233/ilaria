# Durable plan supervisor v2

This library admits one immutable compiled Swyp program and delegates actual
effect authority to `core/effects` and `core/controlkernel`. The host supplies
the compiled module hash/entry, function/effect capability bindings, exact
scope rules, deadlines, identities and budgets. Guest requests cannot create
or widen this policy. The caller validates the compiled plan and terminal
guest frame through the shared protocol and process adapters.

`Open(Config)` returns a supervisor with `Status`, `Start`, `Handle`, `Finish`,
`Abort` and `Close` methods. `Start` durably reserves the guest launch before
the caller starts a process. `Handle` returns publishable evidence only when
its error is nil. It validates run ID plus the next monotonic sequence,
module hash, actual function/effect binding, capability, exact relative path,
deadline and cumulative budgets before issuing a lease or effect grant.

`Inspect(kernel, ledgerPath, taskID, runID)` replays owned durable status without
compiling source, opening read roots, or invoking a verifier. It refuses missing,
empty, damaged or mismatched ledgers. The journal contents are read-only: the
existing Control Kernel lock mechanism still uses its lock sidecar, and an
incomplete final frame requires an explicit normal recovery open.

The immutable policy hash includes the plan, host scopes, root paths,
executor/verifier/signer identities, and optional `ExecutionPolicyHash`. The
caller uses this extra hash to pin typed entry arguments, fuel, returned-value
limits, terminal expectations and process CPU/RSS limits. Credentials and
private signing material are not persisted in the plan ledger.

The separate private supervisor journal uses the existing Control Kernel
`EventStore` durability, locking and hash-chain implementation. It records
launch, request sequence, full upper-bound read reservations, commits, failure
and terminal-frame hashes. The v2 creation record also serializes the normalized
program identity (task/run/module/entry/effects/bindings/deadline/budgets) needed
to inspect an interrupted run without recompiling source. It owns
admission/accounting, not effect authority.
The Control Kernel task pins the ledger identity and policy hash. An existing
task with a missing or empty ledger fails closed instead of resetting quotas.

The library preallocates at most 64 effect nodes in one task before its first
node becomes READY and freezes the topology. It charges each allowed file
read's full byte ceiling before invoking a provider and never refunds that
reservation. Clock reads charge zero file bytes. The protocol/per-read, task,
node and cumulative plan limits all apply.

A successful broker result enters independent verification. The callback must
correlate request/result hashes, the SHA-256 of receipt signing bytes, and the
independently supplied OS execution binding. A separate authenticated verifier
principal records the verdict through the Control Kernel. Only a passing
verdict permits `VERIFYING -> COMMITTING`, intent `COMMITTED`, then node
`SUCCEEDED`. A correlated rejection records a failed verdict and enters
reconciliation; unavailable or malformed verification does not invent a verdict.
Values are never released to the guest by a failed `Handle` call.

`Finish` accepts the hash of a full terminal frame already validated by the
caller after successful guest exit. Every issued effect must be committed;
unused preallocated nodes are cancelled before durable plan success. This
library does not interpret the final program result or claim application
correctness. `Abort` records a durable failed/uncertain run even when its
context is cancelled.

`OpenRecovery(Config)` reconstructs the immutable program identity from the
v2 ledger before validating current host policy. It does not compile source,
open read roots, launch a guest, execute an effect provider, or call the Ilaria
verifier. `Recover(ctx)` then inspects the supervisor ledger together with the
Control Kernel node, lease/fence, intent and already durable independent
verification. A live original lease is left untouched. An expired lease can be
requeued and an interrupted intent can enter the Control Kernel reconciliation
path, but an effect is accounted as committed only when a matching independent
`PASSED` verification exists for the same attempt/lease/fence and the intent
converges to `COMMITTED`.

Recovery never reexecutes a started or committed effect. Missing or invalid
evidence remains uncertain. v2 deliberately has no serialized Swyp stack/PC/
locals continuation, so even after an interrupted effect is safely reconciled,
the whole plan is stopped `UNCERTAIN` with
`reconciled_no_serialized_continuation`; it never claims exact program resume or
plan success. A fully finished plan is reported as terminal and is not rerun.

The caller wraps the whole active plan in the existing resource Governor and
connects its Control Kernel transition sink. This library creates no polling
loop, process, model service, privileged operation or ambient grant. Process
transport, strict process-tree quotas, CPU/RSS metering and terminal-frame
validation belong to the host adapter. Tests fault every durable supervisor/
Control-Kernel boundary and cover restart, invalid evidence, expired/live
leases, changed policy and damaged journals without replaying effects.
