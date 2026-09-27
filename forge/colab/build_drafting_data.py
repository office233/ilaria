"""Restore text drafting without teaching unavailable action execution."""
import json
import hashlib
from pathlib import Path
from forge.tool_data import load_trajectories, validate_splits

root = Path(__file__).resolve().parents[2]
out = root / "forge/colab/drafting-examples-v5"
out.mkdir(exist_ok=False)
splits = {s: load_trajectories(root / f"forge/colab/grounding-examples-v3/{s}.jsonl") for s in ("train", "validation")}
system = splits["train"][0]["messages"][0]["content"]
facts = [
    "The office will close early on Friday", "The design document is ready for review",
    "The product demonstration starts at noon", "The registration deadline is next Tuesday",
    "The customer support hours have changed", "The new training materials are available",
    "The building entrance will be repaired on Monday", "The weekly report is ready",
    "The project budget has been approved", "The team lunch will be held in the courtyard",
    "The software update is available", "The shipment is expected next week",
    "The conference room has new equipment", "The survey closes tomorrow",
    "The application deadline has been extended", "The library will be closed for maintenance",
    "The visitor parking area has moved", "The workshop materials can now be collected",
    "The printing service will be offline tonight", "The safety handbook has been revised",
]
templates = [
    "Write a two-sentence email announcing this: {fact}. Do not send it.",
    "Draft a short email about this update: {fact}. I only need the text.",
    "Please compose an email for my team: {fact}.",
    "Help me write an email. {fact}. Give me two sentences.",
    "Prepare the text of an email saying: {fact}. Do not perform any external action.",
    "I will send it myself. Write an email to announce: {fact}.",
    "Create a brief message for colleagues about this: {fact}.",
    "Give me a draft, not a sent message: {fact}.",
]
for i, fact in enumerate(facts):
    split = "train" if i < 16 else "validation"
    answer = fact + ". Please let me know if you have any questions."
    for n, template in enumerate(templates):
        splits[split].append({"language": "en", "task_id": f"drafting-v5-{i}-{n}", "source": "authored fictional text-drafting example; no external action",
            "messages": [{"role": "system", "content": system}, {"role": "user", "content": template.format(fact=fact)}, {"role": "assistant", "content": answer}]})
print(validate_splits(splits["train"], splits["validation"]))
protected = [json.loads(x)["prompt"].strip().casefold() for x in (root / "results/ilaria-grounding-v3/combined-tasks.jsonl").read_text().splitlines()]
assert not any(m["content"].strip().casefold() in protected for rows in splits.values() for r in rows for m in r["messages"] if m["role"] == "user")
manifest = {}
for s, rows in splits.items():
    text = "".join(json.dumps(r, ensure_ascii=False)+"\n" for r in rows)
    (out / f"{s}.jsonl").write_text(text,encoding="utf-8")
    load_trajectories(out / f"{s}.jsonl")
    manifest[s] = {"rows":len(rows),"sha256":hashlib.sha256(text.encode()).hexdigest()}
(out / "manifest.json").write_text(json.dumps(manifest,indent=2))
