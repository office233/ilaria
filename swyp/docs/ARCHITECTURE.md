# Swyp architecture

## Principle

A generator proposes; the compiler and verifier dispose. Every accepted program
carries its evidence (source hash, IR hash, contract hash, verification status).
Pure execution is deterministic and never calls a model. Host effects use an
explicit SwypikOS broker boundary.

## Pipelines

```
shared source preamble ── module/use metadata ──┬─ executable/Core parser ── typed body HIR
                                               └─ declarative component parser ── declaration HIR
                         │
                         ├─ module graph (explicit root + hashes)
                         └─ qualified HIR linker (`swyp hir-link`)
                                      │
                                      v
                              linked HIR bundle
                                      │
                         ┌────────────┴────────────┐
                         v                         v
                    Core IR v1              SSA / regalloc
                  (`hir-core`)          x64 / ARM64 native backends

                        ┌─ run          AST interpreter (step + call-depth budgets)
.swyp ── Parse ── Check ┼─ build/emit-c C source → GCC native executable
  (legacy scalar)       ├─ web          offline HTML/JS runner
                        └─ compile      safe-integer subset → STV2 → .swypb ── exec

.swyp ── ParseCore ── lower ── coreir JSON ─┬─ core-run / core-exec  (pure, fuel-bounded)
  (Semantic Core:                           └─ verify -contract → status + counterexample
   i64, f64, pure calls)

coreir JSON effect metadata ── validate/prepare ── effectful profile ──X─ pure profiles
                                                        │
                                                        └─ core-broker safe handler ↔ SwypikOS Capability Broker

spec/contract ── synthesis search ── candidate .swyp ── verify ── accept / refine
```

- **Legacy scalar language** (`internal/swyplang/swyp.go`, `check.go`): `number` is
  float64; used by the interpreter, C and JS backends.
- **Shared source frontend** (`internal/sourcefront`): owns the version-1
  `module`/`use` preamble shared by executable and declarative Swyp. It records
  logical dependencies without acquiring ambient authority. `swyp module-graph`
  resolves them through an explicit filesystem root, verifies declared module
  identity/cycles/bounds and content-addresses every source. Declaration parsing
  and symbol linking remain split until later M1 migration slices.
- **HIR v1** (`internal/hir`): a versioned common envelope with
  `module::kind::name` identities, typed function signatures, typed statement /
  expression bodies, fixed-array/slice expressions, typed record fields, nominal
  struct construction/projection, enum construction/exhaustive matching and
  contextual option/result tagged values. `internal/swyplang` and
  `internal/componentspec` both adapt into it. HIR bundles resolve imported calls
  and qualified nominal type references only through direct `use` edges and
  independently revalidate declaration/signature/value schemas.
  Existing execution backends still lower from the old AST/Core path until the
  modular HIR path is selected.
- **Fixed HIR layout** (`internal/hir/layout.go`, `swyp hir-layout`): compiler-
  owned `swyp-fixed-v1` layout for fixed-width scalars, fixed arrays,
  structs/records and enums. It is intentionally separate from C/native ABI and
  refuses descriptor/owned/dynamic types.
- **Logical descriptor ABI** (`internal/hir/descriptor.go`, `swyp hir-descriptor`):
  `swyp-descriptor-v1` describes `slice<T>`, `vec<T>`, `ref<T>` and `mutref<T>`
  using opaque storage identities plus checked element/byte offsets, lengths and
  capacities. It derives element stride only from `swyp-fixed-v1` and provides
  overflow-safe index/range/descriptor validation. It deliberately does not
  define a raw-pointer ABI or native storage lookup yet.
- **Bounds evidence** (`internal/hir/bounds.go`, `swyp hir-bounds`): classifies
  every index/range access as statically `proven` or `runtime_required`, rejects
  statically impossible fixed-array bounds, and provides deterministic evidence
  for later Core/native bounds-check lowering or elision.
- **Descriptor storage oracle** (`internal/hir/storage.go`): bounded reference
  semantics for opaque `storage_id` values with monotonic non-reused IDs,
  mutable/immutable blocks, checked reads/writes and stale-descriptor rejection.
  It is a differential oracle for future Core/native storage runtimes, not a
  second Swyp execution engine.
