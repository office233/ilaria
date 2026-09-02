# Roadmap de îmbunătățire — analiza completă din 2 septembrie 2026

**Metodă**: agent de analiză profundă pe calea LM (transformer/tokenizer/optimizer/ternary),
plus citirea integrală a postmortem-urilor (cursa C/D), auditul de integrare,
HARDCODING_AND_LIMITATIONS.md și planul NeuroTexture. Toate afirmațiile de mai jos
au referințe file:line verificate.

**Hardware țintă (fix)**: GTX 1660 Ti 6GB VRAM · i7-9700 8-core · 16GB RAM.

---

## 1. Verdictul onest

**Ce e solid** (peste media proiectelor de acest gen):
- Backprop-ul manual e CORECT — validat prin gradient check cu diferențe finite pe
  fiecare clasă de parametri (`transformer_backward_test.go:18-123`).
- KV-cache echivalent matematic cu calea de antrenare (`transformer_cache_test.go:14`).
- Adam cu bias correction + grad clipping + persistare/resume (`transformer_optimizer.go`).
- Cultura de inginerie: postmortem-uri, teste de regresie pe bug-uri istorice,
  inventar onest al limitărilor. Rar întâlnit.

**Ce ținea proiectul pe loc**:
1. ~~**Auto-antrenarea online corupea modelul**~~ — **REPARAT 2026-09-02** (vezi §2).
2. **5,4M parametri nu pot învăța fapte** — dovedit empiric în cursa D: 0 generări
   factuale corecte din 228 de încercări; ppl 151 la asimptotă.
3. **Arhitectura cognitivă nu participa la generare** — auditul de integrare:
   broca-eval testa DOAR transformer-ul gol. Puntea SDR→logits lipsea structural.
   (Rezolvată în lucrarea necomisă `cognitive_bridge.go` — vezi §3.)
4. **Zero regularizare** (fără dropout, fără weight decay, fără label smoothing),
   batch=1 cu medie pe secvențe nu pe tokeni, poziții absolute cu zid la 512,
   BPE pe caractere cu OOV→UNK ireversibil.
5. **Scoring-ul eval are false-positive** documentate (`ModeContainsAny` substring,
   `ModeNumeric` primul număr) — orice progres viitor e nemăsurabil până nu se repară.

---

## 2. Reparat pe 2 septembrie 2026

`MiniTransformer.TrainStep` (legacy) actualiza doar embeddings și aplica **zgomot
gaussian** pe toate ponderile attention/FFN (`updateBlockWeights`, șters).
`self_training.go` îl apela în 3 locuri → fiecare ciclu Sleep()/SelfEvolve/LearnQA
**strica** checkpoint-ul antrenat offline.

Schimbări:
- `TrainStep` deleghează acum la `TrainStepBackprop` (backprop real; calea cu zgomot ștearsă).
- `Organism` ține `AdamState` persistent (`ensureAdamState`, lazy, rebuild la swap
  de transformer — același pattern ca `ensureBridge`).
- Cele 3 căi de self-training folosesc `TrainStepAdam`/`TrainStepAdamBatch` cu
  mini-batch-uri de 8 secvențe (zgomot de gradient redus).
- Teste de regresie noi în `self_training_adam_test.go`:
  QA self-training: loss 6.30 → **0.0013** în 60 pași (înainte: nu converga deloc).

---

## 3. Lucrare valoroasă NECOMISĂ găsită în working tree

- `cortex/cognitive_bridge.go` (+ teste): recall hipocampic → bias de logits,
  aplicat corect (după temperatură, după suprimarea EOS, înainte de top-K).
  Închide gap-ul #1 din auditul de integrare. `TestContinualLearning_FactSurvivesRestart`
  dovedește: fapt învățat dintr-O SINGURĂ expunere supraviețuiește restart-ului și
  ajunge în generare.
