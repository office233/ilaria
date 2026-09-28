# Swyp roadmap

Distilled from [the 2026-09-28 research campaign](history/AI_LANGUAGE_RESEARCH_20260928.md).
Correctness is mandatory; speed, size and ergonomics are compared only among
correct variants.

## Done

- Scalar language with interpreter, C and JS backends.
- STV2 VM and SWYPB modules for a safe-integer subset (fuzzed, differential-tested).
- **M1a** Semantic Core: typed `i64`/`f64`, JSON IR, verifier, fuel-bounded executor.
- **M1b (partial)** Contracts with `exhaustive`/`tested`/`counterexample`/`unknown`/`timeout`
  and contract-guided synthesis.

## Next

1. **Closed loop with Ilaria (Nexus).** Register a Swyp `ChatTool` so the model
   can propose a program plus contract and receive a verification report or a
   counterexample to repair. Verified pairs feed Nexus fine-tuning data.
2. **SwypikOS tool.** An approval-gated `swyp.verify` / `swyp.exec` agent tool
   running SWYPB modules on the STV2 VM.
3. **Semantic Core as the single front end.** Lower Core IR to STV2 and to C so
   the legacy float-only path can be retired.
4. **M2 – registers and memory.** Liveness, real register allocation, spilling;
   arrays/slices and structs with explicit aliasing rules.
5. **M3 – richer synthesis.** Comparisons and conditionals in the grammar,
   symbolic verification on a subset, held-out evaluation.
6. **Effects and capabilities.** Pure functions separated from filesystem,
   network, clock and model effects; generated code gets only declared
   capabilities.
7. **M4 – tensors and apps.** Shape/dtype-explicit tensor ops through an
   established backend; modules/packages; C/Python interop.

## Rules for claims

- `tested` is sampling, `exhaustive` is finite-domain execution; neither is an
  SMT proof.
- A delegated agent's "done" is not evidence; only reproduced commands, exit
  codes and hashes are.
