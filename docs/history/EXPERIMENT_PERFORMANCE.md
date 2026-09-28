# Swyp Lang Performance Audit: Benchmark Methodology & Synthesis Feasibility

**Document Version:** 1.0  
**Date:** 2026-09-27  
**Scope:** Independent audit of benchmark methodology in [`benchmarks/swyp/`](../benchmarks/swyp/), measurement results in [`docs/SWYP_OPTIMIZATION_NATIVE.json`](SWYP_OPTIMIZATION_NATIVE.json), native C emission in [`internal/swyplang/native.go`](../internal/swyplang/native.go), and bounded synthesis feasibility as outlined in [`docs/NON_LLM_ARCHITECTURE_REVIEW.md`](NON_LLM_ARCHITECTURE_REVIEW.md).

---

## 1. Executive Summary

This audit assesses:
1. **Benchmark Methodology:** Whether current performance claims comparing native Swyp against C, C++, Go, and Python reflect algorithmic and computational parity, or whether confounding factors distort the results.
2. **Synthesis Feasibility:** Whether autonomous program synthesis can reliably generate programs that outcompete optimizing compilers (C/GCC, Rust/LLVM).

### Key Audit Findings
- **Data-Type Confounder:** Swyp represents all numbers as IEEE 754 `float64` (`number`). In integer-heavy workloads like trial-division prime counting (`PrimeCount100000`), Go float64 was penalized heavily by `math.Mod` function calls (175.76 ms), whereas idiomatic Go integer modulo ran in **22.52 ms** (~7.8x faster). Comparing Swyp to Go float64 rather than idiomatic Go integer modulo creates an artificial performance victory.
- **Asymmetric Safety Guards:** Swyp native C emission ([`internal/swyplang/native.go`](../internal/swyplang/native.go)) injects per-statement execution-budget checks (`swyp_tick` / batch subtractions), per-operation `isfinite` checks (`swyp_finite`), zero-division guards (`swyp_div`/`swyp_mod`), and call-depth tracking (`swyp_depth`). The handwritten C, C++, Go, and Rust references execute unchecked scalar code with none of these safety boundaries.
- **Timing Scope Contamination:** In `Train256x2000`, weight logging (`printf("WEIGHTS...")`) occurs inside the timed compute window. Subprocess wall-clock measurements in [`benchmarks/swyp/run.py`](../benchmarks/swyp/run.py) are dominated by Windows process creation overhead (~8–15 ms), obscuring microsecond-level compute kernel deltas.
- **Synthesis Performance Reality:** Autonomous synthesis (inductive search, e-graphs, or CEGIS) generates abstract syntax trees satisfying discrete input/output examples. Synthesized programs do not automatically outcompete C or Rust because:
  - Synthesis cannot discover global algorithmic paradigm shifts (e.g., transforming trial division $O(N\sqrt{N})$ into a sieve $O(N \log \log N)$) without domain-specific primitives.
  - Synthesized Swyp code still compiles through the Swyp native emitter, inheriting `float64` boxing, fuel decrements, and non-vectorized scalar loops.
  - Optimizing compilers (GCC, Clang, Rustc) perform multi-level polyhedral loop optimizations, register allocation, auto-vectorization (SIMD), and instruction pipelining that AST synthesis cannot match.

---

## 2. Benchmark Methodology Audit

### 2.1 Workload Analysis

The benchmark suite in [`benchmarks/swyp/`](../benchmarks/swyp/) defines three scalar compute workloads across five implementations:

| Workload | Input Size | Algorithm | Primary Bottleneck |
| :--- | :--- | :--- | :--- |
| **Mandelbrot640** | Width 640, Height 320, Max 80 iters | Scalar escape-time fractal iteration | Floating-point arithmetic throughput, branch prediction |
| **PrimeCount100000** | $N = 100,000$ (9,592 primes) | Trial division up to $\lfloor\sqrt{n}\rfloor$ | Remainder/modulo latency, integer arithmetic emulation |
| **Train256x2000** | 256 samples $\times$ 2,000 epochs | Batch gradient descent on $y = 2x + 1$ | Tight loop arithmetic, floating-point accumulator latency |

### 2.2 The Float64 vs. Integer Confounder

