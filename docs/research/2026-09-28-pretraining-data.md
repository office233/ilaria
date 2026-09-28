# Training data for a from-scratch Ilaria model (English only)

Date: 2026-09-28. Scope: the best openly downloadable data for pretraining a new
model from zero, then post-training it. Licenses were deliberately not a filter.
Romanian is out of scope for this model.

Every entry below comes from a web search on this date; the sources are listed
at the end, and every Hugging Face id was checked to exist on this date.
Numbers are as reported by the cited source, not re-measured here.

## 1. General web text (pretraining backbone)

| Dataset | HF id | Size | Evidence |
|---|---|---|---|
| Nemotron-CC-HQ | not on HF: Common Crawl contrib (data.commoncrawl.org/contrib/Nemotron); v2 is `nvidia/Nemotron-CC-v2` | 1.1T tokens (HQ subset of 6.3T) | Best of 8 open web datasets in LAION open-sci-ref (0.13B-1.7B models, up to 1T tokens); a 1.7B model on 1T tokens nearly matches SmolLM2 at 11x less compute. Clear MMLU lead (contains synthetic Q&A). |
| Nemotron-CC-v2.1 | `nvidia/Nemotron-CC-v2.1` | 2.5T new tokens | Dec 2025 refresh: 3 new snapshots, synthetic rephrasing, translation to English. No independent head-to-head yet. |
| DCLM-baseline | `mlfoundations/dclm-baseline-1.0` | ~4T tokens | Second in open-sci-ref; wins Lambada. ~80% fuzzy duplicates per Nemotron-CC paper. |
| FineWeb-Edu | `HuggingFaceFW/fineweb-edu` | 1.3T tokens | Third in open-sci-ref; used by SmolLM2/3. |

## 2. Code

| Dataset | HF id | Size | Evidence |
|---|---|---|---|
| Stack-Edu | `HuggingFaceTB/stack-edu` | 125B tokens | StarCoder2Data filtered by per-language quality classifiers; better HumanEval than unfiltered (SmolLM2). |
| Nemotron-CC-Code-v1 | `nvidia/Nemotron-CC-Code-v1` | 428B tokens | Code pages from Common Crawl, Lynx + LLM cleanup. |
| Nemotron-Pretraining-Code-v2 | `nvidia/Nemotron-Pretraining-Code-v2` | ~180B real + synthetic (Q&A 213B, rewriting 77B, code review 71B, student-teacher 28B, transpilation 24B) | Filtered GitHub plus synthetic code data. |
| OpenCoder annealing corpus | `OpenCoder-LLM/opc-annealing-corpus` | - | Algorithmic code, rewritten code and Q&A; ablations show gains in the annealing phase. |
| SwallowCode (rewritten code) | see arXiv 2505.02881 | - | LLM-rewritten code beats filter-only data on code benchmarks. |

## 3. Math

| Dataset | HF id | Size | Evidence |
|---|---|---|---|
| Nemotron-CC-Math-4+ / 3+ | `nvidia/Nemotron-CC-Math-v1` | 133B tokens total | ICLR 2026. Beat FineMath and MegaMath: MATH +4.8 (4+ vs FineMath-4+, 100B), +9.6 (3+ vs FineMath-3+, 300B). Comparison run by NVIDIA on an 8B checkpoint. |
| FineMath-4+ | `HuggingFaceTB/finemath` | - | Second on MATH in the 100B test; used by SmolLM3. |
| InfiWebMath-4+, MegaMath | `HuggingFaceTB/finemath` (infiwebmath-4plus), `IFM/MegaMath` (formerly LLM360/MegaMath) | - | Used by SmolLM3 stage 2. |

## 4. Annealing (final pretraining phase)

| Dataset | HF id | Notes |
|---|---|---|
| Nemotron-Pretraining-Specialized-v1 | `nvidia/Nemotron-Pretraining-Specialized-v1` | Synthetic STEM reasoning and scientific coding; used for annealing in arXiv 2607.16051. |
| OpenMathReasoning | `nvidia/OpenMathReasoning` | Added by SmolLM3 in its decay phase. |
| opc-annealing-corpus | `OpenCoder-LLM/opc-annealing-corpus` | See code. |

## 5. Post-training: instructions and reasoning

| Dataset | HF id | Notes |
|---|---|---|
| SmolTalk2 | `HuggingFaceTB/smoltalk2` | ~3.4M samples, think / no_think splits; SmolLM3's post-training mix. |
| OpenThoughts3 | `open-thoughts/OpenThoughts3-1.2M` | Strongest published reasoning SFT (math, code, science); ~14k tokens per example on average. |
| Nemotron-Posttraining-v3 | NVIDIA HF collection (Nemotron 3 Ultra, June 2026) | Largest; agentic and multi-turn focus. |
| Llama-Nemotron-Post-Training-Dataset | `nvidia/Llama-Nemotron-Post-Training-Dataset` | 40M+ samples, reasoning on/off. |

