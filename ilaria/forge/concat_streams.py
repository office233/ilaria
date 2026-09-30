"""Join canonical Ilaria token shards into one immutable training stream.

Inputs are <prefix>.bin + <prefix>.json produced by IlariaLex. Every shard must
pin the same tokenizer identity and token-stream format. The output binary is
published atomically; the metadata published afterwards includes the final
stream hash, so an interrupted two-file publication fails closed on the next
consumer validation rather than silently training on mixed artifacts.
"""
from __future__ import annotations

import argparse
import glob
import json
import os
import shutil
from typing import Dict, List

try:
    from .atomic_io import atomic_binary_writer
    from .data_contract import (
        TOKEN_STREAM_FORMAT,
        atomic_write_json,
        require_lower_sha256,
        sha256_file,
    )
except ImportError:  # direct script execution
    from atomic_io import atomic_binary_writer
    from data_contract import (
        TOKEN_STREAM_FORMAT,
        atomic_write_json,
        require_lower_sha256,
        sha256_file,
    )

CHUNK_BYTES = 64 << 20
_DTYPE_BYTES = {"uint16": 2, "uint32": 4}
_REQUIRED_META = {
    "format",
    "vocab_size",
    "eos_id",
    "dtype",
    "tokens",
    "documents",
    "tokenizer",
    "tokenizer_sha256",
    "tokenizer_format",
    "protocol_start_id",
    "byte_level",
}
_COMPAT_KEYS = (
    "format",
    "vocab_size",
    "eos_id",
    "dtype",
    "tokenizer_sha256",
    "tokenizer_format",
    "protocol_start_id",
    "byte_level",
)


def _meta(prefix: str) -> dict:
    with open(prefix + ".json", encoding="utf-8") as stream:
        data = json.load(stream)
    missing = _REQUIRED_META - set(data)
    if missing:
        raise ValueError(
            f"shard {prefix}: metadata missing {sorted(missing)}"
        )
    if data["format"] != TOKEN_STREAM_FORMAT:
        raise ValueError(
            f"shard {prefix}: unsupported format {data['format']!r}"
        )
    if data["dtype"] not in _DTYPE_BYTES:
        raise ValueError(
            f"shard {prefix}: unsupported dtype {data['dtype']!r}"
        )
    if type(data["vocab_size"]) is not int or data["vocab_size"] <= 0:
        raise ValueError(f"shard {prefix}: invalid vocab_size")
    if type(data["eos_id"]) is not int or not (
        0 <= data["eos_id"] < data["vocab_size"]
    ):
        raise ValueError(f"shard {prefix}: invalid eos_id")
    if type(data["protocol_start_id"]) is not int or not (
        0 <= data["protocol_start_id"] < data["vocab_size"]
    ):
        raise ValueError(f"shard {prefix}: invalid protocol_start_id")
    if type(data["tokens"]) is not int or data["tokens"] < 0:
        raise ValueError(f"shard {prefix}: invalid token count")
    if type(data["documents"]) is not int or data["documents"] < 0:
        raise ValueError(f"shard {prefix}: invalid document count")
    if data["byte_level"] is not True:
        raise ValueError(f"shard {prefix}: byte_level must be true")
    require_lower_sha256(
        f"shard {prefix} tokenizer_sha256",
        data["tokenizer_sha256"],
    )

    bin_path = prefix + ".bin"
    if not os.path.isfile(bin_path):
        raise ValueError(f"shard {prefix}: binary file is missing")
    expected_bytes = data["tokens"] * _DTYPE_BYTES[data["dtype"]]
    actual_bytes = os.path.getsize(bin_path)
    if actual_bytes != expected_bytes:
        raise ValueError(
            f"shard {prefix}: binary size {actual_bytes} differs from "
            f"metadata expectation {expected_bytes}"
        )
    return data


