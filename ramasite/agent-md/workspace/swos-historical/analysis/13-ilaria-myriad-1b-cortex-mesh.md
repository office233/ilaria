# ILARIA MYRIAD — DISTRIBUTED 1B MICRO-CORTEX ARCHITECTURE

**Status:** proposed architecture / research contract  
**Date:** 2026-09-28  
**Program:** SwypikOS / Ilaria / Swyp Lang  
**Replaces as preferred research direction:** monolithic 100–200B Ilaria Genesis target, pending benchmark gates.

---

# 0. Executive decision

Do **not** build Ilaria as one 100–200B model first.

Build Ilaria as a **distributed cognitive mesh of fixed-size ~1B Ilaria RGBA MicroCortexes**.

Each MicroCortex:
- is first-party Ilaria;
- starts from random initialization when a new expert lineage is born;
- uses the same IlariaLex tokenizer and Cortical Protocol;
- uses Ilaria RGBA ternary synapses;
- has its own Hippocampal adapter/cache, confidence state and specialty;
- is trained only on signed, centrally curated Ilaria datasets;
- may be trained by a P2P cohort of SwypikOS devices;
- is independently benchmarked;
- can be promoted, cloned, branched, retired or superseded.

The full Ilaria intelligence is the **network + memory + routing + verification + recursive collaboration**, not the parameter count of any single MicroCortex.

A million 1B MicroCortexes corresponds to an enormous distributed parameter population, but only a tiny working set is loaded or invoked for a task.

---

# 1. Research premise

There is no reliable scientific rule that a native ternary model becomes intrinsically worse after 1B parameters. A public native ternary model exists at ~2B scale, and ternary scaling work reports normal scaling behavior.

Therefore the 1B ceiling is **not** justified as a ternary quality law.

The reason to choose ~1B units is instead architectural:

1. fits consumer hardware;
2. cheap to download/cache;
3. cheap enough for P2P training cohorts;
4. supports extreme specialization;
5. failures are isolated;
6. experts can be replaced independently;
7. network capacity can grow without enlarging each inference unit;
8. heterogeneous devices can contribute useful work;
9. routing can keep active compute low;
10. catastrophic forgetting can be localized;
11. enables multiple independent hypotheses/critics;
12. naturally maps onto the existing Ilaria Organism / FractalCortex / ThousandBrains design.

---

# 2. Core concept: Ilaria Myriad

The architecture has five scales:

## Scale A — Synapse

Ilaria RGBA IST32:
- 16 ternary synapses per uint32;
- sign + active-mask planes;
- {-1,0,+1};
- exact zero can skip compute;
- 2 physical bits per synaptic slot.

## Scale B — MicroCortex

One ~1B-parameter neural expert.

Canonical name:
**Ilaria MicroCortex-1B (IMC-1B)**.

## Scale C — Cortical Assembly

A temporary working team of 2–32 MicroCortexes selected for one task.

## Scale D — Regional Cortex

A hierarchical family of experts:
- language;
- code;
- math;
- science;
- systems;
- planning;
- perception;
- law;
- medicine;
- Romanian;
- etc.

## Scale E — Myriad

Global registry of potentially millions of MicroCortex lineages distributed across SwypikOS storage/compute.

---

# 3. Exact IMC-1B reference architecture

Target: ~0.99B parameters.

Reference configuration:

- layers: 16
- d_model: 2048
- vocab: 131,072
- query heads: 16
- KV heads: 4
- head dimension: 128
- FFN dimension: 5,632
- pre-norm
- RoPE-like position mechanism only if retained after Ilaria-specific ablation
- tied token embedding/output head unless ablation disproves it
- all major matrices use Ilaria RGBA ternary forward
- Pulse8 activations
- BF16 latent master weights only during training
- optional SpikeMask side channel
- context target:
  - 8K local native
  - 32K through sparse block attention
  - larger effective context through Hippocampus

Approximate parameter count:

- tied embedding: 268.44M
- attention/layer: 10.49M
- FFN/layer: 34.60M
- 16 layers: ~721.42M
- norms/gains: tiny relative overhead
- total: ~989.92M parameters

Packed 2-bit synaptic storage:
- ~247.5 MB decimal
- ~236 MiB binary
before non-ternary norms/gains/metadata.

This makes expert packages practical to replicate and cache.

---

# 4. Synaptic neurogenesis inside every 1B model

A MicroCortex has a fixed 1B **synaptic address space**, but it does not need all slots active.

Birth state:
- 5–20% active synapses depending on experiment;
- most RGBA mask bits are zero;
- confidence low;
- latent training master state exists only on trainer.

Training can:
- activate dormant synapses;
- flip sign;
- prune low-confidence synapses;
- strengthen confidence;
- rewire sparse patterns.

This gives two kinds of growth:

1. **intra-cortex neurogenesis** — more synapses become useful inside the same 1B address space;
2. **inter-cortex neurogenesis** — new 1B MicroCortexes are born.

A production expert remains bounded at ~1B parameter slots.

---

# 5. Every device has two planes

This is mandatory.

## 5.1 Serving Plane

Stable, verified MicroCortexes used by the user's SwypikOS.

Examples:
- Wernicke-RO-1B
- Wernicke-EN-1B
- Broca-General-1B
- Code-Go-1B
- Code-Rust-1B
- Systems-Windows-1B
- Systems-NativeKernel-1B
- Planner-1B
- Critic-1B

These are signed production artifacts.

They do not mutate during a user turn.

## 5.2 Nursery Plane

A sandboxed **newborn IMC-1B** or training replica.

It:
- starts from deterministic random initialization or a declared experimental parent;
- receives only signed Ilaria curriculum shards;
- has no user-data capability;
- trains only when resource governor permits;
- checkpoints to content-addressed storage;
- produces candidate artifacts;
- can fail without affecting serving.

This allows "every device helps grow Ilaria" without making the user's active assistant an unstable live-training model.

---

# 6. Expert identity / genome

Every canonical MicroCortex is defined by an immutable **Cortical Genome**:

- expert_id
- architecture_version
- tokenizer_hash
- deterministic genesis_seed
- specialty ontology ID
- curriculum manifest
- training objective version
- synapse-growth policy
- context policy
- safety/capability role
- parent expert IDs if branch/mitosis is allowed
- creation timestamp
- provenance root

Two workers training replicas of the same expert identity must start from the same genome/checkpoint so their updates live in the same parameter coordinate system.

Different expert IDs may have different random seeds and do **not** have their weights averaged directly.

---

# 7. Why not merge random independent 1B models blindly

Independent random-init experts do not share a compatible latent basis.

Therefore:

- do not average unrelated experts;
- do not splice arbitrary layers;
- do not assume hidden-state compatibility.

Experts communicate through a stable **Cortical Protocol**, not raw internal coordinates.

Only replicas of the same expert lineage may participate in parameter-delta aggregation.

---

# 8. Cortical Protocol

All experts consume and produce a typed packet.

## Input packet

- task ID
- language
- user goal summary
- typed evidence references
- relevant text/token window
- Hippocampus retrieval references
- tool observations
- Swyp state
- confidence requirements
- resource budget
- specialty hints

## Output packet

- hypothesis / answer fragment
- structured claims
- evidence references
- uncertainty
- suggested next experts
- tool proposal if any
- verification requirements
- contradiction flags
- latent summary token block
- specialty signature

The wire representation is versioned and deterministic.

This enables experts with different internal weights/seeds to collaborate safely.

---

# 9. Thalamus: routing across millions of experts

Never evaluate one million routers.

Use hierarchical retrieval.

## Stage 0 — deterministic capability filter

Filter by:
- language
- domain
- tool capability
- modality
- required trust level
- local hardware
- expert version
- freshness
- privacy restrictions

## Stage 1 — SDR directory retrieval

Each expert has:
- 4K–64K-bit sparse semantic prototype;
- skill tags;
- benchmark vector;
- domain vector;
- historical confidence;
- locality/cache metadata.

