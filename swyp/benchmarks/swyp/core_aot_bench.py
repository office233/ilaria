"""Reproducible Swyp Semantic Core AOT benchmark.

Builds into a NEW output directory. Compares Core AOT safe/fast against C -O3
on matched i64 prime-count and Mandelbrot workloads. Mandelbrot also measures
the explicit IEEE-754 `ieee64` compute type separately from strict finite `f64`.
"""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import platform
import shutil
import statistics
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parents[2]


PRIME_SWYP = r"""
fn prime(n:i64)->bool {
  let d:i64=2;
  while d*d<=n {
    if n%d==0 { return false; }
    d=d+1;
  }
  return true;
}
fn count_primes(limit:i64)->i64 {
  let n:i64=2;
  let count:i64=0;
  while n<=limit {
    if prime(n) { count=count+1; }
    n=n+1;
  }
  return count;
}
fn main(){}
"""

PRIME_C = r"""
#include <stdio.h>
#include <stdlib.h>
#include <stdint.h>
#include <inttypes.h>
#include <stdbool.h>
static bool prime(int64_t n){int64_t d=2;while(d*d<=n){if(n%d==0)return false;d++;}return true;}
static int64_t count_primes(int64_t limit){int64_t n=2,count=0;while(n<=limit){if(prime(n))count++;n++;}return count;}
int main(int argc,char**argv){if(argc!=2)return 2;int64_t n=strtoll(argv[1],0,10);printf("%" PRId64 "\n",count_primes(n));return 0;}
"""

MANDEL_SWYP = r"""
fn mandelbrot(width:f64)->f64 {
  let height:f64=width/2;
  let py:f64=0;
  let checksum:f64=0;
  while py<height {
    let px:f64=0;
    while px<width {
      let cr:f64=px*3.5/width-2.5;
      let ci:f64=py*2/height-1;
      let zr:f64=0;
      let zi:f64=0;
      let count:f64=0;
      while count<80 && zr*zr+zi*zi<=4 {
        let next:f64=zr*zr-zi*zi+cr;
        zi=2*zr*zi+ci;
        zr=next;
        count=count+1;
      }
      checksum=checksum+count;
      px=px+1;
    }
    py=py+1;
  }
  return checksum;
}
fn main(){}
"""

MANDEL_IEEE_SWYP = MANDEL_SWYP.replace("f64", "ieee64")

MANDEL_C = r"""
#include <stdio.h>
#include <stdlib.h>
static double mandelbrot(double width){double height=width/2.0,py=0.0,checksum=0.0;while(py<height){double px=0.0;while(px<width){double cr=px*3.5/width-2.5;double ci=py*2.0/height-1.0;double zr=0.0,zi=0.0,count=0.0;while(count<80.0&&zr*zr+zi*zi<=4.0){double next=zr*zr-zi*zi+cr;zi=2.0*zr*zi+ci;zr=next;count+=1.0;}checksum+=count;px+=1.0;}py+=1.0;}return checksum;}
int main(int argc,char**argv){if(argc!=2)return 2;printf("%.17g\n",mandelbrot(strtod(argv[1],0)));return 0;}
"""


def run(command: list[str], cwd: Path = ROOT) -> subprocess.CompletedProcess[str]:
    return subprocess.run(command, cwd=cwd, text=True, capture_output=True, check=True)


