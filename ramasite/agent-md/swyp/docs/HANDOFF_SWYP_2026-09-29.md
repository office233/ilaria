# HANDOFF — Swyp Lang → Ilaria + SwypikOS
Date: 2026-09-29
Workspace: E:\nexus
Primary Swyp module: E:\nexus\swyp
Branch observed: agent/nexus-clean-swyp-fast

## 0. READ THIS FIRST

The repository is already in a large, intentionally dirty migration state. At the latest inspection, the root worktree contains hundreds of modified/renamed/deleted files from ongoing Nexus/Ilaria/SwypikOS reorganization.

DO NOT:
- git reset --hard
- git clean -fd/-fdx
- mass-revert files you did not create
- overwrite generated/spec files without checking their source-of-truth workflow
- assume every dirty file belongs to the Swyp task

Use surgical edits and preserve unrelated work.

Required Swyp project rules are in:
- E:\nexus\swyp\AGENTS.md

Core rule: Swyp must stay deterministic and independently buildable. Model access is optional and no correctness property may depend on an LLM being available.

## 1. Product goal

The target is not “translate Go/Python/C syntax into Swyp”.

The target is a new AI-native systems language where:

- Ilaria application/model orchestration is written in Swyp;
- SwypikOS application/control-plane code is written in Swyp;
- Swyp eventually supports freestanding/kernel-facing code;
- Swyp becomes self-hosted;
- AI can propose code/compiler changes, but deterministic verification decides whether they are accepted;
- compiler self-evolution is staged, reproducible, verified and rollback-capable.

Target semantic pipeline:

intent / AI
    -> Swyp source
    -> Unified typed HIR
    -> types + contracts + effects + capabilities + ownership/resources
    -> Semantic Core IR
    -> native CPU / tensor-device / Wasm-foreign backends
    -> SwypikOS capability broker / hardware / external runtimes

The canonical long-term plan is:
- swyp/docs/SWYP_1_0_MASTER_PLAN.md

Read that file before designing major language changes.

## 2. What existed before this handoff

Swyp was already much more than a toy language.

Observed existing implementation:

### Frontend/runtime
- scalar parser/checker/interpreter
- functions, let/assignment, if/else, while, return
- legacy scalar types: number/bool/string
- Semantic Core source mode with i64/u64/f64/ieee64

### Semantic Core
- typed Core IR
- strict JSON decoding
- CFG validation
- contracts
- bounded execution
- counterexample reporting
- exhaustive/tested/unknown/timeout verification states

### Optimization/native
- constant folding
- simplification
- DCE
- copy propagation
- CFG cleanup
- pure call inlining
- SSA
- liveness
- deterministic register allocation/spilling
- direct x86-64 lowering
- ARM64 lowering
- C AOT
- safe/fast/turbo execution paths

### Portable/runtime formats
- STV2 VM
- SWYPB modules

### AI/synthesis
- draft
- #natural / #limbaj_natural
- expand
- repair
- swyp judge
- deterministic enumerative synthesis
- counterexample-guided refinement

### Effects/capabilities
- Effect ABI v1 is already implemented in internal/coreir/effects.go
- current registry includes:
  clock.read
  fs.read
  fs.write
  model.infer
  net.connect
  net.fetch
  process.exec
  rng.sample
  tool.call
- call graph propagation is validated
- current pure executor intentionally refuses effectful execution

### Component DSL
Already supports declarative:
- component
- capability
- effect
- contract
- task
- agent
- driver
- model
- expert
- dataset
- train
- verify
- record

This is already used by Ilaria and SwypikOS specs.

## 3. Audit findings that matter

### 3.1 Three language islands currently coexist

There are effectively three Swyp surfaces:

1. Legacy scalar Swyp
   -> AST interpreter / C / JS / STV2

2. Semantic Core Swyp
   -> explicit numeric types / CoreIR / optimizer / native backends

3. Component Swyp
   -> model/agent/driver/effect/record manifests

These must converge into one typed Unified HIR. Do not add a fourth parallel frontend.

### 3.2 Documentation is behind implementation

Some roadmap text still describes effects/capabilities as future work even though internal/coreir/effects.go and tests already implement Effect ABI v1.

Trust the code plus reproduced tests over old status prose.

### 3.3 AI compiler drift was real

Before the fixes in this session:
- CLI advertised Swyp 0.14.0-experimental;
- draft prompt still told Ilaria “Swyp Lang 0.2”;
- generated C still identified itself as Swyp Lang 0.2;
- generation provenance used an old 0.3 version;
- Ilaria endpoint was duplicated as a hard-coded loopback URL.

This was a real compiler/model contract drift.

## 4. Changes implemented in this session

### New files

