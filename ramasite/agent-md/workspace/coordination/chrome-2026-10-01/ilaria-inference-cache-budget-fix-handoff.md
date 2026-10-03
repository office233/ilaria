# IMC inference cache budget fix — frozen handoff

STOP / FROZEN, 2026-10-01 22:11 UTC. This is a separate candidate fork in
`C:\Users\abel\.codex\worktrees\ilaria-inference-cache-budget-fix\nexus`, branch
`codex/ilaria-inference-cache-budget-fix`, HEAD
`06a5f39f805cf36897e05ffe306d05ed212a5a3a`. It does not take ownership of the
previous inference-cache worktree, whose terminal owner handoff remains unknown.
No Main integration, stage, commit, push, paid call, GPU, corpus or pre-existing
checkpoint access occurred. Tests used public synthetic fixtures and temporary
checkpoints; benchmarks created random weights in memory and saved scalar results.

## Owned files and exact source pins

Only these three source files and this new handoff are agent-owned claims:

| Path | SHA256 |
| --- | --- |
| `ilaria/forge/imc_model.py` | `650f4cad06d80760a03fa4396bb2cce27364bd596b8002f39ec02d595205274c` |
| `ilaria/forge/test_imc_model.py` | `c880cd2164e1a9b9eff46c77d7e25aa9ffe0fa7ad843978755ff853a541c303a` |
| `ilaria/bench/imc_incremental_inference.py` | `fe4fb7b2118639d54dac62f5e31528e35b6495ba626169e1d87241cf2db6bd6d` |

Baseline manifest `.nexus-cache-budget-fix-baseline.json`:
`3621b71971c8347052cffc4a62be82db6f19d95180b1e181845378188c61d2bc`.
The parent copied the initial three public sources from the earlier worktree.
Changes here were confined to cache safety, discriminating tests and benchmark
instrumentation. Default forward/training, architecture presets, checkpoint keys
and model configuration serialization remain unchanged. Cache generation remains
explicitly opt-in; this handoff does not enable it by default.

## Fix and validation

Retained byte admission now recomputes unique physical tensor allocation capacity
plus Python snapshot metadata. It stamps cache/reservation counters, storage
capacity, strides and offsets; rejects non-positive/non-integer, stale and
understated accounting; and checks cache layer/token/KV sizes, dtypes and bounds
before reuse. Storage resizing without a tensor version change is detected.
Inference requires homogeneous supported floating model weights and consistent
layer compute configuration. Oversized prompt validation buffers are admitted
before allocation. Byte policy covers cache, metadata and specified staging;
it does not bound model residency, activations, SDPA workspace or whole process RAM.
Older caller-retained snapshots require a separate outer budget.

The initial safety regressions produced 7 failures / 7 passes against the copied
source: invalid counters reached layers, a stale string raised TypeError, malformed
tokens raised IndexError, and mixed model dtype reached a layer. The final cache
subset passes 148 tests, including restamped undercount, malformed state, capacity
shrink, token validation and CPU homogeneous FP64/FP32/FP16/BF16 fixture parity.
Low precision fixture tolerances are declared in tests; no GPU/general quality
claim follows. An independent child performed static review of model/cache tests
and found no actionable issue; it ran no executions.

Required gates: Python compilation PASS; `GOWORK=off`, `GOTOOLCHAIN=local`
`go test ./...` and `go vet ./...` PASS. Full IMC suite initially produced 187
passes / 8 failures because branch HEAD had a stale trainer. The coordinator,
not this agent, supplied exactly two read-only public dependencies:

- `forge/train_ilaria.py`: `3983a95cfe0843d39278fd8c791d2ba57804cecdd2b9e536d2b8101d94b7a621`.
- `forge/training_state.py`: `a6f75be748760c26a05c04f96dcdd0fb91a33207375d8a01f99a49479ef4d0f4`.
- Overlay manifest: `9bbd8a4c2bb23f2e05120eccecc2f0465a0d299915feff57569f8b6e9cd1dbba5`.

Full final IMC suite: **195 PASS**, 47.85 seconds. Final compilation and whitespace
checks pass. The coordinator's later P2P proof dependencies are read-only inputs,
outside agent editing claims; this handoff does not claim their implementation.

## Paired benchmark evidence

Evidence directory: `E:\nexus-training\evidence\inference-cache-review-20261002`.
Frozen baseline `main-original-imc-model.py` is SHA
`235bb86838afb8d467df2f4963efb588fa2cc0be9f80e434e020ca1451a92e45`.
Both modes verify 32 exact FP32 baseline forward/loss/gradient identity cases,
including checkpointing, and identical generated sequences. All timed samples
include prompt prefill/admission plus generation; setup is reported separately.

Tiny public fixture: CPU FP32, Torch 2.14.0+cpu, one thread, nine samples per path,
seed 0, floating and ternary. All eight tiny cases regress:

