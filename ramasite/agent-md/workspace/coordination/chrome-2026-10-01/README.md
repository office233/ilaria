# Nexus — Chrome ChatGPT work allocation

Branch at dispatch: `codex/nexus-supervisor-v3`. Preserve all existing local
changes. Every worker must read applicable AGENTS.md and the supervisor v2
milestone, verify local MCP workspace access, and inspect existing code before
implementing. No branch/index/history changes, reset, clean, push, deployment,
secrets, private data or model weights. Do not introduce another model family.

## Exclusive ownership while workers run

| Worker | Task | Allowed code writes | Completion report |
| --- | --- | --- | --- |
| 1 — Swyp continuations | Pure versioned continuation state, validation and broker export/import | `swyp/internal/coreir/`, `swyp/cmd/swyp/core_broker*`, new `swyp/specs/continuation*`, new `swyp/protocol/continuation/`; no other products | `worker-1.md` |
| 2 — OS resume | Authenticated durable continuation persistence and no-replay resume | `swypik-os/core/supervisor/`, `swypik-os/cmd/plan-supervisor/`; no Control Kernel/process-group changes without reporting need | `worker-2.md` |
| 3 — Snapshot cache | Explicit host-owned immutable snapshot cache library | new `swypik-os/internal/plancache/` only | `worker-3.md` |
| 4 — Energy | Optional real platform energy counters with accurate scope/unavailable states | new `swypik-os/core/resource/energy*` files only; no existing resource files | `worker-4.md` |
| 5 — Integrator | Tests, generated mirrors, cache/energy integration, CI and evidence | new `scripts/*supervisor-v3*`, `docs/milestones/supervisor-v3.md`, own `worker-5.md` initially; CLI/CI/shared outputs only after owner completion and handoff | `worker-5.md` |

Each report must include `State: RUNNING`, `BLOCKED` or `COMPLETE`, exact claimed
files, implemented interfaces, checks and actual results, remaining limitations
and handoff requirements. One worker writes only its own report. A report marked
COMPLETE releases that worker's listed files to Worker 5; workers must stop
editing after release. Do not overwrite an existing claim or another worker's
report. If this dispatch's source ownership conflicts with another active
worker, stop the conflicting edits and document it.

Worker 1 publishes the continuation protocol and API in its report as its first
concrete deliverable. Worker 2 consumes that stable protocol rather than
importing Swyp internals; it can work on independent persistence tests while the
protocol is being prepared. Workers 3 and 4 publish their public library APIs.
Worker 5 performs shared integration after handoff; it must not race worker edits
or claim task completion based only on other chat assurances.

Acceptance: no replay of observed effects, exact validated interpreter state,
explicit host authority, strict existing process-tree containment, bounded
resident/cached state, persistent verifier, honest energy availability/scope,
affected product test/vet gates, Linux race coverage where available, real
cross-product integration, generated-contract drift checks and `git diff --check`.
Use synthetic fixtures and public test keys. No fabricated measurements or
claims of universal device readiness, P2P training or world-leading quality.

## Coordination checks before integration

- Freeze an unambiguous `effect_cursor` definition in the public protocol:
  last resolved sequence/count and next sequence are distinct concepts. Pin
  checkpoint timing and the resolved result binding with executable examples.
- Freeze the actual broker checkpoint/resume fields, bounds, canonical encoding
  and exported validation/hash APIs before consumers integrate them. Draft API
  prose alone is not a stable contract.
- Authenticate cache attestation over the complete identity, canonical IR hash
  and relevant metadata. A recomputed hash alone does not establish provenance.
- Build/test outputs and temporary fixtures must use separate worker directories;
  do not overwrite another worker's executable or change global environment.
- Worker 5 records exact acquired files and waits for completed owner handoff
  before editing shared CLI, generated mirrors or other released files.

The first read-only claim check found no overlap among Workers 1–3. This is a
point-in-time observation, not a guarantee for later claims; recheck reports
before each handoff. Worker reports are implementation evidence to inspect,
not a substitute for independent integration tests.

## Dispatched Chrome chats

All five task messages were submitted in Chat mode with the existing ChatGPT
Bridge plugin selected. Local workspace access was confirmed by each chat;
implementation and integration remain in progress.

| Worker | Chat |
| --- | --- |
| 1 | [Swyp continuations](https://chatgpt.com/c/6abe0d81-c284-83eb-a42f-f7a98a4f111e) |
| 2 | [OS resume](https://chatgpt.com/c/6abe0df0-8d38-83ed-8fac-3a0af1c9b988) |
| 3 | [Snapshot cache](https://chatgpt.com/c/6abe0e36-8ffc-83eb-8bc6-c3efefad21c4) |
| 4 | [Energy counters](https://chatgpt.com/c/6abe0e91-4dac-83ed-a755-89c1ffc94b76) |
| 5 | [Integration and tests](https://chatgpt.com/c/6abe0f09-2fd4-83ed-a8f2-0b21d34ec51f) |

## Recurring coordinator

The local coordinator automation is ACTIVE every 15 minutes. Its current
evidence, accepted handoffs, next allocations and operational limits are in
[coordinator.md](coordinator.md). Original reports remain the record of v3
handoff; subsequent tasks use separate round reports. Always inspect current
chat/job state and file claims before sending another task.

## Current round 2 allocation

Workers 1–4 completed their original v3 implementations and released those
files. Worker 5 is integrating them; the original claims and reports remain
handoff evidence. New tasks do not reacquire the handed-off files.

| Chat worker | Next task | Exclusive writes | Current report |
| --- | --- | --- | --- |
| 1 | Bound Swyp module-graph memory and total source budget | `swyp/internal/sourcefront/graph.go`, new `graph_budget_test.go` and `graph_bench_test.go` in that directory, new `swyp/docs/MODULE_GRAPH_RESOURCE_LIMITS.md` | `worker-1-r2.md` |
| 2 | Explicit bounded JSONL transport up to the public continuation limit | `swypik-os/internal/planprocess/process.go`, `process_test.go`, `README.md`, new `frame_limit_test.go` only; no CLI, group, monitor or platform containment edits | `worker-2-r2.md` |
| 3 | Native IMC TritPack20 codec and allocation-free reference MatVec | new `ilaria/runtime/tritpack20/` files and new `ilaria/docs/architecture/TRITPACK20_V1.md`; no Forge, training, tokenizer, corpus or checkpoint changes | `worker-3-r2.md` |
| 4 | Native seed device-graph wire adapter with real C decoder conformance | new `swypik-os/internal/nativegraph/`, new `swypik-os/kernel/tests/nativegraph_wire_probe.c`, new `scripts/verify-nativegraph-wire.py` only; no kernel or device authority implementation changes | `worker-4-r2.md` |

Each current task writes its separate round report. Keep original COMPLETE
reports intact, and inspect both current round claims and Worker 5 takeover
claims before integration or reassignment. Worker 5 continues supervisor v3
until its own required integrated gates are proved.

## Current OpenCode allocation

General development was explicitly resumed by the human. Four OpenCode sessions
are running under the installed `opencode-control` MCP with the configured
GPT-6.1 Sol model: three isolated editors and one read-only P2P milestone review.
Their exact prompts/claims are in `opencode-batch-1.json`, IDs in
`opencode-sessions-1.json`, and live budget observations in `opencode-budget-1.json`.
See the current OpenCode section in `coordinator.md` for worktrees, baseline
manifests, budget guardian and verified state. Do not assign these files to
another owner or integrate inherited snapshot changes as new implementation.
