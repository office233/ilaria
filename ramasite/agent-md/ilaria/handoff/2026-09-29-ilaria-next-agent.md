# HANDOFF — ILARIA / IMC / MYRIAD

> UPDATE 2026-09-30: pentru starea cea mai noua a Genesis English-first + Colab/GPU/CLI, citeste obligatoriu `docs/handoff/2026-09-30-imc125-genesis-colab.md` si `docs/handoff/2026-09-30-imc125-genesis-state.json`.

Data: 2026-09-29
Workspace real: E:\nexus
Produs: E:\nexus\ilaria
Branch curent: agent/nexus-clean-swyp-fast
Plan canonic: E:\nexus\ilaria\docs\plans\MASTER_PLAN.md

## 0. REGULA PRINCIPALA

Ilaria are o singura familie de model: IMC (Ilaria MicroCortex).

Modelul este al nostru, antrenat de la zero, din greutati random.

NU reintroduce BitNet, GPT/GPT-2/DistilGPT, Llama/Qwen/Gemma, LoRA ca arhitectura principala, vechiul Cortex/Broca/FractalCortex/RadioCortex, NXTF legacy sau vechile runtime-uri paralele.

Expertii Myriad sunt instante IMC specializate, nu alte arhitecturi.

## 1. TINTA ARHITECTURALA

IMC-1B canonic:
- vocab_size 65,536
- d_model 2,048
- layers 16
- heads 16
- kv_heads 4
- head_dim 128
- ffn_dim 7,104
- context_v1 2,048
- RMSNorm
- RoPE
- GQA
- SwiGLU
- bias-free linear layers
- tied token embedding / LM head
- native ternary projection path
- per-token int8 activation quantization

Parametri exacti: 1,000,555,520.

Cod: ilaria/forge/imc_model.py

Scale ladder:
- IMC-125M = 125,882,112
- IMC-250M = 247,559,168
- IMC-500M = 503,457,280
- IMC-1B = 1,000,555,520

125M/250M/500M sunt scale-test-uri ale aceleiasi arhitecturi.

## 2. CURATENIA EFECTUATA

S-a eliminat din Ilaria stack-ul legacy:
- BitNet runtime / LoRA / importer
- GPT-2 / DistilGPT2
- NXTF legacy
- SigLIP/Whisper vechi legate de modelul precedent
- biomedical stack
- vechiul cortex experimental
- Broca/Wernicke/FractalCortex/RadioCortex/Quantum
- vechiul Organism
- vechile CLI-uri dependente
- rezultate/pipeline-uri legacy relevante

Pe filesystem, vechiul ilaria/cortex nu trebuie restaurat.

ATENTIE: Git status arata multe RD/AD din cauza reorganizarii masive a repo-ului. Asta NU inseamna ca trebuie restaurate fisierele legacy.

Snapshot pre-curatare: E:\nexus-before-imc-cleanup.patch

Nu face git reset --hard, git clean -fd, rebase sau checkout destructiv.

## 3. ILARIALEX-65K

Cod:
- forge/hf_tokenizer.py
- forge/test_hf_tokenizer.py

Contract:
- 0 .. 61,439 = BPE learned vocabulary
- 61,440 .. 65,535 = protocol-reserved IDs
- total = 65,536
- protocol reserve = 4,096
- EOS canonic = <|ilaria:eos|>
- EOS ID canonic = 61,440

Protocol tokens includ role, action, observation, verifier, device, OBD2, CAN, PCI/USB/ACPI, senzori, privacy, PCE si WorldEvent.

Bug reparat: exact 65,536 ID-uri folosesc corect uint16 deoarece ID-urile sunt 0..65,535.

Ultima verificare confirmata: 7/7 teste IlariaLex PASS.

IMPORTANT: tokenizerul final de productie nu a fost inca antrenat/frozen pe corpusul final mare. Codul si contractul sunt gata; trebuie produs artefactul canonic si hash-ul final inainte de Genesis.

## 4. MANIFESTUL MODELULUI

Implementat:
- forge/model_manifest.py
- forge/test_model_manifest.py

Manifestul include model_family, architecture_version, preset, parameter_count, config, tokenizer identity/hash, source hash, config hash si architecture hash.

Ultima verificare: 6/6 teste model-manifest PASS.

## 5. HARDCODING-URI RAMASE

In forge/imc_model.py, ImcConfig are inca eos_token_id: int = 3.

