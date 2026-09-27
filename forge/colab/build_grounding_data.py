"""Combine replay with executed tool-error and clarification trajectories."""
import json
import hashlib
from pathlib import Path
from forge.tool_data import load_trajectories, validate_splits

root = Path(__file__).resolve().parents[2]
out = root / "forge/colab/grounding-examples-v3"
out.mkdir(exist_ok=False)
splits = {s: load_trajectories(root / f"forge/colab/behavior-examples-v2/{s}.jsonl") +
          load_trajectories(root / f"forge/colab/grounding-tool-examples-v3/{s}.jsonl")
          for s in ("train", "validation")}
system = splits["train"][0]["messages"][0]["content"]
for i, event in enumerate(["planning call", "design review", "customer workshop", "team lunch", "training session", "demo rehearsal", "office tour", "quarterly review"]):
    split = "train" if i < 6 else "validation"
    for n, request in enumerate([f"Draft an email inviting Casey to the {event}. Do not send it.",
                                 f"Write a short invitation for the {event}. I only need the text."]):
        splits[split].append({"language": "en", "task_id": f"draft-v3-{i}-{n}", "source": "authored synthetic text-only assistance",
            "messages": [{"role": "system", "content": system}, {"role": "user", "content": request},
            {"role": "assistant", "content": f"Hi Casey, you are invited to our {event}. Please let me know whether you can attend."}]})
protected = [json.loads(line) for p in [root / "results/ilaria-comparison-v1/tasks.jsonl", root / "results/ilaria-grounding-v3/fresh-tasks.jsonl"]
             for line in p.read_text().splitlines()]
seen = {r["prompt"].strip().casefold() for r in protected}
assert all(m["content"].strip().casefold() not in seen for rows in splits.values() for r in rows for m in r["messages"] if m["role"] == "user")
print(validate_splits(splits["train"], splits["validation"]))
manifest = {}
for s, rows in splits.items():
    text = "".join(json.dumps(r, ensure_ascii=False)+"\n" for r in rows)
    (out / f"{s}.jsonl").write_text(text, encoding="utf-8")
    load_trajectories(out / f"{s}.jsonl")
    manifest[s] = {"rows": len(rows), "sha256": hashlib.sha256(text.encode()).hexdigest()}
(out / "manifest.json").write_text(json.dumps(manifest, indent=2))
