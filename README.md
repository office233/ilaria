# Nexus Workspace

This repository contains three first-class products with independent build and
test boundaries:

- `ilaria/` — Ilaria cognitive architecture, memory, RGBA inference/training,
  model tooling and headless services.
- `swyp/` — Swyp Lang compiler, Semantic Core IR, contracts, verifier,
  synthesis and component/effect semantics.
- `swypik-os/` — SwypikOS platform, Control Kernel, Compute Fabric, device
  synthesis, native kernel seed, UI and hardware authority.

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
```

For product-specific commands, read each product's README and AGENTS.md.

Run the complete local validation from the repository root:

```powershell
./scripts/verify-workspace.ps1
# Include the native kernel host tests with an installed GCC or Zig compiler:
./scripts/verify-workspace.ps1 -KernelCompiler <compiler-path>
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

The [2026-09-30 audit](docs/audit/2026-09-30.md) records the corrections,
validation evidence, remaining production limits and measurable next steps.
Passing these development gates does not establish model quality or real-device
kernel/driver readiness; those require separate frozen evaluation and hardware
validation.

The [broker effects v1 milestone](docs/milestones/effects-v1.md) connects Swyp's
safe interpreter to scoped SwypikOS `fs.read`/`clock.read` execution and Ilaria's
signature verifier. Run its isolated integration gate without Forge dependencies:

```powershell
./scripts/verify-effects.ps1
```

The [durable plan supervisor v1](docs/milestones/supervisor-v1.md) executes
complete immutable plans with cumulative persisted budgets, independent
verification before commit, restart refusal and measured CPU/RAM. Its headless
service uses event-driven idle operation and a persistent verifier:

```powershell
./scripts/verify-supervisor.ps1
```
