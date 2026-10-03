# SWYPIKOS — MASTER ARCHITECTURE & EXECUTION PLAN

**Data:** 2026-09-28  
**Program:** SWOS-000  
**Repo:** `E:\nexus`, main @ `96290fa`  
**Scope:** SwypikOS + Ilaria + Swyp Lang  
**Status:** architecture/truth audit; no SwypikOS source modifications in this phase.

## 0. North Star

Construim trei plane clare, fără runtime-uri duplicate:

```text
┌────────────────────────────────────────────────────────────────────┐
│                    SWYPIKOS — AUTHORITY PLANE                      │
│ first-party OS substrate; production kernel/base decided by ADR    │
│ Control Kernel / Task DAG / leases / recovery / capabilities      │
│ sandbox / resource budgets / evidence / search / desktop / update │
└───────────────────────────────┬────────────────────────────────────┘
                                │ AgentTurn / Tool ABI / EffectRequest
                                ▼
┌────────────────────────────────────────────────────────────────────┐
│                    ILARIA — COGNITIVE PLANE                        │
│ Organism + attention + working/episodic/semantic memory + learning│
│ planning/tool-use + BitNet language/inference cortex               │
│ persistent cognitive identity; no ambient OS authority             │
└───────────────────────────────┬────────────────────────────────────┘
                                │ proposal / Swyp source / typed plan
                                ▼
┌────────────────────────────────────────────────────────────────────┐
│                  SWYP — SEMANTICS & VERIFICATION PLANE             │
│ Core IR / contracts / bounded verifier / deterministic executor   │
│ explicit effects + capabilities / STV2/SWYPB                      │
└───────────────────────────────┬────────────────────────────────────┘
                                │ effect request
                                ▼
                    SwypikOS Capability Broker
```

Ownership-ul este strict:
- **SwypikOS platform/kernel layer** = hardware/process/memory/device authority. Production base is NOT assumed; Linux currently exists only as a bootable reference/prototype path until the owner-approved OS-base ADR.
- **SwypikOS Control Kernel** = userspace autonomous control plane.
- **Ilaria** = cognitive organism: perception/context, attention, working memory, episodic/semantic memory, learning/consolidation, planning/tool-use and language/inference.
- **Swyp Lang** = typed semantics, contracts, verification, deterministic guest execution.
- **SwypikOS Capability Broker** = singurul owner al efectelor host/device.
- **Swyp Compute Fabric** = opt-in distributed compute plane contributed by users' idle accelerators, with signed jobs, leases, sandboxing and independent result verification.

## 1. Ce este real astăzi

### 1.1 Windows
Produsul curent Windows este o aplicație nativă Go/Win32, fără Electron/Chromium/WebView. Este util ca development/reference shell, dar nu este sistem de operare independent.

Import graph-ul real al `cmd/swypik-os` include:
- config
- core/network
- internal/safepath
- core/agent
- core/coder
- core/compute
- core/ilaria
- core/search
- core/service
- ui/desktop
- ui/theme
- ui/engine

Packages existente dar neimportate de runtime-ul Windows nu sunt product capabilities.

### 1.2 Linux
Există un prototype bootabil real:
UEFI/BIOS → GRUB → kernel Linux stock → initramfs → BusyBox init → swypikd + swypik-session.

Este RAM-only, QEMU-oriented și diagnostic. Are:
- real Linux kernel/modules;
- VirtIO/E1000 etc. pentru VM;
- DHCP prin udhcpc;
- framebuffer;
- evdev keyboard;
- private Unix-socket daemon;
- agent/search service.

Nu are încă:
- persistent install;
- broad firmware/module/device management;
- Wi-Fi/Bluetooth;
- Wayland compositor;
- audio/camera;
- power/laptop lifecycle;
- Secure Boot trust chain;
- signed A/B updates/recovery;
- app sandbox/package platform;
- qualified physical hardware matrix.

### 1.3 Agent runtime
`core/agent` este un single-run, bounded, approval-gated runtime cu proprietăți bune:
- structured planner output;
- limits;
- atomic checkpoint;
- consumed-approval-before-execute;
- crash window detectat ca `uncertain`;
- no blind replay;
- fail-closed storage;
- explicit resume;
- process descendant cleanup.

