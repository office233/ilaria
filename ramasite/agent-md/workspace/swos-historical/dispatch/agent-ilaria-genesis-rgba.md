# IMPLEMENTATION CONTRACT — ILARIA GENESIS RGBA

**Authoritative design:** E:\CEO\projects\swos\analysis\12-ilaria-genesis-rgba-master-spec.md  
**Scope:** Ilaria architecture + training/data/P2P foundation.  
**Mode:** implementation by gated milestones.  
**Do not:** replace current production path wholesale, train frontier scale before gates, ingest user data, import BitNet architecture/weights/code/tokenizer, push/deploy/buy compute without owner approval.

## Mission

Build a from-scratch first-party Ilaria cognitive foundation model and distributed training system whose large synaptic matrices use Ilaria RGBA32 ternary synapses and whose parameter capacity can grow through validated cortical neurogenesis.

The target architecture is Ilaria Genesis RGBA-157B-A18B:
- 80 cortical stages
- d_model 6144
- vocab 131072
- 48 Q heads / 8 KV heads / head_dim 128
- shared FFN 3072
- 48 routed experts/layer
- expert FFN 2048
- top-2 experts/token
- ~157.3B total / ~18.4B active per token
- effective long context via sparse/local/landmark/hippocampal retrieval, not dense 128K attention.

The model must be able to grow experts:
- 16 experts/layer ~60.7B
- 24 ~84.9B
- 32 ~109.0B
- 48 ~157.3B
- 64 ~205.7B
with top-2 active compute remaining approximately constant.

## Hard constraints

1. Read the master spec in full before coding.
2. Inspect E:\nexus\AGENTS.md and live HEAD.
3. Work only in a dedicated worktree/branch for Ilaria Genesis.
4. Preserve current Ilaria-130M and current RGBA engine as baselines.
5. No BitNet production dependency or naming.
6. Third-party model weights are forbidden for the foundation model.
7. User chats/files/browser/local personal memory are forbidden as global training data.
8. P2P compute is opt-in and receives only signed curated training jobs.
9. No unverified P2P update may modify a production checkpoint.
10. Every speed/quality claim requires a reproducible benchmark artifact.
11. Every dataset shard requires provenance/rights manifest.
12. Every model artifact is versioned/content-addressed.
13. No commit/push/deploy unless the owner explicitly requests it.

# PHASE 0 — Truth baseline

Create:
- current architecture inventory;
- current test baseline;
- current benchmark baseline;
- current RGBA/NeuroTexture benchmark;
- current Ilaria-130M benchmark;
- current cognitive-module map;
- exact files that will be reused, migrated or retired.

No source rewrite in this phase.

Deliver:
- analysis/ilaria-genesis-current-state.md
- results/ilaria-genesis-baseline.json

# PHASE 1 — RGBA mathematical contract

Implement first-party:
- IST32 weight tile;
- ConfidenceTile32;
- gain plane;
- Pulse8 activation;
- SpikeMask activation;
- Ilaria Synaptic Quantization (ISQ);
- BF16 master weights for training;
- ternary forward;
- bounded STE backward;
- pack/unpack/export/import.

Required tests:
- all 3^16 pattern logic sampled/property-tested;
- packing round-trip;
- zero-mask skip correctness;
- CPU reference vs Python reference;
- gradient finite test;
- resume determinism;
- corrupt artifact rejection.

Gate:
Do not proceed until parity and determinism are green.

# PHASE 2 — Ilaria Cortical Cell

Implement a minimal ICC with:
- pre-norm;
- GQA attention;
- RGBA Q/K/V/O;
- shared RGBA FFN;
- N experts;
- top-2 router;
- residuals;
- predictor head;
- confidence head.

Implement sparse context:
- local window;
- landmark representation;
- remote-block selection;
- no dense 128K attention.

Train 10M/50M fixtures and overfit deterministic datasets.

Gate:
- loss decreases correctly;
- no NaN/Inf;
- Python/optimized inference parity;
- router does not collapse.

# PHASE 3 — 350M architecture tournament

Train controlled experiments on identical data/tokenizer/seeds where possible.

Ablate:
- sparsity target 25/40/50/60/70%;
- gain granularity;
- threshold method;
- local-window sizes;
- experts 2/4/8;
- router implementation;
- norm family;
- shared/expert FFN ratios.

Run a BF16 research control only as a scientific control; it is not a production architecture.

Freeze one winner through ADR.

# PHASE 4 — Cognitive lifecycle integration

Unify these modules into one lifecycle:
- Wernicke
- Broca
- WorkingMemory
- Hippocampus
- SemanticMemory
- Cerebellum
- Prefrontal
- ThousandBrains
- FractalCortex
- Predictor/WorldModel
- Confidence
- SelfModel
- Reward/Homeostasis
- Curiosity
- SleepConsolidator

