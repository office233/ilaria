# Worker 1 — Round 2: Swyp module-graph resource limits

State: COMPLETE

## Workspace / branch

- MCP access verified for `E:\nexus`.
- Branch observed at start: `codex/nexus-supervisor-v3`.
- Read before edits: root `AGENTS.md`, `swyp/AGENTS.md`, current coordination `README.md`, and current `coordinator.md`.
- Existing dirty/untracked work is preserved. No reset/clean, branch switch, stage/commit, push, deploy or publication will be performed.
- Original Worker 1 v3 report remains COMPLETE and is not modified. Worker 5 owns the previously handed-off v3 files.
- No secrets, private/user data, corpus/checkpoint/weight files or active training files are read or modified.

## Exact claimed files

Worker 1-R2 exclusively claims only these files until this report becomes `State: COMPLETE`:

- `swyp/internal/sourcefront/graph.go`
- `swyp/internal/sourcefront/graph_budget_test.go` (new)
- `swyp/internal/sourcefront/graph_bench_test.go` (new)
- `swyp/docs/MODULE_GRAPH_RESOURCE_LIMITS.md` (new)
- `docs/coordination/chrome-2026-10-01/worker-1-r2.md` (new)

No CoreIR, broker, protocol, generated mirror, integrator, SwypikOS or Ilaria file is claimed.

## Stable API published early

Existing APIs remain source-compatible wrappers:

```go
func ResolveGraph(ctx context.Context, filename string, rootSource []byte, loader Loader) (Graph, error)
func ResolveModules(ctx context.Context, filename string, rootSource []byte, loader Loader) (Graph, []ResolvedModule, error)
```

Explicit per-call resource policy:

```go
type ModuleGraphLimits struct {
    MaxNodes             int
    MaxModuleSourceBytes int
    MaxTotalSourceBytes  int64
}

const (
    MaxModuleGraphNodes          = 256        // existing hard ceiling
    MaxModuleSourceBytes         = 1 << 20    // existing hard per-module ceiling
    DefaultMaxModuleGraphNodes   = MaxModuleGraphNodes
    DefaultMaxModuleSourceBytes  = MaxModuleSourceBytes
    DefaultMaxModuleGraphBytes   = 16 << 20
)

func DefaultModuleGraphLimits() ModuleGraphLimits
func ValidateModuleGraphLimits(ModuleGraphLimits) error

func ResolveGraphWithLimits(
    ctx context.Context,
    filename string,
    rootSource []byte,
    loader Loader,
    limits ModuleGraphLimits,
) (Graph, error)

func ResolveModulesWithLimits(
    ctx context.Context,
    filename string,
    rootSource []byte,
    loader Loader,
    limits ModuleGraphLimits,
) (Graph, []ResolvedModule, error)
```

Semantics promised to consumers:

- Defaults are product constants, independent of the local machine.
- Per-call limits may tighten the existing hard node/per-module ceilings; invalid/zero/overflowing limits fail before loading dependencies.
- Root plus each unique dependency counts once toward node and aggregate source-byte budgets.
- Aggregate byte admission happens before parsing/copying a newly loaded dependency into retained graph state.
- Graph-only resolution retains module metadata, preamble dependency names and SHA-256 only; it does not retain full dependency source buffers.
- `ResolveModulesWithLimits` reloads dependencies and rechecks hashes for TOCTOU protection, checks cancellation immediately after every loader/reload, owns returned source bytes, and returns no partial graph/modules on any failure.
- Existing deterministic node order, hashes, cycle rejection and module-name matching remain unchanged.

## Implementation delivered

- Existing `ResolveGraph` / `ResolveModules` signatures remain wrappers over the named machine-independent default policy.
- Added explicit validated per-call `ModuleGraphLimits` and `ResolveGraphWithLimits` / `ResolveModulesWithLimits`.
- Existing hard ceilings remain 256 nodes and 1 MiB per module. The new default aggregate source budget is 16 MiB; the explicit hard aggregate ceiling is the previous theoretical 256 MiB.
- Root and each unique dependency count exactly once toward node and aggregate-byte budgets. Shared dependencies use the loaded-metadata fast path and are not charged again.
- Dependency source admission happens immediately after the loader returns, before source-to-string preamble parsing and before retained graph state is built.
- Graph discovery no longer stores/copies complete module source buffers. It retains only `Preamble` metadata and the source SHA-256.
- `ResolveModulesWithLimits` preserves the deliberate reload/hash TOCTOU check, independently reapplies per-module/aggregate budgets, copies each successful source into caller-owned output, and returns `Graph{}`, `nil` modules on every error path.
- Context is required and checked before work and immediately after every dependency load/reload. `FSLoader` also rejects nil context explicitly.
- Existing lexical graph ordering, graph JSON shape/version, source hashes, cycle rejection, module-name matching, bounded FS reads and source ownership are preserved.

