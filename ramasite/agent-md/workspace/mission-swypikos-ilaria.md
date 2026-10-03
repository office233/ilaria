# MISIUNE STRATEGICĂ P0 — SWYPIKOS / ILARIA / SWYP LANG

Autoritate: owner, 2026-09-28.

## North Star

Construiește o platformă AI-native în care:

1. **SwypikOS** devine un sistem de operare independent, first-party, și control-plane/orchestrator universal pentru software, agenți, modele, hardware și servicii. Nu este definit ca „Linux + shell” și nu moștenește automat o bază de kernel ca decizie de produs; kernelul/platform substrate se decide prin ADR și benchmark, cu owner approval.
2. **Ilaria** este arhitectura cognitivă proprie a platformei — proiectată ca un „organism” software cu memorie, atenție, învățare, consolidare, planificare, tool-use și identitate operațională persistentă. LLM/BitNet este un substrat de limbaj/inferență al Ilariei, nu definiția completă a Ilariei.
3. **Swyp Lang** devine limbajul AI-native al platformei: contracts, intents, capabilities, verification, agent orchestration și synthesis ca primitive de limbaj.
4. **Swyp Compute Fabric** transformă, numai cu consimțământ explicit, GPU/CPU/NPU idle ale utilizatorilor SwypikOS într-un pool distribuit pentru training, evals, distillation, search/indexing și alte workload-uri Ilaria verificate.
5. Sistemul urmărește simultan: securitate foarte ridicată, crash recovery, determinism unde este posibil, observabilitate completă și consum minim de CPU/RAM/GPU/IO/network.

Ținta de produs este să depășească sistemele de operare existente pe workload-urile unde SwypikOS este proiectat să exceleze: agentic work, recuperare după crash, autonomie locală, search propriu, securitate/capabilities, eficiență și compute colaborativ. Nu declara „cel mai bun OS” fără benchmark-uri reproductibile contra Windows/macOS/Linux și baseline-urilor relevante.

## Regula de execuție

ChatGPT principal orchestrează și poate executa direct. ChatGPT workers execută taskurile delegate. Task Kernel ține starea și lease-urile. QA verifică independent printr-un verifier ChatGPT proaspăt.

Nu porni implementări masive înainte de:
- audit complet al `E:\nexus`, `E:\nexus\swypik-os` și `E:\nexus\swyp`;
- hartă arhitecturală current-state;
- gap analysis față de orchestratoare/agent runtimes/OS-uri moderne;
- benchmark baseline;
- design ADR pentru componentele fundamentale.

## Stream A — SwypikOS Orchestrator

Obiectiv: SwypikOS trebuie să poată orchestra proiecte, agenți și toolchains fără să depindă conceptual de Cowork/Claude Code/Codex.

Capabilități țintă:
- durable task graph / DAG;
- leases și isolation domains;
- capability-based permissions;
- event-sourced execution history;
- resumable/recoverable workflows;
- multi-agent planning + independent verification;
- provider/model routing pe capabilitate, cost, latență și calitate;
- local + cloud compute scheduler;
- semantic code intelligence;
- browser/native UI/device orchestration;
- self-evaluation și self-improvement cu gates;
- deterministic replay pentru operațiile unde este posibil;
- offline/local-first degradation mode;
- resource budgets CPU/RAM/GPU/IO/network per task;
- plugin/driver model extensibil;
- kernel/platform architecture first-party, cu ABI/device model documentat și fără asumarea implicită că Linux este produsul final;
- compatibility strategy pentru hardware/apps care nu compromite ownership-ul SwypikOS;
- universal-native device model: x86-64, ARM64, RISC-V64 și porturi viitoare printr-un Hardware Manifest + Device Graph comun;
- installer adaptiv: Ilaria poate genera cod/IR pentru hardware necunoscut, dar numai prin synthesize → compile → verify → canary → rollback;
- generated drivers rulează implicit în user-mode/capability domains, nu cu ambient kernel authority;
- fiecare driver generat este legat de hardware/firmware/toolchain/provenance hashes și are evidence bundle;
- security boundaries reale, nu doar prompt instructions.

## Stream A2 — Universal Native / AI-Adaptive Install