Nu este încă autonomous kernel:
- un singur Run;
- fără persisted DAG;
- fără leases/fencing;
- fără durable idempotency;
- fără side-effect reconciliation;
- fără capability broker;
- fără independent verifier;
- fără sandbox real;
- fără append-only event source.

### 1.4 Search
Motorul propriu este REAL:
- crawler HTTP(S);
- no external Google/Bing/DDG metasearch;
- SSRF protection;
- robots/noindex/nofollow;
- x/net/html + charset handling;
- local-file indexing;
- append-only persistent index;
- BM25F;
- prefix matching;
- desktop + agent + Linux service wiring.

Scope actual:
- max ~20k docs;
- max crawl 64 pages;
- frontier in-memory;
- no recrawl/freshness scheduler;
- no cross-URL/near dedupe;
- no semantic/vector/hybrid retrieval;
- no distributed index/query serving.

### 1.5 Ilaria
Există runtime BitNet real:
- NXTF loader;
- BitNet model/inference;
- LoRA loading;
- CPU/CUDA decoder paths;
- KV cache;
- Runner/tool loop;
- ilaria-serve / ilaria-chat / ilaria-swyp;
- tool-use pipeline;
- LoRA SFT experiment pipeline.

Gap-ul major este de **integrare cognitivă**, nu faptul că Organismul ar exista.
BitNet+Runner este astăzi cortexul de limbaj/inferență folosit de runtime-ul
product-facing, în timp ce Organism/Hippocampus/WorkingMemory/SemanticMemory/
attention/learning sunt componentele cognitive mai largi. Ținta este un singur
lifecycle Ilaria în care aceste componente orchestrează cortexul de limbaj, nu
două „chatbots” și nu reducerea Organismului la simple wrappers.

### 1.6 Swyp Lang
Există fundație reală:
- parser/checker;
- Semantic Core IR;
- deterministic bounded Core executor;
- requires/ensures contracts;
- finite-domain verifier;
- counterexamples;
- synthesis;
- STV2/SWYPB VM;
- model→propose→verify loop.

Gap-uri majore:
- effects sunt placeholder;
- capabilities absente;
- task primitives absente;
- probabilistic ops absente;
- FFI coerent absent;
- debugger absent;
- incremental compiler absent;
- module/package graph incomplet;
- formal proof backend absent.

## 2. P0 security findings

### 2.1 process.run are ambient user authority
Windows Job Object controlează lifecycle-ul, nu permisiunile.

`process.run` poate citi profilul utilizatorului, registry/files/network conform drepturilor contului după aprobare.

### 2.2 secret leak path real
Child process-ul moștenește mediul părinte. Un secret precum `ILARIA_API_TOKEN` poate fi tipărit de un command; stdout devine Observation; Observation intră în următorul planner prompt/checkpoint.

**Acesta este P0 și se repară înainte de autonomie crescută.**

### 2.3 Workspace path checks != sandbox
Path canonicalization este hardening. Nu rezolvă hostile concurrent mutation și nu limitează un shell aprobat.

### 2.4 No verifier authority separation
Plannerul poate produce și summary-ul final. `core/evidence` este vocabular, nu enforcement plane.

### 2.5 Crypto/reward residue
Zero-crypto business invariant trebuie aplicat asupra modulelor/reward copy istorice:
- l402;
- wallet;
- reward/coin paths din federated/swarm/azure/appstore/views/config.

**Zero-crypto înseamnă fără cryptocurrency/reward-token product semantics.**
Nu înseamnă eliminarea criptografiei legitime: TLS, SHA-256, signatures, TPM, Secure Boot, encryption sunt obligatorii pentru securitate.

## 3. Decizia OS — CORECTATĂ DE OWNER

### Nu există încă o decizie că Linux este kernelul de producție

Afirmația anterioară „Adoptăm Linux LTS + Swypik-owned immutable userland” a fost prea devreme și este retrasă.

Fapt curent:
- există un prototype Linux bootabil și util pentru QEMU/driver/reference testing;
- există o aplicație nativă Windows utilă pentru dezvoltare;
- niciuna nu definește automat produsul final.

Ținta ownerului este un **SwypikOS independent**, proiectat să poată depăși OS-urile existente pe workload-urile sale, nu o distribuție Linux cosmetizată.

### ADR-OS-BASE-001 trebuie să compare prin prototip și benchmark

