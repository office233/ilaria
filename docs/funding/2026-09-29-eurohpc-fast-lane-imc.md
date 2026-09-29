# EuroHPC AI Factory Fast Lane — proposal text (Ilaria IMC)

Call: EuroHPC AI Factory Fast Lane (industrial innovation, SMEs/startups), portal
https://access.eurohpc-ju.europa.eu/calls/59 — up to 50,000 GPU-hours, 1–3 months, single system.
Status: ready to paste, 2026-09-29. Items in [[ ]] must be filled in by the applicant.

## Applicant

- Organisation: THERAPIUM GROUP SRL, Romania (EU SME, startup), VAT/CUI RO38031530, founded [[date]], [[registered address]]
- EU PIC number (if the form asks for it): [[PIC]]
- Principal investigator: Abel Varga, founder & CTO, abel@swypik.com — [[LinkedIn / short CV]]
- Products: Swypik (https://swypik.com, video-native social commerce for Romania/CEE with a multi-tenant ERP)
  and Ilaria (the company's own AI model and runtime that powers Swypik)
- Code: https://github.com/office233/ilaria (public)

## Project title

Ilaria IMC: native 1.58-bit (ternary) language models trained from scratch for on-device agents

## Abstract (≈150 words)

Ilaria is an EU startup's own AI stack: a Go runtime, an episodic memory and a family of language models trained
from scratch with native ternary weights {-1, 0, +1} (1.58 bits). Ternary models run with additions instead of
multiplications and fit on phones and cheap servers, which is what our product Swypik needs: private, offline-capable
assistants for commerce and business operations on the user's own device. On one GPU we have already shown that
native ternary training matches full precision: a 125M-parameter model trained on 1B tokens reaches validation
perplexity 27.0 ternary vs 28.2 in bf16, and a 250M ternary model is training now on 9.1B curated tokens. We request
EuroHPC compute to climb the scaling ladder to 1B and 3B parameters on 20–150B tokens, train specialised ternary
experts that cooperate through a learned router, and teach them verified tool use (compiler- and test-checked
trajectories). Results, recipes and evaluation code are published openly.

## Why this matters (industrial innovation)

- Frontier models need data-centre GPUs and send user data to third-party clouds. A ternary 1B model needs
  ~0.2–0.4 GB of weights and integer additions only, so it can run locally on phones and laptops, in the EU,
  under GDPR, without per-request API costs.
- Swypik (Romanian/CEE social commerce + ERP) is the first deployment: shopping assistant, moderation, captions,
  ERP assistant — tasks where data is private and changes daily.
- Open question with European value: does native ternary training keep matching full precision at 1B–3B scale, and
  do several small ternary specialists plus a router beat one dense model of the same total size? No public study
  answers this for models trained from scratch on open data.

## What already exists (measured, reproducible, in the public repo)

| Item | Result |
|---|---|
| Training stack | PyTorch trainer for our IMC architecture (GQA, RMSNorm, gated FFN, tied head) with native ternary training (8-bit activations, straight-through gradients), chunked cross-entropy, multi-GPU DDP (torchrun), exact resume; 205 automated tests |
| Data pipeline | 9.1B English tokens from DCLM-baseline, FineWeb-Edu, OpenCoder code, Nemotron-CC-Math and FineMath with a 65,536-token tokenizer; extension to ~20B tokens running |
| Ternary vs bf16, 125M, 1B tokens | val loss 3.297 (ppl 27.0) ternary vs 3.339 (ppl 28.2) bf16 |
| Throughput (1× RTX PRO 6000) | 197k tokens/s at 125M, 121k tokens/s at 250M ternary |
| Runtime | Go inference engine that already runs ternary BitNet-format models with a native kernel (RGBA-packed weights, integer adds) and CUDA decoding; reproduces PyTorch logits (max abs. diff 2·10⁻⁵). Loading IMC checkpoints is part of month 3 |
| Memory | one-shot episodic memory: 89% strict accuracy on 100 newly taught facts with frozen weights (1% baseline) |

## Work plan (3 months, gated)

Every stage has a go/no-go gate measured before the next starts, so the allocation is not spent on a failing recipe.

1. **Month 1 — IMC-1B base.** Port the validated recipe to the AI Factory system, verify multi-node throughput,
   train IMC-1B ternary on 20B tokens, then continue to 100B tokens. Control: IMC-1B bf16 on 20B tokens.
   *Gate:* ternary within 2% of bf16 validation loss; IMC-1B clearly better than IMC-250M; competitive with open
   1B-class models on standard benchmarks (HellaSwag, ARC, PIQA, MMLU).
2. **Month 2 — IMC-3B and specialists.** IMC-3B ternary on 150B tokens. Branch four IMC-1B specialists (code, math,
   tools, general) with 10B domain tokens each and train a router.
   *Gate:* 4 × 1B specialists + router beat a single dense model of equal total size at equal compute.
3. **Month 3 — verified tool use and release.** Supervised and RL training on trajectories whose outcome is checked
   by compilers, unit tests and our Swyp contract verifier; evaluation on held-out coding/repair/tool tasks and BFCL;
   public release of recipes, evaluation code and a technical report.

## Resources requested

GPU-hours estimated from 6·N·D training FLOPs at ~400 TFLOP/s sustained bf16 per H100-class GPU, checked against our
measured single-GPU throughput.

| Run | Params | Tokens | GPU-hours |
|---|---|---|---|
| IMC-1B ternary | 1B | 100B | ~450 |
| IMC-1B bf16 control | 1B | 20B | ~90 |
| IMC-3B ternary | 3B | 150B | ~1,900 |
| 4 specialists (1B, 10B tokens each) + router + dense baseline of equal size | — | — | ~900 |
| Tool-use SFT + RL rollouts with verifiers | — | — | ~1,500 |
| Evaluations, ablations (learning rate, data mix, FP8) | — | — | ~1,200 |
| Restarts, multi-node inefficiency, debugging (+30%) | — | — | ~1,800 |
| **Total** | | | **≈ 7,800 → request 8,000 GPU-hours over 3 months** |

- System: any H100/GH200/A100-class AI Factory system (single system as required); runs use 8–32 GPUs.
- Storage: ~3 TB (tokenised data ≈ 0.5 TB, checkpoints ≈ 1.5 TB).
- Software: PyTorch 2.x (bf16, torch.compile, DDP/FSDP), Hugging Face tokenizers/datasets; containerised (Apptainer).
- Team: PI with hands-on experience training the models above; the trainer and data tools are already written and tested.

## Openness, data and ethics

- Data: public web corpora with published licences (DCLM, FineWeb-Edu, OpenCoder, Nemotron-CC-Math, FineMath);
  no personal data from Swypik users is used for training.
- Release: code and evaluation on GitHub; technical report; model weights released where the data licences allow.
- Risks: small models have limited factual reliability; deployment uses retrieval/episodic memory and verifiers
  (compiler/test results) rather than unverified generation.
- Final report within 3 months of the allocation end; EuroHPC acknowledged in all outputs.

## Before submitting

- [[company founding date and registered address]]
- [[EU PIC number, if the form requires it (register at the EU Funding & Tenders Portal)]]
- [[PI LinkedIn or short CV]]
