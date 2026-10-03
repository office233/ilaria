"""Benchmark Swyp direct x86-64 compile paths.

Compares:
- core-x64-pack: Swyp-owned machine-code artifact generation, no GCC;
- core-x64: Swyp-owned assembly generation;
- core-x64-build: Swyp assembly + GCC only as assembler/linker;
- core-build: C AOT reference backend.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path
import statistics
import subprocess
import time

SOURCE = """\
fn mix(a:i64,b:i64)->i64 {
  let x:i64=a+b;
  let y:i64=x*3;
  return y-7;
}
fn main(){}
"""

def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--swyp", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--repetitions", type=int, default=15)
    args = parser.parse_args()
    if not 5 <= args.repetitions <= 100:
        parser.error("repetitions must be 5..100")

    out = args.output.resolve()
    out.mkdir(parents=True, exist_ok=False)
    source = out / "mix.swyp"
    source.write_text(SOURCE, encoding="utf-8")
    swyp = args.swyp.resolve()

    cases = {
        "x64_pack": lambda i: [str(swyp), "core-x64-pack", "-entry", "mix", "-o", str(out / f"mix-{i}.swx64"), str(source)],
        "x64_asm": lambda i: [str(swyp), "core-x64", "-entry", "mix", "-o", str(out / f"mix-{i}.s"), str(source)],
        "x64_linked": lambda i: [str(swyp), "core-x64-build", "-entry", "mix", "-o", str(out / f"x64-{i}.exe"), str(source)],
        "c_aot": lambda i: [str(swyp), "core-build", "-cache-dir", "off", "-entry", "mix", "-profile", "fast", "-o", str(out / f"c-{i}.exe"), str(source)],
    }

    report = {}
    for name, command in cases.items():
        samples = []
        for i in range(args.repetitions):
            start = time.perf_counter()
            subprocess.run(command(i), check=True, capture_output=True, text=True)
            samples.append((time.perf_counter() - start) * 1000)
        ordered = sorted(samples)
        report[name] = {
            "median_ms": statistics.median(samples),
            "min_ms": min(samples),
            "p95_ms": ordered[max(0, int(len(ordered) * 0.95) - 1)],
            "samples_ms": samples,
        }

    (out / "report.json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report, indent=2))
    print(f"Evidence: {out / 'report.json'}")

if __name__ == "__main__":
    main()
