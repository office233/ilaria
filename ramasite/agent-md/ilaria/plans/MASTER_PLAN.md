# ILARIA / MYRIAD V2 — Living Cognitive Network

Date: 2026-09-29
Status: canonical V2; supersedes earlier IMC/Myriad planning where they conflict.
Goal: one native IMC-1B model on every SwypikOS device, millions of persistent model instances, each capable of local experience and specialization, connected through a learned and verified global connectome.

# 1. Thesis

Ilaria is not one big model served from a datacenter.

Ilaria is a living distributed cognitive network.

Every participating device has:
- the same native model family: IMC;
- a full resident IMC-1B inference model;
- local identity and checkpoint lineage;
- local episodic/procedural memory;
- a device/world interface;
- a competence profile that changes from verified experience;
- learned connections to useful peer experts;
- the ability to contribute compute, evaluation, experience, rollouts, verification, or candidate parameter updates.

At one million installations, Myriad is one million situated cognitive cells, not one million dumb replicas.

Research hypothesis:

A network of small persistent models that specialize from real verified experience, learn whom to consult, exchange proof-carrying experience, and consolidate knowledge across time can scale useful capability with the number and diversity of devices without activating or synchronizing every model for every task.

This is a hypothesis to prove, not a marketing assumption.

# 2. What is not the innovation

These are ingredients, not the core novelty:
- ternary/low-bit transformers;
- GQA/RoPE/RMSNorm/SwiGLU;
- Mixture-of-Experts;
- top-k routing;
- federated learning;
- DiLoCo-style low-communication optimization;
- globally distributed training;
- asynchronous RL;
- local device models;
- multi-agent orchestration.

Ilaria must not claim novelty merely for using them.

# 3. The seven Myriad research pillars

## 3.1 Genome / phenotype separation

Every cell shares a stable Genome:
- IMC architecture version;
- IlariaLex tokenizer;
- protocol version;
- Genesis ancestry;
- model-format contract.

Every cell develops a Phenotype:
- specialized weights/checkpoint lineage;
- local memory;
- competence vector;
- device embodiment;
- learned peer connections;
- trust/history.

One architecture becomes many useful experts without incompatible model families.

## 3.2 Proof-Carrying Experience — PCE

The primary transferable learning unit is a Verified Experience Capsule, not raw private data and not blindly trusted gradients.

Conceptual schema:

~~~
ExperienceCapsule
  id
  schema_version
  source_cell
  ancestry_hash
  domain
  observation_schema
  abstract_state
  action_or_hypothesis
  result
  reward
  verifier_type
  verifier_evidence_hash
  privacy_class
  provenance
  replay_recipe
  optional_parameter_delta_hash
  signature
~~~

Examples:
- code: patch -> tests -> PASS;
- OBD: telemetry -> diagnostic hypothesis -> confirmed repair/outcome;
- driver: probe -> candidate -> emulator/HIL result;
- math: solution -> exact verifier;
- tool use: request -> call -> real result.

Raw sensitive source data does not need to travel with a capsule.

## 3.3 Learned Connectome

Every directed peer relation is a learned Synapse:

~~~
Synapse
  source
  target
  domain_signature
  competence_prior
  verified_success
  counterfactual_gain
  latency
  energy_cost
  bandwidth_cost
  freshness
  trust
  uncertainty
~~~

A synapse strengthens only when consulting that peer improves a verified result.
Unused or harmful connections decay.

The topology itself learns.

## 3.4 Counterfactual routing

Routing is not trained only from the route that happened to execute.

For sampled tasks, evaluate equal-budget alternative routes offline:

~~~
route A -> verified score
route B -> verified score
route C -> verified score
~~~

Train Thalamus from the score differences.
Measure routing regret directly.

## 3.5 Collective sleep

Awake phase:
- inference;
- world interaction;
- memory;
- experience collection;
- safe evaluation/adaptation.

Sleep phase:
- replay verified experiences;
- deduplicate/noise-filter;
- consolidate local memory;
- create candidate updates;
- create PCE capsules;
- test forgetting;
- exchange accepted learning artifacts.

Expert families also perform collective sleep rounds using experiences from many cells.

## 3.6 Evolutionary lineage, not blind averaging

Do not blindly average every update.

Maintain a lineage DAG:

~~~
Genesis
  +-- Device-v12
  |     +-- Device-v13-A
  |     +-- Device-v13-B
  +-- Code-v8
        +-- Code-v9-A
        +-- Code-v9-B
