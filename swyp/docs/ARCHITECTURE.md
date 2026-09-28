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

.swyp ── ParseCore ── lower ── coreir JSON ─┬─ core-run / core-exec  (fuel-bounded)
  (Semantic Core:                           └─ verify -contract → status + counterexample
   i64, f64, pure calls)

spec/contract ── synthesis search ── candidate .swyp ── verify ── accept / refine
```

- **Legacy scalar language** (`internal/swyplang/swyp.go`, `check.go`): `number` is
  float64; used by the interpreter, C and JS backends.
- **Semantic Core** (`core_lower.go`, `internal/coreir`): explicit `i64`/`f64`
  types, a mutable-slot CFG IR with a verifier, loader limits (1 MiB, 64
  functions, unknown fields rejected). This is the base for new work.
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
| Worker JSON (stdin/stdout) | `swyp worker` | `bridge/nexus`, Nexus forge checks |
| SWYPB binary | `swyp compile` | `swyp exec`, any host embedding `internal/stv2` |

## Integration with Nexus and SwypikOS

- **Nexus (Ilaria)** already uses the Swyp compiler to check generated programs
  during training (`D:\nexus\forge\colab\build_project_v6.py`). At run time the
  natural hook is Nexus's `ChatTool` interface (`cortex/toolloop.go`); the
  current `bridge/nexus` adapter targets the older `cortex.Tool` interface and
  is not registered.
- **SwypikOS** runs an approval-gated agent (`core/agent/runtime.go`). A Swyp
  tool (`verify` / `exec` of a SWYPB module) fits that `Tool` shape and would
  give SwypikOS a sandboxed, fuel-bounded scripting layer.

See [ROADMAP](ROADMAP.md) for the order of work.
