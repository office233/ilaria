"""Benchmark the persistent Swyp Core compiler/runtime server.

Measures:
- cold AOT build;
- cached AOT materialization;
- embedded RunFast round-trip;
- Core validation/lowering round-trip.

The server stays alive for all measured requests so the result excludes Go
process startup after the initial launch.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path
import statistics
import subprocess
import time


SOURCE = """+fn sum_to(n:i64)->i64 {
  let i:i64=1;
  let total:i64=0;
  while i<=n { total=total+i; i=i+1; }
  return total;
}
fn main(){}
"""


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--swyp", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--repetitions", type=int, default=50)
    args = parser.parse_args()
    if not 10 <= args.repetitions <= 1000:
        parser.error("repetitions must be 10..1000")

    out = args.output.resolve()
    out.mkdir(parents=True, exist_ok=False)
    source = out / "sum.swyp"
    source.write_text(SOURCE, encoding="utf-8")
    cache = out / "cache"

    proc = subprocess.Popen(
        [str(args.swyp.resolve()), "core-server"],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        text=True,
        bufsize=1,
    )
    assert proc.stdin is not None and proc.stdout is not None

    def request(payload: dict) -> tuple[float, dict]:
        start = time.perf_counter()
        proc.stdin.write(json.dumps(payload, separators=(",", ":")) + "\n")
        proc.stdin.flush()
        line = proc.stdout.readline()
        elapsed_ms = (time.perf_counter() - start) * 1000
        response = json.loads(line)
        if response.get("status") not in {"ok", "bye"}:
            raise RuntimeError(response)
        return elapsed_ms, response

    cold, _ = request(
        {
            "id": "cold",
            "action": "build",
            "args": [
                "-entry", "sum_to",
                "-profile", "fast",
                "-cache-dir", str(cache),
                "-o", str(out / "cold.exe"),
                str(source),
            ],
        }
    )

    cached_builds = []
    for index in range(max(10, min(30, args.repetitions))):
        elapsed, _ = request(
            {
                "id": f"build-{index}",
                "action": "build",
                "args": [
                    "-entry", "sum_to",
                    "-profile", "fast",
                    "-cache-dir", str(cache),
                    "-o", str(out / f"cached-{index}.exe"),
                    str(source),
                ],
            }
        )
        cached_builds.append(elapsed)

    for index in range(5):
        request(
            {
                "id": f"warm-{index}",
                "action": "run",
                "args": ["-profile", "fast", "-entry", "sum_to", str(source), "100"],
            }
        )

    runs = []
    checks = []
    evals = []
    for index in range(args.repetitions):
        elapsed, response = request(
            {
                "id": f"run-{index}",
                "action": "run",
                "args": ["-profile", "fast", "-entry", "sum_to", str(source), "100"],
            }
        )
        if '"value":5050' not in response.get("output", ""):
            raise RuntimeError(f"unexpected result: {response}")
        runs.append(elapsed)

    for index in range(args.repetitions):
        elapsed, _ = request(
            {
                "id": f"check-{index}",
                "action": "check",
                "args": ["-entry", "sum_to", str(source)],
            }
        )
        checks.append(elapsed)

    eval_source = SOURCE
    for index in range(5):
        request(
            {
                "id": f"eval-warm-{index}",
                "action": "eval",
                "file": "buffer.swyp",
                "source": eval_source,
                "entry": "sum_to",
                "profile": "turbo",
                "values": ["100"],
            }
        )
    for index in range(args.repetitions):
        elapsed, response = request(
            {
                "id": f"eval-{index}",
                "action": "eval",
                "file": "buffer.swyp",
                "source": eval_source,
                "entry": "sum_to",
                "profile": "turbo",
                "values": ["100"],
            }
        )
        if '"value":"5050"' not in response.get("output", ""):
            raise RuntimeError(f"unexpected eval result: {response}")
        evals.append(elapsed)

    request({"id": "bye", "action": "shutdown"})
    proc.wait(timeout=5)

    def stats(samples: list[float]) -> dict:
        ordered = sorted(samples)
        return {
            "median_ms": statistics.median(samples),
            "min_ms": min(samples),
            "p95_ms": ordered[max(0, int(len(ordered) * 0.95) - 1)],
            "max_ms": max(samples),
            "samples_ms": samples,
        }

    report = {
        "cold_aot_build_ms": cold,
        "cached_aot_build": stats(cached_builds),
        "embedded_run_fast": stats(runs),
        "core_check": stats(checks),
        "cached_inline_eval_turbo": stats(evals),
    }
    (out / "report.json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report, indent=2))
    print(f"Evidence: {out / 'report.json'}")


if __name__ == "__main__":
    main()
