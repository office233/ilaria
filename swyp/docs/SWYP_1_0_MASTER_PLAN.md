# Swyp 1.0 — AI-Native Self-Hosting Master Plan

Date: 2026-09-29

## Mission

Swyp becomes the primary implementation language for Ilaria and SwypikOS, then
becomes capable of compiling, verifying and evolving its own compiler.

The target is not a source-to-source rewrite of Go/Python/C. Swyp is a new
semantic systems language whose compiler owns typed contracts, effects,
capabilities, resource ownership, foreign boundaries, deterministic evidence and
AI-proposed program evolution.

Final product topology:

```text
                         natural intent / agents
                                  |
                                  v
                           Swyp source (.swyp)
                                  |
                     parser -> typed Unified HIR
                                  |
              +-------------------+-------------------+
              |                   |                   |
          contracts          effects/caps        ownership/resources
              |                   |                   |
              +-------------------+-------------------+
                                  |
                           Semantic Core IR
                                  |
             +--------------------+---------------------+
             |                    |                     |
        native CPU IR        tensor/device IR      component/WIT IR
             |                    |                     |
       x64 / arm64 / C       GPU/NPU backends       Wasm/foreign ABI
             |                    |                     |
             +--------------------+---------------------+
                                  |
                            SwypikOS broker
                                  |
                    devices / files / net / tools
```

## Non-negotiable invariants

1. AI proposes; deterministic compiler/verifier gates acceptance.
2. No model is required for deterministic build or execution.
3. No self-modification can replace a production compiler without reproducible
   tests, verification evidence, benchmark evidence, lineage and rollback.
4. Capabilities are authority owned by SwypikOS. Swyp code may only declare
   logical requirements.
5. Foreign code is an explicit adapter plus contract, never an untyped import.
6. Native hot paths must not require a tracing GC.
7. Backend selection must not silently change integer, floating-point, aliasing,
   failure, capability or concurrency semantics.
8. Source, IR, contracts, compiler identity and produced artifacts are
   content-addressed and auditable.

## What exists already

Swyp already has the important seed:

- scalar parser/checker and AST interpreter;
- Semantic Core typed IR with i64/u64/f64/ieee64;
- contracts and bounded verification with counterexamples;
- deterministic synthesis/refinement;
- effect/capability metadata with propagation validation;
- SSA, liveness and deterministic register allocation;
- x86-64 and ARM64 native lowering;
- C AOT, Turbo execution and STV2/SWYPB;
- component/model/expert/dataset/train/driver/record declarations;
- model-facing `swyp judge` and draft/expand/repair paths.

The next generation must converge these surfaces instead of adding parallel
language islands.

## Language architecture

### L0 — Syntax and Unified HIR

Replace the legacy/Core/component split with one typed HIR.

Required declarations:

```text
module
use
fn
struct
enum
trait/interface
impl
resource
foreign
component
capability
effect
contract
task
agent
driver
model
expert
dataset
train
verify
record
```

Required value system:

```text
bool
i8/i16/i32/i64/i128
u8/u16/u32/u64/u128
f16/bf16/f32/f64
finite32/finite64
string
bytes
array<T,N>
slice<T>
vec<T>
option<T>
result<T,E>
tuple
struct
enum
opaque<T>
tensor<T,Shape,Device>
```

Legacy `number` becomes compatibility syntax, not the semantic foundation.

### L1 — Ownership and resources

Native values use a real resource model:

- unique ownership by default;
- immutable borrow;
- mutable borrow;
- explicit shared ownership where required;
- lexical destruction/RAII;
- opaque foreign handles;
- arenas/regions only with explicit lifetime semantics;
- pinning for ABI/device transfers;
- no implicit ownership transfer across async/task boundaries.

Every FFI adapter declares allocation/free pairing and retention rules.

### L2 — Effects and capabilities

Source syntax lowers to the existing effect metadata and later resumable effect
instructions.

Initial source-visible effect classes:

```text
alloc
clock.read
fs.read
fs.write
net.connect
net.fetch
process.exec
rng.sample
model.infer
model.mutate
tool.call
device.read
device.write
device.compute
foreign.call
```

The compiler computes transitive effects. SwypikOS resolves logical capability
requirements to opaque grants.

### L3 — Contracts and proofs

Contracts apply to functions, resources, effects, adapters and compiler
transformations.

