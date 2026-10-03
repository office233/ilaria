# IMC-125M rights/provenance engineering review

Date: 2026-09-30

This document is engineering evidence, not legal approval. Canonical rights
state remains fail-closed until the explicit review decision is completed.

## Source posture

| Source | Engineering posture | Evidence / reason |
|---|---|---|
| apache_nuttx | low ambiguity after filtering | Upstream states Apache-2.0 or Apache-compatible; local corpus accepts only allowlisted per-file SPDX and pins every accepted file/revision. |
| freebsd_licensed_tree | low-to-moderate | FreeBSD documents a mixed-license tree and SPDX policy; local corpus is built from a strict permissive SPDX allowlist and excludes non-allowlisted files. |
| freertos_kernel | low ambiguity | Official FreeRTOS documentation states the kernel is MIT and commercial use is permitted; acquisition is scoped to the kernel repository. |
| openscience_reasoning_2 | low ambiguity | NVIDIA describes the dataset as synthetic, CC-BY-4.0, intended for training/evaluation and ready for commercial use. |
| zephyr | low-to-moderate after filtering | Zephyr is Apache-2.0 overall but documents imported components under other licenses; local corpus uses per-file SPDX/REUSE filtering and pinned provenance. |
| opencode_reasoning_split0 | moderate | NVIDIA/DeepMind expose CC-BY-4.0 dataset licensing but CodeContests warns that third-party source material can have separate terms. The Ilaria subset is now hard-limited to code_contests + CC-BY-4.0 and preserves source/platform provenance. |
| wiki_en | moderate | Wikimedia permits reuse including commercial reuse subject to attribution/license requirements. Production corpus must retain article provenance and handle attribution/share-alike for redistributed corpus artifacts. The regenerated Ilaria source now preserves article id/title/url per chunk. |
| openmath_reasoning_cot | high attention | NVIDIA licenses OpenMathReasoning CC-BY-4.0, but 96,238 of the first 100,000 accepted Ilaria rows originate from AoPS forums and 3,762 from MATH. AoPS Terms include restrictive content/service-use language, so this source should remain pending or be replaced for a conservative production posture. |

## Local provenance measurements

### OpenCodeReasoning split_0

Current Ilaria subset: 120,000 rows.

- dataset: code_contests = 120,000
- embedded license: cc-by-4.0 = 120,000
- sources:
  - Codeforces: 66,035
  - AIZU: 19,410
  - HackerEarth: 13,957
  - AtCoder: 11,640
  - CodeChef: 8,958

The production reader now rejects any row that is not exactly
`dataset=code_contests` and `license=cc-by-4.0`.

### OpenMathReasoning CoT

Pinned revision:
`d3d08664755704f422af97d43a7ff0ded4bd95df`

First 100,000 accepted rows, matching the Ilaria candidate selection:

- aops_c6_high_school_olympiads: 51,148
- aops_c4_high_school_math: 24,037
- aops_c7_college_math: 18,065
- aops_c5_contests_amp_programs: 2,988
- MATH_training_set: 3,762

Total AoPS-derived: **96,238 / 100,000**.

The regenerated corpus preserves `problem_source`, `generation_model`,
`problem_type`, `expected_answer` and `used_in_kaggle` without changing
the training text.

### Wikipedia EN

The regenerated corpus stores, for each chunk when available:

- article id
- title
- canonical article URL
- deterministic article/chunk path

This supplies an article-level attribution path instead of retaining text alone.

## Public evidence checked

- Apache NuttX repository/license and SPDX headers
- FreeBSD Licensing Policy
- FreeRTOS official License Details
- Zephyr official Licensing documentation
- NVIDIA OpenCodeReasoning dataset card
- Google DeepMind CodeContests repository/license notice
- NVIDIA OpenMathReasoning dataset card
- Art of Problem Solving Terms of Service
- NVIDIA OpenScienceReasoning-2 dataset card
- Wikimedia Wikipedia dataset card and Wikimedia Terms of Use
- Hendrycks MATH repository/license

## Production recommendation encoded as process, not approval

Keep all sources in REVIEW_REQUIRED until a human decision exists.

For the strictest provenance posture, do not make OpenMathReasoning production
eligible without resolving the AoPS upstream question. The cleanest alternative
is to replace its 145M-token math quota with a source whose intended use and
upstream rights are easier to defend, or with first-party verifier-generated
math data. NVIDIA Nemotron-MIND is a candidate worth evaluating because its card
states that it is synthetic, CC-BY-4.0, ready for commercial/non-commercial use
and intended for from-scratch pretraining, while disclosing OpenWebMath/ODC-By
as its base corpus.
