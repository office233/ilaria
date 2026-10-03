# EuroHPC applications — Swypik / SwypikOS / Ilaria (2026-09-29)

Portal: https://access.eurohpc-ju.europa.eu/ (one account, one proposal per call).
Five proposals, each with a different scope so none duplicates another. Paste the shared
blocks (A–D) into every form, then the call-specific section. Only the items in [[ ]] need
the applicant.

| Call | Cut-off | What we ask for |
|---|---|---|
| AI Factory Fast Lane | ~1 day | 12,000 GPU-h (the form requires more than 10,000), 3 months: Ilaria IMC-1B + IMC-3B (section 1) |
| AI Factory Large Scale | ~2 days | 64,000 GPU-h (Leonardo A100): IMC-3B/7B and the Myriad experts (section 2) |
| AI Factory Playground | 94 days | small allocation: port and validate the stack on the system (section 3) |
| Development Access | ~2 days | node-hours, up to 1 year: ternary kernels and on-device runtime (section 4) |
| Benchmark Access | open | node-hours, up to 3 months: multi-node scaling data for Extreme Scale (section 5) |

Not applied: AI Factory for Science (academic / EU-funded projects only), Quantum (not our field),
Extreme Scale (needs the scaling evidence that Benchmark Access will produce).

---

## A. Applicant (all forms)

- Organisation: THERAPIUM GROUP SRL — EU SME / startup, VAT RO52367116 (ANAF; RO38031530 used in early drafts is wrong), Reg. Com. J2025063028002, founded 2025-08-22, Str. Duiliu Zamfirescu nr. 1, sat Dumbrăveni, com. Dumbrăveni, jud. Vrancea, 627105, Romania
- EU PIC number (if requested): [[PIC]]
- Principal investigator: Abel Varga, Founder & CTO — abel@swypik.com — [[LinkedIn URL]]
- Products: **Swypik** (https://swypik.com), **SwypikOS**, **Swyp** and the **Ilaria** AI that powers them
- Code: https://github.com/office233/ilaria (public)
- Programmes: Y Combinator W2027 application in review; Google for Startups Immersion EMEA (accepted,
  Oct 2026); Microsoft for Startups Founders Hub (Azure credits)

## B. The company and its products (all forms)

**Swypik** is a video-native commerce platform: shoppers discover products through short videos and buy in the
same flow, and merchants run their business on Swypik's multi-tenant ERP (catalogue, orders, e-invoicing). It is
live at https://swypik.com with a catalogue of [[number]] products and [[number]] product videos in 7 languages.

**SwypikOS** is the operating environment built around Swypik and Ilaria: a native desktop (a single Go/Win32
executable, no browser runtime) with an approval-gated AI agent that plans one step at a time, shows every step and
runs nothing without the user's consent; its own search engine (BM25F index of the user's files and approved
sites, no third-party search API); a verified control kernel in which every effect (file, process, network, device)
needs an explicit capability; and a Compute Fabric in which users may lend idle GPUs to train Ilaria under signed,
verified jobs. A native kernel seed (x86-64 / ARM64 / RISC-V) and a Linux live-image prototype are in development.

**Swyp** is our programming language with a verifier: functions carry contracts that are checked exhaustively on
their domain, so an AI-written program is either proven against its contract or rejected with a counterexample.

**Ilaria** is the AI inside all of it: our own models, trained from scratch, plus a Go runtime and an episodic
memory. Because SwypikOS runs Ilaria **on the user's device**, the models must be small, fast and cheap to run —
which is why Ilaria's language models are **native 1.58-bit (ternary) models**: every weight is −1, 0 or +1, so
inference uses integer additions instead of multiplications and a 1B model needs only ~0.2–0.4 GB of weights.

## C. What already exists (measured; all in the public repo)