1. swyp/docs/SWYP_1_0_MASTER_PLAN.md
   - canonical architecture/migration/self-hosting plan
   - defines M0-M8
   - defines Ilaria migration
   - defines SwypikOS migration
   - defines verified self-evolution policy

2. swyp/cmd/swyp/language.go
   - defines machine-readable Language Capability Manifest
   - adds compiler capability metadata
   - emits types/operators/effects/features
   - generates AI language specification from current compiler metadata

3. swyp/cmd/swyp/ai_backend.go
   - centralizes Ilaria endpoint construction
   - default: http://127.0.0.1:8091
   - SWYP_ILARIA_ENDPOINT overrides endpoint
   - SWYP_ILARIA_TOKEN enables authenticated HTTPS backend path

4. swyp/cmd/swyp/language_test.go
   - guards compiler version vs language manifest
   - guards AI prompt against stale “Swyp Lang 0.2”
   - tests manifest JSON
   - tests configurable endpoint selection

5. swyp/internal/swyplang/version.go
   - compiler-owned language version
   - current value: 0.14.0-experimental

### Modified files

6. swyp/cmd/swyp/draft.go
   - removed hard-coded Swyp 0.2 prompt
   - prompt now derives version/type context from compiler metadata
   - uses configured Ilaria backend

7. swyp/cmd/swyp/intent.go
   - intent prompt now uses current compiler spec
   - uses configured Ilaria backend
   - generation provenance now records current Swyp language version

8. swyp/cmd/swyp/main.go
   - version command derives from compiler-owned version
   - added:
     swyp language-manifest

9. swyp/internal/swyplang/native.go
   - generated C header now uses current compiler-owned Swyp version instead of hard-coded 0.2

10. swyp/README.md
   - links the Swyp 1.0 master plan

11. swyp/docs/SWYP_LANG.md
   - current heading aligned to 0.14 experimental
   - documents language-manifest
   - documents configurable Ilaria endpoint/token

## 5. Current verification evidence

Verified after the changes:

### LSP
Files checked:
- cmd/swyp/language.go
- cmd/swyp/ai_backend.go
- cmd/swyp/draft.go
- cmd/swyp/intent.go
- cmd/swyp/main.go
- cmd/swyp/language_test.go
- internal/swyplang/version.go
- internal/swyplang/native.go

Result:
- 0 compiler errors
- one informational Go suggestion in native.go (QF1003 tagged switch); not an error

### Tests
Command:

go test -count=1 ./internal/swyplang ./cmd/swyp

Result:
PASS
- swyp-lang/internal/swyplang
- swyp-lang/cmd/swyp

Earlier targeted/full Swyp gates from the same branch also passed during the day, including x64/ARM64 work, but do not treat those as proof for any future edits.

### Worktree whitespace check
Command:

git -C E:\nexus diff --check -- swyp

Result:
PASS

### Runtime manifest
Command:

go run ./cmd/swyp language-manifest

Result:
PASS

Current manifest reports:
- version 0.14.0-experimental
- legacy types number/bool/string/void
- Core types bool/i64/u64/f64/ieee64/void
- Effect ABI v1 registry
- contracts/synthesis/SSA/native x64/native ARM64/Turbo/STV2/components feature flags

## 6. Important dirty-worktree warning

The following files touched in this session are mixed with an already-dirty root repository.

Latest scoped status:

MM swyp/README.md
 M swyp/cmd/swyp/draft.go
 M swyp/cmd/swyp/intent.go
MM swyp/cmd/swyp/main.go
 M swyp/docs/SWYP_LANG.md
 M swyp/internal/swyplang/native.go
?? swyp/cmd/swyp/ai_backend.go
?? swyp/cmd/swyp/language.go
?? swyp/cmd/swyp/language_test.go
?? swyp/docs/SWYP_1_0_MASTER_PLAN.md
?? swyp/internal/swyplang/version.go

“MM” means those files already had staged/working-tree history from other work. Inspect before staging or committing.

Do not bundle unrelated repository restructuring into a Swyp feature commit.

## 7. Measured migration surface

At the audit point:

Ilaria:
- Go: 19 files, ~2,060 lines
- Python: 22 files, ~3,246 lines

SwypikOS:
- Go: 178 files, ~27,163 lines
- C: 8 files, ~1,269 lines
- H: 9 files, ~461 lines
- small Python support surface

These numbers are approximate line counts used for migration planning, not complexity estimates.

## 8. Immediate next work — priority order

### P0 — Finish M0 “Compiler Truth”

Goal: compiler/model/tooling can never silently disagree about the language.

Do next:

1. Move all language metadata to a compiler-internal metadata package.
   Suggested:
   internal/langmeta

2. Make these consumers depend on the same metadata:
   - version command
   - language-manifest
   - AI prompt generation
   - generated artifact headers
   - docs-generation command if added later