**A. Swypik-owned kernel/platform**
- kernel propriu sau microkernel/hybrid;
- scheduler, VM, IPC, capability model, VFS, network/device model proprii;
- driver ABI și compatibility strategy;
- pornește pe QEMU/virtio, apoi pe hardware controlat.

**B. Hybrid compatibility architecture**
- Swypik-owned authority/kernel path;
- Linux sau alt kernel poate exista ca compatibility/driver domain izolat, VM sau bootstrap tool, nu ca identitate implicită a OS-ului;
- măsoară overhead, fault containment, boot, suspend/resume și driver coverage.

**C. Linux-based product**
- rămâne candidat tehnic/legal și rapid, nu decizie automată;
- se acceptă numai dacă benchmarkul demonstrează că nu blochează obiectivele de ownership, securitate, performanță și diferențiere.

### Gate de decizie

Nu alegem după preferință. Prototipurile trebuie comparate pe:
- boot time / idle RAM / latency;
- scheduler/task throughput;
- IPC cost;
- fault isolation/recovery;
- power/thermal behavior;
- driver coverage;
- GPU/NPU scheduling;
- security/capability enforceability;
- update/rollback;
- developer complexity;
- licensing/distribution constraints;
- cât din platformă este efectiv Swypik-owned.

Până la ADR: **Linux path = reference/prototype, nu product commitment**.

### Legal/licensing note

Linux poate fi folosit într-un produs comercial dacă sunt respectate obligațiile GPL-2.0 și obligațiile de redistribuire aplicabile. Asta nu înseamnă că este automat alegerea potrivită pentru SwypikOS și nu autorizează copierea arbitrară a codului/driverelor GPL într-un kernel proprietar.

## 4. M1 — Autonomous Control Kernel

Package name should distinguish it from Linux kernel. Recommended prefix:
`core/controlkernel/*`.

### 4.1 Canonical model
Entities:
- Task
- Node
- Edge
- Attempt
- Lease
- CapabilityGrant
- Intent / SideEffectRecord
- EvidenceBundle
- Artifact
- Verification
- Budget

### 4.2 Node states
```text
PENDING
 → READY
 → LEASED
 → PREPARING
 → EXECUTING
 → VERIFYING
 → COMMITTING
 → SUCCEEDED

EXECUTING/VERIFYING
 → RETRY_WAIT → READY

EXECUTING
 → UNCERTAIN
 → RECONCILING
 → SUCCEEDED | RETRY_WAIT | OPERATOR_REQUIRED | FAILED

terminal:
FAILED | CANCELLED | BLOCKED
```

### 4.3 Invariants
1. Execute only with live lease + matching monotonic fence.
2. Capability grants bind to Task/Node + lease fence + resource + rights + expiry.
3. Side-effect intent is durable before execution.
4. Stale-fence result/commit is rejected.
5. External/irreversible uncertain effects are reconciled, never blind-retried.
6. Verifier has no executor authority.
7. Secrets never enter task/event/model/log payloads.
8. Resource budgets are externally enforced.
9. Snapshots accelerate replay; they are not source of truth.

### 4.4 Persistence
First ADR should benchmark:
A. pure-Go SQLite/WAL;
B. custom append-only event journal + projections.

Default recommendation: mature transactional storage first, likely pure-Go SQLite to preserve CGO-free build. Do not build a database for branding.

Required:
- schema migrations;
- expected-seq/CAS append;
- event hash chain;
- transactional projections;
- explicit corruption behavior;
- crash/fault tests.

### 4.5 Sandbox
Windows:
- restricted token / AppContainer feasibility;
- clean allowlisted environment;
- suspended start;
- brokered handles;
- Job CPU/RAM/process limits;
- network default deny;
- no access to control DB/secrets.

Linux:
- user/mount/pid/net namespaces;
- seccomp;
- cgroups v2;
- brokered FDs/mounts;
- no inherited secrets;
- capability-based outbound network.

### 4.6 Secrets
Introduce `SecretRef`.
Secrets are resolved by broker only at the narrow action boundary.

Before persistence/model context:
- known-secret redaction;
- structured secret stripping;
- taint metadata;
- entropy/pattern defense-in-depth.

### 4.7 Verification
Separate:
- deterministic policy verifier;
- optional independent model verifier.

Security invariants are decided by deterministic policy, never by an LLM.

## 5. Swyp Lang — strategic role

Do NOT try to make Swyp a general-purpose language first.

