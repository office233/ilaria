# Semantic Core and Contract IR - experimental M1a

Implemented and locally validated on 28 September 2026. This is an opt-in,
end-to-end slice of the proposed Semantic Core milestone, not a claim that every
backend has been migrated or that Swyp programs are generally formally verified.

## 1. Use the new pipeline

The session build is `bin/swyp-semantic-core-20260928.exe`. It is separate from
`bin/swyp.exe`; the existing executable was not replaced. To build another copy:

```powershell
Set-Location 'D:\nexus\swyp'
go build -o bin/swyp-core.exe ./cmd/swyp
.\bin\swyp-core.exe core-run -entry next examples/swyp/semantic-core.swyp 9007199254740993
.\bin\swyp-core.exe core-run -entry sum_to examples/swyp/semantic-core.swyp 100
.\bin\swyp-core.exe core-run -entry half examples/swyp/semantic-core.swyp 5
.\bin\swyp-core.exe verify -contract examples/swyp/contracts/square.i64.json examples/swyp/semantic-core.swyp
```

The results are exact `i64` 9007199254740994, `i64` 5050, `f64` 2.5 and
`exhaustive` verification of 201 integer inputs, respectively. Typed values in
JSON use text: `{"type":"i64","value":"9007199254740994"}`. Consumers must not
convert this string to an IEEE binary64 number when exact integer values matter.

```powershell
.\bin\swyp-core.exe ir -entry next -o bin/next.core.json examples/swyp/semantic-core.swyp
.\bin\swyp-core.exe core-exec -entry next bin/next.core.json 9007199254740993
```

The IR output path must be new. `core-exec` needs only the executable and the
JSON IR, not the original source, a toolchain or an AI service. `ir` without `-o`
writes JSON to stdout. All flags precede the input filename. The default entry
is `main`; `verify` takes its entry from the contract. The source parser still
requires a zero-parameter `main`, even when selecting another function.

## 2. Numeric and source semantics

```text
fn next(x: i64) -> i64 {
    return x + 1;
}
fn sum_to(n: i64) -> i64 {
    let total: i64 = 0;
    let i: i64 = 1;
    while i <= n {
        total = total + i;
        i = i + 1;
    }
    return total;
}
fn half(x: f64) -> f64 {
    return x / 2;
}
fn half_ieee(x: ieee64) -> ieee64 {
    return x / 2;
}
fn main() {}
```

`i64` covers -9223372036854775808 through 9223372036854775807. Addition,
subtraction, multiplication, division and negation trap on overflow rather than
wrapping or converting to floating point. Division truncates toward zero;
remainder follows the dividend's sign. Both reject a zero divisor. The special
case minimum-i64 divided by -1 overflows, while its remainder is zero. Decimal
integer literals and CLI values are parsed without a float64 intermediate;
original source token text is preserved by the parser.

`f64` is finite binary64 and `number` remains an alias for that behavior in the
core pipeline. Fractional division, ordinary rounding and signed zero remain.
NaN, infinity, non-finite arithmetic results and zero divisors are rejected.
Each floating operation has an explicit rounding boundary; no reassociation or
fused multiply-add optimization is introduced.

`ieee64` is the explicit compute-oriented IEEE-754 binary64 type. It permits
NaN and infinities, follows hardware comparison semantics (all ordered
comparisons with NaN are false), and floating zero divisors produce the IEEE
result rather than a Swyp trap. It is emitted as ordinary C `double` arithmetic
without `-ffast-math`; `-ffp-contract=off` remains enabled. Use it only when
the algorithm is designed for IEEE non-finite behavior. Contract input ranges
for `ieee64` must still have finite endpoints so deterministic sampling remains
well-defined.

Function parameters require annotations. Numeric literals use an expected
numeric type when available, otherwise f64. A local `let i = 0` is therefore f64;
use `let i: i64 = 0` for an integer loop. Local types do not change on assignment.
Unannotated non-void function results default to f64; annotate i64/bool results.
There are no numeric casts or implicit mixed `i64`/`f64`/`ieee64`
arithmetic conversions in
v1. Arithmetic and ordering require matching numeric types. Cross-type scalar
equality compares unequal, matching the existing heterogeneous scalar policy.

The first memory-ABI foundation is the opaque Core type `bytes`. A `bytes`
value is one 64-bit descriptor, not a native pointer: high 32 bits are an arena
offset and low 32 bits are a length. `offset + length` may not wrap the 32-bit
arena address space. The guest cannot create `bytes` with a literal or arithmetic
operation, and there is no dereference opcode yet. It can only transport an
already-authorized descriptor through parameters, `move`, calls and returns.
`Run`, `RunFast` and `RunTurbo` preserve the descriptor identically. Direct
native backends reject any `bytes` signature/slot until an explicit native byte
arena and data-section contract exists, preventing an opaque descriptor from
silently becoming a raw host address.

