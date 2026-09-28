# Swyp Lang 0.5

Version 0.5 supports a separate `validation` array in synthesis specifications.
The engine refines candidates using failing points and enforces one total
candidate budget across rounds. See [the example](../examples/swyp/synthesis-refine.json).
Numeric example fields must be present and non-null. Contradictory outputs for
the same numeric input are rejected before search. Verification covers only the
supplied points; it is not a universal proof.

Version 0.4 adds `swyp synth -o new.swyp spec.json`: bounded deterministic
arithmetic synthesis from examples with no LLM calls. See [the status report](history/NON_LLM_STATUS.md)
for tested capabilities, restrictions and reproducible evaluation.

The native backend now batches execution-budget checks while preserving error
behavior. See [the optimization measurements](history/SWYP_OPTIMIZATION_ASSESSMENT.md)
for the before/after comparison with C, C++, Go and Python.

Swyp Lang is our experimental language, previously called Syra in the research proposal. Files use `.swyp`. Version 0.2 adds static checking, native compilation through C/GCC, numeric command-line inputs, interval timing, and an optional Ilaria draft-generation command.

Version 0.3 adds inline natural-language statements, validated expansion with provenance, separate repair drafts, and an offline HTML/JavaScript target. See [the end-to-end walkthrough](history/SWYP_AI_WORKFLOW.md). These are implemented mechanisms, not a claim of general natural-language correctness.

This is a scalar prototype, not a replacement for SwypikOS. See [0.2 measurements](history/SWYP_NATIVE_ASSESSMENT.md), [historical 0.1 measurements](history/SWYP_MIGRATION_ASSESSMENT.md), and [the requested AI-language vision](history/SWYP_VISION.md).

## Run and build

From the project root in PowerShell:

```powershell
go build -o bin/swyp.exe ./cmd/swyp
.\bin\swyp.exe check examples/swyp/hello.swyp
.\bin\swyp.exe run examples/swyp/hello.swyp
.\bin\swyp.exe build -o bin/hello-swyp.exe examples/swyp/hello.swyp
.\bin\hello-swyp.exe
.\bin\swyp.exe build -o bin/swyp-compute.exe examples/swyp/compute.swyp
.\bin\swyp-compute.exe 2 200
.\bin\swyp.exe run -steps 1000000000 examples/swyp/compute.swyp 2 200
```

Native compilation requires GCC on PATH and emits C11 with `-O2 -ffp-contract=off`, without fast-math. This uses an existing compiler, not an AI optimizer. `emit-c file.swyp` prints inspectable generated C. CLI options precede the filename.

`compute.swyp` mode 0 runs Mandelbrot (second input: width); mode 1 counts primes (second input: limit); mode 2 trains linear regression (second input: epochs).

## Language and checks

```text
fn square(x: number) -> number {
    return x * x;
}
fn main() {
    let count = 1;
    while count <= 5 {
        print("square", count, "=", square(count));
        count = count + 1;
    }
}
```

- Parameter types: `number`, `bool`, `string`; return types also allow `void`. Inference is monomorphic: a function cannot accept both strings and numbers at separate calls. Unresolved function types require annotations.
- `let` creates a mutable fixed-type block-scoped variable. Assignment updates the nearest binding; nested blocks can shadow outer variables. Duplicate declarations in one block are rejected.
- Numbers are finite IEEE 754 float64 values. Integers beyond 2^53 can round. Arithmetic overflow to infinity is rejected; ordinary floating-point rounding remains. There is no integer type yet.
- Operators: `+ - * / %`, `< <= > >=`, `== !=`, `! && ||`. Conditions must be boolean; logical operators short-circuit. Different scalar value types compare unequal.
- Statements: `if condition { ... } else { ... }`, `while condition { ... }`, `return expression;`. Value-returning functions must have a recognized return on every path. The conservative checker does not prove that a loop always returns.
- Semicolons terminate simple statements. Braces delimit blocks. Double-quoted strings support escapes. Line/block comments are supported; interpolation is not.
- String concatenation works in the interpreter and is explicitly rejected by the native backend. Native immutable strings support passing, returning, equality and printing, including embedded NUL bytes.
- CLI `check`, `run` and `build` validate the whole program, including unreachable branches: names, arity, types, and return coverage. This is not proof that intended behavior is correct.

`print(...)` writes space-separated values and a newline. Native numbers use 17 significant digits; interpreter formatting uses Go's default. Compare numeric values rather than assuming byte-identical floating-point text. Void calls cannot be stored or used as values.

`arg(index)` reads finite numeric CLI arguments from index zero. Invalid indices fail. `clock()` returns seconds for interval measurement; its origin is unspecified. Windows uses QueryPerformanceCounter. The untested non-Windows C fallback uses wall-clock time and is subject to clock adjustments.

Interpreter budget: 1,000,000 steps by default, configurable with `-steps`. Native budget: fixed 1,000,000,000 steps. Both limit call depth to 128. Parsing limits source to 1 MiB and nesting to 256. These are guardrails, not a secure sandbox or memory quota. Native execution retains arithmetic and budget checks. The internal Go `Program.Run` API retains the dynamic interpreter for differential tests; CLI paths call `Check` first.

## Natural-language drafts

```powershell
.\bin\swyp.exe draft -prompt examples/swyp/draft-task.txt -o examples/swyp/my-draft.swyp
```

This calls the existing local Ilaria service on `127.0.0.1:8091` with a compact language specification and the chosen task text. It parses and type-checks the reply, then writes a new source file. It neither overwrites files nor automatically compiles or executes the result. Unsupported requests, invalid source, Markdown responses, and unavailable models produce errors.

The real service refused connections during this session. Controlled backend tests passed, but successful generation with a real model remains unverified. No model was downloaded, substituted, or trained. The adapter sends only its instructions and the task text, not the whole repository.

Inline `#natural` and `#limbaj_natural` directives can now be expanded with `swyp expand`. `swyp repair` generates a separate checked candidate for a static diagnostic. Both support explicitly labeled offline response replay for tests. Automatic production repairs, editor UI, provider integrations, and cross-platform publishing remain future work. Saving generated source before compiling makes builds reproducible without an LLM on every build.

## Actual training and tests

The training example performs batch gradient descent on 256 generated samples of `y = 2*x + 1`. Starting at zero, it updates one weight and one bias and reports them with mean squared error. This is real training, but has no autodiff, tensors, GPU kernels, or LLM architecture.

```powershell
go test ./internal/swyplang ./cmd/swyp
go vet ./internal/swyplang ./cmd/swyp
python benchmarks/swyp/run.py
```

Native parity tests compile temporary programs with GCC, explicitly skipping if it is missing. Benchmark references cover C, C++, Go, Python, and Rust when rustc is available. Generated executables go under `bin/swyp-bench`; raw results and source hashes go into `benchmarks/results/SWYP_NATIVE_BENCHMARK.json`.

The new `web -o new.html file.swyp` target produces a scalar runner, not a declarative UI framework. The generated program runs in a worker with Stop, a 10-second timeout and a 1,000-line output limit. The JavaScript core was tested under Node 24; visual browser testing was blocked by the in-app browser's file-URL policy. Browser rendering, worker behavior and controls are not yet end-to-end verified.

Remaining gaps include arrays, structs, modules, declarative UI, network/filesystem APIs, concurrency, resource ownership, foreign-library adapters, tensors, and production tooling. SwypikOS has not been migrated.
