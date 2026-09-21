# NexusCortex

[![CI](https://github.com/office233/Nexuscortex/actions/workflows/ci.yml/badge.svg)](https://github.com/office233/Nexuscortex/actions/workflows/ci.yml)

Experimental sparse cognitive architecture written in Go.

NexusCortex is a research and learning project exploring whether ideas from Sparse Distributed Representations, associative memory, online learning, sparse routing, and local-first compute can be combined into a small cognitive-system prototype.

This is not a replacement for frontier LLMs. It is not an AGI claim. The goal is to understand and implement low-level AI system primitives from scratch.

<p align="center">
  <img src="https://img.shields.io/badge/Go-1.26-00ADD8?style=flat-square&logo=go" />
  <img src="https://img.shields.io/badge/CUDA-Optional-76B900?style=flat-square&logo=nvidia" />
  <img src="https://img.shields.io/badge/Tests-137_passing-brightgreen?style=flat-square" />
  <img src="https://img.shields.io/badge/License-AGPL--3.0-blue?style=flat-square" />
</p>

<p align="center">
  <a href="#what-it-implements">What It Implements</a> •
  <a href="#architecture">Architecture</a> •
  <a href="#quick-start">Quick Start</a> •
  <a href="#neural-dashboard">Dashboard</a> •
  <a href="#benchmark-performance-local-vs-own-dense-baseline">Benchmarks</a> •
  <a href="#roadmap">Roadmap</a>
</p>

---

## What It Implements

- **SDR-based attention** — popcount similarity and top-K retrieval (`sdr_attention.go`)
- **Sparse ternary compute** — RGBA32 packed weights, 0.25 bytes/param (`neurotexture.go`, `ternary.go`)
- **10 neural region modules** — Wernicke, Broca, Hippocampus, Prefrontal, Cerebellum, Emotion, Curiosity, Sleep, Sensory, Reward
- **Episodic and semantic memory** — storage and retrieval prototypes (`hippocampus.go`)
- **Online learning** — continuous learning without full retraining
- **Sleep consolidation** — replay-inspired episodic → semantic memory transfer (`sleep_consolidation.go`)
- **Fractal architecture** — multi-block expert routing (`fractal_cortex.go`)
- **Thousand Brains Theory** — Jeff Hawkins-inspired implementation (`thousand_brains.go`)
- **Local dashboard** — web UI for inspecting runtime state, emotional compass, cognitive vitals
- **CUDA compute backend** — optional GPU acceleration for sparse forward passes
- **Go tests** — 137 tests + 3 fuzz smoke tests, `go vet`, `staticcheck`, `gosec`, `govulncheck`

---

## Why I Built It

I wanted to learn what sits below API-level AI development: memory, retrieval, sparse representations, inference loops, state, routing, and performance constraints.

Instead of only calling model APIs, I built experimental components from scratch to understand how these mechanisms behave.

---

## System Overview

```mermaid
graph TD
    Input["📥 Input Layer"] --> Sensory["Sensory Cortex"]

    Sensory --> SDR["⚡ SDR Attention Hub"]

    SDR --> Wernicke["Wernicke\n(Comprehension)"]
    SDR --> Broca["Broca\n(Production)"]
    SDR --> Hippocampus["Hippocampus\n(Memory)"]
    SDR --> Prefrontal["Prefrontal\n(Reasoning)"]
    SDR --> Cerebellum["Cerebellum\n(Sequences)"]
    SDR --> Emotion["Emotion\n(Valence)"]
    SDR --> Curiosity["Curiosity\n(Novelty)"]
    SDR --> Sleep["Sleep\n(Consolidation)"]
    SDR --> Reward["Reward\n(Reinforcement)"]

    Hippocampus --> Memory["🧠 Memory System\n(Episodic + Semantic)"]
    Sleep --> SleepC["🌙 Sleep Consolidation\n(Replay & Pruning)"]
    SleepC --> Memory

    Wernicke --> Broca
    Prefrontal --> Broca
    Emotion --> Prefrontal
    Reward --> Curiosity

    Broca --> Output["📤 Output Layer"]
```

---

## Architecture

### Neural Regions

| Module | Inspired By | What It Does |
|--------|-------------|--------------|
| **Wernicke** | Wernicke's area | Language comprehension — encodes input into sparse representations |
| **Broca** | Broca's area | Language production — generates output from neural activity |
| **Hippocampus** | Hippocampus | Episodic & semantic memory formation, storage, retrieval |
| **Prefrontal** | Prefrontal cortex | Reasoning, decision-making, reservoir computing |
| **Cerebellum** | Cerebellum | Motor planning and sequence coordination |
| **Emotion** | Limbic system | Valence-arousal emotional state modulation |
| **Curiosity** | Dopaminergic system | Novelty detection, exploration drive |
| **Sleep** | Sleep cycles | Memory consolidation, synaptic pruning, replay |
| **Sensory** | Sensory cortex | Input encoding and signal processing |
| **Reward** | Reward circuits | Reinforcement learning signals |

### Project Structure

```
Nexuscortex/
├── cmd/
│   ├── cortex/              # Interactive CLI
│   ├── cortex-train/        # Curriculum trainer
│   ├── cortex-eval/         # Evaluation runner
│   ├── cortex-autonomous/   # Autonomous learning loop
│   ├── cortex-web/          # Dashboard server
│   ├── cortex-tokenizer/    # Tokenizer tools
│   ├── cortex-diagnose/     # System diagnostics
│   ├── corpus-convert/      # Corpus format converter
│   └── train/               # Alternative trainer
├── cortex/                  # Core engine (all regions, compute, tests)
├── cuda/                    # CUDA kernel implementations
├── web/                     # Dashboard UI
├── data/
│   ├── corpus/              # Training corpora
│   └── evals/               # Evaluation suites
├── docs/                    # Research docs & benchmarks
└── .github/workflows/       # CI/CD pipeline
```

---

## Continual Learning Benchmark — "learn once, answer forever"

The one capability this architecture has that a frozen LLM structurally cannot:
**learning a new fact from a single exposure, with zero gradient updates, that
survives a full restart.**

Protocol (`cmd/continual-bench`, 100 invented facts in `data/evals/continual.jsonl`
that appear in no training corpus anywhere): each fact is stored ONCE in the
hippocampus, persisted to disk, the process state is discarded, and a fresh
process answers paraphrased questions using the same frozen transformer
(DistilGPT-2 82M imported via `cmd/gpt2-import`) three ways:

| Arm | Strict accuracy | Token recall |
|-----|----------------|--------------|
| **Full system** (episodic memory → context + logit bias) | **96%** | 65% |
| Logit bias only (no context injection) | 2% | 2% |
| **Frozen LLM baseline** (same weights, no memory) | **1%** | 1% |

- Memory recall after restart: **100%** · gradient updates: **0** · weight hash
  verified identical before/after.
- Scoring: word-boundary matching, scorer v2 (`cortex/evalsuite`).
- Honest reading: the win comes from one-shot episodic retrieval feeding the
  frozen generator's context (plus a bounded logit bias). The bias alone does
  not carry multi-token invented words — that ablation is reported, not hidden.
- Reproduce: `go run -tags gpu ./cmd/continual-bench -gpu -rep-penalty 1.0 -temp 0.3`
  (CPU works too, drop the flags).

---

## Biomedical organ with real sources (`cortex/biomed`)

Ilaria's first *knowledge organ*: it answers drug questions **only** from live public
sources and shows its evidence. There is no hand-written drug table; what a source
does not know is listed under "Could not determine".

| Source | What it provides |
|---|---|
| RxNorm (NLM) | drug-name normalization (any spelling → RxCUI), full name index for detecting mentions in free text |
| ChEMBL (EMBL-EBI) | molecule properties, curated mechanism of action + protein target, measured IC50/Ki |
| openFDA | the official FDA label: boxed warning, contraindications, interactions, dosing, special populations, pharmacokinetics |
| Open Targets | disease normalization, target↔disease association scores, clinical-stage drugs |
| PubMed | literature counts and PMIDs for (drug, variant) pairs |

Responses are cached under `data/knowledge/biomed/` (this *is* the knowledge on disk;
it grows with every entity met and can live on Google Drive) and every consult extends
an evidence-carrying knowledge graph (`graph.json`). Pharmacokinetic parameters are
extracted from the label text with their quoted sentence and feed a one-compartment
model; if the label states no half-life, the simulation is refused instead of guessed.

```bash
go run ./cmd/nexus-biomed -query "gefitinib și warfarină la pacient cu EGFR T790M" -patient patient.json -dose 250
```

`patient.json` is either a FHIR Bundle or `{"active_medications":["warfarin"],"variants":[{"gene":"EGFR","change":"T790M"}],"labs":{"eGFR":{"value":38,"unit":"mL/min/1.73m2"}}}`.
Inside the organism the same organ is a `Tool` (enable with `"biomed_enabled": true`
in the config); it speaks only when the RxNorm index finds a drug in the input and stays
silent offline. `cortex/swe` now holds a **real** sandbox (`RunGo`) that vets, builds and
tests Go code through the actual toolchain, the organism's self-verification organ.

## Ilaria-130M — the forge-trained language cortex (2026-09-22)

The first real language cortex was trained from scratch in the forge (`forge/train_ilaria.py`)
on a Colab GPU runtime and runs unchanged in the Go engine:

| | |
|---|---|
| architecture | 12 layers, d 768, 12 heads, SwiGLU 2688, RoPE, ctx 1024, tied head — 128.1 M params |
| tokenizer | byte-level BPE 32k trained on a balanced RO/EN sample (`forge/hf_tokenizer.py`), id-identical to the Go byte-level mode |
| corpus | 5.8 M documents → 3.72 G tokens: FineWeb-2 RO, FineWeb-Edu, Wikipedia RO/EN (`forge/prepare_corpus.py`, `forge/concat_streams.py`) |
| training | 11 500 steps × 262 k tokens = 3.0 G tokens, bf16 + `torch.compile`, ~210 k tok/s, ≈ 4 h |
| validation | loss 2.894, perplexity **18.1** (best at step 10 000; `data/forge/brain-a/training.log`) |
| held-out (Wikipedia articles created in 2025, `forge/eval/`) | perplexity **24.4** overall — RO 20.8, EN 28.7 (`forge/ppl.py`, float32) |
| Go ≡ PyTorch on the real weights | max \|Δ logit\| 2·10⁻⁵, argmax identical on every position, identical token ids (`TestForgeBrainEquivalence`) |
| continual-learning benchmark with this cortex | strict accuracy **89 %** (bias-only 1 %, frozen 1 %), memory recall 100 %, zero gradient updates |

What it is not: an instruction-following model. Asked a question through the organism it continues text
like the web it was trained on; phase 2 (distillation / SFT with the organs in the loop) is what turns the
cortex into an assistant. Every answer of `cmd/cortex` now carries a provenance line
(`[provenance] source=tool|memory|reasoning|broca|none tool=<name>`), so it is visible which module answered.

```bash
# generation on the GPU (needs CGO + -tags gpu, see above)
go run -tags gpu ./cmd/nxtf-run -data-dir data/forge/brain-a -gpu -prompt "Ștefan cel Mare a fost" -max-tokens 60 -rep-penalty 1.2
# Go ≡ PyTorch on the real weights
python forge/dump_logits.py --brain data/forge/brain-a --out data/forge/brain-a/logits_ref.json
NEXUS_BRAIN_DIR=$PWD/data/forge/brain-a go test ./cortex -run TestForgeBrainEquivalence -count=1 -v
# perplexity on any UTF-8 text, both engines
python forge/ppl.py --brain data/forge/brain-a --text forge/eval/heldout_wiki_2025.txt
go run ./cmd/nxtf-ppl -data-dir data/forge/brain-a -text forge/eval/heldout_wiki_2025.txt
```

The Colab path (notebook, Drive layout, runner scripts) is documented in `forge/COLAB_GUIDE.md` and `forge/colab/`.

## Benchmark Performance (local, vs own dense baseline)

| Operation | Speed | Allocations |
|-----------|-------|-------------|
| RadioNeuron Pack | **0.24 ns/op** | 0 allocs |
| RadioBus Emit (256 channels) | **1.65 ns/op** | 0 allocs |
| RadioCortex 100K neurons/tick | **1.18 ms** | 0 allocs |
| RadioCortex 1M neurons/tick | **11.8 ms** | 0 allocs |
| ForwardSparse vs Dense | **26.3× faster** | — |
| ForwardQuantum vs Dense | **73.9× faster** | — |
| NeuroRadioCortex 100K tiles/tick | **15.2 ms** | 0 allocs |

---

## Research Foundations

| Theory | Implementation |
|--------|---------------|
| **Sparse Distributed Representations** (Numenta) | `sdr.go`, `sdr_fast.go`, `sdr_pool.go` |
| **Thousand Brains Theory** (Jeff Hawkins) | `thousand_brains.go` |
| **BitNet b1.58** (ternary weights) | `ternary.go`, `neurotexture.go` |
| **Mixture of Experts** (Switch Transformer) | `fractal_cortex.go`, `expert_shard.go` |
| **Global Workspace Theory** (Baars) | `workspace.go` |
| **Predictive Coding** | `predictor.go`, `confidence.go` |
| **Hebbian/STDP Learning** | `error_learning.go`, `reward.go` |
| **Memory Consolidation** (sleep replay) | `sleep_consolidation.go` |
| **Hyperdimensional Computing** | `sdr_attention.go` |

---

## Test Results

```
ok   nexus-cortex/cmd/cortex       1.3s    ✅
ok   nexus-cortex/cmd/cortex-web   9.5s    ✅
ok   nexus-cortex/cortex          86.3s    ✅  (137 tests + 3 fuzz tests)
```

---

## Current Limitations

- **Language generation is not comparable to modern LLMs.** This is a sparse-compute prototype, not a language model.
- **Benchmarks are local** and should be treated as directional until independently reproduced.
- **Some modules are experimental** and need stronger evaluation and ablation testing.
- **Several architecture ideas are exploratory, not proven** — the neuroscience-inspired design is speculative.
- **This project is useful as an AI systems learning/research prototype**, not as a production model.

---

## Best Code Entry Points

If you want to explore the codebase, start here:

| File | What It Shows |
|------|---------------|
| `cortex/sdr_attention.go` | SDR attention and scratch-buffer optimization |
| `cortex/hippocampus.go` | Memory storage and retrieval experiments |
| `cortex/fractal_cortex.go` | Sparse/expert routing experiments |
| `cortex/sleep_consolidation.go` | Memory consolidation via replay |
| `.github/workflows/ci.yml` | Validation pipeline (test, vet, fuzz, security) |

---

## Tech Stack

| Layer | What |
|-------|------|
| **Language** | Go 1.21+ |
| **Compute** | CPU-first, optional CUDA kernels |
| **Weight format** | RGBA32 ternary tiles (0.25 bytes/param) |
| **Storage** | JSON persistence + NTX1 binary format |
| **Dashboard** | Vanilla HTML/CSS/JS |
| **CI** | GitHub Actions (`go test -race`, `go vet`, `govulncheck`, `staticcheck`, `gosec`) |
| **Dependencies** | 4 Go modules: `govaluate`, `mmap-go`, `go-webgpu`, `golang.org/x/sys` |

---

## Neural Dashboard

A local web UI for inspecting cognitive state, emotional compass, memory stats, and interacting with the system in real time.

```bash
go run ./cmd/cortex-web -port 8080 -data-dir ./data/cortex -open
```

---

## Quick Start

### Prerequisites
- Go 1.21+ (tested on 1.26)
- No other dependencies required

### Build & Run

```bash
# Clone
git clone https://github.com/office233/Nexuscortex.git
cd Nexuscortex

# Build
go build ./...

# Train on demo corpus
go run ./cmd/cortex-train \
  -data-dir ./data/cortex \
  -corpus ./data/corpus/general.jsonl \
  -epochs 15 \
  -curriculum=true \
  -revisit=true

# Run evaluation
go run ./cmd/cortex-eval -data-dir ./data/cortex

# Start dashboard
go run ./cmd/cortex-web -port 8080 -data-dir ./data/cortex -open
```

---

## Roadmap

- [x] 10 neural regions with sparse compute
- [x] Curriculum training with surprise-based replay
- [x] Sleep consolidation
- [x] Neural Dashboard
- [x] Autonomous learning loop
- [x] CUDA compute backend
- [x] 137 unit tests + 3 fuzz tests
- [x] CI/CD pipeline
- [ ] NTX binary checkpoint format (mmap-friendly)
- [ ] Expert Atlas with disk-backed experts
- [ ] Top-K expert routing
- [ ] Improved language generator (Broca 2.0)
- [ ] BPE tokenizer (32K vocab)
- [ ] Benchmark arena (1000+ test cases)
- [ ] WebGPU compute backend

---

## FAQ

**Why Go?**
Speed, simplicity, easy concurrency, single binary output, no dependency hell. Go compiles the entire project in 5 seconds.

**Do I need a GPU?**
No. CPU-first design. CUDA is optional and only accelerates sparse ternary forward passes.

**How many parameters?**
~500M with a single cortex block. Scales with FractalCortex blocks.

---

## License

GNU Affero General Public License v3.0 (AGPL-3.0) - see the [LICENSE](LICENSE) file for details.

---

<p align="center">
  ⭐ Star this repo if you're interested in low-level AI systems and sparse compute.
</p>
