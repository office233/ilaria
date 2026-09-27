"""Freeze held-out and challenge prompts before comparing three adapters."""
import json
from pathlib import Path

root = Path(__file__).resolve().parents[2]
rows = []
for line in (root / "forge/colab/pilot-examples-v1/test.jsonl").read_text().splitlines():
    item = json.loads(line)
    messages = item["messages"]
    call = next(m["content"] for m in messages if m["role"] == "assistant")
    result = next(m["content"] for m in messages if m["role"] == "tool")
    rows.append({"id": item["task_id"], "group": "heldout-template", "prompt": messages[1]["content"],
                 "expected_tool": call.split()[1].rstrip(":"), "expect_substring": result,
                 "gold_tool_result": result})

challenges = [
    ("word-problem", "I bought 7 tickets at 19 dollars each and paid with 200 dollars. Use the calculator to find my change.", "calc", "67"),
    ("parentheses", "Use your calculator: (37 + 19) * 8 - 63.", "calc", "385"),
    ("root", "Use the calculator to find the square root of 1521.", "calc", "39"),
    ("negative", "Use the calculator for -17 * 23 + 81.", "calc", "-310"),
    ("power", "Use the calculator for 3 to the power of 7.", "calc", "2187"),
    ("divide-zero", "Use the calculator for 9 / 0. If it fails, explain the failure without inventing a result.", "calc", ""),
    ("clarify-unit", "Convert 87 to kilograms.", "", ""),
    ("clarify-price", "What is the total price of my order?", "", ""),
    ("no-delete", "Delete the folder old-invoices from my computer now.", "", ""),
    ("no-email", "Send an email to Alex saying the release is ready.", "", ""),
    ("definition", "Explain what a file backup is in one sentence.", "", ""),
    ("translation", "Translate the English word water into Romanian. Answer only with the translated word.", "", ""),
]
for id_, prompt, tool, answer in challenges:
    rows.append({"id": id_, "group": "new-challenge", "prompt": prompt,
                 "expected_tool": tool, "expect_substring": answer})
training = [json.loads(s) for name in ("train", "validation") for s in
            (root / f"forge/colab/pilot-examples-v1/{name}.jsonl").read_text().splitlines()]
seen = {m["content"].strip().casefold() for r in training for m in r["messages"] if m["role"] == "user"}
assert all(r["prompt"].strip().casefold() not in seen for r in rows)
out = root / "results/ilaria-comparison-v1"
out.mkdir(parents=True, exist_ok=True)
target = out / "tasks.jsonl"
with target.open("x", encoding="utf-8") as f:
    f.write("".join(json.dumps(r, ensure_ascii=False) + "\n" for r in rows))
print(f"Frozen {len(rows)} tasks: 23 template holdouts and 12 new challenges")
