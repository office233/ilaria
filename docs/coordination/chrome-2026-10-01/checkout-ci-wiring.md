# Public checkout CI wiring - 2026-10-01

State: COMPLETE for source wiring and local validation only. No CI run, publication or full-checkout
success has occurred. Main still refuses the default gate because its input manifest is not integrated.

Initial two claims: copied .github/workflows/ci.yml and this new report. Independent parser P2 caused
an explicit coordinator scope extension to exactly three additional claims: verify-public-checkout.ps1,
test-verify-public-checkout.ps1 and worker-oc-1-checkout.md. Total final scope is five; the manifest,
six Swyp claims, 43 approved inputs, Main and Git index/history remain protected.

Baseline copied workflow SHA256: 478768547d0671da3654b6d3f79f9dec632c5b77706354514c0daadc7d3c1acd
Wired workflow SHA256: 28deb475f14a818ced2be0687f0cdd2120c9f1d515d62772f7de0b276e1656f9
Main workflow at final probe still matches the baseline. No overwrite of Main was attempted.

Exact YAML delta: add public-checkout with Ubuntu/Windows matrix and fail-fast=true; two steps only:
the identical pinned actions/checkout@b4ffde65f46336ab88eb53be808477a3936bae11, immediately followed
by shell pwsh, run ./scripts/verify-public-checkout.ps1 using its default repository root/config.
All eight previous jobs now directly need public-checkout. Existing contracts needs are retained in
order and public-checkout appended. Existing job commands, step conditions, action SHAs, env,
permissions, caches, matrices and triggers are unchanged. No setup/install step precedes the preflight.
Existing jobs have no always() job condition bypass; normal dependency success gates their execution.

Validation: strict duplicate-key-rejecting existing PyYAML 6.0.3 PASS; header and every old job AST
excluding needs equal the baseline. Nine valid unique job IDs, known needs, previous edges retained,
no dependency cycles, two-platform gate shape, exact pinned checkout and literal existing pwsh script
path all PASS. PowerShell syntax, owned-file whitespace and git diff --check PASS. No new runtime,
package installation, model job, agent, Git mutation, push or remote workflow run was used.

Parser correction: 13 failing regressions on the former parser became GREEN; final full affected suite
56/56 PASS. Bare Bash/Node input files, valid/missing/untracked/quoted paths, module/options/composition
boundaries and non-root script-directory scope are covered; no workflow text is evaluated. See the
updated worker handoff for the finite grammar, recognized pip/pytest tooling and metadata-only limits.

Latest real Main CLI at HEAD 06a5f39f805cf36897e05ffe306d05ed212a5a3a: success=false, exit 1,
manifest missing/untracked; Main index metadata unchanged during the read-only probe. Earlier approved
public reconciliation identified the three new gate inputs absent/untracked and existing native kernel
test-host.ps1 unindexed. Integration/recheck of those public inputs remains required. The assigned
partial worktree also correctly FAILs its own missing/unindexed product dependencies without a parser
error. Neither synthetic PASS nor source wiring is presented as actual clean checkout/build/CI success.

Backup/proof location: C:/Users/abel/AppData/Local/Temp/nexus-checkout-ci-review-o8vx1bnu/.
Owner handoff: review/hash-check the five claims, retain frozen manifest SHA256
32b1cca8458605a84590903a66bf45c594793eb57a8655bf51caee3828f5e030, and let the coordinator perform
approved integration and rerun the default gate. This work stops before any integration or CI launch.
