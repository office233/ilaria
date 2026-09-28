# Swyp operation graphs and Nexus integration

## Implemented representation

Swyp can export a pure numerical `predict` function to a versioned DAG. Every
node has a numerical opcode, numeric constant value and references to earlier
nodes. Identical structural subexpressions share nodes. No algebraic float64
reassociation is performed. This is an executable representation with defined
semantics, not a vector embedding, neural weight tensor or quantum state.

| Opcode | Operation | Inputs |
|---:|---|---:|
| 0 | Input x | 0 |
| 1 | Finite constant | 0 |
| 2 | Addition | 2 |
| 3 | Subtraction | 2 |
| 4 | Multiplication | 2 |
| 5 | Negation | 1 |

Version 1 graphs contain 1–64 nodes, must reference only earlier nodes and reject
unknown operations, wrong arity, non-finite constants and invalid output indices.
Evaluation checks finite inputs/results and a caller-supplied node budget.
Its resource accounting is distinct from source-level interpreter ticks.
JSON round trips preserve negative zero constants.

The test `(x+1)*(x+1)` exports four shared graph nodes and agrees with the expected
arithmetic on 65 quarter-step inputs. The graph evaluator is a bounded Go runtime,
not native shader generation. The existing C/GCC backend still compiles source.

## Worker protocol

```powershell
Set-Location 'D:\swyp lang'
go build -o bin/swyp.exe ./cmd/swyp
Get-Content examples/swyp/synthesis-refine.json -Raw | .\bin\swyp.exe worker
```

The worker accepts one JSON specification, at most 64 KiB, with a five-second
search context. It performs non-LLM counterexample refinement, exports the graph,
checks graph results on supplied points and returns JSON with `version: 1`,
`status: "candidate"`, source SHA-256, graph and refinement statistics.
It writes no generated files, starts no external compiler and contacts no model.
It internally evaluates only the bounded generated arithmetic.

The process expects EOF after its one request. External callers must enforce a
whole-process deadline; the included adapter does so. A hash establishes content
identity, not proof of correctness or trusted authorship.

## Nexus / Ilaria findings

Inspected source files:

- `D:/nexus/AGENTS.md`: Nexus is an experimental Go cognitive architecture.
- `D:/nexus/cortex/tools.go`: deterministic `Tool` interface with `Name`, `Match`,
  `Execute`, and `ToolRegistry.Register`.
- `D:/nexus/cortex/sdr.go`: sparse binary SDR representation; it is not an
  instruction-set semantics or an executable Swyp graph.
- `D:/nexus/cmd/ilaria-serve/main.go`: `/v1/chat` loads BitNet model/tokenizer data
  and serves inference. It is not required by the synthesis worker.

`bridge/nexus.Tool` matches the deterministic Tool contract. It accepts an explicit
`swyp:` JSON request, calls a configured absolute executable with the fixed
`worker` argument, caps stdin/stdout, enforces a ten-second process deadline and
checks the returned candidate status and source hash. It never uses a shell.
The integration test builds and invokes the real worker and rejects invalid
requests. [Registration instructions](../bridge/nexus/README.md) are provided.

The Nexus checkout has only been inspected. No dependency, tool registration,
service configuration, model data or active process was changed there. Live
registration is still needed before Ilaria/Nexus users can invoke this adapter.

## Boundaries of the autogenesis proposal

The implemented cycle is specification -> candidate -> counterexample -> renewed
search -> checked candidate. It does not mutate the language syntax, modify the
kernel, replicate itself or delete old versions. It has no demonstrated AGI or
hardware-transistor optimization capability. A future promotion mechanism needs
explicit correctness and performance gates, artifact history and rollback.

Counterexample-guided synthesis is prior art, not a new discovery here. Verified
references include [Combinatorial Sketching for Finite Programs](https://people.eecs.berkeley.edu/~sseshia/pubdir/asplos06-final.pdf)
and [Oracle-Guided Component-Based Program Synthesis](https://www2.eecs.berkeley.edu/Pubs/TechRpts/2010/EECS-2010-15.html).
Our bounded adaptation uses a finite list of points and no SAT/SMT solver.

The research agent suggested warm-starting search pools. We have not adopted
that suggestion: a new counterexample can split previously equivalent classes,
so retaining only old representatives can lose needed candidates. The implemented
restart behavior is covered by a regression test that recovers a previously
indistinguishable constant. Claimed novelty or speed gains require further evidence.
