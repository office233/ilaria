"""Deterministic corpus audit: exact deduplication and benchmark contamination.

The report intentionally contains hashes/counters and source locations, never
the matched raw text. Exact-document dedup uses SQLite so the audit can scale
past RAM. Benchmark contamination uses hashed normalized word shingles.

This is a *detection* stage. It does not silently rewrite source shards.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sqlite3
import tempfile
import unicodedata
from pathlib import Path
from typing import Iterable

try:
    from .data_contract import atomic_write_json, sha256_file
except ImportError:  # direct script execution
    from data_contract import atomic_write_json, sha256_file

AUDIT_SCHEMA_VERSION = 1
_WORD = re.compile(r"\w+", re.UNICODE)


def normalize_text(text: str) -> str:
    return " ".join(unicodedata.normalize("NFKC", text).casefold().split())


def document_sha256(text: str) -> str:
    return hashlib.sha256(normalize_text(text).encode("utf-8")).hexdigest()


def word_tokens(text: str) -> list[str]:
    return _WORD.findall(normalize_text(text))


def shingle_hashes(text: str, width: int) -> set[bytes]:
    if width < 2:
        raise ValueError("shingle width must be at least 2")
    words = word_tokens(text)
    if len(words) < width:
        return set()
    return {
        hashlib.sha256(
            "\x1f".join(words[i : i + width]).encode("utf-8")
        ).digest()
        for i in range(len(words) - width + 1)
    }


def _strings(value) -> Iterable[str]:
    if isinstance(value, str):
        yield value
    elif isinstance(value, dict):
        for child in value.values():
            yield from _strings(child)
    elif isinstance(value, list):
        for child in value:
            yield from _strings(child)


def benchmark_shingles(paths: list[str], width: int) -> tuple[set[bytes], list[dict]]:
    shingles: set[bytes] = set()
    records = []
    for raw_path in sorted(paths):
        path = Path(raw_path)
        if not path.is_file():
            raise ValueError(f"benchmark file does not exist: {path}")
        strings = 0
        local: set[bytes] = set()
        with path.open(encoding="utf-8") as stream:
            if path.suffix.lower() == ".jsonl":
                for line_no, line in enumerate(stream, 1):
                    if not line.strip():
                        continue
                    try:
                        value = json.loads(line)
                    except json.JSONDecodeError as exc:
                        raise ValueError(
                            f"{path}:{line_no}: invalid JSON: {exc}"
                        ) from exc
                    for text in _strings(value):
                        strings += 1
                        local.update(shingle_hashes(text, width))
            elif path.suffix.lower() == ".json":
                try:
                    value = json.load(stream)
                except json.JSONDecodeError as exc:
                    raise ValueError(f"{path}: invalid JSON: {exc}") from exc
                for text in _strings(value):
                    strings += 1
                    local.update(shingle_hashes(text, width))
            else:
                for line in stream:
                    text = line.strip()
                    if text:
                        strings += 1
                        local.update(shingle_hashes(text, width))
        shingles.update(local)
        records.append(
            {
                "path": path.name,
                "sha256": sha256_file(path),
                "strings": strings,
                "unique_shingles": len(local),
            }
        )
    return shingles, records


def _iter_jsonl_documents(path: str):
    with open(path, encoding="utf-8") as stream:
        for line_no, line in enumerate(stream, 1):
            if not line.strip():
                continue
            try:
                value = json.loads(line)
            except json.JSONDecodeError as exc:
                raise ValueError(f"{path}:{line_no}: invalid JSON: {exc}") from exc
            text = value.get("text") if isinstance(value, dict) else None
            if not isinstance(text, str) or not text.strip():
                raise ValueError(f"{path}:{line_no}: missing non-empty text")
            yield line_no, text


def audit(
    shard_paths: list[str],
    benchmark_paths: list[str],
    *,
    shingle_width: int = 12,
    sqlite_path: str | None = None,
) -> dict:
    if not shard_paths:
        raise ValueError("audit requires at least one corpus shard")
    if shingle_width < 2:
        raise ValueError("shingle width must be at least 2")

    bench, benchmark_records = benchmark_shingles(
        benchmark_paths, shingle_width
    )

    cleanup_db = False
    if sqlite_path is None:
        fd, sqlite_path = tempfile.mkstemp(
            prefix="ilaria-dedup-", suffix=".sqlite3"
        )
        os.close(fd)
        cleanup_db = True

    total_docs = 0
    unique_docs = 0
    duplicate_docs = 0
    contaminated_docs = 0
    contaminated_locations: list[dict] = []
    shard_records = []

    try:
        db = sqlite3.connect(sqlite_path)
        try:
            db.execute(
                "CREATE TABLE IF NOT EXISTS docs "
                "(hash TEXT PRIMARY KEY, shard TEXT NOT NULL, line INTEGER NOT NULL)"
            )
            db.execute("DELETE FROM docs")

            for raw_path in sorted(shard_paths):
                path = Path(raw_path)
                if not path.is_file():
                    raise ValueError(f"corpus shard does not exist: {path}")
                shard_docs = shard_unique = shard_duplicates = shard_leaks = 0

                for line_no, text in _iter_jsonl_documents(str(path)):
                    total_docs += 1
                    shard_docs += 1
                    digest = document_sha256(text)
                    try:
                        db.execute(
                            "INSERT INTO docs(hash, shard, line) VALUES (?, ?, ?)",
                            (digest, path.name, line_no),
                        )
                        unique_docs += 1
                        shard_unique += 1
                    except sqlite3.IntegrityError:
                        duplicate_docs += 1
                        shard_duplicates += 1

                    if bench and shingle_hashes(text, shingle_width) & bench:
                        contaminated_docs += 1
                        shard_leaks += 1
                        if len(contaminated_locations) < 1000:
                            contaminated_locations.append(
                                {
                                    "shard": path.name,
                                    "line": line_no,
                                    "document_sha256": digest,
                                }
                            )

                db.commit()
                shard_records.append(
                    {
                        "filename": path.name,
                        "sha256": sha256_file(path),
                        "documents": shard_docs,
                        "unique_documents": shard_unique,
                        "duplicate_documents": shard_duplicates,
                        "contaminated_documents": shard_leaks,
                    }
                )
        finally:
            db.close()
    finally:
        if cleanup_db:
            Path(sqlite_path).unlink(missing_ok=True)

    report = {
        "schema_version": AUDIT_SCHEMA_VERSION,
        "policy": {
            "normalization": "NFKC-casefold-whitespace-v1",
            "dedup": "exact-normalized-sha256",
            "contamination": "hashed-word-shingles",
            "shingle_width": shingle_width,
            "raw_text_in_report": False,
        },
        "totals": {
            "documents": total_docs,
            "unique_documents": unique_docs,
            "duplicate_documents": duplicate_docs,
            "contaminated_documents": contaminated_docs,
        },
        "passed": duplicate_docs == 0 and contaminated_docs == 0,
        "shards": shard_records,
        "benchmarks": benchmark_records,
        "contaminated_locations": contaminated_locations,
    }
    report["audit_sha256"] = hashlib.sha256(
        json.dumps(
            report, sort_keys=True, separators=(",", ":"), ensure_ascii=False
        ).encode("utf-8")
    ).hexdigest()
    return report


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--shard", action="append", required=True)
    parser.add_argument("--benchmark", action="append", default=[])
    parser.add_argument("--shingle-width", type=int, default=12)
    parser.add_argument("--sqlite", default="")
    parser.add_argument("--out", required=True)
    parser.add_argument(
        "--allow-findings",
        action="store_true",
        help="write a failing report without returning a nonzero exit status",
    )
    args = parser.parse_args()

    report = audit(
        args.shard,
        args.benchmark,
        shingle_width=args.shingle_width,
        sqlite_path=args.sqlite or None,
    )
    atomic_write_json(args.out, report)
    print(
        f"[data_audit] docs={report['totals']['documents']} "
        f"duplicates={report['totals']['duplicate_documents']} "
        f"contaminated={report['totals']['contaminated_documents']} "
        f"passed={report['passed']}"
    )
    if not report["passed"] and not args.allow_findings:
        raise SystemExit("data audit failed")


if __name__ == "__main__":
    main()
