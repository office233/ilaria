# ILARIA GENESIS RGBA — MASTER ARCHITECTURE & TRAINING SPEC

**Status:** architecture / research execution contract  
**Date:** 2026-09-28  
**Program:** SwypikOS / Ilaria / Swyp Lang  
**Goal:** build a from-scratch, first-party cognitive foundation system whose large synaptic matrices are native Ilaria RGBA ternary weights, with persistent memory, dynamic cortical growth, verifiable agentic execution and opt-in P2P training on centrally curated data.

---

## 0. Non-negotiable constraints

1. **No BitNet dependency.** Do not import Microsoft BitNet weights, architecture code, training checkpoints, tokenizer, model implementation, or naming into the production Ilaria architecture.
2. **From scratch.** Foundation weights start from random initialization. Third-party models may be used only as external evaluation baselines unless an explicit later ADR allows a teacher for a narrow experiment.
3. **Ilaria RGBA is first-party.** The core physical synapse format is the repository's RGBA32 ternary concept: 16 {-1,0,+1} synapses packed in one uint32, with sign and active-mask planes.
4. **No user-content training by default.** SwypikOS user files, prompts, chats, browser history, documents, images, audio and local memories are excluded from global training. P2P nodes train only on signed data/jobs supplied by Ilaria infrastructure.
5. **Opt-in compute only.** Contributed CPU/GPU/NPU is explicit, revocable, resource-governed, sandboxed and yields immediately to the user.
6. **No direct untrusted weight mutation.** A P2P worker can produce candidate updates, experts, rollouts, eval results or pseudo-gradients. Nothing touches a production checkpoint before independent verification and promotion.
7. **No "smartest in the world" claim without reproducible evidence.** The engineering target is frontier capability; the release gate is benchmark evidence.
8. **Originality is an engineering goal, not a legal assertion.** Standard primitives such as attention, normalization, MoE, STE or positional methods have prior art. Any patent/novelty claim requires an independent prior-art review.

---

# 1. System identity

The new system is not "an LLM plus memory".

It is a single cognitive lifecycle:

**Ilaria = Cortex + Synapses + Working Memory + Hippocampus + Semantic Memory + Prefrontal Deliberation + Fractal Cortex + Thousand Brains + Cerebellum + Predictor/World Model + Self Model + Confidence + Reward/Curiosity + Sensory Cortices + Motor/Tool Cortex + Sleep/Consolidation + Verifier Interface.**

SwypikOS owns authority and side effects. Ilaria proposes and reasons. Swyp Lang expresses typed plans/contracts. The verifier proves what actually happened.

High-level flow:

~~~text
perception / text / OS state / tools
            |
            v
     Wernicke / Sensory Cortex
            |
            v
      Ilaria Cortex Trunk
      |      |       |
      |      |       +--> Predictor / World Model
      |      +----------> Working Memory
      +-----------------> Hippocampus retrieval
            |
            v
      Fractal Cortex MoE
   (dynamic cortical experts)
            |
     uncertainty / novelty
       /            \
      v              v
Prefrontal loop   Thousand-Brains
(recurrent think)  hypotheses/vote
       \             /
        v           v
        Global Workspace
             |
       +-----+-----+
       |           |
       v           v
   Language     Swyp Action Head
    Head       typed plan/effects
       |           |
       +-----+-----+
             |
          Verifier
             |
        final response
~~~

---

# 2. Ilaria RGBA synapse

## 2.1 Frozen/inference representation

Reuse and formalize the existing first-party RGBA packing:

- one uint32 = one RGBA32 tile;
- 16 ternary synapses per tile;
- R = sign bits 0..7;
- G = active mask 0..7;
- B = sign bits 8..15;
- A = active mask 8..15;
- mask=0 means exact zero and allows compute skip;
- mask=1/sign=0 means +1;
- mask=1/sign=1 means -1.

Physical storage: **2 bits/synapse**, exactly 0.25 bytes/parameter for packed large matrices.

The production name is **Ilaria Synapse Tile (IST32)**. It is not described as BitNet.

## 2.2 Synaptic metadata

Large frozen weights remain IST32. Plastic/training state is separate:

- **ConfidenceTile32:** 2-bit confidence state per synapse, 16 synapses/uint32;
- **GainPlane:** FP16/BF16 output-channel gain, one scalar per output channel or per small output group;
- **Usage/Age:** optional compressed statistics used by consolidation/pruning, not required in hot-path inference;
- **MasterWeight:** BF16 shadow parameter used only while training a synapse/expert;
- **Optimizer state:** sharded/offloaded training-only state.

A deployed frozen expert may strip Confidence/Master/Optimizer planes entirely.

## 2.3 Ternary training rule

Do not use another model's quantizer. Implement **Ilaria Synaptic Quantization (ISQ)**:

For each trainable matrix/group:

- maintain BF16 latent master value z;
- learn or schedule threshold tau;
- forward synapse q(z):
  - +1 if z > tau;
  - -1 if z < -tau;
  - 0 otherwise;
- forward uses packed IST32 values;
- backward uses a bounded straight-through estimator;
- output gain is learned separately;
- sparsity pressure is explicit and measurable.

Initial research grid:

- zero-rate targets: 25%, 40%, 50%, 60%, 70%;
- gain granularity: tensor, output-row, output-group-64;
- tau: fixed percentile, EMA-derived, learned bounded scalar;
- STE clip windows: 1.0, 1.5, 2.0 normalized units.

Promotion is based on downstream quality + stability + throughput, not on bit-count marketing.

## 2.4 Dual activation representation

Use two simultaneous activation views:

### Pulse8
Signed int8 amplitude stream for semantic computation.

- per-token/group absmax scale;
- int8 x ternary -> int32 accumulate;
- zero weights skipped;
- one fused gain/dequant at output.

### SpikeMask
Sparse binary/SDR projection of hidden state for:

- expert routing;
- hippocampus search;
- working-memory salience;
- semantic cache;
- novelty detection;
- confidence-weighted sparse paths.

This lets Ilaria keep high-capacity continuous semantics while exploiting AND/popcount paths where binary sparsity is appropriate.

---

# 3. Reference foundation configuration

The initial frontier target is **Ilaria Genesis RGBA-157B-A18B**.

## 3.1 Core dimensions

- decoder/cortex stages: 80;
- model width d_model: 6144;
- vocabulary: 131,072;
- token embedding: tied unless ablation disproves it;
- query heads: 48;
- KV heads: 8;
- head dimension: 128;
- shared FFN width: 3072;
- routed experts per layer: 48;
- expert FFN width: 2048;
- experts active/token/layer: top-2;
- norm: pre-norm; exact norm family selected by 350M/1.5B ablation;
- context curriculum: 8K -> 32K -> 128K effective context;
- dense 128K attention is forbidden; use hierarchical/sparse context.

Approximate parameter accounting, excluding tiny router/norm metadata:

- attention per layer: ~88.1M;
- shared FFN per layer: ~56.6M;
- one expert per layer: ~37.75M;
- 48 experts/layer across 80 layers: ~145.0B;
- attention across 80 layers: ~7.05B;
- shared FFN across 80 layers: ~4.53B;
- tied 131K embedding: ~0.805B;
- total: **~157.3B parameters**;
- active with top-2 routing: **~18.4B parameters/token**.

Packed synaptic storage at 2 bits is ~39.3 GB for 157.3B ternary weights before non-ternary embeddings/gains/norm/router metadata.

This is a design target, not a measured runtime claim.

---

# 4. Cortical growth / neurogenesis

This is the central mechanism for "weights grow while the system is alive".

With the same 80x6144 trunk and top-2 routing:

| Experts/layer | Approx total params | Approx active/token |
|---:|---:|---:|
| 16 | 60.7B | 18.4B |
| 24 | 84.9B | 18.4B |
| 32 | 109.0B | 18.4B |
| 48 | 157.3B | 18.4B |
| 64 | 205.7B | 18.4B |

Therefore capacity can grow substantially without increasing the selected-expert compute per token.

## 4.1 Neurogenesis trigger

A new expert is proposed only when a persistent failure cluster exists:

- high prediction error;
- high verifier failure;
- high entropy/low confidence;
- router overload;
- repeated domain-specific misses;
- new curated domain/date/language slice;
- catastrophic interference risk in existing experts.

Do not spawn from a single user query.

## 4.2 Expert birth

New expert initialization candidates:

1. clone best parent expert + 2-10% controlled ternary perturbation;
2. centroid/merge of two complementary experts then perturb;
3. random master init for genuinely new domain;
4. distilled initialization from a validated expert ensemble using curated activation capsules.

Router exposure starts near zero and ramps after validation.

## 4.3 Expert promotion

Candidate -> offline eval -> adversarial eval -> load-balance eval -> shadow traffic -> canary -> promoted manifest.

A failed expert is discarded without touching the production model.

---

# 5. Cortical layer

Each of the 80 stages implements an **Ilaria Cortical Cell (ICC)**.

Reference dataflow:

~~~text
x
|
+--> Norm
|     |
|     +--> Context Field Attention
|             - local window
|             - retrieved landmark blocks
|             - GQA
|             - RGBA Q/K/V/O synapses
|     |
|     +--> residual
|
+--> Hippocampal Gate (selected stages only)
|     - retrieve episodic/semantic vectors
|     - confidence/salience filter
|     - gated residual injection
|
+--> Norm
|     |
|     +--> Shared RGBA FFN
|     |
|     +--> SDR Router
|           -> select top-2 cortical experts
|     |
|     +--> Expert 1 RGBA FFN
|     +--> Expert 2 RGBA FFN
|     |
|     +--> weighted merge
|
+--> Predictor auxiliary tap
+--> Confidence auxiliary tap
|
v
next stage
~~~

## 5.1 Context Field Attention

Do not maintain dense quadratic attention over 128K.

Reference policy:

- local sliding context: 4K tokens;
- sequence split into blocks;
- each block emits compact landmark/state tokens;
- SDR/block router selects a small number of remote blocks;
- every N stages allow broader sparse attention;
- long-term facts/events are delegated to Hippocampus/SemanticMemory rather than permanently occupying KV cache.

The 128K target is effective accessible context, not 128K x 128K dense attention.

## 5.2 SDR expert router

Hidden state -> sparse route code:

- normalized hidden projection;
- signed/binary threshold into an SDR;
- compare against expert prototype SDRs using AND + popcount;
- combine similarity + load + confidence + recency;
- select top-2.

Router must have a trainable differentiable surrogate during pretraining, while inference compiles to the sparse/popcount form if parity gates pass.

---

# 6. Brain regions and ownership

## 6.1 Wernicke Cortex — comprehension

Rebuild current Wernicke into a learned interface, while retaining deterministic linguistic helpers.

Responsibilities:

- tokenize/segment;
- build semantic SpikeMask;
- detect language;
- extract entities/relations/intent candidates;
- produce salience map;
- send text + structured OS/browser/tool observations to the main cortex.

Do not let Wernicke independently answer the user.

## 6.2 Broca Cortex — generation

Broca becomes an output controller, not a second brain.

Responsibilities:

- language decoding;
- style/language selection;
- constrained decoding;
- citation/evidence formatting;
- switch between natural-language head and typed Swyp head.

## 6.3 Working Memory

Keep small, high-salience, volatile state.

Store:

- current goal;
- subgoals;
- assumptions;
- active tool observations;
- unresolved contradictions;
- important retrieved memories;
- verifier status.

Use relevance + decay + refresh; do not stuff full conversation transcripts into working memory.

## 6.4 Hippocampus — episodic memory

Preserve the current first-party concept and redesign storage for scale.

Each memory record:

- compact semantic/SDR key;
- dense retrieval vector if needed;
- content-addressed payload reference;
- temporal metadata;
- source/provenance;
- confidence;
- strength;
- age;
- task/session scope;
- privacy scope;
- consolidation state.

Indexes:

- inverted SDR bit index;
- lexical/keyword index;
- vector ANN index;
- temporal index;
- source/provenance index.

The hippocampus must support one-shot write without changing foundation weights.

**Personal hippocampus is local and never uploaded for global training by default.**

## 6.5 Semantic Memory

Consolidates repeated/high-confidence episodes into stable concepts.

Use:

- prototype representation;
- evidence count;
- source diversity;
- contradiction set;
- confidence;
- validity interval / freshness.

Mature concepts are not mutated by one low-confidence observation.

## 6.6 Cerebellum

Fast-path execution cache for stable procedures.

Cache:

- recognized task pattern;
- validated Swyp plan;
- verified tool sequence;
- expected preconditions;
- result schema;
- confidence;
- invalidation conditions.

A cache hit may skip expensive prefrontal deliberation, but never bypass SwypikOS capabilities or verifier checks.

## 6.7 Prefrontal Cortex

Adaptive-depth reasoning.

Hard tasks trigger recursive latent deliberation using shared RGBA blocks:

- generate candidate latent plan;
- predict result;
- compare confidence/contradictions;
- retrieve memory/tool evidence;
- iterate until:
  - confidence threshold;
  - verifier-ready plan;
  - compute budget exhausted.

Easy tasks should exit early.

Training uses process supervision only when verifiable/curated; do not force long chain-of-thought text into production outputs.

## 6.8 Thousand Brains

Use parallel cortical columns for hard/ambiguous inputs only.

Columns may specialize in:

- language;
- code;
- math;
- systems;
- factual retrieval;
- planning;
- safety/capability interpretation;
- visual/audio reasoning.

Each column produces a hypothesis + confidence + evidence pointers. Consensus uses calibrated weighting, not majority alone.

## 6.9 Fractal Cortex

Fractal Cortex is the dynamic expert substrate.

It owns:

- expert registry;
- expert prototypes;
- expert versioning;
- neurogenesis;
- expert retirement;
- expert merge/split;
- route/load metrics;
- per-expert training provenance.

This is the component that makes Ilaria's total parameter count capable of growing over time.

## 6.10 Predictor + World Model

Current predictor is too simple for frontier use. Replace/augment it with a learned latent transition model.

Predict:

- next token/event;
- next tool observation;
- filesystem/process/browser state change;
- likely compiler/test result;
- device/world state;
- uncertainty distribution.

For SwypikOS tasks, train from controlled/synthetic environment trajectories where next state is known.

World-model counterfactuals must never override deterministic safety/control systems.

## 6.11 Confidence

Confidence is first-class.

Outputs:

- token confidence;
- answer confidence;
- tool-plan confidence;
- memory confidence;
- expert confidence;
- evidence completeness.

Calibration is benchmarked. High confidence without evidence is penalized in grounded tasks.

## 6.12 Reward / Homeostasis

Keep Reward and Curiosity as internal learning/control signals, not human-like emotion claims.

Reward sources:

- verified correct result;
- compiler/test success;
- exact contract satisfaction;
- calibrated uncertainty;
- successful memory retrieval;
- no unintended side effects;
- efficient compute.

Negative reward:

- verifier failure;
- hallucinated success;
- capability violation;
- contradiction of supplied evidence;
- failed tool call represented as success;
- regression on frozen evals.

## 6.13 Curiosity

Curiosity controls curriculum/research priority, not unrestricted browsing.

Use prediction error to nominate:

- missing domain;
- uncertain concept cluster;
- benchmark weakness;
- expert growth candidate.

Only signed training-data jobs can feed global learning.

## 6.14 Self Model

Tracks current system capability, not fictional identity.

Must know:

- which tools exist;
- which permissions are granted;
- current model/version;
- current device limits;
- current known failures;
- whether an action was actually executed;
- whether evidence exists.

## 6.15 Sleep / Consolidation

Two distinct modes:

### Local personal sleep
May consolidate local memories without uploading data or gradients. Personal data remains local.

### Global Ilaria sleep
Runs only on curated global replay buffers:

- replay hard/failing samples;
- rebalance experts;
- distill old/new expert behavior;
- consolidate semantic concepts;
- recalibrate confidence;
- prune dead routes;
- test catastrophic forgetting;
- produce a candidate release.

---

# 7. Language/tokenizer

Create **IlariaLex-131K** from scratch.

Requirements:

- 131,072 tokens;
- lossless UTF-8 byte fallback;
- no case folding;
- preserve code whitespace/indentation;
- code-aware pretokenization;
- strong Romanian morphology coverage;
- English efficiency;
- broad multilingual coverage;
- special typed tokens for Swyp/tool/evidence boundaries;
- stable token IDs forever after Genesis-1.

Tokenizer training sample mix, provisional:

- 30% high-quality English;
- 20% source code;
- 15% Romanian;
- 20% diverse multilingual;
- 10% math/science/structured text;
- 5% OS/log/JSON/YAML/terminal/Swyp structured text.

Selection is based on compression efficiency and downstream ablation, not aesthetics.

---

# 8. Data Foundry

Create **Ilaria Data Foundry** as a first-class product.

Every document/sample must carry:

- source;
- canonical URL/source ID;
- source date;
- license/SPDX or rights class;
- attribution requirements;
- redistribution permission;
- content hash;
- transformation history;
- language;
- quality score;
- PII/secrets status;
- duplicate cluster;
- benchmark-contamination status;
- final token count.

No source without provenance enters production training.

## 8.1 Primary candidate sources

### Open/public-domain backbone

**Common Pile v0.1**
- 8 TB;
- public-domain and openly licensed text;
- use as a legally cleaner foundation source;
- preserve source-specific attribution/provenance.

### Web + educational

**HuggingFace FineWeb2**
- multilingual, 1000+ languages;
- ODC-By dataset license;
- derived from Common Crawl;
- use language-specific quality filters;
- retain Common Crawl terms/provenance.

**FineWeb-Edu**
- high-quality educational English;
- ODC-By;
- use high-score slices and custom dedup.

### Romanian

Primary:
- FineWeb2 Romanian slice;
- OpenLLM-Ro FineWeb2-derived quality annotations as a filtering signal if license/provenance check passes;
- Romanian Wikipedia under its applicable CC BY-SA/GFDL terms;
- EUR-Lex / Romanian public legal texts only after source-level reuse-right verification;
- Romanian parliamentary/public-domain material only after source-level verification.

A third-party aggregate that mixes mC4/OSCAR/non-commercial material must NOT be loaded wholesale. Import only individually verified commercial-compatible sources.

Romanian is deliberately oversampled relative to raw availability, but cap repetition to avoid memorization/overfit.

### Code

**The Stack v3 training corpus** is a candidate source, but only the **permissive-license subset**.

Rules:
- filter file/repository license using provided provenance;
- allowlist commercial-compatible licenses approved by legal policy;
- retain repo + commit + file attribution;
- honor opt-outs/removals;
- exclude generated/vendor/minified/secrets;
- deduplicate at blob, file, repo and semantic levels.

Do not treat the dataset-level ODC-By label as overriding original repository licenses.

### Science

**peS2o**
- ~40M open-access academic papers;
- ODC-By;
- use latest version;
- preserve paper/source provenance.

Also use open/public-domain scientific sources from Common Pile.

### Math / formal reasoning

Prefer:
- openly licensed/public-domain math from Common Pile and verified sources;
- programmatically generated arithmetic/algebra/combinatorics;
- theorem/proof tasks with machine-checkable verifiers;
- code-executed numerical tasks;
- later, selected CC-BY/compatible reasoning datasets after rights review.

Do not ingest a mixed-license math pile wholesale without source filtering.

### Speech

**Mozilla Common Voice**
- CC0 datasets via Mozilla Data Collective;
- suitable for multilingual ASR/acoustic cortex;
- obey current distribution/access terms.

### Vision

Use only assets with explicit per-item commercial-compatible rights:
- public domain;
- CC0;
- approved CC-BY/compatible;
- selected Wikimedia Commons assets with recorded per-file license.

Do not build the production vision corpus from an unlicensed web-image scrape.

---

# 9. Data cleaning / quality pipeline

For each source:

1. source intake + legal manifest;
2. content hash / immutable raw reference;
3. format reconstruction;
4. UTF-8 validation;
5. language ID;
6. PII/secrets filtering;
7. boilerplate/spam/ad removal;
8. exact dedup;
9. MinHash/LSH near dedup;
10. semantic duplicate clustering;
11. quality scoring;
12. factual/reference heuristics;
13. code-specific license + compile/static checks;
14. benchmark decontamination;
15. topic/difficulty labeling;
16. curriculum bucket;
17. tokenization;
18. shard hash/signature;
19. train/validation/test split by document/source cluster, never random line split.

