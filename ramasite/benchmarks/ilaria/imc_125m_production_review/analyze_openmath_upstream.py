from __future__ import annotations
from collections import Counter
from datasets import load_dataset

REVISION = "d3d08664755704f422af97d43a7ff0ded4bd95df"
TARGET = 100_000

dataset = load_dataset(
    "nvidia/OpenMathReasoning",
    revision=REVISION,
    split="cot",
    streaming=True,
)
sources = Counter()
models = Counter()
types = Counter()
seen = 0
for row in dataset:
    problem = row.get("problem")
    solution = row.get("generated_solution")
    if not isinstance(problem, str) or not isinstance(solution, str):
        continue
    if not problem.strip() or not solution.strip():
        continue
    sources[str(row.get("problem_source", ""))] += 1
    models[str(row.get("generation_model", ""))] += 1
    types[str(row.get("problem_type", ""))] += 1
    seen += 1
    if seen >= TARGET:
        break

import json
print(json.dumps({
    "revision": REVISION,
    "accepted_rows": seen,
    "problem_sources": dict(sources.most_common()),
    "generation_models": dict(models.most_common()),
    "problem_types": dict(types.most_common()),
}, indent=2, sort_keys=True))
