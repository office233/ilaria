# Nexus cleanup handoff

The canonical checkout is `E:\nexus`, on its existing
`codex/nexus-supervisor-v3` branch. Its visible root directories are only
`ilaria`, `swyp`, `swypik-os`, `swypik`, `site` and `ramasite`.
Hidden Git metadata and essential root files remain where tooling expects them.

## Organization

- Agent plans, coordination, handoffs and historic audits: `ramasite/agent-md`.
- Standalone benchmarks, their sources and results: `ramasite/benchmarks`.
- Technical product documentation: `ramasite/docs`.
- Shared integration and verification scripts: `ramasite/scripts`.
- Ignored tools, environments, caches and conversation archives: `ramasite/local`.

Package-owned source tests, runtime assets and generated protocol DTOs remain
with their components. The relocation ledger is `ramasite/RELOCATIONS.json`.

Swypik commerce and mobile sources are under `swypik/commerce` and
`swypik/mobile`; the marketing site is under `site`. The original repositories
and their histories remain in `E:\Swypik`. Filtered import provenance is recorded
in `swypik/SOURCES.json`; no environments, secrets, installed dependencies or
generated binaries were imported.

## CEO preservation

`E:\CEO` no longer exists. It was archived without deleting files at
`E:\arhiva-ceo`, preserving its independent Git history, dirty coordination
documents, unique worktree source, private material and compiler tools.
The archive is deliberately outside Nexus because it also concerns Meister ERP
and GPT Bridge.

All twelve Nexus-linked worktrees now register under `E:\arhiva-ceo\wt`.
Their branches, HEADs and dirty/untracked state were verified unchanged.
The standalone broker-integration wrapper points to its two archived source
snapshots. Paths in historical documents and external launchers may still name
the former CEO location; they are historical provenance, not permission to
restore obsolete implementations or delete unique source.

The three unmerged `agent/swyp-broker-host-v1` commits and the adaptive,
compiler/broker and other unique source candidates remain preserved for
separate review. None was merged wholesale into current product code.

Only 94 screened historical benchmark files were copied into:

- `ramasite/benchmarks/swyp/ceo-20260929` (63 files).
- `ramasite/benchmarks/swypik-os/ceo-resource-20260929` (31 files).

Raw hashes and lengths were verified, and a focused 98-file commit (including
two provenance manifests and two READMEs) was created as `81324a6` on
`agent/ceo-benchmark-evidence`. Main's branch and staged content were not changed.
Nothing was pushed or deployed.

## Review boundaries

The original preexisting uncommitted Main work was preserved, not blanket-staged
or committed. A public-checkout preflight correctly refuses untracked relocated
inputs until an intentional, reviewed layout commit is prepared. Do not bypass
that guard or misreport the working tree as Git-clean.

`E:\nexus-sources`, `E:\nexus-training` and the other Nexus worktrees retain
referenced source/evidence or unintegrated work and were not removed.
The directories for Meister ERP, GPT Bridge and unrelated projects were not
modified. Permanent destruction of the CEO archive is not part of this cleanup.
