"""Cross-backend held-out checks of counterexample refinement, no model calls."""
import hashlib
import json
from pathlib import Path
import subprocess
import tempfile

ROOT=Path(__file__).resolve().parents[2]

def run(*args):
    return subprocess.run([str(a) for a in args],cwd=ROOT,capture_output=True,
                          text=True,check=True,timeout=60).stdout

def main():
    tool=ROOT/"bin/swyp.exe"
    run("go","build","-o",tool,"./cmd/swyp")
    directory=Path(tempfile.mkdtemp(prefix="refinement-eval-",dir=ROOT/"bin"))
    cases=[("square",[0,1],[2,-3,0.5],lambda x:x*x),
           ("zero",[0],[1,2],lambda x:0),
           ("linear",[0],[1,2,-3],lambda x:2*x+1)]
    rows=[]
    for name,train,verify,oracle in cases:
        spec=directory/(name+".json"); source=directory/(name+".swyp"); exe=directory/(name+".exe")
        data={"examples":[{"x":x,"y":oracle(x)} for x in train],
              "validation":[{"x":x,"y":oracle(x)} for x in verify]}
        spec.write_text(json.dumps(data),encoding="utf-8")
        output=run(tool,"synth","-o",source,spec)
        run(tool,"build","-o",exe,source)
        held_out=[i/4 for i in range(-32,33) if i/4 not in train+verify]
        for x in held_out:
            native=float(run(exe,x).strip())
            interpreted=float(run(tool,"run",source,x).strip())
            if native!=oracle(x) or interpreted!=oracle(x):
                raise RuntimeError((name,x,native,interpreted,oracle(x)))
        rows.append({"task":name,"spec":data,"source":source.read_text(),
                     "source_sha256":hashlib.sha256(source.read_bytes()).hexdigest(),
                     "held_out_inputs":len(held_out),"backend_checks":2*len(held_out),
                     "cli_output":output})
    report={"artifacts":str(directory),"results":rows,
            "total_backend_checks":sum(r["backend_checks"] for r in rows),
            "claim":"Only listed training, validation and held-out points tested; no universal proof."}
    (ROOT/"docs/NON_LLM_REFINEMENT_EVALUATION.json").write_text(json.dumps(report,indent=2)+"\n",encoding="utf-8")
    print(json.dumps(report,indent=2))

if __name__=="__main__": main()
