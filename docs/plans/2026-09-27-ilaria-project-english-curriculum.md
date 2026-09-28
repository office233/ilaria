# Ilaria: English-first project curriculum

## Decision and current baseline

Owner priority: English for Swypik, SwypikOS and Swyp Lang. Romanian is deferred, not a release blocker for the English experiment. Mathematics and quantum physics are later curriculum domains, not justification for unfiltered ingestion.

v5 manual development-suite result: 57/59 overall, **57/58 English cases** after excluding the single Romanian translation case. One English failure remains: an invented meeting date. This small suite establishes neither broad English competence nor coding/science competence. Retain the original suite and its failures; changing the reporting slice does not change answers or training.

## Inspected project state

- `D:/swyp lang`: independent Go module. Scalar language, parser/type checker/interpreter, C/GCC native backend, bounded arithmetic synthesis and counterexample refinement. Graph export is a numerical DAG, not neural weights or a quantum state. Matching supplied points is not a proof on all inputs.
- `internal/synthesis/refine.go`: counterexamples share a total candidate budget; contradictory examples are rejected. `cmd/swyp/worker.go`: bounded JSON input, synthesis, source hash and operation graph output. No arbitrary shell or model required for synthesis.
- `cmd/swyp/draft.go`: optional Ilaria drafting checks syntax/types and saves a new candidate. It explicitly disallows invented APIs. Static validity alone does not establish behavior.
- `bridge/ilaria/tool.go`: implements Name/Match/Execute (`cortex.Tool`). The live server `D:/ilaria/cmd/ilaria-serve/main.go` constructs Name/Describe/Call `ChatTool` objects. **A ChatTool wrapper and explicit registration are required.** Registering the legacy Tool alone will not make it callable by the chat model. Inspection found calc/time/convert and optional read_file, not Swyp registration.
- `D:/swypik-os`: a Windows desktop shell, not an independently bootable OS. Its README identifies simulation gaps in distributed training/rewards. Do not teach planned capabilities as implemented facts.
- `E:/Swypik/swypik/app/lib/ai/ilaria.ts`: server-side HTTPS transport with bearer token, bounded request/response and history validation. This does not prove a deployed inference endpoint is available.
- `E:/Swypik/swypik-mobile-pilot`: mobile prototype; README's latest scope removes Studio, retaining Discover and Shop. Ilaria integration and full mobile parity are not yet implemented according to this snapshot. Earlier README sections are stale where the later scope supersedes them.

Independent checks this review: `go test -count=1 -timeout 180s ./internal/... ./cmd/... ./bridge/...` and `go vet ./internal/... ./cmd/... ./bridge/...` passed in Swyp Lang. These cover selected production packages, not every isolated agent workspace or live Ilaria drafting.

Campaign snapshot `agent-lab/20260927-215109/status.json`: 63 completed and 38 failed_or_partial entries. The inspected verification/results.json has 79 independently_executed and 11 no_test_artifact entries. Execution is not synonymous with passing. Do not ingest campaign outputs as gold answers without individual review. No new agents were started and no other agent's project files were changed.

## Training, retrieval and executable tools

1. Keep current repository facts in a versioned retrieval corpus: path, source hash, snapshot time and relevant excerpts. Use explicit source allowlists; exclude secrets, runtime/user data, archives and generated output. Refresh retrieval when code changes.
2. Fine-tune on English behavior: use supplied evidence, ask for missing inputs, produce valid project-specific code, explain real diagnostics, and report actual tool results. Do not memorize snapshots as timeless product facts.
3. Use deterministic tools for arithmetic, compilation, tests and Swyp synthesis. Teach calls only after the actual ChatTool contract is implemented and tested. Tool observations in training must come from execution, not invented transcripts.

Do not upload the repositories wholesale. No project source corpus was uploaded or external dataset downloaded in this review.

## Proposed next English pilot

First build and review 200 seed tasks; expand only after measuring quality. Proposed sampling mixture, to be tuned using fresh development measurements:

