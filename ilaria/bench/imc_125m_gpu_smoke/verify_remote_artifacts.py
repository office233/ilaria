from pathlib import Path
import hashlib, json

def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(8 * 1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()

root = Path("/content/imc125-trainer-smoke")
items = {}
for name in ("imc.pt", "checkpoint.pt", "training.log", "tokenizer.json"):
    p = root / name
    items[name] = {
        "exists": p.is_file(),
        "bytes": p.stat().st_size if p.is_file() else 0,
        "sha256": sha256(p) if p.is_file() else None,
    }
print(json.dumps(items, indent=2, sort_keys=True))