## Acceptance coverage

New `graph_budget_test.go` proves:

- aggregate budget exact limit accepted;
- exactly +1 aggregate byte rejected;
- budget rejection occurs before an intentionally invalid dependency preamble can be parsed;
- per-module exact byte limit accepted and +1 rejected;
- root + shared dependency accounting counts a shared dependency once;
- invalid zero/over-hard limits fail explicitly;
- nil resolver/FSLoader contexts fail without panic;
- cancellation triggered inside the initial loader is observed immediately after return;
- cancellation triggered during the reload phase is observed immediately and yields no partial output;
- dependency mutation between discovery and reload fails the hash check and yields no partial output;
- one reusable loader backing buffer cannot corrupt prior graph hashes or returned module sources;
- returned source bytes do not alias the caller root buffer or loader buffer;
- cycle/module-declaration mismatch behavior is unchanged;
- default wrappers produce the same graph/modules/hashes as the explicit default-limits API.

Existing `graph_test.go` was not modified and also remains green.

## Allocation benchmark — real before/after observation

Command, identical before and after:

```powershell
go test -run '^$' -bench '^BenchmarkModuleGraphSynthetic' -benchmem -benchtime=20x -count=5 ./internal/sourcefront
```

Fixture: synthetic root plus 48 unique dependencies, each dependency 8 KiB; total source payload about 385 KiB. No large corpus/private fixture was used.

Median allocation observations on this Windows amd64 worker:

| Benchmark | Before B/op | After B/op | Delta | Before allocs/op | After allocs/op |
| --- | ---: | ---: | ---: | ---: | ---: |
| `BenchmarkModuleGraphSyntheticResolveGraph` | 1,678,188 | 1,283,446 | -394,742 (-23.5%) | 1,055 | 1,006 |
| `BenchmarkModuleGraphSyntheticResolveModules` | 2,084,464 | 1,688,816 | -395,648 (-19.0%) | 1,205 | 1,155 |

The roughly 395 KiB/op reduction is consistent with removing the discovery-time retained copy of the 48 × 8 KiB dependency buffers. These are synthetic allocation measurements only; no production RSS/latency claim is made.

Documentation with the exact limits, accounting semantics, API, TOCTOU model, ownership and benchmark is in `swyp/docs/MODULE_GRAPH_RESOURCE_LIMITS.md`.

## Verification evidence

Commands run against the current working tree:

- `go test -count=1 ./internal/sourcefront` — PASS.
- `go vet ./...` from `E:\nexus\swyp` — PASS, exit 0.
- `go test -count=1 ./...` from `E:\nexus\swyp` — PASS, 15 packages OK, 0 failed. Relevant package `swyp-lang/internal/sourcefront` passed.
- Bridge `check_files` over all claimed Go/docs implementation files — PASS, zero diagnostics.
- Linux race capability probe through existing WSL Ubuntu:
  - `go version` in WSL — unavailable: `go: command not found`.
  - Standard existing locations `/usr/local/go/bin/go`, `/usr/bin/go`, `/snap/bin/go` — none executable.
  - No toolchain was installed or downloaded, so Linux `-race` was not run.
- Root `git diff --check` — PASS, exit 0. Git emitted only existing CRLF→LF warnings for three SwypikOS docs; no whitespace error was reported.
- Scoped status after implementation contains only the five claimed files.

## Limits / non-claims

- The default aggregate budget is 16 MiB, intentionally lower than the prior implicit 256 MiB theoretical maximum. A caller that legitimately needs more must opt into an explicit validated per-call aggregate limit, up to 256 MiB.
- `FSLoader` retains its existing 1 MiB hard read ceiling. Custom resolver limits can tighten it but cannot make that concrete loader accept larger files.
- Preamble parsing itself still creates transient parser/string allocations; this task removes full-source retention in the graph but does not change `preamble.go`, which is outside the claim.
- `ResolveModules` still reloads dependencies by design for TOCTOU protection; the optimization does not remove that security check.

## Handoff

Changed/released files:

- `swyp/internal/sourcefront/graph.go`
- `swyp/internal/sourcefront/graph_budget_test.go`
- `swyp/internal/sourcefront/graph_bench_test.go`
- `swyp/docs/MODULE_GRAPH_RESOURCE_LIMITS.md`
- `docs/coordination/chrome-2026-10-01/worker-1-r2.md`

No original Worker 1 v3 file/report, CoreIR, broker, protocol, generated mirror, Worker 5 file, SwypikOS file or Ilaria file was edited.

After this report becomes `State: COMPLETE`, these files are released to the coordinator/integrator and Worker 1-R2 stops editing them.
