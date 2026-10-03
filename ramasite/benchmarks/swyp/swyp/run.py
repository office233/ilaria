"""Reproducible Windows CPU comparison. No toolchains are downloaded."""
import hashlib
import argparse
import json
import math
import os
from pathlib import Path
import sys as _nexus_sys
_nexus_sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from nexus_swyp_benchmark_paths import benchmark_root, swyp_root
import platform
import random
import shutil
import statistics
import subprocess
import sys
import time

ROOT = swyp_root(__file__)
parser = argparse.ArgumentParser()
parser.add_argument("--baseline", type=Path, help="Previous native compute executable, measured in the same run")
parser.add_argument("--report", type=Path, default=Path(__file__).resolve().parents[1] / Path("results/SWYP_NATIVE_BENCHMARK.json"))
parser.add_argument("--skip-interpreter", action="store_true", help="Measure compiled Swyp and other languages only")
options = parser.parse_args()
HERE = Path(__file__).resolve().parent
OUT = benchmark_root(__file__) / "build" / "swyp-bench"
OUT.mkdir(parents=True, exist_ok=True)

def execute(command, timeout=60):
    return subprocess.run([str(v) for v in command], cwd=ROOT, capture_output=True,
                          text=True, check=True, timeout=timeout).stdout

versions = {"python": sys.version, "platform": platform.platform(),
            "cpu": os.environ.get("PROCESSOR_IDENTIFIER", "unknown")}
builds = {}
def build(label, command):
    start = time.perf_counter()
    execute(command)
    builds[label] = time.perf_counter() - start

for compiler in ("go", "gcc", "g++"):
    if not shutil.which(compiler):
        raise SystemExit(f"Required toolchain unavailable: {compiler}")
    versions[compiler] = execute([compiler, "version" if compiler == "go" else "--version"]).splitlines()[0]

swyp = benchmark_root(__file__) / "build" / "swyp.exe"
build("Swyp tool", ["go", "build", "-o", swyp, "./cmd/swyp"])
build("Swyp native", [swyp, "build", "-o", OUT / "swyp.exe", ROOT / "examples/swyp/compute.swyp"])
for label,compiler,language in (("C","gcc","c"),("C++","g++","c++")):
    build(label,[compiler,"-x",language,"-O2","-ffp-contract=off",HERE/"reference.c","-o",OUT/f"{compiler}.exe","-lm"])
build("Go",["go","build","-o",OUT/"go.exe",HERE/"reference.go"])
commands = {
    "Swyp native": [OUT/"swyp.exe"],
    "Swyp interpreter": [swyp,"run","-steps","1000000000",ROOT/"examples/swyp/compute.swyp"],
    "C": [OUT/"gcc.exe"], "C++": [OUT/"g++.exe"], "Go": [OUT/"go.exe"],
    "Python": [sys.executable,HERE/"reference.py"],
    "Go integer primes": [OUT/"go.exe"],
}
versions["Rust"] = "Not measured: rustc unavailable on PATH"
if options.skip_interpreter:
    del commands["Swyp interpreter"]
if options.baseline:
    commands["Swyp baseline"] = [options.baseline.resolve()]
if shutil.which("rustc"):
    versions["Rust"] = execute(["rustc","--version"]).strip()
    build("Rust",["rustc","-C","opt-level=2",HERE/"reference.rs","-o",OUT/"rust.exe"])
    commands["Rust"] = [OUT/"rust.exe"]

cases = [("Mandelbrot640",0,640),("PrimeCount100000",1,100000),("Train256x2000",2,2000)]
records = []
def measure(label, case, mode, size, repetition):
    start=time.perf_counter()
    output=execute(commands[label]+[str(3 if label == "Go integer primes" else mode),str(size)],timeout=60)
    wall=time.perf_counter()-start
    lines=output.splitlines()
    result=next(line.split() for line in lines if line.startswith("RESULT "))
    seconds,value=map(float,result[1:])
    if not math.isfinite(seconds) or seconds<=0 or not math.isfinite(value):
        raise ValueError(f"Invalid measurement from {label}: {output}")
    weights=next((list(map(float,line.split()[1:])) for line in lines if line.startswith("WEIGHTS ")),None)
    if mode==1 and value!=9592:
        raise ValueError(f"Incorrect prime count: {label} {value}")
    if mode==2:
        if weights is None or not all(math.isfinite(x) for x in weights):
            raise ValueError(f"Invalid weights: {label}")
        if abs(weights[0]-2)>5e-6 or abs(weights[1]-1)>5e-6 or not 0<=weights[2]<1e-10:
            raise ValueError(f"Training did not converge: {label} {weights}")
    return dict(language=label,case=case,repetition=repetition,seconds=seconds,
                wall_seconds=wall,result=value,weights=weights)

rng=random.Random(20260927)
for case,mode,size in cases:
    # One discarded process per implementation. Each measured process is fresh;
    # this warms file caches, not a persistent interpreter or JIT.
    available=[label for label in commands if mode==1 or label!="Go integer primes"]
    for label in available:
        measure(label,case,mode,size,-1)
    for repetition in range(5):
        order=list(available);rng.shuffle(order)
        for label in order:
            records.append(measure(label,case,mode,size,repetition))
    selected=[r for r in records if r["case"]==case]
    reference=next(r for r in selected if r["language"]=="Python")
    for row in selected:
        if not math.isclose(row["result"],reference["result"],rel_tol=1e-9,abs_tol=1e-15):
            raise ValueError(f"Result mismatch: {row} versus {reference}")
        if row["weights"] and (reference["weights"] is None or len(row["weights"])!=len(reference["weights"]) or any(not math.isclose(a,b,rel_tol=1e-9,abs_tol=1e-15) for a,b in zip(row["weights"],reference["weights"],strict=True))):
            raise ValueError(f"Weights mismatch: {row}")
    print(f"Validated {case}",flush=True)

summary=[]
for case,_,_ in cases:
    for label in commands:
        rows=[r for r in records if r["case"]==case and r["language"]==label]
        if not rows:
            continue
        times=[r["seconds"] for r in rows]
        summary.append(dict(case=case,language=label,median_ms=statistics.median(times)*1000,
                            min_ms=min(times)*1000,max_ms=max(times)*1000,
                            wall_median_ms=statistics.median(r["wall_seconds"] for r in rows)*1000))
paths=[ROOT/"examples/swyp/compute.swyp",HERE/"reference.c",HERE/"reference.go",HERE/"reference.py",HERE/"reference.rs",HERE/"run.py",ROOT/"internal/swyplang/swyp.go",ROOT/"internal/swyplang/check.go",ROOT/"internal/swyplang/native.go"]
report=dict(versions=versions,build_seconds=builds,summary=summary,measurements=records,
            sha256={str(p.relative_to(ROOT.parent)):hashlib.sha256(p.read_bytes()).hexdigest() for p in paths})
if options.baseline:
    report["baseline"] = dict(path=str(options.baseline), sha256=hashlib.sha256(options.baseline.read_bytes()).hexdigest())
(ROOT/options.report).parent.mkdir(parents=True,exist_ok=True)
(ROOT/options.report).write_text(json.dumps(report,indent=2)+"\n",encoding="utf-8")
for row in summary:
    print(f'{row["case"]:20} {row["language"]:18} {row["median_ms"]:10.4f} ms [{row["min_ms"]:.4f}, {row["max_ms"]:.4f}]')
print(f"Saved {options.report}")