| Mode | Case | Baseline median ms | Cache median ms | Baseline/cache ratio |
| --- | --- | ---: | ---: | ---: |
| Floating | short | 1.441 | 3.765 | 0.383 |
| Floating | within window | 47.022 | 113.238 | 0.415 |
| Floating | rollover | 18.952 | 57.354 | 0.330 |
| Floating | above window | 12.949 | 38.198 | 0.339 |
| Ternary | short | 3.245 | 5.706 | 0.569 |
| Ternary | within window | 92.500 | 154.198 | 0.600 |
| Ternary | rollover | 39.448 | 77.094 | 0.512 |
| Ternary | above window | 26.386 | 51.079 | 0.517 |

Within window: one prefill / 23 decode steps for 24 new tokens. Rollover: all 12
steps rebuild; above window: all eight steps rebuild. Short emits one token.
Tiny benchmark active time 12.651 seconds; original tiny result has unavailable
RSS counters (no psutil), not measured process RAM. Its immutable JSON:
`cache-budget-fix-benchmark.json`, SHA
`fdcf072fd132d345278790f311dc24e21a0cb07a996f8dde01bbfb9cbcb1ba8d`.
The final benchmark adds a Windows own-process memory counter fallback.

Canonical IMC-125M preset: **125,882,112 parameters** per model, vocabulary 65536,
CPU FP32, two threads, three paired samples, seed 0, prompt 32 -> eight identical
new tokens, window 128, one prefill / seven decode steps. Baseline median **964.309
ms**, cached **552.024 ms**, ratio **1.747x** for this one case. Median CPU times:
1937.5 / 1093.75 ms. Paired setup 1.846 seconds; total active time including setup
and identity checks **11.332 seconds**, below the 120-second guard.

Two-model parameter storage: 1,007,056,896 bytes. Observed whole paired process
RSS: 1,351,925,760 bytes; process lifetime peak working set: 1,360,359,424 bytes,
below the enforced 2.5 GiB cap (2,684,354,560 bytes). Cache live snapshot peak:
1,064,494 bytes; admitted cache/staging peak: 2,704,285 bytes. RSS includes Torch,
both models and identity fixtures, and is not isolated operator memory. The mode
checks RAM admission before model allocation and live RSS/time at operation
boundaries. It is one preset pair, not an unbounded matrix or production workload.
The 120-second checks are cooperative, not a hard process-kill guarantee. The
active timer includes training identity checks and paired model setup; Python,
Torch and baseline-module imports occur before that timer and are excluded.

125M JSON: `cache-budget-fix-125m-benchmark.json`, SHA
`6a65713ba8e2e54f194af1a5e6236d9dca541cc15dddb103452ff79584fea844`.
Final full-suite log: `cache-budget-fix-overlay-pytest.txt`, SHA
`71f225dc910fe9ff619703d8163409b58b301e03022f475a8e8bbb59a3916c32`.
Raw paired sample wall/CPU times, per-step profiles and all configuration fields
remain in the JSON artifacts. Energy is unmeasured/null. Random-memory fixture
inference does not establish trained quality, IMC-1B results, deployment readiness,
GPU/mobile performance or a universal cache speedup.

## Acceptance boundary

The initial and final protected Main checks preserve all 91 public baseline paths,
Main HEAD and index SHA `321f80fa35a8cc903e6d1c9c074272042df29a8e31b9345efc8b0d958a7a5198`.
The original inference worktree was not modified. Root owns subsequent independent
review, P2P source pin/evaluation reconciliation and any explicit integration.
Historical P2P proof manifests are unchanged by this agent. No Main cache acceptance
or automatic enablement is claimed. Agent source editing has stopped.

## Assertion-check guard follow-up — 2026-10-01 22:20 UTC

STOP / FROZEN after the narrow proof-hardening correction. Current benchmark SHA:
`38a2afcfd78e3dbb24ae5ee5070abcdc68390ea5b747d8d264860391c9b455e8`.
This supersedes the earlier benchmark delivery pin, while the earlier measured
producer remains preserved exactly, before editing, at
`E:\nexus-training\evidence\inference-cache-review-20261002\imc-incremental-inference-producer-fe4fb7b.py`,
SHA `fe4fb7b2118639d54dac62f5e31528e35b6495ba626169e1d87241cf2db6bd6d`.
The timing artifacts and their earlier producer binding are unchanged.

At the start of `run()`, before argument validation, identity checks or model
allocation, optimized Python now raises:
`RuntimeError("benchmark requires assertion checks; Python -O is unsupported")`.
This applies to CLI and imported `run()` entry, preserving the assertion-based
parity checks required for benchmark PASS evidence. The production model and
test source pins above are unchanged. No timing, full-suite or Go gates were
repeated for this benchmark-only entry guard.

Validation: normal `--verify-only --threads 1` passed all 32 identity cases against
the same frozen baseline pin; `python -O --verify-only` exited 1 with the stated
reason; imported `run(None)` under `python -O` also exited 1 with that reason,
before attempting argument access or allocation. Scalar logs are
`cache-assertion-guard-normal.txt`, `cache-assertion-guard-optimized-cli.txt` and
`cache-assertion-guard-optimized-import.txt` in the evidence directory above.
Whitespace checks pass. Only benchmark and this handoff changed in this follow-up;
root owns any corresponding Main update. No further process remains running.
