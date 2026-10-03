# Repository organization

This directory contains supporting material, not extra product implementations.
Product source lives only in `ilaria`, `swyp`, `swypik-os`, `swypik` and `site`.

| Directory | Contents |
|---|---|
| `agent-md/<product>` | Agent plans, handoffs, coordination, historical audits |
| `benchmarks/<product>` | Standalone benchmark sources, fixtures and results |
| `docs/<product>` | Technical guides, architecture and component documentation |
| `scripts` | Shared verification scripts and their input manifests |
| `local/tools` | Ignored local compiler distributions |
| `local/agents` | Ignored per-machine agent configuration |
| `local/environments` | Ignored Python environments |
| `local/caches` | Ignored caches retained without deletion |
| `local/conversatii-claude` | Existing conversation archive, moved without inspection |

Use `workspace` for material shared by several products. Keep a benchmark's
fixtures and reports together; do not scatter loose output into product roots.
Do not move package-owned unit tests or runtime assets out of their components.
Root and product README.md and AGENTS.md files are source navigation and working
policy, not agent plans.

`RELOCATIONS.json` records old and new paths and the hashes of path-only text
updates. No preexisting local work was discarded. Historical JSON evidence
keeps its original provenance paths; use the relocation record to find the
current location instead of rewriting signed or hashed evidence.

Run shared checks from the repository root:

```powershell
.\ramasite\scripts\verify-public-checkout.ps1
.\ramasite\scripts\verify-workspace.ps1
python .\ramasite\scripts\run-python-tests.py --list
```

The benchmark Go modules have local dependencies on their product modules.
Enter `ramasite\benchmarks\ilaria` for its Go tests; Swyp research drivers can be
built explicitly from `ramasite\benchmarks\swyp` without importing code into the
product's internal directories.

`E:\nexus-sources` holds licensed source material referenced by training records.
`E:\nexus-training` holds training and integration evidence.
The inspected `E:\nexus-worktrees` copies contain local work or unmerged commits,
so they were not deleted or relocated.

The former `E:\CEO` multi-project coordination repository is preserved intact at
`E:\arhiva-ceo`, outside Nexus. Its organizational documents, private material,
tools and unintegrated source remain archived rather than deleted or swept into
this repository. All twelve Nexus-linked worktrees were repaired at their archive
paths, keeping their HEADs, branches and existing dirty/untracked work.

Only 94 screened benchmark-source and historical-evidence files were imported
into `benchmarks/swyp/ceo-20260929` and
`benchmarks/swypik-os/ceo-resource-20260929`, with raw provenance manifests.
They are preserved in focused commit `81324a6` on
`agent/ceo-benchmark-evidence`, without staging or committing Main's existing
work. Meister ERP, GPT Bridge and all other project directories were untouched.