~~~

Candidates compete on:
- specialty benchmarks;
- frozen regression;
- calibration;
- real verified tasks;
- adversarial tests;
- latency/memory/energy.

Promote the winner or promote none.

## 3.7 Embodied specialization

Specialization is earned from environment and verified competence.

A vehicle-resident cell can become automotive-specialized.
A developer-workstation cell can become strong in build/debug workflows.
An industrial cell can learn machine-specific dynamics.

The network learns what a cell is good at from evidence, not only from a name.

# 4. Canonical model

One production model family only: IMC.

IMC-1B:
- vocab_size: 65,536
- d_model: 2,048
- layers: 16
- attention_heads: 16
- kv_heads: 4
- head_dim: 128
- ffn_dim: 7,104
- initial context: 2,048
- RMSNorm
- RoPE
- GQA
- SwiGLU
- no linear biases
- tied embedding / LM head
- ternary block projections
- per-token int8 activation quantization
- parameters: 1,000,555,520

Canonical implementation: forge/imc_model.py.

# 5. Scale ladder

IMC-125M: 125,882,112 parameters.
IMC-250M: 247,559,168 parameters.
IMC-500M: 503,457,280 parameters.
IMC-1B: 1,000,555,520 parameters.

Smaller models are scientific checkpoints of the same architecture, not alternate products.

# 6. Pretraining schedule

M1 — IMC-125M:
- ~1B tokens;
- ternary/full-precision control;
- LR sweep;
- SwiGLU vs relu2 A/B;
- context A/B;
- checkpoint/resume correctness.

M2 — IMC-250M:
- ~5B high-quality tokens;
- clear quality gain over 125M required.

M3 — IMC-500M:
- 10–20B tokens;
- multi-GPU stability;
- scaling trend required.

M4 — IMC-1B bootstrap:
- first ~20B high-quality tokens.

M5 — IMC-1B production continuation:
- >=100B high-quality tokens;
- optionally continue toward 300B only while marginal benchmark gain justifies compute.

Freeze:
IMC-1B-GENESIS-v1
with architecture, tokenizer, data, recipe, checkpoint and evaluation hashes.

# 7. Data curriculum

Initial target mix:
- 28% curated general language/knowledge;
- 20% code/software engineering;
- 14% mathematics;
- 10% science/technical reasoning;
- 10% OS/hardware/drivers/standards;
- 8% verified agent/tool trajectories;
- 5% Romanian + selected multilingual;
- 5% verified world/device trajectories.

These are run-manifest parameters, not hardcoded constants.

Every source requires:
- rights/provenance;
- content hash;
- source revision;
- dedup status;
- benchmark contamination scan;
- privacy classification;
- domain/language tags;
- quality filters.

# 8. IlariaLex-65K

One tokenizer for every Myriad cell.

Target: exactly 65,536 token IDs.

Reserve a protocol range for:
- roles;
- actions;
- observations;
- tools;
- modalities;
- devices;
- sensors;
- temporal markers;
- verifier/result markers.

Examples:
<action:read>
<action:execute>
<action:probe>
<obs:result>
<obs:error>
<verify:pass>
<device:pc>
<device:phone>
<device:vehicle>
<bus:obd2>
<bus:can>
<sensor:rpm>
<sensor:temp>

Token IDs become immutable once Genesis training starts.

# 9. First Myriad

The first scientific Myriad contains:
1. GeneralCortex
2. CodeCortex
3. ReasoningCortex
4. DeviceCortex
5. ThalamusRouter

All five are IMC instances.
Genesis remains frozen as the sixth control checkpoint.

Why four specialists:
- enough to prove specialization;
- enough to prove cross-domain routing;
- small enough to audit;
- cheap enough to run counterfactual expert evaluation;
- failure diagnosis remains tractable.

Do not start with 16/64/100 experts before the four-specialist gate passes.

# 10. Expert roles

GeneralCortex:
- broad language;
- factual grounding;
- dialogue;
- synthesis;
- Romanian/multilingual.

CodeCortex:
- Go, Rust, C/C++, Python, TypeScript, Swyp;
- debugging;
- build/test repair;
- repository trajectories.

ReasoningCortex:
- math;
- logic;
- science;
- planning;
- verifier-backed reasoning.

