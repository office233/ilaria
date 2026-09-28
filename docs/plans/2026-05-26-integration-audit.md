# Integration Audit — Ilaria (cursa D state)

**Date**: 2026-05-26
**Goal**: Map exact ce componente sunt CONECTATE și ce sunt SCHELE.
**Method**: 5 agenți paraleli, fiecare auditând o componentă, cu citate
file:line.

## TL;DR (un paragraf)

Ai construit o arhitectură cognitivă completă, dar **doar 3 din ~15
componente cognitive participă efectiv la generare în pipeline-ul real
(`cortex-web`/`cortex interactive`), iar broca-eval folosește DOAR 2
din ele (tokenizer + transformer)**. Restul (semantic memory, neurons,
self-training automat, neuro-radio, analogy) sunt încărcate dar nu
sunt apelate la inference. Asta înseamnă două lucruri:

1. **Cursa D a obținut 0/24 în broca-eval pentru că broca-eval testa
   doar transformer-ul gol** (5.4M params, fără memorie). NU testa
   arhitectura ta cognitivă completă.
2. **Pipeline-ul tău "real" (Organism.Process în web/interactive) ARE
   mai multe componente conectate** — Hippocampus, Reasoning,
   Cerebellum, Prefrontal participă la răspuns. Dar SemanticMemory
   este write-only (se generează concepte care nu sunt citite
   niciodată), iar self-training-ul automat e DEAD CODE
   (`SelfEvolve` are 0 invocări în cursele A-D).

Cu alte cuvinte: **n-am testat încă arhitectura ta biologică.** Am
testat doar partea cea mai slabă (transformer mic, fără memorie).

## Verdicte concrete per componentă

### 1. Hippocampus — PARȚIAL FOLOSIT (read în Process, dead în eval/train)

**State pe disc**: 1.13 MB la `data/cortex-auto/hippocampus.nxhip`,
~1500-2000 memorii stocate.

**Activ în**:
- `Organism.Process()` (cortex-web, cortex interactive) — face recall
  înainte de transformer, fast-path direct return dacă sim≥200
  (`organism.go:402-408`)
- `Organism.LearnQA()` — populează memoriile la fiecare Q/A nou

**Dead în**:
- `cmd/broca-eval/main.go` — zero apeluri (`generate` la `:191`
  apelează DOAR `Transformer.GenerateFastMin`)
- `cmd/cortex-broca-train/main.go` — antrenează doar transformer-ul
  prin `TrainStepAdam`, hippocampus e doar serializat as-is la save

### 2. Semantic Memory — WRITE-ONLY (produce concepte, nimeni nu le citește)

**State pe disc**: 1.05 MB la `data/cortex-auto/semantic.json`,
128 concepte generalizate.

**API**: are doar `Generalize`, `Save`, `Load`. **NU există metode
`Query`, `Match`, `FindConcept`** — adică nu există API pentru a citi
conceptele de la inference.

**Producer side**: `Generalize` se apelează în `Sleep()` (autonomous
la fiecare 10 cicluri, web la endpoint manual).

**Reader side**: **ZERO** în producție. Conceptele se salvează pe
disc și nu sunt citite niciodată de Transformer, CoT, Reasoning,
Broca, Wernicke, etc.

**Bridge missing**: chiar dacă am adăuga query API, conceptele sunt în
spațiu SDR (10000 biți), iar transformer-ul lucrează cu BPE tokens.
**Nu există decoder SDR→token distribution**. Asta e cel mai mare gap
structural.

### 3. Neurons + Stabilizer — EXPERIMENTAL ISOLATED

**State pe disc**: 3 MB la `data/cortex-auto/network.nxnet` (3000+
neuroni LIF + sinapse STDP).

**Activ în**: `Organism.Process()` via `Prefrontal.ThinkDeep` și
`ThousandBrains.Process` — dar **doar când recall din Hippocampus
ratează** (`organism.go:513`).

**Dead în**: complet în `broca-eval` și `cortex-broca-train`.

