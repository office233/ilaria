# SWOS-000 — Independent Synthesis Verdict

**Rol:** Independent Principal Verifier / Architect  
**Data:** 2026-09-28  
**Checkout verificat:** E:\nexus, E:\nexus\swypik-os, E:\nexus\swyp  
**Git observat:** main @ 96290fa, ahead 55; singurul element necomis observat înainte de audit este .mcp.json și nu a fost citit/modificat  
**Mod:** strict source/read-only în cele trei repo-uri. Singura scriere a acestei misiuni este acest raport.  
**Regulă de adevăr:** codul live și import graph-ul prevalează asupra documentației și asupra rapoartelor anterioare.

## 0. Verdict unic

SwypikOS / Ilaria / Swyp nu este vaporware și nu trebuie rescris de la zero. Există trei nuclee tehnice reale, dar ele nu formează încă sistemul autonom descris de North Star:

- **SwypikOS** are astăzi un desktop Win32 nativ, un agent linear approval-gated cu recovery prudent și un motor propriu de search local, plus un Linux live bootabil foarte îngust.
- **Ilaria** are un runtime BitNet headless real, cu LoRA, decoder incremental și Runner/tool loop; stack-ul Organism/memory/self-training este însă o pistă separată și nu este conectat la runtime-ul de produs.
- **Swyp** are un Core IR determinist, bounded, contracts/verifier, synthesis și STV2/SWYPB reale; efectele, capabilitățile și task semantics nu sunt încă executabile.

Blocajul principal nu este lipsa unui model mai mare, a unui kernel custom sau a mai multor UI-uri. Blocajul este **lipsa unui control plane durabil și a unei granițe reale de autoritate** între planner, tool execution, side effects și verifier.

Decizia arhitecturală recomandată este:

**SwypikOS deține autoritatea, task graph-ul și efectele; Ilaria propune/planifică; Swyp definește semantică verificabilă și execuție deterministă; Linux LTS deține kernelul și driver substrate-ul.**

M1 trebuie să construiască această coloană vertebrală înainte de DAG distribuit, device automation, self-update, Internet-scale search sau noi proiecte de model.

---

## 1. Ce am verificat independent

Am citit integral:

- E:\CEO\specs\mission-swypikos-ilaria.md
- E:\CEO\projects\swos\analysis\01-kernel-security.md
- E:\CEO\projects\swos\analysis\02-os-drivers.md
- E:\CEO\projects\swos\analysis\03-search-product.md
- E:\CEO\projects\swos\analysis\04-ilaria-swyp.md
- E:\CEO\projects\swos\m0\Q-bench-fault-suite.md
- E:\nexus\AGENTS.md

Am respectat interdicțiile AGENTS.md: nu am citit data/, cuda/, .env*, executabile, loguri, arhive sau secrete și nu am rulat training/deploy/provisioning.

### 1.1 cmd/swypik-os și recovery

Spot-check live:

- cmd/swypik-os/main_windows.go importă config, core/agent, core/coder, core/compute, core/ilaria, core/search, core/service, ui/desktop și ui/engine.
- Nu importă core/actiongraph, core/security sau core/evidence.
- Search-ul este deschis din search-index.jsonl.
- Tool-urile agentului sunt WorkspaceTools(workspace, coder.Run) + search.query.
- Agentul live este agent.NewPersistent(...), cu un singur current Run.

Recovery-ul live confirmă proprietățile bune raportate:

- approval-ul aprobat este checkpoint-uit ca status=executing și AttemptedSteps este incrementat **înainte** de release către tool;
- dacă serviciul moare după această tranziție și înainte de Observation, recovery devine uncertain;
- uncertain blochează replay/resume automat;
- checkpoint failure latches storageErr și oprește execuția;
- restart-ul nu pornește singur inference sau tools.

Aceasta este o bază bună de siguranță, dar este **single-run checkpointing**, nu event-sourced task kernel.

### 1.2 Autoritatea process.run

Spot-check live confirmă un P0 sever:

- core/coder/shell_windows.go spune explicit că Job Object-ul este lifecycle management, nu security sandbox;
- CreateProcess rulează cmd.exe cu permisiunile utilizatorului;
- environment pointer este nil, deci copilul moștenește mediul părinte;
- config.ResolveToken citește ILARIA_API_TOKEN din environment dacă este prezent;
- output-ul process.run este serializat în Observation;
- JSONPlanner serializază Observations în promptul trimis la Ilaria.

