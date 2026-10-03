# SWOS — Audit AI Systems / Compiler Architecture: Ilaria + Swyp Lang

**Data auditului:** 2026-09-28  
**Rol:** AI systems/compiler architect auditor  
**Scope live inspectat:** E:\nexus și E:\nexus\swyp  
**Repo Git:** E:\nexus, branch main, HEAD observat: 96290fa  
**Mod de lucru:** strict read-only în repo; singura scriere este acest raport  
**Baseline citit:** E:\CEO\projects\swos\m0\B-ilaria-swyplang-audit.md  
**North Star:** E:\CEO\specs\mission-swypikos-ilaria.md

> **Verdict executiv:** există suficient cod real încât direcția SwypikOS ↔ Ilaria ↔ Swyp să fie construită prin consolidare, nu prin rescriere de la zero. Ilaria are model/runtime BitNet, LoRA loading, KV-cached inference și un agent/tool loop funcționale; Swyp are parser, Semantic Core IR, executor bounded, contracts/verifier, synthesis și STV2/SWYPB funcționale. Cele două probleme arhitecturale majore sunt: **(1) split-brain în Ilaria** — stack-ul cognitiv Organism/memory/self-training nu este runtime-ul folosit de ilaria-serve/ilaria-chat, care rulează BitNet + Runner; **(2) Swyp este încă workflow-native, nu semantics-native** — AI propune source din exterior, dar effects/capabilities/tasks/probabilistic ops/FFI/debugger/incremental compilation nu sunt încă semantică de limbaj.

---

# 0. Reguli și metodologie

Au fost respectate explicit restricțiile din E:\nexus\AGENTS.md:

- nu au fost citite data/, cuda/, .env*, secrete, *.exe, *.zip, *.log sau alte clase interzise;
- nu s-au executat training, build, test, benchmark sau procese care ar putea scrie artefacte;
- nu s-a făcut checkout, commit, stash, clean, push, deploy sau provisioning;
- nu s-a modificat niciun fișier din E:\nexus sau E:\nexus\swyp;
- agent-lab a fost inventariat numai structural; executabilele nu au fost deschise;
- singura scriere permisă este prezentul fișier.

Acest audit folosește trei niveluri de evidență:

1. **IMPLEMENTED** — există cod concret și interfețe executabile.
2. **WIRED** — componenta este conectată în fluxul live inspectat.
3. **VALIDATED** — există teste/evidență reproductibilă curentă sau baseline M0 pe același HEAD.

Nu am rerulat testele deoarece ownerul a impus ca singura scriere permisă să fie raportul. Baseline-ul M0 citit a rulat la același HEAD 96290fa și a documentat go vet / go test pentru root + Swyp; acest raport nu pretinde o nouă execuție a acelor teste.

---

# 1. Current-state architecture — granițele reale

## 1.1 MODEL

### A. BitNet b1.58 2B4T — modelul folosit de runtime-ul headless actual

Cod relevant:

- cortex/bitnet.go
- cortex/bitnet_persist.go
- cortex/bitnet_decode.go
- cortex/bitnet_lora*.go
- tokenizerele asociate

BitNetModel este o structură reală de model decoder-only, cu:

- token embedding tied cu lm_head;
- NumLayers decoder layers;
- ternary BitLinear Q/K/V/O + Gate/Up/Down;
- RMSNorm/subnorm;
- RoPE;
- greedy și sampled generation;
- decoder incremental / KV cache;
- NXTF v3 loader strict;
- LoRA loading înainte de construirea decoderului în ilaria-serve, ilaria-chat și ilaria-swyp.

**Clasificare:** REAL model representation + REAL inference implementation.  
**Caveat:** acest audit nu a deschis weights din data/ și nu a rerulat real-checkpoint GPU validation.

### B. Dense Ilaria / MiniTransformer

Cod relevant:

- cortex/transformer.go
- forge/ilaria_model.py
- forge/train_ilaria.py
- cmd/train
- cmd/nxtf-run și training paths istorice

MiniTransformer are forward, training și generation reale. Forge are pipeline PyTorch pentru pretraining și export NXTF. Este însă un traseu diferit de runtime-ul BitNet folosit de ilaria-serve.

**Clasificare:** REAL implementation, dar **research/legacy product path** față de BitNet + adapters.

### C. LoRA adapters

forge/train_tools.py implementează SFT LoRA pentru baza BitNet, cu:

- offline base loading;
- train/validation separate;
- assistant-token loss;
- deterministic seed;
- gradient accumulation;
- DDP;
- checkpoint/resume cu contract strict;
- hash pentru dataset contract;
- immutable step exports;
- metadata pentru LoRA și validation loss.

**Clasificare:** REAL experiment/training pipeline.  
**Limită:** validation loss nu este task success; promotion trebuie decisă pe eval extern, nu pe loss.

---

# 2. INFERENCE RUNTIME — ce rulează efectiv

## 2.1 Runtime-ul activ

Fluxul headless real este:

~~~text
NXTF v3 BitNet weights
      │
      ├── optional LoRA
      │
      ▼
BitNetModel
      │
 CPU/CUDA StepDecoder
      │
 HF/Llama tokenizer
      │
 cortex.Runner
      │
 tool loop + KV cache
      │
 ├── cmd/ilaria-chat
 ├── cmd/ilaria-serve  POST /v1/chat
 └── cmd/ilaria-swyp   generation + Swyp verifier loop
~~~

Search-ul live în cele trei comenzi arată explicit:

- ilaria-serve: LoadBitNetModel → optional LoadBitNetLoRA → NewRunner;
- ilaria-chat: LoadBitNetModel → optional LoRA → NewRunner;
- ilaria-swyp: LoadBitNetModel → optional LoRA → NewRunner.

Nu există NewOrganism / Hippocampus / CognitiveBridge în wiring-ul acestor trei comenzi.

## 2.2 ilaria-serve

Este un server headless real, nu wrapper dummy:

- POST /v1/chat;
- request max 64 KiB;
- history validată;
- max history / pair ordering;
- timeout de turn;
- concurrency gate;
- loopback hardening;
- non-loopback cere TLS + token;
- toolset implicit restrâns: calc, time, convert;
- read_file numai dacă operatorul configurează workdir;
- nu înregistrează implicit go_run;
- răspunsul poate conține tool-call log.

**Clasificare:** REAL serving runtime.

## 2.3 Decoder semantics

BitNet are două niveluri:

- model API cu GenerateGreedy / GenerateSampled;
- agent Runner care, în fluxul inspectat, generează segment cu argmax.

Asta înseamnă că infrastructura suportă sampling, dar agent loop-ul live este în principal greedy. Nu trebuie raportat „probabilistic agent execution” doar pentru că model API are sampling.

---

# 3. COGNITIVE ARCHITECTURE — Organism este alt sistem

cortex/organism.go agregă un stack cognitiv mult mai larg:

- Wernicke / Broca;
- Hippocampus episodic;
- SemanticMemory;
- Cerebellum cache;
- Prefrontal;
- Workspace;
- WorkingMemory;
- attention;
- predictor;
- reward;
- analogy;
- reasoning;
- sleep consolidation;
- Radio/NeuroRadio/FractalCortex;
- optional MiniTransformer;
- CognitiveBridge;
- online self-training.

Process() are un pipeline real și complex: understand → deterministic reasoning → attention/workspace → memory recall → generation → learning.

### Important

**Acesta nu este runtime-ul folosit de ilaria-serve/ilaria-chat/ilaria-swyp.**

CognitiveBridge însuși descrie problema istorică: hippocampal recall și transformer generation au fost două engine-uri de generație separate, iar bridge-ul aplică bias peste logits pentru MiniTransformer/BPE.

Headless BitNet Runner nu consumă această arhitectură.

## 3.1 Consecință: split-brain

Astăzi Ilaria înseamnă două familii de runtime:

### Runtime A — product-facing / headless

- BitNet;
- LoRA;
- tokenizer;
- decoder;
- KV cache;
- Runner;
- ChatTools.

### Runtime B — cognitive research

- Organism;
- SDR;
- Hippocampus;
- SemanticMemory;
- WorkingMemory;
- CognitiveBridge;
- MiniTransformer;
- self-evolution.

Acestea nu trebuie „unificate” prin copiere reciprocă. Trebuie extrasă o interfață comună de memory/retrieval/context și un singur inference runtime.

---

# 4. AGENT / TOOL-USE

## 4.1 cortex.Runner este agent-loop real

ChatTool are contract concret:

- Name()
- Describe()
- Call(ctx,args)

Runner implementează:

- system prompt cu catalog de tool-uri;
- protocol textual CALL <tool>: <args>;
- parsing și dispatch;
- maxCalls;
- maxTokens;
- tool result reinjectat în conversație;
- KV cache continuu între turn-uri;
- reset la system prefix;
- ToolCallLog.

Built-ins inspectate:

- calc;
- time;
- convert;
- read_file cu root confinement și 8 KiB max;
- biomed;
- go_run, doar explicit;
- swyp judge.

**Clasificare mecanism:** REAL.  
**Clasificare autonomie/calitate:** PROTOTYPE.

## 4.2 go_run

Codul însuși este corect de precaut:

- disabled by default;
- operatorul trebuie să permită explicit host execution;
- nu este OS sandbox;
- RunGo fail-closed cere izolare;
- RunTrustedGo are host permissions.

SwypikOS nu trebuie să transforme acest flag într-o permisiune de model. Autoritatea trebuie să rămână în OS capability broker.

## 4.3 SwypJudgeChatTool

Este integrarea corectă ca principiu:

- executable absolut configurat de operator;
- argument fix „judge”;
- model input doar JSON bounded pe stdin;
- source nu devine shell/path;
- candidate code rulează în Core executor fuel-bounded;
- returnează status + summary + full JSON report.

Aici există o graniță sănătoasă: **modelul propune, verifierul decide**.

---

# 5. MEMORY — trebuie separat pe tipuri

## 5.1 KV cache

Runner păstrează KV cache. Este state de inferență/conversație, nu long-term memory.

**REAL + WIRED** în BitNet headless.

## 5.2 Episodic memory

Hippocampus stochează SDR + context, are:

- scored recall;
- keyword recall;
- indexare;
- persistence;
- consolidation.

Codul Process conține chiar mitigări explicite pentru false recall cauzat de SDR collapse.

**REAL mechanism, research semantics.**  
**Nu este wired în ilaria-serve.**

## 5.3 Semantic memory

SemanticMemory generalizează concepte din hippocampus și poate face query.

**PROTOTYPE functional subsystem.**  
**Nu este wired în BitNet headless.**

## 5.4 Working memory

Organism are WorkingMemory distinct de KV cache.

**PROTOTYPE functional subsystem.**  
**Nu este shared cu Runner.**

## 5.5 Self-training memory loop

self_training.go implementează:

- TrainTransformerFromCorpus;
- TrainTransformerFromMemories;
- TrainTransformerFromQA;
- SelfEvolve.

Acestea antrenează MiniTransformer din Organism, nu adapterul BitNet folosit de ilaria-serve.

Prin urmare afirmația „Ilaria se auto-antrenează continuu” nu poate fi transferată automat runtime-ului BitNet de produs.

---

# 6. TRAINING / DATA / EVAL — ce este real

## 6.1 Dense training

forge/train_ilaria.py:

- pretraining LM real;
- train/validation split;
- AdamW;
- warmup/cosine;
- gradient clip;
- seed;
- precision control;
- checkpoint/resume;
- NXTF export.

**REAL implementation / research line.**

## 6.2 Tool-use LoRA

forge/train_tools.py:

- SFT pe trajectories;
- exact protocol compatibility cu Runner;
- labels numai pe assistant tokens;
- no silent truncation;
- train/validation leakage checks;
- resume contract;
- exported adapter metadata.

**REAL experiment pipeline și cea mai relevantă bază pentru M3.**

## 6.3 Swyp Forge

cmd/swyp-forge este unul dintre cele mai puternice elemente actuale de data quality:

- folosește doar train tasks;
- re-verifică reference ca exhaustive;
- generează mutants;
- păstrează numai counterexamples reale;
- compile/syntax failures reale devin repair examples;
- wrong code apare în user prompt, nu ca assistant target;
- model-generated accepted source este re-verificat;
- held-out task text este verificat pentru leakage;
- train/validation derivă determinist;
- manifestul include hash-uri pentru files și inputs.

Manifestul live forge/colab/swyp-forge-examples-v1/manifest.json indică:

- 279 train rows;
- 37 validation rows;
- 316 rows total;
- 40 direct;
- 200 semantic repair;
- 64 syntax repair;
- 12 model-derived rows;
- input hashes pentru task corpus / swyp executable / model report.

Acest dataset este mic, dar lineage-ul este semnificativ mai bun decât corpusurile legacy.

## 6.4 Current Swyp held-out

docs/ILARIA_LOOP.md raportează explicit, pentru 2026-09-28:

- 60 tasks, split 40 train / 20 held-out;
- base BitNet b1.58 2B4T;
- greedy;
- GTX 1660 Ti;
- held-out: 6/20 pass@1;
- 6/20 repair@4;
- 0 din 14 failures au fost reparate după feedback;
- 44 compile errors, 12 counterexamples, 6 exhaustive passes în 62 replies.

Documentul însuși notează corect că 20 tasks este un eșantion mic și nu trebuie generalizat.

**Concluzie:** propose→verify este funcțional; repair intelligence nu este încă demonstrată.

## 6.5 evalsuite scorer

Există doc drift.

HARDCODING_AND_LIMITATIONS.md încă spune că cele două bug-uri de scorer sunt TODO:

- raw substring pentru yes/no;
- first-number numeric extraction.

Codul live cortex/evalsuite/score.go este însă ScorerVersion = 2 și implementează:

- word-boundary text matching;
- answer-aware numeric extraction;
- scorer_version în rezultat.

Deci defectele respective nu mai sunt active în aceeași formă.

### Defect rămas în suite

cortex/evalsuite/suite.go are task-ul reason_syllogism:

- prompt: „All birds can fly. A penguin is a bird. Can a penguin fly? Answer yes or no.”
- Expected: ["yes","no"]
- ModeContainsAny

Asta acceptă practic ambele răspunsuri și nu măsoară raționarea. Suite-ul standard are sub 50 itemi și este potrivit ca smoke/trend suite, nu ca benchmark de capabilitate generală.

---

# 7. DISTILLATION — există mecanisme, provenance este insuficient

## 7.1 cmd/distill

Poate colecta instruction/response de la endpointuri OpenAI-compatible sau Anthropic, cu:

- concurrency;
- retries;
- resume;
- model/provider config;
- skip failure.

Dar outputul final este doar:

~~~json
{"instruction":"...","response":"..."}
~~~

Nu persistă obligatoriu în fiecare row sau într-un manifest canonic:

- teacher provider;
- teacher model revision;
- endpoint identity;
- system prompt hash;
- temperature;
- max tokens;
- timestamp;
- source prompt provenance;
- response hash;
- license/terms;
- request ID;
- filtering/verifier status.

Prin urmare este **PROTOTYPE data harvester**, nu canonical M3 distillation pipeline.

## 7.2 forge/distill_cot.py

Există teacher API/local HF path și scrie reasoning text. Nu ar trebui să devină baza principală M3.

Pentru Ilaria, datele cu valoare mai mare și provenance mai clar sunt:

- observable tool trajectories;
- verifier counterexamples;
- accepted source;
- final answer;
- explicit outcome.

Nu trebuie să depindem de teacher hidden chain-of-thought ca unitate de adevăr.

---

# 8. SWYP LANG — current architecture

## 8.1 Există trei execuții conceptuale

### Legacy scalar frontend

~~~text
.swyp
  └─ Parse / Check
       ├─ AST interpreter
       ├─ C11 emitter → GCC native
       └─ HTML/JS
~~~

### Semantic Core

~~~text
.swyp
  └─ ParseCore
       └─ lower
            └─ Core IR JSON v1
                 ├─ Prepare / Execute
                 └─ Verify(contract)
~~~

### STV2 / SWYPB

~~~text
safe-integer subset
  └─ compile
       └─ STV2 instructions
            └─ SWYPB module
                 └─ bounded deterministic VM
~~~

Azi Semantic Core și legacy path coexistă. Documentele SWYP_LANG.md și SEMANTIC_CORE.md pot părea contradictorii din cauza acestei bifurcații: legacy spune number=float64 și „no integer type yet”, în timp ce Semantic Core are i64/f64/bool.

**Recomandare:** Core IR trebuie declarat semantic authority, iar legacy frontend trebuie migrat/retired gradual.

---

# 9. CÂT DE AI-NATIVE ESTE SWYP AZI

Verdict: **workflow-native, nu încă semantics-native**.

Este mai mult decât un wrapper deoarece are:

- limbaj propriu;
- checker;
- IR propriu;
- bounded executor;
- contracts;
- verifier;
- synthesis;
- bytecode/VM;
- model-facing judge;
- counterexample loop;
- provenance hash-uri.

Dar AI este astăzi în principal un **external proposer of source**.

Runtime-ul determinist nu este o problemă; dimpotrivă, este un avantaj. AI-native nu trebuie să însemne „VM stochastic”. Trebuie să însemne că **task, authority, model/effect boundary, evidence și nondeterminism sunt first-class și auditable**.

---

# 10. GAP ANALYSIS SWYP LANG

| Capability | Stare live | Ce lipsește |
|---|---|---|
| Semantic model | PARTIAL-REAL | Core scalar/CFG există; lipsesc memory/resources/effects/tasks/modules ca semantică |
| IR-first authority | PARTIAL | Core IR este candidatul evident, dar legacy path coexistă |
| Type system | PARTIAL-REAL | i64/f64/bool; fără richer values, ownership/resource types |
| Effects | PLACEHOLDER | Function și Contract au Effects, dar v1 respinge orice effect nenul |
| Capabilities | ABSENT | fără typed authority tokens, capability propagation, attenuation |
| Contracts | PARTIAL-REAL | requires/ensures + bounded verify; fără loop invariants/state contracts/proof engine |
| Task primitives | ABSENT | task/goal/dependency/retry/approval/result/evidence nu sunt values de limbaj |
| Probabilistic ops | ABSENT | nici RNG semantic, nici distribution/sample/seed provenance |
| FFI | GAP | C emitter ≠ FFI; nu există ABI coerent Go/Rust/C/CUDA/WASM |
| Debugger | GAP | source locations/diagnostics există; nu DAP/step/break/watch/time-travel |
| Tracing | PARTIAL | verifier report/history hashes; nu unified execution trace |
| Incremental compiler | ABSENT | fără module graph/cache/invalidation |
| Package/module | ABSENT/limited | docs îl listează next work |
| Formalizable subset | PROMISING PARTIAL | pure typed Core IR e candidat bun; nu formal spec/proof translation |
| AI synthesis | PARTIAL | enumerative synthesis + model proposer; reproducibility metadata neuniform |
| Runtime isolation | PARTIAL | Core has no host ops; nu este OS sandbox sau memory quota |
| Determinism | STRONG pe Core/STV2 | trebuie extins prin explicit effect boundary |

---

# 11. EFFECTS + CAPABILITIES — design recomandat

Nu adăuga direct opcodes fs/network/model în Core v1.

Păstrează două straturi:

## 11.1 Pure Core

Funcții:

~~~text
fn f(x: i64) -> i64 !pure
~~~

Proprietăți:

- zero ambient authority;
- deterministic;
- replayable;
- verifier-friendly;
- cacheable;
- safe pentru compile/test/synthesis.

## 11.2 Effect IR

Efectele să fie declarate și propagate:

~~~text
effects {
  fs.read(path)
  net.fetch(domain)
  clock.read
  rng.sample(seed_scope)
  model.infer(provider, model_class)
  tool.call(tool_id)
}
~~~

Capability este dovada de autoritate, nu stringul efectului.

Exemplu conceptual:

~~~text
cap fs_ro = capability<fs.read>("workspace:/src/**")
task inspect(repo: Repo, using fs_ro) -> Result<Report, Error>
~~~

Reguli:

1. pure by default;
2. capability absent → static reject sau runtime deterministic deny;
3. capability cannot be fabricated by guest code;
4. call graph propagă required effects;
5. capability poate fi attenuated, nu escalated;
6. SwypikOS emite/validează tokenul;
7. Swyp runtime doar cere effect brokerului;
8. audit trace leagă request → authority → result.

Această graniță trebuie să fie semantică de limbaj, nu prompt convention.