DeviceCortex:
- OS internals;
- drivers;
- hardware;
- PCI/USB/ACPI/DeviceTree;
- OBD-II/CAN;
- phones;
- embedded;
- robotics;
- machine telemetry.

ThalamusRouter:
- task classification;
- decomposition;
- expert selection;
- confidence;
- escalation;
- route cost prediction;
- counterfactual route learning.

# 11. Routing

Default:

~~~
task
 -> cheap domain signature
 -> Thalamus
 -> top-1 expert
 -> verifier
 -> response
~~~

Hard/ambiguous:

~~~
task
 -> Thalamus
 -> expert A
 -> uncertainty/verifier
 -> expert B
 -> synthesis/verifier
~~~

Never broadcast to all experts by default.

# 12. Routing metrics

Track:
- top-1 oracle accuracy;
- top-2 oracle coverage;
- routing regret;
- cost-adjusted regret;
- latency regret;
- verifier pass rate;
- unnecessary-expert rate;
- missed-expert rate;
- calibration.

Pilot gates:
- top-1 oracle >=90%;
- top-2 coverage >=97%;
- routing regret <=5%;
- unknown expert selection = 0;
- deterministic GeneralCortex fallback.

# 13. Expert promotion gate

A candidate specialist must:
- improve specialty benchmark >=10% relative to Genesis;
- regress <=2 percentage points on frozen general suite;
- maintain/improve calibration;
- pass provenance/privacy checks;
- pass adversarial regression;
- improve a held-out set of real verified tasks;
- meet deployment memory/latency budget.

# 14. NetworkGain

Core metric:

~~~
NetworkGain =
  Myriad verified task success at budget B
  -
  best single IMC expert task success at the same budget B
~~~

Myriad only succeeds if NetworkGain is positive.

Also track:
- LearningYield = verified capability gain / training kWh
- TransferEfficiency = capability gain from a capsule / bytes transferred
- SynapticUtility = verified gain attributable to a peer edge / peer cost

# 15. WorldEvent

Every device connector emits typed WorldEvents:

~~~
WorldEvent
  event_id
  time_delta
  device_class
  device_model_hash
  source_namespace
  observation_type
  features
  previous_action
  action
  result
  verifier
  confidence
  privacy_class
~~~

Raw streams are not blindly turned into language text.

# 16. Vehicle learning

Start read-only.

Inputs:
- OBD-II PIDs;
- DTCs;
- freeze frames;
- RPM;
- speed;
- engine load;
- throttle;
- temperatures;
- voltage;
- fuel/air data;
- documented/permitted CAN signals.

High-value sequence:

~~~
symptom
 -> telemetry
 -> hypothesis
 -> diagnostic action
 -> observation
 -> repair/action
 -> measured outcome
 -> verifier
~~~

No global VIN/location/person-identifying telemetry by default.
Safety-critical control remains simulation/HIL/independently verified policy territory until proven safe.

# 17. Phone learning

Potential WorldEvents:
- accelerometer/gyroscope;
- battery/thermal/charging;
- network class;
- app state;
- accessibility/UI;
- action/result traces;
- camera/audio only with explicit permission.

Personal content remains local unless policy explicitly allows a sanitized transferable capsule.

# 18. PC learning

This is an early high-quality environment because verification is strong.

Use:
- compiler output;
- tests;
- filesystem actions;
- process state;
- browser/DOM/accessibility;
- builds;
- logs;
- hardware telemetry.

Canonical trajectory:

~~~
goal
 -> inspect
 -> hypothesis
 -> action
 -> error/result
 -> repair
 -> test
 -> verified success/failure
~~~

# 19. Driver/hardware learning

Use:
- public driver source;
- datasheets;
- hardware manifests;
- PCI/USB/ACPI/DeviceTree;
- emulator traces;
- kernel logs;
- candidate drivers;
- static checks;
- HIL verification.

Model confidence is never device authority.
SwypikOS capabilities remain the authority layer.

# 20. Three timescales of learning

Fast — local memory:
- milliseconds/seconds;
- episodic/semantic/procedural memory;
- no uncontrolled global weight mutation.

Medium — local plasticity:
- minutes/hours;
- replay verified experiences;
- generate candidate updates;
- train selected/full parameters depending on hardware;
- test forgetting;
- create PCE capsules.

Slow — collective consolidation:
- hours/days;
- aggregate accepted experiences by expert family;
- spawn candidate descendants;
- train;
- tournament evaluation;
- promote one or none;
- publish signed checkpoint.