Use bit index / AND + popcount to shortlist, for example:
- 1,000,000 -> 512 candidates.

## Stage 2 — Thalamus Router IMC-1B

A dedicated 1B router reads:
- task summary;
- 512 candidate descriptors;
- current WorkingMemory;
- cost/locality.

Select:
- top 8–32 candidates.

## Stage 3 — probe

Run cheap first-pass probes on selected experts.

Use:
- confidence;
- disagreement;
- specialty fit;
- predicted value of information.

Activate:
- typically 2–8 full experts;
- up to 32+ for hard tasks.

---

# 10. Expert hierarchy

The registry is not flat.

## L0 — Universal cortexes

Small population, highly trained:
- General Language
- General Reasoning
- General Code
- General Math
- General World Knowledge
- General Planner
- General Critic
- General Multilingual

Dozens, not millions.

## L1 — Major regions

Hundreds:
- Romanian
- English
- German
- medical
- law
- physics
- chemistry
- software
- operating systems
- finance
- biology
- robotics
- vision
- audio
- security
- etc.

## L2 — Specialties

Thousands:
- Go compiler
- Windows kernel
- Rust ownership
- CUDA
- PostgreSQL
- oncology
- Romanian tax
- numerical analysis
- UI accessibility
- network protocols
- etc.

## L3 — Task/process experts

Tens/hundreds of thousands:
- Go race repair
- React hydration repair
- SQL query optimization
- driver PCIe discovery
- browser checkout automation policy
- Swyp verifier synthesis
- etc.

## L4 — Dynamic frontier experts

Potentially millions over time.

Born from:
- recurring failure clusters;
- new technologies;
- new languages;
- new hardware;
- new scientific domains;
- fresh data epochs.

Most never need to be invoked for most users.

---

# 11. Wernicke and Broca in Myriad

## Wernicke

Wernicke is itself a family of IMC-1B units.

Responsibilities:
- comprehension;
- language normalization;
- semantic decomposition;
- entity/relation extraction;
- task signatures;
- SpikeMask generation;
- ambiguity detection.

Use multiple Wernicke specialists for languages/domains.

## Broca

Broca is a family of output IMC-1B units.

Responsibilities:
- coherent final generation;
- domain/language style;
- compact synthesis of structured expert outputs;
- preserving evidence/certainty;
- not inventing execution success.

A Broca model does not need to contain all knowledge; it renders the Global Workspace state.

---

# 12. Prefrontal Cortex = recursive assembly, not one huge model

This removes the "1B integrator bottleneck".

Prefrontal reasoning is a **protocol** executed by multiple IMC-1B units.

## Round

1. decompose task;
2. route subproblems;
3. experts answer independently;
4. critics attack assumptions;
5. evidence is retrieved;
6. integrators merge compatible claims;
7. contradictions remain explicit;
8. verifier/tool runs if possible;
9. confidence recalculated;
10. either stop or recurse.

## Tree reduction

For many expert outputs:

- 32 experts
- 8 local synthesizers
- 2 higher synthesizers
- 1 final Broca/integrator

No individual 1B expert needs to ingest the full raw output of all 32 peers.

The Global Workspace persists the structured state between rounds.

---

# 13. Thousand Brains becomes native

The existing ThousandBrains concept becomes first-class.

For difficult tasks:
- activate multiple independent experts;
- maintain diverse hypotheses;
- avoid early consensus;
- score evidence;
- select or merge only after critique.

Use explicit diversity regularization during training so experts do not all collapse to the same strategy.

---

# 14. Hippocampus

Hippocampus is **not another 1B model**.

It is a persistent memory substrate shared by the local organism.

Stores:
- episodes;
- expert interactions;
- verified outcomes;
- task states;
- source provenance;
- strengths;
- temporal validity;
- user-local memories.

Important:
- personal Hippocampus remains local;
- not used for global P2P training;
- global training uses separate curated replay stores.

Hippocampus can remember which expert solved a problem before, allowing expert routing to improve without retraining.