---

# 12. CONTRACTS — extindere realistă

Current v1:

- requires;
- ensures;
- finite numeric domains;
- bounded fuel;
- exhaustive pe domenii finite i64 când bugetul permite;
- seeded sampling altfel;
- counterexample;
- hashes.

Păstrați terminologia strictă:

- exhaustive ≠ proved;
- tested ≠ proved;
- unknown ≠ success.

Next layer:

1. loop invariants;
2. resource contracts: fuel / memory / IO / network;
3. effect contracts;
4. state transition contracts;
5. capability preconditions;
6. termination annotations pentru subset;
7. SMT translation numai pentru subsetul formalizabil;
8. proof result nou numai când există solver/proof evidence separat de executor.

Nu redenumi exhaustive în proved.

---

# 13. TASK PRIMITIVES — unde aparțin

SwypikOS are nevoie de task graph durabil. Swyp Lang poate reprezenta task semantics fără să devină schedulerul principal.

Propunere:

~~~text
task BuildPackage(input: SourceTree)
  requires capability<fs.read>
  requires capability<build.exec>
  budget cpu=2, ram=2GiB, wall=120s
  retry transient max=2
  -> Artifact
  evidence { build_log, artifact_hash }
~~~

Swyp Lang definește:

- TaskSpec;
- dependency/result types;
- capability requirements;
- budgets;
- retry class;
- evidence schema.

SwypikOS execută:

- DAG;
- leases;
- scheduling;
- retries;
- persistence;
- approvals;
- crash recovery.

**Nu duplica Task Kernel în Swyp VM.**

---

# 14. PROBABILISTIC OPS — explicit, nu implicit

Swyp Core trebuie să rămână determinist.

Un layer probabilistic poate exista numai cu semantică explicită:

~~~text
sample Bernoulli(0.25) using rng(seed=task.seed)
infer Model("ilaria", profile="planner") using capability<model.infer>
~~~

Trace-ul trebuie să includă:

- RNG algorithm/version;
- seed;
- sampling params;
- provider/model artifact;
- prompt hash;
- response hash;
- replay class: exact / semantically replayable / non-replayable.

Același principiu pentru clock/network/model.

---

# 15. FFI — design înainte de implementare

Nu expune direct arbitrary DLL/SO.

Ordinea recomandată:

1. stable C ABI subset;
2. WebAssembly component/WASI-style adapter;
3. Go/Rust wrappers generate peste C/WASM ABI;
4. CUDA prin host-owned kernel provider, nu raw guest pointers.

FFI descriptor trebuie să specifice:

- symbol;
- ABI version;
- input/output types;
- ownership/lifetime;
- thread safety;
- effects;
- required capabilities;
- max resource budget;
- deterministic class;
- trusted/untrusted boundary.

FFI este un effect boundary și trebuie să fie vizibil verifierului.

---

# 16. DEBUGGER / TRACE / INCREMENTAL

## 16.1 Debugger

Construiți întâi trace deterministic pentru Core:

- instruction index;
- source span;
- function/block;
- slot diffs;
- fuel;
- call stack;
- trap;
- effect request/result IDs.

Apoi:

- step;
- next;
- continue;
- breakpoint source span;
- watch slot;
- reverse replay unde execution este deterministic.

## 16.2 Incremental compiler

Prerequisite: module graph.

Cache key recomandat:

~~~text
hash(
  compiler_semver,
  core_ir_version,
  source_hash,
  dependency_interface_hashes,
  feature_flags,
  target
)
~~~

Invalidarea trebuie bazată pe interface hash, nu timestamp.

Nu încerca incremental compilation înainte de a declara Core IR authority și module semantics.

---

# 17. FORMALIZABLE SUBSET

Current Semantic Core este foarte bun ca seed pentru un subset formalizabil deoarece are:

- scalar types explicite;
- checked i64;
- finite f64;
- explicit CFG;
- pure calls;
- zero host effects;
- bounded recursion/runtime;
- strict loader;
- canonical-ish machine-readable IR;
- contract AST separat.

Propunere: **Swyp/Pure v1**.

Include:

- i64/bool;
- eventual bounded arrays;
- pure functions;
- structured loops cu invariants;
- no f64 pentru primul proof subset;
- no recursion sau recursion cu explicit variant;
- no effects;
- no FFI;
- no dynamic allocation inițial.

Backend de proof:

~~~text
Swyp source
 → Core IR
 → Normalize
 → Verification IR
 → SMT-LIB
 → solver
 → independently checked result / certificate where feasible
~~~

Executorul rămâne separat de prover.

---

# 18. INTEGRAREA ȚINTĂ: SwypikOS ↔ Ilaria ↔ Swyp

## 18.1 Principiul principal

**Un singur owner pentru fiecare responsabilitate.**

| Responsabilitate | Owner |
|---|---|
| durable task graph, leases, approvals | SwypikOS |
| capabilities / authority / resource policy | SwypikOS |
| model inference | Ilaria Runtime |
| planning / tool-selection policy | Ilaria Agent Runtime |
| long-term retrieval/memory service | shared Ilaria MemoryProvider, owned as service/library, nu al doilea generator |
| language semantics / IR | Swyp |
| verifier | Swyp |
| deterministic guest execution | Swyp |
| effects execution | SwypikOS Capability Broker |
| training/eval lineage | M3 experiment registry |

## 18.2 Arhitectură recomandată

~~~text
                         ┌─────────────────────────────┐
                         │          SwypikOS           │
                         │  Task Graph / Scheduler     │
                         │  Leases / Recovery          │
                         │  Approval / Capability CA   │
                         │  Resource Budgets           │
                         │  Event Log                  │
                         └──────────────┬──────────────┘
                                        │ typed AgentTurn
                                        ▼
                         ┌─────────────────────────────┐
                         │      Ilaria Agent Runtime   │
                         │  BitNet inference (ONE)     │
                         │  Runner / Planner           │
                         │  MemoryProvider             │
                         │  Tool policy                │
                         └──────────┬─────────┬────────┘
                                    │         │
                         propose    │         │ retrieve
                                    │         ▼
                                    │  ┌─────────────────┐
                                    │  │ Memory/RAG store│
                                    │  │ episodic/semantic│
                                    │  └─────────────────┘
                                    ▼
                         ┌─────────────────────────────┐
                         │          Swyp Lang          │
                         │ Parse → Core IR             │
                         │ Contracts / Verify          │
                         │ STV2/SWYPB                  │
                         └──────────────┬──────────────┘
                                        │ pure execution
                                        │ OR EffectRequest
                                        ▼
                         ┌─────────────────────────────┐
                         │ SwypikOS Capability Broker  │
                         │ fs/net/process/device/model │
                         │ scoped tokens + audit       │
                         └─────────────────────────────┘
~~~

## 18.3 Ce NU trebuie duplicat

### Nu pune model runtime în Swyp

Swyp poate avea effect model.infer, dar executarea lui este brokered către Ilaria.

