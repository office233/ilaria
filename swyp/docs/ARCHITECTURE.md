# Swyp architecture

## Principle

A generator proposes; the compiler and verifier dispose. Every accepted program
carries its evidence (source hash, IR hash, contract hash, verification status).
Execution is deterministic and never calls a model.

## Pipelines

```
                        ┌─ run          AST interpreter (step + call-depth budgets)
.swyp ── Parse ── Check ┼─ build/emit-c C source → GCC native executable
  (legacy scalar)       ├─ web          offline HTML/JS runner
                        └─ compile      safe-integer subset → STV2 → .swypb ── exec

.swyp ── ParseCore ── lower ── coreir JSON ─┬─ core-run / core-exec  (pure, fuel-bounded)
  (Semantic Core:                           └─ verify -contract → status + counterexample
   i64, f64, pure calls)

coreir JSON effect metadata ── validate/prepare ── effectful profile ──X─ Core executor
                                                        │
                                                        └─ EffectRequest v1 → SwypikOS Capability Broker

spec/contract ── synthesis search ── candidate .swyp ── verify ── accept / refine
```

- **Legacy scalar language** (`internal/swyplang/swyp.go`, `check.go`): `number` is
  float64; used by the interpreter, C and JS backends.
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
| coreir JSON v1 | `swyp ir` | `core-exec`, external tools |
| Contract JSON v1 | hand-written / generator | `verify`, `synth -contract` |
| Verify report JSON | `swyp verify` | agents (status, counterexample, hashes) |
| EffectRequest / EffectResult v1 | future Swyp effect runtime / SwypikOS broker | SwypikOS capability broker / future resumable Swyp runtime |
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