---

# 15. Semantic Memory

Semantic Memory consolidates repeated validated episodes into concepts.

It can also maintain expert-domain maps:

- concept -> best experts
- concept -> trusted sources
- concept -> contradiction history
- concept -> freshness

This reduces future routing cost.

---

# 16. Cerebellum

Cerebellum caches **verified expert assemblies**.

Example:

For a recurrent Go race problem, Cerebellum may cache:

- Wernicke-Code
- Go-Race Expert
- Concurrency Critic
- LSP Expert
- Tool plan
- verifier sequence

Next time the same class appears, Ilaria starts from the proven assembly rather than discovering it again.

---

# 17. Predictor / World Model

World model is also modular.

Families:
- code-execution predictor
- browser-state predictor
- filesystem/process predictor
- hardware/device predictor
- physical/robotics predictor
- social/dialog predictor
- scientific simulators

The prefrontal assembly can ask multiple predictors for counterfactuals.

Measured prediction error feeds:
- confidence;
- curriculum;
- expert creation;
- curiosity.

---

# 18. Curiosity and neurogenesis

Curiosity does not browse randomly.

It detects:

- high-error clusters;
- repeated expert disagreement;
- missing experts;
- stale domains;
- poor benchmark regions.

Then creates a **Neurogenesis Proposal**:

- proposed specialty;
- target data manifest;
- benchmark to beat;
- expected overlap with existing experts;
- estimated compute;
- desired diversity.

Only Data Foundry-approved proposals can spawn global training.

---

# 19. Expert birth modes

## Mode A — Genesis birth

Pure random initialization.

Used for:
- new independent lineages;
- architecture experiments;
- diversity.

## Mode B — Cohort genesis

Many P2P nodes train replicas from the same deterministic random seed.

Used when one canonical expert needs distributed training from zero.

## Mode C — Mitosis

Optional later experiment:
- parent expert checkpoint;
- branch into a specialist;
- avoids relearning language.

Must be explicitly labeled as inherited, not "from zero".

## Mode D — Fusion service

No weight merge.
A new assembly recipe learns to call several existing experts.

Often cheaper than birthing a new expert.

---

# 20. P2P training: cohort model

The preferred model for "each device trains an expert" is a **cohort**.

Example:

Expert:
  IMC-code-rust-borrow-v17

Genome:
  seed = H(expert_id, architecture_version)

1000 devices join cohort.

All start from:
- same random seed at birth, or
- same current canonical checkpoint after the first synchronization.

Each gets different signed data shards.

They run many local steps.

They submit:
- delta fragments;
- token counts;
- metrics;
- sentinel outputs;
- hashes;
- hardware evidence.

Coordinator/synchronizer aggregates after robust validation.

This avoids attempting to merge unrelated random models.

---

# 21. P2P optimizer

Research basis:
- DiLoCo-like many local inner steps;
- Streaming/Decoupled synchronization;
- block-wise parameter fragments;
- quantized deltas;
- asynchronous minimum quorum;
- token-weighted updates.

First-party protocol name:
**Ilaria Synaptic Exchange (ISX)**.

## ISX round

1. coordinator publishes signed round manifest;
2. worker verifies model/data/recipe hashes;
3. worker trains local steps;
4. worker evaluates sentinels;
5. worker submits delta fragments;
6. validator samples/replays work;
7. robust aggregator rejects outliers;
8. outer optimizer updates candidate;
9. candidate frozen eval runs;
10. accepted candidate becomes next cohort checkpoint.

---

# 22. Byzantine / malicious worker defense

Public P2P results are untrusted.

Mandatory checks:

- artifact hashes;
- finite weights;
- delta norm bounds;
- sign-distribution bounds;
- sparsity-distribution bounds;
- sentinel loss;
- gradient/update cosine sanity;
- sampled redundant tasks;
- multiple independent validators;
- worker reputation;
- robust coordinate/block aggregation;
- stale-round rejection;
- architecture/tokenizer hash match.

