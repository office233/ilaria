"""Drop hfmix rows that exceed the trainer's token limit, into a new dataset folder.

forge.tool_data.encode_trajectory refuses (never truncates) a row longer than
max_length tokens, so a mix built with a character cap can still stop training:
hfmix-v1 had 540 such rows, almost all aya rows in Indic scripts. This keeps
every other row byte-for-byte, writes a new manifest that records the parent
manifest's sha256 and every dropped (split, source, language) count, and never
touches the parent folder.

JSONL is split on "\\n" only: str.splitlines() would also split on U+2028 and
other separators that occur inside JSON strings.
"""
from __future__ import annotations

import collections
import hashlib
import json
from pathlib import Path


def filter_length(src: Path, dst: Path, tokenizer, max_tokens: int = 2048, tokenizer_revision: str = "") -> dict:
    from forge.tool_data import encode_trajectory

    src, dst = Path(src), Path(dst)
    if dst.exists() and any(dst.iterdir()):
        raise FileExistsError(f"{dst} is not empty")
    dst.mkdir(parents=True, exist_ok=True)
    parent = json.loads((src / "manifest.json").read_text(encoding="utf-8"))
    dropped, files, kept = collections.Counter(), {}, []
    for split in ("train", "validation"):
        keep = []
        for line in (src / f"{split}.jsonl").read_bytes().decode("utf-8").split("\n"):
            if not line.strip():
                continue
            row = json.loads(line)
            try:
                encode_trajectory(row, tokenizer, max_tokens)
            except ValueError:
                dropped[(split, str(row.get("source")), row["language"])] += 1
                continue
            keep.append(line)
            kept.append((split, row))
        data = "".join(line + "\n" for line in keep).encode("utf-8")
        (dst / f"{split}.jsonl").write_bytes(data)
        files[split] = {"rows": len(keep), "sha256": hashlib.sha256(data).hexdigest()}
    manifest = dict(parent)
    manifest.update(files)
    manifest["languages"] = sorted({row["language"] for _, row in kept})
    manifest["rows_by_source"] = dict(collections.Counter(row.get("source") for split, row in kept if split == "train"))
    manifest["length_filter"] = {
        "max_tokens": max_tokens, "tokenizer_revision": tokenizer_revision, "parent": str(src),
        "parent_manifest_sha256": hashlib.sha256((src / "manifest.json").read_bytes()).hexdigest(),
        "dropped_total": sum(dropped.values()),
        "dropped": {"|".join(key): n for key, n in sorted(dropped.items())},
    }
    (dst / "manifest.json").write_bytes((json.dumps(manifest, indent=2, ensure_ascii=False) + "\n").encode("utf-8"))
    return manifest


if __name__ == "__main__":
    import argparse
    from transformers import AutoTokenizer

    ap = argparse.ArgumentParser()
    ap.add_argument("--src", required=True)
    ap.add_argument("--dst", required=True)
    ap.add_argument("--llm-dir", required=True)
    ap.add_argument("--max-tokens", type=int, default=2048)
    a = ap.parse_args()
    tok = AutoTokenizer.from_pretrained(a.llm_dir, local_files_only=True)
    m = filter_length(Path(a.src), Path(a.dst), tok, a.max_tokens, Path(a.llm_dir).name)
    print(json.dumps({k: m[k] for k in ("train", "validation", "length_filter")}, indent=2, ensure_ascii=False))
