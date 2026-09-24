# Arena (EN) — Ilaria vs. published BitNet b1.58 2B4T numbers

Reference column: BitNet b1.58 2B4T Technical Report, Table 1 / Appendix B — https://arxiv.org/abs/2504.12285

Few-shot settings and generative chat-formatting are replicated from that report (see docs/research/2026-09-24-arena-en-design.md). Each run below is appended, not overwritten.

## 2026-09-24 — ilaria130m

Settings: `ilaria, brain_dir=data/forge/brain-a, device=cuda, float32, unbatched`, tasks=`arc_challenge,arc_easy,hellaswag,winogrande,piqa,mmlu`, limit=`None` (full test sets; run locally on a GTX 1660 Ti, ~1.4 h for the six log-likelihood tasks; gsm8k/ifeval — generative, ~10 h unbatched at 128M — not run yet)

| Task | Metric | N-shot | Value | BitNet 2B4T (paper) |
|---|---|---|---|---|
| arc_challenge | acc,none | 0 | 0.1800 | — |
| arc_challenge | acc_norm,none | 0 | 0.2355 | 0.4991 |
| arc_easy | acc,none | 0 | 0.4562 | — |
| arc_easy | acc_norm,none | 0 | 0.4129 | 0.7479 |
| hellaswag | acc,none | 0 | 0.2761 | — |
| hellaswag | acc_norm,none | 0 | 0.2853 | 0.6844 |
| piqa | acc,none | 0 | 0.5963 | — |
| piqa | acc_norm,none | 0 | 0.5827 | 0.7709 |
| winogrande | acc,none | 0 | 0.5351 | 0.7190 |
| mmlu | acc,none |  | 0.2495 | 0.5317 |
| - humanities | acc,none |  | 0.2410 | — |
| - formal_logic | acc,none | 5 | 0.2222 | — |
| - high_school_european_history | acc,none | 5 | 0.2909 | — |
| - high_school_us_history | acc,none | 5 | 0.2451 | — |
| - high_school_world_history | acc,none | 5 | 0.2658 | — |
| - international_law | acc,none | 5 | 0.2810 | — |
| - jurisprudence | acc,none | 5 | 0.2500 | — |
| - logical_fallacies | acc,none | 5 | 0.2331 | — |
| - moral_disputes | acc,none | 5 | 0.2486 | — |
| - moral_scenarios | acc,none | 5 | 0.2480 | — |
| - philosophy | acc,none | 5 | 0.1865 | — |
| - prehistory | acc,none | 5 | 0.2160 | — |
| - professional_law | acc,none | 5 | 0.2458 | — |
| - world_religions | acc,none | 5 | 0.1930 | — |
| - other | acc,none |  | 0.2562 | — |
| - business_ethics | acc,none | 5 | 0.1400 | — |
| - clinical_knowledge | acc,none | 5 | 0.2302 | — |
| - college_medicine | acc,none | 5 | 0.2139 | — |
| - global_facts | acc,none | 5 | 0.1800 | — |
| - human_aging | acc,none | 5 | 0.2870 | — |
| - management | acc,none | 5 | 0.1748 | — |
| - marketing | acc,none | 5 | 0.2735 | — |
| - medical_genetics | acc,none | 5 | 0.3100 | — |
| - miscellaneous | acc,none | 5 | 0.2401 | — |
| - nutrition | acc,none | 5 | 0.2680 | — |
| - professional_accounting | acc,none | 5 | 0.2979 | — |
| - professional_medicine | acc,none | 5 | 0.3235 | — |
| - virology | acc,none | 5 | 0.2831 | — |
| - social sciences | acc,none |  | 0.2385 | — |
| - econometrics | acc,none | 5 | 0.2807 | — |
| - high_school_geography | acc,none | 5 | 0.2374 | — |
| - high_school_government_and_politics | acc,none | 5 | 0.2280 | — |
| - high_school_macroeconomics | acc,none | 5 | 0.2308 | — |
| - high_school_microeconomics | acc,none | 5 | 0.2857 | — |
| - high_school_psychology | acc,none | 5 | 0.1982 | — |
| - human_sexuality | acc,none | 5 | 0.2519 | — |
| - professional_psychology | acc,none | 5 | 0.2500 | — |
| - public_relations | acc,none | 5 | 0.2091 | — |
| - security_studies | acc,none | 5 | 0.2408 | — |
| - sociology | acc,none | 5 | 0.2587 | — |
| - us_foreign_policy | acc,none | 5 | 0.2500 | — |
| - stem | acc,none |  | 0.2661 | — |
| - abstract_algebra | acc,none | 5 | 0.2100 | — |
| - anatomy | acc,none | 5 | 0.3037 | — |
| - astronomy | acc,none | 5 | 0.1908 | — |
| - college_biology | acc,none | 5 | 0.2778 | — |
| - college_chemistry | acc,none | 5 | 0.1800 | — |
| - college_computer_science | acc,none | 5 | 0.2900 | — |
| - college_mathematics | acc,none | 5 | 0.2100 | — |
| - college_physics | acc,none | 5 | 0.2157 | — |
| - computer_security | acc,none | 5 | 0.3000 | — |
| - conceptual_physics | acc,none | 5 | 0.2638 | — |
| - electrical_engineering | acc,none | 5 | 0.2276 | — |
| - elementary_mathematics | acc,none | 5 | 0.2434 | — |
| - high_school_biology | acc,none | 5 | 0.2032 | — |
| - high_school_chemistry | acc,none | 5 | 0.2956 | — |
| - high_school_computer_science | acc,none | 5 | 0.2100 | — |
| - high_school_mathematics | acc,none | 5 | 0.2593 | — |
| - high_school_physics | acc,none | 5 | 0.3046 | — |
| - high_school_statistics | acc,none | 5 | 0.4815 | — |
| - machine_learning | acc,none | 5 | 0.3304 | — |