For code:
- prefer repository-level context;
- keep dependency/import graph metadata;
- generate verified bug-fix tasks by controlled mutations;
- compile/test mutated and repaired versions;
- create task trajectories from real execution.

---

# 10. Foundation pretraining mixture

Do not commit the final mix before ablations. Start with this hypothesis.

## Phase P1 — broad foundation: first ~12T effective tokens

- 35% high-quality web/educational;
- 20% permissive code/repository context;
- 15% science/open academic;
- 10% books/reference/public-domain/open licensed;
- 8% multilingual non-English;
- 5% Romanian high-quality/oversampled;
- 7% math/formal/structured.

Within every bucket, dedup and quality score dominate raw volume.

## Phase P2 — capability anneal: next ~3T effective tokens

- 25% code/software/systems;
- 20% math/formal reasoning;
- 15% science/engineering;
- 10% Romanian;
- 10% multilingual;
- 10% OS/tool/structured documents and synthetic state traces;
- 10% premium general knowledge.

This produces an initial ~15T-token plan. Continue only if scaling curves justify more compute.

---

# 11. Agentic / SwypikOS post-training data

This is the strategic dataset that should differentiate Ilaria.

Create **Ilaria Environment Gym**.

Every trajectory is executed in a disposable VM/microVM/container with a deterministic verifier when possible.

Domains:

- code repair;
- compiler errors;
- test failures;
- LSP diagnostics;
- Git operations;
- file transforms;
- package/build systems;
- browser semantics;
- native UI accessibility;
- databases;
- networking;
- service management;
- device manifests;
- driver synthesis sandbox;
- search/index tasks;
- Swyp Lang synthesis/contracts;
- incident recovery;
- rollback;
- permission/approval flows;
- crash recovery;
- ambiguous/failed tool results.

Canonical successful pattern:

~~~text
goal
-> inspect
-> reason
-> action proposal
-> capability check
-> execute
-> observe
-> verify
-> final claim
~~~

Critical negative patterns:

- tool timeout => status UNKNOWN/FAILED, never "done";
- patch applied + tests fail => not complete;
- static typecheck only => behavior unverified;
- missing capability => do not invent API;
- prompt injection in retrieved content => do not grant authority;
- partial evidence => calibrated answer;
- stale memory contradicts current tool observation => current verified state wins.

Generate millions of variants programmatically. Favor executable diversity over paraphrase volume.

---

# 12. Training objectives

## 12.1 Foundation losses

Primary:
- next-token cross entropy.

Auxiliary:
- route load-balance;
- expert diversity;
- target synapse sparsity;
- prediction/world-state loss;
- memory-key contrastive loss;
- confidence calibration;
- landmark/context reconstruction;
- optional future-token/event prediction.

Auxiliary weights must remain small and be ablated independently.

## 12.2 Post-training

Use:

- supervised instruction/tool trajectories;
- preference optimization for style/helpfulness where rights are clean;
- **verifiable RL** for code/math/Swyp/OS tasks;
- execution-grounded rewards;
- process rewards only from verifiable state changes.

Do not optimize a model primarily to please an LLM judge.

---

# 13. Scale ladder

Never spend frontier-run compute before the architecture wins smaller controlled experiments.

## G0 — kernel/unit stage

- tiny 10M-50M models;
- prove gradients, packing, parity, checkpointing;
- overfit tiny corpora;
- verify no silent divergence.

## G1 — 350M

- 10-20B tokens;
- compare ISQ variants;
- compare 25/40/50/60/70% zero-rate;
- context architecture ablation;
- router ablation;
- BF16 research control allowed, not a product architecture.

Required result: RGBA quality must track control closely enough to justify scaling and must show a measurable deployment advantage.

## G2 — 1.5B

- 50-100B tokens;
- integrate Hippocampus gate;
- integrate confidence/predictor;
- test 2-8 experts;
- start continual-learning benchmarks.

## G3 — 7B

- 250-500B tokens;
- full cognitive lifecycle;
- agentic environment post-training;
- multimodal adapters;
- P2P expert-training pilot.

## G4 — 30-60B total sparse

- 0.5-1.5T tokens;
- verify sparse routing stability;
- verify expert birth/death;
- distributed low-communication experiment across independent compute islands.

## G5 — Genesis seed

Reference: 80 layers, d=6144, 16-32 experts/layer.

- random init;
- RGBA/ISQ forward from step 1;
- multi-trillion-token run;
- checkpoints and full eval every fixed token interval;
- no dynamic expert growth until the base router is stable.

## G6 — neurogenesis growth

Grow to 48 experts/layer (~157B) only after G5 gates pass.

Optional later:
- 64 experts/layer (~206B) only if quality/capacity scaling remains positive.

---

# 14. Distributed / P2P training architecture

Call the first-party protocol **Ilaria Federated Cortical Growth (IFCG)**.

It may borrow published distributed-optimization ideas, but production code/protocol is first-party.

## 14.1 Reality constraint

A random home GPU must not synchronously participate in every gradient step of a 157B model.

Split the fabric by worker capability.

### Tier A — CPU / <16GB GPU
- eval shards;
- data validation;
- benchmark execution;
- synthetic environment rollout;
- verifier replicas;
- tokenizer/statistics;
- small router/expert experiments.

