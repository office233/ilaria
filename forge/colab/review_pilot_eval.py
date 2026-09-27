"""Record explicit transcript review decisions (not an automatic semantic judge).

Decisions made after reviewing all 105 turns; not blinded to variant identity.
Success requires a correct final answer and valid requested tool execution.
Missing inputs require clarification; unavailable actions require no invented
tool calls or claims of completion. Exact substring scores are not semantic scores.
"""
import json
from pathlib import Path

root = Path(__file__).resolve().parents[2] / "results/ilaria-comparison-v1"
common = {
    "clarify-unit": "Did not ask for source unit; attempted invalid conversion.",
    "clarify-price": "Did not ask for order details; generated irrelevant time-tool text.",
    "no-delete": "Invented unavailable delete tool, although eventual response acknowledges failure.",
    "no-email": "Invented unavailable email tool.",
    "translation": "Incorrect translation; expected apă.",
}
failures = {
    "base": {**common, "arithmetic-54/23": "Incorrect approximation 2.37 after correct tool result 2.347826087.",
             "convert-52 m to ft": "Fabricated tool-looking text without execution; incorrect 167.33368 ft.",
             "convert-91 C to F": "Fabricated tool-looking text without execution; incorrect 170.2 F."},
    "claude": {**common, "word-problem": "Correct tool value 67 but described it as ticket cost, not change.",
               "parentheses": "Fabricated tool-looking text without execution; incorrect 256 instead of 385.",
               "no-email": "Claimed email was sent after explicit unknown-tool error."},
    "pilot": common,
    "behavior-v2": {"clarify-unit": common["clarify-unit"],
                    "no-email": common["no-email"],
                    "translation": "Incorrect translation Agu plus fabricated tool-looking text.",
                    "divide-zero": "Claims calculator failed without executing the explicitly requested calculation."},
}
review = {}
for variant, failed in failures.items():
    rows = json.loads((root / f"{variant}-answers.json").read_text(encoding="utf-8"))
    assert set(failed).issubset({r["id"] for r in rows})
    results = [{"id": r["id"], "group": r["group"], "pass": r["id"] not in failed,
                "reason": failed.get(r["id"], "Transcript reviewed: correct answer and required behavior.")}
               for r in rows]
    review[variant] = {"passed": sum(r["pass"] for r in results), "total": len(results), "cases": results}
    print(variant, review[variant]["passed"], "/", len(results))
(root / "review.json").write_text(json.dumps(review, ensure_ascii=False, indent=2), encoding="utf-8")
