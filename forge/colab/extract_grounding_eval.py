"""Extract actual generation segments for review, keeping fabricated tool text."""
import json
from pathlib import Path
import re

root = Path(__file__).resolve().parents[2] / "results/ilaria-grounding-v3"
for variant, taskfile in [("before", "fresh-tasks.jsonl"), ("after", "combined-tasks.jsonl"), ("prompt-fix", "combined-tasks.jsonl"), ("aligned", "combined-tasks.jsonl"), ("transfer-before", "final-fresh.jsonl"), ("final", "final-tasks.jsonl")]:
    source = root / f"{variant}-transcripts.txt"
    if not source.exists():
        continue
    tasks = [json.loads(s) for s in (root / taskfile).read_text(encoding="utf-8").splitlines()]
    blocks = re.split(r"\[transcript\] ", source.read_text(encoding="utf-8"))[1:]
    if len(blocks) != len(tasks):
        print(f"{variant}: incomplete {len(blocks)}/{len(tasks)}")
        continue
    results = []
    for task, block in zip(tasks, blocks):
        prompt, transcript = block.split("\n", 1)
        assert json.loads(prompt) == task["prompt"]
        body = transcript.split("\n---", 1)[0].split("<|eot_id|>User: ", 1)[1].split("<|eot_id|>Assistant: ", 1)[1]
        results.append({**task, "generation": body.strip(), "answer": body.rsplit("<|eot_id|>Assistant: ", 1)[-1].strip()})
    (root / f"{variant}-answers.json").write_text(json.dumps(results, ensure_ascii=False, indent=2), encoding="utf-8")
    print(variant, len(results), "turns extracted")