Obiectiv: aceeași arhitectură SwypikOS poate fi portată pe PC/laptop, telefon,
tabletă, embedded/edge, automotive compute și alte dispozitive care permit legal
și tehnic third-party boot/install.

La instalare:
1. bootstrap-ul inventariază firmware/arch/buses/devices;
2. construiește Hardware Manifest + Device Graph;
3. folosește driver/adaptor semnat cunoscut când există;
4. pentru hardware fără suport, Ilaria poate genera un candidat de driver/adaptor;
5. candidatul nu primește authority doar fiindcă a fost generat de AI;
6. Swyp/ABI + verifier validează schema/capabilities/provenance;
7. build/test/emulation/control probe rulează izolat;
8. activarea este canary, cu health checks și rollback;
9. fallback-ul este safe mode/generic standard driver, nu execuție neverificată.

Pentru telefoane cu bootloader blocat, hardware proprietar sau automobile cu
control safety-critical, suportul depinde de accesul legal/tehnic și de politici
separate; nu se ocolesc secure boot, OEM locks sau safety certification.

## Stream B — Ilaria

Obiectiv: construiește o cale tehnică realistă spre o arhitectură cognitivă proprie, coerentă și persistentă, capabilă să perceapă context, să rețină, să învețe, să planifice, să folosească unelte și să se corecteze. Modelul lingvistic/inference runtime este o componentă a acestui sistem, nu întregul sistem.

Faze:
1. evaluează arhitectura actuală și separă explicit: cognitive organism, memories, attention/salience, learning/consolidation, planning/tool-use, language/inference cortex și OS authority;
2. unește componentele cognitive într-un singur lifecycle Ilaria, fără două „creiere” concurente;
3. definește benchmark suite internă pentru comportament cognitiv, nu doar next-token quality;
4. construiește dataset/eval/trajectory pipeline cu provenance;
5. identifică strategia de training/fine-tuning/distillation/RAG/memory/tool-use care este fezabilă;
6. măsoară permanent quality / adaptation / memory retention / repair / latency / memory / tokens / energy;
7. abia apoi scalează compute.

Compute:
- inventariază GPU/CPU locale și resurse cloud deja autorizate;
- tratează GPU-urile utilizatorilor SwypikOS ca resursă strategică de compute distribuit, opt-in și revocabilă instant;
- schedulerul trebuie să suporte hardware eterogen, lease-uri, checkpoint-uri, preemption, resumability și workload placement după VRAM/throughput/thermal/power/network;
- fiecare job trebuie să fie versionat, semnat, sandboxed și verificat înainte ca rezultatul să influențeze un checkpoint/model/index oficial;
- rezultatele nodurilor sunt neîncrezătoare implicit; folosește replication/spot-check/robust aggregation/reputation/evidence;
- fișierele personale și conversațiile nu devin date de training implicit; orice on-device/federated-data mode cere consimțământ separat și privacy gate;
- fără mining, crypto-token sau proof-of-work economic; contribuția măsoară useful verified compute;
- propune necesarul suplimentar cu cost, impact și alternativă;
- nu cumpăra, nu provisiona resurse plătite și nu folosi infrastructură terță fără autorizare/buget;
- nu executa acțiuni distructive asupra serverelor sau infrastructurii altor organizații.

## Stream B2 — Swyp Compute Fabric

Obiectiv: fiecare instalare SwypikOS poate deveni, dacă utilizatorul activează explicit opțiunea, un nod de compute verificat pentru Ilaria și platformă.

Arhitectura țintă:
- device identity + attestation/evidence unde este fezabil;
- capability inventory real: GPU/NPU/CPU, VRAM/RAM, driver/runtime, measured throughput;
- signed job manifest + content-addressed artifacts;
- lease + heartbeat + timeout + retry + checkpoint;
- sandboxed worker fără acces implicit la datele utilizatorului;
- resource governor: idle-only, AC/battery, temperatură, putere, VRAM, bandwidth și orar;
- immediate yield când utilizatorul revine;
- result hash/signature + independent verification;
- robust aggregation pentru training distribuit;
- accounting de useful verified compute, fără monede/crypto;
- coordinatorul poate porni centralizat pentru bootstrap, dar protocolul trebuie să permită ulterior multi-region/federated coordinators fără lock-in la Azure.