Prin urmare, un process.run aprobat poate accesa authority/secrete ambientale ale procesului user și poate întoarce datele în prompt. Approval-ul actual nu este un capability boundary.

### 1.3 Linux boot / network / drivers

Spot-check live confirmă:

- scripts/build-os.sh este explicit „RAM-only live ISO” și „not an installer or a production release”;
- copiază un kernel deja instalat din /boot/vmlinuz-$KVER;
- construiește doar swypikd și swypik-session pentru linux/amd64;
- stage-uiește top-level module targets: virtio_pci, virtio_net, virtio_blk, bochs, evdev, atkbd, usbhid, e1000, e1000e plus dependențele rezolvate;
- init montează proc/sysfs/devtmpfs/devpts și tmpfs pentru /run, /tmp, /home și /var;
- rcS ridică interfețele găsite și pornește BusyBox udhcpc;
- udhcpc.script setează IPv4, default route și resolv.conf;
- swypikd refuză root și rulează agent read-only + search pe Unix socket;
- swypik-session rulează non-root și folosește /dev/fb0.

Așadar traseul Linux este bootabil și real, dar hardware contract-ul actual este diagnostic/VM-oriented. Nu există încă firmware population, udev device management, persistent install, Wi-Fi stack, production display/input/audio/camera/power/update stack.

### 1.4 Search

Spot-check live confirmă:

- MaxDocuments = 20.000;
- MaxTextBytes = 16 KiB;
- User-Agent = SwypikBot/0.2;
- MaxCrawlPages = 64;
- frontier in-memory max = 512;
- page max = 2 MiB;
- robots max = 512 KiB;
- un singur crawl activ per Engine;
- 1 conexiune/host și delay de 1 secundă;
- SSRF checks rezolvă DNS, resping orice adresă non-publică și dial-uiesc IP-ul validat;
- robots este consultat înainte de crawl;
- exact URL este document identity;
- persistence este append-only JSONL;
- BM25F este real: k1=1.2, titleWeight=3.0, titleB=0.5, bodyB=0.75;
- prefix expansion pe ultimul termen are weight 0.5;
- top 20 rezultate;
- Search() ia lock exclusiv deoarece vocab cache poate fi reconstruit;
- nu există în core/search embedding/vector/HNSW/ANN/reranker semantic.

Concluzie: own search este real, dar este un engine local/user-seeded bounded, nu open-web search fabric.

### 1.5 Ilaria headless

Spot-check live al cmd/ilaria-serve, cmd/ilaria-chat și cmd/ilaria-swyp:

- LoadBitNetModel;
- opțional LoadBitNetLoRA;
- LoadHFTokenizerJSON;
- BitNet CPU sau CUDA StepDecoder;
- cortex.NewRunner;
- ilaria-serve expune /v1/chat;
- ilaria-swyp folosește Runner + Swyp judge loop.

Nu există NewOrganism, Hippocampus, SemanticMemory sau CognitiveBridge în aceste trei entrypoint-uri.

Deci runtime-ul de produs este BitNet + Runner. Organism este research/prototype separat.

### 1.6 Swyp Core / effects

Spot-check live:

- internal/coreir Function are câmp Effects;
- Module.Validate respinge explicit len(Effects) != 0 cu „core v1 is pure”;
- Contract are câmp Effects;
- Contract.validate respinge explicit len(Effects) != 0;
- Core IR nu are host calls.

Deci Pure Core este real și util; effect semantics/capabilities sunt încă neimplementate.

---

## 2. Contradicții și claims care trebuie corectate

### 2.1 „SwypikOS este OS” este ambiguu în starea actuală

Există două artefacte diferite:

- Windows: aplicație Win32 nativă peste Windows;
- Linux: live image bootabil, RAM-only, pre-alpha.

Niciunul nu trebuie prezentat azi ca desktop OS general-purpose comparabil operațional cu Windows/macOS. Linux-ul este începutul corect al unei distribuții proprii, dar nu are încă platform contract-ul necesar.

### 2.2 Raportul OS/driver supradimensionează M1

