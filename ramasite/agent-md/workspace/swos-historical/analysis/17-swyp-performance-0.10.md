# Swyp 0.10 Performance Upgrade — 2026-09-29

## Implemented in E:\nexus\swyp

### Persistent compiler/runtime
- Added `swyp core-server`.
- JSONL stdin/stdout only; no network listener.
- Supports:
  - `build` -> existing verified `core-build`;
  - `run` -> embedded Core execution;
  - `check` -> Core parse/typecheck/lowering;
  - `shutdown`.
- Reuses the same CLI semantics; no shadow compiler.

### Content-addressed AOT cache
- `core-build` now supports `-cache-dir auto|off|DIR`.
- Default `auto` uses OS user cache.
- Key includes:
  - source bytes;
  - entry point;
  - profile;
  - CPU target;
  - LTO/strip options;
  - compiler identity;
  - GOOS/GOARCH;
  - cache format version.
- Cache check runs before ParseCore/typecheck/IR/codegen on a hit.
- Output remains create-only and is copied from immutable-style cache artifact.
- Tests verify cache hits and semantic key changes.

### Reproducible benchmark suite
Added:
- `benchmarks/swyp/core_server_bench.py`
- `internal/swyplang/pipeline_bench_test.go`

## Measurements — i7-9700 workstation

### Core frontend in-process
Command:
`go test -run=^$ -bench=BenchmarkCoreFrontendPipeline -benchmem -benchtime=3s -count=1 ./internal/swyplang`

Measured:
- ~111,734 ns/op = ~0.112 ms
- ~85 KB/op
- ~1,030 allocations/op

This means the frontend itself is not the dominant source of interactive latency.

### CLI cached AOT
Initial cache implementation:
- cold build ~555 ms
- cached fresh-process build ~34 ms median
- ~16x cold-to-warm speedup

After moving cache lookup before frontend:
- cold ~560 ms
- cached fresh-process ~33.3 ms median

No material difference, proving process startup + output materialization dominate warm CLI time, not parsing/lowering.

### Persistent core-server
Evidence: `E:\CEO\swyp-server-run-bench-20260929-082412`

Measured:
- embedded RunFast median: ~0.227 ms
- RunFast min: ~0.172 ms
- RunFast p95: ~0.298 ms
- Core check median: ~0.239 ms
- check min: ~0.166 ms
- check p95: ~0.296 ms

### Persistent cached AOT materialization
Evidence: `E:\CEO\swyp-server-bench-20260929-082308`

Measured:
- cold AOT in server: ~354 ms
- cached materialization: ~15.6 ms median
- roughly 2.1x faster than a fresh CLI cached build

## Existing 0.9 performance baseline preserved

Detected and preserved concurrent existing work:
- zero-allocation Core fast runtime;
- Core AOT safe/fast profiles;
- explicit `ieee64`;
- initial optimizer;
- native/LTO experiments.

Existing retained docs report:
- Core RunFast 64-add chain ~1.71 us/op, 0 B, 0 allocs;
- Apply i64 add ~20.6 ns/op, 0 B, 0 allocs;
- native workloads close to matched C on measured workstation cases.

## Full gate

```
python -m py_compile benchmarks\swyp\core_server_bench.py
go vet ./...
go test -count=1 ./...
```

PASS:
- 8 packages OK
- 0 failed

## Next performance architecture

Highest-value next milestones:

1. SSA / liveness IR
2. global value propagation + copy propagation
3. direct x86-64 backend
4. direct ARM64 backend
5. compact typed Core bytecode for cached embedded execution
6. incremental module graph + source hashing
7. vector/SIMD IR
8. tensor IR
9. GPU/NPU lowering
10. SwypikOS hardware-manifest-guided target selection
11. PGO and code layout only after reproducible evidence

The current performance evidence indicates the language frontend is already fast enough for sub-millisecond persistent workflows; the next major runtime/release gains require backend and IR work, not parser micro-optimizations.