Supported: booleans, typed parameters and locals, lexical shadowing, mutation,
if/else, while, early return, pure function calls and bounded recursion. Logical
`&&` and `||` are compiled into branches, so their right sides remain lazy.

Core source supports explicit process effects for `print`, `eprint` and `clock`;
the normal Core executor still refuses host effects and requires the standalone
process backend/capability boundary. Pure programs remain unchanged. See
[EFFECTS_CAPABILITIES](EFFECTS_CAPABILITIES.md).

`Program.CoreIR(entry)` selects that function and its transitive callees.
Unrelated functions are not included or claimed as checked by this operation.
Every statement in the selected functions is checked, including dead statements
after return. Arbitrary strings, filesystem/network/process services and other
unsupported host calls remain rejected. `print`, `eprint` and `clock` lower to
explicit capability-gated effects. This still allows a pure helper to be selected
from a file whose unrelated functions contain process effects.

`ParseCore` is explicitly separate from `Parse`. Existing `run`, `check`,
`build`, `web`, `synth`, STV2 and SWYPB behavior is unchanged. The legacy checker,
interpreter and emitters reject a core-mode Program rather than silently treating
an i64 program as float64. Core source can run through `core-run`, export JSON IR,
or compile AOT:

```powershell
swyp core-build -entry sum_to -profile fast -cpu portable -o sum.exe program.swyp
```

`safe` AOT preserves Core's function/instruction/terminator fuel boundaries.
`fast` keeps execution bounded but charges fuel only at loop backedges and
recursive call cycles. Both preserve each type's declared semantics: checked
`i64`, strict finite `f64`, and hardware-style `ieee64`. `-cpu native`
additionally asks GCC to tune for the current CPU; portable remains the default.

## 3. IR and execution model

`internal/coreir` has no dependency on the source parser. The version-1 JSON
module contains named functions, typed parameter and local slots, basic blocks,
ordered instructions and explicit terminators. Optional function metadata uses
Effect ABI v1 (`effect_version`, `effects`, `required_capabilities`) with a closed
effect registry and canonical ordering. This is a **mutable-slot CFG IR, not
SSA**. It does not yet perform liveness analysis or a Swyp-owned register
allocator. Native AOT delegates those low-level optimizations to the host C
compiler after Core validation. Short-circuiting and control flow are explicit.

Instructions include constants, moves, pure calls, typed arithmetic, comparison
and boolean negation. Source locations and checked `may_trap` annotations are
preserved. The annotation concerns operation-level traps; the host fuel/deadline
can interrupt any execution independently.

The verifier checks names, call signatures, scalar/result types, opcode arity,
instruction payloads, branch/return operands, destinations and CFG edges. It
rejects edges back into function entry. Definite-initialization analysis uses
intersection over reachable predecessors; a write on only one branch cannot
initialize a value for the other branch. Unreachable blocks are still checked
structurally and for operand types, but are not subject to reachable-path
initialization requirements.

Effect validation is fail-closed: unknown/duplicate/noncanonical effects,
malformed or duplicate capability requirements, capability requirements for
undeclared effects, and missing call-graph propagation are rejected. Strict JSON
also rejects guest attempts to add capability tokens or `capability_refs` to IR.

Bounds: version exactly 1; JSON at most 1 MiB; 64 functions; 256 blocks and 512
slots per function; 16 parameters; at most 8,192 instructions plus terminators
across the module. The loader rejects unknown fields, duplicate JSON keys
(including casing aliases), nulls, trailing data and nesting beyond 128.

`Prepare` validates and owns a private snapshot, including parsed constants.
Changing the original Module does not alter the executable. Runs have separate
slots, call stacks and budgets and can run concurrently. Call depth is capped
at 128. The host supplies 1..1,000,000 fuel units; each function entry,
instruction and terminator consumes one. AST and STV2 fuel counts are different
accounting systems, not interchangeable performance measurements. Context
cancellation and deadlines are checked at every tick.

Prepared functions expose a `pure` or `effectful` semantics profile. `Run`
rejects effectful entries with `effectful_program` before guest execution. Core
does not resolve capabilities and does not execute host effects.