Raportul 02 propune pentru M1 și production image plumbing, persistence, physical laptop, Wi-Fi și Wayland. Acestea sunt direcții corecte pentru produs, dar nu trebuie să fie **exit gate al M1 Autonomous Kernel** din mission spec.

Dacă M1 este blocat de Wayland, laptop bring-up și full firmware stack, echipa amestecă două programe diferite:

- M1 control-plane/security correctness;
- OS distribution/hardware productization.

Decizie: kernel-ul autonom software se livrează primul peste host-ul actual și un executor Linux controlat. Production Linux image rulează în paralel după ADR-ul de kernel, dar hardware breadth intră în M4 / platform track, nu blochează task semantics, leases, journal și verifier.

### 2.3 „Ilaria este reală” trebuie calificat

Codul și wiring-ul BitNet sunt reale. Nu s-au inspectat weights din data/ și în această misiune nu s-a rerulat un checkpoint real. Prin urmare putem afirma „runtime implementat și wired”, nu „inteligență generală demonstrată” sau „model superior”.

Experimentul Swyp 6/20 documentat rămâne un experiment mic, nu o măsură de coding capability generală.

### 2.4 „Own search engine” este adevărat, „Internet search competitor” nu

Crawlerul, indexul și rankingul sunt proprii și nu fac metasearch. Claim-ul trebuie însă limitat la corpusul explicit indexat. Nu există frontier persistent distribuit, content dedupe, freshness scheduler, vector retrieval, shards sau query router.

### 2.5 Q-bench este specificație, nu rezultat

Q-bench definește metrici și hard gates bune. Majoritatea sunt marcate chiar acolo UNVERIFIED. Nu există încă dovadă că SwypikOS trece fault classes sau că are overhead/recovery superior.

### 2.6 Pachetele existente nu înseamnă runtime capability

core/actiongraph, core/security, core/evidence și mai multe suprafețe istorice pot avea cod și teste, dar nu sunt în import graph-ul desktopului live. „Implemented package” nu trebuie tradus automat în „product feature”.

---

## 3. CE ESTE REAL AZI

### SwypikOS

1. Desktop Win32 nativ, fără Electron/WebView/browser runtime.
2. Agent linear cu:
   - planner JSON strict;
   - per-tool approval;
   - read-before-edit + SHA stale-write check;
   - output bounds;
   - deadline/step bounds;
   - persistent current-run;
   - conservative crash recovery.
3. process.run cu descendant cleanup prin Windows Job Object.
4. Search propriu lexical + crawler bounded + local file indexing.
5. Files viewer și settings minime.
6. GPU/compute inventory.
7. Linux live ISO bootabil cu stock Linux kernel, BusyBox userland, swypikd, swypik-session și DHCP pentru NIC-uri suportate.

### Ilaria

1. BitNet model representation/runtime în Go.
2. NXTF loader.
3. LoRA loading.
4. CPU/CUDA decoder wiring.
5. Runner cu KV/tool loop.
6. ilaria-serve headless HTTP API.
7. Optional read_file/tool adapters.
8. Swyp judge integration și propose→verify loop.
9. Training/LoRA tooling existent ca experiment pipeline.

### Swyp

1. Parser/checker.
2. Semantic Core IR v1.
3. Strict decoder/validator.
4. Deterministic bounded executor.
5. Contracts + finite-domain/sampled verifier.
6. Counterexample generation.
7. Synthesis.
8. STV2 + SWYPB bounded deterministic VM.
9. Model-facing judge integration.

---

## 4. CE ESTE PROTOTYPE / DEAD / NE-WIRED

### Prototype funcțional, dar nu authority de produs

- core/actiongraph;
- core/security;
- core/evidence în suprafețele experimentale;
- Organism / Hippocampus / SemanticMemory ca research runtime;
- core/hal inventory;
- core/audio memory/VAD/tone;
- core/bridge ADB/synthetic behavior;
- core/notifications;
- core/docs;
- core/sheets;
- core/worldmodel;
- mobile/bridge;
- autogenesis driver candidate generation;
- compute execution/coordinator.

### Dead / historical pentru runtime-ul desktop curent

- ui/views legacy ecosystem;
- Electron-era desktop documentation/surfaces;
- App Store actual ca product install system;
- proactive fake-completion flows;
- legacy bridge/nexus ca integrare principală Ilaria↔Swyp.