### Nu pune scheduler durabil în Ilaria

Ilaria produce plan / next action. SwypikOS deține task state, retry, lease și recovery.

### Nu păstra două generatoare cognitive

Organism nu trebuie să devină al doilea chatbot paralel cu BitNet Runner.

Extrage din Organism elementele valoroase:

- Hippocampus;
- SemanticMemory;
- retrieval scoring;
- persistence;
- consolidation concepts.

Expune-le ca MemoryProvider / RetrievalProvider consumat de singurul inference runtime.

### Nu lăsa Swyp să facă host syscalls direct

Swyp runtime emite EffectRequest; OS broker execută/refuză.

### Nu continua bridge/nexus legacy ca integrare principală

bridge/nexus implementează vechiul cortex.Tool și documentația spune că nu este registered.

Integrarea modernă trebuie să folosească un Tool ABI versionat compatibil cu Runner + SwypikOS, nu două tool registries divergente.

---

# 19. TOOL ABI COMUN

Înlocuiește gradual contractele ad-hoc cu un envelope versionat.

## 19.1 Tool descriptor

~~~json
{
  "version": 1,
  "tool_id": "swyp.verify",
  "input_schema_sha256": "...",
  "output_schema_sha256": "...",
  "effects": [],
  "required_capabilities": [],
  "determinism": "deterministic",
  "timeout_ms": 10000,
  "max_input_bytes": 32768,
  "max_output_bytes": 65536
}
~~~

## 19.2 ToolCall

~~~json
{
  "version": 1,
  "episode_id": "ep_...",
  "call_id": "call_...",
  "tool_id": "swyp.verify",
  "arguments": {},
  "capability_refs": [],
  "budget": {
    "wall_ms": 10000
  }
}
~~~

## 19.3 ToolResult

~~~json
{
  "version": 1,
  "call_id": "call_...",
  "status": "ok",
  "result": {},
  "evidence": {
    "tool_build_sha256": "...",
    "result_sha256": "...",
    "started_at_monotonic_ns": 0,
    "duration_ns": 0
  }
}
~~~

Modelul poate continua să vadă o reprezentare textuală compactă. Runtime-ul și dataset-ul trebuie însă să păstreze structura.

---

# 20. BENCHMARK / EVAL PIPELINE M3

Benchmark-ul trebuie să măsoare separat:

1. model;
2. inference runtime;
3. agent/tool policy;
4. memory/RAG;
5. Swyp synthesis/repair;
6. Swyp compiler/runtime;
7. OS integration.

Altfel un improvement de tool routing poate fi raportat greșit ca model intelligence.

## 20.1 Run manifest obligatoriu

Fiecare run produce immutable experiment manifest:

~~~json
{
  "schema": "swypik.eval-run.v1",
  "run_id": "run_...",
  "git_head": "96290fa...",
  "dirty_state_sha256": "...",
  "model": {
    "family": "bitnet-b1.58-2b4t",
    "base_sha256": "...",
    "adapter_sha256": "...",
    "tokenizer_sha256": "..."
  },
  "runtime": {
    "build_sha256": "...",
    "backend": "cpu|cuda",
    "decoder_version": "...",
    "tool_protocol_version": 1
  },
  "generation": {
    "mode": "greedy",
    "temperature": null,
    "top_k": null,
    "top_p": null,
    "seed": null,
    "max_tokens": 0
  },
  "prompt": {
    "system_sha256": "...",
    "template_version": "..."
  },
  "toolset": [
    {"id":"calc","schema_sha256":"..."}
  ],
  "dataset_manifest_sha256": "...",
  "scorer_version": "...",
  "hardware": {},
  "started_at": "...",
  "results_sha256": "..."
}
~~~

## 20.2 Suite A — LM / answer quality

Nu folosi numai evalsuite Standard.

Păstrează Standard ca smoke suite, apoi adaugă:

- general factual holdout;
- Romanian;
- instruction following;
- reasoning cu exact answer;
- abstention/honesty;
- contradiction;
- long context;
- code understanding;
- prompt injection handling.

Scorers:

- exact / normalized exact unde se poate;
- executable checker pentru code;
- deterministic rule checker;
- judge model numai pentru rubrici unde nu există oracle, cu blind pairwise și versioned judge prompt.

## 20.3 Suite B — tool-use

Metrici separate:

- correct tool selection;
- argument exactness;
- unnecessary call rate;
- false call rate;
- invalid tool rate;
- recovery after tool error;
- recovery after counterexample;
- call budget compliance;
- unsafe tool attempt rate;
- final task success;
- calls/task;
- tokens/task;
- p50/p95 latency.

Include adversarial:

- tool description injection;
- malicious tool output;
- stale observation;
- denied capability;
- timeout;
- malformed JSON;
- duplicate result;
- tool result contradicts model prior.

## 20.4 Suite C — Swyp generation

Current 60-task corpus este seed, nu final benchmark.

Țintă minimă înainte de claims:

- sute de tasks;
- multiple structural families;
- split pe algorithm family/template, nu doar task ID;
- hidden constants/domains;
- generated metamorphic variants;
- held-out syntax forms;
- no prompt text overlap;
- no reference source overlap.

Metrici:

- parse@1;
- compile/check@1;
- exhaustive-verify@1;
- exhaustive-verify@k;
- counterexample repair success;
- repair delta;
- rounds to acceptance;
- compile-error distribution;
- semantic counterexample distribution;
- verifier fuel/cases;
- model tokens;
- wall time.

## 20.5 Suite D — compiler/runtime

Pentru Semantic Core/STV2:

- parse latency;
- lower latency;
- Prepare latency;
- execute latency;
- verify latency;
- fuel consumed;
- module bytes;
- peak RSS;
- deterministic replay hash;
- corrupted input rejection;
- fuzz corpus regression.

Benchmark-ul cross-language existent benchmarks/swyp/run.py este util, dar are doar trei workload-uri:

- Mandelbrot640;
- PrimeCount100000;
- Train256x2000.

El este benchmark de scalar native performance, nu benchmark al întregului limbaj.

## 20.6 Suite E — memory / RAG

Când MemoryProvider este integrat:

- retrieval recall@k;
- precision@k;
- MRR/nDCG unde are sens;
- correct-answer delta with/without retrieval;
- stale fact handling;
- temporal update;
- negative memory;
- cross-user isolation;
- adversarial memory injection;
- retrieval latency;
- memory bytes/item;
- persistence/restart correctness.

## 20.7 Suite F — SwypikOS integration

- task success;
- crash recovery time;
- duplicate side-effect rate;
- denied-capability success;
- no-side-effect-after-deny;
- lease expiry recovery;
- idempotency;
- task graph replay;
- verifier/executor separation;
- tool/device failure;
- offline degradation;
- p50/p95 orchestration overhead;
- CPU/RAM/IO/task.

---

# 21. DATASET PROVENANCE — format canonic

Swyp Forge are deja hashes bune, dar M3 are nevoie de un registry general.

