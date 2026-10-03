# Repo Separation Result — Ilaria / Swyp Lang / SwypikOS

**Date:** 2026-09-28  
**Source repo:** `E:\nexus`  
**Implementation worktree:** `E:\CEO\wt\repo-separation-swyp2`  
**Branch:** `agent/repo-separation-swyp2`  
**Base:** `a5a8175a5cd1ff9bb7f43d90ff9800856ea4f1fa`  
**Commit/push/deploy:** none

## Result

The repository has been physically separated into three first-class product roots:

```text
E:\CEO\wt\repo-separation-swyp2\
  ilaria\
  swyp\
  swypik-os\
```

The workspace root now contains only coordination material plus the three products:

```text
.github\
ilaria\
swyp\
swypik-os\
.gitignore
AGENTS.md
go.work
go.work.sum
LICENSE
README.md
```

The root is no longer the Ilaria Go module. A Go workspace now joins the three modules:

- `ilaria`
- `swyp-lang`
- `swypik-os`

Verified with `go list -m`.

## Physical migration

### Ilaria

The former root Ilaria module was moved history-preservingly under `ilaria/`, including:

- `cmd/`
- `cortex/`
- `forge/`
- `internal/`
- `bench/`
- `docs/`
- `scripts/`
- `results/`
- `data/`
- `cuda/`
- Go module files
- Ilaria README and AGENTS rules

Historical root audit files were moved under `ilaria/docs/audit/`.

No model training, checkpoint mutation, deployment or publication was performed.

### Swyp Lang

`swyp/` remains the canonical independent `swyp-lang` Go module.

A nested `swyp/AGENTS.md` now owns its product rules.

### SwypikOS

`swypik-os/` remains the canonical independent OS Go module.

The first-party C11/freestanding native kernel seed was moved:

```text
swypik-kernel/ -> swypik-os/kernel/
```

The Linux/reference OS path remains separate from the first-party native-kernel seed.

A nested `swypik-os/AGENTS.md` now owns OS product rules.

## Workspace integration changes

Added:
- root `README.md`
- root `AGENTS.md`
- root `go.work`
- generated `go.work.sum`

Updated:
- `.gitignore` to recognize new Ilaria data/checkpoint/cache locations while retaining legacy root ignores for pre-existing local artifacts
- `swypik-os/scripts/start-with-ilaria.ps1` so default Ilaria location is sibling `../ilaria`
- Ilaria and SwypikOS README/AGENTS paths
- selected stale Swyp documentation paths
- root CI into independent Ilaria / Swyp / SwypikOS jobs plus cross-product Swyp contract validation

## CI structure

The GitHub workflow now has:

1. **Ilaria**
   - Go vet
   - full Go test
   - existing fuzz smoke tests
   - command build
   - WebGPU compile check

2. **Swyp Lang**
   - Go vet
   - full Go test

3. **SwypikOS**
   - Go vet
   - full Go test

4. **Cross-product contracts**
   - recompiles Ilaria/SwypikOS `.swyp` component specifications
   - diffs generated canonical manifests against checked-in manifests

Workspace CI uses Go 1.26.2 because root `go.work` declares Go 1.26.2. Swyp keeps its own `go 1.21` module declaration as its source-level minimum.

## Exact validation results

### Baseline before moves

Ilaria:

```text
go test -count=1 -timeout 180s ./...
PASS
12 ok packages, 0 failed
ilaria/cortex: ~43.9s
```

Swyp:

```text
go test -count=1 ./...
PASS
7 ok packages, 0 failed
```

SwypikOS:

```text
go test -count=1 -timeout 180s ./...
PASS
44 ok packages, 0 failed
```

### Native kernel after move

From `swypik-os/kernel/`:

```text
powershell -NoProfile -ExecutionPolicy Bypass -File .\build.ps1
PASS

host architecture-neutral core tests: PASS
x86_64/arm64/riscv64 contract compile checks: PASS
benchmark schema emitter skeleton: PASS
x86_64 UEFI PE32+ seed: built
PE inspection/hash: PASS
QEMU unavailable: explicit execution blocker, not silently claimed
EFI_SHA256=b31edbeaf046452a9286f855ff938781e9938bdef39761ba124240d95c7ad7b0
```

SwypikOS immediately after kernel move:

```text
go test -count=1 -timeout 180s ./...
PASS
44 ok packages, 0 failed
```

### After full product separation

Ilaria:

```text
go vet ./...
go test -count=1 -timeout 180s ./...
PASS
12 ok packages, 0 failed
ilaria/cortex: ~31.8s
```

Swyp final:

```text
go vet ./...
go test -count=1 ./...
PASS
8 ok packages, 0 failed
```

SwypikOS final:

```text
go vet ./...
go test -count=1 -timeout 180s ./...
PASS
44 ok packages, 0 failed
```

Root structural/static gates:

```text
PowerShell parse: PASS
YAML parse: PASS
git diff --check: PASS
git diff --cached --check: PASS
go list -m:
  ilaria
  swyp-lang
  swypik-os
```

## Git state

No commit was made.

Current status contains a large number of paths because the separation is a physical history-preserving migration:

- total porcelain status records: **762**
- staged path names: **740**
- unstaged path names: **11**
- untracked entries/groups: **13**
- the overwhelming majority are Git renames produced by `git mv`

New/untracked product/workspace artifacts include:
- root `AGENTS.md`, `README.md`, `go.work`, `go.work.sum`
- Ilaria specs/manifests
- Swyp AGENTS/component compiler files/docs/example
- SwypikOS AGENTS/specs/manifests

The large status is expected for this migration and has not been committed.

## Coordination warning

Several implementation worktrees were active during this migration and still use the old paths.

Do **not** merge this separation branch into `main` blindly while those worktrees contain unlanded changes. First finish/reconcile them, then rebase/cherry-pick/merge their logical changes onto the new product paths.

The migration worktree itself did not modify those active worktrees.

## Definition of done reached in this worktree

- three explicit product roots
- independent Go modules still green
- native kernel belongs to SwypikOS
- root Go workspace valid
- runtime sibling path to Ilaria corrected
- CI split by product
- cross-product Swyp specifications validated
- no commit/push/deploy
