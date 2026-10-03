"""Check tracked path organization without reading model, user or secret data."""
from pathlib import PurePosixPath
import json
import subprocess
import sys


OBSOLETE_PREFIXES = (
    "docs/", "scripts/", "ilaria/docs/", "ilaria/bench/",
    "swyp/docs/", "swyp/benchmarks/", "swypik-os/docs/",
    "swypik-os/kernel/bench/", "swypik-os/scripts/benchmark-resources.ps1",
)
LOCAL_PREFIXES = ("ramasite/local/", ".tools/", "_conversatii-claude/")
SECRET_NAMES = {"id_rsa", "id_ed25519", ".env"}
RESTRICTED_SUFFIXES = {".pem", ".key", ".pfx", ".p12", ".pt", ".pth", ".ckpt", ".safetensors", ".gguf"}


def validate_paths(paths):
    issues = []
    for path in paths:
        name = PurePosixPath(path).name
        if path.startswith(OBSOLETE_PREFIXES):
            issues.append({"code": "obsolete_path", "path": path})
        if path.startswith(LOCAL_PREFIXES):
            issues.append({"code": "machine_local_path", "path": path})
        if name in SECRET_NAMES or name.startswith(".env.") and name not in {".env.example", ".env.template"} or PurePosixPath(path).suffix.lower() in RESTRICTED_SUFFIXES:
            issues.append({"code": "restricted_filename", "path": path})
    return issues


def main():
    result = subprocess.run(["git", "ls-files", "-z"], capture_output=True, check=True)
    paths = [path for path in result.stdout.decode("utf-8").split("\0") if path]
    if not paths:
        raise ValueError("empty Git index cannot establish repository organization")
    issues = validate_paths(paths)
    print(json.dumps({"tracked_paths": len(paths), "success": not issues, "issues": issues}))
    return 1 if issues else 0


if __name__ == "__main__":
    sys.exit(main())
