# Contract-guided synthesis — experimental M1b

Implemented and locally validated on Windows on 28 September 2026. This adds an
opt-in `synth -contract` path to the Semantic Core. Legacy `synth` and its JSON
schema remain unchanged. This milestone is bounded relational synthesis, not
an LLM, an SMT solver, a universal correctness proof or native code generation.

## Run the actual implementation

The separate session build is `bin/swyp-contract-synth-20260928.exe`.
`bin/swyp.exe` was not replaced. Building a new copy is a developer step:

```powershell
Set-Location 'D:\swyp lang'
go build -o bin/swyp-contract.exe ./cmd/swyp
$swyp = '.\bin\swyp-contract.exe'
& $swyp synth -contract examples/swyp/contracts/square.i64.json -o bin/square-generated.swyp examples/swyp/synthesis-contract-square.json
& $swyp core-run -entry square bin/square-generated.swyp 12
& $swyp verify -contract examples/swyp/contracts/square.i64.json bin/square-generated.swyp
```

Output paths must be NEW. All flags precede the spec filename. The generated
program runs in the core pipeline, not the legacy float64 interpreter:

```text
fn square(x: i64) -> i64 {
    return (x * x);
}
fn main() {}
```

The example starts from only `0 -> 0` and `1 -> 1`. Its first proposal is `x`.
Verification finds the input `-100`, where that proposal violates the square
contract. The next search returns `(x * x)`. The saved trace records two rounds,
57 candidates, one added input, 249 search evaluation units, 207 total cases
and 618 core instructions. The final proposal is checked on all 201 integers
in `[-100,100]`; counts for that final verification alone are 201 cases and 603
instructions. `core-run ... 12` returns exact i64 `144`.

Legacy synthesis with just those two examples still returns `x`, and its result
at 12 remains 12. Both programs fit the initial examples. The contract supplies
additional information; this comparison does not claim a speedup or that the
legacy engine is wrong to satisfy its stated, weaker specification.

## Relational constraints, not invented expected outputs

`examples/swyp/contracts/above.i64.json` specifies `x < result <= x + 2` on
`[-20,20]`. There are two valid integer outputs per input, and no exact-output
oracle is provided. This works with an empty example set:

```powershell
& $swyp synth -contract examples/swyp/contracts/above.i64.json -o bin/above-generated.swyp examples/swyp/synthesis-contract-empty.json
& $swyp core-run -entry above bin/above-generated.swyp 7
```

The observed candidate is `x + 1`, producing 8. A counterexample adds an INPUT
on which future candidates must satisfy all the original postconditions. It
does not invent a required output from a general relation. The contract is a
validated private snapshot; candidates do not receive a mutable evaluator.

Exact values above binary64's consecutive-integer range are also supported:

```powershell
& $swyp synth -contract examples/swyp/contracts/next-exact.i64.json -o bin/next-generated.swyp examples/swyp/synthesis-contract-empty.json
& $swyp core-run -entry next bin/next-generated.swyp 9007199254740993
```

The observed result is `9007199254740994`, not a rounded floating-point value.

## Spec and numeric semantics

Contract synthesis uses a separate version-1 spec:

```json
{
  "version": 1,
  "examples": [{"x": "0", "y": "0"}, {"x": "1", "y": "1"}],
  "constants": ["-1", "0", "1", "2"],
  "max_nodes": 7,
  "max_candidates": 20000,
  "max_evaluations": 1000000
}
```

Examples and constants are optional. Numeric values MUST be strings. They are
parsed directly into the contract input type, never through JSON float64 first.
Missing/null fields, numeric JSON example values, duplicate keys (including
case aliases), unknown fields and trailing data are rejected. The input and
output types are the same: either checked `i64` or finite `f64`.

The grammar consists of the input variable, constants and binary `+`, `-`, `*`.
Enumeration proceeds by expression-tree size with typed output-vector
deduplication. Signed constants count as one grammar terminal; this count is
not the number of source parser AST nodes. Floating signed zero is preserved
in vectors. Integer overflow and non-finite floating intermediates invalidate
the candidate; a later operation cannot hide an earlier trap. Emitted constants
round-trip even at minimum i64, maximum finite f64 and minimum f64 subnormal.

At most 64 initial/distinct training points and 16 constants are accepted.
Initial examples must be in the declared domain, satisfy preconditions and
agree with postconditions. Contradictory examples are rejected before searching.
The current integration supports exactly one numeric input, one same-type result
and an ASCII source identifier for an entry other than `main`. The core verifier
still supports broader contracts separately; this synthesis grammar does not.

## Acceptance and evidence

Default publication requires `exhaustive`: all tuples in a finite integer domain
were enumerated. This is an execution-based finite-domain check, NOT a symbolic
proof over all i64 values. For f64 or larger domains, the verifier produces
boundary/seeded sampling evidence, labeled `tested`.

Publishing a sampled candidate requires explicit `-allow-sampled`. Without
that option, a sampled result returns `unknown` with `exhaustive_required`, exits
nonzero and creates no source file. Empty admissible domains, predicate errors,
resource exhaustion, cancellation and timeout also never create a candidate.
A reduced remaining global case budget cannot silently downgrade the requested
sample count and still accept the candidate.

