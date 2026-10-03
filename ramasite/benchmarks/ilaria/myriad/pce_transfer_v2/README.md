# PCE Transfer v2 — Collective Sleep benchmark

Purpose: test whether a second IMC cell can acquire verified new mappings from
PCE-style replay while retaining already-mastered skills.

This is a mechanism benchmark, not a claim about production intelligence.

## Frozen data

- tasks.jsonl: 12 new synthetic skills.
- anchors.jsonl: 8 pre-existing skills used to detect catastrophic forgetting.
- Every item has an opaque skill_key and distinct train/validation/test wording.

The opaque keys make the causal association measurable without depending on
external factual knowledge.

## Protocol

1. Initialize one tiny IMC cell.
2. Pretrain its 8 anchor skills.
3. Freeze that state as the shared starting checkpoint.
4. Clone it into Transfer and Control cells.
5. Transfer cell receives correct PCE skill mappings.
6. Control gets the same target-token multiset, optimizer budget, anchor replay
   and schedule, but new-skill mappings are rotated to incorrect source states.
7. Collective Sleep evaluates periodically.
8. A candidate is eligible only if known-anchor accuracy remains inside the
   forgetting budget.
9. The sleep controller restores the best validation checkpoint.
10. Final test prompts are evaluated only after sleep.

## Validation and checkpoint selection

Promotion uses **natural held-out validation NLL as the primary checkpoint
criterion**. The canonical `skill_key` probe is retained as a diagnostic/secondary
signal only and does not replace natural-language validation.

Collective Sleep also enforces known-anchor retention, restores the best eligible
checkpoint, and early-stops after three stale validation evaluations.

## Default gate

forge/pce_transfer_v2_gate.py requires:

- at least 4 seeds;
- positive causal NLL advantage in 100% of seeds;
- positive top-1 advantage in at least 75% of seeds;
- no seed with negative top-1 causal advantage;
- known-anchor drop <= 12.5 percentage points;
- mean NLL advantage >= 0.5;
- early stopping active in every seed.

These thresholds are parameters of the gate script, not hidden constants in the
training code.

## Commands

Run one seed:

    python forge/pce_transfer_v2.py --seed 7 --sleep-steps 320 --eval-every 20 --patience-evals 3 --out bench/myriad/pce_transfer_v2/result-seed7.json

Evaluate frozen results:

    python forge/pce_transfer_v2_gate.py

Consume a validated content-addressed signed-PCE replay store instead of raw
training states:

    python forge/pce_transfer_v2.py --seed 7 --replay-artifact-dir <artifact-dir>

Every file in that directory must be named `<artifact_sha256>.json`; artifacts
are validated fail-closed, duplicate capsules are rejected, and every frozen
skill must match exactly one `(domain, action)` replay artifact. This optional
path does not change the canonical frozen benchmark unless explicitly enabled.

See RESULTS.md for the current frozen tiny-IMC evidence.
