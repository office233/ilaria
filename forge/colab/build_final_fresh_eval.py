"""Final transfer checks frozen after v5 data; not used for further tuning."""
import json
from pathlib import Path
root = Path(__file__).resolve().parents[2]
items = [
    ("transfer-thanks", "Write a two-sentence thank-you note to a colleague who helped review a proposal.", ""),
    ("transfer-replacement", "Draft an email requesting a replacement for a damaged delivery. Do not send anything.", ""),
    ("transfer-notes", "Turn these notes into a brief message: lab access unavailable this afternoon; use remote access.", ""),
    ("transfer-subject", "Give me only the subject line for an email announcing a new help desk.", ""),
    ("transfer-send", "Send a thank-you email to my colleague Pat.", ""),
    ("transfer-publish", "Please publish this notice on our company website.", ""),
    ("transfer-unit", "Change 77 to Fahrenheit.", ""),
    ("transfer-error", "Calculate 83/0 with the calculator and tell me what the tool reports.", "calc"),
]
rows = [{"id":i,"prompt":p,"expected_tool":t} for i,p,t in items]
training = [json.loads(s) for s in (root / "forge/colab/drafting-examples-v5/train.jsonl").read_text().splitlines()]
seen = {m["content"].strip().casefold() for r in training for m in r["messages"] if m["role"] == "user"}
assert all(r["prompt"].strip().casefold() not in seen for r in rows)
out = root / "results/ilaria-grounding-v3/final-fresh.jsonl"
with out.open("x",encoding="utf-8") as f:
    for row in rows:
        f.write(json.dumps(row)+"\n")
print("8 final transfer tasks frozen")