| Item | Result |
|---|---|
| Ternary training from scratch | IMC architecture (GQA, RMSNorm, gated FFN, tied head) with native ternary weights and 8-bit activations, straight-through gradients |
| Ternary vs full precision, 125M params, 1B tokens | validation loss 3.297 (perplexity 27.0) ternary vs 3.339 (28.2) bf16 |
| Scaling | IMC-250M ternary training now: validation loss 3.30 after 0.8B of ~4.6B tokens, 121k tokens/s on one RTX PRO 6000 |
| Data | 9.1B curated tokens (DCLM-baseline, FineWeb-Edu, OpenCoder code, Nemotron-CC-Math, FineMath), 65,536-token tokenizer; extension to ~20B tokens running |
| Training software | chunked cross-entropy, multi-GPU DDP (torchrun), exact resume, 205 automated tests |
| Runtime | Go engine that already runs ternary BitNet-format models with a native integer kernel (RGBA-packed weights) and CUDA decoding; matches PyTorch logits to 2·10⁻⁵ |
| Agent + verifier | Swyp verifier grading AI-written code; ternary 2B baseline: 11 of 20 held-out tasks solved first try after our parser fix |
| Memory | 89% accuracy recalling 100 newly taught facts with frozen weights (1% without memory) |

## D. Data, openness, ethics (all forms)

- Training data: public corpora with published licences; no Swypik or SwypikOS user data is used for training.
- Outputs: code, recipes and evaluation suites public on GitHub; technical reports; weights released where
  data licences allow. SME confidentiality option used only for commercial fine-tunes.
- Safety: the agent never acts without user approval; code is accepted only when a verifier (compiler, tests,
  Swyp contracts) passes it; every answer records which module produced it.
- A final report within 3 months of each allocation; EuroHPC acknowledged in all outputs.

---

## 1. AI Factory Fast Lane — "Ilaria IMC-1B: a native ternary language model for on-device agents in SwypikOS"

**Abstract.** SwypikOS runs its AI agent on the user's own device, so its language model must be small, fast and
private. We train Ilaria IMC — language models with native 1.58-bit weights, trained from scratch — and have shown on
one GPU that ternary training matches full precision at 125M parameters (perplexity 27.0 vs 28.2 on 1B tokens). We
request 12,000 GPU-hours for three months to train IMC-1B on 300B tokens with a full-precision control and IMC-3B on
150B tokens, then teach it
verified tool use for the SwypikOS agent (steps checked by compilers, tests and Swyp contracts). The result is the base
model that ships inside SwypikOS and Swypik.

**Plan (gated).**
1. Month 1 — port and verify throughput; IMC-1B ternary on 20B tokens and a bf16 control. *Gate:* ternary within 2% of
   bf16 validation loss and clearly better than IMC-250M.
2. Month 2 — continue IMC-1B to 300B tokens with a final high-quality annealing phase; IMC-3B on 150B tokens. *Gate:* competitive with open
   1B-class models on HellaSwag, ARC, PIQA, MMLU.
3. Month 3 — supervised and RL training on verified agent trajectories (SwypikOS tools, Swyp tasks, code repair);
   held-out evaluation; release of recipes and evaluation code.

**Resources.** 6·N·D FLOPs at ~400 TFLOP/s sustained per H100-class GPU, checked against measured throughput.

| Item | GPU-hours |
|---|---|
| IMC-1B ternary, 300B tokens | ~1,250 |
| IMC-1B bf16 control, 20B tokens | ~90 |
| IMC-3B ternary, 150B tokens | ~1,900 |
| Agent SFT + RL rollouts with verifiers | ~3,000 |
| Evaluations, ablations (learning rate, data mix, FP8, scaling sweep 125M–1B) | ~3,500 |
| Restarts, debugging | ~2,260 |
| **Request** | **12,000** |

Single system, 8–32 GPUs per job, ~2 TB storage, PyTorch 2.x (bf16, torch.compile, DDP/FSDP) in an Apptainer container.

---

