# PCE Transfer v1 — Experimental Record

Date: 2026-09-29

This benchmark is a mechanism experiment, not evidence of production-level
Myriad capability.

## Frozen task set

12 synthetic, intentionally invented skills across automotive, device, code,
reasoning, operations, mobile and robotics domains.

The opaque codes/rules reduce the chance that the model can answer from ordinary
pretraining knowledge.

## Protocol

Two tiny IMC cells begin with identical weights.

- **Transfer:** correct state -> action-token mapping.
- **Control:** exact same action-token multiset and optimizer budget, but mappings
  are rotated to the wrong states.
- **Baseline:** untouched initial checkpoint.

Held-out prompts use different wording from the teaching state.

Primary causal comparisons:

- transfer top-1 accuracy vs control;
- transfer action-token NLL vs control.

## Ternary IMC, 120 replay steps

| Seed | Baseline top-1 | Control top-1 | Transfer top-1 | Accuracy advantage | NLL advantage |
|---:|---:|---:|---:|---:|---:|
| 7 | 0/12 | 2/12 | 4/12 | +16.67 pp | +0.7841 |
| 11 | 0/12 | 2/12 | 1/12 | -8.33 pp | +1.4829 |
| 19 | 0/12 | 1/12 | 2/12 | +8.33 pp | +1.5444 |
| 23 | 0/12 | 1/12 | 2/12 | +8.33 pp | +0.5204 |

Aggregate:

- NLL advantage positive: **4/4 seeds**.
- Top-1 advantage positive: **3/4 seeds**.
- Mean top-1 advantage: **+6.25 percentage points**.
- Mean NLL advantage: **+1.083**.

Interpretation: the correct PCE mapping transfers measurable information across
all four seeds in probability space. Top-1 behavior is still noisy at this tiny
scale and must not be overclaimed.

## Full-precision IMC control, seed 7, 120 steps

- baseline: 0/12;
- mismatched control: 1/12;
- correct transfer: 1/12;
- top-1 causal advantage: 0 pp;
- NLL causal advantage: **+1.2956**.

Interpretation: the correct mapping improves target probability even when the
argmax has not yet changed.

## Ternary IMC, seed 7, 300 steps

- control: 2/12;
- transfer: 2/12;
- top-1 causal advantage: 0 pp;
- NLL causal advantage: +1.5300;
- training loss approached zero.

The 300-step candidate **fails the top-1 transfer gate** despite memorizing the
training associations. This is an explicit overtraining/generalization warning.

## Consequence for Collective Sleep

A sleep/consolidation candidate must not be promoted because replay loss fell.

Future promotion needs:

1. replay/train split;
2. separate validation paraphrases for early stopping;
3. untouched frozen test prompts;
4. general-regression replay to detect forgetting;
5. multiple seeds;
6. promotion on verified held-out gain, not training loss.

## Current conclusion

PCE v1 has passed the first mechanism check:

**verified correct experience changes a second IMC cell in the intended
direction more reliably than equal-compute mismatched experience in NLL.**

It has **not** yet proven robust top-1 skill transfer or large-scale Myriad
network gain. Those are subsequent gates.
