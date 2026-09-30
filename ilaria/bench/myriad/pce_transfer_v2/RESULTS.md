# PCE Transfer v2 — Reproducibility Record

Date: 2026-09-29

## Status

**Current formal promotion gate: PASS.**

The earlier stale PASS/FAIL records are superseded by the four canonical results listed below. All four seeds use the same frozen benchmark, the same implementation, and the same sleep recipe. Gate thresholds were not changed.

## Frozen benchmark identity

- tasks: 12 synthetic new skills
- anchors: 8 pre-existing skills
- tasks SHA-256: `b2917f3fd51fc4650687a92f8bb12cafbf59a149cdeb6ea3e92ade2359e25953`
- anchors SHA-256: `8dddb46fbfeb34db2ee41f4f214dc5ef33a23c5064b16c72f5674f24516dde89`
- manifest: `manifest.json`

## Canonical mechanism

The receiving cell:
- begins from the same post-anchor checkpoint as control;
- receives the correct PCE mapping;
- uses three deterministic pre-action replay prompt views;
- never includes the post-action `result` in the decision input;
- uses action-ranking supervision plus replay-view consistency;
- replays known anchors;
- uses a frozen teacher KL term for anti-forgetting;
- selects checkpoints by natural held-out validation NLL;
- restores the best verifier-eligible checkpoint;
- early-stops on stale validation evaluations.

Control receives the same model initialization, optimizer budget, replay-view distribution, anchor replay, teacher regularization and target-token multiset, but uses the rotated incorrect skill mapping.

Canonical sleep recipe:
- max steps: 320
- eval every: 20
- patience evaluations: 3
- min NLL improvement: 0.01
- sleep LR: 0.002
- anchor replay ratio: 0.35
- teacher KL weight: 0.05
- action rank weight: 1.0
- replay consistency weight: 0.1
- replay label smoothing: 0.1
- skill batch size: 2
- anchor batch size: 2
- maximum known-anchor accuracy drop: 12.5 pp

## Canonical four-seed result

| Seed | Transfer top-1 | Control top-1 | Top-1 advantage | NLL advantage | Known-anchor delta | Best step | Early stop |
|---:|---:|---:|---:|---:|---:|---:|:---:|
| 7  | 83.33% | 0.00% | +83.33 pp | +4.1891 | 0 pp | 240 | yes |
| 11 | 8.33%  | 0.00% | +8.33 pp  | +0.7729 | 0 pp | 40  | yes |
| 19 | 0.00%  | 0.00% | 0.00 pp   | +0.4401 | 0 pp | 20  | yes |
| 23 | 16.67% | 0.00% | +16.67 pp | +0.2615 | 0 pp | 120 | yes |

Aggregate:
- mean top-1 causal advantage: **+27.08 percentage points**
- positive top-1 advantage: **3 / 4 seeds**
- non-negative top-1 advantage: **4 / 4 seeds**
- mean NLL causal advantage: **+1.4159**
- positive NLL advantage: **4 / 4 seeds**
- known-anchor retention: **4 / 4 within budget**
- early stopping activated: **4 / 4**

## Formal gate

The unchanged gate requires:
- at least 4 seeds;
- positive NLL advantage in 100% of seeds;
- positive top-1 advantage in at least 75% of seeds;
- no seed with negative top-1 advantage;
- known-anchor drop <= 12.5 pp;
- mean NLL advantage >= 0.5;
- early stopping in every seed.

Observed gate result: **PASS**.

All checks:
- `seed_count`: PASS
- `positive_nll_fraction`: PASS
- `positive_accuracy_fraction`: PASS
- `no_negative_accuracy_advantage`: PASS
- `known_anchor_retention`: PASS
- `mean_nll_advantage`: PASS
- `all_early_stopped`: PASS

## Canonical result hashes

- seed 7: `f9894d2739c0c46c55d844893d7159e67b9d5fc21203d14b8983689ca53e418e`
- seed 11: `0566806841c1817a61a90f94026bbcf9742fe8666408b62b658acc0d0245ef92`
- seed 19: `64b7e5b4d97126c01dadfd013b316d2d9b8c2e8cbc15068a33b6f7c13bb6bce4`
- seed 23: `baa07f16b06b9e0df01f8ec092cd3c5dda8041772951cbdaafaaebcd4a69e114`

These hashes are tied to the frozen dataset identity above.

## Promotion decision

PCE Transfer v2 is promoted as the current canonical Collective Sleep transfer benchmark. Signed-PCE replay ingestion is now available through the validated content-addressed `ilaria-pce-replay-v1` bridge and is opt-in so the frozen canonical result bytes remain unchanged. Remaining work moves to final IlariaLex freeze and IMC-125M preparation.