Verification ladder:

1. static type/effect/ownership checking;
2. finite exhaustive execution where possible;
3. property-based and differential testing;
4. fuzzing;
5. symbolic/SMT proof for a supported subset;
6. translation validation for optimizer/backend transformations.

A result must always identify the evidence class; sampled testing is never
reported as proof.

### L4 — Polyglot interoperability

Swyp does not pretend to understand every foreign language directly.
Interoperability is a typed adapter protocol.

Priority boundaries:

1. C ABI;
2. Rust through C ABI or Wasm Component Model;
3. WIT/Wasm Component Model;
4. Python worker/embedded CPython adapters;
5. Go service/c-shared adapters;
6. JavaScript/TypeScript worker/browser adapters;
7. JVM/.NET host adapters;
8. DLPack/Arrow tensor/data exchange.

Every adapter describes:

- ABI/version;
- types/layout/alignment;
- encoding;
- ownership and cleanup;
- sync/async behavior;
- threading;
- cancellation;
- error mapping;
- copies/device transfers;
- effects/capabilities.

The compiler must be able to explain the bridge and its runtime costs.

### L5 — Concurrency

Use structured concurrency, not invisible background work.

Required primitives:

- task scopes;
- cancellation;
- channels/messages;
- actors where useful;
- explicit ownership transfer;
- deterministic task groups for pure compute;
- separate UI/main executor;
- bounded device/model work.

### L6 — AI-native compiler API

The compiler exports a machine-readable Language Capability Manifest generated
from the actual compiler, never a hand-maintained prompt.

The API exposes:

- supported syntax/features/types;
- effects/capabilities;
- diagnostics with stable codes;
- semantic diff;
- contract generation/checking;
- candidate verification;
- counterexamples;
- migration hints;
- optimizer evidence;
- backend support matrix.

AI loop:

```text
intent
  -> contract/spec
  -> candidate
  -> parse/type/effect/ownership
  -> verify
  -> counterexample/diagnostic
  -> repair
  -> differential/fuzz/benchmark gates
  -> signed candidate artifact
```

### L7 — Verified evolution

Self-improvement is a promotion pipeline, not uncontrolled self-editing.

```text
compiler Cn
   |
telemetry + failures + benchmark corpus
   |
AI/synthesis proposes patch
   |
candidate compiler Cn+1
   |
bootstrap build
   |
semantic regression suite
   |
differential tests
   |
fuzz
   |
translation validation
   |
performance/size/resource gates
   |
reproducibility check
   |
promote or reject
```

Every promoted compiler records:

- parent compiler hash;
- source tree hash;
- patch hash;
- generator/model identity when applicable;
- test/fuzz corpus hashes;
- verification evidence;
- benchmark evidence;
- compiler binary hash;
- rollback pointer.

## Self-hosting stages

### S0 — Go bootstrap

Current compiler remains the trusted bootstrap implementation.

Exit criterion:
- Unified HIR and new semantic rules are implemented and independently tested.

### S1 — Swyp standard modules

Move deterministic libraries to Swyp first: canonical encoding, hashes wrappers,
protocol validation, state machines and pure algorithms.

Exit criterion:
- Swyp versions pass differential tests against Go references.

### S2 — Compiler leaf modules

Rewrite parser-independent compiler modules in Swyp:

- IR transforms;
- optimizer passes;
- contract predicates;
- verifier utilities;
- ABI schema generators.

Exit criterion:
- bootstrap compiler can compile and run these modules with identical results.

### S3 — Frontend self-hosting

Rewrite lexer/parser/HIR/type/effect/ownership checker in Swyp.

Exit criterion:
- Go bootstrap and Swyp compiler produce canonical-equivalent HIR/Core IR for a
  frozen corpus.

### S4 — Backend self-hosting

Rewrite optimizer, SSA, register allocation and backend orchestration in Swyp.

Exit criterion:
- Swyp-built compiler can compile the compiler and reproduce a semantically
  equivalent next-stage compiler.

### S5 — Reproducible bootstrap

Use diversified double compilation / independent bootstrap checks where
practical to reduce trust in a single bootstrap binary.

## Ilaria migration

Current approximate implementation surface observed on 2026-09-29:

- Go: 19 files / ~2,060 lines;
- Python: 22 files / ~3,246 lines.