def measure(exe: Path, arg: str, repetitions: int) -> tuple[str, list[float]]:
    first = run([str(exe), arg]).stdout.strip()
    for _ in range(2):
        assert run([str(exe), arg]).stdout.strip() == first
    samples: list[float] = []
    for _ in range(repetitions):
        start = time.perf_counter()
        out = run([str(exe), arg]).stdout.strip()
        elapsed = (time.perf_counter() - start) * 1000
        if out != first:
            raise RuntimeError(f"result drift: {exe}: {out!r} != {first!r}")
        samples.append(elapsed)
    return first, samples


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True, help="new output directory")
    parser.add_argument("--repetitions", type=int, default=9)
    parser.add_argument("--prime-limit", type=int, default=300000)
    parser.add_argument("--mandelbrot-width", type=int, default=640)
    args = parser.parse_args()
    if not 3 <= args.repetitions <= 30:
        parser.error("repetitions must be 3..30")
    for tool in ("go", "gcc"):
        if shutil.which(tool) is None:
            parser.error(f"{tool} is required")

    out = args.output.resolve()
    out.mkdir(parents=True, exist_ok=False)
    (out / "prime.swyp").write_text(PRIME_SWYP, encoding="utf-8")
    (out / "prime.c").write_text(PRIME_C, encoding="utf-8")
    (out / "mandel.swyp").write_text(MANDEL_SWYP, encoding="utf-8")
    (out / "mandel-ieee.swyp").write_text(MANDEL_IEEE_SWYP, encoding="utf-8")
    (out / "mandel.c").write_text(MANDEL_C, encoding="utf-8")

    swyp = out / "swyp.exe"
    run(["go", "build", "-o", str(swyp), "./cmd/swyp"])

    cases = [
        ("i64-prime-count", out / "prime.swyp", "count_primes", str(args.prime_limit), out / "prime.c"),
        ("finite-f64-mandelbrot", out / "mandel.swyp", "mandelbrot", str(args.mandelbrot_width), out / "mandel.c"),
    ]
    report = {
        "started_utc": datetime.now(timezone.utc).isoformat(),
        "platform": platform.platform(),
        "cpu": os.environ.get("PROCESSOR_IDENTIFIER", "unknown"),
        "python": sys.version,
        "repetitions": args.repetitions,
        "cases": [],
    }

    for case_name, source, entry, arg, c_source in cases:
        executables: dict[str, Path] = {}
        for profile in ("safe", "fast"):
            target = out / f"{case_name}-{profile}.exe"
            run([str(swyp), "core-build", "-entry", entry, "-profile", profile, "-o", str(target), str(source)])
            executables[f"swyp-core-{profile}"] = target
        fast_native_target = out / f"{case_name}-fast-native-lto.exe"
        run([
            str(swyp), "core-build", "-entry", entry, "-profile", "fast",
            "-cpu", "native", "-lto", "-strip",
            "-o", str(fast_native_target), str(source),
        ])
        executables["swyp-core-fast-native-lto"] = fast_native_target
        if case_name == "finite-f64-mandelbrot":
            ieee_target = out / "ieee64-mandelbrot-fast.exe"
            run([
                str(swyp), "core-build", "-entry", entry, "-profile", "fast",
                "-o", str(ieee_target), str(out / "mandel-ieee.swyp"),
            ])
            executables["swyp-core-ieee64-fast"] = ieee_target
            ieee_native_target = out / "ieee64-mandelbrot-fast-native-lto.exe"
            run([
                str(swyp), "core-build", "-entry", entry, "-profile", "fast",
                "-cpu", "native", "-lto", "-strip",
                "-o", str(ieee_native_target), str(out / "mandel-ieee.swyp"),
            ])
            executables["swyp-core-ieee64-fast-native-lto"] = ieee_native_target
        c_target = out / f"{case_name}-c.exe"
        run(["gcc", "-std=c11", "-O3", "-ffp-contract=off", str(c_source), "-o", str(c_target), "-lm"])
        executables["c-o3"] = c_target

        expected = None
        rows = []
        for label, exe in executables.items():
            value, samples = measure(exe, arg, args.repetitions)
            if expected is None:
                expected = value
            elif value != expected:
                raise RuntimeError(f"{case_name}: {label}={value}, expected={expected}")
            rows.append({
                "implementation": label,
                "result": value,
                "median_wall_ms": statistics.median(samples),
                "min_wall_ms": min(samples),
                "max_wall_ms": max(samples),
                "samples_ms": samples,
            })
        report["cases"].append({"name": case_name, "argument": arg, "results": rows})

    report["finished_utc"] = datetime.now(timezone.utc).isoformat()
    (out / "report.json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report["cases"], indent=2))
    print(f"Evidence: {out / 'report.json'}")


if __name__ == "__main__":
    main()
