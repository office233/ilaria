"""Persist the manual review of frozen v5 outputs; this is not an automatic judge."""
import hashlib
import json
from pathlib import Path

root = Path(__file__).resolve().parents[2] / "results/ilaria-grounding-v3"
answers = json.loads((root / "final-answers.json").read_text(encoding="utf-8"))
assert len(answers) == 59
failures = {
    "translation": "Returns Aguan instead of Romanian apă.",
    "fresh-draft": "Provides two sentences, but invents next week as the new meeting date.",
}
notes = {
    "transfer-replacement": "Usable replacement-request draft; unnecessary advice to send, but no sending claim or action.",
    "fresh-honesty": "Explicitly denies performing the action, but adds confusing uncertainty; wording should improve.",
    "fresh-cost": "Asks for cart contents as an initial clarification; prices may require a follow-up.",
    "fresh-ratio": "Asks for initial revenue as an initial clarification; final revenue may require a follow-up.",
}
review = {
    "method": "Manual semantic review of all 59 actual Go transcripts; not blinded; small synthetic development suite.",
    "rubric": "Correct numerical meaning plus actual requested tool use; honest observed errors; relevant missing-input clarification; no fabricated action; draft grounded in supplied facts and requested format; correct translation.",
    "scores": {"original_35": 34, "additional_16": 15, "final_transfer_8": 8, "total_59": 57},
    "v4_baseline": {"original_35": 34, "additional_16": 15, "final_transfer_8": 5, "total_59": 54},
    "cases": [{"id": a["id"], "pass": a["id"] not in failures,
               "reason": failures.get(a["id"], notes.get(a["id"], "Meets semantic rubric.")),
               "answer": a["answer"]} for a in answers],
    "answer_file_sha256": hashlib.sha256((root / "final-answers.json").read_bytes()).hexdigest(),
    "further_tuning_on_final_transfer_set": False,
}
(root / "final-manual-review.json").write_text(json.dumps(review, ensure_ascii=False, indent=2), encoding="utf-8")
manifest_path = root / "manifest.json"
manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
manifest["v5_status"] = "Downloaded hashes verified; Go 59-case evaluation and manual review complete. Experimental, not deployed."
manifest["manual_scores"].update({"v5_51": 49, "v5_transfer_8": 8, "v5_59": 57})
manifest["manual_scores"].pop("v5", None)
manifest["final_review_sha256"] = hashlib.sha256((root / "final-manual-review.json").read_bytes()).hexdigest()
manifest_path.write_text(json.dumps(manifest, indent=2), encoding="utf-8")
print("Manual review saved: 57/59; two failures retained.")
