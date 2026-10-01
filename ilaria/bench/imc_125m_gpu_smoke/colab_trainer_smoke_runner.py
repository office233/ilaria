from __future__ import annotations

import json
import subprocess
import sys
import zipfile
from pathlib import Path

root = Path("/content")
forge = root / "forge"
forge.mkdir(exist_ok=True)
with zipfile.ZipFile(root / "forge-smoke.zip") as archive:
    archive.extractall(forge)

cmd = [
    sys.executable,
    str(forge / "train_ilaria.py"),
    "--data", "/content/smoke_stream",
    "--out", "/content/imc125-trainer-smoke",
    "--tokenizer", "/content/ilarialex.dev.json",
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
proc = subprocess.run(cmd, text=True, capture_output=True, timeout=240)
print(proc.stdout, end="")
if proc.stderr:
    print(proc.stderr, file=sys.stderr, end="")
print(json.dumps({"returncode": proc.returncode}, sort_keys=True))
raise SystemExit(proc.returncode)
