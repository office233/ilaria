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
