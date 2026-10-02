# IMC incremental-inference preflight — 2026-10-01

State: source-only preflight COMPLETE, FROZEN for allocation; cache, implementation and performance remain PROPOSED. No model, suite, training, paid job or benchmark ran in this task.
Only this report is written. Canonical Forge/training/controller, network, mobile, MatVec and all other source claims remain unchanged.

Proved source: `forge/imc_model.py:253` greedily calls the complete `forward` on `out[-max_seq_len:]` for every next token; `hidden` recomputes every block and the LM head projects every prefix position.
`Attention.forward:158` projects Q/K/V anew, rotates them, expands GQA K/V and calls causal SDPA; it exposes no per-layer cache or absolute-position argument. `rope:135` starts positions at zero for each supplied tensor.
`linear:48` retains the canonical floating/ternary projection paths; KV caching would not by itself cache repeated ternary weight quantization or integrate the Go packed MatVec kernel.
Inspected `runtime/cmd/internal` consumers expose no `generate_greedy`/`load_imc` call. `runtime/isxprobe/peer.py:148,195` instantiates the canonical tiny IMC and measures full-sequence NLL/anchors, not a production token-decoding service.
MASTER_PLAN §21 explicitly lists quantized KV cache and packed deployment as work toward eligible-device residency; these are objectives, not this preflight's completed capabilities.

Decision: a genuine incremental cache cannot be added safely through the current public API without modifying canonical Forge. A monkey-patched runtime attention/model would duplicate the architecture and is excluded.
One proposed route: extend the SAME `rope`, `Attention`, `Block` and `ImcTransformer` with explicit inference state, then let opt-in greedy generation prefill once and evaluate only newly accepted tokens.
Keep default `forward(ids, targets)`/loss/checkpointing, PRESETS, state_dict parameter names and persisted ImcConfig schema unchanged; inference policy/state is separate from architecture/training identity.
Prefill may project only the final hidden position through the tied LM head; cached decoding uses the same canonical projections, RMSNorm, GQA, sub-norm and FFN, not another attention implementation.
Explicit positions must match the oracle's positions. Cached queries must attend to their permitted past plus current chunk; offset-aware causality must be proved for query-length != key-length, not inferred from the existing square SDPA call.
Critical rollover: the existing cropped window resets positions and recomputes surviving tokens' hidden states. Dropping/rebasing old K/V alone cannot preserve that multilayer oracle; invalidate and prefill the whole cropped window on EACH rollover (potentially every token at capacity).

Proposed exact future claims: existing `ilaria/forge/imc_model.py`, existing `ilaria/forge/test_imc_model.py`, NEW `ilaria/bench/imc_incremental_inference.py` (absent at inspection).
No change to `runtime/isxprobe/peer.py`, trainer, controller, checkpoint format, OS authority or network protocol is required for this isolated library experiment. Root must release/reassign the frozen Forge claims before implementation.
Policy is opt-in and host-configured: max cache bytes, tokens <= max_seq_len, max batch, deadline/cancellation and supported compute dtype; validate/admit before allocation and account actual allocated capacities, not just live tokens.
Store unexpanded per-layer GQA K/V in the SAME dtype as canonical projections; bind state to model/weights epoch, config, device/dtype, batch streams, prefix and position. No cross-request mutable global cache, disk persistence or prompt/features logging.
V1 eviction is whole-run invalidation and canonical full-prefix fallback/rebuild, never silent removal of attended history. Model/epoch/device/dtype/batch mismatch rejects state; cancellation/failure drops staged state without publishing partially advanced layers or tokens.
Raw KV bytes = 2 × layers × batch × kv_heads × tokens × head_dim × element_size. Existing tiny fixture needs 4,096 FP32 bytes at B=1,T=16; IMC-1B at B=1,T=2048 would need 128 MiB FP32 or 64 MiB FP16/BF16 raw KV ONLY, not measured total RAM.
Include metadata, allocator capacity, prefill activations, repeated-head temporaries and model residency in memory admission/measurement. Quantized KV is deferred to a separate quality gate; packed weight bytes do not establish cache precision or model footprint.

Discriminating acceptance: compare every next-token logit with the SAME frozen model's uncached full-prefix oracle; predeclare justified per-dtype tolerance (initial CPU FP32 target atol/rtol 1e-5) and require identical greedy token sequences, EOS/stopping and no extra decode after EOS.
Cover floating AND ternary paths, both FFN gates, sub-norm on/off, multiple seeds/prefixes, GQA shapes, prefill/chunk/single-token decoding and tie-sensitive examples; tolerant logits alone cannot excuse a changed token sequence.
Batch B=1 and B>1 must match independent streams; unsupported ragged batches fail explicitly. No cache leakage between streams/models and no accidental reuse after weights/config/dtype/device change.
Test prefixes below/at/above context capacity, all positions/chunk boundaries and repeated rollover; assert rebuild behavior plus parity, including deeper-layer state. A wrong RoPE offset or rectangular causal mask must fail a constructed regression.
Inject cancel before prefill, between layers and before token/state publication; assert bounded allocation, no partially advanced state, no further work after cancellation, and reproducible retry with a fresh cache. Test budget rejection and eviction fallback explicitly.
Future paired benchmark uses canonical random-initialized IMC and public synthetic token IDs, based on `test_imc_model.py:16` tiny config (vocab64,width32,layers2,heads4,kv2,ffn48), with declared context sweeps and no checkpoint/corpus access.
Measure end-to-end prompt→identical completion before/after, including cache admission/allocation and prefill; separately report setup, prefill, decode, actual tokens, wall/CPU time, thread count, sample distribution, total/peak RAM and allocated cache bytes where measurable.
Report rollover and short-sequence regressions honestly; cache may be slower and exact rollover may erase its benefit. Do not substitute a MatVec microbenchmark for transformer inference.
Energy/Joules and power-counter evidence are UNMEASURED here; runtime scheduling/resource limits remain caller-owned. No trained IMC-1B, mobile support, device residency, universal gain or end-to-end quality is claimed.

Read-only source SHA256 snapshots (unchanged at report creation):
- `AGENTS.md`: `14cb7cc77fee717459d4485297371c507ede16c4fe46a6fa9d9712c8cacfca37`
- `ilaria/AGENTS.md`: `e5ef7269b9b201ff4717b2be5214c8e121f4d86a9867e53a45d3f64d6bf0ff41`
- `ilaria/forge/imc_model.py`: `235bb86838afb8d467df2f4963efb588fa2cc0be9f80e434e020ca1451a92e45`
- `ilaria/forge/test_imc_model.py`: `1fcf98470153cddab8eb2404e25a7b771283144c347a0b167749285fd0c5a83c`
- `ilaria/runtime/isxprobe/peer.py`: `e657632cbaa2b2e7738529c3ecb93ade41958de5fe50be5d345f1be6feafa06e`
- `ilaria/docs/plans/MASTER_PLAN.md`: `b37802af976ff811ad2382458c57d9b9d3fdc42f10e9860a1576cc81804357dc`
