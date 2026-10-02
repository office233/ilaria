from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "forge"))
from bundle_workspace import extract_code_bundle


def main(argv=None):
    parser = argparse.ArgumentParser(description="Run a locked full-step benchmark with explicit paths.")
    parser.add_argument("--bundle", type=Path, required=True)
    parser.add_argument("--workspace", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--timeout", type=float, default=900)
    args = parser.parse_args(argv)
    if not 0 < args.timeout <= 3600:
        parser.error("--timeout must be >0 and <=3600 seconds")
    root = extract_code_bundle(args.bundle, args.workspace)
    cmd = [sys.executable, str(root / "bench" / "imc_125m_g4_probe" / "g4_full_step_benchmark.py"),
           "--out", str(args.out.resolve())]
    print("[g4-full-step-runner]", " ".join(cmd), flush=True)
    proc = subprocess.run(cmd, text=True, capture_output=True, timeout=args.timeout)
    print(proc.stdout, end="")
    if proc.stderr:
        print(proc.stderr, file=sys.stderr, end="")
    print(json.dumps({"returncode": proc.returncode}, sort_keys=True))
    return proc.returncode


if __name__ == "__main__":
    raise SystemExit(main())