3. Reduce manually duplicated capability lists.
   The current manifest is much better than before, but operators/features are still manually enumerated in cmd/swyp/language.go.

4. Add stable diagnostic codes to source parser/checker paths.
   CoreIR already has structured diagnostics; legacy/source frontend errors are mostly free-form strings.

5. Add tests proving:
   - manifest version == compiler version
   - manifest effects == Core effect registry
   - AI prompt uses current supported source surface
   - generated C header uses current version
   - no active code contains old “Swyp Lang 0.2”

6. Run final module gate:
   go vet ./...
   go test -count=1 ./...

Acceptance:
- one source of truth
- no stale active-language version strings
- deterministic JSON manifest
- full Swyp gate green

### P1 — M1 Unified HIR

This is the most important architectural task.

Do NOT bolt structs/modules onto both legacy AST and Core independently.

Create one typed intermediate frontend representation, e.g.:

internal/hir/

Initial HIR must represent:
- Module
- Import/Use
- Function
- Parameter
- Local
- Block
- Expression
- Struct
- Enum
- Option/Result
- Array/Slice
- Resource
- Effect set
- Capability requirement
- Contract reference
- Foreign declaration

Suggested migration shape:

source parser
    -> syntax AST
    -> Unified HIR
    -> semantic checking
    -> CoreIR lowering

The existing CoreIR stays as execution/compiler IR. HIR is the language-semantic layer above it.

Acceptance:
- current Semantic Core samples lower through HIR without semantic regressions
- legacy path can be gradually retired rather than duplicated
- source locations preserved
- canonical HIR dump available for tests/debugging

Strong suggestion:
add an opt-in command first:

swyp hir file.swyp

Return deterministic JSON for frozen fixtures.

### P2 — Type System v2

After HIR exists, add in this order:

1. struct
2. enum/tagged union
3. option<T>
4. result<T,E>
5. fixed array<T,N>
6. slice<T>
7. vec<T> or owned buffer
8. generics only after monomorphic aggregates are stable

Do not jump directly to arbitrary generics.

Define ABI/layout separately from semantic type identity.

### P3 — Ownership/resource model

Needed before serious OS/FFI migration.

Required concepts:
- owned
- borrow
- mut borrow
- shared only when explicit
- deterministic destruction
- resource/opaque handles
- pinning
- transfer across task boundaries
- no implicit aliasing of mutable buffers

Add ownership checking to HIR, not to machine IR.

### P4 — Source-visible effects + SwypikOS effect runtime

The effect metadata layer already exists in CoreIR.

Missing:
- source syntax
- HIR effect typing
- lowering
- resumable effect instruction/runtime
- EffectRequest/EffectResult connection to SwypikOS broker
- effect result binding to request/task/lease evidence

Keep authority in SwypikOS. Never put bearer capability tokens in guest Swyp IR.

### P5 — Foreign Interface IR

First production FFI target: C ABI.

A foreign declaration must include:
- ABI/version
- parameter/result types
- layout/alignment
- owned/borrowed semantics
- cleanup function/pairing
- errors
- threading
- cancellation
- copies
- effects/capabilities

Then:
- Rust via C ABI and/or Wasm Component Model
- WIT/Wasm Components
- Python adapter
- Go adapter
- JS/TS adapter
- DLPack/Arrow for tensors/data

No “import any package from any language” magic.

### P6 — First Ilaria migration vertical slice

Do not start with PyTorch/model training.

First candidates should be deterministic/pure protocol logic.

Inspect:
- ilaria/runtime/protocol/contract.go
- ilaria/runtime/connectome/connectome.go
- ilaria/runtime/pce/capsule.go

Recommended first slice:
protocol validation + immutable DTOs.

Process:
1. freeze Go behavior with tests/fixtures;
2. implement equivalent Swyp types/functions;
3. differential-test Go vs Swyp;
4. switch one consumer;
5. keep Go oracle briefly;
6. remove Go only after parity.

Python/Torch model code remains the reference until tensor/autodiff/backend support exists.

### P7 — First SwypikOS migration vertical slice

Start with pure state/control logic, not Win32 UI or kernel C.

Best candidates:
- core/controlkernel/state.go
- pure validation/model helpers in core/controlkernel/model.go
- projection logic after structs/enums exist

Then:
- event store
- lease/recovery semantics
- capability broker
- agent runtime
- Compute Fabric
- UI state/controller
- HAL
- native UI
- kernel last

### P8 — Tensor/AI runtime

Required before eliminating Ilaria Python training stack:

- tensor<T, Shape, Device>
- dtype/shape checking
- matmul
- normalization
- attention primitives
- activation primitives
- autodiff
- optimizer state
- checkpoint format
- deterministic/random semantics
- device transfer semantics
- CPU reference backend
- GPU backend

Keep Python/PyTorch as differential oracle until frozen parity tests pass.

