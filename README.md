# Swyp Lang

Swyp is an experimental language for **verified, AI-proposed programs**: a
generator (search today, a model tomorrow) proposes code, and the compiler and
contract verifier decide whether it is accepted. Nothing at run time depends on
a model.

```
intent → contract → candidate → verification → pinned source → deterministic build
```

## Quick start

```powershell
Set-Location 'D:\swyp lang'
go test ./...
go build -o bin/swyp.exe ./cmd/swyp        # or: scripts\build-local.ps1, then swyp.cmd

.\bin\swyp.exe run examples/swyp/hello.swyp
.\bin\swyp.exe verify -contract examples/swyp/contracts/square.i64.json examples/swyp/semantic-core.swyp
.\bin\swyp.exe synth -contract examples/swyp/contracts/square.i64.json -o bin/square.swyp examples/swyp/synthesis-contract-square.json
.\bin\swyp.exe compile --target stv2 -o bin/sum.swypb examples/swyp/sum.stv2.swyp
.\bin\swyp.exe exec bin/sum.swypb 100      # {"value":5050,...}
```

Output files must not already exist; Swyp never overwrites.

## What works today

| Area | Status | Docs |
|---|---|---|
| Scalar language: functions, `let`, `if`/`while`, `number`/`bool`/`string` | Tested; AST interpreter, C (GCC) and offline HTML/JS backends | [SWYP_LANG](docs/SWYP_LANG.md) |
| Semantic Core: checked `i64`, finite `f64`, typed JSON IR, fuel-bounded executor | Tested (M1a) | [SEMANTIC_CORE](docs/SEMANTIC_CORE.md) |
| Contracts: `verify` → `exhaustive` / `tested` / `counterexample` / `unknown` / `timeout` | Tested on finite domains; no SMT proofs | [SEMANTIC_CORE](docs/SEMANTIC_CORE.md) |
| Synthesis: enumerative search with counterexample refinement (`synth`, `synth -contract`) | Tested; grammar is `x`, constants, `+ - *` | [CONTRACT_SYNTHESIS](docs/CONTRACT_SYNTHESIS.md) |
| STV2 VM + SWYPB modules: compile once, run without source or toolchain | Tested, fuzzed; safe-integer subset only | [STV2_ISA](docs/STV2_ISA.md), [SWYPB_FORMAT](docs/SWYPB_FORMAT.md) |
| Nexus/Ilaria worker (`swyp worker`, `bridge/nexus`) | Adapter tested, **not registered** in Nexus | [bridge/nexus](bridge/nexus/README.md) |
| Natural-language `draft` / `expand` / `repair` via Ilaria | Fixture-tested only; never run against a live model | [SWYP_LANG](docs/SWYP_LANG.md) |

Direction and milestones: [ROADMAP](docs/ROADMAP.md). How the pieces fit:
[ARCHITECTURE](docs/ARCHITECTURE.md). Local build and validation:
[DEVELOPMENT](docs/DEVELOPMENT.md). Earlier reports and measurements live in
[docs/history](docs/history).

## Layout

```
cmd/swyp          CLI (run, check, build, web, ir, core-run, verify, synth, compile, exec, worker, ...)
cmd/swyp-stv2     standalone STV2 assembler/runner
internal/swyplang parser, checker, interpreter, C/JS emitters, STV2 lowering, SWYPB container
internal/coreir   Semantic Core IR, verifier, executor, contracts
internal/synthesis enumerative and contract-guided synthesis
internal/stv2     STV2 ternary-encoded ISA and bounded VM
internal/ilaria   optional client for the local Ilaria (Nexus) model service
bridge/nexus      Nexus tool adapter around `swyp worker`
benchmarks/swyp   cross-language reference programs and evaluation scripts
examples/swyp     sample programs, contracts and synthesis specs
```

Swyp builds independently of SwypikOS and Nexus. Raw evidence from the
2026-09-27/28 campaigns, old binaries and the ChatGPT MCP bridge were moved out
of the repository to `D:\swyp-lang-archive-20260928`.