No public worker can directly write canonical weights.

---

# 23. No user-data training

A SwypikOS training worker receives only:

- signed model checkpoint/genome;
- signed Ilaria dataset shard;
- signed recipe;
- scratch storage.

It cannot access by default:
- user chat;
- personal files;
- personal Hippocampus;
- browser;
- clipboard;
- email;
- tokens/secrets;
- camera/audio;
- arbitrary network.

Training contribution is compute contribution, not data donation.

---

# 24. Local-first inference

Do not send private prompts to arbitrary P2P experts.

Default flow:

1. route expert ID locally;
2. if missing, download signed ~250MB expert package through P2P/CDN;
3. verify hash/signature;
4. cache;
5. execute locally.

Remote expert inference is optional and must be an explicit privacy mode.

This turns the P2P network primarily into:
- artifact distribution;
- training;
- verification;
not a privacy-leaking prompt RPC network.

---

# 25. Local expert cache

A device maintains:

- Hot set — GPU resident;
- Warm set — RAM resident;
- Cold set — SSD;
- Remote set — downloadable from mesh.

Predictive prefetch uses task context.

At ~247.5MB raw packed major weights per IMC-1B, a device can store many specialists on SSD. Actual runtime footprint will be higher due to embeddings, gains, KV cache and working buffers and must be benchmarked.

---

# 26. Adaptive inference budget

## Simple task

Possible assembly:
- Wernicke
- 1 domain expert
- Broca

~3 IMC invocations.

## Medium task

- Wernicke
- 3 experts
- 1 critic
- 1 integrator
- Broca

~7 invocations.

## Hard task

- decomposition
- 8–32 experts
- 2–8 critics
- hierarchical synthesis
- tools
- verifier
- multiple rounds

Potentially dozens/hundreds of 1B invocations, heavily parallel.

Intelligence scaling becomes:
- number of relevant experts;
- reasoning rounds;
- memory quality;
- tool/environment verification;
not one monolithic parameter count.

---

# 27. Training curriculum for each expert

Training every one of millions of full 1B models on a full general corpus would be computationally wasteful.

Use specialist curricula.

## Universal expert

Example budget:
- 50–200B high-quality tokens;
- broad language/reasoning/code;
- strong general benchmark gate.

## Regional expert

Example:
- 10–80B tokens;
- 40–60% shared universal primer;
- 40–60% regional specialty.

## Deep specialty expert

Example:
- 5–30B tokens;
- structured Wernicke input;
- 20–40% universal protocol/communication;
- 60–80% specialist corpus/trajectories.

## Process expert

Often better trained on:
- millions of verified environment trajectories;
- tool interactions;
- compiler/verifier rewards;
rather than massive generic text corpora.

These are starting hypotheses, to be fit by scaling experiments.

---

# 28. Dataset architecture

Reuse the Ilaria Data Foundry principle.

Core candidate sources:
- Common Pile
- FineWeb2
- FineWeb-Edu
- permissive-license code subsets
- peS2o/open science
- verified Romanian sources
- generated verifiable math
- generated code repair
- SwypikOS Environment Gym
- Common Voice / licensed multimodal corpora

Every expert has a declared curriculum manifest.

No hidden data mix.

---

# 29. Dataset specialization

Examples.

## IMC-Romanian-Language
- Romanian FineWeb2 quality slice
- Romanian Wikipedia
- verified public/open Romanian literature/reference
- EU/public legal corpus
- Romanian technical docs
- EN/RO translation pairs with commercial-compatible rights
- generated grammar/comprehension tasks

## IMC-Go
- permissive Go repos
- Go standard library/documentation if rights allow
- build/test traces
- compiler errors
- mutation/repair tasks
- race detector tasks
- Go issue/patch data with rights manifest

## IMC-NativeKernel
- permissive OS/kernel code
- architecture manuals with reuse rights
- generated driver/device simulations
- Swyp hardware manifests
- compiler/emulator verified tasks

## IMC-Math
- open mathematical text
- generated problems
- symbolic/verifiable solutions
- theorem tasks

