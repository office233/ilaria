# Offline existing-VM budget policy

Status: **OFFLINE_ONLY_REMOTE_DELETE_UNVERIFIED**. This module makes local
decisions only. It has no CLI, cloud implementation, subprocess, authentication,
SSH, GPU, filesystem/profile access, model or training behavior. It has never
verified remote deletion. Nothing here purchases compute or guarantees an invoice.

The caller supplies a validated manifest through `Policy.from_manifest(mapping)`;
the exact schema is shown by `manifest()` in `test_policy.py`. Those values are
synthetic test fixtures, not live authorization. Replace them with the human's
immutable existing instance ID, provider, instance type, GPU quantity, quote ID,
USD **total per VM** hourly rate, authorized budget and current capped budget.
No new instances, stop/start, restart or replacement are authorized. Quote and
runtime observations must match that entire binding; an 8-GPU quantity never
multiplies the quoted whole-VM price. Stale, future, malformed or changed quotes
fail closed. Exact Decimal arithmetic rounds projected all-in costs up to cents.

Supply timezone-aware billing start, absolute termination deadline and host stop
time, plus explicit provisioning, startup, export, deletion and freshness durations.
`prior_spend_usd` means costs already charged **outside** the current bound VM's
billable interval. All current VM time since `billing_started_at` is charged,
including provisioning and startup. Configure reserves conservatively for the
provider's billing units and deletion latency. The earlier absolute deadline or
host stop is a confirmed-termination boundary; deletion must be requested at least
the configured deletion slack before it. This deliberately treats an operational
delete deadline conservatively. A request or a powered-off VM is not termination.

`plan(policy, quote, now, work_seconds)` reserves every phase and rejects an
insufficient budget or time window. Invalid planning inputs raise `PolicyError`;
callers must treat that as denial. `evaluate(policy, quote, observation, now,
next_work_seconds)` returns a typed decision. Supply an explicit positive next
interval before doing work; a zero interval only checks reserves at that instant.
Callers must stop on any exception instead of proceeding. Runtime observations
are explicit typed values; `ReadOnlyAdapter` documents a caller-owned reader
interface without providing one.

* `CONTINUE`: only the next supplied interval plus phase reserves fits.
* `EXPORT_AND_DELETE`: stop useful work, export within its reserve, then request
  deletion. Export failure immediately produces `STOP_AND_DELETE`.
* `STOP_AND_DELETE`: stop work and request deletion of **only the immutable bound
  existing instance**. Unknown state, missing readback or a pending deletion
  remain here. This is an instruction, not evidence that deletion happened.
* `TERMINATION_CONFIRMED`: a fresh, scoped provider terminal-state readback with
  coherent timestamps confirms the supplied termination evidence. It still
  requires invoice reconciliation; late termination or a spend breach is reported.

The caller must implement actual capabilities separately, retain reliable
readback, and arrange an independent deletion mechanism before the local host
stops. This policy cannot guarantee a provider rate, taxes, storage/network charges,
billing granularity, successful export or termination latency. Include known
charges in the supplied prior spend and conservative cap/reserves. The offline
status remains unchanged even when synthetic or caller-supplied evidence passes.

From this directory: `python -m pytest -q test_policy.py` and
`python -m py_compile policy.py test_policy.py`.
