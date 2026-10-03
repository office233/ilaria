# Swyp native optimization — 2026-09-27

Swyp's native emitter now batches consecutive execution-budget checks across
infallible temporary declarations. It flushes before arithmetic checks, calls,
variable stores and control flow. When enough budget remains it subtracts the
batch once; otherwise it performs the original checks in order, retaining the
exact failure location. Overflow, division-by-zero, recursion and execution
limits remain enabled. This compiler optimization uses no LLM.

## Measured results

Windows, Intel Core i7-9700; GCC/G++ 15.2.0, Go 1.26.2, Python 3.12.10.
Native C builds use `-O2 -ffp-contract=off`, without fast-math. Each cell is the
median of five fresh processes after one discarded warmup. Order is shuffled.
Times are milliseconds within the program, excluding build and process startup.
Raw timing ranges, wall times, versions and hashes are in
[the final measurement file](SWYP_OPTIMIZATION_NATIVE.json).

| Implementation | Mandelbrot 640 | Primes to 100000 | Training 256 samples, 2000 epochs |
|---|---:|---:|---:|
| Swyp before | 77.3393 | 36.2446 | 16.1722 |
| Swyp optimized | 62.4291 | 29.2396 | 13.6430 |
| C | 13.9118 | 17.5119 | 3.6681 |
| C++ | 14.6265 | 16.1626 | 3.7343 |
| Go, float64 | 18.3196 | 175.7630 | 8.2036 |
| Go, integer primes | — | 22.5155 | — |
| Python, scalar loops | 920.6948 | 347.9950 | 195.3166 |

Swyp execution time fell approximately **19.3%, 19.3%, and 15.6%**, respectively.
These are local measurements, not universal performance guarantees. Swyp remains
slower than C/C++ in all three cases. It beats the Go float64 prime implementation
but loses to the integer implementation; Go also wins Mandelbrot and training.
The references omit Swyp's runtime budget and finite-result guards, so this is a
comparison of these implementations with different runtime guarantees.

Training is a tiny scalar linear-regression example, learning y=2x+1. Every
measured run validates results and the resulting weights against the Python
reference. It is not LLM training, a GPU test, or a comparison against NumPy,
PyTorch or optimized tensor kernels. Rust was unavailable and was not measured.

An initial run, including the interpreter, is saved in
[the diagnostic report](SWYP_OPTIMIZATION_BENCHMARK.json). Its early work overlapped
with test execution. The table above uses the subsequent run with no concurrent
test or vet commands. The workloads were enlarged after the original short Go
measurement returned zero elapsed time; that invalid run was rejected.

## Validation and reproduction

`go test ./...` and `go vet ./internal/swyplang ./cmd/swyp` passed. The new regression
test checks every budget from 0 through 180 against the unbatched emitter,
comparing output and error locations through loops, short circuiting, calls,
returns and a final division error. Existing native/interpreter parity tests
cover overflow and recursion too.

The pre-change native executable was preserved as `bin/swyp-baseline/swyp.exe`
before rebuilding; its SHA-256 is included in both reports. The original emitter
was saved locally as `bin/swyp-baseline/native.go.txt`.

```powershell
python benchmarks/swyp/run.py --skip-interpreter --baseline bin/swyp-baseline/swyp.exe --report docs/SWYP_OPTIMIZATION_NATIVE.json
```

Omit `--skip-interpreter` to include interpreted Swyp. On another checkout,
preserve a pre-change build of `examples/swyp/compute.swyp` as the baseline first,
or omit `--baseline` to measure only current implementations. No toolchains are
downloaded by the harness.

## Autonomous language direction

This change improves native execution. It does not implement autonomous program
synthesis, replication or general natural-language understanding without a model.
A future non-LLM prototype can search a bounded program grammar, score candidates
against explicit specifications and tests, and retain successful candidates.
That requires a separate implementation and evaluation; passing tests alone is
not a proof of general correctness or greater intelligence.