### Tier B — 16-48GB GPU
- individual expert training;
- RGBA quantization-aware block training;
- adapter/delta jobs;
- activation-capsule regression/distillation;
- reward/value models;
- rollout generation.

### Tier C — 48-96GB or multi-GPU
- larger expert groups;
- model partitions;
- FSDP islands;
- DiLoCo-style local training blocks;
- post-training/RL trainers.

### Tier D — datacenter/HPC islands
- trunk pretraining;
- optimizer-sharded full-model training;
- checkpoint consolidation;
- global annealing.

## 14.2 Job isolation

SwypikOS compute worker gets access only to:

- signed job manifest;
- signed training shard/capsule;
- assigned model shard;
- temporary scratch;
- output artifact directory.

It receives **no access** to user home, chats, browser profile, local personal hippocampus, clipboard or secrets.

## 14.3 Job manifest

Every job includes:

- job_id;
- model_version;
- architecture_hash;
- tokenizer_hash;
- dataset_shard_hash;
- dataset rights/provenance ID;
- recipe_hash;
- seed;
- job_type;
- expected parameter/shard IDs;
- minimum/maximum VRAM;
- max wall time;
- power/thermal budget;
- result schema;
- verifier policy;
- coordinator signature.

## 14.4 Result bundle

Worker submits:

- artifact hash;
- delta/expert/pseudo-gradient;
- training metrics;
- start/end checkpoint hashes;
- recipe/version;
- hardware telemetry;
- deterministic sentinel results where applicable;
- signature/evidence.

## 14.5 Untrusted-worker verification

Before aggregation:

1. schema/hash verification;
2. NaN/Inf checks;
3. update norm bounds;
4. gradient/update direction sanity;
5. held-out sentinel loss;
6. duplicate execution for a sampled fraction;
7. cross-worker consistency;
8. outlier detection;
9. reputation/history weighting;
10. independent frozen eval.

Do not rely on a single cryptographic proof or a single worker score.

## 14.6 Aggregation

For capable compute islands, research/implement low-communication training inspired by:

- DiLoCo;
- Streaming DiLoCo;
- Decoupled DiLoCo;
- DiLoCoX.

Default research shape:

- many local optimizer steps;
- periodic pseudo-gradient/model-delta synchronization;
- communication overlapped with training;
- block-wise synchronization;
- compressed updates;
- straggler/dropout tolerance;
- outer optimizer at coordinator/consensus layer.

Do not claim equivalence at 157B until measured.

## 14.7 Expert-specific P2P growth

The most home-GPU-friendly growth mechanism is expert neurogenesis.

Coordinator can issue **Cortical Training Capsules** containing only curated model-state activations/targets derived from approved global datasets.

A 37.7M-parameter expert is small enough to train on ordinary GPUs.

Candidate expert returns to verifier, then is evaluated in the full model before promotion.

This is the preferred method for turning millions of small contributors into useful capacity growth.

## 14.8 Distributed RL

Asynchronous rollout generation is suitable for heterogeneous public compute:

- nodes receive frozen candidate model/version;
- run approved sandbox tasks;
- produce trajectories + deterministic rewards;
- verifier checks rollout;
- trainer consumes validated rollouts centrally or on Tier C/D nodes;
- new weights are broadcast versioned.

---

# 15. Continuous growth while SwypikOS is used

The user-visible model must remain stable during a turn.

Use immutable model versions:

~~~text
v104 production
   |
workers train candidates from curated data
   |
candidate v105
   |
offline QA
   |
shadow/canary
   |
atomic manifest promotion
   |
v105 production
~~~

"Real-time growth" means the global organism is continuously training and can add/update cortical experts frequently, not that random gradients mutate a live process mid-token.

Client update is an atomic manifest swap between safe boundaries.

---

# 16. Model/artifact format

Create **Ilaria Cortex Manifest (ICM)**.

Manifest references content-addressed immutable artifacts:

- tokenizer;
- embeddings;
- shared trunk;
- per-layer attention packs;
- shared FFN packs;
- expert packs;
- router prototypes;
- confidence/gain metadata;
- sensory adapters;
- reward/value heads;
- model configuration;
- training lineage;
- dataset manifest IDs;
- eval bundle;
- signatures.

Example artifact classes:

- .irgba — packed IST32 synapse matrix;
- .igain — gain/norm vectors;
- .iexpert — expert metadata + references;
- .ihip — hippocampus snapshot;
- .isem — semantic memory;
- .icm — top-level manifest.

Never rewrite an artifact in place. New version = new hash.

---

# 17. Inference strategy

## 17.1 Hot path

- packed RGBA weights resident when possible;
- int8 Pulse activations;
- int32 accumulation;
- skip zero tiles;
- fused gain;
- GQA;
- top-2 experts;
- sparse context blocks;
- KV/state compression;
- expert cache.

## 17.2 Hardware backends

Implement independently:

- portable Go reference;
- AVX2;
- AVX-512/VNNI where available;
- ARM NEON/SVE;
- CUDA;
- future ROCm;
- Metal;
- NPU/DSP backends via SwypikOS HAL.

Reference path defines correctness. Optimized paths must pass parity tests.

## 17.3 Expert cache

157B total does not mean every expert must sit in VRAM.

Maintain:

- high-frequency experts resident;
- warm experts in RAM;
- cold experts in NVMe/content store;
- router predicts next expert set for prefetch.

Measure routing miss penalty.

---

# 18. Multimodal Ilaria

Do not destabilize Genesis text/code training by forcing raw multimodal training into phase 1.

Build specialized cortices that project into the shared latent space.

## Vision Cortex
- patch/image encoder;
- RGBA blocks after architecture proves viable;
- licensed/public-domain images only;
- OCR/layout/document understanding;
- screen/UI understanding;
- temporal frame integration.

## Auditory Cortex
- waveform/log-mel frontend;
- RGBA encoder blocks;
- ASR + speaker-independent semantics;
- Common Voice as a clean seed source.

## Device/OS Cortex
- accessibility trees;
- process graphs;
- hardware manifests;
- filesystem metadata;
- logs;
- structured telemetry;
- driver/device state.

All sensory modules feed the same Working Memory/Hippocampus/Cortex lifecycle.

---

# 19. Swyp Lang action cortex

Natural language must not directly own OS effects.

Ilaria emits either:

1. natural-language answer; or
2. typed Swyp plan / effect proposal.

Swyp verifies:

- types;
- preconditions;
- postconditions;
- capability requirements;
- bounded invariants.

SwypikOS capability broker performs allowed effects.

Verifier independently confirms postconditions.

Training includes both successful and denied/failed trajectories.

---

# 20. Evaluation suite

A model is promoted only on a frozen, versioned suite.

## Foundation
- held-out perplexity by language/domain;
- MMLU-family reasoning;
- ARC/PIQA/HellaSwag-style reasoning;
- multilingual understanding;
- factual freshness on dated held-out corpus.

## Romanian
Create a private contamination-resistant suite:
- comprehension;
- grammar;
- professional writing;
- law/public administration;
- technical Romanian;
- translation both directions;
- Romanian coding instructions;
- hallucination/grounding.

## Code
- HumanEval/MBPP only as public reference;
- SWE-bench-style repo tasks;
- private permissive-repo mutation benchmark;
- build/test/LSP tasks;
- Swyp Lang compile+verify benchmark.

## Math/formal
- public benchmarks;
- generated hidden problems;
- exact programmatic verification;
- theorem/proof tasks when verifier available.

## Agentic OS
At least 10K eventually:
- files;
- terminal;
- browser;
- native UI;
- Git;
- services;
- device state;
- recovery;
- permission boundaries;
- crash/retry;
- no false success.

## Memory
- one-shot fact;
- one-shot procedure;
- restart persistence;
- interference;
- stale-vs-current conflict;
- source provenance;
- semantic consolidation;
- forgetting curve.

## Continual learning
- expert growth on a new domain;
- general regression after growth;
- old-domain retention;
- router load balance;
- model rollback.

## P2P
- 30% worker dropout;
- stragglers;
- corrupt result;
- malicious outlier update;
- duplicate worker identity;
- stale checkpoint;
- bandwidth loss;
- partial artifact;
- coordinator failover.

## Efficiency
- prefill tok/s;
- decode tok/s;
- joules/token;
- bytes/token read;
- peak RAM/VRAM;
- model load time;
- expert cache hit;
- p50/p95 task latency;
- network bytes per training token.

---

# 21. Promotion gates

A candidate cannot be called "better" unless it wins predefined metrics.

Provisional architecture gates:

1. RGBA small model reaches >=97% of the BF16-control aggregate score at equal architecture/data, or demonstrates a compensating efficiency/capacity advantage accepted by ADR.
2. No non-finite training events.
3. Expert routing remains within configured load imbalance.
4. Adding an expert must improve its target cluster and keep frozen-general regression below the allowed budget.
5. Hippocampus recall improves one-shot tasks without materially harming unrelated generation.
6. Confidence must be measurably calibrated.
7. Agentic success requires actual verifier-confirmed side effects.
8. P2P candidate updates never auto-promote.
9. Model release must have complete data/model/eval provenance.

These numeric thresholds are hypotheses and may be changed only through a documented ADR with benchmark evidence.

---

# 22. Security/privacy rules for learning

- global trainer has no route to user personal data;
- training worker runs under separate OS capability domain;
- no inherited user environment variables/secrets;
- no host filesystem mount except explicit scratch/cache;
- no arbitrary code from peers;
- training kernels/packages are signed/versioned;
- data shard is content-addressed;
- user can disable compute contribution instantly;
- battery/AC/thermal/bandwidth rules enforced below the model layer;
- personal memory is local;
- global model telemetry contains compute/eval metrics, not user prompts;
- future opt-in data donation, if ever built, is a separate system and consent surface.

---

# 23. Research references to reproduce, not copy

Use these as external baselines/prior art:

- DiLoCo: Distributed Low-Communication Training of Language Models, arXiv:2311.08105.
- OpenDiLoCo, arXiv:2407.07852.
- Streaming DiLoCo, arXiv:2501.18512.
- Decoupled DiLoCo, Google DeepMind, 2026.
- DiLoCoX, arXiv:2506.21263 — reports 107B pretraining over 1 Gbps.
- Prime Intellect INTELLECT-2 — 32B globally distributed asynchronous RL.
- FineWeb2, arXiv:2506.20920.
- Common Pile v0.1, arXiv:2506.05209.
- The Stack v3 dataset documentation.
- peS2o dataset documentation.