Make it the **typed language of autonomous work**.

### 5.1 Core IR becomes semantic authority
Legacy frontend becomes compatibility layer, then retires.

### 5.2 Pure by default
Swyp/Pure:
- i64/bool first;
- deterministic;
- bounded;
- no ambient authority;
- no host effect;
- verifier-friendly;
- cache/replay-friendly.

### 5.3 Effect IR
First-class effects:
- fs.read/write;
- process.exec;
- net.connect/fetch;
- clock.read;
- rng.sample;
- model.infer;
- tool.call;
- device operations.

Effect declaration is not authority.
Authority is an opaque SwypikOS capability.

### 5.4 Task semantics
Swyp describes:
- task spec;
- dependencies;
- capabilities;
- budgets;
- retry class;
- evidence schema;
- contracts.

SwypikOS executes/persists/schedules them.

**Do not duplicate scheduler in Swyp VM.**

### 5.5 Verification
Extend contracts with:
- loop invariants;
- resource contracts;
- effect contracts;
- capability preconditions;
- state transition contracts.

Later define Swyp/Pure formal subset → Verification IR → SMT backend.
Do not call bounded exhaustive testing “formal proof”.

## 6. Ilaria — strategic role

### 6.1 Ilaria is not an LLM
Ilaria is intentionally modeled as a software organism. The repository already encodes this intent directly: `cortex/organism.go` defines `Organism` as the central orchestrator connecting brain modules; `Hippocampus`, `WorkingMemory`, `SemanticMemory` and attention modules are first-class cognitive components.

Therefore the architecture must not collapse Ilaria into “BitNet + RAG”.

The correct split is:

```text
ILARIA ORGANISM
├─ attention / salience
├─ working memory
├─ episodic memory / hippocampus
├─ semantic memory
├─ learning + consolidation
├─ planning / goals / tool-use
├─ metacognition / self-evaluation where implemented
└─ language & reasoning cortex
      └─ BitNet inference runtime + adapters
```

BitNet is the current **language/inference cortex**, not the whole person-like system.

The product goal is one coherent Ilaria lifecycle: cognitive state persists across turns/tasks and the language model is called by that lifecycle rather than replacing it.

Where the current Organism path and BitNet Runner are not wired together, treat this as an **integration gap**, not evidence that the cognitive modules should be deleted or reduced to generic providers.

### 6.2 Cognitive authority boundary
Ilaria may decide, remember, learn, plan and request actions. It does not receive ambient host authority.

All external effects still cross:
`Ilaria → typed Tool/Effect request → Swyp semantics/contracts → SwypikOS capability broker → executor/evidence`.

This preserves the “human-like mind” design while keeping OS authority deterministic and auditable.

### 6.3 Typed AgentTurn / Tool ABI
Replace ad-hoc text-only tool semantics with versioned structured envelopes:
- tool_id;
- schema digests;
- effects;
- capability requirements;
- determinism/replay class;
- timeout/budget;
- ToolCall IDs;
- ToolResult evidence hashes.

The model may see compact text; storage/dataset must preserve structured truth.

### 6.4 Training order
1. Freeze eval/provenance/trajectory contracts.
2. Define cognitive-state serialization/evaluation: working memory, episodic recall, semantic consolidation, attention and goal continuity.
3. Wire the language cortex into the Organism lifecycle rather than maintaining two independent intelligence paths.
4. Use retrieval/RAG as one memory access mechanism, not as a replacement for Ilaria's memory architecture.
5. LoRA SFT for stable behavior: tool selection, structured output, Swyp syntax, repair.
6. Distillation only with provider/model/source provenance + verifier.
7. Outcome/preference optimization only after sufficient real paired outcomes.
8. Scale compute only after marginal gains are measured.

Do not train on hidden teacher chain-of-thought as truth.
Store observable actions/tools/results/verifier evidence/final outcome.

## 7. Own Search Engine

Current foundation should be evolved, not thrown away.

### S0 — Truth + evaluation
- versioned corpus;
- 100–500 judged queries;
- Romanian + English;
- typos/diacritics;
- duplicates/freshness cases;
- Recall@K, MRR, nDCG, P@K;
- p50/p95;
- RAM/IO/index bytes;
- ingest throughput.

