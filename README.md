# Swyp Lang

## Contract-guided synthesis (experimental)

`synth -contract` now refines typed arithmetic candidates using real contract
counterexamples. It preserves exact `i64` values and evaluates relational
postconditions without inventing a unique expected output. Existing `synth`
without this flag retains its previous float64/example-based behavior.

```powershell
go build -o bin/swyp-contract.exe ./cmd/swyp
./bin/swyp-contract.exe synth -contract examples/swyp/contracts/square.i64.json -o bin/square-generated.swyp examples/swyp/synthesis-contract-square.json
./bin/swyp-contract.exe core-run -entry square bin/square-generated.swyp 12
```

The example refines `x` into `x * x` in two rounds, checks all 201 integers in
`[-100,100]`, and returns `144` for input `12`. Output must be new. Publication
requires exhaustive finite-domain verification by default; sampled evidence
requires explicit `-allow-sampled`. No SMT or universal proof is claimed.
See [contracts, bounds, evidence and limitations](docs/CONTRACT_SYNTHESIS.md).

## Opt-in Semantic Core and contracts (experimental)

The new core pipeline has checked `i64`, finite `f64` (`number` remains binary64),
verified control flow, pure function calls, typed JSON IR and bounded contract
verification. It does not replace the existing interpreter, C/JS backends or STV2.

```powershell
go build -o bin/swyp-core.exe ./cmd/swyp
./bin/swyp-core.exe core-run -entry next examples/swyp/semantic-core.swyp 9007199254740993
./bin/swyp-core.exe verify -contract examples/swyp/contracts/square.i64.json examples/swyp/semantic-core.swyp
```

The first result is the exact integer `9007199254740994`. The second enumerates
201 integer inputs. `tested` is sampling, `exhaustive` is finite-domain execution,
and neither is an SMT proof. Failed checks emit JSON counterexamples or explicit
`unknown`/`timeout` statuses and exit nonzero. See [syntax, IR and contract limits](docs/SEMANTIC_CORE.md).

## Compiled Swyp modules (experimental)

Swyp source stays `.swyp`. The main `swyp` executable can now compile the existing
safe-integer subset to a self-describing `.swypb` file and run it in another
process without the original source, a Go toolchain, GCC, or an AI service:

```sh
swyp compile --target stv2 -o sum.swypb examples/swyp/sum.stv2.swyp
swyp exec sum.swypb 100
```

The second command returns JSON with `value: 5050`. Build the updated tool once
with `go build -o swyp ./cmd/swyp` (Windows: `swyp.exe`); that build is a developer
step, not how Swyp programs are written. Compile does not execute the program.
Output files must be new. See [module format and limits](docs/SWYPB_FORMAT.md).
This is bytecode for the Swyp VM, not a standalone native application or a new
language. The source subset and existing backends are unchanged.

Version 0.5 adds counterexample refinement to **program synthesis without an LLM**. Given numeric
input/output examples, `synth` searches arithmetic expressions and saves a new
type-checked program. It matches examples; it does not prove general correctness.

An optional `validation` array in the JSON specification checks each proposal on
additional points. The first failing point feeds the next search round; all
rounds share one candidate budget. See [the refinement example](examples/swyp/synthesis-refine.json).

```powershell
Set-Location 'D:\swyp lang'
go build -o bin/swyp.exe ./cmd/swyp
.\bin\swyp.exe synth -o bin/my-linear.swyp examples/swyp/synthesis-linear.json
.\bin\swyp.exe run bin/my-linear.swyp 8
```

The output file must be new. [Implementation and verification report](docs/NON_LLM_STATUS.md).

[Version 0.5 campaign and independent test results](docs/CAMPAIGN_100_AGENTS.md).

`swyp worker` accepts one specification on stdin and returns JSON containing the
candidate, its source hash and a bounded numerical operation DAG. The
[Nexus adapter](bridge/nexus/README.md) implements the inspected Nexus deterministic
tool interface and has been tested against the real worker. It is not yet
registered in the Nexus application.

Experimental language project, moved from SwypikOS to `D:\swyp lang`.

```powershell
Set-Location 'D:\swyp lang'
go test ./...
go build -o bin/swyp.exe ./cmd/swyp
.\bin\swyp.exe run examples/swyp/hello.swyp
```

- [Language and commands](docs/SWYP_LANG.md)
- [Latest speed comparisons](docs/SWYP_OPTIMIZATION_ASSESSMENT.md)
- [AI workflow and current limits](docs/SWYP_AI_WORKFLOW.md)
- [Research and vision](docs/SWYP_VISION.md)

The compiler, interpreter, tests, examples, benchmarks, documentation and generated
artifacts are located here. This module builds independently of SwypikOS.
The optional legacy Ilaria transport was copied into `internal/ilaria`; its
original implementation remains in the desktop application, which still uses it.
No model service is required to compile or run ordinary Swyp programs.

[Move manifest](docs/MOVE_MANIFEST.json) records SHA-256 hashes verified immediately
after the move, before import paths were adjusted and the CLI was rebuilt.
Historical reports and generated provenance files retain their original paths
and hashes as records of the earlier runs.
