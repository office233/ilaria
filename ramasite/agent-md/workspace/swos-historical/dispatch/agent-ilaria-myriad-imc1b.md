# IMPLEMENTATION AGENT — ILARIA MYRIAD / IMC-1B

**Authoritative architecture:** E:\CEO\projects\swos\analysis\13-ilaria-myriad-1b-cortex-mesh.md  
**Prior architecture context:** E:\CEO\projects\swos\analysis\12-ilaria-genesis-rgba-master-spec.md  
**Goal:** validate and implement Ilaria as a distributed mesh of ~1B RGBA MicroCortex experts rather than one monolithic 100–200B model.

## Hard rules

1. Read both architecture documents completely before coding.
2. Inspect E:\nexus\AGENTS.md and live HEAD.
3. Preserve current Ilaria-130M, RGBA, Hippocampus and Organism baselines.
4. No BitNet weights/code/tokenizer/model dependency in the new Myriad path.
5. No global training from user prompts/files/browser/personal Hippocampus.
6. No unverified P2P result may alter canonical weights.
7. No commit/push/deploy/purchase unless owner explicitly asks.
8. Every quality/speed claim requires an exact benchmark artifact.
9. Work in a dedicated worktree.

# Phase 0 — falsify/validate the premise

Before implementation, produce:
- evidence review on native ternary scaling >1B;
- current Ilaria RGBA performance baseline;
- parameter/storage calculation for IMC-1B;
- estimated training compute at 250M/500M/1B/2B controls;
- decision record explaining why 1B is or is not a Pareto point.

Do not assert a 1B quality ceiling without evidence.

# Phase 1 — IMC-1B genome

Reference model:
- 16 layers
- d_model 2048
- vocab 131072
- 16 Q heads
- 4 KV heads
- head_dim 128
- FFN 5632
- tied embedding/head
- ~989.9M parameters
- Ilaria RGBA major matrices
- Pulse8 activations
- optional SpikeMask
- BF16 master state only for training.

Implement:
- genome schema;
- deterministic random initialization from expert_id + architecture_version;
- model config/hash;
- checkpoint format;
- packed inference export;
- corruption checks.

# Phase 2 — tiny scaling fixtures first

Do not allocate a 1B model first.

Build equivalent:
- 10M
- 50M
- 250M

Verify:
- loss decreases;
- RGBA ternary forward;
- finite gradients;
- resume determinism;
- CPU/Python parity;
- sparsity dynamics;
- tokenizer correctness.

# Phase 3 — synaptic neurogenesis

Implement:
- dormant synapse mask;
- confidence plane;
- growth interval;
- activation of candidate dormant connections;
- pruning;
- sign flip;
- growth/prune journal;
- rollback.

Benchmark active sparsity:
- 10%
- 25%
- 40%
- 50%
- 60%.

# Phase 4 — Cortical Protocol

Implement typed input/output packet.

Must include:
- task;
- goal;
- language;
- evidence refs;
- memory refs;
- tool observations;
- confidence;
- specialty;
- hypothesis;
- claims;
- contradictions;
- proposed next experts;
- verification requirements.

Experts with unrelated random seeds communicate only through this protocol.

# Phase 5 — Cortex Registry

Implement:
- expert identity;
- genome hash;
- checkpoint hash;
- specialty ontology;
- SDR prototype;
- benchmark vector;
- language;
- modality;
- status;
- runtime requirements;
- provenance;
- lineage;
- artifact locations.

Content-address every artifact.

# Phase 6 — Thalamus routing simulation

Start in-process with 8 experts.

Pipeline:
1. deterministic capability filter;
2. SDR/popcount shortlist;
3. learned/router control;
4. probe;
5. top-k full expert calls.

Test:
- correct specialization;
- abstention;
- duplicates;
- load balance;
- router failure fallback.

Then scale metadata-only simulation:
8 -> 32 -> 128 -> 1,024 -> 10,000 expert descriptors.

Do not train thousands of models.

# Phase 7 — cognitive lifecycle

Map existing components:
- Hippocampus
- SemanticMemory
- WorkingMemory
- Cerebellum
- Prefrontal
- ThousandBrains
- FractalCortex
- Predictor
- Confidence
- Curiosity
- Reward
- Sleep
- Wernicke
- Broca
- SelfModel

into one Myriad lifecycle.

No duplicate answering brains.

# Phase 8 — Nursery security boundary

Implement separate Serving and Nursery planes.

Nursery:
- no home directory capability;
- no chat history;
- no personal Hippocampus;
- no browser;
- no clipboard;
- no secrets;
- signed model/data/recipe only;
- scratch only;
- immediate yield/stop.

Write integration tests proving the firewall.

# Phase 9 — two-node P2P cohort

Build one canonical newborn expert.

Both physical nodes:
- derive same random init from genome;
- train different signed shards;
- submit deltas/metrics.

Implement first:
- exact round manifests;
- leases;
- checkpoint;
- stale rejection;
- hash verification;
- finite/norm checks;
- duplicate/sentinel validation.

Compare:
- synchronous
- FedAvg-like
- DiLoCo-like local steps.

No public untrusted nodes yet.

# Phase 10 — expert graduation

Lifecycle:
NEWBORN -> LEARNING -> EVAL_READY -> SHADOW -> CANARY -> VERIFIED -> PRODUCTION -> RETIRED

Gate on:
- specialty benchmark;
- protocol correctness;
- calibration;
- grounding;
- malicious input;
- efficiency;
- regression.

# Phase 11 — 1B research run

Only after previous gates.

Train:
- IMC-1B random genesis.

Required controls:
- 250M;
- 500M;
- 2B research control if budget allows.

Answer empirically:
- is 1B the best unit?
- how much data per specialty?
- what sparsity wins?
- does multi-1B assembly beat matched single-model baselines?

# Phase 12 — assembly benchmarks

Experiments:
- 4x1B experts vs one ~4B baseline;
- 8x1B active committee vs one ~8B baseline;
- 32-expert registry with top-4;
- recursive synthesis;
- critic rounds;
- tool/verifier grounded tasks.

Measure quality vs:
- active FLOPs;
- latency;
- energy;
- RAM/VRAM;
- network;
- failure rate.

# Phase 13 — population growth

Only after assembly wins.

Scale canonical registry:
- 32
- 128
- 1,024
- 10,000
- 100,000
- 1,000,000 only as justified by routing economics.

Most candidates should be allowed to fail/retire early.

# Report

After each phase report:
- files changed;
- exact commands;
- exact tests;
- exact benchmarks;
- failed gates;
- next smallest action.

Never claim "smartest", "faster", "production-ready", "1B is optimal" or "P2P works" without the corresponding measured evidence.
