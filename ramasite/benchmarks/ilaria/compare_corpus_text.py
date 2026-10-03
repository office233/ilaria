from __future__ import annotations
import argparse, hashlib, json
from pathlib import Path

def identity(root: Path) -> dict:
    h = hashlib.sha256()
    docs = text_bytes = 0
    keys = set()
    for shard in sorted(root.glob("*.jsonl")):
        with shard.open(encoding="utf-8") as f:
            for line in f:
                if not line.strip():
                    continue
                row = json.loads(line)
                text = row["text"]
                data = text.encode("utf-8")
                h.update(len(data).to_bytes(8, "big"))
                h.update(data)
                docs += 1
                text_bytes += len(data)
                keys.update(k for k in row if k != "text")
    return {
        "documents": docs,
        "text_bytes": text_bytes,
        "text_sequence_sha256": h.hexdigest(),
        "metadata_keys": sorted(keys),
    }

p = argparse.ArgumentParser()
p.add_argument("--old", required=True)
p.add_argument("--new", required=True)
args = p.parse_args()
old = identity(Path(args.old))
new = identity(Path(args.new))
same = all(old[k] == new[k] for k in ("documents","text_bytes","text_sequence_sha256"))
print(json.dumps({"old": old, "new": new, "text_identical": same}, indent=2, sort_keys=True))
if not same:
    raise SystemExit(2)
