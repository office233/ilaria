"""Extract complete generated turns for human review; does not grade answers."""
import json
from pathlib import Path
import re

root = Path(__file__).resolve().parents[2] / "results/ilaria-comparison-v1"
tasks = [json.loads(x) for x in (root / "tasks.jsonl").read_text().splitlines()]
for variant in ("base", "claude", "pilot", "behavior-v2"):
    source = root / f"{variant}-transcripts.txt"
    if not source.exists():
        continue
    blocks = re.split(r"\[transcript\] ", source.read_text(encoding="utf-8"))[1:]
    if len(blocks) != len(tasks):
        print(f"{variant}: incomplete ({len(blocks)}/{len(tasks)})")
        continue
    rows = []
    for task, block in zip(tasks, blocks):
        prompt, transcript = block.split("\n", 1)
        assert json.loads(prompt) == task["prompt"]
        transcript = transcript.split("\n---", 1)[0]
        generation = transcript.split("<|eot_id|>User: ", 1)[1].split("<|eot_id|>Assistant: ", 1)[1]
        # EOT boundaries are engine-inserted. Un-delimited fake Tool/Assistant
        # text remains part of the answer, rather than being treated as execution.
        answer = generation.rsplit("<|eot_id|>Assistant: ", 1)[-1].strip()
        rows.append({**task, "generation": generation.strip(), "answer": answer})
    (root / f"{variant}-answers.json").write_text(json.dumps(rows, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"{variant}: extracted {len(rows)} complete turns")