## IMC-Agent
- Environment Gym trajectories
- tool success/failure
- verifier rewards
- capability/permission cases
- recovery/rollback.

---

# 30. Expert graduation

A newborn expert never becomes callable production capability just because loss decreased.

Stages:

0. NEWBORN
1. LEARNING
2. EVAL_READY
3. SHADOW
4. CANARY
5. VERIFIED
6. PRODUCTION
7. RETIRED

Requirements:
- specialty benchmark;
- general communication benchmark;
- hallucination/grounding;
- calibration;
- malicious-input tests;
- performance;
- memory;
- no regression beyond allowed bounds.

---

# 31. Expert diversity

A million identical experts is useless.

Encourage diversity through:
- different curated specialties;
- different seeds;
- different curriculum orders;
- different sparse synapse growth patterns;
- different reasoning objectives;
- different verifier environments.

But preserve common:
- tokenizer;
- Cortical Protocol;
- evidence model;
- trust semantics;
- Swyp interface.

---

# 32. Expert competition

For a specialty, keep multiple candidate experts.

Use a league:

- score on hidden tests;
- score on fresh tests;
- efficiency;
- calibration;
- robustness;
- long-term stability.

Thalamus learns which expert wins on which subdomain.

Do not collapse the whole population to one winner.

---

# 33. Expert cooperation

Specialists can return:

- facts;
- derivations;
- code patches;
- predictions;
- plans;
- counterexamples;
- critiques.

Integrator works over structured outputs, not raw hidden states.

This makes heterogeneous expert evolution possible.

---

# 34. Distributed memory vs distributed weights

Keep them separate.

## Weights

Global, signed, versioned expert artifacts.

## Global semantic knowledge

Curated source-indexed knowledge base and model training data.

## Personal episodic memory

Local Hippocampus, never globally synchronized by default.

## Working memory

Task-local.

Do not use global weight updates as a substitute for remembering a user's personal state.

---

# 35. Network directory

Create a distributed but signed **Cortex Registry**.

Each expert record:

- ID
- genome hash
- checkpoint hash
- specialty
- semantic SDR prototype
- supported languages
- supported modalities
- benchmark vector
- version
- status
- size
- runtime requirements
- training provenance
- rights manifest
- trust tier
- download locations
- parent/child lineage
- created/updated timestamps.

Registry metadata can be mirrored P2P.

Canonical promotion authority starts centralized/multi-sig service-side for safety; decentralization can evolve later.

---

# 36. Population scale

Do not target one million production-grade experts on day one.

Milestones:

- 8 experts
- 32
- 128
- 1,024
- 10,000
- 100,000
- 1,000,000 registry lineages only if routing/training economics justify it.

At every milestone test:
- retrieval precision;
- router collapse;
- duplication;
- storage;
- cache hit;
- network distribution;
- quality/compute curve.

---

# 37. Why one million is technically plausible as registry scale

At ~247.5MB raw packed synaptic slots per ~1B model:

- 1,000 experts ~247.5GB raw;
- 10,000 ~2.475TB;
- 100,000 ~24.75TB;
- 1,000,000 ~247.5TB.

This is large but plausible for a globally distributed content-addressed network.

It is **not** plausible to keep all experts on one device or execute all of them for each token.

The registry/mesh must remain sparse.

---

# 38. Training compute warning

A 1B model trained fully from random on tens of billions of tokens is still expensive.

Therefore:
- millions of experts cannot all receive full generalist pretraining independently with today's economics;
- most specialized models need narrower curricula;
- parent inheritance/mitosis should remain an optional later optimization even if Genesis experiments begin from zero;
- many candidate experts should die early;
- P2P resources must be allocated by expected capability gain.

This is a hard engineering constraint.

---

# 39. "Every device starts a model from zero" implementation

When a SwypikOS user opts in:

1. benchmark available hardware;
2. download Nursery runtime;
3. receive expert birth assignment;
4. derive deterministic random weights from signed genome seed;
5. initialize 1B RGBA address space;
6. receive signed curriculum shard;
7. train locally during approved idle windows;
8. checkpoint;
9. send only candidate model delta/metrics;
10. receive next round/checkpoint;
11. continue.

The user data never enters steps 4–10.

A low-resource device may instead receive:
- eval;
- rollout;
- verifier;
- data-validation roles.

---

# 40. Continuous growth loop

~~~text
EVAL FAILURE
   |
   v
Curiosity / Gap Detector
   |
   v
Failure Cluster
   |
   +--> existing expert can improve?
   |         |
   |         v
   |      new curriculum round
   |
   +--> missing specialty?
             |
             v
       Neurogenesis Proposal
             |
             v
       New IMC-1B genome
             |
             v
         P2P cohort
             |
             v
       candidate checkpoint
             |
             v
      independent evaluation
             |
             v
       registry graduation
~~~

This is the canonical growth mechanism.

---

# 41. Prefrontal adaptive expansion

Prefrontal controller tracks confidence.

If confidence high:
- use small assembly.

If disagreement high:
- activate more experts.

If evidence insufficient:
- query Hippocampus/search/tools.

If still unresolved:
- spawn asynchronous research/training gap proposal, but current user answer remains appropriately uncertain.

Inference never waits for future training.

---

# 42. Swyp integration

Experts do not execute arbitrary effects.

A MicroCortex may emit:
- answer packet;
- hypothesis;
- typed Swyp plan.

Swyp:
- type checks;
- checks preconditions;
- checks capabilities;
- verifies bounded contracts.

SwypikOS broker executes.

Verifier returns evidence.

All experts see evidence, not assumed success.

---

# 43. Core runtime roles

Minimum local production assembly:

- Thalamus Router IMC-1B
- Wernicke IMC-1B
- Generalist IMC-1B
- Planner IMC-1B
- Critic IMC-1B
- Broca IMC-1B

Plus dynamically cached specialties.

On constrained devices, roles may be serialized or combined experimentally, but canonical logic remains separate.

---

# 44. Training objectives

Per expert:

- next-token / sequence objective where language is central;
- structured Cortical Packet objective;
- specialty-specific supervised objective;
- confidence calibration;
- evidence citation/provenance;
- verifier-grounded RL;
- sparse synapse growth regularization;
- communication compression;
- expert abstention when out of domain.

Experts must learn **"not my domain"**.

That is essential for good routing.

---

# 45. Router training

Positive examples:
- task -> expert succeeds.

Hard negatives:
- semantically close expert fails;
- stale expert;
- wrong language;
- wrong capability;
- overconfident generalist.

Losses:
- retrieval ranking;
- load balance;
- value prediction;
- latency/cost penalty;
- locality/cache bonus.

Router output is not authoritative; verifier outcome updates routing statistics.

---

# 46. P2P research track

Implement controlled comparisons:

A. synchronous cohort SGD  
B. FedAvg  
C. DiLoCo-like  
D. streaming fragments  
E. decoupled/asynchronous  
F. expert-tournament without weight merging

Measure:
- convergence;
- bytes/token;
- robustness to dropout;
- heterogeneous GPU variance;
- stale update damage;
- malicious worker resilience.

No algorithm is chosen by ideology.

---

# 47. Required first experiments

## E1 — Is 1B the right unit?

Train:
- 250M
- 500M
- 1B
- 2B research control

same data/tokens where feasible.

Measure quality/latency/storage.

If 1B is not the Pareto point, change unit size through ADR.

## E2 — From-zero specialist vs inherited specialist

Even if product preference is from-zero, compare scientifically:
- random genesis;
- common primer checkpoint;
- parent mitosis.

Measure tokens-to-quality.

## E3 — 4 independent experts vs 4B single model

Equal active parameter/FLOP budget.

Measure:
- reasoning;
- code;
- domain;
- routing failures;
- ensemble benefit.

## E4 — 32 experts / top-4 vs single 8B baseline

Measure collective capability.

## E5 — remote vs downloaded expert