- **Affine ownership gate** (`internal/hir/ownership.go`, `swyp hir-ownership`):
  recursively classifies HIR values as Copy/Move/Borrowed, tracks by-value moves
  through structured control flow and emits deterministic evidence for
  use-after-move, implicit drop, borrowed escape and unsupported partial/loop
  moves. `drop(x)` explicitly consumes a move value in HIR. Lexical `&`/`&mut`
  borrows now track shared/exclusive loans to scope exit (or early `drop`), with
  Copy-only dereference and `store(mutref<T>, value)` in v1. Explicit
  `borrows <param>` contracts propagate lifetime provenance across linked calls;
  non-Copy field/index projections participate in conservative place analysis.
- **HIR → Core translation** (`internal/hircore`): lowers a validated linked HIR
  bundle into ordinary Core IR, retaining the root entry name and assigning
  deterministic hash-derived internal names to linked symbols. The result is
  validated by Core IR and can be consumed by `core-exec`, SSA, optimizer and
  native backends without a second runtime or IR format.
- **Linked native build** (`hir-x64-pack`, `hir-arm64-pack`, `hir-x64-exe`,
  `hir-arm64-exe`): reuses the same native module validation, SSA, register
  allocation, process runtime and sensitive capability grants as the original
  single-file Core commands. Packed modules are pure-only; standalone authority
  remains explicit and propagated across imported calls.
- **Semantic Core** (`core_lower.go`, `internal/coreir`): explicit `i64`/`f64`
  types, a mutable-slot CFG IR with a verifier, loader limits (1 MiB, 64
  functions, unknown fields rejected). Effect ABI v1 adds closed effect names,
  declarative capability requirements and call-graph propagation. Prepared
  effectful entries are reported but never executed by the Core executor.
- **STV2 / SWYPB** (`internal/stv2`, `stv2.go`, `swypb.go`): 27-opcode ISA with
  ternary-encoded instructions, executed on int64 registers by a bounded Go VM.
  SWYPB wraps the program in a versioned header with a SHA-256 trailer.
- **Synthesis** (`internal/synthesis`): bounded enumeration over `x`, constants
  and `+ - *`, refined by counterexamples; `-contract` mode uses relational
  postconditions and requires exhaustive finite-domain verification by default.

## Machine-readable surfaces

| Surface | Producer | Consumer |
|---|---|---|
| source module/use metadata | `internal/sourcefront` | executable/Core + component parsers |
| module graph JSON v1 | `swyp module-graph -root DIR` | future typed HIR/linker, build tooling |
| HIR module JSON v1 | `swyp hir` | agents, migration tooling, future backend lowering |
| linked HIR bundle JSON v1 | `swyp hir-link -root DIR` | Core/native linker and build pipeline |
| fixed HIR layout JSON v1 | `swyp hir-layout -root DIR -type TYPE` | layout/ownership work, ABI tooling |
| affine ownership report JSON v1 | `swyp hir-ownership -root DIR` | promotion gates, agents, ownership migration |
| Core IR JSON v1 from linked HIR | `swyp hir-core -root DIR` | `core-exec`, verifier, native tooling |
| linked native packed/executable artifacts | `swyp hir-{x64,arm64}-{pack,exe}` | native hosts / standalone process runtime |
| coreir JSON v1 | `swyp ir` | `core-exec`, external tools |
| Contract JSON v1 | hand-written / generator | `verify`, `synth -contract` |
| Verify report JSON | `swyp verify` | agents (status, counterexample, hashes) |
| EffectRequest / EffectResult v1 | `swyp core-broker` / SwypikOS broker | SwypikOS capability broker / existing safe Core interpreter |
| Worker JSON (stdin/stdout) | `swyp worker` | `bridge/nexus`, Nexus forge checks |
| SWYPB binary | `swyp compile` | `swyp exec`, any host embedding `internal/stv2` |

## Integration with Nexus and SwypikOS

- **Nexus (Ilaria)** already uses the Swyp compiler to check generated programs
  during training (`D:\nexus\forge\colab\build_project_v6.py`). At run time the
  natural hook is Nexus's `ChatTool` interface (`cortex/toolloop.go`); the
  current `bridge/nexus` adapter targets the older `cortex.Tool` interface and
  is not registered.
- **SwypikOS** owns capability authority and host/device effect execution. Swyp
  Core IR carries only logical requirements; opaque capability references live
  on the host side of Tool ABI v1. See [effects and capabilities](EFFECTS_CAPABILITIES.md).

See [ROADMAP](ROADMAP.md) for the order of work.
