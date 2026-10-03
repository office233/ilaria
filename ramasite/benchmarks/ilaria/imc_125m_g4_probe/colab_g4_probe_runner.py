from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path
import sys as _nexus_sys
_nexus_sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from nexus_ilaria_benchmark_paths import ilaria_root

sys.path.insert(0, str(ilaria_root(__file__) / "forge"))
from bundle_workspace import extract_code_bundle


def main(argv=None):
    parser = argparse.ArgumentParser(description="Run G4 probing in a new explicit workspace.")
    parser.add_argument("--bundle", type=Path, required=True)
    parser.add_argument("--workspace", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--batches", default="4,8,16,32")
    parser.add_argument("--max-vram-utilization", type=float, default=0.85)
    parser.add_argument("--timeout", type=float, default=900)
    args = parser.parse_args(argv)
    if not 0 < args.timeout <= 3600:
        parser.error("--timeout must be >0 and <=3600 seconds")
    root = extract_code_bundle(args.bundle, args.workspace)
    cmd = [sys.executable, str(root / "bench" / "imc_125m_g4_probe" / "g4_batch_probe.py"),
           "--batches", args.batches, "--max-vram-utilization", str(args.max_vram_utilization),
           "--out", str(args.out.resolve())]
    print("[g4-runner]", " ".join(cmd), flush=True)
    result = subprocess.run(cmd, text=True, capture_output=True, timeout=args.timeout)
    print(result.stdout, end="")
    if result.stderr:
        print(result.stderr, file=sys.stderr, end="")
    print(json.dumps({"returncode": result.returncode}))
    return result.returncode


if __name__ == "__main__":
    raise SystemExit(main())