Measure:
- latency;
- bandwidth;
- privacy;
- cache behavior.

---

# 48. Success criterion

The architecture succeeds only if the **collective system** beats single-model baselines at matched or acceptable:

- quality;
- active compute;
- memory;
- latency;
- energy;
- training cost;
- reliability.

Do not declare victory because aggregate global parameter count is enormous.

---

# 49. Existing Ilaria components mapped into Myriad

Current -> Myriad role:

- Organism -> local cognitive lifecycle
- Brain -> legacy/procedural synaptic graph; migrate useful concepts, not duplicate cortex
- TernaryLayer -> IST32 primitive
- NeuroTexture -> sparse compute/storage primitive
- NeuroRadioCortex -> research router/communication primitive
- RadioCortex -> research sparse communication primitive
- Hippocampus -> personal episodic memory
- SemanticMemory -> concept consolidation
- WorkingMemory -> task-local state
- Cerebellum -> verified assembly/procedure cache
- Prefrontal -> recursive assembly controller
- ThousandBrains -> hypothesis committee
- FractalCortex -> expert birth/lineage manager
- Predictor -> surprise/gap signal
- ConfidenceLayer -> synaptic/expert confidence
- Curiosity -> curriculum/neurogenesis trigger
- Reward -> verifier-grounded learning signal
- SleepConsolidator -> local/global replay lifecycle
- Wernicke -> comprehension expert family
- Broca -> expression/synthesis expert family
- SelfModel -> capability/state awareness
- SwypikOS worldmodel -> specialized counterfactual model family

---

# 50. Build order

## M0
Truth baseline. No redesign code.

## M1
IMC-1B reference architecture + RGBA/ISQ.

## M2
Train 10M/50M/250M scaling fixtures.

## M3
Train 1B prototype.

## M4
Implement Cortical Protocol + Thalamus directory/router.

## M5
Run 8-expert local assembly.

## M6
Integrate Hippocampus/WorkingMemory/Cerebellum/Prefrontal.

## M7
Build Nursery sandbox + signed training job.

## M8
Two-node P2P cohort from random init.

## M9
8/32/128 expert registry.

## M10
Environment Gym + verifier RL.

## M11
1,024 expert routing/storage/load test.

## M12
10K+ population only if M11 wins.

Million-expert scale is an eventual systems target, not milestone 1.

---

# 51. Immediate implementation deliverables

Create ADRs:

- ADR-MYRIAD-001 — IMC-1B exact architecture
- ADR-MYRIAD-002 — Cortical Protocol
- ADR-MYRIAD-003 — Cortex Registry
- ADR-MYRIAD-004 — Thalamus hierarchical routing
- ADR-MYRIAD-005 — Nursery security boundary
- ADR-MYRIAD-006 — ISX P2P optimizer
- ADR-MYRIAD-007 — expert birth/graduation/retirement
- ADR-MYRIAD-008 — personal memory vs global training firewall

Then implement only:
1. deterministic IMC-1B genome/init;
2. 10M fixture;
3. RGBA forward/backward parity;
4. Cortical Packet schema;
5. 8-expert in-process router simulation.

Do not start massive training before these pass.

---

# 52. North Star

Ilaria Myriad is not one giant neural network.

It is a **living, sparse, distributed cortex**:

- each neural cortex is small enough to fit ordinary hardware;
- each cortex has a specialty;
- the Hippocampus remembers episodes instantly;
- Semantic Memory consolidates concepts;
- Cerebellum remembers verified procedures;
- Thalamus finds the right specialists;
- Prefrontal Cortex recursively assembles specialists for hard problems;
- ThousandBrains preserves competing hypotheses;
- Curiosity detects capability gaps;
- Neurogenesis births new 1B cortexes;
- P2P SwypikOS devices train them using only approved Ilaria data;
- Swyp and the verifier keep actions grounded;
- the network grows by adding verified brains instead of making one monolith indefinitely.

The intelligence target is the capability of the **organized collective**, not a parameter-count slogan.
