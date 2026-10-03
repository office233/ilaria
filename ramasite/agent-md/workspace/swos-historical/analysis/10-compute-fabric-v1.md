# SPEC-COMPUTE-FABRIC-v1 — Swyp verified community compute

Status: M1 design contract
Date: 2026-09-28
Owner intent: opted-in SwypikOS devices contribute useful idle GPU/CPU/NPU compute to Ilaria and platform workloads.

## 1. Safety and product invariants

1. Contribution is OFF by default and revocable immediately.
2. User workload always wins over contributed workload.
3. Personal files, conversations and local secrets are not training data by default.
4. Device workers execute signed/versioned job bundles only.
5. Contributor results are untrusted until independently verified.
6. Work is accepted exactly once by lease/job/result identity.
7. No cryptocurrency, mining or proof-of-work economics.
8. Coordinator protocol is cloud-vendor-neutral.
9. Every accepted result has provenance, artifact hashes and verifier evidence.
10. Unsupported hardware degrades safely; no hidden driver/runtime downloads.

## 2. Roles

- Device Agent: local consent, resource governor, hardware inventory, lease client.
- Coordinator: registry, scheduler, leases, artifact manifests, checkpoint lineage.
- Artifact Store: content-addressed immutable inputs/outputs.
- Verifier: replication, gold tasks, spot checks, deterministic checks.
- Aggregator: applies only accepted verified updates.
- Ilaria Planner: chooses eligible workload classes, not raw device authority.

## 3. Device enrollment

Device publishes a privacy-safe capability record:
- device public key / enrollment identity;
- SwypikOS build and Compute ABI version;
- CPU architecture/features;
- GPU/NPU vendor/model/VRAM/runtime capabilities;
- RAM;
- measured benchmark classes;
- power/thermal control availability;
- bandwidth class;
- supported job runtimes.

Do not upload raw serial numbers, user paths, SSIDs, MAC addresses or unrelated personal data.

## 4. Consent policy

Local policy is authoritative:
- enabled;
- idle-only;
- AC-only / battery threshold;
- allowed hours;
- max GPU percent;
- max VRAM;
- max CPU percent;
- max RAM;
- max temperature;
- max upload/download;
- allowed workload classes;
- immediate pause/revoke.

Coordinator cannot override local policy.

## 5. JobManifest v1

Fields:
- schema/version;
- job_id;
- workload_class;
- lease_id;
- attempt;
- deadline;
- input artifact hashes;
- base checkpoint/model/index hash;
- runtime/toolchain identity;
- required capabilities;
- hardware constraints;
- resource limits;
- deterministic seed where applicable;
- checkpoint cadence;
- expected output schema;
- verifier policy;
- coordinator signature.

A device rejects unknown schema, bad signature, unavailable inputs, forbidden capabilities or resource requirements above local policy.

## 6. Lease semantics

State:
QUEUED -> LEASED -> DOWNLOADING -> RUNNING -> CHECKPOINTING -> UPLOADING -> SUBMITTED -> VERIFYING -> ACCEPTED

Other states:
PREEMPTED, EXPIRED, REJECTED, CANCELLED, FAILED.

Rules:
- heartbeat extends only the current lease/fence;
- stale lease cannot submit authoritative result;
- retry gets a new fence;
- duplicate submit is idempotent;
- checkpoint may migrate to another compatible device only when workload semantics allow;
- user activity can preempt without penalty.

## 7. Artifact model

All job inputs/outputs are content-addressed.
Required hashes:
- bundle;
- source/IR;
- dataset shard;
- model/checkpoint;
- toolchain/runtime;
- output;
- logs/evidence manifest.

No mutable "latest" pointer is accepted as an authoritative input.

## 8. Verification policies

Depending on workload:
- deterministic exact replay;
- k-way replication;
- coordinator gold task;
- randomized spot-check;
- tolerance-bound numeric comparison;
- robust aggregation;
- provenance/schema validation.

No worker self-declared IsPoisonous/ProofOfCompute flag is trusted.

For training updates:
- validate shape/checkpoint lineage;
- finite values/norm constraints;
- compare replicated/gold outcomes;
- robust aggregation;
- eval gate before promotion.

## 9. Workload classes

M1 preferred:
1. eval shards;
2. benchmark shards;
3. synthetic-data validation;
4. embeddings/index segments;
5. LoRA/adaptor training shards;
6. distillation batches;
7. batched inference.

Later:
- asynchronous/federated full training when network/hardware economics are measured.

Avoid synchronous all-reduce across unreliable consumer nodes unless measurement proves it useful.

## 10. Resource governor

Local sampler tracks:
- foreground idle state;
- AC/battery;
- GPU utilization/VRAM;
- CPU/RAM;
- temperature/power;
- network availability.

Preemption requirement:
user returns -> stop scheduling -> checkpoint if safe -> release GPU promptly -> report PREEMPTED.

## 11. Security

- signed coordinator manifests;
- pinned trust roots with rotation;
- sandboxed worker;
- no ambient filesystem/network;
- artifact-only filesystem view;
- egress allowlist;
- per-job capability grants;
- no arbitrary shell from coordinator;
- bounded logs and secret redaction;
- worker update signing;
- compromised node treated as Byzantine.

## 12. Ilaria relationship

Ilaria is the cognitive system consuming compute. Compute Fabric is infrastructure, not Ilaria's identity.

Ilaria may:
- propose workloads;
- choose eval/training goals;
- analyze verified outcomes.

Ilaria may not:
- bypass local consent;
- directly grant device authority;
- promote unverified model updates.

## 13. M1 pilot acceptance

A real two-node pilot passes when:
1. two separately enrolled devices advertise measured capabilities;
2. both opt in;
3. coordinator signs one reproducible workload;
4. both receive independent leases;
5. one device disconnects and resumes/retries safely;
6. duplicate submission is accepted at most once;
7. verifier compares/spot-checks results;
8. accepted result is content-addressed and linked to exact inputs/runtime;
9. local revoke stops new work immediately;
10. no user data/secrets appear in artifacts/logs.

## 14. Current repository migration

`core/compute` hardware detection can seed the new capability inventory.
`core/federated` and `core/swarm` are not production foundations: simulated gradients, coin/reward and hash-work semantics must not be promoted.
Reuse only mathematical/structural ideas after fresh tests and zero-crypto cleanup.