- `cmd/distill/`: recoltor de perechi instruction/response de la un model-profesor
  (orice endpoint OpenAI-compatibil / Anthropic), rezumabil, cu backoff.
- Fix predictor saturation în `cmd/cortex-train` (Predict înainte de Update).

**Acțiune**: review + commit. Acestea sunt fundația Fazei 1.

---

## 4. Strategia: unde POATE câștiga Nexus (și unde nu)

**Nu se poate** (spus direct): a bate GPT-4/Claude/Gemini la benchmark-uri generale
pe 6GB VRAM. Frontier models = mii de GPU-uri; nicio arhitectură nu compensează
un raport de capacitate de 10^5.

**Se poate câștiga — trei ținte concrete, în ordinea fezabilității**:

**Ținta A — Bate orice LLM înghețat la învățare continuă (realizabil ACUM)**
Un LLM frozen nu poate învăța un fapt nou fără fine-tuning. Nexus, prin
hippocampus + cognitive bridge, învață dintr-o expunere, persistă pe disc, zero
gradient. Construiește benchmark-ul "learn-once, answer-forever": N fapte noi
predate o singură dată → întrebate după restart → comparat cu un LLM local frozen
de aceeași mărime. Aici Nexus bate prin design, iar rezultatul e publicabil.

**Ținta B — Bate GPT-2 124M la calitate/parametru pe hardware-ul tău (luni)**
GPT-2 124M e o țintă publică, măsurabilă, apropiată de bugetul de VRAM. Drumul:
Broca 2.0 la 30–50M cu arhitectură modernă (§5) + corpus distilat + curriculum
TinyStories-style. Lecția TinyStories (Eldan & Li 2023): la scară mică, corpusul
potrivit bate scala — modele de 10–30M generează text coerent pe corpus simplu
și consistent. Dolly+alpaca la 5M a fost o nepotrivire fundamentală de scară.

**Ținta C — Eficiență extremă (după A+B)**
Ternary real (QAT cu STE, BitNet b1.58) + bit-packing/popcount + expert atlas mmap
(planul NTX1 există deja). Metrică: tokeni/sec/watt pe CPU vs llama.cpp la calitate
egală. Doar DUPĂ ce există un model coerent de comprimat.

---

## 5. Plan de execuție

### Faza 0 — Igienă măsurătoare (1-2 sesiuni) — fără asta orice progres e invizibil
1. Repară `evalsuite/score.go`: word-boundary la `ModeContainsAny`, extragere
   answer-aware la `ModeNumeric`; `scorer_version: 2` în JSON; rescore istoric
   offline pe `auto-step*.json` (planul există în HARDCODING §11).
2. Script build CUDA care copiază `cuda_nexus.dll` lângă binar (HARDCODING §10).
3. Commit lucrarea necomisă (bridge + distill + fix predictor) după review.

### Faza 1 — Ținta A: benchmark-ul de continual learning (1 săptămână)
1. `data/evals/continual.jsonl`: 100 fapte noi (care NU apar în corpus) + parafraze.
2. Runner: teach-once → restart → eval, cu/fără bridge (ablație), raport JSON.
3. Semantic memory: adaugă API de citire (`Query/FindConcept`) — azi e write-only —
   și leagă-l ca a doua sursă de bias în bridge.
4. README: secțiune cu rezultatul, formulat onest (nișă, nu AGI).