Migration order:

1. protocol validation and Myriad DTO/business rules;
2. connectome/PCE/state machines;
3. tokenizer/data pipeline orchestration;
4. model manifest/checkpoint lineage;
5. inference graph representation;
6. tensor/autodiff core;
7. optimizer/training loop;
8. distributed expert/training orchestration;
9. remove Python runtime dependency after tensor backend parity is demonstrated.

The IMC architecture remains one model family; migration must not introduce
alternate pretrained model architectures.

Python/Torch remains a differential oracle until Swyp tensor/training semantics
match it on frozen tests.

## SwypikOS migration

Current approximate implementation surface observed on 2026-09-29:

- Go: 178 files / ~27,163 lines;
- C/H native kernel seed: ~1,730 lines;
- small Python support surface.

Migration order:

1. pure state models and protocol DTOs;
2. agent planner/tool schemas;
3. Control Kernel state machine and projection logic;
4. event store and recovery logic;
5. capability/effect broker;
6. federated/Compute Fabric orchestration;
7. portable UI state/controller layer;
8. HAL/device abstractions;
9. native UI/runtime bindings;
10. kernel subsystems once Swyp supports freestanding compilation.

Kernel-facing Swyp requires, before migration:

- freestanding target;
- exact repr/layout attributes;
- volatile loads/stores;
- atomics and memory ordering;
- interrupts/traps;
- MMIO/PIO abstractions;
- no-allocation/no-panic profiles;
- linker sections;
- calling-convention control;
- inline or external assembly boundary;
- deterministic stack/resource limits.

Do not rewrite kernel C merely for language purity before these semantics exist.

## Migration rule: vertical slices

No big-bang translation.

Each migrated subsystem follows:

```text
existing implementation
      |
freeze observable contract + fixtures
      |
Swyp implementation
      |
differential tests
      |
stress/fuzz/race/resource tests
      |
performance comparison
      |
switch default
      |
retain old implementation as oracle briefly
      |
delete old implementation
```

A migration is complete only after the old implementation is no longer required
for correctness or production execution.

## Immediate milestones

### M0 — Compiler truth

- [x] Language Capability Manifest generated from the compiler.
- [x] Remove stale hard-coded Swyp 0.2 AI prompt.
- [x] Configurable model/backend endpoint.
- [x] Stable diagnostic codes (source diagnostic schema v1, published in the manifest).
- [x] One version source of truth.

### M1 — Unified HIR

- One frontend pipeline for executable and declarative Swyp.
- Modules/imports.
- structs/enums/option/result.
- typed arrays/slices.
- source-visible effects/contracts.

### M2 — Resource-safe systems core

- ownership/borrowing/resources;
- explicit memory/layout semantics;
- C ABI FFI;
- deterministic destruction;
- structured concurrency foundations.

### M3 — Universal bridge

- WIT/Wasm components;
- Rust/Python/Go/JS adapters;
- bridge explain command;
- generated adapter tests.

### M4 — AI compiler

- structured compiler service;
- contract-first synthesis;
- semantic repair;
- frozen eval suite;
- verified candidate registry.

### M5 — Swyp self-hosting seed

- migrate deterministic compiler leaf modules;
- bootstrap equivalence gates.

### M6 — Ilaria-on-Swyp

- protocol/control plane first;
- then tensor/model/training runtime;
- Python removed only after parity.

### M7 — SwypikOS-on-Swyp

- Control Kernel and agent runtime;
- capability broker;
- Compute Fabric;
- UI/control plane;
- HAL and finally freestanding kernel modules.

### M8 — Verified self-evolution

- compiler candidate farm;
- reproducible promotion;
- regression/fuzz/perf gates;
- automatic rollback;
- no unverified autonomous replacement.

## Definition of success

Swyp 1.0 succeeds when:

1. a substantial Ilaria build runs without Go/Python application logic;
2. a substantial SwypikOS build runs without Go application logic;
3. Swyp can express the required systems/tensor/agent semantics directly;
4. Swyp compiler stages can compile later compiler stages;
5. AI can propose compiler/application changes through structured APIs;
6. every promoted change carries machine-verifiable provenance/evidence;
7. one Swyp source graph can safely coordinate native CPU, accelerator, foreign
   runtime, model and OS-capability work without hiding ownership or authority.
