# Repo Separation Preflight — Ilaria / Swyp Lang / SwypikOS

**Date:** 2026-09-28
**Source repo:** E:\nexus
**Migration worktree:** E:\CEO\wt\repo-separation-swyp2
**Branch:** agent/repo-separation-swyp2
**Base:** a5a8175a5cd1ff9bb7f43d90ff9800856ea4f1fa

## Current truth

The repository is a monorepo whose root Go module is Ilaria:

- root `go.mod`: `module ilaria`
- `swyp/`: separate Go module `swyp-lang`
- `swypik-os/`: separate Go module `swypik-os`
- `swypik-kernel/`: first-party freestanding C11 native-kernel seed, not a Go module

Tracked-file counts at preflight:

- `cortex/`: 290
- `forge/`: 193
- `cmd/`: 49
- `swyp/`: 163
- `swypik-os/`: 232
- `swypik-kernel/`: 25
- `docs/`: 41
- `results/`: 58

Main working tree was not modified. It had only these pre-existing untracked paths:
- `.mcp.json`
- `data/modele de test/`

## Active worktrees observed

Existing worktrees must remain untouched:

- E:\CEO\wt\swos-compute-fabric-m1
- E:\CEO\wt\swos-control-kernel-m1
- E:\CEO\wt\swos-device-synthesis-m1
- E:\CEO\wt\swos-ilaria-cognitive-m1
- E:\CEO\wt\swos-install-adapt-m1
- E:\CEO\wt\swos-native-kernel-seed-m1
- E:\CEO\wt\swos-os-platform-m1
- E:\CEO\wt\swos-security-p0
- E:\CEO\wt\swos-swyp-effects-m1
- E:\nexus\.claude\worktrees\diloco
- E:\nexus\.claude\worktrees\elegant-borg-ff9a71
- E:\nexus\.claude\worktrees\hf-data-mix
- E:\nexus\.claude\worktrees\swyp-repair
- E:\nexus\.claude\worktrees\swypik-bench
- E:\nexus\.claude\worktrees\truth-hardening
- E:\nexus\.claude\worktrees\unify

The migration therefore uses its own isolated worktree.

## Existing architecture boundaries

### Ilaria

Current root owns:
- `cmd/`
- `cortex/`
- `forge/`
- `internal/`
- most Ilaria scripts/benchmarks/docs

Current AGENTS.md describes this root as the Ilaria project and explicitly says SwypikOS is a separate module.

### Swyp Lang

Already independent:
- parser/checker/interpreter
- Semantic Core IR
- bounded executor
- finite-domain contracts/verifier
- synthesis
- STV2/SWYPB
- C/native emission
- optional Ilaria client/bridge

This should be evolved rather than replaced.

### SwypikOS

Already independent Go module. Current source includes:
- Control Kernel
- agent runtime
- device synthesis
- HAL
- search
- desktop/session UI
- Ilaria integration

### Swypik native kernel

`swypik-kernel/` is a first-party C11/freestanding native-kernel seed. Its README explicitly says it is separate from the Linux reference path. Conceptually it belongs under the SwypikOS product boundary.

## Baseline

Ilaria:
`go test -count=1 -timeout 180s ./...` — PASS.
Notable package: `ilaria/cortex` passed in ~43.9s.

Swyp:
baseline running at time this report was created; final result must be appended to result report.

SwypikOS:
must be run before moving kernel/source boundaries.

## Repository instruction constraints

Root AGENTS.md currently forbids:
- reading restricted `data/`, `cuda/`, secrets, generated binaries/logs;
- modifying CI workflow files;
- modifying deploy scripts.

Therefore this migration will:
- not read or move personal/training data;
- not inspect or rewrite CUDA restricted source in this phase;
- not alter current GitHub workflow content;
- isolate code/module separation from data/checkpoint movement;
- report any CI path drift explicitly rather than silently editing protected workflow files.

## Target layout

```text
E:\nexus\
  ilaria\
  swyp\
  swypik-os\
  docs\            # cross-system only
  AGENTS.md         # workspace rules
  README.md         # workspace map
  go.work           # module workspace if validation passes
```

### Ilaria target

Move code/module-owned paths into `ilaria/` where safe:
- `cmd/`
- `cortex/`
- `forge/`
- `internal/`
- Ilaria-only benchmark/support source
- root Go module files
- Ilaria README/license as appropriate

Restricted runtime data and restricted CUDA paths are not touched in this migration phase.

### Swyp target

Keep `swyp/` as the canonical module.
Extend it toward Swyp 2.0 component/contracts language.

### SwypikOS target

Keep `swypik-os/` as canonical module.
Move the native seed `swypik-kernel/` under `swypik-os/kernel/` if all references and build scripts remain valid.

## Key migration risks

1. Current root CI assumes `go.mod`, `cortex/`, and `cmd/` at repository root.
2. Historical docs/scripts contain absolute D:/ and E:/ Ilaria paths.
3. Active implementation worktrees may later merge source changes against pre-migration paths.
4. `data/` and `cuda/` are protected by current repo instructions and cannot be blindly moved.
5. SwypikOS scripts currently describe starting Ilaria from the old monorepo root.
6. Nested Go modules mean root `go test ./...` does not validate Swyp or SwypikOS.

## Migration policy

- preserve Git history using `git mv`;
- one writer only;
- no commits/push/deploy;
- after each physical boundary change, run that module's full gates;
- no source duplication;
- compatibility shims only if unavoidable and explicitly temporary;
- create a final stale-path report.

## Swyp 2.0 direction

Swyp should become the semantic construction/verification spine for the platform, initially defining:
- components
- capabilities
- effects
- contracts
- tasks
- agents
- models/experts
- datasets/training plans
- verification/evidence schemas

Hot paths remain native Go/C/Rust/CUDA and are bound through explicit FFI/contracts.

First Swyp-defined platform artifacts should be:
1. Ilaria Cortical Protocol
2. Ilaria Expert Genome
3. Cortex Registry manifest
4. Compute Fabric job manifest
5. capabilities/effects
6. verifier evidence schema