def interleave_prefixes(groups: Dict[str, List[str]]) -> List[str]:
    """Round-robin over groups; each group is stable-sorted."""
    queues = {g: sorted(paths) for g, paths in groups.items() if paths}
    order: List[str] = []
    while queues:
        for group in list(queues):
            order.append(queues[group].pop(0))
            if not queues[group]:
                del queues[group]
    return order


def concat(prefixes: List[str], out_prefix: str) -> dict:
    """Concatenate canonical shards in order and publish a hashed stream."""
    if not prefixes:
        raise ValueError("no shards given")

    metas = [_meta(prefix) for prefix in prefixes]
    ref = metas[0]
    for prefix, meta in zip(prefixes, metas):
        for key in _COMPAT_KEYS:
            if meta.get(key) != ref.get(key):
                raise ValueError(
                    f"shard {prefix}: {key}={meta.get(key)!r} differs "
                    f"from {prefixes[0]}: {ref.get(key)!r}"
                )

    os.makedirs(os.path.dirname(os.path.abspath(out_prefix)), exist_ok=True)
    tokens = 0
    documents = 0
    shard_records = []

    with atomic_binary_writer(out_prefix + ".bin") as out:
        for prefix, meta in zip(prefixes, metas):
            bin_path = prefix + ".bin"
            meta_path = prefix + ".json"
            with open(bin_path, "rb") as src:
                shutil.copyfileobj(src, out, CHUNK_BYTES)
            tokens += meta["tokens"]
            documents += meta["documents"]
            shard_records.append(
                {
                    "prefix": os.path.basename(prefix),
                    "bin_sha256": sha256_file(bin_path),
                    "meta_sha256": sha256_file(meta_path),
                    "bytes": os.path.getsize(bin_path),
                    "tokens": meta["tokens"],
                    "documents": meta["documents"],
                }
            )

    stream_path = out_prefix + ".bin"
    metadata = {
        "format": TOKEN_STREAM_FORMAT,
        "vocab_size": ref["vocab_size"],
        "eos_id": ref["eos_id"],
        "dtype": ref["dtype"],
        "tokens": tokens,
        "documents": documents,
        "tokenizer": ref["tokenizer"],
        "tokenizer_sha256": ref["tokenizer_sha256"],
        "tokenizer_format": ref["tokenizer_format"],
        "protocol_start_id": ref["protocol_start_id"],
        "byte_level": True,
        "shards": len(prefixes),
        "stream_sha256": sha256_file(stream_path),
        "stream_bytes": os.path.getsize(stream_path),
        "shard_records": shard_records,
    }
    atomic_write_json(out_prefix + ".json", metadata)
    return metadata


def main(argv=None) -> None:
    parser = argparse.ArgumentParser(
        description="Join canonical Ilaria token shards into one training stream."
    )
    parser.add_argument(
        "--out",
        required=True,
        help="output prefix (writes <out>.bin and <out>.json)",
    )
    parser.add_argument(
        "--prefix",
        action="append",
        default=[],
        help=(
            "<group>=<shard prefix or glob without .bin> (repeatable); "
            "groups are interleaved"
        ),
    )
    args = parser.parse_args(argv)

    groups: Dict[str, List[str]] = {}
    for item in args.prefix:
        group, _, pattern = item.partition("=")
        if not pattern:
            group, pattern = "all", item
        found = [p[:-4] for p in glob.glob(pattern + "*.bin")]
        if not found and os.path.exists(pattern + ".bin"):
            found = [pattern]
        if not found:
            raise SystemExit(f"no shards match {pattern!r}")
        groups.setdefault(group, []).extend(found)

    order = interleave_prefixes(groups)
    meta = concat(order, args.out)
    print(
        f"[concat_streams] {meta['shards']} shards, "
        f"{meta['tokens']:,} tokens, vocab {meta['vocab_size']} "
        f"sha256={meta['stream_sha256']} -> {args.out}.bin"
    )


if __name__ == "__main__":
    main()