## 21.1 Dataset manifest

~~~json
{
  "schema": "swypik.dataset.v1",
  "dataset_id": "swyp-forge-v1",
  "version": 1,
  "content_sha256": "...",
  "created_by_git_head": "...",
  "sources": [
    {
      "source_id": "...",
      "uri_or_name": "...",
      "snapshot_date": "...",
      "license": "...",
      "license_verified": false,
      "raw_sha256": "...",
      "collection_method": "...",
      "allowed_uses": ["training"]
    }
  ],
  "transform_dag": [
    {
      "op": "normalize|filter|dedupe|verify|translate|mutate",
      "version": "...",
      "code_sha256": "...",
      "config_sha256": "...",
      "parents": ["..."]
    }
  ],
  "splits": {
    "train": {"sha256":"...", "rows":0},
    "validation": {"sha256":"...", "rows":0},
    "dev": {"sha256":"...", "rows":0},
    "heldout": {"sha256":"...", "rows":0}
  },
  "split_policy": {
    "group_key": "algorithm_family",
    "seed": "...",
    "frozen": true
  },
  "contamination_checks": [],
  "pii_policy": {},
  "safety_filters": {},
  "known_limitations": []
}
~~~

## 21.2 Ce trebuie schimbat față de cmd/distill

Nicio linie teacher-generated nu intră în canonical training set fără:

- teacher ID + revision;
- provider;
- generation config;
- system/user prompt hash;
- source prompt provenance;
- timestamp;
- raw response hash;
- filter/verifier result;
- license/usage provenance;
- transform lineage.

---

# 22. TOOL-USE TRAJECTORY FORMAT

Current forge/tool_data.py validează protocolul conversațional, dar row-ul este prea subțire pentru audit complet.

Propunere: **swypik.trajectory.v1**.

~~~json
{
  "schema": "swypik.trajectory.v1",
  "trajectory_id": "tr_...",
  "task_id": "swyp.absolute",
  "split": "train",
  "language": "en",

  "artifacts": {
    "git_head": "...",
    "model_sha256": "...",
    "adapter_sha256": "...",
    "tokenizer_sha256": "...",
    "system_prompt_sha256": "...",
    "toolset_sha256": "..."
  },

  "generation_config": {
    "mode": "greedy",
    "max_tokens": 512,
    "seed": null
  },

  "events": [
    {
      "seq": 0,
      "type": "user",
      "content": "..."
    },
    {
      "seq": 1,
      "type": "model_output",
      "content": "CALL swyp: ...",
      "tokens": 0,
      "latency_ms": 0
    },
    {
      "seq": 2,
      "type": "tool_call",
      "call_id": "c1",
      "tool_id": "swyp.verify",
      "arguments_sha256": "...",
      "arguments": {}
    },
    {
      "seq": 3,
      "type": "tool_result",
      "call_id": "c1",
      "status": "counterexample",
      "content": "...",
      "evidence_sha256": "..."
    },
    {
      "seq": 4,
      "type": "model_output",
      "content": "...",
      "tokens": 0,
      "latency_ms": 0
    }
  ],

  "outcome": {
    "status": "success|failure|infra_error",
    "verifier_status": "exhaustive",
    "rounds": 2,
    "task_score": 1.0
  },

  "provenance": {
    "dataset_manifest_sha256": "...",
    "parent_trajectory_ids": []
  },

  "integrity": {
    "canonical_sha256": "..."
  }
}
~~~

### Ce NU se stochează ca necesitate

- hidden model chain-of-thought;
- secrete;
- raw capability tokens;
- private user data ne-redactată.

Pentru training sunt suficiente:

- prompt;
- observable model action;
- tool call;
- tool observation;
- verifier evidence;
- final answer/outcome.

---

# 23. PATH REALIST DE FINE-TUNING / DISTILLATION / RAG / SLM

Nu există o singură metodă „câștigătoare”. Folosiți experiment gates.

## Stage 0 — Freeze truth

Înainte de training nou:

- model + adapter hashes;
- canonical eval;
- trajectory schema;
- dataset registry;
- scorer versions;
- holdout freeze.

## Stage 1 — RAG / memory înainte de weight updates pentru knowledge mutabil

Pentru:

- project state;
- docs;
- user/workspace knowledge;
- recent facts;
- tool outputs.

Folosiți retrieval, nu fine-tuning.

Motiv arhitectural:

- update rapid;
- delete/forget posibil;
- provenance;
- access control;
- no retrain;
- no stale weights.

Extract Organism memory ca MemoryProvider, dar reevaluați retrieval algorithm independent.

## Stage 2 — LoRA SFT pentru behavior stabil

Candidați buni pentru weights:

- CALL syntax;
- tool selection;
- structured output;
- Swyp syntax;
- compile-error repair;
- counterexample repair;
- refusal/abstention pattern;
- concise answer style.

Current train_tools.py este bază suficientă.

Prioritate dataset:

1. verified real trajectories;
2. verifier-generated repair pairs;
3. syntax repair;
4. deterministic synthetic tasks;
5. teacher-generated rows numai cu provenance + verification.

## Stage 3 — Distillation

Distillation este utilă doar când teacher output poate fi controlat.

Pentru code/tool tasks:

- teacher proposes;
- local compiler/verifier/tool decides;
- only successful observable trajectories enter SFT.

Pentru factual/open-ended:

- teacher response trebuie să păstreze source provenance;
- RAG-grounded source set frozen;
- evaluator separat.

Nu antrena pe „teacher said so”.

## Stage 4 — Preference / outcome optimization

Doar după suficient real outcome data.

Pair construction:

- same task;
- same base context;
- accepted vs rejected;
- verifier evidence;
- no leakage from heldout.

Se poate evalua DPO/ORPO/RL-style ulterior, dar nu există motiv să fie P0 înainte de SFT baseline solid.

## Stage 5 — SLM strategy

BitNet 2B4T este deja în zona small/local model.

Nu porni pretraining from scratch pentru „own model” ca obiectiv de branding.

Benchmark candidate roles:

- 2B planner/general local agent;
- foarte mic router/tool selector;
- specialized Swyp repair adapter;
- embedding/retrieval model separat.

Un SLM de routing poate merita dacă reduce tokens/latency fără task regression. Asta trebuie demonstrat, nu presupus.

## Stage 6 — Dense Ilaria research

MiniTransformer / Ilaria-130M rămâne track de research.

Nu îl pune în critical path SwypikOS până nu depășește baseline BitNet pe workload-urile target cu aceeași evaluare.

---

# 24. PROMOTION GATES

Niciun adapter/checkpoint nu devine default doar pentru că validation loss scade.

## Gate model

Candidate trebuie să aibă:

- same frozen eval;
- same runtime version;
- same tools;
- same scorer;
- same generation config.

Promotion dacă:

- target suite se îmbunătățește semnificativ sau atinge pragul;
- nicio critical suite nu regresează peste budget;
- tool false-call rate nu crește;
- safety/capability tests nu regresează;
- p95 latency/RAM rămân în budget;
- artifact provenance complet;
- rerun independent reproduce rezultatul.

Project-v6, documentat ca nepromovat din cauza regresiunilor, este exact comportamentul corect de governance.

---

# 25. EVAL STATISTICS

Pentru suites mici nu raporta procente ca adevăr general.

Folosiți:

- raw counts;
- Wilson interval pentru binary success;
- bootstrap CI pentru delta;
- paired bootstrap sau McNemar când aceleași tasks rulează before/after;
- median + p95 pentru latency;
- repetitions interleaved/randomized pentru perf;
- hardware/runtime hash.

Swyp 6/20 este „6 successes din 20 held-out tasks”, nu „30% general coding capability”.

---

# 26. OBSERVABILITY

Un trace ID trebuie să traverseze:

~~~text
SwypikOS task
 → Ilaria turn
 → model generation
 → tool call
 → Swyp verifier
 → effect broker
 → final result
~~~

Minimal IDs:

- task_id;
- lease_id;
- episode_id;
- model_call_id;
- tool_call_id;
- effect_id;
- verifier_run_id;
- artifact_id.

Fiecare event are:

- monotonic timestamp;
- parent span;
- input/output hash;
- status;
- resource usage;
- capability reference ID, nu tokenul secret.

---

# 27. DOC DRIFT IDENTIFICAT

## 27.1 evalsuite

HARDCODING_AND_LIMITATIONS.md: scorer v1 bug „TODO”.  
Live code: ScorerVersion = 2 și fixurile sunt implementate.

**Action:** actualizează doc și păstrează istoria v1 ca historical note.

## 27.2 Swyp language semantics

SWYP_LANG.md descrie legacy number=float64 și „no integer type yet”.  
SEMANTIC_CORE.md / code au i64/f64/bool în ParseCore.

**Action:** documentația principală trebuie să distingă explicit Legacy Frontend vs Semantic Core și să declare ce este canonical.

## 27.3 bridge/nexus

ARCHITECTURE/bridge docs vorbesc despre vechiul cortex.Tool adapter neînregistrat.  
Root cortex are deja modern SwypJudgeChatTool pentru Runner.

**Action:** marchează bridge/nexus ca compatibility/legacy; documentează modern integration.

## 27.4 Natural-language Swyp docs

SWYP_LANG.md spune live Ilaria generation neverified într-o sesiune veche.  
ILARIA_LOOP.md documentează ulterior live model→Swyp runs.

**Action:** mută session-specific statements în history și păstrează current status într-un singur CURRENT_STATUS.md generat/actualizat controlat.

---

# 28. P0 / P1 / P2 RECOMANDAT

## P0 — înainte de refactor mare

1. ADR: Ilaria runtime authority = BitNet runtime unic.
2. ADR: Organism memory se extrage ca MemoryProvider, nu generator paralel.
3. ADR: Core IR este semantic authority Swyp.
4. Definește Tool ABI v1.
5. Definește Capability/Effect IR v1.
6. Definește trajectory v1.
7. Definește dataset manifest v1.
8. Definește eval-run manifest v1.
9. Repară evalsuite task invalid reason_syllogism.
10. Curăță doc drift.
11. Freeze actual 60 Swyp tasks ca seed benchmark, fără să fie „final holdout”.
12. Creează broad heldout separat înainte de următorul fine-tune.

## P1 — executable integration

1. MemoryProvider pentru BitNet Runner.
2. SwypikOS → Ilaria AgentTurn typed API.
3. SwypikOS capability broker.
4. Swyp EffectRequest / EffectResult.
5. first-class trace IDs.
6. Swyp task/evidence value types.
7. loop invariants + effect contracts.
8. larger Swyp generation benchmark.
9. LoRA SFT din trajectories v1.
10. promotion gate automat.

## P2 — după baseline solid

1. SMT backend Swyp/Pure.
2. module/package graph.
3. incremental compiler.
4. debugger/DAP.
5. FFI C/WASM first.
6. richer data structures.
7. probabilistic effect layer.
8. routing SLM.
9. preference/outcome optimization.
10. compute scaling numai dacă marginal gain justifică.

---

# 29. CE ESTE REALMENTE FUNCȚIONAL — MATRICE FINALĂ

| Componentă | Implemented | Wired în runtime relevant | Validated / evidence | Verdict |
|---|---:|---:|---:|---|
| BitNet Go model/runtime | da | da | tests/baseline M0; real weights nu rerulate în acest audit | REAL |
| NXTF v3 loader | da | da | strict loader + tests baseline | REAL |
| LoRA loading | da | da | runtime + training pipeline | REAL |
| ilaria-serve | da | da | handler/security baseline | REAL |
| Runner/KV/tool-loop | da | da | tests baseline | REAL mechanism |
| calc/time/convert | da | da | direct | REAL |
| read_file | da | optional | path/root bounded | REAL optional |
| go_run sandbox | nu | disabled implicit | fail-closed | NO real OS sandbox |
| go_run trusted host | da | opt-in | explicit unsafe boundary | REAL but unsafe by design |
| SwypJudgeChatTool | da | optional | loop + live docs | REAL mechanism |
| ilaria-swyp propose/verify | da | da | live 20 heldout: 6 verified | PROTOTYPE capability |
| repair after CE | da loop | da | 0/14 repair în heldout report | NOT effective yet |
| Organism cognitive pipeline | da | research CLI | tests/baseline | PROTOTYPE |
| Hippocampus persistence | da | Organism | continual test baseline | PROTOTYPE but functional |
| SemanticMemory | da | Organism | tests | PROTOTYPE |
| Organism→MiniTransformer bridge | da | Organism | tests | PROTOTYPE |
| Organism memory in BitNet serve | nu | nu | search confirms no wiring | ABSENT |
| MiniTransformer online self-train | da | Organism | code/tests | PROTOTYPE |
| BitNet online self-train from memory | nu | nu | no wiring | ABSENT |
| BitNet LoRA SFT | da | offline training | train_tools pipeline | REAL experiment |
| canonical provenance registry | nu | partial per-campaign | manifests inconsistent | GAP |
| Swyp parser/checker | da | da | baseline tests | REAL |
| Semantic Core IR | da | da | tests/fuzz evidence docs + baseline | REAL |
| Core executor | da | da | bounded/pure | REAL |
| contracts/verifier | da | da | bounded finite/sampled | REAL, not formal proof |
| synthesis | da | da | bounded | REAL |
| STV2/SWYPB | da | da | deterministic bounded | REAL |
| Swyp effects | field only | rejected if nonempty | explicit v1 restriction | PLACEHOLDER |
| Swyp capabilities | nu | nu | — | ABSENT |
| Swyp task primitives | nu | nu | — | ABSENT |
| Swyp probabilistic ops | nu | nu | — | ABSENT |
| Swyp FFI | nu | nu | C emitter is not FFI | GAP |
| Swyp debugger | nu | nu | diagnostics only | GAP |
| incremental compiler | nu | nu | — | ABSENT |
| formal proof | nu | nu | verifier explicitly not SMT | ABSENT |
| formalizable pure subset seed | da | da | Core structure | STRONG SEED |

