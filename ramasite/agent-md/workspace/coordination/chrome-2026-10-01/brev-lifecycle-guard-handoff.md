# Brev H200 lifecycle guard

State: STOP/FROZEN — LOCAL/LINUX GATES PASS, READY FOR SELECTIVE INTEGRATION.

Scope is limited to the new ilaria/bench/brev_lifecycle_guard package and this
handoff. No existing trainer, data pipeline or cloud configuration file is claimed.

The implementation is a fail-closed export/deletion state machine for an already
allocated Brev workspace. Real cloud mutation is explicitly out of scope for local
validation; no VM is created, copied from, stopped, or deleted by this handoff.

## Contract and failure semantics

The content-addressed contract pins the exact Brev org, workspace name and ID,
CLI bytes, remote output path, local export destination, required files, hard
deletion deadline, emergency lead, copy/command timeouts, poll interval and
required absence confirmations. The guard serializes concurrent controllers with
an OS file lock and persists an atomic event journal.

Normal path: inventory -> export -> manifest/file hash verification -> exact-ID
delete -> repeated org-scoped ls --json absence confirmations.

If export is still unverified when the reserved teardown window begins, budget
safety takes precedence and the guard issues an emergency delete. If a copy call
fails after crossing that boundary, the same emergency path is taken. Before the
boundary, an export error fails closed and no delete is issued. A pre-existing
export is reusable only if its manifest binds the exact contract SHA, instance ID
and workspace name and every required byte/hash validates.

Initial inventory absence is never called deletion proof. It is an error unless
this persisted contract already records a successful delete request. Terminal
ABSENT_CONFIRMED requires the configured number of consecutive readbacks.

The terminal state intentionally keeps billing_stop_verified=false: resource
absence is not a provider billing-ledger receipt.

## Verification

- Windows targeted lifecycle suite: 13/13 PASS.
- Linux pinned CPU runtime targeted lifecycle suite: 13/13 PASS; this exercises
  the POSIX fcntl lock path.
- IMC model + lifecycle suite: 33/33 PASS.
- Required Ilaria GOWORK=off go test ./...: PASS (8 test-bearing packages).
- Required Ilaria go vet ./...: PASS.
- py_compile: PASS.
- Pyright/LSP on both Python files: 0 diagnostics.
- Official local Brev CLI read-only pin: v0.6.335, SHA-256
  06b9b68018e6c346b03d04480f447f0a6e6662c707db15c41e82190b614b2b10.
- Read-only help verified the expected ls --json/--org, copy, and delete syntax.

No Brev org list was read merely to fabricate a demo contract. A real executable
contract still requires the exact operator/provider org at the authorized window.
No provider mutation, GPU allocation, paid job, secret read, Bridge/config change,
stage, commit, push or deploy occurred.

This code makes the teardown mechanism implementable on an independent host but
does not prove that such a host has been deployed. Real export, real deletion and
provider billing-stop evidence remain operational gates before H200 allocation.
