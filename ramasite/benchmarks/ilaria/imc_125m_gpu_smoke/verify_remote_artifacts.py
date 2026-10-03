from pathlib import Path
import argparse
import hashlib
import json

def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(8 * 1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()

def main(argv=None):
    parser = argparse.ArgumentParser(description="Inspect only the explicitly selected smoke output directory.")
    parser.add_argument("--root", type=Path, required=True)
    args = parser.parse_args(argv)
    items = {}
    for name in ("imc.pt", "checkpoint.pt", "training.log", "tokenizer.json"):
        p = args.root / name
        items[name] = {
            "exists": p.is_file(),
            "bytes": p.stat().st_size if p.is_file() else 0,
            "sha256": sha256(p) if p.is_file() else None,
        }
    print(json.dumps(items, indent=2, sort_keys=True))
    return 0 if all(item["exists"] for item in items.values()) else 1


if __name__ == "__main__":
    raise SystemExit(main())
