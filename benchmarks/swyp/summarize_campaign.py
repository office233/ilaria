"""Summarize dispatch outcomes separately from independently verified tests."""
from collections import Counter
import json
from pathlib import Path
import sys

ROOT=Path(__file__).resolve().parents[2]
base=Path(sys.argv[1]).resolve()
campaign=json.loads((base/"status.json").read_text(encoding="utf-8"))
audit=json.loads((base/"verification-final/results.json").read_text(encoding="utf-8"))
invalid={"test-003":"Go constant arithmetic mistaken for runtime float64 arithmetic",
         "test-009":"Requires candidates after an early successful match; also asserts obsolete contradiction diagnostic",
         "test-012":"Unused errors import prevents test compilation",
         "test-015":"Unused errors import prevents test compilation"}
classifications=[]
for row in audit:
    name=row["agent"]
    if row["status"]!="independently_executed":
        classification=row["status"]
    else:
        old=row["runs"]["original"].get("exit_code")
        new=row["runs"]["current"].get("exit_code")
        if old==new==0: classification="passes_original_and_current"
        elif name in invalid: classification="invalid_generated_test"
        elif old==0 and new==1:
            log=(base/"verification-final"/name/"current/test.stdout.txt").read_text()
            classification=("obsolete_contradiction_error_expectation" if
                "invalid synthesis spec: contradictory" in log else "unresolved_failure")
        else: classification="unresolved_failure"
    classifications.append({"agent":name,"classification":classification,
                            "note":invalid.get(name,"")})
testing=[r for r in campaign["agents"] if r["number"]]
report={"campaign":str(base),"model":campaign["model"],"parallelism":campaign["parallelism"],
        "test_agent_count":len(testing),"research_agents":1,
        "research_outcome":"initial timeout; same conversation resumed and completed",
        "test_dispatch_exit_codes":dict(Counter(str(r.get("exit_code")) for r in testing)),
        "test_files":sum(r["status"]=="independently_executed" for r in audit),
        "classifications":dict(Counter(r["classification"] for r in classifications)),
        "details":classifications,
        "root_checks":(json.loads((base/"root-checks.json").read_text(encoding="utf-8"))
                       if (base/"root-checks.json").exists() else {"status":"not_recorded"}),
        "limits":["Agent completion is not test success.",
                  "Similar seeded tests are not independent evidence of novel capabilities.",
                  "Source and node contracts are bounded; no general correctness or AGI claim."]}
out=ROOT/"docs/AGENT_CAMPAIGN_20260927.json"
out.write_text(json.dumps(report,indent=2)+"\n",encoding="utf-8")
print(json.dumps({k:v for k,v in report.items() if k!="details"},indent=2))