There are no guest filesystem/network/process/model/tool effect opcodes. Effect
metadata is a declaration, not authority. This restricted runtime is not
advertised as an OS security sandbox, a memory quota or a certification.
JSON file reads are size-bounded, not guaranteed to time out on special devices.
CLI execution deadlines begin after reading, lowering and preparing input.

## 4. Contracts and verification evidence

Contracts are separate JSON, not natural-language instructions or executable
host code. See `examples/swyp/contracts/square.i64.json`:

```json
{
  "version": 1,
  "entry": "square",
  "inputs": [{"name":"x","type":"i64","min":"-100","max":"100"}],
  "ensures": [{"op":"eq","args":[
    {"var":"result"},
    {"op":"mul","args":[{"var":"x"},{"var":"x"}]}
  ]}],
  "max_steps": 100
}
```

Inputs must match parameter names, order and numeric types. Intervals are
inclusive. Predicates contain exactly one of `var`, typed `const`, or `op` with
arguments. The standard core arithmetic/comparison operations are available,
plus lazy `and`/`or` and `not`. No free-form predicate evaluation is used.

`requires` filters admissible tuples and cannot reference `result`. `ensures`
must contain at least one boolean predicate and may reference `result`. Input
name `result` is reserved. Pure contracts omit effect metadata. Effectful
contracts use `effect_version: 1` plus the exact canonical effect set of the
executable entry. `Verify` reports such a program as `effectful` and returns
`unknown` / `effectful_execution_not_supported` without executing a case.
Numeric predicates themselves use checked i64/finite-f64 operations, not
unbounded mathematical integers. A predicate overflow or zero division is
reported as an evaluation problem, not silently treated as false or proved
correct.

Limits: contract files at most 64 KiB through the CLI; at most four numeric
inputs, sixteen preconditions and sixteen postconditions, 256 predicate nodes
in total and depth 32. `max_steps` limits this verifier's per-case execution;
it is not an independently proved complexity bound.

Verification options: `-cases` defaults to 256, maximum 10,000; `-steps` defaults
to 100,000, maximum 1,000,000; `-total-steps` defaults to and is capped at
10,000,000; `-seed` defaults to 1; `-timeout` defaults to 5s, allowed 1ms..60s.
The effective per-case fuel is capped by both the contract and the host, and
remaining total fuel is never exceeded.

For all-i64 domains whose Cartesian product fits the case budget, every tuple
is enumerated. Domain cardinality is calculated with arbitrary-precision
integers to avoid overflow. Larger or floating domains use deterministic
boundary and seeded sampling with deduplication. The latter is not an assertion
of statistically uniform sampling. Subnormal and extreme floating bounds are
clamped correctly; a sampled input must stay inside its declared domain.

| Status | Meaning |
|---|---|
| `exhaustive` | Every tuple in the bounded integer domain was considered; all admissible cases passed and at least one was checked. |
| `tested` | The checked sample passed. This does not cover unseen inputs. |
| `counterexample` | An admissible input failed a postcondition or caused a guest arithmetic trap. The witness includes typed inputs and the observed result or diagnostic. |
| `unknown` | Empty admissible domain, fuel/call-depth exhaustion, cancellation or inability to evaluate the contract. This is not success. |
| `timeout` | The execution/verification context reached its deadline. |

There is no SMT solver or `proved` result in this implementation. Even finite
exhaustiveness is an execution result dependent on the implementation, not an
independently checked proof artifact. Contract strength still matters: passing
a weak contract does not establish an unstated user intention.

Successful verification statuses exit zero. Counterexample, unknown and timeout
exit nonzero with a single JSON report. Malformed inputs produce structured
error JSON. Reports retain counts, budgets, seed, consumed steps and SHA-256
hashes of source, canonical IR and raw contract. Source locations are part of
the IR, so moving the source can change its hash. Hashes identify artifacts;
they are not author authentication or signatures.

The deliberate wrong-square example returns x. Against the domain [-100,100],
the real executable reported a counterexample at x=-100, actual result -100,
where the square contract requires 10000. The correct function passed all 201
inputs, consuming 603 core execution steps. With `-steps 1`, verification
reported `unknown`/`fuel_exhausted`, not a passing result.

## 5. Local validation and comparison

Reproduce the principal checks from the repository root:

