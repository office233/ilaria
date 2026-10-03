# SwypikOS migration assessment

Historical assessment of version 0.1. Version 0.2 adds static checking and native compilation; see [the newer experiment](SWYP_NATIVE_ASSESSMENT.md). The no-rewrite decision still holds, but the capability and timing statements below describe 0.1.

Date: 27 September 2026. Decision: **do not rewrite SwypikOS in Swyp Lang 0.1**. Retain Swyp as an experimental language and reassess after a typed native implementation and a useful application integration exist.

## Measured evidence

Environment: Windows amd64, Intel Core i7-9700 @ 3.00 GHz, Go 1.26.2. Standard Go test build, no custom optimization flags, one benchmark CPU (`-cpu=1`). Five measurements per case, 200 ms target per measurement; Go's benchmark runner calibrates iteration counts. Machine load and power state were not isolated. Results are medians, not confidence intervals or universal language rankings.

| Workload, per complete invocation | Go median | Swyp median | Swyp / Go |
| --- | ---: | ---: | ---: |
| Sum of squares for 1,000 values | 1.624 microseconds | 343.074 microseconds | 211.3x |
| Recursive Fibonacci(15) | 3.026 microseconds | 489.278 microseconds | 161.7x |
| Clamp and scale 1,000 generated audio values | 6.406 microseconds | 625.783 microseconds | 97.7x |

Swyp allocated roughly 24 KB / 2,998 allocations, 20.6 KB / 2,581 allocations, and 50 KB / 6,247 allocations per respective invocation. Go allocated 8 bytes / one allocation per invocation including result formatting. These are allocated bytes per operation, not peak process memory.

Parsing is excluded from the execution comparison and measured separately: median 6.627, 6.504, and 13.311 microseconds for the respective programs. Both implementations format one result to `io.Discard`; terminal I/O and process startup are excluded. Go calculations use float64, matching Swyp's numeric representation, and non-inlined functions prevent removal of the benchmark workload. The interpreter additionally performs dynamic lookup/type checks and step accounting; this compares the actual current implementations, not equivalent compiler backends. It does not isolate the cost of each runtime feature.

The audio workload adapts only the clamp-and-scale expression used in `ui/web/security.go`'s `writeChime`. It does not reproduce int16 conversion, WAV serialization, HTTP transport, or the full audio path. The other two cases are synthetic. This is not an end-to-end SwypikOS benchmark and does not imply a 98–211x slowdown for a whole application.

## Correctness and checks

- All three benchmark programs produced the same printed result as the Go reference before timing.
- The audio clamp expression matched the Go reference on nine boundary/example values and 1,000 deterministic randomly generated float32 values converted to float64 (seed 42). NaN and infinity are outside Swyp's supported numeric values.
- `go test ./internal/swyplang ./cmd/swyp` passed, including existing language/error tests.
- `go vet ./internal/swyplang ./cmd/swyp` passed.
- This experiment added tests and documentation; production application code was not migrated.

Test source: [migration_test.go](../../../docs/swyp/internal/swyplang/migration_test.go). Measurements: [SWYP_BENCHMARK_RAW.txt](SWYP_BENCHMARK_RAW.txt).

Reproduce:

```powershell
go test ./internal/swyplang -run 'TestMigrationParity|TestAudioClampParity' -v
go test ./internal/swyplang -run '^$' -bench 'BenchmarkMigration|BenchmarkSwypParse' -benchmem -count=5 -benchtime=200ms -cpu=1
```

SHA-256 of the implementation tested: `03CEC082875AA9BDB6F09EF3BFC43BBABFD22F92743E7B3F1EA857C72A640092`.

SHA-256 of migration test source: `D2F976C76732EBEAC0EBE1205DE04C7FCADE7045CB4F4DFE7A82E9D7A3D3A979`.

## Application readiness

The inspected application code uses HTTP handlers, binary encoding, buffers, integer conversions, regular expressions, filesystem path resolution, and native Go library types. Swyp currently exposes arithmetic, strings, booleans, functions, control flow, and print. It has no arrays/structs, module imports, foreign-function interface, filesystem/network API, concurrency, or UI renderer. Its `check` command does not statically resolve variable names or types. These gaps independently prevent a functional whole-application replacement today.

Implementing host wrappers would still leave those parts in Go and introduce a bridge, which should be described as integration rather than a complete rewrite. Existing benchmark success does not establish equivalence for security checks, application behavior, or model inference.

## Source obscurity

A less familiar language can make casual reading less convenient, but it is not an access-control or secret-protection mechanism. This prototype directly reads plaintext `.swyp` files and its implementation documents the semantics. Hiding code is not a sufficient migration benefit. Keep credentials out of distributed code and use explicit access boundaries regardless of implementation language.

## Reassessment gate

Continue only with a bounded experiment: specify and check types/names, compile a small subset to native code, and repeat this suite with matching numeric/error semantics. Then integrate one optional noncritical component, measure end-to-end latency and memory, and retain the existing implementation for comparison.

Before any broader migration, require feature parity for the selected component, independent regression tests, reproducible performance results, and a demonstrated benefit such as fewer integration errors or materially better development workflow. A future native backend could perform much better than this interpreter; that remains unmeasured. No current evidence supports migrating the server, desktop UI, security layer, or Ilaria integration.
