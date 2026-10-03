# Public checkout Main acceptance - 2026-10-01

State: independent review PASS; exactly six approved claims integrated byte-identically.
Actual production preflight remains FAIL, exit 1. No clean-checkout/build/CI success is claimed.

Source: E:/nexus-worktrees/opencode-preamble-r3; destination: E:/nexus.
The source worktree and both source-owner reports remain frozen and unchanged.

## Independent review and copy preconditions

Compared parser/test delta against the first handoff backup, with exact 7ef445.../b1ad66... hashes.
Both original missing bare Bash/Node inputs now fail with missing and untracked issues and are inventoried.
Tracked bare inputs and quoted paths with spaces/brackets pass; six opaque module/eval/options forms refuse.
Workflow/dependency text is never evaluated; real Git still uses separate literal process arguments.
pip/pytest are explicit bounded tooling exemptions, not module/runtime closure certification.
Strict duplicate-key YAML comparison preserved every previous job field except the authorized needs delta.
The Ubuntu/Windows preflight has only pinned checkout then the default pwsh verifier; all eight old jobs
need its success, retaining previous needs, commands, action SHAs, permissions, triggers and matrices.
Nine job IDs and dependency references/cycles pass validation; no remote CI execution was launched.

Main workflow matched copied origin SHA256 478768547d0671da3654b6d3f79f9dec632c5b77706354514c0daadc7d3c1acd.
All other five destinations and this acceptance report were absent before copy; no overlay occurred.
Only the following six approved claims were copied; Main and frozen source hashes match exactly:

| Claim | SHA256 |
| --- | --- |
| .github/workflows/ci.yml | 28deb475f14a818ced2be0687f0cdd2120c9f1d515d62772f7de0b276e1656f9 |
| scripts/verify-public-checkout.ps1 | e82da9af42831064c5ec8191cd14eb4a971c27fa72cf51e6243013b70525fc14 |
| scripts/test-verify-public-checkout.ps1 | f63aeedae09278ebdff61de73c67e0deb5336aae251ad589d392b4470f6681d6 |
| scripts/public-checkout.inputs.json | 32b1cca8458605a84590903a66bf45c594793eb57a8655bf51caee3828f5e030 |
| docs/coordination/chrome-2026-10-01/worker-oc-1-checkout.md | 19a74008959806498cc6d22b95dc0abd03fec5e9d692706b334b68b37ceda1d0 |
| docs/coordination/chrome-2026-10-01/checkout-ci-wiring.md | 26c2aa502cb6246016c4e3ea82ed0224eaf17f4769f4d8f959396091d26bd845 |

## Actual Main gates and preserved state

Main affected regression command: pwsh -NoProfile -File scripts/test-verify-public-checkout.ps1.
Actual result: PASS 56/56, exit 0, no skipped cases. PowerShell parsing and strict Main YAML/needs PASS.
Main YAML equals the independently reviewed frozen AST; explicit owned whitespace and git diff --check PASS.
Default real command: pwsh -NoProfile -File scripts/verify-public-checkout.ps1 -Format Json.
Actual result: success=false, exit 1; nine workflow references and 54 dependencies, all present.
Exactly four issues, all untracked, with no missing input or parser error:

- scripts/public-checkout.inputs.json
- scripts/verify-public-checkout.ps1
- scripts/test-verify-public-checkout.ps1
- swypik-os/kernel/test-host.ps1 (preexisting; not copied or edited here)

Before/after Main HEAD: 06a5f39f805cf36897e05ffe306d05ed212a5a3a; staged paths: 0 throughout.
Before/after exact Git index metadata SHA256: 35489bc7b37386db6a34b612ea60f5061d33dbe8eee74153bc6d3401a75efcbd.
All 518 preexisting porcelain entries were retained; workflow already had modified status before copy.
Copy added only five new claim paths; this new acceptance report adds one further untracked path.
Final status also observed concurrent untracked p2p-network-integration-preflight.md in this directory;
that disjoint report was not read, copied or edited by this task. No preexisting status entry disappeared.
No product/P2/P15 claim, existing unrelated Main change, index or history was edited by this task.

## Pending coordinator work and limits

To be committed by the coordinator after review: the six copied claims and this acceptance report.
The three new gate inputs require indexing; the existing native test-host.ps1 requires a separate reviewed
indexing/commit decision. Reports are handoff documents, not additional compiler/gate inputs.
The gate is metadata/existence/index proof, not immutable committed-content or full dependency closure proof.
No staging, commit, push, install, network, model job, product suite, build or CI launch was performed.
No private corpus/user data, secrets, keys, model weights or generated binaries were inspected.
Source owner observations of Main before integration remain historical, unchanged in their frozen reports.