### P9 — Freestanding/kernel Swyp

Do not rewrite kernel C before Swyp supports:

- exact repr/layout
- no_std/freestanding target
- volatile memory operations
- atomics + memory order
- MMIO/PIO
- interrupts/traps
- linker sections
- calling conventions
- explicit stack/resource budgets
- no-alloc/no-panic profile
- assembly boundary
- architecture-specific intrinsics

Only then migrate kernel modules incrementally.

### P10 — Self-hosting

Order:
1. pure standard modules
2. verifier/optimizer leaf utilities
3. IR transformations
4. lexer/parser/HIR
5. type/effect/ownership checker
6. optimizer/SSA/regalloc orchestration
7. backend orchestration
8. Swyp compiler builds next Swyp compiler

Require differential/canonical equivalence against Go bootstrap at every stage.

### P11 — Verified self-evolution

Never allow direct autonomous replacement of production compiler.

Pipeline:

compiler Cn
 -> collect regressions/bench evidence
 -> AI/synthesis proposes patch
 -> build Cn+1
 -> bootstrap
 -> static checks
 -> contracts
 -> differential tests
 -> fuzz
 -> translation validation
 -> performance/resource gates
 -> reproducibility
 -> promote/reject
 -> rollback pointer

Every promoted compiler needs content-addressed lineage.

## 9. Recommended first task for the next agent

Start with P0 + the smallest possible P1 scaffold.

Concrete task:

A. Refactor language metadata out of cmd/swyp into internal/langmeta without behavior changes.

B. Add deterministic HIR skeleton:
- internal/hir/types.go
- internal/hir/module.go
- internal/hir/validate.go

C. Add an opt-in current-source-to-HIR path for functions/scalars only.

D. Add:
swyp hir <file.swyp>

E. Lower HIR back into the existing CoreIR for the currently supported Core subset.

F. Freeze equivalence tests:
current ParseCore/CoreIR output vs new AST->HIR->CoreIR path.

Do not switch production/default lowering until equivalence tests are green.

## 10. Validation protocol for every implementation step

After modifying Go code:

1. run LSP diagnostics on changed files;
2. run gofmt/check_files;
3. run targeted unit tests;
4. run:
   git -C E:\nexus diff --check -- swyp
5. before declaring milestone complete:
   cd E:\nexus\swyp
   go vet ./...
   go test -count=1 ./...

For Ilaria migrations also obey ilaria/AGENTS.md.
For SwypikOS migrations also obey swypik-os/AGENTS.md.

Never claim a delegated/agent task is done just because the agent said so. Reproduce tests locally.

## 11. Files to read first

In order:

1. swyp/AGENTS.md
2. swyp/docs/SWYP_1_0_MASTER_PLAN.md
3. swyp/docs/ARCHITECTURE.md
4. swyp/docs/EFFECTS_CAPABILITIES.md
5. swyp/docs/SEMANTIC_CORE.md
6. swyp/internal/swyplang/swyp.go
7. swyp/internal/swyplang/core_lower.go
8. swyp/internal/coreir/ir.go
9. swyp/internal/coreir/effects.go
10. swyp/internal/coreir/optimize.go
11. swyp/cmd/swyp/judge.go
12. swyp/cmd/swyp/language.go
13. swyp/cmd/swyp/ai_backend.go

For migration targets:
14. ilaria/AGENTS.md
15. ilaria/runtime/protocol/contract.go
16. swypik-os/AGENTS.md
17. swypik-os/core/controlkernel/state.go
18. swypik-os/core/controlkernel/kernel.go

## 12. Architectural decisions already made

Treat these as current direction unless new evidence justifies changing them:

- Semantic Core IR is kept; do not throw it away.
- Unified HIR goes above CoreIR.
- AI proposes, deterministic systems verify.
- effects/capabilities are explicit.
- SwypikOS owns machine authority.
- C ABI is first native FFI.
- Wasm Component Model/WIT is the preferred portable component boundary.
- Python/Go/JVM/etc. need explicit adapters, not magical imports.
- no mandatory tracing GC for native compute/system hot paths.
- kernel migration is last, after freestanding semantics exist.
- self-hosting is incremental.
- self-evolution is candidate/promotion based, never blind mutation.

## 13. Definition of the final objective

The project reaches the intended destination when:

- Ilaria control/model orchestration is predominantly Swyp;
- Ilaria tensor/training logic can run through Swyp-native semantics/backends;
- SwypikOS control plane and application logic are predominantly Swyp;
- kernel-facing Swyp is real and validated, not simulated;
- Swyp compiler can compile later versions of itself;
- AI can propose language/compiler/application changes through structured compiler APIs;
- every promoted compiler/program change carries reproducible verification/provenance;
- foreign languages become explicit compatibility boundaries rather than the implementation language of the platform.