### S1 — useful vertical search
- durable frontier;
- per-host politeness;
- recrawl scheduling;
- ETag/Last-Modified;
- sitemap;
- rel=canonical;
- exact/near duplicate clusters;
- freshness;
- phrase/boolean/site/type/date/scope operators.

Target: useful 10k–100k corpus.

### S2 — Index v2
- numeric doc IDs;
- immutable segments;
- positions;
- compressed postings;
- tombstones;
- checksums/manifest;
- background merge;
- concurrent query/ingest.

Target: benchmarked 100k–1M docs/node.

### S3 — Hybrid
- versioned embeddings;
- ANN;
- BM25F + vector fusion;
- optional top-K reranker only if eval improves;
- provenance-preserving answer synthesis.

### S4 — multi-host distributed fabric
Only after vertical quality/capacity evidence:
- durable partitioned frontier;
- worker leases;
- sharded immutable index generations;
- replicas;
- query router/fanout/merge;
- host scheduling;
- abuse/trap controls.

No Google-scale claim before economics + SLO evidence.

## 8. Product UX

Current real product:
Home / Chat / Agent / Search / Files / Compute / Settings.

Next coherent product should be:
**verified agentic workspace + own search + native OS authority**.

### Files → verified editor
P0/P1:
- internal edit/save;
- line numbers;
- search;
- SHA precondition;
- diff preview;
- stale conflict;
- git status/diff;
- diagnostics;
- symbols/references.

### Agentic coding tools
Typed tools:
- workspace.search;
- workspace.read/edit;
- git.status/diff;
- diagnostics;
- symbols;
- tests;
- build;
- search.query.

Every mutating tool goes through capability + evidence + verifier.

### Browser/computer use
Later, after authority boundary:
- semantic browser adapter;
- UI Automation;
- stale-ref detection;
- postcondition verification;
- scoped session capabilities;
- evidence capture.

Do not reintroduce Electron.

## 9. Repository truth cleanup

Before M1 expands:
1. ONE current architecture doc per subsystem.
2. Mark historical docs as historical.
3. CI import-boundary: product entrypoints cannot import research/dead modules.
4. Move/quarantine dead/prototype surfaces under explicit research/legacy boundary.
5. Purge cryptocurrency/reward product semantics.
6. Keep cryptographic security primitives.
7. Add machine-generated current wiring/import report.
8. Product UI must not expose unwired capability.

Candidate legacy/prototype groups needing disposition:
- core/appstore;
- core/notifications;
- core/docs;
- core/sheets;
- core/proactive;
- core/worldmodel;
- mobile/bridge;
- ui/views;
- reward/coin/wallet/l402 families;
- actiongraph as authority (reuse ideas only);
- core/security anti-debugging as primary security story.

## 10. OS hardware roadmap

### M1 — substrate decision + two reference tracks

**Swypik-owned platform spike**
- QEMU boot;
- interrupts/timer;
- physical + virtual memory baseline;
- scheduler/process/thread primitive;
- IPC;
- capability object model;
- minimal VFS/device model;
- VirtIO block/network/input where feasible;
- deterministic boot/recovery evidence.

**Linux reference/compatibility candidate**
- keep the existing bootable prototype and mkosi worktree as a comparative target;
- persistent state;
- Ethernet/Wi-Fi;
- native session/display path;
- least-privilege services;
- offline boot/files/settings.

Exit: ADR-OS-BASE-001 compares both plus a hybrid compatibility design on the
same QEMU workloads. No path becomes production architecture without owner
approval.

### M2
- first-party device/tool capability ABI independent of substrate;
- input/display/audio/network/storage contracts;
- driver compatibility strategy;
- app/process isolation;
- suspend/resume and power model;
- persistent encrypted state;
- installer/recovery semantics.

Linux-specific technologies such as libinput/PipeWire/BlueZ/UPower/LUKS2 may be
used in the reference candidate and reused only if the final architecture chooses
that boundary.

### M4
- secure/measured boot equivalent for the chosen substrate;
- signed A/B or equivalent transactional OTA;
- automatic rollback;
- recovery;
- Intel/AMD/NVIDIA qualification matrix;
- wider Wi-Fi/BT;
- USB-C/Thunderbolt;
- firmware update;
- long-cycle reliability/fault injection.

## 11. Benchmark/fault gates

Implement the existing Q suite before calling M1 done.