### Faza 2 — Broca 2.0 modern (2-4 săptămâni, în ordinea ROI)
| # | Schimbare | Unde | Status |
|---|---|---|---|
| 1 | Batch 8 default + medie pe TOKENI nu secvențe | `accumulateGradWeighted`, trainer `-batch-size` | ✅ 2026-09-02 |
| 2 | AdamW (decay decuplat, doar matrici) + dropout attn/FFN (mască inversată, doar ForwardTrain) | `adamUpdateWD`, `transformer.go`, trainer `-weight-decay`/`-dropout` (default 0.01/0.1) | ✅ 2026-09-02 |
| 3 | Top-p + repetition penalty | `transformer_sampling.go` (GenerateSampled) | ✅ 2026-09-02 |
| 4 | Prefill batched (un Forward peste prompt, KV din lastK/lastV; serial păstrat ca referință de test) | `transformer_cache.go` prefill/prefillSerial | ✅ 2026-09-02 |
| 5 | RoPE — OBLIGATORIU config-gated: greutățile GPT-2 importate cer poziții absolute | `transformer.go`, cache, backward | deschis |
| 6 | SwiGLU — la fel, config-gated (GPT-2 cere GELU) | FFN + backward | deschis |
| 7 | Numărare incrementală a perechilor la antrenarea BPE (byte-level EXISTĂ deja via GPT-2 mode) | `tokenizer.go:202-327` | deschis |
| 8 | Update Adam sparse pe embeddings (doar rândurile atinse) | `embedding.go`, optimizer | deschis |
| 9 | Checkpoint binar | `transformer_persist_binary.go` (NXTF2BIN) | ✅ 2026-09-02 |

Notă: rescorarea istorică (Faza 0.1 pasul 3) e IMPOSIBILĂ pe această mașină —
`data/cortex-auto/` cu evaluările curselor C/D nu există în clona curentă
(directorul era gitignored și a rămas pe mediul vechi). Baseline-ul nou începe
de la scorer v2 + modelele importate.

Gradient check-ul existent validează fiecare schimbare de arhitectură — avantaj enorm.

### Faza 3 — Cursa E' (după Faza 2)
- Corpus NOU: distilat prin `cmd/distill` (10-50k perechi QA curate, RO+EN) +
  TinyStories-style, secvențe mai lungi (fix-ul real al degenerării EOS —
  67,8% din corpus sub 25 cuvinte a învățat modelul să tacă).
- Model: 30M (6L × d384 × 6H, ctx 1024 cu RoPE) — încape lejer în 6GB.
- Auto-eval cu scorer v2 de la primul pas; asimptota așteptată ppl < 40.

### Faza 4 — Ținta C: eficiență (doar după model coerent)
- QAT ternary real: master weights FP + STE + scală absmean (înlocuiește STDP
  probabilistic din `ternary_train.go` pentru LM).
- Bit-packing 4 params/byte + `bits.OnesCount64` pe produse scalare.
- Expert atlas NTX1 mmap (planul din NEUROTEXTURE_SUPERAI_PLAN §5-8).

---

## 5-bis. EXECUTAT 2026-09-02 (aceeași zi): sărim peste pre-antrenare — import GPT-2

Descoperire: MiniTransformer e arhitectural IDENTIC cu GPT-2 (matmul row-vector cu
ponderi [in,out] = exact layout-ul Conv1D, gelu_new, pre-norm, LN eps 1e-5, head
legat, poziții absolute). Deci greutățile GPT-2 se copiază direct, fără transpuse.

Livrat și testat:
- `cortex/tokenizer_gpt2.go` — mod byte-level GPT-2 pe BPETokenizer (flag `ByteLevel`):
  alfabetul byte→unicode, pretokenizare cu semantica regex-ului GPT-2,
  `<|endoftext|>` pentru toate rolurile speciale. UNK devine imposibil (acoperire
  totală pe bytes — inclusiv diacritice românești).
- `cortex/transformer_persist_binary.go` — format checkpoint binar v2 ("NXTF2BIN"),
  `SaveBinary` + sniffing automat în `LoadMiniTransformer`. La 82M parametri: secunde
  în loc de zeci de minute cât ar fi durat JSON-ul gzip.
- `cmd/gpt2-import` — cititor safetensors pur Go (F32/F16/BF16) + maparea numelor
  GPT-2 → structuri Nexus + probă de generare + verificare reload.

