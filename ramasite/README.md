# Repository organization

Product implementations live in `ilaria/`, `swyp/` and `swypik-os/`.
This directory holds supporting material, not duplicate runtimes.

| Directory | Contents |
|---|---|
| `agent-md/<product>/` | Plans, handoffs, historical audits |
| `benchmarks/<product>/` | Standalone benchmark sources, fixtures and results |
| `docs/<product>/` | Technical guides and architecture |
| `scripts/` | Shared verification tools and their manifests |
| `local/` | Ignored machine-local tools, environments, caches and archives |

Use `workspace` for shared material. Product README.md, AGENTS.md and
package-owned unit tests remain with their sources.

`RELOCATIONS.json` records the owner-approved migration. Historical evidence
keeps its original hashes and provenance paths; a relocation is not a new
training, quality, security or hardware qualification.

```powershell
./ramasite/scripts/verify-public-checkout.ps1
./ramasite/scripts/verify-workspace.ps1
python ./ramasite/scripts/run-python-tests.py --list
```

The commerce/mobile/site source imports and the former CEO archive are retained
outside this core integration for separate reviews. No archive worktree, source,
private material, or unique history is deleted or included by implication.
