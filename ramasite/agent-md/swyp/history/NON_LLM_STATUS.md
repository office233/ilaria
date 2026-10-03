# Swyp 0.4: bounded synthesis without a language model

Historical 0.4 report. The [0.5 campaign report](CAMPAIGN_100_AGENTS.md) covers the
subsequent 100 test agents, counterexample refinement, operation graph and Nexus adapter.

## Delivered

`swyp synth -o new.swyp spec.json` finds a scalar arithmetic expression from
numeric examples. It searches x, finite constants, +, - and * in increasing
grammar node count. It generates source, parses/type-checks it and writes a new
file without overwriting existing work. No model, HTTP service or inference
library is used by this operation. Existing optional Ilaria commands remain
separate. The compiler itself is still implemented in Go.

```json
{
  "examples": [{"x": -3, "y": -5}, {"x": 0, "y": 1}, {"x": 4, "y": 9}],
  "constants": [-1, 0, 1, 2],
  "max_nodes": 7,
  "max_candidates": 20000
}
```

For the evaluated linear task, the generated function was:

```text
fn predict(x: number) -> number { return (x + (x + 1)); }
fn main(){print(predict(arg(0)));}
```

This is real expression synthesis, not general natural-language understanding,
self-replication, a universal optimizer or a compiler that rewrites itself.

## Independently verified

After integration, `go test ./...` passed. Codex corrected an unused test import
and bounded the CLI's input read before acceptance.

`python benchmarks/swyp/synthesis_eval.py` synthesized identity, linear and
square functions. Each was checked on 60 held-out quarter-step inputs in [-8,8]
using the interpreter and native C/GCC target: **360 comparisons passed**.
Search candidates were respectively **1, 83 and 56**. The generated source,
hashes and raw diagnostic CLI wall times are in [NON_LLM_EVALUATION.json](NON_LLM_EVALUATION.json).
Those times include startup and concurrent agent activity; they are not a speed
comparison or an optimizer benchmark.

`go run ./experiments/grammar`, `memory`, `layout`, and `repair` were run
independently. [Raw output](NON_LLM_EXPERIMENT_RUNS.txt) is retained. These are
separate toy experiments, not integrated compiler features. In particular,
the [repair experiment was rejected](EXPERIMENT_REPAIR.md) despite its own tests
printing success: review found incorrect guarantees and budget accounting.

## Antigravity delegation provenance

Ten scoped agents were launched through the installed
[Antigravity skill](C:/Users/Pos5/.codex/skills/antigravity/SKILL.md), CLI 1.2.12.
The first five used `--tier flash`, which resolved to Gemini 3.8 Flash (High).
The next five used explicit `--model gemini-3.8-flash-high`.

| Agent | Outcome | Reviewed artifact |
|---|---|---|
| Synthesis engine | Completed; accepted after tests | internal/synthesis/synthesis.go |
| Independent tests | Completed; unused import fixed during integration | internal/synthesis/synthesis_test.go |
| CLI and example | Completed; bounded reader added during integration | cmd/swyp/synth.go, synth_test.go |
| Research | Completed; overclaims removed and primary sources checked | NON_LLM_SYNTHESIS_RESEARCH.md |
| Architecture | Partial document; command permission denied | NON_LLM_ARCHITECTURE_REVIEW.md, rewritten after review |
| Grammar | Partial files; provider API 500 | experiments/grammar; independently run |
| Memory | Completed | experiments/memory; independently run |
| Repair | Partial files; provider API 500; rejected on review | EXPERIMENT_REPAIR.md |
| UI/layout | Completed; broad performance/compliance claims removed | experiments/layout; independently run |
| Performance audit | Completed | EXPERIMENT_PERFORMANCE.md |

With the user's permission, a project-specific `write_file(D:/swyp lang)` rule
was added to Antigravity settings. Existing Go command permissions and deny
rules were preserved, settings were backed up, and no permission bypass flag
was used. No further agents were launched after these ten.

## Limits and next step

Matching examples is not a proof over all float64 inputs. Even x+(x+1) and
2*x+1 can differ through rounding. Limits are 64 examples, 16 constants, 9 nodes,
100000 attempted candidates and a CLI deadline up to 60 seconds. Budget
exhaustion reports failure to find a candidate within that search, not
mathematical impossibility. No SMT/MLIR/GPU/ownership system was added.

The next useful step is typed holes with explicit finite-domain contracts and
counterexamples, building on this tested engine. The [reviewed research](NON_LLM_SYNTHESIS_RESEARCH.md)
separates that plan from delivered capabilities.
