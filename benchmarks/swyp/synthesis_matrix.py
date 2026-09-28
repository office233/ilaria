"""Evaluate bounded non-LLM synthesis across budgets and independent held-out inputs.

No model calls or installs. The caller supplies a built Swyp CLI and a NEW output
path. A training fit with a held-out mismatch is an observed overfit, not success.
"""
from __future__ import annotations
import argparse
from datetime import datetime, timezone
import hashlib
import json
import math
from pathlib import Path
import subprocess
import time

ROOT = Path(__file__).resolve().parents[2]


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--tool", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    tool = args.tool.resolve()
    if not tool.is_file(): parser.error("tool must be an existing compiled Swyp CLI")
    out = args.output.resolve()
    out.mkdir(parents=True, exist_ok=False)
    held_out = [-7.5, -2.5, -0.5, 0.25, 0.5, 1.5, 3.5, 6.5]
    ordinary = [-3, -1, 0, 2, 4]
    cases = [
        ("identity", lambda x: x, ordinary, []),
        ("linear", lambda x: 2*x+1, ordinary, []),
        ("square", lambda x: x*x, ordinary, []),
        ("cubic", lambda x: x*x*x, ordinary, []),
        ("quadratic", lambda x: x*x+x+1, ordinary, []),
        ("absolute", abs, ordinary, []),
        ("ambiguous_square", lambda x: x*x, [0, 1], []),
        ("refined_square", lambda x: x*x, [0, 1], [-1, 2]),
    ]
    report = {"status": "running", "started_utc": datetime.now(timezone.utc).isoformat(),
              "tool_sha256": hashlib.sha256(tool.read_bytes()).hexdigest(),
              "script_sha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
              "method": "8 task specifications x 3 candidate budgets; max_nodes=7; constants [-1,0,1,2]; held-out inputs never supplied to search; exact equality on these small dyadic arithmetic cases; interpreter and native executions both checked",
              "held_out_inputs": held_out, "results": [], "commands": [],
              "limitations": "finite task set; no LLM; no universal correctness proof; budget exhaustion is not impossibility; generated/native startup included in wall times"}
    def save() -> None:
        (out/"report.json").write_text(json.dumps(report, indent=2)+"\n", encoding="utf-8")
    def run(command: list[object], required: bool=True) -> tuple[subprocess.CompletedProcess[str], float]:
        start = time.perf_counter()
        cmd = list(map(str,command))
        result = subprocess.run(cmd,cwd=ROOT,text=True,capture_output=True,timeout=30)
        wall = time.perf_counter()-start
        report["commands"].append({"argv":cmd,"exit_code":result.returncode,"wall_seconds":wall,
                                   "stdout":result.stdout,"stderr":result.stderr})
        if required and result.returncode:
            raise RuntimeError(f"command failed {cmd}: {result.stderr}")
        return result,wall
    try:
        for name,oracle,training,validation in cases:
            for budget in (32,512,20000):
                case=out/f"{name}-{budget}"
                case.mkdir()
                spec={"examples":[{"x":x,"y":oracle(x)} for x in training],
                      "constants":[-1,0,1,2],"max_nodes":7,"max_candidates":budget}
                if validation:spec["validation"]=[{"x":x,"y":oracle(x)} for x in validation]
                specpath=case/"spec.json"
                specpath.write_text(json.dumps(spec,indent=2)+"\n",encoding="utf-8")
                source,exe=case/"candidate.swyp",case/"candidate.exe"
                result,wall=run([tool,"synth","-o",source,specpath],required=False)
                row={"task":name,"budget":budget,"synthesis_exit":result.returncode,"synthesis_wall_seconds":wall,
                     "synthesis_stdout":result.stdout,"synthesis_stderr":result.stderr,
                     "source_created":source.exists(),"held_out":[]}
                if result.returncode:
                    row["outcome"]="no_candidate_in_this_run"
                    if source.exists():raise RuntimeError("failed synthesis left an unexpected source")
                else:
                    row["source"]=source.read_text(encoding="utf-8")
                    row["source_sha256"]=hashlib.sha256(source.read_bytes()).hexdigest()
                    run([tool,"check",source])
                    run([tool,"build","-o",exe,source])
                    for x in held_out:
                        interpreted=float(run([tool,"run",source,x])[0].stdout.strip())
                        native=float(run([exe,x])[0].stdout.strip())
                        expected=oracle(x)
                        row["held_out"].append({"x":x,"expected":expected,"interpreter":interpreted,"native":native,
                                                "passed":math.isfinite(interpreted) and math.isfinite(native) and interpreted==native==expected})
                    row["outcome"]="held_out_pass" if all(v["passed"] for v in row["held_out"]) else "held_out_mismatch"
                report["results"].append(row)
                save()
                print(f"{name:20} budget={budget:5} {row['outcome']}",flush=True)
        outcomes={name:sum(r["outcome"]==name for r in report["results"])
                  for name in ("held_out_pass","held_out_mismatch","no_candidate_in_this_run")}
        report.update(status="completed",summary=outcomes,finished_utc=datetime.now(timezone.utc).isoformat())
        save()
        print(json.dumps(outcomes,indent=2))
    except BaseException as exc:
        report.update(status="failed",error=f"{type(exc).__name__}: {exc}")
        save()
        raise


if __name__=="__main__":main()
