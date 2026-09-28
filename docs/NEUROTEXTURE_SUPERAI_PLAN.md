# Ilaria NeuroTexture Super-AI Plan

> Status: architecture and research roadmap.  
> Goal: turn Ilaria from a brain-inspired local cognitive engine into a fast, sparse, memory-rich language-and-reasoning system.

This document is intentionally ambitious, but it must remain honest: the goal is not to claim that Ilaria already beats frontier LLMs. The goal is to define a path where it can become faster, more adaptive, and more memory-efficient than classical dense LLMs in targeted domains, then expand from there.

---

## 1. Core Thesis

Ilaria should not copy a dense transformer LLM.

The winning direction is:

```text
Ilaria Super-AI
= persistent memory
+ sparse ternary NeuroTexture weights
+ expert routing
+ associative Brain
+ symbolic verifier
+ Broca 2.0 language core
+ replay/sleep consolidation
+ strict benchmarks
```

A dense LLM keeps most of its knowledge inside weights and must run a large matrix-heavy model for every generated token.

Ilaria should use:

```text
RAM    = active context, hot cache, active experts, routing index
VRAM   = Broca 2.0 / hot NeuroTexture kernels
NVMe   = cold experts, episodic memory, semantic memory, checkpoints
CPU    = routing, retrieval, symbolic reasoning, cache orchestration
GPU    = fast generation and packed ternary compute where available
```

The advantage is not raw dense scale. The advantage is sparse activation, persistent learning, external memory, and low-bit packed compute.

---

## 2. Research Anchors

These research directions support the plan:

### 2.1 Ternary / low-bit neural weights

Relevant direction: BitNet b1.58 and related low-bit models.

Key lesson:

```text
Ternary weights {-1, 0, +1} can drastically reduce memory and arithmetic cost.
```

Ilaria already has the foundation:

```text
TernaryTile = RGBA32 uint32
16 ternary weights per 4 bytes
```

This gives approximately:

```text
0.25 bytes / weight
16x smaller than float32 weights
4x smaller than int8 weights
```

### 2.2 Sparse Mixture-of-Experts

Relevant direction: Switch Transformer, GLaM, DeepSeek-style sparse MoE.

Key lesson:

```text
A model can have many stored parameters but activate only a small fraction per token/query.
```

For Ilaria:

```text
Do not run all experts.
Route input to top-k experts.
Keep cold experts on disk.
Cache hot experts in RAM/VRAM.
```

### 2.3 Lookup-table and logic-based neural networks

Relevant direction: LUT-NN, SparseLUT, logic-gate networks, FPGA/edge inference.

Key lesson:

```text
Some neural computation can be replaced with lookup, bit operations, popcount, cache hits, and logic.
```

For Ilaria:

```text
RGBA32 tile read
AND / mask / sign
popcount
add/subtract
cache result
```

### 2.4 Associative memory and hyperdimensional computing

Relevant direction: modern Hopfield networks, dense associative memory, HDC.

Key lesson:

```text
Not all knowledge needs to live inside model weights.
Large memory stores plus similarity retrieval can reduce parameter pressure.
```

For Ilaria:

```text
EpisodicMemory + SemanticMemory + SDR retrieval are strategic assets.
```

### 2.5 Continual learning and catastrophic forgetting

Relevant direction: replay, consolidation, elastic weight protection, sleep-like replay.

Key lesson:

```text
Continuous plasticity without replay/consolidation destroys old knowledge.
```

For Ilaria:

```text
Sleep() must become a real consolidation phase:
- replay old memories
- merge plasticity journals
- prune weak paths
- protect important synapses
- distill episodic memory into semantic memory and experts
```

---

## 3. What Ilaria Has Now

Current strengths:

```text
- TernaryLayer using RGBA32 packed ternary weights
- Brain associative synapses: uint16 weights between word neurons
- Episodic and semantic memory
- Symbolic reasoning shim
- Feedback, reward, emotion, sleep modules
- FractalCortex with multiple cortex blocks
- WebLearner with SSRF hardening
- Dashboard hardened enough for local development
```

Current limitations:

```text
- Broca 1.0 is not a true fluent language generator
- FractalCortex currently runs blocks by voting, not scalable top-k expert routing
- MaxFractalBlocks is small
- No unified checkpoint format for all model state
- No proper tokenizer / autoregressive training loop
- No NeuralFabric with millions/billions of virtual neurons
- Benchmark is still too small for capability claims
```

---

## 4. NeuroTexture: The Core Format

### 4.1 Definition

A NeuroTexture is a raw packed neural texture, not a PNG.

```text
NeuroTexture = raw RGBA32 tensor-like page
Pixel        = TernaryTile uint32
Tile         = 16 ternary weights
Weight       = {-1, 0, +1}
```

Current tile layout should remain:

```text
R byte = sign bits for weights 0-7
G byte = mask bits for weights 0-7
B byte = sign bits for weights 8-15
A byte = mask bits for weights 8-15
```

Interpretation:

```text
mask=0          => weight = 0
mask=1, sign=0  => weight = +1
mask=1, sign=1  => weight = -1
```

### 4.2 Why not PNG?

PNG is useful for visualization, not primary storage.

Do not store trainable weights primarily as PNG because:

```text
- decompression adds overhead
- exact byte layout can become indirect
- mmap is harder
- GPU upload path is less direct
- metadata/checksum/versioning are awkward
```

Use a raw format:

```text
.ntx / .ntex = direct raw NeuroTexture checkpoint page
.png         = optional visualization/export only
```

---

## 5. Proposed File Format: NTX1

Create a package:

```text
cortex/neurotexture/
  format.go
  mmap.go
  pack.go
  lookup.go
  cache.go
  journal.go
```

Header proposal:

```go
type Header struct {
    Magic      [4]byte // "NTX1"
    Version    uint16
    HeaderSize uint16
    Width      uint32 // tiles per row
    Height     uint32 // output rows / neurons
    Layout     uint16 // RGBA_TERNARY_V1
    Flags      uint16
    TileCount  uint64
    Checksum   uint64
}
```

Data immediately follows:

```text
[]uint32 raw RGBA32 TernaryTile data
```

Layer layout:

```text
width  = TilesPerRow
height = OutputSize
index  = row * width + col
```

---

## 6. TileStore Abstraction

Do not tie all computation to `[]TernaryTile` forever.

Introduce:

```go
type TileStore interface {
    Width() int
    Height() int
    Tile(row, col int) TernaryTile
    Row(row int) []TernaryTile
    Close() error
}
```

Implementations:

```text
RAMTileStore       = current in-memory slice
MMapTileStore      = memory-mapped .ntx file
GPUTileStore       = WebGPU buffer/texture representation
CompressedTileStore = skip empty tiles / sparse tile pages
```

Migration path:

```text
TernaryLayer.Tiles []TernaryTile
    -> TernaryLayer.Store TileStore
    -> compatibility wrapper for existing code
```

---

## 7. Compute Strategy: Avoid Heavy Matrix Multiplication

The target is not zero computation. The target is minimal computation.

### 7.1 Sparse input path

For SDR-like sparse input:

```text
active_indices = ~50 out of 10,000
```

Only process active positions.

### 7.2 Bit operations per tile

For each tile:

```text
positive_mask = mask & ~sign
negative_mask = mask & sign
```

For binary active masks:

```text
contribution = popcount(positive_mask & active_mask)
             - popcount(negative_mask & active_mask)
```

For signed/int16 values:

```text
weight +1 => add input value
weight -1 => subtract input value
weight  0 => skip
```

### 7.3 LUT strategy

Do not build impossible global LUTs.

Build small hot caches:

```text
popcount_table[65536]
hot_tile_cache[(tile_hash, active_mask)] -> contribution
sdr_cache[input_sdr_hash] -> output_sdr
expert_cache[(expert_id, input_hash)] -> expert_output
response_cache[(intent_hash, context_hash)] -> response plan
```

---

## 8. Expert Atlas

Each expert becomes an atlas directory:

```text
experts/
  expert_biology_ro_001/
    metadata.json
    feature.ntx
    gate.ntx
    input_projection.ntx
    output_projection.ntx
    vocab_adapter.ntx
    plasticity.log
    stats.json
```

Metadata:

```json
{
  "expert_id": "biology.ro.001",
  "domains": ["biology", "romanian"],
  "version": 1,
  "sdr_size": 10000,
  "active_count": 50,
  "confidence": 0.0,
  "usage_count": 0,
  "last_used_unix": 0,
  "files": {
    "feature": "feature.ntx",
    "gate": "gate.ntx",
    "input_projection": "input_projection.ntx",
    "output_projection": "output_projection.ntx"
  }
}
```

---

## 9. Expert Router

Current FractalCortex voting runs all blocks. That will not scale.

Replace all-block voting with top-k routing:

```text
input -> Wernicke/SDR -> Router -> top-k experts -> merge/vote -> verifier
```

Router scoring:

```text
score = semantic_similarity
      + episodic_hit_score
      + expert_domain_match
      + recent_success_score
      + confidence_prior
      - latency_penalty
```

Routing modes:

```text
top-1 = fastest
top-2 = balanced
top-4 = quality
top-k dynamic = based on uncertainty
```

Acceptance target:

```text
For most local queries, activate <= 4 experts.
Never scan all experts except maintenance/evaluation.
```

---

## 10. Plasticity Journal

Do not rewrite huge `.ntx` files after every learning event.

Instead write delta events:

```text
plasticity.log
  timestamp
  expert_id
  layer_id
  tile_index
  old_tile
  new_tile
  reason
  reward
  confidence
```

During online operation:

```text
read base .ntx + apply hot journal deltas in memory
```

During Sleep():

```text
merge journal -> new .ntx
recompute checksum
compact empty tiles
prune low-value deltas
archive old checkpoint
```

---

## 11. Continuous Plasticity Rules

Ilaria needs a real plasticity engine.

Implement:

```text
Hebbian strengthen
LTP / LTD from feedback
STDP-like timing traces
reward-modulated update
surprise/error-modulated update
homeostatic normalization
synaptic decay
importance protection
```

Simple rule:

```text
delta = local_activity * eligibility_trace * modulatory_signal
```

Modulatory signals:

```text
Reward       -> dopamine-like positive signal
ErrorLearner -> correction/error signal
Curiosity    -> novelty signal
Emotion      -> global state modulation
Confidence   -> learning gate
```

---

## 12. Sleep Consolidation Upgrade

Sleep must become central.

Current sleep should evolve into:

```text
1. sample old episodic memories
2. replay them through experts
3. protect high-importance synapses
4. merge plasticity journals
5. prune weak/noisy paths
6. distill repeated episodes into semantic memory
7. spawn/split/merge experts if needed
8. run regression benchmark before accepting checkpoint
```

Sleep acceptance rule:

```text
Never commit a new checkpoint if hidden benchmark regresses beyond threshold.
```

---

## 13. Broca 2.0

Current Broca 1.0 is associative and SDR-based. It is fast, but not enough for fluent language.

Broca 2.0 should be:

```text
tokenizer + small autoregressive generator + Cortex context injection
```

Target for current hardware:

```text
50M -> 150M parameters first
4-bit / ternary where possible
small context
fast local inference
```

Broca 2.0 should not hold all knowledge. It should verbalize what Cortex decides.

Pipeline:

```text
User input
  -> Wernicke / SDR
  -> episodic + semantic retrieval
  -> expert routing
  -> reasoning/verifier
  -> structured answer plan
  -> Broca 2.0 fluent realization
  -> verifier pass
  -> final answer
```

---

## 14. Tokenizer Plan

Create:

```text
cortex/tokenizer/
  trainer.go
  bpe.go
  vocab.go
  encode.go
  decode.go
```

Requirements:

```text
- Romanian + English
- 32k vocabulary target
- byte fallback
- deterministic encode/decode
- stores vocab and merges in checkpoint
```

Training corpus:

```text
- curated Romanian text
- curated English text
- Q&A pairs
- domain-specific documents
- synthetic instruction examples only if clearly labeled
```

---

## 15. Benchmark Arena

No capability claim without benchmark.

Create:

```text
cmd/cortex-arena/
  main.go
```

Benchmark categories:

```text
- factual QA Romanian
- factual QA English
- refusal / unknown questions
- contradiction detection
- arithmetic / symbolic reasoning
- multi-turn memory
- learning-after-feedback
- retention-after-sleep
- hallucination traps
- language fluency
- latency and memory use
```

Minimum benchmark sizes:

```text
smoke:       50 cases
hidden-dev:  500 cases
serious:     1000+ cases
```

Metrics:

```text
accuracy
exact match
semantic match
refusal precision
refusal recall
hallucination rate
latency p50/p95
RAM peak
VRAM peak
cache hit rate
learning retention
regression after sleep
```

---

## 16. Hardware-Aware Plan for 16 GB RAM / 6 GB VRAM

Do not target dense frontier LLM locally.

Target:

```text
small active model
large external memory
sparse experts on disk
hot cache in RAM
hot generator in VRAM
```

Practical target:

```text
Broca 2.0: 50M-150M parameters
Expert active set: top-1 to top-4
NeuroTexture store: mmap on NVMe
Runtime RAM budget: < 8 GB for core system
VRAM budget: < 5 GB for generator/hot kernels
```

---

## 17. Implementation Phases

### Phase 0 — Freeze UI Work

Only security-critical UI fixes from now on.

No more dashboard feature expansion until the intelligence pipeline improves.

Acceptance:

```text
UI remains local-secure.
No new UI work unless it supports training/evaluation.
```

### Phase 1 — NeuroTexture v1

Build:

```text
cortex/neurotexture/format.go
cortex/neurotexture/pack.go
cortex/neurotexture/mmap.go
```

Acceptance:

```text
Can export a TernaryLayer to .ntx.
Can import .ntx back with identical tiles.
Checksum validation works.
Fuzz test corrupt .ntx headers.
```

### Phase 2 — TileStore Integration

Build TileStore and adapt TernaryLayer.

Acceptance:

```text
Existing TernaryLayer tests still pass.
RAMTileStore works.
MMapTileStore works.
ForwardSparse works through TileStore.
```

