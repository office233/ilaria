# Cercetare: memorie ca un creier + gândire dincolo de predicție (2016–2026)

**Pentru**: Ilaria (Nexus) — decizia „calea B": creierul se forjează în PyTorch, organismul rămâne în Go.
**Metodă**: 12 căutări web + verificare pe surse primare (abstracte arXiv, blogul ARC Prize, fișa
HuggingFace, Nature Communications). Cifrele marcate ✅ sunt citate din sursa primară; cele marcate
⚠️ vin din rezumate terțe sau comunicate de presă și NU au fost verificate.

---

## Partea 1 — Memorie „ca un creier sau mai bună"

### 1.1 Sisteme de învățare complementare (hipocamp ↔ neocortex, replay, somn) — dovezi PUTERNICE

| Lucrare | Ce s-a demonstrat | Cod |
|---|---|---|
| Kirkpatrick et al., *EWC*, PNAS 2017 | Un DQN învață 10 jocuri Atari secvențial fără uitare catastrofală (dar sub scorul a 10 rețele separate) | da |
| Tadros, Krishnan, Ramyaa, Bazhenov, *Nature Communications* 2022 ✅ | Somn = antrenare offline cu plasticitate Hebbiană locală + zgomot; „sleep was able to recover old tasks that were otherwise forgotten"; bate EWC și SI la class-incremental (⚠️ OWM îl depășește ușor) | da |
| Singh, Norman, Schapiro, PNAS 2022 | Alternanța NREM/REM (replay recent vs. vechi) permite învățare continuă grațioasă, complet autonom în timpul „somnului" | — |
| „Continual learning benefits from multiple sleep mechanisms", arXiv 2209.05245 | NREM veridic + REM generativ + downscaling sinaptic, toate trei ajută pe CIFAR-100 incremental; trade-off la downscaling | — |
| Wake-Sleep Consolidated Learning, arXiv 2401.08623 (2024) | Faze wake/NREM/REM pentru DNN-uri de clasificare vizuală în continual learning | — |

**Ce înseamnă pentru Ilaria**: scheletul e deja corect (`Hippocampus` → `Sleep()` → `Generalize`).
Ce lipsește e exact ce demonstrează literatura: **în somn, memoriile episodice trebuie REDATE ca
date de antrenare cu gradienți reali** în creierul parametric (la noi: fine-tuning/LoRA pe
transformer din episoadele hipocampului). Asta transformă memoria din „citită în context" în
„cunoaștere consolidată". Evidență: 4 laboratoare independente, 2017–2024.

