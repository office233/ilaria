"""Convert a validated licensed-tree candidate into canonical raw corpus shards."""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path

try:
    from .data_contract import CORPUS_MANIFEST_SCHEMA, atomic_write_json, sha256_file
    from .licensed_tree_source import validate_manifest
except ImportError:  # direct script execution
    from data_contract import CORPUS_MANIFEST_SCHEMA, atomic_write_json, sha256_file
    from licensed_tree_source import validate_manifest


def build_raw_corpus(
    licensed_manifest_path: str | Path,
    *,
    root: str | Path,
    out_dir: str | Path,
    source_name: str,
    provider: str,
    language: str = "code",
    shard_docs: int = 10_000,
) -> dict:
    if shard_docs < 1:
        raise ValueError("licensed-tree corpus shard_docs must be positive")
    if not source_name.strip() or not provider.strip() or not language.strip():
        raise ValueError("licensed-tree corpus source identity is incomplete")

    manifest = validate_manifest(licensed_manifest_path, root=root)
    if manifest["source_name"] != source_name:
        raise ValueError(
            "licensed-tree source name differs from requested corpus source name"
        )
    tree = Path(root).resolve()
    output = Path(out_dir)
    output.mkdir(parents=True, exist_ok=True)
    manifest_path = output / f"{source_name}.manifest.json"
    if manifest_path.exists() or any(output.glob(f"{source_name}-*.jsonl")):
        raise ValueError("licensed-tree corpus output already contains source artifacts")

    shard_records = []
    buffer: list[dict] = []
    shard_index = 0
    total_docs = 0

    def flush() -> None:
        nonlocal shard_index, total_docs
        if not buffer:
            return
        filename = f"{source_name}-{shard_index:05d}.jsonl"
        destination = output / filename
        temporary = destination.with_suffix(destination.suffix + ".tmp")
        with temporary.open("w", encoding="utf-8", newline="\n") as stream:
            for row in buffer:
                stream.write(
                    json.dumps(
                        row,
                        ensure_ascii=False,
                        sort_keys=True,
                        separators=(",", ":"),
                    )
                    + "\n"
                )
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, destination)
        count = len(buffer)
        shard_records.append(
            {
                "index": shard_index,
                "filename": filename,
                "sha256": sha256_file(destination),
                "bytes": destination.stat().st_size,
                "documents": count,
            }
        )
        total_docs += count
        shard_index += 1
        buffer.clear()

    for record in manifest["files"]:
        path = tree / record["path"]
        text = path.read_text(encoding="utf-8", errors="ignore").strip()
        if not text:
            continue
        buffer.append(
            {
                "text": f"[FILE {record['path']} SPDX={record['spdx']}]\n{text}",
                "path": record["path"],
                "spdx": record["spdx"],
                "file_sha256": record["sha256"],
            }
        )
        if len(buffer) >= shard_docs:
            flush()
    flush()
    if total_docs == 0:
        raise ValueError("licensed-tree corpus produced no documents")

    source_manifest = {
        "schema_version": CORPUS_MANIFEST_SCHEMA,
        "source": {
            "name": source_name,
            "provider": provider,
            "config": None,
            "revision": manifest["source_revision"],
            "language": language,
        },
        "pipeline": {
            "name": "licensed-tree-corpus-v1",
            "licensed_tree_manifest_sha256": manifest["manifest_sha256"],
            "allowed_spdx": manifest["allowed_spdx"],
            "secret_filter": "strong-markers-v1",
            "agent_instruction_filter": "known-agent-files-v1",
        },
        "docs": total_docs,
        "shards": len(shard_records),
        "shard_docs": shard_docs,
        "complete": [record["index"] for record in shard_records],
        "raw_rows": total_docs,
        "shard_records": shard_records,
    }
    atomic_write_json(manifest_path, source_manifest)
    return source_manifest


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--licensed-manifest", required=True)
    parser.add_argument("--root", required=True)
    parser.add_argument("--out-dir", required=True)
    parser.add_argument("--source-name", required=True)
    parser.add_argument("--provider", required=True)
    parser.add_argument("--language", default="code")
    parser.add_argument("--shard-docs", type=int, default=10_000)
    args = parser.parse_args()
    report = build_raw_corpus(
        args.licensed_manifest,
        root=args.root,
        out_dir=args.out_dir,
        source_name=args.source_name,
        provider=args.provider,
        language=args.language,
        shard_docs=args.shard_docs,
    )
    print(
        f"[licensed-tree-corpus] {args.source_name}: "
        f"docs={report['docs']} shards={report['shards']}"
    )


if __name__ == "__main__":
    main()
