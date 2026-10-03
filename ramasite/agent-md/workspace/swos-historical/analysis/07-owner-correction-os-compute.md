# OWNER CORRECTION — SwypikOS kernel direction + community compute

**Date:** 2026-09-28  
**Authority:** owner  
**Status:** active strategic correction

## 1. SwypikOS is not defined as Linux

The repository's current Linux path is useful and real as a boot/reference prototype, but it is not the product decision.

Previous wording that fixed Linux LTS as the production kernel is superseded.

Required next decision:
- Swypik-owned kernel/platform prototype;
- hybrid compatibility architecture;
- Linux reference candidate;
- same workloads, same hardware class, reproducible measurements;
- owner approval before one path becomes the product base.

No agent may merge or describe a Linux implementation as “the final SwypikOS architecture” solely because it is faster to bring up.

## 2. Product ambition

SwypikOS is intended to outperform existing operating systems on the workload classes it owns:
- agentic task completion;
- durable autonomous workflows;
- recovery after crash/power/network failure;
- capability-based security;
- local-first AI;
- own search;
- cognitive continuity through Ilaria;
- distributed compute contributed by users;
- low idle/resource overhead;
- safe update/rollback.

Claims must be benchmarked against relevant Windows/macOS/Linux baselines. “Best OS” is a target, not an unmeasured release claim.

## 3. Ilaria is a cognitive organism

Ilaria is not a simple LLM.

Ilaria includes:
- attention/salience;
- working memory;
- episodic memory / hippocampus;
- semantic memory;
- learning/consolidation;
- planning/goals/tool-use;
- self-evaluation/metacognition where implemented;
- language/reasoning cortex, currently including BitNet inference.

The model is a component of Ilaria, not Ilaria itself.

## 4. Swyp Compute Fabric is a first-class pillar

People who install SwypikOS can explicitly opt in to contribute idle GPU/CPU/NPU compute.

The platform must support:
- explicit consent, off by default;
- immediate revocation/yield;
- idle/power/thermal/VRAM/bandwidth schedules;
- device identity and measured hardware capabilities;
- signed/versioned job manifests;
- content-addressed input/output artifacts;
- leases, deadlines, heartbeat, preemption and checkpoint;
- sandboxed execution without implicit access to personal files/conversations;
- result hash/signature;
- replication, spot checks, robust aggregation and independent verification;
- useful verified compute accounting;
- heterogeneous hardware scheduling;
- coordinator protocol not permanently locked to one cloud vendor.

Candidate workloads:
- Ilaria evals;
- synthetic-data verification;
- LoRA/adapters;
- distillation;
- embedding/index builds;
- search experiments;
- batched inference;
- selected training workloads suitable for unreliable heterogeneous nodes.

Do not treat consumer nodes as one synchronous GPU supercomputer. Use workload decomposition that tolerates disconnects and heterogeneity.

## 5. Zero crypto remains in force

Community compute is NOT cryptocurrency mining.

Remove/retire:
- SWP coin rewards;
- wallet product semantics;
- mining/hash-work;
- crypto-economic proof-of-work.

Keep legitimate cryptography:
- TLS;
- hashes;
- digital signatures;
- encryption;
- attestation;
- Secure Boot/measured boot where applicable.

## 6. Existing Linux M1 worktree

`E:\CEO\wt\swos-os-platform-m1` is retained as a **Linux reference candidate**.

Its mkosi/systemd/NetworkManager/A-B declarations can be useful for:
- compatibility comparison;
- hardware bring-up;
- measuring the Linux baseline;
- learning which platform contracts SwypikOS needs.

It must not be integrated as the final product-base decision before ADR-OS-BASE-001.

## 7. Immediate engineering priorities

1. Finish QA on current M1 Control Kernel / Security / Swyp effects candidates.
2. Repair any QA-rejected invariants.
3. Write ADR-OS-BASE-001 benchmark contract.
4. Build minimal Swypik-owned kernel/platform spike in a new isolated worktree.
5. Keep Linux candidate isolated as reference.
6. Write SPEC-COMPUTE-FABRIC-v1.
7. Implement coordinator + two-node real GPU pilot before scaling.
8. Benchmark, then decide.
