from __future__ import annotations
from collections import Counter
from datasets import load_dataset
import json

REVISION = "4b506f297762367fb05cac773fa41af672482160"
N = 10_000
ds = load_dataset("nvidia/Nemotron-MIND", revision=REVISION, split="train", streaming=True)
rows = 0
bytes_total = 0
styles = Counter()
for row in ds:
    text = row.get("Text")
    if not isinstance(text, str) or not text.strip():
        continue
    data = text.strip().encode("utf-8")
    bytes_total += len(data)
    styles[str(row.get("Conversational Style", ""))] += 1
    rows += 1
    if rows >= N:
        break
print(json.dumps({
    "revision": REVISION,
    "rows": rows,
    "text_bytes": bytes_total,
    "avg_text_bytes": bytes_total / rows,
    "estimated_tokens_min_bytes_over_4_plus_eos": bytes_total // 4 + rows,
    "estimated_tokens_max_bytes_over_3_2_plus_eos": int(bytes_total / 3.2) + rows,
    "styles": dict(styles.most_common()),
}, indent=2, sort_keys=True))