### Phase 3 — LUT and Cache Engine

Build:

```text
TileLUT
SDR output cache
expert output cache
```

Acceptance:

```text
Benchmark shows speedup on repeated/similar inputs.
Cache invalidates correctly after plasticity updates.
```

### Phase 4 — Expert Atlas and Router

Build:

```text
ExpertAtlas
ExpertMetadata
ExpertRouter
TopK routing
```

Acceptance:

```text
FractalCortex can route top-k instead of always voting all blocks.
Latency decreases as expert count grows.
Quality does not regress beyond benchmark threshold.
```

### Phase 5 — Plasticity Journal

Build:

```text
plasticity.log
journal replay
journal merge during Sleep
```

Acceptance:

```text
Online learning writes deltas, not full checkpoints.
Sleep merges deltas into .ntx.
Recovery after crash replays journal safely.
```

### Phase 6 — Broca 2.0 Prototype

Build tokenizer and minimal autoregressive generator.

Acceptance:

```text
Can train tokenizer.
Can train tiny generator on small corpus.
Can generate grammatical short text.
Can condition on Cortex answer plan.
```

### Phase 7 — Benchmark Arena

Build `cmd/cortex-arena`.

Acceptance:

```text
At least 500 hidden-dev cases.
Tracks quality and speed.
Fails degenerate output: ?, empty, punctuation-only.
Compares against at least one local LLM baseline.
```

### Phase 8 — Scale Ladder

Scale only after benchmarks show gains.

Targets:

```text
1M virtual neurons / 10M synapses
10M virtual neurons / 100M synapses
100M virtual neurons / 1B synapses
```

Acceptance:

```text
No catastrophic forgetting.
Latency stays within budget.
Memory stays within hardware budget.
Hidden benchmark improves or remains stable.
```

---

## 18. Experiments to Run First

### Experiment A — RGBA32 vs int8 vs float32

Compare:

```text
TernaryLayer ForwardSparse
int8 dense baseline
float32 dense baseline
```

Settings:

```text
SDRSize = 10,000
ActiveCount = 50
OutputSize = 10,000
```

Measure:

```text
latency
RAM
CPU utilization
output stability
```

### Experiment B — Cache Hit Performance

Add:

```text
input_sdr_hash -> output_sdr
```

Measure:

```text
cache hit rate
latency reduction
accuracy impact
```

### Experiment C — Top-k Experts

Compare:

```text
all-block voting
top-1
top-2
top-4
```

Measure:

```text
latency
accuracy
confidence
hallucination/refusal behavior
```

### Experiment D — Plasticity Stability

Train on A, then B, then retest A.

Measure:

```text
forgetting rate
recovery after sleep
memory retention
expert specialization
```

---

## 19. Non-Negotiable Rules

1. Do not claim Ilaria beats LLMs without benchmark evidence.
2. Do not scale parameters before routing and benchmark are stable.
3. Do not keep all experts active.
4. Do not store trainable weights mainly as PNG.
5. Do not let online learning overwrite stable memory without replay.
6. Do not accept a new checkpoint if hidden benchmark regresses badly.
7. Keep everything local-first and hardware-aware.

---

## 20. Short-Term TODO Checklist

```text
[ ] Add cortex/neurotexture package
[ ] Add NTX1 header and raw tile serialization
[ ] Add export/import tests for TernaryLayer -> .ntx -> TernaryLayer
[ ] Add fuzz tests for .ntx headers
[ ] Add TileStore interface
[ ] Add RAMTileStore and MMapTileStore
[ ] Add ForwardSparse benchmark suite
[ ] Add SDR cache prototype
[ ] Add ExpertMetadata and ExpertRouter
[ ] Convert FractalCortex to top-k routing mode
[ ] Add PlasticityJournal
[ ] Upgrade Sleep() to merge journals
[ ] Start tokenizer package
[ ] Define Broca 2.0 architecture spec
[ ] Build cortex-arena benchmark command
[ ] Expand hidden benchmark to 500+ cases
```

---

## 21. Final Direction

The target architecture is:

```text
Ilaria
  -> Wernicke / SDR encoder
  -> episodic + semantic retrieval
  -> ExpertRouter top-k
  -> NeuroTexture experts
  -> symbolic/verifier layer
  -> Broca 2.0 fluent generator
  -> feedback / plasticity journal
  -> Sleep consolidation
```

This is the path that best matches the existing technology:

```text
RGBA32 ternary weights
+ sparse SDR activation
+ persistent memory
+ plasticity
+ local hardware constraints
```

If Ilaria becomes powerful, it will not be because it imitates a dense LLM. It will be because it uses a different computational contract:

```text
less dense math
more memory
more routing
more sparsity
more plasticity
more verification
```
