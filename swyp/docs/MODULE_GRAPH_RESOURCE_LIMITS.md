# Module graph resource limits

Swyp module discovery is deterministic and authority-free, but source loading is
host work and must be bounded. The resolver therefore applies an explicit
per-call resource policy before retaining graph metadata or returning linked
sources.

## Default and hard limits

The defaults are product constants. They do not depend on local RAM, CPU count,
operating system, or benchmark host.

| Limit | Default | Hard ceiling | Meaning |
| --- | ---: | ---: | --- |
| Graph nodes | 256 | 256 | Root plus unique dependencies |
| Source bytes per module | 1 MiB | 1 MiB | Exact loader result / root source |
| Aggregate graph source bytes | 16 MiB | 256 MiB | Root plus each unique dependency once |

The hard aggregate ceiling is the previous theoretical maximum
`256 × 1 MiB`; the new 16 MiB default makes that previously implicit worst
case unavailable unless a caller explicitly supplies a wider validated total
budget.

The compatibility wrappers use these defaults:

```go
ResolveGraph(ctx, filename, rootSource, loader)
ResolveModules(ctx, filename, rootSource, loader)
```

Callers that need an explicit tighter or wider aggregate policy use:

```go
type ModuleGraphLimits struct {
    MaxNodes             int
    MaxModuleSourceBytes int
    MaxTotalSourceBytes  int64
}

limits := DefaultModuleGraphLimits()
limits.MaxNodes = 64
limits.MaxTotalSourceBytes = 8 << 20

graph, err := ResolveGraphWithLimits(ctx, filename, rootSource, loader, limits)
graph, modules, err := ResolveModulesWithLimits(ctx, filename, rootSource, loader, limits)
```

`ValidateModuleGraphLimits` rejects zero/negative limits and any node,
per-module, or aggregate limit above the hard ceilings. There is no mutable
package-global policy.

## Accounting semantics

Accounting is based on logical graph membership, not loader call count:

- the root counts as one node and its source bytes count once;
- each unique dependency counts once even when several parents use it;
- a dependency already present in the graph cache is not charged again;
- aggregate admission is checked immediately after a loader returns and before
  the source is converted for preamble parsing or copied into retained state;
- exact limits are accepted; the first byte or node over a limit is rejected.

The graph-only resolver retains only:

- logical module name;
- declared `use` names;
- SHA-256 of the exact loaded source.

Complete dependency source buffers are not stored in `Graph` or in the
internal discovery map.

## ResolveModules and TOCTOU

`ResolveModulesWithLimits` deliberately performs two phases.

1. Discover the graph and hashes under the supplied limits.
2. Reload every dependency, recompute the hash, and compare it to the graph
   snapshot before returning owned source bytes.

This reload is intentional TOCTOU protection; removing it would allow a module
to change between dependency validation and linking. The reload phase applies
the same per-module and aggregate limits independently before output copies are
retained.

The root is not re-read from a loader because its exact caller-supplied buffer is
the root snapshot. Its hash is checked again during phase 2, so mutation between
the two phases fails closed.

Every returned `ResolvedModule.Source` is an owned copy. Loaders may reuse a
single backing buffer across calls without corrupting earlier hashes, graph
metadata, or returned module sources.

On any error, including a changed hash or cancellation, the resolver returns a
zero `Graph` and no module slice rather than exposing a partially built result.

## Cancellation

A nil context is rejected explicitly.

For dependency loads and reloads, cancellation is checked immediately after the
loader call returns, before parsing, hashing, or accepting its result. This also
covers loaders that return bytes while canceling the context during the call.

`FSLoader` rejects a nil context and retains its existing hard 1 MiB bounded
file read. Per-call resolver limits may be tighter than that loader ceiling.

## Compatibility

The change preserves:

- existing `ResolveGraph` and `ResolveModules` function signatures;
- graph version and JSON shape;
- deterministic lexical node ordering;
- source SHA-256 values;
- cycle rejection;
- requested-module/declaration matching;
- reload hash validation.

Only resource behavior changes for graphs whose aggregate source bytes exceed
the new default 16 MiB policy; those callers must opt into an explicit validated
aggregate budget.

## Synthetic allocation benchmark

Command used before and after the implementation:

```powershell
go test -run '^$' -bench '^BenchmarkModuleGraphSynthetic' -benchmem -benchtime=20x -count=5 ./internal/sourcefront
```

Fixture: root plus 48 unique dependencies, each dependency 8 KiB; total source
payload is about 385 KiB. The same benchmark code, host, Go process shape, and
iteration count were used for both measurements.

Median observed allocation results on the local Windows amd64 worker:

| Benchmark | Before B/op | After B/op | Change | Before allocs/op | After allocs/op |
| --- | ---: | ---: | ---: | ---: | ---: |
| `ResolveGraph` | 1,678,188 | 1,283,446 | -23.5% | 1,055 | 1,006 |
| `ResolveModules` | 2,084,464 | 1,688,816 | -19.0% | 1,205 | 1,155 |

The approximately 395 KiB reduction per operation matches removal of the
discovery-time retained copy of each 8 KiB dependency. These are synthetic local
allocation measurements, not production peak-RSS or latency claims. Timing
samples are intentionally not used as an acceptance threshold.