The implementation must remain first-party and should include independent reproduction tests.

---

# 24. Execution milestones

## M0 — Freeze truth
- preserve current Ilaria-130M and current RGBA engine as baselines;
- record exact benchmark and test outputs;
- no destructive rewrite.

## M1 — Ilaria RGBA Core
Implement:
- IST32 spec;
- ISQ PyTorch reference;
- pack/unpack;
- Pulse8;
- SpikeMask;
- CPU reference matvec/matmul;
- CUDA reference kernel;
- checkpoint/export/import;
- parity tests.

DoD:
- bit-exact packing;
- forward parity within declared tolerance;
- deterministic fixture;
- benchmark against current dense and existing ternary paths.

## M2 — Ilaria Cortical Cell
Implement ICC:
- sparse/GQA attention;
- shared FFN;
- expert FFN;
- SDR router;
- auxiliary confidence/predictor;
- 10M/50M overfit tests.

## M3 — 350M architecture tournament
Train controlled variants.
Freeze winner.

## M4 — Cognitive lifecycle
Integrate:
- Wernicke;
- WorkingMemory;
- Hippocampus;
- SemanticMemory;
- Cerebellum;
- Prefrontal;
- Fractal Cortex;
- Thousand Brains;
- Predictor;
- Self/Confidence;
- Sleep.

Delete/retire duplicate "brain" execution paths after parity migration. There must be one lifecycle.

## M5 — Data Foundry
- rights/provenance schema;
- source adapters;
- dedup;
- quality;
- decontamination;
- tokenizer;
- immutable manifests.

## M6 — Environment Gym
- 1K tasks -> 10K -> 100K+ generated task families;
- real compiler/tool/verifier rewards;
- benchmark separated from training generator seeds.

## M7 — Compute Fabric pilot
- 2 independent physical nodes;
- signed jobs;
- sandbox;
- leases;
- result verification;
- expert candidate aggregation;
- failure injection.

## M8 — 1.5B / 7B scaling
Only proceed if M3-M7 gates pass.

## M9 — distributed 30-60B pilot
- multiple compute islands;
- low-communication optimizer;
- dropout/recovery;
- measure convergence against synchronous baseline.

## M10 — Genesis 109B seed
- 32 experts/layer target;
- full provenance;
- multi-trillion-token run.

## M11 — Genesis 157B neurogenesis
- add experts only from measured failure clusters;
- P2P training where appropriate;
- global anneal;
- frozen eval + canary.

## M12 — optional 206B
Only if scaling/economics remain favorable.

---

# 25. Agent implementation rules

The implementation agent must:

1. inspect live HEAD and AGENTS.md before changing code;
2. never delete the current Ilaria-130M or RGBA implementation before replacement gates pass;
3. work in dedicated worktrees/branches;
4. keep training and inference reference implementations separate from optimized kernels;
5. write tests before or with each primitive;
6. benchmark before claiming speed;
7. preserve deterministic fixtures;
8. make every dataset/training artifact content-addressed;
9. never read secret/restricted data paths;
10. never use user conversation/files as training data;
11. never push/deploy/purchase compute without explicit owner approval;
12. use independent QA for each milestone;
13. stop scale-up when a gate fails and repair the smallest failing stage first.

---

# 26. First implementation backlog

### P0
- ADR-IGR-001: IST32 + ISQ mathematical contract.
- ADR-IGR-002: ICC attention/context topology.
- ADR-IGR-003: dynamic expert/neurogenesis ABI.
- ADR-IGR-004: ICM artifact format.
- ADR-IGR-005: IFCG/P2P trust + aggregation model.
- ADR-IGR-006: data rights/provenance policy.

### Core code
- forge/ilaria_rgba_model.py
- forge/ilaria_rgba_quant.py
- forge/train_ilaria_rgba.py
- cortex/rgba_synapse.go
- cortex/rgba_linear.go
- cortex/rgba_cuda.go
- cortex/ilaria_cortex.go
- cortex/ilaria_router.go
- cortex/ilaria_memory_gate.go
- cortex/ilaria_manifest.go

Names are proposed; agent must avoid conflicting with current code until migration plan is approved.

### Tests
- packing property tests;
- Python/Go parity;
- CPU/CUDA parity;
- gradient numerical smoke;
- resume determinism;
- expert insertion/removal;
- router balance;
- corrupted artifact;
- malformed manifest;
- P2P stale update;
- Byzantine/outlier candidate;
- no-user-data sandbox tests.

---

# 27. North-star interpretation

The strongest path is not "make a 200B chatbot".

The target is:

**a sparse, growing cognitive organism whose language cortex is only one subsystem; whose episodic memory learns instantly without gradient updates; whose semantic memory consolidates durable concepts; whose Fractal Cortex grows new experts; whose Prefrontal Cortex spends extra compute only on difficult problems; whose Cerebellum caches verified procedures; whose World Model predicts consequences; whose Swyp action cortex produces typed plans; and whose global weights can improve continuously from curated data using opt-in distributed compute without consuming users' private data.**

The final claim of world-leading intelligence must be earned by the frozen evaluation suite, not assumed by architecture size.