Surse: [Tadros 2022](https://www.nature.com/articles/s41467-022-34938-7) ·
[Singh 2022](https://www.pnas.org/doi/10.1073/pnas.2123432119) ·
[EWC 2017](https://www.pnas.org/doi/10.1073/pnas.1611835114) ·
[2209.05245](https://arxiv.org/abs/2209.05245) · [WSCL](https://arxiv.org/pdf/2401.08623)

### 1.2 Memorie episodică pentru agenți LLM (MemGPT/Letta, Mem0, Zep, A-MEM) — dovezi MEDII, scoruri disputate

- **Mem0** (ECAI 2025, arXiv 2504.19413) ✅: „26% relative improvements in the LLM-as-a-Judge
  metric over OpenAI" pe LoCoMo; ⚠️ ~1.764 tokeni/conversație vs 26.031 full-context, p95 0,2s.
- **Letta (MemGPT)**, aug. 2025 ⚠️: 74% LoCoMo doar cu fișiere + căutare iterativă a agentului —
  concluzia lor: *cum gestionează agentul contextul contează mai mult decât mecanismul de retrieval*.
- **Zep** contestă cifrele Mem0 (75,1% recalculat; 71,2% LongMemEval în arXiv 2501.13956) ⚠️.
- **2026**: toți vânzătorii raportează 90%+ pe LoCoMo — **necomparabile** (modele, judecători și
  protocoale diferite); singura măsurătoare independentă găsită pune Mem0 la 49% pe LongMemEval.

**Ce înseamnă pentru Ilaria**: abordarea noastră (memorie episodică externă → context) e exact
tiparul SOTA; rezultatul nostru de 96% pe fapte inventate e consistent cu domeniul. Lecția Letta:
dă-i Ilariei **unelte de memorie ca acțiuni** (caută, recitește, decide ce reține), nu doar un
bias unic la fiecare pas.

Surse: [Mem0](https://arxiv.org/abs/2504.19413) · [Letta](https://www.letta.com/blog/benchmarking-ai-agent-memory/) ·
[Zep rebuttal](https://blog.getzep.com/lies-damn-lies-statistics-is-mem0-really-sota-in-agent-memory/) ·
[Mem0 2026 guide](https://mem0.ai/blog/ai-memory-benchmarks-in-2026)

### 1.3 Memorie ÎN rețea: Titans, Memory Layers, TTT, Hopfield modern — dovezi PUTERNICE (la scară mare)

- **Memory Layers at Scale** (Meta FAIR, ICML 2025, arXiv 2412.09764) ✅: „language models augmented
  with our improved memory layer outperform dense models with more than twice the computation budget";
  scalare până la 128B parametri de memorie, 1T tokeni; câștiguri mai ales pe fapte. Cod: github.com/facebookresearch/memory.
- **Titans** (Google, NeurIPS 2025, arXiv 2501.00663) ✅: memorie neurală pe termen lung antrenată la
  test-time; „more effective than Transformers and recent modern linear recurrent models"; ⚠️ >2M
  context la needle-in-haystack (varianta NeurIPS a abstractului e mai prudentă).
- **TTT** (Sun et al. 2024, arXiv 2407.04620, ICML 2025) ⚠️: starea ascunsă e ea însăși un model
  antrenat pe secvența de test; la 125M–1,3B egalează/depășește Transformer și Mamba, avantaj crescând cu contextul.
- **Hopfield modern** (Ramsauer 2020): capacitate exponențială, update = atenția Transformer;
  ⚠️ lucrări din 2024–25 arată fragilitate pe date reale.

**Ce înseamnă pentru Ilaria**: **Memory Layers e cea mai practică idee pentru 6GB** — parametri de
„cunoaștere" într-un tabel cheie-valoare care NU costă FLOPs și poate sta în RAM/NVMe. E exact planul
nostru NTX1/expert-atlas, dar cu dovadă la scară. TTT-Linear e antrenabil la 125M — fezabil.

Surse: [Memory Layers](https://arxiv.org/abs/2412.09764) · [Titans](https://arxiv.org/abs/2501.00663) ·
[TTT](https://arxiv.org/abs/2407.04620) · [Hopfield](https://www.semanticscholar.org/paper/804a6d7c23335bbca6eec3b7d3c8366dcbe395a5)

### 1.4 Reprezentări „cerebrale": Thousand Brains (Monty), SDM/HDC, HTM — dovezi PUTERNICE pe obiecte 3D, ZERO pe limbaj

- **Monty** (Thousand Brains Project, arXiv 2507.04494, *Neural Computation* 2026) ✅: recunoaștere +
  poză pe 77 obiecte YCB prin învățare senzorimotorie, învățare rapidă/continuă, votare între coloane;
  ⚠️ 98,6% acuratețe curată, 95,1% cu zgomot, 73,1% fără culoare (cifre din rezumate). MIT license,
  non-profit independent, finanțat parțial de Gates Foundation.
- **SDM ≈ atenție** (Bricken & Pehlevan 2021): atenția Transformer aproximează memoria distribuită rară a lui Kanerva.
- **HDC**: benchmark-uri reproductibile pe 121 seturi UCI (Torchhd); hardware memristiv 95% pe identificare de limbă.
- **HTM/NAB**: scorul ~70 e din 2016–17; LSTM/Informer au F1 mai mare; Wu & Keogh arată că NAB e defect.

**Ce înseamnă pentru Ilaria**: SDR-urile sunt un substrat bun pentru **indexare asociativă robustă**
(hipocampul nostru merge). Dar **nu există nicio demonstrație de inteligență lingvistică din SDR/HTM**.
Păstrăm SDR pentru memorie; nu așteptăm gândire de la ele.

Surse: [Monty](https://arxiv.org/abs/2507.04494) · [tbp.monty](https://github.com/thousandbrainsproject/tbp.monty) ·
[SDM≈attention](https://arxiv.org/abs/2111.05498) · [NAB critique](https://arxiv.org/abs/2009.13807)

---

## Partea 2 — Sisteme care „gândesc", nu doar prezic

### 2.1 HRM și TRM — modele minuscule care rezolvă puzzle-uri — dovezi PUTERNICE, cu o lecție surprinzătoare

- **HRM** (Sapient, arXiv 2506.21734) ✅: 27M parametri, 1000 exemple, fără pre-antrenare; abstractul
  revendică „nearly perfect" pe Sudoku/labirint și ~40% ARC-AGI-1.
- **Verificarea ARC Prize** ✅ (arcprize.org/blog/hrm-analysis): **32% ARC-AGI-1 semi-privat, 2%
  ARC-AGI-2**; „the hierarchical architecture had minimal performance impact when compared to a
  similarly sized transformer"; „the under-documented outer loop refinement process drove substantial
  performance"; doar 300 augmentări sunt necesare; transfer între sarcini limitat — performanța vine
  din memorarea sarcinilor de evaluare.
- **TRM** (Samsung SAIL, arXiv 2510.04871) ✅: „With only 7M parameters, TRM obtains 45% test-accuracy
  on ARC-AGI-1 and 8% on ARC-AGI-2"; o singură rețea de 2 straturi; backprop complet prin recursie
  (⚠️ 56,5% → 87,4% pe Sudoku-Extreme); ⚠️ antrenare 4×H100 × 48h; critică: augmentare 1000×.

**Ce înseamnă pentru Ilaria**: lecția transferabilă NU e „arhitectura biologică" (ARC Prize a arătat
că nu ea contează), ci **bucla de rafinare iterativă cu decizie de oprire**: propune un răspuns,
întreabă „am terminat?", rafinează. E implementabilă la 7M parametri (încape lejer pe 6GB) — ca modul
de raționament pentru sarcini structurate, nu ca model de limbaj.

Surse: [HRM](https://arxiv.org/abs/2506.21734) · [ARC Prize analysis](https://arcprize.org/blog/hrm-analysis) ·
[ablation repo](https://github.com/arcprize/hierarchical-reasoning-model-analysis) ·
[TRM](https://arxiv.org/abs/2510.04871) · [TRM code](https://github.com/SamsungSAILMontreal/TinyRecursiveModels)

### 2.2 Gândire în spațiu latent: recurență în adâncime și Coconut — dovezi PUTERNICE la scară mare, MIXTE la scară mică

- **Geiping et al.** (NeurIPS 2025, arXiv 2502.05171) ✅: un bloc recurent iterat la adâncime arbitrară
  la test-time; 3,5B parametri, 800B tokeni; „improve its performance on reasoning benchmarks, sometimes
  dramatically, up to a computation load equivalent to 50 billion parameters"; fără date CoT speciale.
  Cod + model publice.
- **Coconut** (Meta, arXiv 2412.06769) ⚠️: fine-tuning pe **GPT-2 124M** (scara noastră!); ProsQA 97,0%
  vs 77,5% CoT cu de 3× mai puțini tokeni; **dar GSM8k 34,1% vs 42,9%** — gândirea latentă pierde la
  matematică, câștigă la planificare/căutare în grafuri (BFS emergent).
- Retrofitarea recurenței pe modele pre-antrenate există (arXiv 2511.07384).

**Ce înseamnă pentru Ilaria**: „gândește mai mult fără parametri în plus" e fezabil pe 6GB — buclăm
blocurile transformer-ului. Coconut arată că merge chiar la 124M, cu limite oneste.

Surse: [Geiping](https://arxiv.org/abs/2502.05171) · [Coconut](https://arxiv.org/abs/2412.06769)

### 2.3 Raționament prin distilare și RL la scară mică — dovezi PUTERNICE

- **DeepSeek-R1-Distill-Qwen-1.5B** ✅ (fișa HF): **AIME 2024 28,9%, MATH-500 83,9%** — doar SFT pe
  ~800k urme de raționament de la profesor, fără RL.
- ⚠️ Continuări cu RL pe același 1,5B: DeepScaleR 43,1% AIME; STILL-3 39,3%; Open-RS (7k exemple, 24h, 4×A40).
- ⚠️ **TinyZero**: R1-Zero replicat pe 3B pentru ~$30 pe Countdown — auto-verificare emergentă din RL pur.

**Ce înseamnă pentru Ilaria**: la 0,5–1,5B, „gândirea pe pași" se transferă prin **distilare SFT** —
exact calea B. Constrângere: 1,5B nu încape în 6GB la fine-tuning fp32 → LoRA/bf16 obligatoriu.

Surse: [R1 paper](https://arxiv.org/abs/2501.12948) · [1.5B card](https://huggingface.co/deepseek-ai/DeepSeek-R1-Distill-Qwen-1.5B) ·
[Raschka overview](https://magazine.sebastianraschka.com/p/understanding-reasoning-llms)

### 2.4 Verificatori, modele ale lumii, sinteză de programe, inferență activă — dovezi MIXTE

- **Energy-Based Transformers** (ICLR 2026 oral, arXiv 2507.02092) ✅: predicția = minimizare de
  energie; „up to 35% higher scaling rate"; ⚠️ „think longer" +29% pe limbaj; critică: câștigul poate
  veni din calcul suplimentar la test-time.
- **V-JEPA 2** (Meta 2025): model al lumii din 1M ore video; robotică zero-shot 60–80% manipulare ⚠️ — **nu e limbaj**.
- **DreamCoder** (PLDI 2021): wake-sleep cu învățare de bibliotecă de programe; rezolvă ≥ cel mai bun
  baseline în 8 domenii; ⚠️ o abordare inspirată de el: 26% ARC-AGI-2 (sept. 2025).
- **Inferență activă / AXIOM** (VERSES 2025): ⚠️ toate cifrele sunt din comunicate de presă — neverificate.

**Ce înseamnă pentru Ilaria**: DreamCoder e cea mai bună potrivire pentru partea simbolică
(`reasoning.go`) + ciclul nostru de somn: **proceduri reutilizabile care cresc în timp**. EBT e prea
timpuriu pentru bugetul nostru.

Surse: [EBT](https://arxiv.org/abs/2507.02092) · [V-JEPA 2](https://arxiv.org/html/2506.09985v1) ·
[DreamCoder](https://dl.acm.org/doi/10.1145/3453483.3454080)

### 2.5 Cât de mic poate fi un creier coerent — dovezi PUTERNICE (rețeta forjei)

- **TinyStories** (Eldan & Li 2023, arXiv 2305.07759) ✅: modele „below 10 million total parameters"
  produc povești fluente, cu gramatică aproape perfectă; ⚠️ ≤30h pe un V100; 480M tokeni sintetici.
- **SmolLM2** (arXiv 2502.02737) ✅: 1,7B „overtrain … on ~11 trillion tokens"; ⚠️ 135M pe 2T tokeni,
  360M pe 4T — 64×H100. Un studiu pe un singur GPU (L20, 13B tokeni) ajunge la ~85% din scorul
  SmolLM2-135M cu 0,65% din bugetul lui ⚠️.
- ⚠️ GPT-2 124M reprodus în ~90 min pe 8×A100 (10B tokeni); pe un 4090 în 90 min la 3B tokeni.

**Ce înseamnă pentru Ilaria**: pe 1660 Ti, ținta realistă a forjei e **30–100M parametri pe 1–5B
tokeni**: coerență de tip TinyStories în ore, GPT-2-small-quality în zile. Nu SmolLM2 (2T tokeni).

---

## Top 5 direcții pentru Ilaria (după forța dovezilor × fezabilitate pe 6GB)

1. **Consolidare prin somn cu gradienți reali** (CLS; Tadros 2022, Singh 2022) — episoadele din
   hipocamp devin date de fine-tuning (LoRA) în faza de somn. Avem tot scheletul; lipsește doar
   antrenarea reală în `SelfEvolve`. *Cel mai mare câștig pe efort.*
2. **Distilare a urmelor de raționament în creierul mic** (R1-Distill 1,5B: 28,9% AIME din SFT pur) —
   calea B: profesor → urme CoT → student de 100M–500M. Ilaria capătă „gândire pe pași" măsurabilă.
3. **Memory Layers** (Meta 2024: bate dense la 2× calcul) — tabel cheie-valoare antrenabil pentru
   fapte, în RAM/NVMe, zero FLOPs în plus. Unifică planul nostru NTX1 cu o dovadă la scară.
4. **Buclă de rafinare iterativă cu oprire** (lecția verificată a HRM/TRM; 7M parametri) + **recurență
   în adâncime** în LM (Geiping; Coconut merge la 124M) — „gândește mai mult" fără parametri în plus.
5. **Memorie agentică + învățare de bibliotecă** (Letta: gestionarea contextului > retrieval;
   DreamCoder: proceduri reutilizabile prin wake-sleep) — Ilaria decide ce caută, ce reține, ce
   abstractizează.

## Ce NU urmărim (și de ce)

- **SDR/HTM ca substrat de gândire** — nicio demonstrație lingvistică; rămân pentru indexare.
- **„Arhitectura biologică = inteligență"** — ARC Prize a arătat că la HRM nu ierarhia conta, ci bucla.
- **Cifrele de presă (AXIOM, scorurile de memorie din 2026)** — neverificate independent.
- **AGI** — nimic din cele de mai sus nu e AGI; sunt ingredientele demonstrate ale unui sistem mic
  care învață continuu și raționează iterativ. Asta e ținta reală.