Rules:
- no competing independent "brains";
- cortex produces latent reasoning;
- memory modules provide state/recall;
- Broca controls output;
- Swyp action head controls typed proposals;
- SwypikOS retains authority.

Add one-shot memory, restart persistence, stale-memory conflict and interference tests.

# PHASE 5 — IlariaLex-131K

Build tokenizer from approved corpus sample:
- byte fallback;
- lossless UTF-8;
- code whitespace preserved;
- Romanian-heavy sample;
- English + multilingual + code + math + structured OS text.

Benchmark:
- chars/token by language;
- bytes/token;
- code identifier fragmentation;
- Romanian morphology;
- JSON/YAML/path/terminal fragmentation.

Freeze token IDs after selection.

# PHASE 6 — Data Foundry

Implement provenance schema and source adapters.

Initial approved-source candidates:
- Common Pile v0.1
- FineWeb2
- FineWeb-Edu
- permissive-only The Stack v3
- peS2o
- source-verified Romanian Wikipedia / public legal data
- Common Voice for audio
- per-asset licensed/public-domain vision data.

Do not load mixed/non-commercial configurations wholesale.

Pipeline:
license/provenance -> format -> lang -> PII/secrets -> quality -> exact dedup -> near dedup -> semantic dedup -> benchmark decontam -> curriculum -> tokenizer -> signed shard.

Deliver a manifest with counts/tokens/licenses/removals per source.

# PHASE 7 — Ilaria Environment Gym

Build executable trajectory generation for:
- code repair
- LSP
- compiler/test
- Git
- filesystem
- terminal
- browser semantic actions
- native UI
- search
- service recovery
- permissions/approvals
- device manifests
- Swyp synthesis/verification
- crash/rollback.

Every final success claim must be verifier-backed.

Keep train/eval generators and seeds isolated.

# PHASE 8 — P2P / IFCG pilot

Implement Ilaria Federated Cortical Growth.

Worker:
- explicit opt-in;
- isolated training capability domain;
- no user data mounts;
- resource governor;
- signed job verification;
- heartbeat/checkpoint/yield.

Coordinator:
- scheduler;
- artifact store;
- candidate registry;
- verifier;
- robust aggregator;
- model manifest promotion.

Candidate checks:
- hashes/schema
- finite values
- norm bounds
- sentinel evaluation
- sampled replication
- outlier rejection
- independent frozen eval.

Pilot on minimum 2 independent physical nodes.

# PHASE 9 — Expert neurogenesis

Implement:
- failure clustering;
- expert parent selection;
- expert clone/centroid/random birth;
- controlled ternary perturbation;
- router cold-start;
- training capsule format;
- P2P expert training;
- full-model validation;
- canary promotion;
- expert rollback/retirement.

Prove that adding an expert improves a target cluster without unacceptable frozen-suite regression.

# PHASE 10 — Scale ladder

Only after previous gates:

G2:
- 1.5B
- 50-100B tokens

G3:
- 7B
- 250-500B tokens

G4:
- 30-60B sparse
- 0.5-1.5T tokens
- multi-island low-communication training

G5:
- 109B seed (32 experts/layer)
- multi-trillion-token foundation run

G6:
- neurogenesis to 157B
- targeted expert growth
- global annealing

G7 optional:
- 206B
- only if measured scaling remains positive.

# P2P workload tiers

Tier A (<16GB GPU):
- eval
- data validation
- rollouts
- verifier
- router/small models

Tier B (16-48GB):
- individual expert jobs
- RGBA QAT blocks
- adapters
- activation training capsules
- reward/value

Tier C (48-96GB or multi-GPU):
- larger partitions
- FSDP islands
- low-communication local training
- RL trainers

Tier D (HPC/datacenter):
- trunk pretraining
- full optimizer state
- global checkpoint consolidation.

# Training data firewall

Global training worker must be unable to access:
- user home
- chat history
- personal Hippocampus
- browser profile
- clipboard
- secrets
- arbitrary local files.

The only data input is a signed curated shard/capsule identified by hash.

Add an integration test that proves this boundary.

# Mandatory evals

Foundation:
- held-out PPL per domain/language
- reasoning
- multilingual
- factual

Romanian:
- private contamination-resistant Romanian suite

Code:
- public coding references
- private permissive-repo mutation benchmark
- build/test/LSP
- Swyp contracts

Agentic:
- verifier-grounded SwypikOS tasks

Memory:
- one-shot
- restart
- interference
- stale conflict

P2P:
- dropout
- stale result
- malicious/outlier update
- corrupted artifact
- coordinator retry

Efficiency:
- tok/s
- joules/token
- memory bandwidth
- VRAM/RAM
- expert-cache hit
- network bytes/training token.

# Reporting format after every phase

Report only:
1. files changed;
2. architecture/config actually implemented;
3. commands executed;
4. exact test results;
5. exact benchmark results;
6. failed gates;
7. next smallest gated step.

Never report "better", "faster", "ready" or "world-class" without the corresponding measured gate.
