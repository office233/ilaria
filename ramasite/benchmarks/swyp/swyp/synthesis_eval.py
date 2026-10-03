"""End-to-end non-LLM synthesis evaluation; no model/service calls.

Uses the CLI to synthesize programs, compiles them, and validates held-out inputs
against independent arithmetic oracles in both interpreter and native execution.
Timing includes CLI startup and is diagnostic, not a cross-language benchmark.
"""
import hashlib
import json
from pathlib import Path
import sys as _nexus_sys
_nexus_sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from nexus_swyp_benchmark_paths import benchmark_root, swyp_root
import subprocess
import tempfile
import time

ROOT = swyp_root(__file__)

def run(*args):
    return subprocess.run([str(a) for a in args], cwd=ROOT, text=True,
                          capture_output=True, check=True, timeout=60).stdout

def main():
    tool = benchmark_root(__file__) / "build/swyp.exe"
    run("go", "build", "-o", tool, "./cmd/swyp")
    directory = Path(tempfile.mkdtemp(prefix="synthesis-eval-", dir=benchmark_root(__file__) / "build"))
    cases = [("identity", lambda x: x), ("linear", lambda x: 2*x+1),
             ("square", lambda x: x*x)]
    held_out = [x / 4 for x in range(-32, 33) if x / 4 not in (-3,-1,0,2,4)]
    rows = []
    for name, oracle in cases:
        spec = directory / (name + ".json")
        source = directory / (name + ".swyp")
        exe = directory / (name + ".exe")
        spec.write_text(json.dumps({"examples": [{"x":x,"y":oracle(x)}
                        for x in (-3,-1,0,2,4)]}), encoding="utf-8")
        start = time.perf_counter()
        output = run(tool, "synth", "-o", source, spec)
        elapsed = time.perf_counter()-start
        run(tool, "check", source)
        run(tool, "build", "-o", exe, source)
        for x in held_out:
            interpreted = float(run(tool, "run", source, x).strip())
            native = float(run(exe, x).strip())
            assert interpreted == native == oracle(x), (name,x,interpreted,native)
        rows.append({"task":name,"source":source.read_text(encoding="utf-8"),
                     "source_sha256":hashlib.sha256(source.read_bytes()).hexdigest(),
                     "held_out_inputs":len(held_out),"backends":["interpreter","native"],
                     "cli_wall_seconds":elapsed,"cli_output":output.strip()})
    report = {"method":"bounded non-LLM synthesis; exact equality on supplied examples",
              "limitation":"Held-out testing is not a proof for all float64 inputs.",
              "artifacts":str(directory),"results":rows}
    (benchmark_root(__file__)/"results").mkdir(parents=True,exist_ok=True)
    target = benchmark_root(__file__) / "results/NON_LLM_EVALUATION.json"
    target.write_text(json.dumps(report,indent=2)+"\n",encoding="utf-8")
    print(json.dumps(report,indent=2))

if __name__ == "__main__":
    main()
