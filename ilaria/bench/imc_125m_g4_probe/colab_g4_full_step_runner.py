from __future__ import annotations

import json
import shutil
import subprocess
import sys
import zipfile
from pathlib import Path

bundle = Path("/content/ilaria-live-training-bundle.zip")
root = Path("/content/ilaria-g4-throughput")
if root.exists():
    shutil.rmtree(root)
root.mkdir(parents=True)

with zipfile.ZipFile(bundle) as archive:
    archive.extractall(root)

cmd = [
    sys.executable,
    str(root / "bench" / "imc_125m_g4_probe" / "g4_full_step_benchmark.py"),
]
print("[g4-full-step-runner]", " ".join(cmd), flush=True)
proc = subprocess.run(cmd, text=True, capture_output=True, timeout=900)
print(proc.stdout, end="")
if proc.stderr:
    print(proc.stderr, file=sys.stderr, end="")
print(json.dumps({"returncode": proc.returncode}, sort_keys=True))
raise SystemExit(proc.returncode)
