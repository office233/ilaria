# Syra: a universal language with explicit interoperability

Naming update: the user selected **Swyp Lang**. This document preserves the original research terminology. The implemented interpreter subset and its limits are documented in [SWYP_LANG.md](SWYP_LANG.md); the broader features below remain proposals.

Research and design proposal, 27 September 2026.

Status: exploratory specification. No Syra compiler, runtime, benchmark results, or working language examples are delivered by this document. All Syra syntax below is proposed and non-executable.

## Recommendation

Build a general-purpose compiled language with a small, coherent semantic core, typed interoperability, and domain libraries for UI and machine learning. Use SwypikOS as its first integration environment, rather than restricting the language to UI.

Proposed English description: **“Syra — a language for systems, interfaces, and intelligence.”**

Proposed product promise: **“Build across languages. Understand every boundary.”**

Syra is a working name, not an established acronym. A preliminary search found existing software using this name, including a [PHP ORM](https://github.com/SertyOan/Syra) and a [music platform](https://github.com/OxyHQ/Syra). This research does not establish name availability.

The ambition is broad applicability, competitive native performance, and unusually understandable composition across ecosystems. Universal superiority in runtime speed, compile time, memory consumption, safety, portability, and ease of use is not a defensible requirement. These objectives conflict. A bridge also cannot automatically accelerate the foreign program it calls.

## Research scope and evidence

This is a targeted landscape review of primary documentation, specifications, and research covering systems languages, declarative UI, numerical computing, GPU compilers, model artifacts, and language interoperability. It is not a census of every technology in the world, a patent search, or proof of global novelty. Pages were consulted on the date above; rolling documentation may describe different releases and must be pinned before implementation.

The tables describe documented mechanisms. Recommendations and hypotheses in later sections are our design judgments, not claims made by those projects. No third-party performance headline is adopted as a predicted Syra result.

## What already exists and what to learn

| Technology | Relevant existing mechanism | Lesson for Syra |
| --- | --- | --- |
| [Rust ownership](https://doc.rust-lang.org/book/ch04-01-what-is-ownership.html) | Ownership rules govern memory without a garbage collector. | Make lifetime and mutation rules consistent; reducing visible annotations still requires a real soundness design. |
| [Rust FFI](https://doc.rust-lang.org/nomicon/ffi.html) | Native interfaces expose explicit unsafe boundaries. | A safe caller does not make arbitrary foreign code safe. |
| [Go cgo](https://pkg.go.dev/cmd/cgo) | C interoperability includes rules for Go pointers and callbacks. | Preserve each runtime's constraints instead of pretending every pointer is interchangeable. |
| [Zig](https://ziglang.org/documentation/master/) | Compile-time evaluation and C interoperability. | Prefer explicit allocation and useful compile-time specialization over opaque compiler magic. |
| [Python embedding](https://docs.python.org/3/extending/embedding.html) | A host can initialize Python and exchange values through its C API. | Library compatibility requires an interpreter and conversion/lifetime management. |
| [Swift C++ interoperability](https://www.swift.org/documentation/cxx-interop/status/) | Bidirectional interoperability has a documented supported feature set and constraints. | Publish a compatibility matrix; do not claim all C++ works automatically. |
| [Kotlin/Native C interop](https://kotlinlang.org/docs/native-c-interop.html) | A generator exposes C APIs to Kotlin. | Generated adapters are useful infrastructure, not evidence of semantic equivalence. |
| [Julia C/Fortran calls](https://docs.julialang.org/en/v1.6.3/manual/calling-c-and-fortran-code/) | Numerical programs can reuse native libraries. | Reuse optimized kernels and existing scientific code. This source is versioned historical documentation. |
| [TypeScript](https://github.com/microsoft/TypeScript) | A typed language compiles to JavaScript. | A source-to-source first implementation can still be a language; it does not imply faster machine code. |
| [Svelte](https://svelte.dev/docs/svelte/what-are-runes) | Compiler-recognized syntax declares reactive behavior. | Explicit reactive state is existing prior art. |
| [Slint](https://docs.slint.dev/latest/docs/slint/guide/language/concepts/slint-language/) | A dedicated declarative UI language. | Concise UI blocks alone are not novel. |
| [Qt QML](https://doc.qt.io/qt-6/qtqml-index.html) | UI-oriented language infrastructure integrates JavaScript and C++. | UI/native integration is already a mature design category. |
| [SwiftUI](https://developer.apple.com/swiftui/) | Declarative interface construction. | Study state, composition, tooling, and accessibility as part of the language experience. |
| [Mojo](https://docs.modular.com/mojo/manual/) | Python-like syntax, systems features, and CPU/GPU programming based on MLIR. | “Python syntax with native AI performance” is already a crowded proposition. |
| [JAX](https://docs.jax.dev/en/latest/key-concepts.html) | Function transformations include JIT compilation, differentiation, and vectorization. | Separate pure numerical functions from effects and mutable application state. |
| [PyTorch compiler](https://docs.pytorch.org/docs/stable/torch.compiler.html) | Graph capture and compiler backends optimize existing model code. | Compare against compiled frameworks, not only unoptimized Python loops. |
| [Triton](https://triton-lang.org/) | A language and compiler for custom parallel kernels. | Kernel development can use an existing backend rather than a new GPU toolchain. |
| [CUDA Tile](https://developer.nvidia.com/cuda/tile) | Tile-based GPU programming targeting NVIDIA hardware. | Hardware specialization and portability are different goals. |
| [Futhark](https://futhark-lang.org/) | A statically typed functional array language with CPU/GPU compilation. | Restrictions on a compute sublanguage can enable useful optimizations. |
| [Halide](https://halide-lang.org/) | Image/array algorithms and their execution schedules can be described separately. | Keep mathematical intent separate from hardware tuning. |
| [Taichi](https://docs.taichi-lang.org/docs/differentiable_programming) | Differentiable programming for supported computations. | Simulation plus automatic differentiation is existing prior art. |
| [Slang](https://docs.shader-slang.org/en/stable/external/slang/docs/user-guide/07-autodiff.html) | Automatic differentiation of supported shader code. | Rendering and differentiation already overlap; arbitrary UI interactions are not automatically differentiable. |
| [Enzyme](https://enzyme.mit.edu/) | Compiler-based automatic differentiation. | Evaluate existing AD infrastructure before implementing every derivative transformation. |
| [Burn](https://burn.dev/books/burn/building-blocks/autodiff.html) | Backend-based tensor differentiation in the Rust ecosystem. | Native typed ML libraries are a serious alternative to creating a new language. |
| [MLIR](https://mlir.llvm.org/) | Extensible compiler infrastructure with multiple abstraction levels. | Preserve domain information until the compiler can use it. |
| [IREE](https://iree.dev/) and [TVM](https://tvm.apache.org/) | ML compilation/deployment infrastructure. | Evaluate existing compute backends with a representative model before committing. |
| [ONNX Runtime](https://onnxruntime.ai/docs/) | Model execution through supported providers. | An optional adapter, subject to model/operator compatibility; not a replacement for Nexus by default. |
| [WebGPU / WGSL](https://www.w3.org/TR/WGSL/) | GPU shader execution, including compute. | Browser GPU work needs an explicit capability matrix and fallback. |
| [GraalVM](https://www.graalvm.org/latest/reference-manual/polyglot-programming/) | Polyglot value exchange for supported language implementations. | A universal bridge is not a new idea by itself. |
| [WebAssembly Component Model](https://component-model.bytecodealliance.org/) | Typed interfaces for interoperable components. | Useful optional plugin boundary; support and packaging differ by language/toolchain. |
| [DLPack](https://github.com/dmlc/dlpack) | A shared in-memory tensor representation. | Tensor exchange still needs device, ownership, layout, and synchronization agreement. |
| [Arrow C Data Interface](https://arrow.apache.org/docs/format/CDataInterface.html) | An interface for exchanging columnar arrays. | Reuse established data layouts instead of inventing every interchange format. |
| [Safetensors](https://huggingface.co/docs/safetensors/index) | Loading and saving tensor data. | Model parameters are artifacts with schemas, separate from executable source. |

## A coherent core instead of a collection of incompatible features

Proposed core: static typing with local inference; functions; structs; tagged unions; pattern matching; explicit optional values and results; generics; modules; and lexical resource lifetimes. English keywords, diagnostics, public API names, and documentation.

Take readability and quick feedback as goals inspired by Python; straightforward concurrency and tooling as goals inspired by Go; ownership discipline from Rust; data layout control and native interoperability from C/C++; and compile-time specialization from Zig. These are design inspirations, not a promise that their complete behavior can be combined without tradeoffs.

Use one ownership model for native values: unique ownership by default, scoped borrowing, and explicit shared ownership when needed. Specify cycles and reference-count costs before adding shared UI objects. An optional arena must have a real lifetime rule. Foreign managed objects remain opaque handles governed by their own runtime. “No mandatory GC in native compute” does not mean imported Python or Go loses its runtime.

Use structured tasks with cancellation and explicit ownership transfer. Avoid invisible background work. UI updates belong to the UI executor; long inference and training run on workers. A language-level rule cannot guarantee that a GPU driver or foreign call meets a frame deadline.

Define effects for I/O, allocation, foreign execution, device transfer, and mutation of model parameters. Start with a small implementable subset. A compiler can reject a known blocking operation in a render callback; it cannot statically predict arbitrary program latency.

The compiler itself could initially be written in Go to fit this repository. Native code emitted by that compiler need not use the Go runtime. A production implementation language decision should follow a backend integration experiment, not a blanket rewrite of SwypikOS.

## Interoperability architecture

An import is an adapter plus a contract, never automatic understanding of every foreign source file.

| Boundary | Proposed implementation | Essential limitations |
| --- | --- | --- |
| C | Platform-specific C ABI; generated declarations; explicit owned/borrowed buffers. | Layout, alignment, calling convention, allocation/free pairing, and error conventions must match. |
| C++ | Begin with a C-compatible wrapper; evaluate deeper Clang integration later. | Templates, exceptions, STL layouts, compiler versions, and object lifetime complicate direct imports. |
| Rust | Exported C-compatible functions or supported Wasm components. | Do not expose arbitrary Rust layouts or assume a stable default Rust ABI. |
| Go | Existing service API first; c-shared/c-archive adapter where supported and tested. | Runtime initialization, pointer retention, callback and threading rules remain relevant. |
| Python | Embedded CPython or a worker process; generated adapters around supported functions. | Object conversion, interpreter configuration, extension compatibility, and runtime-specific thread rules. No automatic speedup of Python code. |
| JavaScript/TypeScript | Browser bindings for web UI; an embedded JS runtime or worker for native use. | Event-loop, promises, garbage collection, and packaging remain part of the contract. |
| JVM/.NET and other runtimes | Later explicit host adapters or service protocols. | No blanket “any package” claim; each runtime needs tests and version support. |
| Portable plugins | WIT interfaces and the Wasm Component Model where toolchains support them. | Conversion costs, available host capabilities, and feature coverage must be measured. |
| Tensor/columnar data | DLPack and Arrow when both parties support the needed representation. | Zero-copy is conditional; a shared format does not remove device transfers or synchronization. |

Every adapter should declare types, encoding, ownership, cleanup, threading, cancellation, error mapping, supported versions, and copying behavior. Convert foreign exceptions into explicit errors at supported boundaries. Unsafe in-process libraries can corrupt the process; process isolation is a separate option with separate cost.

The proposed tool `syra explain bridge` would show declared conversions and ownership operations plus measured runtime costs when profiling is enabled. Static estimates must be labeled estimates. This tool does not exist yet.

## Candidate differentiator: explainable composition across domains

Research hypothesis: one checked contract connecting UI events, foreign functions, tensors, and model versions can reduce integration defects and avoid unnecessary work in mixed applications. This is a possible product advantage, not a proven research novelty.

Three experiments should test it:

1. **Boundary explanations:** show exactly where values are copied, converted, retained, released, or moved between devices. Compare generated adapters with equivalent handwritten adapters.
2. **Version-aware execution:** each inference operation holds one immutable weights snapshot. Cache keys include input identity, preprocessing configuration, model code, and weights version. Training publishes a new snapshot explicitly; existing inference keeps its original version.
3. **Responsive execution:** stale previews can be cancelled or discarded with explicit semantics. Training gets bounded work chunks where the backend supports them. The scheduler preserves responsiveness without claiming hard real-time guarantees.

One source language should still have distinct internal graphs: UI dependencies, pure tensor computations, and effectful tasks. They have different rules. A button click is not a differentiable tensor operation. A single untyped graph would hide this distinction and make optimization unsafe.

Foreign opaque calls are optimization barriers unless adapters provide valid contracts. Reuse of results requires purity and complete dependency tracking. Smaller precision, quantization, and approximate algorithms require explicit opt-in and quality checks.

## UI and weights

For UI, provide reusable components, typed properties, reactive state, event handlers, layout, styling, focus, keyboard navigation, and accessibility. The first backend can generate HTML/CSS/JavaScript for the existing web surface. A native renderer is a later backend with a separate validation burden.

For AI, distinguish four tasks:

- Define parameter shapes, data types, initialization, and model operations.
- Load existing parameter values from a compatible checkpoint.
- Train or fine-tune using data, a loss, gradients, and an optimizer.
- Validate and save a new parameter artifact, then explicitly publish it for inference.

Writing a `weights` declaration does not create a trained intelligent model. Useful parameters require a suitable training process or an existing checkpoint. Exporting tensors alone is not a full resumable training checkpoint: optimizer state, random-generator state, training step, preprocessing, and architecture configuration may also be necessary. Safetensors is a storage choice, not an architecture or automatic Nexus compatibility layer.

Illustrative future syntax, not an implemented API:

```text
module demo

model Classifier {
    parameter weights: Tensor<f32, [784, 10]> = xavier()
    parameter bias: Tensor<f32, [10]> = zeros()

    fn forward(x: Tensor<f32, [1, 784]>) -> Tensor<f32, [1, 10]> {
        return matmul(x, weights) + bias
    }
}

view Counter {
    state count: i64 = 0

    column(gap: 16) {
        text("Hello from Swypik")
        button("Count: {count}") {
            count += 1
        }
    }
}
```

`model` describes trainable parameters and computation. `view` describes an interface. `state` declares a value whose changes update dependent UI. The button handler increments that value. This example demonstrates intent, not an automatic connection between the counter and classifier.

Static tensor dimensions can be checked before execution. Data-dependent dimensions need runtime checks or specialization; rejecting them all would make the language too restrictive. A training DSL comes after shape rules, numerical operations, derivative correctness, and artifact formats are specified.

## Compiler and runtime plan

```text
Syra source
    -> parser and source locations
    -> typed core with ownership and effects
    -> domain lowering
         -> UI dependencies -> HTML/CSS/JavaScript initially
         -> native functions -> C output initially; LLVM candidate later
         -> tensor operations -> selected existing compute backend
         -> foreign calls -> checked adapter + foreign runtime/service
    -> diagnostics, source maps, packaging and profiling
```

MLIR is a candidate for tensor compilation once a small model proves the integration. IREE, Triton, and other compute backends are alternatives to evaluate, not dependencies to install simultaneously. A generated C backend can establish native semantics and an ABI without immediately implementing an LLVM integration. It still requires a compatible C toolchain and does not guarantee better performance than handwritten C.

Keep a tiny development interpreter optional for quick feedback. Never report interpreter timings as native backend results. Backend choice must not silently change integer overflow, aliasing, exceptions, or tensor precision semantics.

## Fit with the current project

The local README describes a Windows desktop shell built in Go with an embedded web UI. `go.mod` declares Go 1.21. The local Nexus contract documents Ilaria on loopback HTTP, a chat request/response API, serialized inference, and explicit checkpoint/tokenizer configuration. These observations come from `README.md`, `go.mod`, and `docs/NEXUS_CONTRACT.md`; live Nexus behavior was not tested in this research.

Begin by generating one optional UI component and calling the existing Go service contract. Preserve Ilaria/Nexus as the product model backend. Do not invent streaming, checkpoint reload, training, or tensor-sharing endpoints and present them as existing capabilities. Those need separate contracts and implementation.

The model-definition example is a compiler research target. It is not evidence that Ilaria's architecture or checkpoints can already be imported into Syra. A generic ONNX adapter would likewise not establish Ilaria compatibility.

## Milestones with exit criteria

| Stage | Deliverable | Exit criterion |
| --- | --- | --- |
| 0 | Core language RFC and semantics | Specify integer behavior, errors, resource lifetimes, effects, and unsupported syntax; review small examples. |
| 1 | Parser, type checker, CLI, diagnostics | Positive/negative fixtures; useful source locations; unsupported features fail explicitly. |
| 2 | Small native backend and C bridge | Run arithmetic, structs, loops, result values, and buffers; verify allocation/free contracts and malformed boundary inputs. |
| 3 | Swypik UI vertical slice | A real generated counter plus one existing Ilaria service call; verify keyboard access, error state, cancellation, and UI responsiveness. |
| 4 | Additional adapters | Rust/C++, Go, Python, and JS fixtures with pinned toolchains, ownership tests, and measured conversion costs. |
| 5 | Tensor core and weights artifacts | Matmul, activation, loss, shape checking, load/save round trip, and a small training task; gradients checked against numerical/reference results. |
| 6 | Optimization experiments | Demonstrate measured gains on a preregistered suite without relaxing correctness or model quality. |
| 7 | Broader portability and tooling | Additional targets, editor integration, debugger mapping, package management, and compatibility policy. |

This is an implementation order, not a time estimate. A reliable universal ecosystem is a sustained engineering program. The first demonstrator should prove one complete path rather than merely accept attractive syntax.

## What “better” must mean in benchmarks

Compare whole implementations and workloads, not language names alone. Report losses as well as wins.

| Area | Baseline | Metrics and controls |
| --- | --- | --- |
| Native execution | C/C++ and Rust with comparable release optimization | Same algorithms, bounds/overflow semantics, data, CPU features, threading, and allocation strategy; latency distribution and peak memory. |
| Services | Equivalent Go service | Throughput, p50/p95/p99, memory, and cancellation behavior at matched concurrency. |
| Scripting | CPython and relevant native-library-backed Python | Separate startup, pure scripting, and native compute; do not attribute library compute time to the interpreter. |
| UI | Current Swypik web UI and a selected established UI implementation | Input-to-paint, frame time, dropped frames, startup, memory, and accessibility parity. |
| AI | PyTorch eager and compiled; JAX or another compatible optimized backend | Same model, weights, dtype, batch, sequence lengths, device, quality threshold; separate compile/startup from warm execution; synchronize GPU timing. |
| Bridges | Handwritten adapters using the same underlying transport | Empty-call overhead plus real buffer/object workloads; bytes copied, allocations, cleanup, throughput, and failure behavior. |
| Developer workflow | Current project workflow | Clean/incremental build time, diagnostic quality, integration code required, and reproducible user tasks. |

Suggested experimental go/no-go target, not a predicted result: at least a 20% improvement in a declared latency or memory metric on one representative mixed UI/AI workload, while preserving output quality and avoiding material regressions in predefined guardrails. Also publish per-case results and variation. Select the workload and guardrails before optimization; one win does not establish superiority over a language.

Record hardware, drivers, OS, compiler/framework versions, flags, artifact hashes, input datasets, warm-up policy, and repeated measurements. Keep failing and slower cases visible. Training benchmarks require real loss/quality evidence, not animation or simulated GPU counters.

## Decisions still requiring experiments

The most uncertain parts are ownership ergonomics across UI graphs, useful foreign-library coverage, whether tensor/renderer sharing is possible on the actual device and process boundaries, and whether a common contract produces meaningful performance gains beyond an ordinary library.

If a typed library or generated bindings deliver the same result more simply, that is evidence against adding a language feature. If a new language demonstrably reduces integration complexity and enables optimizations that the separate tools cannot express conveniently, that is evidence for expanding Syra.

The research supports building a measured prototype. It does not establish that Syra is revolutionary, globally unique, or faster than all existing languages.