Rezultat cu DistilGPT-2 82M (descărcat de pe HuggingFace, licență MIT):
- „Albert Einstein developed the theory of" → „...theory of relativity in 1876. The
  theory was based on the principle that the laws" — engleză fluentă ÎN motorul Go.
  (Cursa D, după 30k pași de antrenare: 0 mențiuni „relativity" din 228 încercări.)
- ~0,2s/token pe CPU. Checkpoint: `data/cortex-gpt2/transformer.nxtf` (328MB).

Pași următori conveniți:
1. **Calea GPU cu ponderi rezidente** — cuBLAS-ul actual copiază ponderile la fiecare
   apel (inutilizabil la GEMV M=1). Cu ponderile urcate O DATĂ în VRAM (500MB din
   6GB), estimare 40-80 tok/s pe GTX 1660 Ti = 50-100× față de CPU.
2. **Integrarea în Organism** — LoadOrganism cere restul fișierelor de stare;
   de făcut bootstrap pe un data-dir care are doar transformer+tokenizer.
3. **Benchmark-ul continual-learning (Ținta A)** — acum cu generator fluent sub punte.

## 5-ter. EXECUTAT 2026-09-02 (seara): Ținta A atinsă — benchmark-ul continual learning

Livrat:
- `data/evals/continual.jsonl` — 100 fapte INVENTATE (țări, inventatori, romane,
  coduri fictive), imposibil de știut de orice LLM. Subiect unic per fapt.
- `cmd/continual-bench` — protocol teach-once → persist → restart (obiecte noi,
  seed diferit, doar discul transportă cunoașterea) → eval în 3 brațe de ablație,
  scorare evalsuite v2, checksum de greutăți care dovedește zero antrenare.
- Secțiune README cu rezultatul.

Rezultat (DistilGPT-2 82M înghețat, GPU rezident, 142s pentru 300 generări):

| Braț | Acuratețe strictă |
|---|---|
| Sistem complet (memorie→context + bias) | **94%** |
| Doar bias de logits | 2% |
| LLM înghețat (aceleași greutăți, fără memorie) | **1%** |

Recall memorie după restart: 97%. Gradient updates: 0. Hash greutăți identic.

Lecție de mecanism (raportată onest): bias-ul de logits singur NU poate dicta
cuvinte inventate multi-token; injecția memoriei în context (RAG peste memoria
episodică one-shot) e mecanismul care duce greul. Ambele rămân în sistem —
bias-ul ajută la copiere, contextul poartă conținutul.

**Update (aceeași seară) — toate cele 3 follow-up-uri executate:**
1. Recall 97→**100%**: stemmer normalizat (e-final, y→i — „dance"/„dances",
   „memory"/„memories" pe același stem) + fallback la prag 1 în bridge când
   pragul 2 nu găsește nimic. Strict accuracy: 94→**96%**.
2. Formatul QA câștigător (one-shot example + Fact/Question/Answer) e acum în
   `Broca.generateQAStyle`, activat automat când tokenizer-ul e byte-level
   (GPT-2) — `Organism.Process` beneficiază direct.
3. SemanticMemory nu mai e write-only: `Query` (SDR) + `QueryByKeywords`
   (robust la restart de encoder) + integrare în CognitiveBridge ca a doua
   sursă de bias (damped la `SemanticWeight`=0.5, plafonat la MaxBias; sursa
   episodică domină întotdeauna). Închis gap-ul #2 din auditul de integrare.

## 6. Ce NU facem (decizii explicite)

- Nu wire-uim ternary în transformer înainte de QAT real — STDP-ul actual nu poate
  antrena un LM (fără loss, fără gradienți).
- Nu flash-attention la ctx ≤ 1024 — bottleneck-ul e embedding/LM-head, nu attention.
- Nu mai multe variante de cortex în paralel (radio/fractal/quantum concurează între
  ele) — Faza 1-3 folosesc UN singur drum: hippocampus + bridge + MiniTransformer.
- Nu promitem "batem LLM-urile" generic în README — promitem Ținta A și B, măsurate.
