# Swyp Lang 0.2: native execution and training experiment

27 September 2026. **The native prototype is substantially faster than the interpreter on this suite. It does not outperform all languages, and does not justify rewriting SwypikOS.**

## Delivered

- Whole-program static checking of lexical names, function arguments, monomorphic scalar types and return coverage. Function annotations are optional when inference resolves them.
- Inspectable C11 generation and `swyp build`, using GCC optimization to produce a native executable. Arithmetic error checks, a step budget and a call-depth guard remain enabled.
- Three nontrivial executable workloads: Mandelbrot iteration, prime counting and real gradient descent.
- Natural-language draft adapter for the existing local Ilaria service. Controlled tests cover valid/invalid responses and service errors. The real service refused connections; no successful live generation is claimed.

## Results

Times below are **median milliseconds inside the process**, five runs per cell. Lower is better. All implementations returned equivalent checked results. Do not read these as whole-application latency or language-wide rankings.

| Implementation | Mandelbrot 160 x 80, up to 80 iterations | Primes through 10,000 | Training: 256 samples x 200 epochs |
| --- | ---: | ---: | ---: |
| Swyp interpreter | 299.422 | 51.969 | 55.390 |
| Swyp native via GCC | 4.592 | 1.428 | 1.609 |
| C / GCC | 0.830 | 0.663 | 0.382 |
| C++ / G++ | 0.843 | 0.644 | 0.402 |
| Go, matching float64 | 1.090 | 6.407 | 1.065 |
| Python scalar loops | 51.180 | 14.308 | 17.311 |
| Go, integer prime baseline | — | 1.088 | — |

Native Swyp was about 34–65x faster than its interpreter and about 10–11x faster than the scalar Python references. It was slower than C/C++ in every case. It beat the Go float64 prime reference, but lost to the Go integer version on the observed median. Go also beat native Swyp on Mandelbrot and training. The prime result highlights the cost of numeric representation and remainder implementations, rather than proving language superiority.

Rust was not measured: rustc was unavailable on PATH and at the checked default user installation path. An optional reference is included for a future run, but it has not been compiled or verified here. This is not a comparison of all languages or of AI models.

## Training result

The Swyp program starts weight and bias at zero, computes explicit mean-squared-error gradients, and updates both using batch gradient descent with learning rate 0.1. After 200 epochs it reports approximately:

```text
weight = 1.9999979251351307
bias   = 0.9999999513851825
MSE    = 1.4349333412848139e-12
```

Those are learned parameters for generated data `y = 2*x + 1`, not a hardcoded output. The harness checks parameter convergence and cross-implementation agreement and saves raw weights in the JSON report. There is no model checkpoint loader, tensor engine, autodiff, GPU training, or LLM model in this experiment.

The Python baseline uses scalar loops, not NumPy, PyTorch, JAX or native GPU kernels. An optimized training framework may spend most of its time outside Python; these measurements cannot establish an acceleration of LLM weights generation. Language/compiler speed also does not establish improved model intelligence or quality.

## Method and reproducibility

Sources: [Swyp workload](../examples/swyp/compute.swyp), [C/C++ reference](../benchmarks/swyp/reference.c), [Go reference](../benchmarks/swyp/reference.go), [Python reference](../benchmarks/swyp/reference.py), [optional Rust reference](../benchmarks/swyp/reference.rs), [harness](../benchmarks/swyp/run.py).

Run `python benchmarks/swyp/run.py` from the project root. It builds available implementations, performs a discarded warm-up process per case/implementation, and then uses five fresh processes in deterministically shuffled order. Work size is supplied at runtime. Results and learned weights are checked on every run. The prime count must be 1,229; training must meet predefined parameter and loss thresholds.

The timed region excludes process startup and parsing, but includes workload computation and the training parameter print. The final RESULT print is outside the timed region. Raw data also contains total subprocess wall time, min/max, single observed build durations, compiler versions and source SHA-256 hashes. Build timings are not a statistically controlled clean/incremental compilation comparison. The warm-up warms filesystem caches, not a persistent JIT.

Environment: Windows 11 amd64, Intel Core i7-9700, Go 1.26.2, GCC/G++ 15.2.0, CPython 3.12.10. GCC/G++ references use `-O2 -ffp-contract=off`; Swyp uses the same optimization flags plus C11. No fast-math or device-specific tuning. Go uses default release compilation. Scalar float64 algorithms are matched; the separately labeled Go integer case deliberately tests a representation Swyp cannot currently express.

Swyp retains checks for non-finite arithmetic, division/remainder by zero, depth and a 1-billion-step budget. The handwritten references omit those checks because benchmark inputs are known and bounded. Consequently this is a comparison of actual implementations with documented differences, not an isolated comparison of compiler optimization quality or equivalent safety guarantees.

The host was not isolated or pinned. The Go integer-prime range was approximately 0.560–1.205 ms, and training cases also varied. Medians do not provide significance claims for near results. Peak memory and allocation counts were not collected in this cross-language suite. See [raw measurements](SWYP_NATIVE_BENCHMARK.json) for all observations.

## Decision

Continue the language experiment, retain the Go application. Native compilation removed much of the interpreter overhead, but Swyp still lacks arrays, structs, I/O libraries, concurrency, UI rendering and a usable foreign-library interface. Next useful evidence is a typed array/native-library boundary and one optional UI integration with independent behavior tests. Cross-platform publishing, automatic repairs and inline natural-language compilation remain goals documented in [SWYP_VISION.md](SWYP_VISION.md), not completed features.
