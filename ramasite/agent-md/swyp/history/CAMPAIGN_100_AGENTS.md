# Swyp 0.5 — 100 test agents, refinement and operation graphs

## What was run

One research agent and 100 test agents used Antigravity with
`gemini-3.8-flash-high`. Test agents received separate Go modules containing the
complete synthesis and language implementation files from one frozen baseline.
Eight ran concurrently. Each had a separate assigned seed and one of ten test
themes. These related seeded tests are not 100 independent discoveries.

Workspace: `D:/swyp lang/agent-lab/20260927-215109`.
Each directory retains its task, source snapshot and stdout/stderr. The
[dispatch manifest](../../../docs/swyp/agent-lab/20260927-215109/status.json) records actual exits.

| Test-agent outcome | Count |
|---|---:|
| Normal completion | 63 |
| Timeout / partial output | 35 |
| Command permission denial | 2 |
| Test files recovered from all sessions | 80 |
| Sessions leaving no test file | 20 |

The research agent initially timed out, then completed when resumed by its exact
conversation ID. No permission bypass flag was used. Queued test tasks were
narrowed after early timeouts: write one small test and let Codex execute it.

## Independent test review

All 80 available test files were run separately against the frozen original and
the final current implementation. Agent edits to production files were not used
as the test target. Import/directive checks preceded execution; detailed source
hashes and command output are retained in the
[verification report](../../../docs/swyp/agent-lab/20260927-215109/verification-final/results.json).

| File-level result | Count |
|---|---:|
| Passed on original and current code | 65 |
| Passed original; asserted an obsolete contradiction error on current code | 11 |
| Defective generated tests, failing both implementations | 4 |

The 11 diagnostic mismatches expect search exhaustion for contradictory data.
Version 0.5 now rejects those inputs immediately as `ErrInvalidSpec`, consuming
zero search candidates. This is an intentional observable API change, explicitly
covered by project regression tests. Raw agent tests were preserved unchanged.

The four defective test files included two unused-import build failures, an
incorrect expected candidate count after early success, and confusion between
Go compile-time constants and runtime float64 addition. A corrected rounding
regression was integrated into the project. No passing-test claim is made for
these original files or for the 20 missing artifacts.

The [machine-readable summary](AGENT_CAMPAIGN_20260927.json) separates dispatch,
test outcomes, manual triage and the recorded project verification commands.

## Changes accepted into Swyp

1. **Counterexample refinement without an LLM.** An optional `validation` set
   checks each proposal; the first failing point joins the next search round.
   Rounds share one total candidate budget. Search restarts rather than unsafely
   reusing equivalence classes formed on a smaller input set.
2. **Stricter specifications.** Missing/null numeric example fields and null
   constants are rejected. Contradictory outputs are rejected before search.
3. **Numerical operation DAG.** Pure functions export versioned numeric opcodes
   and shared structural nodes, with bounded evaluation, cycle/arity checks,
   finite-number guards and signed-zero-preserving JSON serialization.
4. **Nexus worker adapter.** A bounded stdin/stdout worker returns a candidate,
   source hash, graph and evidence. The Go adapter matches the inspected Nexus
   deterministic Tool interface and was tested with the real worker executable.

For example, the seed examples `(0,0)` and `(1,1)` initially produce `x`.
Validation point `(2,4)` rejects it. The next search produces `x*x`: **two rounds,
57 total candidates**, then the result evaluates to 49 at input 7.

Three refinement cases passed **366 additional held-out comparisons** across
the interpreter and native executable. Details are in
[NON_LLM_REFINEMENT_EVALUATION.json](NON_LLM_REFINEMENT_EVALUATION.json).
These are correctness checks, not a speed comparison or proof over all inputs.

The recorded project checks are `go test -count=1 ./...` and `go vet ./...`;
their actual exit codes and source hashes are retained in
[root-checks.json](../../../docs/swyp/agent-lab/20260927-215109/root-checks.json).

## Nexus and remaining scope

The [graph and integration report](OPERATION_GRAPH_AND_NEXUS.md) describes the
implemented protocol and the inspected Nexus files. Nexus itself was not modified.
Tool registration and its local module dependency remain to be installed there.
A read-only Ilaria `/health` probe exceeded a two-second timeout, so no live
Ilaria integration is claimed. The worker and adapter tests need no model service.

This is a bounded code-generation and checking system. It does not demonstrate
AGI, self-replication, a mutable instruction set, quantum execution or universal
speed superiority. The agent's counterexample-refinement proposal has established
prior art; claims of novelty and faster execution require separate evidence.
