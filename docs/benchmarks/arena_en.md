# Arena (EN) — Ilaria vs. published BitNet b1.58 2B4T numbers

Reference column: BitNet b1.58 2B4T Technical Report, Table 1 / Appendix B — https://arxiv.org/abs/2504.12285

Few-shot settings and generative chat-formatting are replicated from that report (see docs/research/2026-09-24-arena-en-design.md). Each run below is appended, not overwritten.

## 2026-09-24 — ilaria130m

Settings: `ilaria, brain_dir=data/forge/brain-a, device=cuda, float32, unbatched`, tasks=`arc_easy,hellaswag`, limit=`20`

| Task | Metric | N-shot | Value | BitNet 2B4T (paper) |
|---|---|---|---|---|
| arc_easy | acc,none | 0 | 0.5500 | — |
| arc_easy | acc_norm,none | 0 | 0.2000 | 0.7479 |
| hellaswag | acc,none | 0 | 0.3000 | — |
| hellaswag | acc_norm,none | 0 | 0.2500 | 0.6844 |

## 2026-09-24 — bitnet2b

Settings: `hf, pretrained=data/pretrained/bitnet-b1.58-2B-4T, dtype=bfloat16, batch_size=1, device=cuda`, tasks=`arc_easy`, limit=`5`

| Task | Metric | N-shot | Value | BitNet 2B4T (paper) |
|---|---|---|---|---|
| arc_easy | acc,none | 0 | 0.6000 | — |
| arc_easy | acc_norm,none | 0 | 0.6000 | 0.7479 |

