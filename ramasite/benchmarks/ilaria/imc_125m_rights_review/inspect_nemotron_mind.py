from __future__ import annotations
import json
from huggingface_hub import HfApi
from datasets import load_dataset

repo = "nvidia/Nemotron-MIND"
info = HfApi().dataset_info(repo)
print(json.dumps({
    "repo": repo,
    "sha": info.sha,
    "gated": bool(info.gated),
    "private": bool(info.private),
    "tags": list(info.tags or []),
}, indent=2, sort_keys=True))

ds = load_dataset(repo, revision=info.sha, split="train", streaming=True)
for i, row in enumerate(ds):
    safe = {}
    for key, value in row.items():
        if isinstance(value, str):
            safe[key] = {
                "chars": len(value),
                "preview": value[:240].replace("\n", "\\n"),
            }
        else:
            safe[key] = value
    print(json.dumps({"first_row": safe}, indent=2, sort_keys=True))
    break
