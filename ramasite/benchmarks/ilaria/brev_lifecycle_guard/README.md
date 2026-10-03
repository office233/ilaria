# Brev lifecycle guard

This package owns only post-allocation lifecycle safety for an already existing
Brev workspace. It does not create instances, alter billing, approve datasets,
start training, promote checkpoints, or read credentials.

The guard is designed to run on a control host independent from the developer PC.
Its contract pins the exact Brev CLI binary, exact Brev org, instance ID and
workspace name, remote output path, export destination, required exported files,
a hard deletion deadline, and bounded absence polling. The org is mandatory; the
guard never guesses it from whichever profile happens to be active after restart.

Normal path:

inventory -> export -> byte/hash verification -> delete by exact ID ->
repeated org-scoped ls --json absence confirmation.

Budget-safety path:

When the configured emergency lead window is reached before export is verified,
deletion takes precedence. The state records emergency_delete=true; no claim is
made that artifacts were saved. The lead window must be large enough for the
configured delete command plus all required readback confirmations. A copy timeout
is clipped to the remaining pre-teardown budget.

Before deletion, the remote output directory must contain export.manifest.json.
The included build_export_manifest helper creates that manifest after trainer
publication. It binds the exact lifecycle contract, workspace ID/name, file sizes
and SHA-256 values. A completed export from another run cannot be recovered as
the current run.

The --execute flag is required for copy/delete. Without it the CLI performs only
contract validation plus a read-only org-scoped brev ls --json inventory.

Current project status: implementation/tests prove the state machine locally on
Windows and Linux, but independence from the workstation and deletion of a real
Brev VM remain unverified until the guard is actually deployed on an independent
host during an authorized paid window. ABSENT_CONFIRMED proves repeated inventory
absence, not the provider billing ledger; billing_stop_verified therefore remains
false until separate provider-side billing evidence exists.
