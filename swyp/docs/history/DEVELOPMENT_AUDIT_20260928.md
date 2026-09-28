# Swyp development audit: parser and CLI guardrails

Date: 2026-09-28 (Europe/Bucharest).
Workspace: `D:\swyp lang`.
Base commit: `650d88616da46cbc0f459f7af29991654d00e507`.
Observed branch: `work/local-swyp-validation-20260928`.
Environment: Go 1.26.2, Windows/amd64; GCC and Node available.

## Scope and observed architecture

This was a focused source audit and first implementation pass, not a certification
or an exhaustive audit of every experiment. The existing full test suite passed
before changes, but did not detect the regressions described below.

The repository contains a Go-implemented scalar language with parsing, static
checking, an AST interpreter, C/native and JavaScript/web emitters, deterministic
arithmetic synthesis, and a Nexus worker adapter. STV2 is a separate bounded
safe-integer backend. SWYPB persists that backend's bytecode and metadata; it is
not a standalone native executable. The current STV2 compiler accepts one main,
number/bool results, literal arg(0)..arg(3), and eight registers without spilling.
It explicitly rejects user functions, strings, print, clock and division.

Reviewed implementation: `internal/swyplang/{swyp,check,native,web,stv2,swypb}.go`,
`cmd/swyp/{main,module,worker}.go`, associated tests, the root README,
`docs/SWYP_LANG.md`, `docs/SWYPB_FORMAT.md`, and the existing CI workflow.
Historical agent-lab worktrees and generated experiments were not treated as the
current implementation.

## Implemented corrections

### 1. Non-finite tokens could override ordinary identifiers

Reproduction before the fix:

```swyp
fn main() { let NaN = 7; print(NaN); }
```

The interpreter printed `NaN`, not `7`. The parser attempted floating-point
conversion on identifier text and excluded infinity but not NaN. Unbound `NaN`,
`nan` and `NAN` passed static checking as numeric literals; calling a user
function named NaN failed to parse.

`internal/swyplang/swyp.go` now excludes both NaN and infinity when recognizing
numeric literals. These names follow ordinary identifier lookup: bound names
work and unbound names fail checking/execution. Existing finite decimal,
exponent, underscore-separated and hexadecimal-float literals remain covered.

### 2. Iterative expression construction bypassed recursive nesting checks

An expression containing 513 left-associated operands parsed successfully even
though the resulting tree exceeded the intended nesting guard. Parser call depth
was bounded, but a loop constructing binary nodes did not increase that depth.
The checker and backend traversals subsequently received the deep tree.

Every parsed expression now records its tree height. Construction rejects an AST
height above 256 independently of the existing parser-recursion guard. Tests
cover arithmetic, boolean and mixed-precedence chains, plus accepted shallow
expressions. This bounds tree depth; it is not a complete CPU or memory sandbox.
No process crash or exploit was claimed or required for the reproduction.

### 3. Main CLI commands read whole source files before checking size

`check`, `run`, `emit-c`, `web` and `build` used `os.ReadFile` before Parse enforced
its 1 MiB source limit. Thus the parse-time limit did not bound the initial read.

`cmd/swyp/main.go` now reuses the existing bounded reader from the module CLI.
It reads at most the limit plus one byte to detect oversize input, and rejects it
before parsing or output creation. Exactly 1 MiB remains accepted. Read errors
retain their original identity. This change covers these five commands only;
other input entrypoints require their own review and appropriate limits.

## Regression evidence

New files:

- `internal/swyplang/parser_guardrails_test.go`: six test functions covering
  identifier handling, unbound names, function names, finite literals, rejected
  deep trees and accepted shallow trees.
- `cmd/swyp/source_input_test.go`: three test functions covering all five core
  source commands, exact-size acceptance and missing-file errors.

The new parser regressions were run against the original implementation and
failed for NaN identifier/function handling and deep trees. After the parser
patch, all six functions passed. The new CLI over-limit regression failed
before the CLI patch, reporting the later parser error rather than the bounded
reader error. It passed in the complete suite after the patch. The CLI test is
an execution-path regression, not a peak-memory benchmark.

## Commands actually executed after changes

All commands below returned exit code 0:

```powershell
go test ./internal/swyplang -run '^TestParser' -count=1 -timeout=30s -v
go test ./... -count=1 -timeout=90s
go vet ./...
go build ./...
gofmt -l internal/swyplang/swyp.go internal/swyplang/parser_guardrails_test.go cmd/swyp/main.go cmd/swyp/source_input_test.go
git diff --check
go test -race -count=1 -timeout=90s ./internal/swyplang ./cmd/swyp ./experiments/ternaryvm
go test ./internal/swyplang -run '^$' -fuzz '^FuzzParse$' -fuzztime=8s -parallel=2
go test ./internal/swyplang -run '^$' -fuzz '^FuzzSTV2CompilerAudit$' -fuzztime=8s -parallel=2
```

The formatter reported no files; `go vet` and `git diff --check` reported no
issues. The full suite passed all seven packages that have tests; seven other
packages reported no test files. Race detection passed the three listed
packages. Parser fuzzing reported 32,809 executions; compiler fuzzing reported
80,363 executions. Both bounded runs passed. These are observations from short
runs, not proofs of correctness or absence of races.

### Actual executable smoke checks

A fresh CLI was built in a unique temporary directory. No installed or existing
repository executable was replaced. Temporary files were removed afterward.

1. Copy the sum source; compile it into SWYPB; remove the copied source; run the
   module with PATH containing only the temporary directory and no toolchains.
   Observed result:

```json
{"format":"SWYPB","version":1,"target":"stv2","profile":"swyp-safe-integer","result_type":"number","value":5050,"steps":1308,"instructions":18,"module_bytes":157}
```

2. Run `let NaN = 7; print(NaN);` through the interpreter and a freshly built
   native executable. Both produced `7`.
3. Compile and execute a module returning the local variable NaN. It returned
   value 7, with 3 executed steps, 4 instructions and 79 module bytes.

Existing generated web runner behavior was not visually re-tested in Chrome.
Remote CI was not invoked; these results are local Windows measurements.

## Delegation and editor integration limitations

Two `spawn_antigravity_agent` calls and one read-only `opencode_run` review
returned provider `chatgpt-web` acknowledgements without source findings or
command evidence. A launcher status of completed/exit 0 was not treated as a
completed independent audit. No independent agent review was obtained.
The findings, changes and verification above came from direct Antigravity
filesystem and PowerShell execution.

LSP diagnostics were requested after each code-file change. The bridge reported
VS Code Insiders unavailable on local port 3005. No clean LSP result is claimed;
Go tests, compilation, vet and race detection supplied the actual verification.

## Remaining work and acceptance criteria

1. Audit the other file-reading entrypoints (`draft`, `expand`/`repair`, `ternary`)
   and introduce suitable input bounds without changing replay/provenance
   contracts. Require oversize, exact-boundary and no-output-on-error tests.
2. Extend differential coverage across interpreter, C, JS and STV2 where their
   documented domains overlap; include numeric edge cases, identifiers, scope,
   evaluation order and short-circuit behavior. Keep backend exclusions explicit.
3. Design better STV2 register allocation before expanding its language subset.
   Current allocation has eight registers and no spilling. Define and test
   liveness/pressure behavior before adding any new VM storage or function ABI.
4. Add Windows execution to the CI validation matrix. The reviewed workflow runs
   on Ubuntu and cross-builds Windows; cross-compilation does not replace running
   the Windows tests. Require the full suite, native parity and source-free CLI
   execution on each supported execution platform.

Agent delegation and the editor bridge need a separate integration repair before
claims of autonomous multi-agent review or live LSP validation are justified.

## Workspace preservation and source hashes

No commit, push, reset, clean, dependency installation, provider reconfiguration
or persistent service launch was performed. Pre-existing untracked work under
`bridge/chatgpt-mcp/`, `docs/LOCAL_DEVELOPMENT.md`, `scripts/` and `swyp.cmd` was
not edited. Only two production files, two new test files and this report were
changed/created. The new tests/report remain untracked until deliberately staged.

SHA-256 of verified source files:

```text
3BEEF036E155241200E8CAA8D474AF039D66B5A5FFA9BBA43146B9C4D7762E2D  internal/swyplang/swyp.go
17D7618EFA4BD34B6A1EEE24200E0F575FB86B635C12786694C0575238E1D928  internal/swyplang/parser_guardrails_test.go
52A2D9A5111DD5986A05F8456466F28FDAF75F0A8965D0489D0FCABA66E69295  cmd/swyp/main.go
FC190BEE0910905112D71D8A46CCBAD1C5ECE733B0F33FF4F3DE681E7B08E0E4  cmd/swyp/source_input_test.go
```
