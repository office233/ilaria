# Preamble parsing resources

## Implementation and preserved contract

`internal/sourcefront/preamble.go:blankPrefix` uses one `strings.Builder`,
preallocated with `Grow(len(source))`. It writes each prefix byte as a space
except CR and LF, which remain unchanged, then appends the identical suffix.
It avoids the former whole-source `[]byte` allocation and final string copy.
There is no unsafe, API change, new limit, or change to parser/frontend routing.
Time is O(source bytes), with one output buffer when a prefix is present.
The `end <= 0` return remains allocation-free; oversized end is clamped.
ParsePreamble's no-preamble return remains unchanged (scanner allocations still
exist, so parsing legacy source itself is not claimed to allocate zero bytes).

Unicode prefix bytes become one space per byte, not per rune. Therefore inline
Unicode retains historical blanked-source scanner columns, which may differ
from original rune columns. Offsets and CR/LF bytes are preserved. Tests assert
oracle column parity for that case rather than silently changing semantics.

## Reproducible measurement

Both runs used the same new BenchmarkPreambleResources fixtures, Windows
Go 1.27.1 amd64, AMD EPYC 7763, GOMAXPROCS default 8, with
`GOWORK=off GOTOOLCHAIN=local GOFLAGS=-buildvcs=false` and dedicated temporary
build/cache directories. BEFORE was run before modifying blankPrefix, not
reconstructed. Fixture construction occurs outside the timer: optional
`module bench.root;\r\nuse bench.lib;\n`, then `fn main() {}\n`, then spaces
to exactly 8KiB/128KiB/1MiB. Each run repeated every benchmark three times.

From `swyp`:

```text
go test ./internal/sourcefront -run '^$' -bench 'Benchmark(PreambleResources|ModuleGraphSynthetic)' -benchmem -count=3
```

Median results (B/op has minor runtime measurement rounding):

| Fixture | BEFORE ns/op | AFTER ns/op | BEFORE B/op | AFTER B/op | allocs BEFORE → AFTER |
|---|---:|---:|---:|---:|---:|
| 8KiB preamble | 6763 | 4131 | 17864 | 9672 | 18 → 17 |
| 128KiB preamble | 51824 | 29079 | 263625 | 132552 | 18 → 17 |
| 1MiB preamble | 264083 | 145617 | 2098639 | 1050060 | 18 → 17 |
| 8KiB legacy | 587.8 | 548.0 | 1338 | 1338 | 5 → 5 |
| 128KiB legacy | 574.0 | 581.5 | 1338 | 1338 | 5 → 5 |
| 1MiB legacy | 685.9 | 705.5 | 1338 | 1338 | 5 → 5 |
| Graph ResolveGraph | 2151406 | 2021697 | 1283434 | 889318 | 1006 → 957 |
| Graph ResolveModules | 2514080 | 2551466 | 1688814 | 1294697 | 1155 → 1106 |

One full-source allocation is eliminated for every parsed preamble. Existing
graph fixtures contain 49 preambles, yielding 49 fewer allocations and about
394 kB (about 385 KiB) fewer allocated bytes/op without editing graph implementation or tests.
Wall-clock results are noisy; no statistical performance significance is
claimed. Legacy SetBytes reports the fixture size, not bytes actually scanned.

## Correctness evidence and gates

New tests compare bytes against an independent separately constructed prefix
oracle, including seeded arbitrary bytes, all ends from -1 through size+1,
CR/LF, invalid UTF-8, empty sources and clamping. Scanner filename/offset/line/
column and FirstBodyToken are checked for LF, CRLF, Unicode, comments/body,
legacy, and EOF. Duplicate/malformed declarations, exact MaxUses and +1,
use order, and allocation-free nonpositive end are covered.

Baseline targeted tests and AFTER full sourcefront tests passed; the latter
includes all nine existing graph budget/resource tests. Full `go vet ./...`
passed. Full `go test -count=1 ./...` failed only in cmd/swyp:
`TestForgeTaskReferencesAreExhaustive`, `cmd/swyp/tasks_test.go:51`, missing
`examples/swyp/tasks/tasks.jsonl`. The missing corpus was not read or modified;
coordinator remediation/scope authorization is required.

Existing malformed-body behavior is preserved: ParsePreamble accepts
`module a; /* unterminated`, while FirstBodyToken reports the scanner error.
See `preamble.go:144–147`; fixing this semantic issue is outside this change.

Linux race could not run: both the requested Go executable at
`/tmp/nexus-supervisor-go1.26.2-native-H8pXzQ5h/golang.org/toolchain@v0.0.1-go1.26.2.linux-amd64/bin/go`
and gccshim directory `/tmp/nexus-audit-gcc-20260930/bin` were absent in WSL.
No installation was attempted. Detailed command evidence and checkpoint state
are in `docs/coordination/chrome-2026-10-01/worker-oc-1.md` at workspace root.
