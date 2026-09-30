"""Benchmark Swyp CFG inlining and native-call overhead.

Two workloads are measured:
1. inline: a three-block helper that should be CFG-inlined.
2. call: a larger helper that deliberately remains a native call.

Both are compared with the Core C-AOT backend on the same Swyp source.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path
import statistics
import subprocess
import time


INLINE_SOURCE = """\
fn step(x:i64)->i64 {
  if x < 0 { return x + 1; }
  return x + 1;
}
fn iterate(n:i64)->i64 {
  let i:i64=0;
  let x:i64=0;
  while i<n {
    x=step(x);
    i=i+1;
  }
  return x;
}
fn main(){}
"""


CALL_SOURCE = """\
fn step(x:i64)->i64 {
  if x < 0 { return x + 1; }
  if x == 0 { return 1; }
  return x + 1;
}
fn iterate(n:i64)->i64 {
  let i:i64=0;
  let x:i64=0;
  while i<n {
    x=step(x);
    i=i+1;
  }
  return x;
}
fn main(){}
"""


def median_run(command: list[str], repetitions: int) -> dict:
    subprocess.run(command, check=True, capture_output=True, text=True)
    samples = []
    output = ""
    for _ in range(repetitions):
        start = time.perf_counter()
        completed = subprocess.run(command, check=True, capture_output=True, text=True)
        samples.append((time.perf_counter() - start) * 1000)
        output = completed.stdout.strip()
    ordered = sorted(samples)
    return {
        "median_ms": statistics.median(samples),
        "min_ms": min(samples),
        "p95_ms": ordered[max(0, int(len(ordered) * 0.95) - 1)],
        "result": output,
        "samples_ms": samples,
    }


def build_case(swyp: Path, out: Path, name: str, source_text: str) -> tuple[Path, Path, str]:
    source = out / f"{name}.swyp"
    source.write_text(source_text, encoding="utf-8")
    x64 = out / f"{name}-x64.exe"
    c_aot = out / f"{name}-c-aot.exe"
    assembly = out / f"{name}.s"

    subprocess.run(
        [str(swyp), "core-x64", "-entry", "iterate", "-o", str(assembly), str(source)],
        check=True,
        capture_output=True,
        text=True,
    )
    subprocess.run(
        [str(swyp), "core-x64-build", "-entry", "iterate", "-o", str(x64), str(source)],
        check=True,
        capture_output=True,
        text=True,
    )
    subprocess.run(
        [
            str(swyp), "core-build", "-cache-dir", "off", "-entry", "iterate",
            "-profile", "fast", "-o", str(c_aot), str(source),
        ],
        check=True,
        capture_output=True,
        text=True,
    )
    return x64, c_aot, assembly.read_text(encoding="utf-8")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--swyp", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--iterations", type=int, default=20_000_000)
    parser.add_argument("--repetitions", type=int, default=9)
    args = parser.parse_args()
    if not 5 <= args.repetitions <= 100:
        parser.error("repetitions must be 5..100")
    if not 1 <= args.iterations <= 100_000_000:
        parser.error("iterations must be 1..100000000")

    out = args.output.resolve()
    out.mkdir(parents=True, exist_ok=False)
    swyp = args.swyp.resolve()
    expected = str(args.iterations)

    cases = {}
    for name, source_text, expect_call in (
        ("inline", INLINE_SOURCE, False),
        ("call", CALL_SOURCE, True),
    ):
        x64, c_aot, assembly = build_case(swyp, out, name, source_text)
        has_step = "call swyp_core_step_raw" in assembly
        if has_step != expect_call:
            raise RuntimeError(
                f"{name}: native assembly call presence={has_step}, expected {expect_call}"
            )
        case = {
            "assembly_contains_step_call": has_step,
            "x64_direct_backend": median_run([str(x64), expected], args.repetitions),
            "c_aot": median_run([str(c_aot), expected], args.repetitions),
        }
        for backend in ("x64_direct_backend", "c_aot"):
            if case[backend]["result"] != expected:
                raise RuntimeError(
                    f"{name}/{backend}: result {case[backend]['result']!r} != {expected!r}"
                )
        cases[name] = case

    report = {
        "iterations": args.iterations,
        "cases": cases,
    }
    (out / "report.json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report, indent=2))
    print(f"Evidence: {out / 'report.json'}")


if __name__ == "__main__":
    main()