## 2. AI Factory Large Scale — "Myriad: a society of ternary Ilaria models for SwypikOS"

**Abstract.** Instead of one large model, SwypikOS will run a resident ternary model on every device and consult
specialised expert models through a learned router, so capability grows by adding experts rather than by making one
model bigger. We request 64,000 GPU-hours on Leonardo BOOSTER over 12 months to (1) scale Ilaria IMC to 3B and, if gates pass, 7B parameters, (2) train
16 ternary specialists (code, maths, tools, commerce, ERP, search, languages) with a router, and (3) test the central
claim — N small specialists plus a router beat one dense model of the same total size at equal compute — on public
benchmarks and on verified SwypikOS agent tasks.

**Plan (gated).**
1. Months 1–3 — IMC-3B ternary on 600B tokens (+ bf16 control at 50B). *Gate:* ternary within 2% of bf16.
2. Months 4–6 — 16 specialists branched from IMC-1B/3B, 20B domain tokens each; router training.
   *Gate:* 4 × 1B + router beats a dense 4B at equal compute.
3. Months 7–10 — IMC-7B ternary on 1.5T tokens if gate 2 passes, otherwise more specialists.
4. Months 11–12 — agent RL with verifiers, evaluation, release.

| Item | GPU-hours |
|---|---|
| IMC-3B ternary 300B tokens | ~12,000 |
| IMC-3B bf16 control 30B tokens | ~1,200 |
| 16 specialists (~1B, 20B domain tokens each) + router + dense 4B baseline | ~8,500 |
| IMC-7B ternary 250B tokens (only if gates 1–2 pass) | ~23,300 |
| Agent RL with verifiers, evaluations, ablations | ~10,700 |
| Restarts, multi-node overhead (~15%) | ~8,300 |
| **Request** | **64,000** |

Submitted form (DRAFT-23775, 2026-09-29): only Leonardo BOOSTER (A100 64 GB) was offered, so estimates use
6·N·D FLOPs at ~125 TFLOP/s sustained per A100 (4.5e17 FLOPs per GPU-hour).

Multi-node FSDP on 32–128 GPUs, ~20 TB storage.

---

## 3. AI Factory Playground — "Porting the Ilaria training stack for SwypikOS"

**Abstract.** Short access to port and validate our training stack before larger allocations: containerise the
Ilaria trainer, reproduce our single-GPU results on the AI Factory system, and measure multi-GPU throughput for
IMC-250M and IMC-1B. Deliverables: a verified container, throughput tables and a small IMC-500M run.

**Resources.** The standard Playground allocation ([[max offered by the chosen system]]), one month.

---

## 4. Development Access — "Integer-only ternary inference and training kernels for SwypikOS devices"

**Abstract.** Ternary models only pay off with kernels that exploit them. We will develop and optimise (1) GPU
training kernels that fuse ternary weight quantisation and chunked cross-entropy, (2) integer-add inference kernels
(packed 1.6-bit storage, 2-bit compute layout) for CPUs and GPUs, and (3) the Go runtime that SwypikOS embeds, and
validate numerical equivalence against PyTorch at every step. Code is released openly.

**Resources.** [[node-hours as offered by the call; e.g. 2,000 GPU node-hours]] over up to 12 months.

---

## 5. Benchmark Access — "Multi-node scaling of native ternary training"

**Abstract.** Measure strong and weak scaling of Ilaria IMC training (1B–7B, DDP/FSDP, 8–256 GPUs), communication
overhead of low-communication training (DiLoCo-style outer steps that SwypikOS's Compute Fabric will use across
devices), and I/O for large token streams. The results feed a future Extreme Scale proposal.

**Resources.** [[node-hours offered by the call]] over up to 3 months.

---

## Still needed from the applicant

- [[company founding date and registered address]]
- [[EU PIC number, if requested]]
- [[LinkedIn URL / short CV of the PI]]
- [[Swypik catalogue figures: products, videos (confirm current numbers)]]
