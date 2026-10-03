# Non-LLM synthesis research — reviewed findings

Reviewed by Codex after the Antigravity research run. Unsupported numerical
claims and universal correctness claims from the draft were removed.

## What can be built

A generator can enumerate a restricted grammar without any neural model.
Examples filter candidates; a formal specification and suitable verifier can
provide stronger evidence. These are different levels of assurance.

The [SyGuS specification](https://sygus-org.github.io/language/) explicitly
separates allowed syntax from semantic constraints. Its max2 example uses both
a grammar and logical constraints; grammar compliance alone is insufficient.
Our current engine is inspired by bounded enumerative synthesis, but is not a
SyGuS solver or an implementation of the SyGuS input standard.

[Equality saturation with egg](https://arxiv.org/abs/2004.03082) is a possible
future optimizer: it represents and explores rewrites without immediately
committing to one expression. Swyp does not currently implement it. Rewrite
rules must preserve this language's float64 arithmetic, exceptional behavior,
evaluation order, and any observable resource-limit behavior.

[Z3's documented tactics](https://microsoft.github.io/z3guide/docs/strategies/summary/)
have differing proof support, parameters and resource bounds. We cannot infer
that an arbitrary lifetime property can always be proved. A timeout or unknown
result must never authorize unsafe memory reclamation. No SMT solver is currently
integrated into Swyp.

[MLIR](https://mlir.llvm.org/docs/LangRef/) supplies an intermediate representation
framework; adopting it would require actual lowering and target work. It does
not turn a grammatical expression into a proof of its intended behavior. Swyp
currently emits C11 and invokes GCC, or emits JavaScript for its web target.

## Corrections to the proposed Omni design

- An SLM is a language model. Embedding one contradicts the requested model-free
  runtime and synthesis engine. Development agents can use models without making
  the resulting compiler depend on them.
- A finite automaton does not recognize arbitrary unbounded recursive nesting.
  Recursive grammar constraints require suitable parser state; bounded subsets
  are a separate case. Parsing, type checking and semantic verification differ.
- Neural lifetime guesses are proposals, not proofs. Static ownership/regions or
  conservative analysis are possible approaches; reference counting has costs
  and cycle-handling requirements. No universal zero-cost guarantee follows.
- Prioritizing symbolic paths is useful for finding bugs, but skipping unproved
  paths does not prove their safety. Exhausting a search budget means unknown.
- A fixed UI layout depends on its inputs. Window dimensions, text, font metrics
  and zoom can change. The toy layout experiment motivates selective precomputation
  plus recomputation, not a universal performance claim.

## What this project now implements

`internal/synthesis` searches expressions built from x, finite constants and
+, -, *. It evaluates vectors of examples, discards non-finite candidates,
retains representatives of observed output vectors, and enforces node/candidate
limits and context cancellation. CLI `swyp synth` saves a new type-checked file.
No network call, model weights or inference library is used by this path.

The initial grammar is deliberately small. It cannot synthesize endpoints,
concurrency, memory managers, shaders or its own compiler from a sentence.
Observational equivalence is scoped to the supplied examples, not a global
program equivalence claim. Comparisons use float64 ==, treating signed zeros as
equal. More examples or changed constraints require a new search.

Independent held-out tests are recorded in NON_LLM_EVALUATION.json. They support
these concrete examples only. The generated expression x+(x+1), for example,
need not equal 2*x+1 on every float64 input because rounding can differ.

## Next bounded stages

1. Explicit contracts and counterexamples for a finite domain, with a result that
   states exactly which domain was checked.
2. Typed holes inside larger programs, using this engine for small pure regions.
3. An optional SMT verifier whose unknown/timeouts preserve rejection or review.
4. More operators and integer types, each with regression and cost measurements.
5. Memory, concurrency and native UI only after their semantics and tests exist.