# 21. Full IMC-1B on every eligible device

Target every eligible SwypikOS installation to host a full IMC-1B inference model.

Deployment work:
- packed ternary projection matrices;
- low-bit/int8 embeddings if quality gate passes;
- compact fp16 scaling/norm state;
- quantized KV cache where useful;
- mmap/streamed cold weights where necessary.

Objective: sub-1GB resident footprint where realistic.

Do not claim that every tiny microcontroller can host 1B.

# 22. Weak-device training contribution

A phone does not need Adam state for all 1B parameters to contribute to training the full 1B system.

Possible jobs:
- inference rollouts;
- verified eval;
- WorldEvent encoding;
- capsule construction;
- replay;
- parameter-block training;
- sparse layer/block updates;
- candidate delta verification;
- synthetic environment tasks.

Use rotating parameter/block leases on memory-constrained devices.

# 23. ISX — Ilaria Swarm eXchange

Training Job:
- job ID;
- expert lineage;
- architecture hash;
- tokenizer hash;
- checkpoint hash;
- data/capsule shard hash;
- parameter/block ownership;
- recipe hash;
- seed;
- local steps;
- precision;
- resource limits;
- deadline;
- verifier policy.

Result:
- before/after hashes;
- delta/capsule hashes;
- tokens/episodes processed;
- metrics;
- sentinels;
- runtime/energy metrics;
- device signature.

# 24. Swarm roles

A node may act as:
- inference/rollout worker;
- evaluator;
- verifier;
- capsule builder;
- parameter-block trainer;
- full trainer;
- aggregation verifier;
- checkpoint distributor.

Role assignment follows measured capability, not device marketing labels.

# 25. Byzantine resistance

Public workers are untrusted.

Use:
- signed identity;
- signed jobs;
- content-addressed artifacts;
- replicated tasks;
- random spot checks;
- sentinels;
- update norm/distribution checks;
- robust aggregation;
- reputation;
- quarantine;
- rollback;
- full lineage trace.

Critical promotions are independently verified on trusted compute.

# 26. Privacy

Privacy classes:
PUBLIC
CURATED
DEVICE_NONPERSONAL
LOCAL_PRIVATE
SENSITIVE
FORBIDDEN_GLOBAL

Personal memory defaults to LOCAL_PRIVATE.

PCE export fails closed if provenance/privacy policy cannot prove transferability.

Long-term research:
- secure aggregation;
- differential privacy where quality permits;
- hardware-backed identity/attestation;
- leakage audits.

# 27. Collective sleep round

1. freeze current production expert;
2. collect accepted PCE capsules;
3. stratify by domain/difficulty/source;
4. deduplicate;
5. adversarially scan;
6. mix with old replay;
7. spawn multiple descendants;
8. train;
9. run specialty + regression + calibration + adversarial + real-task tests;
10. compare candidates;
11. promote exactly one or none;
12. publish signed checkpoint;
13. update competence/connectome metadata;
14. retain rollback ancestry.

# 28. Catastrophic forgetting

Every specialist update includes:
- specialty data;
- Genesis/general replay;
- prior expert replay;
- hard routing negatives;
- calibration data;
- adversarial regression.

Promotion blocks large base-capability loss.

# 29. Self-organizing specialty discovery

After the first manually seeded experts:

1. collect task embeddings + verified outcomes;
2. cluster recurring unmet tasks;
3. detect cells repeatedly outperforming peers;
4. propose an emerging specialty;
5. freeze a benchmark for it;
6. branch/train a candidate expert family;
7. promote only if it creates positive NetworkGain.

This is how 4 becomes 16, 64, 1,024 without arbitrary taxonomy.

# 30. Expert scale path

Stage A: 4 specialists + Thalamus.
Stage B: 16 expert families.
Stage C: 64.
Stage D: 1,024 with hierarchical routing.
Stage E: 10k+ lineages/replicas.
Stage F: 1,000,000 resident cells.

Physical cells and distinct expert families are different quantities.

# 31. Million-node topology

Avoid all-to-all.

~~~
Cell
 -> local cohort
 -> domain/region fabric
 -> expert-family registry
 -> global lineage registry
~~~

Prefer local/nearby experts when competence is equivalent.
Aggregate training by lineage/expert family.

# 32. Experiment: network scaling law