### Explicit absent

- durable multi-task DAG;
- leases/fencing;
- durable idempotency semantics;
- side-effect journal/reconciler;
- capability broker;
- secret broker;
- real worker sandbox;
- independent verifier process;
- hard per-task CPU/RAM/process/IO/network budgets;
- signed updater/canary/rollback;
- production Linux desktop/device stack;
- Swyp effect execution;
- Swyp capability semantics;
- Swyp task primitives;
- Swyp FFI/debugger/incremental compiler;
- BitNet headless MemoryProvider;
- Internet-scale search fabric;
- semantic/vector/hybrid search.

---

## 5. TOP P0 blockers

Ordinea este intenționată. Nu introduceți DAG concurrency înainte ca primele granițe să existe.

### P0-1 — Authority boundary

Astăzi approved process.run = user authority. Trebuie eliminată autoritatea ambientală înainte de autonomie suplimentară.

**Gate:** niciun tool worker nu moștenește implicit user secrets, filesystem authority sau network authority.

### P0-2 — Durable kernel state

current-run.json nu poate deveni scheduler. Este nevoie de Task/Node/Edge state machine, append/CAS events și projections durabile.

**Gate:** restart la fiecare tranziție produce aceeași stare proiectată și nu pornește efecte singur.

### P0-3 — Side-effect semantics

Trebuie Intent → Started → Result → Verify → Commit și stare UNCERTAIN/RECONCILING.

**Gate:** crash în orice fereastră nu produce blind duplicate execution.

### P0-4 — Leases + fencing + idempotency

Fără ownership epoch, un worker vechi poate comite după expirare.

**Gate:** stale fence este respins determinist și duplicate side-effect rate = 0 în fault suite.

### P0-5 — Capability + secret broker

Approval trebuie transformat în autoritate scoped, expiring și legată de task/node/fence. Secretele trebuie reprezentate prin refs, nu valori transportate în prompt/event.

**Gate:** denied/out-of-scope capabilities produc zero side effects; known secret values nu apar în event/prompt/tool output persistence.

### P0-6 — Sandboxed worker + hard budgets

Separarea în proces este necesară, dar nu suficientă. Windows: restricted identity/AppContainer sau echivalent + handle allowlist + Job limits + network policy. Linux: namespaces + seccomp + cgroups v2.

**Gate:** worker-ul nu poate citi în afara grantului, nu poate deschide network fără grant și nu poate depăși bugetele hard.

### P0-7 — Independent verifier / evidence contract

Executorul nu își poate declara singur succesul.

**Gate:** verifier separat, read-only/no executor capability, validează output/artifact/diff/test evidence înainte de commit.

### P0-8 — Fault harness ca release gate

Q-bench trebuie implementat, nu doar documentat.

**Hard M1 gates:** duplicate side effects = 0; worktree collision loss = 0; fault-class pass rate = 100%; security escape = 0.

---

## 6. Target architecture: SwypikOS ↔ Ilaria ↔ Swyp

### 6.1 Ownership

| Responsabilitate | Owner canonic |
|---|---|
| Task graph, scheduler, leases, retry, crash recovery | SwypikOS Kernel |
| Approval, capabilities, secrets, budgets | SwypikOS Kernel |
| Side-effect journal și reconciliere | SwypikOS Kernel |
| Host filesystem/process/network/device effects | SwypikOS Capability Broker + workers |
| Inference | Ilaria Runtime |
| Planning / next-action policy | Ilaria Agent Runtime |
| Long-term retrieval | Ilaria MemoryProvider, nu al doilea generator |
| Limbaj / Core IR / deterministic guest execution | Swyp |
| Contracts / verifier semantics | Swyp |
| Effect declaration | Swyp |
| Effect execution | SwypikOS, niciodată direct Swyp |
| Search corpus/frontier/index/ranking | Search service separat |
| Hardware drivers | Linux kernel/upstream driver stack |
| OS device policy | SwypikOS userland broker/services |