Acesta este un rest de test/legacy si trebuie eliminat.

Directia recomandata:
- eos_token_id devine obligatoriu explicit
- muta-l inainte de campurile cu default in dataclass
- actualizeaza toate instantiarile de test sa transmita explicit EOS
- productia il primeste mereu din IlariaLex/token-stream metadata

Alt code smell:
forge/train_ilaria.py, validate_training_args() contine un if True rezultat din migrarea IMC-only. Curata-l fara schimbarea semanticii trainerului.

## 6. DATA ENGINE EXISTENT — NU DUPLICA

Exista deja:
- forge/data_contract.py
- forge/data_audit.py
- forge/curate_corpus.py
- forge/dataset_manifest.py
- forge/config/data_rights.json
- teste aferente

Flux:
raw manifests -> rights gate -> deterministic dedup -> benchmark contamination exclusion -> deterministic train/validation split -> curated shard hashes -> post-curation audit -> IlariaLex encoding -> token-stream hashes -> immutable dataset manifest

dataset_manifest.py refuza:
- tokenizer identity mixta
- shard modificat
- audit incomplet
- surse cu drepturi neaprobate
- train/validation tampering

Foloseste acest pipeline. Nu crea unul paralel.

## 7. TRAINER IMC

Cod: forge/train_ilaria.py

Are:
- IMC-only
- GQA
- ternary path
- chunked CE
- gradient checkpointing
- AdamW configurabil
- DDP
- exact resume
- train/validation stream compatibility
- content hashes
- dataset-manifest gate pentru productie
- atomic checkpoint/export

Bug reparat anterior:
best_nxtf_sha256 / to_go_json() -> best_export_sha256 / cfg.to_json().

Ultima suita IMC confirmata: 18/18 teste PASS.

## 8. MYRIAD CONTRACT — SWYP

Sursa: ilaria/specs/myriad.swyp

Artefacte generate:
- ilaria/specs/myriad.manifest.json
- ilaria/generated/myriad/types_gen.go

Contractele includ:
- CorticalRequest
- CorticalResponse
- ExpertGenome
- WorldEvent
- ExperienceCapsule
- ReplayExample
- ConnectomeEdge
- SynapseObservation

Experti declarati:
- ThalamusRouter
- GeneralCortex
- CodeCortex
- ReasoningCortex
- DeviceCortex

Ultimul component check dupa ReplayExample: 23 declarations valid.

Swyp Lang este limbajul de contract/verificare/control. Nu rescrie tensor math/PyTorch/CUDA in Swyp acum.

## 9. RUNTIME MYRIAD IMPLEMENTAT IN GO

Package-uri:
- runtime/protocol
- runtime/world
- runtime/pce
- runtime/connectome
- runtime/router
- runtime/integration

protocol:
- Protocol Version 1
- PPM validation
- identifier validation
- SHA256 validation
- privacy classes
- fail-closed transfer

WorldEvent:
- validate
- deterministic hash
- verifier/result contract
- privacy gate

PCE:
- NewFromWorldEvent
- Ed25519 signing
- signature verification
- tamper detection
- provenance requirement
- lineage/ancestry compatibility
- privacy fail-closed
- VerifyForReplay
- ToReplayExample

Connectome:
- verified-only edge updates
- success/failure
- trust PPM
- verified gain
- latency
- compute cost
- configurable routing policy
- deterministic ranking

Router:
- top-K configurabil
- scor din Connectome
- fallback determinist la GeneralCortex

Integration test:
Cell A -> WorldEvent -> signed PCE -> Cell B verifies -> ancestry check -> Connectome strengthens -> Thalamus routes catre expertul invatat.

Ultimul go test ./runtime/... = PASS.

## 10. PCE TRANSFER V1

Path: bench/myriad/pce_transfer_v1

12 skill-uri fictive pentru a evita cunoasterea din pretraining.

V1 a demonstrat semnal cauzal, dar a descoperit problema principala:
la prea mult replay, training loss ajunge aproape zero dar held-out generalization se degradeaza.

Concluzie:
Collective Sleep necesita validation, early stopping, anti-forgetting, equal-compute control si multi-seed.

## 11. PCE TRANSFER V2 — IMPLEMENTAREA CANONICA