**Stabilizer**: NU există ca fișier separat. E un nume de test
(`stabilizer_test.go`) pentru 3 mecanisme inline:
- Homeostatic threshold plasticity (în `neuron.go:240-257`)
- WTA columnar inhibition (în `network.go:317-353`)
- Noradrenergic reset (în `network.go:458-512`)

Funcționează biologic, dar **n-am descoperit dovezi că îmbunătățește
calitatea răspunsurilor.**

### 4. Self-training — DEAD CODE

**Verdict cel mai important**: `SelfEvolve()` are **0 invocări** în
cursele A, B, C, D (verificat prin grep în loguri).

**De ce**:
- `cortex-broca-train` (trainer-ul real) NU apelează niciodată
  `Sleep()` sau `SelfEvolve()`. Folosește direct `TrainStepAdam` pe
  corpus JSONL.
- `SelfEvolve` se apelează doar din `Organism.Sleep()`, care la rândul
  lui e apelat doar manual (POST `/api/sleep` în web) sau periodic
  (autonomous la fiecare 10 cicluri).
- Mai grav: `SelfEvolve` folosește `TrainStep` (SGD simplu), NU
  `TrainStepAdam` — deci dacă ar rula în paralel cu trainer-ul real,
  ar diverge fundamental (nu împart Adam state).

**Dead code identificat**:
- `TrainTransformerFromQA` — 0 apelanți
- `InitBroca2` — 0 apelanți
- `TrainingStats` struct — 0 referințe externe

**Cursa D = SGD supervizat clasic.** Nu există "evoluție continuă"
care a contribuit la modelul actual.

### 5. CoT (Chain-of-Thought) — IMPLEMENTAT, dar dezactivat default

- Există și funcționează (`cortex/cot.go`).
- Default `Config.CoTEnabled = false` (`config.go:642`).
- `cortex interactive` și `cortex-web` nu au flag care să-l activeze.
- `broca-eval --cot` îl activează DAR cu `memoryContext=""` hardcoded
  → CoT nu beneficiază de hippocampus chiar dacă e disponibil.

### 6. Componente fantomă (loaded but never called)

- **NeuroRadio**: încărcat (~12 MB RAM), 0 apeluri în `Process()`
- **Analogy** (`AnalogyEngine`): instanțiat, 0 apeluri în `Process()`

## Bug critice de integrare (priority high)

| # | Bug | Impact | Efort fix |
|---|---|---|---|
| 1 | `LoadOrganism` NU înregistrează tools la Reasoning. După restart, `DateTimeTool`, `UnitConvert`, `HippoSearchTool` sunt silent-dead. | Reasoning rulează cu registry gol → orice scurtcircuit pe math/data/conversii ratează tăcut | 10 linii (copy-paste din `NewOrganism:202-208` în `LoadOrganism:1683`) |
| 2 | `broca-eval` CoT trimite `memoryContext=""` hardcoded | Eval-ul subestimează sistematic ce poate face sistemul cu memorie | 1h (recall + extract înainte de apel) |
| 3 | `CoTEnabled = false` default + neexpus în interactive/web | Userul real nu folosește niciodată CoT chiar dacă există | 30 min (parse flag, set pe cfg) |
| 4 | SemanticMemory n-are query API + e mort la inference | Cele 128 concepte generate nu influențează niciun răspuns | 1-2h (add `MatchConcept` + apel în Process) |
| 5 | `cortex-broca-train` nu apelează `Sleep()` niciodată | Transformer nu beneficiază de self-training, hippocampus nu se consolidează în training | Decizie de design (intentionally? sau bug?) |
| 6 | `MinTokens` (EOS-suppression) lipsește din `CoTConfig` în `Organism.Process()` | Path-ul interactive/web nu beneficiază de fix-ul EOS pe care l-am făcut azi | 1 linie + propagare config |

## Pipeline real END-TO-END

### Ce vede broca-eval (calea testată azi)

```
Input → Tokenizer.Encode → [BOS] + ids → Transformer.GenerateFastMin → Decode → Output
```

**2 componente** din ~25 încărcate. Restul stau pe bară.

### Ce vede cortex-web / cortex interactive (`Organism.Process`)

