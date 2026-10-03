# AGENTS.md — Nexus Workspace

## Product boundaries

- `ilaria/` owns cognition, model/runtime, RGBA compute, memory and training.
- `swyp/` owns language semantics, Core IR, contracts, capabilities/effects,
  verification and code generation.
- `swypik-os/` owns OS authority, Control Kernel, Compute Fabric, devices,
  drivers, sandboxing, UI and the first-party native kernel seed.
- `swypik/commerce/` and `swypik/mobile/` own the commerce product and mobile pilot.
- `site/` owns the public marketing site.

## Repository organization

- Keep product implementations, tests, READMEs and AGENTS.md in their product roots.
- Write agent plans, handoffs and coordination records under `ramasite/agent-md/<product>/`.
- Keep standalone benchmarks and their results under `ramasite/benchmarks/<product>/`.
- Keep technical documentation under `ramasite/docs/<product>/`.
- Shared validation scripts live in `ramasite/scripts/`.
- Machine-local tools, environments, caches and conversation archives belong in
  ignored `ramasite/local/`. Never read or commit secrets or generated binaries.
- Preserve `ramasite/RELOCATIONS.json` as the path migration record.

Do not create duplicate implementations across product roots.

## Dependency rules

1. Ilaria may emit or consume Swyp schemas/plans, but must not gain ambient OS authority.
2. SwypikOS executes effects through explicit capabilities and may call Ilaria through a stable protocol.
3. Swyp must remain usable without a running model.
4. Prefer protocol/schema boundaries over importing another product's internal packages.

## Working policy

- Use a dedicated branch/worktree for non-trivial changes.
- Read the nested product AGENTS.md before editing that product.
- Do not read secrets, private files, ignored model weights, user data, or generated binaries.
- Do not push, deploy or publish unless explicitly requested.
- Run the affected product's tests and `git diff --check` before reporting completion.