Foloseste ca baza:
- forge/collective_sleep.py
- forge/pce_transfer_v2.py
- forge/pce_transfer_v2_gate.py
- forge/test_collective_sleep.py
- forge/test_pce_transfer_v2_data.py
- forge/test_pce_transfer_v2_gate.py
- bench/myriad/pce_transfer_v2/tasks.jsonl
- bench/myriad/pce_transfer_v2/anchors.jsonl

Varianta are:
- train/validation/test distinct
- 12 new skills
- 8 anchor skills preexistente
- equal-compute mismatched control
- anchor replay
- early stopping
- best-checkpoint restore
- formal multi-seed promotion gate
- multi-view validation natural paraphrase + skill_key

## 12. COLIZIUNE IMPORTANTĂ SI REPARATIE

tasks.jsonl a fost suprascris accidental de un experiment paralel fara skill_key.

Schema a fost reparata si au fost adaugate skill_key-uri deterministe:
- MYR-ZXQ-731
- MYR-RKM-204
- MYR-NX17-S4
- MYR-Q2-K7
- MYR-SWX-441
- MYR-LNK-ION-88
- MYR-RHO-KAPPA
- MYR-DELTA-ZORIN
- MYR-HELIX-MINT
- MYR-MYRA-Q9
- MYR-LUMEN-FROST
- MYR-SORA-PIVOT62

Dupa reparare:
test_pce_transfer_v2_data.py = 3 PASS.

Cele 4 seed-uri canonice 7,11,19,23 au fost rerulate de la zero, iar result-seed*.json au fost regenerate.

## 13. STAREA ACTUALA CRITICA — PCE V2 GATE = FAIL

NU considera vechiul bench/myriad/pce_transfer_v2/RESULTS.md adevar curent.

Acel document descrie un run anterior care trecea gate-ul.

Rezultatele actuale, dupa rerularea curenta:

Seed 11:
- transfer top1 8.33%
- control top1 16.67%
- accuracy advantage -8.33 pp
- NLL advantage -1.1202
- anchor delta 0
- best step 240
- early stop false

Seed 19:
- transfer top1 8.33%
- control top1 0%
- accuracy advantage +8.33 pp
- NLL advantage +1.3395
- anchor delta 0
- best step 240
- early stop false

Seed 23:
- transfer top1 25%
- control top1 16.67%
- accuracy advantage +8.33 pp
- NLL advantage -0.4856
- anchor delta 0
- best step 260
- early stop false

Seed 7:
- transfer top1 75%
- control top1 8.33%
- accuracy advantage +66.67 pp
- NLL advantage +3.6943
- anchor delta 0
- best step 260
- early stop false

Aggregate actual:
- mean NLL advantage +0.8570
- positive NLL seeds 2/4
- mean top1 advantage +18.75 pp
- positive top1 seeds 3/4
- known anchor drop 0 pp in toate seed-urile
- early stopping 0/4

Gate FAIL checks:
- positive_nll_fraction
- no_negative_accuracy_advantage
- all_early_stopped

Gate PASS checks:
- seed_count
- positive_accuracy_fraction
- known_anchor_retention
- mean_nll_advantage

NU modifica pragurile gate-ului ca sa treaca. Algoritmul trebuie imbunatatit.

## 14. PROTOTIP PARALEL — DE CONSOLIDAT, NU PASTRAT DUBLU

Exista forge/collective_sleep_experiment.py plus regression.jsonl si rezultate aug-seed*/seed* necanonice.

Prototipul a testat:
- frozen teacher distillation
- KL anti-forgetting
- prompt replay augmentation
- state-only replay
- NLL-first checkpoint selection

Rezultat experimental dupa prompt augmentation:
- positive NLL advantage 4/4
- mean NLL advantage +0.7668
- positive top1 3/4
- mean top1 advantage +18.75 pp

Nu mentine doua controllers de Collective Sleep.

Ce trebuie facut:
1. porteaza in collective_sleep.py / pce_transfer_v2.py doar ideile utile
2. state-only replay
3. 2-3 template-uri deterministe de replay augmentation
4. NLL-first candidate selection
5. optional frozen-teacher KL regression gate
6. pastreaza anchor gate existent
7. apoi sterge collective_sleep_experiment.py si rezultatele necanonice

## 15. PCE V2 NU FOLOSESTE INCA PCE-UL SEMNAT REAL END-TO-END

Runtime-ul Go are PCE real semnat Ed25519.

Dar forge/pce_transfer_v2.py foloseste inca direct dataset synthetic/skill mappings.