Hard invariants:
- duplicate external side effect = 0 under tested retry/crash matrix;
- stale fence commit = rejected;
- worktree/lease collision = 0 successful conflicting commits;
- secret leakage to prompts/logs = 0;
- sandbox capability escape = 0;
- corrupted/torn persistence fails closed or recovers per documented contract;
- provider outage does not corrupt task state;
- low-RAM/CPU pressure refuses/queues safely;
- verifier cannot gain executor authority;
- crash/restart resumes/reconciles without blind replay.

Metrics:
- cold start;
- idle RAM;
- task overhead;
- scheduler throughput;
- recovery time;
- p50/p95;
- CPU/IO/task;
- model calls/tokens per accepted task;
- fault matrix pass rate.

## 12. Exact implementation order

### M0.5 — freeze architecture before feature work
1. ADR-OS-BASE-001: compare Swypik-owned kernel/platform vs hybrid compatibility vs Linux reference; no product kernel assumed.
2. ADR-CONTROL-KERNEL-001: Task/Node/Edge state machine and failure semantics.
3. ADR-EVENTSTORE-001: SQLite/WAL vs framed journal benchmark + choice.
4. ADR-CAPABILITY-001: authority/grant/revocation/fence model.
5. ADR-TOOL-ABI-001: common ToolDescriptor/Call/Result.
6. ADR-ILARIA-RUNTIME-001: one coherent Ilaria cognitive lifecycle; integrate Organism/memory/attention/learning with the BitNet language-inference cortex instead of reducing Ilaria to an LLM runtime.
7. ADR-SWYP-IR-001: Core IR is semantic authority.
8. ADR-SWYP-EFFECTS-001: explicit effects/capabilities.
9. SPEC-TRAJECTORY-v1 + SPEC-EVAL-RUN-v1 + dataset manifest.
10. SPEC-COMPUTE-FABRIC-v1: consent, device identity, leases, signed jobs, verification, resource governor.
11. Repo truth/legacy/zero-crypto cleanup plan.

### M1 — implement in this order
1. EventStore + schema migrations + projections.
2. Existing one-run agent compatibility adapter over one Task/Node.
3. Side-effect Intent journal + Reconciler.
4. Leases/fencing/idempotency.
5. Capability broker.
6. SecretRef + clean env + redaction gate.
7. Separate sandbox worker; move process.run first.
8. Deterministic evidence verifier.
9. Resource budgets.
10. Durable DAG scheduling.
11. Fault-injection throughout, not at end.
12. Signed artifacts + canary updater only after authority/recovery is proven.

### Parallel OS track during M1
- păstrează Linux/mkosi doar ca reference/compatibility prototype;
- pornește ADR-OS-BASE-001 cu un Swypik kernel/platform spike în QEMU;
- definește boot/IPC/memory/capability/device-driver ABI minim;
- benchmark Swypik-kernel spike vs Linux reference pe aceleași workload-uri;
- definește strategia de reuse/compatibility pentru drivere fără a încălca licensing-ul;
- primul reference hardware se alege după gate, nu înainte.

### Parallel Swyp Compute Fabric track during M1
- device enrollment + consent;
- GPU/NPU/CPU capability inventory;
- signed job manifest;
- lease/heartbeat/checkpoint;
- isolated worker;
- result hash/signature;
- duplicate/Byzantine verification;
- idle/power/thermal/bandwidth governor;
- pilot cu minimum 2 noduri reale;
- zero crypto/reward-token semantics.

### M2
Swyp effects/capabilities/tasks + device broker + desktop hardware surface.

### M3
Ilaria cognitive eval/provenance/trajectory infrastructure → memory/attention/
repair benchmarks → LoRA/RAG/distillation experiments → contributed-compute pilot.

### M4
Full integrated platform + signed update/recovery + hardware matrix + Swyp Compute Fabric + distributed search evolution.

## 13. First executable engineering tasks

1. **CK-001 Event model ADR + Go types**
DONE: state machine/events/invariants compiled + property tests.

2. **CK-002 EventStore prototype**
DONE: expectedSeq CAS, migrations, corruption/torn-write tests, restart replay.

3. **CK-003 Legacy agent adapter**
DONE: current desktop one-run behavior passes existing tests on new store.

4. **CK-004 Side-effect journal**
DONE: prepared/started/result/uncertain/reconcile transitions fault-tested.

5. **CK-005 Lease/fence subsystem**
DONE: stale owner cannot commit; expiry/renew/reassign tests.