### 6.2 Fluxul țintă

    User / System Event
            |
            v
    SwypikOS Durable Task Kernel
    EventStore -> TaskGraph -> Lease/Fence -> Budget
            |
            +--> Approval -> Capability/Secret Broker
            |
            v
    Ilaria AgentTurn
    BitNet Runtime + Planner + MemoryProvider
            |
            | proposes typed action / Swyp source
            v
    Swyp
    Parse -> Core IR -> Contract/Verifier -> Pure execution
            |
            | EffectRequest only
            v
    SwypikOS Side-Effect Journal
    Prepare Intent -> Capability Check -> Sandboxed Worker
            |
            v
    Independent Verifier -> Commit / Reconcile / Fail
            |
            v
    Evidence + immutable task history

Search este un serviciu al platformei și poate folosi ulterior lease/event primitives pentru crawl workers, dar **crawler scheduling nu trebuie să fie LLM planning**.

### 6.3 Interfețe care trebuie versionate

Minimum:

- TaskSpec v1;
- AgentTurn / AgentDecision v1;
- ToolDescriptor / ToolCall / ToolResult v1;
- EffectRequest / EffectResult v1;
- CapabilityGrant v1;
- EvidenceBundle v1;
- Trajectory v1;
- EvalRun v1.

Toate trebuie să aibă schema version, trace IDs și hashes pentru payload/artifact unde este relevant.

---

## 7. Decizia kernel / drivers

### Decizie

**SwypikOS va fi Linux-LTS-based. Nu se construiește un general-purpose kernel propriu pe M1-M4.**

Linux deține:

- scheduler/MMU/VFS;
- TCP/IP;
- PCIe/USB;
- NVMe/AHCI/storage;
- input;
- DRM/KMS;
- ALSA;
- Wi-Fi/Bluetooth kernel side;
- power/ACPI;
- driver ecosystem.

SwypikOS deține:

- immutable/signed image contract;
- userland;
- desktop shell;
- capability broker;
- task kernel;
- Ilaria integration;
- Swyp runtime;
- search;
- settings/policy;
- update/recovery policy;
- hardware qualification.

### Tranziție recomandată

1. Păstrați Windows desktopul actual ca development/product shell în timpul M1.
2. Păstrați actualul RAM ISO doar ca T0 diagnostic/smoke artifact.
3. Scrieți ADR-OS-001 acum: Linux LTS + upstream/distro drivers.
4. Nu extindeți manual lista fixă de module ca strategie de producție.
5. Creați ulterior un production image path separat: systemd/udev, full curated modules + linux-firmware, persistent encrypted state, signed boot/update.
6. Wayland, PipeWire, NetworkManager+iwd, BlueZ, libcamera, power și hardware matrix vin în platform track după ce authority/kernel semantics sunt stabile.
7. Kernel custom rămâne research separat, fără dependență în roadmap.

---

## 8. Planul motorului propriu de search

Nu aruncați engine-ul actual. Este suficient de real pentru a deveni seed, dar storage/frontier trebuie schimbate înainte de scale.

### S0 — Truth + relevance bench

- corpus versionat;
- 100–500 query judgments Romanian + English;
- duplicates/freshness/diacritics/typos;
- Recall@K, MRR, nDCG@K, P@K;
- p50/p95 query;
- RAM/index bytes;
- ingest throughput.

**Exit:** fiecare ranking/storage schimbare poate fi comparată cu baseline-ul actual.

### S1 — Durable vertical search

- persistent URL frontier;
- host scheduling;
- next_fetch_at / attempts / backoff;
- ETag + Last-Modified;
- sitemap;
- canonical/redirect aliases;
- exact + near dedupe;
- deletion lifecycle;
- freshness signals;
- source manager UI.

**Țintă:** 10k–100k documente utile, nu web-wide.

### S2 — Index v2

- numeric doc IDs;
- immutable segments;
- term dictionary;
- compressed postings;
- positions;
- field stats;
- tombstones;
- atomic manifest generation;
- checksum/recovery;
- background merge;
- concurrent query + ingest.

**Țintă:** 100k–1M pe un nod, numai dacă benchmark-ul confirmă resurse/latency.

### S3 — Query + hybrid

- phrase;
- AND/OR/NOT;
- site/type/date/scope;
- versioned embeddings;
- independent ANN segments;
- RRF/weighted fusion;
- reranker numai dacă relevance eval arată câștig.

### S4 — Distributed fabric

Numai după S2/S3 green:

- partitioned durable frontier;
- host ownership/leases;
- fetch workers;
- content store;
- shard builder;
- replicas;
- query router;
- fanout/merge/cache;
- abuse/takedown controls.

Nu există justificare tehnică să se sară direct la „Google-scale”.

---

## 9. M1 / M2 / M3 / M4 — implementation order

## M1 — Autonomous Kernel

**Scop:** authority + durability + crash semantics, nu hardware breadth.

Ordine:

1. execution/state/replay ADR;
2. event store + projections;
3. compatibility adapter pentru agentul actual;
4. leases/fencing;
5. side-effect journal/reconciler;
6. capability + secret broker;
7. sandbox worker și hard budgets;
8. independent verifier/evidence;
9. durable DAG;
10. fault/benchmark release gate.

**M1 Exit:** desktopul existent poate rula un task prin noul kernel; toate side effects trec prin journal/capability/worker/verifier; restart și stale workers nu dublează efecte; cele 9 fault classes trec; no security escape.

## M2 — Swyp Lang Seed

**Prerequisite:** capability/effect ABI M1 stabil.

1. declară Core IR semantic authority;
2. păstrează Pure Core determinist;
3. introduce Effect IR / EffectRequest, fără host syscall;
4. introduce typed capability requirements;
5. introduce TaskSpec/evidence/budget/retry types fără a duplica schedulerul;
6. leagă effect request de brokerul SwypikOS;
7. trei demo-uri end-to-end;
8. regression/fuzz/contract tests.

**M2 Exit:** programul Swyp nu poate fabrica autoritate; pure path rămâne deterministic; effectful path este brokered și auditat.

## M3 — Ilaria Eval / Training Pipeline

**Prerequisite:** Tool ABI + trajectory/evidence stable.

1. un singur BitNet runtime authority;
2. MemoryProvider extras din ideile utile Organism, nu al doilea generator;
3. canonical trajectory/dataset/eval-run manifests;
4. freeze broad heldout;
5. tool-use + Swyp generation eval;
6. LoRA SFT pe verified trajectories;
7. promotion gate cu regression/latency/resource checks;
8. distillation numai cu provenance + verification;
9. compute scaling numai după evidence.

**M3 Exit:** nicio promovare de adapter/model fără reproducible manifest și suite frozen.

## M4 — Integration / Real OS Product

1. production Linux image;
2. systemd/udev/full firmware strategy;
3. persistent encrypted state;
4. Wayland/input;
5. networking/Wi-Fi;
6. audio/BT/camera/power;
7. signed boot + signed A/B update + rollback/recovery;
8. device capability ABI;
9. Ilaria + Swyp + task kernel integration pe Linux;
10. search S2/S3 productionization;
11. hardware qualification;
12. plugin/driver manifests și fault injection end-to-end.

**M4 Exit:** capabilitățile prezentate ca supported au evidence reproducibil pe hardware matrix și rollback/recovery demonstrat.

---

## 10. Primele 12 taskuri executabile pentru orchestrator

Acestea sunt intenționat atomice. Nu porniți task N+1 dacă invariantul fundamental al taskului N este încă ambiguu.

### T01 — Freeze Kernel Execution Semantics

**Target:** docs/ADR-KERNEL-EXECUTION-001.md + core/kernel/model schema skeleton.

Definește Task/Node states, transitions, replay classes PURE/IDEMPOTENT/REVERSIBLE/IRREVERSIBLE, event names, UNCERTAIN semantics și regula „no exactly-once claim for arbitrary external effects”.

**DONE verificabil:**
- transition table completă;
- fiecare state are allowed predecessors/successors;
- fiecare replay class are retry rule;
- niciun „executing → ready” implicit;
- schema poate fi parsată într-un test de model.

### T02 — Durable EventStore v1

**Target:** core/kernel/eventstore + migration 001.

Implementare locală single-node, preferabil SQLite/WAL cu driver compatibil build policy sau ADR explicit dacă policy se schimbă. Append trebuie CAS pe expected sequence.

**DONE verificabil:**
- append/load/restart tests;
- concurrent stale expectedSeq este respins;
- torn/crash transaction nu produce partial event;
- event payload hash și stream ordering verificate;
- schema migration este idempotentă.