Urmatorul gate real trebuie sa consume ReplayExample provenit din capsule semnate:

WorldEvent -> Go pce.NewFromWorldEvent -> Sign Ed25519 -> VerifyForReplay -> ToReplayExample -> JSONL/content-addressed replay artifact -> Python Collective Sleep -> candidate checkpoint

Python nu trebuie sa poata inventa experiente global-trusted fara provenance/verifier.

## 16. ORDINE EXACTA DE EXECUTIE

P0 — Stabilizare PCE v2:
1. Nu modifica test set sau gate thresholds.
2. Integreaza state-only replay in pce_transfer_v2.py.
3. Adauga deterministic replay prompt augmentation.
4. Adauga NLL-first validation selection.
5. Adauga frozen-teacher KL ca bariera suplimentara anti-forgetting daca ajuta.
6. Reruleaza seeds 7,11,19,23.
7. Ruleaza pce_transfer_v2_gate.py.
8. Gate trebuie sa treaca cu pragurile curente.
9. Actualizeaza RESULTS.md numai dupa PASS reproducibil.
10. Leaga RESULTS de hash-ul datasetului ca sa nu mai existe raport stale.

P1 — Curatare hardcodings:
1. elimina default eos_token_id=3 din ImcConfig
2. EOS obligatoriu explicit
3. actualizeaza testele tiny
4. elimina if True din train_ilaria.validate_training_args
5. cauta orice productie care presupune implicit EOS=3
6. ruleaza toate testele

P2 — Signed PCE -> Replay artifact:
1. defineste format canonic ilaria-pce-replay-v1
2. include capsule hash, ancestry, verifier evidence hash, privacy class, replay prompt/target, source expert, signature/verifier metadata
3. genereaza artefactul din Go dupa VerifyForReplay
4. Python Forge citeste doar replay artifacts validate
5. teste tampering, ancestry gresit, LOCAL_PRIVATE, signer gresit
6. PCE v2 ruleaza prin aceasta cale

P3 — Final IlariaLex artifact:
1. corpus curated/rights-gated
2. sample reprezentativ EN/RO/code/math/hardware/tool trajectories/protocol
3. train 61,440 BPE + 4,096 protocol
4. freeze tokenizer.json
5. produce SHA256
6. token IDs immutable dupa Genesis

P4 — Data pipeline production:
- rights approved
- zero duplicates
- zero benchmark contamination
- immutable train/validation
- valid dataset manifest

P5 — IMC-125M:
- aproximativ 1B tokens
- ternary vs full-precision control
- frozen validation
- checkpoint/resume
- general/code/math/RO/calibration
- PCE Transfer v2 pe checkpoint pretrained real
- anti-forgetting

Nu trece la 250M pana cand 125M nu este stabil.

P6 — Scale:
- 250M -> aproximativ 5B tokens
- 500M -> 10-20B
- 1B bootstrap -> aproximativ 20B
- 1B production -> 100B+

P7 — Myriad 4+1:
- GeneralCortex
- CodeCortex
- ReasoningCortex
- DeviceCortex
- ThalamusRouter

Metric: NetworkGain = routed Myriad - best single expert la acelasi compute budget.

## 17. DEVICE LEARNING — DIRECTIE

PC / phone / OBD-II / CAN / drivers / hardware / robotics.

Flux:
device/sensor -> WorldEvent -> privacy filter -> local IMC -> action/hypothesis -> measured result -> verifier -> PCE -> local sleep -> verified global transfer

Automotive/hardware incepe read-only/simulation/HIL. Nu trial-and-error safety critical pe masina reala.

## 18. ISX / MILLION-NODE MYRIAD

Tinta:
1,000,000 devices x 1 resident IMC-1B = 1,000,000 situated IMC cells.

Nu este un model dens de 10^15 parametri.

Scale vine din specializare, routing, local experience, memory, verified transfer si distributed compute.

## 19. SWYP LANG — DECIZIE

Nu rescrie tot proiectul in Swyp Lang acum.

Swyp = schema/control/contracts/capabilities/effects/verifier/plans/model manifests/PCE/World/ISX.

PyTorch/CUDA/Rust/Go raman corecte pentru training si hot paths in etapa curenta.

## 20. TESTE CONFIRMATE