| Share | Domain | Evidence required |
|---:|---|---|
| 40% | SwypikOS and Swypik support/development | Supplied source excerpts, current contracts, expected behavior |
| 25% | Swyp language and synthesis | Compiler/type checker, runtime outputs, held-out inputs |
| 20% | Go and TypeScript debugging | Reproducible failing test, patch, passing tests |
| 15% | Grounded English and numerical reasoning | Fact-preserving text, deterministic numerical answers |

These are proposed proportions, not an existing dataset or a claim that 200 tasks suffice. Replay selected earlier tool/clarification examples to measure and limit regressions. Initial curated release target: 2,000–5,000 reviewed examples only if diversity and validation justify expansion.

Concrete seed task families:

1. Given the current Swyp type rules, generate a scalar `predict` function and test on unseen inputs.
2. Repair a type mismatch, undefined variable or missing return using the actual compiler diagnostic.
3. Turn numeric input/output pairs into a bounded worker specification; state ambiguity when multiple functions fit.
4. Explain a counterexample, budget exhaustion or contradictory example without claiming mathematical impossibility.
5. Reject requests for unavailable Swyp arrays, imports, network or filesystem APIs; identify the missing capability.
6. Given an OS integration excerpt, distinguish proposed features from implemented ones.
7. Given an HTTP error/timeout fixture, explain service unavailability without inventing a successful action.
8. Preserve complete alternating chat history and explain rejected invalid requests.
9. Given mobile requirements and API fixtures, distinguish empty/loading/error states without inventing users or products.
10. Draft notices using only supplied dates, names and commitments; use neutral wording or placeholders for missing details.
11. Solve arithmetic and unit problems through actual tool calls; request missing quantities/units.
12. Repair small Go/TypeScript functions with executable tests and no unrelated edits.

## Evaluation gates before another training run

- Freeze a new English evaluation set before generating training variants. Split by task family/source function/topic, not random paraphrase. Keep the previous final eight prompts out of training.
- Run v5 on the new set first: include Swyp compile rate, behavioral correctness on unseen inputs, tool selection, unsupported actions, factual invention and project-source grounding.
- Keep numerical/scientific test answers outside training. Record provenance and exact source revision for each example.
- Verify no truncation of supervised answers, the corrected assistant-header tokenization, and identical deployed prompt/tool schema.
- Run a small pilot with separate checkpoint/output and compare against v5. A lower validation loss alone does not approve the adapter. Do not launch a large multi-GPU run until data, single-GPU training and evaluation are reproducible.

## Broad code and science, after the project pilot

"All GitHub" is not the next input batch. Choose relevant Go/TypeScript/Python code with usable licenses, provenance, deduplication and tests. The Stack documentation explicitly requires respecting original code licenses; its filtering/opt-out practices are relevant to corpus construction: https://www.bigcode-project.org/docs/about/the-stack/ . A candidate educational corpus to inspect is https://huggingface.co/datasets/HuggingFaceTB/smollm-corpus . Neither was imported.

Mathematics progression: arithmetic/units → algebra → linear algebra → calculus/probability. Use independently checked answers and numerical/symbolic validators where applicable. Swyp's present scalar arithmetic engine cannot replace a general symbolic algebra or tensor system.

Quantum physics follows linear algebra, complex numbers, probability and classical physics. Start with narrowly testable concepts/problems, not claims of quantum hardware acceleration. The inspected OpenStax volume covers quantum mechanics, but its current page displays a noncommercial/share-alike license; treat it as a reference candidate requiring suitability review, not an automatically approved commercial training source: https://openstax.org/books/university-physics-volume-3/pages/7-introduction .

The existing approximately 2B-parameter BitNet adapter experiment does not establish that short LoRA runs on a large raw corpus will yield a frontier general model. Decide on broader continued pretraining or a different base only after project-specific baselines and compute/data measurements.

## Immediate implementation order

1. Agree the bounded Swyp ChatTool contract in code and test it with the actual worker.
2. Build a local, source-hashed project reference corpus and the new English evaluation fixtures.
3. Capture verified English task/answer/tool trajectories, validate the corpus, then train a small project pilot.
4. Evaluate and only then consider integration/promotion or larger compute.

This review changes documentation only. It does not install the bridge, train a new adapter, deploy a service or alter Swyp/OS/mobile source.
