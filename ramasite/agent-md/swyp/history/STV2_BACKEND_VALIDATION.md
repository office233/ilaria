# Swyp to STV2: implementation and validation

Date: 2026-09-27. Source checkpoint: `843171a6787614ff3e05785b6dff829879104caf`.
Branch: `feature/ternary-isa-v2`; PR #1. STV1 and the existing Swyp backends remain in place.

## Correction to the earlier validation claim

The preceding PR revision (`8bb381756673c585c00833e6e9225768f772db9f`)
contained a literal newline inside a quoted Go string in `AssembleV2`.
Compiling that source failed with `newline in string` at v2.go:118.
Earlier statements that this revision had passed tests and about 205,000 fuzz
inputs were not supported by execution logs and must not be used as evidence.
This revision fixes the build error. The measurements below come from actual
executions in this session; raw local evidence is in [STV2_VALIDATION_RAW.txt](STV2_VALIDATION_RAW.txt).

## Implemented pipeline

`Swyp source -> existing parser/type checker -> STV2 lowering -> EncodeV2 -> DecodeV2 -> RunV2Exact`

`Program.CompileSTV2()` creates an immutable module. It runs the existing checker,
checks supported constructs even in unreachable code, allocates registers,
emits branches and operations, and validates a packed-bytecode round trip.
`module.Run(args, fuel)` creates fresh registers. `Bytecode()` returns a copy.

Supported: a single `fn main` returning `number` or `bool`; signed int32 literals;
`let`, assignment, lexical shadowing, `if/else`, nested `while`, early returns;
`+ - * %`, comparisons, `!`, short-circuit `&&` and `||`;
constant `arg(0)` through `arg(3)` indices. Repeated input reads remain immutable.
Mixed-type equality preserves Swyp semantics: `true == 1` is false, and both
operands still evaluate before an equality result is produced.

Limitations are explicit, not silently emulated: no additional/user functions,
strings, `print`, `clock`, fractional literals, or `/`. Swyp `/` is floating-point
division, so substituting STV2 integer division would be incorrect. The new CLI
is separate from `swyp ternary`, which still accepts assembly.

Numbers must remain in `[-9007199254740991, 9007199254740991]`, including every
intermediate result. An intermediate excursion fails even if a later subtraction
would bring the final answer back into range. This is a restricted execution
profile, not full float64 support. Signed-zero bit identity is not promised.
Raw `RunV2` retains the previous checked int64 assembly behavior.

Eight registers include inputs, locals and temporaries; exhaustion is a compile
error, with no spilling yet. Limits remain 4,096 instructions and 1,000,000 fuel
units. Fuel counts differ from the AST interpreter, so budget-boundary errors
are not claimed equivalent across backends. There are no guest host calls.
This is an experimental backend, not a security certification or general AI.

## Run it

On the feature branch, from the repository root:

```sh
go run ./cmd/swyp-stv2 examples/swyp/sum.stv2.swyp 100
go run ./cmd/swyp-stv2 -o new-sum.stv2 examples/swyp/sum.stv2.swyp 100
```

Observed JSON:

```json
{"format":"STV2","profile":"swyp-safe-integer","result_type":"number","value":5050,"steps":1308,"instructions":18,"packed_bytes":109}
```

The optional destination must not exist. Source reads are bounded to 1 MiB.
Failed execution does not create the requested bytecode file. Raw STV2 bytes do
not carry the module's arity, result type or safe-integer profile: a host loading
them must retain that metadata and use the correct execution profile. The 109
bytes include the STV2 header, not all runtime/module memory.

## Local test scope and observed results

The local environment could not clone the private repository. A minimal buildable
snapshot was materialized from connector reads; the original parser, checker,
STV1 core, STV2 core and go.mod were checked against their Git blob hashes. The
snapshot adds the new lowering, CLI and tests. Other original source/test files
were not materialized. Therefore these local results are NOT a full-repository
regression claim. The source manifest in the raw evidence identifies exact files.