### T03 — Task/Node/Edge Projections

**Target:** core/kernel/taskgraph.

Construiește projection deterministic din event stream și one-node TaskSpec.

**DONE verificabil:**
- replay de N ori produce byte-equivalent canonical projection;
- invalid transition este refuzată;
- dependency edge nu devine READY înainte de predicate;
- restart reproduce state fără side effect.

### T04 — Compatibility Adapter pentru agent.Manager

**Target:** core/agent/kernel_adapter.go.

Păstrează UI/API actuală, dar Start/Snapshot/Decide/Resume trebuie mapate pe kernel events, nu current-run.json ca source of truth.

**DONE verificabil:**
- testele approval/recovery relevante trec prin adapter;
- desktop/controller nu necesită rescriere;
- grep/import graph arată că live path instanțiază kernel adapter;
- legacy file store este doar migration input, nu authority.

### T05 — LeaseStore + Fencing

**Target:** core/kernel/lease.

Lease per node cu monotonically increasing fence.

**DONE verificabil:**
- acquire/renew/release tests;
- expired owner nu poate commit;
- stale fence test reproduce și este respins 100%;
- restart păstrează ownership epoch corect.

### T06 — Side-Effect Journal + Reconciler Contract

**Target:** core/kernel/journal.

Introduce Intent ID, idempotency key, tool/version digest, input digest, capability ref, lease fence, external ref și phases.

**DONE verificabil:**
- Intent este persistent înainte de worker start;
- aceeași idempotency key nu poate crea două intents active;
- crash după Started produce UNCERTAIN;
- IRREVERSIBLE din UNCERTAIN nu este auto-reexecutat;
- mock reconciler poate marca committed/retry/operator-required.

### T07 — Capability + Secret Broker v1

**Target:** core/kernel/capability și core/kernel/secrets.

Approval mint-uiește un grant scoped la task/node/fence/resource/rights/expiry. Secretul este SecretRef, nu payload.

**DONE verificabil:**
- expired/wrong-fence/wrong-resource grant este refuzat;
- attenuation funcționează, escalation nu;
- no raw secret în persisted event fixtures;
- output gate redacts exact known secrets;
- denied capability produce zero tool invocation.

### T08 — Move process.run Behind swypik-worker

**Target:** cmd/swypik-worker + core/kernel/executor/windows.

Desktop/kernel nu mai apelează coder.Run direct. Worker primește request bounded și o environment allowlist explicită.

**DONE verificabil:**
- import graph live nu mai leagă process.run direct la coder.Run;
- worker env test demonstrează că ILARIA_API_TOKEN și un sentinel secret nu sunt moștenite;
- stdin/stdout protocol bounded;
- timeout omoară arborele de procese;
- worker nu are kernel DB handle.

### T09 — Enforce Sandbox + Hard Budgets

**Target:** executor/windows întâi; executor/linux separat după aceea.

Windows narrow slice: restricted identity/AppContainer-equivalent chosen by ADR, explicit handles, Job memory/process/CPU limits, network default deny.

**DONE verificabil:**
- read outside granted workspace fails;
- process count/memory budget violation termină workerul;
- raw parent handle access fails;
- network connection fără grant fails;
- budget usage este raportat în result evidence.

### T10 — Independent Verifier + EvidenceBundle v1

**Target:** cmd/swypik-verifier + core/kernel/verifier/evidence.

Începe deterministic: output schema, expected file hashes/diff, test exit evidence, policy checks.

**DONE verificabil:**
- verifier process nu primește executor capability;
- executor „success” cu wrong artifact este respins;
- verifier result are input/output/tool build hashes;
- commit nu poate ajunge SUCCEEDED fără accepted verifier event.

### T11 — Crash Recovery / Reconciliation Matrix

**Target:** core/kernel/replay/recovery tests.

Injectează crash la fiecare frontieră: before intent, after intent, after start, after result, during verify, before commit, after commit.

**DONE verificabil:**
- nicio fereastră nu produce blind duplicate effect;
- final state este deterministic sau OPERATOR_REQUIRED;
- restart recovery latency este măsurată;
- legacy current-run import este one-shot și hash-uit.

### T12 — Implement Q-bench / Fault Gate

**Target:** benchmarks/orchestrator + cmd/swypik-bench.