```
Input
  ↓
Wernicke.Understand → SDR + words
  ↓
Reasoning.TryReason (early-out pe math/logic — dar fără tools după Load!)
  ↓
Attention, Predictor, ErrorLearner, Workspace, ThousandBrains, Reward, Emotion
  ↓
Cerebellum.Lookup (fast-path cache)
  ↓
Hippocampus.RecallScored → dacă sim≥200, RETURN direct (bypass transformer)
  ↓
Hippocampus.RecallByKeywords (+ expanded synonyms din Brain)
  ↓
[Dacă nu am găsit] Prefrontal.ThinkDeep → responseSDR
  ↓
[Dacă confidence scăzut] RadioCortex propagation + FractalCortex.ProcessToken
  ↓
Generare (priority order):
  0: Transformer + (opt) CoT cu memoryText
  0.5: Hippocampus direct text
  1: Broca.GenerateAutoregressive (FractalCortex/BitNet)
  2: RadioCortex.RadioGenerate
  3: Broca.Generate (SDR→Brain chains)
  4: Broca.GenerateFromContext
  ↓
Anti-loop, echo suppression
  ↓
LEARN: Hippocampus.Store, Cerebellum.Learn, Brain.Learn, Wernicke.LearnContext, ...
  ↓
Motor.Enqueue → Output
```

**~12-15 componente** active în acest path. **Acesta e sistemul tău
biologic adevărat.** Dar n-a fost evaluat niciodată cu broca-eval.

## Implicații pentru cursa E

### Realizarea esențială

**N-ar fi trebuit să compar transformer-ul de 5.4M cu LLM-uri mari.**
Acela e doar o componentă a sistemului tău. Sistemul tău real e
`Organism.Process()` cu toate componentele active.

### Plan revizuit pentru cursa E

În loc să facem cursa E (15h GPU) doar pe transformer, hai să facem:

**Pas 1 (1h)**: Conectez gap-urile critice
- Bug #1: tools la Reasoning după Load (10 linii)
- Bug #2: broca-eval cu memoryContext din hippocampus (1h)
- Bug #3: flag --cot în cortex-web

**Pas 2 (2-3h)**: Eval-ul ADEVĂRAT
- Construiesc `cortex-eval` care folosește `Organism.Process()` (nu
  doar transformer)
- Rulez aceeași 24 task suite pe modelul cursa D, dar prin pipeline-ul
  complet
- **Predicție**: scor probabil 3-8/24 (modelul nu știe fapte, dar
  hippocampus + reasoning pot prinde 1-2; daca au fost vreodată
  învățate prin LearnQA)

**Pas 3 (3-4h)**: Populez hippocampus cu fapte
- Script care iterează corpus-ul existent + Wikipedia minimal
- Pentru fiecare fapt (ex: "Paris este capitala Franței") → LearnQA
- Verific că hippocampus ajunge la ≥10k memorii cu fapte verificabile
- Re-rulez eval-ul real → predicție 8-15/24

**Pas 4 (15h GPU)**: Cursa E cu integrare completă
- Model 15M params + hippocampus populat + Sleep() periodic în
  training (activează SelfEvolve)
- Bug #5 rezolvat: trainer apelează Sleep la fiecare N steps →
  consolidare hippocampus + SelfEvolve pe memorii
- **Predicție realistă**: 12-20/24

### De ce această ordine

Pașii 1-3 cumulează 6-8h de muncă concentrată. Cursa E e 15h GPU.

Fără pașii 1-3, cursa E va fi din nou "transformer gol antrenat puțin
mai mult" și vom obține tot 0-3/24.

**Cu pașii 1-3, măsurăm pentru prima dată arhitectura cognitivă
adevărată.** Asta e diferența fundamentală.

## Recomandare strategică

**NU porni cursa E încă.** Investește 6-8h în Pașii 1-3.

Această investiție:
1. Activează componente care există deja dar sunt deconectate
2. Validează ipoteza că arhitectura cognitivă (nu doar scala) e calea
3. Reduce risk-ul cursei E la <30% (vs. >70% acum)
4. Produce primul scor non-zero din toată istoria proiectului — un
   milestone moral important