Environment: Go 1.23.2, Linux amd64, AMD EPYC 9V74 host, five visible CPUs;
GCC Debian 14.2.0. Each fuzz campaign used two workers and a 10-second budget.

| Check | Observed result |
|---|---|
| Add/sub/mul/div/mod against independent `math/big` oracle | 1,001,125 comparisons passed; seed 5802 |
| Comparisons, moves, min/max, bitwise operations and aliasing | 480,000 checks passed; seed 2702 |
| Single-byte transport mutations across ten program lengths | 100,352 cases: 7,536 canonical valid, 92,816 rejected |
| Generated Swyp programs vs original AST interpreter | 5,000 programs, 20,000 executions passed; seed 15802 |
| Loops, Fibonacci, nested scopes, repeated inputs, early returns | 1,369 comparisons passed |
| Decoder fuzz target | 609,810 executions, no failure observed |
| Assembler fuzz target | 523,800 executions, no failure observed |
| Parser/checker/lowering fuzz target | 29,938 executions, no failure observed |
| Race detector on three local packages | Passed, including 64 concurrent runs of one compiled module |
| `go vet` on three local packages | Passed |
| Cross-compilation of three test packages | Passed for linux/386, linux/arm64 and windows/amd64 |
| Attempted linux/386 execution | Blocked by host `exec format error`; runtime NOT validated |

These are property-case and fuzz-execution counts, not millions of distinct unit
test functions or a proof of correctness. Additional tests exercise invalid
headers, truncation, padding, trailing data, version confusion, all opcode values,
invalid registers/labels, overflow, zero divisors, fuel, unsupported source,
short-circuit errors, output failures and refusing to overwrite files.

## Local performance experiment

Workload: the same Swyp source computes the sum 1 through 1000. Medians of five
Go benchmark runs, 200 ms per benchmark. Parsing/compilation is outside the AST
and STV2 run timings. STV2 still validates the program and applies runtime checks.

| Implementation | Median time/op | Allocations reported by harness |
|---|---:|---:|
| Original Swyp AST interpreter | 151.170 us | 2,002 |
| Lowered STV2 exact-integer runner | 29.859 us | 1 |
| Go unchecked loop reference | 0.3258 us | 1 |
| Check/lower/encode/decode an already parsed AST | 8.459 us | 47 |

STV2 was approximately 5.06 times faster than the AST interpreter on this one
workload. The unchecked native Go loop was approximately 91.65 times faster than
STV2. The reference does not have the same fuel and exact-domain checks. The
harness stores results through an interface, which introduces boxing allocations.
These figures are NOT a ternary-versus-binary ISA comparison, whole-application
measurements, or evidence of being faster than other programming languages.

## Reproduction and full-repository CI

```sh
go test -count=1 ./experiments/ternaryvm ./internal/swyplang ./cmd/swyp-stv2
go vet ./experiments/ternaryvm ./internal/swyplang ./cmd/swyp-stv2
go test -race -count=1 ./experiments/ternaryvm ./internal/swyplang ./cmd/swyp-stv2
go test ./experiments/ternaryvm -run '^$' -fuzz '^FuzzSTV2DecodeAudit$' -fuzztime=10s -parallel=2
go test ./experiments/ternaryvm -run '^$' -fuzz '^FuzzSTV2AssemblyAudit$' -fuzztime=10s -parallel=2
go test ./internal/swyplang -run '^$' -fuzz '^FuzzSTV2CompilerAudit$' -fuzztime=10s -parallel=2
go test ./internal/swyplang -run '^$' -bench '^BenchmarkSTV2LoweredSum$' -benchmem -benchtime=200ms -count=5
```

The new `.github/workflows/stv2-validation.yml` also runs `go test ./...` and
`go vet ./...` in a complete checkout, followed by race checks, bounded fuzzing,
the example and diagnostic benchmarks. Its results must be read from the actual
GitHub Actions run, not inferred from the existence of the workflow file.

Next engineering priorities: full-repository regression results, module metadata
serialization, register spilling, function calls, and benchmark suites with
multiple workloads and equivalent safety checks. Native code generation and
browser UI integration remain separate milestones.