Confirmate in aceasta sesiune:
- IMC: 18 passed
- IlariaLex: 7 passed
- model manifest: 6 passed
- go test ./runtime/...: PASS
- go test ./... Ilaria: PASS
- go vet ./... Ilaria: PASS
- PCE v2 data dupa repair: 3 passed
- PCE v2 current promotion gate: FAIL, blocker actual

Unele suite combinate au fost refuzate de resource admission din cauza CPU 100% provocat de alte task-uri paralele. Resource admission nu este test failure.

## 21. WORKSPACE / CONCURRENCY WARNING

Repo-ul este foarte dirty si exista mai multe workstreams paralele.

Branch: agent/nexus-clean-swyp-fast

Ultimul git status avea aproximativ 842 files changed la nivel Nexus.

NU FACE:
- git reset --hard
- git clean -fd
- rebase
- checkout global
- restore masiv
- rewind global al checkpoint-urilor Bridge

Lucreaza surgical.

## 22. FISIERE DE CITIT PRIMELE

1. E:\nexus\AGENTS.md
2. E:\nexus\ilaria\AGENTS.md
3. E:\nexus\ilaria\docs\plans\MASTER_PLAN.md
4. E:\nexus\ilaria\README.md
5. E:\nexus\ilaria\forge\imc_model.py
6. E:\nexus\ilaria\forge\train_ilaria.py
7. E:\nexus\ilaria\forge\hf_tokenizer.py
8. E:\nexus\ilaria\specs\myriad.swyp
9. E:\nexus\ilaria\runtime\pce\capsule.go
10. E:\nexus\ilaria\runtime\connectome\connectome.go
11. E:\nexus\ilaria\runtime\router\router.go
12. E:\nexus\ilaria\forge\collective_sleep.py
13. E:\nexus\ilaria\forge\pce_transfer_v2.py
14. E:\nexus\ilaria\forge\pce_transfer_v2_gate.py
15. E:\nexus\ilaria\bench\myriad\pce_transfer_v2\README.md
16. result-seed*.json curente

## 23. PROMPT DE START PENTRU URMATORUL AGENT

Lucrezi in E:\nexus\ilaria. Citeste root/ilaria AGENTS, docs/plans/MASTER_PLAN.md si handoff-ul. Nu restaura BitNet/cortex legacy. IMC este modelul unic from-scratch. Repo-ul este foarte dirty si alte workstreams modifica Swyp/SwypikOS, deci nu folosi git reset/clean/rebase.

Primul blocker este PCE Transfer v2. Cele 4 result-seed*.json au fost regenerate pe datasetul curent, iar gate-ul canonic FAILS: positive NLL doar 2/4, seed 11 are accuracy advantage negativ si niciun seed nu early-stop. Nu schimba pragurile gate-ului si nu folosi test set la selectie.

Canonicalizeaza doar collective_sleep.py + pce_transfer_v2.py. Integreaza state-only replay, deterministic prompt augmentation, NLL-first validation selection si, daca ajuta, frozen-teacher KL anti-forgetting, pastrand anchor replay/gate. Elimina apoi prototipul duplicat collective_sleep_experiment.py.

Reruleaza seeds 7,11,19,23 si cere PASS cu pce_transfer_v2_gate.py. Actualizeaza RESULTS.md numai dupa reproducerea PASS.

Apoi elimina hardcoding-ul eos_token_id=3 din ImcConfig si if True din train_ilaria.py, ruleaza toate testele, apoi construieste calea signed ExperienceCapsule -> ReplayExample artifact -> Python Collective Sleep. Dupa aceea freeze IlariaLex-65K si pregateste IMC-125M.

Lucreaza OBSERVE -> REASON -> ACT -> VERIFY. Nu supra-vinde rezultatele; pastreaza experimentele esuate ca evidence.

## 24. DEFINITION OF DONE PENTRU URMATORUL MILESTONE

Milestone-ul este inchis numai cand:
1. exista un singur Collective Sleep canonic
2. PCE v2 dataset este reproductibil si hash-uit
3. 4 seed-uri trec gate-ul existent fara relaxarea pragurilor
4. anchor retention ramane in buget
5. early stopping functioneaza
6. RESULTS.md este regenerat din rezultatele curente
7. signed PCE produce replay artifact consumat de Forge
8. eos_token_id=3 implicit a disparut
9. toate testele IMC/IlariaLex/PCE/Go/vet trec
10. git diff --check -- ilaria este verde

Abia dupa asta: freeze tokenizer final + IMC-125M.
