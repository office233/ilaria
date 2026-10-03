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
    parser = argparse.ArgumentParser(description="Run the locked IMC smoke with explicit input/output paths.")
    parser.add_argument("--bundle", type=Path, required=True)
    parser.add_argument("--workspace", type=Path, required=True, help="new extraction directory; existing directories are refused")
    parser.add_argument("--data", type=Path, required=True, help="synthetic smoke token-stream prefix")
    parser.add_argument("--tokenizer", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--timeout", type=float, default=240)
    args = parser.parse_args(argv)
    if not 0 < args.timeout <= 3600:
        parser.error("--timeout must be >0 and <=3600 seconds")
    root = extract_code_bundle(args.bundle, args.workspace)
    forge = root / "forge" if (root / "forge" / "train_ilaria.py").is_file() else root
    if not (forge / "train_ilaria.py").is_file():
        parser.error("bundle does not contain the canonical train_ilaria.py")
    cmd = [
        sys.executable,
        str(forge / "train_ilaria.py"),
        "--data", str(args.data.resolve()),
        "--out", str(args.out.resolve()),
        "--tokenizer", str(args.tokenizer.resolve()),
        "--allow-unmanifested-data",
        "--allow-internal-val-split",
        "--preset", "imc-125m",
        "--ternary",
        "--ctx", "128",
        "--max-seq-len", "2048",
        "--batch", "1",
        "--accum", "1",
        "--steps", "2",
        "--warmup", "1",
        "--eval-every", "2",
        "--eval-iters", "1",
        "--precision", "bf16",
        "--grad-checkpoint",
        "--chunked-loss",
        "--sample-tokens", "0",
        "--seed", "1250007",
    ]
    print("[runner]", " ".join(cmd), flush=True)
    proc = subprocess.run(cmd, text=True, capture_output=True, timeout=args.timeout)
    print(proc.stdout, end="")
    if proc.stderr:
        print(proc.stderr, file=sys.stderr, end="")
    print(json.dumps({"returncode": proc.returncode}, sort_keys=True))
    return proc.returncode


if __name__ == "__main__":
    raise SystemExit(main())
