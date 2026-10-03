from __future__ import annotations
import json
from collections import Counter
from pathlib import Path

root = Path("data/candidate-corpus/opencode_reasoning_split0")
licenses = Counter()
sources = Counter()
datasets = Counter()
rows = 0
for shard in sorted(root.glob("*.jsonl")):
    with shard.open(encoding="utf-8") as stream:
        for line in stream:
            if not line.strip():
                continue
            row = json.loads(line)
            rows += 1
            licenses[str(row.get("license", ""))] += 1
            sources[str(row.get("source", ""))] += 1
            datasets[str(row.get("dataset", ""))] += 1
result = {
    "rows": rows,
    "licenses": dict(licenses.most_common()),
    "sources": dict(sources.most_common()),
    "datasets": dict(datasets.most_common()),
}
print(json.dumps(result, indent=2, sort_keys=True))