Implementează cele 11 metrics și exact cele 9 fault classes definite în Q-bench, cu manifest al run-ului.

**DONE verificabil:**
- duplicate side-effect rate = 0;
- lost worktree collisions = 0;
- fault pass rate = 100%;
- security escapes = 0;
- cold-start/idle RAM/overhead/recovery/CPU/token/latency sunt raportate ca measured, nu inferred;
- CI/release gate refuză M1 dacă oricare hard gate eșuează.

După T12 se decide pe date dacă DAG concurrency se extinde imediat sau dacă sandbox/recovery are nevoie de încă un hardening cycle. Nu se pornește distributed scheduler înainte de aceste gates.

---

## 11. Ce NU trebuie construit încă

1. **Nu construiți un kernel general-purpose propriu.**
2. **Nu scrieți drivere NIC/NVMe/USB/audio/GPU proprii** când upstream Linux deja rezolvă problema.
3. **Nu scrieți compositor Wayland de la zero** înainte de platform plumbing stabil.
4. **Nu porniți multi-host/distributed orchestrator** înainte de leases/journal/fencing/fault gates single-node.
5. **Nu pretindeți exactly-once pentru side effects arbitrare.**
6. **Nu construiți Google-scale crawler/index** înainte de relevance + single-node storage/capacity evidence.
7. **Nu adăugați vector search ca substitut pentru index/storage correctness**; hybrid vine după eval și Index v2.
8. **Nu creați un al doilea Ilaria chatbot pe Organism.** Extrageți memory/retrieval, păstrați un singur inference runtime.
9. **Nu pretrenați un nou model de la zero pentru branding.** Evaluați BitNet + RAG + LoRA + verified trajectories întâi.
10. **Nu extindeți Swyp cu FFI arbitrar, debugger, incremental compiler sau probabilistic layer** înainte de Core IR authority + Effect/Capability semantics.
11. **Nu reactivați App Store/Docs/Sheets/Proactive/Mobile ca product claims** până nu au persistence, authority, real adapters și evidence.
12. **Nu permiteți autonomous self-update** înainte de signed artifacts, trust root, canary și rollback.
13. **Nu folosiți LLM-ul pentru crawl scheduling per URL.**
14. **Nu investiți în UI polish ca substitut pentru authority/recovery correctness în M1.**

---

## 12. M1 Definition of Done final

M1 poate fi declarat terminat numai când toate sunt adevărate simultan:

1. live SwypikOS path folosește kernel event store ca source of truth;
2. Task/Node/Edge projection este durabilă;
3. fiecare executable node are lease + fence;
4. fiecare external effect are durable Intent înainte de start;
5. capability grant este scoped și bound la fence;
6. raw secrets nu intră în prompt/event/tool persisted output;
7. process.run nu mai rulează cu ambient user authority;
8. hard resource budgets sunt enforce-uite din afara workerului;
9. independent verifier precede commit;
10. crash/restart poate reconcile fără blind replay;
11. stale worker nu poate commit;
12. Q-bench hard gates: duplicate=0, collisions=0, fault=100%, security escape=0;
13. current UI poate continua să opereze prin compatibility adapter;
14. toate claims de performance sunt însoțite de measured run manifest.

Până atunci termenul corect este **approval-gated agent runtime**, nu autonomous kernel.

---

## 13. Concluzia pentru orchestrator

Nu mai este nevoie de încă un audit general înainte de M1. Direcția este suficient de clară.

**Începeți cu T01.**  
Prima linie de cod M1 trebuie să consolideze execution semantics și durable authority, nu să adauge încă un agent, un driver, un UI sau un model.

Ordinea de dependență este:

**semantics → event store → projections → adapter → leases → journal → capabilities/secrets → worker isolation → verifier → recovery → fault gates → concurrency**

Aceasta păstrează ce este deja bun în runtime-ul actual — approval, bounded execution, fail-closed persistence și conservative recovery — și înlocuiește exact partea care lipsește: authority, durability, reconciliation și independently verifiable execution.

După M1, Swyp poate primi efecte/capabilități fără să devină periculos, iar Ilaria poate primi mai multă autonomie fără să primească autoritatea hostului. Abia atunci M2/M3/M4 se pot integra într-un singur SwypikOS coerent.