## 6. Post-training: tool / function calling

| Dataset | HF id | Notes |
|---|---|---|
| APIGen-MT-5k | `Salesforce/APIGen-MT-5k` | Multi-turn; xLAM-2-8B beat GPT-4o on BFCL v3. |
| ToolMind | see arXiv 2511.15718 | 111,941 samples with reasoning, built from When2Call, Glaive-v2, ToolACE, BUTTONInstruct, APIGen-MT-5k, tau-bench train and synthetic trajectories. |
| xlam-function-calling-60k + xlam-irrelevance-7.5k | `Salesforce/xlam-function-calling-60k` (gated), `MadeAgents/xlam-irrelevance-7.5k` | Execution-verified single-turn calls; when not to call. |
| ToolACE | `Team-ACE/ToolACE` | ToolACE-8B beats GPT-4o-mini. |
| FunReason-MT | - | Multi-turn with environment-API graphs and chain of thought. |
| Our own | Swyp Forge, Ilaria Go tools | Verified by `swyp judge` / real tool execution. |

Notes from the tool-use literature: RL beats SFT on the same data (Nemotron-Research-Tool-N1);
filtering to the best 8K examples beat the full 16K (ToolRM); argument/linguistic diversity
raised BFCL non-live 77.8 -> 85.2 (arXiv 2601.17829). Never train on BFCL data.

## 7. Proven recipe to copy: SmolLM3 (3B, 11.2T tokens)

- Stage 1 (0-8T): 85% web (FineWeb-Edu, DCLM, FineWeb2), 12% code (Stack v2, PRs, notebooks, issues, StackExchange), 3% math.
- Stage 2 (8-10T): 75% web, 15% code (adds Stack-Edu), 10% math (FineMath4+, InfiWebMath4+, MegaMath).
- Stage 3 decay (10-11.1T): more math and code, adds OpenMathReasoning and other reasoning data.
- WSD schedule, peak LR 2e-4, decay over the last 10%, 4096 context.
- Post-training on SmolTalk2.

For Ilaria (English only) the web share would come from Nemotron-CC-HQ, code from
Stack-Edu (+ Nemotron code), math from Nemotron-CC-Math-4+, annealing from
Specialized-v1 / OpenMathReasoning / opc-annealing, then SmolTalk2 + tool data.

## Access

NVIDIA datasets and xLAM are gated: accept the terms on Hugging Face with the
account that downloads them and use an HF token on Colab.

## Sources

- Nemotron-CC: https://arxiv.org/abs/2412.02595
- Open-sci-ref-0.01: https://arxiv.org/abs/2509.09009 , https://laion.ai/blog/open-sci-ref-001/
- SmolLM3: https://huggingface.co/blog/smollm3 , https://huggingface.co/collections/HuggingFaceTB/smollm3-pretraining-datasets-685a7353fdc01aecde51b1d9 , https://github.com/huggingface/smollm/blob/main/text/pretraining/smollm3/stage1_8T.yaml
- SmolLM2: https://arxiv.org/pdf/2502.02737
- Nemotron-CC-Math: https://arxiv.org/abs/2508.15096 , https://huggingface.co/datasets/nvidia/Nemotron-CC-Math-v1
- OpenCoder: https://arxiv.org/pdf/2411.04905 , https://huggingface.co/datasets/OpenCoder-LLM/opc-annealing-corpus
- SwallowCode: https://arxiv.org/pdf/2505.02881
- Nemotron pretraining v2.1: https://huggingface.co/datasets/nvidia/Nemotron-CC-v2.1 , https://huggingface.co/datasets/nvidia/Nemotron-Pretraining-Code-v2 , https://huggingface.co/datasets/nvidia/Nemotron-Pretraining-Specialized-v1 , https://arxiv.org/pdf/2607.16051
- OpenThoughts: https://arxiv.org/pdf/2506.04178
- SmolTalk2: https://huggingface.co/datasets/HuggingFaceTB/smoltalk2
- Nemotron post-training: https://huggingface.co/datasets/nvidia/Llama-Nemotron-Post-Training-Dataset , https://research.nvidia.com/labs/nemotron/Nemotron-3-Ultra/
- BFCL V4: https://gorilla.cs.berkeley.edu/leaderboard.html
- APIGen-MT: https://arxiv.org/pdf/2504.03601
- ToolMind: https://arxiv.org/pdf/2511.15718
- Nemotron-Research-Tool-N1: https://arxiv.org/pdf/2505.00024
- ToolRM: https://arxiv.org/pdf/2509.11963
- Function-calling diversity: https://arxiv.org/pdf/2601.17829
- Dataset list: https://github.com/mlabonne/llm-datasets
