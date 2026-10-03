# Non-LLM architecture review — integration decision

This replaces the agent's unverified draft. The agent saved its initial document
but its session ended after an Antigravity command-permission denial.

## Implemented path

JSON examples -> bounded arithmetic search -> Swyp source -> parser/type checker
-> new output file. The developer can then run or compile that file explicitly.
Independent evaluation checks both the interpreter and native output.

The generator uses no LLM. Existing optional `draft`, `expand`, and `repair`
commands still use the legacy Ilaria adapter or explicit replay fixtures; they
are separate from `synth`. This change does not silently remove them.

The synthesis engine caps examples at 64, constants at 16, nodes at 9 and
candidates at 100000. Defaults are 7 nodes and 20000 candidates. Every attempted
candidate counts, including invalid and duplicate vectors. The CLI adds a
5-second default deadline (maximum 60 seconds) and a bounded 64-KiB JSON reader.

## Assurance boundaries

- A parsed, type-checked candidate may still overflow on unseen inputs.
- Matching examples does not establish intended behavior for all inputs.
- Candidate-limit exhaustion is not proof that no implementation exists.
- Pruning by example outputs must not be advertised as universal equivalence.
- Stored results are proposals; there is no propagation or hidden source editing.
- Candidate generation runs only the small arithmetic evaluator, not arbitrary
  generated shell commands or external processes.

## Findings acted on during integration

Codex removed an unused test import and replaced the CLI's unbounded ReadFile
with a bounded reader. All package tests and the generated-code differential
checks were then run independently.

The experimental repair agent returned partial work before an API error. Its
prototype exceeded its candidate budget and mislabeled empirical matches as
semantic equivalence. It remains a rejected experiment, not an integrated
self-healing facility; see EXPERIMENT_REPAIR.md.

A future verifier must model float64 rounding and exceptional behavior explicitly.
An eventual memory system needs specified aliasing, ownership and concurrency
rules before any lifetime proof can be meaningful. Neither module exists today.