6. **SEC-001 Secret containment**
DONE: child env allowlist; ILARIA_API_TOKEN cannot reach stdout/prompt/checkpoint in adversarial test.

7. **SEC-002 Capability broker**
DONE: scoped grant required for fs/process/network; revocation/expiry/fence tests.

8. **SEC-003 Sandbox worker**
DONE: process.run moved out-of-process; cannot read forbidden file or network without grant; CPU/RAM/process limits verified.

9. **QA-001 Evidence + verifier**
DONE: author cannot self-accept; deterministic verifier gate required for commit.

10. **SWYP-001 Core IR authority + effects ADR**
DONE: one canonical IR version; pure/effect boundary represented and round-trip tested.

11. **SEARCH-001 Search eval + durable frontier design**
DONE: baseline metrics frozen + 100+ judged queries + crawl-state schema.

12. **OS-001 Kernel/platform decision spike**
DONE: same QEMU workload is measured on Swypik-owned kernel/platform prototype and Linux reference; ADR records boot/IPC/memory/security/driver/engineering tradeoffs and owner approves the production direction.

13. **COMPUTE-001 Community GPU pilot**
DONE: two independent opted-in devices execute a signed Ilaria workload under leases/resource limits; one duplicate result is independently verified; disconnect/retry does not double-accept work.

## 14. Ce NU pretindem încă

- că Linux este kernelul final;
- că Swypik-owned kernel are deja broad hardware parity;
- că avem mii de drivere proprii;
- distributed open-web crawler înainte de vertical search proof;
- AI App Store peste metadata mock;
- proactive auto-actions fără real integrations/evidence;
- custom browser engine;
- full IDE;
- online self-modifying production model;
- autonomous self-update fără signatures/canary/rollback;
- second Ilaria inference runtime;
- second scheduler inside Swyp Lang;
- SMT claims before formal subset exists.

## 15. Definition of “SwypikOS is real”

Nu este suficient „bootează”.

Un developer preview este real când:
1. bootează independent pe hardware declarat;
2. are storage persistent/encrypted;
3. drivers/firmware/network/display/input funcționează pe matricea declarată;
4. offline OS lifecycle nu depinde de model/cloud;
5. shell + compositor sunt native;
6. agent workers sunt sandboxed;
7. authority is capability-based;
8. task state survives crashes without blind side-effect replay;
9. update is signed + rollbackable;
10. search corpus/ranking are proprietary and benchmarked;
11. Ilaria runtime/model identity is versioned and measurable;
12. Swyp effects map to brokered capabilities, not host syscalls;
13. every claim has reproducible evidence.
14. kernel/platform ownership și third-party boundaries sunt documentate exact.
15. community compute este explicit opt-in, revocabil, sandboxed și verificat; niciun rezultat de nod nu este trusted implicit.

## 16. Current baseline verification performed by ChatGPT principal

Audit baseline original: `96290fa`. Main a avansat ulterior; orice integrare
trebuie revalidată pe HEAD-ul live înainte de merge.
- `E:\nexus\swypik-os`: `go vet ./...` + `go test -count=1 -timeout 180s ./...` → PASS.
- `E:\nexus\swyp`: same → PASS.
- `E:\nexus`: same → PASS.
- Git working tree observed unchanged except pre-existing `?? .mcp.json`.
- No SwypikOS/Ilaria/Swyp source was modified during this architecture audit.

## 17. Final direction

Nu trebuie să aruncăm proiectul. Există fundații bune și reale.

Dar trebuie să schimbăm centrul de greutate:

**nu „mai multe module demo” → ci control kernel + authority + reproducibility + real OS substrate.**

Ordinea strategică este:

```text
TRUTH
→ SECURITY / AUTHORITY
→ DURABLE CONTROL KERNEL
→ REAL OS SUBSTRATE
→ SWYP EFFECT/CAPABILITY SEMANTICS
→ VERIFIED AGENTIC WORKSPACE
→ OWN SEARCH QUALITY
→ ILARIA EVAL/TRAINING
→ HARDWARE + UPDATE/RECOVERY
→ DISTRIBUTED SCALE
```

Asta transformă SwypikOS dintr-un repository cu multe idei într-o platformă coerentă care poate demonstra, prin benchmark și fault injection, că este autonomă, sigură și utilă.
