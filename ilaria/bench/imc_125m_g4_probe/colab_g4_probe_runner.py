from __future__ import annotations

import json
import subprocess
import sys
import zipfile
from pathlib import Path

bundle = Path("/content/ilaria-live-training-bundle.zip")
root = Path("/content/ilaria-g4")
if root.exists():
    import shutil
    shutil.rmtree(root)
root.mkdir(parents=True)

with zipfile.ZipFile(bundle) as archive:
    archive.extractall(root)

cmd = [
    sys.executable,
    str(root / "bench" / "imc_125m_g4_probe" / "g4_batch_probe.py"),
    "--batches", "4,8,16,32",
    "--max-vram-utilization", "0.85",
    "--out", "/content/g4-batch-probe.json",
]
print("[g4-runner]", " ".join(cmd), flush=True)
result = subprocess.run(cmd, text=True, capture_output=True, timeout=900)
print(result.stdout, end="")
if result.stderr:
    print(result.stderr, file=sys.stderr, end="")
print(json.dumps({"returncode": result.returncode}))
raise SystemExit(result.returncode)
