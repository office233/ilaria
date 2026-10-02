"""Build a deterministic, content-addressed tokenizer candidate sample.

This artifact is deliberately *not* a production rights approval. It exists so
IlariaLex can be exercised and corpus token counts can be measured before the
manual rights/ownership gates are closed. Production coverage/sample manifests
remain governed by ``tokenizer_coverage.py`` and ``tokenizer_freeze.py``.
"""
from __future__ import annotations

import argparse
import json
import os
from collections.abc import Mapping, Sequence
from pathlib import Path

from data_contract import atomic_write_json, canonical_json_sha256, sha256_file


FORMAT = "ilarialex-candidate-sample-v1"
REQUIRED_CATEGORIES = frozenset(
    {"english", "code", "math_science", "os_drivers", "hardware", "tools_protocol"}
)


def _manifest_hash(value: dict) -> str:
    payload = dict(value)
    payload.pop("sample_sha256", None)
    return canonical_json_sha256(payload)


def _load_source_manifest(path: Path) -> dict:
    with path.open(encoding="utf-8") as stream:
        manifest = json.load(stream)
    source = manifest.get("source")
    records = manifest.get("shard_records")
    if not isinstance(source, dict) or not str(source.get("name", "")).strip():
        raise ValueError(f"candidate sample source manifest has invalid source: {path}")
    if not isinstance(records, list) or not records:
        raise ValueError(f"candidate sample source manifest has no shards: {path}")
    return manifest


def _iter_text(manifest_path: Path, manifest: dict):
    for record in manifest["shard_records"]:
        filename = record.get("filename")
        if not isinstance(filename, str) or not filename:
            raise ValueError(f"candidate sample shard filename is invalid: {manifest_path}")
        shard = manifest_path.parent / filename
        if not shard.is_file():
            raise ValueError(f"candidate sample shard is missing: {shard}")
        if int(record.get("bytes", -1)) != shard.stat().st_size:
            raise ValueError(f"candidate sample shard size mismatch: {shard}")
        if str(record.get("sha256", "")) != sha256_file(shard):
            raise ValueError(f"candidate sample shard hash mismatch: {shard}")
        with shard.open(encoding="utf-8") as stream:
            for line in stream:
                try:
                    row = json.loads(line)
                except json.JSONDecodeError as exc:
                    raise ValueError(f"candidate sample invalid JSONL: {shard}") from exc
                text = row.get("text") if isinstance(row, dict) else None
                if isinstance(text, str) and text.strip():
                    yield text


def build_candidate_sample(
    entries: Mapping[str, Sequence[str | Path]],
    *,
    out_dir: str | Path,
    bytes_per_category: int,
) -> dict:
    if set(entries) != REQUIRED_CATEGORIES:
        raise ValueError("candidate tokenizer sample category set mismatch")
    if bytes_per_category < 1:
        raise ValueError("candidate tokenizer sample byte target must be positive")

    output = Path(out_dir)
    output.mkdir(parents=True, exist_ok=True)
    categories: dict[str, dict] = {}
    all_inputs: list[dict] = []

    for category in sorted(REQUIRED_CATEGORIES):
        paths = [Path(path).resolve() for path in entries[category]]
        if not paths:
            raise ValueError(f"candidate tokenizer sample category {category!r} is empty")
        source_records = []
        loaded = []
        for path in paths:
            if not path.is_file():
                raise ValueError(f"candidate sample manifest does not exist: {path}")
            manifest = _load_source_manifest(path)
            source_record = {
                "source": manifest["source"]["name"],
                "manifest": path.name,
                "manifest_sha256": sha256_file(path),
                "revision": manifest["source"].get("revision"),
            }
            source_records.append(source_record)
            all_inputs.append({"category": category, **source_record})
            loaded.append((path, manifest))

        destination = output / f"{category}.txt"
        temporary = destination.with_suffix(".txt.tmp")
        written = 0
        documents = 0
        iterators = [iter(_iter_text(path, manifest)) for path, manifest in loaded]
        active = list(range(len(iterators)))
        with temporary.open("w", encoding="utf-8", newline="\n") as stream:
            while active and written < bytes_per_category:
                next_active = []
                for index in active:
                    try:
                        text = next(iterators[index])
                    except StopIteration:
                        continue
                    line = text.replace("\r", " ").replace("\n", " ").strip() + "\n"
                    encoded = line.encode("utf-8")
                    stream.write(line)
                    written += len(encoded)
                    documents += 1
                    next_active.append(index)
                    if written >= bytes_per_category:
                        break
                active = next_active
            stream.flush()
            os.fsync(stream.fileno())
        if documents == 0:
            temporary.unlink(missing_ok=True)
            raise ValueError(f"candidate tokenizer sample category {category!r} produced no text")
        os.replace(temporary, destination)
        categories[category] = {
            "filename": destination.name,
            "sha256": sha256_file(destination),
            "bytes": destination.stat().st_size,
            "documents": documents,
            "sources": source_records,
        }

    manifest = {
        "format": FORMAT,
        "production_eligible": False,
        "purpose": "tokenizer-development-and-exact-candidate-counting-only",
        "bytes_per_category_target": bytes_per_category,
        "categories": categories,
        "inputs": sorted(all_inputs, key=lambda item: (item["category"], item["source"])),
    }
    manifest["sample_sha256"] = _manifest_hash(manifest)
    atomic_write_json(output / "candidate-sample.manifest.json", manifest)
    return manifest


def _parse_input(value: str) -> tuple[str, Path]:
    category, sep, path = value.partition("=")
    if not sep or category not in REQUIRED_CATEGORIES or not path:
        raise ValueError("candidate sample input must be CATEGORY=MANIFEST")
    return category, Path(path)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", action="append", required=True)
    parser.add_argument("--out-dir", required=True)
    parser.add_argument("--bytes-per-category", type=int, default=40_000_000)
    args = parser.parse_args()
    entries = {category: [] for category in REQUIRED_CATEGORIES}
    for raw in args.input:
        category, path = _parse_input(raw)
        entries[category].append(path)
    manifest = build_candidate_sample(
        entries, out_dir=args.out_dir, bytes_per_category=args.bytes_per_category
    )
    print(
        f"[ilarialex-candidate-sample] sha256={manifest['sample_sha256']} "
        f"bytes={sum(item['bytes'] for item in manifest['categories'].values()):,}"
    )


if __name__ == "__main__":
    main()