```powershell
go test ./... -count=1 -timeout=180s
go test -v ./internal/swyplang -run '^TestCore' -count=1
go test -v ./internal/coreir -count=1
go test -v ./internal/coreir -run 'Effect|Capability' -count=1
go test -v ./cmd/swyp -run '^TestCore' -count=1
go vet ./...
go build ./...
go test -race -count=1 -timeout=180s ./internal/coreir ./internal/swyplang ./cmd/swyp ./internal/stv2
go test ./internal/coreir -run '^$' -fuzz '^FuzzCoreIRDecode$' -fuzztime=10s -parallel=2
go test ./internal/swyplang -run '^$' -fuzz '^FuzzCoreLower$' -fuzztime=10s -parallel=2
go test ./internal/coreir -run '^$' -fuzz '^FuzzContractDecodeAndVerify$' -fuzztime=10s -parallel=2
```

Executed evidence is under `docs/research/20260928-semantic-core/` (archived outside the repository under `D:/swyp-lang-archive-20260928/docs/research/`):

- 100,845 i64 arithmetic cases compared with an independent `math/big` oracle,
  including boundary values, signed overflow, division and remainder.
- 10,000 unique source programs, each tested at three inputs: core IR, the
  existing AST interpreter and STV2 matched an independent integer oracle for
  all 30,000 input cases in their common exact domain. This is one parameterized
  control-flow family, not 10,000 independent algorithms. Separate tests cover
  recursion, calls, shadowing, signed zero, short circuiting and type errors.
- Contract tests cover Cartesian enumeration, the full i64 domain cardinality,
  false preconditions, malformed predicates, guest and predicate arithmetic
  errors, cancellation, deadlines, budgets and subnormal sampling bounds.
- Bounded fuzz runs passed: IR loader 251,247 executions; source lowering 77,119;
  contract decoding/verifying 309,018. These 637,384 executions are not that
  many distinct valid programs and are not proof that defects are absent.
- Race checks passed for coreir, swyplang, the CLI and the ternary VM. The real
  CLI was tested after deleting its source copy and with no toolchain in PATH.
- Existing SWYPB compile/exec still returned 5050 from a 146-byte module.

A small local precision comparison evaluated 9007199254740993 + 1:

| Explicit numeric profile | Observed result |
|---|---:|
| Swyp core i64 | 9007199254740994 |
| Python integer | 9007199254740994 |
| JavaScript BigInt | 9007199254740994 |
| Existing Swyp number | 9007199254740992 |
| JavaScript Number | 9007199254740992 |

This is a representation/semantics comparison, not a speed benchmark or an
assertion that these types have identical ranges. Node 24.15.0, Python 3.12.10
and Go 1.26.2 were observed locally. Commands, exit codes and outputs are retained
in `smoke-results.json`. Previous language-performance measurements were not
rerun and must not be attributed to this IR implementation.

One existing symlink test was skipped on Windows because creating symlinks
requires a privilege unavailable to the process. Editor diagnostics could not
be obtained because the LSP bridge on port 3005 was unavailable. Compilation,
static analysis and tests are the actual validation; no clean LSP result is
claimed. CI configuration includes core race, fuzz and positive/negative smoke
checks, but remote CI was not executed during this session.

## 6. Scope, provenance and next work

Implementation: `internal/coreir/`, `internal/swyplang/core_lower.go` and
`cmd/swyp/core.go`, with tests alongside. Existing edits are limited to parser
mode/lexeme retention, legacy mode guards, CLI dispatch/help, README and CI.
The earlier STV2 optimization and unrelated untracked user work were preserved.
No dependencies, models or toolchains were installed; no commit or push was
made. New source, tests and examples are untracked until explicitly added to Git.

One Antigravity agent launch was retried. It returned the known static provider
acknowledgement, not file-derived findings or command results. Thus there were
zero independent agent audits; all work described here was executed directly
through Antigravity. The provider/bridge configuration was not changed.

The subsequent M1b milestone connects contract witnesses to an opt-in
`synth -contract` refinement loop for unary i64/f64 arithmetic. Existing `synth`
without that flag keeps its previous semantics. See [contract synthesis](CONTRACT_SYNTHESIS.md)
for the exact grammar, publication policy, shared budgets and local evidence.

Remaining work includes symbolic checking with explicit unknown/timeout outcomes,
SSA/liveness/allocation, native lowering for the core integer semantics,
arrays/structs and a capability/effect model beyond the current pure subset.
The eight-register STV2 backend and SWYPB format have not been widened or
replaced by this JSON IR.

Design references consulted (not dependencies or sources of benchmark results):
MLIR's typed operations/control-flow model, the Go specification's integer and
floating behavior, and Dafny's distinction between preconditions, postconditions
and verification. This implementation does not embed MLIR or Dafny.

- https://mlir.llvm.org/docs/LangRef/
- https://go.dev/ref/spec
- https://dafny.org/dafny/OnlineTutorial/guide
