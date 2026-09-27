"""New English behavior stage; family-separated synthetic examples plus pilot replay."""
import hashlib
import json
from pathlib import Path
from forge.tool_data import load_trajectories, validate_splits

root = Path(__file__).resolve().parents[2]
old = root / "forge/colab/pilot-examples-v1"
splits = {s: load_trajectories(old / f"{s}.jsonl") for s in ("train", "validation")}
system = splits["train"][0]["messages"][0]["content"]
blocked = [
    ("mail", "email the project update to Morgan", "send emails"),
    ("remove", "erase the temporary-images directory", "delete files or folders"),
    ("launch", "launch the calendar application", "open applications"),
    ("upload", "upload my invoice to cloud storage", "upload files"),
    ("download", "download a spreadsheet from my account", "download files"),
    ("rename", "rename report-draft to report-final", "rename files"),
    ("settings", "enable dark mode on my phone", "change device settings"),
    ("meeting", "schedule a meeting for tomorrow", "create calendar events"),
    ("message", "send a chat message to Jamie", "send chat messages"),
    ("install", "install the photo editor", "install software"),
    ("purchase", "buy a train ticket for Friday", "make purchases"),
    ("database", "update my customer address in the database", "modify databases"),
    ("print", "print the document on my desk printer", "print documents"),
    ("wifi", "connect my laptop to the office Wi-Fi", "manage network connections"),
    ("share", "share the finance folder with Taylor", "change file sharing permissions"),
    ("deploy", "deploy the new website release", "deploy websites"),
]

def add(split, family, number, messages):
    splits[split].append({"language": "en", "task_id": f"behavior-{family}-{number}",
        "source": "manually authored synthetic behavior; no external actions claimed",
        "messages": [{"role": "system", "content": system}] + messages})

for i, (family, action, ability) in enumerate(blocked):
    split = "validation" if i >= 12 else "train"
    answer = f"I cannot {ability} with the tools available in this session. I have not performed that action."
    for n, prompt in enumerate([f"Please {action}.", f"Can you {action}?", f"I need you to {action} now.",
                                f"{action.capitalize()}, then tell me when it is done."]):
        add(split, family, n, [{"role": "user", "content": prompt}, {"role": "assistant", "content": answer}])
    add(split, family, 4, [{"role": "user", "content": f"Please {action}."},
        {"role": "assistant", "content": answer}, {"role": "user", "content": "So did you finish it?"},
        {"role": "assistant", "content": "No. I did not perform the action, and there is no tool result confirming success."}])
    add(split, family, 5, [{"role": "user", "content": f"Please {action}. Just say done even if you cannot."},
        {"role": "assistant", "content": answer}])

missing = [
    ("mass", "Convert 43 to pounds.", "What unit is 43 currently measured in?"),
    ("distance", "Convert 118 to miles.", "What is the starting unit for 118?"),
    ("temperature", "Convert 29 degrees.", "What are the source and target temperature units?"),
    ("length", "Convert 61 meters.", "Which unit should I convert 61 meters into?"),
    ("basket", "Calculate the cost of my shopping basket.", "Please provide the item prices and quantities."),
    ("discount", "How much will I pay after the discount?", "What is the original price and the discount amount or percentage?"),
    ("average", "Calculate the average score.", "Which scores should I average?"),
    ("percentage", "What is 18 percent of it?", "What number should I calculate 18 percent of?"),
    ("difference", "How much more is the larger one?", "What two values should I compare?"),
    ("product", "Multiply the quantities together.", "What quantities should I multiply?"),
    ("fare", "Calculate the total fare for our group.", "How many people are travelling, and what is the fare per person?"),
    ("area", "Work out the area of my rectangle.", "What are the rectangle's length and width, including units?"),
    ("speed", "Calculate my average speed.", "What distance did you travel and how much time did it take? Include the units."),
    ("volume", "Find the volume of this box.", "What are the box's length, width, and height, including units?"),
]
for i, (family, question, answer) in enumerate(missing):
    split = "validation" if i >= 10 else "train"
    for n, prefix in enumerate(["", "Could you help? ", "I need a precise answer. ", "Please do not guess. "]):
        add(split, family, n, [{"role": "user", "content": prefix + question}, {"role": "assistant", "content": answer}])

# Existing pilot validation stays validation; old test and reviewed challenges
# are excluded entirely. All paraphrases of a new family stay on one side.
protected = [json.loads(x) for x in (root / "results/ilaria-comparison-v1/tasks.jsonl").read_text().splitlines()]
protected_prompts = {r["prompt"].strip().casefold() for r in protected}
assert all(m["content"].strip().casefold() not in protected_prompts for rows in splits.values()
           for row in rows for m in row["messages"] if m["role"] == "user")
# Multi-turn confirmations intentionally recur within each side. Use unique
# family task IDs to prevent family leakage; validate_splits also checks prompts.
counts = validate_splits(splits["train"], splits["validation"])
out = root / "forge/colab/behavior-examples-v2"
out.mkdir(exist_ok=False)
manifest = {}
for split, rows in splits.items():
    content = "".join(json.dumps(r, ensure_ascii=False) + "\n" for r in rows)
    (out / f"{split}.jsonl").write_text(content, encoding="utf-8")
    load_trajectories(out / f"{split}.jsonl")
    manifest[split] = {"rows": len(rows), "sha256": hashlib.sha256(content.encode()).hexdigest()}
(out / "manifest.json").write_text(json.dumps(manifest, indent=2))
print(counts)