Swyp 0.2/0.3 supports only monomorphic scalar types: `number` (`float64`), `bool`, `string`, and `void` ([`internal/swyplang/check.go:9-15`](../internal/swyplang/check.go#L9-L15)). The language lacks native integer types (`int32`, `int64`, `uint64`).

#### Prime Counting Distortion
In [`benchmarks/swyp/compute.swyp:28-35`](../examples/swyp/compute.swyp#L28-L35), prime trial division evaluates:
```swyp
fn prime(n: number) -> bool {
    let divisor = 2;
    while divisor * divisor <= n {
        if n % divisor == 0 { return false; }
        divisor = divisor + 1;
    }
    return true;
}
```

In the Go reference ([`benchmarks/swyp/reference.go:35-44`](../benchmarks/swyp/reference.go#L35-L44)), this was mapped to:
```go
func prime(n float64) bool {
    divisor := 2.0
    for divisor*divisor <= n {
        if math.Mod(n, divisor) == 0 { return false; }
        divisor = divisor + 1
    }
    return true
}
```

- In Go, `math.Mod` is an out-of-line software library function handling floating-point NaN, Inf, and subnormal edge cases. In GCC C11, `fmod` is compiled with hardware assistance and library calls.
- Consequently, Go float64 took **175.76 ms** (median) in [`docs/SWYP_OPTIMIZATION_NATIVE.json:94`](SWYP_OPTIMIZATION_NATIVE.json#L94), while native Swyp (compiled via GCC) took **29.24 ms**.
- However, when measured with idiomatic Go integers ([`reference.go:104-119`](../benchmarks/swyp/reference.go#L104-L119)), Go executed in **22.52 ms**, beating native Swyp by 23%.
- **Audit Verdict:** Claiming Swyp beats Go on prime calculation is an artifact of forcing Go to use `math.Mod(float64, float64)` for an algorithm that is inherently integer-based.

#### Counter & Loop Index Inefficiencies
In `Mandelbrot640` and `Train256x2000`, inner loop variables (`count`, `px`, `py`, `epoch`, `i`) are all IEEE 754 `double`.
- In C (`reference.c:10-14`), counters are forced to `double` to match Swyp's type system.
- Using `double` for counters increases register pressure on x86-64 SSE/AVX registers and prevents compiler loop trip-count vectorization that would otherwise occur with standard 32-bit/64-bit integer loop indices.

### 2.3 Timing Scopes and Measurement Guards

The benchmark harness [`benchmarks/swyp/run.py`](../benchmarks/swyp/run.py) measures two distinct intervals:
1. **Internal Kernel Time (`seconds`):** Reported by the program over stdout (`RESULT <seconds> <val>`).
2. **Subprocess Wall Time (`wall_seconds`):** Measured by Python around `subprocess.run()`.

#### Audit Findings in Timing Scopes:
1. **I/O Contamination in `Train`:** In `reference.c:23`, `compute.swyp:77`, and `reference.go:79`, the training function calls `printf`/`print("WEIGHTS ...")` *before* returning `loss` to `main()`. The internal timer in `main()` spans:
   ```c
   double start = timer();
   if (mode == 0) result = mandelbrot(size);
   else if (mode == 1) result = primes(size);
   else result = train(size);
   printf("RESULT %.17g %.17g\n", timer() - start, result);
   ```
   Thus, `timer() - start` for `Train256x2000` includes string formatting and flushing of the `WEIGHTS` stdout record.
2. **Subprocess Wall Time Skew:** On Windows 11, process invocation (`CreateProcess`) takes between 8 ms and 18 ms. For fast kernels:
   - C `Train256x2000`: Kernel time = 3.67 ms; Subprocess wall time = 11.33 ms (68% process spawn overhead).
   - Go `Train256x2000`: Kernel time = 8.20 ms; Subprocess wall time = 17.85 ms (Go runtime scheduler and GC initialization add ~9 ms).
   - Wall time reflects OS loader and runtime overhead rather than language execution throughput.

### 2.4 Asymmetry of Runtime Safety Guards

The native Swyp compiler generates C code with extensive runtime checks that are completely omitted in handwritten references:

| Safety Guard | Implementation in Swyp Native C | Reference C / C++ / Go |
| :--- | :--- | :--- |
| **Execution Step Fuel** | Batched counter decrement `swyp_steps -= N;` on basic blocks ([`native.go:97`](../internal/swyplang/native.go#L97)) | None |
| **Call Depth Guard** | `if (++swyp_depth > 128) swyp_fail(...)` ([`native.go:42`](../internal/swyplang/native.go#L42)) | None |
| **Finite Numeric Assertion** | `swyp_finite(x)` (`!isfinite(x)`) after every arithmetic op ([`native.go:282`](../internal/swyplang/native.go#L282)) | None |
| **Division/Mod Zero Guard** | `swyp_div` and `swyp_mod` check `y == 0` on every `/` and `%` ([`native.go:273-277`](../internal/swyplang/native.go#L273-L277)) | None (relies on hardware trap / undefined behavior) |

- In [`internal/swyplang/native.go:281-283`](../internal/swyplang/native.go#L281-L283), every binary addition, subtraction, and multiplication evaluates `swyp_finite(...)`. This inserts branch checks or FP status word inspection into the inner loops.
- Batched fuel ticks ([`native.go:90-104`](../internal/swyplang/native.go#L90-L104)) reduce tick overhead by ~15–19% (as documented in [`docs/SWYP_OPTIMIZATION_ASSESSMENT.md`](SWYP_OPTIMIZATION_ASSESSMENT.md)), but fuel checks remain in the generated binary.
- **Audit Verdict:** The comparison between Swyp and C/C++ is not a comparison of compiler code quality; it is a comparison between a **sandboxed, fuel-metered runtime** and an **unchecked native executable**.

---

## 3. Synthesis Feasibility & Why Generated Programs Do Not Automatically Beat C/Rust

As proposed in [`docs/NON_LLM_ARCHITECTURE_REVIEW.md`](NON_LLM_ARCHITECTURE_REVIEW.md), non-LLM program synthesis for Swyp relies on bounded enumerative search, observational equivalence, and equality saturation (e-graphs). While viable for small arithmetic expressions, claims that synthesized programs can outcompete handwritten C or Rust must be critically qualified.

### 3.1 Combinatorial Explosion of Search Space
- The search space for an AST of size $n$ over an operator set $O$ and terminal set $T$ grows asymptotically as:
  $$|S_n| = C_{n-1} \cdot |O|^{n-1} \cdot |T|^n$$
  where $C_k$ is the Catalan number.
- For a small terminal pool ($x$ and 4 constants) and 3 binary operators ($+, -, *$), searching beyond depth $d = 4$ or $N = 9$ nodes requires evaluating millions of candidates.
- Inductive synthesis is effective for discovering expressions like $2x + 1$ or polynomial interpolations, but is computationally intractable for synthesizing complex iterative algorithms (e.g., iterative sorting, fractal generation, or numerical solvers) without predefined domain templates or sketches.

### 3.2 The Algorithmic Paradigm Gap
- Program synthesis explores syntax trees within a fixed grammar. It cannot autonomously invent algorithmic insights that lower asymptotic complexity classes.
- For example, synthesis cannot transform an $O(N^2)$ bubble sort into an $O(N \log N)$ merge sort unless the primitive higher-order operations (split, merge, recursion) are explicitly provided in the grammar.
- Handwritten C and Rust implementations leverage sophisticated algorithmic choices (cache-blocking, SIMD intrinsics, lookup tables, bit-twiddling hacks) that inductive synthesizers cannot synthesize from scratch.

### 3.3 The Code Generation Pipeline Penalty
Even if a synthesis engine generates an optimal mathematical expression, compiling it through Swyp introduces performance penalties:
1. **Uniform Float64 Representation:** Everything remains an IEEE 754 double; integer arithmetic and bitwise optimizations remain unavailable.
2. **Fuel and Safety Injections:** The generated Swyp code passes through `Program.EmitC()`, injecting `swyp_finite`, `swyp_tick`, and depth guards.
3. **Absence of Memory Primitives:** Swyp 0.3 lacks arrays, pointers, slices, and heap allocation. Algorithms requiring spatial locality or buffer re-use cannot be expressed.

### 3.4 Compiler Optimization Mismatch
Modern optimizing compilers (GCC, Clang/LLVM, Rustc) apply hundreds of optimization passes:
- **Auto-Vectorization:** Converting scalar float operations into AVX2/AVX-512 SIMD vector instructions (processing 4 to 8 doubles per instruction).
- **Instruction-Level Parallelism (ILP):** Reordering instructions to saturate multiple execution ports and avoid pipeline stalls.
- **Polyhedral Loop Transformations:** Loop unrolling, interchange, and tiling for L1/L2 cache locality.
- **Dead-Code Elimination and Constant Folding:** Removing redundant expressions across basic blocks.

A synthesized Swyp AST compiled via `gcc -O2 -ffp-contract=off` with per-operation `swyp_finite()` calls prevents GCC from vectorizing loops, because the compiler cannot guarantee that `swyp_fail` will not be called on intermediate floating-point values.

---

## 4. Proposed Fair Benchmark Matrix

To eliminate confounders and establish an objective benchmark baseline, we propose a four-tier benchmark matrix:

### Matrix Architecture

```
┌────────────────────────────────────────────────────────────────────────┐
│                        FAIR BENCHMARK MATRIX                           │
├─────────────────────┬──────────────────────────────────────────────────┤
│ Tier 1: Pure Engine │ Raw scalar compute; all safety guards disabled   │
│ (Compiler Quality)  │ (Swyp unchecked vs C -O2 vs Rust opt-level=2)    │
├─────────────────────┼──────────────────────────────────────────────────┤
│ Tier 2: Metered     │ Identical safety envelope injected in all langs  │
│ (Runtime Parity)    │ (Fuel ticks + isfinite checks in C, Rust, Go)    │
├─────────────────────┼──────────────────────────────────────────────────┤
│ Tier 3: Idiomatic   │ Native types & algorithms per language           │
│ (Real-World Parity) │ (int64 for primes; vector/slices for data)       │
├─────────────────────┼──────────────────────────────────────────────────┤
│ Tier 4: Pipeline    │ Disaggregated startup vs kernel timing           │
│ (System Costs)      │ (Process launch vs steady-state iteration)       │
└─────────────────────┴──────────────────────────────────────────────────┘
```

### Detailed Benchmark Suite Specification

| Benchmark Identifier | Domain | Algorithmic Class | Controlled Variables | Comparison Target |
| :--- | :--- | :--- | :--- | :--- |
| **`NUM-MANDELBROT`** | Fractal escape | Scalar Float64 Loop | Width 640, Height 320, 80 iters; no fast-math | Swyp Native vs C vs Rust |
| **`INT-PRIME-TRIAL`** | Number theory | Discrete Trial Division | $N = 100,000$; explicit integer types (`int64`) | Swyp (once `int` added) vs C vs Go |
| **`ML-LINREG-BATCH`** | Optimization | Batch Gradient Descent | 256 samples, 2000 epochs; exclude I/O from timing | Swyp Native vs C vs Python (NumPy) |
| **`MEM-STREAM-REDUCE`** | Memory / Cache | Array Dot Product | 1M float64 elements (tests memory bandwidth) | Swyp (once arrays added) vs C vs Rust |
| **`REC-FIBONACCI`** | Call Overhead | Recursive Branching | $N = 35$; stresses call depth and stack guards | Swyp Native vs C vs Go |

### Implementation Guidelines for the Matrix
1. **Decouple I/O from Kernels:** Ensure no `printf` or logging functions run within the timed benchmark window. Output records should be emitted strictly after recording kernel completion.
2. **In-Process Warmup & Multi-Iteration:** Execute 10 warm iterations and 50 measured iterations inside a single process instance to amortize OS loader noise, while continuing to report cold process spawn times separately.
3. **Explicit Guard Flags:** Introduce a compiler flag `--emit-unchecked` in Swyp for benchmark comparison against raw C/Rust, and provide a reference C header (`swyp_guards.h`) to compile C/Rust with identical fuel and finiteness checks.

---

## 5. Summary and Recommendations

1. **Acknowledge Safety Overheads Explicitly:** Do not frame Swyp Native as competing with raw C on bare compute speed. Position it accurately as a **memory-safe, fuel-bounded execution engine** whose C emission outperforms interpreted and dynamic languages while providing hard termination and arithmetic guarantees.
2. **Add Native Integer Types Before Benchmarking Discrete Math:** Do not claim superior performance over languages like Go on discrete algorithms until Swyp implements first-class integer types (`int64`, `int32`) and native integer division/modulo.
3. **Calibrate Synthesis Expectations:** Inductive synthesis should be positioned for automated DSL generation, reactive policy rules, and verifiable arithmetic transformations—not as a magic compiler capable of outperforming human-engineered or LLVM-optimized C/Rust algorithms.
