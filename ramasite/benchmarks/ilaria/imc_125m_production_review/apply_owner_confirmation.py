import json
from pathlib import Path
import sys as _nexus_sys
_nexus_sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from nexus_ilaria_benchmark_paths import ilaria_root

root = ilaria_root(__file__)
review = Path(__file__).resolve().parent
packet = json.loads((review / "REVIEW_PACKET.json").read_text(encoding="utf-8"))
attribution = json.loads((review / "ATTRIBUTION.json").read_text(encoding="utf-8"))
decision = json.loads((review / "DECISION_TEMPLATE.json").read_text(encoding="utf-8"))

packet_sha = packet["review_packet_sha256"]
attribution_sha = attribution["attribution_sha256"]
if attribution["review_packet"]["sha256"] != packet_sha:
    raise ValueError("attribution packet identity differs from current review packet")

review_ref = (
    "chat-confirmation:2026-09-30T18:37+03:00;"
    f"packet={packet_sha};attribution={attribution_sha}"
)

for source, record in decision["external_sources"].items():
    record["decision"] = "APPROVE"
    record["reviewed_by"] = "project-owner"
    record["review_ref"] = review_ref
    record["resolved_obligations"] = list(
        packet["external_sources"][source].get("unresolved_obligations", [])
    )

for record in decision["first_party_sources"].values():
    record["decision"] = "ATTEST"
    record["attested_by"] = "project-owner"
    record["review_ref"] = review_ref

decision.pop("decision_sha256", None)
(review / "DECISION_APPROVED.json").write_text(
    json.dumps(decision, indent=2, sort_keys=True) + "\n",
    encoding="utf-8",
)
