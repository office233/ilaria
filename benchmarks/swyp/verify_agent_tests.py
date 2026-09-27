"""Independently run finished agents' tests against frozen original/current code.

Never imports agent production edits; unapproved imports/directives are skipped
for manual review. Stores all diagnostics, including test failures, as evidence.
"""
import concurrent.futures
import hashlib
import json
from pathlib import Path
import re
import shutil
import subprocess
import sys

ROOT=Path(__file__).resolve().parents[2]
ALLOWED={"bytes","context","errors","fmt","math","math/rand","math/big",
         "reflect","sort","strconv","strings","testing","testing/quick",
         "time","encoding/json","encoding/binary","sync","sync/atomic","runtime",
         "swyp-lang/internal/synthesis","swyp-lang/internal/swyplang"}

def digest(path): return hashlib.sha256(path.read_bytes()).hexdigest()

def main():
    base=Path(sys.argv[1]).resolve()
    if not base.is_relative_to(ROOT/"agent-lab"):
        raise SystemExit("Expected campaign within project agent-lab")
    campaign=json.loads((base/"status.json").read_text(encoding="utf-8"))
    destination=base/("verification-final" if "--final" in sys.argv[2:] else "verification")
    destination.mkdir(exist_ok=True)
    report_path=destination/"results.json"
    results=json.loads(report_path.read_text()) if report_path.exists() else []
    existing={r["agent"] for r in results}
    jobs=[r for r in campaign["agents"] if r["number"] and r["status"] not in
          ("queued","running") and r["agent"] not in existing]
    def verify(row):
        folder=Path(row["directory"])
        test=folder/"internal/synthesis/agent_test.go"
        outcome={"agent":row["agent"],"agent_status":row["status"]}
        if not test.exists(): return dict(outcome,status="no_test_artifact")
        text=test.read_text(encoding="utf-8-sig")
        blocks=re.findall(r'(?m)^import\s*\((.*?)\)|^import\s+([^\n]+)',text,re.S)
        imports=set()
        for block,single in blocks:
            imports.update(re.findall(r'"([^"\n]+)"',block or single))
        if not imports <= ALLOWED or "//go:" in text or re.search(r'func\s+(init|TestMain)\s*\(',text):
            return dict(outcome,status="requires_manual_review",imports=sorted(imports))
        if not re.search(r'func\s+TestAgent\w*\s*\(',text):
            return dict(outcome,status="no_matching_test")
        outcome["test_sha256"]=digest(test)
        outcome["runs"]={}
        for version in ("original","current"):
            target=destination/row["agent"]/version
            target.mkdir(parents=True,exist_ok=True)
            hashes={}
            source_root=folder if version=="original" else ROOT
            paths=[source_root/"go.mod"]
            for package in ("synthesis","swyplang"):
                paths += [p for p in (source_root/"internal"/package).glob("*.go") if not p.name.endswith("_test.go")]
            for source in paths:
                relative=str(source.relative_to(source_root))
                if version=="original" and campaign["source_sha256"].get(relative)!=digest(source):
                    return dict(outcome,status="agent_modified_production")
                to=target/relative;to.parent.mkdir(parents=True,exist_ok=True)
                shutil.copy2(source,to);hashes[relative]=digest(source)
            shutil.copy2(test,target/"internal/synthesis/agent_test.go")
            try:
                result=subprocess.run(["go","test","-json","./internal/synthesis","-run","Agent",
                                       "-count=1","-timeout=15s"],cwd=target,text=True,
                                      capture_output=True,timeout=60)
                (target/"test.stdout.txt").write_text(result.stdout,encoding="utf-8")
                (target/"test.stderr.txt").write_text(result.stderr,encoding="utf-8")
                events=[]
                for line in result.stdout.splitlines():
                    try:
                        event=json.loads(line)
                        if "Test" in event and event.get("Action") in ("pass","fail"):
                            events.append({"test":event["Test"],"outcome":event["Action"]})
                    except json.JSONDecodeError: pass
                outcome["runs"][version]={"exit_code":result.returncode,"tests":events,"source_sha256":hashes}
            except subprocess.TimeoutExpired:
                outcome["runs"][version]={"status":"timeout"}
        outcome["status"]="independently_executed"
        return outcome
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as executor:
        for result in executor.map(verify,jobs):
            results.append(result)
            report_path.write_text(json.dumps(results,indent=2),encoding="utf-8")
            print(result["agent"],result["status"],
                  {k:v.get("exit_code",v.get("status")) for k,v in result.get("runs",{}).items()},flush=True)
    print("Saved",report_path)

if __name__=="__main__": main()
