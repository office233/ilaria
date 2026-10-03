# Audit remediation — 2026-10-01

Scope: the reproducible findings from the whole-workspace audit. Existing local
changes were snapshotted into an isolated worktree; remediation does not discard
other work, load private user data or publish a release. Passing these gates is
not a guarantee of zero undiscovered bugs or real-device/model readiness.

## Correctness and integrity

- Wallet transfer signatures use the versioned, length-prefixed
  `CanonicalTransferMessage` payload, exact float bits and full UTC timestamps.
  `VerifyTransfer` refuses unsupported legacy signatures. Transfers too small to
  change the floating-point balance are refused; no signing implies settlement.
- L402 refuses sum/counter overflow before marking an invoice settled. A refused
  invoice grants no authorization; settled invoices remain idempotent.
- Critical/VIP notifications take precedence over promotional terms; words are
  matched at boundaries, not inside unrelated words.
- Sheet recalculation caches actual evaluation errors rather than interpreting
  display text as an error. Totals use a stable order; column parsing checks
  overflow before multiplication.
- Documents, app catalog entries and context observations return owned snapshots.
  Mutating a result cannot change the manager's stored state.
- IMC stream concatenation refuses output/input aliases, including hardlinks,
  validates token/EOS counts and declared hashes, hashes exactly the copied bytes,
  and refuses metadata changes during copying before publishing output.

## No fabricated defaults or authority

- New sheets, document managers, proactive engines and app catalogs start empty.
  Documents and catalog entries are supplied with `CreateDocument` and
  `RegisterCatalogEntry`. Repeated creation cannot overwrite existing content.
- Proactive context is labelled `REQUIRES_REVIEW`, with an observation timestamp,
  no execution timestamp and no claim of booking or autonomous execution.
- Maintenance recommendations require `ConfigureMaintenance`, explicit
  calibration/part/price/destination and valid telemetry. They are unsigned
  `DRAFT_REQUIRES_APPROVAL` records, never claimed TPM signatures or drone dispatch.
- Physics simulation requires `NewConfiguredSimulator(Config)`, explicit surface
  calibration and vehicle wheelbase. Unknown surfaces, robotic overspeed and
  nonfinite numeric results fail closed. Small motors have no fictitious minimum
  stall-torque/velocity denominator. Static robot evaluation counts one scenario.
- Federated trainers do not invent measured work: synthetic data requires
  `ConfigureSimulation`, has explicit seeded assumptions and `SIMULATED` evidence.
  That evidence and the full timestamp are covered by a versioned signature.
  Content hashes also use length-prefixed fields; mismatched signing keys are refused.
  GPU zero/nonfinite ceilings pause work; the maximum integer round remains finite.
- Aggregation starts empty, requires `ConfigureCandidate`, checks exact layer
  dimensions and applies updates to a copied candidate atomically. It does not
  claim production promotion or trimmed-mean robustness. Synthetic swarm work
  never earns live rewards or increments completed training jobs. Contribution and
  training are off by default.

## Configuration and launchers

- The daemon uses per-user directories or explicit environment/flag overrides;
  workspace authority must be explicit. RAM-only image paths are passed by the
  image launcher as deployment configuration, not daemon binary defaults.
- Browser paths are discovered from installed executables or explicit settings;
  no assumed `C:` installation is returned.
- Native cleanup temporary output uses `--temp-root` or the host temporary
  directory, never a developer-specific user path.
- Colab benchmark runners require explicit bundle/workspace/output paths. Bundle
  extraction refuses existing directories, traversal, symlinks, case aliases and
  oversized members; it never recursively deletes an existing workspace.
- `start-with-ilaria.ps1` builds the native desktop and connects to an explicit,
  already running protocol endpoint. It no longer assumes BitNet weights or a
  nonexistent `cmd/ilaria-serve`. `-Check` validates without starting a window.

## Validation and remaining boundaries

Regression tests accompany these changes. Required gates include independent Go
vet/tests/builds for all products, the complete Forge suite, generated contracts,
effects/supervisor integration, Linux race checks for affected packages, kernel
host/cleanup tests and `git diff --check`.

Validated after integration into `E:\nexus`:

- `verify-workspace.ps1 -KernelCompiler <installed Zig>`: PASS, including all
  independent product Go vet/tests/builds, Forge, contracts, effects, supervisor,
  native host tests and whitespace checks.
- Forge: **369 passed**. **32 new named Go audit regression tests** cover the
  corrected paths, in addition to updated existing tests.
- Linux/amd64 command builds for all three products: PASS.
- Linux race tests in WSL for docs, appstore, proactive, wallet, federated,
  worldmodel, sheets, notifications, L402, swarm and configuration: PASS.
  Windows race execution was unavailable with the installed Zig/TSan combination;
  this was not reported as a passing Windows race gate.
- Native cleanup: **59 cases, 13,550 checks, zero failures**.
- Public-checkout synthetic regression suite: **56 passed, zero failed**, using
  a portable PowerShell 7.6.6 distribution verified against its published SHA-256.
- Explicit-endpoint desktop launcher `-Check`, integrated shell/PowerShell syntax
  and a synthetic public-API reproduction of the audit failures: PASS.

The public-checkout verifier must continue to refuse required files absent from
the Git index. Existing untracked inputs must be reviewed and committed before a
clean-checkout claim; this remediation does not fake that state. The real gate
currently refuses `scripts/public-checkout.inputs.json`,
`scripts/verify-public-checkout.ps1`, `scripts/test-verify-public-checkout.ps1`
and `swypik-os/kernel/test-host.ps1`, all pre-existing untracked user work. No
commit, index manipulation, push or deployment was performed. GPU execution,
frozen model evaluation, native hardware boot and physical driver/device safety
remain separate gates. Protocol, format and architecture constants are explicit
invariants, not accidental operational hardcodings.
