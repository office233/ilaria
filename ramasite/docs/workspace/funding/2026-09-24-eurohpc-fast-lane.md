# EuroHPC AI Factory — Fast Lane proposal (draft)

Status: DRAFT, 2026-09-24. Fields marked [[…]] need facts from the applicant; nothing there may be invented.
Call: EuroHPC AI Factory Fast Lane (industrial innovation, SMEs/startups), portal access.eurohpc-ju.europa.eu.

## Applicant

- Organisation: [[legal name, e.g. THERAPIUM GROUP SRL]] — CUI [[…]], founded [[date]], Romania (EU SME)
- Principal investigator: [[Abel Varga]], founder
- Products: **Ilaria** (Romanian-first language model) and **Swypik** (swypik.com, video-native social commerce for Romania/CEE, plus a Romanian multi-tenant ERP)
- Code: https://github.com/office233/ilaria [[must be public before submission]]

## Project title

Ilaria-7B: an open Romanian foundation model with one-shot episodic memory, powering Swypik

## Summary (≈150 words)

No open foundation model is built Romanian-first: Romanian is a minor share of the data of Llama, Qwen or Gemma.
Ilaria is a Romanian–English foundation model trained from scratch, with its own Go inference engine and a
hippocampus-inspired episodic memory that lets the model learn a new fact from a single exposure, with no gradient
update, and keep it across restarts — a capability frozen LLMs structurally lack. Goal: **the strongest open model
for Romanian**, outperforming open models of the same size on Romanian benchmarks, deployed in Swypik (Romanian
social commerce: moderation, shopping assistant, captions and translation, product-quality scoring) and its Romanian
ERP, where facts change daily and retraining is not an option. A 128M prototype trained on one GPU already reaches
held-out perplexity 24.4 on 2025 Wikipedia (Romanian 20.8) and 89% on a one-shot continual-learning benchmark (1%
frozen baseline). We will scale Ilaria through gated steps to 7B parameters on 300B tokens and release everything
openly.

## State of the art and what exists already

| Component | Status (verified, in repo) |
|---|---|
| Ilaria-130M | 12 layers, d 768, RoPE, SwiGLU, 32k byte-level BPE trained on balanced RO/EN; 3.0 B tokens; val ppl 18.1 |
| Corpus pipeline | 5.8 M documents → 3.72 B tokens (FineWeb-2 Romanian, FineWeb-Edu, Wikipedia RO/EN); resumable, sharded |
| Go inference engine | reproduces PyTorch logits on the real weights, max abs. difference 2·10⁻⁵, identical argmax |
| Continual-learning benchmark | 100 invented facts, single exposure, frozen weights: 89% strict accuracy vs 1% baseline, 100% recall after restart |
| Held-out evaluation | 40 Wikipedia articles created in 2025: ppl 24.4 overall, RO 20.8, EN 28.7 |

## Work plan (3 months, gated)

Each step must pass a go/no-go gate before the next one starts, so the allocation is never spent on a failed recipe.

1. **Weeks 1–3 — data and scaling ladder.** Build a 300 B-token corpus (all of FineWeb-2 Romanian, Romanian
   Wikipedia and permissively licensed public text, FineWeb-Edu English, code). Train Ilaria-1B (50 B tokens).
   *Gate:* 1B beats open 1B-class models (e.g. Llama-3.2-1B, Qwen2.5-1.5B) on Romanian held-out perplexity.
2. **Weeks 3–5 — Ilaria-3B** (100 B tokens) with the recipe validated at 1B. *Gate:* predicted scaling curve holds.
3. **Weeks 5–11 — Ilaria-7B** (300 B tokens), multi-node FSDP.
4. **Weeks 11–13 — adaptation and release.** Instruction tuning / distillation for Romanian assistant and commerce
   tasks (Swypik catalogue Q&A, moderation, captioning); memory-consolidation experiments (episodic memory folded
   into LoRA adapters in a "sleep" phase); Romanian benchmark suite (translated MMLU/ARC/HellaSwag-RO, RO reading
   comprehension, one-shot continual-learning benchmark) against same-size open models; open release.

## Resources requested

Estimates use 6·N·D training FLOPs and ~350 TFLOP/s sustained bf16 per H100-class GPU (≈35% MFU); the 130M run
measured ~210 k tokens/s on one GPU, consistent with this.

| Run | Params | Tokens | GPU-hours |
|---|---|---|---|
| Ilaria-1B | 1 B | 50 B | ~250 |
| Ilaria-3B | 3 B | 100 B | ~1,450 |
| **Ilaria-7B** | 7 B | 300 B | **~10,000** |
| SFT / distillation, memory-consolidation ablations, benchmarks | — | — | ~1,500 |
| Restarts, hyper-parameter checks, multi-node inefficiency (+25%) | — | — | ~3,300 |
| **Total** | | | **≈ 16,500 → request 18,000 GPU-hours** |

- Nodes: 4–8 GPUs per node (H100/GH200/A100 class); the 7B run uses FSDP on 4–8 nodes (32–64 GPUs) for ~1 week.
- Storage: ~5 TB (tokenised corpus ≈ 1 TB, checkpoints ≈ 2 TB).
- Software: PyTorch 2.x (bf16, torch.compile, FSDP), Hugging Face tokenizers/datasets; containerised (Apptainer).

## Innovation and impact

- The first open Romanian-first foundation model at 7B scale, trained from scratch on documented data, aiming to be
  the strongest open model for Romanian at its size.
- A reproducible benchmark and mechanism for one-shot continual learning without retraining — directly useful to
  European SMEs whose data changes daily.
- Commercial path inside an EU SME: Swypik (RO/CEE social commerce) and a Romanian ERP; inference runs on small CPU/GPU
  servers thanks to the model size and the Go engine.

## Openness, data and ethics

- Release: code (AGPL-3.0) on GitHub, weights + tokenizer + model card on Hugging Face, technical report on arXiv,
  benchmark data public.
- Data: public web corpora with published licences (FineWeb-2, FineWeb-Edu, Wikipedia); no personal data from Swypik
  users is used for pre-training.
- Risks: small model, limited factual reliability; deployed with retrieval/memory and human-visible provenance
  (every answer records which module produced it).

## Missing before submission

- [[legal entity, CUI, founding date, address]]
- [[repo made public]]
- [[PI CV / short bio, LinkedIn]]
- [[Swypik figures confirmed by the applicant: products, videos, users]]