The same deterministic sampling seed is used across refinement rounds. A
sampled candidate may therefore fit that finite sampled set without satisfying
unseen inputs. Increasing sample size is not a proof. Predicate arithmetic is
checked core arithmetic, not unbounded mathematical integer arithmetic. A
predicate that traps is reported as an evaluation problem, not certified false
or true. Search exhaustion is not a proof that no program exists.

Before full verification, emitted source is reparsed, lowered, prepared and
executed on all accumulated inputs. Its results must match search vectors,
including signed zero, and satisfy the original constraints. Source is exposed
as a final result only after acceptance. This checks the connection between the
search engine and executable source, not merely an in-memory candidate string.

CLI JSON includes the proposal history, witnesses, consumed budgets, exact
source hash, contract/spec byte hashes and per-proposal IR hashes. IR source
locations use the output path; consequently IR hashes depend on that path.
The final source hash matches the actual published bytes. API contract/spec
hashes use JSON serialization; CLI hashes use the exact input file bytes.
`rounds` counts searches attempted; history contains proposals that reached
whole-domain verification, so a failed search/training run need not add a history
entry. No cryptographic authentication or unforgeable proof certificate is claimed.

## Shared limits

| Limit | Default | Maximum |
|---|---:|---:|
| Candidate attempts, all rounds | 20,000 | 100,000 |
| Search evaluation units, all rounds | 1,000,000 | 10,000,000 |
| Grammar nodes | 7 | 9 |
| Retained output-vector representatives per search | 8,192 | 8,192 |
| `-rounds` | 16 | 32 |
| `-cases`, per proposal | 256 | 10,000 |
| `-total-cases`, all rounds | 10,000 | 10,000 |
| `-steps`, per core execution | 100,000 | 1,000,000 |
| `-total-steps`, all rounds | 10,000,000 | 10,000,000 |
| `-timeout` | 5 seconds | 60 seconds |

Per-case fuel is additionally capped by the contract's `max_steps`. Total cases
include compiled training runs and verifier cases examined, including skipped
precondition cases. Total core instructions include training and verification
execution. One search evaluation unit is one candidate value at one input or
one full point-constraint check; each contract is separately bounded to 256
predicate nodes. These units are not CPU time or core instructions. Validation
of initial data is bounded separately and does not count as search evaluation.

The deadline begins after the CLI's bounded file reads/JSON decoding and applies
to the synthesis operation. Each input file is limited to 64 KiB. File reading
is not a timeout guarantee for special devices. Limits do not constitute an OS
security sandbox, process memory quota or certification. No guest host/file/
network/model operations are introduced by this grammar.

## File publication and compatibility

Publication uses exclusive creation, refuses existing files/symlinks, and cleans
up new partial output on normal write/close failure. It is not crash-atomic.
If stdout fails after successful publication, the command reports an error but
keeps the valid source file. Concurrent writers cannot overwrite each other.

Legacy `synth`, `validation`, `worker`/Nexus behavior, `number` semantics, C/JS
backends, STV2 and SWYPB are unchanged. There is no new native backend, external
solver, model installation, package dependency or background service.

## Validation performed in this session

Raw records are under `docs/research/20260928-contract-synth/` (archived outside the repository under `D:/swyp-lang-archive-20260928/docs/research/`):

- Baseline: 132 top-level test functions passed in eight tested packages.
- Final full suite: 152 top-level test functions passed, zero failures; twenty
  new test functions plus a fuzz target. Parametrized subtests are additional.
- An existing SWYPB symlink test was skipped because the Windows process lacked
  symlink privileges. This is not counted as a passed test.
- `go vet ./...` and `go build ./...` succeeded.
- Race detector succeeded on coreir, synthesis, swyplang, cmd/swyp and ternaryvm.
- `FuzzContractSynthesis`: 229,952 executions with two workers, no failure.
- Forty-nine affine functions were synthesized and each checked against a
  separate, bounded native-integer oracle on 61 inputs: 2,989 comparisons. This
  is a parametrized family, not forty-nine independent algorithms.
- Sixteen final executable smoke scenarios passed, including runtime PATH with
  no toolchains, generated IR execution after deleting only its temporary source
  copy, exact i64, sampled-result opt-in and resource rejection without output.
- SWYPB compatibility smoke: sum(100) remains 5050 and the module remains 146 bytes.

The first smoke harness incorrectly expected JSON from the unchanged SWYPB
`compile` command, which prints text. Raw first-attempt outputs are preserved;
`smoke-final/smoke-summary.json` is the successful corrected run. The reusable
`smoke_check.py` records stdout, stderr, exit codes and a partial report on failure.
Use a NEW `--output-dir` to rerun it without replacing previous evidence.

An Antigravity agent launch returned only the static provider acknowledgment,
not an independent audit. Implementation and validation were executed directly
through Antigravity. LSP calls still fail because the VS Code bridge is not
available on port 3005. No remote CI, Linux execution or independent model audit
is claimed. All changes are local, without commit or push.

Remaining synthesis work includes multiple inputs, a conditional grammar,
boolean results, solver-assisted checks and independent holdout strategies for
sampled acceptance. Core native lowering remains a separate milestone.