At N = 1, 2, 4, 8, 16, 32, 64 experts, measure at equal inference budget:
- verified success;
- NetworkGain;
- routing regret;
- latency;
- bytes transferred;
- energy;
- specialization entropy;
- utilization;
- failure resilience.

Build an empirical network scaling curve.

If quality plateaus, fix the architecture before adding nodes.

# 33. Experiment: can cells teach cells?

A learns a task family.
B learns from:
1. raw public examples;
2. teacher traces;
3. PCE capsules;
4. parameter delta;
5. capsule + delta;
6. no transfer.

Measure:
- sample efficiency;
- transfer bytes;
- forgetting;
- verified final success.

# 34. Experiment: can the connectome learn?

Start with uniform/random peer edges.
Run a multi-domain task stream.

Compare:
- static routing;
- central top-k;
- learned synapses;
- learned synapses + counterfactual routing.

Measure whether the graph discovers useful expert topology while reducing communication.

# 35. Experiment: embodied specialization

Start identical descendants on:
- developer PC;
- vehicle simulator/OBD replay;
- phone;
- robotics/embedded simulator.

After equal verified experience budgets, test:
- domain gain;
- cross-domain regression;
- PCE transfer;
- competence discovery;
- routing accuracy.

This is a flagship experiment.

# 36. Swyp role

Swyp is proof/contract infrastructure, not a second brain.

Use it for:
- model/expert manifests;
- WorldEvent/PCE schemas;
- capability contracts;
- training jobs;
- verifier interfaces;
- action plans;
- device/driver plans;
- rollback invariants.

# 37. SwypikOS role

SwypikOS owns:
- device identity;
- permissions;
- explicit user consent;
- capability authority;
- device discovery;
- sensor connectors;
- model lifecycle;
- resource/thermal policy;
- sandboxing;
- transport;
- Compute Fabric worker;
- checkpoint update/rollback.

Ilaria never gains OS authority merely because confidence is high.

# 38. Target repository structure

~~~
ilaria/
  forge/
    imc_model.py
    train_ilaria.py
    training_state.py
    tokenizer/
    datasets/
    eval/
    pce/
    isx/
  runtime/
    imc/
    memory/
    router/
    connectome/
    world/
    tools/
  verifier/
  specs/
    myriad.swyp
    pce.swyp
    world.swyp
    training.swyp
  bench/
    imc/
    myriad/
    routing/
    continual/
    device/
    swarm/
~~~

Do not recreate the deleted legacy cortex.

# 39. Execution milestones

M0 Purity:
- no legacy model dependencies;
- IMC self-contained;
- canonical plan/spec;
- all tests green.

M1 IlariaLex:
- fixed 65K;
- reserved protocol IDs;
- determinism/hash tests.

M2 Data engine:
- provenance;
- dedup;
- contamination;
- quality;
- immutable manifests.

M3 IMC-125M:
- 1B tokens;
- ternary/full control;
- architecture/optimizer experiments.

M4 IMC-250M:
- 5B tokens;
- scaling gate.

M5 IMC-500M:
- 10–20B;
- distributed training gate.

M6 IMC-1B Genesis:
- 20B bootstrap;
- 100B+ continuation;
- freeze Genesis.

M7 PCE:
- schema;
- code/test capsules;
- two-cell capsule replay.

M8 Myriad 4+1:
- four specialists;
- Thalamus;
- counterfactual routing;
- learned connectome.

M9 WorldEvent:
- PC;
- phone;
- OBD simulator/read-only;
- hardware/driver connectors.

M10 Local sleep:
- replay;
- candidate generation;
- forgetting tests.

M11 Collective sleep:
- candidate lineage;
- tournament promotion.

M12 ISX trusted:
- 2 -> 4 -> 8 nodes;
- fault/restart tests.

M13 Heterogeneous swarm:
- phone/PC/workstation;
- block jobs;
- capsule jobs;
- rollout/eval jobs.

M14 16/64 experts:
- only if NetworkGain stays positive.

M15 Public swarm:
- identity;
- consent;
- verification;
- revocation;
- reputation.

M16 Million-cell architecture:
- hierarchical registry;
- distributed connectome;
- expert-family placement;
- observability.

# 40. The first "wow" demonstration

Do not demo only a chatbot benchmark.

Demonstrate knowledge becoming collective:

1. a vehicle simulator or read-only OBD source exposes a fault pattern unknown to the initial DeviceCortex;
2. the local cell investigates telemetry and technical evidence;
3. a verifier confirms the diagnostic sequence/outcome;
4. the local cell stores the experience;
5. sleep creates a privacy-safe PCE capsule;
6. a second DeviceCortex on another machine receives/replays it;
7. that cell solves a held-out related fault it previously failed;
8. the Connectome increases trust in the originating lineage;
9. CodeCortex is consulted for a driver/tool problem;
10. routed Myriad succeeds on a cross-domain task where every initial individual cell failed.

This single demo proves:
- embodiment;
- local learning;
- memory;
- privacy-aware transfer;
- verification;
- specialization;
- peer teaching;
- learned connections;
- collective improvement.

# 41. Claims discipline

Do not claim:
- AGI;
- consciousness;
- that a million nodes automatically improve quality;
- a literal dense 10^15-parameter model;
- that every phone can continuously full-parameter-train 1B;
- that distributed training itself is novel.

The revolutionary claim is conditional on experiments:

A verified living network of persistent device-native models can accumulate embodied skill, specialize, learn its own inter-model topology, and transfer useful experience across heterogeneous devices while retaining one compatible model genome.

# 42. Current implementation evidence — 2026-09-29

Implemented and verified at tiny/mechanism scale:

- legacy cortex/model compatibility removed from the canonical Ilaria path;
- IMC architecture is self-contained;
- IlariaLex-65K contract implemented as 61,440 learned IDs + 4,096 protocol IDs;
- deterministic architecture/model manifests implemented;
- WorldEvent v1, signed PCE, replay compatibility and Ed25519 verification implemented;
- content-addressed `ilaria-pce-replay-v1` artifacts are generated only after signature/ancestry/privacy verification and are consumed by Forge without post-action result leakage;
- learned Connectome + configurable top-K router implemented;
- Collective Sleep v1 implements validation-NLL checkpoint selection, early stopping, forgetting gates and best-checkpoint restoration;
- PCE Transfer v2 frozen benchmark passes its unchanged four-seed tiny-IMC promotion gate;
- formal result: positive causal NLL advantage in 4/4 seeds, positive top-1 advantage in 3/4 seeds, no top-1 regression in 4/4, zero loss of already-mastered anchor mappings;
- production tokenizer-sample creation is rights-gated and `ilarialex-freeze-v1` pins the sample, source coverage, rights registry, tokenizer and companion artifact hashes;
- Genesis v1 is now explicitly **English-first**: the 1B-token curriculum assigns `romanian_multilingual=0`; the removed 50M-token Romanian allocation is redistributed to general English knowledge, code, mathematics and science/technical reasoning;
- the locked English-first mix is 300M general knowledge, 220M code, 145M mathematics, 105M science/technical reasoning, 100M OS/hardware/drivers/standards, 80M agent/tool trajectories and 50M world/device trajectories;
- production tokenizer coverage is content-addressed per required category (`english`, `code`, `math_science`, `os_drivers`, `hardware`, `tools_protocol`) and cannot be satisfied by labels alone; the tokenizer remains byte/Unicode-capable without a dedicated Romanian training corpus;
- registry approval is evidence-closed: pinned evidence must also be `APPROVED`, have zero unresolved obligations and match the declared license/source lock;
- `forge/production_readiness.py` produces one read-only blocker report for rights plus missing production artifacts;
- `forge/imc_125m_preflight.py` fail-closes the first serious 125M run unless tokenizer freeze, dataset manifest, rights identity, EOS/protocol IDs, exact 125,882,112-parameter shape and the ~1B-token train budget all agree.
- external corpus repositories are pinned by `ilaria-corpus-source-lock-v1`; production acquisition refuses mutable upstream `main` revisions;
- external Git corpus candidates are pinned independently by `ilaria-git-source-lock-v1`; the current lock covers Zephyr, Go, CPython, Rust, FreeRTOS-Kernel and FreeBSD at exact commit SHAs;
- Zephyr staging is built outside the Nexus worktree: the hardened SPDX manifest contains 13,417 accepted files / 107.6 MB, excludes disallowed licenses, known agent-instruction files and strong secret markers, and produces canonical raw corpus shards compatible with `curate_corpus.py`;
- the real Zephyr curation attempt is intentionally rejected while its rights state remains `REVIEW_REQUIRED`, proving the staging-to-production boundary is fail-closed;
- SPDX expression parsing is fail-closed and preserves full expressions (`AND`/`OR`); mixed restrictive branches, `WITH` exceptions and ambiguous multiple declarations are rejected unless explicitly modeled;
- immutable Git acquisition verifies exact locked commit + remote, never initializes submodules implicitly, removes partial checkouts on mismatch, and licensed-tree scanning rejects symlinks;
- FreeRTOS-Kernel has been exercised end-to-end at locked commit `8be86d4a24fd4091f8f4192018423ab590f408db`: 636 files / 14.48 MB passed the SPDX allowlist, while the subsequent curation attempt was correctly rejected by the `REVIEW_REQUIRED` rights gate;
- `ilaria-first-party-attestation-v1` pins first-party contract file hashes without assuming ownership; the current tools/protocol template remains deliberately unsigned until explicit ownership/provenance attestation;
- `ilaria-rights-review-decision-v1` binds any future human approval/rejection to the exact evidence/source-lock hashes and requires every pinned obligation to be explicitly resolved before `APPROVED` can be applied;
- `ilaria-rights-evidence-v1` is hash-linked to the source lock and rights registry while approval remains explicitly manual;
- `forge/config/imc_125m_recipe.json` fixes the bootstrap 125M recipe at 1B target tokens and 262,144 global batch tokens, with matched ternary/full-precision three-seed controls;
- the trainer accepts `--target-tokens` and records the resolved horizon in its exact-resume signature, production runs require both dataset manifest and tokenizer freeze, and `--sample-tokens 0` disables post-run generation for smoke/CI without changing the training signature;
- the canonical **125,882,112-parameter** IMC-125M has now executed a real CPU smoke on both ternary and full-precision paths; ternary pause/resume advanced schema-v3 checkpoint state from step 1 to step 2, retained the better step-1 export after validation regressed, and verified the stored best-export SHA256 against the actual artifact;
- this smoke is explicitly non-promotable and uses a synthetic 8,192-token stream with `ctx=4`; its reproducibility record is `bench/imc_125m_smoke/RESULTS.md` and does not replace the required ~1B-token production run.
- `forge/gpu_preflight.py` fail-closes serious launches on missing CUDA, insufficient GPU count/VRAM/compute capability and optional bf16 requirements; the current host correctly fails because its PyTorch build is CPU-only;
- `forge/imc_125m_launch.py` now emits content-addressed initial or resume launch contracts; resume manifests pin the checkpoint SHA256 while `stop_after` preserves the original 1B-token training horizon. Operational steps are documented in `docs/runbooks/IMC_125M_GPU_TRAINING.md`.

