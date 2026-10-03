# Nexus Workspace

This repository contains five first-class products with independent build and
test boundaries:

- `ilaria/` — Ilaria cognitive architecture, memory, RGBA inference/training,
  model tooling and headless services.
- `swyp/` — Swyp Lang compiler, Semantic Core IR, contracts, verifier,
  synthesis and component/effect semantics.
- `swypik-os/` — SwypikOS platform, Control Kernel, Compute Fabric, device
  synthesis, native kernel seed, UI and hardware authority.
- `swypik/` — Swypik commerce (`commerce/`) and the native mobile pilot
  (`mobile/`), imported as filtered working-tree source snapshots.
- `site/` — Swypik's Astro marketing site.

The only other visible root directory is `ramasite/`, organized by purpose:

```text
nexus\
|-- ilaria\
|-- swyp\
|-- swypik-os\
|-- swypik\
|   |-- commerce\
|   `-- mobile\
|-- site\
`-- ramasite\
    |-- agent-md\       Agent plans, handoffs, coordination and audit records
    |-- benchmarks\     Benchmarks, fixtures and retained results, by product
    |-- docs\           Technical documentation, by product
    |-- scripts\        Shared verification and integration tools
    `-- local\          Ignored machine-local tools, environments and archives
```

Root Git metadata (`.git/`, `.github/`) and essential files remain in place.
Read [the organization rules](ramasite/README.md) before adding project notes or
benchmark artifacts. Product READMEs and AGENTS.md remain with their sources.

The original Swypik repositories and their Git histories remain in `E:\Swypik`.
The imported file counts and source commits are recorded in
[`swypik/SOURCES.json`](swypik/SOURCES.json); local modifications are included.
Credentials, environment files, installed dependencies and generated builds
were not imported. Each web/mobile product uses its own package manager and
lockfile; do not run deployment or installation scripts as part of cleanup.

Swyp `.swyp` component specifications are also used as source-of-truth for
cross-product protocol DTOs. CI regenerates their canonical JSON manifests and
Go types and rejects drift.

The dependency direction is intentional:

```text
Ilaria  -> proposes typed plans / model artifacts
Swyp    -> defines semantics, contracts and verification
SwypikOS -> owns effects, capabilities, devices and execution
```

There is no root Go module. Use the workspace or enter a product directory.
The workspace toolchain is Go 1.26.2 (from `ilaria/go.mod`); individual modules
may declare an older minimum language version.

```powershell
go test ./ilaria/...
go test ./swyp/...
go test ./swypik-os/...
go test ./ramasite/benchmarks/ilaria/...
```

Benchmark Go modules remain independently buildable and reference the product
modules through local `replace` directives. The commerce backend remains an
independent module under `swypik/commerce/services/platform-api`; run it with
`GOWORK=off`, not as another OS or compiler implementation.

For product-specific commands, read each product's README and AGENTS.md.

Run the complete local validation from the repository root:

```powershell
./ramasite/scripts/verify-workspace.ps1
# Include the native kernel host tests with an installed GCC or Zig compiler:
./ramasite/scripts/verify-workspace.ps1 -KernelCompiler <compiler-path>
```

The verifier runs each Go module independently (`GOWORK=off`), builds all
commands, runs the full Ilaria Forge tests, checks the generated protocol
contracts, runs the cross-product effects and supervisor integrations and checks whitespace. Python test dependencies are pinned in
[CI](.github/workflows/ci.yml). `-GoCommand` and `-PythonCommand` accept explicit
executable paths. Use `-Products swyp` or `-SkipForge` for a narrower check;
the script reports when native kernel tests were not selected.

CI covers Go tests/builds on Windows and Linux, Linux race detection, Forge,
compiler fuzz smoke and the native C/assembly host gate. Local tool distributions,
bulk training data and regenerable benchmark caches remain outside Git; sources,
tests, manifests and audit reports remain reviewable.

The [2026-09-30 audit](ramasite/agent-md/workspace/audit/2026-09-30.md) records the corrections,
validation evidence, remaining production limits and measurable next steps.
Passing these development gates does not establish model quality or real-device
kernel/driver readiness; those require separate frozen evaluation and hardware
validation.

The [broker effects v1 milestone](ramasite/docs/workspace/milestones/effects-v1.md) connects Swyp's
safe interpreter to scoped SwypikOS `fs.read`/`clock.read` execution and Ilaria's
signature verifier. Run its isolated integration gate without Forge dependencies:

```powershell
./ramasite/scripts/verify-effects.ps1
```

The [durable plan supervisor v1](ramasite/docs/workspace/milestones/supervisor-v1.md) executes
complete immutable plans with cumulative persisted budgets, independent
verification before commit, restart refusal and measured CPU/RAM. Its headless
service uses event-driven idle operation and a persistent verifier:

```powershell
./ramasite/scripts/verify-supervisor.ps1
```