---

# 30. CLAIMS — ce putem și ce nu putem spune

## Putem spune

- Ilaria are un runtime BitNet local real în Go.
- Ilaria are agent tool-use real ca mecanism.
- Ilaria poate încărca LoRA adapters.
- Ilaria și Swyp au un closed loop real propose→verify.
- Swyp poate detecta counterexamples și refuza candidate greșite.
- Swyp Semantic Core este determinist, bounded și fără host effects.
- Swyp contracts fac bounded verification, inclusiv exhaustive finite-domain execution.
- Swyp Forge produce verified repair training rows cu hashes.
- LoRA SFT pipeline există și are resume/provenance parțială.
- Organism are memory subsystems reale ca implementare.

## Nu putem spune încă

- Ilaria este un singur unified cognitive runtime.
- BitNet headless folosește hippocampal/semantic memory.
- Ilaria repair intelligence este robustă.
- Ilaria are reasoning general demonstrat.
- Swyp este deja AI-native complet.
- Swyp are capability security semantics.
- Swyp verifier produce formal proofs.
- Swyp rulează arbitrar host effects într-un sandbox OS.
- current SFT adapter este superior fără regression suite.
- current heldout 20 tasks reprezintă general coding capability.
- self-evolution din Organism înseamnă online improvement al BitNet product runtime.

---

# 31. RECOMANDARE ARHITECTURALĂ FINALĂ

Nu construi încă un runtime nou.

Consolidează exact aceste trei nuclee:

## Nucleu 1 — SwypikOS Control Plane

- task graph;
- durable state;
- capability authority;
- approvals;
- scheduling;
- crash recovery;
- resource budget;
- event log.

## Nucleu 2 — Ilaria Intelligence Plane

- un singur BitNet inference runtime;
- Runner/Planner;
- MemoryProvider extras;
- tool policy;
- versioned model/adapters;
- no ambient authority.

## Nucleu 3 — Swyp Verification/Execution Plane

- Core IR ca semantic truth;
- contracts;
- verifier;
- deterministic executor;
- STV2/SWYPB;
- explicit effect requests;
- no direct host authority.

Interfața dintre ele trebuie să fie structurată, versionată, hash-uită și replayable.

**Aceasta satisface North Star fără duplicare de runtime: SwypikOS orchestrează, Ilaria decide/propunе, Swyp verifică/execută determinist, iar SwypikOS deține autoritatea asupra efectelor.**

---

# 32. Next executable design artifacts recomandate

Ordine recomandată după acest audit:

1. ADR-ILARIA-RUNTIME-001 — single inference runtime + MemoryProvider.
2. ADR-SWYP-IR-001 — Core IR semantic authority.
3. ADR-SWYP-EFFECTS-001 — effects/capabilities.
4. ADR-SWYP-TASK-001 — task/evidence semantics vs OS scheduler boundary.
5. SPEC-TOOL-ABI-v1.
6. SPEC-TRAJECTORY-v1.
7. SPEC-DATASET-PROVENANCE-v1.
8. SPEC-EVAL-RUN-v1.
9. Benchmark M3 baseline frozen.
10. Abia apoi următorul LoRA/repair experiment.

---

# Appendix A — fișiere și suprafețe inspectate

## Required

- E:\CEO\specs\mission-swypikos-ilaria.md
- E:\CEO\projects\swos\m0\B-ilaria-swyplang-audit.md
- E:\nexus\AGENTS.md
- E:\nexus\swyp\README.md

## Ilaria

- cortex/bitnet.go
- cortex/bitnet_persist.go
- cortex/transformer.go
- cortex/toolloop.go
- cortex/swyp_tool.go
- cortex/swyp_solve.go
- cortex/organism.go
- cortex/cognitive_bridge.go
- cortex/hippocampus.go structural/symbol inventory
- cortex/semantic_memory.go structural/symbol inventory
- cortex/self_training.go
- cortex/provenance.go
- cortex/eval.go
- cortex/evalsuite/score.go
- cortex/evalsuite/suite.go
- cortex/swe/sandbox_executor.go
- cmd/ilaria-serve
- cmd/ilaria-chat
- cmd/ilaria-swyp
- cmd/swyp-forge
- cmd/distill
- cmd/train
- forge/train_ilaria.py
- forge/train_tools.py
- forge/tool_data.py
- forge/distill_cot.py
- selected forge manifests only; nu restricted data/

## Swyp

- internal/coreir
- internal/stv2
- internal/swyplang
- internal/synthesis
- internal/ilaria
- bridge/nexus
- docs/ARCHITECTURE.md
- docs/ROADMAP.md
- docs/SEMANTIC_CORE.md
- docs/SWYP_LANG.md
- docs/CONTRACT_SYNTHESIS.md
- docs/ILARIA_LOOP.md
- docs/DEVELOPMENT.md
- docs/history/NON_LLM_STATUS.md
- docs/history/SWYP_AI_WORKFLOW.md
- examples/swyp/tasks/tasks.jsonl sample + inventory
- benchmarks/swyp/run.py + benchmark inventory
- agent-lab directory inventory only; executables not read

---

# Appendix B — repo state înainte de scriere

E:\nexus:

~~~text
## main...origin/main [ahead 55]
?? .mcp.json
~~~

HEAD observat:

~~~text
96290fa 2026-09-28 Merge agent/nexus-wip-snapshot into agent/unify
~~~

Untracked .mcp.json exista înainte de audit și nu a fost citit sau modificat.

---

# Appendix C — limitările acestui audit

- Nu au fost citite weights/checkpoints din data/.
- Nu au fost inspectate sursele interzise cuda/.
- Nu au fost deschise executabile.
- Nu s-au executat benchmark-uri sau test suites noi.
- Nu s-a auditat live SwypikOS source în această misiune; integrarea propusă folosește North Star și contractele deja documentate, nu pretinde o nouă validare a OS.
- Rezultatele de test citate ca baseline provin din auditul M0 pe același HEAD; acest raport nu le re-etichetează ca rerulate.
- Rezultatele din docs/ILARIA_LOOP.md sunt tratate ca experiment documentat, cu limita de sample size explicită.

---

# DONE

Auditul confirmă o cale tehnică coerentă:

**SwypikOS = authority + orchestration**  
**Ilaria = intelligence + planning + retrieval**  
**Swyp = typed semantics + verification + deterministic execution**

Cel mai important pas următor nu este mai mult cod neural sau un nou compiler. Este să fixați **contractele dintre aceste trei plane** și să transformați provenance/eval/trajectory în infrastructură obligatorie. După aceea, fine-tuning, distillation, RAG și SLM routing pot fi comparate pe aceeași bază măsurabilă, fără claims nevalidate.