Not yet demonstrated:

- PCE transfer at IMC-125M;
- production English-first IlariaLex tokenizer trained on the final rights-approved representative corpus sample (current required sources remain REVIEW_REQUIRED);
- large-scale continual learning;
- four-expert NetworkGain;
- real OBD/phone/device transfer;
- public or million-node swarm behavior.

Evidence: `bench/myriad/pce_transfer_v2/RESULTS.md` and `bench/imc_125m_smoke/RESULTS.md`.

# 43. Immediate next actions

1. Complete manual rights review using `forge/config/data_rights_evidence.json`; record decisions through `ilaria-rights-review-decision-v1`, close every pinned obligation, then rerun `forge/production_readiness.py`.
2. Complete technical/source review for the preferred English-first corpus lanes (Zephyr for code/OS/drivers/hardware, reviewed English Wikipedia/math-science sources) and explicitly attest first-party ownership/provenance for the tools/protocol contract set.
3. Assemble content-addressed tokenizer coverage evidence for EN/code/math-science/OS-drivers/hardware/tools-protocol from approved/eligible sources.
4. Train and freeze the production IlariaLex-65K artifact through the rights-gated `ilarialex-freeze-v1` path.
5. Run `forge/imc_125m_preflight.py` against the frozen tokenizer + dataset manifests, then start the IMC-125M base recipe only if it passes.
6. Freeze the resulting 125M base checkpoint and regression suite.
7. Repeat PCE Transfer v2 on real IMC-125M + IlariaLex-65K with at least 5–10 seeds.
8. Compare PCE against raw examples, teacher traces and parameter-delta transfer at equal byte/compute budgets.
9. Prove learned-synapse routing with four 125M specialists.
10. Scale 250M -> 500M only after NetworkGain and continual-learning gates pass.
11. Train IMC-1B Genesis.
12. Repeat Myriad/PCE/Connectome experiments at 1B.
13. Integrate WorldEvent and ISX into SwypikOS.