Workload-uri candidate:
1. evals și benchmark shards;
2. synthetic-data validation;
3. LoRA/adapters și distillation shards;
4. embedding/index builds;
5. search crawl/parse/ranking experiments;
6. batched inference non-interactive;
7. full training numai unde algoritmul și bandwidth-ul o fac eficientă.

Nu presupune că GPU-urile eterogene formează un singur cluster sincron. Schedulerul alege workload-ul după hardware și rețea.

## Stream C — Swyp Lang

Obiectiv: limbaj AI-native, nu un wrapper cosmetic peste Go/Python.

Product/Architecture trebuie să cerceteze și să decidă:
- model semantic;
- syntax vs IR-first;
- type/effect system;
- capability/security types;
- agent/task primitives;
- contracts + invariants + verification;
- deterministic and probabilistic operations;
- FFI cu Go/Rust/C/CUDA/WebAssembly;
- compiler/interpreter/runtime;
- package/module system;
- debugger/tracing;
- incremental compilation;
- formalizable subset;
- AI-assisted synthesis fără a pierde reproducibilitatea.

Primul milestone nu este „scrie compilerul”, ci un ADR + executable minimal IR + 3 programe demonstrative și benchmark.

## Stream D — Efficiency & Reliability

Ținte măsurabile, nu sloganuri:
- cold-start;
- idle RAM;
- task overhead;
- scheduler throughput;
- recovery time după crash;
- duplicate side-effect rate;
- worktree/file collision rate;
- CPU per orchestration task;
- token/model-call efficiency;
- latency p50/p95;
- fault-injection pass rate.

Construiește benchmark harness comparabil cu baseline-uri publice și cu versiunile noastre anterioare.

## Stream E — Security

Principii:
- least privilege;
- capability tokens;
- scoped filesystem/process/network access;
- immutable audit log;
- secrets never enter prompts/logs;
- verifier separat de executor;
- signed/versioned artifacts;
- rollback/canary/self-update sigur;
- sandbox real pentru procese, nu doar path checks;
- threat model și red-team tests pentru prompt injection, confused deputy, race conditions, supply chain și privilege escalation.

## Milestones

### M0 — Truth
- audit repo complet;
- architecture map;
- toate modulele clasificate: real / prototype / stub / dead;
- baseline tests + benchmark;
- lista P0/P1/P2.

### M1 — Autonomous Kernel
- task graph durabil;
- scheduler;
- leases;
- verifier;
- crash recovery;
- capability isolation;
- benchmark suite.

### M2 — Swyp Lang Seed
- ADR;
- IR;
- parser/compiler minimal sau IR-first tooling;
- 3 demonstrații;
- test suite.

### M3 — Ilaria Eval/Training Pipeline
- eval harness;
- dataset provenance;
- reproducible training/fine-tuning experiment;
- comparativ baseline.
- compute-fabric coordinator + real contributed-GPU pilot cu minimum 2 noduri independente și verificare a rezultatului.

### M4 — SwypikOS Integration
- orchestratorul folosește Swyp Lang/IR;
- Ilaria rulează ca provider propriu;
- tool/device drivers;
- Swyp Compute Fabric este integrat cu consent/resource governor/task leases/evidence;
- self-update canary;
- benchmark + fault injection.

## Definition of Done pentru fiecare milestone

- dovezi în Git;
- teste/gates verzi rulate independent;
- benchmark înainte/după;
- threat model actualizat;
- documente ADR;
- fără rezultate inventate;
- fără bypass al limitelor ownerului.

## Prima acțiune CEO

1. VP Product/Architecture produce auditul și architecture/gap spec.
2. VP Engineering verifică executabilitatea și creează planul tehnic în task-uri ≤ 1 zi.
3. QA definește benchmark/fault-injection suite înainte de refactor major.
4. CEO reconciliază cele trei rapoarte și aprobă ordinea milestone-urilor.
5. Abia apoi pornește workers de implementare prin `task_* → chatgpt_*`.
