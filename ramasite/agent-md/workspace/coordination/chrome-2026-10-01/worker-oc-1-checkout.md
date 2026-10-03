# OC1 public checkout gate - reviewed parser correction and CI handoff

State: COMPLETE for gate implementation/correction and copied-workflow wiring only.
Owner: local Codex /root/audit_swypik after coordinator-confirmed OC1 Azure rate-limit terminal state.
No OpenCode/model job, install, cloud/CI run, push, commit or integration was performed.
Main dependency closure remains FAIL; full public checkout/CPU/GPU/train/CI success is NOT claimed.

Dedicated worktree: E:/nexus-worktrees/opencode-preamble-r3, branch codex/opencode-preamble-r3.
Final authorized scope is exactly five claims:

- scripts/verify-public-checkout.ps1
- scripts/test-verify-public-checkout.ps1
- docs/coordination/chrome-2026-10-01/worker-oc-1-checkout.md
- .github/workflows/ci.yml
- docs/coordination/chrome-2026-10-01/checkout-ci-wiring.md

scripts/public-checkout.inputs.json remains frozen, as do six Swyp claims, 43 approved copied public
inputs, branch/index/history and Main. Only the copied workflow was separately reopened for wiring.

## Read-only gate and parser review correction

    pwsh -NoProfile -File scripts/test-verify-public-checkout.ps1
    pwsh -NoProfile -File scripts/verify-public-checkout.ps1 -Root <checkout-root> -Format Json

PowerShell 7 interface, tested locally with Windows PowerShell 7.6.5. Root is generic; no host root,
expected HEAD or historical counts are hardcoded. Real Git rev-parse and ls-files --stage -z use literal
ProcessStartInfo arguments with optional locks disabled. There is no Git-status fallback, staging or
execution/evaluation of workflow/dependency text. Synthetic Git adapter is in-process only; production
CLI cannot accept it. LibraryOnly requires actual dot-sourcing and cannot silently pass as a CLI mode.

Exact versioned JSON fields/types, duplicate/alias/unknown-key rejection, nonempty input arrays and
canonical-path duplicate rejection are enforced. Required manifest/workflow/discovered script paths
must exist as regular contained files and be indexed. Paths with spaces/literal brackets are supported;
traversal, absolute/drive/control/wildcard paths, symlink/reparse ancestors and malformed/unmerged Git
metadata fail closed. No-vacuous-success and GOWORK off policies remain. Metadata text is bounded;
Git waits have a 15-second timeout. This is not a hostile resource sandbox or committed-content attestation.

Independent review proved a P2: bare `bash helpers/public` and `node tools/public.js` paths were omitted.
On the previous accepted parser, the new suite had 13 failures: absent/existing-untracked/valid-inventory
Bash and Node inputs, quoted paths, and opaque module/eval/option/composition forms. After correction,
all these cases are GREEN. The manifest/mocks were not changed to hide the defect.

The parser now inventories mandatory literal interpreter source inputs with or without ./, including
quoted spaces. Unknown modules, inline evaluation/load options, unknown interpreter options, opaque
compositions, non-root local-script working directories and repeated-path scope reuse fail closed.
The current literal delegated Bash/Go composition remains supported. Known existing `python -m pip
install ...` and `python -m pytest ...` CI tooling are recognized explicitly as non-script module calls;
this is NOT module/runtime closure proof. Local pip requirement/constraint inputs and unknown modules
are refused. Other non-script tool commands and recursive imports are outside this explicit file gate.
Aliases, dynamic commands, unsupported YAML/flow/merge/anchor/folded/complex-key/local-action forms
must not be treated as automatically supported; the parser is bounded, not a general YAML/shell validator.

## Actual gates and scope integrity

- Full affected script fixture suite: PASS 56/56, exit 0, no skipped cases. Original 39 cases retained;
  bare-input correction plus explicit grammar/scope boundaries added. Source text is never executed.
- Valid/missing/untracked/generated inputs; Git errors/nonrepo/root/head/conflict/index symlink;
  path containment and actual owned-temp reparse; JSON fields/types; PS/Bash/Python/Node paths;
  opaque grammar refusal; GOWORK; no-vacuous and real CLI library refusal are covered.
- Fixtures use synthetic public text and mocked authoritative Git records. No git init/add/stage/commit.
  Owned-temp cleanup verifies an absolute path under temp with an exact generated prefix; link targets
  in the reparse test are also within that owned temp root.
- Copied wired workflow parses through strict duplicate-key-rejecting existing PyYAML 6.0.3; nine
  valid job IDs and all needs references/cycles verified. All previous job fields except needs match
  the exact copied baseline AST; existing commands/actions/permissions/caches remain unchanged.
- PowerShell syntax, explicit owned-file whitespace, git diff --check and protected hashes: PASS.
  Six Swyp and all 43 approved public hashes remain baseline-identical; worktree index unchanged.
- No unaffected product/CPU/GPU/model suites or remote GitHub CI were run or certified.

Own partial worktree correctly refuses its unindexed/missing inputs: ilaria/go.mod, swypik-os/go.mod
and native kernel test-host.ps1 remain absent there. Wired workflow discovers nine unique script
references and evaluates 54 dependency paths, with no parser error. No index mutation to make it green.

## Real Main proof and coordinator follow-up

Latest real CLI proof at E:/nexus, HEAD 06a5f39f805cf36897e05ffe306d05ed212a5a3a: success=false,
exit 1; scripts/public-checkout.inputs.json missing and untracked; dependency closure cannot be
evaluated. No external manifest was used to produce success. Main index metadata remained identical
during the probe, and its workflow still matches copied baseline SHA256
478768547d0671da3654b6d3f79f9dec632c5b77706354514c0daadc7d3c1acd.

The preceding independent public metadata reconciliation found three new gate inputs absent/untracked
(verify-public-checkout.ps1, test-verify-public-checkout.ps1, public-checkout.inputs.json), plus existing
swypik-os/kernel/test-host.ps1 unindexed. Recheck those exact closure gaps before integration;
historical seven-untracked-script assertions are not substituted for observed metadata.

Coordinator must review/hash-check these five claims and the separately frozen manifest, integrate only
approved files, resolve the native host script index gap, then rerun the default gate in Main. Wiring is
source-only evidence: no CI event launched and no full-checkout or build success yet. Source attestation
approval remains governed by existing Ilaria procedures; none was fabricated here.

Public baseline backups/proofs: C:/Users/abel/AppData/Local/Temp/nexus-checkout-ci-review-o8vx1bnu/
(including main-current-gate.json); earlier gate metadata proof backup remains
C:/Users/abel/AppData/Local/Temp/nexus-public-checkout-090c53ee413f4284bc0360df875bd736/.
No secrets, corpus, private user data, weights or generated binaries were read.

| Public source / frozen manifest | SHA256 |
| --- | --- |
| scripts/verify-public-checkout.ps1 | e82da9af42831064c5ec8191cd14eb4a971c27fa72cf51e6243013b70525fc14 |
| scripts/test-verify-public-checkout.ps1 | f63aeedae09278ebdff61de73c67e0deb5336aae251ad589d392b4470f6681d6 |
| scripts/public-checkout.inputs.json | 32b1cca8458605a84590903a66bf45c594793eb57a8655bf51caee3828f5e030 |
| .github/workflows/ci.yml | 28deb475f14a818ced2be0687f0cdd2120c9f1d515d62772f7de0b276e1656f9 |

The report hashes are supplied separately in the final handoff. Claims are refrozen after final checks.
