"""concat_streams.py — join tokenized shards (<prefix>.bin + <prefix>.json from
cmd/corpus-tokenize) into one training stream for forge/train_ilaria.py.

Shards are validated (same vocab_size, eos_id, dtype) and written with a
bounded buffer, so a 20 GB stream on Google Drive never needs 20 GB of RAM.

Usage:
    python forge/concat_streams.py --out /content/drive/MyDrive/ilaria/train_stream \
        --prefix ro=/content/drive/MyDrive/ilaria/corpus/fineweb2_ro \
        --prefix ro=/content/drive/MyDrive/ilaria/corpus/wiki_ro \
        --prefix en=/content/drive/MyDrive/ilaria/corpus/fineweb_edu \
        --prefix en=/content/drive/MyDrive/ilaria/corpus/wiki_en
Shards of the same language group are interleaved round-robin so the stream
does not start with 3 GB of one source and end with another.
"""

from __future__ import annotations

import argparse
import glob
import json
import os
import shutil
from typing import Dict, List

CHUNK_BYTES = 64 << 20


def _meta(prefix: str) -> dict:
    with open(prefix + ".json", encoding="utf-8") as f:
        return json.load(f)


def interleave_prefixes(groups: Dict[str, List[str]]) -> List[str]:
    """Round-robin over groups (each group's list is used in sorted order)."""
    queues = {g: sorted(paths) for g, paths in groups.items() if paths}
    order: List[str] = []
    while queues:
        for g in list(queues):
            order.append(queues[g].pop(0))
            if not queues[g]:
                del queues[g]
    return order


def concat(prefixes: List[str], out_prefix: str) -> dict:
    """Concatenate shards in the given order; returns the merged metadata."""
    if not prefixes:
        raise ValueError("no shards given")
    metas = [_meta(p) for p in prefixes]
    ref = metas[0]
    for p, m in zip(prefixes, metas):
        for key in ("vocab_size", "eos_id", "dtype"):
            if m.get(key) != ref.get(key):
                raise ValueError(f"shard {p}: {key}={m.get(key)!r} differs from {prefixes[0]}: {ref.get(key)!r}")
    os.makedirs(os.path.dirname(os.path.abspath(out_prefix)), exist_ok=True)
    tokens = 0
    docs = 0
    with open(out_prefix + ".bin", "wb") as out:
        for p, m in zip(prefixes, metas):
            with open(p + ".bin", "rb") as src:
                shutil.copyfileobj(src, out, CHUNK_BYTES)
            tokens += int(m.get("tokens", 0))
            docs += int(m.get("documents", 0))
    meta = {
        "vocab_size": ref["vocab_size"], "eos_id": ref["eos_id"], "dtype": ref["dtype"],
        "tokens": tokens, "documents": docs, "tokenizer": ref.get("tokenizer", ""),
        "byte_level": ref.get("byte_level", False), "shards": len(prefixes),
        "sources": [os.path.basename(p) for p in prefixes],
    }
    with open(out_prefix + ".json", "w", encoding="utf-8") as f:
        json.dump(meta, f, indent=2)
    return meta


def main(argv=None) -> None:
    ap = argparse.ArgumentParser(description="Join tokenized shards into one training stream.")
    ap.add_argument("--out", required=True, help="output prefix (writes <out>.bin and <out>.json)")
    ap.add_argument("--prefix", action="append", default=[],
                    help="<group>=<shard prefix or glob without .bin> (repeatable); groups are interleaved")
    args = ap.parse_args(argv)
    groups: Dict[str, List[str]] = {}
    for item in args.prefix:
        group, _, pattern = item.partition("=")
        if not pattern:
            group, pattern = "all", item
        found = [p[:-4] for p in glob.glob(pattern + "*.bin")] or ([pattern] if os.path.exists(pattern + ".bin") else [])
        if not found:
            raise SystemExit(f"no shards match {pattern!r}")
        groups.setdefault(group, []).extend(found)
    order = interleave_prefixes(groups)
    meta = concat(order, args.out)
    print(f"[concat_streams] {meta['shards']} shards, {meta['tokens']:,} tokens, vocab {meta['vocab_size']} -> {args.out}.bin")


if __name__ == "__main__":
    main()
